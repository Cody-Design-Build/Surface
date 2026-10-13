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

## Links

**Decided (Oct 12):** filenames are human-readable, folder location never matters, and files can be moved without breaking links.

- **Link style:** name-only wikilinks, `[[Jane Doe]]`, and in front matter `"[[Jane Doe]]"`. They resolve by filename anywhere in the workspace, so moves never break them in Surface or Obsidian.
- **Never write path links**, neither `[[folder/Name]]` nor `[text](../folder/Name.md)`. A path makes the folder matter.
- **Filenames are unique across the workspace.** Disambiguate with human context (`Jane Doe (Acme Plumbing)`), never codes. Surface warns on create and flags duplicates made elsewhere.
- **Identity:** a permanent `id` in front matter. Links don't carry it; Surface's index maps links to IDs to detect renames done outside Surface and Obsidian.
- **Headings and paragraphs:** `[[Note#Heading]]`; `[[Note#^block-id]]`, with the `^block-id` added only when something links to that paragraph.
- **Editors without wikilink support** show the link as plain text. Nothing breaks; there's just no click-through.

Considered and rejected:

- Standard Markdown path links with the ID in the link title: a path breaks when moved outside Surface.
- Filename = ID: Finder browsing becomes unreadable.
- Name plus a short ID in the filename: noise in every filename.

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

1. ~~Link style~~ decided: name-only wikilinks.
2. ~~Filenames~~ decided: human names, unique workspace-wide.
3. Test needed: confirm in a live Obsidian vault that name-only links survive moves, that Obsidian rewrites front matter links on rename, and what Obsidian does with a duplicate filename.
