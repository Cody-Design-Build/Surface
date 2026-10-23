// Files that teach agents how this checkout works: AGENTS.md, a Surface skill,
// and a readable copy of every type in .surface/types/.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Checkout } from "./config.ts";
import type { TypeRow } from "./db.ts";

function describeField(f: TypeRow["fields"][number], types: TypeRow[]): string {
  let kind: string = f.kind;
  if (f.kind === "phone") kind += ": E.164 entries [{number, label?, extension?}]; CLI also accepts formatted US/Canadian numbers or +country-code numbers, one labeled number per line";
  if (f.kind === "select" || f.kind === "multi_select") kind += ` (${(f.options ?? []).join(", ")})`;
  if (f.kind === "link") {
    const t = types.find((t) => t.id === f.target);
    kind += ` → ${t ? t.key : "any type"}${f.multiple ? ", several" : ""}`;
    if (f.inverse) kind += `, computed inverse of ${t?.fields.find(x => x.id === f.inverse)?.key ?? f.inverse}; edit with surface set, not Markdown`;
  }
  return `\`${f.key}\`: ${kind}${f.required ? ", required" : ""}`;
}

function typesSection(types: TypeRow[]): string {
  return types
    .map((t) => {
      const fields = t.fields.length ? t.fields.map((f) => `  - ${describeField(f, types)}`).join("\n") : "  - (title and body only)";
      return `- **${t.key}** (${t.name}), folder \`${t.folder ?? t.name}\`\n${fields}`;
    })
    .join("\n");
}

const SKILL = (types: TypeRow[], layout: string) => `---
name: surface
description: Use when reading or changing records in this Surface checkout (Markdown files backed by the Surface database).
---

# Working in a Surface checkout

The Markdown files here are a **checkout** of a Surface workspace. The database is the source of truth.
Every file is one record: front matter = typed fields, body = notes.

## Rules

1. **Prefer the CLI** for changes: \`surface new\`, \`surface set\`, \`surface rm\`. It validates and records who changed what.
2. If you edit a file, change only the fields and text you mean to, keep \`id\`, \`type\` and \`rev\`, then run \`surface push\`.
   Unpushed edits can be overwritten by the next \`surface pull --force\`.
3. \`surface push\` normalizes safe fixes (dates, option case, numbers) and reports them; it **rejects** invalid values
   and **conflicts** (the record changed since your file's \`rev\`). On a conflict: \`surface pull\`, redo the edit, push again.
4. New files: give them front matter with \`type:\` and \`title:\` (no \`id\`), then \`surface push --new\`.
5. Links between records are \`"[[File Name]]"\` in front matter. Filenames are unique in the checkout.
6. Never invent fields. To add one: \`surface field add <type> <key> --kind <kind>\`.
7. Don't edit \`.surface/\` except \`.surface/views/*.yaml\` (saved views; push them like records).
   Types are readable in \`.surface/types/\` but are changed only with \`surface type …\` / \`surface field …\`.
8. Every record can have one \`parent\` (\`parent: "[[Page]]"\`): Notion-style nesting. It never moves the file.

## Files, folders and views

- **Files are storage.** Each record is one file in one folder. This checkout's layout: \`${layout}\`
  (\`surface layout\` shows or changes it: type, folder, flat, link:<field>).
- **Folders** (folder layout) are the record's \`folder\` value: \`surface mv <record> <folder>\`, \`surface folder rename\`, \`surface folders\`.
- **The Views tree is navigation** (\`surface tree\`), defined in \`.surface/views/sidebar.yaml\`:
  \`group\` (virtual folder), \`record\` (one record and its nested pages), \`query\` (\`from\`, \`where\`, \`sort\`, \`label\`, and \`each\` for
  children of every match, where \`this\` = that match). Check with \`surface tree check\`, then \`surface push\`.

## Useful commands

| Command | Does |
|---|---|
| \`surface status\` | Edited, new, missing, and changed-in-Surface files |
| \`surface check\` | Validate files without pushing |
| \`surface pull\` / \`surface push\` | Database → files / files → database |
| \`surface query <type> --where key=value --json\` | Find records |
| \`surface show <id or name>\` | One record |
| \`surface new <type> "Title" key=value …\` | Create a record |
| \`surface set <id or name> key=value …\` | Change fields |
| \`surface types\` / \`surface type show <key>\` | The schema |
| \`surface new page "Title" --parent "Other page"\` | Nest a page inside another |
| \`surface tree --paths\` | The Views tree, with file paths |

## Types in this workspace

${typesSection(types)}
`;

const AGENTS = (co: Checkout, types: TypeRow[]) => `# AGENTS.md

This folder is a **Surface checkout** of the workspace "${co.config.workspaceName ?? co.config.workspace}".
Records are Markdown files with typed front matter; the Surface database is the source of truth.

Read \`.agents/skills/surface/SKILL.md\` before changing anything. In short: use the \`surface\` CLI,
or edit files and run \`surface push\`. Never edit \`.surface/\`.

Types: ${types.map((t) => `\`${t.key}\``).join(", ")}. Run \`surface types\` for fields.

<!-- Generated by \`surface skills\`; regenerated on every pull. Add your own notes in a separate file. -->
`;

export function writeAgentFiles(co: Checkout, types: TypeRow[]) {
  const put = (rel: string, text: string) => {
    const abs = path.join(co.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== text) fs.writeFileSync(abs, text);
  };
  put("AGENTS.md", AGENTS(co, types));
  const skill = SKILL(types, co.config.layout);
  put(".agents/skills/surface/SKILL.md", skill);
  put(".claude/skills/surface/SKILL.md", skill); // Claude Code reads .claude/skills, not .agents/skills

  const dir = path.join(co.root, ".surface", "types");
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();
  for (const t of types) {
    const file = `${t.key}.yaml`;
    keep.add(file);
    const doc = {
      key: t.key,
      name: t.name,
      folder: t.folder,
      builtin: t.is_builtin,
      fields: t.fields.map((f) => ({
        key: f.key,
        name: f.name,
        kind: f.kind,
        ...(f.options ? { options: f.options } : {}),
        ...(f.kind === "link" ? { target: types.find((x) => x.id === f.target)?.key ?? null, multiple: !!f.multiple } : {}),
        ...(f.inverse ? { inverse: f.inverse } : {}),
        ...(f.required ? { required: true } : {}),
        id: f.id,
      })),
    };
    put(path.join(".surface", "types", file), "# Read-only copy. Change types with `surface type …` and `surface field …`.\n" + YAML.stringify(doc));
  }
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f));
}
