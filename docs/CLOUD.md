# The cloud: optional, and yours

Surface works fully on one computer with no account: each computer has its own database (embedded Postgres), and everything stays on that machine. That's the default.

The **cloud** is what you add to sync between your computers or share with a team. It's a [Supabase](https://supabase.com) project that **you** own. Surface has no hosted service, and nobody else's project is involved: not the authors', not anyone's. You create one project for yourself or your team, and every Surface computer that should share data connects to it.

| | Local only (default) | With your cloud |
|---|---|---|
| Where data lives | This computer | Each computer has a full copy; your Supabase project is the hub |
| Account | None | One per person, in your project |
| Offline | Everything works | Everything works; changes sync when back online |
| Several computers / a team | No | Yes: members, roles (owner, admin, member, viewer), invites |
| Cost | Free | Whatever your Supabase plan costs (the free tier is enough to start) |

## Set up a cloud (once, by one person)

1. **Create a Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard) (free tier is fine). Pick a region near your team. Save the database password somewhere safe; Surface doesn't need it.

2. **Connect this computer** to it. In the dashboard, open *Project Settings → API* (or *Data API*), and copy the **Project URL** and the **publishable key** (`sb_publishable_…`; older projects call it the *anon* key):

   ```sh
   surface cloud connect https://<ref>.supabase.co sb_publishable_… --name "Our team"
   ```

   Never use the **secret** (service role) key. Surface refuses it.

3. **Create Surface's tables.** Surface tells you if they're missing:

   ```sh
   surface cloud schema --out surface-schema.sql
   ```

   Open the project's *SQL Editor → New query*, paste the file, and *Run*. (If you use the Supabase CLI, `supabase db push` with this repo's `supabase/migrations` does the same.)

4. **Make your account and put a workspace in the cloud:**

   ```sh
   surface signup                 # or surface login
   cd ~/Surface && surface sync enable
   surface cloud                  # checks: project, signed in, tables ready
   ```

**Auth settings worth a look** (*Authentication → Providers → Email* and *→ Emails*): Supabase confirms new accounts by email by default, and its built-in mailer sends only a few emails an hour. For a team, set up custom SMTP, or have each person sign up before you invite them.

### Or let an agent do it (Supabase MCP)

Supabase's official [MCP server](https://supabase.com/docs/guides/ai-tools/mcp) lets an agent (Claude Code, Cursor, Codex…) create the project, apply Surface's schema and fetch the URL and publishable key, after you sign in through your browser and pick the organization:

```sh
claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?features=account,database,development,docs"
```

Then ask: *"Set up a Supabase cloud for Surface, following skills/surface-setup."* The agent asks for your OK on any cost, creates the project, runs `apply_migration` with `surface cloud schema`, and finishes with `surface cloud connect` and `surface signup` (you type the password). Two settings stay manual in the dashboard: email confirmation and SMTP (below). Once you're set up, scope or remove the MCP connection; Surface doesn't use it.

## Bring in your team

Invites go by email address. As an owner or admin, in the workspace:

```sh
surface workspace invite anna@yourco.com --role member          # prints a ready-to-send message
surface workspace invite anna@yourco.com --role member --mail   # or opens it as a draft in your email app
```

The message has install steps and one command for them to run:

```sh
surface join surface-invite:eyJ1cmwiOi…
```

That one command connects their computer to your project, has them create an account (or sign in) as the invited email, accepts the invite, and copies the workspace to their computer. Then `cd` into it and `surface serve`.

**Is it safe to email?** Yes. The invite code holds your project's URL, its publishable key and the invitee's email: no password, no secret key. The publishable key is designed to be public; row-level security in the database decides who sees what. The code only works for the invited email, and only after that person signs in.

**Roles:** owner (everything, including deleting the workspace), admin (members, types and fields, shared views), member (records and views), viewer (read only). Change them with `surface workspace role <email> <role>`, remove people with `surface workspace remove-member <email>`.

## Another computer of your own

On the new computer: install Surface, then

```sh
surface cloud connect https://<ref>.supabase.co sb_publishable_…
surface login
surface sync list                       # your cloud workspaces, with the join command for each
surface sync join <workspace id> ~/Surface-team
```

Or invite yourself (`surface workspace invite you@…`) and use the `surface join` line.

## Commands

| Command | What it does |
|---|---|
| `surface cloud` | Which project this computer uses, who's signed in, whether the tables are ready |
| `surface cloud connect <url> <key>` | Use your Supabase project |
| `surface cloud schema [--out file]` | The SQL that creates Surface's tables in a new project |
| `surface cloud disconnect` | Forget the project; local workspaces keep working |
| `surface signup` / `login` / `logout` | Your account in that project |
| `surface sync enable` | Put a local workspace in the cloud and keep it synced |
| `surface sync list` / `sync join` | Copy a cloud workspace to this computer |
| `surface workspace invite <email> [--mail]` | Invite someone; prints their `surface join` code |
| `surface join <code>` | A teammate's one step |

Config lives in `~/.config/surface-cli/`: `cloud.json` (project URL and publishable key), `session.json` (your sign-in, private). `SURFACE_SUPABASE_URL` and `SURFACE_PUBLISHABLE_KEY` override `cloud.json`.

How sync works (record by record, conflicts kept as copies): [`LOCAL.md`](LOCAL.md) §1b.
