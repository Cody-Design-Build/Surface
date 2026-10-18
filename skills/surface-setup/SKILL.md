---
name: surface-setup
description: Install Surface; set up a private cloud or join a team.
version: 0.1.0
author: David Cody (Cody-Design-Build), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [surface, setup, supabase, onboarding, teams]
    related_skills: []
---

# Surface setup

Gets someone from nothing to a working Surface: installed and local (the default), optionally connected to **their own** Supabase project for sync and teams, or joined to a team that invited them. Surface has no hosted service. Never point anyone at a project they don't own or weren't invited to.

## When to Use

- "Install Surface", "set up Surface on my laptop"
- "Sync Surface between my computers", "share Surface with my team", "set up a cloud"
- Someone has a `surface-invite:` code or an invite email
- `surface` errors say "No cloud is set up on this computer"

Don't use for: day-to-day record work inside a checkout (that's the checkout's own `surface` skill in `.agents/skills/surface/`).

## Decide the path first

Ask only if it isn't clear from the request:

1. **Local only:** one computer, no account. Stop after Install.
2. **Joining a team:** they have a `surface-invite:` code. Install, then Join.
3. **Their own cloud:** sync their computers or host a team. Install, then Cloud.

## Install (all paths)

```
terminal(command="git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface && ~/Developer/Surface/install.sh", timeout=600)
```

Done when the output ends with "Surface is set up." If it warns that `~/.local/bin` isn't on PATH, add the line it prints to the shell rc file, or call `~/.local/bin/surface` by full path for the rest of the session. Check with `terminal(command="surface doctor")`: it should print "All good."

## Join a team (invite code)

```
terminal(command="surface join 'surface-invite:…'", timeout=300)
```

It asks for a password (new or existing account for the invited email). The person types it themselves. Never ask for it, echo it, or put it in a command. Outcomes:

- "Done. … is in ~/Surface-<name>": finished. Open with `cd ~/Surface-<name> && surface serve`.
- "Check … for a confirmation email": they click the link, then run the same command again.
- "too many signup emails": the team's project hit Supabase's email limit. Wait, or ask their admin.
- "connected to another cloud": add `--force` only if they confirm they want to switch projects.

## Set up their own cloud

**If the Supabase MCP server is connected** (tools like `list_organizations`, `create_project`, `apply_migration`, `get_publishable_keys`): the agent can do steps 1, 2 and 4 itself. Setup for the person: `claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?features=account,database,development,docs"`, then sign in through the browser prompt. It uses OAuth and they pick the organization; there's no token to paste.

- `list_organizations`: ask which org. Then `get_cost` and `confirm_cost` (or the client's cost form): tell them the price, free or paid, and only continue on a yes. Then `create_project` (name, region near them). Poll `get_project` until it's healthy, a few minutes.
- Run `surface cloud schema --out surface-schema.sql`, then `apply_migration` with name `surface_schema` and the file's contents as the query. Done when `list_tables` shows `workspaces`, `records`, `types`, `views`, `invites`.
- `get_project_url` and `get_publishable_keys`: take the **publishable** key (`sb_publishable_…`), never a secret one. Go to step 3.
- MCP can't change Auth settings: the email confirmation and SMTP advice in step 6 stays manual (dashboard).
- Scope the MCP connection to the new project afterwards (`?project_ref=<ref>`), or remove it. Surface itself never needs it.

**Without MCP**, by hand:

1. They create a project at supabase.com/dashboard (free tier is fine). You can't do this for them: it's their account.
2. They copy the **Project URL** and the **publishable key** (`sb_publishable_…`, or the legacy anon key) from *Project Settings → API*. Never the secret/service-role key; Surface rejects it.
3. Connect:
   ```
   terminal(command="surface cloud connect <url> <publishable key> --name '<team name>'")
   ```
4. If it says the tables are missing, write the schema and have them run it in the SQL editor (the command prints the exact link):
   ```
   terminal(command="surface cloud schema --out surface-schema.sql")
   ```
5. Account and first workspace:
   ```
   terminal(command="surface signup")      # interactive; they type the password
   terminal(command="cd ~/Surface && surface sync enable")
   terminal(command="surface cloud")
   ```
   Done when `surface cloud` shows the project, "Signed in: <email>", and "Surface tables: ready".
6. Recommend, for teams: custom SMTP in *Authentication → Emails* (the built-in mailer sends only a few emails an hour).

## Invite teammates

From inside the workspace folder, as owner or admin:

```
terminal(command="surface workspace invite <email> --role member")
```

It prints a subject and body to send (`--mail` opens a draft in their email app). The body contains a `surface join` code with the project URL, publishable key and invitee email. That's safe to email; there are no secrets in it.

## Pitfalls

- `surface login` / `signup` need a cloud configured first (`surface cloud connect` or `surface join`).
- An invite is tied to one email. The teammate must sign in as exactly that address.
- `install.sh` is bash: macOS and Linux. On Windows use WSL.
- Joining copies the workspace into a new local database. Edits sync while `surface serve` runs, or with `surface sync`.
- Config is per user in `~/.config/surface-cli/` (`cloud.json`, `session.json`). Don't commit or paste `session.json`.
- Supabase MCP `create_project` can cost money on paid orgs: always show the cost and get a yes first. Never use `execute_sql` to read or change a team's records; Surface's CLI does that, under row-level security.

## Verification

- Local: `surface doctor` prints "All good."
- Cloud: `surface cloud` shows the project, signed in, tables ready.
- Team: the teammate's folder has the workspace files, and `surface sync status` in it shows "Hub: the cloud".
