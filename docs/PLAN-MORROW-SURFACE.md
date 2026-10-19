# Morrow review: closed

Decided October 18, 2026 (David).

We reviewed Morrow (github.com/Aarav2709/Morrow, Apache-2.0) as a Notion-style surface for Surface:
running it on a checkout, a hybrid of its UI on our database, and borrowing its UI. **We are not
adopting it.**

- **Direction:** our own app stays **Obsidian-style**: a file-tree sidebar, a calm text-first
  record page with properties shown quietly, and no Notion page header, icon or cover. That matches
  DESIGN.md ("feel like Obsidian for writing… with the polish of Bear and Margin").
- **Taking from Morrow:** only `src/core/formula.ts` (a formula parser and evaluator with no
  dependencies and its own tests), and only when we build formula fields. Keep its Apache-2.0 notice
  and say what we changed.
- **Not taking:** its editor (Tiptap), storage and sync, page header, icon and cover, Home page,
  canvases, flashcards and Electron shell. Its other patterns are standard Notion conventions that
  we don't need from Morrow.
- **Learned:** Morrow's "databases" are folders of Markdown files: a `kind: database` page whose
  front matter defines properties and views, with one row per subpage. Nothing enforces types, and
  relations point at titles. Its storage did open a copy of the cdb-os checkout cleanly and kept
  Surface's `id`, `type`, `rev` and fields, but it renamed some files because it sanitises names
  differently. Useful for the editor test matrix (TODO.md). Spike scripts: `~/Work/morrow-spike/`.
