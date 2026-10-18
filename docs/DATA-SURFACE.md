# Standalone data surface

Decision: October 18, 2026. A local, independent Airtable-style interface over the Surface foundation. The writing app and Markdown checkout are other clients of the same records. No SaaS dependency or second authoritative data store.

## First usable build

- Own browser entry point and CLI command (`surface data`, default port 4318). Its server/workspace selection is independent of the writing app on 4317.
- Workspace selector; every type appears as a table, including empty types and types with no saved views. An All records view always exists without creating database metadata.
- Editable typed cells, relationship pickers using existing record IDs, selection, paste/fill, sorting, grouping, column controls and row heights via the existing grid.
- Record creation, detail editing, duplication and recoverable deletion. Writes retain Surface validation and revision checks. Errors retain drafts rather than claiming a successful save.
- Named personal/shared table views using the existing view definitions, with filters and grid configuration persisted together. Shared definitions change only after an explicit save by an authorized role.
- Type creation and field management, including link targets, through the existing type API. Viewers are read-only for records; only owners/admins change schemas.
- Local URL is directly useful; linking from the writing app is optional.

## Verification

Test against an isolated local workspace: a type without saved views, an empty type, a populated type, select/date/number/link cells, stale revisions, failed validation, saved-view persistence, personal/shared behavior, and schema changes. Also read the real cdb-os workspace to confirm every table is discoverable. Do not use its business records for destructive QA.

## Further Airtable table parity

Track separately: range-selection parity, grouped summaries, field menus, richer filter expressions, formula/rollup engine, relationship reverse editing, attachments across machines, grouped bulk undo and larger-data pagination. The initial surface reuses existing grid behavior; it is not a claim that every Airtable table feature is already implemented. Board/calendar/gallery and Airtable automation/interface products are outside the first table-focused delivery.

## Component boundary

The standalone React entry point shares typed editors, grid rendering, API and validation with the writing app, but never mounts its App/sidebar shell. A separate server is used initially because the current server's active workspace is process-scoped. A shared multi-workspace server would need request-scoped workspace context before replacing that isolation.
