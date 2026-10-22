// Explicit administrator-only deployment. Publishable keys and Surface login sessions are
// never used here; the Supabase Management API (currently Beta) requires an operator's PAT.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cloudConfig } from "./config.ts";
import { UserError } from "./client.ts";
import { MIGRATIONS_DIR } from "./local.ts";

type Migration = { version: number; name: string; checksum: string; source: string };
type History = { version: number; name: string; checksum: string; applied_at?: string };

const HISTORY_SQL = "select version, name, checksum, applied_at from surface_migrations.history order by version";
const MAX_VERSION = 2_147_483_647;

function migrations(directory: string): Migration[] {
  const files = fs.readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name));
  const seen = new Set<number>();
  return files.map((name) => {
    const version = Number(name.slice(0, name.indexOf("_")));
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION)
      throw new UserError(`Invalid bundled migration version: ${name}.`);
    if (seen.has(version)) throw new UserError(`Duplicate bundled migration version ${version}. Remove the duplicate before deploying.`);
    seen.add(version);
    const source = fs.readFileSync(path.join(directory, name));
    return { version, name, checksum: createHash("sha256").update(source).digest("hex"), source: source.toString("utf8") };
  }).sort((a, b) => a.version - b.version);
}

function historyRows(value: unknown): History[] {
  if (!Array.isArray(value)) throw new UserError("Supabase returned an invalid Surface migration ledger. Inspect surface_migrations.history before deploying.");
  const seen = new Set<number>();
  for (const row of value) {
    if (!row || typeof row !== "object" || !Number.isInteger(row.version) || row.version < 1 || row.version > MAX_VERSION ||
        typeof row.name !== "string" || typeof row.checksum !== "string" || seen.has(row.version))
      throw new UserError("The Surface migration ledger is malformed. Inspect surface_migrations.history before deploying.");
    seen.add(row.version);
  }
  return value as History[];
}

function pending(files: Migration[], history: History[], since: number): Migration[] {
  const local = new Map(files.map((file) => [file.version, file]));
  const installed = new Set<number>();
  for (const row of history) {
    const file = local.get(row.version);
    if (!file) throw new UserError("The cloud migration ledger is ahead of, or unknown to, this Surface installation. Update Surface before deploying.");
    if (row.name !== file.name || row.checksum !== file.checksum)
      throw new UserError(`Cloud migration checksum/name drift for ${file.name}. Restore the original migration file; do not rewrite the ledger to hide changes.`);
    installed.add(row.version);
  }
  const plan = files.filter((file) => file.version >= since && !installed.has(file.version));
  if (plan.some((file) => history.some((row) => row.version > file.version)))
    throw new UserError("The cloud migration ledger has a gap after --since. Use the original already-installed baseline and inspect surface_migrations.history before deploying.");
  return plan;
}

function literal(value: string): string {
  return "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
}

function dollar(value: string, label: string): string {
  let tag = `$${label}$`;
  while (value.includes(tag)) tag = tag.slice(0, -1) + "_$";
  return tag + value + tag;
}

function deploymentSql(files: Migration[], since: number): string {
  const bundled = files.map((file) => `(${file.version}, ${literal(file.name)}, ${literal(file.checksum)})`).join(",\n      ");
  const changes = files.filter((file) => file.version >= since).map((file) => `
  if not exists (select 1 from surface_migrations.history where version = ${file.version}) then
    current_version := ${file.version};
    execute ${dollar(file.source, `surface_sql_${file.version}`)};
    insert into surface_migrations.history(version, name, checksum)
      values (${file.version}, ${literal(file.name)}, ${literal(file.checksum)});
    applied := applied || jsonb_build_array(${literal(file.name)});
    current_version := null;
  end if;`).join("\n");
  // Dynamic EXECUTE runs inside this atomic block (including its exception subtransaction).
  // Source COMMIT/ROLLBACK, including nested DO transaction controls, cannot escape it.
  const body = `
declare
  bad_version integer;
  current_version integer;
  applied jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(1937076838, 1835624306);
  create schema if not exists surface_migrations;
  revoke all on schema surface_migrations from public, anon, authenticated, service_role;
  create table if not exists surface_migrations.history (
    version integer primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now()
  );
  revoke all on table surface_migrations.history from public, anon, authenticated, service_role;

  select h.version into bad_version from surface_migrations.history h
    left join (values ${bundled}) as bundled(version, name, checksum) using (version)
    where bundled.version is null limit 1;
  if found then raise exception 'surface_migration_ahead:%', bad_version; end if;

  select h.version into bad_version from surface_migrations.history h
    join (values ${bundled}) as bundled(version, name, checksum) using (version)
    where h.name is distinct from bundled.name or h.checksum is distinct from bundled.checksum limit 1;
  if found then raise exception 'surface_migration_drift:%', bad_version; end if;

  select bundled.version into bad_version
    from (values ${bundled}) as bundled(version, name, checksum)
    where bundled.version >= ${since}
      and not exists (select 1 from surface_migrations.history h where h.version = bundled.version)
      and exists (select 1 from surface_migrations.history h where h.version > bundled.version)
    limit 1;
  if found then raise exception 'surface_migration_gap:%', bad_version; end if;
${changes}
  perform set_config('surface_migrations.applied', applied::text, true);
  if jsonb_array_length(applied) > 0 then perform pg_notify('pgrst', 'reload schema'); end if;
exception when others then
  if current_version is not null then
    raise exception using message = format('surface_migration_failed:%s:%s', current_version, sqlstate), errcode = sqlstate;
  end if;
  raise;
end
`;
  // postgres-meta returns the last nonempty rowset. Keep the result in this same query/
  // transaction, not a later pooled session, so concurrent deployers report their own work.
  return `do ${dollar(body, "surface_deploy")};
select current_setting('surface_migrations.applied')::jsonb as applied,
  (select coalesce(jsonb_agg(h order by h.version), '[]'::jsonb) from surface_migrations.history h) as history;`;
}

/** `since` declares migrations below that number already installed; 1 means a fresh project. */
export async function migrateCloud(
  options: { since: number; check?: boolean },
  fetchImpl: typeof fetch = globalThis.fetch,
  directory: string = MIGRATIONS_DIR,
): Promise<{ projectRef: string; planned: string[]; applied: string[] }> {
  const config = cloudConfig();
  if (!config) throw new UserError("Connect the intended cloud first: surface cloud connect <project url> <publishable key>.");
  const projectRef = /^https:\/\/([a-z]{20})\.supabase\.co$/.exec(config.url)?.[1];
  if (!projectRef)
    throw new UserError("Cloud migrations require a hosted project URL exactly https://<20-letter-ref>.supabase.co, without credentials, port, path, query or fragment. Reconnect the intended project.");
  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token)
    throw new UserError("Cloud migrations require an administrator's SUPABASE_ACCESS_TOKEN environment variable (a Supabase personal access token authorized for this project). Surface login and publishable keys cannot deploy schema changes.");
  const files = migrations(directory);
  if (!Number.isInteger(options.since) || options.since < 1 || !files.some((file) => file.version === options.since))
    throw new UserError("--since must be a positive bundled migration number: it explicitly declares all earlier migrations already installed (use --since 1 only for a new project).");

  const rerun = `Run surface cloud migrate --since ${options.since} --check, then rerun the same apply command if needed; matching ledger entries are never repeated. No automatic retry was attempted.`;
  const unknownApply = () => new UserError(`The cloud migration apply result is unknown; the server may have committed. ${rerun}`);
  async function query(sql: string, readOnly: boolean): Promise<Record<string, unknown>[]> {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql, read_only: readOnly }),
      });
    } catch {
      if (!readOnly) throw unknownApply();
      throw new UserError("Couldn't reach the Supabase Management API. Check your network and administrator access, then rerun the read-only check. No changes were sent.");
    }
    if (response.status === 401 || response.status === 403)
      throw new UserError(`Supabase rejected administrator access (HTTP ${response.status}). Set SUPABASE_ACCESS_TOKEN to a personal access token authorized for this project; Surface login, publishable keys and service-role keys are not administrator credentials.`);
    let data: unknown;
    try { data = await response.json(); }
    catch {
      if (!readOnly) throw unknownApply();
      throw new UserError("Supabase returned an unreadable migration-check response. Check the project's status and rerun; no changes were sent.");
    }
    if (!response.ok) {
      // Never print an upstream response, SQL context, headers or a fetch exception: they
      // can echo credentials/data. Only recognize our own bounded, non-secret markers.
      const message = typeof data === "string" ? data : JSON.stringify(data) ?? "";
      const failed = /surface_migration_failed:(\d+):([0-9A-Z]{5})/.exec(message);
      if (failed) {
        const file = files.find((file) => file.version === Number(failed[1]));
        if (file) throw new UserError(`Cloud migration ${file.name} failed (PostgreSQL ${failed[2]}). All source changes and ledger entries in this deployment rolled back. Inspect that migration and the project database logs, confirm --since, then rerun.`);
      }
      if (/surface_migration_drift:\d+/.test(message))
        throw new UserError("Cloud migration checksum/name drift detected under the deployment lock. No deployment changes committed. Restore the original migration files and inspect surface_migrations.history.");
      if (/surface_migration_ahead:\d+/.test(message))
        throw new UserError("The cloud migration ledger is ahead of this Surface installation. No deployment changes committed. Update Surface before deploying.");
      if (/surface_migration_gap:\d+/.test(message))
        throw new UserError("The cloud migration ledger has a gap after --since. No deployment changes committed. Use the original already-installed baseline and inspect surface_migrations.history.");
      if (!readOnly) throw unknownApply();
      throw new UserError(`Supabase couldn't read the Surface migration ledger (HTTP ${response.status}). Check administrator permissions and the project database logs; no changes were sent.`);
    }
    if (!Array.isArray(data) || !data.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      if (!readOnly) throw unknownApply();
      throw new UserError("Supabase returned an invalid migration-check response. Inspect the project database logs; no changes were sent.");
    }
    return data as Record<string, unknown>[];
  }

  const probe = await query("select to_regclass('surface_migrations.history') is not null as present", true);
  if (probe.length !== 1 || typeof probe[0].present !== "boolean")
    throw new UserError("Supabase returned an invalid migration-ledger discovery response. No changes were sent.");
  const before = probe[0].present ? historyRows(await query(HISTORY_SQL, true)) : [];
  const planned = pending(files, before, options.since).map((file) => file.name);
  if (options.check) return { projectRef, planned, applied: [] };

  const result = await query(deploymentSql(files, options.since), false);
  if (result.length !== 1 || !Array.isArray(result[0].applied) ||
      !result[0].applied.every((name) => typeof name === "string" && planned.includes(name)) ||
      new Set(result[0].applied).size !== result[0].applied.length)
    throw unknownApply();
  try {
    if (pending(files, historyRows(result[0].history), options.since).length) throw unknownApply();
  } catch {
    throw new UserError(`The apply response did not verify the expected immutable migration ledger. ${rerun}`);
  }
  return { projectRef, planned, applied: result[0].applied as string[] };
}
