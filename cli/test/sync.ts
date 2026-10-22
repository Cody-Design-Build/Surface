// Sync test: three "computers" on one machine, each with its own local database and config.
//   hub  runs `surface serve` and acts as the hub (stands in for the cloud: same migrations, same rules)
//   a, b each have a local copy of the same workspace, syncing with the hub
// Covers: enable, join, edits both ways, a link and parent, conflict copies, deletes, delete vs edit,
// offline edits that go up when the hub is back, and the serve loop syncing an app edit on its own.
//   npm run test:sync                the hub is another `surface serve`
//   npm run test:sync:cloud          the hub is your Supabase project, using this computer's sign-in
//                                    and cloud (~/.config/surface-cli/session.json + cloud.json, from
//                                    `surface cloud connect` + `surface login`); creates and deletes a test workspace
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "../bin/surface");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "surface-sync-"));
const HUB_PORT = 4390 + Math.floor(Math.random() * 50);
const A_PORT = HUB_PORT + 60;
const hubUrl = `http://127.0.0.1:${HUB_PORT}`;
const CLOUD = process.env.SYNC_HUB === "cloud";
const REAL_CFG = process.env.SURFACE_REAL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "surface-cli");
console.log(`hub: ${CLOUD ? "the cloud" : "a Surface serve"}`);

type Who = "hub" | "a" | "b";
const envOf = (who: Who) => ({
  ...process.env,
  SURFACE_STORE: "local",
  SURFACE_CONFIG_DIR: path.join(tmp, who, ".cfg"),
  SURFACE_DATA_DIR: path.join(tmp, who, ".data"),
  NO_COLOR: "1",
});
const dir = (who: Who) => path.join(tmp, who, "vault");
/** A test computer that can reach the cloud: link (not copy) the real session, so refreshed tokens stay in one place. */
function signIn(who: Who) {
  const cfg = path.join(tmp, who, ".cfg");
  fs.mkdirSync(cfg, { recursive: true });
  fs.symlinkSync(path.join(REAL_CFG, "session.json"), path.join(cfg, "session.json"));
  fs.copyFileSync(path.join(REAL_CFG, "cloud.json"), path.join(cfg, "cloud.json")); // which Supabase project (yours)
  fs.writeFileSync(path.join(cfg, "store.json"), JSON.stringify({ store: "local" }));
}
/** Ask the cloud directly, as the real signed-in user. */
function cloud(args: string[]): string {
  return execFileSync(BIN, args, { cwd: tmp, env: { ...process.env, SURFACE_STORE: "cloud", SURFACE_CONFIG_DIR: REAL_CFG, NO_COLOR: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const OFFLINE: Record<string, string> = CLOUD ? { SURFACE_SUPABASE_URL: "http://127.0.0.1:9" } : {};
let hubWs = "";
function run(who: Who, args: string[], opts: { cwd?: string; fail?: boolean; env?: Record<string, string> } = {}): string {
  try {
    const out = execFileSync(BIN, args, { cwd: opts.cwd ?? dir(who), env: { ...envOf(who), ...opts.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (opts.fail) assert.fail(`expected failure: surface ${args.join(" ")}\n${out}`);
    return out;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    if (opts.fail) return (err.stdout ?? "") + (err.stderr ?? "");
    throw new Error(`[${who}] surface ${args.join(" ")} failed (${err.status}):\n${err.stdout}\n${err.stderr}`);
  }
}
const q = (who: Who, type: string) => JSON.parse(run(who, ["query", type, "--json"])) as Record<string, any>[];
const find = (who: Who, type: string, title: string) => q(who, type).find((r) => r.title === title);
const idOf = (out: string) => /\(([0-9a-z]{12})\)/.exec(out)![1];
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function storedRows(value: unknown): { id: string; [key: string]: unknown }[] {
  assert.ok(Array.isArray(value));
  return value.map(row => {
    assert.ok(isObject(row) && typeof row.id === "string");
    return { ...row, id: row.id };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Read real sync state/reports without depending on human-facing command wording. */
function callSync(who: Who, op: "status" | "now"): unknown {
  const config: unknown = JSON.parse(fs.readFileSync(path.join(dir(who), ".surface", "config.json"), "utf8"));
  assert.ok(isObject(config) && typeof config.workspace === "string");
  const script = `
    import { sb, requireUser } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
    import { syncCall } from ${JSON.stringify(new URL("../src/sync.ts", import.meta.url).href)};
    import { closeLocal } from ${JSON.stringify(new URL("../src/local.ts", import.meta.url).href)};
    try { await requireUser(); console.log(JSON.stringify(await syncCall(${JSON.stringify(op)}, ${JSON.stringify(config.workspace)}))); }
    finally { await sb().auth.stopAutoRefresh(); await closeLocal(); }
  `;
  return JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    cwd: dir(who), env: envOf(who), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
}
function syncData(who: Who) {
  const state = callSync(who, "status");
  assert.ok(isObject(state) && isObject(state.hub) && typeof state.hub.workspace === "string" && isObject(state.pending) && Array.isArray(state.conflicts));
  const conflicts = state.conflicts.map(conflict => {
    assert.ok(isObject(conflict) && typeof conflict.record_id === "string" && typeof conflict.copy_id === "string");
    return { record_id: conflict.record_id, copy_id: conflict.copy_id };
  });
  return { hub: { workspace: state.hub.workspace }, last_error: state.last_error, errorKind: state.errorKind, pending: state.pending, conflicts };
}
function syncRound(who: Who) {
  const reports = callSync(who, "now");
  assert.ok(Array.isArray(reports));
  return reports.map(report => {
    assert.ok(isObject(report) && Array.isArray(report.errors));
    return { scan: report.scan, errors: report.errors };
  });
}

/** A join must leave actual hub rows/revisions untouched, regardless of progress accounting. */
async function hubSnapshot(token: string) {
  const tables = ["types", "records", "views"] as const;
  if (CLOUD) {
    const script = `
      import { sb, requireUser } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
      try {
        await requireUser();
        const snapshot = {};
        for (const table of ${JSON.stringify(tables)}) {
          const { data, error } = await sb().from(table).select("*").eq("workspace_id", ${JSON.stringify(hubWs)});
          if (error) throw new Error(error.message);
          snapshot[table] = data;
        }
        console.log(JSON.stringify(snapshot));
      } finally { await sb().auth.stopAutoRefresh(); }
    `;
    const data: unknown = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
      cwd: tmp, env: { ...process.env, SURFACE_STORE: "cloud", SURFACE_CONFIG_DIR: REAL_CFG, NO_COLOR: "1" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.ok(isObject(data));
    return { types: storedRows(data.types), records: storedRows(data.records), views: storedRows(data.views) };
  }
  const snapshot: Record<(typeof tables)[number], { id: string; [key: string]: unknown }[]> = { types: [], records: [], views: [] };
  for (const table of tables) {
    const response = await fetch(`${hubUrl}/api/_db`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-surface-token": token },
      body: JSON.stringify({ kind: "select", table, columns: "*", filters: [{ col: "workspace_id", op: "eq", value: hubWs }], order: [], returning: false }),
    });
    assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.ok(isObject(result));
    assert.equal(result.error, null);
    snapshot[table] = storedRows(result.data);
  }
  return snapshot;
}
let step = 0;
const ok = (name: string) => console.log(`ok ${++step} ${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (f()) return;
    } catch {}
    await sleep(300);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const procs: ChildProcess[] = [];
async function serveOn(who: Who, port: number, extra: Record<string, string> = {}) {
  const p = spawn(BIN, ["serve", "--port", String(port), "--no-watch"], { cwd: dir(who), env: { ...envOf(who), ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  await until(`${who} serve on ${port}`, () => out.includes("Open: "));
  return { proc: p, log: () => out };
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null) return;
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
}

try {
  // the hub: a Surface with a checkout, served so others can reach its database
  let hub: { proc: ChildProcess } | null = null;
  let token = "";
  let H: string[] = [];
  if (CLOUD) {
    signIn("a");
    signIn("b");
  } else {
    fs.mkdirSync(path.join(tmp, "hub"), { recursive: true });
    run("hub", ["init", dir("hub"), "--create", "Hub home"], { cwd: tmp });
    hub = await serveOn("hub", HUB_PORT);
    token = fs.readFileSync(path.join(tmp, "hub", ".cfg", "serve-token"), "utf8").trim();
    H = ["--hub", hubUrl, "--token", token];
  }

  // computer A: a local workspace with types, a link, a parent, then sync on
  fs.mkdirSync(path.join(tmp, "a"), { recursive: true });
  run("a", ["init", dir("a"), "--create", "Team"], { cwd: tmp });
  run("a", ["type", "add", "project"]);
  run("a", ["field", "add", "project", "status", "--kind", "select", "--options", "Lead,Active,Done"]);
  run("a", ["type", "add", "task"]);
  run("a", ["field", "add", "task", "status", "--kind", "select", "--options", "todo,doing,done"]);
  run("a", ["field", "add", "task", "project", "--kind", "link", "--target", "project"]);
  const proj = idOf(run("a", ["new", "project", "Kitchen", "status=Active"]));
  const t1 = idOf(run("a", ["new", "task", "Order tile", "status=todo", `project=${proj}`]));
  run("a", ["new", "page", "Notes", "--parent", proj]);
  run("a", ["view", "new", "Open tasks", "--from", "task", "--where", "status=todo", "--key", "open-tasks"]);
  run("a", ["sync", "enable", ...H]);
  const enabled = syncData("a");
  assert.ok(enabled);
  assert.equal(enabled.last_error, null);
  assert.deepEqual(enabled.pending, {});
  hubWs = enabled.hub.workspace;
  ok("enable: a local workspace goes up to the hub");

  // The hub really has the same record identities and values.
  const beforeJoin = await hubSnapshot(token);
  assert.deepEqual(beforeJoin.records.map(r => r.title).sort(), ["Kitchen", "Notes", "Order tile"]);
  assert.ok(beforeJoin.records.some(r => r.id === proj && r.title === "Kitchen"));
  assert.ok(beforeJoin.records.some(r => r.id === t1 && r.title === "Order tile"));
  ok("the hub holds the same records with the same ids");

  // computer B joins: a new local copy, with types, fields, links, parent and views
  fs.mkdirSync(path.join(tmp, "b"), { recursive: true });
  run("b", ["sync", "join", hubWs, dir("b"), ...H], { cwd: path.join(tmp, "b") });
  assert.deepEqual(await hubSnapshot(token), beforeJoin, "joining must not write records, schemas or views to the hub");
  const bt = find("b", "task", "Order tile")!;
  assert.equal(bt.id, t1);
  assert.equal(bt.fields.project, proj);
  assert.match(fs.readFileSync(path.join(dir("b"), "Pages", "Notes.md"), "utf8"), /parent: "\[\[Kitchen\]\]"/);
  assert.ok(fs.existsSync(path.join(dir("b"), ".surface", "views", "open-tasks.yaml")));
  assert.ok(fs.readdirSync(path.join(dir("b"), "Tasks")).some((f) => f.startsWith("Order tile")));
  ok("join: B gets types, records (same ids), links, parents, views and Markdown files");

  // edits both ways
  run("a", ["set", t1, "status=doing"]);
  run("a", ["sync"]);
  run("b", ["sync"]);
  assert.equal(find("b", "task", "Order tile")!.fields.status, "doing");
  run("b", ["new", "task", "Call plumber", "status=todo"]);
  run("b", ["sync"]);
  run("a", ["sync"]);
  assert.ok(find("a", "task", "Call plumber"));
  ok("edits and new records sync both ways");

  // schema change on A reaches B
  run("a", ["field", "add", "task", "due", "--kind", "date"]);
  run("a", ["set", t1, "due=2026-11-01"]);
  run("a", ["sync"]);
  run("b", ["sync"]);
  assert.equal(find("b", "task", "Order tile")!.fields.due, "2026-11-01");
  ok("a new field and its value reach B");

  // later rounds pull incrementally (only what changed since the cursor), and still get changes
  run("a", ["set", t1, "status=todo"]);
  run("a", ["sync"]);
  const incremental = syncRound("b");
  assert.equal(incremental[0].scan, "incremental");
  assert.deepEqual(incremental[0].errors, []);
  assert.equal(find("b", "task", "Order tile")!.fields.status, "todo");
  ok("incremental pull: only changes since the last round");

  // conflict: both edit the same record; the second to sync keeps a conflict copy
  run("a", ["set", t1, "status=done"]);
  run("b", ["set", t1, "status=doing", "body=B's note"]);
  run("a", ["sync"]);
  run("b", ["sync"]);
  const bTasks = q("b", "task");
  assert.equal(bTasks.find((r) => r.id === t1)!.fields.status, "done"); // took A's (the hub's) version
  const copy = bTasks.find((r) => r.title.startsWith("Order tile (conflict"))!;
  assert.ok(copy, "conflict copy exists");
  assert.equal(copy.fields.status, "doing");
  assert.equal(syncData("b").conflicts.find(c => c.record_id === t1)?.copy_id, copy.id);
  run("b", ["sync"]);
  run("a", ["sync"]);
  assert.ok(find("a", "task", copy.title), "the conflict copy syncs like any record");
  run("b", ["rm", copy.id]);
  run("b", ["sync", "resolve", t1]);
  assert.deepEqual(syncData("b").conflicts, []);
  ok("conflict: hub version wins, B's version kept as a copy, resolvable");

  // delete on B reaches A
  run("b", ["sync"]);
  run("a", ["sync"]);
  assert.equal(find("a", "task", copy.title), undefined);
  const plumber = find("a", "task", "Call plumber")!;
  run("a", ["rm", plumber.id]);
  run("a", ["sync"]);
  run("b", ["sync"]);
  assert.equal(find("b", "task", "Call plumber"), undefined);
  ok("deletes sync");

  // delete vs edit: A deletes while B edits; the edit wins
  run("b", ["sync"]);
  run("a", ["sync"]);
  run("a", ["rm", t1]);
  run("b", ["set", t1, "status=doing"]);
  run("b", ["sync"]);
  run("a", ["sync"]);
  assert.equal(find("a", "task", "Order tile")?.fields.status, "doing");
  ok("delete on one computer, edit on another: the edit wins and the record comes back");

  // offline: the hub goes away; A keeps working; changes go up when it's back
  if (hub) await stop(hub.proc);
  run("a", ["set", t1, "status=done"]);
  run("a", ["sync"], { env: OFFLINE });
  assert.equal(find("a", "task", "Order tile")!.fields.status, "done");
  const offline = syncData("a");
  assert.equal(offline.errorKind, "network");
  assert.equal(offline.pending.record, 1);
  if (!CLOUD) hub = await serveOn("hub", HUB_PORT);
  run("a", ["sync"]);
  run("b", ["sync"]);
  assert.equal(find("b", "task", "Order tile")!.fields.status, "done");
  ok("offline: edits stay local, then go up when the hub is back");

  // the app path: A runs serve; an app edit syncs to the hub without running `surface sync`
  const aServe = await serveOn("a", A_PORT, { SURFACE_SYNC_MS: "700" });
  const aTok = fs.readFileSync(path.join(tmp, "a", ".cfg", "serve-token"), "utf8").trim();
  const hdr = { "content-type": "application/json", cookie: `surface_token=${aTok}`, origin: `http://127.0.0.1:${A_PORT}` };
  const st = await fetch(`http://127.0.0.1:${A_PORT}/api/state`, { headers: hdr }).then((r) => r.json());
  assert.ok(st.records.find((r: any) => r.id === t1));
  const put = await fetch(`http://127.0.0.1:${A_PORT}/api/record/${t1}`, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ baseRev: find("a", "task", "Order tile")!.rev, type: "task", title: "Order tile", fields: { status: "todo", project: proj, due: "2026-11-01" }, body: "" }),
  });
  assert.equal(put.status, 200, await put.clone().text());
  await until("B sees the app edit", () => {
    run("b", ["sync"]);
    return find("b", "task", "Order tile")!.fields.status === "todo";
  });
  // and B's change shows up in A's running app on its own
  run("b", ["set", t1, "status=doing"]);
  run("b", ["sync"]);
  let last = "";
  await until("A's serve pulls B's edit", () => {
    const out = execFileSync("curl", ["-s", "-H", `cookie: surface_token=${aTok}`, "-H", `origin: http://127.0.0.1:${A_PORT}`, "-H", "content-type: application/json", "-d", JSON.stringify({ from: "task" }), `http://127.0.0.1:${A_PORT}/api/query`], { encoding: "utf8" });
    last = out.slice(0, 600);
    const r = (JSON.parse(out).records ?? JSON.parse(out)).find((r: any) => r.id === t1);
    return r?.fields?.status === "doing" || JSON.stringify(r).includes('"doing"');
  }).catch((e) => {
    console.error("A record:", last, "\nA serve log:\n" + aServe.log());
    throw e;
  });
  // `surface sync` on A while serve owns the database goes through serve
  run("a", ["sync"]);
  // the app's sync state: enabled, hub, nothing waiting, no conflicts; then a conflict shows up there
  const ss = await fetch(`http://127.0.0.1:${A_PORT}/api/sync`, { headers: hdr }).then((r) => r.json());
  assert.equal(ss.enabled, true);
  assert.equal(ss.pending, 0);
  assert.equal(ss.conflicts.length, 0);
  assert.ok(ss.lastSync);
  ok("the app sees sync state (/api/sync)");
  await stop(aServe.proc);
  ok("serve syncs on its own: app edits go up, others' edits come down");

  console.log(`\nall ${step} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const p of procs) await stop(p).catch(() => {});
  if (CLOUD && hubWs) {
    try {
      cloud(["workspace", "delete", hubWs, "--yes"]);
      console.log(`deleted cloud test workspace ${hubWs}`);
    } catch (e) {
      console.error(`couldn't delete cloud test workspace ${hubWs}: ${(e as Error).message}`);
    }
  }
  if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
  else console.error(`left ${tmp} for inspection`);
}
