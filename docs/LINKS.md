# Links and vaults

How Surface keeps links correct across renames, and how a workspace shows up as folders of Markdown that Obsidian, VS Code, Finder or an agent can open. Built Oct 18.

## The idea

The database is the truth. Every page is a record, and the folders of Markdown you open in other apps are **generated** from it. A generated folder is a **vault**. A workspace can have any number of them.

```text
database: records (title, folder, fields, aliases, text)  +  links (who points at whom)
    │
    ├── vault: ~/Surface-EcoSynthesis            everything, your folders
    ├── vault: ~/Wiki                            only the "02 - knowledge base/01 - wiki" folder
    ├── the app (writing, data view)
    └── agents (CLI)
```

Every vault is editable: save a file in Obsidian and it goes back to the database (push on save while `surface serve` runs, or `surface push`).

## Links

**Stored by id, shown by name.** In the database, a link in page text is the target's id:

```text
[[id:1ndaswyd55m8]]              a link
[[id:1ndaswyd55m8#Zone 1]]       to a heading
[[id:1ndaswyd55m8|the zones]]    with its own label
![[id:1ndaswyd55m8]]             an embed
```

Every surface shows the target's current name, so a vault file reads `[[Zones]]`, `[[Zones#Zone 1]]`, `[[Zones|the zones]]`. Rename "Zones" to "Permaculture Zones" and every file shows `[[Permaculture Zones]]` on the next pull. **Nothing that links to it changes in the database** (no new revisions, no sync traffic).

**Reading what you typed.** When a file is pushed (or the app saves), each `[[Name]]` is looked up the way Obsidian does:

1. a filename in the vault (`[[Zones]]`), or a path when two files share a name (`[[02 - knowledge base/README]]`);
2. an alias (`[[Zone 1]]`, from `aliases:`);
3. a title.

If what you typed isn't the target's own name, it's kept as the label, so the text reads the same: typing `[[Zone 1]]` stores `[[id:…|Zone 1]]` and shows `[[Zones|Zone 1]]`.

**Not links:** anything inside code (`` `[[x]]` `` and fenced blocks), and attachments (`![[photo.png]]`, PDFs), which stay as paths.

**Unresolved links** (no page by that name yet) stay as typed text. `surface links` lists them with where they're used. Create the page, add the name as an alias, or fix the link. When a page is created, links to it resolve on that push; `surface relink` resolves any that are left.

**Links in fields** (link fields, `parent`) already worked this way: ids in the database, `"[[Name]]"` in front matter.

**Backlinks** come from the stored ids. The database's `links` table holds field links and text links (`field_id = 'body'`), maintained by a trigger on every save.

## Aliases

`aliases:` in front matter (Obsidian's convention) is a built-in property of every record, in every table, like the title. It's a plain list in the database (`records.aliases`). The app shows it under the properties ("Also called"). Aliases only matter for reading what someone typed.

## Vaults

```text
surface vault new <folder> [--workspace <name>] [--under <folder>] [--only table,table] [--layout folder|type|flat|link:<field>]
surface vault list
```

- `--layout folder` (the default for `vault new`): records go in their own folders. Your folders keep your filenames; two `README.md` in different folders are fine.
- `--under "02 - knowledge base"`: a vault of one folder. Paths start inside it; a note made in it lands in that folder.
- `--only wiki,source`: only some tables.
- A vault is a checkout (`.surface/` inside holds its state). `surface init` makes one too.

## Importing a folder of notes

```text
surface vault new ~/Surface-EcoSynthesis --create EcoSynthesis
cd ~/Surface-EcoSynthesis
surface import <folder> [--type-from <front matter key>] [--tables a,b,c]
```

Copies every note and attachment (the source is untouched), keeping folders. With `--type-from document_type`, each note's `document_type` names its table (`--tables` limits which; the rest are pages) and is replaced by `type:`. Other front-matter keys become fields, typed from their values (date, number, URL, a select when a few values repeat, else text). Then it pushes everything and resolves links.

## Upgrading a cloud project

Aliases and text links need migration `0006_links_aliases.sql`. Local databases get it automatically. For a Supabase project: `surface cloud schema --since 6 --out upgrade.sql`, paste it into the SQL editor, Run. Until then, saving still works; aliases aren't stored in the cloud (logged as a warning), and sync keeps local aliases.

## Open

- Links to headings are kept as text after the id (`#Zone 1`); renaming a heading doesn't update them yet.
- Block links (`#^id`) and links to attachments aren't tracked as records.
- A list field kind (for `tags` and similar) is still missing; list values import as comma-joined text.
