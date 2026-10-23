// Exercise real npm builds without touching the installed app, server, or database.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apps } from "../../surfaces.mts";
import { ensureAppBuild } from "../src/app-build.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-app-build-test-"));
const app = path.join(root, "app");
const dist = path.join(app, "dist");
const stamp = path.join(dist, "surface-build.json");
const input = path.join(app, "build-input.json");
const log = path.join(app, "builds.jsonl");
const installed = { number: "0.1.1", commit: "3ed43b18470c9598a7960336f6744772249efc63" };
const old = { number: "0.1.0", commit: "52d97ac3fa576a00614c34f761a5505cd08e4d43" };
type Version = typeof installed | { number: string; commit: null };

function configure(version: Version, title: string, mode = "success") {
  fs.writeFileSync(input, JSON.stringify({ version, title, mode, entries: apps.map(app => app.entry) }));
}
function builds() {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
}
function assertUI(title: string, version: Version) {
  for (const app of apps) {
    const html = fs.readFileSync(path.join(dist, app.entry), "utf8");
    assert.ok(html.includes(`<h1>${title}</h1>`), `${app.entry} serves the requested UI`);
    assert.ok(html.includes(`<p>${version.number} / ${version.commit ?? "archive"}</p>`), `${app.entry} renders the build version`);
    assert.ok(html.includes(`<title>${app.id}</title>`), `${app.entry} is its own app entry`);
  }
}
function snapshotDist() {
  return Object.fromEntries(["surface-build.json", ...apps.map(app => app.entry)].map(file => [file, fs.readFileSync(path.join(dist, file), "utf8")]));
}
function directoryContents() {
  return { root: fs.readdirSync(root).sort(), app: fs.readdirSync(app).sort() };
}

try {
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { build: "node build.mjs" } }));
  // This is an actual npm build program: it compiles fixture source data into HTML,
  // accepts Vite's outDir option, and deliberately writes partial output on failure.
  fs.writeFileSync(path.join(app, "build.mjs"), `
import fs from "node:fs";
import path from "node:path";
const input = JSON.parse(fs.readFileSync("build-input.json", "utf8"));
const option = process.argv.indexOf("--outDir");
if (option < 0 || !process.argv[option + 1]) throw new Error("Build must provide a staging outDir");
const out = path.resolve(process.argv[option + 1]);
if (out === path.resolve("dist")) throw new Error("Build must not overwrite live assets");
fs.appendFileSync("builds.jsonl", JSON.stringify({ out, title: input.title }) + "\\n");
fs.mkdirSync(out, { recursive: true });
for (const entry of input.entries) {
  if (input.mode === "missing-entry" && entry === input.entries.at(-1)) continue;
  const id = ${JSON.stringify(Object.fromEntries(apps.map(app => [app.entry, app.id])))}[entry];
  fs.writeFileSync(path.join(out, entry), "<!doctype html><title>" + id + "</title><h1>" + input.title + "</h1><p>" + input.version.number + " / " + (input.version.commit ?? "archive") + "</p>");
  if (input.mode === "fail") {
    console.error("Fixture build failed after partial HTML output");
    process.exit(17);
  }
}
if (input.mode !== "missing-stamp") {
  const version = input.mode === "wrong-version" ? { ...input.version, commit: "wrong-build" } : input.version;
  fs.writeFileSync(path.join(out, "surface-build.json"), input.mode === "invalid-stamp" ? "{invalid" : JSON.stringify(version));
}
`);

  fs.mkdirSync(dist);
  for (const app of apps) fs.writeFileSync(path.join(dist, app.entry), `<!doctype html><h1>Stale installed UI</h1><p>${old.commit}</p>`);
  fs.writeFileSync(stamp, JSON.stringify(old));
  configure(installed, "Current installed UI");
  const layout = directoryContents();
  // Build logging is the only persistent new fixture file after a successful build.
  fs.writeFileSync(log, "");
  layout.app.push(path.basename(log));
  layout.app.sort();
  ensureAppBuild(root, installed);
  assert.equal(builds(), 1);
  assertUI("Current installed UI", installed);
  assert.deepEqual(directoryContents(), layout, "successful publication removes staging and backup directories");

  configure(installed, "This build must never run", "fail");
  const current = snapshotDist();
  ensureAppBuild(root, installed);
  assert.equal(builds(), 1, "a matching complete build is reused without invoking npm");
  assert.deepEqual(snapshotDist(), current);

  const staleCases: [string, () => void][] = [
    ["missing stamp", () => fs.rmSync(stamp)],
    ["invalid JSON stamp", () => fs.writeFileSync(stamp, "{invalid")],
    ["invalid stamp shape", () => fs.writeFileSync(stamp, JSON.stringify({ number: installed.number }))],
    ["mismatched number", () => fs.writeFileSync(stamp, JSON.stringify({ ...installed, number: old.number }))],
    ["mismatched commit", () => fs.writeFileSync(stamp, JSON.stringify({ ...installed, commit: old.commit }))],
    ["missing app entry", () => fs.rmSync(path.join(dist, apps.at(-1)!.entry))],
    ["app entry is a directory", () => {
      const entry = path.join(dist, apps.at(-1)!.entry);
      fs.rmSync(entry);
      fs.mkdirSync(entry);
    }],
  ];
  for (const [reason, invalidate] of staleCases) {
    invalidate();
    configure(installed, `Rebuilt after ${reason}`);
    const before = builds();
    ensureAppBuild(root, installed);
    assert.equal(builds(), before + 1, `${reason} cannot pass the freshness check`);
    assertUI(`Rebuilt after ${reason}`, installed);
    assert.deepEqual(directoryContents(), layout);
  }

  const archive = { number: installed.number, commit: null };
  configure(archive, "Source archive UI");
  const beforeArchive = builds();
  ensureAppBuild(root, archive);
  assert.equal(builds(), beforeArchive + 1, "a null archive commit does not match a Git build");
  assertUI("Source archive UI", archive);
  configure(archive, "Archive must not rebuild", "fail");
  ensureAppBuild(root, archive);
  assert.equal(builds(), beforeArchive + 1, "matching number plus null commit is current");
  const nextArchive = { number: "0.1.2", commit: null };
  configure(nextArchive, "Updated archive UI");
  ensureAppBuild(root, nextArchive);
  assert.equal(builds(), beforeArchive + 2, "archive freshness still compares package numbers");
  assertUI("Updated archive UI", nextArchive);

  for (const mode of ["fail", "missing-stamp", "invalid-stamp", "wrong-version", "missing-entry"]) {
    const oldAssets = snapshotDist();
    const before = builds();
    configure(installed, `Unpublishable ${mode} UI`, mode);
    assert.throws(() => ensureAppBuild(root, installed), /build|assets|npm|HTML|entry|version|stamp/i, `${mode} must produce an actionable build error`);
    assert.equal(builds(), before + 1, `${mode} actually attempted an isolated build`);
    assert.deepEqual(snapshotDist(), oldAssets, `${mode} preserves every previously readable app page`);
    assertUI("Updated archive UI", nextArchive);
    assert.deepEqual(directoryContents(), layout, `${mode} removes partial build staging directories`);
  }
  console.log("App build: stale UI replaced, current builds reused, incomplete output rejected, archive versions supported, and failed builds preserve live HTML.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
