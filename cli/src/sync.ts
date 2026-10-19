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
import { localAdmin, localOwnerPort, localUser, remoteClient } from "./local.ts";
import { CONFIG_DIR } from "./config.ts";
import { logger } from "./log.ts";
import fs from "node:fs";
import path from "node:path";

const L = logger("sync");

export type Hub = { kind: "surface"; url: string; token: string; workspace: string } | { kind: "cloud"; workspace: string };

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
export async function enableSync(ws: string, hubIn: Omit<Hub, "workspace"> & { workspace?: string }): Promise<Hub> {
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
export async function joinSync(hubIn: Omit<Hub, "workspace"> & { workspace: string }, name?: string): Promise<string> {
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

export async function disableSync(ws: string) {
  await localAdmin(async (tx) => {
    for (const t of ["sync_rows", "sync_conflicts", "sync_workspaces"]) await tx.query(`delete from surface_local.${t} where workspace_id = $1`, [ws]);
  });
}

export async function resolveConflict(ws: string, id: string) {
  await localAdmin((tx) => tx.query("update surface_local.sync_conflicts set resolved = true where workspace_id = $1 and (record_id = $2 or copy_id = $2 or id::text = $2)", [ws, id]));
}

// ---------------------------------------------------------------------------
// One sync round for one workspace
// ---------------------------------------------------------------------------
type Mark = { kind: string; key: string; synced: string | null; hub_id?: string | null };

export async function syncWorkspace(ws: string): Promise<SyncReport> {
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

export async function syncAll(): Promise<SyncReport[]> {
  const out: SyncReport[] = [];
  for (const w of await syncedWorkspaces()) out.push(await syncWorkspace(w.workspace_id));
  return out;
}

const OPS = {
  now: (ws?: string) => (ws ? syncWorkspace(ws).then((r) => [r]) : syncAll()),
  status: (ws: string) => syncStatus(ws),
  list: () => syncedWorkspaces().then((ws) => ws.map((w) => ({ ...w, hub: { ...w.hub, token: undefined } }))),
  enable: (ws: string, hub: Omit<Hub, "workspace"> & { workspace?: string }) => enableSync(ws, hub),
  join: (hub: Omit<Hub, "workspace"> & { workspace: string }, name?: string) => joinSync(hub, name),
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
    if (!quiet) L.info(`op ${op}`, { args, ms: Date.now() - t0, result: op === "now" ? (out as SyncReport[]).map((r) => ({ ws: r.workspace, pushed: r.pushed, pulled: r.pulled, conflicts: r.conflicts.length, errors: r.errors, offline: r.offline })) : undefined });
    return out;
  } catch (e) {
    L.error(`op ${op} failed`, { args, ms: Date.now() - t0, err: e as Error });
    throw e;
  }
}

/** For `surface serve`: sync every few seconds, and soon after a local change. */
export function startSyncLoop(onChange: () => void, everyMs = 5000, onTick: () => void = () => {}) {
  let running = false;
  let again = false;
  // remember each workspace's last state so the log records changes (went offline, back online, new error), not every quiet round
  const last = new Map<string, string>();
  L.info("sync loop started", { everyMs });
  const tick = async () => {
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
  return { kick: () => void tick(), stop: () => clearInterval(timer) };
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
    marks: (await tx.query<any>("select key, synced, dirty, hub_id from surface_local.sync_rows where workspace_id = $1 and kind = 'type'", [ws])).rows as (Mark & { dirty: boolean })[],
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

  // push local type changes first (schema edits are expected while online)
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
      if (lt && m && m.synced === h.updated_at && m.hub_id === h.id) continue;
      if (lt && m?.dirty && !m.synced) continue; // pushed above or failed
      const lk = fieldsByKey(lt);
      const fields = h.fields.map((f) => {
        const out: Field = { ...f };
        const same = lk.get(f.key);
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
    `select s.key, s.synced, r.* from surface_local.sync_rows s left join public.records r on r.id = s.key
      where s.workspace_id = $1 and s.kind = 'record' and s.dirty order by r.created_at nulls last`, [ws])).rows);
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
      const args = {
        p_workspace: hub.workspace, p_id: id, p_base_rev: base, p_type: lt.key, p_title: r.title,
        p_fields: byKey(r.fields, lt), p_body: r.body, p_folder: r.folder, p_parent: r.parent_id ?? "",
      };
      let res = await client.rpc("push_record", args);
      if (res.error && /^deleted: /.test(res.error.message)) {
        // deleted on the hub, edited here: the edit wins and brings it back
        must(await client.from("records").update({ deleted_at: null }).eq("id", id).select("id"), "restore on hub");
        const cur = must(await client.from("records").select("rev").eq("id", id).single(), "read hub record");
        res = await client.rpc("push_record", { ...args, p_base_rev: cur.rev });
      }
      if (res.error && /^conflict: /.test(res.error.message)) {
        L.info("conflict on push: hub changed since last sync", { ws, id, title: r.title, baseRev: base });
        await conflictCopy(ws, client, types, r, rep);
        continue;
      }
      const saved = must(res, `push ${r.title}`);
      await markClean(ws, "record", id, String(saved.rev), r.rev);
      L.debug("pushed record", { ws, id, title: r.title, baseRev: base, hubRev: saved.rev, localRev: r.rev });
      rep.pushed++;
    } catch (e) {
      if (e instanceof Offline) throw e;
      L.error("push failed", { ws, id, title: r.title, baseRev: base, err: e as Error });
      rep.errors.push(`${r.title ?? id}: ${(e as Error).message}`);
    }
  }
}

/** Mark a row synced, unless it changed again locally since we read it (then it stays dirty). */
async function markClean(ws: string, kind: string, key: string, synced: string | null, localRev: number | null, keepDirty = false) {
  await localAdmin((tx) => tx.query(
    `update surface_local.sync_rows
        set synced = $4,
            dirty = case when $5::int is null or exists (select 1 from public.records where id = $3 and rev = $5) then $6 else true end
      where workspace_id = $1 and kind = $2 and key = $3`,
    [ws, kind, key, synced, localRev, keepDirty]));
}

/** Someone else changed the record: keep ours as a new record and take theirs. */
async function conflictCopy(ws: string, client: Client, types: Types, r: Row, rep: SyncReport) {
  const h = must(await client.from("records").select("*").eq("id", r.key).single(), "read hub record");
  const ht = types.hubById.get(h.type_id);
  const lt = (ht && types.localByKey.get(ht.key)) || types.localById.get(r.type_id);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const copyTitle = `${r.title} (conflict ${stamp})`;
  await localAdmin(async (tx) => {
    const copy = (await tx.query<any>(
      `insert into public.records (workspace_id, type_id, title, fields, body, folder, parent_id)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning id`,
      [ws, r.type_id, copyTitle, JSON.stringify(r.fields), r.body, r.folder, r.parent_id])).rows[0];
    await tx.query("insert into surface_local.sync_conflicts (workspace_id, record_id, copy_id, title) values ($1, $2, $3, $4)", [ws, r.key, copy.id, r.title]);
    // the copy is a normal local change: mark it so it syncs up too
    await tx.query("insert into surface_local.sync_rows (workspace_id, kind, key, dirty) values ($1, 'record', $2, true) on conflict do nothing", [ws, copy.id]);
  });
  await applyRecord(ws, h, lt!, ht);
  rep.conflicts.push(`${r.title}: changed elsewhere too; your version is "${copyTitle}"`);
}

async function applyRecord(ws: string, h: Row, lt: TypeRow, ht: TypeRow | undefined, strip = false) {
  let fields = byId(byKey(h.fields ?? {}, ht), lt);
  if (strip) fields = Object.fromEntries(Object.entries(fields).filter(([k]) => lt.fields.find((f) => f.id === k)?.kind !== "link"));
  await localAdmin(async (tx) => {
    const exists = (await tx.query<any>("select 1 from public.records where id = $1", [h.id])).rows.length > 0;
    const parent = strip ? null : h.parent_id;
    if (exists) {
      await tx.query("update public.records set type_id = $2, title = $3, fields = $4::jsonb, body = $5, folder = $6, parent_id = $7, deleted_at = $8 where id = $1",
        [h.id, lt.id, h.title, JSON.stringify(fields), h.body ?? "", h.folder, parent, h.deleted_at]);
    } else {
      await tx.query("insert into public.records (id, workspace_id, type_id, title, fields, body, folder, parent_id, deleted_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)",
        [h.id, ws, lt.id, h.title, JSON.stringify(fields), h.body ?? "", h.folder, parent, h.deleted_at]);
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
