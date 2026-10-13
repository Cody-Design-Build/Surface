# Importing an Existing Vault

> **Parked (Oct 13).** Flagged for later; not part of the current design work. See `docs/SPEC.md` §12.

Working draft, Oct 12. Question: if someone already has a vault (Obsidian, or any folder of Markdown), can Surface import it and make it work?

Yes. Surface's normal behaviour already covers most of it: an existing vault is just a large batch of "new notes" to reconcile.

## Two ways in

| | Adopt in place | Import as a copy |
|---|---|---|
| What happens | Surface takes over the existing folder | Surface builds a new workspace from a copy of the vault |
| Original vault | Becomes the workspace's Markdown files and keeps working in Obsidian | Untouched |
| File layout | **Kept as-is**: existing names and folders are recorded, not regenerated | Can be regenerated to Surface's layout |
| Writes to files | Adds an ID line to each note's front matter (one bulk approval) | Only in the copy |
| Best for | Keeping Obsidian as a daily companion | Trying Surface safely, or a clean restructure |

**Proposed principle:** Surface generates paths only for records *it* creates. Existing files keep the names and folders their owner chose. That makes adopting in place safe, and keeps Surface from renaming someone's whole vault.

## The import steps

1. **Scan.** Every `.md` file becomes a candidate record. Attachments (images, PDFs) are tracked as files.
2. **Infer types.** Surface proposes types from the vault's existing signals: folders (`Tasks/`, `People/`), tags (`#task`), a `type:` or similar property, and recurring sets of front-matter keys. Anything unclear becomes a plain **note** type.
3. **Infer schemas.** Surface proposes field types from the values it finds (dates, numbers, choices, links). It seeds them from Obsidian's own property types in `.obsidian/types.json`.
4. **Review.** The user, or the agent in a conversation, confirms or edits the proposed types and schemas. This is the onboarding interview.
5. **Assign IDs.** Each record gets a time-sortable, type-prefixed ID, written into its front matter after a single bulk approval (adopt mode).
6. **Resolve links.** Wikilinks are resolved the way Obsidian resolves them (by filename, or by path when there are duplicates) and mapped to record IDs. Markdown links, heading links (`#Heading`), block links (`#^id`) and embeds (`![[...]]`) are resolved too. Ambiguous or broken links are flagged.
7. **Flag the rest.** Fields that don't fit the schema, broken YAML, duplicate names and broken links all land in "needs attention." Nothing is rewritten without a choice.

## Obsidian-specific content

| Obsidian feature | Handling |
|---|---|
| Wikilinks, aliases, heading and block links | Resolved to record IDs; the text in the file stays as it is |
| Embeds `![[note]]`, `![[image.png]]` | Tracked as links or attachments |
| Tags (inline `#tag` and `tags:`) | Imported as a tags field; usable for type inference |
| Property types (`.obsidian/types.json`) | Seed the inferred schemas |
| Bases files (`.base`) | Converted to Surface views where possible; the original file is kept |
| Canvas files (`.canvas`) | Kept as files; maybe a Surface view later |
| Dataview and other plugin queries | Kept as text; flagged as "not understood" where they matter |
| Plugin syntax in text (Tasks-plugin dates, etc.) | Preserved as text |
| `.obsidian/` folder | Left alone; Surface uses its own `.surface/` folder alongside it |

## Open questions

1. **Default mode:** adopt in place, or import as a copy?
2. **ID key name:** many vaults already have an `id` property, and Margin uses `margin_id` for exactly this reason. Should Surface use a namespaced key such as `surface_id` to avoid collisions?
3. **Path generation:** confirm the principle that Surface only generates paths for records it creates, and that existing files keep their layout.
4. **Huge vaults (thousands of notes):** import everything as plain notes first and type them gradually with the agent, or type them all up front?
