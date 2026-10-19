# Surface Spec

The current design in one place. Last consolidated: Oct 16, 2026.

> **Current direction (Oct 14, decided): a headless foundation with many surfaces.**
> - **The database is the truth:** a mutable types engine for records, relationships, validation, permissions and history. It runs in Supabase (sync mode); a local mode on one computer with no account is leaning (`LOCAL.md`).
> - **Agents help humans do the work.** The foundation operates independently of any one interface.
> - **Markdown is the first and foundational surface:** `surface pull`, edit, `surface push`, with normalization and revision checks. There is no merge engine.
> - **Surfaces range from snapshots to interactive tools:** documents, PDFs, widgets, web interfaces, artifacts and canvases, inside or outside the web UI.
> - **The CLI is the core; the web UI is a visualizer** (decided Oct 17, §9). Every capability is a CLI operation first; the web UI, served by `surface serve`, renders records, views and sidebars. A first local version is built.
> - **Built today:** the Supabase types engine and CLI, including nesting, folder tools and saved navigation trees, and a first version of the web UI (a visualizer) in local mode. Other clients and integrations are planned.
>
> Earlier designs with a database on every device and CRDT merging are superseded.

- **How we got here:** the working notes in `docs/notes/` (DATA-MODEL, CONVENTIONS, SYNC), kept as design history.
- **Research:** `docs/research/`.
- **Local mode and sync mode:** `docs/LOCAL.md`.
- **Links and vaults:** `docs/LINKS.md`. Links in page text are stored by record id and shown by current name, so renames never break them; vaults are generated folders of Markdown, any number per workspace (built Oct 18).
- **Parked:** importing existing vaults (`docs/IMPORT.md`).

Status markers: **Decided**, **Leaning** (direction agreed, details open), **Open**.

---

## 1. Thesis

**Surface is an agent- and platform-agnostic place where people keep the artifacts and Markdown files their work needs, and share any part of them with their team or with people outside it.** (Decided Oct 17.)

- **Agent-agnostic:** any agent (Claude Code, Codex, Hermes, a local model, a script) works through the same CLI, files and API. No agent is built in or preferred.
- **Platform-agnostic:** no interface owns the work. The CLI is the core; the web UI, Obsidian, a generated HTML page or a PDF are all surfaces over it (§9).
- **Artifacts and Markdown, as needed:** Markdown for text that people and agents write and edit; HTML artifacts for what people need to see or act on (dashboards, reports, reviews, one-off editors), following Thariq Shihipar's "unreasonable effectiveness of HTML" (claude.com/blog, May 2026). Both are kept, typed and linked to the data, not left as loose files.
- **Share any part:** a workspace, a folder, a view, one record or one artifact, with teammates (members, roles) or with outside people (clients, subs) by a link or a guest invite. What they can do (see, comment, edit) is set per share, and the database enforces it.

Underneath, Surface is a headless, mutable database foundation: Notion's pages, structured data and relationships made independent of its interface. People need three things:

1. **Data:** shared, persistent records and relationships, with types and fields that users and agents can create and change as their work evolves.
2. **Agents:** assistants that organize, query and act on the data with people, reducing the need for dedicated software for every workflow.
3. **Surfaces:** ways for humans to view and interact with that data, suited to the task and the place where work happens.

The foundation holds the data and its meaning. A surface is where a human touches it. Storage, relationships, validation, permissions and history remain useful across interfaces.

### Surfaces: what the CLI creates

**Decided (Oct 18).** Surface is a local-first, headless foundation: a database on each computer and a CLI. Its job is to **create viewing surfaces wherever they make sense**, and keep them connected to the data. The web UI is one optional, useful surface; nothing depends on it.

Each surface has its own capabilities. The CLI knows what each can do and keeps the promise it makes: what a surface can't edit, it doesn't pretend to.

| Surface | Created by | Read | Edit | Changes reach the database | Live | Status |
|---|---|---|---|---|---|---|
| **Markdown vault**: open in Obsidian, VS Code, Zed, any text editor | `surface init` / `pull` | ✓ | ✓ text, front matter | automatically on save (`surface serve` or `surface watch`), or `surface push` | after pull | built |
| Same vault in an editor with its own format (Logseq, Morrow) | `surface init` | ✓ | ✓ | `push`, if the editor keeps `id`/`type`/`rev` | after pull | to test per editor |
| **Web UI** | `surface serve` | ✓ | ✓ fields, text, boards | directly | ✓ | built, optional |
| **Static artifact**: dashboard, portal, report, as plain HTML files | `surface artifact build` (planned) | ✓ | – | – (snapshot) | rebuild to refresh | planned |
| **Live artifact**: the same, talking to the API | `surface artifact build --live` (later) | ✓ | what it exposes | directly, validated | ✓ | later |
| PDF | from an artifact | ✓ | – | – | – | planned |
| Agent | reads the vault or `surface query --json` | ✓ | ✓ | `push` / `surface set` | ✓ | built |
| Hosted page, Slack canvas, other hosts | adapters (later) | ✓ | depends | depends | depends | direction |

Rules:

1. **Every surface is made by a command and can be made again.** Its definition (which records, which view, which template) is data, so an agent can rebuild it anywhere.
2. **Write-back always goes through the same check** (`push_record`): from a file, the web UI or a live artifact, bad values are refused the same way.
3. **A surface states its freshness.** Snapshots say when they were built; live ones say they're live.
4. **Lock-in test:** a surface must keep working without Surface where it can. A vault is plain Markdown; a static artifact is files that run on any host. Only live surfaces need Surface running.

**Publishing (planned).** `surface publish <artifact>` puts a static artifact somewhere people can open it, through swappable adapters: a folder, `rsync` to any SSH host (a Mac mini, a VPS), Cloudflare Pages, Vercel, Netlify, S3/R2. Provider settings and credentials live in config and the environment, never in the agent's head or the artifact. Every artifact carries a manifest (`artifact.yaml`: profile, data sources, built at, a fingerprint of the data, where it's published), so `list`, rebuilds and unpublishing work from files rather than a host's state. Publishing shows what data went in and flags secrets and personal details (access codes, emails, prices) before anything leaves the computer. Unguessable, unindexed links are v1 access control; per-person logins come later through the host (e.g. Cloudflare Access) or the sync layer. Detail: the artifact system draft (Oct 18), to be folded into `docs/ARTIFACTS.md`.

### Artifacts

**Decided (Oct 17), design open.** An artifact is a file an agent (or a person) makes for people to look at or use: usually one self-contained HTML page, sometimes a PDF or an image. In Surface an artifact is a record like any other, so it has a type, links (the job it's about, the view it was built from), permissions and history, and it can be shared.

- **Snapshot or live.** A snapshot holds the data from when it was made (a weekly report). A live artifact reads current records through the API, and its controls save edits through the same validated write path as `surface push` (a procurement board). This replaces Thariq's "copy as JSON" button: the edit goes straight into the data, checked.
- **Made by any agent.** The CLI gives an agent the data (`surface query --json`, a view's records with their fields and links) and stores the result (`surface artifact add`, planned). A skill teaches agents the pattern.
- **Shown anywhere.** In the web UI, in a browser by link, or embedded in a Markdown page like a view block.

Open (TODO.md): how a live artifact authenticates when opened outside the local server, sandboxing of artifact scripts, storage of large files.

### Sharing

**Decided (Oct 17), design open.** Anything can be shared, at any size: a workspace, a folder or sidebar section, a view, a record (with or without what's inside it), an artifact. Inside the team that's members and roles (§7a). Outside it, a share is a link or a guest invite to just that part, with see, comment or edit set per share. Shares are rows in the database; row-level security enforces them for every client, so an agent, the CLI and a link all see exactly the same thing.

### Why Markdown comes first

**Decided.** Markdown is the first and foundational surface because it is a shared working medium for humans and agents. It is the native working language of LLMs: text they can read, reason about and edit directly. People can use that same text in familiar editors. YAML front matter expresses typed fields and links; Markdown bodies express notes, context and instructions.

The checkout is more than an export or an escape hatch. A person can create a page or task in Obsidian, or an agent can write it as a file, then the CLI normalizes safe fixes, reports them, validates the values and adds the record to the database. Existing records follow the same edit-and-push path, with revision checks.

Markdown is a bridge to the foundation, not a requirement for every surface. A PDF can be generated from a query; a connected widget can work with records directly through authorized operations. Neither needs its own copy of the Markdown checkout.

### Why Surface and not just Obsidian

**Decided (positioning).** Obsidian's properties are loose: a status can be `Done`, `done`, `complete` or a typo, a date can be any text, and nothing checks them. That drift is fine for personal notes, but **it makes Obsidian mostly unusable as a business app**, because views, totals and agents can't trust the data.

**Surface adds a shared, typed foundation behind the files:**

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

**CDB OS demonstrated the file-and-agent workflow. Surface turns that into a shared foundation with trusted data and accessible human interfaces.** The team also needs:

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

- **The team needs a browser experience with simple onboarding.** The web UI, a visualizer served by the CLI, covers browsing (§9). Obsidian and the Markdown checkout remain first-class ways to work.
- **A central database is the truth** (Supabase; see §3 and `docs/notes/CENTRAL-DATABASE.md`). A browser has no local copy to merge.
- **Solo, account-free, local-only use is dropped.** Everyone signs in.

## 2. Principles

1. **Data is the foundation.** The surface is just where a human touches it.
2. **The database is the truth; files are a checkout.** The workspace lives in Supabase. Any machine can pull it as Markdown, read and edit it offline, and push changes back. *(Was "local-first, no account"; superseded Oct 14.)*
3. **Files are first-class.** Every record is also a plain Markdown file. People and agents can edit those files in any editor, then push. They're also the exit: your data is always readable without Surface. **Files are real Markdown that looks good in any text editor:** no hidden IDs in the body, no HTML, no custom layout syntax. Block-style editing is a UI feature (§5b).
4. **Many surfaces share one foundation.** The web UI, Markdown editors and generated interfaces are clients of the same data. Markdown stays plain and useful outside Surface; each surface chooses the interaction it needs.
5. **Fix only what's safe, report every fix, reject the rest.** On push, unambiguous fixes are applied and each one is reported, e.g. `Oct 20` → `2026-10-20`, or `done` → `Done`. Anything ambiguous, like a typo'd option, an unknown field or a stale revision, rejects that file with a clear message. Surface never quietly rewrites or discards someone's edit.
6. **Agents are users.** Their edits travel the same paths as a person's, and get the same validation, history and permissions.
7. **The structure can evolve.** People and agents can create and edit types, fields and relationships. The foundation supplies those capabilities independently of any particular screen or workflow.

## 2a. No lock-in

**Decided (principle).** This is a big part of why Obsidian is popular: your notes are yours, and you can leave any time. Surface must feel the same. It isn't about Obsidian. It's about people knowing there's no vendor lock-in. Obsidian, or any other notes app, is always an option if you want to leave.

### The rule

**Product requirement: everything a person or agent authors must be exportable as open, readable files, with nothing lost.** The database adds validation, history and collaboration. Today, `surface pull` exports checked-out records, schema copies and saved views. Complete export of future features and history remains planned. *(Oct 14: the database is now the truth. The promise moves from "files are always the only copy" to "a complete, plain-file copy is always one pull away". A scheduled pull committed to Git keeps one always current; see §7.)*

Every feature must fit one of three tiers. The table describes the portability design, including features not yet implemented:

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

The rule above still holds for *authored content*: your words, fields and links must remain exportable as readable files. The trade-offs are about *behaviour*: things that only work while Surface is running.

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

- **Planned: a "leave and come back" test**, to run automatically on builds:
  1. Build a workspace using every feature.
  2. Pull a full checkout.
  3. Check that every authored thing is present and readable in the files, and that it opens cleanly in Obsidian and in a plain text editor.
  4. Import the checkout into an empty workspace, and check that nothing changed.
- **Planned: a published, open file format spec** ("Surface Markdown"): how records, fields, links, types, views and comments are written. Anyone can build a tool that reads or writes it. People trust the format more than any promise.
- **Planned: a "Leave Surface" feature.** One action should make a workspace fully standalone:
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

- **There's no sync engine.** Each workspace has one database. The checkout's `.surface/state.json` (revisions and file hashes) is the only state kept with the files.
- **Pull and push, like Git, but per record:**
  - `surface pull` writes the database into files;
  - `surface push` sends edited or new files back. It validates each one and checks its revision, so a stale file is rejected rather than merged.
- **Two modes, one design (leaning, Oct 16; `LOCAL.md`):**
  - **Local mode:** the same database (Postgres, embedded with PGlite) runs on one computer. No account, fully offline.
  - **Sync mode:** the database is Supabase. Sign in, use any number of computers, and add a team.

  A workspace is in one mode at a time and moves between them by a straight copy. The files, CLI, app and agent guidance are the same in both.
- **A disposable local index may come later,** only if queries get slow. It's a cache rebuilt from the database, never the truth.

> Local mode isn't this superseded design. It has exactly one database, for one person on one computer, and nothing to merge.
>
> **Superseded (Oct 14): a local database on every device** (the device's source of truth, with CRDT merging between devices and an optional sync server).
> - It existed for four needs: fully offline work with queries, speed at huge sizes, live co-editing, and solo use with no account.
> - The MVP showed none of them are needed to start. Offline reading and editing already work through the checkout.
> - It was the hardest and riskiest part of the design: the sync engine, the merge technology and the spike.

## 3a. Clients: one foundation, several ways in

**Decided (product direction).** Headless means the data and its operations are usable independently of any interface. The CLI is the core; every interface is a surface over it (§9). It does not require a background daemon: the CLI talks to the database directly, and its validation and access rules protect the data. `surface serve` is optional and runs only while the app is in use.

```text
        Supabase foundation: types · records · relationships · views · history · RLS
                           authorized reads and writes
                       surface CLI (the core)
                  ┌──────────────────┼──────────────────┐
          Markdown checkout      Web UI            Other surfaces
                  │            (visualizer)          (planned)
          editors and agents   renders views,      widgets, artifacts,
                               records, sidebars   reports, canvases

          Read-only queries can also produce snapshot surfaces such as PDFs.
```

- **`surface`, the command-line tool (built):** auth, workspaces, types and fields, pull/push, record operations, queries, nesting, folders, saved trees and generated agent guidance. TypeScript on Node. See `cli/README.md`.
- **Markdown checkout (built):** the foundational surface for editors and agents. A signed-in CLI connects file edits to the database; reading and editing an existing local copy can happen offline.
- **Web UI (built, local mode):** a visualizer served by the CLI. It renders records, views and sidebars that the CLI defines (§9).
- **Obsidian plugin (planned):** a Views panel (§5a), live embeds, push on save, validation messages and type-aware properties. It extends the Markdown surface.
- **Browser experience (planned):** the web UI's hosted mode: team access without an install, meeting the onboarding bar in §1 (§9).
- **Local server (built, first version):** `surface serve`, the CLI's long-running mode. It serves the web UI on localhost and keeps the checkout current. Commands and agent runs are planned (§9).
- **Generated and external surfaces (direction):** reports, widgets, artifacts, web interfaces and canvases. Formats, supported hosts, scoped access and data connections remain open.
- **MCP (later):** an additional access path for agents that cannot run the CLI or see files.

Every connected surface must use the foundation's permissions and validation. A surface with editing controls writes back to the underlying records; a snapshot only presents data as it existed when generated. Individual surfaces do not need to reproduce the web UI.

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
- **It doesn't move the file.** The sidebar (§5a) can show the nesting; folders stay a separate choice.
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
  - `aliases`: Obsidian's convention; a built-in list on every record, used to resolve typed links (`LINKS.md`).
  - `tags`: Obsidian's convention, reused as-is.
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

**Organization model (Oct 17).** Three layers have separate roles: **files are checkout storage, the sidebar is navigation, views show data.** Records are database rows, shown as documents, as fields, or in views (§5d), whichever fits; Markdown is one way to see them. Supabase remains the source of truth. This model organizes one surface; other surfaces need not use files or a sidebar.

### Layer 1: files in real folders (storage)

- **Each record is one file in one folder.** Within a checkout there are no duplicate copies (they'd make Obsidian links, search and the graph ambiguous).
- **Default layout (decided, built): a folder per type.** Pages are in `Pages/`, tasks in `Tasks/`, and so on. The folder name is a type setting (`surface type edit task --folder "To-dos"`).
- **The user's own folders (built):** the `folder` layout. Each record has a `folder` value, set by where its file sits when pushed, by `surface new … --folder`, or by `surface set <record> folder=…`. Moving a file in Obsidian and pushing moves the record.
- **A layout arranged by link (built),** e.g. `link:project`. A task's file sits under its job: `Projects/Steiner Kitchen/Tasks/…`. Records without that link go to their type folder; with several links, the first one wins.
- **Organizing tools (built in the CLI):** `surface mv`, folder rename, and moving records by query. Human interfaces for these operations are planned.
- **Folders organize storage rather than define relationships.** The database stores a record's `folder` value, but folders are not separate records. Deleting a folder in Finder does not delete database records; files show as missing until restored with pull or records are intentionally deleted with `surface rm`.

### Layer 2: the sidebar (navigation)

**Decided (Oct 17).** The sidebar is organization only. **Arranging it never changes a record's fields.** It's where people put the records and views they use, in the shape that suits them.

**Entries:**

| Entry | What it is |
|---|---|
| **Folder** | A twirl-down holding whatever is placed in it |
| **Record** | Opens one record; can show its sub-pages (`parent`, §4) |
| **View** | A saved view (§5d). Either **opens** as a full page (table, board, calendar…) or **unfolds** to list its results in the tree |

- **The same record or view can be placed any number of times.** Position is only for the person reading the sidebar.
- **Removing an entry removes the link,** never the record.
- **"Under each":** an unfolding view can give every result the same children, where `this` means that result. Set up once, every new result gets them:

  ```
  Wiki                        ← folder
    How We Estimate           ← view (unfolds): every page, nested by parent
      Kitchen pricing
    Supplier List
  Jobs                        ← view (unfolds): every job
    Steiner Kitchen
      Pages                   ← view (unfolds): pages where job = this
      Tasks                   ← view (opens): a board, job = this
      Selections tracker      ← view (opens): a table, job = this
  ```

  Works for any type: recipes with Ingredients under each, clients with Contacts and Invoices.

**Dragging in the sidebar:**

- **Placed entries** (folders, records and views someone added) reorder, nest and duplicate freely.
- **Generated entries** (results of an unfolding view) stay where the view's filter and sort put them.
- **Dragging a generated entry into placed entries pins a link there;** the original stays.
- **Undo** (⌘Z, and Undo in the message after each change) covers every sidebar change.
- **Changing what a record belongs to** happens in its properties, in a board, or with **Move to…** (a command that picks a destination by name and applies the matching link or `parent` change). Never in the sidebar.

**Workspace and personal sidebars:**

- **Workspace sidebar:** shared by everyone in the workspace; owners and admins arrange it (§7a).
- **Personal sidebar:** each member's own, saved to their account so it follows them between devices. Anyone can arrange theirs.
- **Display is a personal setting:** two sections (Workspace, Personal), as in Notion, or one merged tree. Local mode (`LOCAL.md`) has one user and defaults to one tree.

**Storage:**

- **Both are saved views:** the workspace sidebar is the view `sidebar`; personal sidebars are views owned by one member (`views.owner`, migration 0005). Personal data views work the same way.
- **In the checkout,** `.surface/views/sidebar.yaml` holds the workspace sidebar and `.surface/views/personal/sidebar.yaml` the signed-in member's own (with their personal views beside it). Both are readable and agents can edit them.
- **Nesting lives on the records** (the `parent` field). It's data; the sidebar only displays it.

**Built (Oct 17):** both sidebars, in the CLI (`surface tree [--personal]`, `tree init --personal`) and the app:

- view entries that open full-page or unfold (`unfold: true`), with `each` under every result and `label:` to rename an entry;
- placed entries drag to reorder, nest and move or copy between sections (⌥ copies), with a line or box marker and a tag next to the cursor saying what the drop will do;
- generated entries can't be rearranged (the tag says why) but pin a copy when dropped on placed entries;
- menus: add a folder, record or view; rename; duplicate; copy to the other section; switch a view between open and unfold; remove from sidebar (never deletes the record or view);
- the workspace section is arranged by owners and admins only; everyone arranges their own;
- the display setting (two sections or one tree) in Settings, saved in the personal sidebar as `display:`; one tree by default when you're the only member;
- undo for every sidebar change (⌘Z, or the toast's Undo).

### Layer 3: views and composite pages (data)

- **Views are where data work happens:** a saved view opens full-page as a table, board, list, calendar or gallery, with tabs between its layouts (§5d). Editing a cell edits the record; dragging a board card sets the field the board groups by. A drag never leaves the view it started in.
- **A page can also mix text, embedded live views and embedded records:** a paragraph, then this job's open tasks as a table, then more text. The underlying records become building blocks, with their Markdown checkout remaining readable.
- **The embeds stay real Markdown,** so the page reads fine without Surface (§5d).

### Notes and types

**Decided:**

- **Every record has a type. The default is page.** A page has a title and a body, and no required fields. Folder and Zettelkasten users can live entirely in pages.
- **New files found in a checkout** are listed by `surface status` and imported with `surface push --new`. Each one uses the `type:` in its front matter, or page if there isn't one.
- **Changing a page into a task later** is one action, and it keeps the same ID, links and history (§4).

> **Superseded (Oct 14):**
> - "Surface never invents folders or moves files on its own": the default is now a folder per type.
> - "The sidebar is a page of links" (`Sidebar.md`): replaced by the sidebar (§5a), with its arrangement in `.surface/views/sidebar.yaml`.

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

## 5d. Views render the data

**Decided.** Views are renderings of records: queries shown as tables, boards, calendars, galleries or other layouts. The web UI, a plugin or a generated surface can render them. Markdown is the foundational editable surface; the database is the truth. Rich interactive views do not need to be encoded as Markdown layouts.

- **A view = a query plus a layout:** which records, filtered, sorted and grouped, shown as a table, board, list, calendar, Gantt chart or gallery. One view can offer several layouts of the same query, as Obsidian Bases does.
- **In planned interactive views, controls edit the underlying records:**
  - dragging a card to another board column changes its `status`;
  - dragging a Gantt bar changes its `start` and `end`;
  - editing a table cell updates the database record; its checkout file reflects that change on pull.
- **A saved board stores its definition; its results are computed** (tier 3, §2a). Reading a view does not rewrite its definition or the files of the records it displays.
- **Authored through a UI or by an agent:** people can pick types, filters, grouping and layouts in the planned app; agents can author readable definitions. The CLI already supports saved tree definitions.
- **This is the Obsidian Bases idea taken further.**
  - **Bases:** a view is a YAML definition generated over notes' properties. Obsidian 1.14 (Sep 2026) added a native Kanban layout for Catalyst supporters.
  - **Surface goes further** with richer layouts (Gantt, dependencies, rollups), team sync, and agent-built views.

### Standalone Airtable-style data surface

**Decided (Oct 18, clarified): build a standalone, interactive and editable data surface with Airtable-style table usability.** This is another surface over the Surface foundation, separate from the existing writing/navigation app. It opens directly at its own URL/window and is useful without first opening a page, creating a saved view, or navigating the existing app's sidebar. Navigation from the existing app can be added later. The first delivery is a local standalone web UI.

- **Workspace → type/table → saved view:** show every accessible type and its records, including types with no records or saved views yet. Types appear as tables (Contacts, Organizations, Jobs, Tasks, and so on); named views select and arrange those records. Provide workspace switching, type/table navigation and record detail editing inside this surface.
- **Reusable implementation:** the React Data Grid work in the existing app is groundwork, not completion of this standalone surface. Reuse grid interactions, typed editors and the Surface API where appropriate without requiring the writing app's shell. React Data Grid is the current implementation; Glide remains a candidate to evaluate against Airtable-style interaction and appearance. The component choice does not determine the surface's product boundary.
- **Grid interactions:** typed cell editing, keyboard navigation, copy/paste, row selection, column resizing and reordering, frozen columns, filtering, multi-column sorting and grouping. Bulk edits use Surface's validation and revision checks and report rejected or conflicting changes.
- **Saved configurations:** a named view remembers its query, sort, grouping, visible columns, column order and widths, frozen columns, and row height/display preferences. Several views can show the same records without making copies. Record details open within the standalone surface; editing a body can reuse the Markdown editor without navigating to the writing app.
- **Personal and shared:** use the existing personal/workspace view ownership and permissions. Saved personal configurations follow the account between computers in sync mode; shared configurations belong to the workspace. Temporary adjustments do not silently overwrite a shared definition.
- **Airtable table parity is the target, not a claim of current completeness.** Track explicit acceptance criteria for cell/range editing, keyboard navigation, multi-cell copy/paste and fill, typed field creation/editing, select and relation pickers, row create/duplicate/delete, record detail expansion, column controls, filters, sorting, grouping, summaries, search and personal/shared saved views. Formula and rollup support requires foundation work as well as UI; define and track those gaps rather than substituting static imported values. This target concerns Airtable's table workflows, not every Airtable product feature.
- **Independent entry point, shared foundation:** the standalone surface and writing app share types, records, relations, view definitions and permissions. Neither keeps a separate authoritative copy. Grid components may also render app table views and embeds; that reuse does not make the standalone surface a tab inside the writing app. Board, list and calendar remain other layouts and do not substitute for table parity.
- **Same data path in both database modes:** edits go through Surface's API/store and existing validation, permissions, history and conflict handling, whether the database is Supabase or the planned local store. View definitions remain exportable and editable by agents.

### Where view definitions are kept

**Built for saved definitions; richer layouts planned.** A view's definition is authored content, so it must remain exportable under the no-lock-in rule (§2a):

- **Each saved view lives in the database and is pulled as a readable file**, for example `.surface/views/due-this-week.yaml`, with a format marker. File edits return through push with revision checks. The sidebar tree is implemented; the richer layout sketch below is a proposal.
- **Agents can read and write view files** (taught by the generated Surface skill), and leaving keeps them. The planned "Leave Surface" action will convert compatible views to `.base` files.
- **Saved display configuration** (including column widths) belongs to the named view as above. **Transient display state**, such as scroll position, temporary search and collapsed groups, can remain on the device; opening or browsing a view does not rewrite its saved definition.

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
   Other editors show it as readable text. The planned app or plugin renders it live, and `this` means the page it's on.
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

### The sidebar is a page too (superseded Oct 14 by the sidebar, §5a)

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
2. *Decided (Oct 17): a workspace sidebar plus a personal one, shown split or merged by personal setting (§5a).*
3. Should a quick filter be shareable as a link without saving it as a view?

## 6. Keeping files and the database in step

**Decided (Oct 13), built (Oct 14).** Files are generated from the database. Edits come back by an explicit push. There's no continuous two-way merging.

### Stage 1 (built): generated files, plus an explicit push

- **`surface pull` writes every record as Markdown** and rewrites files whose records changed. Renamed records move their files and rewrite every link to them. Deleted records' files are removed.
- **Edits come back through:**
  - the CLI (`surface new`, `surface set`);
  - **editing a file, then `surface push`** (from a terminal, an agent, or later the Obsidian plugin on save);
  - later, the web UI, browser experience and other authorized interactive surfaces.
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
| `link:<field>`: under the linked record, e.g. tasks under their job | built |
| `--only task,project`: a partial checkout | built |

- **Each checkout picks its own layout.** An agent's checkout can differ from yours.
- **Push works in any layout,** because files are matched by `id`, not by path.
- **One rule:** within one checkout, each record appears **once**.

### Stage 2 (not planned): live two-way files

A file watcher with continuous three-way merging. It's only worth building if push on save turns out not to be enough. Push on save is planned in `surface serve` (`LOCAL.md` §5) and in the Obsidian plugin. The data model wouldn't change.

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
- **Live updates (planned):** the web UI, browser experience, plugin and other connected surfaces can subscribe to database changes. The refresh behavior and latency target remain to be validated. The plugin can then pull changed records on its own.
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

**Decided (Oct 17).** Anyone can create as many workspaces as they like and share each one with whoever it's for: a whole team, a few people, one client, or nobody.

- **Create:** `surface workspace create <name>` or from the app's Share panel (built).
- **Local → your cloud → share (built, Oct 18; `CLOUD.md`):** a workspace starts on one computer; `surface cloud setup` connects the user's own Supabase project and syncs it; `surface share device` gives a one-line `surface join` code for the user's other computers, `surface share invite <email>` (or the app's Share panel) one for another person. The code carries the project URL, publishable key, workspace and email, no secrets. Surface has no hosted service.
- **Share (built, Oct 17):** invite people by email with a role: `surface share invite <email> --role member`, or the app's Share panel. Owners and admins invite, change roles and remove members. Invitees see pending invites in the Share panel or `surface workspace invites` and accept with Join or `surface workspace join <id>` (migration 0005: `invites`, `accept_invite`). Membership and roles are enforced by the database.
- **Each workspace is separate:** its own types, records, views, workspace sidebar and members. Each member also has their own personal sidebar in it (§5a).
- **Local and sync:** a workspace in local mode lives on one computer and has one user. Sharing it means turning on sync first (`surface sync enable`, `LOCAL.md` §6), which keeps every ID, link and revision.
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
4. Invitations: email links, or sharing a code; what someone sees before they accept.

## 8. The `.surface/` folder

**Decided (built).** A hidden folder at the checkout root, beside `.obsidian/`.

```
.surface/
  config.json   which workspace, the layout, partial-checkout filter
  state.json    each record's path, revision and file hash at the last pull (for status and push)
  types/        each type as readable YAML (written on pull; edit types with the CLI)
  views/        saved view definitions, including sidebar.yaml (built)
  comments/     comment threads as Markdown (planned; §2a)
```

The login session is stored per user in `~/.config/surface-cli/`, not in the checkout.

## 9. The CLI is the app; the web UI is a visualizer

**Decided (Oct 17).** Surface is, at its foundation, a viewing surface over the data. Its core is the `surface` CLI: every capability (records, types, fields, views, sidebars, sharing, import) exists there first and is usable by people and agents without any interface. The web UI is a **visualizer** of that core: it renders the data and the views the CLI defines, so a person can see and navigate the work.

Rules that follow:

1. **CLI first.** A feature exists when the CLI (and the database behind it) can do it. The web UI may only render it or call the same operation. No capability lives only in the web UI.
2. **Defined in data, not in the UI.** Views, sidebars, layouts and type display are definitions (`.surface/views/*.yaml`, type rows) that agents write. The web UI draws them; it doesn't own them.
3. **Agents configure, the UI shows.** Creating types and fields, arranging the sidebar and building views is done by asking an agent or running a command. UI editors for these are conveniences at most, and aren't extended.
4. **No new web UI features while this holds.** Bug fixes, and rendering of what the CLI already defines, only.

What the web UI may still edit, and how far (text, field values, board drags), is an open question in `TODO.md`.

> **Superseded (Oct 17):** the Oct 14 framing of a "dedicated Surface app" as a first-class client with two roles, everyday work (Obsidian-like) and workspace management (types, fields, teams, permissions without the terminal). It pulled the product toward an opinionated UI app; management belongs to the CLI and agents.

### How the web UI runs

**Decided (Oct 14): a web page, in two modes from one build. An Electron shell is planned for later.** It's served by the CLI (`surface serve`), and adds no logic of its own.

| Mode | How it runs | What it can do |
|---|---|---|
| **Local** | `surface serve` runs a small server on the person's machine. The app is a page on `localhost`, installed as an app (Omarchy web apps, Chrome install, Safari "Add to Dock"). | Everything in hosted mode, plus the Markdown checkout (keep it current, push on save), Surface commands, and launching the person's own agents in the checkout. |
| **Hosted** | The same build served from the web. Teammates open a link and sign in. | Records, pages, views, types and team management against Supabase. No files, shell or local agents. |

- **Platforms:** Mac and Linux first; Windows works through the same browser install, at lower priority.
- **The app talks to two things only:** Supabase (data, validation, permissions, live updates) and, in local mode, the local server's API (files, commands, agents). Features that need the local server are disabled, not hidden, in hosted mode.
- **The local server is the CLI.** It runs the same code as `surface` and is its long-running mode. It listens on localhost only and requires a per-session token, with Host and Origin checks. Shell commands are limited to an approved list and shown before they run.
- **Shared code:** a `core` package (Markdown, normalization, queries, the sidebar, pull and push) used by the CLI, the local server, the app and a future Obsidian plugin.
- **Why web first:** the fastest way to build and change (instant reload, no packaging, signing or update pipeline), one interface for both modes, and it matches how David runs apps on Omarchy. The same pattern as Jupyter or DeepSeek Harness (`dsh web`).
- **Electron (planned):** wraps the same page and starts the same server inside itself, with no interface rewrite. It comes in when one of these is needed: a one-download install for non-technical Mac users who need local files or agents; a global capture hotkey or menu-bar presence; or Mac polish beyond what installed web apps allow.

### Built so far (local mode)

Built before the Oct 17 decision; kept, but not extended. The CLI equivalents are listed in `app/README.md`.

`app/` (React, CodeMirror 6, Vite), served by `surface serve`:

- **Sidebar:** workspace and personal sections (or one tree) as in §5a: placed and generated entries, view entries, pinning, menus, undo. Slides away with ⌘\\.
- **Editor:** live preview. Markdown markers step aside except where the cursor is. It renders headings, emphasis, inline and fenced code, links, `[[wikilinks]]` (with title completion), #tags, task checkboxes, lists, quotes, callouts (`> [!note]`), dividers and images (`![](…)`, `![[…]]`). Slash menu for blocks; shortcuts for bold, italic, code, tasks and headings. Hovering a block shows a ⋮⋮ handle: drag to move the paragraph, heading, list item, quote, table or code block, click to select it; ⌥↑/⌥↓ move lines. A move is a text edit, so the file stays plain Markdown.
- **Page:** a title above typed properties (select, multi-select, date, checkbox, number, text and link pickers), parent breadcrumbs, pages inside, and links from other records. A leading `# Title` heading is hidden while editing and kept in step with the title in the file.
- **Groups:** a sidebar group opens as a table of its records.
- **Views (full page):** a saved view opens as a page with layout tabs: **table** (sort by any column, edit cells in place, add rows), **board** (columns by a select or checkbox field; dragging a card sets that field, and the slot says what it will set), **list**, and **calendar** (month grid by a date field; dragging an item to a day sets the date). A filter box narrows by title. New records start with the view's simple conditions filled in (`status=Doing`, `job=this`). Under a record (`each`), `this` is that record, shown as a breadcrumb.
- **View editor:** pickers for type, conditions (field, is / is not / contains / before / after, value; `this` for links), sort, layouts (board field, calendar date, table columns) and who sees it (everyone, or only me). It writes the same definition as `.surface/views/<key>.yaml`.
- **Records by type:** a type opens as a **document** (fields above the text) or as **fields** (properties first, notes on request) for things like contacts and budget lines. Set in Settings or `surface type edit <key> --display fields`.
- **Move to…:** changes data explicitly. Pick a target, then what it means: set a link field that points to the target's type, or put it inside (parent).
- **Undo:** ⌘Z / ⇧⌘Z for sidebar edits, board and calendar moves, cell edits, Move to… and deletes (outside the editor, which keeps its own undo). Each change shows a toast with Undo.
- **Share and Settings:** members, roles, invites, your workspaces and creating one; sidebar display and type display.
- **Find:** ⌘K finds by title and full text, or creates a page.
- **Saving:** autosave through the same write path as `surface push`, with revision checks. A conflict offers keep mine or use theirs. Changes made elsewhere arrive within a few seconds.
- **Look:** light and dark, one accent, system fonts.

In this version the app reaches Supabase through the local server, using the CLI's sign-in. Hosted mode needs the app to talk to Supabase directly (planned). Also built: **live views in pages**, written as plain Markdown so the file stays readable anywhere:

```surface
view: job-tasks
```

(or `![[Job tasks]]` alone on a line). It renders as the view, with tabs, cell editing and board drag, and `this` is the page it sits on. The slash menu inserts one. Put the cursor inside to edit the source. **GFM tables** render as tables, and clicking a cell opens the source at that cell. **Pasting or dropping an image** (or a PDF) saves it to an `attachments/` folder next to the record's file and links it by a relative path, so it also shows in Obsidian. **Types and fields** (Settings → Edit types and fields) add types, and add, rename, reorder or remove fields, including select options and link targets. Owners and admins edit; the database validates the same structure the CLI writes. Attachments are local files in the checkout and don't sync to Supabase yet.

**Several workspaces:** the workspace menu (top of the sidebar) lists every workspace you belong to and switches between them. Each has its own checkout folder; the CLI records them in `~/.config/surface-cli/checkouts.json`, and opening a workspace that isn't on this computer yet checks it out to `~/Surface-<name>`.

Not built yet: shell commands and agent runs, syncing attachments to storage.

**Open:** whether `surface serve` starts at login (launchd on the Mac, a systemd user service on Linux) or on demand. The earlier research in `research/APP-TECH.md` is input, not a decision to restore a Rust core, local database or CRDT engine. Supabase remains the truth.

**Obsidian remains a supported surface.** The planned plugin improves its checkout experience with the Views panel, composite-page embeds, push on save and validation. It's another visualizer over the same core.

> **Superseded:** the earlier direction that the desktop would be Obsidian-only and a dedicated app would be considered only if the plugin fell short.

### Visual style

**Direction.** Inspired by **Bear** and **Margin**: typography-led, one sparing accent colour, calm even for structured data. The management tools deserve the same care as the editor. See `DESIGN.md`.

## 10. Agents

**Decided:** bring your own agent. Agents help humans work with the shared foundation: changing records, defining types and relationships, querying information and producing useful surfaces. Surface does not require one particular model or agent provider. Full design: `AGENT-INTEGRATION.md`.

- **Markdown is the foundational bridge.** Agents can read and edit the same documents people work with. Reading a local checkout needs no API; connecting changes to the database requires the signed-in CLI.
- **The CLI is the preferred exact interface (built):** records, queries, types, fields, folders and trees. File edits followed by push are equally supported. Both paths use the database's validation, revision checks and permissions.
- **Every pull generates guidance (built):** `AGENTS.md`, `.agents/skills/surface/SKILL.md`, a copy in `.claude/skills/surface/`, and `.surface/types/*.yaml`.
- **Agents can produce surfaces beyond Markdown (direction):** a PDF snapshot, a focused widget, an artifact, a web interface or content in another host. Live connections, editing, hosting and access for those surfaces remain to be designed.
- **Problems are reported by `surface push`, `status` and `check`.** There is no automatic file watcher or persistent flags directory yet; push on save in `surface serve` is planned (`LOCAL.md` §5).
- **Team workflow skills (planned)** capture reusable ways of working. Storage, editing and sharing in the app remain open.
- **MCP (later)** adds access for agents that cannot run the CLI or see files; it is not implemented today.

## 11. Business model

**Open (Oct 16).** With local mode (`LOCAL.md`), a natural model is local free and sync paid: one computer at no cost, a hosted database for several computers and teams. Self-hosting on your own Supabase is possible.

## 12. Open questions

The working checklist of everything still to decide is `TODO.md`; tick items there and record decisions here.

**Database and hosting**

1. **Decided (Oct 18):** no hosted service. Each user or team connects their own Supabase project; Surface ships with none (`CLOUD.md`).
1a. Local mode's open questions: `LOCAL.md` §10.
2. When to add live updates to the plugin, browser experience and other connected surfaces.

**Sharing and permissions**

3. The member roles in detail (flagged for later discussion, §7a).
4. Guests and clients: publish a page or view to the web, or a small shared workspace (§7a).

**Files**

5. The filename naming rule for duplicate titles, and filename churn on renames (§5). (The MVP appends a short ID to the newcomer.)
6. The front matter key: `id` or `surface_id`.
7. The `link:` layout when a record links to several parents (first one wins?).
8. Show reverse links in files (e.g. a read-only `linked_from:` list), or leave that to Obsidian's backlinks pane?

**Views and pages**

9. Sidebar format details: how placed and generated entries, pins and personal sidebars are written in the view files (§5a).
10. The exact syntax of view files and inline ` ```surface ` blocks (§5d); inline value syntax.
11. Should Markdown table column types be remembered, and where (§5c)?

**Types**

12. A fixed prefix for all IDs (e.g. `s_`), or none (minor; §4).
13. Where new records are created from the plugin: the current folder, or the type's folder (§5a).

**Clients**

14. Obsidian plugin scope for a first version: Views panel only, or embeds and push on save too?
15. Whether `surface serve` starts at login or on demand (§9); how much the web UI may edit (`TODO.md`).
16. Where user workflow skills live: `.agents/skills/` or a visible `Skills/` folder (`docs/AGENT-INTEGRATION.md`).

**Parked**

17. Importing existing vaults: in place or as a copy, huge vaults (`docs/IMPORT.md`). `surface push --new` already covers simple cases.

## 13. Not yet designed

Gaps identified Oct 13 (updated Oct 14), in suggested order:

1. **Agents and surfaces** (pillars 2 and 3 of the thesis). Bring-your-own-agent, the entry point and skills are now designed (§10). Still open:
   - Knowing which agent or person made an outside edit; approvals.
   - Generated and external surfaces: how reports, widgets, artifacts and canvases are requested, created, saved and shared; which are snapshots or connected; and how connected surfaces read or edit data with scoped access.
   - Model choice and privacy (local models, your own API key).
2. ~~Permissions and sharing~~ designed (§7a) and enforced by row-level security in the MVP.
3. **Attachments and large files** (photos, PDFs, plans): likely Supabase Storage, pulled into the checkout next to the records; size limits, previews.
4. **Search:** full-text; possibly semantic search for agents; search across views.
5. **History, undo and trash:** the database keeps every revision, and `surface history` / `rm` / `restore` exist. Still open: what the web UI, plugin and browser experience show, and undo.
6. **The view system in detail:** the query language, formulas, rollups and each layout (format decided, §5d).
7. **Templates, recurring items, reminders and notifications;** whether agents replace automations.
8. **Security:** encryption at rest (Supabase), secrets in notes, API tokens for agents.
9. **Mobile:** what's possible with files on iOS and Android.
10. **Performance targets:** workspace size, pull time, query speed (and when a local index is needed).
11. **Onboarding:** first run, starter content.

## 14. Build plan

**MVP: built Oct 14** (`MVP.md`). The Supabase types engine plus `surface` CLI implements the foundational Markdown surface. `cli/test/e2e.ts` defines the end-to-end scenarios, run against a local database or any Supabase project.

**Built beyond the initial MVP** (e2e: 16 scenarios; app: `app/qa/qa-views.mjs`, 24 browser checks):

1. `link:` layouts and folder tools: `surface layout`, `mv`, `folder rename`, `folders`, and moving records by query.
2. Nesting and saved trees: `parent`, `.surface/views/sidebar.yaml`, `surface tree`, and migration 0004.
3. The app's first version in local mode: `surface serve` and `app/` (§9).
4. Sidebars, views and sharing (Oct 17, migration 0005): personal views and sidebars, full-page views, the view editor, record display per type, invites and roles, undo.

**Previously identified next work on the Markdown surface (planned):**

1. The Obsidian plugin's Views panel.
2. Composite pages: live ` ```surface ` blocks and saved-view embeds.
3. Push on save and inline validation, so file editing does not require terminal use.

**Local mode (leaning):** the PGlite spike, then a store interface in the CLI and `surface init --local` (`LOCAL.md` §8–9).

**Product work also planned:**

- **Agents and the CLI (next):** the pillar that fell behind. Everything the web UI does must also be a CLI operation (the gaps are listed in `app/README.md`), plus a second surface that isn't the web UI (an agent producing a report or dashboard from a view) to prove the core stands alone.
- The web UI: built Oct 17 (views, sidebars, live view blocks, workspaces). Frozen apart from fixes and rendering what the CLI defines (§9). Its hosted mode for team access comes later.
- **Standalone data surface (clarified Oct 18, §5d):** deliver an independently accessible Airtable-style local web UI for all workspace types and records, with its own type/table navigation and saved views. Reuse the existing grid work and API; track table-parity gaps explicitly. Keep definitions and operations available to CLI/agents. Optional navigation from the writing app can follow; this is a separate surface, not merely an upgrade to its table tab.
- Additional surfaces, from generated reports to interactive widgets, artifacts and integrations in other hosts.


