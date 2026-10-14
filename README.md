# Surface

## Thesis

Apps and SaaS are not the future. What people need is three things:

1. **Data**: storage and persistence. Multiple users can edit it, just like any app.
2. **Agents**: an agent replaces much of the app. Like a real virtual assistant, it manipulates the data and acts on it.
3. **Surfaces**: the human interface. Surfaces are less permanent and fluid by nature, much like Notion.

That's the name: the data and the agent are the substance. The surface is just where a human touches it.

## Surfaces

A surface can be anything. It can be a small purpose-built app that looks and feels like a cross between Notion and Obsidian. It can also be just a Markdown document.

The model is something like Claude's dashboards. The user asks to see a view, with tools to work with the data, and the agent produces it. The surface talks to the database and shows live data as it changes.

## Data

A typed database (Supabase) is the single truth. Any machine checks the workspace out as plain Markdown files, which you can read and edit in Obsidian or any editor, then push back. The database checks every change against the type's fields. Obsidian with a Surface plugin is the desktop, a web app is for the team, and the `surface` CLI is for agents. See `docs/SPEC.md` (current design) and `cli/README.md` (how to use it).

## No lock-in

Your notes are files. Everything you write lives in open, readable Markdown and YAML on your disk. Surface adds speed, views, agents and collaboration, but you can leave any time, to Obsidian, VS Code or any text editor.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): the current design, consolidated.
- [`docs/DESIGN.md`](docs/DESIGN.md): visual design direction (Bear and Margin inspired).
- [`docs/OBSIDIAN.md`](docs/OBSIDIAN.md): what escaping into Obsidian looks like.
- [`docs/research/`](docs/research/): technology research (sync, app).
- [`docs/notes/`](docs/notes/): working notes showing how decisions were reached (design history).
- [`docs/IMPORT.md`](docs/IMPORT.md): importing existing vaults (parked).

## Status

Design phase. The data model, file conventions and reconciliation rules are largely decided. Sync technology and the app itself are being researched.
- `docs/MVP.md`: the MVP (types engine on Supabase + CLI, used from Obsidian)
- `cli/README.md`: the `surface` CLI, how to use it
