// End-to-end test against the real Supabase project.
// Needs a test account: SURFACE_TEST_EMAIL + SURFACE_TEST_PASSWORD (or ~/.hermes/secrets/surface-test-user.txt).
// Run: npm test
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "../bin/surface");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "surface-e2e-"));
const vault = path.join(tmp, "vault");
const email = process.env.SURFACE_TEST_EMAIL ?? "agent-test@surface.dev";
const password =
  process.env.SURFACE_TEST_PASSWORD ?? fs.readFileSync(path.join(os.homedir(), ".hermes/secrets/surface-test-user.txt"), "utf8").trim();
const env = { ...process.env, SURFACE_CONFIG_DIR: path.join(tmp, ".cfg"), SURFACE_PASSWORD: password, NO_COLOR: "1" };

function run(args: string[], opts: { cwd?: string; fail?: boolean } = {}): string {
  try {
    const out = execFileSync(BIN, args, { cwd: opts.cwd ?? vault, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (opts.fail) assert.fail(`expected failure: surface ${args.join(" ")}\n${out}`);
    return out;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    if (opts.fail) return (err.stdout ?? "") + (err.stderr ?? "");
    throw new Error(`surface ${args.join(" ")} failed (${err.status}):\n${err.stdout}\n${err.stderr}`);
  }
}
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), s);
};
const edit = (rel: string, f: (s: string) => string) => write(rel, f(read(rel)));
let step = 0;
const ok = (name: string) => console.log(`ok ${++step} ${name}`);

const wsName = `e2e ${Date.now()}`;
try {
  run(["login", "--email", email], { cwd: tmp });
  run(["init", vault, "--create", wsName], { cwd: tmp });
  assert.match(run(["types"]), /page \*/);
  assert.ok(fs.existsSync(path.join(vault, "AGENTS.md")));
  ok("login, workspace with built-in page type, agent files");

  run(["type", "add", "project"]);
  run(["field", "add", "project", "status", "--kind", "select", "--options", "Lead,Estimating,In Progress,Done"]);
  run(["field", "add", "project", "budget", "--kind", "number"]);
  run(["type", "add", "task"]);
  run(["field", "add", "task", "status", "--kind", "select", "--options", "todo,doing,done"]);
  run(["field", "add", "task", "due", "--kind", "date"]);
  run(["field", "add", "task", "project", "--kind", "link", "--target", "project"]);
  run(["field", "add", "task", "done", "--kind", "checkbox"]);
  assert.match(run(["field", "add", "task", "status", "--kind", "text"], { fail: true }), /duplicate field/);
  assert.match(run(["field", "add", "task", "title"], { fail: true }), /reserved/);
  assert.match(run(["field", "add", "task", "x", "--kind", "select"], { fail: true }), /needs --options/);
  ok("create types and fields; bad field definitions rejected");

  run(["new", "project", "Kitchen Remodel", "status=estimating", "budget=$45,000"]);
  run(["new", "task", "Order cabinets", "status=todo", "due=Oct 24 2026", "project=Kitchen Remodel", "--body", "Confirm finish."]);
  const task = read("Tasks/Order cabinets.md");
  assert.match(task, /due: 2026-10-24/);
  assert.match(task, /project: "\[\[Kitchen Remodel\]\]"/);
  assert.match(read("Projects/Kitchen Remodel.md"), /status: Estimating\nbudget: 45000/);
  assert.match(run(["set", "Order cabinets", "status=dnoe"], { fail: true }), /Did you mean "done"/);
  ok("new records via CLI, normalized values, links rendered");

  edit("Tasks/Order cabinets.md", (s) => s.replace("status: todo", "status: Doing").replace("done:", "done: yes").replace("Confirm finish.", "Confirm finish.\n\nWhite oak."));
  edit("Projects/Kitchen Remodel.md", (s) => s.replace("title: Kitchen Remodel", "title: Steiner Kitchen").replace("budget: 45000", 'budget: "$47,500"'));
  write("Tasks/Demo.md", '---\ntype: task\nstatus: todo\nproject: "[[Bathroom]]"\n---\nDumpster.\n');
  write("Bathroom.md", "---\ntype: project\nstatus: lead\n---\n");
  write("Loose note.md", "No front matter.\n");
  write("Pages/Broken.md", "---\ntitle: [oops\n---\n");
  const st = run(["status"]);
  assert.match(st, /Edited, not pushed/);
  assert.match(st, /Not in Surface/);
  const pushed = run(["push", "--new"], { fail: true }); // Broken.md makes it exit 1
  assert.match(pushed, /broken YAML/);
  assert.match(pushed, /2 pushed, 3 added/);
  assert.ok(fs.existsSync(path.join(vault, "Projects/Steiner Kitchen.md")), "renamed title moves the file");
  assert.ok(!fs.existsSync(path.join(vault, "Projects/Kitchen Remodel.md")));
  assert.match(read("Tasks/Order cabinets.md"), /status: doing[\s\S]*project: "\[\[Steiner Kitchen\]\]"[\s\S]*done: true[\s\S]*White oak/);
  assert.match(read("Tasks/Demo.md"), /id: \w{12}[\s\S]*project: "\[\[Bathroom\]\]"/);
  assert.match(read("Projects/Bathroom.md"), /status: Lead/);
  assert.match(read("Pages/Loose note.md"), /type: page/);
  fs.rmSync(path.join(vault, "Pages/Broken.md"));
  assert.match(run(["status"]), /Clean/);
  ok("edit files, push: normalize, import new files, link new-to-new, rename moves file and rewrites links");

  edit("Tasks/Demo.md", (s) => s.replace("status: todo", "status: doing"));
  run(["set", "Demo", "due=11/3/2026", "--workspace", wsName], { cwd: tmp }); // someone else's change
  const conflict = run(["push"], { fail: true });
  assert.match(conflict, /conflict/);
  assert.match(run(["pull"]), /kept/);
  run(["pull", "--force"]);
  run(["set", "Demo", "status=doing"]);
  assert.match(read("Tasks/Demo.md"), /rev: 3[\s\S]*status: doing\ndue: 2026-11-03/);
  ok("conflict detected on stale rev; pull keeps unpushed edits; force + redo resolves");

  edit("Tasks/Order cabinets.md", (s) => s.replace("status: doing", "status: DOING"));
  assert.match(run(["push"]), /"DOING" → "doing"/);
  assert.match(read("Tasks/Order cabinets.md"), /status: doing/);
  assert.match(run(["status"]), /Clean/);
  ok("normalize-only edit rewrites the file without a new revision");

  const q = run(["query", "task", "--where", "status=doing && due>2026-11-01"]);
  assert.match(q, /Demo/);
  assert.doesNotMatch(q, /Order cabinets/);
  const json = JSON.parse(run(["query", "task", "--json"]));
  assert.equal(json.length, 2);
  ok("query with filters and JSON");

  run(["field", "edit", "task", "due", "--key", "due_date"]);
  assert.match(read("Tasks/Demo.md"), /due_date: 2026-11-03/);
  run(["field", "edit", "project", "status", "--remove-option", "Lead"]);
  assert.match(run(["check"], { fail: true }), /Bathroom: status "Lead" isn't an option/);
  run(["set", "Bathroom", "status=Estimating"]);
  assert.match(run(["check"]), /All good/);
  run(["field", "rm", "task", "done"]);
  assert.doesNotMatch(read("Tasks/Order cabinets.md"), /done:/);
  ok("rename a field key, remove an option (flagged by check), remove a field");

  run(["type", "add", "material"]);
  run(["field", "add", "material", "cost", "--kind", "number"]);
  run(["field", "add", "material", "tasks", "--kind", "link", "--target", "task", "--multiple"]);
  run(["new", "material", "Shaker cabinets", "cost=12000", "tasks=Order cabinets,Demo"]);
  assert.match(read("Materials/Shaker cabinets.md"), /tasks:\n  - "\[\[Order cabinets\]\]"\n  - "\[\[Demo\]\]"/);
  run(["type", "edit", "material", "--key", "supply", "--folder", "Supplies"]);
  assert.ok(fs.existsSync(path.join(vault, "Supplies/Shaker cabinets.md")));
  assert.match(run(["type", "rm", "supply"], { fail: true }), /has 1 record/);
  run(["type", "rm", "supply", "--move-to", "page"]);
  assert.ok(fs.existsSync(path.join(vault, "Pages/Shaker cabinets.md")));
  assert.match(run(["type", "rm", "page"], { fail: true }), /built in/);
  ok("multi-links, rename a type (files move), remove a type safely, built-in protected");

  run(["rm", "Loose note"]);
  assert.ok(!fs.existsSync(path.join(vault, "Pages/Loose note.md")));
  run(["restore", "Loose note"]);
  assert.ok(fs.existsSync(path.join(vault, "Pages/Loose note.md")));
  assert.match(run(["history", "Loose note"]), /delete[\s\S]*restore/);
  ok("delete, restore, history");

  run(["new", "page", "Estimating guide"]);
  run(["new", "page", "Pricing", "--parent", "Estimating guide"]);
  assert.match(read("Pages/Pricing.md"), /title: Pricing\nparent: "\[\[Estimating guide\]\]"/);
  edit("Pages/Loose note.md", (s) => s.replace("title: Loose note", 'title: Loose note\nparent: "[[Pricing]]"'));
  assert.match(run(["push"]), /1 pushed/);
  assert.match(run(["set", "Estimating guide", "parent=Loose note"], { fail: true }), /inside itself/);
  const top = run(["query", "page", "--where", "parent="]);
  assert.match(top, /Estimating guide/);
  assert.doesNotMatch(top, /Pricing/);
  assert.match(run(["query", "--where", "parent=this", "--this", "Pricing"]), /Loose note/);
  run(["set", "Loose note", "parent="]);
  assert.doesNotMatch(read("Pages/Loose note.md"), /parent:/);
  ok("nesting: parent field, cycles rejected, query parent= and parent=this, clear parent");

  const linked = path.join(tmp, "linked");
  run(["init", linked, "--workspace", wsName, "--layout", "link:project,parent"], { cwd: tmp });
  assert.ok(fs.existsSync(path.join(linked, "Projects/Steiner Kitchen.md")));
  assert.ok(fs.existsSync(path.join(linked, "Projects/Steiner Kitchen/Tasks/Order cabinets.md")));
  assert.ok(fs.existsSync(path.join(linked, "Projects/Bathroom/Tasks/Demo.md")));
  assert.ok(fs.existsSync(path.join(linked, "Pages/Estimating guide/Pricing.md")));
  assert.match(run(["layout", "type"], { cwd: linked }), /moved/);
  assert.ok(fs.existsSync(path.join(linked, "Tasks/Order cabinets.md")));
  ok("link layout: tasks under their project, pages under their parent; switch layout moves files");

  const fold = path.join(tmp, "fold");
  run(["init", fold, "--workspace", wsName, "--layout", "folder"], { cwd: tmp });
  run(["mv", "Order cabinets", "Demo", "Jobs/Active"], { cwd: fold });
  assert.ok(fs.existsSync(path.join(fold, "Jobs/Active/Order cabinets.md")));
  run(["folder", "rename", "Jobs", "Work"], { cwd: fold });
  assert.ok(fs.existsSync(path.join(fold, "Work/Active/Demo.md")));
  assert.match(run(["folders"], { cwd: fold }), /Work\/[\s\S]*Active\/\s+2/);
  run(["mv", "--type", "task", "--where", "project=Bathroom", "--to", "Archive"], { cwd: fold });
  assert.ok(fs.existsSync(path.join(fold, "Archive/Demo.md")));
  ok("folders: mv records, mv by query, rename a folder, list folders");

  run(["tree", "init"]);
  assert.ok(fs.existsSync(path.join(vault, ".surface/views/sidebar.yaml")));
  assert.match(run(["tree"]), /Pages\/[\s\S]*Estimating guide\n│   └── Pricing/);
  write(".surface/views/sidebar.yaml", [
    "name: Sidebar",
    "items:",
    "  - group: Jobs",
    "    items:",
    "      - query: { from: project, sort: title }",
    "        each:",
    "          - query: { from: task, where: \"project=this\", label: Tasks }",
    "  - record: \"[[Estimating guide]]\"",
    "",
  ].join("\n"));
  assert.match(run(["status"]), /sidebar\.yaml/);
  assert.match(run(["tree", "check"]), /valid/);
  assert.match(run(["push"]), /pushed\s+\.surface\/views\/sidebar\.yaml/);
  const tree = run(["tree", "--paths"]);
  assert.match(tree, /Jobs\/\n├── Bathroom[\s\S]*Tasks\/[\s\S]*Demo[\s\S]*Steiner Kitchen[\s\S]*Order cabinets  \(Tasks\/Order cabinets\.md\)/);
  assert.match(tree, /Estimating guide[\s\S]*Pricing/);
  assert.match(read(".surface/views/sidebar.yaml"), /surface_view: 1/);
  edit(".surface/views/sidebar.yaml", (s) => s.replace("from: task", "from: tsak"));
  assert.match(run(["push"], { fail: true }), /rejected[\s\S]*no type "tsak"/);
  run(["pull", "--force"]);
  assert.match(run(["status"]), /Clean/);
  ok("views tree: init, edit the YAML, check, push, draw with paths; invalid tree rejected");

  const flat = path.join(tmp, "flat");
  run(["init", flat, "--workspace", wsName, "--layout", "flat", "--only", "task"], { cwd: tmp });
  assert.deepEqual(fs.readdirSync(flat).filter((f) => f.endsWith(".md")).sort(), ["AGENTS.md", "Demo.md", "Order cabinets.md"]);
  ok("second checkout: flat layout, tasks only");

  console.log(`\nall ${step} passed`);
} finally {
  // clean up the test workspace
  try {
    run(["workspace", "delete", wsName, "--yes"], { cwd: tmp });
    assert.match(run(["workspace", "list"], { cwd: tmp }), /^(?![\s\S]*e2e)/);
    console.log("cleaned up test workspace");
  } catch (e) {
    console.error("cleanup failed:", e);
    process.exitCode = 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
