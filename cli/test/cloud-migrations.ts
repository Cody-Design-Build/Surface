// Isolated Management API contract regressions backed by real PostgreSQL (PGlite).
// No live network, administrator credentials, or existing Surface files are used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-cloud-migrations-"));
const envKeys = ["SURFACE_CONFIG_DIR", "SURFACE_DATA_DIR", "SURFACE_STORE", "SURFACE_LOG_FILE", "SURFACE_SYNC", "SURFACE_SUPABASE_URL", "SURFACE_PUBLISHABLE_KEY", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"];
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const token = "sbp_test_administrator_secret_never_print";
const publishableKey = "sb_publishable_test_not_administrator";
const serviceKey = "sb_secret_test_not_an_access_token";
const projectRef = "abcdefghijklmnopqrst";
const cloudUrl = `https://${projectRef}.supabase.co`;
Object.assign(process.env, {
  SURFACE_CONFIG_DIR: path.join(tmp, "config"), SURFACE_DATA_DIR: path.join(tmp, "data"),
  SURFACE_STORE: "local", SURFACE_LOG_FILE: "off", SURFACE_SYNC: "off", SUPABASE_ACCESS_TOKEN: token,
});
delete process.env.SURFACE_SUPABASE_URL;
delete process.env.SURFACE_PUBLISHABLE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Live network is forbidden in cloud migration tests"); };
// These modules capture config paths, so import only after selecting isolated directories.
const { saveCloudConfig, CLOUD_FILE } = await import("../src/config.ts");
const { migrateCloud } = await import("../src/cloud-migrations.ts");
const { MIGRATIONS_DIR } = await import("../src/local.ts");
const connect = (url = cloudUrl) => saveCloudConfig({ url, publishableKey });
connect();

const baseline = "create table public.migration_probe (id integer primary key, note text not null);\ninsert into public.migration_probe values (1, 'manually installed baseline');\n";
const upgrade = "alter table public.migration_probe add column upgraded boolean not null default true;\ninsert into public.migration_probe(id,note) values (2, 'applied once');\n";
const later = "do $fixture$ begin insert into public.migration_probe(id,note) values (3, 'BEGIN inside a function is not a transaction control'); end $fixture$;\n";
const names = ["0001_baseline.sql", "0002_upgrade.sql", "0003_later.sql"];
let fixtureNumber = 0;
function directory(files: Record<string, string> = { [names[0]]: baseline, [names[1]]: upgrade }) {
  const dir = path.join(tmp, `migrations-${++fixtureNumber}`);
  fs.mkdirSync(dir);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return dir;
}
const checksum = (source: string) => createHash("sha256").update(source).digest("hex");
type Request = { query: string; read_only?: boolean };
type Hook = (request: Request) => Promise<void>;

async function fixture(run: (f: {
  db: PGlite; fetch: typeof fetch; requests: Request[];
  beforeApply: (hook: Hook | null) => void; loseApplyReply: () => void;
}) => Promise<void>, installBaseline = true) {
  const db = new PGlite();
  const requests: Request[] = [];
  let beforeApply: Hook | null = null;
  let loseReply = false;
  const transport: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://api.supabase.com/v1/projects/${projectRef}/database/query`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error", "admin credentials must not follow redirects");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.match(headers.get("content-type") ?? "", /application\/json/);
    assert.equal(headers.get("apikey"), null, "publishable credentials do not authorize migrations");
    const request = JSON.parse(String(init?.body)) as Request;
    assert.equal(typeof request.query, "string");
    assert.ok(!String(init?.body).includes(token));
    requests.push(request);
    if (request.read_only !== true && beforeApply) await beforeApply(request);
    try {
      // Execute the exact SQL, including DO blocks, locks, and DDL. Read-only discovery
      // also runs in an engine-enforced read-only transaction, not a response stub.
      const rows = await db.transaction(async tx => {
        if (request.read_only === true) await tx.exec("set transaction read only");
        const results = await tx.exec(request.query);
        return results.at(-1)?.rows ?? [];
      });
      if (request.read_only !== true && loseReply) {
        loseReply = false;
        throw new Error(`acknowledgement lost after commit: ${token}`);
      }
      return Response.json(rows, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("acknowledgement lost")) throw error;
      return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  };
  try {
    await db.exec("create role authenticated nologin; create role anon nologin; create role service_role nologin;");
    if (installBaseline) await db.exec(baseline);
    await run({ db, fetch: transport, requests, beforeApply: hook => { beforeApply = hook; }, loseApplyReply: () => { loseReply = true; } });
  } finally {
    await db.close();
  }
}
async function rows<T = Record<string, unknown>>(db: PGlite, query: string) { return (await db.query<T>(query)).rows; }
async function ledgerExists(db: PGlite) { return (await rows<{ present: boolean }>(db, "select to_regclass('surface_migrations.history') is not null as present"))[0].present; }
async function history(db: PGlite) { return rows<{ version: number; name: string; checksum: string }>(db, "select version,name,checksum from surface_migrations.history order by version"); }
async function rejectsRedacted(action: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    for (const secret of [token, publishableKey, serviceKey]) assert.ok(!error.message.includes(secret), "errors must not disclose credentials");
    return true;
  });
}
let step = 0;
const ok = (name: string) => console.log(`ok ${++step} ${name}`);

try {
  const dir = directory();
  let calls = 0;
  const noTransport: typeof fetch = async () => { calls++; throw new Error("invalid input reached transport"); };
  for (const since of [undefined, 0, -1, 1.5, NaN, Infinity, 3, "2"]) {
    await rejectsRedacted(migrateCloud({ since: since as number, check: true }, noTransport, dir), /since|baseline|migration/i);
  }
  assert.equal(calls, 0, "an explicit existing bundled migration number is required before contacting an administrator API");
  ok("since is required, positive, integral, and present in the bundled files");

  await fixture(async f => {
    const result = await migrateCloud({ since: 2, check: true }, f.fetch, dir);
    assert.deepEqual(result, { projectRef, planned: [names[1]], applied: [] });
    assert.ok(f.requests.length > 0);
    assert.ok(f.requests.every(request => request.read_only === true));
    assert.equal(await ledgerExists(f.db), false);
    assert.deepEqual(await rows(f.db, "select * from public.migration_probe"), [{ id: 1, note: "manually installed baseline" }]);
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from information_schema.columns where table_name='migration_probe' and column_name='upgraded'"))[0].n, 0);
  });
  ok("check uses real read-only queries and creates neither ledger nor schema changes");

  await fixture(async f => {
    assert.deepEqual(await migrateCloud({ since: 2 }, f.fetch, dir), { projectRef, planned: [names[1]], applied: [names[1]] });
    assert.deepEqual(await history(f.db), [{ version: 2, name: names[1], checksum: checksum(upgrade) }]);
    assert.deepEqual(await rows(f.db, "select id,upgraded from public.migration_probe order by id"), [{ id: 1, upgraded: true }, { id: 2, upgraded: true }]);
    assert.deepEqual(await migrateCloud({ since: 2 }, f.fetch, dir), { projectRef, planned: [], applied: [] });
    assert.deepEqual(await migrateCloud({ since: 2, check: true }, f.fetch, dir), { projectRef, planned: [], applied: [] });
    assert.equal((await history(f.db)).length, 1, "explicit baseline does not fabricate old migration history");
    await f.db.exec("create role migration_public_client nologin");
    const privileges = await rows<{ schema_usage: boolean; table_select: boolean; table_insert: boolean }>(f.db, "select has_schema_privilege('migration_public_client','surface_migrations','usage') schema_usage, has_table_privilege('migration_public_client','surface_migrations.history','select') table_select, has_table_privilege('migration_public_client','surface_migrations.history','insert') table_insert");
    assert.deepEqual(privileges, [{ schema_usage: false, table_select: false, table_insert: false }]);
  });
  ok("apply records exact source checksums, skips the real baseline, reruns safely, and keeps the ledger private");

  await fixture(async f => {
    assert.deepEqual((await migrateCloud({ since: 1 }, f.fetch, dir)).applied, names.slice(0, 2));
    assert.deepEqual((await history(f.db)).map(row => row.version), [1, 2]);
  }, false);
  ok("since 1 genuinely installs the full schema rather than treating migration 1 as already installed");

  await fixture(async f => {
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, dir), /migration|relation|exist|rerun|check/i);
    assert.equal(await ledgerExists(f.db), false);
    assert.equal((await rows<{ missing: boolean }>(f.db, "select to_regclass('public.migration_probe') is null missing"))[0].missing, true);
  }, false);
  ok("declaring a nonexistent baseline does not invent the earlier schema or its history");

  await fixture(async f => {
    await migrateCloud({ since: 2 }, f.fetch, dir);
    for (const changed of [
      directory({ [names[0]]: baseline, [names[1]]: `${upgrade}-- exact bytes changed\n` }),
      directory({ [names[0]]: baseline, "0002_renamed.sql": upgrade }),
    ]) {
      const writes = f.requests.filter(request => request.read_only !== true).length;
      for (const check of [true, false]) await rejectsRedacted(migrateCloud({ since: 2, check }, f.fetch, changed), /checksum|name|changed|drift|mismatch/i);
      assert.equal(f.requests.filter(request => request.read_only !== true).length, writes);
    }
    await f.db.exec("insert into surface_migrations.history(version,name,checksum) values (99,'0099_future.sql','future')");
    for (const check of [true, false]) await rejectsRedacted(migrateCloud({ since: 2, check }, f.fetch, dir), /ahead|newer|unknown|bundled|version|migration/i);
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.migration_probe"))[0].n, 2);
  });
  ok("stored checksum/name drift and a ledger ahead of the installation are refused in check and apply");

  const duplicate = directory({ [names[0]]: baseline, [names[1]]: upgrade, "0002_duplicate.sql": later });
  calls = 0;
  await rejectsRedacted(migrateCloud({ since: 2 }, noTransport, duplicate), /duplicate|version/i);
  assert.equal(calls, 0);
  ok("duplicate local migration versions are refused before any administrator request");

  await fixture(async f => {
    const broken = directory({ [names[0]]: baseline, [names[1]]: upgrade,
      [names[2]]: "create table public.should_rollback(id int); insert into public.migration_probe(id,note) values(3,'must roll back'); select 1/0;\n" });
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, broken), /zero|migration|failed|rerun|check/i);
    assert.equal(await ledgerExists(f.db), false, "ledger creation and earlier entries roll back with failed later DDL");
    assert.deepEqual(await rows(f.db, "select * from public.migration_probe"), [{ id: 1, note: "manually installed baseline" }]);
    assert.equal((await rows<{ missing: boolean }>(f.db, "select to_regclass('public.should_rollback') is null missing"))[0].missing, true);
    await migrateCloud({ since: 2 }, f.fetch, dir);
    const committedHistory = await history(f.db);
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, broken), /zero|migration|failed|rerun|check/i);
    assert.deepEqual(await history(f.db), committedHistory, "a failed upgrade also preserves an existing ledger exactly");
    assert.deepEqual((await rows<{ id: number }>(f.db, "select id from public.migration_probe order by id")).map(row => row.id), [1, 2]);
    assert.equal((await rows<{ missing: boolean }>(f.db, "select to_regclass('public.should_rollback') is null missing"))[0].missing, true);
  });
  ok("failure in a later migration rolls back earlier source changes and every ledger change atomically");

  await fixture(async f => {
    const nested = directory({ [names[0]]: baseline, [names[1]]: "begin; insert into public.migration_probe values (2,'escape'); commit;" });
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, nested), /transaction|begin|commit|migration/i);
    assert.equal(await ledgerExists(f.db), false);
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.migration_probe"))[0].n, 1);
  });
  ok("source transaction controls cannot escape migration atomicity");

  await fixture(async f => {
    const extended = directory({ [names[0]]: baseline, [names[1]]: upgrade, [names[2]]: later });
    let reached = 0;
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    f.beforeApply(async () => { if (++reached === 2) release(); await barrier; });
    const results = await Promise.all([
      migrateCloud({ since: 2 }, f.fetch, extended),
      migrateCloud({ since: 2 }, f.fetch, extended),
    ]);
    assert.deepEqual(results.flatMap(result => result.applied).sort(), names.slice(1));
    assert.deepEqual((await history(f.db)).map(row => row.version), [2, 3]);
    assert.deepEqual((await rows<{ id: number }>(f.db, "select id from public.migration_probe order by id")).map(row => row.id), [1, 2, 3]);
  });
  ok("overlapping deployments with stale preflight plans apply each source only once");

  await fixture(async f => {
    await migrateCloud({ since: 2 }, f.fetch, dir);
    const extended = directory({ [names[0]]: baseline, [names[1]]: upgrade, [names[2]]: later });
    f.beforeApply(async () => {
      f.beforeApply(null);
      await f.db.exec("update surface_migrations.history set checksum='changed-after-preflight' where version=2");
    });
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, extended), /checksum|changed|drift|mismatch|migration|rerun|check/i);
    assert.deepEqual((await rows<{ id: number }>(f.db, "select id from public.migration_probe order by id")).map(row => row.id), [1, 2]);
    assert.deepEqual((await history(f.db)).map(row => row.version), [2]);
  });
  ok("ledger integrity is rechecked inside the locked apply, not just during preflight");

  for (const url of [
    "http://abcdefghijklmnopqrst.supabase.co", "https://localhost", "https://evil.example",
    "https://abcdefghijklmnopqrst.supabase.co.evil.example", "https://abcdefghijklmno12345.supabase.co",
    "https://user:password@abcdefghijklmnopqrst.supabase.co", `${cloudUrl}/rest/v1`, `${cloudUrl}?token=x`, `${cloudUrl}#fragment`,
  ]) {
    connect(url);
    calls = 0;
    await rejectsRedacted(migrateCloud({ since: 2 }, noTransport, dir), /url|project|host|https|supabase/i);
    assert.equal(calls, 0, "administrator tokens never go to untrusted project URLs");
  }
  connect();
  delete process.env.SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  calls = 0;
  await rejectsRedacted(migrateCloud({ since: 2, check: true }, noTransport, dir), /SUPABASE_ACCESS_TOKEN|administrator|access token/i);
  assert.equal(calls, 0, "a publishable key or service role key is not a Management API access token");
  process.env.SUPABASE_ACCESS_TOKEN = token;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  ok("hosted project validation and administrator token boundaries reject unsafe destinations and credential substitution");

  for (const status of [401, 403]) {
    let attempts = 0;
    const forbidden: typeof fetch = async () => {
      attempts++;
      return Response.json({ message: `denied ${token} ${publishableKey} ${serviceKey}` }, { status });
    };
    await rejectsRedacted(migrateCloud({ since: 2 }, forbidden, dir), /401|403|access|authoriz|permission|administrator|denied/i);
    assert.equal(attempts, 1);
  }
  ok("401/403 are actionable, redacted, and not retried");

  await fixture(async f => {
    f.loseApplyReply();
    await rejectsRedacted(migrateCloud({ since: 2 }, f.fetch, dir), /rerun|re-run|check/i);
    assert.equal(f.requests.filter(request => request.read_only !== true).length, 1, "ambiguous committed writes are never automatically retried");
    assert.deepEqual((await history(f.db)).map(row => row.version), [2]);
    assert.deepEqual(await migrateCloud({ since: 2, check: true }, f.fetch, dir), { projectRef, planned: [], applied: [] });
    assert.deepEqual(await migrateCloud({ since: 2 }, f.fetch, dir), { projectRef, planned: [], applied: [] });
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.migration_probe"))[0].n, 2);
  });
  ok("a lost apply response is redacted without retry; explicit check and manual rerun safely discover the commit");

  await fixture(async f => {
    // The same minimal Supabase auth facilities used by the existing local-store shim.
    await f.db.exec(`
      create schema auth;
      create table auth.users(id uuid primary key, email text, created_at timestamptz not null default now());
      create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      create function auth.jwt() returns jsonb language sql stable as $f$ select jsonb_build_object('sub',auth.uid(),'email',(select email from auth.users where id=auth.uid())) $f$;
      grant usage on schema auth to authenticated; grant select on auth.users to authenticated;
      grant execute on function auth.uid(),auth.jwt() to authenticated;
    `);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files.filter(name => Number(name.slice(0, 4)) < 7)) {
      await f.db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
    }
    assert.equal((await rows<{ missing: boolean }>(f.db, "select to_regprocedure('public.surface_schema_version()') is null missing"))[0].missing, true);
    const planned = files.filter(name => Number(name.slice(0, 4)) >= 7);
    assert.deepEqual((await migrateCloud({ since: 7, check: true }, f.fetch)).planned, planned);
    assert.equal(await ledgerExists(f.db), false);
    assert.deepEqual((await migrateCloud({ since: 7 }, f.fetch)).applied, planned);
    assert.ok((await rows<{ version: number }>(f.db, "select public.surface_schema_version() version"))[0].version >= 7);
    await f.db.exec("set role authenticated");
    assert.ok((await rows<{ version: number }>(f.db, "select public.surface_schema_version() version"))[0].version >= 7);
    await f.db.exec("reset role");
    assert.deepEqual((await history(f.db)).map(row => row.version), files.filter(name => Number(name.slice(0, 4)) >= 7).map(name => Number(name.slice(0, 4))));
    assert.deepEqual((await migrateCloud({ since: 7 }, f.fetch)).applied, []);
  }, false);
  ok("the bundled inverse-relationship migration upgrades actual 0001–0006 PostgreSQL schema and exposes capability 7");

  for (const partial of [true, false]) await fixture(async f => {
    await f.db.exec(`
      create schema auth;
      create table auth.users(id uuid primary key, email text, created_at timestamptz not null default now());
      create function auth.uid() returns uuid language sql stable as $f$ select '00000000-0000-0000-0000-000000000001'::uuid $f$;
      create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
      insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000001','repair@example.test');
      grant usage on schema auth to authenticated;
      grant select on auth.users to authenticated;
      grant execute on function auth.uid(),auth.jwt() to authenticated;
    `);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    const apply = async (version: number) => {
      const name = files.find(name => Number(name.slice(0, 4)) === version)!;
      await f.db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
    };
    for (let version = 1; version <= (partial ? 5 : 6); version++) await apply(version);
    const forward = { id: "f8000001", key: "organizations", kind: "link", target: "repairorg", multiple: true };
    const obsolete = { id: "f8000002", key: "organization_name", kind: "text" };
    const schema = JSON.stringify([forward, obsolete]);
    await f.db.query("insert into public.workspaces(id,name) values('repairws','Repair regression')");
    await f.db.query("insert into public.members(workspace_id,user_id,role) values('repairws','00000000-0000-0000-0000-000000000001','owner')");
    await f.db.query("insert into public.types(id,workspace_id,key,name) values('repairorg','repairws','organization','Organization')");
    await f.db.query("insert into public.types(id,workspace_id,key,name,fields) values('repaircontact','repairws','contact','Contact',$1::jsonb)", [schema]);
    await f.db.exec(`
      insert into public.records(id,workspace_id,type_id,title,fields) values('repairorgrow','repairws','repairorg','Acme','{}');
      insert into public.records(id,workspace_id,type_id,title,fields,body)
        values('repairalice','repairws','repaircontact','Alice','{"f8000001":["repairorgrow"],"f8000002":"Acme"}','[[id:repairorgrow]]');
      insert into public.records(id,workspace_id,type_id,title,fields) values('repairbob','repairws','repaircontact','Bob','{}');
    `);
    if (!partial) await f.db.exec("update public.records set aliases=array['Existing alias'] where id='repairalice'");
    await assert.rejects(apply(8), /requires 0007/);
    await apply(7);
    const removeField = () => f.db.query("update public.types set fields=$1::jsonb where id='repaircontact'", [JSON.stringify([forward])]);
    if (partial) {
      assert.equal((await rows<{ missing: boolean }>(f.db, "select not exists(select 1 from information_schema.columns where table_schema='public' and table_name='records' and column_name='aliases') missing"))[0].missing, true);
      await assert.rejects(removeField(), /record "new" has no field "aliases"/);
    }
    const before = await rows(f.db, "select id,title,fields,body from public.records order by id");
    assert.deepEqual((await migrateCloud({ since: 8 }, f.fetch)).applied, files.filter(name => Number(name.slice(0, 4)) >= 8));
    assert.deepEqual(await rows(f.db, "select id,title,fields,body from public.records order by id"), before);
    assert.deepEqual((await rows<{ aliases: string[] }>(f.db, "select aliases from public.records where id='repairalice'"))[0].aliases, partial ? [] : ["Existing alias"]);
    await removeField();
    assert.deepEqual((await rows<{ fields: unknown }>(f.db, "select fields from public.records where id='repairalice'"))[0].fields, { f8000001: ["repairorgrow"] });
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.records"))[0].n, 3);
    assert.deepEqual(await rows(f.db, "select field_id,target_id from public.links where source_id='repairalice' order by field_id"), [
      { field_id: "body", target_id: "repairorgrow" }, { field_id: "f8000001", target_id: "repairorgrow" },
    ]);
    const inverse = { id: "f8000003", key: "contacts", kind: "link", target: "repaircontact", multiple: true, inverse: forward.id };
    await f.db.query("update public.types set fields=$1::jsonb where id='repairorg'", [JSON.stringify([inverse])]);
    await f.db.exec(`
      select public.push_record('repairws','repairorgrow',(select rev from public.records where id='repairorgrow'),
        'organization','Acme','{"contacts":["repairalice","repairbob","repairbob"]}','',null,null,array['Company']);
    `);
    assert.deepEqual((await rows<{ fields: unknown }>(f.db, "select fields from public.records where id='repairbob'"))[0].fields, { f8000001: ["repairorgrow"] });
    assert.deepEqual((await rows<{ fields: unknown }>(f.db, "select fields from public.records where id='repairorgrow'"))[0].fields, {});
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.links where field_id='f8000001'"))[0].n, 2);
    assert.equal((await rows<{ n: number }>(f.db, "select count(*)::int n from public.history where fields ? 'f8000003'"))[0].n, 0);
    assert.deepEqual((await rows<{ aliases: string[] }>(f.db, "select aliases from public.history where record_id='repairorgrow' order by rev desc limit 1"))[0].aliases, ["Company"]);
    assert.equal((await rows<{ absent: boolean }>(f.db, "select to_regprocedure('public.push_record(text,text,integer,text,text,jsonb,text,text,text)') is null absent"))[0].absent, true);
    assert.ok((await rows<{ version: number }>(f.db, "select public.surface_schema_version() version"))[0].version >= 7);
  }, false);
  ok("0008 alone repairs missing 0006 prerequisites and preserves normal upgrades, field cleanup, canonical inverse writes, aliases history and body links");

  assert.ok(!fs.readFileSync(CLOUD_FILE, "utf8").includes(token), "administrator credentials are never persisted in cloud config");
  console.log(`${step} cloud migration regressions passed`);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
