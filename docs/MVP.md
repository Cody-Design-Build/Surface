# Surface MVP: a types engine on Supabase, plus a CLI, used from Obsidian

**Status:** proposed (Oct 13). The smallest version of Surface that can be tested immediately. `SPEC.md` stays the long-term design. This is stage 1 of it, with Obsidian standing in for the app.

## What it is

```
Supabase (Postgres): types · records · links · history
        ⇅  surface CLI  (pull · push · new · set · query · check)
Markdown checkout in a folder  ←  Obsidian (reading, Bases views, editing) and agents
```

- **No app, no local database, no sync engine.** Supabase is the truth, and the folder is a checkout.
- **Obsidian is the UI:**
  - its Bases provide the views, and work well because the generated front matter is clean and typed;
  - editing a file and then running `surface push` (or an agent doing it) writes changes back.
- **Agents** use the CLI plus a generated `AGENTS.md` and skills.

## What it tests

1. **Does a generic types engine remove the "new table for every type" pain?** Create a type and its relationships in minutes, with no migrations and no new access rules.
2. **Does structured data stay clean** when people and agents edit through Obsidian, with validation on push?
3. **Does the pull, edit, push loop feel OK** for you and for agents?
4. **Does the file format work in Obsidian:** links, Bases and readable files?

**Not tested yet:** the team experience for non-technical people (that needs the web app, step 2), live co-editing, offline-first use.

## Database (sketch)

| Table | Holds |
|---|---|
| `workspaces` | id, name |
| `members` | workspace, user, role (roles flagged for later discussion) |
| `types` | id, workspace, key (`task`), name, icon, default folder, `fields` (JSON list: field id, key, label, kind, choice options, link target type, required) |
| `records` | id (time-sortable), workspace, type, title, `fields` (JSON keyed by **field id**), body (Markdown), `rev`, folder, created/updated by and at, deleted_at |
| `links` | record, field, target: maintained from link fields, for backlinks and two-way relations |
| `history` | record, rev, fields, body, who, when: written by a trigger |

- **Access rules written once:** "member of this workspace" to read, and a role to write, on every table. No new rules per type.
- **Server-side checks:** a `push_record(id, base_rev, fields, body)` function validates against the type, checks the revision, and applies the change atomically, or rejects it with a reason.
- **Renaming a field** is a change to the type only (records are keyed by field id). The next pull rewrites the files.

## CLI (sketch)

| Command | Does |
|---|---|
| `surface login` | Supabase sign-in (email link) |
| `surface init <folder>` | Connect a folder to a workspace and choose a layout |
| `surface pull [--layout project\|type\|flat] [--only <project>]` | Write records as Markdown (each record once) |
| `surface push [files]` | Validate, check revisions, apply; show anything rejected |
| `surface status` | Unpushed edits, rejected files, open flags |
| `surface new <type> "Title" [--field value]` | Create a record, then pull it |
| `surface set <record> field=value` | Edit a field directly |
| `surface query "<filter>"` | Search records (for agents) |
| `surface types` | List, add and edit types and fields |
| `surface check` | Validate the checkout without pushing |
| `surface skills` | Regenerate `AGENTS.md` and `.agents/skills/` from the types |

**Built in TypeScript with `supabase-js`,** compiled to a single binary.

## File format

```markdown
---
id: 0q8z4mkr7f2c
type: task
rev: 7
title: Order cabinets
status: doing
due: 2026-10-20
project: "[[Kitchen Remodel (2243 Steiner)]]"
---
Notes go here.
```

- **Links are written by title,** and resolved back to IDs on push. Titles are unique within a checkout, as filenames.
- **Two-way links:** only the stored side is written (`OBSIDIAN.md`). The reverse appears through Obsidian's backlinks and Bases.

## Plan

1. **A new, separate Supabase project.** Not BuildBase's.
2. **Schema and access rules, plus `push_record`.** A few days.
3. **CLI:** login, init, pull, push, status, new, set. About a week.
4. **types, query, check, skills.** A few days.
5. **Try it on one real use case,** for example Steiner material tracking or procurement, alongside Notion, not replacing it.

**Timebox: about 2 to 3 weeks of spare time.** Then decide: keep going (step 2 is a simple web app for the team on the same database), adjust, or stop.

## Open

1. Which real use case to test with first?
2. Validation strictness on push: reject invalid values, or accept and flag?
3. Is the CLI's language TypeScript (fits your Next/Supabase stack) or something else?
