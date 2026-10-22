// Real CLI authoring in an isolated local store: every supported kind and both link directions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { KINDS, type Kind } from "../src/db.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "surface-cli-schema-"));
const workspace = path.join(scratch, "workspace");
const env: Record<string, string | undefined> = { ...process.env, SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(scratch, "config"), SURFACE_DATA_DIR: path.join(scratch, "data"), SURFACE_SYNC: "off", SURFACE_LOG_FILE: "off", SURFACE_UPDATE_CHECK: "0", NO_COLOR: "1" };
delete env.SURFACE_SUPABASE_URL;
delete env.SURFACE_PUBLISHABLE_KEY;
delete env.SUPABASE_ACCESS_TOKEN;
const main = path.resolve(import.meta.dirname, "../src/main.ts");
function cli(args: string[], fail = false): string {
  const result = spawnSync(process.execPath, ["--no-warnings", main, ...args], {
    cwd: fs.existsSync(workspace) ? workspace : scratch, env, encoding: "utf8", timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (fail) assert.notEqual(result.status, 0, "destructive operation unexpectedly succeeded");
  else assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const records = (type: string) => JSON.parse(cli(["query", type, "--json"])) as { id: string; title: string; fields: Record<string, unknown> }[];
const types = () => JSON.parse(cli(["types", "--json"])) as { key: string; fields: { id: string; key: string }[] }[];
try {
  cli(["init", workspace, "--create", "CLI schema operations"]);
  cli(["type", "add", "organization"]);
  cli(["type", "add", "sample"]);
  cli(["type", "add", "empty"]);
  cli(["type", "rm", "empty"]);
  assert(!types().some(type => type.key === "empty"));
  cli(["new", "organization", "Target organization"]);
  const organization = records("organization")[0];
  const cases: { kind: Kind; input: string; expected: unknown; flags?: string[] }[] = [
    { kind: "text", input: "Notes with punctuation.", expected: "Notes with punctuation." },
    { kind: "number", input: "$1,234.50", expected: 1234.5 },
    { kind: "date", input: "2026-11-15", expected: "2026-11-15" },
    { kind: "checkbox", input: "yes", expected: true },
    { kind: "select", input: "active", expected: "Active", flags: ["--options", "Active,Paused"] },
    { kind: "multi_select", input: "red,blue", expected: ["Red", "Blue"], flags: ["--options", "Red,Blue"] },
    { kind: "url", input: "example.com", expected: "https://example.com" },
    { kind: "email", input: "person@example.test", expected: "person@example.test" },
    { kind: "phone", input: "+1 415 555 0100", expected: "+1 415 555 0100" },
    { kind: "link", input: organization.title, expected: organization.id, flags: ["--target", "organization"] },
  ];
  assert.deepEqual(cases.map(field => field.kind).sort(), [...KINDS].sort(), "a supported field kind needs a real CLI round-trip case");
  for (const field of cases) cli(["field", "add", "sample", `f_${field.kind}`, "--kind", field.kind, ...(field.flags ?? [])]);
  cli(["field", "add", "sample", "organizations", "--kind", "link", "--target", "organization", "--multiple"]);
  cli(["field", "add", "organization", "samples", "--kind", "link", "--target", "sample", "--multiple", "--inverse", "organizations"]);
  cli(["new", "sample", "First", ...cases.map(field => `f_${field.kind}=${field.input}`), `organizations=${organization.title}`]);
  cli(["new", "sample", "Second"]);
  let first = records("sample").find(record => record.title === "First")!;
  const second = records("sample").find(record => record.title === "Second")!;
  for (const field of cases) assert.deepEqual(first.fields[`f_${field.kind}`], field.expected, `${field.kind} must preserve its typed normalized value`);
  assert.deepEqual(records("organization")[0].fields.samples, [first.id]);
  cli(["set", organization.title, "samples=First,Second"]);
  for (const record of records("sample")) assert.deepEqual(record.fields.organizations, [organization.id]);
  cli(["set", "First", "organizations="]);
  assert.deepEqual(records("organization")[0].fields.samples, [second.id]);
  assert.equal(records("sample").find(record => record.id === first.id)!.fields.f_link, organization.id, "changing one relationship must not clear another link to the same target");
  cli(["field", "edit", "sample", "f_text", "--key", "label", "--name", "Label"]);
  first = records("sample").find(record => record.id === first.id)!;
  assert.equal(first.fields.label, cases[0].expected);
  assert.equal(Object.hasOwn(first.fields, "f_text"), false);
  cli(["field", "rm", "sample", "label"]);
  assert(!types().find(type => type.key === "sample")!.fields.some(field => field.key === "label"));
  assert.equal(Object.hasOwn(records("sample").find(record => record.id === first.id)!.fields, "label"), false);
  cli(["type", "rm", "sample"], true);
  assert.deepEqual(records("sample").map(record => record.id).sort(), [first.id, second.id].sort(), "unconfirmed populated-table deletion must preserve its rows");
  cli(["field", "rm", "organization", "samples"]);
  cli(["type", "rm", "sample", "--force"]);
  assert(!types().some(type => type.key === "sample"));
  assert.equal(records("organization")[0].id, organization.id, "table deletion must preserve other tables' records");
  console.log(`CLI schema operations passed: ${KINDS.length} typed field round-trips, table/field creation and removal, guarded deletion, renames, single/multiple links and two-way edits.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
