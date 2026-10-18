# Surface

Surface is an agent- and platform-agnostic place where people keep the artifacts and Markdown files their work needs, and share any part of them with their team or with people outside it.

- **Any agent:** Claude Code, Codex, Hermes, a local model or a script all work through the same CLI, files and API.
- **Any surface:** the CLI is the core. The web UI, Obsidian, a generated HTML page or a PDF are views of the same data.
- **Markdown and artifacts:** Markdown for text people and agents write; HTML artifacts (reports, dashboards, one-off editors) for what people need to see or act on. Both are typed records, linked to the data.
- **Share any part:** a workspace, a view, a record or one artifact, with teammates or outside people, by link or invite, with the access set per share.

Underneath is a headless, mutable database foundation: Notion's pages, types and relationships made independent of any one interface.

## Thesis

People need three things:

1. **Data:** persistent, shared records and relationships. Users and agents can create and change types and fields as their work evolves.
2. **Agents:** assistants that help people organize, query and act on that data, reducing the need to build dedicated software for every workflow.
3. **Surfaces:** the human interfaces through which people see and interact with the data, wherever the work happens.

That's the name: the foundation holds the data and its meaning; a surface is where a human touches it.

## Many surfaces, one foundation

A surface can be a Markdown workspace in Obsidian, a PDF report, a widget, a small web interface, an agent-generated artifact, or a canvas in Slack. Claude's artifacts and similar experiences in Codex illustrate the idea: ask for a useful interface to the work at hand, and an agent produces it.

Surfaces have different levels of interactivity. A PDF shows a snapshot of the data when it was generated. A connected widget can show live values and let someone edit records. A surface can be temporary or permanent, personal or shared. It does not have to live inside the dedicated Surface app.

These are product directions, not a list of integrations already built. The foundation supplies persistence, types, relationships, validation, permissions and history; each surface presents the part of the work someone needs.

## Markdown first

The Markdown checkout is the first and foundational surface. Markdown is the native working language of LLMs: readable text they can reason about and edit directly, and a practical bridge to human work. People can read and edit the same documents in Obsidian or any text editor. YAML front matter carries typed values and links; the body carries prose.

The database is the source of truth: Supabase today, and a local mode on one computer with no account is planned ([`docs/LOCAL.md`](docs/LOCAL.md)). `surface pull` checks a workspace out as Markdown, and `surface push` sends edits back with validation and revision checks. Make a page or task in Obsidian, then use the CLI to normalize safe fixes and add it to the database. Files are an editable surface and a portable copy of the work.

## The dedicated app

The CLI is the core: every capability exists there first, for people and agents. The web UI, served by `surface serve`, is a visualizer: it renders the records, views and sidebars the CLI defines, and doesn't get features of its own (SPEC §9). A hosted mode for teammates in a browser is planned.

## No lock-in

Records can be pulled as readable Markdown, with types and saved views in YAML. The long-term promise is that everything authored can be exported in open, readable formats; planned features must preserve that promise. Validation and collaboration come from Surface, while the files remain useful in Obsidian, VS Code or another editor.

## Status

- **Built:** the Supabase types engine and TypeScript CLI, including Markdown pull/push, type and field editing, queries, nesting, folder layouts and saved navigation trees.
- **Built, first version:** the web UI in local mode (`surface serve`): sidebars, live-preview Markdown editor, typed properties, full-page and embedded views, several workspaces, search, autosave with conflict handling and live updates.
- **Next:** artifacts as records (agents make them, any surface shows them), sharing any part with outside people, and closing the gaps where the web UI can do something the CLI can't.
- **Built (Oct 18):** local mode: every computer has its own Postgres (PGlite), no account, the default. `install.sh` + `surface setup` install the whole system.
- **Planned:** the optional sync and team layer for local workspaces, hosted mode, push on save, the Obsidian plugin.

## Try it

```sh
git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
~/Developer/Surface/install.sh
cd ~/Surface && surface serve
```

No account: your data lives in a Postgres database on this computer. Details, and running it on a remote Linux machine: [`cli/README.md`](cli/README.md#install).

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): current product direction, architecture and build plan.
- [`docs/TODO.md`](docs/TODO.md): open questions as a checklist to work through.
- [`docs/MVP.md`](docs/MVP.md): what the first implementation does and what it tests.
- [`cli/README.md`](cli/README.md): installation, CLI usage and running the app.
- [`app/README.md`](app/README.md): the app's code.
- [`docs/LOCAL.md`](docs/LOCAL.md): local mode (one computer, no account) and sync mode (teams).
- [`docs/DESIGN.md`](docs/DESIGN.md): the web UI's visual direction.
- [`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md): how agents use the foundation and help create surfaces.
- [`docs/OBSIDIAN.md`](docs/OBSIDIAN.md): using the foundational Markdown surface in Obsidian.
- [`docs/research/`](docs/research/): dated technology research, not implementation decisions.
- [`docs/notes/`](docs/notes/): design history; the current spec takes precedence.
- [`docs/IMPORT.md`](docs/IMPORT.md): importing existing vaults (parked).
