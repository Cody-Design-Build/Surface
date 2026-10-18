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

Every computer keeps a **full copy** in its own database and works offline. The cloud is the hub they sync through, record by record; if two computers change the same record, one version is kept and the other saved as a conflict copy ([`LOCAL.md`](LOCAL.md) §1b).

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
