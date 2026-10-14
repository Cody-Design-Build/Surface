# Surface Spec

The current design in one place. Last consolidated: Oct 14, 2026.

> **Current direction (Oct 14, decided): Supabase is the truth.**
> - **There's no local database or sync engine.**
> - **Files are a checkout:** `surface pull`, edit, `surface push`, with revision checks.
> - **Three layers:**
>   1. **Files:** storage, one home per record.
>   2. **Views:** navigation, a tree in an Obsidian plugin.
>   3. **Composite pages:** prose plus live data.
> - **Clients:** Obsidian with a Surface plugin (desktop), a web app (team) and the `surface` CLI (agents).
> - **The MVP is built** (`docs/MVP.md`, `cli/`, `supabase/migrations/`).
>
> Sections still describing a local database, CRDT merging or a Tauri app have been rewritten. Their reasoning is kept as **Superseded** notes.

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

### Why Surface and not just Obsidian

**Decided (positioning).** Obsidian's properties are loose: a status can be `Done`, `done`, `complete` or a typo, a date can be any text, and nothing checks them. That drift is fine for personal notes, but **it makes Obsidian mostly unusable as a business app**, because views, totals and agents can't trust the data.

**Surface's difference is structured data on top of plain files:**

- types with typed fields and validation;
- drift is flagged, never silently accepted or silently fixed;
- two-way links and totals;
- **a real database as the truth,** which refuses bad data on every write, whoever sends it;
- one shared workspace for the team, with no Git;
- agents that can rely on the data.

Views over properties are the same idea as Obsidian Bases. The trust in the data underneath them is what's different.

### Lessons from CDB OS

**Context (Oct 13).** CDB OS (`Cody-Design-Build/CDB-OS`) already proved most of Surface's data and agent ideas, with no app at all:

- plain Markdown records with `document_type` and `id` front matter;
- `AGENTS.md` as the entry point, plus skills in `.agents/skills/`;
- a checker (`check.py`) for broken links, IDs and duplicates;
- a link-safe rename tool (`links.py`);
- saved views as `.base` files;
- templates;
- background Git sync every 2 minutes.

**It works for agents and for David:** 207 commits, all from David and two agents. **It didn't work for the rest of the team:** GitHub, Git, Finder and Obsidian don't feel team-like to non-technical people.

**So Surface's real job isn't the data model or the agent layer; CDB OS has those.** It's what's missing:

1. **An app that feels like Notion to non-technical people,** with no Git, Finder or Obsidian required.
2. **Sync you never see.**
3. **Structure that doesn't drift.** CDB OS's "Finder test" deliberately forbids required fields.
4. **Phone and field use.**
5. **Sharing with clients and subs.**

**Why the team never used it, and chose Notion instead (Oct 13):** joining meant creating a GitHub account and being taught Git in person. Notion meant "log in and start making pages."

**The bar for Surface's team onboarding:**

- an invite link;
- sign in with Google or email;
- working in a browser within a minute;
- no install, no GitHub, no teaching.

**Consequences (decided Oct 14):**

- **A web app becomes the main team experience.** Obsidian (with the Surface plugin) and the files checkout are for power users and agents.
- **A central database is the truth** (Supabase; see §3 and `docs/explorations/CENTRAL-DATABASE.md`). A browser has no local copy to merge.
- **Solo, account-free, local-only use is dropped.** Everyone signs in.

## 2. Principles

1. **Data is the foundation.** The surface is just where a human touches it.
2. **The database is the truth; files are a checkout.** The workspace lives in Supabase. Any machine can pull it as Markdown, read and edit it offline, and push changes back. *(Was "local-first, no account"; superseded Oct 14.)*
3. **Files are first-class.** Every record is also a plain Markdown file. People and agents can edit those files in any editor, then push. They're also the exit: your data is always readable without Surface. **Files are real Markdown that looks good in any text editor:** no hidden IDs in the body, no HTML, no custom layout syntax. Block-style editing is a UI feature (§5b).
4. **Surface is the tool; other editors are welcome guests.** Obsidian and any Markdown editor can read and edit the files, but compatibility is best effort, not a design constraint.
5. **Fix only what's safe, report every fix, reject the rest.** On push, unambiguous fixes are applied and each one is reported, e.g. `Oct 20` → `2026-10-20`, or `done` → `Done`. Anything ambiguous, like a typo'd option, an unknown field or a stale revision, rejects that file with a clear message. Surface never quietly rewrites or discards someone's edit.
6. **Agents are users.** Their edits travel the same paths as a person's, and get the same validation, history and permissions.

## 2a. No lock-in

**Decided (principle).** This is a big part of why Obsidian is popular: your notes are yours, and you can leave any time. Surface must feel the same. It isn't about Obsidian. It's about people knowing there's no vendor lock-in. Obsidian, or any other notes app, is always an option if you want to leave.

### The rule

**Everything a person or agent authors can always be written out as open, readable files, with one command (`surface pull`) and nothing lost. The database adds validation, history and collaboration, but it never holds anything that can't be exported.** *(Oct 14: the database is now the truth. The promise moves from "files are always the only copy" to "a complete, plain-file copy is always one pull away". A scheduled pull committed to Git keeps one always current; see §7.)*

Every feature is designed into one of three tiers:

| Tier | What | Where | If Surface disappeared |
|---|---|---|---|
| **1. In the note** | fields, body, links, tags, to-dos, callouts, heading and paragraph links | the `.md` file: YAML front matter plus Markdown | Works in any Markdown app; native in Obsidian |
| **2. In a readable side file** | type schemas, saved views, comments, workspace settings | plain YAML or Markdown files in the workspace | Readable in any editor; views can also be written as Obsidian `.base` files |
| **3. Computed or temporary** | the search index, rollups, backlinks, presence, sync state, merge internals | the database only | Nothing authored is lost; all of it can be rebuilt from tiers 1 and 2 |

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
| The database as the truth | Your current copy is a checkout, not the master | Validation enforced on every write; one shared workspace for the team | A full pull is a complete plain-file workspace; history export (git) |
| Field validation, choice lists, required fields | Enforced by the database, not the files | Data that can't drift | Values stay as written; schemas readable in YAML |
| Two-way links | The reverse side is computed, not written | No duplicated lists, no inconsistency | Reverse side via the Obsidian backlinks pane, or a generated Bases view |
| Rollups and formulas | Computed only in Surface | Live totals without stale numbers in files | Formulas readable in the view files; optional snapshot of values |
| Rich views (trees, boards, calendars, agent-built views) | Full behaviour only in Surface | Views far beyond a table | Bases files for what Obsidian can show; others as readable definitions or static snapshots |
| Comments anchored to text | Anchoring only in Surface | Discussion without cluttering the note | Comments as readable Markdown side files, or converted to callouts |
| Permissions and sharing | Enforced by the database (row-level security) | Teams and guests | Plain files; your copy is yours |
| Rename and link repair | Automatic only in Surface | Links that never break | Links valid at the moment you left; Obsidian maintains them from there |

The ledger is a product asset as well as a document. It belongs on the website: people trust a product that's honest about its trade-offs.

### What this changes

- **Comments are written to files** (Markdown side files), not kept only in the database.
- **Views and schemas are always written to files** (already the plan).
- **The database has no lock-in either:**
  - it's plain Postgres (Supabase), with a small, documented schema (`supabase/migrations/`);
  - Supabase can be self-hosted;
  - and since a pull is plain files, teams can always fall back to Git, Dropbox or Obsidian Sync on their own.
- **Agents have no lock-in either:** any agent (Claude Code, Codex, Hermes, anything with a terminal) can work directly on the files.

### Proving it

- **The "leave and come back" test**, run automatically on every build:
  1. Build a workspace using every feature.
  2. Pull a full checkout.
  3. Check that every authored thing is present and readable in the files, and that it opens cleanly in Obsidian and in a plain text editor.
  4. Import the checkout into an empty workspace, and check that nothing changed.
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
- *Bring your own agent.*

(Naming other products in marketing is generally fine when it's factual, but check before launch.)

## 3. Architecture: the database is the truth

**Decided (Oct 14).** Built and running as the MVP.

| Layer | Git equivalent | Role |
|---|---|---|
| **Database** (Supabase / Postgres) | the remote | the single source of truth: types, records, links, full history, permissions; validates every write |
| **Files** (a checkout on any machine) | working copy | Markdown generated from the database; people, editors and agents read and edit them, then push |

- **There's no local database and no sync engine.** The checkout's `.surface/state.json` (revisions and file hashes) is the only local state.
- **Pull and push, like Git, but per record:**
  - `surface pull` writes the database into files;
  - `surface push` sends edited or new files back. It validates each one and checks its revision, so a stale file is rejected rather than merged.
- **Everyone signs in.** The workspace is shared by default. A personal workspace is just a workspace with one member.
- **A disposable local index may come later,** only if queries get slow. It's a cache rebuilt from the database, never the truth.

> **Superseded (Oct 14): a local database on every device** (the device's source of truth, with CRDT merging between devices and an optional sync server).
> - It existed for four needs: fully offline work with queries, speed at huge sizes, live co-editing, and solo use with no account.
> - The MVP showed none of them are needed to start. Offline reading and editing already work through the checkout.
> - It was the hardest and riskiest part of the design: the sync engine, the merge technology and the spike.

## 3a. Clients: one database, several ways in

**Leaning (Oct 14).** No headless background service. The database is the shared core, and every client talks to it directly.

```
                      Supabase (types · records · links · history · RLS)
         ┌───────────────────┬──────────────────┬─────────────────────┐
   surface CLI         Obsidian + Surface     Web app             any agent
   (agents, scripts,   plugin (desktop:       (the team:          (via the CLI,
    power users)       Views tree, embeds,     no install)         or files + push)
                       push on save)
```

- **`surface`, the command-line tool (built):** auth, workspaces, types and fields, `pull`, `push`, `status`, `diff`, `check`, `new`, `set`, `show`, `query`, `rm`, `restore`, `history`, `skills`. TypeScript on Node. See `cli/README.md`.
- **Obsidian plugin (planned; likely the desktop app):** a **Views** panel (§5a), live embeds in pages, push on save, inline validation messages, and type-aware property editing. It talks to Supabase directly.
- **Web app (planned):** the team's way in. It meets the onboarding bar (§1): invite link, sign in, working in a browser within a minute.
- **A Surface Mac app is deferred.** Obsidian plus the plugin covers the desktop, and a separate app only comes back if the plugin can't meet the "feels like Bear" bar.
- **MCP (later):** a thin layer over the same operations, for agents that can't run the CLI or see files.

**Why:**

- **Agents get exact operations** with immediate errors: `surface new task` validates fields and makes the ID.
- **Every write goes through the database's validation**, whichever client sends it.
- **Building on Obsidian** gets an editor, file handling, search and a plugin ecosystem for free.

> **Superseded (Oct 14): a Rust core plus a `surfaced` background service** that watched files, merged and synced, with a Tauri Mac app as its main client. There's nothing left to watch or merge once the database is the truth and files are pushed explicitly.

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
- **A record's type can change** (page → task) with one action. It's a field edit: the ID, links and history stay the same. Fields are mapped to the new type, and any that don't fit are kept and flagged.

### IDs

**Decided.**

- **Format:** `{time}{random}`, all lowercase Crockford base32. Example: `0q8z4mkr7f2c`.
  - 7 characters of creation time (seconds, good for about 1,000 years) plus 5 random characters (about 33 million per second).
  - IDs sort by creation time, and can be made offline on any device with no realistic chance of collision.
- **IDs don't carry the type (decided Oct 13).** The type is a normal field: `type: task` in the database and in front matter. Changing a record's type (page → task) just edits that field, so the ID, links and history stay intact.
- **Minor open point:** one fixed prefix for every record (e.g. `s_0q8z4mkr7f2c`), to make IDs easy to recognise and search for in logs and text. It would never encode the type.

> **Superseded (Oct 13): type-prefixed IDs** (`task_0q8z4mkr7f2c`, with the type derived from the prefix). The prefix existed so an ID *filename* could say what it was. Once filenames became readable titles and types became user-editable, it only had costs: a type change would need a new ID, rewritten links and split history; users would have to invent a prefix for every type; and merging types would rewrite IDs.

### Types and schemas

**Decided.** Types are created and changed by users, like Notion databases. There's a **Types** interface where people can:

- **Create a type:** name, icon, colour, default folder.
- **Add fields:** name, field type, options, default, and required or not.
- **Edit fields:** rename them, change their type, reorder them, edit choice options.
- **Archive or delete** fields and types.
- **Agents can do all of this too,** from a conversation: "track my wine collection" leads the agent to propose a Wine type with fields, and you approve it.
- **Page is built in** and can't be deleted. It's the only type a new workspace starts with (decided Oct 14; the MVP does this). A page has a title and a body.
- **Everything else is created by the user or an agent** (`surface type add`), or added from the gallery below.
- *Superseded (Oct 14): shipped Note, Task, Project and Contact types. "Note" is now "page", and the other three move to the gallery.*
- **More types, one click away:** a type gallery (for example Meeting, Company, Event, Document, Bookmark, Decision). Adding one creates an ordinary editable type.

**Gallery starter fields (proposed; kept minimal so people add rather than delete):**

| Type | Fields |
|---|---|
| Page (built in) | title, body |
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

- Schemas are data: stored in the database (`types.fields`, JSON), and written to every checkout as readable YAML in `.surface/types/`.
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

Built behaviour in the MVP (`surface type …` / `surface field …`):

| Change | In the database | In the files | Risk |
|---|---|---|---|
| Add a field | Instant | Appears (empty) on the next pull | None |
| Rename a field key or label | Instant (values are stored by field ID) | The next pull writes the new key | A file still using the old key is rejected on push, with a message naming the field |
| Add or remove a choice option | Instant | Nothing | Values using a removed option are kept; `surface check` flags them |
| Change a field's kind (e.g. text → date) | Planned: values converted | Rewritten where conversion succeeds | Values that can't convert are **kept and flagged**, never lost |
| Reorder fields | Instant | Canonical order on the next pull | None |
| Remove a field | Values removed from every record (kept in history) | Removed on the next pull | Destructive; history keeps the old values |
| Rename a type's key, name or folder | Instant | Files move on the next pull | None |
| Remove a type | Refused while it has records, unless `--move-to <type>` or `--force` | Files move or disappear on the next pull | `page` can't be removed |
| Change a record's type (page → task) | One action (`set <record> type=task`); same ID, links and history | `type:` updated | Values for fields the new type lacks are dropped (kept in history) |

**In teams:** editing types is a permission (owners and admins by default). A type change applies to the database at once, and every checkout gets it on its next pull.

### Nesting: the `parent` field

**Leaning (Oct 14).** Pages can sit inside pages, like Notion.
- **Every record gets a built-in, optional `parent` link,** to any record of any type.
- **Nesting is data:** agents can set it, queries can use it, and it shows in front matter (`parent: "[[Steiner Kitchen]]"`).
- **It doesn't move the file.** The Views tree (§5a) shows the nesting; folders stay a separate choice.
- **One parent per record.** Appearing in many places is what links and query nodes are for.

## 5. The Markdown files

### Layout

**Decided:** Surface controls filenames, so they're readable and work well in Finder and Obsidian.

- **Readable filenames,** kept unique by a stable rule, e.g. `Order cabinets (2243 Steiner).md`.
- **Readable wikilinks** that are always correct: `[[Order cabinets (2243 Steiner)]]`. Renaming a record in Surface renames its file and rewrites every link to it.
- **Each person's files contain only what they're allowed to see.**

**Folders: see §5a.** By default each type has its own folder. Users can set up their own folders instead.

**Open:**

- **The naming rule:** always qualify types prone to duplicates (every task includes its job), or qualify only the newcomer? Existing files should never be renamed just because a duplicate appeared.
- **Filename churn:** a title change renames the file. That's fine in Obsidian, but noisy in git and breaks outside bookmarks.

> **Superseded (Oct 12–13):**
> - ID-as-filename (`task_0q8z….md`) and "files can live in any folder, moves never flagged": both made sense while files were the source of truth.
> - "Meaningful folders generated from relationships" (`Jobs/2243 Steiner/Tasks/`) as *the* layout: it's back as one optional layout (`link:`), alongside type folders and the user's own folders (§5a, §6).

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

## 5a. Organizing: files, views and composite pages

**Leaning (Oct 14), in David's framing.** Three layers that never fight: **files are storage, views are navigation, composite pages combine the two.** Surface can show the data any way we like, because it isn't tied to where the files sit.

### Layer 1: files in real folders (storage)

- **Each record is one file in one folder.** Within a checkout there are no duplicate copies (they'd make Obsidian links, search and the graph ambiguous).
- **Default layout (decided, built): a folder per type.** Pages are in `Pages/`, tasks in `Tasks/`, and so on. The folder name is a type setting (`surface type edit task --folder "To-dos"`).
- **The user's own folders (built):** the `folder` layout. Each record has a `folder` value, set by where its file sits when pushed, by `surface new … --folder`, or by `surface set <record> folder=…`. Moving a file in Obsidian and pushing moves the record.
- **Planned: a layout arranged by link,** e.g. `link:project`. A task's file sits under its job: `Projects/Steiner Kitchen/Tasks/…`. Records without that link go to their type folder; with several links, the first one wins.
- **Good organizing tools,** for agents first, then the plugin: `surface mv`, folder rename, and "move everything matching X". These are planned.
- **Folders have no meaning to the database.** A folder exists only while it holds a record, and deleting a folder in Finder deletes nothing (files show as missing until `surface rm`).

### Layer 2: the Views tree (navigation)

- **An Obsidian plugin adds a sidebar panel called "Views".** Later, the same tree is the web app's sidebar.
- **It looks like folders,** with twirl-downs, but nothing in it moves a file. Its items:

| Item | What it is |
|---|---|
| **Group** | A twirl-down, like a folder, but virtual |
| **Page or record** | Opens the real file; can have children |
| **Nested pages** | Pages in pages, like Notion, from the `parent` field (§4) |
| **Query** | Fills its children automatically, e.g. "tasks where project = this job" |

  ```
  Jobs                      ← query: all projects
  └── Steiner Kitchen       ← the record
      ├── Tasks             ← query: tasks where project = Steiner Kitchen
      ├── Materials         ← query: materials where project = Steiner Kitchen
      └── Meetings          ← query: meetings linked to Steiner Kitchen
  ```
- **One record, many places:** a task appears under every job it links to, with no copies. Notion allows one parent per page; the closest prior art is Tana.
- **Where the tree is stored:**
  - **Nesting lives on the records** (the `parent` field). It's data.
  - **The arrangement lives in a view file,** `.surface/views/sidebar.yaml`: groups, query nodes, manual order, pinned items. It's readable, agents can edit it, and it's kept on Leave.
- **Views are queries, not containers.** A record appears under a query node because it matches. Hand-picked lists are a page or collection record with a list of links.

### Layer 3: composite pages (prose plus live data)

- **A page can mix text, embedded live views and embedded records:** a paragraph, then this job's open tasks as a table, then more text. The data, which is all files, becomes building blocks.
- **The embeds stay real Markdown,** so the page reads fine without Surface (§5d).

### Notes and types

**Decided:**

- **Every record has a type. The default is page.** A page has a title and a body, and no required fields. Folder and Zettelkasten users can live entirely in pages.
- **New files found in a checkout** are listed by `surface status` and imported with `surface push --new`. Each one uses the `type:` in its front matter, or page if there isn't one.
- **Changing a page into a task later** is one action, and it keeps the same ID, links and history (§4).

> **Superseded (Oct 14):**
> - "Surface never invents folders or moves files on its own": the default is now a folder per type.
> - "The sidebar is a page of links" (`Sidebar.md`): replaced by the Views tree, with its arrangement in `.surface/views/sidebar.yaml`.

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
- **Comments anchored to a paragraph:** anchors are found again by quoted text and surrounding context after edits. Comments live in side files (§2a).

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

### View file sketch (illustrative, not final)

```yaml
# .surface/views/due-this-week.yaml
surface_view: 1          # format version
title: Due this week
from: task
where: status != done and due <= today + 7d
sort: due
group: project
layouts:
  - show: table
    columns: [title, status, due, assignee]
  - show: board
    by: status
  - show: gantt
    start: start
    end: due
```

### Views on pages (composite pages)

**Leaning (Oct 14).** A page shows live data in three ways, all real Markdown:

1. **A saved view:** a one-line embed, `![[Due this week]]`. Other editors show it as a link; the query lives in the view file.
2. **An inline view block** for a view that only matters on this page:
   ```surface
   from: task
   where: project = this and status != done
   show: table
   ```
   Other editors show it as readable text. The Surface plugin renders it live, and `this` means the page it's on.
3. **A ` ```base ` block** (Obsidian Bases syntax) for simple cases. It renders natively in Obsidian even without the plugin.

- **A dashboard or job page is text plus a few embeds:** a composite page.
- *Reversed (Oct 14): ` ```surface ` blocks had been superseded in favour of one-line embeds only. They're back, because composite pages need page-local views, and a fenced block is still plain Markdown.*

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

### The sidebar is a page too (superseded Oct 14 by the Views tree, §5a)

- **The sidebar was an outline of links** in a Markdown file (for example `Sidebar.md`):
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

1. **View file format, decided (Oct 13): Surface's own format, plain YAML text like `.base`, as simple as possible, growing only when a feature needs it. Converted to `.base` on Leave.** Bases was checked against Obsidian's docs:
   - **Power:**
     - **Has:** filters (and, or, not, functions), JavaScript-like formulas, summaries, multiple sorts, and table, cards, list, Kanban (1.14) and map layouts.
     - **Missing:**
       - typed fields and validation (it reads loose properties);
       - first-class two-way relations;
       - totals across linked records;
       - Gantt, calendar and dependencies;
       - more than one level of grouping.
   - **Openness:** documented in Obsidian's help, and "simple formats anyone can build editors for" (kepano). But it has **no formal open spec, licence, versioning or governance** (unlike JSON Canvas). One company changes it on its own schedule.
   - **Folders:** not an issue; filters can use any property. Surface is *folder-optional*.
   - **So:**
     - Surface's view format is versioned and published as an open spec (§2a);
     - its simple views (filter, sort, one group, table, cards, list or Kanban) are designed to map cleanly onto `.base`;
     - "Leave Surface" writes those as `.base` files.
2. One sidebar for the whole team, or a shared one plus personal additions?
3. Should a quick filter be shareable as a link without saving it as a view?

## 6. Keeping files and the database in step

**Decided (Oct 13), built (Oct 14).** Files are generated from the database. Edits come back by an explicit push. There's no continuous two-way merging.

### Stage 1 (built): generated files, plus an explicit push

- **`surface pull` writes every record as Markdown** and rewrites files whose records changed. Renamed records move their files and rewrite every link to them. Deleted records' files are removed.
- **Edits come back through:**
  - the CLI (`surface new`, `surface set`);
  - **editing a file, then `surface push`** (from a terminal, an agent, or later the Obsidian plugin on save);
  - later, the web app and the plugin's own editing.
- **`surface push` works like `git push`, per record:**
  - Each file carries its `rev` in front matter.
  - Push normalizes safe fixes and reports each one (§2, principle 5), validates the fields, checks the revision, and applies the change through one database function (`push_record`).
  - **If the record changed since the file was pulled, that file is rejected.** `surface diff` shows what you changed. Pull with `--force` and redo the edit.
  - New files are imported with `surface push --new`. Links between new files resolve in the same push.
- **Pull never overwrites unpushed edits** unless you ask (`--force`). `surface status` lists them.

### Files can be laid out any way we like

Because the files are generated, **the folder layout is a choice made per checkout, not where the data lives:**

| Layout | Status |
|---|---|
| `type`: a folder per type (default) | built |
| `folder`: the user's own folders | built |
| `flat`: one folder | built |
| `link:<field>`: under the linked record, e.g. tasks under their job | planned |
| `--only task,project`: a partial checkout | built |

- **Each checkout picks its own layout.** An agent's checkout can differ from yours.
- **Push works in any layout,** because files are matched by `id`, not by path.
- **One rule:** within one checkout, each record appears **once**.

### Stage 2 (not planned): live two-way files

A file watcher with continuous three-way merging. It's only worth building if push on save (in the Obsidian plugin) turns out not to be enough. The data model wouldn't change.

### What push reports

| Situation | What happens |
|---|---|
| New file without an ID | Listed by `status`; imported by `push --new` (type from front matter, or page) |
| File deleted locally | Listed as missing; the record is deleted only by `surface rm` |
| File renamed or moved | Matched by `id`; in the `folder` layout the move is recorded, and a changed `title` renames the record |
| Broken YAML | That file is rejected with the parser's message |
| Record changed since the file was pulled | That file is rejected as a conflict |
| A safe fix (`Oct 12` → `2026-10-12`, `done` → `Done`, `$1,200` → `1200`, `yes` → `true`) | Applied and reported |
| An ambiguous value (choice typo `dnoe`) | Rejected with "did you mean `done`?" |
| A field the type doesn't have | Rejected, with the command to add it |
| A value made invalid by a schema change (e.g. a removed option) | Kept; `surface check` flags it until someone fixes it |

> **Superseded (Oct 14): "flag and never rewrite; fixes only when someone accepts them".** The MVP applies safe fixes on push and reports each one, and rejects anything ambiguous. That kept data clean without a separate "needs attention" queue.

## 7. Multi-user editing

**Decided (Oct 14): one central database, no device-to-device merging.**

- **Everyone works against the same Supabase database.** The CLI and files sync by pull and push, with per-record revision checks.
- **Two people editing the same record:** the second push is rejected with a clear conflict, never silently merged or lost. For a small team editing mostly different records, this is enough to start.
- **Live updates (planned):** the web app and the Obsidian plugin can subscribe to changes (Supabase Realtime), so others' edits appear within about a second. The plugin can then pull changed records on its own.
- **Live co-editing in one note** (cursors, simultaneous typing) isn't planned. If it's ever needed, it's a text-collaboration layer for the body only, added on top of this model.
- **Backup and history:** the `history` table keeps every revision. Optionally, a scheduled `surface pull` committed to a Git repository gives Git history and an always-current plain-file copy outside Supabase.

### Considered and set aside

- **A local database on every device with CRDT merging** (Automerge, Loro or Yjs, with a relay server). Research is in `docs/research/SYNC-TECH.md`. It was set aside Oct 14 (§3): it's the hardest part of the original design, and the MVP doesn't need it.
- **GitHub as the source of truth** (Oct 14 discussion). History, diffs and free hosting, but:
  - rules can't be enforced, because anyone can push anything;
  - Git's line-based merges can leave conflict markers inside front matter;
  - the team needs GitHub accounts and Git (CDB OS's failure);
  - there's no database to query;
  - renames create noisy commits.

  A CLI that checks before committing only enforces a convention, not a guarantee. GitHub stays useful as a backup target.
- **Dropbox / iCloud / Syncthing:** whole-file sync with conflict copies and no merging.

## 7a. Permissions and sharing

**Leaning (Oct 13).** Surface is for **small teams with high trust**, not large organisations. **The workspace is the permission boundary.** There are no Notion-style per-page permissions.

### Why the workspace is the natural boundary

- **Whatever you pull is on your disk as readable files.** You can't hide part of a checkout from someone whose computer holds it.
- **With a central database, per-record read rules are technically possible,** but rules about links and views that cross the boundary get complicated, and small teams don't need them.
- **The same model** is used by Git repositories, shared Obsidian vaults and Anytype spaces.

### Multiple workspaces

- **You can belong to several workspaces,** shown together in one app (like Slack teams or Anytype spaces), for example:
  - "Cody Design Build" (the whole team);
  - "Office" (the owners only);
  - "Smith Kitchen, with client";
  - your own **personal workspace**, created automatically for private notes.
- **"Private" means a different workspace,** not a hidden page.
- **Links between workspaces** work as plain links (open it if you have access). There are no live views or totals across workspaces.
- **Moving or copying a record to another workspace** is one action, for when something needs to be shared more widely or more privately.

### Roles within a workspace

| Role | Can do |
|---|---|
| Owner | Everything, plus members, billing, and deleting the workspace |
| Admin | Edit types, shared views, the sidebar and team skills |
| Member | Create and edit all records |
| Viewer | Read only |

- **Permissions are enforced by the database** (Postgres row-level security, written once for the generic tables; built):
  - members read and write records; owners and admins edit types;
  - viewers read only, and their pushes are rejected;
  - non-members see nothing.
  - *(Superseded Oct 14: signed changes checked by a sync server.)*
- **Agents act with their user's role.** A remote agent (the later MCP server) gets a token for one workspace with a chosen role.

### Clients and outside people

- **Rather than per-page permissions, share outward:**
  - **Publish a page or view** as a read-only web link (live or snapshot), like Notion's "share to web." Clients get what they need without joining.
  - Or create a small shared workspace for that client or sub.
- **Not planned:** per-page or per-field permissions.

### Honest limits (trade-off ledger)

- **Removing someone doesn't erase what's already on their computer,** just as with email or a shared Dropbox folder. They can no longer pull or push.
- **Trust is assumed within a workspace.** Anything a member can see, they can copy.

**Open:**

1. **Flagged for later discussion (Oct 13):** the member roles: which roles exist (Owner, Admin, Member, Viewer?), what each can do, and whether Member + Viewer is enough to start.
2. Should publishing to the web come with the first team release?
3. How does a record move between workspaces with its links and history?

## 8. The `.surface/` folder

**Decided (built).** A hidden folder at the checkout root, beside `.obsidian/`.

```
.surface/
  config.json   which workspace, the layout, partial-checkout filter
  state.json    each record's path, revision and file hash at the last pull (for status and push)
  types/        each type as readable YAML (written on pull; edit types with the CLI)
  views/        view definitions and sidebar.yaml (planned)
  comments/     comment threads as Markdown (planned; §2a)
```

The login session is stored per user in `~/.config/surface-cli/`, not in the checkout.

## 9. The app

**Leaning (Oct 14): no Surface desktop app to start.**

- **Desktop = Obsidian plus the Surface plugin** (§3a): Views tree, composite-page embeds, push on save, validation messages and type-aware properties.
- **Team = a web app** on the same Supabase database: sign in, browse the Views tree, edit records and pages, and see views. Its editor and views stack are open; earlier research (`docs/research/APP-TECH.md`: CodeMirror 6, TanStack Table, dnd-kit) still applies.
- **Agents = the CLI,** or files plus push.
- **A native Mac app comes back only if** the plugin can't meet the "feels like Bear" bar (§9 Visual style).

> **Superseded (Oct 14): a Tauri 2 Mac app** with a Rust core, file watching and a flags view as the first milestone. Obsidian supplies the desktop editor; the web app is the team's way in.

### Visual style

**Leaning.** Inspired by **Bear** and **Margin**: typography-led, one sparing accent colour, calm even for structured data. Applies to the web app and the plugin's panels. See `docs/DESIGN.md`.

## 10. Agents

**Decided:** bring your own agent. Surface doesn't ship one. **Decided:** files are the interface; no MCP server or API is required. The rest is **leaning**. Full design: `docs/AGENT-INTEGRATION.md`.

- **Any agent that can read and write files can work in a workspace:** Claude Code, Codex, Cursor, Gemini CLI, Copilot, Hermes and others. No agent lock-in.
- **Agents get knowledge from files, using the two open standards they already read:**
  - **`AGENTS.md`** at the workspace root: a short, stable entry point and five hard rules;
  - **Agent Skills** in `.agents/skills/`, copied to `.claude/skills/` for Claude Code.
- **Surface-shipped skills** (`surface-workspace`, `surface-types` generated from the workspace's types, `surface-views`, `surface-flags`, `surface-import`) are regenerated when the workspace changes.
- **Users and teams write their own workflow skills** in Surface, like notes. They sync with the workspace, so every teammate's agent gets the same playbook.
- **Problems are reported by `surface push`, `status` and `check`,** which agents read like anyone else.
- **Agents edit through the CLI, or by editing files and running `surface push`.** Both go through the same validation and revision check as everyone else's edits.
- **The `surface` CLI (built)** gives exact operations and immediate errors. Every pull writes `AGENTS.md`, a Surface skill and the types. MCP, local or remote, comes later for agents that can't run the CLI.

## 11. Business model

**Open (Oct 14).** The database is hosted, so the natural model is a hosted service: free for one person or a small workspace, paid for teams. Self-hosting on your own Supabase is possible. *(Superseded: a free local app plus paid sync.)*

## 12. Open questions

**Database and hosting**

1. Hosting long-term: Surface-hosted Supabase for everyone, a project per team, or self-hosted?
2. When to add live updates (Supabase Realtime) to the plugin and web app.

**Sharing and permissions**

3. The member roles in detail (flagged for later discussion, §7a).
4. Guests and clients: publish a page or view to the web, or a small shared workspace (§7a).

**Files**

5. The filename naming rule for duplicate titles, and filename churn on renames (§5). (The MVP appends a short ID to the newcomer.)
6. The front matter key: `id` or `surface_id`.
7. The `link:` layout when a record links to several parents (first one wins?).
8. Show reverse links in files (e.g. a read-only `linked_from:` list), or leave that to Obsidian's backlinks pane?

**Views and pages**

9. The tree's storage split: `parent` on records plus `.surface/views/sidebar.yaml` (proposed, §5a). One shared sidebar, or shared plus personal?
10. The exact syntax of view files and inline ` ```surface ` blocks (§5d); inline value syntax.
11. Should Markdown table column types be remembered, and where (§5c)?

**Types**

12. A fixed prefix for all IDs (e.g. `s_`), or none (minor; §4).
13. Where new records are created from the plugin: the current folder, or the type's folder (§5a).

**Clients**

14. Obsidian plugin scope for a first version: Views panel only, or embeds and push on save too?
15. The web app's stack and first screens.
16. Where user workflow skills live: `.agents/skills/` or a visible `Skills/` folder (`docs/AGENT-INTEGRATION.md`).

**Parked**

17. Importing existing vaults: in place or as a copy, huge vaults (`docs/IMPORT.md`). `surface push --new` already covers simple cases.

## 13. Not yet designed

Gaps identified Oct 13 (updated Oct 14), in suggested order:

1. **Agents and surfaces** (pillars 2 and 3 of the thesis). Bring-your-own-agent, the entry point and skills are now designed (§10). Still open:
   - Knowing which agent or person made an outside edit; approvals.
   - Agent-built views: how they're requested, rendered, saved and shared, and how they get live data.
   - Model choice and privacy (local models, your own API key).
2. ~~Permissions and sharing~~ designed (§7a) and enforced by row-level security in the MVP.
3. **Attachments and large files** (photos, PDFs, plans): likely Supabase Storage, pulled into the checkout next to the records; size limits, previews.
4. **Search:** full-text; possibly semantic search for agents; search across views.
5. **History, undo and trash:** the database keeps every revision, and `surface history` / `rm` / `restore` exist. Still open: what the plugin and web app show, and undo.
6. **The view system in detail:** the query language, formulas, rollups and each layout (format decided, §5d).
7. **Templates, recurring items, reminders and notifications;** whether agents replace automations.
8. **Security:** encryption at rest (Supabase), secrets in notes, API tokens for agents.
9. **Mobile:** what's possible with files on iOS and Android.
10. **Performance targets:** workspace size, pull time, query speed (and when a local index is needed).
11. **Onboarding:** first run, starter content.

## 14. Build plan

**MVP: built Oct 14** (`docs/MVP.md`). It's a Supabase types engine plus the `surface` CLI, used from Obsidian, with an 11-step end-to-end test.

**Next, in order (agreed Oct 14):**

1. **CLI: the `link:` layout and folder commands** (`surface mv`, folder rename, move by query).
2. **The `parent` field, `.surface/views/sidebar.yaml` and `surface tree`,** so agents can build and read the Views tree.
3. **The Obsidian plugin: the Views panel.**
4. **Composite pages:** live ` ```surface ` blocks and saved-view embeds in the plugin.
5. **Push on save** in the plugin, so Obsidian users never need the terminal.

Then: the web app for the team, and live updates.
