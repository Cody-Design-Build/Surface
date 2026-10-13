# Surface Spec

The current design in one place. Last consolidated: Oct 13, 2026.

- **How we got here:** the working notes in `docs/notes/` (DATA-MODEL, CONVENTIONS, SYNC), kept as design history.
- **Research:** `docs/research/`.
- **Parked:** importing existing vaults (`docs/IMPORT.md`).

Status markers: **Decided**, **Leaning** (direction agreed, details open), **Open**.

---

## 1. Thesis

Apps and SaaS aren't the future. People need three things:

1. **Data:** storage and persistence, editable by many people, like any app.
2. **Agents:** they replace much of the app. Like a real assistant, an agent works with the data and acts on it.
3. **Surfaces:** the human interface. Fluid and often temporary, much like Notion. A surface can be the Surface app, a Markdown file, or a view an agent builds on request (like Claude's dashboards) showing live data.

## 2. Principles

1. **Data is the foundation.** The surface is just where a human touches it.
2. **Local-first.** Your workspace lives on your device, works offline, and needs no account. The cloud is optional, for teams.
3. **Files are first-class.** Every record is also a plain Markdown file. People and agents can edit those files in any editor, even when Surface is closed. They're also the exit: your data is always readable without Surface.
4. **Surface is the tool; other editors are welcome guests.** Obsidian and any Markdown editor can read and edit the files, but compatibility is best effort, not a design constraint.
5. **Flag, don't silently fix.** When outside changes can't be merged safely, or drift from the schema, Surface flags them and a person or agent chooses what happens. Surface never quietly rewrites or discards someone's edit.
6. **Agents are users.** Their edits travel the same paths as a person's, and get the same merging, history and permissions.

## 3. Architecture: three layers, with Surface as the manager

**Decided.** Surface works like a git client that merges continuously on its own:

| Layer | Git equivalent | Role |
|---|---|---|
| **Markdown files** on disk | working copy | where people, editors and agents edit freely |
| **Local database** on the device | local repository | the device's source of truth: records, full change history, and the last-seen version of every file |
| **Sync server** (optional) | remote | shared history between devices and team members |

- **Solo workspace (decided):** files plus the local database. No network, no account. The local database is the source of truth.
- **Team workspace (decided):** the same, plus sync. Every device keeps a full local copy, works offline, and merges when it reconnects.
- **Same app, same data model.** Sync is a switch per workspace. Personal and team workspaces sit side by side.
- **Moving between modes (decided):** solo to team means turning on sync and uploading. Leaving a team means your local copy stays yours.

## 4. The record

**Decided: a record is a page.**

```
Record
  id       permanent, never changes; links point here
  fields   typed values (text, number, date, choice, link, list...)
  body     optional flat Markdown (one string, not blocks)
```

- **`title` is just a field.** It's what Surface displays, and it can repeat (every job has an "Order cabinets" task).
- **Rule of thumb:** if something needs fields, it's a record of its own, linked or embedded. Simple to-dos in a body stay as `- [ ]`.
- **A record's type never changes.** Turning a task into an issue is a migration: a new ID, with every link rewritten.

### IDs

**Decided.**

- **Format:** `{prefix}_{time}{random}`, all lowercase Crockford base32. Example: `task_0q8z4mkr7f2c`.
  - 7 characters of creation time (seconds, good for about 1,000 years) plus 5 random characters (about 33 million per second).
  - IDs sort by creation time, and can be made offline on any device with no realistic chance of collision.
- **The prefix is the type.** It's a short, stable code set in the type's schema (`prefix: task`), separate from the display name. Renaming "Tasks" to "To-dos" changes no IDs.
- **Type is derived from the ID.** There's no separate `type:` field.

### Types and schemas

**Decided.**

- **One schema per type**, defining its fields, types, options, defaults and ID prefix.
- **Schemas are data too:** stored in the database, synced like records, and mirrored as readable YAML in `.surface/types/`.

```yaml
# .surface/types/task.yaml
name: Task
prefix: task
fields:
  title:    { type: text, required: true }
  status:   { type: choice, options: [todo, doing, done], default: todo }
  due:      { type: date }
  assignee: { type: link, to: person }
  estimate: { type: number, unit: hours }
  tags:     { type: list, of: text }
```

- **Fields not in the schema are kept and flagged** with *"add it to the schema, or remove it?"*
- **Schema changes are migrations.** Renaming a field or an option updates every record in one operation.
- **Computed fields are never stored as input.** Rollups and formulas are computed at view time.

## 5. The Markdown files

### Layout

**Decided:** Surface controls filenames, so they're readable and work well in Finder and Obsidian.

- **Readable filenames,** kept unique by a stable rule, e.g. `Order cabinets (2243 Steiner).md`.
- **Readable wikilinks** that are always correct: `[[Order cabinets (2243 Steiner)]]`. Renaming a record in Surface renames its file and rewrites every link to it.
- **Each person's files contain only what they're allowed to see.**

**Folders: see §5a.** They're the user's own organization, not generated by Surface.

**Open:**

- **The naming rule:** always qualify types prone to duplicates (every task includes its job), or qualify only the newcomer? Existing files should never be renamed just because a duplicate appeared.
- **Filename churn:** a title change renames the file. That's fine in Obsidian, but noisy in git and breaks outside bookmarks.

> **Superseded (Oct 12–13):**
> - ID-as-filename (`task_0q8z….md`) and "files can live in any folder, moves never flagged": both made sense while files were the source of truth.
> - "Meaningful folders generated from relationships" (`Jobs/2243 Steiner/Tasks/`): replaced by folders as the user's own organization (§5a).

### Front matter

- **Reserved keys:**
  - `id`: the record ID; ties the file to its database record. **Open:** use a namespaced key such as `surface_id` to avoid clashing with vaults that already use `id` (see IMPORT).
  - `title`.
  - `aliases`, `tags`: Obsidian's conventions, reused as-is.
- **Every other key** is a schema field.
- **Plain YAML scalars and lists only.** Links are quoted wikilinks (`assignee: "[[Jane Doe]]"`). No Surface-only syntax.
- **Canonical layout** when Surface writes a file: one field per line, in schema order, so edits to different fields touch different lines.

### Body conventions

Everything degrades gracefully: it's readable in any text editor, renders in any Markdown editor, and is native in Obsidian.

| Need | Convention |
|---|---|
| Callouts | GitHub-style alerts: `> [!NOTE]` |
| To-dos | GFM `- [ ]` |
| Link to a heading | `[[Note#Heading]]` |
| Link to a paragraph | Obsidian `^block-id`, added only when something links to it |
| Live record view in a page | ` ```surface ` fenced block containing a query (like Obsidian's ` ```base `) |
| Comments, presence | in Surface's database, never inside the file |

## 5a. Organizing: views, not folders (and folders if you like)

### The sidebar is views

**Decided.** Unlike Obsidian, Bear and Margin, Surface's sidebar is not a folder tree. It's a set of views over the records.

- A **Tasks** section twirls down to as many saved views as you like: "Due this week", "By job", "Waiting on others", "Done". Each view is a filter, a sort and a layout (list, table, board, calendar).
- The same record can appear in many views. Where its file sits on disk doesn't matter to any of them.
- **Notes are no longer locked into folders, but they're still Markdown files on your disk,** and nobody has to use the sync service.
- **Views are data:** saved in the workspace, synced in teams, and written as files so they escape too (see `docs/OBSIDIAN.md`). Proposal: view files use Obsidian Bases syntax.

### Folders alongside types

**Leaning.** Some note-takers think in folders: Zettelkasten, atomic notes, or old-fashioned filing. That's also part of the escape hatch. So folders are allowed as a second, optional way to organize:

- **Folders are the user's, not Surface's.** Surface never invents folders or moves files on its own. New records go where you create them, or into the type's default folder.
- **The sidebar shows the real folder tree** in its own "Folders" section, beside the type views. You can create folders, and drag notes into them, in Surface, Finder or Obsidian.
- **A record's folder is just another attribute.** Views can use it ("tasks in Projects/Kitchen"). Typed records can live in any folder.
- **Moving a file is an ordinary change,** not a flag. It's recorded and synced like any edit. *(This changes the earlier "renames and moves are flagged" decision for moves.)*
- **Untyped notes are first-class.** A plain note needs no type and no fields: just a title, a body, links and tags. Zettelkasten and atomic-note users can live entirely in folders, notes and links.

**Open:**

- **Renames in Finder or Obsidian:** treat a filename change as a title change (natural for folder users), or keep flagging it?
- **Team folders:** is the folder tree shared by the whole team (it lives in the files, so yes by default), or personal per person?

## 6. Keeping files and the database in step

**Decided.**

- **Surface stores a base version.** For every record, the database keeps the exact file contents it last wrote or read.
- **It checks on startup and live.** Surface scans the files when it starts, and a file watcher catches changes while it runs.
- **It compares three versions** for any changed file: the base, the file now, and the database now (which may include teammates' changes).
  - **Front matter merges field by field.** A field changed in only one place is applied automatically.
  - **The body merges as text.** The outside edit is applied as an ordinary text edit, so it combines with teammates' edits.
- **A merged change is an ordinary change.** It's recorded in history and synced like any edit made in Surface.

### Flags (the "needs attention" view)

Like `git status` plus merge conflicts:

| Situation | What Surface does |
|---|---|
| New file without an ID | Flags *new note*; asks whether to import it (and as which type) or ignore it |
| File deleted outside Surface | Flags it; asks whether to allow the deletion or restore the file |
| File renamed outside Surface | Flags it (leaning: treat as a title change instead; §5a) |
| File moved to another folder | Ordinary change, synced (leaning; §5a) |
| Broken or invalid YAML | Flags it; keeps the database values until it's resolved |
| The same field changed in the file and the database | Flags a conflict |
| Values that drift from the schema | Reads them leniently for display, and flags them (see below) |
| A field not in the schema | Keeps it and flags it |

**Reading drift leniently** (flagged as a notice or a warning, never rewritten):

- `due: Oct 12` reads as `2026-10-12`;
- `status: Done` reads as `done`;
- a choice typo like `dnoe` is flagged with a suggested fix;
- `cost: $1,200` reads as `1200`.

A fix is applied only when someone accepts it. A bulk "fix all safe notices" exists, but only when someone runs it.

## 7. Sync and multi-user editing

### The feel

**Target:** like Notion desktop, or Anytype's new app AnyTwo.

- Others' edits appear within about a second, with no save button.
- Offline edits merge automatically on reconnect.
- You can see who else is on a page.

### How merging works

**Leaning.** Every device merges as an equal (CRDTs).

- Every device arrives at the same result on its own; no server decides the order.
- **The sync server stores and relays every change.** It's always on, so people don't need to be online at the same time.
- **It enforces permissions:** it relays writes only from members allowed to write, and sends each member only what they may read.
- **Fields** merge one by one. **Target:** detect two people changing the same field at once, and flag it rather than silently picking a winner (Notion's weakness).
- **Body text** merges automatically, using a text CRDT.

### Built sync-ready from day one

**Decided.** Globally unique IDs, every change recorded as a small operation, field-level changes, and mergeable body text. Turning on sync later just means sending the history.

### Technology

**Open, research done** (`docs/research/SYNC-TECH.md`). Recommendation, ranked:

1. **Automerge 3 + automerge-repo,** with a small self-hosted relay.
   - It's the only option that keeps the losing value when two people edit the same field (`getConflicts`), so Surface can flag it. Verified in the Automerge docs.
   - `changeAt` applies a file edit "as of" the last-written version and lets the CRDT merge it. That's our three-way reconcile, built in.
   - MIT licence, Rust core, full history.
2. **Loro.** The best text handling, with line-based diffs suited to Markdown and agent edits. But fields are last-writer-wins with no conflict API, and there's less sync infrastructure ready-made.
3. **Yjs + Hocuspocus.** Battle-tested, but weak on history and on field conflicts.

**Ruled out:**

- The server decides, not the devices: Zero, PowerSync, ElectricSQL, InstantDB, Turso.
- Stalled: cr-sqlite (last release Jan 2024) and Triplit.
- Not open source or not ready: any-sync, Jazz 2.0, DXOS, Ditto.

**Applies to any choice:**

- One CRDT document per record, so the relay can grant or block access per record.
- SQLite holds the CRDT data as the truth, plus query tables rebuilt from it.

**Next step:** a one-week spike. 20,000 records, the Markdown reconcile, offline team sync through a relay, and per-record permissions; Automerge first, then Loro.

### Considered and set aside

- **GitHub as the source of truth (push and pull):** history, accounts and no server, but at best 5–15 seconds behind. Other limits: per-repo permissions, a 100 MB file limit, and every user needs a GitHub account. It could still serve as an optional backup or export target.
- **Dropbox / iCloud / Syncthing:** whole-file sync with conflict copies and no merging.
- **The cloud as the only truth (Notion-style):** offline is partial.

## 8. The `.surface/` folder

**Decided.** A hidden folder at the workspace root, beside `.obsidian/`. Hidden in Finder (Cmd+Shift+. shows it) and not listed in Obsidian.

```
.surface/
  types/        schema files (mirrored from the database)
  settings      workspace settings
  comments/     comment threads (if mirrored to files)
  local/        the local database, cache, base versions (this device only, never synced as files)
```

**Open:** should the local database live inside the workspace (`.surface/local/`) or in the app's own data folder? It must never be synced by Dropbox or iCloud, and it must survive the workspace being moved.

## 9. The app

**Open, research done** (`docs/research/APP-TECH.md`). Recommendation:

- **App shell: Tauri 2,** a Rust core with a web interface, with Mac polish as its own workstream from day one.
  - **Margin is built exactly this way** (Tauri v2 + CodeMirror 6; verified in its author's post on the CodeMirror forum).
  - Fallback: a native Swift shell around the same Rust core, if the web interface isn't "Bear enough."
- **Editor: CodeMirror 6** with an Obsidian-style live preview. It edits the text itself, so files save exactly as written. It has collaborative-editing plugins for Automerge, Loro and Yjs. ProseMirror-based editors (TipTap, BlockNote) change Markdown on save.
- **Views:** TanStack Table and TanStack Virtual for tables, dnd-kit for boards, Schedule-X or FullCalendar for calendars.
- **Query language:** a small YAML format modelled on Obsidian Bases, turned into SQL, plus read-only SQL for agents and power users.
- **Agents:** one Rust core with three ways in:
  - the Markdown files;
  - a `surface` command-line tool;
  - a local MCP server, restricted to this machine and protected by a token.

  Agent-built views run sandboxed, following the MCP Apps standard.
- **First milestone:** solo workspaces on Mac only.
  - the editor;
  - file watching with three-way merge, and the flags view;
  - table and board views;
  - ` ```surface ` blocks;
  - the CLI and the MCP server;
  - baseline Mac polish.

### Visual style

**Leaning.** Inspired by **Bear** and **Margin**: native Mac feel, typography-led, one sparing accent colour, live preview with no toolbar, calm even for structured data. See `docs/DESIGN.md`.

## 10. Agents

**Leaning.**

- **Agents can just edit the files,** with or without Surface running. Changes are reconciled like any outside edit.
- **When Surface is running,** agents can also use the live path (an MCP server or CLI), getting instant sync, validation and permissions.
- **Agents never rewrite whole files.** They make field edits and section-level patches through the same merge path as people.

## 11. Business model

**Leaning.** A free local app, plus a paid sync service (the Obsidian and Anytype model). The billable parts are sync and agent labor. Self-hosting the sync server is an option for teams.

## 12. Open questions

**Sync and hosting**

1. The sync technology: Automerge (recommended) or Loro; decide after the spike.
2. Who runs the sync server: a hosted Surface service, self-hosted, or both?
3. Same-network peer-to-peer (Anytype-style), or always through the server?

**Sharing and permissions**

4. Can everyone in a workspace see everything? Or are there per-record permissions?
5. Guests: can a client or sub see a single job without receiving the whole workspace?

**Feel**

6. Live cursors, or just presence?

**Files**

7. The filename naming rule, and filename churn (section 5).
8. The front matter key: `id` or `surface_id`.
9. Where the local database lives (section 8).

**App**

10. The shell: is about 95% of Bear's look acceptable (Tauri), or are a real native toolbar and controls required (Swift shell)? Also confirm the editor, views and MVP scope.

**Organizing and Obsidian**

11. Folders alongside types: confirm moves are ordinary changes, and decide on rename handling (§5a).
12. View files in Obsidian Bases syntax, and where they live (`docs/OBSIDIAN.md`).

**Parked**

13. Importing existing vaults: in place or as a copy, huge vaults, the path-generation principle (`docs/IMPORT.md`).
