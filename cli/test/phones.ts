// Phone normalization, real PostgreSQL enforcement, CLI/Markdown and HTTP writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { normalizePhones, phoneEntries, phoneText, phoneHref } from "../src/phone.ts";
import { normalize } from "../src/normalize.ts";

const expected = [{ number: "+14155550123" }];
for (const raw of ["4155550123", "415.555.0123", "(415) 555-0123", "+1 415 555 0123", 4155550123, [{ number: "+14155550123" }]]) assert.deepEqual(normalizePhones(raw), expected);
const numbers = normalizePhones("(415) 555-0123 x004\n+44 20 7946 0958 ext. 009\n4155550124")!;
assert.deepEqual(numbers, [{ number: "+14155550123", extension: "004" }, { number: "+442079460958", extension: "009" }, { number: "+14155550124" }]);
assert.deepEqual(normalizePhones(phoneText(numbers)), numbers, "plain text round-trip preserves every entry and its order");
assert.deepEqual(normalizePhones(phoneText(numbers, false)), numbers, "canonical text preserves every number and extension");
assert.deepEqual(normalizePhones(phoneText(numbers).replace(/\n/g, "; ")), numbers, "grid editing preserves all entries");
assert.deepEqual(normalizePhones(JSON.stringify(numbers)), numbers, "CLI accepts structured JSON too");
const beforeRead = JSON.stringify(numbers);
assert.deepEqual(phoneEntries(numbers), numbers);
assert.equal(JSON.stringify(numbers), beforeRead, "reading phone entries must not mutate stored order or content");
assert(!/primary|mobile|office|★/i.test(phoneText(numbers)), "serialized phone text contains no labels or primary markers");
assert.deepEqual(normalizePhones("tel:+14155550123;ext=004"), [{ number: "+14155550123", extension: "004" }]);
assert.deepEqual(normalizePhones("4155550123; 4155550124"), [{ number: "+14155550123" }, { number: "+14155550124" }]);
assert.equal(phoneText(expected), "(415) 555-0123");
assert.equal(phoneHref(numbers[0]), "tel:+14155550123;ext=004");
assert.equal(phoneText("not a number"), "not a number", "legacy bad values stay visible for review");
for (const bad of ["555-0123", "not a phone", "+1415555012345678", "+11235550123", true, {}, [null], [{ number: "+14155550123", extension: "abc" }], [{ number: "+14155550123", unexpected: "discard me" }], [{ number: "4155550123 x4", extension: "5" }]]) assert.throws(() => normalizePhones(bad));
for (const bad of ["mobile: 4155550123", "Office: +44 20 7946 0958", [{ number: "+14155550123", label: "mobile" }], [{ number: "+14155550123", label: null }], '[{"number":"+14155550123","label":"office"}]']) {
  assert.throws(() => normalizePhones(bad), /labels are not supported/, "labeled writes require explicit correction, never silent metadata removal");
}
const legacyLabeled = [{ number: "+14155550123", label: "mobile", extension: "004" }];
assert.equal(phoneEntries(legacyLabeled), null, "unsupported legacy metadata is not silently dropped during reads");
assert.equal(phoneText(legacyLabeled), JSON.stringify(legacyLabeled), "invalid legacy entries remain visible for correction");
assert.equal(normalizePhones(null), null);
assert.equal(normalizePhones(""), null);
assert.equal(normalizePhones([]), null);
assert(normalize({ id: "p", key: "phone", name: "Phone", kind: "phone" }, "5550123", { link: () => null }).error);
console.log("ok phone parsing: ordered entries, international numbers, extensions, lossless editing, rejected labels and invalid input");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "surface-phone-"));
const workspace = path.join(scratch, "workspace");
Object.assign(process.env, { SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(scratch, "config"), SURFACE_DATA_DIR: path.join(scratch, "data"), SURFACE_SYNC: "off", SURFACE_LOG_FILE: "off", SURFACE_UPDATE_CHECK: "0", NO_COLOR: "1" });
const main = path.resolve(import.meta.dirname, "../src/main.ts");
let server: ChildProcess | undefined;
function cli(args: string[], fail = false) {
  const r = spawnSync(process.execPath, ["--no-warnings", main, ...args], { cwd: fs.existsSync(workspace) ? workspace : scratch, env: process.env, encoding: "utf8", timeout: 30000 });
  if (fail) {
    assert.notEqual(r.status, 0, "expected CLI failure");
    return r.stderr || r.stdout;
  }
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
const { localAdmin, closeLocal, localClient } = await import("../src/local.ts");
try {
  cli(["init", workspace, "--create", "Phone test"]);
  cli(["type", "add", "contact"]);
  cli(["field", "add", "contact", "phone", "--kind", "phone"]);
  cli(["new", "contact", "Ada", "phone=415.555.0123"]);
  let rows = JSON.parse(cli(["query", "contact", "--json"]));
  assert.deepEqual(rows[0].fields.phone, expected);
  assert.match(fs.readFileSync(path.join(workspace, "Contacts", "Ada.md"), "utf8"), /number:.*\+14155550123/);
  cli(["set", "Ada", "phone=" + phoneText(numbers)]);
  rows = JSON.parse(cli(["query", "contact", "--json"]));
  assert.deepEqual(rows[0].fields.phone, numbers);
  assert.match(cli(["check"]), /All good|Nothing to push/);
  const record = () => JSON.parse(cli(["query", "contact", "--json"])).find((row: { title: string }) => row.title === "Ada");
  const adaId = record().id;
  cli(["field", "add", "contact", "alternate", "--kind", "phone"]);
  cli(["field", "add", "contact", "note", "--kind", "text"]);
  cli(["type", "add", "organization"]);
  cli(["field", "add", "organization", "contact", "--kind", "link", "--target", "contact"]);
  cli(["field", "add", "contact", "organizations", "--kind", "link", "--target", "organization", "--multiple", "--inverse", "contact"]);
  cli(["new", "organization", "Analytical Engines", "contact=Ada"]);
  const linkedBefore = JSON.parse(cli(["query", "organization", "--json"]));
  const original = record();
  cli(["phone", "primary", "Ada", "3"]);
  let current = record();
  const reordered = [numbers[2], numbers[0], numbers[1]];
  assert.deepEqual(current.fields.phone, reordered, "choosing primary moves one entry to front and preserves the others' relative order and extensions");
  assert.equal(current.rev, original.rev + 1, "one primary change writes exactly one revision");
  assert.deepEqual(current.fields.organizations, original.fields.organizations, "inverse relationships survive phone changes");
  assert.deepEqual(JSON.parse(cli(["query", "organization", "--json"])), linkedBefore, "the forward relationship record is untouched");
  assert.match(fs.readFileSync(path.join(workspace, "Contacts", "Ada.md"), "utf8"), /\+14155550124[\s\S]*\+14155550123[\s\S]*\+442079460958/, "checkout refresh stores the new order");
  assert.match(cli(["phone", "primary", adaId, "1"]), /No change/);
  assert.deepEqual(record(), current, "already-primary does not write a revision or change timestamps");
  for (const index of ["0", "-1", "4", "1.5", "no", "9007199254740992"]) {
    assert.match(cli(["phone", "primary", "Ada", index], true), /index/i);
    assert.deepEqual(record(), current, `invalid index ${index} leaves the entire record untouched`);
  }
  assert.match(cli(["phone", "primary", "Ada", "1", "--field", "note"], true), /not a phone field/);
  assert.match(cli(["phone", "primary", "Ada", "1", "--field", "missing"], true), /no field/);
  assert.match(cli(["phone", "primary", "Ada", "1", "--field", "alternate"], true), /no phone numbers/);
  assert.deepEqual(record(), current, "invalid or empty fields leave the record untouched");
  for (const value of ["mobile: 4155550123", JSON.stringify([{ number: "+14155550123", label: "mobile" }])]) {
    assert.match(cli(["set", "Ada", "phone=" + value], true), /labels are not supported/);
    assert.deepEqual(record(), current, "rejected labeled writes preserve all numbers and metadata");
  }
  cli(["set", "Ada", "alternate=" + JSON.stringify(numbers)]);
  cli(["phone", "primary", "Ada", "2", "--field", "alternate"]);
  current = record();
  assert.deepEqual(current.fields.alternate, [numbers[1], numbers[0], numbers[2]], "--field selects a custom phone field");
  assert.deepEqual(current.fields.phone, reordered, "selecting a custom field leaves the default field alone");
  cli(["set", "Ada", "phone=" + JSON.stringify(reordered.slice(1))]);
  assert.deepEqual(record().fields.phone, [numbers[0], numbers[1]], "removing the first entry promotes the next number without losing its extension");
  const replacement = [{ number: "+14155550125", extension: "007" }, numbers[1]];
  cli(["set", "Ada", "phone=" + JSON.stringify(replacement)]);
  assert.deepEqual(record().fields.phone, replacement, "set replaces entries in supplied primary order");
  cli(["set", "Ada", "phone="]);
  assert.match(cli(["phone", "primary", "Ada", "1"], true), /no phone numbers/);
  cli(["set", "Ada", "phone=" + JSON.stringify(numbers)]);
  rows = JSON.parse(cli(["query", "contact", "--json"]));
  console.log("ok CLI: primary reorder, no-op revisions, invalid indices, custom fields, inverse links, replacement and clearing");

  const db = localClient();
  const { data: typeRows, error } = await db.from("types").select("*").eq("key", "contact");
  assert.equal(error, null);
  const type = (typeRows as { fields: { id: string }[] }[])[0];
  const field = type.fields[0].id;
  const id = rows[0].id;
  for (const bad of ["415.555.0123", [{ number: "4155550123" }], [{ number: "+11235550123" }], [{ number: "+14155550123", extension: 12 }], [{ number: "+14155550123", label: "MOBILE" }], [], [{ number: "+14155550123", extra: "no" }]]) {
    await assert.rejects(localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,$2::jsonb) where id=$3", [field, JSON.stringify(bad), id])), /invalid_record/, "direct SQL must not bypass the phone type");
  }
  // Schema 9 still accepts historical lowercase labels. Application writes must
  // reject them without silently discarding metadata, including primary changes.
  await localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,$2::jsonb) where id=$3", [field, JSON.stringify(legacyLabeled), id]));
  await closeLocal();
  const historical = record();
  assert.deepEqual(historical.fields.phone, legacyLabeled);
  assert.match(cli(["phone", "primary", "Ada", "1"], true), /labels are not supported/);
  assert.deepEqual(record(), historical, "primary never strips historical labels as a side effect");
  await localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,$2::jsonb) where id=$3", [field, JSON.stringify(numbers), id]));
  // Old invalid phone values must not prevent unrelated edits after upgrade.
  await localAdmin(async tx => {
    await tx.exec("alter table public.records disable trigger records_validate");
    await tx.query("update public.records set fields=jsonb_build_object($1::text,to_jsonb('legacy value'::text)) where id=$2", [field, id]);
    await tx.exec("alter table public.records enable trigger records_validate");
  });
  await localAdmin(tx => tx.query("update public.records set title='Ada legacy' where id=$1", [id]));
  await assert.rejects(localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,to_jsonb('different bad value'::text)) where id=$2", [field, id])), /invalid_record/);
  const { rows: stored } = await localAdmin(tx => tx.query<{ fields: Record<string, unknown> }>("select fields from public.records where id=$1", [id]));
  assert.equal(stored[0].fields[field], "legacy value");
  await closeLocal();
  console.log("ok database: canonical structure enforced, historical labels retained, application rejects labeled changes, legacy unrelated edits preserved");

  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  server = spawn(process.execPath, ["--no-warnings", main, "serve", "--no-watch", "--port", String(port)], { cwd: workspace, env: process.env, stdio: "ignore" });
  const tokenFile = path.join(process.env.SURFACE_CONFIG_DIR!, "serve-token");
  let token = "";
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      token = fs.readFileSync(tokenFile, "utf8").trim();
      if ((await fetch(base + "/api/state", { headers: { cookie: `surface_token=${token}` } })).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("isolated test server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = (fields: unknown) => fetch(base + "/api/records", { method: "POST", headers: { cookie: `surface_token=${token}`, origin: base, "content-type": "application/json" }, body: JSON.stringify({ type: "contact", title: "API phone", fields: { phone: fields } }) });
  const good = await request("415.555.0123 ext. 004\n+44 20 7946 0958 ext. 009\n4155550124");
  const body = await good.json();
  assert.equal(good.status, 200, JSON.stringify(body));
  assert.deepEqual(body.record.fields.phone, numbers);
  for (const value of ["5550123", "mobile: 415.555.0123", [{ number: "+14155550123", label: "mobile" }]]) {
    const bad = await request(value);
    assert.equal(bad.status, 422);
    assert((await bad.json()).errors.phone);
  }
  console.log("ok API: browser writes normalize ordered entries; ambiguous and labeled input returns a field error");
} finally {
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => server!.once("exit", () => resolve())); }
  await closeLocal();
  fs.rmSync(scratch, { recursive: true, force: true });
}
