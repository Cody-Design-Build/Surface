// QA: block drag handles + sidebar drag-to-nest. node qa-drag.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.config/surface-cli/serve-token", "utf8").trim();
const base = "http://127.0.0.1:4317";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  defaultViewport: { width: 1360, height: 860, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, body) =>
  page.evaluate(async (path, body) => {
    const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    return r.json();
  }, path, body);

await page.goto(`${base}/?token=${token}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tree .node");

// a scratch page with blocks
const body = "First paragraph.\n\n## Heading two\n\n- apple\n- banana\n- cherry\n\nLast paragraph.\n";
const { record: scratch } = await api("/api/records", { type: "page", title: "Drag Test", body, folder: "" });
const { record: host } = await api("/api/records", { type: "page", title: "Drag Host", folder: "" });
await page.evaluate((id) => (location.hash = "/r/" + id), scratch.id);
await page.waitForFunction(() => document.querySelector(".page .title")?.value === "Drag Test");
await sleep(600);

const lineBox = (text) =>
  page.evaluate((text) => {
    const l = [...document.querySelectorAll(".cm-line")].find((e) => e.textContent.includes(text));
    const r = l.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
  }, text);
const doc = () => page.evaluate(() => window.__surfaceEditor.state.doc.toString());

async function dragBlock(from, to, after = false) {
  const a = await lineBox(from);
  await page.mouse.move(a.x, a.y);
  await sleep(150);
  const h = await page.$eval(".cm-block-handle.is-on", (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  const b = await lineBox(to);
  const ty = after ? b.bottom - 3 : b.top + 3;
  for (let i = 1; i <= 8; i++) await page.mouse.move(h.x, h.y + ((ty - h.y) * i) / 8);
  await sleep(100);
  await page.mouse.up();
  await sleep(300);
}

const ok = (name, cond, extra = "") => console.log(cond ? "ok  " : "FAIL", name, extra);

// 1. handle appears on hover
const a = await lineBox("First paragraph");
await page.mouse.move(a.x, a.y);
await sleep(200);
ok("handle shows on hover", await page.$(".cm-block-handle.is-on"));
await page.screenshot({ path: "shots/10-handle.png" });

// 2. move the last paragraph to the top
await dragBlock("Last paragraph", "First paragraph");
let d = await doc();
ok("paragraph moved to top", d.startsWith("Last paragraph.\n\nFirst paragraph."), JSON.stringify(d));

// 3. move a list item within the list
await dragBlock("cherry", "apple");
d = await doc();
ok("list item reordered", d.includes("- cherry\n- apple\n- banana"), JSON.stringify(d));

// 4. move the heading below the list
await dragBlock("Heading two", "banana", true);
d = await doc();
ok("heading moved after list", /- banana\n\n## Heading two/.test(d), JSON.stringify(d));

// 5. click selects the block
const f = await lineBox("First paragraph");
await page.mouse.move(f.x, f.y);
await sleep(150);
await page.click(".cm-block-handle.is-on");
const sel = await page.evaluate(() => {
  const v = window.__surfaceEditor;
  const r = v.state.selection.main;
  return v.state.sliceDoc(r.from, r.to);
});
ok("click selects block", sel === "First paragraph.", JSON.stringify(sel));

// 6. ⌥↓ moves a line
await page.evaluate(() => {
  const v = window.__surfaceEditor;
  const i = v.state.doc.toString().indexOf("- cherry");
  v.dispatch({ selection: { anchor: i + 2 } });
  v.focus();
});
await page.keyboard.down("Alt");
await page.keyboard.press("ArrowDown");
await page.keyboard.up("Alt");
await sleep(200);
d = await doc();
ok("alt-down moves line", d.includes("- apple\n- cherry"), JSON.stringify(d));

// wait for autosave and check the server copy
await sleep(1800);
const saved = (await api("/api/record/" + scratch.id)).record.body;
ok("saved to file/db", saved.includes("- apple\n- cherry") && saved.startsWith("Last paragraph."), JSON.stringify(saved));

// 7. sidebar: drag "Drag Test" onto "Drag Host" to nest it
await page.evaluate(() => {
  const sec = [...document.querySelectorAll(".node.is-section")].find((n) => n.textContent.includes("Inbox"));
  if (sec && !sec.nextElementSibling) sec.click();
});
await sleep(300);
console.log("labels:", await page.evaluate(() => [...document.querySelectorAll(".node-label")].map((e) => e.textContent).join(" | ")));
console.log("scratch folder:", (await api("/api/record/" + scratch.id)).record.folder);
const nested = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".node")];
  const src = nodes.find((n) => n.querySelector(".node-label")?.textContent === "Drag Test");
  const dst = nodes.find((n) => n.querySelector(".node-label")?.textContent === "Drag Host");
  if (!src || !dst) return "missing " + !!src + " " + !!dst;
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  return "ok";
});
await sleep(50);
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".node")];
  const dst = nodes.find((n) => n.querySelector(".node-label")?.textContent === "Drag Host");
  const dt = new DataTransfer();
  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await sleep(100);
await page.screenshot({ path: "shots/11-sidebar-drop.png" });
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".node")];
  const dst = nodes.find((n) => n.querySelector(".node-label")?.textContent === "Drag Host");
  const dt = new DataTransfer();
  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await sleep(2500);
const after = (await api("/api/record/" + scratch.id)).record;
ok("sidebar drop nests page", nested === "ok" && after.parent === host.id, `${nested} parent=${after.parent}`);
await page.screenshot({ path: "shots/12-nested.png" });

// cleanup
for (const id of [scratch.id, host.id]) await page.evaluate((id) => fetch("/api/record/" + id, { method: "DELETE" }), id);
await sleep(500);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
