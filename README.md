# Surface

Surface is a headless, mutable database foundation for humans and agents, with many ways to view and work with the same data. Think of Notion's pages, types and relationships made independent of any one interface.

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

Supabase is the source of truth. `surface pull` checks a workspace out as Markdown, and `surface push` sends edits back with validation and revision checks. Make a page or task in Obsidian, then use the CLI to normalize safe fixes and add it to the database. Files are an editable surface and a portable copy of the work.

## The dedicated app

A dedicated Surface app is planned. It will offer an Obsidian-like writing and browsing experience with the visual polish of Bear and Margin. It will also provide the tools to manage workspaces, teams, permissions, types, fields and relationships.

The app is a first-class client of the same foundation that powers Markdown checkouts and other surfaces. Its desktop technology and relationship to the planned browser experience remain open.

## No lock-in

Records can be pulled as readable Markdown, with types and saved views in YAML. The long-term promise is that everything authored can be exported in open, readable formats; planned features must preserve that promise. Validation and collaboration come from Surface, while the files remain useful in Obsidian, VS Code or another editor.

## Status

The Supabase types engine and TypeScript CLI MVP are built, including Markdown pull/push, type and field editing, queries, nesting, folder layouts and saved navigation trees. The dedicated app, Obsidian plugin, browser interface and other connected surfaces are planned. The Markdown workflow is the foundation for testing the product now.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): current product direction, architecture and build plan.
- [`docs/MVP.md`](docs/MVP.md): what the first implementation does and what it tests.
- [`cli/README.md`](cli/README.md): installation and CLI usage.
- [`docs/DESIGN.md`](docs/DESIGN.md): the dedicated app's role and visual direction.
- [`docs/AGENT-INTEGRATION.md`](docs/AGENT-INTEGRATION.md): how agents use the foundation and help create surfaces.
- [`docs/OBSIDIAN.md`](docs/OBSIDIAN.md): using the foundational Markdown surface in Obsidian.
- [`docs/research/`](docs/research/): dated technology research, not implementation decisions.
- [`docs/notes/`](docs/notes/): design history; the current spec takes precedence.
- [`docs/IMPORT.md`](docs/IMPORT.md): importing existing vaults (parked).
