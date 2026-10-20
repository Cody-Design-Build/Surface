// QA: the editable grid (React Data Grid) on a local-store workspace.
// Needs: surface serve --port 4391 on ~/.hermes/cache/scratch/grid-qa (see the setup in the session).
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const G = process.env.HOME + "/.hermes/cache/scratch/grid-qa";
const token = fs.readFileSync(G + "/cfg/serve-token", "utf8").trim();
const base = "http://127.0.0.1:4391";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 } });
await browser.defaultBrowserContext().overridePermissions(base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: process.env.DARK ? "dark" : "light" }]);
const errors = [];
page.on("console", (m) => m.type() === "debug" && console.log("  [page]", m.text()));
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const shot = (n) => page.screenshot({ path: `shots/${n}.png` });
const api = (path, opts) => page.evaluate(async (path, opts) => (await fetch((/^\/w\/[^/]+/.exec(location.pathname)?.[0] ?? "") + path, opts)).json(), path, opts);
const view = () => api("/api/view/all-tasks");
const task = async (title) => (await view()).records.find((r) => r.title === title);
const near = async (k) => {
  const v = await page.evaluate(() => [...document.querySelectorAll('.surface-grid [role="row"]')].map((r) => r.querySelector(".sg-title-text")?.textContent).filter(Boolean));
  return v[Math.max(0, v.indexOf("Order tile 1")) + k];
};
const cell = (title, colName) =>
  page.evaluate(
    (title, colName) => {
      const heads = [...document.querySelectorAll('.surface-grid [role="columnheader"]')];
      const h = heads.find((e) => e.textContent.trim().startsWith(colName));
      if (!h) return null;
      const col = h.getAttribute("aria-colindex");
      const row = [...document.querySelectorAll('.surface-grid [role="row"]')].find((r) => r.querySelector(".sg-title-text")?.textContent === title);
      const c = row?.querySelector(`[aria-colindex="${col}"]`);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + Math.min(30, r.width / 2), left: r.left, y: r.top + r.height / 2, text: c.textContent, w: r.width };
    },
    title,
    colName,
  );

await page.goto(`${base}/?token=${token}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tree .node");
await page.evaluate(() => (location.hash = "/v/all-tasks"));
await page.waitForSelector(".surface-grid [role='row']");
await sleep(500);
await shot("g1-grid");

const info = await page.evaluate(() => ({
  heads: [...document.querySelectorAll('.surface-grid [role="columnheader"]')].map((e) => e.textContent.trim()),
  rows: document.querySelectorAll('.surface-grid [role="row"]').length,
  rowCount: document.querySelector('.surface-grid')?.getAttribute("aria-rowcount"),
}));
check("grid renders with the view's columns", info.heads.join("|").includes("Title|Status|Owner|Due|Cost|Done|Trades|Job"), info.heads.join("|"));
check("grid virtualizes but knows all 36 rows", Number(info.rowCount) === 37, `aria-rowcount ${info.rowCount}, ${info.rows} rendered`);

// 1. type into a text cell
let c = await cell("Order tile 1", "Owner");
await page.mouse.click(c.x, c.y);
await page.keyboard.type("Dana");
await page.keyboard.press("Enter");
await sleep(1000);
check("typing on a selected cell edits and saves it", (await task("Order tile 1")).fields.owner === "Dana", (await task("Order tile 1")).fields.owner);

// 2. keyboard navigation: arrow down and edit with Enter
const visible = await page.evaluate(() => [...document.querySelectorAll('.surface-grid [role="row"]')].map((r) => r.querySelector(".sg-title-text")?.textContent).filter(Boolean));
const below = visible[visible.indexOf("Order tile 1") + 1];
c = await cell("Order tile 1", "Owner");
await page.mouse.click(c.x, c.y);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await sleep(150);
await page.keyboard.press("End");
await page.keyboard.type(" Jr");
await page.keyboard.press("Enter");
await sleep(1000);
const second = below;
const t2 = await task(second);
check("arrow keys move, Enter edits the cell below", /Jr$/.test(t2.fields.owner ?? ""), `${second}: ${t2.fields.owner}`);

// 3. select menu
c = await cell("Order tile 1", "Status");
await page.mouse.click(c.x, c.y);
await page.keyboard.press("Enter");
await sleep(250);
const menu = await page.$(".sg-menu");
const geo = await page.evaluate(() => {
  const m = document.querySelector(".sg-menu")?.getBoundingClientRect();
  const cellEl = document.querySelector('.surface-grid [aria-selected="true"]')?.getBoundingClientRect();
  const pills = document.querySelector('.surface-grid [aria-selected="true"]')?.querySelectorAll(".pill").length;
  return m && cellEl ? { dy: Math.round(m.top - cellEl.bottom), dx: Math.round(m.left - cellEl.left), pills } : null;
});
check("Enter on a select cell opens its menu, right under the cell", !!menu && geo && Math.abs(geo.dy - 2) <= 2 && Math.abs(geo.dx) <= 1 && geo.pills === 1, JSON.stringify(geo));
await shot("g2-select-menu");
await page.keyboard.type("don");
await page.keyboard.press("Enter");
await sleep(1000);
check("choosing from the menu saves", (await task("Order tile 1")).fields.status === "Done", (await task("Order tile 1")).fields.status);

// 4. invalid value is refused with a message
c = await cell("Order tile 1", "Cost");
await page.mouse.click(c.x, c.y);
await page.keyboard.type("lots");
await page.keyboard.press("Enter");
await sleep(1200);
const toast = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
const costAfter = (await task("Order tile 1")).fields.cost;
check("invalid number refused and reported", costAfter === 0 && /number/i.test(toast), `cost ${costAfter}; toast "${toast}"`);

// 5. checkbox with Space
const cbRow = await near(2);
c = await cell(cbRow, "Done");
const before = (await task(cbRow)).fields.done ?? false;
await page.mouse.click(c.left + 6, c.y);
await page.keyboard.press("Space");
await sleep(1000);
check("Space toggles a checkbox", ((await task(cbRow)).fields.done ?? false) === !before, cbRow);

// 6. copy/paste a cell (clipboard events on the selected cell, as the browser sends them)
c = await cell("Order tile 1", "Owner");
await page.mouse.click(c.x, c.y);
const copied = await page.evaluate(() => {
  const dt = new DataTransfer();
  document.activeElement.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData("text/plain");
});
const pasteRow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.surface-grid [role="row"]')].filter((r) => { const b = r.getBoundingClientRect(); return b.top > 200 && b.bottom < 760; });
  return rows.map((r) => r.querySelector(".sg-title-text")?.textContent).filter((x) => x && x !== "Order tile 1")[0];
});
c = await cell(pasteRow, "Owner");
await page.mouse.click(c.x, c.y);
await page.evaluate((text) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, copied);
await sleep(1200);
const pasted = (await task(pasteRow)).fields.owner;
check("copy and paste a cell", copied === "Dana" && pasted === "Dana", `copied "${copied}", pasted into ${pasteRow}: ${pasted}`);

// 7. sort by clicking a header, saved in the shared view only on "Save for everyone"
await page.evaluate(() => [...document.querySelectorAll('.surface-grid [role="columnheader"]')].find((e) => e.textContent.trim().startsWith("Cost")).querySelector("span,div")?.click());
await sleep(400);
const costs = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('.surface-grid [role="columnheader"]')];
  const col = heads.find((e) => e.textContent.trim().startsWith("Cost")).getAttribute("aria-colindex");
  return [...document.querySelectorAll('.surface-grid [role="row"]')].slice(1, 6).map((r) => Number(r.querySelector(`[aria-colindex="${col}"]`)?.textContent.replace(/,/g, "") || NaN));
});
const asc = costs.every((x, i) => i === 0 || x >= costs[i - 1]);
const dirty = await page.$(".view-dirty");
check("header click sorts; shared view shows Save/Reset instead of saving", asc && !!dirty && !(await view()).view.definition.sort, costs.join(","));
await page.evaluate(() => [...document.querySelectorAll(".view-dirty button")].find((b) => b.textContent.includes("Save")).click());
await sleep(1000);
check("Save for everyone writes sort to the view definition", (await view()).view.definition.sort === "cost", (await view()).view.definition.sort);

// 8. resize a column → widths saved
const h = await page.evaluate(() => {
  const e = [...document.querySelectorAll('.surface-grid [role="columnheader"]')].find((e) => e.textContent.trim().startsWith("Owner"));
  const r = e.getBoundingClientRect();
  return { x: r.right - 2, y: r.top + r.height / 2, w: r.width };
});
await page.mouse.move(h.x, h.y);
await page.mouse.down();
await page.mouse.move(h.x + 60, h.y, { steps: 8 });
await page.mouse.up();
await sleep(900);
await page.evaluate(() => [...document.querySelectorAll(".view-dirty button")].find((b) => b.textContent.includes("Save"))?.click());
await sleep(1000);
const widths = (await view()).view.definition.layouts[0].widths ?? {};
check("resizing a column saves its width", widths.owner > h.w + 30, JSON.stringify(widths));

// 9. Display: group by status
await page.evaluate(() => [...document.querySelectorAll(".view-tools .btn-soft")].find((b) => b.textContent.includes("Display")).click());
await sleep(200);
await page.select(".sg-options .sg-select", "status");
await sleep(500);
const groups = await page.$$eval(".sg-group", (e) => e.map((x) => x.textContent));
const treeRows = await page.$eval(".surface-grid", (e) => e.getAttribute("aria-rowcount"));
await shot("g3-grouped");
check("group by status (3 groups + 36 rows)", groups[0].startsWith("To do") && Number(treeRows) === 40, `${groups.join(" | ")}; rowcount ${treeRows}`);
await page.keyboard.press("Escape");
await page.click(".group-title");
await sleep(200);
await page.evaluate(() => [...document.querySelectorAll(".view-dirty button")].find((b) => b.textContent.includes("Reset"))?.click());
await sleep(500);
check("Reset drops unsaved grouping", !(await page.$(".sg-group")));

// 10. row selection + delete with undo
const delRow = await near(1);
await page.evaluate((delRow) => {
  const rows = [...document.querySelectorAll('.surface-grid [role="row"]')];
  const r = rows.find((x) => x.querySelector(".sg-title-text")?.textContent === delRow);
  r.querySelector('input[type="checkbox"]').click();
}, delRow);
await sleep(200);
const selBar = await page.evaluate(() => document.querySelector(".sg-selection")?.textContent ?? "");
check("selecting rows shows the selection bar", selBar.includes("1 selected"), selBar);
await page.evaluate(() => [...document.querySelectorAll(".sg-selection button")].find((b) => b.textContent.includes("Delete")).click());
await sleep(1200);
check("delete selected", !(await task(delRow)), delRow);
await page.mouse.click(700, 60);
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await sleep(1500);
check("⌘Z restores it", !!(await task(delRow)));

// 11. Space on the title opens the record
c = await cell("Order tile 1", "Title");
await page.mouse.click(c.x + 40, c.y);
await page.keyboard.press(" ");
await sleep(600);
check("Space on a title opens the record", (await page.evaluate(() => location.hash)).startsWith("#/r/"));

// 12. the file on disk has the edit (CLI is the source of truth)
const md = fs.readFileSync(G + "/v/Tasks/Order tile 1.md", "utf8");
check("edits land in the Markdown file", /owner: Dana/.test(md) && /status: Done/.test(md));
const yaml = fs.existsSync(G + "/v/.surface/views/all-tasks.yaml") ? fs.readFileSync(G + "/v/.surface/views/all-tasks.yaml", "utf8") : "";
check("saved view settings land in the view file", /sort: cost/.test(yaml) && /widths:/.test(yaml) && /owner: 2\d\d/.test(yaml), yaml.replace(/\n/g, " ⏎ ").slice(0, 300));
const real = errors.filter((e) => !e.includes("status of 422")); // the refused number above
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
