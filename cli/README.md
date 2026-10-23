# surface CLI

Typed records in Supabase, checked out as Markdown files you can open in Obsidian or any editor.
The database (Supabase) is the source of truth; the folder is a checkout. This is Surface's first and foundational surface: a shared Markdown working medium for humans and agents. The dedicated app (run with `surface serve`, below) and other surfaces use the same data foundation; see [`../docs/SPEC.md`](../docs/SPEC.md) for the product direction and [`../docs/MVP.md`](../docs/MVP.md) for current scope.

## Install

```sh
git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
~/Developer/Surface/install.sh
```

`install.sh` gets Node 24 if yours is older than 23.6 (via fnm, nvm, mise, Homebrew or pacman if you have one; otherwise fnm into your home folder, no sudo), resolves the newest stable Git tag from `origin`, and installs a separate release without pulling or resetting the bootstrap checkout. It then runs that release's `surface setup`, which does the rest:

1. installs and builds the web UI;
2. puts `surface` on your PATH (a link in `~/.local/bin`);
3. creates **this computer's own database** (embedded Postgres; no account, nothing leaves the machine) in `~/Library/Application Support/Surface` on a Mac or `~/.local/share/surface` on Linux;
4. creates a first workspace and checks it out to `~/Surface`;
5. with `--service`, starts the web UI at login (launchd on a Mac, a systemd user service on Linux).

Flags: `--dir <folder>`, `--name <workspace>`, `--service`, `--port <n>`, `--rebuild`, and `--cloud` to work directly against your own Supabase project instead (connect it first with `surface cloud connect`; see `../docs/CLOUD.md`). For an existing installation, use `surface update` (or `surface update --check` to check first). `surface doctor` checks everything.

**A remote Linux machine:** run the same two lines over SSH, then `surface setup --service` (and `loginctl enable-linger $USER` if it should keep running after you log out). The web UI listens on that machine's 127.0.0.1 only; reach it from your own computer with `ssh -L 4317:127.0.0.1:4317 you@that-machine` and open the link `surface serve` printed (`journalctl --user -u surface | grep Open` shows it for the service).

**Open a surface in its own window:** `surface open` (the workspace home), `surface open "Open tasks"` (a view, by name or key) or `surface open "Order tile"` (a record). It finds the running `surface serve`, or starts one in the background, switches it to this checkout's workspace if needed, and opens the page as an app window (Chrome, Chromium, Brave or Edge with `--app`, using its own profile), falling back to the default browser. `--tab` opens a normal tab; `--print` prints the address for scripts and agents.

**Push on save:** while `surface serve` runs it watches the checkout, so a save in Obsidian, VS Code or any editor goes to the database within about half a second: normalized, validated, revision-checked. New Markdown files become records (moved into their type's folder in the type layout). Invalid values are refused and the file is left as written; a file changed in both places is reported as a conflict. Deleting a file never deletes its record. Without the web UI, `surface watch` does the same in the foreground; `surface serve --no-watch` turns it off.

**Local and cloud stores:** `surface store` shows which one this computer uses; `surface store local|cloud` switches. With the local store, a cloud workspace syncs to this computer with `surface sync join` (see Sync below).

## Updates and one background server

```sh
surface update --check                 # read stable release tags from origin; cache status only
surface update                         # prepare, activate, verify; restart only a running server
surface service install                # one server at login, all workspaces
surface service status                 # also: start, stop, restart
surface data                           # opens /w/<id>/data/ on that server
surface data --print                   # print its address instead
```

**CLI-only, published releases.** `surface update` and `surface update --check` use the highest numeric stable SemVer tag (`vMAJOR.MINOR.PATCH`, or `MAJOR.MINOR.PATCH`) advertised by `origin`. Annotated tags are peeled to their commit. Prereleases, build aliases and branch tips are never selected. A detached stable checkout works; no tracked branch is required. Tags are trusted code from your configured origin, not an additional signature-verification scheme. Dirty or divergent developer checkouts are refused for installation without reset, merge or deletion; checks remain available with local edits.

**Prepare before downtime.** The new release is cloned independently into `~/.config/surface-cli/runtime/releases/`, verified against the advertised commit, and prepared with `npm ci` in both packages and the production app build while the old server stays up. Download/dependency/build failures leave the existing active path and server unchanged. Activation atomically replaces `runtime/current`; the linked CLI and managed service resolve that stable path, so the next update works from an activated detached release. The original checkout and previous releases remain intact. `SURFACE_CONFIG_DIR` relocates the runtime/cache/backups together.

**Activation and recovery.** Only after preparation succeeds does installation disable/remove old Surface update timers or launch agents, stop an existing server, and back up the stopped local database plus JSON configuration under `update-backups/<timestamp>/` (private directory). It starts a server only if one was running, on the same port, and verifies the commit reported by the actual process. A failed activation/startup stops the attempted new process, restores the previous code path and managed-service definition, quarantines the attempted database as `failed-db` in the backup, restores the stopped local database snapshot, and restarts the previous server if appropriate. A stopped installation stays stopped.

Local migrations can run when a release first opens the database. Code rollback alone does **not** make migrated data compatible: automatic failure recovery therefore restores the stopped database snapshot, not just code. Any changes accepted during failed startup after that snapshot may be absent from restored local data; `failed-db` is retained for inspection. Cloud schema migrations and effects already accepted by a cloud are separate and are never applied or rolled back by the installer. Do not restore an older local snapshot over newer work or manually downgrade a healthy release without checking schema compatibility.

If automatic recovery cannot stop a process, obtain the database lock, or restore/start the previous release, the CLI reports the previous code path and backup and leaves evidence intact. Keep all Surface servers stopped. Inspect `update-backups/<timestamp>/release.json`, `db/`, `failed-db/` and the backed-up config; preserve the current database before recovering. Restore a compatible stopped database and the previous `runtime/current` symlink together, restore the prior service definition if needed, then run `surface serve` or `surface service start`. Backups and previous release directories are retained intentionally; remove them manually only after confirming a healthy release and the desired retention policy.

**No automatic installers.** Browser release status is read-only: there are no install/check buttons, browser update endpoints, detached update jobs, automatic install flags or update schedules. Previously installed `surface-update.timer`/`surface-update.service` (Linux) or `dev.surface.update` launch agent (macOS) are disabled/unloaded and removed by explicit installation/setup cutover. `--check` only reads releases and updates the currency cache; it does not disable schedules or change the installation. Linux and macOS services are supported; use WSL on Windows.

The local server performs bounded, passive in-process release discovery on startup and when the four-hour cache expires. Interactive CLI commands may show a cached notice but never launch a discovery worker or installer. JSON and noninteractive commands stay quiet. Failed passive checks retry after 15 minutes; a failed cloud or release check does not establish that the computer has no internet connection. `SURFACE_UPDATE_CHECK=0` disables passive discovery (manual `surface update --check` still works; reinstall the service to persist the setting).

### Recovering the phone schema rollout (0.1.2)

The shared database received migration `0009_phone_fields.sql` before the matching client was published. Version 0.1.1 cannot sync the new structured phone values. On every computer, run:

```sh
surface update
surface restart
surface doctor
surface sync
```

Version 0.1.2 bundles the phone validator, renderer and migration. The updater installs dependencies and builds the app before activation, backs up the stopped local database, and restarts a running server. The explicit restart also covers an installation that was already current but still had an older process running. Existing local phone strings remain readable and are normalized when edited. Keep local edits and sync conflicts; do not delete the database, rejoin the workspace, or rerun cloud migrations to repair a client installation.

### Publishing and migrating releases

Release maintainers update package versions and lockfiles consistently, commit the intended release (including migration/recovery notes), run the release checks, and publish an immutable stable tag to the installation's `origin`:

```sh
git tag -a v1.2.3 <release-commit> -m "Surface 1.2.3"
git push origin refs/tags/v1.2.3
```

Publish and verify the compatible stable client release before deploying a shared schema that changes stored value formats. Upgrade participating clients before converting existing shared records. Test upgrades from the previous published release, including pending local data.

Pushing a branch or a prerelease tag alone does not offer an update. Do not move an already published tag or reuse a version for different code; the updater rejects conflicting same-version aliases and a tag that changes during preparation. Publish a new stable version to correct a release. Clients require their installed commit to be an ancestor of the target release; preserve release ancestry or provide a separately reviewed migration instead of force-resetting installations.

For older branch-based/two-server installations, first preserve local code changes and stop both old servers (including any data server on 4318). Use a separate clean clone at the published stable tag that introduces this updater; do not `git pull` or reset a developer checkout. Run its `install.sh --dir "<existing workspace folder>"` with the same config/data environment, then use the newly linked `surface` command. Setup removes old update schedules and retains workspace folders, account configuration and sync mappings. Future updates use `surface update` only.

### Isolated release smoke fixture

```sh
cd cli
SURFACE_KEEP_UPDATE_FIXTURE=1 npm run test:updates
```

This executable integration fixture starts from the published `v0.1.1` client and database, then snapshots the current source into a temporary local Git publisher, publishes real annotated stable/prerelease tags and unreleased commits, installs the actual CLI/app with real `npm ci` and production builds, and runs a real server. It exercises migration of existing phone data, dirty/divergent code preservation, read-only checks, preparation failure without stopping the server, atomic activation, actual-revision health checks, rollback after a release's startup failure, repeat updates from the active detached release, and stopped-server preservation. Git is local-only; npm may download dependencies into an isolated cache. Its temporary HOME/config/data/ports prevent touching an installed CLI, systemd service or launch agent. The optional environment variable keeps the fixture and logs for inspection; without it the fixture is removed. This does not exercise a real systemd/launchd session; verify managed-service restart behavior separately in an isolated OS account.

The writing and data interfaces use the same port (4317 by default). A workspace is part of its URL, so tabs stay independent. Close any old data server on 4318 during the first upgrade.

## Start

```sh
surface signup
surface init ~/Surface --create "Cody Design Build"
cd ~/Surface
```

Every workspace starts with one built-in type, **page** (title and body only).

## Run the app

Build the app once, and again after pulling app changes. From the repository root:

```sh
cd app && npm install && npm run build
```

Then, in your checkout:

```sh
surface serve --open
```

It serves the app on http://127.0.0.1:4317. Open the link it prints once (it carries a sign-in token), then install the page as an app: Omarchy's Install Web App, Chrome's Install, or Safari's Add to Dock. `--port` changes the port; `--open` opens the browser. The server listens on 127.0.0.1 only and keeps the checkout current while it runs. Edits in other editors push on save while the server is running.

## Cloud administrator migrations

Normal Surface credentials remain limited to data access under row-level security. To deploy bundled schema changes, an administrator supplies `SUPABASE_ACCESS_TOKEN` separately and runs:

```sh
surface cloud migrate --since 7 --check   # read-only plan; earlier migrations already installed
surface cloud migrate --since 7           # explicit, atomic administrator deployment
```

The required `--since` declares the existing baseline; use 1 only for a fresh project. The private cloud ledger records file names and SHA256 checksums. Matching migrations are skipped, altered/ahead/gapped histories are refused, and SQL failures roll back source and ledger changes together. A lost response is not automatically retried: inspect `--check` and explicitly rerun. No token is persisted, printed or sent to the browser; do not put it in arguments or project files. See [safe credential entry and deployment details](../docs/CLOUD.md#administrator-migrations-from-the-cli). The Supabase Management API SQL endpoint is currently Beta. `cloud schema` remains a manual SQL-export alternative; app updates/startup never deploy shared schema automatically.

## Build your types

```sh
surface type add project
surface field add project status --kind select --options "Lead,Estimating,In Progress,Done"
surface field add project budget --kind number
surface type add material --name "Material"
surface field add material supplier
surface field add material cost --kind number
surface field add material project --kind link --target project
surface types
surface type show material
```

Field kinds: `text`, `number`, `date`, `checkbox`, `select`, `multi_select`, `url`, `email`, `phone`, `link` (`--target <type>`, `--multiple`, optional `--inverse <forward-field-key-or-id>`).

Change them any time:

- `surface field edit <type> <key>`: `--key`, `--name`, `--add-option`, `--remove-option`, `--required`, `--target`, `--multiple`, `--inverse <forward-field-key-or-id>`, …
- `surface field rm <type> <key>`
- `surface type edit <key>`: `--key`, `--name`, `--folder`
- `surface type rm <key>`: `--move-to <type>` or `--force`

Fields have permanent internal IDs, so renaming a key never loses data.

### Two-way relationships, stored once

```sh
surface field add contact organizations --kind link --target organization --multiple
surface field add organization contacts --kind link --target contact --multiple --inverse organizations
surface set "Anna" organizations="Cody Design Build"
surface show "Cody Design Build" --json    # contacts includes Anna immediately
surface set "Cody Design Build" contacts="Anna,Ben"
```

`--inverse` resolves a field key or permanent field ID on the target type. It must reference an ordinary stored link back to the owning type, in the same workspace. Inverse fields require `--multiple` and cannot be required. Schema JSON keeps `inverse` as that forward field's **ID**, so field and type renames preserve the relationship.

The relationship lives only in `contact.organizations`; the reverse `organization.contacts` is computed from all live contacts on every read, including records outside a partial checkout. `show`, `query`, view filters and the API expose those reverse values, and the existing link controls edit either end. A reverse replacement atomically updates the corresponding stored source links. Omitted reverse keys leave the relationship alone; `contacts=` (API `null` or `[]`) explicitly clears it. API updates that supply an inverse key must include the record's `baseRev`; source membership changes invalidate that revision, preventing stale replacements.

Markdown contains only stored fields: inverse fields are omitted, not duplicated or written as empty values. Edit the forward link in files, or either end through CLI/API/UI. Raw record snapshots, sync and history also contain only stored source fields; sync translates inverse field IDs as schema metadata. Removing the inverse field removes the presentation, not the stored forward links.

Local databases apply migration **0007** when opened by the updated client. Before adding or syncing inverse-bearing schemas, an authorized administrator must run `surface cloud migrate --since 7` with `SUPABASE_ACCESS_TOKEN`, or apply `surface cloud schema --since 7` through the SQL editor. Client installation does not migrate the cloud. The schema-version capability check fails closed on an older or inaccessible hub, preserving local edits rather than silently discarding inverse metadata or duplicating reverse values.


## Phone fields

Phone is a validated database type, not unrestricted text. The CLI, Markdown push and app accept common US/Canadian formats (default region US), or international numbers beginning with `+` and a country code. They normalize numbers to E.164. The app displays US/Canadian numbers as `(415) 555-0123` and international numbers in international format.

Use one phone field for an ordered list of entries. **The first is primary**; do not create separate Mobile/Office fields, phone-type labels, or primary flags. See the shared [phone field policy](../docs/PHONE.md).

```yaml
phone:
  - number: "+14155550123" # Primary
  - number: "+14155550124"
    extension: "004"
```

Choose a different primary without losing the other numbers:

```sh
surface phone primary "Contact name" 2
```

Positions are one-based. This moves the selected entry first and preserves the order of the others. New numbers append; removing the primary promotes the next. The web editor provides a primary star, Add number, removal, and separate extensions; compact cells show the primary and `+N more`.

Plain CLI input still works: `phone=415.555.0123`, multiple numbers on separate lines or separated by semicolons, or a JSON array of `{number, extension?}` entries. Replacing a list with `surface set` preserves the supplied order. Copy/export includes every number, not only the primary.

CLI/API writes reject incomplete numbers, conflicting extensions, phone-type labels, and unknown entry keys rather than guessing or dropping information. Validation checks structure and plausible number length, not whether a number is active or assigned. Clear optional fields with `null` or an empty CLI assignment.

**Upgrade:** migration `0009_phone_fields.sql` applies automatically to local stores on restart. Cloud administrators must apply migration 9 before updated clients write structured phones (`surface cloud migrate --since 9` with administrator credentials, or `surface cloud schema --since 9` in the SQL editor). Older clients need updating to edit phone fields. Existing legacy values remain visible and don't block unrelated edits; normalize or review them explicitly. History retains the original values.

## Work with records

From the CLI:

```sh
surface new project "Steiner Kitchen" status=Estimating budget='$45,000'
surface new material "Shaker cabinets" cost=12000 project="Steiner Kitchen"
surface new page "Punch List" --folder Reference
surface set "Shaker cabinets" cost=12500
surface query material --where "cost>10000" --sort -cost
surface show "Steiner Kitchen"
```

Or in files, in Obsidian, by hand or by an agent:

1. Edit a file. Change fields in the front matter, or write in the body.
2. Run `surface status` to see what changed, and `surface diff` to see how.
3. Run `surface push` to send it up.

Push **normalizes** safe fixes and reports each one:
- `Oct 20` → `2026-10-20`
- `in-progress` → `In Progress`
- `$47,500` → `47500`
- `yes` → `true`

It **rejects** anything it can't use: an unknown option (with a "did you mean"), a bad date, a field the type doesn't have, or a link to a missing record. It also catches **conflicts**: if the record changed since your file's `rev`, the file is rejected, like `git push`. Run `surface pull --force`, redo the edit, and push again.

New files: write front matter with `type:` (or none, for a page), then `surface push --new`.

`surface pull` writes the database into the folder. It never overwrites a file with unpushed edits (unless `--force`). Renamed records move their files and rewrite every link.

Layouts: `surface init <dir> --layout type|flat|folder [--only task,project]`. Each checkout can differ.

## Folders, nesting and the Views tree

Files are storage; the Views tree is navigation. Neither one changes the other.

```sh
surface layout                         # show this checkout's layout
surface layout link:project,parent     # tasks under their project, pages under their parent page (files move)
surface layout folder                  # your own folders (each record's folder value)

surface mv "Order cabinets" "Jobs/Active"                        # folder layout: move records
surface mv --type task --where "project=Bathroom" --to Archive   # move by query
surface folder rename Jobs Work                                  # everything under a folder
surface folders                                                  # list folders with counts

surface new page "Pricing" --parent "Estimating guide"           # nest a page (front matter: parent: "[[…]]")
surface set "Loose note" parent=                                 # un-nest
surface query --where "parent=this" --this "Pricing"             # children of a record

surface tree init                      # starting tree: a group per type
surface tree --paths                   # draw it, with file paths
# edit .surface/views/sidebar.yaml, then:
surface tree check && surface push

surface view new "Job tasks" --from task --where "job=this" --sort due --show board:status,table
surface view new "My week" --from task --where "status!=Done" --show calendar:due,list --personal
surface tree init --personal           # your own sidebar (.surface/views/personal/sidebar.yaml)
surface tree --personal
surface type edit budget_line --display fields   # opens fields-first in the app

surface workspace invite anna@example.com --role member   # admin | member | viewer
surface workspace members              # members and pending invites
surface workspace invites              # invites addressed to you
surface workspace join <id>
```

`.surface/views/sidebar.yaml`:

```yaml
name: Sidebar
items:
  - group: Jobs                          # a virtual folder
    items:
      - query: { from: project, where: "status!=Done", sort: title }
        each:                            # children of every matching project
          - query: { from: task, where: "project=this", label: Tasks }
  - record: "[[How We Estimate]]"        # one record, with its nested pages
  - query: { from: page, where: "folder= && parent=", label: Inbox }
```

Sidebar entries can also be saved views: `- view: job-tasks` opens it as a full page; add `unfold: true` to list its records in the tree instead, `each:` to put entries under every result (`this` = that result), and `label:` to rename the entry. The workspace sidebar can use shared views only; your personal sidebar can use both. `display: merged` (personal sidebar) shows one tree instead of two sections.

```yaml
items:
  - group: Jobs
    items:
      - view: all-jobs
        unfold: true
        each:
          - { view: job-pages, unfold: true, label: Pages }
          - { view: job-tasks, label: Tasks }
          - { view: budget, label: Budget }
```

Every record in the tree also shows the records nested under it (`nested: false` turns that off).

## Sync

Each computer keeps its own database (the local store), and every surface (files, the app, the data view, agents) reads and writes it. Sync is optional, per workspace: the local database trades changes with a hub, record by record. Offline you keep working; changes go up when the hub is back.

```sh
surface sync enable                           # hub: the cloud (after `surface login`)
surface sync enable --hub http://mini:4317 --token …   # hub: another computer running `surface serve --host 0.0.0.0`
surface sync join <hub workspace id> ~/Team   # on another computer: a local copy of it
surface sync status                           # last sync, changes waiting, conflicts
```

`surface serve` syncs every few seconds and right after a local change. Changes to different properties of the same record coexist. Only competing changes to the same property create a conflict copy; identical results do not. Keep one, delete the other, then `surface sync resolve <record>`. Design: `docs/LOCAL.md` §1c.

## For agents

Every pull writes `AGENTS.md`, `.agents/skills/surface/SKILL.md` (also copied to `.claude/skills/`), and a read-only copy of each type in `.surface/types/`.

## Test

```sh
npm test            # the CLI against the local store (npm run test:cloud for the hosted one)
npm run test:watch  # push on save
npm run test:inverse  # pure inverse-link read projections and stored-only Markdown
npm run test:sync   # three computers' databases syncing through a hub
npm run test:sync:cloud  # the same, with the cloud as hub (uses your sign-in; temporary workspace)
```

## Database

Migrations are in `../supabase/migrations/`:

| Table | Holds |
|---|---|
| `workspaces`, `members` | Roles: owner, admin, member, viewer |
| `types` | Field definitions as JSON, each field with a permanent id |
| `records` | Values keyed by field id |
| `links` | Maintained from link fields |
| `history` | Every revision |

- Row-level security is written once, on these six tables. New types never need new tables or rules.
- The database validates every write in a trigger, so a client that skips the CLI still can't store bad data.
- `push_record` does the revision check.
