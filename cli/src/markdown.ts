// Records ⇄ Markdown files.
import crypto from "node:crypto";
import YAML from "yaml";
import type { RecordRow, TypeRow } from "./db.ts";
import type { Layout } from "./config.ts";

export const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

const BUILTIN_KEYS = ["id", "type", "rev", "title", "parent"];

/** Characters that break filenames or Obsidian links. */
export function safeName(title: string): string {
  const s = title
    .replace(/[\/\\:*?"<>|#^\[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s]+$/g, "")
    .slice(0, 120);
  return s || "Untitled";
}

const safeFolder = (f: string) =>
  f.split("/").map((p) => safeName(p)).filter((p) => p && p !== "Untitled").join("/");

/** Decide a path for every record. Basenames are unique across the whole checkout,
 *  so `[[Basename]]` always resolves in Obsidian.
 *  Layouts: "type" (a folder per type), "folder" (the record's own folder), "flat",
 *  or "link:<field>[,<field>]": under the record it links to, e.g. link:project puts
 *  a task in `Projects/Steiner Kitchen/Tasks/`, and link:parent nests pages in pages. */
export function planPaths(records: RecordRow[], types: Map<string, TypeRow>, layout: Layout): Map<string, string> {
  const out = new Map<string, string>();
  const bases = new Map<string, string>();
  const taken = new Map<string, string>(); // lowercased basename -> record id
  // stable order: oldest first keeps the plain name
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  for (const r of sorted) {
    let base = safeName(r.title);
    if (taken.has(base.toLowerCase())) base = `${base} (${r.id.slice(-5)})`;
    taken.set(base.toLowerCase(), r.id);
    bases.set(r.id, base);
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const typeDir = (t: TypeRow) => safeFolder(t.folder || t.name);
  const linkKeys = layout.startsWith("link:") ? layout.slice(5).split(",") : null;

  /** The record this one is filed under in a link layout, if it's in the checkout. */
  const anchor = (r: RecordRow): RecordRow | null => {
    if (!linkKeys) return null;
    const t = types.get(r.type_id)!;
    for (const key of linkKeys) {
      let id: unknown = null;
      if (key === "parent") id = r.parent_id;
      else {
        const f = t.fields.find((f) => f.key === key && f.kind === "link");
        const v = f ? r.fields[f.id] : null;
        id = Array.isArray(v) ? v[0] : v;
      }
      if (typeof id === "string" && id !== r.id && byId.has(id)) return byId.get(id)!;
    }
    return null;
  };

  const dirs = new Map<string, string>();
  const dirOf = (r: RecordRow, visiting: Set<string>): string => {
    if (dirs.has(r.id)) return dirs.get(r.id)!;
    const t = types.get(r.type_id)!;
    let dir = "";
    if (layout === "type") dir = typeDir(t);
    else if (layout === "folder") dir = r.folder != null ? safeFolder(r.folder) : typeDir(t);
    else if (linkKeys) {
      const up = anchor(r);
      if (up && !visiting.has(up.id) && visiting.size < 20) {
        visiting.add(r.id);
        const upDir = dirOf(up, visiting);
        visiting.delete(r.id);
        const own = `${upDir ? upDir + "/" : ""}${bases.get(up.id)}`;
        dir = up.type_id === r.type_id ? own : `${own}/${typeDir(t)}`;
      } else dir = typeDir(t);
    }
    dirs.set(r.id, dir);
    return dir;
  };

  for (const r of sorted) {
    const dir = dirOf(r, new Set([r.id]));
    const base = bases.get(r.id)!;
    out.set(r.id, dir ? `${dir}/${base}.md` : `${base}.md`);
  }
  return out;
}

export function basename(p: string) {
  return p.replace(/^.*\//, "").replace(/\.md$/i, "");
}

/** Render a record as Markdown. `linkName` maps a record id to the name to show in [[…]]. */
export function render(r: RecordRow, t: TypeRow, linkName: (id: string) => string): string {
  const fm: Record<string, unknown> = { id: r.id, type: t.key, rev: r.rev, title: r.title };
  if (r.parent_id) fm.parent = `[[${linkName(r.parent_id)}]]`;
  for (const f of t.fields) {
    let v = r.fields[f.id];
    if (v === undefined) v = null;
    if (f.kind === "link" && v !== null) {
      const ids = Array.isArray(v) ? (v as string[]) : [v as string];
      const names = ids.map((id) => `[[${linkName(id)}]]`);
      v = f.multiple ? names : names[0];
    }
    fm[f.key] = v;
  }
  const doc = new YAML.Document(fm);
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && node.value.startsWith("[[")) node.type = "QUOTE_DOUBLE";
    },
  });
  const yaml = doc.toString({ lineWidth: 0, nullStr: "" });
  const body = canonBody(r.body ?? "");
  return `---\n${yaml}---\n${body ? "\n" + body + "\n" : ""}`;
}

/** Bodies are stored without trailing whitespace, so files round-trip byte for byte. */
export const canonBody = (b: string) => b.replace(/\r\n/g, "\n").replace(/\s+$/, "");

export interface ParsedFile {
  frontmatter: Record<string, unknown> | null;
  body: string;
  error?: string;
}

export function parse(text: string): ParsedFile {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/);
  if (!m) return { frontmatter: null, body: canonBody(text) };
  let body = text.slice(m[0].length).replace(/^\r?\n/, "");
  body = canonBody(body);
  try {
    const fm = YAML.parse(m[1], { schema: "core" }) ?? {};
    if (typeof fm !== "object" || Array.isArray(fm)) return { frontmatter: null, body, error: "front matter isn't a set of fields" };
    return { frontmatter: fm as Record<string, unknown>, body };
  } catch (e) {
    return { frontmatter: null, body, error: `broken YAML: ${(e as Error).message.split("\n")[0]}` };
  }
}

export const isBuiltinKey = (k: string) => BUILTIN_KEYS.includes(k);
