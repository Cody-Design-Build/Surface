# Handoff: standalone Airtable-style Surface data UI

Updated October 18, 2026. Work is in `/home/ductape/Work/Surface`, on `main`, based on `87adcad`. **All changes described here are uncommitted and unpushed. The standalone build is not finished or verified for daily use.** Another remote agent also works on this repository; preserve its changes and reconcile before pushing.

## User's intended outcome

Build a separate surface, like Airtable, over the Surface foundation. It must work independently of the existing writing/navigation app. It should list every existing type as a table, show/edit its records and relationships, support saved views, and let users create types and edit their fields. Own local URL/window now; optional navigation from the writing app later. No SaaS dependency. Airtable table feature parity is the target, with gaps tracked explicitly rather than claimed complete.

Earlier work added React Data Grid inside the writing app's saved table views. That was the wrong product boundary; reuse that grid as groundwork, not as completion. React Data Grid is the implementation being reused now. Glide was discussed as another candidate, but the user has not authorized a component migration. TanStack was discussed too; it requires more custom interaction work.

The user clarified: “just make it so it can function like airtable, it should have all the tables we have now, with relationships. we should be able to create new types and edit them.” No further product answers are required to continue this first build.

## Changes in the working tree

- `docs/SPEC.md`, `docs/TODO.md`, `app/README.md`: correct the concept from an integrated app grid to a standalone data surface. These edits predate this implementation and must be preserved.
- `docs/DATA-SURFACE.md`: first-build plan, architecture and later parity gaps.
- `app/data.html`, `app/src/data.tsx`: independent React entry point, title Surface Data. Does not mount `App.tsx` or its sidebar.
- `app/vite.config.ts`: builds both `index.html` and `data.html`.
- `app/src/DataApp.tsx`: new workspace/table navigation, default All records without saved-view metadata, existing saved table views, reusable editable Grid, record sheet, duplicate, filters, save-as-view, schema management through TypesPanel, undo and notifications.
- `app/src/data.css`: standalone visual shell, teal top bar, type navigation, table toolbar, record sheet, light/dark support and responsive rules. No visual QA yet.
- `app/src/ViewEditor.tsx`: optional `onApply` mode for temporary filters (does not save a database view). Preserve existing layout settings using `{ ...l }`, rather than stripping grid widths/grouping when saving filters. Existing app callers should retain prior behavior.
- `cli/src/main.ts`: new `surface data [--port 4318] [--open] [--tab] [--no-watch]` command.
- `cli/src/serve.ts`: optional `surface: "data"`; `/data/` serves `data.html`; token redirect preserves the data entry point; data server does not replace the writing-app discovery registration.
- `app/package.json`, `app/package-lock.json`: added exact dev dependencies `happy-dom` 21.0.3 and `tsx` 4.23.15 for DOM integration tests. No test script added yet.
- `app/qa/qa-data.mjs`: in-memory DOM integration test against a real, isolated local PGlite/Postgres workspace. Explicit workspace-name safety check. Does not automate a real browser or provide screenshots.

## Architecture and important boundaries

The server's active workspace is process-scoped. The data surface defaults to **port 4318**, separately from the writing app on **4317**, so switching workspace in one does not switch the other. Both use existing authenticated APIs and storage. Local PGlite already supports forwarding to the owning process; check two-server behavior before claiming it is verified with a local store. The live cdb-os workspace uses cloud storage.

Every type must be discoverable, including empty types and those without saved views. Default All records is transient; saved configurations persist using existing personal/shared view APIs. Shared saves must remain explicit. Existing record IDs and link-field targets are reused. Schema changes still require owner/admin privileges, record editing respects viewer restrictions, and backend validation/revision conflicts remain authoritative.

## Progress since first handoff (Oct 18, later session)

- Fixed relationship save: `Properties.tsx` buttons now all `type="button"`; Enter in text/link-search inputs no longer implicitly submits an enclosing form.
- `DataApp.tsx`: hashchange guard (back/forward/typed URL) prompts once and restores the URL on cancel; in-app navigation clears the draft first (`go()`); saved-view `limit` applied; filter dialog applies only `where`/`sort`; RecordSheet load ignores stale/unmounted results.
- `ViewEditor.tsx`: filter mode forces layout section `display:none`.
- `qa/qa-data.mjs`: act-wrapped API calls (no act warnings), `history` exposed to the test, new checks for draft guard and view limit. `npm run qa:data` script added.
- `tsc` + `npm run build` pass; `git diff --check` clean. **11/11 integration checks pass.**
- cdb-os read-only smoke on **port 4318** (`surface data --port 4318 --no-watch` from `/home/ductape/Surface-cdb-os`; `--no-watch` because the 4317 writing server already watches that checkout): owner role, 571 records, all 9 types with link fields present, 14 views, `/data/` serves, no-cookie API → 401, 4317 unaffected. 37/37 contact→organization links resolve. No business records mutated by QA. Afterwards, at the user's explicit request, the `tile_surface` type, its 8 records and the `job-tile` (Tile takeoff) view were permanently deleted from cdb-os (no backup). cdb-os now has 8 types / 563 records.

Still open: items 3 (schema field-edit/link-field QA, viewer role), 6 (modal focus, save-as-view vs record-write race), 7 (Grid gaps), 9 (no real browser/visual QA), 11 (nothing committed).

## What has actually passed (first session)

`npm run build` in `app/` passed after the initial DataApp/entrypoint/server implementation, producing `dist/data.html` and a separate data JS entry. **ViewEditor filter-mode changes happened afterward; rebuild the latest tree.** CLI locked dependencies were installed with `npm ci` to obtain PGlite.

An isolated local database/workspace was created successfully. `surface data --port 4392 --no-watch` started successfully and printed a `/data/?token=...` link.

Latest integration run:

```sh
cd /home/ductape/Work/Surface/app
DATA_QA_CONFIG=/tmp/surface-data-qa/config node --import tsx qa/qa-data.mjs
```

Passed four checks:

1. Independent shell lists every type without the writing sidebar.
2. A type without saved views opens as an editable table.
3. Empty types can be navigated and offer creation.
4. Creating a record and editing its title/body persist through the actual local API.

Then failed at `app/qa/qa-data.mjs:104`, attempting `click(button("Save record"))` after selecting a relationship. The relationship picker opened and the company option was found, but the save button could not be found at that instant. **Do not report relationships as verified yet.** The run also logged React act warnings during async state updates.

Likely issue to investigate: `RecordSheet` wraps reused `Properties` controls in a `<form>`. Existing property picker buttons omit `type="button"`; clicking one may submit the outer form implicitly. This could trigger an early save and change the button to “Saving…”. Inspect/fix that boundary (e.g. avoid wrapping reused controls in a form, or make button types explicit) and make the test wait for the intended idle state. Do not just suppress the failing check.

The remaining saved-view, type-creation, validation/conflict and auth checks in that script have **not run to completion**.

## Isolated test environment

Paths (temporary, can disappear):

```text
/tmp/surface-data-qa/db            SURFACE_DATA_DIR (actual PGlite files under db/)
/tmp/surface-data-qa/config        SURFACE_CONFIG_DIR
/tmp/surface-data-qa/vault         checkout, workspace “Data Surface QA”
http://127.0.0.1:4392              isolated data server
```

Start/recreate if necessary:

```sh
cd /home/ductape/Work/Surface
SURFACE_STORE=local SURFACE_DATA_DIR=/tmp/surface-data-qa/db SURFACE_CONFIG_DIR=/tmp/surface-data-qa/config ./cli/bin/surface init /tmp/surface-data-qa/vault --create 'Data Surface QA'
cd /tmp/surface-data-qa/vault
SURFACE_STORE=local SURFACE_DATA_DIR=/tmp/surface-data-qa/db SURFACE_CONFIG_DIR=/tmp/surface-data-qa/config /home/ductape/Work/Surface/cli/bin/surface data --port 4392 --no-watch
```

Do not rerun `init` over an existing checkout; reuse it. The most recent running exec session ID was `26774`, but session IDs may not survive handoff. Check the listener/process first. Binding localhost requires normal tool escalation in this environment.

The test seeds uniquely named contact, company and empty types on each run. It uses only the QA workspace, then drives the React components in Happy DOM with real HTTP requests to local Postgres. Test uses cookie authentication from the test config; do not print token contents. It guards against accidentally running on cdb-os.

## Remaining implementation/review work

1. Resolve the relationship-picker/form issue and finish integration checks. Improve act wrapping rather than hiding warnings.
2. Review record-draft navigation: `sheetDirty` is retained in a ref. Table/view clicks and hashchange currently have incomplete cleanup/guard behavior; prevent accidental draft loss and stale repeated discard prompts. Browser back/forward should be considered too.
3. Test record-sheet failed validation and revision conflict with the draft retained, plus read-only/viewer behavior. Schema management needs explicit create/edit/link-field QA, not just a button that opens TypesPanel.
4. Review filter dialog mode. It uses ViewEditor with an unsaved `ViewInfo` to apply a draft. Current `hidden` layouts container may still be visible if CSS overrides hidden display. Ensure filters do not alter unrelated layout settings. Existing query grammar only supports conjunctions and has limitations around special strings; don't promise full Airtable filter parity.
5. Preserve saved-view semantics: `DataTable` currently queries by from/where/sort rather than `api.view`, so an existing view's `limit` is not honored. Apply it or query saved view appropriately. Handle externally changed/deleted definitions and scope conflict correctly.
6. Review modal keyboard/focus behavior, errors, network loading and stale request handling. RecordSheet load lacks cancellation protection on unmount. Save-as-view should not race with record writes.
7. Existing Grid has limitations (e.g. last hidden field can fall back to default columns). Track/fix gaps that affect this workflow. Formula/rollup and broader Airtable parity are not implemented.
8. Add repeatable test instructions/scripts, rebuild, run relevant CLI checks and inspect `git diff --check`. React review skill was read; do the actual review of final code.
9. No real browser is exposed via CUA (last inventory had no apps/browsers). No screenshot/visual verification has occurred. Be explicit about that limitation unless browser access becomes available. Existing repo Puppeteer scripts assume the previous agent's Mac; don't blindly run their executable paths.
10. Start the real data surface on cdb-os port 4318 and verify read-only API/table discovery. **Do not mutate business records for QA.** Confirm all 9 types and relationships appear. Give the user a working authenticated link and explain the first-build limitations honestly.
11. Nothing has been committed or pushed. User asked to build; earlier “push this concept” applied to the previous spec commit, not these unreviewed changes. Reconcile with remote work before any eventual push.

## Real workspace / ongoing workflow

- Repo: `/home/ductape/Work/Surface`, GitHub `Cody-Design-Build/Surface`.
- Existing writing-app checkout: `/home/ductape/Surface-cdb-os`; 570 records, 9 types at last check.
- Other checkouts: `/home/ductape/Surface-Vault` (Surface Test), `/home/ductape/Work/Surface-Test`.
- Signed-in Surface account owns cdb-os; credentials are in the normal config. Do not expose them.
- Existing writing server: port 4317, last session `92981`; do not stop it merely to launch the independent data server on 4318.
- For routine user “update”: pull latest code, install locked dependencies if changed, rebuild app, restart the relevant server, verify workspace API. Do not blindly pull/rebase with this uncommitted implementation in progress.
- The user prefers direct action and simple browser links, not instructions involving Neovim. No new desktop settings are needed for this build.
