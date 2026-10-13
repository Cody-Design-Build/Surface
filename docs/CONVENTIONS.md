# Conventions

Working draft. Surface's files must stay plain, portable Markdown. A small set of conventions makes Surface's database features work without breaking Obsidian or any generic Markdown editor.

## Principle: degrade gracefully

Every convention must pass three tests:

1. **Any text editor:** the file is readable and makes sense.
2. **Any Markdown editor** (VS Code, GitHub, Typora…): it renders sensibly, and links work wherever the editor supports links.
3. **Obsidian:** it behaves natively, with links, properties and backlinks working.

Surface reads more meaning out of a file than other apps do. It never requires other apps to understand that meaning.

## The portability ladder

| Layer | Example | Who understands it |
|---|---|---|
| Plain text | everything | everyone |
| CommonMark / GFM | headings, lists, `- [ ]`, tables, `[text](path.md)` | every Markdown editor, GitHub |
| YAML front matter | `---` block at the top | most Markdown tools; GitHub shows it as a table |
| Wikilinks | `[[Jane Doe]]` | the Obsidian family: Obsidian, Logseq, Foam, Zettlr, Bear, Margin… GitHub, VS Code and most plain editors don't resolve them |
| Surface meaning | typed fields, IDs, relations, rollups | Surface only; carried in the layers above, never in a format others can't read |

Note: wikilinks didn't come from Obsidian. They come from wikis (WikiWikiWeb, MediaWiki), and Obsidian made them the norm for Markdown notes. They're still not standard Markdown.

## Front matter

- **Reserved keys:**
  - `id`: permanent, never changes, unique.
  - `type`: the collection.
  - `aliases`, `tags`: Obsidian's own conventions, reused as-is.
- **Every other key** is a field defined by the collection's schema.
- **Values are plain YAML scalars or lists.** Links in front matter are quoted strings.
- **No Surface-only syntax inside values.** No `{id: ...}` objects, no custom tags.

## Links: two candidate models (reopened Oct 12)

Fixed requirement: **filenames are human-readable.** Still open: whether folders carry meaning, and which link syntax Surface writes.

### Model A: name links, folders are free

- **Links:** name-only wikilinks, `[[Jane Doe]]`, and `"[[Jane Doe]]"` in front matter.
- **Folders:** carry no meaning. Files can live and move anywhere.
- **Uniqueness:** filenames must be unique across the whole workspace, disambiguated with human context (`Jane Doe (Acme Plumbing)`).
- **Moves:** never break links, in Surface or Obsidian.
- **Renames:** Surface or Obsidian rewrites links when it does the rename. A rename outside both is caught by the `id` and flagged.
- **Works in:** Obsidian and its family. GitHub, VS Code and other editors without wikilink support show the link as plain text.

### Model B: Markdown links, a link registry, files in type folders

- **Links:** standard Markdown links, `[Jane Doe](../contacts/Jane%20Doe.md)`. Clickable in every Markdown editor, GitHub and Obsidian.
- **Folders:** each type lives in its own folder (`contacts/`, `tasks/`, `jobs/`). Files normally stay put, so paths stay stable.
- **Uniqueness:** only within a folder. `contacts/Jane Doe.md` and `tasks/Jane Doe.md` can coexist, because the path tells them apart.
- **Link registry:** every link Surface creates is registered in the index (source file, target `id`, current path). A file watcher sees moves and renames. The record's `id` shows it's the same file at a new path, and every link pointing at it gets repaired.
- **Moves and renames outside Surface:** links break in other apps until Surface sees the change. If Surface wasn't running, it catches up on the next scan.
- **Costs:**
  - Raw links are noisier (`%20`, relative `../`), and the same target is written differently from different folders.
  - Repairing links means Surface rewrites files. That's an exception to the flag-only normalizer, or else repairs must be accepted one flag at a time.
  - Nested structures (a project folder holding its own documents) sit awkwardly against strict type folders.

### What actually differs

| | Model A | Model B |
|---|---|---|
| Works in any Markdown editor | shows as text | ✅ clickable |
| Works in Obsidian | ✅ native | ✅ (Obsidian supports Markdown links) |
| Names unique across workspace | required | only per folder |
| Folder meaning | none | type = folder |
| Moves outside Surface | safe | break until Surface repairs |
| Surface must rewrite files to keep links working | no | yes (link repair) |

### Either way

- A permanent `id` in front matter is each record's identity.
- The index knows which record every link points to.
- `type:` stays explicit in front matter, even in Model B, so a file is self-describing if it's ever moved.
- Heading and paragraph links: `#Heading` and `#^block-id`, with `^block-id` added only when needed.

Considered and rejected: filename = ID (unreadable in Finder); name plus a short ID in the filename (noise).

## Everything else

| Need | Convention | Degrades to |
|---|---|---|
| Collection schemas | YAML files in a schemas folder | readable YAML |
| Live record views in a page | ` ```surface ` fenced block containing a query (the same pattern as Obsidian's ` ```base `) | a readable code block |
| Link to a heading | `[[Note#Heading]]` | native in the Obsidian family; plain text elsewhere |
| Link to a paragraph | Obsidian `^block-id` at the end of the paragraph, added only when something links to it | a short trailing token |
| Callouts | GitHub-style alerts: `> [!NOTE]` | a blockquote |
| Simple to-dos | GFM `- [ ]` | native |
| Anything with fields | its own record file, linked or embedded | a link |
| Comments, presence, link → ID cache | Surface's index or side files, never inside the note | nothing in the file |

## Open questions

1. **Links:** Model A (name wikilinks, free folders) or Model B (Markdown links, registry, type folders)?
2. ~~Filenames~~ decided: human-readable. Uniqueness scope depends on the link model.
4. **If Model B:** may Surface auto-repair link paths (mechanical, safe) as an exception to the flag-only rule?
3. Test needed: confirm in a live Obsidian vault that name-only links survive moves, that Obsidian rewrites front matter links on rename, and what Obsidian does with a duplicate filename.
