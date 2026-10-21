// Disposable local database + the real production HTTP server and built UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "surface-browser-"));
const workspace = path.join(scratch, "workspace");
const config = path.join(scratch, "config");
const marker = fileURLToPath(new URL("../.browser-qa.json", import.meta.url));
fs.rmSync(marker, { force: true });
const env = { ...process.env, SURFACE_STORE: "local", SURFACE_CONFIG_DIR: config, SURFACE_DATA_DIR: path.join(scratch, "data"), SURFACE_SYNC: "off", SURFACE_LOG_FILE: "off" };
const run = (...args) => execFileSync(process.execPath, ["--no-warnings", cli, ...args], { env, encoding: "utf8" });
run("init", workspace, "--create", "Safari Browser QA");
const child = spawn(process.execPath, ["--no-warnings", cli, "serve", "--port", "4394", "--no-watch"], { cwd: workspace, env, stdio: "inherit" });
let stopping = false;
function stop() { if (!stopping) { stopping = true; child.kill("SIGTERM"); } }
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
child.on("exit", code => { fs.rmSync(marker, { force: true }); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(stopping ? 0 : code ?? 1); });
const base = "http://127.0.0.1:4394";
try {
  let token;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error("Test server exited during startup");
    try {
      token = fs.readFileSync(path.join(config, "serve-token"), "utf8").trim();
      if ((await fetch(`${base}/api/state`, { headers: { cookie: `surface_token=${token}` } })).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function request(url, method = "GET", body) {
    const response = await fetch(base + url, { method, headers: { cookie: `surface_token=${token}`, origin: base, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(`${url}: ${JSON.stringify(result)}`);
    return result;
  }
  await request("/api/types", "POST", { key: "task", name: "Tasks" });
  await request("/api/type/task", "PUT", { fields: [
    { key: "status", name: "Status", kind: "select", options: ["To do", "Doing", "Done"] },
    { key: "owner", name: "Owner", kind: "text" },
    { key: "cost", name: "Cost", kind: "number" },
    { key: "due", name: "Due", kind: "date" },
    { key: "done", name: "Complete", kind: "checkbox" },
    { key: "notes", name: "Notes", kind: "text" },
  ] });
  const records = [];
  for (let i = 0; i < 320; i++) records.push((await request("/api/records", "POST", {
    type: "task", title: `Task ${String(i).padStart(4, "0")}`, body: "# Browser QA\n\nEditable **Markdown** with a [[Task 0001]] link.\n\n- [ ] Test Safari\n",
    fields: { status: ["To do", "Doing", "Done"][i % 3], owner: `Owner ${i % 7}`, cost: i * 17, due: "2026-11-15", done: i % 2 === 0, notes: `Row ${i} – long text for horizontal scrolling` },
  })).record);
  const view = (await request("/api/views", "POST", { name: "Browser QA", personal: false, definition: { from: "task", sort: "title", layouts: [{ show: "table", columns: ["status", "owner", "cost", "due", "done", "notes"], widths: { title: 280, status: 180, owner: 220, cost: 150, due: 160, notes: 420 }, frozen: 1 }] } })).view;
  fs.writeFileSync(marker, JSON.stringify({ token, config, workspace, records: records.map(r => r.id), view: view.key }));
  console.log("Browser QA ready: 320 disposable records, real API, no business data");
} catch (error) { console.error(error); stop(); }
