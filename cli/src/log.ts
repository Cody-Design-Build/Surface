// One log file for every Surface process on this computer: servers, CLI commands, sync.
//
// Where:  Linux   $XDG_STATE_HOME/surface/surface.log  (~/.local/state/surface/surface.log)
//         macOS   ~/Library/Logs/Surface/surface.log
//         Windows %LOCALAPPDATA%\Surface\Logs\surface.log
//         SURFACE_LOG_FILE overrides; SURFACE_LOG_FILE=off turns file logging off.
// Level:  SURFACE_LOG=debug|info|warn|error (default info). debug adds every request and every
//         record a sync sends or receives.
// Format: one line per event, readable and greppable:
//         2026-10-18T17:02:11.123Z INFO  sync   [serve:4317 pid 1234] round done {"ws":"…","pushed":1,"ms":240}
// Rotation: at 5 MB the file moves to surface.log.1 (keeps .1–.3).
// Never log tokens, passwords, keys or record bodies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export function logFile(): string | null {
  const env = process.env.SURFACE_LOG_FILE;
  if (env === "off") return null;
  if (env) return env;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", "Surface", "surface.log");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Surface", "Logs", "surface.log");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "surface", "surface.log");
}

const threshold = (): number => ORDER[(process.env.SURFACE_LOG as Level) in ORDER ? (process.env.SURFACE_LOG as Level) : "info"];
export const debugOn = () => threshold() <= ORDER.debug;

let role = `cli`;
/** Name this process in every line, e.g. "serve:4317", "data:4318", "cli push". */
export function setRole(r: string) {
  role = r;
}

const SECRET = /(token|password|secret|apikey|api_key|authorization|cookie|key)$/i;
function scrub(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return { error: v.message, stack: v.stack?.split("\n").slice(1, 4).map((s) => s.trim()).join(" | ") };
  if (!v || typeof v !== "object" || depth > 3) return typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET.test(k) ? "[redacted]" : scrub(x, depth + 1);
  return out;
}

let fd: number | null = null;
let failed = false;
function write(line: string) {
  const file = logFile();
  if (!file || failed) return;
  try {
    if (fd === null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, "a");
    }
    if (fs.fstatSync(fd).size > MAX_BYTES) {
      fs.closeSync(fd);
      for (let i = KEEP - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      fs.renameSync(file, `${file}.1`);
      fd = fs.openSync(file, "a");
    }
    fs.writeSync(fd, line);
  } catch {
    failed = true; // logging must never break Surface
  }
}

export function log(level: Level, area: string, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const extra = data && Object.keys(data).length ? " " + JSON.stringify(scrub(data)) : "";
  write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${area.padEnd(6)} [${role} pid ${process.pid}] ${msg}${extra}\n`);
}

export const logger = (area: string) => ({
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", area, msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", area, msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", area, msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", area, msg, data),
});

/** Crashes and stray promise errors get logged before the process dies. */
let hooked = false;
export function hookProcess() {
  if (hooked) return;
  hooked = true;
  const L = logger("proc");
  process.on("uncaughtException", (e) => {
    L.error("uncaught exception", { err: e });
    console.error(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => L.error("unhandled promise rejection", { err: e instanceof Error ? e : String(e) }));
  process.on("exit", (code) => {
    if (role.startsWith("serve") || role.startsWith("data")) L.info("stopped", { code });
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.prependListener(sig, () => L.info(`got ${sig}`));
}
