// Reading types and records from the database.
import { sb, dbError, UserError, storeKind } from "./client.ts";

export type Kind =
  | "text" | "number" | "date" | "checkbox" | "select" | "multi_select"
  | "url" | "email" | "phone" | "link";

export const KINDS: Kind[] = ["text", "number", "date", "checkbox", "select", "multi_select", "url", "email", "phone", "link"];

export interface FieldDef {
  id: string;
  key: string;
  name: string;
  kind: Kind;
  options?: string[];
  target?: string; // type id (link fields)
  multiple?: boolean;
  /** Computed reverse link: the target type's ordinary stored link field id. */
  inverse?: string;
  required?: boolean;
}

export interface TypeRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  icon: string | null;
  folder: string | null;
  fields: FieldDef[];
  is_builtin: boolean;
  /** How a record of this type opens: body first, or properties first. */
  display?: "document" | "fields";
}

export interface RecordRow {
  id: string;
  workspace_id: string;
  type_id: string;
  title: string;
  fields: Record<string, unknown>; // keyed by field id
  body: string;
  folder: string | null;
  parent_id: string | null;
  /** Other names the record answers to (Obsidian's `aliases`). Missing on hubs without migration 0006. */
  aliases?: string[] | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function fetchTypes(ws: string): Promise<TypeRow[]> {
  const { data, error } = await sb().from("types").select("*").eq("workspace_id", ws).order("created_at");
  if (error) throw dbError(error);
  return data as TypeRow[];
}

/** Old schema normalizers discard unknown metadata, so inverse schema writes fail closed. */
export async function requireInverseSchema(): Promise<void> {
  const { data, error } = await sb().rpc("surface_schema_version");
  if (error || typeof data !== "number" || data < 7) throw new UserError(`Inverse relationships require database migration 0007. An authorized administrator can run \`surface cloud migrate --since 7\` with SUPABASE_ACCESS_TOKEN, or apply \`surface cloud schema --since 7\` in the SQL editor.${error ? ` ${error.message}` : ""}`);
}

/** Raw stored records, without computed inverse values; safe for snapshots and sync. */
export async function fetchRecords(ws: string, opts: { includeDeleted?: boolean; typeIds?: string[] } = {}): Promise<RecordRow[]> {
  const out: RecordRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb().from("records").select("*").eq("workspace_id", ws).order("id").range(from, from + page - 1);
    if (!opts.includeDeleted) q = q.is("deleted_at", null);
    if (opts.typeIds) q = q.in("type_id", opts.typeIds);
    const { data, error } = await q;
    if (error) throw dbError(error);
    out.push(...(data as RecordRow[]));
    if (data.length < page) break;
  }
  return out;
}

export async function fetchRecord(id: string): Promise<RecordRow | null> {
  const { data, error } = await sb().from("records").select("*").eq("id", id).maybeSingle();
  if (error) throw dbError(error);
  return data as RecordRow | null;
}

/** Materialize reverse links without mutating stored rows. `sources` must contain every
 * live source record, even when `records` is a partial checkout or an id lookup. */
export function materializeInverseLinks(records: RecordRow[], types: TypeRow[], sources: RecordRow[] = records): RecordRow[] {
  const typeMap = new Map(types.map((t) => [t.id, t]));
  const inverses = new Map<string, Map<string, string[]>>();
  for (const t of types) for (const f of t.fields) {
    if (f.kind !== "link" || !f.inverse || !f.target) continue;
    const source = typeMap.get(f.target);
    const forward = source?.fields.find((x) => x.id === f.inverse && x.kind === "link" && !x.inverse && x.target === t.id);
    if (!source || source.workspace_id !== t.workspace_id || !forward || inverses.has(forward.id)) continue;
    const links = new Map<string, string[]>();
    for (const r of sources) {
      if (r.deleted_at || r.type_id !== source.id || r.workspace_id !== t.workspace_id) continue;
      const value = r.fields[forward.id];
      for (const id of new Set(Array.isArray(value) ? value : value == null ? [] : [value])) {
        if (typeof id !== "string") continue;
        const ids = links.get(id);
        if (ids) ids.push(r.id);
        else links.set(id, [r.id]);
      }
    }
    for (const ids of links.values()) ids.sort();
    inverses.set(forward.id, links);
  }
  return records.map((r) => {
    const fields = typeMap.get(r.type_id)?.fields.filter((f) => f.kind === "link" && f.inverse);
    if (!fields?.length) return r;
    const values = { ...r.fields };
    for (const f of fields) {
      const ids = inverses.get(f.inverse!)?.get(r.id) ?? [];
      values[f.id] = f.multiple ? ids : ids[0] ?? null;
    }
    return { ...r, fields: values };
  });
}

export function typeByKey(types: TypeRow[], key: string): TypeRow {
  const t = types.find((t) => t.key === key || t.id === key || t.name.toLowerCase() === key.toLowerCase());
  if (!t) throw new UserError(`No type "${key}". Types: ${types.map((t) => t.key).join(", ")}`);
  return t;
}

export function fieldByKey(t: TypeRow, key: string): FieldDef {
  const f = t.fields.find((f) => f.key === key);
  if (!f) throw new UserError(`Type "${t.key}" has no field "${key}". Fields: ${t.fields.map((f) => f.key).join(", ") || "(none)"}`);
  return f;
}

export interface PushArgs {
  workspace: string;
  id: string | null;
  baseRev: number | null;
  type: string;
  title: string;
  fields: Record<string, unknown>; // keyed by field key
  body: string;
  folder?: string | null;
  /** undefined/null = keep, "" = clear, id = set */
  parent?: string | null;
  /** undefined = keep */
  aliases?: string[];
}

export type PushResult =
  | { ok: true; record: RecordRow }
  | { ok: false; kind: "conflict" | "deleted" | "invalid"; message: string };

export async function pushRecord(a: PushArgs): Promise<PushResult> {
  const args: Record<string, unknown> = {
    p_workspace: a.workspace,
    p_id: a.id,
    p_base_rev: a.baseRev,
    p_type: a.type,
    p_title: a.title,
    p_fields: a.fields,
    p_body: a.body,
    p_folder: a.folder ?? null,
    p_parent: a.parent ?? null,
  };
  // aliases need migration 0006; only send them when there's something to say (or the local store, which always has it),
  // so cloud projects that haven't upgraded keep working without a failed call per save
  if (a.aliases && (a.aliases.length || (a.id && storeKind() === "local"))) args.p_aliases = a.aliases;
  let { data, error } = await sb().rpc("push_record", args);
  if (error && "p_aliases" in args && /p_aliases|function public\.push_record|Could not find the function/i.test(error.message)) {
    const { logger } = await import("./log.ts");
    logger("db").warn("database has no aliases yet (needs migration 0006: surface cloud schema --since 6); saved without them", { id: a.id });
    delete args.p_aliases;
    ({ data, error } = await sb().rpc("push_record", args));
  }
  if (error) {
    if (error.message.startsWith("conflict: ")) return { ok: false, kind: "conflict", message: error.message.slice(10) };
    if (error.message.startsWith("deleted: ")) return { ok: false, kind: "deleted", message: error.message.slice(9) };
    return { ok: false, kind: "invalid", message: dbError(error).message };
  }
  return { ok: true, record: data as RecordRow };
}

// ---------------------------------------------------------------------------
// Saved views (the Views tree is the view with key "sidebar")
// ---------------------------------------------------------------------------
export interface ViewRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  definition: Record<string, unknown>;
  rev: number;
  updated_at: string;
  /** null = shared with the workspace; a user id = that member's own */
  owner: string | null;
}

export async function fetchViews(ws: string): Promise<ViewRow[]> {
  const { data, error } = await sb().from("views").select("*").eq("workspace_id", ws).order("key");
  if (error) throw dbError(error);
  return data as ViewRow[];
}

export async function saveView(ws: string, key: string, name: string | null, definition: Record<string, unknown>, baseRev: number | null, personal = false): Promise<{ ok: true; view: ViewRow } | { ok: false; kind: "conflict" | "invalid"; message: string }> {
  const { data, error } = await sb().rpc("save_view", { p_workspace: ws, p_key: key, p_name: name, p_definition: definition, p_base_rev: baseRev, p_personal: personal });
  if (error) {
    if (error.message.startsWith("conflict: ")) return { ok: false, kind: "conflict", message: error.message.slice(10) };
    return { ok: false, kind: "invalid", message: dbError(error).message };
  }
  return { ok: true, view: data as ViewRow };
}

export async function deleteView(ws: string, key: string, personal = false): Promise<void> {
  let q = sb().from("views").delete().eq("workspace_id", ws).eq("key", key);
  q = personal ? q.not("owner", "is", null) : q.is("owner", null);
  const { error } = await q;
  if (error) throw dbError(error);
}

// ---------------------------------------------------------------------------
// Members and invites
// ---------------------------------------------------------------------------
export interface MemberRow {
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}
export interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  created_at: string;
}

export async function fetchMembers(ws: string): Promise<MemberRow[]> {
  const { data, error } = await sb().rpc("workspace_members", { p_workspace: ws });
  if (error) throw dbError(error);
  return data as MemberRow[];
}
export async function fetchInvites(ws: string): Promise<InviteRow[]> {
  const { data, error } = await sb().from("invites").select("*").eq("workspace_id", ws).order("created_at");
  if (error) throw dbError(error);
  return data as InviteRow[];
}
/** Invites addressed to the signed-in user, with the workspace name. */
export async function myInvites(): Promise<(InviteRow & { workspace: string })[]> {
  const { data, error } = await sb().from("invites").select("*, workspaces(name)").order("created_at");
  if (error) throw dbError(error);
  return (data as (InviteRow & { workspaces: { name: string } | null })[]).map((i) => ({ ...i, workspace: i.workspaces?.name ?? i.workspace_id }));
}
