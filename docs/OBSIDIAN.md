# Obsidian: the foundational Markdown surface

**Current direction, Oct 14, 2026.** The Markdown checkout is Surface's first and foundational surface. Obsidian is one way people can use it for everyday work; the files also remain useful if they leave Surface. See [SPEC.md](SPEC.md) for the authoritative product design.

Surface is a headless, mutable database foundation. Its planned dedicated app will provide an Obsidian-like writing and browsing experience with Bear/Margin visual polish, plus team and type management. Obsidian remains an independent client through the Markdown workflow.

## Working in Obsidian today

1. Sign in with the CLI and check a workspace out using `surface init`.
2. Open the checkout folder as an Obsidian vault.
3. Read and edit pages, typed front matter and Markdown bodies.
4. Make a new page or task as a Markdown file. Give it `type:` and `title:` front matter; omit the ID. Without a type it becomes a page.
5. Run `surface status` and `surface check`, then `surface push` for edits or `surface push --new` for new files.
6. Pull other people's changes with `surface pull`.

The CLI normalizes safe fixes and reports them, rejects invalid values, and checks revisions. Supabase stays the source of truth. Normal pull preserves files with unpushed edits; `pull --force` discards those edits. File editing can happen offline; database operations require a signed-in connection.

Deleting a file in Obsidian does not delete the record. Use `surface rm` for an intentional database deletion. See [the CLI guide](../cli/README.md) for commands and layouts.

## What the files provide

| Data | In the checkout |
|---|---|
| Records | One readable Markdown file per checked-out record |
| Fields | YAML front matter, usable as Obsidian properties |
| Identity and revision | `id`, `type` and `rev` in front matter |
| Link fields | Quoted `[[wikilinks]]`, or lists of them |
| Nested pages | A `parent` link; file placement depends on the checkout layout |
| Schemas | Read-only `.surface/types/*.yaml` copies |
| Saved navigation | `.surface/views/sidebar.yaml`; the CLI can validate and draw it |
| Agent guidance | Generated `AGENTS.md` and Surface skills |

Filenames are readable and unique within a checkout; record titles can repeat. Surface uses a short ID suffix when a filename would collide. Link fields are stored as record IDs in the database and rendered as filenames in the checkout. Pull rewrites their labels when records are renamed.

Bodies remain plain Markdown. Obsidian can render supported Markdown and wikilinks; Surface's database validation is applied when changes are pushed, not while Obsidian edits them. Custom views can be built with Obsidian's own tools, but Surface does not generate `.base` files today.

## Relationships

Only the stored side of a link field is written. For example:

```yaml
---
id: 0q8z4mkr7f2c
type: task
rev: 7
title: Order cabinets
project: "[[Kitchen Remodel]]"
---
```

The project does not need a second list of all its tasks. The database maintains links for reverse lookup. In Obsidian, backlinks can reveal notes linking to the project; a configured Bases view can present matching notes as a table. Editing a computed reverse relation through a dedicated UI is future work, not a field the MVP accepts in front matter.

## Planned plugin

The Surface plugin is planned to add a Views panel, live embeds, push on save, validation messages and type-aware properties. Its delivery order relative to the dedicated app is open. These features extend the Markdown surface; the dedicated app is planned independently of whether Obsidian meets the visual design target.

The CLI already saves and renders navigation trees. Rich views, composite-page embeds and automatic push are not implemented in the plugin because the plugin itself is not built yet. Surface uses its own readable YAML view definitions; conversion of compatible views to Obsidian `.base` files is planned.

## Leaving Surface

A current pull gives you plain records, schema copies and saved view definitions. Start with a full checkout if you want all records; `--only` checkouts intentionally omit other types. Once disconnected, the files are yours to edit with any tools, while Surface's validation, shared permissions and database collaboration no longer apply to that copy.

The no-lock-in design also calls for a future "Leave Surface" action: convert supported views to Bases or snapshots, export history, and preserve other authored features in readable forms as those features are introduced. That complete portability workflow is a product commitment, not an implemented command today. Comments, attachments and their checkout handling remain planned work.

## Open

- Plugin scope and sequencing: Views panel, embeds, push on save and type-aware properties.
- Bases conversion details and tests for supported views.
- Whether an optional preparation tool should create templates, property settings or a "Start here" note.
- Round-trip behavior for Obsidian file moves, renames and third-party plugins.
