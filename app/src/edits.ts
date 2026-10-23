// Record changes made from views, boards and Move to…, each with an undo entry.
import { api, type AppState, type RecordFull, type TypeInfo } from "./api.ts";
import { did } from "./undo.ts";
import { phoneText } from "../../cli/src/phone.ts";

function fmt(v: unknown, f?: { kind: string }, titleOf?: (id: string) => string): string {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "empty";
  if (f?.kind === "phone") return phoneText(v).replace(/\n/g, "; ");
  if (f?.kind === "checkbox") return v ? "checked" : "unchecked";
  if (f?.kind === "link" && titleOf) return (Array.isArray(v) ? v : [v]).map((x) => titleOf(String(x))).join(", ");
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/** Set fields on a record; returns the saved record. Registers undo. */
export async function setFields(app: AppState, rec: RecordFull, patch: Record<string, unknown>, label?: string): Promise<RecordFull> {
  const type = app.types.find((t) => t.key === rec.type);
  const old: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) old[k] = rec.fields[k] ?? null;
  const res = await api.save(rec.id, { baseRev: rec.rev, fields: patch });
  const titleOf = (id: string) => app.records.find((r) => r.id === id)?.title ?? id;
  const k0 = Object.keys(patch)[0];
  const f0 = type?.fields.find((f) => f.key === k0);
  const text = label ?? `Set ${f0?.name ?? k0} → ${fmt(res.record.fields[k0], f0, titleOf)}`;
  let rev = res.record.rev;
  did({
    label: text,
    undo: async () => {
      const r = await api.save(rec.id, { baseRev: rev, fields: old });
      rev = r.record.rev;
    },
    redo: async () => {
      const r = await api.save(rec.id, { baseRev: rev, fields: patch });
      rev = r.record.rev;
    },
  });
  return res.record;
}

export async function setParent(app: AppState, rec: RecordFull, parent: string | null): Promise<RecordFull> {
  const old = rec.parent;
  const res = await api.save(rec.id, { baseRev: rec.rev, parent: parent ?? "" });
  const name = parent ? app.records.find((r) => r.id === parent)?.title ?? parent : null;
  let rev = res.record.rev;
  did({
    label: name ? `Moved inside ${name}` : "Moved to the top level",
    undo: async () => {
      rev = (await api.save(rec.id, { baseRev: rev, parent: old ?? "" })).record.rev;
    },
    redo: async () => {
      rev = (await api.save(rec.id, { baseRev: rev, parent: parent ?? "" })).record.rev;
    },
  });
  return res.record;
}

export async function deleteRecord(rec: { id: string; title: string }) {
  await api.remove(rec.id);
  did({
    label: `Deleted "${rec.title}"`,
    undo: async () => void (await api.restore(rec.id)),
    redo: async () => void (await api.remove(rec.id)),
  });
}

/** Simple `field=value` conditions in a where clause: values a new record in the view should start with. */
export function defaultsFrom(where: string | undefined, type: TypeInfo | undefined, thisId: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!where || !type) return out;
  for (const part of where.split(/\s*&&\s*/)) {
    const m = part.trim().match(/^([a-z_][a-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || part.includes("!=")) continue;
    const f = type.fields.find((x) => x.key === m[1]);
    const want = m[2].trim().replace(/^["']|["']$/g, "");
    if (!f || want === "") continue;
    if (want === "this") {
      if (thisId && f.kind === "link") out[f.key] = f.multiple ? [thisId] : thisId;
      continue;
    }
    if (f.kind === "select" && !(f.options ?? []).some((o) => o.toLowerCase() === want.toLowerCase())) continue;
    if (f.kind === "select") out[f.key] = (f.options ?? []).find((o) => o.toLowerCase() === want.toLowerCase());
    else if (f.kind === "checkbox") out[f.key] = want === "true";
    else if (f.kind === "multi_select") out[f.key] = [want];
    else if (f.kind !== "link") out[f.key] = want;
  }
  return out;
}

/** What "Move to <target>" means for a record: the link field(s) that point at the target's type, or nesting. */
export function moveOptions(app: AppState, rec: { type: string }, target: { id: string; type: string }) {
  const t = app.types.find((x) => x.key === rec.type);
  const links = (t?.fields ?? []).filter((f) => f.kind === "link" && (!f.target || f.target === target.type));
  return { links, canNest: true };
}
