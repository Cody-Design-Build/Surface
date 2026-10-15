// `surface serve`: the local mode of the Surface app.
// A small HTTP server on 127.0.0.1 that serves the app and gives it the workspace,
// using the same code as the CLI (snapshot, normalize, push_record, pull, the Views tree).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CONFIG_DIR, findCheckout, type Checkout } from "./config.ts";
import { dbError, requireUser, sb } from "./client.ts";
import { fetchViews, pushRecord, type RecordRow, type TypeRow, type ViewRow } from "./db.ts";
import { makeResolver, pull, snapshot, type Snapshot } from "./checkout.ts";
import { normalize } from "./normalize.ts";
import { asTreeDef, defaultTree, resolveTree, type TreeNode } from "./tree.ts";
import { matches, parseWhere, sortRows } from "./query.ts";

const APP_DIR = path.resolve(import.meta.dirname, "../../app/dist");
const TOKEN_FILE = path.join(CONFIG_DIR, "serve-token");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function serveToken(): string {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

interface State {
  snap: Snapshot;
  views: ViewRow[];
  revKey: string;
}

export async function serve(co: Checkout, opts: { port: number; host?: string }) {
  const user = await requireUser();
  const ws = co.config.workspace;
  const token = serveToken();
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;

  let state: State = await load();
  const clients = new Set<http.ServerResponse>();

  async function load(): Promise<State> {
    const snap = await snapshot(co);
    const views = await fetchViews(ws);
    return { snap, views, revKey: revKeyOf(snap.all, views) };
  }
  function revKeyOf(records: RecordRow[], views: ViewRow[]) {
    return records.map((r) => `${r.id}:${r.rev}`).sort().join(",") + "|" + views.map((v) => `${v.key}:${v.rev}`).join(",");
  }
  async function refresh(reason: string, ids: string[] = []) {
    state = await load();
    try {
      // The CLI and agents write .surface/ too: re-read it so a stale in-memory copy never overwrites theirs.
      const disk = findCheckout(co.root);
      if (disk) {
        co.config = disk.config;
        co.state = disk.state;
      }
      await pull(co);
    } catch (e) {
      console.error("pull failed:", (e as Error).message);
    }
    broadcast({ type: "changed", reason, ids });
  }
  function broadcast(msg: unknown) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) c.write(line);
  }

  // Watch the database for changes made elsewhere (CLI, agents, teammates).
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const { data, error } = await sb().from("records").select("id,rev").eq("workspace_id", ws).is("deleted_at", null);
      if (error) throw error;
      const views = await fetchViews(ws);
      const key = (data as { id: string; rev: number }[]).map((r) => `${r.id}:${r.rev}`).sort().join(",") + "|" + views.map((v) => `${v.key}:${v.rev}`).join(",");
      if (key !== state.revKey) {
        const before = new Map(state.snap.all.map((r) => [r.id, r.rev]));
        const changed = (data as { id: string; rev: number }[]).filter((r) => before.get(r.id) !== r.rev).map((r) => r.id);
        await refresh("remote", changed);
      }
    } catch (e) {
      console.error("watch:", (e as Error).message);
    } finally {
      polling = false;
    }
  }, 2500).unref();
  setInterval(() => broadcast({ type: "ping" }), 25000).unref();

  // ------------------------------------------------------------------ helpers
  const typeOf = (id: string) => state.snap.typeMap.get(id)!;
  const summary = (r: RecordRow) => ({
    id: r.id,
    title: r.title,
    type: typeOf(r.type_id).key,
    parent: r.parent_id,
    folder: r.folder,
    updated_at: r.updated_at,
    path: co.state.records[r.id]?.path ?? null,
  });
  function recordJson(r: RecordRow) {
    const t = typeOf(r.type_id);
    const fields: Record<string, unknown> = {};
    for (const f of t.fields) fields[f.key] = r.fields[f.id] ?? null;
    return { ...summary(r), rev: r.rev, fields, body: r.body, created_at: r.created_at };
  }
  function backlinks(r: RecordRow) {
    const out: { id: string; title: string; type: string; via: string }[] = [];
    const name = r.title.toLowerCase();
    const file = co.state.records[r.id]?.path;
    const base = file ? path.basename(file, ".md").toLowerCase() : name;
    for (const o of state.snap.all) {
      if (o.id === r.id) continue;
      const t = typeOf(o.type_id);
      let via: string | null = null;
      for (const f of t.fields) {
        if (f.kind !== "link") continue;
        const v = o.fields[f.id];
        const ids = v == null ? [] : Array.isArray(v) ? v : [v];
        if (ids.includes(r.id)) {
          via = f.name;
          break;
        }
      }
      if (!via && o.parent_id === r.id) via = "nested";
      if (!via) {
        const re = /\[\[([^\]|#]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(o.body))) {
          const l = m[1].trim().toLowerCase();
          if (l === name || l === base) {
            via = "mention";
            break;
          }
        }
      }
      if (via) out.push({ id: o.id, title: o.title, type: t.key, via });
    }
    return out;
  }
  function tree(): TreeNode[] {
    const v = state.views.find((x) => x.key === "sidebar");
    const def = v ? asTreeDef(v.definition) : defaultTree(state.snap.types);
    return resolveTree(def, state.snap.records, state.snap.types);
  }
  function typeJson(t: TypeRow) {
    return { id: t.id, key: t.key, name: t.name, folder: t.folder, icon: t.icon, builtin: t.is_builtin, fields: t.fields.map((f) => ({ ...f, target: f.target ? state.snap.typeMap.get(f.target)?.key ?? null : null })) };
  }

  async function save(r: RecordRow | null, body: Record<string, unknown>) {
    const t = r && !body.type ? typeOf(r.type_id) : state.snap.types.find((x) => x.key === (body.type ?? "page"));
    if (!t) throw new HttpError(400, `Unknown type "${body.type}"`);
    const resolver = makeResolver(co, state.snap);
    const fields: Record<string, unknown> = r ? Object.fromEntries(t.fields.map((f) => [f.key, r.fields[f.id] ?? null])) : {};
    const notices: string[] = [];
    const errors: Record<string, string> = {};
    for (const [k, raw] of Object.entries((body.fields as Record<string, unknown>) ?? {})) {
      const def = t.fields.find((f) => f.key === k);
      if (!def) {
        errors[k] = "no such field";
        continue;
      }
      const n = normalize(def, raw, resolver);
      if (n.error) errors[k] = n.error;
      else {
        if (n.notice) notices.push(`${def.name}: ${n.notice}`);
        fields[k] = n.value;
      }
    }
    for (const f of t.fields) if (f.required && (fields[f.key] == null || fields[f.key] === "")) errors[f.key] ??= "is required";
    if (Object.keys(errors).length) throw new HttpError(422, "Some values aren't valid", { errors });
    let parent: string | null = null;
    if (body.parent !== undefined) parent = body.parent ? String(body.parent) : "";
    const title = String(body.title ?? r?.title ?? "Untitled").trim() || "Untitled";
    const res = await pushRecord({
      workspace: ws,
      id: r?.id ?? null,
      baseRev: r ? Number(body.baseRev ?? r.rev) : null,
      type: t.key,
      title,
      fields,
      body: body.body !== undefined ? String(body.body) : r?.body ?? "",
      folder: r ? null : (body.folder as string | undefined) ?? null,
      parent,
    });
    if (!res.ok) throw new HttpError(res.kind === "conflict" ? 409 : 422, res.message);
    await refresh("save", [res.record.id]);
    const fresh = state.snap.byId.get(res.record.id) ?? res.record;
    return { record: recordJson(fresh), notices };
  }

  // ------------------------------------------------------------------ routes
  async function api(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
    const m = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
    const readBody = async () => {
      let s = "";
      for await (const c of req) s += c;
      return s ? JSON.parse(s) : {};
    };
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };

    if (parts[0] === "events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: {"type":"hello"}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (parts[0] === "file" && m === "GET") {
      // files inside the checkout (images in notes); never .surface/ or outside the root
      const rel = String(url.searchParams.get("path") ?? "");
      const abs = path.resolve(co.root, rel);
      if (!abs.startsWith(co.root + path.sep) || rel.split(/[\\/]/).includes(".surface")) return send(403, { error: "Not allowed" });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(404, { error: "Not found" });
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".pdf": "application/pdf" };
      res.writeHead(200, { "content-type": types[path.extname(abs).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    if (parts[0] === "state" && m === "GET") {
      return send(200, {
        mode: "local",
        user: { email: user.email },
        workspace: { id: ws, name: co.config.workspaceName ?? ws },
        root: co.root,
        layout: co.config.layout,
        types: state.snap.types.map(typeJson),
        records: state.snap.records.map(summary),
        tree: tree(),
        hasSidebar: state.views.some((v) => v.key === "sidebar"),
      });
    }
    if (parts[0] === "record" && parts[1]) {
      const r = state.snap.byId.get(parts[1]);
      if (!r) throw new HttpError(404, "No such record");
      if (m === "GET") return send(200, { record: recordJson(r), backlinks: backlinks(r) });
      if (m === "PUT") return send(200, await save(r, await readBody()));
      if (m === "DELETE") {
        const { error } = await sb().from("records").update({ deleted_at: new Date().toISOString() }).eq("id", r.id);
        if (error) throw dbError(error);
        await refresh("delete", [r.id]);
        return send(200, { ok: true });
      }
    }
    if (parts[0] === "records" && m === "POST") return send(200, await save(null, await readBody()));
    if (parts[0] === "query" && m === "POST") {
      const b = await readBody();
      if (Array.isArray(b.ids)) {
        const rows = (b.ids as string[]).map((id) => state.snap.byId.get(id)).filter((r): r is RecordRow => !!r && !r.deleted_at);
        return send(200, { records: rows.map(recordJson) });
      }
      const t = b.from ? state.snap.types.find((x) => x.key === b.from) : null;
      const ctx = { typeOf: state.snap.typeMap, titles: new Map(state.snap.all.map((r) => [r.id, r.title])), thisId: b.this ?? null };
      let rows = state.snap.records.filter((r) => (!t || r.type_id === t.id) && matches(r, parseWhere(b.where), ctx));
      rows = sortRows(rows, b.sort ?? "title", ctx);
      return send(200, { records: rows.map(recordJson) });
    }
    if (parts[0] === "search" && m === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (!q) return send(200, { results: [] });
      const results = [];
      for (const r of state.snap.records) {
        const inTitle = r.title.toLowerCase().includes(q);
        const i = r.body.toLowerCase().indexOf(q);
        if (!inTitle && i < 0) continue;
        const snippet = i >= 0 ? r.body.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, " ") : "";
        results.push({ ...summary(r), snippet, score: inTitle ? 2 : 1 });
      }
      results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
      return send(200, { results: results.slice(0, 50) });
    }
    if (parts[0] === "refresh" && m === "POST") {
      await refresh("manual");
      return send(200, { ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  function staticFile(url: URL, res: http.ServerResponse) {
    if (!fs.existsSync(APP_DIR)) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("The app isn't built yet. Run `npm install && npm run build` in the app/ folder.");
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let file = path.join(APP_DIR, rel);
    if (!file.startsWith(APP_DIR) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(APP_DIR, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      // Only answer requests addressed to this machine (blocks DNS rebinding).
      const h = (req.headers.host ?? "").toLowerCase();
      if (h !== `127.0.0.1:${port}` && h !== `localhost:${port}`) throw new HttpError(403, "Forbidden host");
      // Writes must come from the app itself.
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && origin !== `http://${h}`) throw new HttpError(403, "Forbidden origin");

      const cookies = Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=") as [string, string]));
      const given = url.searchParams.get("token");
      if (given) {
        if (given !== token) throw new HttpError(403, "Wrong token");
        res.writeHead(302, {
          "set-cookie": `surface_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: "/",
        });
        return res.end();
      }
      const authed = cookies.surface_token === token;
      if (url.pathname.startsWith("/api/")) {
        if (!authed) throw new HttpError(401, "Open the link printed by `surface serve` to sign this browser in.");
        return await api(req, url, res);
      }
      if (!authed && !/\.(js|css|svg|png|webmanifest|woff2|ico)$/.test(url.pathname)) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset=utf-8><title>Surface</title><body style="font:15px -apple-system,system-ui,sans-serif;padding:4rem;color:#444">
<h2 style="font-weight:600">Surface is running</h2><p>Open the link printed in the terminal by <code>surface serve</code> to connect this browser.</p></body>`);
      }
      return staticFile(url, res);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) res.writeHead(err.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, ...err.extra }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const link = `http://127.0.0.1:${port}/?token=${token}`;
  console.log(`Surface is running for "${co.config.workspaceName ?? ws}" (${co.root})`);
  console.log(`Open: ${link}`);
  console.log("Then install it as an app (Omarchy: Install Web App; Chrome: Install; Safari: Add to Dock).");
  return { server, link };
}
