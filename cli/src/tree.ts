// The Views tree: a sidebar made of groups, records (with nested pages) and queries.
// Stored as the saved view with key "sidebar"; written to `.surface/views/sidebar.yaml`.
import { UserError } from "./client.ts";
import type { RecordRow, TypeRow } from "./db.ts";
import { matches, parseWhere, sortRows, type QueryCtx } from "./query.ts";

/*  Definition format (YAML on disk, JSON in the database):

    surface_view: 1
    name: Sidebar
    items:
      - group: Jobs
        items:
          - query: { from: project, where: "status!=Done", sort: title }
            each:                                   # children of every matching record
              - query: { from: task, where: "project=this", label: Tasks }
              - query: { from: material, where: "project=this", label: Materials }
      - record: "[[How We Estimate]]"               # one record, with its nested pages
      - query: { from: page, where: "parent=", sort: title, label: Pages }

    Node kinds (one per item):
      group:  a virtual folder; `items` are its children
      record: a record by [[name]], title or id; shows its nested pages (parent field)
      query:  records matching `from` (type), `where`, `sort`. With `label`, they sit under
              a group of that name; without, they appear inline. `each` adds children to
              every match, where `this` means that match.
    Every record node also shows the records nested under it (`nested: false` turns that off).
*/

export interface TreeDef {
  items: TreeItem[];
}
export interface QueryDef {
  from?: string;
  where?: string;
  sort?: string;
  label?: string;
  limit?: number;
}
export interface TreeItem {
  group?: string;
  record?: string;
  query?: QueryDef;
  items?: TreeItem[];
  each?: TreeItem[];
  nested?: boolean;
}

export interface TreeNode {
  label: string;
  kind: "group" | "record";
  id?: string;
  type?: string;
  children: TreeNode[];
}

const KINDS = ["group", "record", "query"] as const;

/** Check a definition; returns a list of problems (empty when valid). */
export function validateTree(def: unknown, types: TypeRow[]): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) return ["the view must be a set of keys (with `items:`)"];
  const items = (def as { items?: unknown }).items;
  if (!Array.isArray(items)) return ["`items:` must be a list"];
  const walk = (list: unknown[], where: string) => {
    list.forEach((raw, i) => {
      const at = `${where}[${i + 1}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void errors.push(`${at}: each item must be a set of keys`);
      const it = raw as Record<string, unknown>;
      const kinds = KINDS.filter((k) => it[k] !== undefined);
      if (kinds.length !== 1) return void errors.push(`${at}: needs exactly one of group, record or query`);
      for (const k of Object.keys(it)) {
        if (![...KINDS, "items", "each", "nested"].includes(k)) errors.push(`${at}: unknown key "${k}"`);
      }
      if (it.group !== undefined && typeof it.group !== "string") errors.push(`${at}: group needs a name`);
      if (it.record !== undefined && typeof it.record !== "string") errors.push(`${at}: record needs a [[name]] or id`);
      if (it.query !== undefined) {
        const q = it.query as Record<string, unknown>;
        if (!q || typeof q !== "object") errors.push(`${at}: query must be a set of keys (from, where, sort, label)`);
        else {
          for (const k of Object.keys(q)) if (!["from", "where", "sort", "label", "limit"].includes(k)) errors.push(`${at}: unknown query key "${k}"`);
          if (q.from !== undefined && !types.some((t) => t.key === q.from)) errors.push(`${at}: no type "${q.from}" (types: ${types.map((t) => t.key).join(", ")})`);
          try {
            parseWhere(q.where as string | undefined);
          } catch (e) {
            errors.push(`${at}: ${(e as Error).message}`);
          }
        }
      }
      if (it.items !== undefined) Array.isArray(it.items) ? walk(it.items, `${at}.items`) : errors.push(`${at}: items must be a list`);
      if (it.each !== undefined) {
        if (it.query === undefined) errors.push(`${at}: each only works on a query`);
        Array.isArray(it.each) ? walk(it.each, `${at}.each`) : errors.push(`${at}: each must be a list`);
      }
    });
  };
  walk(items, "items");
  return errors;
}

/** A default tree: one group per type, listing its top-level records with their nested pages. */
export function defaultTree(types: TypeRow[]): TreeDef {
  return {
    items: types.map((t) => ({ group: t.folder || `${t.name}s`, items: [{ query: { from: t.key, where: "parent=", sort: "title" } }] })),
  };
}

export function resolveTree(def: TreeDef, records: RecordRow[], types: TypeRow[]): TreeNode[] {
  const typeOf = new Map(types.map((t) => [t.id, t]));
  const titles = new Map(records.map((r) => [r.id, r.title]));
  const byId = new Map(records.map((r) => [r.id, r]));
  const children = new Map<string, RecordRow[]>();
  for (const r of records) {
    if (r.parent_id && byId.has(r.parent_id)) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  }
  const findRef = (ref: string): RecordRow | null => {
    const label = ref.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
    if (byId.has(label)) return byId.get(label)!;
    const hits = records.filter((r) => r.title.toLowerCase() === label.toLowerCase());
    return hits.length === 1 ? hits[0] : null;
  };

  const recordNode = (r: RecordRow, extra: TreeNode[], nested: boolean, depth: number, path: Set<string>): TreeNode => {
    const kids = [...extra];
    if (nested && depth < 12 && !path.has(r.id)) {
      const next = new Set(path).add(r.id);
      for (const c of sortRows(children.get(r.id) ?? [], "title", { typeOf, titles })) kids.push(recordNode(c, [], true, depth + 1, next));
    }
    return { label: r.title, kind: "record", id: r.id, type: typeOf.get(r.type_id)!.key, children: kids };
  };

  const resolve = (items: TreeItem[], thisId: string | null, depth: number, path: Set<string>): TreeNode[] => {
    if (depth > 12) return [];
    const out: TreeNode[] = [];
    for (const it of items) {
      const nested = it.nested !== false;
      if (it.group !== undefined) {
        out.push({ label: it.group, kind: "group", children: resolve(it.items ?? [], thisId, depth + 1, path) });
      } else if (it.record !== undefined) {
        const r = findRef(it.record);
        if (!r) out.push({ label: `${it.record} (not found)`, kind: "group", children: [] });
        else out.push(recordNode(r, resolve(it.items ?? [], r.id, depth + 1, path), nested, depth + 1, path));
      } else if (it.query) {
        const q = it.query;
        const ctx: QueryCtx = { typeOf, titles, thisId };
        const t = q.from ? types.find((x) => x.key === q.from) : null;
        let rows = records.filter((r) => (!t || r.type_id === t.id) && matches(r, parseWhere(q.where), ctx));
        rows = sortRows(rows, q.sort ?? "title", ctx);
        if (q.limit) rows = rows.slice(0, q.limit);
        const nodes = rows
          .filter((r) => !path.has(r.id))
          .map((r) => {
            const next = new Set(path).add(r.id);
            return recordNode(r, resolve(it.each ?? [], r.id, depth + 1, next), nested, depth + 1, path);
          });
        if (q.label) out.push({ label: q.label, kind: "group", children: nodes });
        else out.push(...nodes);
      }
    }
    return out;
  };
  return resolve(def.items, null, 0, new Set());
}

/** Draw the tree with box characters. `pathOf` adds the file path when given. */
export function drawTree(nodes: TreeNode[], pathOf?: (id: string) => string | undefined): string {
  const lines: string[] = [];
  const walk = (list: TreeNode[], prefix: string) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1;
      const name = n.kind === "group" ? `${n.label}/` : n.label;
      const extra = n.id && pathOf ? pathOf(n.id) : undefined;
      lines.push(`${prefix}${last ? "└── " : "├── "}${name}${extra ? `  (${extra})` : ""}`);
      walk(n.children, prefix + (last ? "    " : "│   "));
    });
  };
  nodes.forEach((n, i) => {
    const extra = n.id && pathOf ? pathOf(n.id) : undefined;
    lines.push(`${n.kind === "group" ? `${n.label}/` : n.label}${extra ? `  (${extra})` : ""}`);
    walk(n.children, "");
    if (i < nodes.length - 1) lines.push("");
  });
  return lines.join("\n");
}

export function asTreeDef(definition: Record<string, unknown>): TreeDef {
  if (!Array.isArray(definition.items)) throw new UserError("This view has no `items:` list.");
  return definition as unknown as TreeDef;
}
