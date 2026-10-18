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
  await click(button("Filters"));
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
  await until(() => document.querySelector(".data-view-label")?.textContent.includes(`Top one ${suffix}`), "limited view open");
  await until(() => document.querySelector(".data-footer")?.textContent.startsWith("1 record"), "limit applied");
  pass("saved view row limit is honored");
  await click(document.querySelector('[aria-label="Create or edit types"]'));
  await until(() => document.querySelector('[aria-label="Types"]'), "type management");
  await click(button("New type"));
  const nameInput = document.querySelector('.types-new input');
  await input(nameInput, `Equipment ${suffix}`);
  await act(async () => nameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await until(() => [...document.querySelectorAll(".types-item")].some(el => el.textContent.includes(`Equipment ${suffix}`)), "new type");
  assert((await settled("/api/state")).types.some(t => t.name === `Equipment ${suffix}`));
  pass("new types can be created from this surface without using the writing app");
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
