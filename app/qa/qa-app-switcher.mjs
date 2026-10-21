// Isolated interaction checks: no running server, browser or business data needed.
import assert from "node:assert/strict";
import { Window } from "happy-dom";
const window = new Window({ url: "http://localhost/w/abc123/data/" });
for (const key of ["window", "document", "navigator", "location", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppSwitcher } = await import("../src/AppSwitcher.tsx");
const { apps } = await import("../../surfaces.mts");
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
let allowed = false, guarded = 0, navigation;
document.addEventListener("click", event => {
  if (event.target.closest?.("a")) { navigation = !event.defaultPrevented; event.preventDefault(); }
});
const render = async () => act(() => root.render(createElement(AppSwitcher, { beforeNavigate: () => { guarded++; return allowed; } })));
const click = async (element, init = {}) => act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
const key = async (element, key) => act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const trigger = () => host.querySelector("button");
const links = () => [...host.querySelectorAll("nav a")];
try {
  await render();
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.match(trigger().textContent, /Data View/);
  await click(trigger());
  assert.equal(links().length, apps.length);
  assert.equal(links()[0].getAttribute("href"), "/w/abc123/");
  assert.equal(links()[1].getAttribute("aria-current"), "page");
  await key(trigger(), "ArrowDown"); assert.equal(document.activeElement, links()[0]);
  await key(links()[0], "End"); assert.equal(document.activeElement, links().at(-1));
  await key(links().at(-1), "Escape");
  assert.equal(links().length, 0); assert.equal(document.activeElement, trigger());
  await click(trigger()); await click(links()[0]);
  assert.equal(guarded, 1); assert.equal(navigation, false); assert(links().length, "cancel keeps the switcher open");
  await click(links()[0], { ctrlKey: true });
  assert.equal(guarded, 1); assert.equal(navigation, true, "new tab keeps native behavior and current edits");
  allowed = true; await click(links()[0]);
  assert.equal(guarded, 2); assert.equal(navigation, true); assert.equal(links().length, 0);
  await click(trigger()); await click(links()[1]);
  assert.equal(guarded, 2); assert.equal(navigation, false, "current app closes without reloading");
  await click(trigger());
  await act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  assert.equal(links().length, 0);
  window.location.href = "http://localhost/w/xyz789/";
  await render(); await click(trigger());
  assert.equal(links()[0].getAttribute("aria-current"), "page");
  assert.equal(links()[1].getAttribute("href"), "/w/xyz789/data/");
  const future = { id: "projects", name: "Projects", description: "Job progress", path: "/projects/", entry: "projects.html" };
  apps.push(future);
  await render();
  assert.equal(links().at(-1).getAttribute("href"), "/w/xyz789/projects/");
  assert.match(links().at(-1).textContent, /Projects/);
  apps.pop();
  window.location.href = "http://localhost/";
  await act(() => root.render(createElement(AppSwitcher, {appId:"data"})));
  assert.match(trigger().textContent,/Data View/,"standalone Data View identifies itself at the root URL");
  if (!links().length) await click(trigger());
  assert.equal(links()[0].getAttribute("href"),"/index.html","Vault bypasses a legacy Data View default page");
  assert.equal(links()[1].getAttribute("href"),"/data.html");
  await click(links()[0]);assert.equal(navigation,true,"Vault is a distinct navigation even from a Data View server's root");
  console.log("App switcher: workspace links, current app, keyboard, dismissal, edit guard, new tabs and future apps passed.");
} finally { await act(() => root.unmount()); await window.happyDOM.close(); }
