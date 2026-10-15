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
  kind: "group" | "record";
  id?: string;
  type?: string;
  children: TreeNode[];
}
export interface AppState {
  mode: "local" | "hosted";
  user: { email: string };
  workspace: { id: string; name: string };
  root: string;
  layout: string;
  types: TypeInfo[];
  records: Summary[];
  tree: TreeNode[];
  hasSidebar: boolean;
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
  save: (id: string, patch: { baseRev: number; title?: string; body?: string; fields?: Record<string, unknown>; parent?: string | null }) =>
    call<{ record: RecordFull; notices: string[] }>("PUT", `/api/record/${id}`, patch),
  create: (input: { type: string; title: string; parent?: string | null; body?: string; fields?: Record<string, unknown> }) =>
    call<{ record: RecordFull; notices: string[] }>("POST", "/api/records", input),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/record/${id}`),
  query: (q: { from?: string; where?: string; sort?: string; ids?: string[]; this?: string }) => call<{ records: RecordFull[] }>("POST", "/api/query", q),
  search: (q: string) => call<{ results: (Summary & { snippet: string })[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),
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
