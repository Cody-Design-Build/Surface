# Notion import

Builds a Surface workspace from a Notion workspace. Used once to create `cdb-os` from CDB's Notion (Oct 17).

1. **Export** (read-only on Notion): every data source the integration can see, every row, and each page's Markdown (`GET /v1/pages/{id}/markdown`). The export script lives in the scratch folder; it writes `datasources.json`, `rows.json`, `pages_search.json` and `md/<page id>.json`.
2. **Plan:** `python3 plan.py <export folder>` maps databases to types and properties to fields, merges duplicate per-job databases (the Steiner Selections and Orders copies) into one type with a `job` link, turns Notion mentions into `[[wikilinks]]` and inline databases into live view blocks, and makes titles unique. Writes `plan.json`. The mapping table at the top is CDB-specific.
3. **Load:** `node load.ts <plan.json> --workspace cdb-os [--create]` (from `cli/`, signed in). Creates the types and fields, writes every record through `push_record` (so the database validates each one), then sets links and parents in a second pass, then saves the views and the workspace sidebar. A map file next to the plan makes re-runs update in place.

Not carried over: Notion's people fields (empty in this workspace), file attachments (names kept in the notes), formulas and rollups (imported as their current values), relations to databases the integration can't see (Tags, Special inspections, Documents).
