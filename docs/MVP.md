# Surface MVP: the foundation and its first Markdown surface

**Status: built Oct 14, 2026.** The MVP is a generic types engine on Supabase plus a TypeScript CLI. It implements the first and foundational surface: a Markdown checkout people and agents can read and edit. See [SPEC.md](SPEC.md) for the product direction and [the CLI guide](../cli/README.md) for usage.

The broader product is a headless, mutable database foundation with many surfaces. A dedicated app provides Obsidian-like writing and browsing with Bear/Margin visual polish, with team and type management planned. Reports, widgets, artifacts and external integrations are further possible surfaces. Those clients are not part of the MVP. A first version of the app was built after it (SPEC §9).

## What is built

```text
Supabase: types · records · relationships · saved views · history · permissions
        ⇅  surface CLI
Markdown checkout  ←  Obsidian, another editor, or an agent
```

- **Supabase is the truth.** Files are a checkout, with explicit pull/push and revision checks. There is no local database or automatic merge engine.
- **Types can evolve.** Create and edit types and fields without adding new database tables. Fields have permanent internal IDs, so renaming a key preserves its values.
- **Markdown is a working surface.** Read records, edit front matter and prose, or make a new page or task in Obsidian, then use the CLI to validate and push it.
- **Safe normalization is reported.** Unambiguous dates, option case, numbers and checkboxes are normalized. Invalid values and stale revisions are rejected.
- **Files and navigation are separate.** Type, flat, folder and `link:` layouts organize files. Saved YAML definitions describe navigation trees.
- **Agents have exact tools and readable guidance.** The CLI handles records, types, fields, queries, folders and trees; every pull generates instructions and schema copies.

Markdown comes first because it is a shared working language for LLMs and humans. Front matter carries typed values and relationships, while the body carries prose. The same foundation can later support surfaces that do not use files at all.

## What the MVP tests

1. Can people and agents define useful types and relationships without new tables or access rules for each type?
2. Does structured data stay trustworthy when people edit plain files?
3. Does the pull, edit, push workflow work well for humans and agents?
4. Are the files readable and useful in Obsidian and other editors?
5. Can file layouts, nesting and a query-driven navigation tree remain independent?

**Still to validate with real work:** the first sustained use case, such as material tracking or procurement. The MVP does not establish the dedicated app experience, team onboarding, live co-editing, or external surface integrations.

## Database

Migrations are in [`supabase/migrations/`](../supabase/migrations/). The current project is `surface` (`njzrcmzvubhexegbdoeh`, us-west-2).

| Table | Holds |
|---|---|
| `workspaces` | Shared workspace identity and name |
| `members` | Workspace membership: owner, admin, member, viewer |
| `types` | User-defined types and JSON field definitions with permanent field IDs |
| `records` | Type, title, values keyed by field ID, body, folder, parent, revision, authorship and soft deletion |
| `links` | Relationships maintained from link fields |
| `history` | Record revisions, operations and attribution, written by a trigger |
| `views` | Saved definitions, including the sidebar tree, with revision numbers |

Row-level security protects the shared tables. Triggers validate writes and maintain revisions, history and links. `push_record` maps field keys to IDs and checks the caller's base revision; `save_view` checks saved-view revisions. Schema changes can leave older values that need attention; `surface check` reports those values rather than silently rewriting them.

## CLI

| Command | Does |
|---|---|
| `surface signup` / `login` | Sign up or sign in with email and password |
| `surface init <dir> --create "Workspace"` | Create a workspace with its built-in page type and check it out |
| `surface type …` / `field …` | Create and edit types and field definitions |
| `surface pull` / `push [files]` | Database to files / file edits to database |
| `surface push --new` | Import new Markdown files; type defaults to page |
| `surface status` / `diff` / `check` | Inspect changes and validate without writing to the database |
| `surface new <type> "Title" field=value` | Create a record |
| `surface set <record> field=value` | Update a record |
| `surface query [type] --where "key=value"` | Query records, optionally as JSON |
| `surface layout` / `mv` / `folder rename` / `folders` | Inspect and change file organization |
| `surface tree` / `views` | Work with saved navigation trees and list saved views |
| `surface rm` / `restore` / `history` | Soft-delete, restore and inspect record history |
| `surface skills` | Regenerate checkout guidance and schema copies |

The CLI runs TypeScript source directly on Node 23.6 or newer; it is not compiled to a standalone binary.

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

Records have stable IDs. Filenames are readable and unique within a checkout, with a short ID suffix when needed; titles can repeat. Link fields render as quoted wikilinks and resolve back to record IDs on push. The database maintains reverse relationships; the checkout writes the stored side.

## Verification and next work

[`cli/test/e2e.ts`](../cli/test/e2e.ts) defines 15 end-to-end scenarios against the real Supabase project. Run `npm test` from `cli/` with the test account configured. It creates and deletes a temporary test workspace.

Next work and unresolved release ordering are recorded in [SPEC §14](SPEC.md#14-build-plan). The Markdown workflow establishes the foundation; the dedicated app and other surfaces build on it.
