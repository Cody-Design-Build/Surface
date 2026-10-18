# Local mode and sync mode

How Surface runs on one computer with no account, and how the cloud database becomes an optional sync mode. Part of the spec; `SPEC.md` §3 summarizes it.

Status markers: **Decided**, **Leaning** (direction agreed, details open), **Open**.

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

## 2. The database engine

**Leaning: PGlite** (Postgres compiled to WebAssembly, run inside Node), pending the spike in §8.

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
~/Surface/                              the checkout: Markdown files, as today
  .surface/config.json                  { "store": "local", "database": "<path>" } or { "store": "cloud", ... }
~/Library/Application Support/Surface/  Mac
~/.local/share/surface/                 Linux
  workspaces/<id>/db/                   the PGlite database
  workspaces/<id>/backups/              automatic backups
```

- **Leaning: the database lives outside the checkout.** Checkouts are often inside Dropbox, iCloud or Syncthing. Those tools copy files independently and would corrupt a live database or make conflicted copies of it.
- **Open:** offer "everything in one folder" (the database under `.surface/db/`) for people who want a single portable folder and don't sync it.

## 4. Who opens the database

PGlite allows one process at a time.

- **`surface serve` owns the database while it runs.** CLI commands detect it (a lock file with its port) and send their work to its local API instead of opening the database themselves.
- **When `serve` isn't running,** a CLI command opens the database directly, does its work and closes it.
- **Agents see no difference:** `surface new`, `surface push` and `surface query` behave the same in both modes and both cases.

## 5. Files and other editors

The checkout is the same in both modes, so **any Markdown editor is a surface**: Obsidian, Morrow, Bear-style editors, a terminal editor, an agent.

- **Push on save (planned, both modes):** `surface serve` watches the checkout. A file saved in another editor is validated and pushed within a moment. Safe fixes are written back; invalid values are reported in the app and by `surface status`, and the file is left as written. This is the live two-way experience that SPEC §6 set aside, made simple by a single owner process. In local mode the round trip never leaves the machine.
- **Editors that reformat Markdown:** some apps rewrite a whole file when they save it. Morrow, for example, converts pages to its own editor format and writes them back in its own style. Surface accepts that: the push validates values and keeps the record's ID, type and revision. Whether such an app keeps Surface's front matter keys (`id`, `type`, `rev`) has to be tested per editor (§8).
- **Other apps' "databases" are views, not truth.** Morrow defines a database as a folder of pages; Obsidian Bases query properties. Both can show Surface records because the values are plain front matter. Surface's types remain the definition, and the database refuses values that don't fit.

## 6. Moving between modes

- **Turn on sync:** `surface sync enable` (and a button in the app). It signs in, creates a cloud workspace and copies everything: types, fields, records with their IDs and revisions, views and history. Then it switches the checkout to the cloud store. The local database is kept as a read-only backup until removed. Other computers then `surface clone` it.
- **Leave sync:** `surface sync leave` copies a cloud workspace into a new local database. The cloud copy is untouched; deleting it is a separate, deliberate step.
- **Same data model in both,** so moving is a straight copy, not a conversion.

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
