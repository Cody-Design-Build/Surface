# Escaping into Obsidian

Exploration, started Oct 13. David: escaping into Obsidian is always an option, and we want to explore what that looks like.

The promise: open your Surface workspace folder in Obsidian, and it's a good Obsidian vault. You don't need to export or convert anything, and nothing gets lost.

## Two ways to escape

| | Visit | Leave |
|---|---|---|
| What it is | Use Obsidian alongside Surface, for a day or for good | Stop using Surface entirely |
| Edits made in Obsidian | Reconciled the next time Surface runs: merged, or flagged (SPEC §6) | Just files; nothing to reconcile |
| Team sync | Continues through Surface; Obsidian edits sync once Surface sees them | Ends; your local copy is yours |
| What you need | Nothing; open the folder as a vault | Nothing; optionally run "Prepare for Obsidian" once (below) |

## What carries over

| Surface | In Obsidian | Notes |
|---|---|---|
| Records | Markdown notes | Same files |
| Fields | Properties | Native. Choice lists, required fields and validation aren't enforced by Obsidian, but values stay as written |
| `title` | Filename (and the inline title) | Filenames are readable, so this just works |
| Links | `[[wikilinks]]` | Written so they resolve the way Obsidian resolves them |
| Link fields (`assignee: "[[Jane Doe]]"`) | Links in properties, backlinks, graph | Native |
| Tags | Tags | Native |
| Folders (user-made) | Folders | Native (see SPEC: folders alongside types) |
| **Sidebar views** (Tasks → "Due this week") | **`.base` files** | If Surface's view format is compatible with Bases, every view opens in Obsidian as a table, cards, list or kanban |
| Embedded ` ```surface ` views | ` ```base ` blocks, or readable code | Same idea: compatible syntax means they work in Obsidian |
| Types and schemas | `.surface/types/*.yaml` (readable) + Obsidian property types | Obsidian has no per-type schemas; property types are vault-wide |
| Callouts, to-dos, heading and paragraph links | Native | Already chosen to be Obsidian-native |
| Attachments | Files in the vault | Native |

## What doesn't carry over

- **Schema enforcement and flags:** Obsidian won't validate fields or show the "needs attention" view. Visiting is fine, because Surface catches up later. Leaving means drift is possible.
- **Relations and rollups** ("task count on a job"): Bases has formulas, but no Notion-style relation plus rollup. Views that rely on them show less, or need a formula equivalent.
- **Comments, presence and history:** these live in Surface's database. Possible option: export comments as callouts or a side note.
- **Agent-built views:** they stay Surface-only (sandboxed HTML). A static snapshot could be exported.
- **Team sync:** Obsidian doesn't speak Surface's sync. Visiting works through Surface; leaving ends it, or you could use Obsidian Sync or git on your own.
- **IDs for new notes:** notes created in Obsidian have no `id:` until Surface sees them and flags them as new notes. An Obsidian template could add one.

## The big lever: compatible view syntax

The app research already recommends a query format "modelled on Obsidian Bases" (APP-TECH). Taking that one step further:

**Open (Oct 13): David expects Surface views to be more dynamic than Bases tables** (trees from links, calendars, agent views), so the format stays open. The two options:

- **A. A Bases-compatible core plus extras.** Views open natively in Obsidian.
- **B. Surface's own format, plus a Bases export.** Surface writes `.base` files for whatever Bases can show, and its own format isn't tied to Obsidian's.

Option A in more detail: **Surface views use Obsidian Bases syntax** (a compatible subset, plus Surface-only extras that Obsidian ignores).

- Every sidebar view is saved as a `.base` file, and every embedded view as a ` ```base ` block. Both open natively in Obsidian.
- Bases already has filters, sorts, formulas and grouping, plus table, cards, list and kanban layouts. These cover most Surface views.
- **Surface-only features** (relations, rollups, calendar, agent views) live in extra keys. Obsidian shows what it understands.
- **Risks:**
  - We'd follow Obsidian's spec, and it can change.
  - Our extras must never break Obsidian's parser. Test needed.
  - Where `.base` files live has to be decided: a visible `Views/` folder (shows in Obsidian), or `.surface/views/` (hidden from Obsidian, so it doesn't escape well).

## "Prepare for Obsidian" (optional, one action)

For people leaving, or visiting often:

- write Obsidian property types (`.obsidian/types.json`) from Surface schemas, so dates are dates and numbers are numbers (opt-in; it writes into Obsidian's folder);
- write a new-note template per type with the right properties and an `id:`;
- write a "Start here" note listing the types, views and how the vault is organized;
- recommend plugins where they help (for example, Templater for automatic IDs).

## Open questions

1. View format: Bases-compatible core (A), or our own format plus a Bases export (B)?
2. Where do view files live: a visible `Views/` folder, or hidden?
3. How much should "Prepare for Obsidian" write into `.obsidian/`, if anything?
4. A test vault to confirm the details: Bases parsing extra keys, property behaviour, and rename handling.
