// Local store: Surface's own Postgres on this computer (PGlite), no account.
//
// It runs the same migrations as the hosted database (supabase/migrations) behind a tiny
// auth shim, and acts as the one local user under the same role and row-level security.
// It answers the subset of the supabase-js client the CLI uses (from/select/eq/…, rpc,
// auth.getUser), so every command works the same against either store.
//
// One process opens the database at a time. `surface serve` holds it while it runs and
// writes its port into the lock file; other CLI processes then send their queries to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_DIR } from "./config.ts";

type PG = import("@electric-sql/pglite").PGlite;
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number };

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../supabase/migrations");

export function dataDir(): string {
  if (process.env.SURFACE_DATA_DIR) return process.env.SURFACE_DATA_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Surface");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "surface");
}
const dbDir = () => path.join(dataDir(), "db");
const lockFile = () => path.join(dataDir(), "db.lock");

// What Supabase provides that the migrations use.
const SHIM = `
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select jsonb_build_object('sub', auth.uid(), 'email', (select email from auth.users where id = auth.uid())) $f$;
grant usage on schema auth to authenticated;
grant select on auth.users to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function auth.jwt() to authenticated;
create schema if not exists surface_local;
create table if not exists surface_local.migrations (name text primary key, applied_at timestamptz not null default now());
`;

// Sync bookkeeping (local only, never in the shared migrations). A workspace with a row in
// sync_workspaces syncs with a hub (the cloud, or another Surface server). Every local change to
// its records, types and views marks a sync_rows entry dirty; the sync loop (sync.ts) pushes dirty
// rows and pulls the hub's changes. Writes made by the sync loop itself set surface.applying so
// they don't bounce back.
const SYNC = `
create table if not exists surface_local.sync_workspaces (
  workspace_id text primary key,
  hub          jsonb not null,
  enabled_at   timestamptz not null default now(),
  last_sync    timestamptz,
  last_error   text
);
create table if not exists surface_local.sync_rows (
  workspace_id text not null,
  kind         text not null check (kind in ('record','type','view')),
  key          text not null,             -- record id, type id, or view key ('p:' prefix = personal)
  synced       text,                      -- hub version last matched: record rev, type updated_at, view rev
  dirty        boolean not null default true,
  hub_id       text,                      -- types: the hub's id for this type
  primary key (workspace_id, kind, key)
);
alter table surface_local.sync_rows add column if not exists hub_id text;
alter table surface_local.sync_workspaces add column if not exists pull_cursor timestamptz;   -- hub clock: newest updated_at seen
alter table surface_local.sync_workspaces add column if not exists full_scan_at timestamptz;  -- last full id:rev comparison
create table if not exists surface_local.sync_conflicts (
  id           bigint generated always as identity primary key,
  workspace_id text not null,
  record_id    text not null,
  copy_id      text,
  title        text,
  at           timestamptz not null default now(),
  resolved     boolean not null default false
);
create or replace function surface_local.track() returns trigger language plpgsql security definer as $f$
declare
  ws text; k text; oldk text;
begin
  if current_setting('surface.applying', true) = 'on' then return null; end if;
  if tg_op = 'DELETE' then ws := old.workspace_id; else ws := new.workspace_id; end if;
  if not exists (select 1 from surface_local.sync_workspaces where workspace_id = ws) then return null; end if;
  if tg_argv[0] = 'view' then
    if tg_op <> 'INSERT' then oldk := case when old.owner is null then '' else 'p:' end || old.key; end if;
    if tg_op <> 'DELETE' then k := case when new.owner is null then '' else 'p:' end || new.key; end if;
  else
    if tg_op = 'DELETE' then k := old.id; else k := new.id; end if;
  end if;
  if oldk is not null and oldk is distinct from k then
    insert into surface_local.sync_rows (workspace_id, kind, key, dirty) values (ws, tg_argv[0], oldk, true)
      on conflict (workspace_id, kind, key) do update set dirty = true;
  end if;
  if k is not null then
    insert into surface_local.sync_rows (workspace_id, kind, key, dirty) values (ws, tg_argv[0], k, true)
      on conflict (workspace_id, kind, key) do update set dirty = true;
  end if;
  return null;
end $f$;
create or replace trigger surface_sync_track after insert or update or delete on public.records
  for each row execute function surface_local.track('record');
create or replace trigger surface_sync_track after insert or update or delete on public.types
  for each row execute function surface_local.track('type');
create or replace trigger surface_sync_track after insert or update or delete on public.views
  for each row execute function surface_local.track('view');
`;
// Supabase grants the API roles access to public tables by default.
const GRANTS = `
grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
`;

// ---------------------------------------------------------------------------
// Opening the database (and the one-process lock)
// ---------------------------------------------------------------------------
let db: PG | null = null;
let remote: { port: number; token: string } | null = null;
let me: { id: string; email: string } | null = null;
let holdsLock = false;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function acquire(): Promise<"mine" | { port: number }> {
  fs.mkdirSync(dataDir(), { recursive: true });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }), { flag: "wx" });
      holdsLock = true;
      return "mine";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held: { pid?: number; port?: number } = {};
    try {
      held = JSON.parse(fs.readFileSync(lockFile(), "utf8"));
    } catch {}
    if (!held.pid || !alive(held.pid)) {
      fs.rmSync(lockFile(), { force: true }); // stale
      continue;
    }
    if (held.port) return { port: held.port };
    if (Date.now() > deadline) throw new Error(`The local database is busy (process ${held.pid}). Try again in a moment.`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function release() {
  if (!holdsLock) return;
  holdsLock = false;
  try {
    const held = JSON.parse(fs.readFileSync(lockFile(), "utf8"));
    if (held.pid === process.pid) fs.rmSync(lockFile(), { force: true });
  } catch {}
}
process.on("exit", release);
// close the database cleanly on Ctrl-C or a service stop, so nothing is lost or left locked
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    closeLocal().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

/** `surface serve` owns the database while it runs: other processes send it their queries. */
export function announceServer(port: number) {
  if (holdsLock) fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, port }));
}

async function ensure(): Promise<void> {
  if (db || remote) return;
  const got = await acquire();
  if (got !== "mine") {
    const token = fs.readFileSync(path.join(CONFIG_DIR, "serve-token"), "utf8").trim();
    remote = { port: got.port, token };
    return;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const fresh = !fs.existsSync(path.join(dbDir(), "PG_VERSION"));
  db = new PGlite(dbDir());
  await db.exec(SHIM);
  await migrate(db);
  await db.exec(SYNC);
  let u = (await db.query<{ id: string; email: string }>("select id::text, email from auth.users order by created_at limit 1")).rows[0];
  if (!u) {
    u = { id: crypto.randomUUID(), email: `${os.userInfo().username}@${os.hostname().split(".")[0] || "this-computer"}` };
    await db.query("insert into auth.users (id, email) values ($1, $2)", [u.id, u.email]);
  }
  me = u;
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${u.id}', false);`);
  if (fresh) process.stderr.write(`Created the local database in ${dbDir()}\n`);
}

async function migrate(pg: PG) {
  const done = new Set((await pg.query<{ name: string }>("select name from surface_local.migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await pg.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
    await pg.exec(GRANTS);
    await pg.query("insert into surface_local.migrations (name) values ($1)", [f]);
  }
}

export async function closeLocal() {
  if (db) {
    await db.close().catch(() => {});
    db = null;
  }
  release();
}

/** For `surface setup` / `doctor`. */
export async function localInfo() {
  await ensure();
  if (remote) return { dir: dbDir(), via: `surface serve on port ${remote.port}`, migrations: [] as string[], user: (await exec({ kind: "user" })).data as { email: string } };
  await db!.exec("reset role");
  const migrations = (await db!.query<{ name: string }>("select name from surface_local.migrations order by name")).rows.map((r) => r.name);
  await db!.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${me!.id}', false);`);
  return { dir: dbDir(), via: "this process", migrations, user: me! };
}

// ---------------------------------------------------------------------------
// Query descriptors: built by the client below, run here or by `surface serve`
// ---------------------------------------------------------------------------
type Filter = { col: string; op: "eq" | "is" | "in" | "not_is" | "gte"; value: unknown };
export type Desc =
  | { kind: "user" }
  | { kind: "rpc"; fn: string; args: Row }
  | {
      kind: "select" | "insert" | "update" | "delete" | "upsert";
      table: string;
      columns?: string; // select list, or the returning list after a write
      filters: Filter[];
      order: { col: string; asc: boolean }[];
      range?: [number, number];
      single?: "one" | "maybe";
      values?: Row | Row[];
      onConflict?: string;
      returning: boolean;
    };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const id = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`bad identifier "${s}"`);
  return `"${s}"`;
};

function clean(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}

const colTypes = new Map<string, Map<string, string>>();
async function columns(table: string) {
  let m = colTypes.get(table);
  if (!m) {
    const r = await db!.query<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    m = new Map(r.rows.map((x) => [x.column_name, x.data_type]));
    colTypes.set(table, m);
  }
  return m;
}

let fks: { child: string; parent: string; child_col: string; parent_col: string }[] | null = null;
async function foreignKeys() {
  fks ??= (
    await db!.query<{ child: string; parent: string; child_col: string; parent_col: string }>(`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, a.attname as child_col, b.attname as parent_col
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_attribute b on b.attrelid = c.confrelid and b.attnum = c.confkey[1]
       where c.contype = 'f'`)
  ).rows.map((r) => ({ ...r, child: r.child.replace(/^public\./, ""), parent: r.parent.replace(/^public\./, "") }));
  return fks;
}

/** "id,name,members(role,user_id)" → SQL select list, with embedded relations as JSON. */
async function selectList(table: string, list = "*"): Promise<string> {
  const parts: string[] = [];
  let depth = 0,
    cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const out: string[] = [];
  for (const p of parts) {
    if (p === "*") {
      out.push("t.*");
      continue;
    }
    const m = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(p);
    if (!m) {
      out.push(`t.${id(p)}`);
      continue;
    }
    const [, rel, inner] = m;
    const cols = inner.split(",").map((c) => c.trim()).filter(Boolean);
    const obj = cols[0] === "*" ? "to_jsonb(r)" : `jsonb_build_object(${cols.map((c) => `'${c}', r.${id(c)}`).join(", ")})`;
    const keys = await foreignKeys();
    const up = keys.find((k) => k.child === table && k.parent === rel); // many-to-one: an object
    const down = keys.find((k) => k.child === rel && k.parent === table); // one-to-many: a list
    if (up) out.push(`(select ${obj} from public.${id(rel)} r where r.${id(up.parent_col)} = t.${id(up.child_col)}) as ${id(rel)}`);
    else if (down) out.push(`coalesce((select jsonb_agg(${obj}) from public.${id(rel)} r where r.${id(down.child_col)} = t.${id(down.parent_col)}), '[]'::jsonb) as ${id(rel)}`);
    else throw new Error(`no relation between ${table} and ${rel}`);
  }
  return out.join(", ");
}

const procs = new Map<string, { retset: boolean; composite: boolean; args: Map<string, string> }>();
async function procInfo(fn: string, given: string[]) {
  const key = fn + ":" + given.sort().join(",");
  let p = procs.get(key);
  if (!p) {
    const r = await db!.query<{ proretset: boolean; proargnames: string[] | null; argtypes: string[]; typtype: string }>(
      `select p.proretset, p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) as argtypes,
              (select typtype from pg_type where oid = p.prorettype) as typtype
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1
        order by p.pronargs`,
      [fn],
    );
    // the overload whose parameters cover exactly what was given (as PostgREST does)
    const cand = r.rows.find((x) => {
      const names = (x.proargnames ?? []).slice(0, x.argtypes.length);
      return given.every((g) => names.includes(g)) && names.length >= given.length;
    });
    if (!cand) throw new Error(`function ${fn}(${given.join(", ")}) not found`);
    const names = (cand.proargnames ?? []).slice(0, cand.argtypes.length);
    p = { retset: cand.proretset, composite: cand.typtype === "c", args: new Map(names.map((n, i) => [n, cand.argtypes[i]])) };
    procs.set(key, p);
  }
  return p;
}

function param(v: unknown, type: string | undefined): unknown {
  if (v === undefined) return null;
  if ((type === "jsonb" || type === "json") && v !== null) return JSON.stringify(v);
  return v;
}

async function run(d: Desc): Promise<Result> {
  if (d.kind === "user") return { data: me, error: null };
  const pg = db!;
  if (d.kind === "rpc") {
    const given = Object.keys(d.args).filter((k) => d.args[k] !== undefined);
    const p = await procInfo(d.fn, given);
    const vals: unknown[] = [];
    const named = given.map((k) => {
      const t = p.args.get(k);
      vals.push(param(d.args[k], t));
      return `${id(k)} => $${vals.length}::${t}`;
    });
    const r = await pg.query<Row>(`select * from public.${id(d.fn)}(${named.join(", ")})`, vals);
    if (p.retset) return { data: r.rows, error: null };
    if (p.composite) return { data: r.rows[0] ?? null, error: null };
    return { data: r.rows[0] ? Object.values(r.rows[0])[0] : null, error: null };
  }

  const types = await columns(d.table);
  const vals: unknown[] = [];
  const ph = (v: unknown, col?: string) => (vals.push(param(v, col ? types.get(col) : undefined)), `$${vals.length}${col && types.get(col) === "jsonb" ? "::jsonb" : ""}`);
  const whereSql = () => {
    const w = d.filters.map((f) => {
      if (f.op === "is") return `t.${id(f.col)} is null`;
      if (f.op === "gte") return (vals.push(f.value), `t.${id(f.col)} >= $${vals.length}`);
      if (f.op === "not_is") return `t.${id(f.col)} is not null`;
      if (f.op === "in") return (vals.push((f.value as unknown[]).map(String)), `t.${id(f.col)}::text = any($${vals.length}::text[])`);
      return (vals.push(f.value), `t.${id(f.col)} = $${vals.length}`);
    });
    return w.length ? ` where ${w.join(" and ")}` : "";
  };
  const ret = d.returning ? ` returning ${d.columns && d.columns !== "*" ? d.columns.split(",").map((c) => id(c.trim())).join(", ") : "*"}` : "";
  let sql: string;
  if (d.kind === "select") {
    sql = `select ${await selectList(d.table, d.columns)} from public.${id(d.table)} t${whereSql()}`;
    if (d.order.length) sql += ` order by ${d.order.map((o) => `t.${id(o.col)} ${o.asc ? "asc" : "desc"}`).join(", ")}`;
    if (d.range) sql += ` limit ${d.range[1] - d.range[0] + 1} offset ${d.range[0]}`;
  } else if (d.kind === "insert" || d.kind === "upsert") {
    const rows = Array.isArray(d.values) ? d.values : [d.values ?? {}];
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const tuples = rows.map((r) => `(${cols.map((c) => ph(r[c], c)).join(", ")})`);
    sql = `insert into public.${id(d.table)} as t (${cols.map(id).join(", ")}) values ${tuples.join(", ")}`;
    if (d.kind === "upsert") {
      const key = (d.onConflict ?? "id").split(",").map((c) => c.trim());
      const set = cols.filter((c) => !key.includes(c));
      sql += ` on conflict (${key.map(id).join(", ")}) do ${set.length ? `update set ${set.map((c) => `${id(c)} = excluded.${id(c)}`).join(", ")}` : "nothing"}`;
    }
    sql += ret;
  } else if (d.kind === "update") {
    const set = Object.entries(d.values as Row).map(([c, v]) => `${id(c)} = ${ph(v, c)}`);
    sql = `update public.${id(d.table)} as t set ${set.join(", ")}${whereSql()}${ret}`;
  } else {
    sql = `delete from public.${id(d.table)} as t${whereSql()}${ret}`;
  }

  const r = await pg.query<Row>(sql, vals);
  const rows = r.rows.map((x) => clean(x) as Row);
  if (d.kind !== "select" && !d.returning) return { data: null, error: null };
  if (d.single === "maybe") {
    if (rows.length > 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    return { data: rows[0] ?? null, error: null };
  }
  if (d.single === "one") {
    if (rows.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    return { data: rows[0], error: null };
  }
  return { data: rows, error: null };
}

// One query at a time on the single connection.
let queue: Promise<unknown> = Promise.resolve();

type Tx = Parameters<Parameters<PG["transaction"]>[0]>[0];

/** True when this process has the local database open (not handing queries to `surface serve`). */
export async function ownsLocal(): Promise<boolean> {
  await ensure();
  return !!db;
}
/** The port of the `surface serve` that owns the database, if another process does. */
export async function localOwnerPort(): Promise<number | null> {
  await ensure();
  return remote?.port ?? null;
}
export function localUser() {
  return me;
}

/** Run fn in one transaction as the database owner (row-level security off), for the sync loop.
 *  `applying` marks the writes as coming from the hub so they aren't tracked as local changes. */
export async function localAdmin<T>(fn: (tx: Tx) => Promise<T>, opts: { applying?: boolean } = {}): Promise<T> {
  await ensure();
  if (!db) throw new Error("surface serve owns the local database; ask it instead");
  const pg = db;
  const p = queue.then(() =>
    pg.transaction(async (tx) => {
      await tx.exec("set local role none");
      if (opts.applying) await tx.exec("select set_config('surface.applying', 'on', true)");
      return fn(tx);
    }),
  );
  queue = p.catch(() => {});
  return clean(await p) as T;
}

/** Run a descriptor here (if this process owns the database) or in `surface serve`. */
export async function exec(d: Desc): Promise<Result> {
  try {
    await ensure();
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
  if (remote) {
    try {
      const res = await fetch(`http://127.0.0.1:${remote.port}/api/_db`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-surface-token": remote.token },
        body: JSON.stringify(d),
      });
      return (await res.json()) as Result;
    } catch (e) {
      return { data: null, error: { message: `Couldn't reach surface serve on port ${remote.port}: ${(e as Error).message}` } };
    }
  }
  const p = queue.then(() => run(d)).then(
    (r) => ({ ...r, data: clean(r.data) }),
    (e: { message?: string; code?: string }) => ({ data: null, error: { message: e.message ?? String(e), code: e.code } }),
  );
  queue = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
// The supabase-js-shaped client
// ---------------------------------------------------------------------------
class Query implements PromiseLike<Result> {
  d: Extract<Desc, { table: string }>;
  run: (d: Desc) => Promise<Result>;
  constructor(table: string, run: (d: Desc) => Promise<Result> = exec) {
    this.d = { kind: "select", table, filters: [], order: [], returning: false };
    this.run = run;
  }
  select(columns = "*") {
    if (this.d.kind === "select") this.d.columns = columns;
    else {
      this.d.returning = true;
      this.d.columns = columns;
    }
    return this;
  }
  insert(values: Row | Row[]) {
    Object.assign(this.d, { kind: "insert", values });
    return this;
  }
  upsert(values: Row | Row[], opts: { onConflict?: string } = {}) {
    Object.assign(this.d, { kind: "upsert", values, onConflict: opts.onConflict });
    return this;
  }
  update(values: Row) {
    Object.assign(this.d, { kind: "update", values });
    return this;
  }
  delete() {
    this.d.kind = "delete";
    return this;
  }
  eq(col: string, value: unknown) {
    this.d.filters.push({ col, op: "eq", value });
    return this;
  }
  is(col: string, value: null) {
    if (value !== null) throw new Error("is() supports null only");
    this.d.filters.push({ col, op: "is", value });
    return this;
  }
  not(col: string, op: string, value: unknown) {
    if (op !== "is" || value !== null) throw new Error("not() supports (col, 'is', null) only");
    this.d.filters.push({ col, op: "not_is", value });
    return this;
  }
  gte(col: string, value: unknown) {
    this.d.filters.push({ col, op: "gte", value });
    return this;
  }
  in(col: string, value: unknown[]) {
    this.d.filters.push({ col, op: "in", value });
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.d.order.push({ col, asc: opts.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.d.range = [from, to];
    return this;
  }
  single() {
    this.d.single = "one";
    return this;
  }
  maybeSingle() {
    this.d.single = "maybe";
    return this;
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.run(this.d).then(ok, bad);
  }
}

const noAccount = { data: null, error: { message: "This computer uses the local store: no account needed. To use a hosted workspace, run `surface setup --cloud`." } };

/** A client for another Surface's database, reached through its `surface serve` (a sync hub). */
export function remoteClient(url: string, token: string) {
  const base = url.replace(/\/+$/, "");
  const run = async (d: Desc): Promise<Result> => {
    try {
      const res = await fetch(`${base}/api/_db`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-surface-token": token },
        body: JSON.stringify(d),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { data: null, error: { message: `hub answered ${res.status}: ${(await res.text()).slice(0, 200)}`, code: "hub" } };
      return (await res.json()) as Result;
    } catch (e) {
      return { data: null, error: { message: `offline: can't reach ${base} (${(e as Error).message})`, code: "offline" } };
    }
  };
  return {
    from: (table: string) => new Query(table, run),
    rpc: (fn: string, args: Row = {}) => run({ kind: "rpc", fn, args }),
    auth: {
      async getUser() {
        const r = await run({ kind: "user" });
        return r.error ? { data: { user: null }, error: r.error } : { data: { user: r.data as { id: string; email: string } }, error: null };
      },
    },
  };
}

export function localClient() {
  return {
    from: (table: string) => new Query(table),
    rpc: (fn: string, args: Row = {}) => exec({ kind: "rpc", fn, args }),
    auth: {
      async getUser() {
        const r = await exec({ kind: "user" });
        return r.error ? { data: { user: null }, error: r.error } : { data: { user: r.data as { id: string; email: string } }, error: null };
      },
      signUp: async (_: unknown) => noAccount,
      signInWithPassword: async (_: unknown) => noAccount,
      signOut: async () => ({ error: null }),
      stopAutoRefresh: async () => {},
    },
  };
}
