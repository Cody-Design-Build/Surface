# Local mode and sync mode

How Surface runs on one computer with no account, and how the cloud database becomes an optional sync mode. Part of the spec; `SPEC.md` §3 summarizes it.

Status markers: **Decided**, **Leaning** (direction agreed, details open), **Open**.

**Current implementation: §1c.** Sections 1, 1a, and 1b retain the design history; where they differ, §1c takes precedence.

## 1. The idea

**Leaning (Oct 16).** Surface is the same software in two modes. Only where the database lives changes.

| | **Local mode** | **Sync mode** |
|---|---|---|
| Database | Postgres embedded in Surface, on this computer | Supabase in the cloud |
| Account | None | Sign-in |
| Computers | One | Any number |
| People | One | One, or a team (members, roles, sharing) |
| Works offline | Fully | Reading and editing the checkout; pushes wait for a connection |
| Hosted browser access | No | Yes, the app's hosted mode |
| Files, CLI, app, agent guidance, views | Same | Same |

- **Local mode is the starting point.** Install, pick a folder, start writing. Nothing leaves the machine.
- **Sync mode is what you turn on** for a second computer or a team. Teams are a feature of sync mode, not a separate product.
- **One source of truth either way.** In local mode it's the local database; in sync mode it's the cloud. A workspace is in one mode at a time, so the two never have to be merged.

This doesn't reverse the Oct 14 decision against a local database (SPEC §3). That design had a database on every device, kept in step by a merge engine. Here a local workspace has exactly one database and nothing to sync.

## 1a. Exploring: every device has its own Postgres (Oct 18)

**Exploring.** Push the idea further: Surface is local-first by nature, not as a mode.

- **Every device runs its own Postgres** (PGlite inside `surface`). It's the truth for that device. No account, no server, no sign-up, ever, to use Surface alone.
- **Team and multi-computer features are a separate, optional layer** on top: sync between your devices, members, roles, sharing with outside people, hosted links to artifacts. Turning it on adds to a workspace; it doesn't replace its database.
- **The same schema and rules run everywhere,** so every device validates its own writes, offline included. The hosted layer runs them too.

What this changes from §1: §1 says a workspace lives in exactly one database (local *or* cloud). With a sync layer, a shared workspace has a copy on each device plus the hosted one. So the layer has to answer how copies converge. Leaning: the hosted copy is in charge for shared workspaces (it checks permissions and revisions and orders changes); devices send their changes up and replay others' down; edits to different fields merge, and only the same field changed on two devices is a conflict. A private workspace synced only between your own devices could later use encrypted sync instead (the hosted side stores only what it can't read).

This revisits part of the Oct 14 decision (a database on every device was dropped along with a merge engine). The difference: no peer-to-peer merge engine; one copy stays in charge whenever people share.

**Built (Oct 18): local store and installer.** `cli/src/local.ts` runs the unchanged migrations in PGlite behind the auth shim and answers the same client calls the CLI makes to Supabase, so every command works on either store. It's the default on a new computer (`surface store` shows or switches it; computers already signed in stay on the cloud). `surface serve` owns the database while it runs; other CLI processes send their queries to it through the lock file's port. The full CLI suite passes on both stores (16/16 each). `install.sh` and `surface setup` install everything; `surface doctor` checks it. Not built yet: the sync and team layer for local workspaces, moving a workspace between stores, backups.

**Spike step 1 passed (Oct 18):** the five existing migrations apply unchanged in PGlite with a small auth shim (`auth.users`, `auth.uid()`, `auth.jwt()`, the `authenticated` role). `push_record` works under the same row-level security, 200 writes in 73 ms, and invalid values are rejected by the same rules. See `spikes/pglite/`.

Open (TODO.md): the sync layer's protocol (change log, ordering, field-level merge), what's hosted (our Supabase, any Postgres, self-hosted), identity when a local-only user later joins a team, and whether local Postgres for a shared workspace is a full copy or only what the person can see.

## 1b. Decided (Oct 18): a local database per computer, optional sync record by record

**Decided and built.** This replaces the open questions in §1a with the simplest version that works offline.

- **The database is always the truth, and it's the one on this computer.** Every surface reads and writes the local database: the Markdown checkout, the app, the data view, agents. Files are generated from it and pushed back into it, as before.
- **Sync is optional, per workspace.** Off: the workspace lives only here. On: the local database trades changes with a **hub**, the cloud or another computer running `surface serve`. Each computer that syncs holds a full copy.
- **Same rules everywhere.** Local and hub run the same migrations, so a record is the same row (same id, same validation) in both. Sync copies rows; it doesn't translate them. Types and fields are matched by key, since field ids can differ between copies.

**How a change is detected.** A trigger on `records`, `types` and `views` marks a row dirty in `surface_local.sync_rows` whenever it changes, whoever changed it: the app, a file save, the CLI, an agent. Nothing diffs files or compares databases. The bookkeeping is local only (`surface_local` schema), never in the shared migrations.

**How a push works,** for each dirty record (parents and link targets first):

1. Call `push_record` on the hub with the record's values and `base_rev` = the hub revision this copy last matched.
2. Same revision on the hub: applied. Remember the new hub revision; the row is clean.
3. Newer revision on the hub (someone else changed it): **no merge.** Your version is kept as a new record, "Title (conflict 2026-10-18 14:05)", the original takes the hub's version, and the conflict is listed in `surface sync status` until you `surface sync resolve` it.
4. New records are created on the hub with the same id. Deletes are soft (`deleted_at`) and push the same way.
5. **Delete vs edit:** an edit always beats a delete, on either side; the record comes back.

**How a pull works.** Compare the hub's `id:rev` list with the revisions last synced; fetch what changed and write it locally. Records with unpushed local changes are skipped (their push decides). Writes from the hub set `surface.applying`, so the trigger doesn't mark them dirty and they don't bounce back.

**Types and views.** Type and field changes sync both ways; if a type changed on both sides, the hub's version wins. Views sync by key (personal views as yours); a clash keeps the hub's version.

**When it runs.** `surface serve` (which owns the local database) syncs every 5 seconds, right after a local change, and when the hub comes back. `surface sync` runs a round by hand. Offline, every surface keeps working on the local database; dirty rows wait.

**Commands.** `surface sync enable [--hub URL --token T]`, `sync join <hub workspace> <folder>`, `sync [now]`, `sync status`, `sync resolve <record>`, `sync disable`. Without `--hub` the hub is the cloud (after `surface login`). A computer can be a hub for others by running `surface serve --host 0.0.0.0` (or behind Tailscale); peers use its serve token.

**Tested:** `cli/test/sync.ts` runs three computers' databases on one machine (a hub and two copies): enable, join, edits both ways, schema changes, links and parents, conflict copies, deletes, delete vs edit, offline edits, and serve syncing app edits on its own. It passes 10/10 with a Surface hub (`npm run test:sync`) and 10/10 with the cloud as hub (`npm run test:sync:cloud`: uses this computer's sign-in, creates a temporary cloud workspace and deletes it). The CLI suite still passes (16/16, watch 5/5).

**Not done yet:**

- **Permissions on a Surface hub:** a peer with the token acts as the hub's owner. Fine for your own computers; teams should use the cloud, where row-level security applies per member.
- **Pull is incremental** (built): only records the hub changed since a cursor (the hub's `updated_at`, minus a 2-minute margin for late commits), with a full `id:rev` comparison every 10 minutes as a safety net. A true change sequence on the hub would remove the margin.
- **Conflicts on types and views** keep the hub's version silently (no copy).
- **Sync state in the app** (built): `GET/POST /api/sync` reports the database's last observation separately from optional workspace sync. It distinguishes a never-synced workspace, an active round, pending edits, hub failures, authentication/permission errors, and conflicts. See §1c's status contract below.

**In use (Oct 18):** cdb-os on this Linux machine runs on the local store, syncing with the cloud workspace `1nd7c49fg6tk`. Checkout `~/Surface-cdb-os` (local workspace `1ndahjxwpw00`); the old cloud checkout is kept at `~/Surface-cdb-os-cloud-backup`. Joining copied 585 rows and wrote nothing to the cloud. Live check: an app edit reached the cloud, a cloud edit came back, a delete went up.
- Attachments don't sync.

## 1c. Decided and implemented (Oct 19): one server; local execution with cloud acceptance

Surface remains a local-first database and CLI with Markdown checkouts. The app uses the local database **both online and offline**. For a shared workspace, the cloud accepts shared changes and assigns revisions; local workspaces need no cloud. The writing and data interfaces remain local.

### One server per computer

- One `surface serve` owns the database and synchronizes every enabled workspace. It discovers registered checkouts and watches each workspace even with no tab open.
- Each tab identifies its workspace in the URL: `/w/<workspace-id>/` and `/w/<workspace-id>/data/`. API requests, attachments and live events use that same workspace prefix. Opening one workspace never switches another tab.
- `surface open` and `surface data` reuse the server, starting it detached if necessary. `surface serve` reuses an existing instance; a startup lock prevents competing instances, including on a different port.
- `surface service install` installs the same server at login on Linux (systemd user service) or macOS (launchd). `start`, `stop`, `restart`, and `status` manage it. Windows currently uses WSL; a native Windows logon task is not implemented.
- Tests use isolated config and data directories. Old 4318 data processes should be closed during the one-time upgrade; the new `surface data` does not start another server.

### Read-only system status and database observations

- Authenticated `GET /api/system` (also `/w/<id>/api/system`) exposes the machine, cached account identity, installed/running revisions, cached release currency, and `cloudConnectivity`. Release currency has `available`, `availableCommit`, `availableVersion`, and `checkedAt`; it has no updater job or browser action. There is no browser update POST endpoint. Install stable Git releases explicitly with `surface update`; passive release discovery never installs.
- `cloudConnectivity` describes the **server device's configured cloud endpoint**, not the browser's network or general internet access. Its fields are `state` (`online`, `unreachable`, `unknown`, or `unconfigured`), `target`, `checkedAt`, and `checking`. An initial observation is unknown/checking with no timestamp; no cloud configuration is unconfigured and sends no request.
- The server makes an on-demand, single-flight GET to its configured cloud URL's `/auth/v1/health`, with a five-second deadline, no credentials or redirects, and a thirty-second result cache. This works even when workspace sync is disabled. Any HTTP response proves endpoint reachability; an auth error or service failure is not an internet outage, and a reachable health endpoint does not prove a database operation succeeded. A changed target starts a new observation. The timestamp always describes the last completed observation, including failed checks.
- `GET /api/sync` reports `database: { state, checkedAt, error, errorKind }` for the workspace's actual store. The server reuses the initial database load and existing 2.5-second database watcher, not an extra query per status request. State is `checking` before an observation, `ready` after successful database reads, or `error` after failed reads. `errorKind` separates `network`, `auth`, and `database` failures. Local database readiness does not depend on cloud reachability.
- Sync's `state` is `local` when disabled, `cloud` for a direct cloud store (not a replica claimed to be synced), or `never-synced`, `syncing`, `pending`, `synced`, `unreachable`, or `error` for an enabled local replica. `syncing` is the database owner's actual in-flight round; `loopEnabled` indicates whether its automatic sync loop is running. Existing `pending` and `conflicts` remain authoritative; unresolved conflicts must remain visible even after a successful round. The hub's error and `errorKind` (`network`, `auth`, or `sync`) remain visible separately from database readiness and server cloud reachability. The legacy `offline` flag means only that this sync hub was unreachable.
- `lastSync` is null until a complete successful round, is not advanced by partial/error rounds, and is retained when a later round fails. Re-enabling sync clears the previous hub's success/error observation. A disconnected browser cannot obtain fresh server observations; its connection failure must not overwrite or impersonate server-side cloud status. The same distinction applies to a browser on another device.
- Token-authenticated, non-browser `GET /api/_health` includes the running process's startup `commit` and its local `dataDir` (null for a direct cloud store), alongside client and pending counts. CLI update/restart checks use the actual server's revision and database location, not assumptions from the invoking shell.


### Pending edits and reconciliation

1. Every edit is validated and committed to the local database immediately. In a synced workspace, the same transaction records a durable outbox entry: the state before the first unsent edit, the latest desired state, and a generation counter. Repeated edits to one record coalesce; records are sent in dependency order and then queue order.
2. The owner server sends changes promptly while online and every five seconds. Offline edits stay in the database and outbox across restarts.
3. Sync compares the before/after states to determine which properties changed, reads the latest cloud record, and applies those property changes. It uses a revision-filtered update, retrying against a fresh cloud record if another writer wins. The `fields` JSON column is merged before that atomic update; unrelated cloud field values are preserved.
4. Edits to different properties coexist. The same resulting value is an acknowledgement, not a conflict or another revision. A lost acknowledgement can be retried against the accepted result.
5. Competing edits to the **same property**, including the Markdown body, remain explicit conflicts: the original takes the cloud version and the latest local version is saved as a conflict copy. There is no silent last write wins and no paragraph patch protocol.
6. An acknowledgement updates the accepted local state and replays any newer local edits over it in one transaction. A generation check prevents an in-flight upload from clearing later edits.
7. Shared type and field changes require a connection: flush pending edits, change the schema on the hub, then pull the result. Cloud-originated record rewrites do not enter the local outbox. Stable field-id mappings preserve pending values through a field rename. Local-only schema changes stay local.
8. Deletes versus edits retain the existing edit-wins behavior. Permission failures leave pending work locally. If a cloud type is deleted while this computer has unsent records of that type, syncing reports the problem and preserves those records rather than silently discarding them.

A workspace's existing sync mapping determines its Local/Cloud label. `surface sync enable` adds the cloud copy to an existing local workspace; `surface join` obtains a local copy of a shared workspace. The legacy direct-cloud store remains supported for existing installations; it does not gain offline support until a local synced copy is joined.

Existing dirty records from before this upgrade use the previous conservative whole-record path until acknowledged; their history does not contain a reliable new outbox baseline. New edits use the outbox automatically. Attachments still do not sync.

**Stored-once inverse links (migration 0007).** A link field may name `inverse: <stored-forward-field-id>` on its target type. It is a computed, editable projection, never another persisted list. CLI/API reads compute it from all live source rows (including sources outside a partial checkout); Markdown, raw snapshots, history and sync carry only canonical forward values. An explicit inverse write replaces membership atomically by changing those source rows. Omitted inverse keys do nothing, and source membership changes advance the inverse owner's normal revision so stale full-form saves conflict instead of overwriting newer links. Sync translates the schema's inverse field IDs and prepares type identities/stored fields before inverse metadata. Existing hubs must explicitly deploy migration 0007 using administrator-authenticated `surface cloud migrate --since 7` (or the manual `surface cloud schema --since 7` export); a schema-version RPC check stops inverse-bearing sync or schema changes on an older hub without discarding pending edits.


### Verification and updates

`npm run test:workflow` exercises two real PGlite databases and the HTTP request handler without sockets: field reconciliation, equivalent results, persisted offline edits, retries, in-flight edits, body conflicts, schema changes, workspace isolation and authentication. Its inverse-link regression uses different permanent field IDs on the two databases, checks existing links and reverse edits against canonical source rows/history, and simulates a missing hub capability to verify schema refusal and pending-edit retention without hub writes. `npm run test:sync` retains the multi-process test against a Surface hub; `test:sync:cloud` uses a real cloud project.

`surface update --check` reads stable SemVer release tags from `origin` and updates the read-only currency cache. `surface update` refuses dirty/divergent code, prepares a separate tagged release with locked dependencies and the production build **before** stopping a server, backs up the stopped local database/config, activates the stable `runtime/current` path, and restarts only a previously running server. Startup must report the intended actual commit. Failure restores previous code and the stopped local database snapshot; attempted migrated data is retained for inspection. It never resets a developer checkout or applies/rolls back cloud migrations. See [publication, migration and recovery policy](../cli/README.md#updates-and-one-background-server).

Release discovery is passive and read-only: the server checks on startup and when the four-hour cache expires; the browser displays currency and the CLI may print a cached notice. No browser update controls, detached update workers, automatic installation or schedules remain. Explicit CLI installation/setup disables and removes old Surface update schedulers; `--check` leaves them unchanged. Discovery can be disabled with `SURFACE_UPDATE_CHECK=0`; failed checks retry after 15 minutes without claiming the computer is offline.

Startup and `surface restart` verify that the web build's `surface-build.json` matches the installed version and Git commit, and that every app HTML entry exists. Missing or stale builds are compiled with `npm run build` into a temporary directory and published only after validation; failed compilation preserves the previous assets and does not stop an existing server. Matching builds are reused. Dependencies must already be installed; startup does not install packages or update Git.

The browser's **New version ready → Reload** action only refreshes the page after the running server changes. It does not install or rebuild anything. Startup's build check ensures the refreshed page can load matching assets instead of repeatedly offering Reload for the same stale bundle. Uncommitted frontend edits still require an explicit `npm run build` in `app/`.

## 2. The database engine

**Built: PGlite** (Postgres compiled to WebAssembly, run inside Node). The spike in §8 and the local-store tests established it.

Why:

- **One implementation.** It's real Postgres, so the existing migrations run unchanged: `push_record`, normalization, revisions, history, `save_view`, `rename_folder`. The rules that refuse bad data are identical in both modes.
- **Nothing to install.** It's an npm package inside `surface`; no server, no Docker, no Postgres install.
- **One folder on disk** holds the whole database.

**What the migrations need from Supabase,** checked against `supabase/migrations/0001–0004`:

- `auth.uid()` (12 uses) and `auth.users` (2 foreign keys);
- the `authenticated` role, granted the RPCs and used by row-level policies;
- nothing else: no extensions, storage or realtime.

**A local auth shim** supplies these:

- an `auth` schema with a `users` table holding one local user;
- `auth.uid()` returning that user's ID;
- an `authenticated` role that sessions use, so the same grants and row-level policies apply.

The local user owns the workspace, so every policy passes for them. Permissions in local mode are trivial but enforced by the same code.

**Fallback if PGlite can't do this:** SQLite, with `push_record` and the normalization rules re-implemented in TypeScript. That means two implementations to keep identical, so it's a last resort.

## 3. Where things live

```text
~/Surface-<workspace>/                   a Markdown checkout (any chosen folder)
  .surface/config.json                  workspace id, layout and checkout filters
  .surface/state.json                   last-written file hashes and local revisions
~/.local/share/surface/db/              one PGlite database per computer on Linux
~/Library/Application Support/Surface/db/  the same on macOS
~/.config/surface-cli/                  cloud connection, private sign-in, checkouts,
                                        server metadata, startup/update locks
```

`SURFACE_CONFIG_DIR` and `SURFACE_DATA_DIR` isolate a test or a separate installation. Local workspaces, cloud caches, pending edits and sync bookkeeping all live in the one database. The database stays outside Markdown checkouts so Dropbox or other file-sync tools never copy its live internal files individually.

## 4. Who opens the database

PGlite allows one process at a time.

- **`surface serve` owns the database while it runs.** CLI commands detect it (a lock file with its port) and send their work to its local API instead of opening the database themselves.
- **When `serve` isn't running,** a CLI command opens the database directly, does its work and closes it.
- **Agents see no difference:** `surface new`, `surface push` and `surface query` behave the same in both modes and both cases.

## 5. Files and other editors

The checkout is the same in both modes, so **any Markdown editor is a surface**: Obsidian, Morrow, Bear-style editors, a terminal editor, an agent.

- **Push on save (built Oct 18, both stores):** `surface serve` watches the checkout. A file saved in another editor is validated and pushed within a moment. Safe fixes are written back; invalid values are reported in the app and by `surface status`, and the file is left as written. This is the live two-way experience that SPEC §6 set aside, made simple by a single owner process. In local mode the round trip never leaves the machine.
- **Editors that reformat Markdown:** some apps rewrite a whole file when they save it. Morrow, for example, converts pages to its own editor format and writes them back in its own style. Surface accepts that: the push validates values and keeps the record's ID, type and revision. Whether such an app keeps Surface's front matter keys (`id`, `type`, `rev`) has to be tested per editor (§8).
- **Other apps' "databases" are views, not truth.** Morrow defines a database as a folder of pages; Obsidian Bases query properties. Both can show Surface records because the values are plain front matter. Surface's types remain the definition, and the database refuses values that don't fit.

## 6. Moving between modes

- **Share a local workspace:** `surface sync enable` uploads it to the configured cloud and keeps the local database in use. The workspace becomes a local copy of cloud-accepted shared data, with pending edits retained locally until acknowledged.
- **Join a shared workspace:** `surface join <code>` or `surface sync join <cloud workspace id> <folder>` creates a local copy, with a mapping to the cloud workspace. It does not switch the app to direct-cloud operation.
- **Stop sync:** `surface sync disable` keeps both copies and the local records but removes sync bookkeeping. Unsent changes remain in local records; they are no longer queued for the former hub.
- **Legacy direct-cloud installations:** `surface store cloud` still exists for compatibility. A local synced copy must be joined explicitly to gain the offline behavior described here.

## 7. Backup, recovery and lock-in

- **The files are always a complete plain copy** of the current data: every record's values and body, with `.surface/types/` describing every type.
- **Rebuild from files (planned):** `surface rebuild` creates a new database from a checkout's files and `.surface/types/`. It recovers everything except revision history. A lost database is an inconvenience, not a loss.
- **Automatic backups (planned):** a daily copy of the database folder in `backups/`, keeping the last 14.
- **Export:** `surface export` writes a portable dump (records, types, views and history as JSON). It's the same format sync uses, so a local workspace can always move to the cloud and back.

## 8. Spike: prove it before building

1. **Migrations:** run 0001–0004 in PGlite with the auth shim. Pass if they apply unchanged.
2. **Behaviour:** run `cli/test/e2e.ts` (15 scenarios) against the local store. Pass if all 15 pass with no test changes.
3. **Speed:** 10,000 records. Measure startup, a full snapshot, `push_record` and a query. Target: start under 1 s, push under 50 ms.
4. **Size:** bundle and install footprint of PGlite in `surface`.
5. **Other editors:** open a checkout in Obsidian and Morrow, edit a record in each, and check that `id`, `type`, `rev` and typed values survive a save and push.

If 1 or 2 fail in ways a small shim can't fix, revisit the SQLite fallback (§2) before writing more code.

## 9. Build steps

1. **A store interface in the CLI.** Everything that calls Supabase today goes through one `Store` with two implementations, `CloudStore` (today's code) and `LocalStore`. No behaviour change, and the 15 tests still pass on the cloud store.
2. **`LocalStore`** on PGlite with the auth shim; the e2e suite runs against both stores.
3. **`surface init --local`** creates a local workspace with no sign-in. This becomes the default; `--cloud` is the sync-mode path.
4. **`surface serve` as owner:** the lock file, CLI hand-off, and live updates from in-process events instead of polling.
5. **Push on save** (§5), for both modes.
6. **`surface sync enable` / `leave`,** `export`, `rebuild` and automatic backups.

## 10. Open questions

1. Is local mode the default for new users, with sync a later upgrade, or is the choice made at install?
2. The database location: outside the checkout only, or optionally inside it (§3).
3. **Several workspaces on one computer. Leaning (Oct 17): one local database per computer** (see also §1a), holding every local workspace. Every table already carries `workspace_id` and row-level security is per workspace, so a second database per workspace buys nothing. What stays true: each workspace has one home, local or cloud. A shared workspace's truth is the cloud database; a local copy of it would be a cache (fast reads, offline edits queued as normal pushes with revision checks), not a peer that merges. Moving a workspace between modes copies its rows (`where workspace_id = …`) instead of a whole database folder.
4. Pricing: local free and sync paid fits naturally, but it's a business decision (SPEC §11).
5. Mobile: local mode on a phone is unlikely; mobile probably means sync mode with the hosted app.
