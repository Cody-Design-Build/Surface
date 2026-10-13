# Multi-user Editing, Sync, and the App

Deep-dive working doc, started Oct 12. These three are linked: the feel we want decides the sync design, and the sync design decides what the app has to be.

## 1. The feel we want

David: multi-user should work like **Notion desktop** or Anytype's new app, **AnyTwo**.

What that means in practice (to confirm):

- Other people's edits appear within about a second, with no save button and no "pull."
- You can see who else is on a page.
- Offline edits merge automatically when you reconnect. There are no conflict dialogs for text.
- Agents are collaborators too: their edits arrive through the same path as a person's.

### Prior art

**Notion** (cloud database, local cache):

- The server is the source of truth, and the desktop app caches pages.
- Offline mode shipped in August 2025. You mark pages "available offline"; paid plans also download the 20 favorite and 20 most recent pages. For databases, only the first 50 rows of the first view are available offline.
- Text merges automatically using CRDTs. Property values don't: if you set a status offline and a teammate changes it too, one value silently wins.
- Lesson: excellent text merging, weak field merging, and offline is partial because the cloud is the truth.

**Anytype** (local-first, any-sync):

- Each device has a full local copy.
- Changes sync peer-to-peer and through backup nodes, using CRDTs, with end-to-end encryption.
- No server is the source of truth; every device is.
- **AnyTwo:** a completely new app announced at an Anytype town hall (around Sept 2026), with a faster UI, better text editing and faster development. The old Anytype will still be supported. Details beyond that are unverified, so research is still needed.

**Others to study:** Linear (local-first sync engine on a central server), Figma (a central server ordering operations), Obsidian Relay (live CRDT sync on top of a files vault), ElectricSQL / PowerSync / Zero (database sync engines).

## 2. The core sync question

Surface's files are the storage. Live multi-user editing needs something finer than whole files moving between machines. The options:

| | How it works | Live | Offline | Files stay truth |
|---|---|---|---|---|
| **A. Sync the files** (git, Dropbox, Syncthing) | Whole files copied between machines | ❌ minutes, conflict copies | ✅ | ✅ |
| **B. Sync the changes, write files locally** | Each record is a shared-editing document (Yjs, Automerge or Loro). Edits sync as small operations through a relay; every machine writes the merged result to its own `.md` files; edits made outside Surface are diffed back in | ✅ | ✅ | ✅ on every machine, kept in step by the change log |
| **C. Central server** | A server database is the truth; clients cache it and write files locally | ✅ | partial (Notion-like) | ❌ files are a copy |
| **D. Database sync engine** | A local SQLite synced by an engine (ElectricSQL, PowerSync, Zero); files generated from it | ✅ | ✅ | ❌ files are a copy |

**E. GitHub (or any git remote) as the central source of truth** (David, Oct 12). The Surface app pushes and pulls.

- **What it gives for free:**
  - durable hosting and full history;
  - accounts and repo-level permissions;
  - backups, and offline work by default;
  - agents already speak git;
  - no server of our own to run;
  - not locked to GitHub: Gitea, Forgejo or a bare git server work the same way.
- **Fixing CDB OS's conflict stops:** git lets an app register its own *merge driver* through `.gitattributes`. Surface can install one for `.md` files that merges front matter field by field and the body paragraph by paragraph. Only the same field, or the same paragraph, changed on both sides needs a decision. That removes the "sync stops and waits for a human" failure.
- **Limits:**
  - **Speed:** near-live at best. Each push or pull takes about 1–3 seconds. With several people pushing, pushes get rejected and have to retry. GitHub has API and push rate limits. Realistically, others' changes appear within about 5–15 seconds for a small team. No live co-typing.
  - **No push notifications to the app:** GitHub webhooks need a server to receive them, so clients poll.
  - **Large files:** GitHub warns above 50 MB and blocks above 100 MB per file, and soft-limits repos to a few GB. Photos and PDFs need Git LFS (paid storage) or somewhere else.
  - **Permissions are per repo:** everyone in a repo sees every file. Guest access to one job means a separate repo, or nothing.
  - **Accounts:** every user needs a GitHub account, unless Surface acts through a GitHub App on users' behalf.
- **Combining with B:** use GitHub as the durable source of truth and history, with an optional live relay for real-time editing when people are online. The relay commits to GitHub regularly. If the relay is down, Surface falls back to plain push and pull: slower, never broken.

**Leaning (to discuss): E first, then E + B.** v1: GitHub as the source of truth, with a structure-aware merge driver (near-live, a few seconds). v2: add the live relay (B) on top for Notion-like co-editing, without changing the storage. B on its own is the only option that keeps files as the real thing on every machine and still feels live. Field-level merging (one field per line, plus a per-field rule for edits at the same moment) avoids Notion's silent property overwrites.

### Clarification: B's relay is always on

David's concern: if A edits, then closes the laptop, and B opens theirs while A is offline, does B miss the update?

- **Pure peer-to-peer** has exactly that problem: changes move only when both machines are online at the same time.
- **B's relay is a server that's always on.** It stores every change it receives (store-and-forward). A's edits reach the relay before A goes offline, and B gets them from the relay later. A never needs to be online again.
- **General rule:** any setup where people aren't online at the same time needs **something always on** that holds the latest state. That can be a server, GitHub, a cloud bucket, or a Mac mini at the office. Anytype handles this with backup nodes in its network.

### The full menu

Every option is a combination of three choices:

1. **What's always on:** GitHub, a cloud bucket, our own server, or a machine at the office.
2. **What travels:** whole files, or small changes.
3. **How conflicts merge:** whole-file copies, line merge, field/paragraph merge, or automatic merging of every edit (CRDTs).

| Option | Always-on store | What travels | Merging | Feel | Notes |
|---|---|---|---|---|---|
| Dropbox / iCloud / Google Drive | their cloud | whole files | none (conflict copies) | minutes | Easy, but no merging at all |
| Syncthing | an always-on peer (office Mac mini) | whole files | none (conflict copies) | seconds to minutes | P2P; needs one machine always on |
| **E. Git remote** (GitHub, Gitea) | GitHub | commits | Surface's field/paragraph merge driver | ~5–15 s | History, accounts and no server, for free |
| Cloud bucket + change log (S3, Cloudflare R2) | the bucket | files plus a manifest of changes | Surface's merge | seconds | Cheap, our own format; we build the sync logic |
| **B. Change relay with storage** (y-sweet, Automerge sync server, Loro, PartyKit, Liveblocks) | a relay server (ours or hosted) | small changes | automatic (CRDT) | live, under 1 s | Notion-like; a server to run or pay for |
| Database sync engine (ElectricSQL, PowerSync, Zero, Triplit, InstantDB) | a Postgres server | rows | the engine's rules | live | Strong, but the database becomes the truth and files become a copy |
| SQLite replication (Turso embedded replicas, cr-sqlite) | a primary database | database pages or rows | last-write-wins or CRDT | seconds | Same trade-off: files become a copy |
| Anytype's any-sync (open source) | sync and backup nodes | changes | CRDT | live | Built around Anytype's object model; heavy to adopt |
| Office hub (Mac mini or VPS running relay + git) | that machine | changes (live) + commits (history) | CRDT + merge driver | live | Self-hosted version of E + B |

## Full circle: database vs. files first (Oct 12)

David: we've come full circle; a real database has to be weighed against the files-first idea.

**What B really is.** With a change relay, the actual source of truth is the change log (a CRDT store), which is a database. The `.md` files become a projection that's continuously written and also accepts edits. Live multi-user editing for people who aren't online at the same time needs an always-on store of changes, and at that point there's a database underneath whichever way we go. The real question is whether the files are the *truth* or a *guarantee*.

**What files still buy us,** after we've given up readable filenames, folder meaning and Obsidian as the main tool:

1. **Exit and ownership:** a full copy of your data as plain text, always.
2. **Agents read files natively** (grep, Claude Code, Codex).
3. **Other apps can edit the files.**
4. **Plain-text history** (git).

**Which of these need files to be the truth?** Only #3. #1, #2 and #4 are equally well served by an always-current Markdown mirror written from a database.

**Local-first ≠ files.** Local-first means a full copy on your device that works offline and syncs. A local database replica gives you that too. Anytype is local-first without files. The thesis ("data is the foundation, multi-user editable, like any app") doesn't require files; files were the hunch for how to get local-first.

### The two real choices

**1. Files are the truth** (B, or E + B)

- Edits from any app are first-class.
- Costs:
  - The hardest engineering in the whole system: two-way bridging between the files and the change log, and diffing external edits back in.
  - Weaker queries and constraints, and no row-level permissions.

**2. Database first, with a live Markdown mirror**

- The truth is a local-first database: a local replica on each device, synced through an always-on server.
- The data model designed so far carries over unchanged. Records are pages, type-prefixed IDs are row keys, schemas are tables, front-matter fields are columns, and the flat Markdown body is a text column.
- Every record is continuously written to disk as `.md` + YAML. That's the exit, the agent read surface, and plain-text history.
- Agents write through Surface's CLI or MCP, the same live path humans use.
- Edits made to the mirror in other apps can be read back as *proposed changes* that are flagged and accepted, which matches the flag-only rule, or simply ignored.
- Wins: live multi-user editing (existing sync engines do this), real queries, constraints and permissions, mobile, and much less custom engineering.
- Possible bonus: because the mirror isn't the truth, its filenames could be readable names that Surface generates and keeps unique, which brings back much of the Obsidian experience for reading.

**Leaning: choice 2,** unless "other apps can edit the files as first-class" (#3) is a must.

### David's insight: a generated mirror can be built for Obsidian

If the database is the truth and the local files are built from it, the files can be laid out however we want. Filenames, folders and links can always work in Obsidian, because Surface writes all of them, and writes them correctly, every time:

- **Readable filenames** (`Order cabinets.md`), kept unique by a stable rule Surface applies, e.g. `Order cabinets (2243 Steiner).md`.
- **Meaningful folders,** generated from relationships: `Jobs/2243 Steiner/Tasks/Order cabinets.md`. That's useful for browsing in Finder and Obsidian, and costs nothing, because the folder layout is output, not truth.
- **Plain `[[Order cabinets (2243 Steiner)]]` links** that are always correct. A rename in Surface regenerates the file and rewrites every link to it at once.
- **Generated Obsidian Bases files** (`.base`) for the standard views, so tables work in Obsidian too.
- **`id:` stays in front matter,** so any edit made in Obsidian can be traced back to its database row.
- **Permissions carry over:** each person's mirror contains only what they're allowed to see.

**Things to decide**

1. **Edits made in Obsidian.** Either the mirror is read-only (Surface regenerates it, and outside edits are overwritten), or Surface reads outside edits back as changes to the row with that `id:`. Reading back field and body edits is manageable now, because the database decides conflicts. Renames done in Obsidian are messy: Obsidian renames the file *and* rewrites links in other files, so Surface has to read that as "title changed" and ignore the link rewrites.
2. **Name stability.** A new duplicate shouldn't rename existing files. Options: always qualify types prone to duplicates (every task gets its job in the name), or qualify only the newcomer.
3. **Filename churn.** A title change renames the file. That's fine for Obsidian, but noisy in git history and breaks outside bookmarks.
4. **Cloud truth and offline.** The cloud database is the truth; each device keeps a local replica for offline work and speed, and the mirror is written from that replica.

## Local-first workspaces, sync optional (Oct 12)

David: different users want different things. Some only want local work on their own machine; others want to sync with a team, which needs the cloud. Could Surface keep the source of truth in a local database and sync to the cloud only when needed?

**Yes. That's the local-first model** (Anytype; Obsidian with its paid Sync; Linear's client database).

- **Every workspace is a local database on the device** (likely SQLite), and the Markdown mirror is written from it.
- **Solo workspace:** the local database is the source of truth. No account, no cloud and no network needed. Everything works: the app, agents, views and the mirror.
- **Synced workspace:** the same local database, plus a connection to a sync server. Each device keeps a full local replica: it works offline and merges on reconnect. The server stores every change (so people needn't be online at the same time), passes changes between members, and enforces permissions.
- **Same app, same data model.** The only difference between solo and team is whether sync is switched on for that workspace.
- **Several workspaces side by side:** a personal local workspace and a team workspace in the same app (Anytype calls them spaces; Obsidian calls them vaults).
- **Moving between modes:**
  - Solo to team: turn on sync and upload the workspace.
  - Leaving a team: the local copy stays yours (the exit guarantee).

### Built sync-ready from day one

So that turning sync on later is just "ship the history":

- **Globally unique IDs.** The time-sortable random IDs already decided work across devices with no coordination.
- **Every change is recorded** as a small operation (or a CRDT change), not just the latest state. Sync later means sending those changes.
- **Field-level changes,** so two people editing different fields of the same record never conflict.
- **Text bodies** as mergeable text (a CRDT per body), so offline text edits merge automatically.

### Who decides in a team?

- **Server-arbitrated** (Linear, Figma): devices apply changes instantly, and the server decides the final order. Permissions are easy to enforce. Recommended.
- **All peers equal** (Anytype): every device merges independently, and the server only stores and relays. More decentralized; permissions are harder.

### Candidate technology (to research)

- SQLite plus a CRDT layer: cr-sqlite, Automerge or Loro documents per record.
- Sync engines with an offline local database: PowerSync, ElectricSQL, Zero, Triplit, InstantDB. Check which ones work fully local with no server, and which need Postgres on the server.
- Turso / libSQL embedded replicas (offline writes).
- Anytype's any-sync (open source).

### Business model fit

A free local app plus a paid sync service is the Obsidian and Anytype model. It also echoes an earlier Surface insight: the billable part is the sync layer, plus agent labor. Self-hosting the sync server could be an option for teams that want it.

## Direction (Oct 12): local database plus first-class Markdown files

David: unlike Anytype, which keeps everything in its own database with no Markdown files agents can work with, Surface's files must stay workable in any editor. When the Surface app starts, it scans the Markdown files and applies the changes to the database.

That's stronger than the "edits come back as proposals" idea above. **Edits made in other editors are first-class.** It's the two-way version: the database and the files are both editable, and Surface keeps them in step.

### How reconciliation works

- **What gets stored:** for every record, the database keeps the exact version of the file it last wrote or read (the *base*).
- **When it runs:** on startup, Surface scans the files; while it's running, a file watcher does the same live.
- **The three-way comparison:** for any changed file, Surface compares three versions:
  - the base (what the file was);
  - the file now (what changed outside Surface);
  - the database now (which may have teammates' changes that arrived meanwhile).
- **Front matter merges field by field.** A field changed in only one place is just applied. Only the same field changed in both places is a conflict, and that gets flagged.
- **The body merges as text.** The outside edit is imported as an ordinary text edit into the body's mergeable text, so it combines with teammates' edits.
- **Once merged, it's an ordinary change.** The edit is recorded like any other and syncs to the team if sync is on.
- **Agents can therefore just edit files,** with or without Surface running.

### Edge cases to decide

1. **A new file made in another editor (no `id:`):** Surface adds an `id:` line to it, which is a small write to the file and an exception to flag-only, or it flags *"new note; import it?"*
2. **A file deleted outside Surface:** delete the record (with trash and undo), or flag it?
3. **A rename or move in Finder:** filenames and folders are generated by Surface. Treat a rename as a title change, or flag it and regenerate the path?
4. **Broken YAML:** keep the database values and flag the file. (Proposed.)

### Who decides: every device (leaning)

David leans toward every device merging as an equal. That works with this design:

- Merging uses CRDTs, so every device reaches the same result on its own, with no server deciding the order.
- The sync server still stores and relays every change (so people needn't be online at the same time).
- The server can still enforce permissions: it relays changes only from members allowed to write, and sends each member only what they may read.

## 3. Questions to settle

**Feel**

1. How live: changes within about a second, plus seeing others on the page? Live cursors?
2. Offline: does everything work offline, or only recent pages (Notion's limit)?
3. Same field changed by two people at once: last edit wins, or flag it?

**Sync and hosting**

4. Who runs the relay that passes changes between machines: you (a Mac mini, a VPS), a Surface cloud service, or both?
5. Is the relay only a messenger, or does it also keep a full copy as backup and history?
6. Peer-to-peer on the same network (Anytype-style), or always through the relay?

**Sharing and permissions**

7. Is everyone in a workspace able to see everything? Local-first means every member's machine holds every file, so per-record privacy is hard.
8. Guests: can a client or sub see one job's pages without receiving the whole workspace?

**The app**

9. Desktop app (Mac first?), web app, or both? Phone?
10. Does the app run a small local server that agents also talk to, so agents edit through the live path rather than writing files directly?
11. What's in the first version: the editor, table and board views, agent-made views, search?
