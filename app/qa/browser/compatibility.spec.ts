import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

let fixture: { token: string; records: string[]; view: string; config: string; workspace: string };
test.beforeEach(async ({ context, page }) => {
  await expect.poll(() => fs.existsSync(".browser-qa.json"), { timeout: 120_000 }).toBe(true);
  fixture = JSON.parse(fs.readFileSync(".browser-qa.json", "utf8"));
  await context.addCookies([{ name: "surface_token", value: fixture.token, domain: "127.0.0.1", path: "/" }]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  (page as Page & { appErrors: string[] }).appErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { appErrors: string[] }).appErrors).toEqual([]);
});

async function openData(page: Page) {
  await page.goto(`/data/#/table/task?view=${fixture.view}`);
  await expect(page.locator(".surface-grid")).toBeVisible();
  await expect(page.locator(".sg-title-text").first()).toContainText("Task");
}

async function alignment(page: Page) {
  return page.locator(".surface-grid").evaluate(grid => {
    const headers = new Map([...grid.querySelectorAll<HTMLElement>('[role="columnheader"]')].map(h => [h.getAttribute("aria-colindex"), h.getBoundingClientRect()]));
    const errors: string[] = [];
    let visibleRows = 0;
    const viewport = grid.getBoundingClientRect();
    for (const row of grid.querySelectorAll<HTMLElement>('.rdg-row')) {
      const box = row.getBoundingClientRect();
      if (box.bottom <= viewport.top + 34 || box.top >= viewport.bottom) continue;
      visibleRows++;
      for (const cell of row.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
        const rect = cell.getBoundingClientRect();
        const header = headers.get(cell.getAttribute("aria-colindex"));
        if (header && rect.width > 0 && Math.abs(header.x - rect.x) > 1) errors.push(`${cell.textContent}: ${rect.x} != ${header.x}`);
        if (Math.abs(rect.y - box.y) > 1 || Math.abs(rect.height - box.height) > 1) errors.push(`row height: ${cell.textContent}`);
      }
    }
    return visibleRows ? errors : ["No painted rows in viewport"];
  });
}

test("short tables sit flush in the pane and end below the last row", async ({ page }, testInfo) => {
  const response = await page.request.post("/api/views", { headers: { origin: "http://127.0.0.1:4394" }, data: {
    name: `Short table ${testInfo.project.name}`, personal: true,
    definition: { from: "task", sort: "title", limit: 8, layouts: [{ show: "table", columns: ["status", "owner", "cost"] }] },
  } });
  expect(response.ok()).toBe(true);
  const { view } = await response.json();
  await page.goto(`/data/#/table/task?view=${view.key}&personal=1`);
  await expect(page.locator(".sg-title-text")).toHaveCount(8);
  const main = await page.locator(".data-main").boundingBox();
  const grid = await page.locator(".surface-grid").boundingBox();
  expect(Math.abs(grid!.x - main!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(grid!.width - main!.width)).toBeLessThanOrEqual(1);
  const footer = await page.locator(".data-footer").boundingBox();
  expect(Math.abs(footer!.y - (grid!.y + grid!.height))).toBeLessThanOrEqual(1);
  // At desktop height all eight records fit; the grid must not stretch below
  // them. On a phone they may scroll, but the pane still has only one scroller.
  expect(grid!.height).toBeLessThanOrEqual(34 + 8 * 36 + 2);
  expect(await page.locator(".data-grid-area").evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("short-table.png") });
});

test("rows stay aligned during rapid two-axis scrolling and resize", async ({ page, isMobile }, testInfo) => {
  await openData(page);
  // Close the table list to leave useful horizontal space on phones.
  if (isMobile && await page.getByRole("button", { name: "Collapse tables list" }).isVisible()) await page.getByRole("button", { name: "Collapse tables list" }).click();
  const grid = page.locator(".surface-grid");
  expect(await grid.locator(".rdg-row").count()).toBeLessThan(150); // virtualization remains active
  const frozen = await grid.locator('.rdg-row .sg-title').first().boundingBox();
  for (const [x, y] of [[0, 500], [350, 1800], [650, 6000], [120, 2800], [0, 0], [450, 9000], [200, 400], [0, 0]]) {
    await grid.evaluate((el, pos) => el.scrollTo({ left: pos[0], top: pos[1] }), [x, y]);
    await expect.poll(() => alignment(page)).toEqual([]);
    if ((await grid.boundingBox())!.width > 600) await expect.poll(async () => {
      const box = await grid.locator('.rdg-row .sg-title').first().boundingBox();
      return box ? Math.abs(box.x - frozen!.x) : Infinity;
    }).toBeLessThanOrEqual(1);
  }
  // Wheel input exercises async scrolling beyond programmatic scrollTo.
  if (!isMobile) {
    await grid.hover();
    for (const dy of [650, 1700, -1100, 2200, -3000]) {
      await page.mouse.wheel(130, dy);
      await expect.poll(() => alignment(page)).toEqual([]);
    }
    await page.setViewportSize({ width: 1024, height: 740 });
    await expect.poll(() => alignment(page)).toEqual([]);
  }
  await page.screenshot({ path: testInfo.outputPath("grid.png") });
});

test("grouping, row heights, selection, sort and search", async ({ page }) => {
  await openData(page);
  await page.locator('.rdg-row input[aria-label="Select"]').first().check();
  await expect(page.locator(".sg-selection")).toContainText("1 selected");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("columnheader", { name: "Title", exact: true }).click();
  await expect(page.locator(".sg-title-text").first()).toHaveText("Task 0319");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByLabel("Pick a field to group by").selectOption("status");
  await expect(page.locator('.surface-grid[role="treegrid"]')).toBeVisible();
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(page.locator(".rdg-group-row")).toHaveCount(3);
  await expect(page.locator(".rdg-row:not(.rdg-group-row)")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.locator(".sg-title-text").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Hide fields", exact: true }).click();
  await page.getByRole("button", { name: "Tall", exact: true }).click();
  await expect(page.locator(".surface-grid.sg-rows-tall")).toBeVisible();
  await page.locator(".sg-options").getByRole("button", { name: /^Owner/ }).click();
  await expect(page.getByRole("columnheader", { name: "Owner", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".data-table-heading h1").click();
  await page.locator(".surface-grid").evaluate(el => el.scrollTo(250, 2600));
  await expect.poll(() => alignment(page)).toEqual([]);
  await page.getByRole("textbox", { name: /search records/i }).fill("Task 0301");
  await expect(page.locator(".sg-title-text")).toHaveText(["Task 0301"]);
});

test("record edits persist, date input and grid keyboard editing work", async ({ page }) => {
  await openData(page);
  const row = page.locator('.rdg-row[aria-rowindex="2"]');
  await row.locator(".sg-title").click();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Record title", { exact: true })).toBeVisible();
  const note = `Safari edit ${test.info().project.name}`;
  await page.getByLabel("Record notes").fill(note);
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(page.locator(".data-sheet footer")).toContainText("Saved");
  const response = await page.request.get(`/api/record/${fixture.records[0]}`);
  expect((await response.json()).record.body).toBe(note);
  await page.getByRole("button", { name: "Close record" }).click();
  await page.locator(".surface-grid").evaluate(el => el.scrollTo(700, 0));
  await expect(row.locator(".sgk-number")).toBeVisible();
  await row.locator(".sgk-number").dblclick();
  await page.locator(".sg-input").fill("12345");
  await page.locator(".sg-input").press("Enter");
  await expect(row.locator(".sgk-number")).toContainText("12,345");
  await row.locator(".sgk-date").dblclick();
  await expect(page.locator('.sg-input[type="date"]')).toBeVisible();
  await page.locator(".sg-input").fill("2026-12-20");
  await page.locator(".sg-input").press("Enter");
  await expect.poll(async () => (await (await page.request.get(`/api/record/${fixture.records[0]}`)).json()).record.fields.due).toBe("2026-12-20");
});

test("Vault editor, saved view, appearance and narrow viewport bounds", async ({ page }, testInfo) => {
  await page.goto(`/index.html#/r/${fixture.records[1]}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(`\nSafari editor ${testInfo.project.name}`);
  await expect.poll(async () => (await (await page.request.get(`/api/record/${fixture.records[1]}`)).json()).record.body).toContain(`Safari editor ${testInfo.project.name}`);
  await page.goto(`/index.html#/v/${fixture.view}`);
  await expect(page.locator(".surface-grid")).toBeVisible();
  await page.locator(".surface-grid").evaluate(el => el.scrollTo(200, 3000));
  await expect.poll(() => alignment(page)).toEqual([]);
  await openData(page);
  await page.locator(".app-account-trigger").click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("dark.png") });
});

test("install metadata preserves app and workspace and icons are PNG", async ({ page }) => {
  const state = await (await page.request.get("/api/state")).json();
  for (const [path, expected] of [["/", "Vault"], ["/data/", "Data View"]]) {
    const start = `/w/${state.workspace.id}${path}`;
    await page.goto(start);
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(href).toBeTruthy();
    const response = await page.request.get(new URL(href!, page.url()).href);
    expect(response.headers()["content-type"]).toBe("application/manifest+json");
    expect(response.headers()["cache-control"]).toBe("no-cache");
    const manifest = await response.json();
    expect(manifest).toMatchObject({ name: expected, id: start, start_url: start, scope: start, display: "standalone" });
    for (const icon of manifest.icons.filter((icon: { type: string }) => icon.type === "image/png")) {
      const image = await page.request.get(icon.src);
      expect(image.headers()["content-type"]).toBe("image/png");
      expect((await image.body()).subarray(1, 4).toString()).toBe("PNG");
    }
    expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")).toBe("/icon-180.png");
  }
});

test("tables and grouping load without native iterator helpers", async ({ page }) => {
  // Reproduce the runtime API gap in Safari 17 without pretending to emulate
  // that browser's rendering engine.
  await page.addInitScript(() => {
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    delete prototype.map;
    delete prototype.toArray;
    Object.defineProperty(globalThis, "Iterator", { value: undefined, writable: true, configurable: true });
  });
  await openData(page);
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByLabel("Pick a field to group by").selectOption("status");
  await expect(page.locator(".rdg-group-row").first()).toBeVisible();
  await expect(page.locator(".sg-title-text").first()).toBeVisible();
});
