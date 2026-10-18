---
name: surface-setup
description: Install Surface; set up its cloud; share with devices/people.
version: 0.2.0
author: David Cody (Cody-Design-Build), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [surface, setup, supabase, onboarding, sharing, teams]
    related_skills: []
---

# Surface setup

Takes someone through Surface's three steps: **local** (install, works with no account), **their cloud** (their own Supabase project, for sync), and **share** (their other computers, other people). Surface has no hosted service. Never point anyone at a project they don't own or weren't invited to. Full guide for humans: `docs/CLOUD.md`.

## When to Use

- "Install Surface", "set up Surface on my laptop"
- "Sync Surface between my computers", "set up the cloud", "share with my team"
- They have a `surface-invite:` code or an invite email
- `surface` says "No cloud is set up on this computer" or "only on this computer"

Don't use for: record work inside a checkout (the checkout's own `.agents/skills/surface/` skill covers that).

## Pick the step

Check state first, then do only what's missing:

```
terminal(command="surface doctor; surface cloud; surface share")
```

- No `surface` command: **Step 1**.
- "No cloud" and they want sync or sharing: **Step 2**.
- "In your cloud": **Step 3**.
- They have a `surface-invite:` code: Step 1 if needed, then **Join**.

## Step 1: local

```
terminal(command="git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface && ~/Developer/Surface/install.sh", timeout=600)
```

Done when the output ends "Surface is set up." and `surface doctor` prints "All good." If it warns `~/.local/bin` isn't on PATH, add the line it prints to the shell rc file (or use `~/.local/bin/surface` for this session).

## Step 2: their cloud

**With Supabase's MCP server connected** (tools `list_organizations`, `create_project`, `apply_migration`, `get_project_url`, `get_publishable_keys`). To connect it: `claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?features=account,database,development,docs"`, then they sign in through the browser prompt (OAuth, they pick the org; no token).

1. `list_organizations`: ask which one. Cost: `get_cost` → tell them the price → `confirm_cost` only on a yes (or the client's cost form). `create_project` with a name and a region near them; poll `get_project` until healthy (minutes).
2. `terminal(command="surface cloud schema --out surface-schema.sql")`, then `apply_migration` with name `surface_schema` and the file's contents. Done when `list_tables` includes `workspaces`, `records`, `types`, `views`, `invites`.
3. `get_project_url` and `get_publishable_keys`: take the **publishable** key (`sb_publishable_…`), never a secret one.
4. `terminal(command="surface cloud connect <url> <key> --name '<label>'")`
5. In the workspace folder, `terminal(command="surface cloud setup")`. It skips the done parts and does sign-up and `sync enable`. **They type the password**; never ask for it, echo it or pass it in a command.

**Without MCP:** run `terminal(command="cd ~/Surface && surface cloud setup")` with them. It prompts for the project URL and publishable key (they create the project at supabase.com/dashboard and copy both from *Project Settings → API*), writes `surface-schema.sql` and prints the SQL-editor link for them to paste and Run, then signs up and syncs.

Done when `surface cloud` shows the project, "Signed in: <email>", "Surface tables: ready", and `surface share` says "In your cloud".

Then recommend, for teams: custom SMTP in *Authentication → Emails* (the built-in mailer sends a few emails an hour), and know that email confirmation is on by default. MCP can't change these; they do it in the dashboard.

## Step 3: share

In the workspace folder:

- **Their other computer:** `terminal(command="surface share device")`. Prints install steps and a `surface join surface-invite:…` line to run there (`--mail` emails it to themselves).
- **Another person:** `terminal(command="surface share invite <email> --role member")`. Prints a subject and body to send (`--mail` opens a draft). Roles: admin, member, viewer.
- **Who has it:** `terminal(command="surface share")`.

The code holds the project URL, publishable key, workspace id and email. That's safe to email; nothing secret.

## Join (on the joining computer)

```
terminal(command="surface join 'surface-invite:…'", timeout=300)
```

They type the password (new account or existing) when asked. Outcomes:

- "Done. … is in ~/Surface-<name>": finished; open with `cd ~/Surface-<name> && surface serve`.
- "Check … for a confirmation email": they click it, then run the same command again.
- "too many signup emails": the project hit Supabase's email limit; wait, or the admin sets up SMTP.
- "connected to another cloud": add `--force` only if they confirm switching projects.
- "aren't a member": the invite is for a different email; the inviter re-sends to the right one.

## Pitfalls

- Sharing needs step 2 first; `share` / `invite` on a local-only workspace refuses with "only on this computer".
- An invite is tied to one email. A device code is for the same person's account.
- Never use the Supabase secret/service-role key, and never `execute_sql` against a team's records. Surface's CLI works under row-level security.
- `create_project` can cost money on paid orgs: show the cost and get a yes.
- `install.sh` is bash (macOS, Linux). On Windows use WSL.
- `~/.config/surface-cli/session.json` is private: never paste or commit it. `cloud.json` is shareable.

## Verification

- Step 1: `surface doctor` → "All good."
- Step 2: `surface cloud` → project, signed in, tables ready; `surface share` → "In your cloud".
- Step 3: on the joined computer, the folder has the workspace's files and `surface sync status` shows "Hub: the cloud".
