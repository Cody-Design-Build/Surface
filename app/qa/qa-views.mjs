// QA: sidebars (workspace + personal), view pages, board drag, cell edit, undo, panels.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.config/surface-cli/serve-token", "utf8").trim();
const base = "http://127.0.0.1:4317";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && errors.push(m.text()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const state = () => page.evaluate(async () => (await fetch("/api/state")).json());
const shot = (n) => page.screenshot({ path: `shots/${n}.png` });
const rowBox = (label, scope, placed = false) =>
  page.evaluate(
    (label, scope, placed) => {
      const rows = [...document.querySelectorAll(`.node[data-scope="${scope}"]${placed ? ".is-placed" : ""}`)].filter((e) => e.querySelector(".node-label")?.textContent === label);
      if (!rows.length) return null;
      const r = rows[0].getBoundingClientRect();
      return { x: r.left + 60, y: r.top + r.height / 2, top: r.top, h: r.height, left: r.left };
    },
    label,
    scope,
    placed,
  );
async function drag(from, to, { steps = 12, hold } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(16);
  }
  await sleep(80);
  const info = await page.evaluate(() => ({
    tag: document.querySelector(".drag-tag")?.innerText ?? null,
    no: !!document.querySelector(".drag-tag.is-no"),
    drop: [...document.querySelectorAll("[data-drop]")].map((e) => e.dataset.drop),
  }));
  if (hold) await hold(info);
  await page.mouse.up();
  await sleep(900);
  return info;
}

await page.goto(`${base}/?token=${token}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tree .node");
await sleep(500);

// --- 1. two sections rendered
const heads = await page.$$eval(".section-head .section-name", (e) => e.map((x) => x.textContent));
check("two sidebar sections", heads.length === 2 && heads[1] === "Personal", heads.join(" | "));

// expand Jobs > All jobs > Steiner Kitchen
const clickRow = async (label, scope = "workspace") => {
  await page.evaluate((label, scope) => [...document.querySelectorAll(`.node[data-scope="${scope}"]`)].find((e) => e.querySelector(".node-label")?.textContent === label)?.scrollIntoView({ block: "center" }), label, scope);
  await sleep(150);
  const b = await rowBox(label, scope);
  if (!b) throw new Error("no row " + label);
  await page.mouse.click(b.x, b.y);
  await sleep(350);
};
const twirl = async (label, scope = "workspace") => {
  await page.evaluate(
    (label, scope) => {
      const row = [...document.querySelectorAll(`.node[data-scope="${scope}"]`)].find((e) => e.querySelector(".node-label")?.textContent === label);
      const t = row.querySelector(".twirl");
      if (!t.classList.contains("is-open")) t.click();
    },
    label,
    scope,
  );
  await sleep(250);
};
await twirl("All jobs");
await twirl("Steiner Kitchen");
const kids = await page.evaluate(() => [...document.querySelectorAll('.node[data-scope="workspace"] .node-label')].map((e) => e.textContent));
check("each job has its trackers", ["Pages", "Tasks", "Selections tracker", "Budget"].every((k) => kids.includes(k)), kids.slice(0, 16).join(", "));
await shot("v1-sidebar");

// --- 2. open job Tasks view (board), filtered by this job
const tasksRow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.node[data-scope="workspace"]')];
  const sk = rows.findIndex((e) => e.querySelector(".node-label")?.textContent === "Steiner Kitchen");
  const t = rows.slice(sk).find((e) => e.querySelector(".node-label")?.textContent === "Tasks");
  const r = t.getBoundingClientRect();
  return { x: r.left + 60, y: r.top + r.height / 2 };
});
await page.mouse.click(tasksRow.x, tasksRow.y);
await page.waitForSelector(".board", { timeout: 5000 }).catch(() => {});
await sleep(600);
const board = await page.evaluate(() => ({
  title: document.querySelector(".group-title")?.textContent,
  crumb: document.querySelector(".crumbs")?.textContent,
  cols: [...document.querySelectorAll(".board-col")].map((c) => [c.querySelector(".board-head").textContent, c.querySelectorAll(".card").length]),
  cards: [...document.querySelectorAll(".card-title")].map((c) => c.textContent),
}));
check("job Tasks opens as a board filtered to the job", board.cards.length === 2 && board.cards.includes("Schedule electrician") && board.crumb.includes("Steiner"), JSON.stringify(board));
await shot("v2-board");

// --- 3. board drag: Schedule electrician To do -> Doing
const card = await page.evaluate(() => {
  const c = [...document.querySelectorAll(".card")].find((e) => e.textContent.includes("Schedule electrician"));
  const r = c.getBoundingClientRect();
  return { x: r.left + 30, y: r.top + 14 };
});
const doingCol = await page.evaluate(() => {
  const c = [...document.querySelectorAll(".board-col")].find((e) => e.querySelector(".board-head").textContent.startsWith("Doing"));
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + 40 };
});
const bi = await drag(card, doingCol, {
  hold: async () => {
    const slot = await page.$eval(".card-slot", (e) => e.textContent).catch(() => null);
    check("board shows the field change while dragging", slot === "Set Status → Doing", String(slot));
  },
});
let toast = await page.$eval(".toast", (e) => e.textContent).catch(() => "");
let st = await state();
const getTask = async (title) =>
  page.evaluate(async (title) => {
    const s = await (await fetch("/api/state")).json();
    const id = s.records.find((r) => r.title === title).id;
    return (await (await fetch("/api/record/" + id)).json()).record;
  }, title);
let t = await getTask("Schedule electrician");
check("board drop sets status", t.fields.status === "Doing", t.fields.status + " | toast: " + toast);
// undo via keyboard
await page.mouse.click(700, 120);
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await sleep(1200);
t = await getTask("Schedule electrician");
check("⌘Z undoes the board move", t.fields.status === "To do", t.fields.status);

// --- 4. table tab + cell edit
await page.evaluate(() => [...document.querySelectorAll(".view-tab")].find((e) => e.textContent.includes("Table")).click());
await sleep(400);
const ownerCell = await page.evaluate(() => {
  const ths = [...document.querySelectorAll(".grid th")].map((e) => e.textContent);
  const ci = ths.findIndex((x) => x.startsWith("Owner"));
  const row = [...document.querySelectorAll(".grid tbody tr")].find((r) => r.textContent.includes("Schedule electrician"));
  const td = row.children[ci];
  const r = td.getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2, ci };
});
await page.mouse.click(ownerCell.x, ownerCell.y);
await sleep(300);
const editing = await page.$(".cell.is-editing input, .cell.is-editing textarea");
check("clicking a cell edits it in place", !!editing);
if (editing) {
  await page.keyboard.type("Sam");
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.mouse.click(1300, 860);
  await sleep(1200);
  t = await getTask("Schedule electrician");
  check("cell edit saves", t.fields.owner === "Sam", String(t.fields.owner));
}
await shot("v3-table");

// --- 5. sidebar: drag a generated job into Personal = pin, no field change
const before = await getTask("Bathroom Refresh").catch(() => null);
const gen = await rowBox("Bathroom Refresh", "workspace");
const personalHead = await page.evaluate(() => {
  const h = [...document.querySelectorAll(".section-head")].find((e) => e.dataset.section === "personal");
  const r = h.getBoundingClientRect();
  return { x: r.left + 80, y: r.top + r.height / 2 };
});
const pinInfo = await drag(gen, personalHead);
check("dragging a generated entry says Pin", (pinInfo.tag ?? "").includes("Pin here"), pinInfo.tag);
st = await state();
const pinned = JSON.stringify(st.sidebar.personal.definition);
check("pin adds it to the personal sidebar", pinned.includes("Bathroom Refresh"), pinned);
const after = await getTask("Bathroom Refresh");
check("pinning changes no fields", before && after.rev === before.rev, `${before?.rev} → ${after.rev}`);

// --- 6. generated entry can't be reordered within its list
const sk = await rowBox("Steiner Kitchen", "workspace");
const br = await rowBox("Bathroom Refresh", "workspace");
const noInfo = await drag(sk, { x: br.x, y: br.top + 3 });
check("generated list refuses rearranging, with a reason", noInfo.no && (noInfo.tag ?? "").includes("comes from the data"), noInfo.tag);

// --- 7. placed entries reorder: move "Tasks" group above "Wiki"
const wsBefore = (await state()).sidebar.workspace.definition.items.map((i) => i.group ?? i.view ?? i.record);
const tasksGroup = await rowBox("Tasks", "workspace", true);
const wikiGroup = await rowBox("Wiki", "workspace", true);
const mv = await drag(tasksGroup, { x: wikiGroup.x, y: wikiGroup.top + 3 });
const wsAfter = (await state()).sidebar.workspace.definition.items.map((i) => i.group ?? i.view ?? i.record);
check("placed folders reorder with a line marker", wsAfter[0] === "Tasks" && mv.drop.includes("before"), `${wsBefore} → ${wsAfter} | ${mv.tag}`);
// toast undo button
await page.waitForSelector(".toast button", { timeout: 3000 }).catch(() => {});
await page.click(".toast button").catch(() => {});
await sleep(1600);
const wsUndo = (await state()).sidebar.workspace.definition.items.map((i) => i.group ?? i.view ?? i.record);
check("toast Undo restores the order", JSON.stringify(wsUndo) === JSON.stringify(wsBefore), String(wsUndo));

// --- 8. remove the pinned entry via menu
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.node[data-scope="personal"]')].find((e) => e.querySelector(".node-label")?.textContent === "Bathroom Refresh");
  row.querySelector(".node-more").click();
});
await sleep(250);
const menuText = await page.$eval(".menu-fixed", (e) => e.innerText).catch(() => "");
await page.evaluate(() => [...document.querySelectorAll(".menu-fixed .menu-item")].find((e) => e.textContent.includes("Remove from sidebar")).click());
await sleep(1200);
st = await state();
check("remove from sidebar (record kept)", !JSON.stringify(st.sidebar.personal.definition).includes("Bathroom Refresh") && st.records.some((r) => r.title === "Bathroom Refresh"), menuText.replace(/\n/g, " / "));

// --- 9. settings: merged tree
await page.click('.ws-btn[title="Settings"]');
await sleep(300);
await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((e) => e.textContent.includes("One tree")).click());
await sleep(1500);
const mergedHeads = await page.$$eval(".section-head", (e) => e.length);
st = await state();
check("setting: one tree hides the split", mergedHeads === 0 && st.sidebar.display === "merged", `${mergedHeads} heads, ${st.sidebar.display}`);
await shot("v4-settings");
await page.evaluate(() => [...document.querySelectorAll(".seg button")].find((e) => e.textContent.includes("Two sections")).click());
await sleep(1500);
await page.keyboard.press("Escape");
await page.click(".panel-head .icon-btn").catch(() => {});
await sleep(300);

// --- 10. selection opens fields-first
const selId = st.records.find((r) => r.title === "Vanity").id;
await page.evaluate((id) => (location.hash = "/r/" + id), selId);
await sleep(900);
const fieldsFirst = await page.evaluate(() => ({ cls: document.querySelector(".page")?.className, notes: !!document.querySelector(".add-notes"), editor: !!document.querySelector(".cm-editor") }));
check("fields-display type opens fields-first", fieldsFirst.cls.includes("is-fields") && fieldsFirst.notes && !fieldsFirst.editor, JSON.stringify(fieldsFirst));
await shot("v5-fields");

// --- 11. Move to… sets the job link
const tileId = st.records.find((r) => r.title === "Tile Options").id;
await page.evaluate((id) => (location.hash = "/r/" + id), tileId);
await sleep(800);
await page.click('.page-actions .icon-btn[aria-label="Page menu"]');
await page.evaluate(() => [...document.querySelectorAll(".menu .menu-item")].find((e) => e.textContent.includes("Move to")).click());
await sleep(300);
await page.type(".switcher-input input", "Steiner Kitchen");
await sleep(200);
await page.keyboard.press("Enter");
await sleep(300);
const choices = await page.$$eval(".choice", (e) => e.map((x) => x.innerText.split("\n")[0]));
await page.evaluate(() => [...document.querySelectorAll(".choice")].find((e) => e.textContent.includes("Set Job")).click());
await sleep(1200);
let tile = await getTask("Tile Options");
const skId = st.records.find((r) => r.title === "Steiner Kitchen").id;
check("Move to… sets the link field", tile.fields.job === skId, choices.join(" / "));
await page.keyboard.down("Meta");
await page.keyboard.press("z");
await page.keyboard.up("Meta");
await sleep(1200);
tile = await getTask("Tile Options");
check("…and undo puts it back", tile.fields.job !== skId, String(tile.fields.job));

// --- 12. view editor: new personal view from the + menu
await page.evaluate(() => {
  const h = [...document.querySelectorAll(".section-head")].find((e) => e.dataset.section === "personal");
  h.querySelector(".section-add").click();
});
await sleep(250);
await page.evaluate(() => [...document.querySelectorAll(".menu-fixed .menu-item")].find((e) => e.textContent.includes("New view")).click());
await sleep(300);
await page.type(".panel .ve-input", "Unpaid budget");
await page.select(".panel select.ve-input", "budget_line");
await sleep(100);
await page.evaluate(() => [...document.querySelectorAll(".panel .ve-add")].find((e) => e.textContent.includes("Add a condition")).click());
await sleep(100);
await page.evaluate(() => {
  const c = document.querySelector(".ve-cond");
  const sels = c.querySelectorAll("select");
  const set = (el, v) => {
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    proto.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  set(sels[0], "paid");
});
await sleep(100);
await page.evaluate(() => {
  const c = document.querySelector(".ve-cond");
  const sels = c.querySelectorAll("select");
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  proto.call(sels[2], "false");
  sels[2].dispatchEvent(new Event("change", { bubbles: true }));
});
await shot("v6-vieweditor");
await page.evaluate(() => [...document.querySelectorAll(".panel .btn-primary")].find((e) => e.textContent.includes("Create")).click());
await sleep(1800);
st = await state();
const nv = st.views.find((v) => v.name === "Unpaid budget");
check("view editor creates a personal view and adds it to the sidebar", !!nv && nv.personal && JSON.stringify(st.sidebar.personal.definition).includes(nv.key), JSON.stringify(nv?.definition));
if (nv) {
  console.log("   rows:", await page.evaluate(() => [...document.querySelectorAll('.node[data-scope="personal"] .node-label')].map((e) => e.textContent).join(",")), "overlay:", !!(await page.$(".overlay")), JSON.stringify(await rowBox("Unpaid budget", "personal")));
  await clickRow("Unpaid budget", "personal");
  await page.waitForFunction(() => document.querySelector(".group-title")?.textContent === "Unpaid budget" && document.querySelectorAll(".grid tbody tr").length > 0, { timeout: 5000 }).catch(() => {});
  const rows = await page.$$eval(".grid tbody tr", (e) => e.length);
  console.log("   route:", await page.evaluate(() => location.hash + " | " + document.querySelector(".group-title")?.textContent));
  check("new view opens as a table with matching rows", rows === 4, `${rows} rows`);
  await shot("v7-newview");
}

// --- 13. share panel
await page.click('.ws-btn[title="Share"]');
await sleep(900);
const people = await page.$$eval(".people li", (e) => e.map((x) => x.innerText.replace(/\n/g, " ")));
check("share panel lists members and workspaces", people.length >= 3, people.join(" | "));
await shot("v8-share");
await page.click(".panel-head .icon-btn");

// --- 14. calendar
await page.evaluate(() => {
  const g = [...document.querySelectorAll('.node[data-scope="workspace"]')].find((e) => e.querySelector(".node-label")?.textContent === "All tasks");
  g.click();
});
await sleep(800);
await page.evaluate(() => [...document.querySelectorAll(".view-tab")].find((e) => e.textContent.includes("Calendar"))?.click());
await sleep(500);
const calItems = await page.$$eval(".cal-item", (e) => e.length);
check("calendar layout renders", calItems >= 1, `${calItems} items`);
await shot("v9-calendar");

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
