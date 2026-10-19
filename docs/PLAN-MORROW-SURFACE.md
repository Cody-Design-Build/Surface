# Plan: what our Notion-like app borrows from Morrow

Updated October 18, 2026. **Direction (David):** keep building our own Notion-like app (the writing
app, `surface serve`, port 4317) on Surface's database. Borrow only interface ideas and pieces from
Morrow. We won't run Morrow, fork it or use its storage. The spike notes from earlier today are kept
at the end for the record.

Morrow: github.com/Aarav2709/Morrow, **Apache-2.0**. Copying code means keeping its copyright notice,
saying what we changed, and shipping the license. Ideas and visual patterns carry no obligation. A
demo of Morrow on a copy of cdb-os runs at http://127.0.0.1:4330/ (temporary).

## Where we stand (seen side by side on cdb-os)

**Our app already has** a sidebar tree, records with typed properties above a live-preview Markdown
body (CodeMirror), chips for links, coloured select pills, `/` commands, `[[links]]`, block handles,
callouts, embedded live views, board, list and calendar views, the grid, the Ctrl+K switcher, and
sharing and type settings.

**The gaps are mostly about feel and page structure, not data.** Morrow feels like Notion because of:

1. a **page header** with an icon, an optional cover, a large title, and quiet "Saved · edited 12 min
   ago" text at the top right;
2. a **database page**: title, then view tabs (Table / Board / +), then Filter · Sort · Properties
   on the same line;
3. **property rows that read as part of the page**, not a form: label and value with no boxes, an
   "Empty" placeholder, and a hover reveal;
4. a **sidebar** with workspace switcher, then Search / Home / Today / Tasks, then a Pages tree,
   then Import / Trash / Settings at the bottom;
5. a **Home** page: greeting, counts, "Jump back in" cards, open tasks;
6. a **design-token system** (fonts, sizes, radii, colours, shadows; light and dark) used everywhere;
7. richer **blocks and menus**: a grouped `/` menu with descriptions, toggles, columns, a table of
   contents, and a block menu (turn into, duplicate, move, colour).

Our record page currently looks like a form above the text (the "Status / Project type / Address"
grid). That is the single most visible difference.

## What to borrow, in order

Each step is small, visible and judged in a real browser (screenshots side by side with Morrow)
before the next. **Every step reads and writes Surface records through the existing API; no Morrow
storage.**

| # | Borrow | From Morrow | Into our app | Kind |
|---|---|---|---|---|
| 1 | **Design tokens**: type scale (11.5 / 12.5 / 13.5 / 14.5), radii 4/6/10, sidebar and surface greys, hover and active tints, popover and dialog shadows, light and dark | `styles/tokens.css` | `styles.css` variables, one accent (ours, not Morrow's orange) | values only |
| 2 | **Record page header**: icon (emoji) and optional cover, large title, type breadcrumb, "Saved · edited …" at top right | `PageView.tsx`, `Cover.tsx`, `TopBar.tsx` | `Page.tsx` (icon and cover stored as record properties `icon` and `cover`, so the CLI sees them) | pattern and CSS |
| 3 | **Properties that read as page**: borderless rows, label column, "Empty" placeholder, add-property row, hide empty fields | `RowProperties.tsx`, `PropertyValue.tsx` | `Properties.tsx` (keep our validation and link chips) | pattern and CSS |
| 4 | **Database page** for a type: title, view tabs (Table / Board / Calendar / List / +), Filter · Sort · Properties on one line | `DatabaseView.tsx` header | a type's page in the writing app, reusing the data app's grid and Group/Sort panels, and the writing app's board and calendar | pattern |
| 5 | **Sidebar shape**: workspace switcher, Search / Home / Today / Tasks, Pages tree, Trash / Settings at the bottom | `Sidebar.tsx` | `Sidebar.tsx` (keep our sidebar definition and sections) | pattern |
| 6 | **Home**: greeting, counts, recent records ("Jump back in"), open tasks due | `Home.tsx` | new `Home` route; data from records and `updated_at`, tasks from the task type | pattern |
| 7 | **`/` menu**: grouped with descriptions; add toggle, columns, table of contents, divider | `SlashCommand.ts`, `SuggestionMenu.tsx`, `Structure.ts` | `Editor.tsx` completions and `livePreview.ts` widgets (blocks stay plain Markdown: `<details>` for toggles; columns TBD) | ideas; Markdown forms ours |
| 8 | **Block menu** on the handle: turn into, duplicate, move up and down, delete | `BlockHandle.ts`, `EditorMenus.tsx` | `blockHandles.ts` | pattern |
| 9 | **Formula fields** | `core/formula.ts` (no dependencies, tested) | server-side formula field kind, computed on read so CLI and app agree | **code**, with notice |
| 10 | Command palette with actions (not just records), tabs, page history | `CommandPalette.tsx`, `TabBar.tsx`, `HistoryDialog.tsx` | later | pattern |

**Not borrowing:** Tiptap (we keep CodeMirror and plain Markdown), Morrow's storage, vault, sync and
encryption, canvases, flashcards, the importer, the Electron shell, and Morrow's orange accent and
branding.

## How we work this time

- **One step per change, with screenshots.** Each step ends with a before/after screenshot of the
  same cdb-os record or table (headless Chromium, read-only), compared with Morrow's.
- **David approves the look of step 1–3 before 4+.** Steps 1–3 change every record page.
- **No data changes for looks.** Icon and cover are optional properties; nothing is written unless
  someone sets one.
- **Tests:** existing app tests stay green; each step adds a check (e.g. header shows icon and
  saved state; empty properties hidden; database tabs switch).
- **Separate checkout for this work** (`git worktree`) so the other agent's edits in
  `~/Work/Surface` don't get mixed into these commits.

## Decisions needed from David

1. Start with **steps 1–3** (tokens, record header, properties), shown to you as screenshots before
   anything is committed?
2. Accent colour: keep our green, or pick a new one now (DESIGN.md says it's a placeholder)?
3. Icon and cover on records: OK to add as optional properties on every type?

---

## Appendix: spike notes (earlier October 18, superseded)

Morrow's storage engine opened a copy of the cdb-os checkout (565 files) with no errors and kept
Surface's `id`, `type`, `rev` and fields. With a generated `<Folder>.md` per type, it showed the
tables as Morrow databases (board by status, relations from `[[links]]`). Problems: file-name
sanitising differs (8 files renamed on any save), nesting moves files, new pages have no `type`, and
validation only happens at push. Morrow's databases are just files: a `kind: database` page whose
front matter defines properties and views, with one row per subpage. There is no table engine,
nothing enforces types, and relations point at titles. Running Morrow itself as a surface was set
aside in favour of borrowing its interface. Scripts: `~/Work/morrow-spike/`.
