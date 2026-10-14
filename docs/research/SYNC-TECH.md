# Sync technology options for Surface (research, working)

> **Superseded (Oct 14):** Surface dropped the local database and device-to-device merging. Supabase is the single truth, and files are a checkout with pull and push (SPEC §3, §7). Kept as research history in case live co-editing is ever needed.

> **Status: research input, nothing decided.** Checked 13 Oct 2026. GitHub data comes from `gh api` (last push, latest release, license). Anything I couldn't confirm is marked *(unverified)*.

## What we need from the sync layer

- **Per-field merge for front matter**, and the ability to **detect when two people changed the same field at the same time**, so the app can flag it instead of silently picking one.
- **Text merge for the flat Markdown body**, including **turning an outside edit (old text → new text) into ordinary text edits**.
- **Works fully offline with no account** (solo workspaces), plus an optional always-on relay for teams that also enforces permissions.
- **Every device decides** (peer-equal merging), history and time travel, Rust or WASM bindings for Tauri, open source, and comfortable at 10k+ records.

## Summary table

| Option | Status (Oct 2026) | License | Kind of thing | Same-field conflict visible? | Text body | Works with no server? | Server / self-host | Fit |
|---|---|---|---|---|---|---|---|---|
| **Automerge 3 + automerge-repo** | Active (3.5.0, 16 Sep 2026) | MIT | Document CRDT, Rust core + WASM/JS | **Yes, built in** (`getConflicts`) | Good; `updateText` diffs plain text | Yes | Simple relay (`automerge-repo-sync-server`), self-hostable | **Strong** |
| **Loro** | Very active (1.16.4, 30 Sep 2026) | MIT | Document CRDT, Rust core + WASM/Swift | **No** (last-writer-wins only; API requested) | Excellent; `update`/`updateByLine` | Yes | Minimal WS server (`loro-protocol`), self-hostable | **Strong** |
| **Yjs (+ Hocuspocus / y-sweet)** | Active (13.6.33, Sep 2026) | MIT | Document CRDT, JS (Rust port `yrs`) | No | Very good, most battle-tested | Yes | Hocuspocus (Node) or y-sweet (Rust) | Medium |
| **cr-sqlite (vlcn)** | Effectively unmaintained (last release Jan 2024) | MIT | CRDT tables inside SQLite | Per column, last-writer-wins | None (no text CRDT) | Yes | Build your own | Weak |
| **any-sync (Anytype)** | Active (Go, commits this week) | MIT protocol; Anytype's object layer is source-available | Encrypted change graphs + nodes | Up to the app | Up to the app | Yes | Several Go services via docker-compose | Weak–medium |
| **PowerSync** | Active (service 1.27.0, Oct 2026) | Client Apache-2.0; service FSL (source-available) | SQLite on device ↔ server database | No (your backend decides) | None | Local-only tables only | Needs Postgres/Mongo/MySQL + its service | Weak |
| **ElectricSQL** | Active, but now read-path only | Apache-2.0 | Postgres → client streaming | No | Via separate Yjs add-on | No | Postgres + Electric | Weak |
| **Zero (Rocicorp)** | 1.0 shipped June 2026 | Apache-2.0 | Server-authoritative cache over Postgres | No | None | No (offline is read-only) | Postgres + zero-cache | Poor |
| **Triplit** | Acquired by Supabase; last commit Sep 2025 | AGPL-3.0 | Client DB + server | Field-level LWW | None | Partly | Its server | Poor (stalled) |
| **InstantDB** | Active | Apache-2.0 | Firebase-style backend with offline cache | No | None | No | Self-host via Docker (Clojure + Postgres) | Poor |
| **Turso / libSQL** | Active | MIT | SQLite with push/pull sync | No ("last push wins") | None | Yes (local file) | Turso Cloud; self-host of new sync *(unverified)* | Poor |
| Jazz 2.0 | Alpha (v2.0.0-alpha.59) | MIT | New Rust local-first relational DB | *(unverified)* | *(unverified)* | Yes | Jazz Cloud or self-host | Watch |
| DXOS | Active | FSL (source-available) | P2P object store on Automerge | Inherits Automerge | Inherits Automerge | Yes | P2P + signalling | Watch |
| Ditto | Commercial | Proprietary | P2P mobile DB | CRDT | — | Yes | Ditto cloud / licence | Excluded |

**Bottom line:** only three of these are "every device decides" CRDT libraries with a real text type: **Automerge, Loro and Yjs**. Everything else is either server-authoritative (Zero, PowerSync, Electric, InstantDB, Turso), stalled (cr-sqlite, Triplit), or a whole platform we would have to adopt (any-sync, DXOS, Jazz, Ditto). The real contest is **Automerge vs Loro**.

---

## The core three

### 1. Automerge (+ automerge-repo)

- **Maturity.** Ink & Switch's long-running research project, now run by the Automerge team. `automerge` 3.5.0 shipped 16 Sep 2026 and had 100+ commits since July. `automerge-repo` is on v2.6.0-alpha. `automerge-repo-sync-server` v0.3.0 shipped 30 Sep 2026. All MIT. Automerge 3.0 (mid-2025) cut memory use a lot by keeping the compressed form at runtime ([blog](https://automerge.org/blog/automerge-3/)). Memory was the main complaint about earlier versions.
- **Runtime.** Rust core (`automerge` crate, plus `autosurgeon` for Rust structs), JS via WASM, Swift, Python. Fits Tauri well: you can run the merge logic in Rust on the Tauri side.
- **Storage.** Its own compact binary format. automerge-repo ships IndexedDB and Node-filesystem storage adapters ([packages](https://github.com/automerge/automerge-repo/tree/main/packages)). It does not sit on SQLite, but the bytes are easy to store as blobs in our SQLite file.
- **Field merge.** By default the last writer wins, but **the losing values are kept and can be read with `getConflicts(doc, "field")`**. The conflict clears once someone writes the field again ([docs](https://automerge.org/docs/reference/documents/conflicts/)). This is exactly the "flag concurrent edits to the same field" requirement, and no other option here offers it out of the box.
- **Text.** Every string is a text CRDT. `updateText(doc, path, newText)` turns a whole-string replacement into character edits ([docs](https://automerge.org/docs/reference/documents/text/)). Automerge warns that large jumps between calls merge less well, which matters for us (see "Reconcile" below). There is also a rich-text/marks layer and a ProseMirror binding.
- **Three-way reconcile.** `changeAt(doc, heads, fn)` applies an edit *as if* it were made at an older version, then merges it with everything since (confirmed in the 3.5.0 type definitions). That is the three-way reconcile we want: base = the heads recorded when the file was last written; apply the file's diff at that base, and the CRDT merges it with DB edits made in the meantime.
- **History.** Full history is kept. `view(doc, heads)` shows any past version, and `diff(doc, before, after)` and `getHistory` exist.
- **Server and permissions.** The sync server is a dumb relay plus storage, which matches "server is just storage/relay". There is **no built-in permission model**. Ink & Switch's **Keyhive** (Apache-2.0, actively developed, [repo](https://github.com/inkandswitch/keyhive)) is the planned access-control/encryption layer, but I couldn't confirm it is production-ready *(unverified)*. Until then we'd add an auth check to the relay ourselves.
- **Scale risk.** We'd need one document per record (see "Permissions"), so 10k–50k small documents. How fast automerge-repo announces and syncs that many documents on a cold start is the main thing to test *(unverified)*.

### 2. Loro

- **Maturity.** Newest of the three but moving fastest: loro-crdt 1.16.4 shipped 30 Sep 2026, 100+ commits since July, about 6.2k stars, MIT. Small core team (the founders are the main committers). Bindings for Rust, WASM/JS, Swift, Python, React Native and FFI ([org](https://github.com/loro-dev)).
- **Storage.** Its own binary snapshots and updates. As with Automerge, store them as blobs in SQLite.
- **Field merge.** `LoroMap` is **last-writer-wins by logical clock, with no API to see the losing value** ([docs](https://loro.dev/docs/tutorial/map)). An open issue asks for multi-value or conflict detection; a maintainer said it is "theoretically possible" and floated reporting concurrent overwrites in import events, but nothing has shipped ([#742](https://github.com/loro-dev/loro/issues/742)). The workaround is to detect conflicts ourselves: on import, compare `doc.diff(base→local)` with `diff(base→remote)` per field. It's doable but it's our code.
- **Text.** Best in class: a B-tree text type with O(log n) edits, Fugue/Peritext rich text, stable cursors, and ProseMirror/CodeMirror bindings ([docs](https://loro.dev/docs/tutorial/text)). It offers both `text.update(newText)` (character diff) and **`updateByLine(newText)`** (line-based diff, faster on large documents; confirmed in the 1.16.4 types). That suits Markdown files edited by agents.
- **Three-way reconcile.** `doc.forkAt(frontiers)` creates a branch at the base version. Apply the file's diff there, then import it back, and Loro merges it. This is equivalent to Automerge's `changeAt`.
- **History.** `checkout(frontiers)` for time travel, with optional timestamps per change ([docs](https://loro.dev/docs/tutorial/time_travel)). Checkout currently leaves the doc read-only until you call `attach()`, and the docs call this "temporary".
- **Server.** `loro-protocol` (MIT) is a transport-agnostic protocol with a minimal Rust WebSocket server that can snapshot to SQLite ([repo](https://github.com/loro-dev/protocol)). There is **no equivalent of automerge-repo** (document index, storage adapters, many-document sync), so we would build that layer. No permission model.

### 3. Yjs (+ Hocuspocus or y-sweet)

- **Maturity.** The most widely deployed CRDT (about 23k stars, v13.6.33 in Sep 2026, MIT). Rust port `yrs` (y-crdt v0.28.0, Sep 2026). Hocuspocus (MIT, Node) v4.7.1 shipped 12 Oct 2026. **y-sweet**'s parent Jamsocket wound down its platform and joined Modal ([Modal](https://modal.com/blog/jamsocket-is-joining-modal)); y-sweet is still MIT but its last release was Sep 2025, so treat it as at risk.
- **Field merge.** `Y.Map` is last-writer-wins with no conflict API.
- **Text.** Excellent and battle-tested, with every editor binding. There is no built-in "diff these two strings", so you'd use a diff library and apply the result as a delta (a common pattern).
- **History.** Weak. You keep snapshots with garbage collection turned off, and there's no first-class version graph like Automerge's or Loro's.
- **Fit.** It would be a great choice if Surface were a live co-editor. It does less for "flag conflicting fields" and change history, which are both core requirements here.

## The rest, briefly

- **cr-sqlite.** The author said in Dec 2024 he is full-time on Zero and expects no bandwidth "for at least 1-2 years" ([#444](https://github.com/vlcn-io/cr-sqlite/issues/444)). There have been 5 build-fix commits since 2025, and the latest release is v0.16.3 (Jan 2024). Fly.io runs its own fork. It also has no text CRDT and column merge is last-writer-wins. **Not recommended.** A newer alternative, `sqliteai/sqlite-sync`, needs a commercial licence for production use ([repo](https://github.com/sqliteai/sqlite-sync)).
- **PowerSync.** On-device SQLite synced to a server database: Postgres, MongoDB, MySQL and others ([site](https://powersync.com/)). The self-hosted "Open Edition" service is **source-available (FSL), not open source**, and stores sync data in MongoDB or Postgres ([blog](https://powersync.com/blog/powersync-open-edition-release)). There is a local-only mode: "local-only tables" never sync, and otherwise changes pile up in an upload queue ([docs](https://docs.powersync.com/client-sdks/advanced/local-only-usage)). Conflicts are resolved by *your* backend, so it is server-authoritative and has no text merge. That contradicts "every device decides".
- **ElectricSQL.** After its 2024 rewrite it only handles reads: "Electric does read-path sync… does not do write-path sync" ([docs](https://electric.ax/docs/sync/guides/writes)). It requires Postgres. It has a Yjs add-on (`@electric-sql/y-electric`). Not a fit for offline-first peer-equal editing.
- **Zero.** Reached 1.0 in June 2026 ([InfoQ](https://www.infoq.com/news/2026/06/zero-version-1/)). It is explicitly built on server authority ([zero.rocicorp.dev](https://zero.rocicorp.dev/)), requires Postgres, and offline access is **read-only** ([zero-docs](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/sync.mdx)). Wrong model for Surface.
- **Triplit.** Acquired by Supabase, and the founder joined to lead integrations ([Supabase blog](https://supabase.com/blog/triplit-joins-supabase)). The last commit was Sep 2025. AGPL. Effectively stalled.
- **InstantDB.** Open source (Apache-2.0) and can be self-hosted in Docker. It's a Firebase-style backend with an offline cache; the server is authoritative and there's no text CRDT. Not a fit.
- **Turso.** The new Turso Sync gives local-first writes with `push()`/`pull()`, but "on conflicts the strategy is 'last push wins'" ([docs](https://docs.turso.tech/sync/usage)). Older Embedded Replicas send writes to the cloud by default ([docs](https://docs.turso.tech/features/embedded-replicas/introduction)). The docs assume Turso Cloud, and I couldn't confirm a self-hosted sync server *(unverified)*. Good SQLite engine, wrong merge model.
- **any-sync (Anytype).** A Go protocol: encrypted change graphs (DAGs), "spaces" with access lists, and sync/file/consensus nodes you can self-host via docker-compose ([repo](https://github.com/anyproto/any-sync)). It is the closest philosophical match (peer-equal, end-to-end encrypted, store-and-forward nodes, built-in permissions). But the CRDT and object model is in `anytype-heart`, under the **"Any Source Available License"** (not open source), it's Go (a sidecar process next to Tauri), and the documentation for outside apps is thin. It's a good model to study, but I wouldn't build on it.
- **Jazz.** "Jazz 2.0" is a brand-new Rust-core "local-first relational database" in alpha with "an entirely new API". Classic Jazz lives on in a separate repo ([repo](https://github.com/garden-co/jazz)). Too unsettled to adopt now; worth watching.
- **DXOS.** Built on Automerge, peer-to-peer, but **FSL source-available** and a whole platform. **Ditto** is proprietary. Both excluded.

---

## Issues that affect every option

1. **Permissions decide how documents are split.** A relay can only refuse or withhold *whole documents*. It can't hide one field inside a CRDT document, and can't half-accept a change. So **one CRDT document per record** (plus a small per-workspace document for type schemas) is the natural unit. The server checks "is this member allowed to write record X?" before relaying, and "allowed to read X?" before sending. That is the same for Automerge, Loro and Yjs. Field-level read permissions would need separate documents for those fields.
2. **SQLite stays, but in a different role.** None of the CRDTs live *in* SQLite tables. The workable pattern is a SQLite file holding (a) CRDT bytes per record, which are the truth, and (b) normal tables generated from them for queries and views. If (b) is lost it can be rebuilt from (a). This keeps the "local database is the device's source of truth" idea, with the CRDT bytes as the authoritative part.
3. **The reconcile design works best when the CRDT does the merge.** Rather than our own three-way text merge, record the CRDT version (Automerge *heads* / Loro *frontiers*) in `.surface/cache/` each time a `.md` file is written. When the file changes outside the app: parse the front matter, branch the document at that recorded version (`changeAt` / `forkAt`), write the changed fields and the new body text there, and merge. Concurrent DB-side edits then merge like any other peer's. The diff is computed against the *base* text, which keeps Automerge's "big jumps merge worse" warning small. Line-based diff (Loro's `updateByLine`, or a line diff fed to Automerge `splice`) behaves most like git for agent edits.
4. **CRDTs never "fail" a merge.** For text that's fine. For fields, "flag, never rewrite" needs the *losing* value. Automerge keeps it. Loro and Yjs throw it away from the visible state, so we'd detect conflicts ourselves at import time.

## Ranked recommendation

**1. Automerge 3 + automerge-repo, with a small self-hosted relay we extend for auth.**
*Why:* it's the only option that matches the specific "flag concurrent edits to the same field" requirement (`getConflicts`), it has `changeAt` for the Markdown three-way reconcile, full history, a Rust core for Tauri, MIT, a real many-document sync layer, and a relay server that is just storage and forwarding, as you want.
*Risks:* cold-start sync and memory with ~10k–50k documents (much better since 3.0, but unproven at our shape). automerge-repo 2.x is still in alpha releases. There are no permissions until Keyhive matures, so we write the relay's access checks. Text performance is below Loro's, though this is unlikely to matter for page-sized bodies.

**2. Loro + loro-protocol, with our own document-repo layer.**
*Why:* best text type and fastest engine, line-based `updateByLine` that suits Markdown and agents, `forkAt` for the reconcile, good time travel, Rust core, MIT, very active.
*Risks:* no conflict surfacing (we build field-conflict detection from diffs), a smaller team, and no automerge-repo equivalent (we build storage, the document index and multi-document sync). Pick this if the spike shows Automerge too slow or heavy.

**3. Yjs (yrs) + Hocuspocus.** The safe, battle-tested fallback, especially for the body text. It's weaker on history and conflict flagging, which are core here, so it ranks third.

## Suggested spike (about 1 week, throwaway)

Goal: prove or kill Automerge on *our* hard parts, then run the same harness against Loro to compare.

1. **Data:** generate 20k records (front matter with about 10 fields, 0–20 KB Markdown body), one Automerge document per record, stored as blobs in SQLite, with a generated `records` table for queries. Measure disk size, cold-open time, and memory with all documents loaded vs. loaded on demand.
2. **Mirror reconcile:** write all records to `.md` files and record heads per file. Then (a) edit a file in an editor while the app is closed, (b) edit the same record's body and one field in the "DB" too, and (c) start up. Check that the `changeAt` merge keeps both body edits and that same-field edits show up in `getConflicts`. Repeat with an AI agent rewriting a whole paragraph and moving sections.
3. **Team sync:** run `automerge-repo-sync-server` locally with a simple token check. Two clients go offline, edit 500 overlapping records, reconnect at different times (store-and-forward), and must end up identical. Measure time and bytes to sync 20k documents to a fresh device.
4. **Permissions:** add a per-document read/write list in the relay. Confirm a read-only member's changes are dropped and unlisted documents are never sent.
5. **Run the same harness against Loro** for steps 1–3. Compare speed, memory, and how much code the conflict detection took.

**Pass bar:** cold open under 2 s and fresh-device sync of 20k records under 60 s on a recent Mac; zero lost edits in reconcile tests; every same-field concurrent edit flagged.

## Not verified

- Keyhive's production readiness.
- automerge-repo performance with tens of thousands of documents.
- Whether Turso Sync can be self-hosted.
- Jazz 2.0's merge semantics.
- The exact Triplit acquisition date.
- PowerSync's full list of supported source databases (beyond Postgres, MongoDB and MySQL).
