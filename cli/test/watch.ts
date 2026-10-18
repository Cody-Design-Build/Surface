// Push on save: `surface watch` sends edits from any editor to the database.
// Runs on the local store in a temp folder (no account). Run: npm run test:watch
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "../bin/surface");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "surface-watch-"));
const vault = path.join(tmp, "vault");
const env = { ...process.env, SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(tmp, ".cfg"), SURFACE_DATA_DIR: path.join(tmp, ".data"), NO_COLOR: "1" };
const run = (args: string[], cwd = vault) => execFileSync(BIN, args, { cwd, env, encoding: "utf8" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(200);
  }
  assert.fail(`timed out waiting for: ${what}\n--- watch log ---\n${log}`);
}
let step = 0;
const ok = (s: string) => console.log(`ok ${++step} ${s}`);
let log = "";

run(["init", vault, "--create", "Watch test"], tmp);
run(["type", "add", "task"]);
run(["field", "add", "task", "status", "--kind", "select", "--options", "todo,doing,done"]);
run(["new", "task", "Order tile", "status=todo"]);

const w = spawn(BIN, ["watch"], { cwd: vault, env });
w.stdout.on("data", (d) => (log += d));
w.stderr.on("data", (d) => (log += d));
try {
  await until("watcher started", () => /Watching/.test(log));
  const file = path.join(vault, "Tasks", "Order tile.md");

  // an editor saves a change (as Obsidian or VS Code would)
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("status: todo", "status: Doing"));
  await until("edit saved", () => /saved\s+Tasks\/Order tile\.md/.test(log));
  await wait(300);
  assert.match(fs.readFileSync(file, "utf8"), /status: doing/); // normalized and written back
  ok("edit in an editor reaches the database, normalized");

  // a new file becomes a record
  fs.writeFileSync(path.join(vault, "Meeting notes.md"), "# Meeting notes\n\nCall the tile supplier.\n");
  await until("new file added", () => /added\s+Meeting notes\.md/.test(log));
  await wait(300);
  // in the type layout it moves into its type's folder, with an id
  const notes = path.join(vault, "Pages", "Meeting notes.md");
  assert.match(fs.readFileSync(notes, "utf8"), /^---\nid: /);
  ok("new Markdown file added as a record");

  // an invalid value is refused; the file is left as written
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("status: doing", "status: nope"));
  await until("invalid rejected", () => /rejected\s+Tasks\/Order tile\.md[\s\S]*isn.t an option/.test(log));
  assert.match(fs.readFileSync(file, "utf8"), /status: nope/);
  ok("invalid value rejected, file left as written");

  // deleting a file keeps the record
  fs.rmSync(notes);
  await until("removal reported", () => /removed\s+Pages\/Meeting notes\.md/.test(log));
  ok("deleted file reported; record kept");
} finally {
  w.kill("SIGTERM");
  await wait(800);
}
// the database has what the editor saved (watch has stopped, so this opens the database directly)
const q = run(["query", "task"]);
assert.match(q, /Order tile\s+doing/);
assert.match(run(["query", "page", "--json"]), /Meeting notes/);
ok("database matches after the watcher stops");
console.log(`\nall ${step} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
