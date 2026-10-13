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

**Leaning (to discuss): B.** It's the only option that keeps files as the real thing on every machine and still feels live. Field-level merging (one field per line, plus a per-field rule for edits at the same moment) avoids Notion's silent property overwrites.

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
