// Links that survive renames, aliases, unresolved links, vaults of one folder, and import.
//   npm run test:links   (local store, temp folder)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "../bin/surface");
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "surface-links-"));
const vault = path.join(tmp, "vault");
const env = { ...process.env, SURFACE_STORE: "local", SURFACE_CONFIG_DIR: path.join(tmp, ".cfg"), SURFACE_DATA_DIR: path.join(tmp, ".data"), SURFACE_LOG_FILE: "off", NO_COLOR: "1" };

function run(args: string[], cwd = vault): string {
  try {
    return execFileSync(BIN, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`surface ${args.join(" ")} failed (${err.status}):\n${err.stdout}\n${err.stderr}`);
  }
}
const read = (rel: string, root = vault) => fs.readFileSync(path.join(root, rel), "utf8");
const write = (rel: string, s: string, root = vault) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), s);
};
let step = 0;
const ok = (name: string) => console.log(`ok ${++step} ${name}`);

try {
  // an Obsidian-style source: folders, aliases, typed links, a link with a label and a heading, one to nothing
  const src = path.join(tmp, "source");
  write("wiki/Zones.md", "---\naliases: [Zone 1, permaculture zones]\n---\n\n# Zones\n\nSee [[Sheet Mulching]] and [[Sectors|sector analysis]].\n\n## Zone 1\n\nKitchen garden.\n", src);
  write("wiki/Sheet Mulching.md", "---\naliases: [lasagna gardening]\n---\n\nStart in [[Zone 1]]. Read [[Zones#Zone 1]]. Later: [[Hugelkultur]].\n\n`[[not a link]]`\n\n![[photo.png]]\n", src);
  write("wiki/Sectors.md", "Wind and sun. Back to [[permaculture zones]].\n", src);
  write("projects/Garden plan.md", "---\nstatus: active\n---\n\nUse [[lasagna gardening]] in [[Zones|the zones]].\n", src);
  write("wiki/photo.png", "png", src);

  run(["vault", "new", vault, "--create", "Links test"], tmp);
  run(["field", "add", "page", "status", "--kind", "text"]);
  const imp = run(["import", src]);
  assert.match(imp, /Copied 4 note\(s\) and 1 other file/);
  assert.ok(fs.existsSync(path.join(vault, "wiki/photo.png")));
  ok("import a folder of notes: folders kept, attachments copied");

  // files read exactly as typed (links shown by current name), the database stores ids
  const sheet = read("wiki/Sheet Mulching.md");
  assert.match(sheet, /Start in \[\[Zones\|Zone 1\]\]\. Read \[\[Zones#Zone 1\]\]\. Later: \[\[Hugelkultur\]\]\./);
  assert.match(sheet, /`\[\[not a link\]\]`/);
  assert.match(sheet, /!\[\[photo\.png\]\]/);
  assert.match(sheet, /aliases:\n  - lasagna gardening/);
  assert.match(read("projects/Garden plan.md"), /Use \[\[Sheet Mulching\|lasagna gardening\]\] in \[\[Zones\|the zones\]\]\./);
  const stored = JSON.parse(run(["show", "Sheet Mulching", "--json"]));
  assert.match(stored.body, /\[\[id:[0-9a-z]+\|Zone 1\]\]/);
  assert.match(stored.body, /\[\[id:[0-9a-z]+#Zone 1\]\]/);
  assert.match(stored.body, /\[\[Hugelkultur\]\]/);
  assert.deepEqual(stored.aliases, ["lasagna gardening"]);
  ok("links stored by id (aliases, headings, labels); code, attachments and unknown names left as typed");

  assert.match(run(["links"]), /\[\[Hugelkultur\]\]\s+1\s+Sheet Mulching/);
  ok("unresolved links listed");

  // rename: every link follows, with no rewrite of the linking pages in the database
  const before = JSON.parse(run(["show", "Garden plan", "--json"])).rev;
  run(["set", "Zones", "title=Permaculture Zones"]);
  assert.ok(fs.existsSync(path.join(vault, "wiki/Permaculture Zones.md")));
  assert.match(read("wiki/Sheet Mulching.md"), /Start in \[\[Permaculture Zones\|Zone 1\]\]\. Read \[\[Permaculture Zones#Zone 1\]\]/);
  assert.match(read("projects/Garden plan.md"), /in \[\[Permaculture Zones\|the zones\]\]/);
  assert.equal(JSON.parse(run(["show", "Garden plan", "--json"])).rev, before);
  ok("rename a page: links in every file follow, linking records unchanged");

  // the missing page gets created: the typed link resolves
  write("wiki/Hugelkultur.md", "Wood under soil.\n");
  run(["push", "--new"]);
  assert.match(JSON.parse(run(["show", "Sheet Mulching", "--json"])).body, /Later: \[\[id:[0-9a-z]+\]\]/);
  assert.match(run(["links"]), /Every link points at a record/);
  ok("creating a missing page resolves links to it");

  // edit in another editor: typed links become ids, an edited alias list is saved
  const sp = "wiki/Sectors.md";
  write(sp, read(sp).replace(/\n*$/, "\nAlso [[Hugelkultur]].\n").replace("title: Sectors", "title: Sectors\naliases: [sector analysis]"));
  run(["push"]);
  const sec = JSON.parse(run(["show", "Sectors", "--json"]));
  assert.equal((sec.body.match(/\[\[id:/g) ?? []).length, 2);
  assert.deepEqual(sec.aliases, ["sector analysis"]);
  ok("edits in another editor: links stored by id, aliases saved");

  // a second vault of just one folder, in the same workspace
  const wiki = path.join(tmp, "wiki-only");
  run(["vault", "new", wiki, "--workspace", "Links test", "--under", "wiki"], tmp);
  assert.ok(fs.existsSync(path.join(wiki, "Sheet Mulching.md")));
  assert.ok(!fs.existsSync(path.join(wiki, "Garden plan.md")));
  assert.match(read("Sheet Mulching.md", wiki), /Start in \[\[Permaculture Zones\|Zone 1\]\]/);
  write("New idea.md", "Links to [[Sectors]].\n", wiki);
  run(["push", "--new"], wiki);
  run(["pull"]);
  assert.ok(fs.existsSync(path.join(vault, "wiki/New idea.md")), "a note made in the wiki-only vault lands in wiki/");
  assert.match(run(["vault", "list"], tmp), /wiki-only\s+folder\s+folder wiki/);
  ok("a second vault of one folder: paths inside it, new notes land in that folder, vault list");

  console.log("\nall " + step + " passed");
} finally {
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
}
