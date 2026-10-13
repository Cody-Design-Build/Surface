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

### The problem

Surface wants links that point at a record's ID (they survive renames and duplicate names). Portable Markdown links point at a filename or path. Nothing standard carries both.

### Option 1: Wikilinks, with the ID kept in the index

`[[Jane Doe]]`, or `[[contacts/Jane Doe]]` when the name isn't unique.

- Works natively in Obsidian and its family. Doesn't resolve in GitHub, VS Code and generic editors, where it shows as plain text.
- The link → ID mapping lives in Surface's index, not the file (see DATA-MODEL §6).

### Option 2: Standard Markdown links, with the ID in the link title

`[Jane Doe](../contacts/Jane%20Doe.md "id:a7f3c2")`

- A standard CommonMark relative link, so it's clickable in GitHub, VS Code, Obsidian and almost every editor.
- The quoted part is CommonMark's standard *link title*: most apps ignore it or show it as a hover tooltip. Surface reads the ID from it.
- If the file is renamed or moved outside Surface, the path breaks in other apps, but Surface still finds the target by ID and can offer to repair the path.
- Costs: noisier to read raw; spaces in paths need `%20` (or `<...>` brackets in CommonMark). Needs testing: does Obsidian keep the title when it rewrites links on rename?

### Option 3: Filename = ID, title in front matter (Zettelkasten style)

File `a7f3c2.md` with `title: Jane Doe`; links `[[a7f3c2|Jane Doe]]` or `[Jane Doe](a7f3c2.md)`.

- Filenames never change, so renames can't break links in any app, and names never collide.
- Costs: Finder browsing becomes unreadable (`a7f3c2.md`), and raw links are less readable.

### Option 4: Readable name plus a short ID in the filename

`Jane Doe (a7f3).md`, links `[[Jane Doe (a7f3)|Jane Doe]]`.

- Always unique, still mostly readable in Finder.
- Costs: noise in every filename; renaming the title still renames the file.

### Leaning (to discuss)

Surface **reads all link forms** (wikilinks, Markdown links, ID titles) so it can open any vault. Each workspace picks **one style that Surface writes**:

- **Obsidian-first workspaces** → Option 1 (wikilinks, ID in the index).
- **Maximum portability** (GitHub, any editor) → Option 2 (Markdown links with an ID in the title).

## Everything else

| Need | Convention | Degrades to |
|---|---|---|
| Collection schemas | YAML files in a schemas folder | readable YAML |
| Live record views in a page | ` ```surface ` fenced block containing a query (the same pattern as Obsidian's ` ```base `) | a readable code block |
| Link to a heading | `[[Note#Heading]]` / `[text](note.md#heading)` | native |
| Link to a paragraph | Obsidian `^block-id` at the end of the paragraph, added only when something links to it | a short trailing token |
| Callouts | GitHub-style alerts: `> [!NOTE]` | a blockquote |
| Simple to-dos | GFM `- [ ]` | native |
| Anything with fields | its own record file, linked or embedded | a link |
| Comments, presence, link → ID cache | Surface's index or side files, never inside the note | nothing in the file |

## Open questions

1. Which link style should Surface write by default: wikilinks (Obsidian-first) or Markdown links with ID titles (portable everywhere)?
2. Should filenames stay human names (CDB OS / Finder-friendly), or carry the ID (Options 3–4)?
3. Test needed: Obsidian's handling of Markdown links with titles, angle-bracket paths, and link rewriting on rename.
