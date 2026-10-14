# Exploration: a central database, with files as a checkout

**Status:** exploration (Oct 13). Nothing here is decided. It's compared against the current model in `SPEC.md` §3 and §7.

## The idea

- **The source of truth is a database,** possibly a single central database in the cloud.
- **Surface "checks out" the workspace onto the computer** as Markdown files in folders, like a Git checkout.
- **Offline, or at any time,** people and agents create and edit notes and files locally. Surface syncs the changes back up.
- **It feels like Git** (clone, work locally, push and pull), but the truth is a database, not a repository.

## First, what's already the same

The current spec is already **database-first with files as a checkout**, locally:

- every device has a database that's the truth for that device;
- the Markdown files are generated from it and reconciled back into it;
- agents work on the files.

So the real question isn't "database or files." It's **where the truth lives and who decides when edits clash:**

| | Current model | This idea |
|---|---|---|
| Where the truth lives | A full copy on every device (CRDT), merged automatically | One central database in the cloud |
| Who decides on a clash | Every device merges the same way, so all copies end up identical | The server decides |
| The server's role | An always-on relay that stores and forwards changes | The authority |

## The options

### A. Every device decides (current spec)

- Each device holds a full copy of the database. Changes merge automatically (Automerge or Loro).
- A relay server stores and forwards changes, so offline teammates still catch up. The server never overrules anyone.
- Files are a checkout of the local copy.

### B. The central server decides (this idea)

- The cloud database (for example Postgres) is the one truth.
- Devices keep a local cache and the files checkout.
- Offline edits are queued as changes. On reconnect, the server accepts them, rejects them, or flags a clash.
- This is how Linear, Notion and Figma work. Off-the-shelf sync engines do it on Postgres: PowerSync, ElectricSQL, Zero. Supabase fits here too.

### B2. Central database, with a Git-style checkout (pull, edit, push)

**Raised Oct 13:** the "BuildBase v2" path: Supabase/Postgres with one generic `types` table, one generic `records` table and a `links` table, so access rules are written once and there's no new table per type.

- **The database is the one truth.** The team uses a web app.
- **Files are a checkout, not a live mirror:**
  - `surface pull` writes the workspace (or just some projects) as Markdown files;
  - people and agents edit them;
  - `surface push` sends the changes back.
- **Each file carries a revision number** in its front matter. On push, Surface checks it, validates the fields, and applies the change.
  - If the record changed in the database since the pull, that file is **rejected, like a rejected `git push`.** The agent pulls again and reapplies its edit.
  - Text bodies changed on both sides get a simple three-way text merge; if that fails, it's flagged.
- **Optional:** a watcher that pushes automatically on save, for Obsidian users.
- **What's dropped compared with the current spec:**
  - continuous automatic merging;
  - every device as an equal;
  - live sync of local files;
  - solo use with no account (unless there's a local-only mode);
  - offline use in the browser.
- **What's kept:**
  - agents editing real files;
  - Obsidian or any editor, between pull and push;
  - partial checkout;
  - "leave any time" (pull everything, walk away).
- **Why it's much simpler:** optimistic checks ("has it changed since you pulled?") replace CRDTs and the continuous reconcile engine. Agents handle a pull, edit, push loop well.

#### Solo work under B2

**Three options:**

1. **A cloud workspace for solo users too** (free tier). One system, but it needs an account and a connection.
2. **The same database, running locally:** SQLite or PGlite (Postgres running locally), with the same `types` / `records` / `links` schema, inside the desktop app. Same code paths. Going team = upload.
3. **Files are the truth for solo work** (recommended to explore):
   - The Markdown files *are* the workspace, and a local index is rebuilt from them for fast views and queries.
   - Type definitions live in `.surface/types/`. The CLI validates and flags drift.
   - No pull and push: you, Obsidian and agents edit files directly. The only clashes are on one machine, and they're rare.
   - **Going team** = `surface push` uploads the files into a cloud workspace. **Leaving a team** = pull everything and disconnect.
   - **It's CDB OS plus Surface's type system and CLI.** It fits the people who care most about files (solo, Obsidian-style users), while teams get the web app they need.
   - **The cost:** two engines (files as truth for solo, the database as truth for teams). The solo one is small: an index and a validator, not a sync engine. Both share the same file format, type definitions and CLI commands.

### C. Git itself

- Files in a Git repository, with a central remote; Surface commits, pulls and pushes automatically.
- **Already set aside:** Git conflicts are line-based text conflicts, there's no live co-editing, and the history fills with tiny automatic commits.

### D. Every device decides, plus a canonical server (a hybrid)

- Option A, plus an always-on server that acts as **the main copy:**
  - it always has the latest state;
  - it keeps backups and full history;
  - it checks permissions and rejects changes from people without the right role;
  - it powers web publishing and remote agents.
- Merging still happens on every device, so offline work and solo use are unchanged.
- **It feels like "one central truth" to the team,** without the server being the only place the data can live.

### E. Different truth for different users

- **Solo:** the local database is the truth; no cloud, no account.
- **Team:** a central database (B) or a canonical server (D).
- Moving from solo to team uploads the workspace.

## Comparison

| | A. Every device | B. Central server | D. Hybrid |
|---|---|---|---|
| **Works fully offline** | Yes | Yes for edits, but clashes are resolved only on reconnect | Yes |
| **Clashing offline edits** | Merged automatically; real field clashes are flagged | The server applies a rule (last write wins, reject, or flag) | Like A |
| **Text bodies edited by two people offline** | Merged character by character (CRDT) | **Still needs a text merge** (CRDT or three-way merge); a central database doesn't remove this | Like A |
| **Solo use, no account** | Yes | Only with a separate local mode (E) | Yes |
| **One obvious "latest"** | Every copy converges, but there's no single referee | Yes | Yes (the canonical server) |
| **Permission checks** | Signed changes, checked by every peer (harder) | Easy: the server simply refuses | Easy: the server refuses |
| **Partial checkout** (only some projects, guests seeing one job) | Hard: everyone holds the whole workspace | **Easy:** the server sends only what you're allowed | Possible, but harder than B |
| **Per-record read permissions** | Impractical | **Possible** | Hard |
| **Server-side validation** (the schema enforced centrally) | Every device validates | The server can be the enforcer | Every device, plus the server |
| **Running costs** | Small relay | A real database service, always on | A server, but a simpler one than B |
| **If the company disappears** | Data is complete on every device | The files checkout survives; the server needs self-hosting | Data is complete on every device |
| **Existing tools** | Automerge / Loro (younger) | PowerSync, ElectricSQL, Zero on Postgres (mature, used in production) | Automerge's sync server, Anytype-style nodes |
| **Complexity** | Merge logic on every device | Server, sync engine, plus offline clash rules | A plus a server |

## What a central database would really buy

1. **Partial checkout:** clone only the projects you work on. Big workspaces stay small on laptops, and a client or sub gets one job.
2. **Per-record permissions** become possible later, without everyone holding everything.
3. **Simpler to reason about:** "the server has the truth" is easy to explain and to debug.
4. **Mature tools** for the database half: Postgres with PowerSync, ElectricSQL or Zero (familiar from BuildBase on Supabase).

## What it would cost

1. **"No account, no cloud" for solo users** would need a separate local mode (E), which is effectively building two systems.
2. **Text still needs merging.** Two people editing a note's body offline still need a CRDT or three-way merge. The central database settles fields, not prose.
3. **The server becomes essential.** Running costs, uptime, and self-hosting become part of the no-lock-in story.
4. **Offline clashes are settled later, by rules,** not merged on the spot.
5. **The files checkout is the same work in every option:** watching files, three-way reconcile and flags. That part doesn't get easier.

## Assessment

- **The checkout idea is already in the spec,** and it's good. The open question is the authority.
- **For small, trusted teams, D (the hybrid) gives most of what's attractive about a central database:** one always-up-to-date main copy, backups, permission checks, web publishing and remote agents. It keeps offline merging, solo use with no account, and full copies on every device.
- **B becomes the better choice if** partial checkout or per-record read permissions turn out to matter. Examples: guests in one job, very large workspaces, or larger organisations later.
- **This is an expensive decision, so it should be tested, not argued.** The one-week sync test could compare two prototypes on the same files-and-reconcile layer:
  1. Automerge with a canonical server (D);
  2. Postgres with a sync engine such as PowerSync (B).

  Test offline clashes, text merging, partial checkout and permission checks.

## Open

1. How important is partial checkout (only some projects on a laptop; guests seeing one job)? This is B's strongest advantage.
2. Is "solo, no account" a must-have from day one? It favours A or D.
3. Should the test compare D and B side by side?
