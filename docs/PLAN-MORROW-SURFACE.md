# Plan: a Notion-style surface for Surface (Morrow, hybrid, or our own)

Draft, October 18, 2026. Replaces the reverted relationship-map attempt (`59b3eca`, reverted in `4d581f4`).

## The goal

A Notion-feeling app (page tree, rich documents, databases inside pages, board and calendar views)
where **all data stays in Surface's own tables**. It is one more working surface beside the CLI,
the Markdown vault, the writing app (4317) and the data app (4318). The question is which way gets
there best:

1. **Adopt Morrow**: run Morrow itself on a Surface checkout.
2. **Hybrid**: run Morrow's interface on Surface's database through an adapter.
3. **Our own**: keep building the writing app into this surface.

Morrow: github.com/Aarav2709/Morrow, **Apache-2.0** (not MIT). It is React 19, Tiptap and Electron,
about 27k lines, a single author, and 5 days old at the time of review.

## Spike results (done October 18, read only)

I ran Morrow's real storage engine (`VaultRepository` and `WorkspaceSession` over its in-memory
vault) on a copy of the **cdb-os checkout**: 565 Markdown files and 8 tables. The edits went to
memory and to `/tmp` copies, never to cdb-os. Each result was checked with `surface push --dry-run`.
The scripts are in `/tmp/morrow/src/surface-spike*.test.ts`.

| Test | Result |
|---|---|
| Open the checkout | ✅ 573 pages, 0 problems, **0 files changed** |
| Surface's `id`, `type`, `rev` and fields after a Morrow save | ✅ kept |
| Surface tables as Morrow databases | ✅ **after** adding a generated `Jobs.md` (`kind: database`, properties from `.surface/types/job.yaml`). Jobs, Tasks and Contacts were all recognised, and 21 of 22 job rows read select, text and link values. Board view grouped by status. |
| Change a job's status in Morrow | ✅ writes `status: Complete`, keeps `id`, `type` and `rev`. `surface push --dry-run`: **would push**. |
| Link fields (`[[Title]]` lists) | ✅ read as Morrow relations, written back in the same form |
| Rename a record | ✅ file renamed, `id` kept, push matches it by `id` |
| Nest a task under a job | ⚠️ file moves to `Jobs/<job>/<task>.md`; push still matches by `id`, but the next `surface pull` would move it back (layout fight) |
| Edit a page's text | ⚠️ text kept, but Morrow **reformats spacing** (blank lines around headings), so diffs are noisy |
| **Side effect of any save** | ❌ Morrow **renamed 8 unrelated files** whose names Surface had sanitised differently (`Bath-shower trim` → `Bath shower trim`). Surface's next pull would rename them back, so the two would ping-pong forever. |
| New page in Morrow | ⚠️ no `type:`. Push adds it as a plain page, not a row in the table it was created in. |
| `title:` | Morrow drops it when it matches the file name. Push accepts that and uses the file name. |
| Validation | ⚠️ after the fact only. Morrow adds new select options on the fly; Surface refuses them at push. |

**Verdict:** Morrow on a checkout works much better than expected. The failures are all on the file
layout side and fixable in Surface, not in Morrow: matching file names, a nesting rule, database
stub files, and inferring the type from the folder.

## The three options, with evidence

| | 1. Adopt Morrow (checkout) | 2. Hybrid: Morrow UI on the database | 3. Our own app |
|---|---|---|---|
| How | Morrow opens a Surface checkout; `surface watch` pushes saves. Surface generates and maintains the bits Morrow needs. | Fork Morrow and replace its file-system bridge (`VaultBridge`, about 10 methods) with one that reads and writes Surface records through `surface serve`. Records show as virtual Markdown pages with no checkout. | Grow the writing app (4317): page tree, block editor, embedded views, board, calendar |
| Notion feel | Full, today | Full | Weeks to match |
| Data stays in our tables | ✅ via files | ✅ directly | ✅ |
| Live, validated edits | ❌ push after save; refusals after the fact | ✅ save → `push_record` → immediate error | ✅ |
| Runs in the browser, shareable | ❌ desktop app per person | ✅ if served by `surface serve` (needs a web build of the fork) | ✅ |
| Permissions | Whoever has the checkout | Same as the API | Same as the API |
| Work for us | **Small**: Surface-side adapter only | **Medium**: fork plus adapter; we own a fork of a young codebase | **Large** |
| Proves SPEC §1 ("any editor is a surface") | ✅ strongly | Partly | No |
| Main risk | Layout drift; Morrow changes its file rules upstream | Fork maintenance; Morrow is 5 days old | Time |

## Recommendation: 1 now, 2 if it earns it, keep 3 for what only we can do

### Phase 1: Morrow works on a Surface checkout (about 2–3 days, Surface-side only)

1. **Matching file names.** Surface's file-name sanitiser follows Morrow's (`safeFileName`: replaces
   `<>:"/\|?*#^[]` with spaces and collapses whitespace), so neither side renames the other's files.
   This changes Surface file names for about 14 cdb-os records once, via one `surface pull`.
2. **Table stubs.** `surface pull` writes `<Folder>.md` for each type with `kind: database`,
   properties mapped from fields (select options, links as relations), and table and board views.
   They are regenerated from the types, and **ignored by push** (or used to suggest field changes later).
3. **Type from folder.** A new file in `Jobs/` without `type:` gets `type: job` on push (normalised
   and reported).
4. **Nesting rule.** A file under `<Folder>/<Record>/x.md` is pushed with `parent` = that record, and
   pull keeps it there instead of moving it back. That's SPEC §4's `parent`, written as Morrow lays it out.
5. **Ignore `.morrow/`** in checkouts. Keep Morrow's spacing changes (text unchanged) and its
   omission of `title:` without flagging them.
6. **`surface open --morrow`** (or a doc page): opens the checkout in Morrow with `surface watch` running.
7. **Tests:** run the spike as a repeatable test, then a manual session in real Morrow on a QA
   checkout, then cdb-os with you.

Exit: you use Morrow on cdb-os for a few days. We list what's missing (live validation, sharing,
seeing other people's changes).

### Phase 2 (only if Phase 1 shows we want live editing in the browser): Hybrid

Add a `SurfaceVaultBridge` to a Morrow fork that talks to `surface serve` (records as virtual
Markdown using Surface's own renderer; saves through `push_record`; server events for live
updates), served at `/notion/` like `/data/`. Keep the fork small and rebase on Morrow upstream.

### Our own app (3)

Stop building Notion-style features into the writing app while this is tested. Keep it for what
Morrow can't do: Surface-specific views, sharing and guest links, workspace and type management, and
artifacts.

## Decisions needed from David

1. **Go with Phase 1?** It changes about 14 cdb-os file names once (the sanitiser match) and adds
   9 `<Folder>.md` table stubs to the checkout.
2. Is a **desktop app per person** acceptable for now, or is the browser a must? A browser
   requirement means skipping to Phase 2.
3. Should a select option typed in Morrow (not in the type) be **refused** at push, as now, or
   **added to the type** automatically for owners and admins?

## Not in scope

The data app (4318) stays as it is. No Morrow code is copied into Surface in Phase 1; we only read
its file format. Phase 2 forks Morrow as a separate project under Apache-2.0 (keep the notices and
state our changes).
