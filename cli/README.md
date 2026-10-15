# surface CLI

Typed records in Supabase, checked out as Markdown files you can open in Obsidian or any editor.
Supabase is the source of truth; the folder is a checkout. This is Surface's first and foundational surface: a shared Markdown working medium for humans and agents. The planned dedicated app and other surfaces use the same data foundation; see [`../docs/SPEC.md`](../docs/SPEC.md) for the product direction and [`../docs/MVP.md`](../docs/MVP.md) for current scope.

## Install

Copy the commands without comments: zsh treats a pasted `# …` as arguments.

```sh
cd cli && npm install && npm link
```

Needs Node 23.6 or newer (it runs the TypeScript source directly). `npm link` puts `surface` on your PATH; if it fails with `EACCES`, see the fallback below.

Fallback without `npm link`:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/surface" ~/.local/bin/surface
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Start

```sh
surface signup
surface init ~/Surface --create "Cody Design Build"
cd ~/Surface
```

Every workspace starts with one built-in type, **page** (title and body only).

## Run the app

```sh
cd app && npm install && npm run build   # once, and after pulling app changes
cd ~/Surface && surface serve            # serves the app on http://127.0.0.1:4317
```

Open the link it prints once (it carries a sign-in token), then install the page as an app: Omarchy's Install Web App, Chrome's Install, or Safari's Add to Dock. `--port` changes the port; `--open` opens the browser. The server listens on 127.0.0.1 only and keeps the checkout current while it runs.

## Build your types

```sh
surface type add project
surface field add project status --kind select --options "Lead,Estimating,In Progress,Done"
surface field add project budget --kind number
surface type add material --name "Material"
surface field add material supplier
surface field add material cost --kind number
surface field add material project --kind link --target project
surface types
surface type show material
```

Field kinds: `text`, `number`, `date`, `checkbox`, `select`, `multi_select`, `url`, `email`, `phone`, `link` (`--target <type>`, `--multiple`).

Change them any time:

- `surface field edit <type> <key>`: `--key`, `--name`, `--add-option`, `--remove-option`, `--required`, …
- `surface field rm <type> <key>`
- `surface type edit <key>`: `--key`, `--name`, `--folder`
- `surface type rm <key>`: `--move-to <type>` or `--force`

Fields have permanent internal IDs, so renaming a key never loses data.

## Work with records

From the CLI:

```sh
surface new project "Steiner Kitchen" status=Estimating budget='$45,000'
surface new material "Shaker cabinets" cost=12000 project="Steiner Kitchen"
surface new page "Punch List" --folder Reference
surface set "Shaker cabinets" cost=12500
surface query material --where "cost>10000" --sort -cost
surface show "Steiner Kitchen"
```

Or in files, in Obsidian, by hand or by an agent:

1. Edit a file. Change fields in the front matter, or write in the body.
2. Run `surface status` to see what changed, and `surface diff` to see how.
3. Run `surface push` to send it up.

Push **normalizes** safe fixes and reports each one:
- `Oct 20` → `2026-10-20`
- `in-progress` → `In Progress`
- `$47,500` → `47500`
- `yes` → `true`

It **rejects** anything it can't use: an unknown option (with a "did you mean"), a bad date, a field the type doesn't have, or a link to a missing record. It also catches **conflicts**: if the record changed since your file's `rev`, the file is rejected, like `git push`. Run `surface pull --force`, redo the edit, and push again.

New files: write front matter with `type:` (or none, for a page), then `surface push --new`.

`surface pull` writes the database into the folder. It never overwrites a file with unpushed edits (unless `--force`). Renamed records move their files and rewrite every link.

Layouts: `surface init <dir> --layout type|flat|folder [--only task,project]`. Each checkout can differ.

## Folders, nesting and the Views tree

Files are storage; the Views tree is navigation. Neither one changes the other.

```sh
surface layout                         # show this checkout's layout
surface layout link:project,parent     # tasks under their project, pages under their parent page (files move)
surface layout folder                  # your own folders (each record's folder value)

surface mv "Order cabinets" "Jobs/Active"                        # folder layout: move records
surface mv --type task --where "project=Bathroom" --to Archive   # move by query
surface folder rename Jobs Work                                  # everything under a folder
surface folders                                                  # list folders with counts

surface new page "Pricing" --parent "Estimating guide"           # nest a page (front matter: parent: "[[…]]")
surface set "Loose note" parent=                                 # un-nest
surface query --where "parent=this" --this "Pricing"             # children of a record

surface tree init                      # starting tree: a group per type
surface tree --paths                   # draw it, with file paths
# edit .surface/views/sidebar.yaml, then:
surface tree check && surface push
```

`.surface/views/sidebar.yaml`:

```yaml
name: Sidebar
items:
  - group: Jobs                          # a virtual folder
    items:
      - query: { from: project, where: "status!=Done", sort: title }
        each:                            # children of every matching project
          - query: { from: task, where: "project=this", label: Tasks }
  - record: "[[How We Estimate]]"        # one record, with its nested pages
  - query: { from: page, where: "folder= && parent=", label: Inbox }
```

Every record in the tree also shows the records nested under it (`nested: false` turns that off).

## For agents

Every pull writes `AGENTS.md`, `.agents/skills/surface/SKILL.md` (also copied to `.claude/skills/`), and a read-only copy of each type in `.surface/types/`.

## Test

```sh
npm test
```

## Database

Migrations are in `../supabase/migrations/`:

| Table | Holds |
|---|---|
| `workspaces`, `members` | Roles: owner, admin, member, viewer |
| `types` | Field definitions as JSON, each field with a permanent id |
| `records` | Values keyed by field id |
| `links` | Maintained from link fields |
| `history` | Every revision |

- Row-level security is written once, on these six tables. New types never need new tables or rules.
- The database validates every write in a trigger, so a client that skips the CLI still can't store bad data.
- `push_record` does the revision check.
