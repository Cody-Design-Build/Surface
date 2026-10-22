// Computer-wide app information. Cached account details are display-only, never authorization.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG_DIR, cloudConfig, readJson } from "./config.ts";
import { ROOT } from "./service.ts";
import { cachedUpdate } from "./update.ts";

export function signedInAccount() {
  const config = cloudConfig();
  if (!config) return null;
  const saved = readJson<Record<string, string>>(path.join(CONFIG_DIR, "session.json"), {});
  try {
    const key = `sb-${new URL(config.url).hostname.split(".")[0]}-auth-token`;
    const session = JSON.parse(saved[key] ?? "null");
    if (!session?.access_token || !session?.refresh_token || !session.user?.id || !session.user?.email) return null;
    const user = session.user;
    const name = user.user_metadata?.full_name ?? user.user_metadata?.name ?? user.user_metadata?.display_name;
    return { id: String(user.id), email: String(user.email), name: typeof name === "string" ? name : null };
  } catch { return null; }
}

/** Read the checkout revision without a subprocess or a network request. */
export function installedVersion() {
  const number = readJson<{version: string}>(path.join(ROOT, "cli/package.json"), {version: "unknown"}).version;
  let commit: string | null = null;
  try {
    let git = path.join(ROOT, ".git");
    if (fs.statSync(git).isFile()) git = path.resolve(ROOT, fs.readFileSync(git, "utf8").trim().replace(/^gitdir: /, ""));
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) commit = head;
    else {
      const ref = head.slice(5);
      const commonFile = path.join(git, "commondir");
      const common = fs.existsSync(commonFile) ? path.resolve(git, fs.readFileSync(commonFile, "utf8").trim()) : git;
      const loose = path.join(common, ref);
      commit = fs.existsSync(loose) ? fs.readFileSync(loose, "utf8").trim() : fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n").find(line => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
    }
    if (commit && !/^[a-f0-9]{40,64}$/.test(commit)) commit = null;
  } catch { /* Source archives may have no Git metadata. */ }
  return { number, commit };
}

/** Classify a failed operation separately from endpoint reachability. */
export function statusErrorKind(error: unknown): "network" | "auth" | "database" {
  const e = error as { message?: string; code?: string; status?: number } | null;
  const message = String(e?.message ?? error);
  if (e?.code === "offline" || /(?:^offline:|fetch failed|failed to fetch|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network|timed? ?out)/i.test(message)) return "network";
  if (e?.status === 401 || e?.status === 403 || ["42501", "PGRST301", "PGRST302"].includes(e?.code ?? "") ||
      /JWT|not signed in|sign in|invalid.*token|token.*expired|refresh.*token|permission|row.level security|unauthorized|forbidden/i.test(message)) return "auth";
  return "database";
}

export interface CloudConnectivity {
  state: "online" | "unreachable" | "unknown" | "unconfigured";
  target: string | null;
  checkedAt: string | null;
  checking: boolean;
}
const CONNECTIVITY_TTL = 30_000;
let connectivity: CloudConnectivity = { state: "unconfigured", target: null, checkedAt: null, checking: false };

/** Observe this server's configured endpoint, not the browser's network or the whole internet. */
function cloudConnectivity(): CloudConnectivity {
  const config = cloudConfig();
  let target: string | null = null;
  if (config) {
    try {
      const url = new URL(config.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported cloud URL");
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/auth/v1/health`;
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      target = url.href;
    } catch { /* Invalid configuration is unknown, not a network outage. */ }
  }
  if (!config || !target) {
    connectivity = { state: config ? "unknown" : "unconfigured", target, checkedAt: null, checking: false };
    return { ...connectivity };
  }
  if (connectivity.target !== target) connectivity = { state: "unknown", target, checkedAt: null, checking: false };
  if (!connectivity.checking && (!connectivity.checkedAt || Date.now() - Date.parse(connectivity.checkedAt) >= CONNECTIVITY_TTL)) {
    const observation = connectivity;
    observation.checking = true;
    // No credentials, redirects, third-party probes, database reads, or subprocesses.
    void (async () => {
      try {
        const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: "manual" });
        // Even an HTTP auth/service error proves endpoint reachability, not database health.
        void response.body?.cancel().catch(() => {});
        observation.state = "online";
      } catch {
        observation.state = "unreachable";
      } finally {
        observation.checkedAt = new Date().toISOString();
        observation.checking = false;
      }
    })();
  }
  return { ...connectivity };
}

export function systemInfo(runningVersion = installedVersion()) {
  // Cached release discovery is display-only; browser requests cannot install updates.
  const version = installedVersion();
  return { machine: os.hostname(), account: signedInAccount(), version, runningVersion, update: cachedUpdate(version.commit), cloudConnectivity: cloudConnectivity() };
}
