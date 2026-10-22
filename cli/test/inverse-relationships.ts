// Isolated real database regressions. Run: node --no-warnings test/inverse-relationships.ts
// Uses normal authenticated writes, including the local migration loader; never a live store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-inverse-"));
Object.assign(process.env, {
  SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(tmp, "config"),
  SURFACE_DATA_DIR: path.join(tmp, "data"), SURFACE_LOG_FILE: "off", SURFACE_SYNC: "off",
});
delete process.env.SURFACE_SUPABASE_URL;
delete process.env.SURFACE_PUBLISHABLE_KEY;
// The local module captures config paths at load time; load only after isolation.
const local = await import("../src/local.ts");
type Row = { id: string; rev: number; type_id: string; title: string; fields: Record<string, unknown>; body: string; aliases: string[]; parent_id: string | null; deleted_at: string | null };
const query = <T = any>(sql: string, params: unknown[] = []) => local.localAdmin(async tx => {
  await tx.exec("set local role authenticated");
  return (await tx.query<T>(sql, params)).rows;
});
const one = async <T = any>(sql: string, params: unknown[] = []) => (await query<T>(sql, params))[0];
const row = (id: string) => one<Row>("select * from public.records where id=$1", [id]);
const orgType = "inverse_org_type", contactType = "inverse_contact_type";
const organizations = "f9000001", contacts = "f9000002", note = "f9000003";
let ws: string;
const push = (type: string, id: string | null, rev: number | null, title: string, fields: Record<string, unknown>, body = "", parent: string | null = null, aliases: string[] | null = null) =>
  one<Row>("select * from public.push_record($1,$2,$3,$4,$5,$6::jsonb,$7,null,$8,$9::text[])",
    [ws, id, rev, type, title, JSON.stringify(fields), body, parent, aliases]);
const saveOrg = async (id: string, fields: Record<string, unknown>, rev?: number | null) => {
  const current = await row(id);
  return push(orgType, id, rev === undefined ? current.rev : rev, current.title, fields, current.body);
};
const saveContact = async (id: string, ids: string[]) => {
  const current = await row(id);
  return push(contactType, id, current.rev, current.title, { organizations: ids }, current.body);
};
const inverse = async (id: string, field = organizations, type = contactType) => (await query<{ id: string }>(
  `select r.id from public.links l join public.records r on r.id=l.source_id
    where l.workspace_id=$1 and l.target_id=$2 and l.field_id=$3 and r.type_id=$4 and r.deleted_at is null order by r.id`,
  [ws, id, field, type])).map(r => r.id);
const reverseDef = { id: contacts, key: "contacts", kind: "link", target: contactType, multiple: true, inverse: organizations };
const noteDef = { id: note, key: "note", kind: "text" };
const orgSchema = (fields: unknown[]) => query("update public.types set fields=$2::jsonb where id=$1", [orgType, JSON.stringify(fields)]);
let step = 0;
const ok = (name: string) => console.log(`ok ${++step} ${name}`);

try {
  const info = await local.localInfo();
  assert.ok(info.migrations.includes("0007_inverse_relationships.sql"));
  const capability = await local.exec({ kind: "rpc", fn: "surface_schema_version", args: {} });
  assert.equal(capability.error, null);
  assert.ok(Number(capability.data) >= 7, "inverse relationship capability is supported");
  ws = (await one("select * from public.create_workspace($1)", ["Inverse regression"])).id;
  await query("insert into public.types(id,workspace_id,key,name) values($1,$2,'organization','Organization')", [orgType, ws]);
  const forward = { id: organizations, key: "organizations", kind: "link", target: orgType, multiple: true };
  await query("insert into public.types(id,workspace_id,key,name,fields) values($1,$2,'contact','Contact',$3::jsonb)", [contactType, ws, JSON.stringify([forward])]);
  let acme = await push(orgType, null, null, "Acme", {});
  const beta = await push(orgType, null, null, "Beta", {});
  const alice = await push(contactType, null, null, "Alice", { organizations: [acme.id] });
  const bob = await push(contactType, null, null, "Bob", {});
  await orgSchema([reverseDef, noteDef]);
  assert.deepEqual(await inverse(acme.id), [alice.id]);
  assert.equal((await row(acme.id)).fields[contacts], undefined);
  ok("local upgrade and capability probe; pre-existing forward links need no backfill");

  acme = await saveOrg(acme.id, { contacts: [alice.id, bob.id, bob.id], note: "Added from organization" });
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  assert.deepEqual((await row(bob.id)).fields[organizations], [acme.id]);
  assert.equal(acme.fields[contacts], undefined);
  assert.equal((await one("select count(*)::int as n from public.links where source_id=$1 and field_id=$2", [acme.id, contacts])).n, 0);
  assert.equal((await one("select count(*)::int as n from public.history where fields ? $1", [contacts])).n, 0);
  ok("reverse add normalizes duplicates, updates only canonical forward links and stores no inverse history");

  acme = await saveOrg(acme.id, { note: "Unrelated edit" });
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  const beforeNoop = acme.rev;
  acme = await saveOrg(acme.id, { note: "Unrelated edit", contacts: [bob.id, alice.id] });
  assert.equal(acme.rev, beforeNoop);
  ok("omitted inverse survives unrelated saves; an unchanged full inverse snapshot is a no-op");

  await saveContact(alice.id, [acme.id, beta.id]);
  acme = await saveOrg(acme.id, { contacts: [bob.id] });
  assert.deepEqual((await row(alice.id)).fields[organizations], [beta.id]);
  assert.deepEqual(await inverse(acme.id), [bob.id]);
  assert.deepEqual(await inverse(beta.id), [alice.id]);
  await saveContact(alice.id, [acme.id, beta.id]);
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  await saveContact(alice.id, [beta.id]);
  assert.deepEqual(await inverse(acme.id), [bob.id]);
  ok("reverse removal preserves other targets; forward additions and removals update both inverse views");

  const stale = await row(acme.id);
  await saveContact(alice.id, [acme.id, beta.id]);
  assert.ok((await row(acme.id)).rev > stale.rev);
  await assert.rejects(saveOrg(acme.id, { contacts: [bob.id] }, stale.rev), /conflict:/);
  await assert.rejects(saveOrg(acme.id, { contacts: [] }, null), /conflict:.*base revision/);
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  ok("forward membership changes invalidate stale reverse replacements, and unguarded inverse writes are refused");

  const beforeUnrelated = await row(acme.id);
  const aliceNow = await row(alice.id);
  await push(contactType, alice.id, aliceNow.rev, "Alice renamed", { organizations: [acme.id, beta.id] }, "Unrelated body");
  assert.equal((await row(acme.id)).rev, beforeUnrelated.rev);
  await query("update public.records set deleted_at=now() where id=$1", [alice.id]);
  const afterDelete = await row(acme.id);
  assert.ok(afterDelete.rev > beforeUnrelated.rev);
  assert.deepEqual(await inverse(acme.id), [bob.id]);
  await assert.rejects(saveOrg(acme.id, { contacts: [alice.id, bob.id] }, beforeUnrelated.rev), /missing record|conflict:/);
  await query("update public.records set deleted_at=null where id=$1", [alice.id]);
  assert.ok((await row(acme.id)).rev > afterDelete.rev);
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  const transient = await push(contactType, null, null, "Hard delete", { organizations: [acme.id] });
  const beforeHardDelete = await row(acme.id);
  await query("delete from public.records where id=$1", [transient.id]);
  assert.ok((await row(acme.id)).rev > beforeHardDelete.rev);
  assert.deepEqual(new Set(await inverse(acme.id)), new Set([alice.id, bob.id]));
  ok("source rename is not a relationship change; source soft-delete, restore and hard-delete update inverse membership and revisions");

  const foreignWs = (await one("select * from public.create_workspace($1)", ["Foreign regression"])).id;
  await query("insert into public.types(id,workspace_id,key,name,fields) values('foreign_contact',$1,'contact','Contact','[]')", [foreignWs]);
  const foreignContact = await one<Row>("select * from public.push_record($1,null,null,'contact','Foreign','{}','')", [foreignWs]);
  const orgBeforeInvalid = await row(acme.id);
  const sourcesBeforeInvalid = await query("select id,fields,rev from public.records where type_id=$1 order by id", [contactType]);
  for (const value of [[foreignContact.id], [beta.id], ["missing"], [42], 42, { id: alice.id }]) {
    await assert.rejects(saveOrg(acme.id, { contacts: value }), /invalid_record:/);
  }
  assert.deepEqual(await row(acme.id), orgBeforeInvalid);
  assert.deepEqual(await query("select id,fields,rev from public.records where type_id=$1 order by id", [contactType]), sourcesBeforeInvalid);
  await assert.rejects(saveContact(alice.id, [foreignContact.id]), /invalid_record:/);
  await assert.rejects(query("update public.records set fields=$2::jsonb where id=$1", [acme.id, JSON.stringify({ [contacts]: [alice.id] })]), /computed.*cannot be stored/);
  await assert.rejects(query("update public.records set fields=$2::jsonb where id=$1", [acme.id, JSON.stringify({ [contacts]: null })]), /computed.*cannot be stored/);
  ok("invalid, wrong-type and cross-workspace links fail atomically, and raw inverse values are refused");

  for (const invalid of [
    { ...reverseDef, multiple: false }, { ...reverseDef, required: true }, { ...reverseDef, kind: "text" },
    { ...reverseDef, inverse: "missing" }, { ...reverseDef, inverse: null },
    { ...reverseDef, target: "foreign_contact" }, { ...reverseDef, target: orgType, inverse: contacts },
  ]) await assert.rejects(orgSchema([invalid, noteDef]), /invalid_field:/);
  await assert.rejects(query("update public.types set fields='[]' where id=$1", [contactType]), /still used by inverse/);
  await assert.rejects(query("update public.types set fields=$2::jsonb where id=$1", [contactType, JSON.stringify([{ ...forward, target: contactType }])]), /still used by inverse/);
  await assert.rejects(query("update public.types set workspace_id=$2 where id=$1", [contactType, foreignWs]), /cannot move to another workspace/);
  const emptySourceType = "empty_source";
  await query("insert into public.types(id,workspace_id,key,name,fields) values($1,$2,'empty_source','Empty',$3::jsonb)", [emptySourceType, ws,
    JSON.stringify([{ id: "f9000011", key: "organization", kind: "link", target: orgType }])]);
  await orgSchema([reverseDef, noteDef, { id: "f9000012", key: "empty_sources", kind: "link", multiple: true, target: emptySourceType, inverse: "f9000011" }]);
  const singleSource = await push(emptySourceType, null, null, "Single link", { organization: beta.id });
  const betaBeforeMove = await row(beta.id);
  await saveOrg(acme.id, { empty_sources: [singleSource.id] });
  assert.equal((await row(singleSource.id)).fields.f9000011, acme.id);
  assert.ok((await row(beta.id)).rev > betaBeforeMove.rev);
  assert.deepEqual(await inverse(acme.id, "f9000011", emptySourceType), [singleSource.id]);
  assert.deepEqual(await inverse(beta.id, "f9000011", emptySourceType), []);
  await saveOrg(acme.id, { empty_sources: [] });
  assert.equal((await row(singleSource.id)).fields.f9000011, undefined);
  await query("delete from public.records where id=$1", [singleSource.id]);
  await assert.rejects(query("delete from public.types where id=$1", [emptySourceType]), /remove inverse fields/);
  await orgSchema([reverseDef, noteDef]);
  await query("delete from public.types where id=$1", [emptySourceType]);
  ok("invalid inverse metadata, inverse-of-inverse and breaking source schema changes are rejected");

  // Required forward fields must not be cleared through the opposite end. A
  // failed multi-source replacement must roll back every earlier source update.
  await query("update public.types set fields=$2::jsonb where id=$1", [contactType, JSON.stringify([{ ...forward, required: true }])]);
  const requiredOrg = await push(orgType, null, null, "Required links", { note: "Keep on rollback" });
  await push(contactType, "a_required_source", null, "Removal succeeds first", { organizations: [requiredOrg.id, beta.id] });
  await push(contactType, "z_required_source", null, "Removal fails second", { organizations: [requiredOrg.id] });
  const requiredTargetBefore = await row(requiredOrg.id);
  const beforeRequired = await query("select id,fields,rev from public.records where type_id=$1 order by id", [contactType]);
  await assert.rejects(saveOrg(requiredOrg.id, { contacts: [] }), /organizations is required/);
  assert.deepEqual(await row(requiredOrg.id), requiredTargetBefore);
  assert.deepEqual(await query("select id,fields,rev from public.records where type_id=$1 order by id", [contactType]), beforeRequired);
  await assert.rejects(saveContact(bob.id, []), /organizations is required/);
  await query("update public.types set fields=$2::jsonb where id=$1", [contactType, JSON.stringify([forward])]);
  await saveOrg(acme.id, { contacts: null });
  assert.deepEqual(await inverse(acme.id), []);
  assert.deepEqual((await row(alice.id)).fields[organizations], [beta.id]);
  assert.equal((await row(bob.id)).fields[organizations], undefined);
  ok("required stored links cannot be emptied and failed replacements roll back; explicit null clears optional inverses");

  // A new target can establish reverse relationships atomically in its creation.
  const created = await push(orgType, null, null, "Created with contacts", { contacts: alice.id });
  assert.deepEqual(await inverse(created.id), [alice.id]);
  assert.deepEqual(new Set((await row(alice.id)).fields[organizations] as string[]), new Set([beta.id, created.id]));
  const parent = await push("page", null, null, "Parent", {});
  let compatible = await push(orgType, created.id, created.rev, created.title, { contacts: [alice.id] }, "Body", parent.id, ["Alias"]);
  assert.equal(compatible.parent_id, parent.id); assert.deepEqual(compatible.aliases, ["Alias"]);
  compatible = await push(orgType, compatible.id, compatible.rev, compatible.title, {}, "Body changed");
  assert.equal(compatible.parent_id, parent.id); assert.deepEqual(compatible.aliases, ["Alias"]);
  assert.deepEqual(await inverse(created.id), [alice.id]);
  ok("new-target inverse writes work and preserve parent/aliases behavior from existing migrations");

  // Permission checks cover the reverse RPC and its invoker trigger side effects.
  await local.localAdmin(async tx => { await tx.query("update public.members set role='viewer' where workspace_id=$1", [ws]); });
  await assert.rejects(saveOrg(created.id, { contacts: [] }), /permission|row-level security/);
  assert.deepEqual(await inverse(created.id), [alice.id]);
  await local.localAdmin(async tx => { await tx.query("update public.members set role='owner' where workspace_id=$1", [ws]); });
  const beforeRemovingReverse = (await row(alice.id)).fields;
  await orgSchema([noteDef]);
  assert.deepEqual((await row(alice.id)).fields, beforeRemovingReverse);
  await saveContact(alice.id, [created.id]);
  await orgSchema([reverseDef, noteDef]);
  assert.deepEqual(await inverse(created.id), [alice.id]);
  ok("viewers cannot edit through inverse RPC; deleting/recreating inverse schema never deletes forward data");
  await query("delete from public.workspaces where id=$1", [ws]);
  assert.equal((await one("select count(*)::int as n from public.records where workspace_id=$1", [ws])).n, 0);
  assert.equal((await one("select count(*)::int as n from public.types where workspace_id=$1", [ws])).n, 0);
  ok("workspace deletion still cascades through mutually dependent type schemas");
  console.log(`\nall ${step} passed`);
} finally {
  await local.closeLocal();
  fs.rmSync(tmp, { recursive: true, force: true });
}
