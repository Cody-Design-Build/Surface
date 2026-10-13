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

Fixed requirements:

- **Filenames are human-readable.**
- **Every type has a home folder.** Creating a type creates its folder, and new records of that type are always created there.

Still open: whether records may later move out of their folder, and which link syntax Surface writes.

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

### A catch that applies to both: names repeat within a type

A folder can't hold two files with the same name, so uniqueness *within a type* is required in both models. Model B only removes collisions *across* types. Row-like records collide constantly: "Order cabinets" exists on every job.

Proposed answer for both models: **the filename is unique and readable, and the display name lives in front matter.**

- `title: Order cabinets` in front matter is what Surface shows.
- The filename adds human context to stay unique: `Order cabinets - 2243 Steiner.md`. Surface generates it on create from the title plus a key field (job, date, organization), and the user can override it.
- Links show the title: `[[Order cabinets - 2243 Steiner|Order cabinets]]` (Model A) or `[Order cabinets](Order%20cabinets%20-%202243%20Steiner.md)` (Model B).
- Finder stays readable, because filenames carry their own context.

### Finder browsing

The system doesn't need folders. The index plus `type:` and `id` are enough. Folders are for people, and Finder is the **escape hatch**, not the main interface:

- Relationship browsing ("tasks for this job") is a Surface view, not a folder. A flat folder of 400 tasks is a jumble either way.
- The Finder goal is modest: type folders plus self-describing filenames, so a person without Surface can still find things.
- Subfolders inside a type folder (for example `jobs/2243 Steiner/`) can be allowed for people's convenience, as long as they carry no meaning. That's free in Model A; in Model B every move rewrites links.

### The root problem: one string doing two jobs (Oct 12)

In a database, the **key** (unique, permanent, meaningless) and the **label** (human, changeable, can repeat) are separate. A filename tries to be both. Every link problem comes from that: readable names collide and get renamed; unique permanent names aren't readable.

The spectrum of answers:

| | Filename | Links point at | Links work in Obsidian | Finder readable | Collisions | Renames |
|---|---|---|---|---|---|---|
| 1. Key only | `a7f3c2.md` | filename (= key) | ✅ always | ❌ | impossible | label is in front matter, so renames never touch the file |
| 2. Label + key | `Order cabinets ~a7f3.md` | filename | ✅ | mostly | impossible | a rename changes the label part; Surface still matches by the key suffix |
| 3. Unique label (Model A) | `Order cabinets - 2243 Steiner.md` | filename | ✅ | ✅ | must be prevented by hand or by Surface | renames outside Surface and Obsidian break links (flagged) |
| 4. Free label, ID links | `Order cabinets.md` (may repeat) | front-matter `id` | ❌ Obsidian can't resolve an ID that isn't a filename | ✅ | allowed | free |

Note on option 4: Obsidian resolves links by filename only; aliases feed its link picker, not resolution. So links by front-matter ID are dead outside Surface.

### Direction (Oct 12): the filename is the key, and the key carries its type

David: an ID as the filename is fine. It works like a database:

- **the filename holds both the table and the primary key:** `task_28ey28eh` means table `task`, key `28ey28eh`;
- the file is the row;
- front-matter fields are the columns;
- links are foreign keys;
- `title` is just a field.

Folders play no part in the model. The type comes from the filename, not from where the file sits.

**ID format (proposal):** `{type prefix}_{random}`, e.g. `task_0q8z4mkr7f2c.md`. Stripe uses the same pattern (`cus_…`, `inv_…`).

- **The type is in the key.** Any script can tell what a file is, and where it belongs, from its name alone. That puts type and key on one line, and possibly removes the need for folders (see below).
- **The prefix is a short, stable code** defined in the type's schema (`prefix: task`), separate from the display name. Renaming the "Tasks" collection to "To-dos" changes no IDs and no links.
- **The random part:**
  - **Lowercase only.** macOS filesystems are case-insensitive by default, so `A` and `a` would collide.
  - **Crockford base32** (digits plus letters, without `i`, `l`, `o`, `u`), so the characters can't be confused with each other.
  - **Time-sortable option:** about 7 characters of creation time (seconds), then 5 random. Files then sort in creation order in Finder and in Obsidian's file list, and IDs created offline by different people can't realistically collide.
  - **Pure random option:** 10 characters (50 bits). The chance of a collision across 100,000 records of one type is about 1 in 250,000.
- **Who generates them:** Surface and the agent (`new task`). A file created elsewhere (for example "Untitled.md" in Obsidian) is flagged *"no ID; assign one?"* Assigning the ID renames the file, so it happens only when accepted, per the flag-only rule.
- **The ID is also stored in front matter** as `id: task_0q8z4mkr7f2c`. If the file is renamed in Finder, the front matter still says which record it is.
- **`type:` becomes redundant.** The type is derived from the ID prefix, so a separate `type:` field would be a second copy that could drift. Keep it only if Obsidian Bases filtering needs it.
- **A type never changes.** Turning a task into an issue is a migration: a new ID, with every link rewritten. It isn't an in-place edit.

**Folders become optional.** With the type in every filename, a single flat folder still groups records by type (files sort by prefix). Choices:

- **Flat:** all records in one folder. Files can't be "misplaced," and moves don't exist.
- **Type folders as a convention:** `tasks/task_….md`. Easier on the eye in Finder and Obsidian. Since the prefix says where a file belongs, the normalizer can flag *"task_… is outside tasks/; move it back?"*

Either way, folder location carries no meaning the system depends on.

### The fork this exposes (Oct 12)

David: without readable names and folders, Obsidian is mostly unusable. So ID-only filenames mean Obsidian stops being a real surface. The decision underneath is whether Obsidian is a requirement:

- **Path 1, Obsidian-native.** Readable filenames, type folders, and the ID in front matter. Surface's index does the database work. Within this path:
  - **1a. Unique readable names** (`Order cabinets - 2243 Steiner.md`): fully native, but uniqueness needs discipline, and renames done outside Surface and Obsidian break links (flagged).
  - **1b. Name plus key** (`Order cabinets ~task_0q8z.md`): readable in Obsidian and Finder, with a short tag. Always unique, and Surface can always identify the file from its tag.
- **Path 2, Surface-native.** ID filenames (`task_0q8z4mkr7f2c.md`). Files are the storage format: agent-friendly, portable, yours. Surface is the real interface. Obsidian and other editors are for reading and emergency edits only.

### Why files at all, if filenames become keys?

Readable filenames are only one of the things files provide. The rest survive every option above:

- **Agents work natively with files.** Claude Code, Codex, Hermes and grep all read and edit them with no API.
- **Ownership and longevity.** The data outlives the app; leaving is free.
- **History, diff, backup and sync come for free** (git, Dropbox, Time Machine).
- **Readable content.** The front matter and body are plain text in any editor, whatever the filename.
- **Merge-friendly** at line, field and paragraph level.

What changes with key-like filenames: Finder browsing, readable raw links, and some of the "feels like Obsidian" quality.


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
