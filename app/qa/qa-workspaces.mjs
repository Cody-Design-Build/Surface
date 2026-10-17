// QA: switch workspace from the app, see the imported cdb-os data, switch back.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.config/surface-cli/serve-token", "utf8").trim();
const BASE = "http://127.0.0.1:4317";
const SHOTS = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
const TARGET = process.env.WS ?? "cdb-os";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", defaultViewport: { width: 1360, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/favicon|401|422/.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => r.status() === 404 && errors.push("404 " + r.url()));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, opts = {}) => page.evaluate(async (path, opts) => (await fetch(path, opts)).json(), path, opts);

await page.goto(`${BASE}/?token=${token}`, { waitUntil: "domcontentloaded" });
await sleep(1200);
const start = (await api("/api/state")).workspace.name;
console.log("   starting in", start);

await page.click(".ws-switch");
await sleep(800);
const items = await page.evaluate(() => [...document.querySelectorAll(".ws-item")].map((b) => b.innerText.replace(/\s+/g, " ")));
check("workspace menu lists workspaces", items.length >= 2, items.join(" | "));
await page.screenshot({ path: SHOTS + "w1-menu.png" });
const clickWs = async (name) => {
  await page.evaluate((name) => [...document.querySelectorAll(".ws-item")].find((b) => b.querySelector(".ws-item-text span")?.textContent === name)?.click(), name);
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(2000);
};
await clickWs(TARGET);
let st = await api("/api/state");
check(`switched to ${TARGET}`, st.workspace.name === TARGET, st.workspace.name);
check("imported records present", st.records.length > 500, `${st.records.length} records`);
const side = await page.evaluate(() => document.querySelector(".sidebar")?.innerText ?? "");
check("sidebar shows imported groups", /Jobs/.test(side) && /Contacts/.test(side) && /Procurement/.test(side), side.slice(0, 200).replace(/\n/g, " / "));
await page.screenshot({ path: SHOTS + "w2-cdb-os.png" });

// open the Steiner job; its embedded views render
const job = st.records.find((r) => /2243 Steiner/.test(r.title) && r.type === "job");
await page.evaluate((id) => (location.hash = `#/r/${id}`), job.id);
await sleep(2200);
await page.evaluate(() => { document.querySelectorAll(".cm-scroller, main, .main, .page-scroll").forEach((e) => (e.scrollTop = 1e6)); document.scrollingElement.scrollTop = 1e6; });
await sleep(1000);
const jobInfo = await page.evaluate(() => ({ props: document.querySelector(".props, .properties")?.innerText.slice(0, 300), embeds: [...document.querySelectorAll(".cm-embed .embed-title")].map((e) => e.textContent), links: document.querySelectorAll(".cm-content .cm-link, .cm-content .cm-wikilink").length }));
check("job page shows linked contacts and embedded views", /Owner|Contacts/.test(jobInfo.props ?? "") && jobInfo.embeds.length >= 1, JSON.stringify(jobInfo));
await page.screenshot({ path: SHOTS + "w3-job.png" });

// a contact shows its backlinks (jobs, tasks)
const contact = st.records.find((r) => r.title === "James Carlson");
if (contact) {
  const rec = await api(`/api/record/${contact.id}`);
  check("contact has backlinks from jobs", (rec.backlinks ?? []).some((b) => /Steiner/.test(b.title)), (rec.backlinks ?? []).map((b) => b.title).join(", ").slice(0, 200));
}

// procurement view renders a board
const proc = st.views.find((v) => v.key === "procurement");
await page.evaluate(() => (location.hash = "#/v/procurement"));
await sleep(2000);
const cards = await page.evaluate(() => document.querySelectorAll(".card-title, tbody tr").length);
check("procurement view shows selections", cards > 10, `${cards} items; view ${proc?.name}`);
await page.screenshot({ path: SHOTS + "w4-procurement.png" });

// switch back
await page.click(".ws-switch");
await sleep(800);
await clickWs(start);
st = await api("/api/state");
check(`switched back to ${start}`, st.workspace.name === start, st.workspace.name);
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${pass}/${pass + fail} passed`);
await browser.close();
process.exit(fail ? 1 : 0);
