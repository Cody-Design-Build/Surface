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
3. **Files are first-class.** Every record is also a plain Markdown file. People and agents can edit those files in any editor, even when Surface is closed. They're also the exit: your data is always readable without Surface. **Files are real Markdown that looks good in any text editor:** no hidden IDs in the body, no HTML, no custom layout syntax. Block-style editing is a UI feature (§5b).
4. **Surface is the tool; other editors are welcome guests.** Obsidian and any Markdown editor can read and edit the files, but compatibility is best effort, not a design constraint.
5. **Flag, don't silently fix.** When outside changes can't be merged safely, or drift from the schema, Surface flags them and a person or agent chooses what happens. Surface never quietly rewrites or discards someone's edit.
6. **Agents are users.** Their edits travel the same paths as a person's, and get the same merging, history and permissions.

## 2a. No lock-in

**Decided (principle).** This is a big part of why Obsidian is popular: your notes are yours, and you can leave any time. Surface must feel the same. It isn't about Obsidian. It's about people knowing there's no vendor lock-in. Obsidian, or any other notes app, is always an option if you want to leave.

### The rule

**Everything a person or agent authors exists in open, readable files at all times. The database adds speed, history and collaboration, but it never holds the only copy of anything you wrote.**

Every feature is designed into one of three tiers:

| Tier | What | Where | If Surface disappeared |
|---|---|---|---|
| **1. In the note** | fields, body, links, tags, to-dos, callouts, heading and paragraph links | the `.md` file: YAML front matter plus Markdown | Works in any Markdown app; native in Obsidian |
| **2. In a readable side file** | type schemas, saved views, comments, workspace settings | plain YAML or Markdown files in the workspace | Readable in any editor; views can also be written as Obsidian `.base` files |
| **3. Computed or temporary** | the search index, rollups, backlinks, presence, sync state, merge internals | the local database only | Nothing authored is lost; all of it can be rebuilt from tiers 1 and 2 |

**Not allowed:** authored data that exists only in the database, or only in a format nobody else can read.

The tier 3 exception is **history** (who changed what, and when). It's valuable but not authored content, so it gets an export: a git repository of snapshots, or per-note history files, on demand.

### Honest trade-offs, and an easy way back

**Decided.** Some features we want can't be fully expressed in plain notes. That's acceptable when three conditions hold:

1. **It's justified.** The feature is worth it, and we can explain why in plain language.
2. **It's disclosed.** It's listed in a public **trade-off ledger** saying what's less portable and why.
3. **It degrades.** "Leave Surface" turns it into the best plain-file form available, and the ledger says exactly what that is.

The rule above still holds for *authored content*: your words, fields and links are always in files. The trade-offs are about *behaviour*: things that only work while Surface is running.

**Trade-off ledger (draft):**

| Feature | What's less portable | Why it's worth it | What you get if you leave |
|---|---|---|---|
| Live co-editing and offline merge | Merge internals live in Surface's database | No conflict copies; teammates' edits merge automatically | Final text in the files; history export (git) |
| Field validation, choice lists, required fields | Only enforced while Surface runs | A real database instead of loose YAML | Values stay as written; schemas readable in YAML |
| Two-way links | The reverse side is computed, not written | No duplicated lists, no inconsistency | Reverse side via the Obsidian backlinks pane, or a generated Bases view |
| Rollups and formulas | Computed only in Surface | Live totals without stale numbers in files | Formulas readable in the view files; optional snapshot of values |
| Rich views (trees, boards, calendars, agent-built views) | Full behaviour only in Surface | Views far beyond a table | Bases files for what Obsidian can show; others as readable definitions or static snapshots |
| Comments anchored to text | Anchoring only in Surface | Discussion without cluttering the note | Comments as readable Markdown side files, or converted to callouts |
| Permissions and sharing | Enforced only by Surface sync | Teams and guests | Plain files; your copy is yours |
| Rename and link repair | Automatic only in Surface | Links that never break | Links valid at the moment you left; Obsidian maintains them from there |

The ledger is a product asset as well as a document. It belongs on the website: people trust a product that's honest about its trade-offs.

### What this changes

- **Comments are written to files** (Markdown side files), not kept only in the database.
- **Views and schemas are always written to files** (already the plan).
- **Sync has no lock-in either:**
  - the sync server can be self-hosted;
  - the protocol is open;
  - and since the files are plain, teams can always fall back to git, Dropbox or Obsidian Sync on their own.
- **Agents have no lock-in either:** any agent (Claude Code, Codex, Hermes, anything with a terminal) can work directly on the files.

### Proving it

- **The "delete Surface" test**, run automatically on every build:
  1. Build a workspace using every feature.
  2. Delete Surface's local database.
  3. Check that every authored thing is still present and readable in the files, and that it opens cleanly in Obsidian and in a plain text editor.
  4. Rebuild the database from the files, and check that nothing changed.
- **A published, open file format spec** ("Surface Markdown"): how records, fields, links, types, views and comments are written. Anyone can build a tool that reads or writes it. People trust the format more than any promise.
- **"Leave Surface" is a feature,** not a support article. One action makes a workspace fully standalone:
  - views become `.base` files;
  - comments become visible notes;
  - history can be exported to git;
  - a "Start here" note explains the layout.
- **Arriving is as easy as leaving:** importing an existing vault (parked; `docs/IMPORT.md`) is the other half of the same promise.

### Marketing lines (drafts)

- *Your notes are files. Leave any time.*
- *Surface is a way of working with your files, not a place they're locked away.*
- *Obsidian, VS Code, or any text editor is always an option.*
- *No account needed. No cloud needed. Sync if you want it.*
- *Bring your own agent.*

(Naming other products in marketing is generally fine when it's factual, but check before launch.)

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

## 3a. A headless core: the app is one client

**Leaning (Oct 13).** Surface's base is a **core engine with command-line tools**, and the Mac app is one client of it, like Git and its GUIs, or Syncthing and its web interface. Everything Surface does works without opening the app.

```
                 surface core (Rust library)
     file watching · three-way merge · database · sync · flags · types · queries
                              │
          surfaced (background service: owns the workspace)
         ┌──────────────┬───────────────┬──────────────────┐
     Mac app       surface CLI      surface mcp      raw file edits
   (Tauri GUI)   (people, agents,  (agents that       (any editor,
                    scripts)        prefer MCP)        any agent)
```

- **`surfaced`, the background service:** watches files, reconciles, keeps the database and syncs with the team, all with no window open.
  - It runs at login on a Mac, or as a service on a Linux server.
  - **This makes always-on setups possible:** a Mac mini or a small server running agents around the clock, keeping a team workspace in sync.
- **`surface`, the command-line tool:** `init`, `status`, `sync`, `check`, `flags` (list and resolve), `new`, `query`, `types`, `views`, `history` and `undo`, `import`, `leave`, and `skills` (regenerate).
- **`surface mcp`:** the same operations as a local MCP server, a thin layer over the CLI that's cheap to add.
  - **Still optional:** files, `AGENTS.md` and skills remain the baseline (§10).
  - A remote MCP server for web and phone assistants is a later, separate piece.
- **The Mac app** bundles the core and service, so non-technical users never see a terminal.
- **One owner per workspace:** only one process writes a workspace's database at a time. If the service is running, the app and CLI talk to it over a local socket. If not, the first one to start takes a lock and acts as the service.

**Why:**

- **Agents get exact operations,** with errors right away instead of flags later: `surface new task` validates fields and makes the ID.
- **Edits through the CLI or MCP can say who made them** (`--as claude-code`, or an environment variable). Raw file edits stay anonymous ("edited outside Surface").
- **Build order follows naturally:** the hard part (merge, sync, flags) is all in the core. The one-week sync test becomes the first layer of the real product, and early users who live in agents can use Surface before the app is polished.
- **No lock-in, again:** the app is optional too.

**Costs:**

- **Background services add complexity:** installing, updating, starting at login, Mac permissions, and making sure they don't misbehave.
- **The app and CLI share one engine,** so the local socket protocol becomes something we have to keep stable.
- **CLI-first products risk neglecting the app.** The Bear-level app stays a first-class goal, not an afterthought.

**Open:** should the first release be **core + CLI + service** (developers and agent users first), with the app close behind? Or should all three ship together?

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
- **A record's type can change** (Note → Task) with one action. It's a field edit: the ID, links and history stay the same. Fields are mapped to the new type, and any that don't fit are kept and flagged.

### IDs

**Decided.**

- **Format:** `{time}{random}`, all lowercase Crockford base32. Example: `0q8z4mkr7f2c`.
  - 7 characters of creation time (seconds, good for about 1,000 years) plus 5 random characters (about 33 million per second).
  - IDs sort by creation time, and can be made offline on any device with no realistic chance of collision.
- **IDs don't carry the type (decided Oct 13).** The type is a normal field: `type: task` in the database and in front matter. Changing a record's type (Note → Task) just edits that field, so the ID, links and history stay intact.
- **Minor open point:** one fixed prefix for every record (e.g. `s_0q8z4mkr7f2c`), to make IDs easy to recognise and search for in logs and text. It would never encode the type.

> **Superseded (Oct 13): type-prefixed IDs** (`task_0q8z4mkr7f2c`, with the type derived from the prefix). The prefix existed so an ID *filename* could say what it was. Once filenames became readable titles and types became user-editable, it only had costs: a type change would need a new ID, rewritten links and split history; users would have to invent a prefix for every type; and merging types would rewrite IDs.

### Types and schemas

**Decided.** Types are created and changed by users, like Notion databases. There's a **Types** interface where people can:

- **Create a type:** name, icon, colour, default folder.
- **Add fields:** name, field type, options, default, and required or not.
- **Edit fields:** rename them, change their type, reorder them, edit choice options.
- **Archive or delete** fields and types.
- **Agents can do all of this too,** from a conversation: "track my wine collection" leads the agent to propose a Wine type with fields, and you approve it.
- **Note is built in** and can't be deleted.
- **Shipped types (decided): Note, Task, Project, Contact.** Except for Note, they're ordinary editable types, set up on a new workspace, not hard-coded.
- **More types, one click away:** a type gallery (for example Meeting, Company, Event, Document, Bookmark, Decision). Adding one creates an ordinary editable type.

**Starter fields (proposed; kept minimal so people add rather than delete):**

| Type | Fields |
|---|---|
| Note | title, tags |
| Task | title, status (todo / doing / done), due, assignee → Contact, project ↔ Project |
| Project | title, status (planned / active / done), start, end, tasks ↔ Task, contacts ↔ Contact |
| Contact | title (name), email, phone, company (text, until a Company type is added), projects ↔ Project |

`↔` marks a two-way link. Out of the box, a Project shows its tasks and contacts, and a Contact shows its projects.

**Two-way links are stored on one side only (leaning).** One-to-many links are stored on the "one" side (each Task's `project`). For many-to-many, the schema names the stored side. The other side is computed. In Surface, both sides show and both are editable; editing the computed side writes the stored one. In Obsidian, the reverse appears in the backlinks pane, or in an embedded Bases view. See `docs/OBSIDIAN.md` → "Two-way links in the files."

**Field types (proposed):**

- text, number, date, checkbox;
- choice and multi-choice;
- link (to a type, or to anything), with optional **two-way relations** (a "tasks" field on Job mirrors a "job" field on Task, like Notion);
- person, URL, email, phone, file;
- formula and rollup (computed);
- created and updated time (automatic).

**Storage:**

- Schemas are data: stored in the database, synced like records, and mirrored as readable YAML in `.surface/types/`.
- **Every field has a permanent internal ID, separate from its name.** This is the key-versus-label idea again. The database stores values by field ID, so renaming a field or a choice option is instant in Surface. The files then get their YAML key updated in one migration.

```yaml
# .surface/types/task.yaml (mirror; illustrative)
name: Task
icon: check-circle
folder: tasks/
fields:
  - { id: fld_0q8z4m, name: title,    type: text, required: true }
  - { id: fld_0q8z4n, name: status,   type: choice, options: [todo, doing, done], default: todo }
  - { id: fld_0q8z4p, name: due,      type: date }
  - { id: fld_0q8z4q, name: assignee, type: link, to: person }
  - { id: fld_0q8z4r, name: job,      type: link, to: job, two_way: tasks }
```

### What each schema change does

| Change | In Surface | In the files | Risk |
|---|---|---|---|
| Add a field | Instant | Nothing until a value is set | None |
| Rename a field or option | Instant (stored by field ID) | One migration rewrites the YAML key or value in every affected file | Offline edits with the old name: Surface keeps a list of old names and maps them on reconcile |
| Change a field's type (e.g. text → date) | Values converted | Rewritten where conversion succeeds | Values that can't convert are **kept and flagged**, never lost |
| Reorder fields | Instant | Canonical order applies on the next write | None |
| Archive a field | Hidden from views; values kept | Untouched | Can be restored |
| Delete a field | Asks first; shows how many records have values | Values removed from files in one migration | Destructive; undo through history |
| Rename a type | Instant | `.surface/types/` mirror only | None |
| Delete a type | Its records become Notes (or are archived); asks first | Unchanged, apart from the type | Fields that don't belong to Note are kept as extra values and flagged |
| Change a record's type (Note → Task) | One action; same ID, links and history | Fields mapped; `type:` updated | Fields that don't exist on the new type are kept and flagged |

**In teams:** editing types is a permission (owners and admins by default). Schema changes sync like any change. Two people changing the same field definition at once is flagged.

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
  - `type`: the record's type (Note, Task, …).
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
| Live record view in a page | An embed of a view: `![[Due this week]]` (§5d) |
| Comments | Markdown side files (tier 2; §2a), never inside the note itself |
| Presence | in Surface's database only (temporary; tier 3) |

## 5a. Organizing: views and folders, side by side

### The sidebar has both

**Leaning.** The sidebar has two kinds of sections:

- **Views** (by type): a **Tasks** section twirls down to as many saved views as you like: "Due this week", "By job", "Waiting on others". Each view is a query: a filter, a sort and a layout.
- **Folders:** the real folder tree on disk, for people who think in folders (Zettelkasten, atomic notes, plain filing). It's also part of the escape hatch.
- Possibly **Pinned**, for favourite records and views.

**One record, many places.** A record lives in exactly one folder on disk, but it can appear in as many views as you like. A view can also be a *tree* built from links: Job → its Tasks → their notes. So a page can be "nested" under several parents at once. Notion allows only one parent per page; the closest prior art is Tana, where a node can live in many places.

**Views are queries, not containers.** A record appears in a view because it matches. You can't "remove it from a view" except by changing the record, or the view. Hand-picked lists, if wanted later, would be a separate feature (a record with a list of links).

**Views are data:** saved in the workspace, synced in teams, and written as files so they escape too.

**Open:** the view format. Surface views will likely be more dynamic than Obsidian Bases tables: trees, boards, calendars, agent-built views. Options: a Bases-compatible core with extras, or Surface's own format plus a Bases *export*. See `docs/OBSIDIAN.md`.

### Folders

**Decided:**

- **Folders are the user's.** Surface never invents folders or moves files on its own.
- **Moving a file between folders is an ordinary change:** recorded and synced, never flagged. A record's folder is just another attribute that views can use ("tasks in Projects/Kitchen").

**Open: where new records are created.** Recommendation, decided by context with no prompt:

- Creating from inside a **folder** puts the record in that folder (what Finder and Obsidian do).
- Creating from a **view**, or anywhere else, puts it in the type's default folder.
- A workspace setting can change this: always the type folder, always ask, or a fixed inbox folder.

### Notes and types

**Decided:**

- **Every record has a type. The default is Note.** A Note has a title, a body, links and tags, and no required fields. Folder and Zettelkasten users can live entirely in Notes.
- **New files found on disk are flagged for import,** defaulting to Note and asking for the type.
  - Refinement: if the file sits in a type's default folder (for example `tasks/`), suggest that type.
  - A bulk "import all as Note" is available for many files at once.
- **Changing a Note into a Task later** is one action, and it keeps the same ID, links and history (§4). Notes becoming typed records will be the common case.

## 5b. Block-like editing on plain Markdown

**Decided (Oct 13): real Markdown only, with the block feel added in the UI.** Files must always look good and be readable in any text editor. There are no real blocks, no per-paragraph IDs, and no HTML or custom syntax for layout.

Background: The question (Oct 13): are Bear or Margin block-based, and can Surface have block-based editing without breaking the files?

- **Neither is block-based.**
  - **Margin** is a text editor (CodeMirror 6) with live preview. Its block-like behaviour (drag lines, fold headings, `/` menu, Tab to indent) is done as text operations on one Markdown document. Verified from the author's post on the CodeMirror forum.
  - **Bear** is also text-first: one Markdown-style document per note with rich rendering. It keeps notes in its own database rather than as files on disk. From knowledge, not verified.
- **Notion is block-based in its data:** every paragraph is a database row with an ID.

### Two meanings of "block-based"

| | Block *feel* (how editing behaves) | Block *data* (how it's stored) |
|---|---|---|
| What it is | `/` menu, drag handles, move, fold, "turn into", a hover menu per paragraph | Every paragraph is a record with a permanent ID and its own metadata |
| Files stay clean Markdown | ✅ It's all text operations | ❌ Needs an ID on every paragraph, or a separate block store |
| Who does it | Margin, Obsidian, Typora, Craft-like editors | Notion, Anytype |

**Decided: full block *feel*, on plain text *data*.** The editor behaves like a block editor; the file stays ordinary Markdown.

### What maps cleanly to Markdown (and works in Obsidian)

| Block | Markdown |
|---|---|
| Headings, lists, to-dos, quotes, code, dividers, tables, images | Standard Markdown / GFM |
| Callouts | `> [!NOTE]` |
| Toggles (collapsible blocks) | Foldable callouts `> [!NOTE]-` (Obsidian syntax), or a folded heading |
| Highlight | `==text==` (Obsidian) |
| Embed a note, or part of one (like a synced block) | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` (Obsidian embeds) |
| Live database view in a page | An embed of a view, `![[View name]]` (the view itself lives in the app, §5d) |
| Link to a paragraph | `^id`, added only when something links to it (already decided) |

### What doesn't map, and how to handle it

- **Columns or side-by-side layouts:** not supported. There's no Markdown standard, and HTML would hurt readability.
- **Per-block colours or backgrounds:** not supported. Callout types cover most of the need.
- **Per-block permissions and per-block metadata:** not supported. If something needs fields, it's a record (existing rule).
- **Comments anchored to a paragraph:** inside Surface, anchors ride on the text CRDT (Automerge supports cursors and marks that survive edits). After outside edits, anchors are re-found by quoted text and surrounding context. Comments live in side files (§2a).

## 5c. Tables in a page

**Leaning.** There are three different things people mean by "a table in a page." Surface supports all three, each written as real Markdown.

### 1. Plain Markdown tables (content that belongs to this page)

- A standard GFM pipe table, written in the body.
- **Edited cell by cell** in Surface (as Margin does). The file stays a normal table that looks fine in any editor.
- **Typed in the UI only (proposal):** Surface can treat a column as a number, date or choice, based on its contents or a choice in the UI. It can then sort, validate and show totals in a footer. Totals are displayed, never written into the file.
- **Use when** the rows only matter inside this page: a quick comparison, a materials list, a meeting agenda.

### 2. Live views (records shown in a page)

- An embedded view (`![[Tasks for this job]]`; views are built in the app, §5d): for example, "tasks where project is this page, sorted by due date."
- Surface renders it as a live table, board or list. **Editing a cell edits the record it came from,** and that record's own file.
- **In other editors** you see the query as readable text, not the data. That's a ledger item (§2a).
- **Not done by default:** writing a snapshot of the results into the page. It would go stale, and it would rewrite the page every time a task changes, adding noise to sync and merging.
- **Leaving Surface** converts each live view into a Bases embed (if Obsidian can show it) or a snapshot table.
- **Use when** the rows are records that matter across the workspace: tasks, contacts, projects.

### 3. Notion-style "inline databases" (rows that belong to this page)

In Surface this isn't a separate feature. It's case 1 or case 2:

- **Rows that need to be linked, queried across pages, or have a body of their own** are records (a type), and the page shows them with a live view (case 2).
- **Rows that only live in this page** are a plain Markdown table (case 1). This avoids hundreds of tiny files for things like line items.

**Rule of thumb:** if a row needs to be found, linked or reported on from elsewhere, it's a record. Otherwise it's a table row.

### Converting a table to records

**Leaning.** The hard part is that rows must become records of a type with matching fields. It works like a CSV import into Notion or Airtable: a mapping step with a preview.

1. **Pick the target type:** an existing type, or **"new type from this table"** (each column becomes a field).
2. **Map the columns.** Each column becomes one of:
   - **an existing field,** auto-matched by name ("Due date" → `due`);
   - **a new field** added to the type, with its field type guessed from the values (all dates → date; a few repeated words → choice);
   - **the body** of each record;
   - **ignored.**
   
   One column must become the `title` (the first column by default).
3. **Convert the values, with a preview:**
   - dates and numbers are parsed;
   - new choice values are offered as new options;
   - cells matching an existing record's title can become links ("Jane" → `[[Jane Doe]]`);
   - **values that don't fit are kept as text and flagged, never dropped.**
4. **Check for duplicates.** Rows matching an existing record can be linked to it, merged, or created anyway.
5. **Link the records back to this page** (for example, each new task's `project` is set to this project), so the live view can find them.
6. **Replace the table with a live view** of those records, or keep the table as well.
7. **Undo** reverses the whole conversion in one step.

- **Agents can do the same:** "turn this table into tasks." The agent proposes the mapping, and you approve it.
- **The reverse** (live view → plain table) is easy: write the current results as a static Markdown table. The records stay as they are.
- **One import engine:** the same mapping-and-preview step serves table conversion, CSV import, new notes found on disk, vault import (parked) and future imports from other apps.

**Open:**

- Should Markdown table column types be **remembered** (and where, without adding syntax to the file)?

## 5d. Views are generated in the app

**Decided (Oct 13).** **Markdown is the notes and the editable database. Views are generated by the app from that data.** Kanban boards, Gantt charts, calendars, galleries and tables can't be expressed well in Markdown, and shouldn't be. They're renderings of records, not documents.

- **A view = a query plus a layout:** which records, filtered, sorted and grouped, shown as a table, board, list, calendar, Gantt chart or gallery. One view can offer several layouts of the same query, as Obsidian Bases does.
- **Interacting with a view edits the records,** never a picture of them:
  - dragging a card to another board column changes its `status`;
  - dragging a Gantt bar changes its `start` and `end`;
  - editing a table cell edits that record's file.
- **Nothing about the board is stored except its definition.** The results are computed (tier 3, §2a), so files never churn when a view changes.
- **Built in the app, not typed:** you pick the type, filters, grouping and layout in the UI.
- **This is the Obsidian Bases idea taken further.**
  - **Bases:** a view is a YAML definition generated over notes' properties. Obsidian 1.14 (Sep 2026) added a native Kanban layout for Catalyst supporters.
  - **Surface goes further** with richer layouts (Gantt, dependencies, rollups), team sync, and agent-built views.

### Where view definitions are kept

**Leaning.** A view's definition is authored content, so under the no-lock-in rule (§2a) it can't live only in the database:

- **Each view is saved as a small readable file** that Surface owns, for example `.surface/views/due-this-week.yaml`, with a format version.
- **Agents can read and write view files** (taught by `surface-views`), and leaving keeps them. On "Leave Surface", views that Obsidian can show are converted to `.base` files.
- **Personal display state** (column widths, collapsed groups, a quick search) stays on this device and is never written.

### Views on pages

- **A page shows a view with a one-line embed:** `![[Due this week]]`. A dashboard is a page with text plus a few embeds.
- **Other editors** show the embed as a link. The query lives in the view file.
- **Superseded:** putting the query itself in a page (` ```surface ` blocks), and "a view is just a page."

### Mixing tables, prose and content from other notes

**Leaning.** A view page can pull in live content from anywhere, using standard Markdown and Obsidian syntax (Obsidian renders all of it live too, except inline values):

| You want | In the file | Live? |
|---|---|---|
| A link to another note | `[[Kitchen Remodel]]` | Always; links survive renames (§5) |
| Another note's whole text | `![[Site meeting notes]]` | Yes; editing it in place edits the source note |
| One section of another note | `![[Kitchen Remodel#Scope]]` | Yes |
| One paragraph of another note | `![[Kitchen Remodel#^scope-1]]` | Yes, but needs a `^id` marker on that paragraph, added only when someone embeds it (a ledger item) |
| A view (table, board, Gantt…) | `![[Due this week]]` | Yes, in Surface; other editors show a link |
| One field's value in a sentence | `` `= [[Kitchen Remodel]].status` `` | In Surface; other editors show the readable expression |

**Rules:**

- **Embeds stop at a few levels deep** and never loop (A embeds B embeds A).
- **A missing or renamed target** is rewritten like any link, or flagged if the target is gone.
- **Prefer embedding a section (heading)** over a paragraph, so no `^id` markers are needed.

**Open:** the inline value syntax (Dataview-style `` `= …` `` or something else).

### The sidebar is a page too (proposal)

- **The sidebar is an outline of links** in a Markdown file (for example `Sidebar.md`):
  - indenting a link nests it, which gives the twirl-downs;
  - the same page can be linked under as many headings as you like.

  ```markdown
  - Tasks
    - [[Due this week]]
    - [[Waiting on others]]
    - [[Tasks by job]]
  - Jobs
    - [[Active jobs]]
    - [[Kitchen Remodel (2243 Steiner)]]
  ```
- **Folders** appear as their own section below it (§5a).
- **Readable in any editor,** and in Obsidian it's just a note of links.

**Open:**

1. The view file format: Surface's own (versioned), or a superset of Obsidian's `.base` format.
2. One sidebar for the whole team, or a shared one plus personal additions?
3. Should a quick filter be shareable as a link without saving it as a view?

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
| File renamed outside Surface | Flags it: *"Renamed to X. Make that the new title and update N links, or restore the old name?"* Surface itself doesn't break, because it identifies files by `id:`; but links written in other files by name would. |
| File moved to another folder | Ordinary change, synced, never flagged (§5a) |
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
  comments/     comment threads as Markdown (always written; §2a)
  flags/        open flags as readable files, so agents can resolve them (§10)
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
- **Agents:** the Markdown files plus `AGENTS.md` and skills (the baseline); the `surface` CLI and local `surface mcp` from the headless core (§3a); a remote MCP server later (§10).
- **First milestone:** solo workspaces on Mac only.
  - the editor;
  - file watching with three-way merge, and the flags view;
  - table and board views;
  - view embeds in pages;
  - `AGENTS.md`, the shipped skills and flags-as-files; the optional CLI;
  - baseline Mac polish.

### Visual style

**Leaning.** Inspired by **Bear** and **Margin**: native Mac feel, typography-led, one sparing accent colour, live preview with no toolbar, calm even for structured data. See `docs/DESIGN.md`.

## 10. Agents

**Decided:** bring your own agent. Surface doesn't ship one. **Decided:** files are the interface; no MCP server or API is required. The rest is **leaning**. Full design: `docs/AGENT-INTEGRATION.md`.

- **Any agent that can read and write files can work in a workspace:** Claude Code, Codex, Cursor, Gemini CLI, Copilot, Hermes and others. No agent lock-in.
- **Agents get knowledge from files, using the two open standards they already read:**
  - **`AGENTS.md`** at the workspace root: a short, stable entry point and five hard rules;
  - **Agent Skills** in `.agents/skills/`, copied to `.claude/skills/` for Claude Code.
- **Surface-shipped skills** (`surface-workspace`, `surface-types` generated from the workspace's types, `surface-views`, `surface-flags`, `surface-import`) are regenerated when the workspace changes.
- **Users and teams write their own workflow skills** in Surface, like notes. They sync with the workspace, so every teammate's agent gets the same playbook.
- **Flags are written as files** (`.surface/flags/`), so agents can see and resolve them.
- **Agents never rewrite whole files.** Edits go through the same three-way merge as everyone else's. A burst of outside edits is one undoable change.
- **The `surface` CLI and `surface mcp`** come with the headless core (§3a). They add exact operations, validation and "who edited", but aren't required. A *remote* MCP server or API comes later, for agents that can't see the files (web and phone assistants, remote teammates).

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

7. The filename naming rule, and filename churn (§5).
8. The front matter key: `id` or `surface_id`.
9. Where the local database lives (§8).

**App**

10. The shell: is about 95% of Bear's look acceptable (Tauri), or are a real native toolbar and controls required (Swift shell)? Also confirm the editor, views and MVP scope.

**Types**

11. A fixed prefix for all IDs (e.g. `s_`), or none (minor; §4).
12. Who can edit types in a team (default: owners and admins).

**Organizing, tables and Obsidian**

13. Where new records are created: by context, or a setting (§5a).
14. The view file format: Surface's own, or a superset of Obsidian's `.base` (§5d).
15. Should Markdown table column types be remembered, and where (§5c)?

**Parked**

16. Importing existing vaults: in place or as a copy, huge vaults, the path-generation principle (`docs/IMPORT.md`).

## 13. Not yet designed

Gaps identified Oct 13, in suggested order:

1. **Agents and surfaces** (pillars 2 and 3 of the thesis). Bring-your-own-agent, the entry point and skills are now designed (§10). Still open:
   - Knowing which agent or person made an outside edit; approvals.
   - Agent-built views: how they're requested, rendered, saved and shared, and how they get live data.
   - Model choice and privacy (local models, your own API key).
2. **Permissions and sharing.** Constrains the sync design (one CRDT document per record), so it's expensive to change later.
3. **Attachments and large files** (photos, PDFs, plans): where they're stored, how they sync (CRDTs aren't for large binary files), size limits, previews.
4. **Search:** full-text; possibly semantic search for agents; search across views.
5. **History, undo, trash and deletion:** what users see; how deletions sync; restoring.
6. **The view system:** layouts, query language, formulas, rollups, grouping, calendar.
7. **Templates, recurring items, reminders and notifications;** whether agents replace automations.
8. **Security:** end-to-end encryption for sync, encryption at rest, secrets in notes.
9. **Mobile:** what's possible with files on iOS and Android.
10. **Performance targets:** workspace size, open time, sync time (partly covered by the spike).
11. **Onboarding:** first run, starter content.
