# Local first, cloud when you want it, share when you need to

Surface grows in three steps. Each one is optional and builds on the last.

1. **Local.** Install, and you have a workspace on this computer. No account, no cloud, nothing leaves the machine.
2. **Your cloud.** Connect a [Supabase](https://supabase.com) project **you** own, and put the workspace in it. Surface has no hosted service and never uses anyone else's project.
3. **Share.** Add your other computers, and invite other people (who can add their own computers).

```
   1. local                 2. your cloud                    3. share
 ┌──────────┐   sync    ┌──────────────────┐   sync    ┌──────────────┐
 │ this     │ ◀───────▶ │ your Supabase    │ ◀───────▶ │ your laptop  │
 │ computer │  enable   │ project (the hub)│   join    │ Anna's Mac   │
 └──────────┘           └──────────────────┘           │ Anna's PC …  │
                                                       └──────────────┘
```

Every computer keeps a **full copy** in its own database and works offline. The cloud is the hub they sync through, with durable pending edits. Different field changes coexist; competing changes to the same property preserve a conflict copy ([`LOCAL.md`](LOCAL.md) §1c).

| | 1. Local (default) | 2. + your cloud | 3. + shared |
|---|---|---|---|
| Computers | One | Any of yours | Anyone you invite, and their computers |
| Account | None | One, in your project | One per person, in your project |
| Offline | Yes | Yes | Yes |
| Cost | Free | Your Supabase plan (free tier to start) | Same |

---

## 1. Local

```sh
git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
~/Developer/Surface/install.sh
cd ~/Surface && surface serve
```

That's a working workspace in `~/Surface`. More workspaces: `surface init ~/Other --create "Other"`. Stop here if one computer is all you need.

## 2. Your cloud

One person does this once. Pick whichever way suits you.

### Guided, in the terminal

From inside the workspace folder:

```sh
surface cloud setup
```

It walks through four checks and skips any that are already done (re-run it any time):

1. **A Supabase project.** Create one at [supabase.com/dashboard](https://supabase.com/dashboard) (free tier is fine), open *Project Settings → API*, and paste the **Project URL** and the **publishable key** (`sb_publishable_…`; older projects call it *anon*). Never the secret (service role) key: Surface refuses it.
2. **Surface's tables.** It writes `surface-schema.sql` and gives you the link to your project's SQL editor; paste, *Run*, press Enter.
3. **Your account.** Sign up (or sign in) in your project.
4. **This workspace in the cloud.** It runs `surface sync enable`.

### By an agent

Ask Claude Code, Codex, Hermes or any agent to *"set up a cloud for Surface, following skills/surface-setup"*. The skill ([`skills/surface-setup`](../skills/surface-setup/SKILL.md)) covers both paths:

- **With Supabase's MCP server** ([docs](https://supabase.com/docs/guides/ai-tools/mcp)), the agent creates the project, applies the schema and fetches the URL and key itself, after you sign in through the browser and pick the organization (no token to paste), and asks before anything that costs money:
  ```sh
  claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?features=account,database,development,docs"
  ```
- **Without it**, the agent runs `surface cloud setup` with you and tells you what to click.

Either way, you type your own password; agents never handle it.

### By hand

```sh
surface cloud connect https://<ref>.supabase.co sb_publishable_… --name "Our team"
surface cloud schema --out surface-schema.sql     # paste into the SQL editor, Run
surface signup                                    # or: surface login
surface sync enable                               # in the workspace folder
surface cloud                                     # check: project, signed in, tables ready
```

(If you use the Supabase CLI: `supabase db push` with this repo's `supabase/migrations` also creates the tables.)

**Existing projects: inverse relationships require migration 0007.** An authorized administrator can run `surface cloud migrate --since 7` as described below. The manual alternative remains `surface cloud schema --since 7`, applied in the project's SQL editor. A publishable key cannot execute migrations; installing/updating a client does not deploy cloud SQL. Inverse schema writes and sync require the hub's `surface_schema_version()` capability to report at least 7. Missing, older or failed capability responses stop the operation and preserve local changes; an existing connection or a previously successful sync is not proof that this migration is installed.

**Repair for a partially upgraded legacy project:** if 0007 was applied over a database missing 0006, record writes or field removal can fail with `record "new" has no field "aliases"`. Do not replay 0006 over 0007: that would replace the inverse-aware validator/RPC. Apply only the forward repair using administrator-authenticated `surface cloud migrate --since 8` (or export `surface cloud schema --since 8` for an authorized SQL editor). Migration 0008 adds the missing aliases columns/history indexing and removes the obsolete RPC overload without changing stored relationships. A normally upgraded 0006 project can still use `--since 7`, which applies both 0007 and 0008. Cloud schema work is never automatically performed by client installation.

### Administrator migrations from the CLI

`surface cloud migrate --since N [--check]` uses a separate **Supabase personal access token** authorized to administer the configured project. Create it in [Supabase account access tokens](https://supabase.com/dashboard/account/tokens). Surface account login, publishable keys and service-role keys do not authorize this command. Never paste the administrator token into chat, a command argument, an invite or a project config file.

For an existing project with migrations 0001–0006 already installed, run in Bash:

```bash
read -r -s -p "Supabase administrator access token: " admin_token
printf '\n'
SUPABASE_ACCESS_TOKEN="$admin_token" surface cloud migrate --since 7 --check
SUPABASE_ACCESS_TOKEN="$admin_token" surface cloud migrate --since 7
unset admin_token
```

`--since` is required: it declares every earlier migration already installed, without inventing history for it. Use `--since 1` only for a new project; SQL-editor/MCP installations must identify their existing baseline before using this command. Keep the same baseline on later runs; matching ledger entries are skipped. `--check` performs read-only queries and creates no schema or ledger.

The apply command locks deployment, rechecks migration names/checksums and runs source SQL plus the private `surface_migrations.history` ledger atomically. A SQL failure rolls the deployment back; changed files, unknown/ahead versions and gaps are refused. Concurrent or repeated runs do not reapply matching migrations. If a response is lost after a possible commit, the CLI does not retry automatically: run `--check`, then rerun the explicit apply if needed.

The token is read only from `SUPABASE_ACCESS_TOKEN`, sent only to the fixed HTTPS Supabase Management API, and is not saved by Surface. Hosted `https://<project-ref>.supabase.co` URLs are required; custom/self-hosted URLs, paths, ports and redirects are refused for this administrator operation. This uses Supabase's [Management API SQL endpoint](https://supabase.com/docs/reference/api/v1-run-a-query), currently Beta. The browser, server startup and `surface update` never invoke cloud deployment automatically.



### Two Supabase settings worth changing for a team

In *Authentication → Providers → Email* and *→ Emails*:

- New accounts must **confirm their email** by default. Fine, but your teammates then click a link before they can join.
- The built-in mailer sends only **a few emails an hour**. Set up custom SMTP (any provider) before inviting several people, or they'll hit "too many signup emails".

## 3. Share

Sharing needs the workspace in your cloud (step 2). See who has it:

```sh
surface share
```

### Your other computers

```sh
surface share device            # prints a one-line join command (--mail: email it to yourself)
                                # uses this folder's workspace; elsewhere it asks which one (or pass --workspace <name>)
```

On the other computer: install Surface, then run the line it printed:

```sh
surface join surface-invite:eyJ1cmwiOi…
```

It connects that computer to your project, asks for your password, and puts a full copy of the workspace there. Repeat for every computer.

### Other people

As an owner or admin:

```sh
surface share invite anna@yourco.com --role member          # prints a ready-to-send message
surface share invite anna@yourco.com --role member --mail   # opens it as a draft in your email app
```

In the app: **Share** (sidebar) → enter the email, pick a role, **Invite**. The panel shows the message with **Copy** and **Email it**, and the *Use it on another computer of yours* row gives your own join command.

Anna installs Surface and runs the one line from the message. It connects her computer to your project, has her create an account (or sign in) as `anna@yourco.com`, accepts the invite, and copies the workspace to her computer. **Her other computers:** she runs `surface share device` on hers and does the same, with her own account.

**Is the join code safe to email?** Yes. It holds your project's URL, its publishable key, the workspace id and the email it's for. No password, no secret key. The publishable key is designed to be public; row-level security in your database decides who sees what. An invite works only for the invited email, and only after that person signs in.

### Roles and access

| Role | Can |
|---|---|
| owner | everything, including deleting the workspace |
| admin | invite and remove people, change roles, edit tables and fields, edit shared views |
| member | create and edit records and views |
| viewer | read only |

```sh
surface workspace role anna@yourco.com viewer
surface workspace remove-member anna@yourco.com     # her computers keep their copy; it stops syncing
surface workspace uninvite anna@yourco.com          # cancel a pending invite
```

---

## Command reference

| Command | Step | What it does |
|---|---|---|
| `surface cloud` | 2 | This computer's project, who's signed in, whether the tables are ready |
| `surface cloud setup` | 2 | Guided: project, tables, account, sync this workspace |
| `surface cloud connect <url> <key>` | 2 | Use your Supabase project |
| `surface cloud schema [--out file]` | 2 | The SQL that creates Surface's tables |
| `surface cloud migrate --since N [--check]` | 2 | Explicit administrator migration deployment; check is read-only |
| `surface cloud disconnect` | 2 | Forget the project; local workspaces keep working |
| `surface signup` / `login` / `logout` | 2 | Your account in that project |
| `surface sync enable` | 2 | Put a local workspace in the cloud and keep it synced |
| `surface share` | 3 | Who has this workspace |
| `surface share device [--mail]` | 3 | A join command for your other computer |
| `surface share invite <email> [--role] [--mail]` | 3 | Invite someone; prints their message and join command |
| `surface join <code>` | 3 | On the joining computer: connect, sign in or up, copy the workspace |
| `surface sync list` / `sync join <id> <folder>` | 3 | Copy one of your cloud workspaces here by id (alternative to `join`) |
| `surface workspace role` / `remove-member` / `uninvite` | 3 | Manage access |

Config is per user in `~/.config/surface-cli/`: `cloud.json` (project URL and publishable key; shareable), `session.json` (your sign-in; private, never share it). `SURFACE_SUPABASE_URL` and `SURFACE_PUBLISHABLE_KEY` override `cloud.json`.

## Testing (for contributors)

`npm run test:team` (in `cli/`) runs the whole path against the project this computer is connected to: a local workspace, `sync enable`, a second computer of yours joining with `share device`, a teammate joining with `share invite` + `join`, and edits flowing between them. It makes a temporary workspace and deletes it.

## Logs

Every Surface process (the single app server, CLI commands, sync) writes one shared log:

- Linux `~/.local/state/surface/surface.log`, macOS `~/Library/Logs/Surface/surface.log`, Windows `%LOCALAPPDATA%\\Surface\\Logs\\surface.log`. `surface log path` prints it.
- `surface log` shows the last 50 lines; `--area sync`, `--level warn`, `--follow`.
- Logged by default: server start (port, workspace, store, whether it owns the database, sync on/off), shutdowns and crashes, every sync round that moved anything (pushed, pulled, conflicts, errors, time), going offline and back, conflicts, failed pushes and pulls with record id and revisions, failed or slow API requests, file-watcher pushes.
- `SURFACE_LOG=debug` adds every API request and every record a sync sends or receives. `SURFACE_LOG_FILE=<path>` moves it, `=off` turns it off.
- One line per event with the process (`serve:4317`, `cli push`) and pid. Rotates at 5 MB, keeps 3. Tokens, keys and record bodies are never logged.

## Updating an installed computer

Publish an immutable stable Git tag (`vMAJOR.MINOR.PATCH`) to the installation's `origin`, then run `surface update --check` / `surface update` on the client. Branch tips and prereleases are not client releases. Installation refuses dirty/divergent code, prepares dependencies and the app before stopping the old server, backs up stopped local data/config, activates a separate release through a stable path, and checks the actual running revision. A stopped server stays stopped. Cloud schema deployment remains a separate step; installing a client never changes shared schema automatically.

Updates are exclusively explicit CLI operations. The browser keeps read-only release currency inside Surface status, not update jobs or installation controls. After the running server changes, it offers an explicit Reload action that refuses while editor drafts are unsaved; it never reloads automatically. There are no automatic-install modes or update schedules; explicit installation/setup removes legacy Surface update timers/launch agents. `--check` only caches status and does not alter schedules or the installation.

If activation fails, recovery restores the previous code path and stopped local database snapshot before restarting the previous server. The attempted database is retained as `failed-db` for inspection; code rollback alone cannot undo local migrations. Cloud-side accepted writes and schema changes are never rolled back, so snapshot restoration is not a distributed rollback guarantee. For migration from old branch-based/two-server installations, publication instructions, manual recovery and a real isolated local-Git smoke fixture, see [the CLI release policy](../cli/README.md#updates-and-one-background-server).
