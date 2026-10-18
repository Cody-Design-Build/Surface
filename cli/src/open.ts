// `surface open [view|record]`: show a surface in its own browser window.
//
// Finds the running `surface serve` for this computer (or starts one in the background),
// makes sure it's showing this checkout's workspace, then opens the page as an app window
// (Chrome/Chromium/Brave/Edge `--app=`), falling back to the default browser.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR, type Checkout } from "./config.ts";

const RUNNING_FILE = path.join(CONFIG_DIR, "serve.json");
const TOKEN_FILE = path.join(CONFIG_DIR, "serve-token");

export function announceRunning(port: number, root: string) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(RUNNING_FILE, JSON.stringify({ pid: process.pid, port, root }));
  const clear = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(RUNNING_FILE, "utf8"));
      if (cur.pid === process.pid) fs.rmSync(RUNNING_FILE);
    } catch {}
  };
  process.on("exit", clear);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function call(port: number, token: string, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { cookie: `surface_token=${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as Record<string, unknown>;
}

async function running(): Promise<{ port: number; root: string } | null> {
  try {
    const r = JSON.parse(fs.readFileSync(RUNNING_FILE, "utf8"));
    if (!alive(r.pid)) return null;
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    await call(r.port, token, "GET", "/api/state");
    return r;
  } catch {
    return null;
  }
}

async function start(co: Checkout, port: number): Promise<number> {
  const bin = process.argv[1];
  const log = path.join(CONFIG_DIR, "serve.log");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const out = fs.openSync(log, "a");
  const child = spawn(process.execPath, [...process.execArgv, bin, "serve", "--port", String(port)], { cwd: co.root, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const r = await running();
    if (r) return r.port;
    if (child.exitCode !== null) break;
  }
  throw new Error(`surface serve didn't start. See ${log}`);
}

function appBrowsers(): string[] {
  if (process.platform === "darwin")
    return ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge", "Arc"]
      .map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`)
      .filter((p) => fs.existsSync(p) || fs.existsSync(p.replace("/Applications", os.homedir() + "/Applications")));
  if (process.platform === "win32") return [];
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave", "brave-browser", "microsoft-edge"];
  return names.filter((n) => spawnSync("sh", ["-c", `command -v ${n}`]).status === 0);
}

export function openWindow(url: string, opts: { tab?: boolean } = {}): string {
  if (!opts.tab) {
    for (const b of appBrowsers()) {
      // a separate profile dir keeps the window from attaching to an existing browser session
      // as a plain tab, and gives Surface its own window/dock icon
      const profile = path.join(CONFIG_DIR, "app-window");
      const p = spawn(b, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1360,880"], { detached: true, stdio: "ignore" });
      p.unref();
      return `app window (${path.basename(b)})`;
    }
  }
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  return "default browser";
}

/** Build the URL for a target (view key or record id) and open it. */
export async function openSurface(co: Checkout, target: { view?: string; record?: string } | null, opts: { port: number; tab?: boolean; print?: boolean }) {
  let r = await running();
  let started = false;
  if (!r) {
    // let go of the local database first: serve needs it, and waits for whoever holds it
    const { storeKind } = await import("./client.ts");
    if (storeKind() === "local") await (await import("./local.ts")).closeLocal();
    await start(co, opts.port);
    r = await running();
    started = true;
  }
  if (!r) throw new Error("couldn't reach surface serve");
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (path.resolve(r.root) !== path.resolve(co.root)) {
    await call(r.port, token, "POST", "/api/workspace/switch", { id: co.config.workspace });
  }
  const hash = target?.view ? `#/v/${encodeURIComponent(target.view)}` : target?.record ? `#/r/${target.record}` : "";
  const url = `http://127.0.0.1:${r.port}/?token=${token}${hash}`;
  if (opts.print) return { url, how: "printed", started };
  return { url, how: openWindow(url, { tab: opts.tab }), started };
}
