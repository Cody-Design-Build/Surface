# Surface: how outside agents work in a workspace

**Status:** Bring-your-own-agent and files-first are **decided** (Oct 13). The rest is **leaning** unless marked open. Summary in `SPEC.md` §10.

## The idea

**Surface doesn't ship an agent.** You bring your own: Claude Code, Codex, Cursor, Gemini CLI, Copilot, Hermes or whatever comes next.

- **The workspace is a folder of Markdown files,** so any agent that can read and write files can already work in it. No MCP server, API or account is needed.
- **What an agent needs is knowledge, not access:**
  - what the files mean;
  - how records, types, IDs and links work;
  - the rules (edit in place, never delete without asking);
  - the team's workflows.
- **Surface provides that knowledge as plain files,** using the two open standards agents already read:
  - **`AGENTS.md`:** the entry point;
  - **Agent Skills (`SKILL.md` folders):** the how-to.

This is the same no-lock-in idea applied to agents: **no agent lock-in either.** Switch agents, or mix them on one team, and the workspace works the same.

**Precedent:** Obsidian's CEO publishes `kepano/obsidian-skills` (about 49k stars), Agent Skills that teach any agent Obsidian's Markdown, Bases and Canvas formats. Surface does the same for its own conventions. It ships with the workspace instead of as a separate install.

## The standards (checked Oct 13, 2026)

- **`AGENTS.md`** ([agents.md](https://agents.md/)): a README for agents, used by over 60k projects.
  - Read by Codex, Cursor, Gemini CLI, Copilot, Zed, Amp, Aider and others.
  - **Claude Code reads it since 2.1.277 (Sep 18, 2026),** but only when there's no `CLAUDE.md` in the folder.
- **Agent Skills** ([agentskills.io](https://agentskills.io/specification)): a folder containing `SKILL.md` (a name, a description, then instructions), plus optional `references/`, `scripts/` and `assets/`.
  - **Progressive disclosure:** agents see only names and descriptions until a skill is relevant, then load it. Many skills cost almost nothing until used.
  - **Project skills live in `.agents/skills/`.** It's read by Codex (its primary location), Cursor, Gemini CLI, VS Code Copilot, Zed, Amp, Goose, OpenCode and others.
  - **Claude Code is the exception:** it reads only `.claude/skills/`, not `.agents/skills/`. Cursor also reads `.claude/skills/` for compatibility.

## What Surface writes into a workspace

```
My Workspace/
  AGENTS.md                      the entry point (short, stable)
  .agents/skills/
    surface-workspace/SKILL.md   core: layout, records, IDs, links, rules
    surface-types/               generated from the workspace's types
      SKILL.md
      references/task.md         one file per type: fields, choices, examples
      references/project.md
    surface-views/SKILL.md       how to read and write view files (.surface/views/)
    surface-flags/SKILL.md       how to read and resolve flags
    surface-import/SKILL.md      tables to records, CSV, new notes
    weekly-review/SKILL.md       a team workflow (user-authored)
    new-job-setup/SKILL.md       a team workflow (user-authored)
  .claude/skills/                a copy of .agents/skills/, for Claude Code
  .surface/
    flags/                       open flags as readable files (see below)
    ...
```

### `AGENTS.md`: the entry point

- **Short and stable.** It says:
  - this is a Surface workspace;
  - records are Markdown files with front matter;
  - load the `surface-workspace` skill before changing anything;
  - the five hard rules.
- **Rarely changes,** so it's safe to let users add their own instructions below Surface's part. Surface never rewrites a user's text in it.
- **`CLAUDE.md`:** Surface doesn't create one. Claude Code falls back to `AGENTS.md` when there's no `CLAUDE.md`. If the user already has a `CLAUDE.md`, Surface offers to add `@AGENTS.md` to it.

The hard rules (draft):

1. Prefer the `surface` CLI for changes. If you edit a file, change only what you mean to, then run `surface push`. Unpushed edits are overwritten. Never reformat or rewrite a whole file.
2. Every record needs `id` and `type` in its front matter. New IDs follow the recipe in `surface-workspace`.
3. Never delete a record without the user's approval. (Surface flags deletions anyway.)
4. Never touch `.surface/local/`.
5. After pushing, fix anything `surface push` rejected or flagged.

### Skills Surface ships

- **Surface-shipped skills start with `surface-`.** Surface owns them and regenerates them when the workspace changes (for example, when a type gains a field). Users don't edit them.
- **`surface-types` is generated per workspace:** one reference file per type, listing its fields, kinds, choice options, link targets and an example file. The agent knows this workspace's Task fields, not just generic ones.
- **The ID recipe** is a few lines any agent can follow in any language: creation time plus random characters, lowercase base32. An agent that gets it wrong just produces a flag ("invalid ID"), never corruption.

### Workflows and team skills

- **Users and teams write their own skills:** "weekly review", "new job setup", "turn meeting notes into tasks", "client update email".
- **In Surface, skills are just documents:** a "Skills" section in the sidebar lists them and edits them like any note. They're saved as standard `SKILL.md` folders.
- **They sync with the workspace,** so every teammate's agent (whichever agent it is) gets the same playbook. **Your team's way of working travels with the data.**
- **Surface never touches skills without the `surface-` prefix.**

## Working without an API: what agents can and can't do through files

| Need | How, through files |
|---|---|
| Read records | Read the Markdown files |
| Find records | Search the files (grep), filtering on front matter |
| Create, edit, link | Write files following the skills |
| Totals, backlinks | Compute them from the files; nothing is hidden in the database |
| Know whether an edit was valid | Run `surface push` (Stage 1, SPEC §6): it validates, applies, or rejects with the reason; problems also go to `.surface/flags/` |
| Resolve a flag | Edit the flag file's `resolution:` field, or fix the record |
| Make a view | Write a view file in `.surface/views/` (`surface-views`); embed it in a page with `![[View name]]` |

- **Live, for free:** when Surface is running, it notices file changes within moments. An agent editing files shows up live in the app and syncs to the team, with no special connection.
- **Flags as files** make the "needs attention" view available to agents too. "Clean up my flags" becomes an agent task.
- **Grouped outside edits:** a burst of edits made outside Surface (for example, an agent changing 40 files) shows as one change in history: *"40 files changed outside Surface: review or undo all."*

## The CLI and local MCP (headless core, SPEC §3a)

Surface's base is a headless core with a background service (`surfaced`) and a `surface` CLI. The app is one client. So agents get more than files when they want it:

- **`surface` CLI:** exact operations with immediate validation, for example:
  - `surface new task "Order cabinets" --project "Kitchen Remodel"`;
  - `surface query`, `surface check`, `surface flags`, `surface undo`.
- **`surface mcp`:** the same operations as a local MCP server, for agents that prefer tools.
- **Attribution:** edits through the CLI or MCP record who made them (`--as codex`, or `SURFACE_AGENT=codex`). Raw file edits show as "edited outside Surface".
- **Sync without the app:** `surfaced` keeps the workspace in sync with the team, so an agent on a server can work in a team workspace with no GUI at all.
- **The skills say:** use `surface` if it's installed; otherwise work with the files. Both paths end up in the same place.
- **Remote MCP or API: later,** only for agents that can't see the files (Claude or ChatGPT on the web, phone assistants).

## Open

1. **Knowing who edited:** solved for CLI and MCP edits. Raw file edits stay "edited outside Surface". Should the skills prefer the CLI when it's available, so most agent edits get attributed?
2. **Agent-built surfaces beyond views:** custom interactive pages (HTML or app-like) that an agent writes and Surface renders with live data. Format, sandboxing and how they read data are all open.
3. **Where the user's workflow skills live:** hidden `.agents/skills/` (the standard), or a visible `Skills/` folder mirrored there.
4. **Copy or symlink for `.claude/skills/`:** symlinks are cleaner, but they may not survive Dropbox, iCloud or Windows.
5. **Workspaces inside a code repository** (where `AGENTS.md` may already exist for the code): how to merge the two.
