// Talks to the local server (`surface serve`).
export type Kind = "text" | "number" | "date" | "checkbox" | "select" | "multi_select" | "url" | "email" | "phone" | "link";

export interface FieldDef {
  id: string;
  key: string;
  name: string;
  kind: Kind;
  options?: string[];
  target?: string | null; // type key
  multiple?: boolean;
  required?: boolean;
}
export interface TypeInfo {
  id: string;
  key: string;
  name: string;
  folder: string | null;
  icon: string | null;
  builtin: boolean;
  display: "document" | "fields";
  fields: FieldDef[];
}
export interface Summary {
  id: string;
  title: string;
  type: string;
  parent: string | null;
  folder: string | null;
  updated_at: string;
  path: string | null;
}
export interface RecordFull extends Summary {
  rev: number;
  fields: Record<string, unknown>;
  body: string;
  created_at: string;
}
export interface TreeNode {
  label: string;
  kind: "group" | "record" | "view";
  id?: string;
  type?: string;
  view?: string;
  thisId?: string | null;
  unfold?: boolean;
  personal?: boolean;
  /** placed entries only: index path through `items` in the sidebar definition */
  loc?: number[];
  children: TreeNode[];
}
export interface TreeItem {
  group?: string;
  record?: string;
  view?: string;
  query?: { from?: string; where?: string; sort?: string; label?: string; limit?: number };
  unfold?: boolean;
  label?: string;
  items?: TreeItem[];
  each?: TreeItem[];
  nested?: boolean;
}
export interface TreeDef {
  items: TreeItem[];
  display?: "split" | "merged";
}
export interface SidebarInfo {
  exists: boolean;
  rev: number | null;
  definition: TreeDef;
  tree: TreeNode[];
}
export type LayoutKind = "table" | "board" | "list" | "calendar";
export interface LayoutDef {
  show: LayoutKind;
  columns?: string[];
  by?: string;
  date?: string;
  name?: string;
}
export interface ViewDef {
  from: string;
  where?: string;
  sort?: string;
  limit?: number;
  layouts?: LayoutDef[];
}
export interface ViewInfo {
  key: string;
  name: string;
  personal: boolean;
  rev: number;
  definition: ViewDef;
  updated_at: string;
}
export type Role = "owner" | "admin" | "member" | "viewer";
export interface AppState {
  mode: "local" | "hosted";
  user: { email: string; id: string };
  role: Role;
  workspace: { id: string; name: string };
  root: string;
  layout: string;
  types: TypeInfo[];
  records: Summary[];
  views: ViewInfo[];
  sidebar: { workspace: SidebarInfo; personal: SidebarInfo; display: "split" | "merged" };
  members: number;
  tree: TreeNode[];
  hasSidebar: boolean;
}
export interface Member {
  user_id: string;
  email: string;
  role: Role;
  created_at: string;
}
export interface Invite {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  workspace?: string;
}
export interface Backlink {
  id: string;
  title: string;
  type: string;
  via: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors?: Record<string, string>) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText, data.errors);
  return data as T;
}

export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  record: (id: string) => call<{ record: RecordFull; backlinks: Backlink[] }>("GET", `/api/record/${id}`),
  save: (id: string, patch: { baseRev?: number; title?: string; body?: string; fields?: Record<string, unknown>; parent?: string | null }) =>
    call<{ record: RecordFull; notices: string[] }>("PUT", `/api/record/${id}`, patch),
  create: (input: { type: string; title: string; parent?: string | null; body?: string; fields?: Record<string, unknown> }) =>
    call<{ record: RecordFull; notices: string[] }>("POST", "/api/records", input),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/record/${id}`),
  upload: async (id: string, file: File) => {
    const r = await fetch(`/api/record/${id}/attach?name=${encodeURIComponent(file.name || "image.png")}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error ?? r.statusText);
    return data as { path: string; markdownPath: string };
  },
  restore: (id: string) => call<{ ok: true }>("POST", `/api/record/${id}/restore`),
  query: (q: { from?: string; where?: string; sort?: string; ids?: string[]; this?: string }) => call<{ records: RecordFull[] }>("POST", "/api/query", q),
  search: (q: string) => call<{ results: (Summary & { snippet: string })[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  view: (key: string, opts: { personal?: boolean; this?: string | null } = {}) =>
    call<{ view: ViewInfo; records: RecordFull[]; problem: string | null; this: Summary | null }>(
      "GET",
      `/api/view/${encodeURIComponent(key)}?${new URLSearchParams({ ...(opts.personal ? { personal: "1" } : {}), ...(opts.this ? { this: opts.this } : {}) })}`,
    ),
  saveView: (key: string, personal: boolean, body: { name: string; definition: ViewDef; baseRev?: number | null }) =>
    call<{ view: ViewInfo }>("PUT", `/api/view/${encodeURIComponent(key)}${personal ? "?personal=1" : ""}`, body),
  createView: (body: { name: string; definition: ViewDef; personal: boolean }) => call<{ view: ViewInfo }>("POST", "/api/views", body),
  removeView: (key: string, personal: boolean) => call<{ ok: true }>("DELETE", `/api/view/${encodeURIComponent(key)}${personal ? "?personal=1" : ""}`),
  saveSidebar: (scope: "workspace" | "personal", definition: TreeDef, baseRev?: number | null) =>
    call<{ sidebar: SidebarInfo }>("PUT", "/api/sidebar", { scope, definition, baseRev }),
  saveType: (type: string, patch: { name?: string; folder?: string; display?: "document" | "fields"; fields?: FieldDef[] }) => call<{ ok: true }>("PUT", `/api/type/${type}`, patch),
  createType: (body: { key: string; name: string; display?: "document" | "fields" }) => call<{ ok: true; key: string }>("POST", "/api/types", body),
  setTypeDisplay: (type: string, display: "document" | "fields") => call<{ ok: true }>("PUT", `/api/type/${type}`, { display }),
  members: () => call<{ members: Member[]; invites: Invite[]; role: Role }>("GET", "/api/members"),
  invite: (email: string, role: Role) => call<{ ok: true }>("POST", "/api/invites", { email, role }),
  cancelInvite: (id: string) => call<{ ok: true }>("DELETE", `/api/invites/${id}`),
  setRole: (userId: string, role: Role) => call<{ ok: true }>("PUT", `/api/members/${userId}`, { role }),
  removeMember: (userId: string) => call<{ ok: true }>("DELETE", `/api/members/${userId}`),
  workspaces: () => call<{ workspaces: { id: string; name: string; role: Role | null; current: boolean }[]; invites: Invite[] }>("GET", "/api/workspaces"),
  createWorkspace: (name: string) => call<{ workspace: { id: string; name: string } }>("POST", "/api/workspaces", { name }),
  acceptInvite: (id: string) => call<{ ok: true }>("POST", `/api/invites/${id}/accept`),
};

export function subscribe(onChange: (msg: { type: string; reason?: string; ids?: string[] }) => void, onStatus: (online: boolean) => void) {
  let es: EventSource | null = null;
  let timer: number | undefined;
  const open = () => {
    es = new EventSource("/api/events");
    es.onopen = () => onStatus(true);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "changed") onChange(msg);
      } catch {}
    };
    es.onerror = () => {
      onStatus(false);
      es?.close();
      timer = window.setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    es?.close();
    window.clearTimeout(timer);
  };
}
