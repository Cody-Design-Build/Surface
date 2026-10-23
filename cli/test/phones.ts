// Phone normalization, real PostgreSQL enforcement, CLI/Markdown and HTTP writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { normalizePhones, phoneText, phoneHref } from "../src/phone.ts";
import { normalize } from "../src/normalize.ts";

const expected = [{ number: "+14155550123" }];
for (const raw of ["4155550123", "415.555.0123", "(415) 555-0123", "+1 415 555 0123", 4155550123, [{ number: "+14155550123" }]]) assert.deepEqual(normalizePhones(raw), expected);
const labeled = normalizePhones("Mobile: (415) 555-0123 x004\noffice: +44 20 7946 0958")!;
assert.deepEqual(labeled, [{ number: "+14155550123", label: "mobile", extension: "004" }, { number: "+442079460958", label: "office" }]);
assert.deepEqual(normalizePhones(phoneText(labeled)), labeled);
assert.deepEqual(normalizePhones(phoneText(labeled).replace(/\n/g, "; ")), labeled, "grid editing preserves all labeled entries");
assert.deepEqual(normalizePhones(JSON.stringify(labeled)), labeled, "CLI accepts structured JSON too");
assert.deepEqual(normalizePhones("tel:+14155550123;ext=004"), [{ number: "+14155550123", extension: "004" }]);
assert.deepEqual(normalizePhones("4155550123; 4155550124"), [{ number: "+14155550123" }, { number: "+14155550124" }]);
assert.equal(phoneText(expected), "(415) 555-0123");
assert.equal(phoneHref(labeled[0]), "tel:+14155550123;ext=004");
assert.equal(phoneText("not a number"), "not a number", "legacy bad values stay visible for review");
for (const bad of ["555-0123", "not a phone", "+1415555012345678", "+11235550123", true, {}, [null], [{ number: "+14155550123", extension: "abc" }], [{ number: "+14155550123", unexpected: "discard me" }], [{ number: "4155550123 x4", extension: "5" }]]) assert.throws(() => normalizePhones(bad));
assert.equal(normalizePhones(""), null);
assert.equal(normalizePhones([]), null);
assert(normalize({ id: "p", key: "phone", name: "Phone", kind: "phone" }, "5550123", { link: () => null }).error);
console.log("ok phone parsing: formats, labels, international, extensions, idempotent editing, invalid/ambiguous input");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "surface-phone-"));
const workspace = path.join(scratch, "workspace");
Object.assign(process.env, { SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(scratch, "config"), SURFACE_DATA_DIR: path.join(scratch, "data"), SURFACE_SYNC: "off", SURFACE_LOG_FILE: "off", SURFACE_UPDATE_CHECK: "0", NO_COLOR: "1" });
const main = path.resolve(import.meta.dirname, "../src/main.ts");
let server: ChildProcess | undefined;
function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", main, ...args], { cwd: fs.existsSync(workspace) ? workspace : scratch, env: process.env, encoding: "utf8", timeout: 30000 });
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
  cli(["set", "Ada", "phone=" + phoneText(labeled)]);
  rows = JSON.parse(cli(["query", "contact", "--json"]));
  assert.deepEqual(rows[0].fields.phone, labeled);
  assert.match(cli(["check"]), /All good|Nothing to push/);
  console.log("ok CLI and YAML round-trip preserves phone entries");

  const db = localClient();
  const { data: typeRows, error } = await db.from("types").select("*").eq("key", "contact");
  assert.equal(error, null);
  const type = (typeRows as { fields: { id: string }[] }[])[0];
  const field = type.fields[0].id;
  const id = rows[0].id;
  for (const bad of ["415.555.0123", [{ number: "4155550123" }], [{ number: "+11235550123" }], [{ number: "+14155550123", extension: 12 }], [{ number: "+14155550123", label: "MOBILE" }], [], [{ number: "+14155550123", extra: "no" }]]) {
    await assert.rejects(localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,$2::jsonb) where id=$3", [field, JSON.stringify(bad), id])), /invalid_record/, "direct SQL must not bypass the phone type");
  }
  await localAdmin(tx => tx.query("update public.records set fields=jsonb_build_object($1::text,$2::jsonb) where id=$3", [field, JSON.stringify(labeled), id]));
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
  console.log("ok database: direct writes rejected, canonical entries accepted, legacy unrelated edits preserved");

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
  const good = await request("mobile: 415.555.0123 ext. 004\noffice: +44 20 7946 0958");
  const body = await good.json();
  assert.equal(good.status, 200, JSON.stringify(body));
  assert.deepEqual(body.record.fields.phone, labeled);
  const bad = await request("5550123");
  assert.equal(bad.status, 422);
  assert((await bad.json()).errors.phone);
  console.log("ok API: browser writes normalize all entries; ambiguous input returns a field error");
} finally {
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise<void>(resolve => server!.once("exit", () => resolve())); }
  await closeLocal();
  fs.rmSync(scratch, { recursive: true, force: true });
}
