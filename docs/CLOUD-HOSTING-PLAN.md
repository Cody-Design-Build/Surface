# Surface cloud hosting, authentication, and agent access plan

Status: superseded historical proposal. The user chose a separate, Data-View-only application named [CDB-Surface](https://github.com/Cody-Design-Build/CDB-Surface), not a migration or retirement of the full Surface app. This repository retains its Vault, Markdown checkout, local CLI/database, offline work, and sync. The broader proposal below is retained for reference only; do not execute its full-app cutover or removal steps.

Assumption: the hosting provider referred to as “versatile” is Vercel.

## Agreed direction

- One hosted Surface deployment, with the existing production Supabase project as the source of truth.
- Keep the React/Vite interface; do not make a framework rewrite or database reset part of this migration.
- Retire per-machine production databases, background synchronization, mandatory Markdown checkouts, and local web servers.
- Use Supabase Auth for individual user accounts and authenticated agent connections.
- Only the owner may change the schema: tables/types, fields, field kinds/options, relationship definitions, or SQL/storage-engine behavior.
- Other authorized users may read records, create records in existing tables, and edit values in existing fields. Creating a record is allowed; creating a field is not.
- Expose a Surface-specific remote MCP for agents. A thin cloud CLI can remain optional; neither requires a local database or daemon.
- Preserve the [phone field policy](PHONE.md): ordered entries, first primary, no phone-type labels, preserve numbers and extensions.

## Architecture

- Vercel serves the UI and stateless Surface API handlers.
- Supabase supplies Postgres, Auth, private Storage, and Realtime.
- Web, MCP, and optional CLI operations share the same domain operations, validation, revisions, and authorization.
- Normal requests run in the authenticated user's database context, not with a shared desktop account or administrator/service-role key.
- Realtime notifications invalidate/refetch current data; they are not an offline replication engine.
- Browser caches are disposable. They are not another source of truth.

The existing local `serve.ts` cannot simply be exposed publicly: it assumes a desktop session, a shared local access token, checkout files, process-local snapshots/watchers, and a long-running local server. Hosted execution must remove those assumptions. Preserve current API shapes where practical and extract reusable business logic rather than rebuilding the UI.

## Authentication

1. Users sign in to Surface through Supabase Auth. Prefer invite-only workspace access for the initial deployment.
2. Surface accounts are Supabase Auth application users, not Supabase Dashboard/project administrators. Ordinary users must not receive project-management access, database passwords, management tokens, or service-role keys.
3. The hosted API validates the requesting user's token and checks workspace membership for every operation. Never trust a caller-supplied role or cache one person's authenticated Supabase client for all visitors.
4. Remote MCP uses Supabase Auth's OAuth 2.1 authorization-code flow with PKCE and explicit client consent, token verification, and revocable access. Enable/configure the OAuth server and authorization/consent screen as part of implementation; this is not automatic merely because Auth exists.
5. An agent acts with its user's permitted workspace access and may be further restricted by its authorization grant. Agent consent must never increase that user's permissions.
6. Database RLS/grants and authorized RPCs enforce the boundary even if a caller bypasses the UI, MCP tool listing, or CLI. Session revocation and role/membership changes must be covered by tests.

Supabase Auth answers “who is this?” Workspace authorization answers “what may they change?” OAuth identity scopes are not automatically table/field permissions.

## Permission model

Confirmed requirements: owner-only schema changes; members can read, create, and edit records in authorized workspaces. Deletion and shared-configuration rights below are conservative planning defaults, not additional permissions requested by the user.

| Operation | Owner | Member | Viewer, if used |
| --- | --- | --- | --- |
| Read authorized records and field definitions | Yes | Yes | Yes |
| Create a record in an existing table | Yes | Yes | No |
| Edit values in existing fields and notes | Yes | Yes | No |
| Set an existing relationship or choose a primary phone | Yes | Yes | No |
| Create/rename/delete a table/type | Yes | No | No |
| Add/remove/rename fields; change kinds/options or relationship definitions | Yes | No | No |
| Change SQL functions, grants, or physical storage schema | Authorized migration pipeline | No | No |
| Invite users or change roles/ownership | Yes | No | No |
| Delete/archive/restore records | Yes | Owner-only default | No |
| Save personal filters/views without schema changes | Yes | Yes | Read-only/personal-view policy to finalize |
| Change shared navigation/views or create workspaces | Yes | Owner-only default | No |

Additional rules:

- Creating a record must fail clearly for unknown fields or an unknown table; it must never auto-create schema.
- Editing values in a link field does not authorize changing its target, inverse, cardinality, or definition.
- No user or MCP argument may promote its own role. Ownership/schema authority is derived from trusted workspace membership, not a global `authenticated` JWT role, an email comparison, a UI flag, or a tool parameter.
- The intended initial owner is the current owner/user; do not assign other users an owner/admin role by default.
- Review sensitive financial fields and exports before rollout. Hiding a column is not access control.

### Gap in the current implementation

The CLI already supports record read/query/create/update, schema read/create/edit/remove, relationship values, phone-primary selection, and other operations. Those are reusable capabilities, not proof of the requested permission boundary.

Current migration policies use `ws_can_admin` for schema writes, and that helper admits both `owner` and `admin`. Membership administration also admits admins. `rec_write` covers all operations for writers, including deletion. `create_workspace` is executable by authenticated users. These must be reconciled with the stricter owner-only/default-deny plan through new versioned migrations and matching API checks; do not rewrite applied migrations or claim the policy is already enforced.

The current codebase does not implement a Surface MCP server. Existing Supabase MCP references concern developer/project setup and are not the proposed end-user Surface connector.

## MCP and CLI responsibilities

Build a Surface-specific remote MCP using the same cloud operation layer as the web UI. Do not hand ordinary users the general Supabase project-administration MCP.

Proposed member tool capabilities:

- Discover accessible workspaces and read table/field definitions, constraints, choices, and relationship targets.
- Search/query records with bounded result sizes and pagination; get individual records and authorized relationship values.
- Create records in existing tables; update known field values and notes with expected revision checks.
- Set existing relationships and select a primary phone through the same validated record operations.
- Upload/read authorized attachments through scoped Storage access.
- Return clear validation, permission, and revision-conflict errors. Do not overwrite newer data silently.

Owner schema capabilities may be exposed separately or appear only for owner sessions. Either way, the handler and database must deny unauthorized calls even when the caller invokes a tool by name without discovering it. Avoid arbitrary SQL tools, unrestricted table-update tools, or privileged credential proxies in the member MCP.

A thin CLI can expose the same operations for agents with shell access. Remove its production local-store/serve/sync requirements; do not maintain a second permission or normalization implementation. Users may build reports and workflows against existing data without obtaining schema authority.

Normal authorized data work should not require a new sign-in/permission grant for each record. MCP client consent and revocation remain explicit. Agent applications may independently require tool approvals; Surface cannot bypass their client-side approval settings.

## Offline policy

Recommended scope: online-only database editing, without an offline outbox or complete local table replica.

- Keep an unsaved edit visible in the current tab when disconnected and say “Not saved—offline.” Never claim it reached Supabase.
- Recheck the original record revision on reconnect/save. Preserve recoverable user input if another person edited the record.
- Do not queue offline schema changes, deletions, or background replay of record writes.
- Offline notes can be written in a separate notes app and ingested by an agent after reconnection.
- Durable, account-scoped browser draft recovery can be considered separately. It is not a prerequisite for this migration and must not become another synchronization engine.

## Attachments, links, and live updates

- Inventory files on every machine: current attachments live beside Markdown records and may not be in Supabase at all.
- Move files into private Supabase Storage with workspace-aware access policies and durable object references. Do not persist expiring signed URLs as the canonical document reference.
- Transfer large file bytes directly to Storage rather than through the hosted API request body.
- Rewrite/resolve existing relative attachment links without losing files, and verify the migration by content/hash and reference checks.
- Resolve records and aliases using database identities, not checkout filenames or local paths.
- Replace local event streams/watchers with Supabase Realtime and refetch on reconnect/focus. Retain revision conflicts; Realtime does not provide automatic document merging.
- Replace sync-machine badges with edit states such as Saving, Saved, Not saved, and Conflict.

## Deployment and database changes

- Keep one production Supabase database. Preview/test deployments use isolated test data and must not accidentally write to production.
- Preserve logical Surface tables in the existing `types`/`records` model. A physical `CREATE TABLE` does not automatically produce a Surface table.
- Ordinary table/field changes are owner-authorized Surface schema operations, not arbitrary SQL.
- Physical schema, SQL functions, grants, and RLS changes are version-controlled migrations run by a separately authorized deployment principal. No manual SQL copying or desktop-by-desktop migration deployment.
- Reconcile the existing migration ledger before enabling automated production migrations; a version RPC alone is not a full migration history.
- Gate production deployment on database compatibility. Use safe migration ordering and deploy checks so a new UI cannot edit against an incompatible database.
- Do not run migrations from ordinary HTTP requests. Do not put migration credentials in browsers, user MCP grants, chat, or repository files.

## Execution phases

### A. Inventory and protect data

Inventory all machines/workspaces, including local-only workspaces such as EcoSynthesis, unsent edits, conflicts, local-only history, and attachments. Back up Supabase and export local-only material. Preserve ID mappings, relationship identities, and existing cloud records rather than reimporting duplicates.

### B. Implement shared cloud operations and authorization

Separate domain operations from checkout/filesystem/process state. Implement stateless authenticated API handlers and per-user Supabase access. Add the owner-only schema boundary, membership restrictions, and approved record capabilities at the database and API layers. Preserve current validation, history, relationships, and phone policy.

### C. Deploy hosted UI, Storage, and Realtime

Keep the existing Vite UI, add login/session/logout/invite flows, configure workspace/deep-link routing, replace disk-backed attachment handling and record-link resolution, and remove local status/update assumptions. Verify public hosting cannot expose a shared desktop session or private data.

### D. Add authenticated Surface MCP and optional thin CLI

Configure OAuth/consent/discovery, expose member and owner operations through the shared authorization layer, verify connection/revocation from the actual intended agent clients, and update canonical/generated agent instructions to the cloud workflow.

### E. Verify an isolated deployment

Acceptance must include:

- The app works with every user's local Surface server stopped and no CLI installed.
- Two independently authenticated browsers see accepted changes without silent overwrites.
- Members can read/create/update records and relationship values, including via MCP.
- Members cannot add/rename/delete tables or fields, change relationship definitions, change SQL functions, promote themselves, or bypass restrictions through direct REST/RPC or guessed MCP calls.
- Anonymous users, viewers, expired/revoked access, wrong-workspace IDs, and changed membership are denied appropriately.
- Owners can perform approved schema operations and access management; normal requests still do not carry administrative database keys.
- Phone ordering, unknown-field rejection, validation, revision history, and current inverse relationships remain correct.
- Upload/download authorization, durable attachment references, reconnect behavior, and honest unsaved/offline indicators work.
- Preview deployments do not mutate production.

### F. Cut over once, then remove obsolete production paths

Briefly pause legacy writers, complete final reconciliation/uploads, verify records/relationships/history/attachments, switch users and agents to the hosted URL/API/MCP, stop and disable local background services, and mark old checkouts as archived snapshots. Retain verified read-only backups until cutover and restore checks are accepted.

Do not keep two writable architectures indefinitely. Remove the obsolete production local database/sync/server paths after acceptance; development/testing databases are not production user replicas. Roll back a faulty app to a compatible hosted deployment rather than restarting competing local writers or blindly reversing database migrations.

## Implementation prerequisites and unresolved defaults

- Confirm Vercel project/domain, Supabase Auth settings, intended agent clients, OAuth consent/client registration policy, and deployment identity through authorized tooling; do not request secrets in chat.
- Inventory actual memberships, legacy admin roles, sensitive fields, local-only workspaces/history, and attachments before applying permission/data migrations.
- Record deletion and shared-configuration rights are owner-only planning defaults. Finalize them before implementation grants additional rights; member read/create/update and owner-only schema control are the confirmed requirements.
- This is a saved plan, not authorization to execute hosting, permission, or data changes now.

## References

- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase OAuth 2.1 server](https://supabase.com/docs/guides/auth/oauth-server)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
