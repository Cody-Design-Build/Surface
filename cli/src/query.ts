// Filtering and sorting records: shared by `surface query` and the Views tree.
import { UserError } from "./client.ts";
import { phoneText } from "./phone.ts";
import type { RecordRow, TypeRow } from "./db.ts";

export interface Cond {
  key: string;
  op: string;
  want: string;
}

export interface QueryCtx {
  typeOf: Map<string, TypeRow>;
  titles: Map<string, string>;
  /** The record `this` refers to (the page a view sits on, or the parent in a tree). */
  thisId?: string | null;
}

/** "status=doing && due<2026-11-01" -> conditions. Empty want ("parent=") means "is empty". */
export function parseWhere(where: string | string[] | undefined | null): Cond[] {
  const parts = ([] as string[]).concat(where ?? []).flatMap((w) => w.split(/\s*&&\s*/)).filter((w) => w.trim());
  return parts.map((w) => {
    const m = w.trim().match(/^([a-z_][a-z0-9_]*)\s*(!=|>=|<=|=|>|<|~)\s*(.*)$/);
    if (!m) throw new UserError(`Can't read the condition "${w}". Use key=value, key!=value, key>value, key<value or key~text (join with &&).`);
    return { key: m[1], op: m[2], want: m[3].trim().replace(/^["']|["']$/g, "") };
  });
}

/** Raw ids a key points at (link fields and parent), or null when the key isn't a link. */
function linkIds(r: RecordRow, key: string, t: TypeRow): string[] | null {
  if (key === "parent") return r.parent_id ? [r.parent_id] : [];
  const f = t.fields.find((f) => f.key === key);
  if (!f || f.kind !== "link") return null;
  const v = r.fields[f.id];
  return v == null ? [] : (Array.isArray(v) ? v : [v]).map(String);
}

export function valueOf(r: RecordRow, key: string, ctx: QueryCtx): unknown {
  const t = ctx.typeOf.get(r.type_id)!;
  if (key === "title") return r.title;
  if (key === "type") return t.key;
  if (key === "id") return r.id;
  if (key === "folder") return r.folder ?? "";
  const ids = linkIds(r, key, t);
  if (ids) return ids.map((id) => ctx.titles.get(id) ?? id);
  const f = t.fields.find((f) => f.key === key);
  return f?.kind === "phone" ? phoneText(r.fields[f.id], false) : f ? r.fields[f.id] : undefined;
}

export function matches(r: RecordRow, conds: Cond[], ctx: QueryCtx): boolean {
  const t = ctx.typeOf.get(r.type_id)!;
  return conds.every(({ key, op, want }) => {
    const known = ["title", "type", "id", "folder", "parent"].includes(key) || t.fields.some((f) => f.key === key);
    if (!known) return op === "!=" || (op === "=" && want === "");
    if (want === "this") {
      const ids = linkIds(r, key, t);
      const hit = !!ctx.thisId && (ids ? ids.includes(ctx.thisId) : r.id === ctx.thisId);
      return op === "!=" ? !hit : op === "=" ? hit : false;
    }
    const v = valueOf(r, key, ctx);
    const list = Array.isArray(v) ? v.map(String) : null;
    const s = v == null ? "" : list ? list.join(", ") : String(v);
    const lw = want.toLowerCase();
    const num = (x: string) => (x !== "" && !isNaN(Number(x)) ? Number(x) : x);
    switch (op) {
      case "=": return s.toLowerCase() === lw || (!!list && list.some((x) => x.toLowerCase() === lw));
      case "!=": return s.toLowerCase() !== lw && !(list && list.some((x) => x.toLowerCase() === lw));
      case "~": return s.toLowerCase().includes(lw);
      case ">": return s !== "" && num(s) > num(want);
      case "<": return s !== "" && num(s) < num(want);
      case ">=": return s !== "" && num(s) >= num(want);
      case "<=": return s !== "" && num(s) <= num(want);
    }
    return false;
  });
}

/** Sort by a key; "-key" sorts descending. */
export function sortRows(rows: RecordRow[], sortKey: string | undefined | null, ctx: QueryCtx): RecordRow[] {
  if (!sortKey) return rows;
  // "status,-due": by status (in option order), then due descending; empty values last
  const keys = sortKey.split(",").map((k) => k.trim()).filter(Boolean).map((k) => ({ desc: k.startsWith("-"), key: k.replace(/^-/, "") }));
  const val = (r: RecordRow, k: string) => {
    const v = valueOf(r, k, ctx);
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
    const f = ctx.typeOf.get(r.type_id)?.fields.find((x) => x.key === k);
    if (f?.kind === "select" && f.options?.includes(String(v))) return f.options.indexOf(String(v));
    return Array.isArray(v) ? v.join(", ").toLowerCase() : typeof v === "number" ? v : String(v).toLowerCase();
  };
  return [...rows].sort((x, y) => {
    for (const { key, desc } of keys) {
      const a = val(x, key), b = val(y, key);
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
}
