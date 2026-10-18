# Morrow as a source for Surface viewing surfaces

Reviewed October 18, 2026: https://github.com/Aarav2709/Morrow at `a2daae1`.

**License: Apache-2.0, not MIT.** The README links an MIT badge in places, but `LICENSE` and
`package.json` are Apache-2.0. Borrowing is still fine. We have to keep the copyright and license
notice, state our changes in the files we adapt, and ship the license text. Its text is in
`app/third_party/Morrow-LICENSE.txt`. Morrow has no `NOTICE` file.

## What Morrow is

It is a local-first Electron app for notes, databases and canvases, stored as Markdown files.
It is React 19 with Tiptap and about 27k lines of TypeScript. Its data model is "pages whose
subpages are rows", with per-database property and view definitions, so it isn't compatible with
Surface's typed records, link fields or shared Postgres store. We can borrow UI ideas and isolated
pieces, but not the app itself.

## Taken

| Piece | Morrow source | Surface file | Notes |
| --- | --- | --- | --- |
| Force-directed graph | `src/app/components/GraphView.tsx` | `app/src/RelationshipGraph.tsx` | Rebuilt on Surface records and link fields, coloured by table, with a table filter, focus on a record with a 1–3 hop depth, and click to open the record sheet. Uses `d3-force` 3.0.0 (ISC). |

The relationship map is in the data app's sidebar (`/data/#/map`). On cdb-os it showed 345 linked
records and 435 links across 8 tables (headless Chromium screenshot, read only).

## Worth taking next (not done)

| Idea | Morrow source | Why it fits |
| --- | --- | --- |
| Gallery / card layout | `DatabaseView.tsx` `GalleryView`, `Card` | Card view of a table (selections and orders with product images). It needs an image/attachment field kind first. |
| Formula fields | `src/core/formula.ts` (parser and evaluator, about 350 lines, no deps, has tests) | Gives us Airtable-style formula columns, which we don't have yet. Rewrite `prop("Name")` to Surface field keys and compute on read in the server so the CLI agrees. |
| Filter operators per field kind | `src/core/database.ts` `filterOpsFor`, `FILTER_LABELS` | A friendlier filter panel than the current query-grammar editor. |
| Calendar | `DatabaseView.tsx` `CalendarView` | We already have one in the writing app's `ViewPage.tsx`. Compare before porting. |

## Left out

The editor (Tiptap), canvases, flashcards, encryption, sync, the Notion importer, the Electron
shell, and Morrow's vault, storage and history layers. Surface already has its own storage and
history, or doesn't need these.
