// Reading types and records from the database.
import { sb, dbError, UserError } from "./client.ts";

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

/** All records of a workspace, paginated past PostgREST's 1000-row cap. */
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
}

export type PushResult =
  | { ok: true; record: RecordRow }
  | { ok: false; kind: "conflict" | "deleted" | "invalid"; message: string };

export async function pushRecord(a: PushArgs): Promise<PushResult> {
  const { data, error } = await sb().rpc("push_record", {
    p_workspace: a.workspace,
    p_id: a.id,
    p_base_rev: a.baseRev,
    p_type: a.type,
    p_title: a.title,
    p_fields: a.fields,
    p_body: a.body,
    p_folder: a.folder ?? null,
    p_parent: a.parent ?? null,
  });
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
}

export async function fetchViews(ws: string): Promise<ViewRow[]> {
  const { data, error } = await sb().from("views").select("*").eq("workspace_id", ws).order("key");
  if (error) throw dbError(error);
  return data as ViewRow[];
}

export async function saveView(ws: string, key: string, name: string | null, definition: Record<string, unknown>, baseRev: number | null): Promise<{ ok: true; view: ViewRow } | { ok: false; kind: "conflict" | "invalid"; message: string }> {
  const { data, error } = await sb().rpc("save_view", { p_workspace: ws, p_key: key, p_name: name, p_definition: definition, p_base_rev: baseRev });
  if (error) {
    if (error.message.startsWith("conflict: ")) return { ok: false, kind: "conflict", message: error.message.slice(10) };
    return { ok: false, kind: "invalid", message: dbError(error).message };
  }
  return { ok: true, view: data as ViewRow };
}
