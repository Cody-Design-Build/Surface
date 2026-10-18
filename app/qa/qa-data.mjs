// In-memory DOM integration against an isolated, real local Postgres workspace.
// Requires: surface data --port 4392 --no-watch in a workspace named Data Surface QA.
// DATA_QA_CONFIG points to its isolated SURFACE_CONFIG_DIR. Never use business data.
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";

const base = process.env.DATA_QA_BASE ?? "http://127.0.0.1:4392";
const config = process.env.DATA_QA_CONFIG;
assert(config, "Set DATA_QA_CONFIG to an isolated test configuration directory");
const token = fs.readFileSync(`${config}/serve-token`, "utf8").trim();
const nativeFetch = globalThis.fetch;
async function request(path, method = "GET", body) {
  const r = await nativeFetch(new URL(path, base), { method, headers: { cookie: `surface_token=${token}`, origin: base, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json();
  return { status: r.status, ...data };
}
const initial = await request("/api/state");
assert.equal(initial.workspace.name, "Data Surface QA", "Refusing to test a business workspace");
const suffix = Date.now().toString(36);
const orgKey = `org_${suffix}`, contactKey = `contact_${suffix}`, emptyKey = `empty_${suffix}`;
for (const [key, name] of [[orgKey, `Companies ${suffix}`], [contactKey, `Contacts ${suffix}`], [emptyKey, `Empty ${suffix}`]]) {
  assert.equal((await request("/api/types", "POST", { key, name })).status, 200);
}
assert.equal((await request(`/api/type/${contactKey}`, "PUT", { fields: [
  { key: "email", name: "Email", kind: "email" },
  { key: "status", name: "Status", kind: "select", options: ["Active", "Inactive"] },
  { key: "organization", name: "Organization", kind: "link", target: orgKey },
] })).status, 200);
const company = (await request("/api/records", "POST", { type: orgKey, title: `Company ${suffix}` })).record;
const contact = (await request("/api/records", "POST", { type: contactKey, title: `Person ${suffix}`, fields: { organization: company.id, status: "Active" } })).record;

registerHooks({ load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return nextLoad(url, context); } });
const window = new Window({ url: `${base}/data/#/table/${contactKey}` });
for (const key of ["window", "document", "navigator", "location", "history", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "DOMRect", "getComputedStyle"]) {
  const value = key === "window" ? window : window[key];
  Object.defineProperty(globalThis, key, { value: typeof value === "function" && key === "getComputedStyle" ? value.bind(window) : value, configurable: true });
}
window.confirm = () => true;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
class ResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ target, contentRect: { width: 1200, height: 600 }, contentBoxSize: [{ inlineSize: 1200, blockSize: 600 }], borderBoxSize: [{ inlineSize: 1200, blockSize: 600 }] }]); }
  disconnect() {} unobserve() {}
}
globalThis.ResizeObserver = window.ResizeObserver = ResizeObserver;
globalThis.EventSource = class { constructor() { queueMicrotask(() => this.onopen?.()); } close() {} };
globalThis.fetch = (url, opts = {}) => nativeFetch(new URL(url, base), { ...opts, headers: { ...opts.headers, cookie: `surface_token=${token}`, origin: base } });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DataApp } = await import("../src/DataApp.tsx");
document.body.innerHTML = '<div id="root"></div>';
const root = createRoot(document.querySelector("#root"));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => { await pause(30); });
  }
  throw new Error(`Timed out: ${label}`);
}
const button = text => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text);
async function click(el) { assert(el, "Missing expected button"); await act(async () => { el.click(); }); }
async function input(el, value) {
  assert(el, "Missing input");
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value); el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
}
// Direct API calls made while the UI is mounted run inside act so React's resulting reloads are flushed, not warned about.
async function settled(...args) { let result; await act(async () => { result = await request(...args); await pause(30); }); return result; }
let passes = 0;
function pass(label) { passes++; console.log(`PASS ${label}`); }

try {
  await act(async () => { root.render(createElement(DataApp)); });
  await until(() => document.querySelectorAll(".data-table-link").length >= 4, "table navigation");
  assert(!document.querySelector(".sidebar"));
  pass("independent shell lists every type without the writing sidebar");
  await until(() => document.querySelector(".data-grid-area"), "grid load");
  assert.equal(document.querySelector(".data-table-heading h1").textContent, `Contacts ${suffix}`);
  assert(document.querySelector('.data-view-tabs button').textContent.includes("All records"));
  pass("a type with no saved views opens immediately as an editable table");
  await click([...document.querySelectorAll(".data-table-link")].find(el => el.textContent.includes(`Empty ${suffix}`)));
  await until(() => document.querySelector(".data-empty"), "empty table");
  pass("empty types are navigable and offer record creation");
  await click([...document.querySelectorAll(".data-table-link")].find(el => el.textContent.includes(`Contacts ${suffix}`)));
  await until(() => document.querySelector(".data-footer")?.textContent.includes("1 record"), "contact table");
  await click(button("Add record"));
  await until(() => document.querySelector('[aria-label="Record title"]'), "record sheet");
  await input(document.querySelector('[aria-label="Record title"]'), `Edited ${suffix}`);
  await input(document.querySelector('[aria-label="Record notes"]'), "Notes saved from the standalone data surface.");
  await click(button("Save record"));
  await until(() => document.querySelector(".data-sheet footer span")?.textContent === "Saved", "record save");
  const edited = (await settled("/api/query", "POST", { from: contactKey })).records.find(r => r.title === `Edited ${suffix}`);
  assert.equal(edited.body, "Notes saved from the standalone data surface.");
  pass("record creation and detail edits persist through the real local API");
  const organizationRow = [...document.querySelectorAll(".prop")].find(el => el.querySelector(".prop-label")?.textContent === "Organization");
  assert(organizationRow, "Relationship property is present");
  const linkButton = organizationRow.querySelector("button");
  await click(linkButton);
  await until(() => [...document.querySelectorAll(".menu-item")].some(el => el.textContent.includes(company.title)), "relationship picker");
  await click([...document.querySelectorAll(".menu-item")].find(el => el.textContent.includes(company.title)));
  await click(button("Save record"));
  await until(() => document.querySelector(".data-sheet footer span")?.textContent === "Saved", "relationship save");
  assert.equal((await settled(`/api/record/${edited.id}`)).record.fields.organization, company.id);
  pass("relationship picker links to an existing record using its stable ID");
  // Draft guard: back/forward (hashchange) with unsaved edits asks first; declining keeps the sheet and URL.
  await input(document.querySelector('[aria-label="Record notes"]'), "Unsaved draft");
  const hashBefore = location.hash;
  let prompts = 0;
  window.confirm = () => { prompts++; return false; };
  await act(async () => { location.hash = `/table/${orgKey}`; await pause(60); });
  assert.equal(prompts, 1, `navigating away with a draft prompts once (got ${prompts})`);
  assert(document.querySelector('[aria-label="Record title"]'), "declining keeps the record sheet open");
  assert.equal(location.hash, hashBefore, `declining restores the URL (got ${location.hash}, href ${location.href})`);
  assert.equal(document.querySelector('[aria-label="Record notes"]').value, "Unsaved draft");
  window.confirm = () => { prompts++; return true; };
  await click(document.querySelector('[aria-label="Close record"]'));
  assert.equal(prompts, 2); assert(!document.querySelector('[aria-label="Record title"]'));
  await click([...document.querySelectorAll(".data-table-link")].find(el => el.textContent.includes(`Companies ${suffix}`)));
  assert.equal(prompts, 2, "no stale second prompt after the draft was discarded");
  await click([...document.querySelectorAll(".data-table-link")].find(el => el.textContent.includes(`Contacts ${suffix}`)));
  await until(() => document.querySelector(".data-footer")?.textContent.includes("2 records"), "contact table again");
  pass("unsaved record drafts are guarded on back/forward and navigation, prompting once");
  await click(button("Filter"));
  await until(() => document.querySelector('[aria-label="Filter table"]'), "filter editor");
  await click(button("Add a condition"));
  const selects = document.querySelectorAll(".ve-cond select");
  await input(selects[0], "status");
  await input(document.querySelector(".ve-cond select:last-of-type"), "Active");
  // Set via the value select explicitly; its label is not an operator.
  const valueSelect = document.querySelectorAll(".ve-cond select")[2];
  if (valueSelect) await input(valueSelect, "Active");
  await click(button("Apply filters"));
  await until(() => document.querySelector(".data-filter-summary"), "applied filter");
  assert(document.querySelector(".data-filter-summary").textContent.includes("status=Active"));
  await click(button("Save as view"));
  await input(document.querySelector('.data-save-body input'), `Active ${suffix}`);
  await click(document.querySelector('.data-save-body button'));
  await until(() => [...document.querySelectorAll(".data-view-tabs button")].some(el => el.textContent.includes(`Active ${suffix}`)), "saved view");
  const state = await settled("/api/state");
  const view = state.views.find(v => v.name === `Active ${suffix}`);
  assert(view.personal); assert.equal(view.definition.where, "status=Active");
  assert.deepEqual(view.definition.layouts[0].columns, ["email", "status", "organization"]);
  pass("personal saved view persists its filters and column configuration");
  const limited = (await settled("/api/views", "POST", { name: `Top one ${suffix}`, personal: true, definition: { from: contactKey, sort: "title", limit: 1, layouts: [{ show: "table" }] } })).view;
  assert(limited, "limited view created");
  // The test's EventSource stub never pushes; use the in-app Refresh, as a live server push would.
  await click([...document.querySelectorAll(".data-footer button")].find(el => el.textContent.includes("Refresh")));
  await until(() => [...document.querySelectorAll(".data-view-tabs button")].some(el => el.textContent.includes(`Top one ${suffix}`)), "limited view listed");
  await act(async () => { location.hash = `/table/${contactKey}?view=${limited.key}&personal=1`; await pause(60); });
  await until(() => document.querySelector(".data-view-tabs .is-active")?.textContent.includes(`Top one ${suffix}`), "limited view open");
  await until(() => document.querySelector(".data-footer")?.textContent.startsWith("1 record"), "limit applied");
  pass("saved view row limit is honored");
  // Airtable-style Group: multi-level, persisted in the view, groups shown with counts, collapse/expand all.
  await act(async () => { location.hash = `/table/${contactKey}`; await pause(60); });
  await until(() => document.querySelector(".data-view-tabs .is-active")?.textContent.includes("All records"), "all records");
  await until(() => document.querySelector(".data-grid-area") && button("Group"), `group button (buttons: ${[...document.querySelectorAll(".data-toolbar button")].map(b => b.textContent.trim()).join(" | ")})`);
  await click(button("Group"));
  await until(() => document.querySelector('[role="dialog"][aria-label="Group records"]'), "group panel");
  await input(document.querySelector('[aria-label="Pick a field to group by"]'), "status");
  await until(() => document.querySelector('[aria-label="Add subgroup"]'), "subgroup offered");
  await input(document.querySelector('[aria-label="Add subgroup"]'), "organization");
  await input(document.querySelector('[aria-label="Group level 2 direction"]'), "DESC");
  await until(() => button("Grouped by 2 fields"), "group button summary");
  await until(() => document.querySelectorAll(".sg-group").length >= 2, "group rows rendered");
  const groupTexts = [...document.querySelectorAll(".sg-group")].map(el => el.textContent);
  assert(groupTexts.some(t => t.includes("Active") && t.includes("Status")), `status group shown (${groupTexts.join(" | ")})`);
  await click(button("Collapse all"));
  await until(() => [...document.querySelectorAll('[role="row"][aria-level="1"]')].every(r => r.getAttribute("aria-expanded") === "false"), "collapsed");
  await click(button("Expand all"));
  await until(() => [...document.querySelectorAll('[role="row"][aria-level="1"]')].every(r => r.getAttribute("aria-expanded") === "true"), "expanded");
  await act(async () => { document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); });
  // Sort panel, then save as a view: both persist in the definition and the server accepts multi-level group
  // the default table view sorts by title, so the button already summarizes one sort level
  await click([...document.querySelectorAll(".data-toolbar button")].find(el => /^Sort(ed by \d+ fields?)?$/.test(el.textContent.trim())));
  await until(() => document.querySelector('[role="dialog"][aria-label="Sort records"]'), "sort panel");
  await input(document.querySelector('[aria-label="Sort level 1 direction"]'), "DESC");
  await until(() => button("Sorted by 1 field"), "sort summary");
  await act(async () => { document.body.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); });
  await click(button("Save as view"));
  await input(document.querySelector('.data-save-body input'), `Grouped ${suffix}`);
  await click(document.querySelector('.data-save-body button'));
  await until(() => [...document.querySelectorAll(".data-view-tabs button")].some(el => el.textContent.includes(`Grouped ${suffix}`)), "grouped view saved");
  const groupedView = (await settled("/api/state")).views.find(v => v.name === `Grouped ${suffix}`);
  assert.equal(groupedView.definition.layouts[0].group, "status,-organization");
  assert.equal(groupedView.definition.sort, "-title");
  const tooDeep = await settled("/api/views", "POST", { name: `Too deep ${suffix}`, personal: true, definition: { from: contactKey, layouts: [{ show: "table", group: "status,organization,email,title" }] } });
  assert.equal(tooDeep.status, 422, "more than three group levels is rejected");
  pass("Airtable-style Group (up to 3 levels, direction, collapse/expand all) and Sort persist in saved views");
  // New table: generic, name only; no domain-specific relationships are offered or created.
  await click(document.querySelector('[aria-label="Add table or folder"]'));
  await click([...document.querySelectorAll(".data-add-menu .menu-item")].find(el => el.textContent.includes("New table")));
  await until(() => document.querySelector('[aria-label="New table"][role="dialog"]'), "new table dialog");
  const dialogText = document.querySelector('[role="dialog"][aria-label="New table"]').textContent;
  assert(!/job/i.test(dialogText), "new-table dialog offers no business-specific links");
  await input(document.querySelector('[role="dialog"] input'), `Equipment ${suffix}`);
  await click(button("Create table"));
  await until(() => document.querySelector(".data-table-heading h1")?.textContent === `Equipment ${suffix}`, "new table opens");
  const equipment = (await settled("/api/state")).types.find(t => t.name === `Equipment ${suffix}`);
  assert(equipment); assert.deepEqual(equipment.fields, [], "new table starts with no fields");
  pass("new tables are generic: name only, opened immediately, no preset fields");
  // Add field: every field has an explicit type; a relationship is the "Link to another record" type with a chosen table.
  await click(button("Add field"));
  await until(() => document.querySelector('[role="dialog"][aria-label="Add field"]'), "add field dialog");
  await input(document.querySelector('[role="dialog"][aria-label="Add field"] input'), "Assigned company");
  await input(document.querySelector('[aria-label="Field type"]'), "link");
  assert(button("Create field").disabled, "a link field cannot be created without choosing a table");
  await input(document.querySelector('[aria-label="Link to table"]'), orgKey);
  await click(button("Create field"));
  await until(() => !document.querySelector('[aria-label="Add field"][role="dialog"]'), "field saved");
  const linked = (await settled("/api/state")).types.find(t => t.key === equipment.key).fields.find(f => f.name === "Assigned company");
  assert.equal(linked.kind, "link"); assert.equal(linked.target, orgKey); assert.equal(linked.multiple, true);
  await click(button("Add field"));
  await input(document.querySelector('[role="dialog"][aria-label="Add field"] input'), "Condition");
  await input(document.querySelector('[aria-label="Field type"]'), "select");
  await click(button("Create field"));
  await until(() => !document.querySelector('[aria-label="Add field"][role="dialog"]'), "select field saved");
  const cond = (await settled("/api/state")).types.find(t => t.key === equipment.key).fields.find(f => f.name === "Condition");
  assert.equal(cond.kind, "select"); assert.deepEqual(cond.options, ["Option 1", "Option 2"]);
  pass("fields are created with an explicit field type; relationships are link fields to a chosen table");
  // Folders in the tables list: organization only, shared, persisted as the "tables" tree view.
  await click(document.querySelector('[aria-label="Add table or folder"]'));
  await click([...document.querySelectorAll(".data-add-menu .menu-item")].find(el => el.textContent.includes("New folder")));
  await until(() => document.querySelector('[aria-label="Folder name"]'), "folder name input");
  const folderInput = document.querySelector('[aria-label="Folder name"]');
  await input(folderInput, `Assets ${suffix}`);
  await act(async () => folderInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await until(() => [...document.querySelectorAll(".data-folder-head")].some(el => el.textContent.includes(`Assets ${suffix}`)), "folder created");
  await click(document.querySelector(`[aria-label="Organize Equipment ${suffix}"]`));
  await click([...document.querySelectorAll(".data-nav-menu .menu-item")].find(el => el.textContent.includes(`Assets ${suffix}`)));
  const folderEl = () => [...document.querySelectorAll(".data-folder")].find(el => el.querySelector(".data-folder-head")?.textContent.includes(`Assets ${suffix}`));
  await until(() => folderEl()?.querySelector(".is-nested")?.textContent.includes(`Equipment ${suffix}`), "table in folder");
  let tables;
  for (let i = 0; i < 40; i++) { tables = (await settled("/api/state")).tables.definition.items; if (tables.find(x => x.group === `Assets ${suffix}`)?.items?.length) break; }
  assert.deepEqual(tables.find(i => i.group === `Assets ${suffix}`).items, [{ query: { from: equipment.key } }], "folder change persisted on the server");
  await click([...document.querySelectorAll(".data-folder-head")].find(el => el.textContent.includes(`Assets ${suffix}`)));
  assert(![...document.querySelectorAll(".data-table-link")].some(el => el.textContent.includes(`Equipment ${suffix}`)), "collapsed folder hides its tables");
  await click([...document.querySelectorAll(".data-folder-head")].find(el => el.textContent.includes(`Assets ${suffix}`)));
  // Remove folder: tables stay
  await click(document.querySelector(`[aria-label="Folder Assets ${suffix} options"]`));
  await click([...document.querySelectorAll(".data-nav-menu .menu-item")].find(el => el.textContent.includes("Remove folder")));
  await until(() => ![...document.querySelectorAll(".data-folder-head")].some(el => el.textContent.includes(`Assets ${suffix}`)), "folder removed");
  assert([...document.querySelectorAll(".data-table-link")].some(el => el.textContent.includes(`Equipment ${suffix}`)), "table remains after folder removal");
  assert(!(await settled("/api/state")).views.some(v => v.key === "tables"), "folder layout is not listed as a data view");
  pass("tables can be organized into collapsible shared folders without changing data");
  // Relationship map: built from typed link fields; focus mode follows links N hops across tables.
  const { buildGraph } = await import("../src/RelationshipGraph.tsx");
  const st = await settled("/api/state");
  const recs = [];
  for (const k of [orgKey, contactKey]) recs.push(...(await settled("/api/query", "POST", { from: k })).records);
  const all = new Set([orgKey, contactKey]);
  const g = buildGraph(st, recs, { tables: all, orphans: false, focus: null, depth: 1 });
  assert(g.links.some(l => l.field === "Organization" && [l.source, l.target].includes(company.id)), "contact→company link is an edge");
  assert(g.nodes.every(n => n.degree > 0), "orphans hidden by default");
  const focused = buildGraph(st, recs, { tables: all, orphans: false, focus: company.id, depth: 1 });
  assert(focused.nodes.some(n => n.id === company.id) && focused.nodes.every(n => n.id === company.id || focused.links.some(l => [l.source, l.target].includes(n.id))), "focus keeps only neighbours");
  const noContacts = buildGraph(st, recs, { tables: new Set([orgKey]), orphans: true, focus: null, depth: 1 });
  assert(noContacts.nodes.every(n => n.table === orgKey) && !noContacts.links.length, "table filter hides a table and its edges");
  await click(document.querySelector(".data-map-link"));
  await until(() => document.querySelector('[aria-label="Relationship map"] canvas') && location.hash === "#/map", "map opens");
  await until(() => /\d+ records · \d+ links/.test(document.querySelector(".data-graph-sub")?.textContent ?? ""), "map counts");
  pass("relationship map draws records and typed links, with table filter and focus depth");
  const bad = await settled(`/api/record/${contact.id}`, "PUT", { baseRev: contact.rev, fields: { status: "not-a-valid-choice" } });
  assert.equal(bad.status, 422);
  const good = await settled(`/api/record/${contact.id}`, "PUT", { baseRev: contact.rev, title: "Changed elsewhere" });
  assert.equal(good.status, 200);
  const stale = await settled(`/api/record/${contact.id}`, "PUT", { baseRev: contact.rev, title: "Stale draft" });
  assert.equal(stale.status, 409);
  pass("invalid values and stale revisions are rejected by the shared data engine");
  const noCookie = await nativeFetch(`${base}/api/state`);
  assert.equal(noCookie.status, 401);
  const auth = await nativeFetch(`${base}/data/?token=${token}`, { redirect: "manual" });
  assert.equal(auth.status, 302); assert.equal(auth.headers.get("location"), "/data/");
  pass("authentication protects the API and token login preserves the standalone entry point");
  console.log(`\n${passes} integration checks passed (in-memory DOM + local Postgres; not a visual browser test).`);
} finally {
  await act(async () => { await pause(50); });
  await act(async () => root.unmount());
  await window.happyDOM.abort();
  window.close();
}
