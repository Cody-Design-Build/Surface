// Checkout operations: pull (database → files), push (files → database), status, check.
import fs from "node:fs";
import path from "node:path";
import { type Checkout, saveCheckout } from "./config.ts";
import YAML from "yaml";
import { fetchRecords, fetchTypes, fetchViews, pushRecord, saveView, type RecordRow, type TypeRow } from "./db.ts";
import { validateTree } from "./tree.ts";
import { basename, hash, isBuiltinKey, parse, planPaths, render } from "./markdown.ts";
import { normalize, type Resolver } from "./normalize.ts";
import { writeAgentFiles } from "./skills.ts";

const IGNORED_DIRS = new Set([".surface", ".obsidian", ".git", ".agents", ".claude", "node_modules", ".trash"]);
const IGNORED_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

export function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.name.toLowerCase().endsWith(".md") && !(dir === root && IGNORED_FILES.has(e.name))) {
        out.push(path.relative(root, path.join(dir, e.name)));
      }
    }
  };
  walk(root);
  return out.sort();
}

const read = (co: Checkout, rel: string) => fs.readFileSync(path.join(co.root, rel), "utf8");

function writeFile(co: Checkout, rel: string, text: string) {
  const abs = path.join(co.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function removeFile(co: Checkout, rel: string) {
  const abs = path.join(co.root, rel);
  if (fs.existsSync(abs)) fs.rmSync(abs);
  // tidy empty folders Surface created
  let dir = path.dirname(abs);
  while (dir.startsWith(co.root) && dir !== co.root) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/** Files edited since Surface last wrote them. */
export function localEdits(co: Checkout): Set<string> {
  const edited = new Set<string>();
  for (const [id, st] of Object.entries(co.state.records)) {
    const abs = path.join(co.root, st.path);
    if (fs.existsSync(abs) && hash(fs.readFileSync(abs, "utf8")) !== st.hash) edited.add(id);
  }
  return edited;
}

export interface Snapshot {
  types: TypeRow[];
  typeMap: Map<string, TypeRow>;
  /** Records in this checkout (all, or the `only` types). */
  records: RecordRow[];
  /** Every live record in the workspace, for links that point outside a partial checkout. */
  all: RecordRow[];
  byId: Map<string, RecordRow>;
}

export async function snapshot(co: Checkout): Promise<Snapshot> {
  const types = await fetchTypes(co.config.workspace);
  const typeMap = new Map(types.map((t) => [t.id, t]));
  const all = await fetchRecords(co.config.workspace);
  const only = co.config.only?.length ? new Set(types.filter((t) => co.config.only!.includes(t.key)).map((t) => t.id)) : null;
  const records = only ? all.filter((r) => only.has(r.type_id)) : all;
  return { types, typeMap, records, all, byId: new Map(all.map((r) => [r.id, r])) };
}

const VIEWS_DIR = path.join(".surface", "views");
const viewPath = (key: string) => path.join(VIEWS_DIR, `${key}.yaml`);

/** View files edited since Surface last wrote them, plus new ones. */
export function localViewEdits(co: Checkout): string[] {
  const dir = path.join(co.root, VIEWS_DIR);
  if (!fs.existsSync(dir)) return [];
  const known = co.state.views ?? {};
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .filter((key) => hash(fs.readFileSync(path.join(dir, `${key}.yaml`), "utf8")) !== known[key]?.hash);
}

export function renderView(name: string, definition: Record<string, unknown>): string {
  return `# Surface view. Edit, then run \`surface push\`. Format: see \`surface tree --help\`.\n${YAML.stringify({ surface_view: 1, name, ...definition }, { lineWidth: 0 })}`;
}

export interface PullReport {
  written: string[];
  removed: string[];
  moved: string[];
  skipped: string[]; // local edits kept
}

/** Write the database into the folder. Files with unpushed edits are left alone unless `force`. */
export async function pull(co: Checkout, opts: { force?: boolean } = {}): Promise<PullReport> {
  const snap = await snapshot(co);
  const paths = planPaths(snap.records, snap.typeMap, co.config.layout);
  const edited = localEdits(co);
  const report: PullReport = { written: [], removed: [], moved: [], skipped: [] };
  const linkName = (id: string) => {
    const p = paths.get(id);
    return p ? basename(p) : (snap.byId.get(id)?.title ?? id);
  };
  const next: typeof co.state.records = {};

  for (const r of snap.records) {
    const t = snap.typeMap.get(r.type_id)!;
    const rel = paths.get(r.id)!;
    const prev = co.state.records[r.id];
    if (prev && edited.has(r.id) && !opts.force) {
      report.skipped.push(prev.path);
      next[r.id] = prev; // keep the old base so the edit can still be pushed
      continue;
    }
    const text = render(r, t, linkName);
    const abs = path.join(co.root, rel);
    if (prev && prev.path !== rel) {
      removeFile(co, prev.path);
      report.moved.push(`${prev.path} → ${rel}`);
    }
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) {
      writeFile(co, rel, text);
      if (!prev || prev.path === rel) report.written.push(rel);
    }
    next[r.id] = { path: rel, rev: r.rev, hash: hash(text) };
  }

  // Records gone from the database (deleted, or outside `only`)
  for (const [id, st] of Object.entries(co.state.records)) {
    if (next[id]) continue;
    if (edited.has(id) && !opts.force) {
      report.skipped.push(st.path);
      next[id] = st;
      continue;
    }
    removeFile(co, st.path);
    report.removed.push(st.path);
  }

  co.state.records = next;

  // Saved views → .surface/views/<key>.yaml
  const views = await fetchViews(co.config.workspace);
  const editedViews = new Set(localViewEdits(co));
  const nextViews: NonNullable<typeof co.state.views> = {};
  for (const v of views) {
    const rel = viewPath(v.key);
    if (editedViews.has(v.key) && !opts.force && fs.existsSync(path.join(co.root, rel))) {
      report.skipped.push(rel);
      if (co.state.views?.[v.key]) nextViews[v.key] = co.state.views[v.key];
      continue;
    }
    const text = renderView(v.name, v.definition);
    const abs = path.join(co.root, rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) {
      writeFile(co, rel, text);
      report.written.push(rel);
    }
    nextViews[v.key] = { rev: v.rev, hash: hash(text) };
  }
  for (const key of Object.keys(co.state.views ?? {})) {
    if (nextViews[key] || editedViews.has(key)) continue;
    const abs = path.join(co.root, viewPath(key));
    if (fs.existsSync(abs)) fs.rmSync(abs);
    report.removed.push(viewPath(key));
  }
  co.state.views = nextViews;

  co.state.pulledAt = new Date().toISOString();
  saveCheckout(co);
  writeAgentFiles(co, snap.types);
  return report;
}

/** Send edited or new view files. */
export async function pushViews(co: Checkout, types: TypeRow[], opts: { dryRun?: boolean; only?: string[] } = {}): Promise<FileResult[]> {
  const results: FileResult[] = [];
  const keys = localViewEdits(co).filter((k) => !opts.only || opts.only.includes(k));
  for (const key of keys) {
    const rel = viewPath(key);
    let def: Record<string, unknown>;
    try {
      def = YAML.parse(fs.readFileSync(path.join(co.root, rel), "utf8")) ?? {};
    } catch (e) {
      results.push({ path: rel, status: "error", notices: [], errors: [`broken YAML: ${(e as Error).message.split("\n")[0]}`] });
      continue;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      results.push({ path: rel, status: "error", notices: [], errors: ["view file names must be lowercase letters, digits, - or _"] });
      continue;
    }
    const { surface_view: _v, name, ...definition } = def as Record<string, unknown>;
    const errors = "items" in definition || key === "sidebar" ? validateTree(definition, types) : [];
    if (errors.length) {
      results.push({ path: rel, status: "rejected", notices: [], errors });
      continue;
    }
    const isNew = !co.state.views?.[key];
    if (opts.dryRun) {
      results.push({ path: rel, status: isNew ? "created" : "pushed", notices: [], errors: [] });
      continue;
    }
    const res = await saveView(co.config.workspace, key, typeof name === "string" ? name : key, definition, co.state.views?.[key]?.rev ?? null);
    if (!res.ok) {
      results.push({ path: rel, status: res.kind === "conflict" ? "conflict" : "rejected", notices: [], errors: [res.message] });
      continue;
    }
    // mark clean, so the pull afterwards rewrites it in canonical form
    co.state.views = { ...(co.state.views ?? {}), [key]: { rev: res.view.rev, hash: hash(fs.readFileSync(path.join(co.root, rel), "utf8")) } };
    results.push({ path: rel, status: isNew ? "created" : "pushed", notices: [], errors: [] });
  }
  return results;
}

/** Map link labels to record ids: checkout filenames first, then titles. */
export function makeResolver(co: Checkout, snap: Snapshot): Resolver {
  return {
    link(label, target) {
      // rebuilt per call: records created earlier in the same push become linkable
      const byBase = new Map<string, string>();
      for (const [id, st] of Object.entries(co.state.records)) byBase.set(basename(st.path).toLowerCase(), id);
      const ok = (id: string) => {
        const r = snap.byId.get(id);
        return r && (!target || r.type_id === target) ? id : null;
      };
      if (snap.byId.has(label)) return ok(label);
      const viaFile = byBase.get(label.toLowerCase());
      if (viaFile && ok(viaFile)) return viaFile;
      const byTitle = snap.all.filter(
        (r) => r.title.toLowerCase() === label.toLowerCase() && (!target || r.type_id === target),
      );
      return byTitle.length === 1 ? byTitle[0].id : null;
    },
  };
}

export interface FileResult {
  path: string;
  status: "unchanged" | "pushed" | "created" | "rejected" | "conflict" | "untracked" | "error";
  id?: string;
  notices: string[];
  errors: string[];
}

export interface Prepared {
  path: string;
  id: string | null;
  rev: number | null;
  type: TypeRow;
  title: string;
  fields: Record<string, unknown>;
  body: string;
  folder: string | null;
  /** "" = no parent, otherwise the parent's id */
  parent: string;
  notices: string[];
  errors: string[];
}

/** Read one file and normalize it against its type. Never writes. */
export function prepare(co: Checkout, snap: Snapshot, rel: string, resolver: Resolver, defaultType = "page"): Prepared | FileResult {
  const text = read(co, rel);
  const parsed = parse(text);
  const notices: string[] = [];
  const errors: string[] = [];
  if (parsed.error) return { path: rel, status: "error", notices, errors: [parsed.error] };
  const fm = parsed.frontmatter ?? {};
  const id = typeof fm.id === "string" && fm.id ? fm.id : fm.id != null ? String(fm.id) : null;

  const typeKey = typeof fm.type === "string" && fm.type ? fm.type : (id && snap.byId.get(id) ? snap.typeMap.get(snap.byId.get(id)!.type_id)!.key : defaultType);
  const type = snap.types.find((t) => t.key === typeKey || t.name.toLowerCase() === String(typeKey).toLowerCase());
  if (!type) return { path: rel, status: "error", id: id ?? undefined, notices, errors: [`unknown type "${typeKey}" (types: ${snap.types.map((t) => t.key).join(", ")})`] };
  if (fm.type && fm.type !== type.key) notices.push(`type "${fm.type}" → "${type.key}"`);

  let title = fm.title == null || String(fm.title).trim() === "" ? "" : String(fm.title).trim();
  if (!title) {
    title = basename(rel);
    notices.push(`no title: used the filename "${title}"`);
  }

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (isBuiltinKey(k)) continue;
    const def = type.fields.find((f) => f.key === k) ?? type.fields.find((f) => f.key === k.toLowerCase().replace(/[\s-]+/g, "_"));
    if (!def) {
      errors.push(`"${k}" isn't a field of ${type.key} (add it: surface field add ${type.key} ${k.toLowerCase().replace(/[\s-]+/g, "_")} --kind text)`);
      continue;
    }
    if (def.key !== k) notices.push(`field "${k}" → "${def.key}"`);
    const n = normalize(def, v, resolver);
    if (n.error) errors.push(`${def.key}: ${n.error}`);
    else {
      if (n.notice) notices.push(`${def.key}: ${n.notice}`);
      fields[def.key] = n.value;
    }
  }
  for (const def of type.fields) {
    if (def.required && (fields[def.key] === null || fields[def.key] === undefined)) errors.push(`${def.key}: is required`);
  }
  let parent = "";
  if (fm.parent != null && String(fm.parent).trim() !== "") {
    const n = normalize({ id: "parent", key: "parent", name: "Parent", kind: "link" }, fm.parent, resolver);
    if (n.error) errors.push(`parent: ${n.error}`);
    else {
      if (n.notice) notices.push(`parent: ${n.notice}`);
      parent = String(n.value ?? "");
      if (parent && parent === id) errors.push("parent: a record can't be its own parent");
    }
  }
  const rev = fm.rev == null ? null : Number(fm.rev);
  let folder: string | null = null;
  if (co.config.layout === "folder") {
    const dir = path.dirname(rel);
    folder = dir === "." ? "" : dir;
  }
  return { path: rel, id, rev: Number.isFinite(rev) ? rev : null, type, title, fields, body: parsed.body, folder, parent, notices, errors };
}

const isPrepared = (x: Prepared | FileResult): x is Prepared => "type" in x;

/** Files to consider: given paths, or every tracked file that was edited plus untracked ones. */
function candidates(co: Checkout, files: string[] | undefined): string[] {
  if (files && files.length) {
    return files.map((f) => path.relative(co.root, path.resolve(f)));
  }
  const tracked = new Map(Object.values(co.state.records).map((s) => [s.path, s]));
  return listMarkdown(co.root).filter((rel) => {
    const st = tracked.get(rel);
    if (!st) return true; // untracked
    return hash(read(co, rel)) !== st.hash;
  });
}

export async function push(
  co: Checkout,
  opts: { files?: string[]; includeNew?: boolean; dryRun?: boolean; defaultType?: string } = {},
): Promise<FileResult[]> {
  let snap = await snapshot(co);
  const results: FileResult[] = [];
  const given = opts.files?.length ? opts.files.map((f) => path.relative(co.root, path.resolve(f))) : undefined;
  const isView = (f: string) => f.startsWith(VIEWS_DIR + path.sep);
  const viewFiles = given?.filter(isView) ?? [];
  const mdFiles = given?.filter((f) => !isView(f));
  const files = given ? (mdFiles!.length ? candidates(co, mdFiles) : []) : candidates(co, undefined);
  if (!given || viewFiles.length) {
    const vr = await pushViews(co, snap.types, { dryRun: opts.dryRun, only: viewFiles.length ? viewFiles.map((f) => path.basename(f, ".yaml")) : undefined });
    results.push(...vr);
  }
  let changed = results.some((r) => r.status === "pushed" || r.status === "created") && !opts.dryRun;
  const resolver = makeResolver(co, snap);
  const tracked = new Set(Object.keys(co.state.records));

  // New files first, so tracked files can link to them. Files whose links point at
  // records created later in the same push get a second pass.
  let queue = [...files].sort((a, b) => Number(isTrackedPath(co, a)) - Number(isTrackedPath(co, b)));
  for (let pass = 0; pass < 2 && queue.length; pass++) {
  const retry: string[] = [];
  const lastPass = pass === 1;
  for (const rel of queue) {
    if (!fs.existsSync(path.join(co.root, rel))) {
      results.push({ path: rel, status: "error", notices: [], errors: ["file not found"] });
      continue;
    }
    const p = prepare(co, snap, rel, resolver, opts.defaultType);
    if (!isPrepared(p)) {
      results.push(p);
      continue;
    }
    const isNew = !p.id || (!tracked.has(p.id) && !snap.byId.has(p.id));
    if (isNew && !opts.includeNew) {
      results.push({ path: rel, status: "untracked", notices: [`would import as ${p.type.key}`, ...p.notices], errors: p.errors });
      continue;
    }
    if (p.errors.length) {
      if (!lastPass && p.errors.some((e) => e.includes("can't find a record"))) {
        retry.push(rel);
        continue;
      }
      results.push({ path: rel, status: "rejected", id: p.id ?? undefined, notices: p.notices, errors: p.errors });
      continue;
    }
    const current = p.id ? snap.byId.get(p.id) : undefined;
    if (current && sameContent(current, p)) {
      results.push({ path: rel, status: "unchanged", id: p.id!, notices: p.notices, errors: [] });
      if (p.notices.length && !opts.dryRun) changed = true; // rewrite the file in canonical form
      continue;
    }
    if (current && p.rev !== null && p.rev !== current.rev) {
      results.push({
        path: rel, status: "conflict", id: p.id!, notices: p.notices,
        errors: [`changed in Surface since you pulled (your rev ${p.rev}, now rev ${current.rev}). Run \`surface diff ${rel}\`, then pull and redo the edit.`],
      });
      continue;
    }
    if (opts.dryRun) {
      results.push({ path: rel, status: isNew ? "created" : "pushed", id: p.id ?? undefined, notices: p.notices, errors: [] });
      continue;
    }
    const res = await pushRecord({
      workspace: co.config.workspace,
      id: p.id,
      baseRev: current ? (p.rev ?? current.rev) : null,
      type: p.type.key,
      title: p.title,
      fields: p.fields,
      body: p.body,
      folder: p.folder,
      parent: p.parent,
    });
    if (!res.ok) {
      results.push({ path: rel, status: res.kind === "conflict" ? "conflict" : "rejected", id: p.id ?? undefined, notices: p.notices, errors: [res.message] });
      continue;
    }
    changed = true;
    // Track the file at its current path so the pull below rewrites it in place (or moves it).
    co.state.records[res.record.id] = { path: rel, rev: res.record.rev, hash: "" };
    snap.byId.set(res.record.id, res.record);
    snap.records = [...snap.records.filter((r) => r.id !== res.record.id), res.record];
    results.push({ path: rel, status: isNew ? "created" : "pushed", id: res.record.id, notices: p.notices, errors: [] });
  }
  queue = retry;
  }

  if (changed && !opts.dryRun) {
    // Pushed files now match the database; mark them clean so pull rewrites them canonically.
    for (const r of results) {
      if ((r.status === "pushed" || r.status === "created" || r.status === "unchanged") && r.id && co.state.records[r.id]) {
        co.state.records[r.id].hash = hash(read(co, co.state.records[r.id].path));
      }
    }
    saveCheckout(co);
    await pull(co);
  }
  return results;
}

function isTrackedPath(co: Checkout, rel: string) {
  return Object.values(co.state.records).some((s) => s.path === rel);
}

function sameContent(r: RecordRow, p: Prepared): boolean {
  if (r.title !== p.title || r.type_id !== p.type.id || r.body !== p.body) return false;
  if (p.folder !== null && (r.folder ?? "") !== p.folder) return false;
  if ((r.parent_id ?? "") !== p.parent) return false;
  for (const def of p.type.fields) {
    const a = r.fields[def.id] ?? null;
    const b = p.fields[def.key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

export interface StatusReport {
  edited: string[];
  untracked: string[];
  missing: string[];
  behind: string[]; // changed in the database since pull
  remoteNew: number;
  remoteDeleted: string[];
}

export async function status(co: Checkout): Promise<StatusReport> {
  const snap = await snapshot(co);
  const edited = localEdits(co);
  const trackedPaths = new Set(Object.values(co.state.records).map((s) => s.path));
  const rep: StatusReport = { edited: [], untracked: [], missing: [], behind: [], remoteNew: 0, remoteDeleted: [] };
  for (const [id, st] of Object.entries(co.state.records)) {
    if (!fs.existsSync(path.join(co.root, st.path))) rep.missing.push(st.path);
    else if (edited.has(id)) rep.edited.push(st.path);
    const r = snap.byId.get(id);
    if (!r) rep.remoteDeleted.push(st.path);
    else if (r.rev !== st.rev) rep.behind.push(st.path);
  }
  for (const rel of listMarkdown(co.root)) if (!trackedPaths.has(rel)) rep.untracked.push(rel);
  for (const key of localViewEdits(co)) rep.edited.push(viewPath(key));
  rep.remoteNew = snap.records.filter((r) => !co.state.records[r.id]).length;
  return rep;
}
