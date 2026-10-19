# Plan: the Surface app as a cross between Obsidian and Notion

Draft, October 18, 2026, for David's review. It covers the writing app (`surface serve`, port
4317). The data app (4318) stays the Airtable-style surface and supplies the grid.

## The target in one line

**Obsidian's shell and writing feel, with Notion's structured data inside the page.** Plain Markdown
files, a file-tree sidebar, a text-first page, links, backlinks, outline and graph, plus typed
properties, live database views in pages, board, table and calendar, and relations, all checked by
Surface's database.

| From Obsidian | From Notion |
|---|---|
| File-tree sidebar; quiet, dense, keyboard-first | Typed properties that read like part of the page |
| Text-first page, live preview, no page chrome | Live views (table, board, calendar) inside a page |
| `[[links]]`, backlinks, outgoing links, outline, graph | Relations both ways (job ↔ tasks), shown on each side |
| Tabs and split panes; command palette | `/` menu and block menu (turn into, move, duplicate) |
| Daily notes, templates, tags | Database pages for every table with view tabs |
| Files readable anywhere | Shared workspace, permissions, validation |

**Not doing** (David, October 18): Notion page headers, icons and covers.

## Where the app is today (screenshots of cdb-os, October 18)

**Already in place:**
- a sidebar tree (workspace and personal);
- a record page: title, type breadcrumb, typed properties, CodeMirror live-preview body;
- `/` menu (headings, lists, to-do, quote, code, divider, link, table, views);
- `[[links]]`, block drag handles, callouts, embedded live views;
- children and backlinks under the body;
- view pages with layout tabs (board, table, calendar, list), Ctrl+K switcher, sharing and type
  panels, undo.

**What keeps it from feeling like either app:**
1. **Properties read as a form**: a label grid with "Empty" values and `+` buttons always showing.
2. **Body and properties repeat each other**: the job's "Contacts" text duplicates its Contacts
   property. Nothing shows relations as live lists. A job has no "Tasks" section unless someone
   embeds a view.
3. **No right-hand panel**: backlinks, outline and properties sit in the page; Obsidian puts
   context in a side panel.
4. **One page at a time**: no tabs, no split view.
5. **View pages are utilitarian**: plain cards, bare empty columns, no per-card field choice, and
   different toolbars from the data app's Group, Sort and Filter.
6. **No whole-workspace tools**: no graph, daily notes, templates or tags page. The command palette
   only finds records; it can't run actions.

## Plan: four phases, each usable on its own

Every step: real-browser screenshots of the same cdb-os record or view, before and after; David
signs off on the look before the next step; tests stay green and grow; one commit per step.

### Phase 1: The page (look and feel; about 1 week)

The record page should feel like an Obsidian note with Notion properties.

1. **Properties, Obsidian style.** A compact "Properties" block under the title: one line per
   field, label then value, no boxes. Empty fields are hidden behind "+ N empty" (shown on hover or
   click). Pills and chips are kept, and `+` buttons appear only on hover. Click a value to edit;
   it's still validated by the database. The panel can collapse, and the setting is remembered per
   type.
2. **Relations as live sections.** Under the body, an automatic section for each incoming link:
   on a job, *Tasks (12)*, *Selections (8)*, *Orders (3)*, each a compact live list with an
   expand-to-table option, from the backlinks the API already returns. This replaces typing
   "Contacts" lists into the body by hand and is the biggest Notion gain. It uses no new data.
3. **Type and spacing pass.** One set of tokens (sizes, greys, hairlines, radii, light and dark),
   following DESIGN.md (Bear and Margin calm); a readable text width; quieter breadcrumb and
   metadata. No header, icon or cover.
4. **Right panel** (toggle, Obsidian style), with tabs for Outline, Backlinks / Outgoing links,
   and Properties when the page is narrow. It remembers whether it's open.

### Phase 2: Moving around (about 1 week)

5. **Tabs**: open records and views in tabs (Ctrl+click or middle-click), with Ctrl+W, Ctrl+Tab
   and reopen-closed.
6. **Split view**: two panes side by side (Obsidian), for example a job and a task, or a view and
   a record.
7. **Command palette** (Ctrl+P): every action as well as records (new record of type X, move to,
   change type, toggle panel, open view, switch workspace). Ctrl+K stays as the quick switcher.
8. **Sidebar polish**: denser rows, quieter indent guides, a "Recent" and "Starred" pair at the
   top, Trash at the bottom (restore deleted records; the API already supports undelete).

### Phase 3: Data in pages (about 1–2 weeks)

9. **A database page for each table.** Every table gets a page (`#/t/job`) with view tabs over its
   saved views, plus "All". The toolbar is the data app's (Filter, Sort, Group, Hide fields) and the
   grid is the data app's, so both surfaces behave the same. Board, calendar and list stay.
10. **Board and card polish**: choose which fields show on cards, card density, better empty
    columns, drag to reorder within a column (when sorted by a manual order field, later).
11. **View embeds in pages**: insert from the `/` menu with a mini toolbar (layout, filter `this`),
    resize, and click through to the full view.
12. **Block menu** on the drag handle: turn into (heading, to-do, quote, callout), duplicate,
    move up and down, delete. These are text operations, so the Markdown stays plain.
13. **Callout and toggle blocks**: foldable callouts (`> [!NOTE]-`, Obsidian syntax) as toggles,
    plus `==highlight==`.

### Phase 4: Whole-workspace (later, pick as needed)

14. **Graph view** of records and their links, coloured by table, with a local graph per page.
    Live data only.
15. **Daily notes** (a page per day, `@today` links) and **templates** per table (a new task gets a
    starting body and default fields).
16. **Tags** page and tag pills (`#tag` in body or a tags field).
17. **Formula fields**: server-side and computed on read (CLI and app agree). Morrow's
    `formula.ts` can be borrowed with its Apache-2.0 notice.

## What stays true

- **Plain Markdown on disk**: none of this adds syntax beyond Obsidian's (callouts, embeds,
  highlights). Relation sections and panels are display only.
- **The database is the truth**: edits go through the API with validation, revisions and undo.
- **The data app stays separate**: shared grid and toolbar components, not merged screens.
- **Agent-neutral**: anything the app can do stays possible from the CLI.

## How we'll work

- **Separate checkout** (`git worktree` at `~/Work/Surface-app`) on a branch for this work, merged
  to `main` per step, so the other agent's edits in `~/Work/Surface` aren't mixed in.
- **Screenshots first**: each step is shown on cdb-os (read only) before committing. The headless
  Chromium harness from today becomes `app/qa/shot.mjs`.
- **Tests**: `app/qa/qa-app.mjs`, in-browser checks per step (properties collapse, relation sections
  list the right records, tabs open and close, and so on).

## Decisions needed from David

1. **Order**: Phase 1 first (page look and relation sections), or Phase 3 (database pages) first?
2. **Relation sections**: automatic on every record (one per incoming link field), or only where a
   table is set to show them?
3. **Properties**: hide empty fields by default?
4. **Accent colour**: keep the current teal and green, or choose now?
