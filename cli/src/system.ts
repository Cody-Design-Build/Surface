// Computer-wide app information. Cached account details are display-only, never authorization.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG_DIR, cloudConfig, readJson } from "./config.ts";
import { ROOT } from "./service.ts";
import { cachedUpdate, updateJobStatus } from "./update.ts";

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

export function systemInfo(runningVersion = installedVersion()) {
  // The worker checks the checkout on disk. A long-lived server can still be
  // running an earlier revision after a commit or pull; don't discard its results.
  const version = installedVersion();
  return { machine: os.hostname(), account: signedInAccount(), version, runningVersion, update: { ...cachedUpdate(version.commit), job: updateJobStatus() } };
}
