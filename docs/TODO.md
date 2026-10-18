# Open questions: the task list

Everything still to decide, in one place. Tick an item when it's decided, and record the decision in the doc it points to (SPEC, LOCAL, …). The details behind each question stay in those docs.

## Next up

- [ ] **Explore: every device has its own Postgres, local-first with no account; team and multi-computer features are an optional layer.** (LOCAL §1a) Local store built Oct 18 (default, no account; 16/16 tests on both stores), plus `install.sh` / `surface setup`. Next: test on the Linux machine, the 10,000-record speed check, backups, then the sync layer.
- [ ] **Sync layer design:** change log and ordering, field-level merge, which copy is in charge, encrypted sync for private workspaces later.
- [ ] **Identity:** a local user with no account later joins a team or links a second computer; how records and history keep their author.

- [ ] **Offline edits in a shared workspace:** merge both edits automatically, or reject the stale edit and show the newer one? Merging needs a sync engine (dropped Oct 14). (LOCAL §10)
- [ ] **Local database:** confirm one database per computer for every local workspace (leaning). (LOCAL §10.3)
- [ ] **Local mode as the default** for new users, or a choice at install? (LOCAL §10.1)
- [ ] **Attachments:** sync pasted images and PDFs to Supabase Storage so teammates see them; size limits, previews. (SPEC §13.3)
- [ ] **cdb-os:** is the Notion import good enough to use, and what's missing (Tags, Documents, Special Inspections, files, assignees)? (`tools/notion-import/README.md`)

## Artifacts and sharing (Oct 17 direction)

- [ ] **Artifact record shape:** a type with the HTML (or file) as body or attachment, links to its source view and records, snapshot vs live flag. (SPEC §1 Artifacts)
- [ ] **Live artifacts outside the local server:** how a page opened by link reads and writes records (scoped token per share?), and script sandboxing.
- [ ] **CLI for agents:** `surface artifact add/list/open`, and a one-call data bundle for a view (records, fields, links) to build from.
- [ ] **A skill that teaches any agent** to make Surface artifacts, kept agent-neutral (plain CLI, no Claude-only features).
- [ ] **Share model:** what can be shared (workspace, folder, view, record ± children, artifact), to whom (member, guest, anyone with link), with what (see, comment, edit), expiry; enforced by row-level security. (SPEC §1 Sharing, §7a)
- [ ] **Where outside people open a share:** hosted web UI, or a plain hosted page per artifact?
- [ ] **CLI parity:** list what the web UI can do that the CLI can't, and close each gap.
- [ ] **Proof:** one real live artifact from cdb-os (Steiner procurement), made by an agent, shared with an outside person.

## Database and hosting

- [ ] Where sync mode is hosted long term: Surface-hosted Supabase, one project per team, or self-hosted. (SPEC §12.1)
- [ ] Where the local database lives: outside the checkout only, or optionally inside it. (LOCAL §10.2)
- [ ] Pricing: local free, sync paid? A business decision. (LOCAL §10.4)
- [ ] Mobile: sync mode with the hosted app? (LOCAL §10.5, SPEC §13.9)
- [ ] When to add live updates to the plugin and other surfaces (the app has them). (SPEC §12.2)

## Sharing and permissions

- [ ] Member roles in detail. (SPEC §7a)
- [ ] Member roles beyond owner/admin/editor/viewer, if any.

## Files

- [ ] Filename rule for duplicate titles, and filename churn on renames. (SPEC §5)
- [ ] Front matter key: `id` or `surface_id`.
- [ ] The `link:` layout when a record links to several parents.
- [ ] Reverse links in files (`linked_from:`), or leave them to Obsidian's backlinks pane?

## Views and pages

- [ ] How placed entries, generated entries, pins and personal sidebars are written in view files. (SPEC §5a)
- [ ] Exact syntax of view files and ` ```surface ` blocks; inline value syntax. (SPEC §5d)
- [ ] Remember Markdown table column types, and where? (SPEC §5c)
- [ ] The view system in detail: query language, formulas, rollups (the Notion import copied formula values as plain numbers). (SPEC §13.6)

## Types

- [ ] A fixed prefix for IDs (e.g. `s_`), or none. (SPEC §4)
- [ ] Where the plugin creates new records: the current folder or the type's folder. (SPEC §5a)

## Clients

- [ ] Obsidian plugin scope for a first version. (SPEC §12.14)
- [ ] The app's first screens and management flows; does `surface serve` start at login or on demand? (SPEC §9)
- [ ] Where user workflow skills live: `.agents/skills/` or a visible `Skills/` folder. (`AGENT-INTEGRATION.md`)

## Not designed yet

- [ ] Agents and surfaces: who made an outside edit, approvals, generated surfaces (reports, widgets, canvases), model choice and privacy. (SPEC §13.1)
- [ ] Search: full text, semantic search for agents. (SPEC §13.4)
- [ ] History, undo and trash beyond the app's undo. (SPEC §13.5)
- [ ] Templates, recurring items, reminders, notifications. (SPEC §13.7)
- [ ] Security: secrets in notes (the Steiner page holds site access codes), API tokens for agents. (SPEC §13.8)
- [ ] Performance targets and when a local index is needed. (SPEC §13.10)
- [ ] Onboarding: first run, starter content. (SPEC §13.11)

## Parked

- [ ] Importing existing vaults: in place or as a copy; huge vaults. (`IMPORT.md`)
