// `surface serve`: the local mode of the Surface app.
// A small HTTP server on 127.0.0.1 that serves the app and gives it the workspace,
// using the same code as the CLI (snapshot, normalize, push_record, pull, the Views tree).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { appAtPath } from "../../surfaces.mts";
import { installedVersion, statusErrorKind, systemInfo } from "./system.ts";
import { maybeCheckForUpdates } from "./update.ts";
import { CONFIG_DIR, findCheckout, knownCheckouts, rememberCheckout, saveCheckout, type Checkout } from "./config.ts";
import { storeKind, dbError, requireUser, sb } from "./client.ts";
import { dataDir } from "./local.ts";
import { deleteView, fetchInvites, fetchMembers, fetchViews, materializeInverseLinks, myInvites, pushRecord, requireInverseSchema, saveView, type RecordRow, type TypeRow, type ViewRow } from "./db.ts";
import { makeResolver, linkNames, pull, snapshot, type Snapshot } from "./checkout.ts";
import { toShown, toStored } from "./links.ts";
import { normalize } from "./normalize.ts";
import { asTreeDef, defaultTree, isTreeDef, resolveTree, validateDataView, validateTree, type TreeDef, type TreeNode } from "./tree.ts";
import { matches, parseWhere, sortRows } from "./query.ts";
import { logger, logFile, debugOn } from "./log.ts";

const L = logger("serve");
const HL = logger("http");

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

async function workspaceHandler(co: Checkout, opts: { port: number; watch?: boolean }, kick: () => void) {
  const user = await requireUser();
  const ws = co.config.workspace;
  rememberCheckout(co);
  const token = serveToken();
  const port = opts.port;

  let database: { state: "ready" | "checking" | "error"; checkedAt: string | null; error: string | null; errorKind: "network" | "auth" | "database" | null } =
    { state: "checking", checkedAt: null, error: null, errorKind: null };
  function databaseReady() {
    database = { state: "ready", checkedAt: new Date().toISOString(), error: null, errorKind: null };
  }
  function databaseFailed(error: unknown) {
    database = { state: "error", checkedAt: new Date().toISOString(), error: (error as Error).message, errorKind: statusErrorKind(error) };
  }
  let state: State = await load();
  const clients = new Set<http.ServerResponse>();
  const extraCheckouts = new Map<string, { co: Checkout; watcher: { close: () => void } }>();

  async function load(): Promise<State> {
    try {
      const snap = await snapshot(co);
      // Read projection only: checkout/sync snapshots always retain canonical stored fields.
      const all = materializeInverseLinks(snap.all, snap.types);
      const byId = new Map(all.map((r) => [r.id, r]));
      snap.all = all;
      snap.records = snap.records.map((r) => byId.get(r.id)!);
      snap.byId = byId;
      const views = await fetchViews(ws);
      databaseReady();
      return { snap, views, revKey: revKeyOf(snap.all, views) };
    } catch (error) {
      databaseFailed(error);
      throw error;
    }
  }
  function revKeyOf(records: RecordRow[], views: ViewRow[]) {
    return records.map((r) => `${r.id}:${r.rev}`).sort().join(",") + "|" + views.map(viewRevKey).sort().join(",");
  }
  function viewRevKey(v: ViewRow) {
    return `${v.owner ? "p:" : ""}${v.key}:${v.rev}`;
  }
  // one checkout writer at a time: the pull loop, the file watcher and app saves share it
  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }
  async function refresh(reason: string, ids: string[] = []) {
    await exclusive(() => refreshNow(reason, ids));
  }
  async function refreshNow(reason: string, ids: string[] = []) {
    const previous = state.snap.byId;
    const next = await load();
    if (ids.length) {
      const changed = new Set(ids);
      for (const record of next.snap.all) if (previous.get(record.id)?.rev !== record.rev) changed.add(record.id);
      for (const id of previous.keys()) if (!next.snap.byId.has(id)) changed.add(id);
      ids = [...changed];
    }
    state = next;
    try {
      // The CLI and agents write .surface/ too: re-read it so a stale in-memory copy never overwrites theirs.
      const disk = findCheckout(co.root);
      if (disk) {
        co.config = disk.config;
        co.state = disk.state;
      }
      await pull(co);
      for (const entry of extraCheckouts.values()) {
        const disk = findCheckout(entry.co.root);
        if (disk) entry.co = disk;
        await pull(entry.co);
      }
    } catch (e) {
      L.error("pull to files failed", { reason, err: e as Error });
      console.error("pull failed:", (e as Error).message);
    }
    broadcast({ type: "changed", reason, ids });
    if (reason !== "sync") kick(); // a local change: send it up soon
  }
  function broadcast(msg: unknown) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) c.write(line);
  }

  // Watch the database for changes made elsewhere (CLI, agents, teammates).
  let polling = false;
  let typesKey = "";
  const pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const { data, error } = await sb().from("records").select("id,rev").eq("workspace_id", ws).is("deleted_at", null);
      if (error) throw error;
      const views = await fetchViews(ws);
      const key = (data as { id: string; rev: number }[]).map((r) => `${r.id}:${r.rev}`).sort().join(",") + "|" + views.map(viewRevKey).sort().join(",");
      // types change rarely; compare them too so a display or field change shows up
      const { data: tdata, error: typeError } = await sb().from("types").select("id,updated_at").eq("workspace_id", ws);
      if (typeError) throw typeError;
      databaseReady();
      const tkey = JSON.stringify((tdata ?? []).map((t) => [t.id, t.updated_at]).sort());
      if (typesKey && tkey !== typesKey) {
        typesKey = tkey;
        await refresh("types");
        return;
      }
      typesKey = tkey;
      if (key !== state.revKey) {
        const before = new Map(state.snap.all.map((r) => [r.id, r.rev]));
        const changed = (data as { id: string; rev: number }[]).filter((r) => before.get(r.id) !== r.rev).map((r) => r.id);
        await refresh("remote", changed);
      }
    } catch (e) {
      databaseFailed(e);
      L.warn("database watch failed", { err: e as Error });
      console.error("watch:", (e as Error).message);
    } finally {
      polling = false;
    }
  }, 2500).unref();
  const pingTimer = setInterval(() => broadcast({ type: "ping" }), 25000);
  pingTimer.unref();

  // Push on save: edits from any editor (Obsidian, VS Code, agents) reach the database.
  let watcher: { close: () => void } | null = null;
  async function startWatching() {
    watcher?.close();
    watcher = null;
    if (opts.watch === false) return;
    const { watchCheckout } = await import("./watch.ts");
    watcher = watchCheckout(() => co, {
      exclusive,
      log: (l) => {
        logger("files").info(l);
        console.log(l);
      },
      onPushed: (results) => {
        const ids = results.map((r) => r.id).filter((x): x is string => !!x);
        setImmediate(() => refresh("files", ids).catch(() => {}));
      },
    });
  }
  await startWatching();
  async function watchCheckouts() {
    if (opts.watch === false) return;
    const { watchCheckout } = await import("./watch.ts");
    const known = knownCheckouts().filter(k => k.workspace === ws && k.root !== co.root);
    const roots = new Set(known.map(k => k.root));
    for (const [root, entry] of extraCheckouts) if (!roots.has(root)) { entry.watcher.close(); extraCheckouts.delete(root); }
    for (const k of known) if (!extraCheckouts.has(k.root)) {
      const other = findCheckout(k.root);
      if (!other) continue;
      const entry = { co: other, watcher: { close() {} } };
      entry.watcher = watchCheckout(() => entry.co, { exclusive,
        log: line => logger("files").info(line),
        onPushed: () => { setImmediate(() => void refresh("files").catch(e => L.warn("checkout refresh failed", { err: e }))); }
      });
      extraCheckouts.set(k.root, entry);
    }
  }
  await watchCheckouts();

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
  function summaryOf(id: string) {
    const r = state.snap.byId.get(id);
    return r ? summary(r) : null;
  }
  function recordJson(r: RecordRow) {
    const t = typeOf(r.type_id);
    const fields: Record<string, unknown> = {};
    for (const f of t.fields) fields[f.key] = r.fields[f.id] ?? null;
    // the app edits readable text: [[id:…]] shows as [[Current name]]; saving turns it back
    return { ...summary(r), rev: r.rev, fields, body: toShown(r.body, linkNames(co, state.snap)), aliases: r.aliases ?? [], created_at: r.created_at };
  }
  function backlinks(r: RecordRow) {
    const out: { id: string; title: string; type: string; via: string }[] = [];
    const name = r.title.toLowerCase();
    const file = co.state.records[r.id]?.path;
    const base = file ? path.basename(file, ".md").toLowerCase() : name;
    const names = new Set([name, base, ...(r.aliases ?? []).map((a) => a.toLowerCase())]);
    const idLink = `[[id:${r.id}`;
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
      if (!via && o.body.includes(idLink)) via = "mention";
      if (!via) {
        // typed links that predate id links (or were never resolved)
        const re = /\[\[([^\]|#]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(o.body))) {
          const l = m[1].trim().toLowerCase();
          if (names.has(l)) {
            via = "mention";
            break;
          }
        }
      }
      if (via) out.push({ id: o.id, title: o.title, type: t.key, via });
    }
    return out;
  }
  const dataViews = () => state.views.filter((v) => !isTreeDef(v.key, v.definition));
  const sidebarRow = (personal: boolean) => state.views.find((x) => x.key === "sidebar" && !!x.owner === personal);
  function sidebarJson(personal: boolean) {
    const v = sidebarRow(personal);
    const def: TreeDef = v ? asTreeDef(v.definition) : { items: [] }; // nothing arranged yet: the Vault section shows the folders
    return {
      exists: !!v,
      rev: v?.rev ?? null,
      definition: def,
      // the workspace sidebar sees shared views; the personal one sees both, its own first
      tree: resolveTree(def, state.snap.records, state.snap.types, personal ? [...dataViews().filter((x) => !x.owner), ...dataViews().filter((x) => x.owner)] : dataViews().filter((x) => !x.owner)),
    };
  }
  // Surface Data's table folders: the shared tree view "tables" (groups of `query: { from }` items).
  // Organization only; types not placed in it are listed after the folders.
  const tablesRow = () => state.views.find((x) => x.key === "tables" && !x.owner);
  function tablesJson() {
    const v = tablesRow();
    return { rev: v?.rev ?? null, definition: v ? asTreeDef(v.definition) : { items: [] } };
  }
  function viewJson(v: ViewRow) {
    return { key: v.key, name: v.name, personal: !!v.owner, rev: v.rev, definition: v.definition, updated_at: v.updated_at };
  }
  function typeJson(t: TypeRow) {
    return { id: t.id, key: t.key, name: t.name, folder: t.folder, icon: t.icon, builtin: t.is_builtin, display: t.display ?? "document", fields: t.fields.map((f) => ({ ...f, target: f.target ? state.snap.typeMap.get(f.target)?.key ?? null : null })) };
  }
  let role: string | null = null;
  let memberCount = 1;
  async function myRole() {
    if (role) return role;
    const { data } = await sb().from("members").select("role,user_id").eq("workspace_id", ws);
    const rows = (data ?? []) as { role: string; user_id: string }[];
    memberCount = rows.length || 1;
    role = rows.find((x) => x.user_id === user.id)?.role ?? "viewer";
    return role;
  }

  async function save(r: RecordRow | null, body: Record<string, unknown>) {
    const t = r && !body.type ? typeOf(r.type_id) : state.snap.types.find((x) => x.key === (body.type ?? "page"));
    if (!t) throw new HttpError(400, `Unknown type "${body.type}"`);
    const resolver = makeResolver(co, state.snap);
    // Missing reverse keys mean "keep"; never copy computed values into an unrelated save.
    const fields: Record<string, unknown> = r ? Object.fromEntries(t.fields.filter((f) => !f.inverse).map((f) => [f.key, r.fields[f.id] ?? null])) : {};
    if (r && !Number.isInteger(body.baseRev) && t.fields.some((f) => f.inverse && Object.hasOwn((body.fields as Record<string, unknown>) ?? {}, f.key))) {
      throw new HttpError(422, "baseRev is required when replacing an inverse relationship; reload the record first.");
    }
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
    const names = linkNames(co, state.snap, resolver);
    const text = body.body !== undefined ? toStored(String(body.body), names).body : r?.body ?? "";
    const aliases = Array.isArray(body.aliases) ? (body.aliases as unknown[]).map((x) => String(x).trim()).filter(Boolean) : undefined;
    const res = await pushRecord({
      workspace: ws,
      id: r?.id ?? null,
      baseRev: r ? Number(body.baseRev ?? r.rev) : null,
      type: t.key,
      title,
      fields,
      body: text,
      folder: r ? null : (body.folder as string | undefined) ?? null,
      parent,
      aliases,
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
      if (!fs.realpathSync(abs).startsWith(fs.realpathSync(co.root) + path.sep)) return send(403, { error: "Not allowed" });
      const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".pdf": "application/pdf" };
      res.writeHead(200, { "content-type": types[path.extname(abs).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    if (parts[0] === "state" && m === "GET") {
      role = null;
      const shared = sidebarJson(false);
      const personal = sidebarJson(true);
      return send(200, {
        mode: "local",
        user: { email: user.email, id: user.id },
        role: await myRole(),
        workspace: { id: ws, name: co.config.workspaceName ?? ws, home: storeKind() === "cloud" || (await (await import("./sync.ts")).syncCall("status", ws))?.hub.kind === "cloud" ? "cloud" : "local" },
        root: co.root,
        layout: co.config.layout,
        types: state.snap.types.map(typeJson),
        records: state.snap.records.map(summary),
        views: dataViews().map(viewJson),
        // one tree or two sections is a personal setting; alone in a workspace, one tree by default
        sidebar: { workspace: shared, personal, display: (personal.definition.display as string | undefined) ?? (memberCount > 1 ? "split" : "merged") },
        members: memberCount,
        tables: tablesJson(),
        // older clients
        tree: shared.tree,
        hasSidebar: shared.exists,
      });
    }
    // ---- database observation and sync state for this workspace
    if (parts[0] === "sync" && (m === "GET" || m === "POST")) {
      if (storeKind() !== "local") return send(200, { enabled: false, store: "cloud", state: "cloud", syncing: false, loopEnabled: false, database });
      // The database owner holds the actual in-flight round state.
      const { syncCall } = await import("./sync.ts");
      if (m === "POST") {
        const b = await readBody();
        if (b.resolve) await syncCall("resolve", ws, String(b.resolve));
        else {
          await syncCall("now", ws);
          await refresh("sync");
        }
      }
      const s = await syncCall("status", ws);
      if (!s) return send(200, { enabled: false, store: "local", state: "local", syncing: false, loopEnabled: false, database });
      const offline = s.errorKind === "network";
      const pending = Object.values(s.pending as Record<string, number>).reduce((a, b) => a + b, 0);
      const state = s.syncing ? "syncing" : s.last_error ? offline ? "unreachable" : "error" : !s.last_sync ? "never-synced" : pending ? "pending" : "synced";
      return send(200, { enabled: true, store: "local", state, syncing: s.syncing, loopEnabled: s.loopEnabled, database, hub: s.hub.kind === "cloud" ? "the cloud" : s.hub.url, hubWorkspace: s.hub.workspace, lastSync: s.last_sync, error: s.last_error, errorKind: s.errorKind, offline, pending, conflicts: s.conflicts });
    }
    // ---- views (tables, boards, lists, calendars)
    if (parts[0] === "view" && parts[1]) {
      const personal = url.searchParams.get("personal") === "1";
      const v = state.views.find((x) => x.key === parts[1] && !!x.owner === personal) ?? (personal ? undefined : state.views.find((x) => x.key === parts[1]));
      if (m === "GET") {
        if (!v || isTreeDef(v.key, v.definition)) throw new HttpError(404, "No such view");
        const d = v.definition as { from: string; where?: string; sort?: string; limit?: number };
        const t = state.snap.types.find((x) => x.key === d.from);
        const thisId = url.searchParams.get("this") || null;
        const ctx = { typeOf: state.snap.typeMap, titles: new Map(state.snap.all.map((r) => [r.id, r.title])), thisId };
        let rows: RecordRow[] = [];
        let problem: string | null = null;
        try {
          rows = t ? state.snap.records.filter((r) => r.type_id === t.id && matches(r, parseWhere(d.where), ctx)) : [];
          rows = sortRows(rows, d.sort ?? "title", ctx);
          if (d.limit) rows = rows.slice(0, d.limit);
          if (!t) problem = `No type "${d.from}"`;
        } catch (e) {
          problem = (e as Error).message;
        }
        return send(200, { view: viewJson(v), records: rows.map(recordJson), problem, this: thisId ? summaryOf(thisId) : null });
      }
      if (m === "PUT") {
        const b = await readBody();
        const def = (b.definition ?? {}) as Record<string, unknown>;
        const errors = validateDataView(def, state.snap.types);
        if (errors.length) throw new HttpError(422, errors.join("; "), { problems: errors });
        const res = await saveView(ws, parts[1], String(b.name ?? v?.name ?? parts[1]), def, b.baseRev ?? v?.rev ?? null, personal);
        if (!res.ok) throw new HttpError(res.kind === "conflict" ? 409 : 422, res.message);
        await refresh("view", []);
        return send(200, { view: viewJson(res.view) });
      }
      if (m === "DELETE") {
        if (parts[1] === "sidebar") throw new HttpError(400, "The sidebar can't be removed");
        await deleteView(ws, parts[1], personal);
        await refresh("view", []);
        return send(200, { ok: true });
      }
    }
    if (parts[0] === "views" && m === "POST") {
      // create: picks a free key from the name
      const b = await readBody();
      const personal = !!b.personal;
      const def = (b.definition ?? {}) as Record<string, unknown>;
      const errors = validateDataView(def, state.snap.types);
      if (errors.length) throw new HttpError(422, errors.join("; "), { problems: errors });
      const base = String(b.name ?? "view").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "view";
      let key = base === "sidebar" ? "sidebar-view" : base;
      for (let i = 2; state.views.some((x) => x.key === key && !!x.owner === personal); i++) key = `${base}-${i}`;
      const res = await saveView(ws, key, String(b.name ?? key), def, null, personal);
      if (!res.ok) throw new HttpError(422, res.message);
      await refresh("view", []);
      return send(200, { view: viewJson(res.view) });
    }
    // ---- sidebars
    if (parts[0] === "sidebar" && m === "PUT") {
      const b = await readBody();
      const personal = b.scope === "personal";
      const def = (b.definition ?? {}) as Record<string, unknown>;
      const errors = validateTree(def, state.snap.types, personal ? dataViews() : dataViews().filter((x) => !x.owner));
      if (errors.length) throw new HttpError(422, errors.join("; "), { problems: errors });
      const cur = sidebarRow(personal);
      if (!personal && !["owner", "admin"].includes(await myRole())) throw new HttpError(403, "Only owners and admins arrange the workspace sidebar. Add things to your personal sidebar instead.");
      const res = await saveView(ws, "sidebar", personal ? "My sidebar" : "Sidebar", def, b.baseRev === undefined ? cur?.rev ?? null : b.baseRev, personal);
      if (!res.ok) throw new HttpError(res.kind === "conflict" ? 409 : 422, res.message);
      await refresh("sidebar", []);
      return send(200, { sidebar: sidebarJson(personal) });
    }
    if (parts[0] === "tables" && m === "PUT") {
      const b = await readBody();
      const def = (b.definition ?? {}) as Record<string, unknown>;
      const errors = validateTree(def, state.snap.types, []);
      if (errors.length) throw new HttpError(422, errors.join("; "), { problems: errors });
      if (!["owner", "admin"].includes(await myRole())) throw new HttpError(403, "Only owners and admins arrange table folders.");
      const res = await saveView(ws, "tables", "Table folders", def, b.baseRev === undefined ? tablesRow()?.rev ?? null : b.baseRev, false);
      if (!res.ok) throw new HttpError(res.kind === "conflict" ? 409 : 422, res.message);
      await refresh("view", []);
      return send(200, { tables: tablesJson() });
    }
    // ---- types
    if (parts[0] === "type" && parts[1] && m === "PUT") {
      const t = state.snap.types.find((x) => x.key === parts[1]);
      if (!t) throw new HttpError(404, "No such type");
      const b = await readBody();
      const patch: Record<string, unknown> = {};
      if (b.name !== undefined) patch.name = String(b.name).trim() || t.name;
      if (b.folder !== undefined) patch.folder = String(b.folder).trim() || null;
      if (b.fields !== undefined) {
        // field targets arrive as type keys; the database stores type ids
        const fields = (b.fields as Record<string, unknown>[]).map((f) => {
          const out: Record<string, unknown> = { ...f };
          if (typeof f.target === "string" && f.target) {
            const tt = state.snap.types.find((x) => x.key === f.target || x.id === f.target);
            if (!tt) throw new HttpError(422, `No type "${f.target}" for the link field "${f.key}"`);
            out.target = tt.id;
          } else delete out.target;
          if (!out.id) delete out.id;
          return out;
        });
        if (fields.some((f) => f.inverse)) {
          try { await requireInverseSchema(); }
          catch (error) { throw new HttpError(422, (error as Error).message); }
        }
        patch.fields = fields;
      }
      if (b.display !== undefined) {
        if (!["document", "fields"].includes(b.display)) throw new HttpError(422, "display must be document or fields");
        patch.display = b.display;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change");
      const { data, error } = await sb().from("types").update(patch).eq("id", t.id).select("id");
      if (error) throw new HttpError(422, dbError(error).message);
      if (!data.length) throw new HttpError(403, "Only owners and admins can change types.");
      await refresh("types", []);
      return send(200, { ok: true });
    }
    if (parts[0] === "types" && m === "POST") {
      const b = await readBody();
      const key = String(b.key ?? "").trim();
      const name = String(b.name ?? "").trim() || key.replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new HttpError(422, "A type key is lowercase letters, digits and _ (like budget_line).");
      const { error } = await sb().from("types").insert({ workspace_id: ws, key, name, folder: b.folder ?? `${name}s`, display: b.display === "fields" ? "fields" : "document" });
      if (error) throw new HttpError(error.code === "23505" ? 409 : 422, error.code === "23505" ? `A type "${key}" already exists.` : dbError(error).message);
      await refresh("types", []);
      return send(200, { ok: true, key });
    }
    // ---- sharing
    if (parts[0] === "members" && m === "GET") {
      // a local workspace that syncs is shared through its cloud copy
      const { shareState } = await import("./cloud.ts");
      const s = await shareState(ws).catch(async () => ({ shared: false, cloud: null, workspace: ws, members: await fetchMembers(ws), invites: await fetchInvites(ws).catch(() => []) }));
      return send(200, { members: s.members, invites: s.invites, role: await myRole(), shared: s.shared, cloud: s.cloud });
    }
    if (parts[0] === "invites" && m === "POST") {
      const b = await readBody();
      const { createInvite } = await import("./cloud.ts");
      try {
        const msg = await createInvite(ws, String(b.email ?? ""), String(b.role ?? "member"));
        return send(200, { ok: true, message: msg });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    }
    if (parts[0] === "share" && parts[1] === "device" && m === "POST") {
      const { deviceInvite } = await import("./cloud.ts");
      try {
        return send(200, await deviceInvite(ws));
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    }
    if (parts[0] === "invites" && parts[1] && m === "DELETE") {
      const { shareTarget } = await import("./cloud.ts");
      const t = await shareTarget(ws).catch(() => ({ db: sb(), workspace: ws }));
      const { error } = await t.db.from("invites").delete().eq("id", parts[1]).eq("workspace_id", t.workspace);
      if (error) throw dbError(error);
      return send(200, { ok: true });
    }
    if (parts[0] === "members" && parts[1] && (m === "PUT" || m === "DELETE")) {
      const { shareTarget } = await import("./cloud.ts");
      const t = await shareTarget(ws).catch(() => ({ db: sb(), workspace: ws }));
      const q = m === "PUT"
        ? t.db.from("members").update({ role: String((await readBody()).role) }).eq("workspace_id", t.workspace).eq("user_id", parts[1]).select("user_id")
        : t.db.from("members").delete().eq("workspace_id", t.workspace).eq("user_id", parts[1]).select("user_id");
      const { data, error } = await q;
      if (error) throw dbError(error);
      if (!data?.length) throw new HttpError(403, "Only owners and admins can change members.");
      role = null;
      return send(200, { ok: true });
    }
    if (parts[0] === "workspaces" && m === "GET") {
      const { data, error } = await sb().from("workspaces").select("id,name,members(role,user_id)");
      if (error) throw dbError(error);
      const known = knownCheckouts();
      const list = (data as { id: string; name: string; members: { role: string; user_id: string }[] }[]).map((w) => ({ id: w.id, name: w.name, role: w.members.find((x) => x.user_id === user.id)?.role ?? null, current: w.id === ws, checkout: known.find((k) => k.workspace === w.id)?.root ?? null }));
      // invites addressed to me (admins can also see the ones they sent)
      const mine = (await myInvites().catch(() => [])).filter((i) => i.email.toLowerCase() === (user.email ?? "").toLowerCase());
      return send(200, { workspaces: list, invites: mine });
    }
    if (parts[0] === "workspaces" && m === "POST") {
      const b = await readBody();
      const name = String(b.name ?? "").trim();
      if (!name) throw new HttpError(422, "Give the workspace a name.");
      const { data, error } = await sb().rpc("create_workspace", { p_name: name });
      if (error) throw dbError(error);
      return send(200, { workspace: data });
    }
    if (parts[0] === "workspace" && parts[1] === "switch" && m === "POST") {
      // Open another workspace: its checkout on this computer, or a new one in ~/Surface-<name>.
      const b = await readBody();
      const id = String(b.id ?? "");
      const { data: w, error } = await sb().from("workspaces").select("id,name").eq("id", id).maybeSingle();
      if (error) throw dbError(error);
      if (!w) throw new HttpError(404, "No such workspace, or you're not a member.");
      return send(200, { ok: true, url: `/w/${w.id}/`, root: knownCheckouts().find(k => k.workspace === w.id)?.root ?? null });
    }
    if (parts[0] === "invites" && parts[1] && parts[2] === "accept" && m === "POST") {
      const { error } = await sb().rpc("accept_invite", { p_invite: parts[1] });
      if (error) throw dbError(error);
      return send(200, { ok: true });
    }
    if (parts[0] === "record" && parts[1] && parts[2] === "attach" && m === "POST") {
      // a pasted or dropped file: saved in an attachments/ folder next to the record's file,
      // linked from the text by a relative path (works in Obsidian and any editor)
      const r = state.snap.byId.get(parts[1]);
      if (!r) throw new HttpError(404, "No such record");
      const ctype = String(req.headers["content-type"] ?? "");
      const exts: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif", "application/pdf": ".pdf" };
      if (!exts[ctype]) throw new HttpError(415, "Only images and PDFs can be attached.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 25 * 1024 * 1024) throw new HttpError(413, "Files over 25 MB can't be attached.");
        chunks.push(c as Buffer);
      }
      const recPath = co.state.records[r.id]?.path ?? "";
      const dir = recPath.includes("/") ? recPath.split("/").slice(0, -1).join("/") : "";
      const raw = String(url.searchParams.get("name") ?? "image");
      let base = raw.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().slice(0, 60) || "image";
      if (/^image$/i.test(base)) base = `Pasted ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}`;
      const ext = exts[ctype];
      const attDir = path.join(co.root, dir, "attachments");
      fs.mkdirSync(attDir, { recursive: true });
      let name = `${base}${ext}`;
      for (let i = 2; fs.existsSync(path.join(attDir, name)); i++) name = `${base} ${i}${ext}`;
      fs.writeFileSync(path.join(attDir, name), Buffer.concat(chunks));
      return send(200, { path: path.posix.join(dir, "attachments", name), markdownPath: `attachments/${name}` });
    }
    if (parts[0] === "record" && parts[1] && parts[2] === "restore" && m === "POST") {
      const { data, error } = await sb().from("records").update({ deleted_at: null }).eq("id", parts[1]).eq("workspace_id", ws).select("id");
      if (error) throw dbError(error);
      if (!data.length) throw new HttpError(404, "No such record");
      await refresh("restore", [parts[1]]);
      return send(200, { ok: true });
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

  return { api, refresh, broadcast, watchCheckouts, clients: () => clients.size, close() {
    clearInterval(pollTimer); clearInterval(pingTimer); watcher?.close();
    for (const entry of extraCheckouts.values()) entry.watcher.close();
    for (const client of clients) client.end();
  } };
}

export async function serve(initial: Checkout, opts: { port: number; host?: string; watch?: boolean; listen?: boolean }) {
  const { running } = await import("./open.ts");
  if (await running()) throw new Error("Surface is already running. Use surface open or surface data.");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const lock = path.join(CONFIG_DIR, "server.lock");
  const release = () => {
    try { if (fs.readFileSync(lock,"utf8") === String(process.pid)) fs.rmSync(lock); } catch {}
  };
  try { fs.writeFileSync(lock,String(process.pid),{flag:"wx"}); }
  catch {
    let pid = 0;
    try { pid = Number(fs.readFileSync(lock,"utf8")); } catch {}
    let active = false;
    if (pid > 0) try { process.kill(pid,0); active = true; } catch (e) { active = (e as NodeJS.ErrnoException).code === "EPERM"; }
    if (active || !pid) throw new Error("Another Surface server is running or starting. Use surface open.");
    fs.rmSync(lock);
    fs.writeFileSync(lock,String(process.pid),{flag:"wx"});
  }
  process.once("exit",release);
  const token = serveToken();
  const port = opts.port;
  const host = opts.host ?? "127.0.0.1";
  const contexts = new Map<string, Promise<Awaited<ReturnType<typeof workspaceHandler>>>>();
  const version = installedVersion();
  let syncLoop: { kick: () => void; stop: () => void } | null = null;
  let discovering = false;
  let stopping = false;
  async function context(ws: string) {
    let promise = contexts.get(ws);
    if (!promise) {
      promise = (async () => {
        const { data: w, error } = await sb().from("workspaces").select("id,name").eq("id", ws).maybeSingle();
        if (error) throw dbError(error);
        if (!w) throw new HttpError(404, "No such workspace, or you're not a member.");
        let co = ws === initial.config.workspace ? initial : null;
        if (!co) {
          const known = knownCheckouts().find(k => k.workspace === ws);
          if (known) co = findCheckout(known.root);
        }
        if (!co) {
          // Keep UI-created workspaces visible to Markdown apps, without replacing a folder.
          const slug = w.name.replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"") || ws;
          let root = path.join(os.homedir(),`Surface-${slug}`);
          for (let i=2; fs.existsSync(root) && fs.readdirSync(root).length; i++) root = path.join(os.homedir(),`Surface-${slug}-${i}`);
          co = { root, config: { workspace: ws, workspaceName: w.name, layout: "type" }, state: { records: {} } };
          saveCheckout(co);
          await pull(co);
        }
        return workspaceHandler(co, opts, () => syncLoop?.kick());
      })();
      contexts.set(ws, promise);
      promise.catch(() => contexts.delete(ws));
    }
    return promise;
  }
  async function refreshAll() {
    await Promise.all([...contexts.values()].map(async p => (await p).refresh("sync")));
  }
  async function discover() {
    if (discovering || stopping) return;
    discovering = true;
    try {
      // Watch every known workspace, even when none of its browser tabs is open.
      const { data, error } = await sb().from("workspaces").select("id");
      if (error) throw dbError(error);
      const available = new Set((data ?? []).map(w => w.id));
      for (const [ws,p] of contexts) if (!available.has(ws)) { (await p).close(); contexts.delete(ws); }
      for (const k of knownCheckouts()) if (available.has(k.workspace)) await context(k.workspace).then(c => c.watchCheckouts()).catch(e => L.warn("checkout unavailable", { ws: k.workspace, err: e }));
    } finally { discovering = false; }
  }
  await context(initial.config.workspace);
  await discover();
  const discoveryTimer = setInterval(() => void discover().catch(e => L.warn("workspace discovery failed", { err: e })), 2500);
  discoveryTimer.unref();
  function staticFile(url: URL, res: http.ServerResponse, requestedPath = url.pathname) {
    if (!fs.existsSync(APP_DIR)) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("The app isn't built yet. Run `npm install && npm run build` in the app/ folder.");
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // Each installed app returns to the workspace it was installed from. A
    // relative manifest URL keeps this true for /w/<id>/ and /w/<id>/data/.
    if (url.pathname === "/manifest.webmanifest" || url.pathname === "/data/manifest.webmanifest") {
      const data = url.pathname.startsWith("/data/") || url.searchParams.get("app") === "data";
      const prefix = /^\/w\/[a-z0-9]+/.exec(requestedPath)?.[0] ?? "";
      const start = `${prefix}${data ? "/data/" : "/"}`;
      const manifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, "manifest.webmanifest"), "utf8"));
      res.writeHead(200, { "content-type": MIME[".webmanifest"], "cache-control": "no-cache" });
      return res.end(JSON.stringify({ ...manifest, name: data ? "Data View" : "Vault", short_name: data ? "Data View" : "Vault", id: start, start_url: start, scope: start }));
    }
    const app = appAtPath(url.pathname);
    if (app) rel = app.entry;
    let file = path.join(APP_DIR, rel);
    if (!file.startsWith(APP_DIR) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(APP_DIR, "index.html");
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // log API requests: every one at debug, slow (>1 s) or failed (>=400) ones always. Path only, never the query (it can hold the token).
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/events") {
      const t0 = Date.now();
      res.on("finish", () => {
        const ms = Date.now() - t0;
        const data = { method: req.method, path: url.pathname, status: res.statusCode, ms };
        if (res.statusCode >= 500) HL.error("request failed", data);
        else if (res.statusCode >= 400 && res.statusCode !== 401) HL.warn("request refused", data);
        else if (ms > 1000) HL.warn("slow request", data);
        else HL.debug("request", data);
      });
    }
    try {
      // Only answer requests addressed to this machine (blocks DNS rebinding).
      const h = (req.headers.host ?? "").toLowerCase();
      // Other computers syncing with this one (a hub) call /api/_db with the token header; browsers
      // can't send that header cross-site without a preflight we never answer.
      const hubCall = (url.pathname === "/api/_db" || url.pathname === "/api/_sync") && typeof req.headers["x-surface-token"] === "string" && !req.headers.origin;
      if (!hubCall && h !== `127.0.0.1:${port}` && h !== `localhost:${port}`) throw new HttpError(403, "Forbidden host");
      // Writes must come from the app itself.
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && origin !== `http://${h}`) throw new HttpError(403, "Forbidden origin");

      if (url.pathname === "/api/_health" && req.method === "GET") {
        if (req.headers["x-surface-token"] !== token || origin) throw new HttpError(403, "Forbidden");
        const loaded = await Promise.all(contexts.values());
        const { localAdmin } = await import("./local.ts");
        const pending = storeKind() === "local" ? await localAdmin(async tx => (await tx.query<{n:number}>("select count(*)::int as n from surface_local.sync_rows where dirty")).rows[0].n) : 0;
        res.writeHead(200,{"content-type":"application/json"});
        return res.end(JSON.stringify({ clients: loaded.reduce((n,c) => n+c.clients(),0), pending, commit: version.commit, dataDir: storeKind() === "local" ? dataDir() : null }));
      }
      // CLI processes on this computer send their queries here while serve owns the local database
      if (url.pathname === "/api/_db" && req.method === "POST") {
        if (req.headers["x-surface-token"] !== token || origin) throw new HttpError(403, "Forbidden");
        let body = "";
        for await (const c of req) body += c;
        const { exec } = await import("./local.ts");
        const out = await exec(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      // Sync commands from CLI processes on this computer (serve owns the database)
      if (url.pathname === "/api/_sync" && req.method === "POST") {
        if (req.headers["x-surface-token"] !== token || origin || storeKind() !== "local") throw new HttpError(403, "Forbidden");
        let body = "";
        for await (const c of req) body += c;
        const { op, args } = JSON.parse(body) as { op: string; args: unknown[] };
        const { runSyncOp } = await import("./sync.ts");
        res.writeHead(200, { "content-type": "application/json" });
        try {
          const ok = await runSyncOp(op, args ?? []);
          if (op !== "status" && op !== "list") void refreshAll().catch(e => L.warn("refresh failed", { err: e }));
          return res.end(JSON.stringify({ ok: ok ?? null }));
        } catch (e) {
          return res.end(JSON.stringify({ error: (e as Error).message }));
        }
      }
      const cookies = Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=") as [string, string]));
      const given = url.searchParams.get("token");
      if (given) {
        if (given !== token) throw new HttpError(403, "Wrong token");
        res.writeHead(302, {
          "set-cookie": `surface_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: url.pathname.startsWith("/w/") ? url.pathname : `/w/${initial.config.workspace}${appAtPath(url.pathname)?.path ?? "/"}`,
        });
        return res.end();
      }
      const authed = cookies.surface_token === token;
      const route = /^\/w\/([a-z0-9]+)(\/.*)?$/.exec(url.pathname);
      if (url.pathname.startsWith("/w/") && !route) throw new HttpError(404, "No such workspace");
      if (route && !route[2]) {
        res.writeHead(302, { location: `${url.pathname}/` }); return res.end();
      }
      const ws = route?.[1] ?? initial.config.workspace;
      const localUrl = new URL(url);
      if (route) localUrl.pathname = route[2] || "/";
      if (localUrl.pathname.startsWith("/api/")) {
        if (!authed) throw new HttpError(401, "Open the link printed by surface serve to sign this browser in.");
        if (localUrl.pathname === "/api/system" && req.method === "GET") {
          res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
          return res.end(JSON.stringify(systemInfo(version)));
        }
        return await (await context(ws)).api(req, localUrl, res);
      }
      if (!authed && !/\.(js|css|svg|png|webmanifest|woff2|ico)$/.test(url.pathname)) {
        res.writeHead(401, { "content-type": "text/plain" });
        return res.end("Surface is running. Open the link printed by surface serve to connect this browser.");
      }
      const requestedApp = appAtPath(url.pathname);
      if (authed && !route && requestedApp) {
        res.writeHead(302, { location: `/w/${initial.config.workspace}${requestedApp.path}` });
        return res.end();
      }
      if (route) await context(ws); // validate workspace before serving its page
      return staticFile(localUrl, res, url.pathname);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
      if (!(e instanceof HttpError)) {
        L.error("handler crashed", { method: req.method, path: url.pathname, err: e as Error });
        console.error(e);
      }
      if (!res.headersSent) res.writeHead(err.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message, ...err.extra }));
    }
  });

  if (opts.listen !== false) await new Promise<void>((resolve, reject) => {
    server.once("error", (e) => {
      L.error("could not listen", { port, err: e as Error });
      release();
      clearInterval(discoveryTimer);
      for (const p of contexts.values()) void p.then(c => c.close());
      reject(e);
    });
    server.listen(port, host, () => resolve());
  });
  let owner = false;
  if (storeKind() === "local") {
    const local = await import("./local.ts");
    if (opts.listen !== false) local.announceServer(port);
    owner = await local.ownsDatabase();
    // Workspaces with sync on trade changes with their hub in the background.
    // Only the process that owns the database syncs; a second server (e.g. `surface data`) leaves it to the owner.
    if (process.env.SURFACE_SYNC !== "off" && owner) {
      const { startSyncLoop } = await import("./sync.ts");
      syncLoop = startSyncLoop(() => void refreshAll().catch(e => L.warn("refresh failed", { err: e })), Number(process.env.SURFACE_SYNC_MS ?? 5000), () => {
        for (const p of contexts.values()) void p.then(c => c.broadcast({ type: "sync" }));
      });
    }
  }
  L.info("started", { port, root: initial.root, store: storeKind(), workspaces: contexts.size, sync: !!syncLoop });
  if (opts.listen !== false) (await import("./open.ts")).announceRunning(port, initial.root);
  const link = `http://127.0.0.1:${port}/w/${initial.config.workspace}/?token=${token}`;
  console.log(`Surface is running for all workspaces on this computer.`);
  console.log(`Open: ${link}`);
  console.log(`Log: ${logFile() ?? "off"}`);
  // Passive bounded release discovery shares its cache with the CLI; it never installs.
  const checkUpdates = () => void maybeCheckForUpdates().catch(e => L.debug("update discovery unavailable", { err:e }));
  if (opts.listen !== false) checkUpdates();
  const updateTimer = opts.listen !== false ? setInterval(checkUpdates,15 * 60 * 1000) : null;
  updateTimer?.unref();
  server.on("close", () => {
    stopping = true; release(); clearInterval(discoveryTimer); syncLoop?.stop();
    if (updateTimer) clearInterval(updateTimer);
    for (const p of contexts.values()) void p.then(c => c.close());
  });
  return { server, link };
}
