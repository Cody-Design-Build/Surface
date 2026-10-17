// QA: live view embed in a page, Markdown table render + click-to-edit, image paste, types panel.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.config/surface-cli/serve-token", "utf8").trim();
const BASE = "http://127.0.0.1:4317";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", defaultViewport: { width: 1360, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/favicon|401|422/.test(m.text()) && errors.push(m.text()));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, opts = {}) => page.evaluate(async (path, opts) => (await fetch(path, opts)).json(), path, opts);

await page.goto(`${BASE}/?token=${token}`, { waitUntil: "domcontentloaded" });
await sleep(800);
const st = await api("/api/state");
const job = st.records.find((r) => r.title === "Steiner Kitchen");
await page.evaluate((id) => { location.hash = `#/r/${id}`; }, job.id);
await sleep(1500);

// 1. live view renders in the page
const embed = await page.evaluate(() => {
  const e = document.querySelector(".cm-embed");
  if (!e) return null;
  return { title: e.querySelector(".embed-title")?.textContent, cards: e.querySelectorAll(".card-title, tbody tr, .list-row").length, text: e.innerText.slice(0, 300) };
});
check("live view block renders as a view", !!embed && /Job tasks/.test(embed.title ?? ""), JSON.stringify(embed));
check("embedded view shows this job's tasks only", !!embed && embed.cards >= 1 && !/Bathroom/.test(embed.text), `cards=${embed?.cards}`);
await page.screenshot({ path: SHOTS + "e1-embed.png", fullPage: false });

// 2. table renders (the editor draws only what's on screen: scroll to the end first)
await page.evaluate(() => { document.querySelectorAll(".cm-scroller, main, .main, .page-scroll").forEach((e) => (e.scrollTop = 1e6)); document.scrollingElement.scrollTop = 1e6; });
await sleep(800);
const tbl = await page.evaluate(() => {
  const t = document.querySelector(".cm-md-table table");
  return t ? { heads: [...t.querySelectorAll("th")].map((x) => x.textContent), cells: [...t.querySelectorAll("td")].map((x) => x.textContent), align: t.querySelector("td:nth-child(2)")?.style.textAlign } : null;
});
check("Markdown table renders", !!tbl && tbl.heads.join() === "Item,Allowance,Notes" && tbl.cells.includes("Quartz"), JSON.stringify(tbl));
check("table alignment honoured", tbl?.align === "right");

// 3. click a cell -> source appears with cursor there
await page.evaluate(() => document.querySelector(".cm-md-table td:nth-child(2)")?.scrollIntoView({ block: "center" }));
await sleep(200);
const td = await page.$(".cm-md-table tbody tr:nth-child(2) td:nth-child(2)");
const box = await td.boundingBox();
await page.mouse.click(box.x + 10, box.y + box.height / 2);
await sleep(400);
const afterClick = await page.evaluate(() => ({ table: !!document.querySelector(".cm-md-table"), line: (() => { const n = window.getSelection()?.anchorNode; const el = n?.nodeType === 3 ? n.parentElement : n; return el?.closest?.(".cm-line")?.textContent; })() }));
check("clicking a table cell shows the source at that cell", !afterClick.table && /Counters/.test(afterClick.line ?? ""), JSON.stringify(afterClick));
await page.keyboard.press("Escape");
await page.mouse.click(1300, 120);
await sleep(400);

// 4. image paste
const before = (await api(`/api/record/${job.id}`)).record.body ?? "";
await page.evaluate(() => {
  const content = document.querySelector(".cm-content");
  content.focus();
});
await page.evaluate(() => {
  const v = document.querySelector(".cm-content");
  // place cursor at doc end
  const sel = window.getSelection();
  sel.selectAllChildren(v);
  sel.collapseToEnd();
});
await sleep(200);
await page.evaluate(async () => {
  // 1x1 png
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bin], "image.png", { type: "image/png" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelector(".cm-content").dispatchEvent(ev);
});
await sleep(2500);
await page.evaluate(() => { document.querySelectorAll(".cm-scroller, main, .main, .page-scroll").forEach((e) => (e.scrollTop = 1e6)); document.scrollingElement.scrollTop = 1e6; });
await sleep(800);
const body = (await api(`/api/record/${job.id}`)).record.body ?? "";
const imgEl = await page.evaluate(() => { const i = document.querySelector(".cm-image img"); return i ? { src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0 } : null; });
check("pasted image inserted as Markdown and file saved", /attachments\/Pasted/.test(body) || !!imgEl, JSON.stringify(imgEl));
const files = fs.readdirSync(os.homedir() + "/Surface/Projects/Steiner Kitchen/attachments").filter((f) => f.startsWith("Pasted"));
check("attachment written next to the record", files.length >= 1, files.join(","));
check("pasted image displays", !!imgEl?.ok, JSON.stringify(imgEl));
await page.screenshot({ path: SHOTS + "e2-paste.png" });

// 5. types panel: add a field, save, verify, remove it
await page.evaluate(() => document.querySelector(".ws-btn[title=Settings]")?.click());
await sleep(500);
await page.evaluate(() => [...document.querySelectorAll(".ve-add")].find((b) => /types and fields/.test(b.textContent))?.click());
await sleep(500);
check("types panel opens", await page.evaluate(() => !!document.querySelector(".panel-types")));
await page.evaluate(() => [...document.querySelectorAll(".types-item")].find((b) => /Selection/.test(b.textContent))?.click());
await sleep(300);
const nFields = await page.evaluate(() => document.querySelectorAll(".field-list > li").length);
await page.evaluate(() => [...document.querySelectorAll(".type-editor .ve-add")].find((b) => /Add field/.test(b.textContent))?.click());
await sleep(200);
await page.keyboard.type("Lead time");
await page.select(".field-detail select", "number");
await page.screenshot({ path: SHOTS + "e3-types.png" });
await page.evaluate(() => [...document.querySelectorAll(".type-foot button")].find((b) => b.textContent === "Save")?.click());
await sleep(2500);
let st2 = await api("/api/state");
let sel = st2.types.find((t) => t.key === "selection");
check("new field saved to the type", sel.fields.some((f) => f.key === "lead_time" && f.kind === "number"), sel.fields.map((f) => f.key).join(","));
check("field list updated in panel", (await page.evaluate(() => document.querySelectorAll(".field-list > li").length)) === nFields + 1);

// bad save shows an error (duplicate key)
await page.evaluate(() => [...document.querySelectorAll(".type-editor .ve-add")].find((b) => /Add field/.test(b.textContent))?.click());
await sleep(200);
await page.keyboard.type("Lead time");
await page.evaluate(() => [...document.querySelectorAll(".type-foot button")].find((b) => b.textContent === "Save")?.click());
await sleep(1500);
const err = await page.evaluate(() => document.querySelector(".ve-error")?.textContent);
check("invalid fields rejected with a message", !!err, err);
await page.evaluate(() => [...document.querySelectorAll(".type-foot button")].find((b) => b.textContent === "Revert")?.click());
await sleep(200);

// remove the field again
page.on("dialog", (d) => d.accept());
await page.evaluate(() => [...document.querySelectorAll(".field-row")].find((r) => /Lead time/.test(r.textContent))?.click());
await sleep(200);
await page.evaluate(() => [...document.querySelectorAll(".btn-danger-soft")].find((b) => /Remove field/.test(b.textContent))?.click());
await page.evaluate(() => [...document.querySelectorAll(".type-foot button")].find((b) => b.textContent === "Save")?.click());
await sleep(2500);
st2 = await api("/api/state");
sel = st2.types.find((t) => t.key === "selection");
check("field removed", !sel.fields.some((f) => f.key === "lead_time"), sel.fields.map((f) => f.key).join(","));
await page.keyboard.press("Escape");

// clean up: drop the pasted images from the text and disk
{
  const dir = os.homedir() + "/Surface/Projects/Steiner Kitchen/attachments";
  const r = (await api(`/api/record/${job.id}`)).record;
  const clean = (r.body ?? "").replace(/\n?!\[image\]\(attachments\/Pasted[^)]*\)/g, "");
  await api(`/api/record/${job.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: clean, baseRev: r.rev }) });
  for (const f of fs.readdirSync(dir)) if (f.startsWith("Pasted")) fs.unlinkSync(`${dir}/${f}`);
}
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${pass}/${pass + fail} passed`);
await browser.close();
process.exit(fail ? 1 : 0);
