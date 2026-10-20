// Sync: a local workspace keeps working on its own database and, when sync is on, trades
// changes with a hub, record by record. Design: docs/LOCAL.md §1b.
//
//   - Every local change to a record, type or view is marked dirty by a trigger (local.ts).
//   - Push: each dirty record goes to the hub through push_record with the hub revision it was
//     last synced at. A newer hub revision means someone else changed it: your version is kept
//     as a conflict copy (a new record) and the record takes the hub's version. No merging.
//   - Pull: compare the hub's id:rev list with what we last synced; fetch and apply what changed.
//     Writes from the hub run with surface.applying set, so they aren't tracked as local changes.
//
// Records keep the same id everywhere. Types and fields are matched by key (field ids and type
// ids may differ between the local database and the hub); views by key and owner.
import { exec, localAdmin, localOwnerPort, localUser, remoteClient, type Desc } from "./local.ts";
import { CONFIG_DIR } from "./config.ts";
import { logger } from "./log.ts";
import fs from "node:fs";
import path from "node:path";

const L = logger("sync");

export type Hub = { kind: "surface"; url: string; token: string; workspace: string } | { kind: "cloud"; workspace: string };

export type HubInput = { kind: "cloud"; workspace?: string } | { kind: "surface"; url: string; token: string; workspace?: string };

type Row = Record<string, any>;
type Field = { id: string; key: string; kind: string; target?: string; [k: string]: unknown };
type TypeRow = { id: string; key: string; name: string; icon: string | null; folder: string | null; fields: Field[]; display?: string; is_builtin?: boolean; updated_at: string };
type Client = { from: (t: string) => any; rpc: (fn: string, args?: Row) => Promise<{ data: any; error: any }> };

export interface SyncReport {
  workspace: string;
  pushed: number;
  pulled: number;
  conflicts: string[];
  errors: string[];
  offline?: boolean;
  offlineReason?: string;
  scan?: "full" | "incremental";
}

class Offline extends Error {}

async function hubClient(hub: Hub): Promise<Client> {
  if (hub.kind === "surface") return remoteClient(hub.url, hub.token) as unknown as Client;
  const { cloudClient } = await import("./client.ts");
  return cloudClient() as unknown as Client;
}

/** Throw on a hub error; network failures become Offline so the loop just tries again later. */
function must<T = any>(r: { data: T; error: any }, what: string): T {
  if (r.error) {
    const msg = String(r.error.message ?? r.error);
    if (r.error.code === "offline" || /fetch failed|ECONNREFUSED|ENOTFOUND|network|timed? ?out/i.test(msg)) throw new Offline(msg);
    throw new Error(`${what}: ${msg}`);
  }
  return r.data;
}

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---------------------------------------------------------------------------
// Local bookkeeping
// ---------------------------------------------------------------------------
export async function syncedWorkspaces(): Promise<{ workspace_id: string; hub: Hub; last_sync: string | null; last_error: string | null }[]> {
  return localAdmin(async (tx) => (await tx.query<any>("select workspace_id, hub, last_sync, last_error from surface_local.sync_workspaces order by workspace_id")).rows);
}

export async function syncStatus(ws: string) {
  return localAdmin(async (tx) => {
    const w = (await tx.query<any>("select hub, last_sync, last_error from surface_local.sync_workspaces where workspace_id = $1", [ws])).rows[0];
    if (!w) return null;
    const pending = (await tx.query<any>("select kind, count(*)::int as n from surface_local.sync_rows where workspace_id = $1 and dirty group by kind", [ws])).rows;
    const conflicts = (await tx.query<any>("select id, record_id, copy_id, title, at from surface_local.sync_conflicts where workspace_id = $1 and not resolved order by at", [ws])).rows;
    const hub = { ...w.hub, token: w.hub.token ? "…" : undefined };
    return { hub, last_sync: w.last_sync, last_error: w.last_error, pending: Object.fromEntries(pending.map((p: any) => [p.kind, p.n])), conflicts };
  });
}

/** Turn sync on for a local workspace. With no hub workspace given, one is created on the hub. */
export function enableSync(ws: string, hubIn: HubInput): Promise<Hub> {
  return inWorkspace(ws, () => enableSyncNow(ws,hubIn));
}
async function enableSyncNow(ws: string, hubIn: HubInput): Promise<Hub> {
  const client = await hubClient(hubIn as Hub);
  let hubWs = hubIn.workspace;
  if (!hubWs) {
    const name: string | undefined = await localAdmin(async (tx) => (await tx.query<any>("select name from public.workspaces where id = $1", [ws])).rows[0]?.name);
    if (!name) throw new Error(`no local workspace ${ws}`);
    hubWs = must(await client.rpc("create_workspace", { p_name: name }), "create the hub workspace").id as string;
  }
  const hub = { ...hubIn, workspace: hubWs } as Hub;
  await localAdmin(async (tx) => {
    await tx.query("insert into surface_local.sync_workspaces (workspace_id, hub) values ($1, $2::jsonb) on conflict (workspace_id) do update set hub = excluded.hub", [ws, JSON.stringify(hub)]);
    // everything already here goes up on the first sync
    await tx.query(`insert into surface_local.sync_rows (workspace_id, kind, key, dirty)
      select workspace_id, 'type', id, true from public.types where workspace_id = $1
      union all select workspace_id, 'record', id, true from public.records where workspace_id = $1 and deleted_at is null
      union all select workspace_id, 'view', case when owner is null then '' else 'p:' end || key, true from public.views where workspace_id = $1
      on conflict do nothing`, [ws]);
  });
  return hub;
}

/** Make a new local workspace that is a synced copy of a hub workspace. Returns the local id. */
export async function joinSync(hubIn: HubInput & { workspace: string }, name?: string): Promise<string> {
  const client = await hubClient(hubIn as Hub);
  const w = must(await client.from("workspaces").select("id,name").eq("id", hubIn.workspace).maybeSingle(), "find the hub workspace");
  if (!w) throw new Error(`the hub has no workspace ${hubIn.workspace} you can see`);
  const me = localUser();
  const ws = await localAdmin(async (tx) => {
    const id = (await tx.query<any>("select public.surface_id() as id")).rows[0].id as string;
    await tx.query("insert into public.workspaces (id, name, created_by) values ($1, $2, $3)", [id, name ?? w.name, me!.id]);
    await tx.query("insert into public.members (workspace_id, user_id, role) values ($1, $2, 'owner')", [id, me!.id]);
    await tx.query("insert into public.types (workspace_id, key, name, folder, is_builtin) values ($1, 'page', 'Page', 'Pages', true)", [id]);
    await tx.query("insert into surface_local.sync_workspaces (workspace_id, hub) values ($1, $2::jsonb)", [id, JSON.stringify(hubIn)]);
    return id;
  });
  return ws;
}

export function disableSync(ws: string) {
  return inWorkspace(ws, () => disableSyncNow(ws));
}
async function disableSyncNow(ws: string) {
  await localAdmin(async (tx) => {
    for (const t of ["outbox", "sync_rows", "sync_conflicts", "sync_workspaces"]) await tx.query(`delete from surface_local.${t} where workspace_id = $1`, [ws]);
  });
}

export async function resolveConflict(ws: string, id: string) {
  await localAdmin((tx) => tx.query("update surface_local.sync_conflicts set resolved = true where workspace_id = $1 and (record_id = $2 or copy_id = $2 or id::text = $2)", [ws, id]));
}

// ---------------------------------------------------------------------------
// One sync round for one workspace
// ---------------------------------------------------------------------------
type Mark = { kind: string; key: string; synced: string | null; hub_id?: string | null; field_ids?: Record<string,string> | null };

async function syncWorkspaceNow(ws: string): Promise<SyncReport> {
  const rep: SyncReport = { workspace: ws, pushed: 0, pulled: 0, conflicts: [], errors: [] };
  const conf = (await syncedWorkspaces()).find((w) => w.workspace_id === ws);
  if (!conf) throw new Error(`sync is off for workspace ${ws}`);
  const hub = conf.hub;
  const client = await hubClient(hub);
  try {
    const hubTypes = await fetchHubTypes(client, hub.workspace);
    await syncTypes(ws, hub, client, hubTypes, rep);
    const types = await mapTypes(ws, await fetchHubTypes(client, hub.workspace));
    await pushRecords(ws, hub, client, types, rep);
    await pullRecords(ws, hub, client, types, rep);
    await syncViews(ws, hub, client, rep);
    await localAdmin((tx) => tx.query("update surface_local.sync_workspaces set last_sync = now(), last_error = $2 where workspace_id = $1", [ws, rep.errors.length ? rep.errors.join("; ").slice(0, 2000) : null]));
  } catch (e) {
    if (e instanceof Offline) {
      rep.offline = true;
      rep.offlineReason = (e as Error).message;
    } else {
      rep.errors.push((e as Error).message);
      L.error("round stopped", { ws, err: e as Error, pushed: rep.pushed, pulled: rep.pulled });
    }
    await localAdmin((tx) => tx.query("update surface_local.sync_workspaces set last_error = $2 where workspace_id = $1", [ws, (rep.offline ? "offline: " : "") + (e as Error).message]));
  }
  return rep;
}

const rounds = new Map<string, Promise<unknown>>();
function inWorkspace<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const p = (rounds.get(ws) ?? Promise.resolve()).then(fn, fn);
  rounds.set(ws, p);
  void p.finally(() => { if (rounds.get(ws) === p) rounds.delete(ws); }).catch(() => {});
  return p;
}
export function syncWorkspace(ws: string): Promise<SyncReport> {
  return inWorkspace(ws, () => syncWorkspaceNow(ws));
}

async function removeSharedType(ws: string, typeId: string, into: string | null, force: boolean) {
  return inWorkspace(ws, async () => {
    const conf = (await syncedWorkspaces()).find(w=>w.workspace_id===ws);
    if (!conf) throw new Error("This workspace is local; use the normal type command.");
    const report = await syncWorkspaceNow(ws);
    if (report.offline || report.errors.length) throw new Error("Removing a shared type needs the cloud online and pending edits synced first.");
    const client = await hubClient(conf.hub);
    const types = await fetchHubTypes(client,conf.hub.workspace);
    const localType = await localAdmin(async tx=>(await tx.query<any>("select key from public.types where id=$1 and workspace_id=$2",[typeId,ws])).rows[0]);
    const source = types.find(t=>t.key===localType?.key);
    if (!source || source.is_builtin) throw new Error("No removable cloud type.");
    const target = into ? types.find(t=>t.key===into) : undefined;
    if (into && (!target || target.id===source.id)) throw new Error("Choose a different existing destination type.");
    const records: Row[] = [];
    for (let offset=0;;offset+=1000) {
      const page = must(await client.from("records").select("*").eq("workspace_id",conf.hub.workspace).eq("type_id",source.id).order("id").range(offset,offset+999),"read type records");
      records.push(...page); if(page.length<1000) break;
    }
    if(records.some(r=>!r.deleted_at) && !force && !target) throw new Error("This type has records; use --move-to <type> or --force.");
    for(const r of records) {
      if(!r.deleted_at && target) {
        const values = byKey(r.fields,source);
        const fields = Object.fromEntries(Object.entries(values).filter(([k])=>target.fields.some(f=>f.key===k)));
        must(await client.rpc("push_record",{p_workspace:conf.hub.workspace,p_id:r.id,p_base_rev:r.rev,p_type:target.key,p_title:r.title,p_fields:fields,p_body:r.body,p_folder:target.folder}),"move cloud record");
      } else must(await client.from("records").delete().eq("id",r.id).eq("rev",r.rev).select("id"),"remove cloud record");
    }
    const deleted = must(await client.from("types").delete().eq("id",source.id).select("id"),"remove cloud type");
    if(!deleted.length) throw new Error("Cloud refused to remove this type.");
    // Pull moved records before deleting their former local type.
    const targetMap = await mapTypes(ws,types);
    for (const r of records) {
      const fresh = must(await client.from("records").select("*").eq("id",r.id).maybeSingle(),"read moved record");
      if (fresh) {
        const ht=targetMap.hubById.get(fresh.type_id)!;
        await applyRecord(ws,fresh,targetMap.localByKey.get(ht.key)!,ht);
      }
    }
    const done=await syncWorkspaceNow(ws);
    if(done.offline || done.errors.length) throw new Error("Cloud type was removed; this computer still needs to sync. " + done.errors.join("; "));
    return {removed:source.key};
  });
}

/** Shared schema changes execute at the hub, then return through the normal pull.
 * No local rewrite is allowed before cloud acceptance, including while offline. */
export async function routeSchemaWrite(d: Extract<Desc, { table: string }>) {
  if (d.kind === "select") return null;
  const input = Array.isArray(d.values) ? d.values : [d.values ?? {}];
  const rows = d.kind === "insert" ? input : ((await exec({ ...d, kind: "select", columns: "*", single: undefined, returning: false })).data ?? []) as Row[];
  const configs = await syncedWorkspaces();
  const shared = rows.map(row => ({ row, config: configs.find(c => c.workspace_id === row.workspace_id) }));
  if (!shared.some(x => x.config)) return null;
  if (shared.some(x => !x.config) || new Set(shared.map(x => x.row.workspace_id)).size !== 1)
    throw new Error("Change shared schemas one workspace at a time.");
  const ws = rows[0].workspace_id as string;
  return inWorkspace(ws, async () => {
    const conf = shared[0].config!;
    const report = await syncWorkspaceNow(ws);
    if (report.offline || report.errors.length) throw new Error("Schema changes need the cloud online and pending edits synced first. " + (report.offlineReason ?? report.errors.join("; ")));
    const client = await hubClient(conf.hub);
    const localTypes = await localAdmin(async tx => (await tx.query<any>("select * from public.types where workspace_id=$1", [ws])).rows as TypeRow[]);
    const cloudTypes = await fetchHubTypes(client, conf.hub.workspace);
    const marks = await localAdmin(async tx => (await tx.query<any>("select key,hub_id from surface_local.sync_rows where workspace_id=$1 and kind='type'", [ws])).rows);
    const cloudType = (id: string) => cloudTypes.find(t => t.id === marks.find(m => m.key === id)?.hub_id) ?? cloudTypes.find(t => t.key === localTypes.find(l => l.id === id)?.key);
    const changed: string[] = [];
    for (const { row } of shared) {
      const old = localTypes.find(t => t.id === row.id);
      if (old && (!equal(old.fields, row.fields) || old.key !== row.key)) throw new Error("Schema changed while syncing; refresh and retry your schema edit.");
      const remote = old ? cloudType(old.id) : undefined;
      const values: Row = { ...(d.kind === "insert" ? row : d.values as Row) };
      delete values.id; delete values.workspace_id;
      if (values.fields) values.fields = values.fields.map((f: Field) => {
        const copy = { ...f };
        const prior = old?.fields.find(p => p.id === f.id);
        const rf = remote?.fields.find(p => p.key === prior?.key);
        if (rf) copy.id = rf.id; else delete (copy as Row).id;
        if (copy.target) copy.target = cloudType(copy.target)?.key ?? copy.target;
        return copy;
      });
      let query;
      if (d.kind === "insert") query = client.from("types").insert({ ...values, workspace_id: conf.hub.workspace }).select("*");
      else {
        if (!remote) throw new Error(`Cloud type ${old?.key} no longer exists; refresh and retry.`);
        query = d.kind === "delete" ? client.from("types").delete().eq("id", remote.id).select("*")
          : client.from("types").update(values).eq("id", remote.id).eq("updated_at", remote.updated_at).select("*");
      }
      const saved = must(await query, "change cloud schema");
      if (!saved.length) throw new Error("Cloud schema changed or permission was denied. Refresh and retry.");
      changed.push(saved[0].key);
      if (d.kind === "delete" && old) await localAdmin(async tx => {
        const waiting = (await tx.query<any>("select count(*)::int as n from surface_local.outbox where workspace_id=$1 and after_row->>'type_id'=$2",[ws,old.id])).rows[0].n;
        if (waiting) throw new Error("The cloud type was removed, but new pending local records were preserved. Export or move them before syncing.");
        await tx.query("delete from public.records where type_id=$1", [old.id]);
        await tx.query("delete from public.types where id=$1", [old.id]);
        await tx.query("delete from surface_local.sync_rows where workspace_id=$1 and kind='type' and key=$2", [ws,old.id]);
      }, { applying: true });
    }
    const after = await syncWorkspaceNow(ws);
    if (after.offline || after.errors.length) throw new Error("Cloud schema was saved, but this computer still needs to sync. " + after.errors.join("; "));
    const local = await localAdmin(async tx => (await tx.query<any>("select * from public.types where workspace_id=$1 and key=any($2)", [ws,changed])).rows);
    return { data: d.returning ? (d.single ? local[0] ?? null : local) : null, error: null };
  });
}

export async function syncAll(): Promise<SyncReport[]> {
  const out: SyncReport[] = [];
  for (const w of await syncedWorkspaces()) out.push(await syncWorkspace(w.workspace_id));
  return out;
}

const OPS = {
  removeType: (ws: string, typeId: string, into: string | null, force: boolean) => removeSharedType(ws,typeId,into,force),
  now: (ws?: string) => (ws ? syncWorkspace(ws).then((r) => [r]) : syncAll()),
  status: (ws: string) => syncStatus(ws),
  list: () => syncedWorkspaces().then((ws) => ws.map((w) => ({ ...w, hub: { ...w.hub, token: undefined } }))),
  enable: (ws: string, hub: HubInput) => enableSync(ws, hub),
  join: (hub: HubInput & { workspace: string }, name?: string) => joinSync(hub, name),
  disable: (ws: string) => disableSync(ws),
  resolve: (ws: string, id: string) => resolveConflict(ws, id),
} as const;
export type SyncOp = keyof typeof OPS;

/** Run a sync operation here if this process owns the local database, else in `surface serve`. */
export async function syncCall(op: SyncOp, ...args: unknown[]): Promise<any> {
  const port = await localOwnerPort();
  if (port) {
    const token = fs.readFileSync(path.join(CONFIG_DIR, "serve-token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/_sync`, { method: "POST", headers: { "x-surface-token": token, "content-type": "application/json" }, body: JSON.stringify({ op, args }) });
    const out = (await res.json()) as { ok: unknown } | { error: string };
    if ("error" in out) throw new Error(out.error);
    return out.ok;
  }
  return runOp(op, args);
}
/** For serve's /api/_sync endpoint. */
export async function runSyncOp(op: string, args: unknown[]) {
  if (!(op in OPS)) throw new Error(`unknown sync operation ${op}`);
  return runOp(op as SyncOp, args);
}

/** Run an op here, logging the ones that change things (enable, join, disable, resolve, now). */
async function runOp(op: SyncOp, args: unknown[]) {
  const quiet = op === "status" || op === "list";
  const t0 = Date.now();
  try {
    const out = await (OPS[op] as (...a: unknown[]) => Promise<unknown>)(...args);
    if (!quiet) L.info(`op ${op}`, { args: args.map(a => a && typeof a === "object" ? { ...a as object, token: undefined } : a), ms: Date.now() - t0, result: op === "now" ? (out as SyncReport[]).map((r) => ({ ws: r.workspace, pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts.length, errors: r.errors, offline: r.offline })) : undefined });
    return out;
  } catch (e) {
    L.error(`op ${op} failed`, { args: args.map(a => a && typeof a === "object" ? { ...a as object, token: undefined } : a), ms: Date.now() - t0, err: e as Error });
    throw e;
  }
}

/** For `surface serve`: sync every few seconds, and soon after a local change. */
export function startSyncLoop(onChange: () => void, everyMs = 5000, onTick: () => void = () => {}) {
  let running = false;
  let again = false;
  let stopped = false;
  // remember each workspace's last state so the log records changes (went offline, back online, new error), not every quiet round
  const last = new Map<string, string>();
  L.info("sync loop started", { everyMs });
  const tick = async () => {
    if (stopped) return;
    if (running) return void (again = true);
    running = true;
    const t0 = Date.now();
    try {
      const reps = await syncAll();
      if (reps.some((r) => r.pulled || r.conflicts.length)) onChange();
      for (const r of reps) {
        const state = r.offline ? "offline" : r.errors.length ? "error" : "ok";
        const prev = last.get(r.workspace);
        last.set(r.workspace, state);
        const data = { ws: r.workspace, pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts.length, errors: r.errors.length, ms: Date.now() - t0 };
        if (state === "offline" && prev !== "offline") L.warn("hub unreachable, working offline", { ws: r.workspace, reason: r.offlineReason });
        if (state !== "offline" && prev === "offline") L.info("hub reachable again", { ws: r.workspace });
        if (r.pushed || r.pulled || r.conflicts.length || r.errors.length) L.info("round", data);
        else L.debug("round (nothing to do)", data);
        for (const e of r.errors) {
          L.error("error", { ws: r.workspace, error: e });
          console.error(`sync ${r.workspace}: ${e}`);
        }
        for (const c of r.conflicts) {
          L.warn("conflict", { ws: r.workspace, conflict: c });
          console.error(`sync ${r.workspace}: conflict: ${c}`);
        }
      }
      if (reps.length) onTick();
    } catch (e) {
      L.error("round failed", { err: e as Error });
      console.error("sync:", (e as Error).message);
    } finally {
      running = false;
      if (again) {
        again = false;
        setTimeout(tick, 200);
      }
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  setTimeout(tick, 500);
  return { kick: () => void tick(), stop: () => { stopped = true; clearInterval(timer); } };
}


// ---------------------------------------------------------------------------
// Types (matched by key; hub_id remembered so a renamed key still matches)
// ---------------------------------------------------------------------------
async function fetchHubTypes(client: Client, hubWs: string): Promise<TypeRow[]> {
  return must(await client.from("types").select("*").eq("workspace_id", hubWs).order("created_at"), "read hub types") as TypeRow[];
}

/** Field ids and link targets: from one side's ids to keys, and from keys to the other side's ids. */
function fieldsByKey(t: TypeRow | undefined) {
  return new Map((t?.fields ?? []).map((f) => [f.key, f]));
}

async function syncTypes(ws: string, hub: Hub, client: Client, hubTypes: TypeRow[], rep: SyncReport) {
  const { local, marks } = await localAdmin(async (tx) => ({
    local: (await tx.query<any>("select * from public.types where workspace_id = $1 order by created_at", [ws])).rows as TypeRow[],
    marks: (await tx.query<any>("select key, synced, dirty, hub_id, field_ids from surface_local.sync_rows where workspace_id = $1 and kind = 'type'", [ws])).rows as (Mark & { dirty: boolean })[],
  }));
  const markOf = new Map(marks.map((m) => [m.key, m]));
  const hubById = new Map(hubTypes.map((t) => [t.id, t]));
  const hubByKey = new Map(hubTypes.map((t) => [t.key, t]));
  const localById = new Map(local.map((t) => [t.id, t]));
  const localKeyOfHubId = (hid: string) => {
    const m = marks.find((x) => x.hub_id === hid);
    if (m) return localById.get(m.key)?.key;
    return hubById.get(hid)?.key;
  };
  const hubFor = (t: TypeRow) => {
    const m = markOf.get(t.id);
    return (m?.hub_id && hubById.get(m.hub_id)) || hubByKey.get(t.key);
  };
  const toHubFields = (t: TypeRow, h: TypeRow | undefined) => {
    const hk = fieldsByKey(h);
    return t.fields.map((f) => {
      const out: Field = { ...f };
      const same = hk.get(f.key);
      if (same) out.id = same.id;
      if (f.kind === "link" && f.target) out.target = localById.get(f.target)?.key ?? f.target;
      return out;
    });
  };

  // A deleted cloud type must never be recreated by a cached copy.
  for (const t of [...local]) {
    const m = markOf.get(t.id);
    if (!m?.synced || hubFor(t)) continue;
    await localAdmin(async tx => {
      const waiting = (await tx.query<any>("select count(*)::int as n from surface_local.outbox where workspace_id=$1 and after_row->>'type_id'=$2",[ws,t.id])).rows[0].n;
      if (waiting) throw new Error(`Cloud type ${t.key} was removed; pending local edits are preserved. Export or move them before syncing.`);
      await tx.query("delete from surface_local.sync_rows where workspace_id=$1 and kind='record' and key in(select id from public.records where type_id=$2)",[ws,t.id]);
      await tx.query("delete from public.records where type_id=$1",[t.id]);
      await tx.query("delete from public.types where id=$1",[t.id]);
      await tx.query("delete from surface_local.sync_rows where workspace_id=$1 and kind='type' and key=$2",[ws,t.id]);
    },{applying:true});
    localById.delete(t.id); markOf.delete(t.id);
    local.splice(local.findIndex(x=>x.id===t.id),1);
  }

  // Bootstrap/legacy type edits only; new shared schema edits use routeSchemaWrite.
  for (const t of local) {
    const m = markOf.get(t.id);
    if (!m || !m.dirty) continue; // only tracked local changes go up (enable marks everything; joins start clean)
    const h = hubFor(t);
    if (h && m?.synced && h.updated_at !== m.synced) continue; // changed on the hub too: the hub wins below
    const body = { key: t.key, name: t.name, icon: t.icon, folder: t.folder, display: t.display ?? "document", fields: toHubFields(t, h) };
    let saved: TypeRow[];
    if (h) {
      saved = must(await client.from("types").update(body).eq("id", h.id).select("*"), `update hub type ${t.key}`);
    } else {
      saved = must(await client.from("types").insert({ ...body, workspace_id: hub.workspace }).select("*"), `add hub type ${t.key}`);
    }
    const s = saved[0];
    if (!s) throw new Error(`the hub refused type ${t.key} (permission?)`);
    hubById.set(s.id, s);
    hubByKey.set(s.key, s);
    await localAdmin((tx) => tx.query(
      `insert into surface_local.sync_rows (workspace_id, kind, key, synced, dirty, hub_id) values ($1, 'type', $2, $3, false, $4)
       on conflict (workspace_id, kind, key) do update set synced = $3, dirty = false, hub_id = $4`, [ws, t.id, s.updated_at, s.id]));
    markOf.set(t.id, { kind: "type", key: t.id, synced: s.updated_at, hub_id: s.id, dirty: false });
    rep.pushed++;
  }

  // pull hub type changes (a few passes so link targets to new types resolve)
  let pending = [...hubById.values()];
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const next: TypeRow[] = [];
    for (const h of pending) {
      const lm = [...markOf.values()].find((m) => m.hub_id === h.id);
      const lt = (lm && localById.get(lm.key)) || local.find((t) => t.key === h.key);
      const m = lt ? markOf.get(lt.id) : undefined;
      if (lt && m && m.synced === h.updated_at && m.hub_id === h.id && m.field_ids) continue;
      if (lt && m?.dirty && !m.synced) continue; // pushed above or failed
      const lk = fieldsByKey(lt);
      const fields = h.fields.map((f) => {
        const out: Field = { ...f };
        const same = lk.get(f.key) ?? lt?.fields.find(lf => lf.id === m?.field_ids?.[f.id]);
        if (same) out.id = same.id;
        if (f.kind === "link" && f.target) {
          const key = localKeyOfHubId(f.target);
          const target = local.find((x) => x.key === key) ?? (key === (lt?.key ?? h.key) ? lt : undefined);
          out.target = target?.id ?? key ?? f.target;
        }
        return out;
      });
      try {
        const saved = await localAdmin(async (tx) => {
          let row: TypeRow;
          if (lt) {
            row = (await tx.query<any>("update public.types set key = $2, name = $3, icon = $4, folder = $5, display = $6, fields = $7::jsonb where id = $1 returning *",
              [lt.id, h.key, h.name, h.icon, h.folder, h.display ?? "document", JSON.stringify(fields)])).rows[0];
          } else {
            row = (await tx.query<any>("insert into public.types (id, workspace_id, key, name, icon, folder, display, fields, is_builtin) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning *",
              [h.id, ws, h.key, h.name, h.icon, h.folder, h.display ?? "document", JSON.stringify(fields), !!h.is_builtin])).rows[0];
          }
          await tx.query(`insert into surface_local.sync_rows (workspace_id, kind, key, synced, dirty, hub_id) values ($1, 'type', $2, $3, false, $4)
             on conflict (workspace_id, kind, key) do update set synced = $3, dirty = false, hub_id = $4`, [ws, row.id, h.updated_at, h.id]);
          await tx.query("update surface_local.sync_rows set field_ids=$3::jsonb where workspace_id=$1 and kind='type' and key=$2",[ws,row.id,JSON.stringify(Object.fromEntries(h.fields.map(f=>[f.id,row.fields.find(lf=>lf.key===f.key)!.id])))]);
          return row;
        }, { applying: true });
        localById.set(saved.id, saved);
        const i = local.findIndex((x) => x.id === saved.id);
        if (i >= 0) local[i] = saved;
        else local.push(saved);
        markOf.set(saved.id, { kind: "type", key: saved.id, synced: h.updated_at, hub_id: h.id, dirty: false });
        rep.pulled++;
      } catch (e) {
        if (pass === 2) rep.errors.push(`type ${h.key}: ${(e as Error).message}`);
        next.push(h);
      }
    }
    pending = next;
  }
}

/** Local and hub types side by side, by key, for translating record fields. */
async function mapTypes(ws: string, hubTypes: TypeRow[]) {
  const local = await localAdmin(async (tx) => (await tx.query<any>("select * from public.types where workspace_id = $1", [ws])).rows as TypeRow[]);
  return {
    localById: new Map(local.map((t) => [t.id, t])),
    localByKey: new Map(local.map((t) => [t.key, t])),
    hubById: new Map(hubTypes.map((t) => [t.id, t])),
    hubByKey: new Map(hubTypes.map((t) => [t.key, t])),
  };
}
type Types = Awaited<ReturnType<typeof mapTypes>>;

const byKey = (fields: Record<string, unknown>, t: TypeRow | undefined) => {
  const out: Record<string, unknown> = {};
  for (const f of t?.fields ?? []) if (fields[f.id] !== undefined && fields[f.id] !== null) out[f.key] = fields[f.id];
  return out;
};
const byId = (fields: Record<string, unknown>, t: TypeRow | undefined) => {
  const out: Record<string, unknown> = {};
  for (const f of t?.fields ?? []) if (fields[f.key] !== undefined && fields[f.key] !== null) out[f.id] = fields[f.key];
  return out;
};

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
async function pushRecords(ws: string, hub: Hub, client: Client, types: Types, rep: SyncReport) {
  const dirty = await localAdmin(async (tx) => (await tx.query<any>(
    `select s.key, s.synced, r.*, o.before_row, o.after_row, o.generation from surface_local.sync_rows s left join public.records r on r.id = s.key left join surface_local.outbox o on o.workspace_id = s.workspace_id and o.record_id = s.key
      where s.workspace_id = $1 and s.kind = 'record' and s.dirty order by o.sequence nulls first, r.created_at nulls last`, [ws])).rows);
  // parents and link targets first: records that others point at go up before them
  const order = sortForLinks(dirty, (r) => [r.parent_id, ...linkTargets(r.fields, types.localById.get(r.type_id))]);
  for (const r of order) {
    const id = r.key as string;
    const base = r.synced == null ? null : Number(r.synced);
    try {
      if (!r.id) { // gone locally (shouldn't happen: deletes are soft)
        await markClean(ws, "record", id, r.synced, null);
        continue;
      }
      if (r.before_row && base != null) {
        await pushPatch(ws, hub, client, types, r, rep);
        continue;
      }
      if (r.deleted_at) {
        if (base == null) { await markClean(ws, "record", id, null, r.rev); continue; }
        const cur = must(await client.from("records").select("id,rev,deleted_at").eq("id", id).maybeSingle(), "read hub record");
        if (cur && !cur.deleted_at && cur.rev !== base) {
          // edited on the hub while deleted here: the edit wins; the pull below brings it back
          await markClean(ws, "record", id, null, null);
          rep.conflicts.push(`${r.title}: deleted here but edited elsewhere; kept the edit`);
          continue;
        }
        if (cur && !cur.deleted_at) {
          const done = must(await client.from("records").update({ deleted_at: r.deleted_at }).eq("id", id).select("id,rev"), "delete on hub");
          await markClean(ws, "record", id, String(done[0]?.rev ?? cur.rev), r.rev);
        } else await markClean(ws, "record", id, cur ? String(cur.rev) : null, r.rev);
        rep.pushed++;
        continue;
      }
      const lt = types.localById.get(r.type_id);
      if (!lt) throw new Error(`unknown type ${r.type_id}`);
      const args: Row = {
        p_workspace: hub.workspace, p_id: id, p_base_rev: base, p_type: lt.key, p_title: r.title,
        p_fields: byKey(r.fields, lt), p_body: r.body, p_folder: r.folder, p_parent: r.parent_id ?? "",
      };
      if (r.aliases?.length) args.p_aliases = r.aliases;
      let res = await client.rpc("push_record", args);
      if (res.error && "p_aliases" in args && /p_aliases|Could not find the function|function public\.push_record/i.test(res.error.message)) {
        L.warn("hub has no aliases yet (needs migration 0006); pushed without them", { ws, id });
        delete args.p_aliases;
        res = await client.rpc("push_record", args);
      }
      if (res.error && /^deleted: /.test(res.error.message)) {
        // deleted on the hub, edited here: the edit wins and brings it back
        must(await client.from("records").update({ deleted_at: null }).eq("id", id).select("id"), "restore on hub");
        const cur = must(await client.from("records").select("rev").eq("id", id).single(), "read hub record");
        res = await client.rpc("push_record", { ...args, p_base_rev: cur.rev });
      }
      if (res.error && /^conflict: /.test(res.error.message)) {
        const h = must(await client.from("records").select("*").eq("id", id).single(), "read hub record");
        if (equal(document(r, lt), document(h, types.hubById.get(h.type_id)))) {
          await markClean(ws, "record", id, String(h.rev), r.rev); rep.pushed++; continue;
        }
      }
      if (res.error && /^conflict: /.test(res.error.message)) {
        L.info("conflict on push: hub changed since last sync", { ws, id, title: r.title, baseRev: base });
        await conflictCopy(ws, client, types, r, rep);
        continue;
      }
      const saved = must(res, `push ${r.title}`);
      if (r.generation) await acknowledge(ws, types, r, saved);
      else await markClean(ws, "record", id, String(saved.rev), r.rev);
      L.debug("pushed record", { ws, id, title: r.title, baseRev: base, hubRev: saved.rev, localRev: r.rev });
      rep.pushed++;
    } catch (e) {
      if (e instanceof Offline) throw e;
      L.error("push failed", { ws, id, title: r.title, baseRev: base, err: e as Error });
      rep.errors.push(`${r.title ?? id}: ${(e as Error).message}`);
    }
  }
}

/** Translate a record into stable property names. Field ids differ between computers. */
function document(r: Row, t: TypeRow | undefined): Row {
  return { type: t?.key, title: r.title, body: r.body ?? "", folder: r.folder ?? null,
    parent: r.parent_id ?? null, aliases: r.aliases ?? [], fields: byKey(r.fields ?? {}, t), deleted: !!r.deleted_at };
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a == null && b == null) return true;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(k => equal((a as Row)[k], (b as Row)[k]));
  }
  return a === b;
};

/** Three-way property merge, protected by the hub's existing atomic revision check.
 * Retry reads the hub again: a response lost after a successful write becomes a no-op,
 * never a duplicate record. Same-property conflicts remain explicit, including body text. */
async function pushPatch(ws: string, hub: Hub, client: Client, types: Types, r: Row, rep: SyncReport) {
  const before = document(r.before_row, types.localById.get(r.before_row.type_id));
  const after = document(r.after_row, types.localById.get(r.after_row.type_id));
  for (let attempt = 0; attempt < 5; attempt++) {
    const h = must(await client.from("records").select("*").eq("workspace_id", hub.workspace).eq("id", r.id).maybeSingle(), "read hub record");
    if (!h) throw new Error(`${r.title}: record was removed from the cloud; pending edits are kept locally`);
    const current = document(h, types.hubById.get(h.type_id));
    const merged: Row = { ...current, fields: { ...current.fields } };
    let conflict = false;
    // Deleting while someone edits keeps the edit. Editing a deleted record restores it.
    if (after.deleted && !before.deleted && !equal({ ...before, deleted: false }, { ...current, deleted: false })) {
      await acknowledge(ws, types, r, h); rep.conflicts.push(`${r.title}: deleted here but edited elsewhere; kept the edit`); return;
    }
    for (const k of ["type", "title", "body", "folder", "parent", "aliases", "deleted"]) {
      if (equal(before[k], after[k])) continue;
      if (!equal(current[k], before[k]) && !equal(current[k], after[k])) conflict = true;
      merged[k] = after[k];
    }
    for (const k of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
      if (equal(before.fields[k], after.fields[k])) continue;
      // Removed schema fields must never be resurrected by a pending record edit.
      const target = types.hubByKey.get(merged.type);
      if (!target?.fields.some(f => f.key === k)) continue;
      if (!equal(current.fields[k], before.fields[k]) && !equal(current.fields[k], after.fields[k])) conflict = true;
      if (after.fields[k] == null) delete merged.fields[k]; else merged.fields[k] = after.fields[k];
    }
    if (conflict && !equal(after, current)) {
      // Preserve the latest local record, including edits made while this request was in flight.
      const latest = await localAdmin(async tx => (await tx.query<any>("select *, id as key from public.records where id=$1", [r.id])).rows[0]);
      await conflictCopy(ws, client, types, latest, rep);
      return;
    }
    // A local edit always beats a remote delete.
    if (current.deleted && !after.deleted) merged.deleted = false;
    if (equal(merged, current)) { await acknowledge(ws, types, r, h); rep.pushed++; return; }
    // A revision-filtered update also supports deletion/restoration without a separate unsafe write.
    const ht = types.hubByKey.get(merged.type);
    if (!ht) throw new Error(`no cloud type ${merged.type}`);
    const proposed: Row = { type_id: ht.id, title: merged.title, body: merged.body, folder: merged.folder,
      parent_id: merged.parent, aliases: merged.aliases, fields: byId(merged.fields, ht),
      deleted_at: merged.deleted ? (h.deleted_at ?? r.deleted_at) : null };
    if (!("aliases" in h)) {
      if (merged.aliases.length) throw new Error("The cloud needs migration 0006_links_aliases.sql before aliases can sync. Your edits are saved locally.");
      delete proposed.aliases;
    }
    const patch = Object.fromEntries(Object.entries(proposed).filter(([key,value]) => !equal(h[key],value)));
    if (!Object.keys(patch).length) { await acknowledge(ws,types,r,h); rep.pushed++; return; }
    const saved = must(await client.from("records").update(patch).eq("workspace_id", hub.workspace).eq("id", r.id).eq("rev", h.rev).select("*"), `patch ${r.title}`);
    if (!saved.length) continue; // another writer won; recompute against its accepted version
    await acknowledge(ws, types, r, saved[0]); rep.pushed++; return;
  }
  throw new Error(`${r.title}: cloud changed repeatedly; queued edit will retry`);
}

/** Accept a cloud result and replay edits made during the request over it atomically. */
async function acknowledge(ws: string, types: Types, sent: Row, accepted: Row) {
  const ht = types.hubById.get(accepted.type_id)!;
  const lt = types.localByKey.get(ht.key)!;
  await localAdmin(async tx => {
    const pending = (await tx.query<any>("select * from surface_local.outbox where workspace_id=$1 and record_id=$2 for update", [ws, sent.id])).rows[0];
    const base: Row = { ...accepted, workspace_id: ws, type_id: lt.id, aliases: accepted.aliases ?? sent.after_row.aliases ?? [], fields: byId(byKey(accepted.fields, ht), lt) };
    let result: Row = { ...base, fields: { ...base.fields } };
    if (pending && pending.generation !== sent.generation) {
      const previous = sent.after_row;
      const latest = pending.after_row;
      for (const k of ["title", "body", "folder", "parent_id", "aliases", "deleted_at", "type_id"]) {
        if (!equal(previous[k], latest[k])) result[k] = latest[k];
      }
      for (const k of new Set([...Object.keys(previous.fields), ...Object.keys(latest.fields)])) {
        if (!equal(previous.fields[k], latest.fields[k])) {
          if (latest.fields[k] == null) delete result.fields[k]; else result.fields[k] = latest.fields[k];
        }
      }
    }
    const row = (await tx.query<any>(`update public.records set type_id=$2,title=$3,body=$4,folder=$5,parent_id=$6,aliases=$7,fields=$8::jsonb,deleted_at=$9 where id=$1 returning *`,
      [sent.id,result.type_id,result.title,result.body,result.folder,result.parent_id,result.aliases,JSON.stringify(result.fields),result.deleted_at])).rows[0]
      ?? (await tx.query<any>("select * from public.records where id=$1", [sent.id])).rows[0];
    const remains = pending && pending.generation !== sent.generation;
    await tx.query("update surface_local.sync_rows set synced=$3,dirty=$4 where workspace_id=$1 and kind='record' and key=$2", [ws,sent.id,String(accepted.rev),!!remains]);
    if (remains) await tx.query("update surface_local.outbox set before_row=$3::jsonb,after_row=$4::jsonb where workspace_id=$1 and record_id=$2", [ws,sent.id,JSON.stringify(base),JSON.stringify(row)]);
    else await tx.query("delete from surface_local.outbox where workspace_id=$1 and record_id=$2", [ws,sent.id]);
  }, { applying: true });
}

/** Mark a row synced, unless it changed again locally since we read it (then it stays dirty). */
async function markClean(ws: string, kind: string, key: string, synced: string | null, localRev: number | null, keepDirty = false) {
  await localAdmin((tx) => tx.query(
    `update surface_local.sync_rows
        set synced = $4,
            dirty = case when $5::int is null or exists (select 1 from public.records where id = $3 and rev = $5) then $6 else true end
      where workspace_id = $1 and kind = $2 and key = $3`,
    [ws, kind, key, synced, localRev, keepDirty]));
  if (kind === "record" && !keepDirty) await localAdmin(async tx => {
    await tx.query("delete from surface_local.outbox where workspace_id = $1 and record_id = $2 and (after_row->>'rev')::int = $3", [ws, key, localRev]);
  });
}

/** Someone else changed the record: keep ours as a new record and take theirs. */
async function conflictCopy(ws: string, client: Client, types: Types, r: Row, rep: SyncReport) {
  const h = must(await client.from("records").select("*").eq("id", r.key).single(), "read hub record");
  const ht = types.hubById.get(h.type_id);
  const lt = (ht && types.localByKey.get(ht.key)) || types.localById.get(r.type_id);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const copyTitle = `${r.title} (conflict ${stamp})`;
  await localAdmin(async (tx) => {
    const latest = (await tx.query<any>("select * from public.records where id=$1",[r.key])).rows[0];
    const copy = (await tx.query<any>(
      `insert into public.records (workspace_id, type_id, title, fields, body, folder, parent_id, aliases)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, '{}') returning *`,
      [ws, latest.type_id, copyTitle, JSON.stringify(latest.fields), latest.body, latest.folder, latest.parent_id])).rows[0];
    await tx.query("insert into surface_local.sync_conflicts (workspace_id, record_id, copy_id, title) values ($1, $2, $3, $4)", [ws, r.key, copy.id, latest.title]);
    await tx.query("insert into surface_local.sync_rows (workspace_id, kind, key, dirty) values ($1, 'record', $2, true) on conflict do nothing", [ws, copy.id]);
    await tx.query("insert into surface_local.outbox(workspace_id,record_id,after_row) values($1,$2,$3::jsonb)",[ws,copy.id,JSON.stringify(copy)]);
    await tx.query("update public.records set type_id=$2,title=$3,fields=$4::jsonb,body=$5,folder=$6,parent_id=$7,deleted_at=$8,aliases=coalesce($9::text[],aliases) where id=$1",
      [r.key,lt!.id,h.title,JSON.stringify(byId(byKey(h.fields,ht),lt)),h.body,h.folder,h.parent_id,h.deleted_at,h.aliases ?? null]);
    await tx.query("update surface_local.sync_rows set synced=$3,dirty=false where workspace_id=$1 and kind='record' and key=$2",[ws,r.key,String(h.rev)]);
    await tx.query("delete from surface_local.outbox where workspace_id=$1 and record_id=$2",[ws,r.key]);
  }, { applying: true });
  rep.conflicts.push(`${r.title}: changed elsewhere too; your version is "${copyTitle}"`);
}

async function applyRecord(ws: string, h: Row, lt: TypeRow, ht: TypeRow | undefined, strip = false) {
  let fields = byId(byKey(h.fields ?? {}, ht), lt);
  if (strip) fields = Object.fromEntries(Object.entries(fields).filter(([k]) => lt.fields.find((f) => f.id === k)?.kind !== "link"));
  await localAdmin(async (tx) => {
    const exists = (await tx.query<any>("select 1 from public.records where id = $1", [h.id])).rows.length > 0;
    // A user can edit after the pull's initial scan but before this transaction.
    // Never overwrite that edit or mark its outbox clean.
    const pending = (await tx.query<any>("select dirty from surface_local.sync_rows where workspace_id=$1 and kind='record' and key=$2",[ws,h.id])).rows[0];
    if (pending?.dirty) return;
    const parent = strip ? null : h.parent_id;
    // a hub without migration 0006 sends no aliases: keep the local ones rather than clearing them
    if (exists) {
      await tx.query("update public.records set type_id = $2, title = $3, fields = $4::jsonb, body = $5, folder = $6, parent_id = $7, deleted_at = $8, aliases = coalesce($9::text[], aliases) where id = $1",
        [h.id, lt.id, h.title, JSON.stringify(fields), h.body ?? "", h.folder, parent, h.deleted_at, Array.isArray(h.aliases) ? h.aliases : null]);
    } else {
      await tx.query("insert into public.records (id, workspace_id, type_id, title, fields, body, folder, parent_id, deleted_at, aliases) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, coalesce($10::text[], '{}'))",
        [h.id, ws, lt.id, h.title, JSON.stringify(fields), h.body ?? "", h.folder, parent, h.deleted_at, Array.isArray(h.aliases) ? h.aliases : null]);
    }
    await tx.query(`insert into surface_local.sync_rows (workspace_id, kind, key, synced, dirty) values ($1, 'record', $2, $3, false)
       on conflict (workspace_id, kind, key) do update set synced = $3, dirty = false`, [ws, h.id, strip ? null : String(h.rev)]);
  }, { applying: true });
}

// Incremental pull: only records the hub changed since the cursor (its own updated_at clock, with a
// margin for transactions that committed late). A full id:rev comparison runs every FULL_SCAN_MS as a
// safety net, and catches records removed from the hub outright.
const FULL_SCAN_MS = Number(process.env.SURFACE_SYNC_FULL_MS ?? 10 * 60_000);
const CURSOR_MARGIN_MS = 2 * 60_000;

async function pullRecords(ws: string, hub: Hub, client: Client, types: Types, rep: SyncReport) {
  const cur = await localAdmin(async (tx) => (await tx.query<any>("select pull_cursor, full_scan_at from surface_local.sync_workspaces where workspace_id = $1", [ws])).rows[0]);
  const fullScan = !cur?.pull_cursor || !cur.full_scan_at || Date.now() - new Date(cur.full_scan_at).getTime() > FULL_SCAN_MS;
  const since = fullScan ? null : new Date(new Date(cur.pull_cursor).getTime() - CURSOR_MARGIN_MS).toISOString();
  const remote: { id: string; rev: number; deleted_at: string | null; updated_at: string }[] = [];
  for (let from = 0; ; from += 1000) {
    let q = client.from("records").select("id,rev,deleted_at,updated_at").eq("workspace_id", hub.workspace);
    if (since) q = q.gte("updated_at", since);
    const page = must(await q.order("id").range(from, from + 999), "list hub records");
    remote.push(...page);
    if (page.length < 1000) break;
  }
  rep.scan = fullScan ? "full" : "incremental";
  const newest = remote.reduce<string | null>((m, r) => (!m || r.updated_at > m ? r.updated_at : m), cur?.pull_cursor ?? null);
  const marks = await localAdmin(async (tx) => (await tx.query<any>("select key, synced, dirty from surface_local.sync_rows where workspace_id = $1 and kind = 'record'", [ws])).rows);
  const markOf = new Map(marks.map((m: any) => [m.key, m]));
  const saveCursor = () => localAdmin((tx) => tx.query(
    `update surface_local.sync_workspaces set pull_cursor = $2${fullScan ? ", full_scan_at = now()" : ""} where workspace_id = $1`, [ws, newest]));
  if (fullScan) {
    // records we had synced that the hub no longer has at all (removed with their type): delete here too
    const there = new Set(remote.map((r) => r.id));
    const gone = marks.filter((m: any) => m.synced && !m.dirty && !there.has(m.key)).map((m: any) => m.key);
    if (gone.length) {
      await localAdmin(async (tx) => {
        await tx.query("update public.records set deleted_at = now() where id = any($1) and deleted_at is null", [gone]);
        await tx.query("update surface_local.sync_rows set synced = null where workspace_id = $1 and kind = 'record' and key = any($2)", [ws, gone]);
      }, { applying: true });
      rep.pulled += gone.length;
    }
  }
  const changed = remote.filter((r) => {
    const m = markOf.get(r.id);
    if (m?.dirty) return false; // ours goes up first; a clash becomes a conflict copy on the next push
    if (!m) return !r.deleted_at;
    return m.synced !== String(r.rev);
  }).map((r) => r.id);
  if (!changed.length) return void (await saveCursor());
  const full: Row[] = [];
  for (const ids of chunks(changed, 200)) full.push(...must(await client.from("records").select("*").in("id", ids), "read hub records"));
  // apply parents and link targets first; anything still failing goes in without links, then again with them
  const order = sortForLinks(full, (r) => [r.parent_id, ...linkTargets(r.fields, types.hubById.get(r.type_id))]);
  const retry: Row[] = [];
  for (const h of order) {
    const ht = types.hubById.get(h.type_id);
    const lt = ht && types.localByKey.get(ht.key);
    if (!lt) { rep.errors.push(`${h.title}: no local type ${ht?.key ?? h.type_id}`); continue; }
    try {
      await applyRecord(ws, h, lt, ht);
      L.debug("pulled record", { ws, id: h.id, title: h.title, hubRev: h.rev, deleted: !!h.deleted_at });
      rep.pulled++;
    } catch (e) {
      L.debug("pull deferred (retry after links)", { ws, id: h.id, err: (e as Error).message });
      retry.push(h);
    }
  }
  for (const h of retry) {
    const ht = types.hubById.get(h.type_id)!;
    const lt = types.localByKey.get(ht.key)!;
    try {
      await applyRecord(ws, h, lt, ht, true);
    } catch (e) {
      rep.errors.push(`${h.title}: ${(e as Error).message}`);
    }
  }
  for (const h of retry) {
    const ht = types.hubById.get(h.type_id)!;
    const lt = types.localByKey.get(ht.key)!;
    try {
      await applyRecord(ws, h, lt, ht);
      rep.pulled++;
    } catch (e) {
      L.error("pull failed", { ws, id: h.id, title: h.title, hubRev: h.rev, err: e as Error });
      rep.errors.push(`${h.title}: ${(e as Error).message}`);
    }
  }
  // move the cursor only when everything applied; otherwise the next round tries the same window again
  if (!rep.errors.length) await saveCursor();
}

function linkTargets(fields: Record<string, unknown> | null, t: TypeRow | undefined): string[] {
  const out: string[] = [];
  for (const f of t?.fields ?? []) {
    if (f.kind !== "link") continue;
    const v = fields?.[f.id];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v.map(String));
  }
  return out;
}

/** Dependencies first (parent, link targets) where they're in the same batch. */
function sortForLinks<T extends Row>(rows: T[], deps: (r: T) => (string | null | undefined)[]): T[] {
  const byIdMap = new Map(rows.map((r) => [(r.id ?? r.key) as string, r]));
  const seen = new Set<string>();
  const out: T[] = [];
  const visit = (r: T, depth: number) => {
    const id = (r.id ?? r.key) as string;
    if (seen.has(id)) return;
    seen.add(id);
    if (depth < 50) for (const d of deps(r)) if (d && byIdMap.has(d)) visit(byIdMap.get(d)!, depth + 1);
    out.push(r);
  };
  for (const r of rows) visit(r, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Views (by key; 'p:' = your personal view). A clash keeps the hub's version.
// ---------------------------------------------------------------------------
async function syncViews(ws: string, hub: Hub, client: Client, rep: SyncReport) {
  const me = localUser();
  const { local, marks } = await localAdmin(async (tx) => ({
    local: (await tx.query<any>("select * from public.views where workspace_id = $1", [ws])).rows,
    marks: (await tx.query<any>("select key, synced, dirty from surface_local.sync_rows where workspace_id = $1 and kind = 'view'", [ws])).rows,
  }));
  const vkey = (v: Row) => (v.owner ? "p:" : "") + v.key;
  const localOf = new Map(local.map((v: Row) => [vkey(v), v]));
  const markOf = new Map(marks.map((m: any) => [m.key, m]));
  let remote: Row[] = must(await client.from("views").select("*").eq("workspace_id", hub.workspace), "read hub views");
  let remoteOf = new Map(remote.map((v) => [vkey(v), v]));

  for (const m of marks.filter((m: any) => m.dirty)) {
    const v = localOf.get(m.key);
    const h = remoteOf.get(m.key);
    const personal = m.key.startsWith("p:");
    const key = personal ? m.key.slice(2) : m.key;
    try {
      if (!v) {
        if (h && (!m.synced || String(h.rev) === m.synced)) {
          let q = client.from("views").delete().eq("workspace_id", hub.workspace).eq("key", key);
          q = personal ? q.not("owner", "is", null) : q.is("owner", null);
          must(await q, `delete view ${key}`);
        }
        await localAdmin((tx) => tx.query("delete from surface_local.sync_rows where workspace_id = $1 and kind = 'view' and key = $2", [ws, m.key]));
        rep.pushed++;
        continue;
      }
      if (h && m.synced && String(h.rev) !== m.synced) continue; // changed on the hub too: hub wins below
      const res = await client.rpc("save_view", { p_workspace: hub.workspace, p_key: key, p_name: v.name, p_definition: v.definition, p_base_rev: h ? h.rev : null, p_personal: personal });
      if (res.error && /^conflict: /.test(res.error.message)) continue;
      const saved = must(res, `save view ${key}`);
      await localAdmin((tx) => tx.query("update surface_local.sync_rows set synced = $3, dirty = false where workspace_id = $1 and kind = 'view' and key = $2", [ws, m.key, String(saved.rev)]));
      markOf.set(m.key, { key: m.key, synced: String(saved.rev), dirty: false });
      remoteOf.set(m.key, saved);
      rep.pushed++;
    } catch (e) {
      if (e instanceof Offline) throw e;
      rep.errors.push(`view ${key}: ${(e as Error).message}`);
    }
  }

  remote = [...remoteOf.values()];
  for (const h of remote) {
    const k = vkey(h);
    const m = markOf.get(k);
    if (m && m.synced === String(h.rev) && !m.dirty) continue;
    if (m && m.dirty && !m.synced) continue;
    const v = localOf.get(k);
    if (v && m && m.synced === String(h.rev)) continue;
    await localAdmin(async (tx) => {
      const owner = h.owner ? me!.id : null;
      if (v) await tx.query("update public.views set name = $2, definition = $3::jsonb, rev = rev + 1, updated_at = now() where id = $1", [v.id, h.name, JSON.stringify(h.definition)]);
      else await tx.query("insert into public.views (workspace_id, key, name, definition, owner) values ($1, $2, $3, $4::jsonb, $5)", [ws, h.key, h.name, JSON.stringify(h.definition), owner]);
      await tx.query(`insert into surface_local.sync_rows (workspace_id, kind, key, synced, dirty) values ($1, 'view', $2, $3, false)
        on conflict (workspace_id, kind, key) do update set synced = $3, dirty = false`, [ws, k, String(h.rev)]);
    }, { applying: true });
    rep.pulled++;
  }
  // views deleted on the hub that we had synced and haven't touched since
  for (const m of marks) {
    if (m.dirty || !m.synced || remoteOf.has(m.key)) continue;
    const v = localOf.get(m.key);
    await localAdmin(async (tx) => {
      if (v) await tx.query("delete from public.views where id = $1", [v.id]);
      await tx.query("delete from surface_local.sync_rows where workspace_id = $1 and kind = 'view' and key = $2", [ws, m.key]);
    }, { applying: true });
    rep.pulled++;
  }
}
