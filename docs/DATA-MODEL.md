# Data Model

Working design doc. This is the most important decision in Surface, and we're still exploring. Nothing here is final.

## The core observation: a record is a page

Notion and Obsidian share the same basic unit. A record is a page: a set of fields plus an optional body.

- In **Obsidian**, each task is a Markdown file. The YAML front matter holds the fields, and the body holds any notes. The body can be empty and let the YAML carry the whole task, including a description or notes field. Obsidian Bases shows many such files as a table of records.
- In **Notion**, every record is a page. It has fields (properties), table views over them, and a full page for text, which often goes unused.

Same idea, different storage. So Surface separates two things:

- **the data model**: what a record *is*, the same everywhere;
- **the storage**: where it physically lives, decided separately.

## What we want, and why it's hard

1. **Files on disk, no lock-in.** Obsidian has a huge following for a reason. Files on disk are less app-like, and you can open them in any Markdown editor. Surface should keep that.
2. **A real database.** This is where Obsidian breaks down. YAML that isn't enforced as structured, typed data is weak as a database. Fields drift, types are loose, there's no real query layer, and links are filenames that break on rename. Notion solved this.
3. **Multi-user editing without conflicts.** Blocks are what make this work in Notion. Obsidian has tools that make Markdown *feel* block-based, but they do nothing for conflicts between users. The file is still one string.

**The dilemma.** Once you move to blocks and structured fields in a database, you no longer have something any other app can open. Requirements 2 and 3 pull toward a database. Requirement 1 pulls toward files.

## How Notion does it (our bet, largely confirmed)

The hunch: Notion's pages are simple rows in a database with fields, and the body is a field or a set of fields.

That matches Notion's published description of its data model ("The data model behind Notion's flexibility"). Everything is a **block**, and a page is just a block too. Each block has:

- `id`: a permanent UUID;
- `type`: page, text, heading, to-do, and so on;
- `properties`: the field values (for a page, these are the database fields);
- `content`: an ordered list of child block IDs (for a page, this is the body);
- `parent`: the block it belongs to.

The blocks are rows in a database. A page's body isn't one text field. It's a list of pointers to child-block rows. That's why two people can edit different paragraphs at once: they're editing different rows.

## How Obsidian does it

- One Markdown file per note; the filename is its identity.
- YAML front matter holds fields. Property types are loose and set across the whole vault, not per collection.
- Links are `[[filename]]` wikilinks.
- Bases computes table and card views over files at view time.
- Block references (`^id`) exist, but they're optional and written by hand.
- Concurrency happens at the whole-file level, via whatever syncs the folder.

## Field-by-field comparison

| | Notion | Obsidian | Decision for Surface |
|---|---|---|---|
| Fields | Typed, defined per database | Free-form YAML, loose vault-wide types | How strict should definitions be? |
| Collection membership | Exactly one database | Folder, tag, or `type:`, loosely | What makes a record "a task"? |
| Links | Relations by ID, two-way, rollups | Wikilinks by filename | Link by ID or by name? |
| Body | Ordered child blocks, each addressable | One Markdown string | Whole text, or blocks? |
| Computed values | In the database | In Bases views only | Stored, or computed at view time? |
| Source of truth | Cloud database | Files on disk | Files, database, or both? |

## Options for resolving the dilemma

**A. Files are truth, made stricter ("Obsidian plus").**
Markdown files stay the source of truth. Each collection gets a definition file listing its fields and types, and the engine validates against it. Queries come from an index built from the files.
- Keeps: open in any editor, no lock-in.
- Weak at: multi-user conflicts, because concurrency is still per file and the body is one string.

**B. The database is truth; files are a one-way export.**
Notion's model. Files are generated for reading, backup and portability.
- Keeps: real database, block-level multi-user editing.
- Loses: editing in any app. Files become a read-only copy.

**C. The database is the engine; files are a two-way mirror.**
The database owns concurrency, typing and queries. Every record is also kept as a Markdown file on disk. Edits made in any editor are picked up, parsed, and diffed back into fields and blocks.
- Keeps: both, in principle.
- Cost: the hard part is mapping a freely edited Markdown file back to stable blocks. Hidden block IDs clutter the file, and matching by content is fuzzy. There are two copies to keep consistent.

**D. Files are truth, and the sync layer understands their structure.**
Conflicts are about *how finely changes are merged*, not about the file format. Git merges by line, but only in batches, and stops on conflicts. A live sync layer could treat each file as fields plus a body and merge each field separately. It could also merge the body paragraph by paragraph, or with a shared-editing document per record (Yjs, Automerge or Loro), while still writing a plain `.md` file to disk.
- Keeps: files on disk as the real thing, with good-enough multi-user editing.
- Cost: you'd have to build or adopt a file-aware sync engine. Very fine-grained live co-editing is harder than in B.

## Prior art to study

- **Notion**: the blocks-as-rows model above.
- **Obsidian + Bases**: files plus computed views.
- **Logseq**: started file-based, then built a database version, because the files approach ran into these exact limits. A warning worth reading closely.
- **Anytype**: local-first objects with typed relations, shared-editing sync, and Markdown export (option B, local-first).
- **Obsidian live-collaboration plugins** (e.g. Relay): shared-editing sync layered on a files vault (a version of option D).
- **Margin** (gomargin.app): a pure option A done well. The app is just a fast view over a folder of `.md` files. A `margin_id` in each note's front matter keeps its identity through renames. A file watcher picks up outside edits (vim, VS Code, git pull) and ignores Margin's own saves. A note beside a same-named folder is its parent. Extensions stay plain Markdown that reads fine anywhere (callouts are GitHub-style blockquotes, footnotes are `[^1]`). It has no typed fields, no database views, no sync and no multi-user editing.
- **CDB OS**: Markdown + YAML in a git repo, with `id` in front matter so links survive renames. Its sync stops on conflicts.

## Draft record shape (independent of storage)

```
Record
  id       permanent, never changes; links point here
  type     its collection (task, contact, job, ...)
  fields   typed values: text, number, date, choice, link -> id, ...
  body     optional long-form content (a string or blocks; undecided)
```

Each collection gets a small definition file listing its fields and their types, like a Notion database's properties. Whether records may carry extra fields is open.

## Direction under exploration (Oct 12)

David's leaning:

- **Keep YAML front matter intact.** It's a tradition and it keeps files portable. Add typed data *on top of* it rather than replacing it, and give Surface built-in tools to normalize front matter when user edits make it drift.
- **Keep the body as one flat Markdown file.** Give up some advantages of a block-based editor, and solve the problems that choice creates.

That's roughly option D, and possibly D with a rebuildable index (see below). The two sections below are proposals, not decisions.

## Proposal: typed data on top of YAML

The file is the record. A schema says what the record *should* look like. An index makes it queryable. A normalizer flags where files drift from the schema.

### 1. Schemas live in plain files too

Each collection has a definition file in the workspace, for example `.surface/types/task.yaml`:

```yaml
name: Task
folder: tasks/            # default home; optional
fields:
  status:   { type: choice, options: [todo, doing, done], default: todo }
  due:      { type: date }
  assignee: { type: link, to: person }
  estimate: { type: number, unit: hours }
  tags:     { type: list, of: text }
extra_fields: allow       # allow | warn | deny
```

- It's readable and editable in any editor, and it's versioned with the data.
- Prior art: **Astro content collections** (schemas validate Markdown front matter at build time), **Obsidian's Metadata Menu plugin** ("fileClass" schemas per note type), **Obsidian Properties** (vault-wide types in `.obsidian/types.json`), and **Git-based CMSs** like TinaCMS and Decap (schema-driven forms that write Markdown front matter).

### 2. How a file knows its type

An explicit `type: task` field in front matter, with the folder as a fallback default. Being explicit survives moves and makes every file self-describing in any app.

### 3. A rebuildable typed index

On load and whenever a file changes, Surface parses the front matter, coerces it against the schema, and writes typed rows to a local index (likely SQLite). Every view, query, filter, sort and rollup runs against the index.

- The files stay the source of truth. Delete the index and it rebuilds from the files.
- This is where it behaves like a real database without the files becoming one.

### 4. The normalizer: read leniently, flag, never rewrite

**Decided (Oct 12): the normalizer only warns and flags.** It never rewrites a file on its own.

Surface reads whatever humans and other apps write, interprets it as leniently as it safely can for the index, and flags anything that drifts from the schema.

| Drift | Example | How the index reads it | Flag |
|---|---|---|---|
| Format | `due: Oct 12`, `due: 10/12/26` | `2026-10-12` | Notice: non-canonical format |
| Choice casing | `status: Done` | `done` | Notice |
| Choice typo | `status: dnoe` | unresolved | Warning; suggest `done` |
| Booleans and numbers | `billable: yes`, `cost: $1,200` | `true`, `1200` | Notice |
| Unknown key | `stauts: done` | kept as an extra field | Warning; suggest `status` |
| Missing required field | no `status` | schema default, if one is defined | Warning |
| Value not in options | `status: blocked` | unresolved | Warning; offer to add it to the schema |
| Link | `assignee: "[[Jane Doe]]"` | resolved to an ID (see section 6) | Warning if missing or ambiguous |
| Key order and quoting | random order, mixed quotes | no effect | none, or a notice |

Rules:

- **Files are never changed by the normalizer.** A flag lives in the index and shows in a "needs attention" view. The file stays exactly as its author left it.
- **Fixes happen only when someone chooses one.** From a flag, a human or the agent can accept a suggested fix, which then saves like any other edit. A bulk "fix all safe notices" command is possible, but only when someone runs it.
- **Surface's own editor writes canonical form.** When a record is edited in Surface, Surface is the author, so its save uses the canonical layout. This doesn't touch files edited elsewhere.
- **It runs in two places**: whenever a file changes (from anywhere), and as an on-demand lint across the whole workspace.

### 5. Canonical YAML is also merge-friendly

One field per line, in fixed schema order, means two people editing different fields change different lines, and those merge cleanly. Long free text (descriptions, notes) belongs in the body, or in block-style YAML, so a long value never shares a line with anything else.

### 6. Links without forcing unique names

Same pattern as the typed fields: **the file keeps a readable link, the index resolves it to an ID, and anything ambiguous gets flagged.** Names don't have to be unique.

**The file always stays readable and Obsidian-compatible**, in one of three forms:

| Form | Example | When to use it |
|---|---|---|
| Name | `[[Jane Doe]]` | The name is unique in context (the usual case) |
| Path | `[[contacts/Jane Doe]]` | Two records share a name. The filesystem already guarantees paths are unique. |
| Path + display name | `[[contacts/smith/Jane Doe\|Jane Doe]]` | A long path, shown as the plain name |

Obsidian resolves all three natively. Its "shortest path when possible" link setting does the same thing.

**How the index resolves a link**, in order:

1. **Explicit path.** If the link has a path, it's unambiguous.
2. **Narrow by type.** A typed link field in the schema (`assignee: { type: link, to: person }`) only looks at person records. A task named "Jane Doe" and a contact named "Jane Doe" never collide in that field.
3. **Narrow by nearness** (body links, which have no type): a match in the same folder, then the same parent, before anywhere else.
4. **Aliases.** Match names listed in a record's `aliases:` front-matter field (an existing Obsidian convention).
5. **Still more than one match, or none:** flag it. Nothing is guessed, and the link shows as unresolved until someone picks.

Steps 2–4 are **Surface-only**. Obsidian doesn't know about types, Surface's nearness rule or alias resolution. It resolves a bare `[[Name]]` by filename only, and an alias doesn't resolve a bare link there (aliases only feed its link picker). So these steps help Surface read links that humans typed loosely, but they must never be what a written link *depends* on.

**Writing links (Obsidian-safe rule).** When Surface or the agent creates or fixes a link, it writes the shortest form that **Obsidian would resolve to the same file**:

- the plain `[[Name]]` only if that filename is unique across the whole workspace;
- otherwise a path, `[[contacts/Jane Doe]]`, or a path plus display name.

Uniqueness here is judged the way Obsidian judges it (by filename across the vault), not by Surface's type narrowing. A link Surface writes therefore points to the same record in both apps.

**Compatibility notes:**

- Links in front matter must be quoted strings (`assignee: "[[Jane Doe]]"`), or lists of them. Obsidian treats those as real links in properties, backlinks and the graph.
- Heading links (`[[Note#Heading]]`) and block links (`[[Note#^id]]`) are native Obsidian syntax.
- Renames done *in Obsidian* are handled by Obsidian's own "update links" setting, and Surface just sees the updated files. Renames done in Finder or git break the links in Obsidian until someone accepts Surface's "update N links?" flag.
- A loose bare link a human typed (`[[Jane Doe]]` with two Jane Does) may open the wrong one in Obsidian, even though Surface resolved it correctly by type. Surface flags these with "ambiguous in other apps; pin it?"

**Remembering what a link meant.** Once a link resolves, the index stores which record ID it points to. That keeps links stable even when things change later:

- **A new duplicate appears** (a second Jane Doe is created): existing links keep their stored target and are flagged *"now ambiguous; pin it?"* Pinning rewrites that link to its path form. Pinning is an edit someone chooses, so the flag-only rule still holds.
- **A rename inside Surface:** Surface rewrites the links that point at the renamed record, using the stored IDs. A rename is something the user did in Surface, so this isn't the normalizer acting.
- **A rename outside Surface** (Finder, another editor, git): the record's `id` in its front matter is unchanged, so the index sees the same record at a new path. Links that point to the old name are flagged *"target renamed; update N links?"* and updated only when someone accepts.

The cost: the stored link → ID mapping lives in the index, not the file. If the index is rebuilt from scratch, links are resolved fresh from their text. Any link whose text is ambiguous at that moment gets flagged rather than silently reattached. That's acceptable, because writing the shortest unambiguous form keeps those cases rare.

### 7. Schema changes are migrations

Renaming a field, or a choice option, in the schema rewrites every affected file in one operation (the way `links.py rename` handles links). The index is rebuilt afterwards. Nobody hand-edits 400 files.

### 8. Computed fields are never stored

Formulas and rollups (task count on a job, days overdue) are computed in the index at view time. If one is written into a file for portability, it's marked read-only and regenerated, never trusted as input.

## Proposal: a flat Markdown body

The body stays one Markdown string per file. Here's what that costs and how to recover most of it:

| Problem | Solution |
|---|---|
| **Two people editing the same body** | Three-way merge at paragraph level against the last common version. Edits to different paragraphs merge; only same-paragraph collisions need resolution. For live co-editing inside the Surface app, run a temporary shared-editing session (a Yjs or Loro text document) while people have the note open. It writes back to the plain file and keeps its state out of the file. Edits from other apps are diffed into the session. |
| **Agents overwriting human edits** | Agents never rewrite a whole file. They make section-level patches (replace the contents under a heading, append to a list) through the same merge path humans use. |
| **Presence and collisions** | Show who's in a note and which section they're editing. An optional soft lock per section is a lighter version of the old checkout idea. |
| **Linking to part of a page** | Headings are natural anchors (`[[Note#Heading]]`). Add Obsidian-style `^block-id` markers only when something actually links to that paragraph, never everywhere. |
| **Comments anchored to text** | Store comments in a side file (or the index), anchored by the quoted text plus its surrounding context (the W3C Web Annotation approach). They survive edits without cluttering the file. |
| **Live record views inside a page** | Use a fenced code block (` ```surface ` with a query inside), as Obsidian Bases does with ` ```base `. Surface renders a live table; other editors show readable query text. |
| **Tasks inside a body** | Plain `- [ ]` checkboxes for simple to-dos. Rule: **if it needs fields, it's a record.** It gets its own file, and the body links to or embeds it. |
| **Moving and reordering** | The editor handles drag and fold as text operations (Margin-style); the result is still plain Markdown. |
| **History and undo** | File history from git or snapshots, plus the merge base kept for three-way merges. |

What we give up on purpose: block-level permissions, per-block metadata, and Notion-grade live co-typing as the default. Simultaneous editing of the same paragraph should be rare for a small team, and the live session covers it when it happens inside Surface.

## Open questions

1. **Source of truth:** files (A or D), database (B), or both (C)?
2. **Strictness:** enforced field types, suggested ones, or defined but tolerant of extras?
3. **Links:** by permanent ID (survives renames, less readable raw) or by name?
4. **Body:** one Markdown string, or blocks? If blocks, how does that survive a round trip through an external editor?
5. **Concurrency target:** live co-typing in the same paragraph, or "different fields and paragraphs merge cleanly, same-spot collisions are rare"?
6. **"Any app can open it":** must other apps be able to *edit* the files, or is *reading* them enough? This decides between B and C/D. (Leaning: edit. Files and YAML stay the real thing.)
7. **Schema location:** `.surface/types/` (hidden), or a visible folder that Finder users can browse?
8. **Extra fields:** allow, warn, or deny fields that aren't in the schema, globally or per collection?
9. ~~**Unique names**~~: resolved. Names needn't be unique; links resolve by path, type, nearness and aliases, and ambiguity is flagged (section 6).
10. ~~**Normalizer authority**~~: decided. Warn and flag only; never rewrite (section 4).
