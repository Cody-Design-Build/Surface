# Surface: agents, shared data and surfaces

**Current direction, Oct 14, 2026.** Agents help humans work with Surface's headless, mutable database foundation. Markdown is the first and foundational bridge; the CLI is the built interface for exact operations. See [SPEC §10](SPEC.md#10-agents).

## The agent's role

Bring your own agent. Surface does not require one particular model or provider. An agent can help define types and relationships, organize records, answer questions, perform updates and create a useful surface for the work at hand.

Markdown is the native working language of LLMs and a practical shared medium with humans. An agent can read and edit the same files a person opens in Obsidian or another editor. The foundation supplies shared storage, typed data, validation, permissions and history independently of the editor or agent.

An existing checkout can be read and edited offline without an API connection. Pulling fresh data or applying those edits to the database requires the CLI and a signed-in account. The MVP has no background service or automatic file watcher.

## Two supported ways to work

**Prefer the CLI for exact changes:**

```sh
surface type add project
surface type add task
surface field add task project --kind link --target project
surface new project "Kitchen Remodel"
surface new task "Order cabinets" project="Kitchen Remodel"
surface query task --where "project=Kitchen Remodel" --json
surface set "Order cabinets" title="Order oak cabinets"
```

**Or edit Markdown, then push:**

1. Read the checkout's generated instructions and type definitions.
2. Edit the intended fields and body, preserving existing `id`, `type` and `rev` values unless changing the type intentionally.
3. For a new file, use `type:` and `title:` front matter, with no ID; the database assigns one. A file without a type defaults to page.
4. Inspect with `surface status`, `surface diff` and `surface check`.
5. Apply edits with `surface push`, or import new files with `surface push --new`.
6. Resolve any normalization notices, validation failures or conflicts.

Both routes use the database's validation and permissions. Safe fixes are normalized and reported; unusable values are rejected. A stale revision is rejected rather than merged. Normal pull keeps files with unpushed edits. To resolve a conflict, preserve the intended edit, inspect the current database record, then deliberately refresh and reapply it; `pull --force` discards local edits.

Deleting a local file does not delete its database record. `surface status` reports it as missing; `surface pull` restores it. Use `surface rm` for an intentional soft deletion and `surface restore` to undo it.

## What the checkout writes today

```text
My Workspace/
  AGENTS.md
  .agents/skills/surface/SKILL.md
  .claude/skills/surface/SKILL.md
  .surface/
    config.json
    state.json
    types/<type>.yaml
    views/sidebar.yaml             when a sidebar view exists
  Pages/
  ...                              records in the chosen layout
```

- **`AGENTS.md`** is the generated entry point. The current implementation regenerates the whole file on pull; keep personal instructions in a separate file. Preserving user additions in place is future work.
- **The Surface skill** explains the workflow and the workspace's current types. It is written under `.agents/skills/` and copied to `.claude/skills/` for agent compatibility.
- **`.surface/types/*.yaml`** are readable schema copies. Change types through `surface type …` and `surface field …`.
- **`.surface/views/*.yaml`** are editable saved definitions. `surface tree init` creates a starting sidebar; check edits with `surface tree check`, then push them.
- **Config and state** belong to the checkout machinery; agents should not edit them directly.

The MVP generates one Surface skill. It has no `surface-flags` skill, persistent flags directory, automatic file synchronization or grouped undo for batches of outside edits. Problems are reported by the CLI. Record changes are attributed to the signed-in account; raw file authorship does not identify a separate agent.

## Agents also create surfaces

The Markdown checkout is the starting point. Agents should also be able to produce the interface a person needs, wherever it is useful:

| Need | Possible surface |
|---|---|
| Review a project's state | A PDF report, reflecting data at generation time |
| Update a small set of fields | A focused widget or web interface |
| Explore a question | An interactive artifact, inspired by Claude artifacts and similar experiences in Codex |
| Bring context into a conversation | A canvas in Slack or another collaboration host |
| Work across the whole workspace | The planned dedicated Surface app |

These are product directions, not implemented integrations. A snapshot needs a read at generation time. A connected surface needs authorized data access, an explicit freshness model, and validated write-back if it offers editing. It should act on the shared records rather than become a separate source of truth.

A surface need not run inside the Surface app or use Markdown internally. The dedicated app remains planned for polished writing and browsing, plus management of teams, types and relationships. Agents and other surfaces can use the foundation independently of it.

## Planned and open

- **MCP access:** later, for agents that cannot run the CLI or access files. It should expose the same underlying operations and permissions.
- **Generated surfaces:** formats, supported hosts, rendering, hosting, saving and sharing; authentication, scoped access and write-back; snapshot versus live refresh.
- **Team workflows:** reusable skills such as weekly reviews and new-project setup. Their editing and sharing in the app are not implemented.
- **Authorship and review:** per-agent identity, review of batches, and undo beyond inspecting history and restoring deleted records.
- **Instruction ownership:** preserving user-authored `AGENTS.md` content when a checkout shares a folder with a code repository.

Older multi-skill, file-watcher and flag-file proposals have been removed from this guide so it describes the built workflow and names future work explicitly.
