// The sidebar: organization only. Arranging it never changes a record's fields.
// The workspace sidebar is the shared view "sidebar" (`.surface/views/sidebar.yaml`);
// each member's own is their personal view "sidebar" (`.surface/views/personal/sidebar.yaml`).
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

      - view: open-tasks                            # a saved view: opens full-page (table, board…)
      - view: jobs
        unfold: true                                # lists its results in the tree instead
        each:
          - view: job-tasks                         # `this` = each job
            label: Tasks

    Node kinds (one per item):
      group:  a folder; `items` are its children
      record: a record by [[name]], title or id; shows its nested pages (parent field)
      view:   a saved view by key. Opens full-page; with `unfold: true` its results are listed
              in the tree (generated entries), and `each` adds children to every result.
              `label` renames the entry.
      query:  an inline unfolding search (`from`, `where`, `sort`), the older form of an
              unfolding view.
    Every record node also shows the records nested under it (`nested: false` turns that off).
    Entries written in the definition are "placed" (people arrange them); entries produced by
    a view or query are "generated" (the data decides where they appear).
    Top-level option: `display: split | merged` (personal sidebar only) — show the workspace and
    personal sidebars as two sections or one tree.
*/

export interface TreeDef {
  items: TreeItem[];
  display?: "split" | "merged";
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
  view?: string;
  unfold?: boolean;
  label?: string;
  items?: TreeItem[];
  each?: TreeItem[];
  nested?: boolean;
}

export interface TreeNode {
  label: string;
  kind: "group" | "record" | "view";
  id?: string;
  type?: string;
  /** view nodes: the saved view's key, and the record `this` means for it */
  view?: string;
  thisId?: string | null;
  unfold?: boolean;
  /** placed entries: where the item sits in the definition (indexes through `items`) */
  loc?: number[];
  /** view entries: the view is a personal one */
  personal?: boolean;
  children: TreeNode[];
}

/** A saved data view, as far as the tree needs it. */
export interface ViewLike {
  key: string;
  name: string;
  definition: Record<string, unknown>;
  owner?: string | null;
}

const KINDS = ["group", "record", "query", "view"] as const;

/** Check a definition; returns a list of problems (empty when valid). */
export function validateTree(def: unknown, types: TypeRow[], views?: ViewLike[]): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) return ["the view must be a set of keys (with `items:`)"];
  const items = (def as { items?: unknown }).items;
  if (!Array.isArray(items)) return ["`items:` must be a list"];
  const display = (def as { display?: unknown }).display;
  if (display !== undefined && display !== "split" && display !== "merged") errors.push("display must be split or merged");
  const walk = (list: unknown[], where: string) => {
    list.forEach((raw, i) => {
      const at = `${where}[${i + 1}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void errors.push(`${at}: each item must be a set of keys`);
      const it = raw as Record<string, unknown>;
      const kinds = KINDS.filter((k) => it[k] !== undefined);
      if (kinds.length !== 1) return void errors.push(`${at}: needs exactly one of group, record, view or query`);
      for (const k of Object.keys(it)) {
        if (![...KINDS, "items", "each", "nested", "unfold", "label"].includes(k)) errors.push(`${at}: unknown key "${k}"`);
      }
      if (it.view !== undefined) {
        if (typeof it.view !== "string") errors.push(`${at}: view needs a saved view's key`);
        else if (views && !views.some((v) => v.key === it.view)) errors.push(`${at}: no saved view "${it.view}" (views: ${views.map((v) => v.key).join(", ") || "none"})`);
      }
      if (it.label !== undefined && typeof it.label !== "string") errors.push(`${at}: label must be text`);
      if (it.unfold !== undefined && it.view === undefined) errors.push(`${at}: unfold only works on a view`);
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
        if (it.query === undefined && !(it.view !== undefined && it.unfold)) errors.push(`${at}: each only works on a query or an unfolding view`);
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

export function resolveTree(def: TreeDef, records: RecordRow[], types: TypeRow[], views: ViewLike[] = []): TreeNode[] {
  const typeOf = new Map(types.map((t) => [t.id, t]));
  const titles = new Map(records.map((r) => [r.id, r.title]));
  const byId = new Map(records.map((r) => [r.id, r]));
  const viewByKey = new Map(views.map((v) => [v.key, v]));
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

  const recordNode = (r: RecordRow, extra: TreeNode[], nested: boolean, depth: number, path: Set<string>, loc?: number[]): TreeNode => {
    const kids = [...extra];
    if (nested && depth < 12 && !path.has(r.id)) {
      const next = new Set(path).add(r.id);
      for (const c of sortRows(children.get(r.id) ?? [], "title", { typeOf, titles })) kids.push(recordNode(c, [], true, depth + 1, next));
    }
    return { label: r.title, kind: "record", id: r.id, type: typeOf.get(r.type_id)!.key, children: kids, ...(loc ? { loc } : {}) };
  };

  const run = (q: QueryDef, thisId: string | null) => {
    const ctx: QueryCtx = { typeOf, titles, thisId };
    const t = q.from ? types.find((x) => x.key === q.from) : null;
    if (q.from && !t) return [];
    let conds;
    try {
      conds = parseWhere(q.where);
    } catch {
      return [];
    }
    let rows = records.filter((r) => (!t || r.type_id === t.id) && matches(r, conds, ctx));
    rows = sortRows(rows, q.sort ?? "title", ctx);
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows;
  };

  // `placed` = this list comes from the definition, so its items get a loc
  const resolve = (items: TreeItem[], thisId: string | null, depth: number, path: Set<string>, base: number[] | null): TreeNode[] => {
    if (depth > 12) return [];
    const out: TreeNode[] = [];
    items.forEach((it, i) => {
      const loc = base ? [...base, i] : undefined;
      const nested = it.nested !== false;
      if (it.group !== undefined) {
        out.push({ label: it.group, kind: "group", children: resolve(it.items ?? [], thisId, depth + 1, path, loc ?? null), ...(loc ? { loc } : {}) });
      } else if (it.record !== undefined) {
        const r = findRef(it.record);
        if (!r) out.push({ label: `${it.record} (not found)`, kind: "group", children: [], ...(loc ? { loc } : {}) });
        else out.push(recordNode(r, resolve(it.items ?? [], r.id, depth + 1, path, loc ?? null), nested, depth + 1, path, loc));
      } else if (it.view !== undefined) {
        const v = viewByKey.get(it.view);
        const label = it.label ?? v?.name ?? `${it.view} (not found)`;
        const node: TreeNode = { label, kind: "view", view: it.view, thisId, unfold: !!it.unfold, personal: !!v?.owner, children: [], ...(loc ? { loc } : {}) };
        if (v && it.unfold) {
          const d = v.definition as QueryDef;
          node.children = run({ from: d.from, where: d.where, sort: d.sort, limit: d.limit }, thisId)
            .filter((r) => !path.has(r.id))
            .map((r) => recordNode(r, resolve(it.each ?? [], r.id, depth + 1, new Set(path).add(r.id), null), nested, depth + 1, path));
        }
        out.push(node);
      } else if (it.query) {
        const q = it.query;
        const nodes = run(q, thisId)
          .filter((r) => !path.has(r.id))
          .map((r) => recordNode(r, resolve(it.each ?? [], r.id, depth + 1, new Set(path).add(r.id), null), nested, depth + 1, path));
        if (q.label) out.push({ label: q.label, kind: "group", children: nodes, ...(loc ? { loc } : {}) });
        else out.push(...nodes);
      }
    });
    return out;
  };
  return resolve(def.items, null, 0, new Set(), []);
}

/** Draw the tree with box characters. `pathOf` adds the file path when given. */
export function drawTree(nodes: TreeNode[], pathOf?: (id: string) => string | undefined): string {
  const lines: string[] = [];
  const walk = (list: TreeNode[], prefix: string) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1;
      const name = n.kind === "group" ? `${n.label}/` : n.kind === "view" ? `${n.label} ⊞` : n.label;
      const extra = n.id && pathOf ? pathOf(n.id) : undefined;
      lines.push(`${prefix}${last ? "└── " : "├── "}${name}${extra ? `  (${extra})` : ""}`);
      walk(n.children, prefix + (last ? "    " : "│   "));
    });
  };
  nodes.forEach((n, i) => {
    const extra = n.id && pathOf ? pathOf(n.id) : undefined;
    lines.push(`${n.kind === "group" ? `${n.label}/` : n.kind === "view" ? `${n.label} ⊞` : n.label}${extra ? `  (${extra})` : ""}`);
    walk(n.children, "");
    if (i < nodes.length - 1) lines.push("");
  });
  return lines.join("\n");
}

export function asTreeDef(definition: Record<string, unknown>): TreeDef {
  if (!Array.isArray(definition.items)) throw new UserError("This view has no `items:` list.");
  return definition as unknown as TreeDef;
}

// ---------------------------------------------------------------------------
// Saved data views (tables, boards, lists, calendars)
// ---------------------------------------------------------------------------
/*  surface_view: 1
    name: Open tasks
    from: task
    where: "status!=Done && job=this"
    sort: due                           # or several: "status,-due" (- = descending)
    layouts:
      - show: table
        columns: [status, due, job]       # title always comes first; order = column order
        widths: { status: 120, job: 220 } # column widths in pixels (title too)
        frozen: 1                         # columns kept in view when scrolling sideways, after the title
        group: status                     # group rows by a field (up to 3: "status,-due"; "-" = descending)
        rows: compact                     # row height: compact | normal | tall
      - show: board
        by: status                        # a select or checkbox field
      - show: list
      - show: calendar
        date: due                         # a date field
*/
export const LAYOUTS = ["table", "board", "list", "calendar"] as const;
export interface LayoutDef {
  show: (typeof LAYOUTS)[number];
  columns?: string[];
  widths?: Record<string, number>;
  frozen?: number;
  group?: string;
  rows?: "compact" | "normal" | "tall";
  by?: string;
  date?: string;
  name?: string;
}
export interface DataViewDef {
  from: string;
  where?: string;
  sort?: string;
  limit?: number;
  layouts?: LayoutDef[];
}

export const isTreeDef = (key: string, def: Record<string, unknown>) => key === "sidebar" || "items" in def;

export function validateDataView(def: unknown, types: TypeRow[]): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== "object" || Array.isArray(def)) return ["the view must be a set of keys (from, where, sort, layouts)"];
  const d = def as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!["from", "where", "sort", "limit", "layouts"].includes(k)) errors.push(`unknown key "${k}"`);
  const t = types.find((x) => x.key === d.from);
  if (typeof d.from !== "string") errors.push("`from:` needs a type");
  else if (!t) errors.push(`no type "${d.from}" (types: ${types.map((x) => x.key).join(", ")})`);
  try {
    parseWhere(d.where as string | undefined);
  } catch (e) {
    errors.push((e as Error).message);
  }
  const known = (k: string) => ["title", "type", "folder", "parent", "id"].includes(k) || !!t?.fields.some((f) => f.key === k);
  if (d.sort !== undefined) {
    if (typeof d.sort !== "string") errors.push("sort must be a field key, or several separated by commas");
    else if (t) for (const k of d.sort.split(",").map((x) => x.trim().replace(/^-/, ""))) if (!known(k)) errors.push(`sort: no field "${k}"`);
  }
  if (d.layouts !== undefined) {
    if (!Array.isArray(d.layouts) || !d.layouts.length) errors.push("layouts must be a list");
    else
      d.layouts.forEach((raw, i) => {
        const at = `layouts[${i + 1}]`;
        const l = raw as Record<string, unknown>;
        if (!l || typeof l !== "object") return void errors.push(`${at}: must be a set of keys`);
        if (!LAYOUTS.includes(l.show as never)) errors.push(`${at}: show must be one of ${LAYOUTS.join(", ")}`);
        const allowed = l.show === "table" ? ["show", "columns", "widths", "frozen", "group", "rows", "name"] : ["show", "columns", "by", "date", "name"];
        for (const k of Object.keys(l)) if (!allowed.includes(k)) errors.push(`${at}: unknown key "${k}"${["widths", "frozen", "group", "rows"].includes(k) ? " (table layouts only)" : ""}`);
        if (l.widths !== undefined) {
          if (!l.widths || typeof l.widths !== "object" || Array.isArray(l.widths)) errors.push(`${at}: widths must be field: pixels`);
          else
            for (const [k, w] of Object.entries(l.widths as Record<string, unknown>)) {
              if (t && !known(k)) errors.push(`${at}: widths: no field "${k}"`);
              if (typeof w !== "number" || w < 40 || w > 2000) errors.push(`${at}: widths.${k} must be a number of pixels (40–2000)`);
            }
        }
        if (l.frozen !== undefined && (!Number.isInteger(l.frozen) || (l.frozen as number) < 0)) errors.push(`${at}: frozen must be a whole number of columns (0 = only the title)`);
        if (l.group !== undefined) {
          // one field, or up to three separated by commas (outer first); "-" orders that level descending
          const levels = typeof l.group === "string" ? l.group.split(",").map((x) => x.trim().replace(/^-/, "")).filter(Boolean) : null;
          if (!levels || !levels.length) errors.push(`${at}: group must be a field key, or up to three separated by commas`);
          else {
            if (levels.length > 3) errors.push(`${at}: group allows at most three levels`);
            if (new Set(levels).size !== levels.length) errors.push(`${at}: group lists a field twice`);
            if (t) for (const k of levels) if (!known(k)) errors.push(`${at}: group: no field "${k}"`);
          }
        }
        if (l.rows !== undefined && !["compact", "normal", "tall"].includes(l.rows as string)) errors.push(`${at}: rows must be compact, normal or tall`);
        if (l.columns !== undefined) {
          if (!Array.isArray(l.columns)) errors.push(`${at}: columns must be a list`);
          else if (t) for (const c of l.columns) if (!known(String(c))) errors.push(`${at}: no field "${c}"`);
        }
        if (l.show === "board") {
          const f = t?.fields.find((x) => x.key === l.by);
          if (t && (!f || !["select", "checkbox"].includes(f.kind))) {
            const ok = t.fields.filter((x) => ["select", "checkbox"].includes(x.kind)).map((x) => x.key);
            errors.push(`${at}: a board needs by: <a select or checkbox field>${l.by ? ` ("${l.by}" isn't one)` : ""}; ${t.key} has: ${ok.join(", ") || "none"}`);
          }
        }
        if (l.show === "calendar") {
          const f = t?.fields.find((x) => x.key === l.date);
          if (t && (!f || f.kind !== "date")) {
            const ok = t.fields.filter((x) => x.kind === "date").map((x) => x.key);
            errors.push(`${at}: a calendar needs date: <a date field>${l.date ? ` ("${l.date}" isn't one)` : ""}; ${t.key} has: ${ok.join(", ") || "none"}`);
          }
        }
      });
  }
  return errors;
}
