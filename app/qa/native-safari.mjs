// Real macOS Safari via its bundled WebDriver, with a disposable local server.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

assert.equal(process.platform, "darwin", "This suite requires macOS Safari");
const driverURL = "http://127.0.0.1:4445";
const base = "http://127.0.0.1:4394";
const marker = new URL("../.browser-qa.json", import.meta.url);
const output = new URL("../test-results/native-safari/", import.meta.url);
fs.mkdirSync(output, { recursive: true });
fs.rmSync(marker, { force: true });
const children = [];
function start(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { child.log = (child.log + bytes).slice(-4000); });
  children.push(child);
  return child;
}
let session, fixture, passes = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${driverURL}/${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(value?.message ?? `WebDriver HTTP ${response.status}`);
  return value;
}
const wd = (path, body, method) => command(`session/${session}/${path}`, body, method);
const js = (fn, ...args) => wd("execute/sync", { script: `return (${fn}).apply(null, arguments)`, args });
async function until(check, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}`);
}
async function element(selector) {
  return wd("element", { using: "css selector", value: selector });
}
const elementID = el => el["element-6066-11e4-a52e-4f735466cecf"];
const clickElement = el => wd(`element/${elementID(el)}/click`, {});
const click = async selector => clickElement(await element(selector));
async function button(text) {
  const el = await js(text => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text), text);
  assert(el, `Missing button ${text}`);
  await clickElement(el);
}
async function type(selector, text) {
  const id = elementID(await element(selector));
  await wd(`element/${id}/clear`, {});
  await wd(`element/${id}/value`, { text });
}
async function select(selector, value) {
  await js((selector, value) => {
    const el = document.querySelector(selector);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);
}
async function navigate(path) {
  await wd("url", { url: base + path });
}
const openData = () => navigate(`/data/#/table/task?view=${fixture.view}`);
const readyGrid = () => until(() => js(() => !!document.querySelector(".sg-title-text")), "painted grid");
function alignment() {
  const grid = document.querySelector(".surface-grid");
  const viewport = grid.getBoundingClientRect();
  const headers = new Map([...grid.querySelectorAll('[role="columnheader"]')].map(el => [el.getAttribute("aria-colindex"), el.getBoundingClientRect()]));
  let visible = 0;
  const errors = [];
  for (const row of grid.querySelectorAll(".rdg-row")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top + 34 || rect.top >= viewport.bottom) continue;
    visible++;
    for (const cell of row.querySelectorAll('[role="gridcell"]')) {
      const box = cell.getBoundingClientRect(), header = headers.get(cell.getAttribute("aria-colindex"));
      if (header && box.width > 0 && Math.abs(box.x - header.x) > 1) errors.push(cell.textContent);
      if (Math.abs(box.y - rect.y) > 1 || Math.abs(box.height - rect.height) > 1) errors.push(`height: ${cell.textContent}`);
    }
  }
  return visible ? errors : ["No visible rows"];
}
async function aligned() { await until(async () => (await js(alignment)).length === 0, "aligned headers and rows"); }
async function screenshot(name) {
  fs.writeFileSync(new URL(`${name}.png`, output), Buffer.from(await wd("screenshot"), "base64"));
}
const pass = label => { console.log(`PASS ${++passes} ${label}`); };
async function api(path) {
  const response = await fetch(base + path, { headers: { cookie: `surface_token=${fixture.token}` } });
  assert(response.ok, `API ${path}: ${response.status}`);
  return response.json();
}

try {
  const driver = start("/usr/bin/safaridriver", ["-p", "4445"]);
  await until(async () => {
    if (driver.exitCode !== null) throw new Error(driver.log);
    try { return !!(await command("status")); } catch { return false; }
  }, "Safari driver startup");
  const created = await command("session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  session = created.sessionId;
  console.log(`Installed Safari ${created.capabilities.browserVersion}`);
  const server = start(process.execPath, ["qa/browser-server.mjs"]);
  await until(async () => {
    if (server.exitCode !== null) throw new Error(server.log);
    return fs.existsSync(marker);
  }, "isolated database startup", 120_000);
  fixture = JSON.parse(fs.readFileSync(marker, "utf8"));
  await wd("window/rect", { width: 1440, height: 900 });
  await navigate(`/data/?token=${fixture.token}#/table/task?view=${fixture.view}`);
  await readyGrid();
  assert((await js(() => document.querySelectorAll(".rdg-row").length)) < 150);
  await aligned();
  pass("production table loads with row virtualization");

  for (let i = 0; i < 32; i++) {
    await js(i => document.querySelector(".surface-grid").scrollTo((i * 173) % 700, (i * 1291) % 10500), i);
    await aligned();
  }
  await screenshot("scroll");
  pass("32 two-axis scrolling reversals keep cells aligned with headers");

  await openData(); await readyGrid();
  await click('.rdg-row input[aria-label="Select"]');
  await until(() => js(() => document.querySelector(".sg-selection")?.textContent.includes("1 selected")), "row selection");
  await button("Clear");
  await click('[role="columnheader"][aria-colindex="2"]');
  await until(() => js(() => document.querySelector(".sg-title-text")?.textContent === "Task 0319"), "descending sort");
  await button("Group");
  await select('[aria-label="Pick a field to group by"]', "status");
  await until(() => js(() => !!document.querySelector('.surface-grid[role="treegrid"]')), "grouped table");
  await button("Collapse all");
  await until(() => js(() => document.querySelectorAll(".rdg-row").length === 3), "collapsed groups");
  await button("Expand all");
  await readyGrid();
  await click(".data-table-heading h1");
  await button("Hide fields"); await button("Tall");
  await until(() => js(() => !!document.querySelector(".sg-rows-tall")), "tall rows");
  await click(".data-table-heading h1");
  await js(() => document.querySelector(".surface-grid").scrollTo(250, 2600));
  await aligned();
  await type('[aria-label="Search records"]', "Task 0301");
  await until(() => js(() => document.querySelectorAll(".sg-title-text").length === 1 && document.querySelector(".sg-title-text").textContent === "Task 0301"), "record search");
  pass("selection, sorting, grouping, collapse/expand, tall rows and search");

  await openData(); await readyGrid();
  await click('.rdg-row[aria-rowindex="2"] .sg-title');
  await wd("actions", { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: " " }, { type: "keyUp", value: " " }] }] });
  await until(() => js(() => !!document.querySelector('[aria-label="Record notes"]')), "record sheet");
  await type('[aria-label="Record notes"]', "Saved from installed Safari");
  await button("Save record");
  await until(async () => (await api(`/api/record/${fixture.records[0]}`)).record.body === "Saved from installed Safari", "saved record data");
  await click('[aria-label="Close record"]');
  pass("keyboard opens record sheet and edits persist through the real API");

  await navigate(`/index.html#/r/${fixture.records[1]}`);
  await until(() => js(() => !!document.querySelector(".cm-content")), "Markdown editor");
  await click(".cm-content");
  const editor = elementID(await element(".cm-content"));
  await wd(`element/${editor}/value`, { text: "Native Safari autosave " });
  await until(async () => (await api(`/api/record/${fixture.records[1]}`)).record.body.includes("Native Safari autosave"), "Markdown autosave");
  await navigate(`/index.html#/v/${fixture.view}`); await readyGrid();
  await js(() => document.querySelector(".surface-grid").scrollTo(400, 4200));
  await aligned();
  pass("Vault Markdown autosave and saved table scrolling");

  await openData(); await readyGrid();
  await click(".app-account-trigger");
  await select('[aria-label="Theme"]', "dark");
  await wd("refresh", {}); await readyGrid();
  assert.equal(await js(() => document.documentElement.dataset.theme), "dark");
  await wd("window/rect", { width: 800, height: 850 });
  await aligned();
  assert(await js(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot("narrow-dark");
  pass("dark theme persists and resized table stays within viewport");

  const state = await api("/api/state");
  for (const suffix of ["/", "/data/"]) {
    const start = `/w/${state.workspace.id}${suffix}`;
    await navigate(start);
    const manifest = await wd("execute/async", { script: "fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json()).then(arguments[0]);", args: [] });
    assert.equal(manifest.start_url, start);
    assert.equal(manifest.id, start);
    assert.equal(manifest.scope, start);
    assert.equal(manifest.display, "standalone");
  }
  pass("both install manifests preserve app/workspace identity");
  fs.writeFileSync(new URL("result.json", output), JSON.stringify({ browser: created.capabilities, checks: passes, status: "passed" }, null, 2));
  console.log(`${passes} installed Safari checks passed`);
} catch (error) {
  if (session) await screenshot("failure").catch(() => {});
  throw error;
} finally {
  if (session) await command(`session/${session}`, undefined, "DELETE").catch(() => {});
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}
