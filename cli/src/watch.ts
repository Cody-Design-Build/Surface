// Push on save: watch a checkout and send edited Markdown (and view YAML) to the database.
//
// Any editor works (Obsidian, VS Code, vim, an agent): a save changes the file on disk, the
// watcher notices, waits for the burst of writes to settle, then runs the same `push` as
// `surface push --new`. That does the work: it finds files whose content differs from what
// Surface last wrote, normalizes and validates them, checks revisions, and adds new files as
// records. Files Surface itself writes (normalized values, pulls) hash-match and are skipped.
//
// Deleting a file never deletes its record; it's reported so the person can run `surface rm`
// or `surface pull` to bring it back.
import fs from "node:fs";
import path from "node:path";
import { findCheckout, type Checkout } from "./config.ts";
import { push, type FileResult } from "./checkout.ts";

const IGNORE = /(^|[\\/])(\.git|\.obsidian|\.trash|node_modules|\.agents)([\\/]|$)|(^|[\\/])\.surface[\\/](?!views[\\/])|~$|\.swp$|\.tmp$|\.crswap$/;

export interface WatchOptions {
  /** Delay after the last change before pushing (editors write in bursts). */
  settleMs?: number;
  /** Run fn with exclusive access to the checkout (serve shares one with its pull loop). */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Called after each push that did something. */
  onPushed?: (results: FileResult[]) => void;
  log?: (line: string) => void;
}

export function watchCheckout(getCo: () => Checkout, opts: WatchOptions = {}) {
  const settle = opts.settleMs ?? 400;
  const log = opts.log ?? ((s: string) => console.log(s));
  const exclusive = opts.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let again = false;
  const missingReported = new Set<string>();

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await exclusive(async () => {
        const co = getCo();
        // other processes (CLI, agents) update .surface/state.json: start from what's on disk
        const disk = findCheckout(co.root);
        if (disk) {
          co.config = disk.config;
          co.state = disk.state;
        }
        const results = await push(co, { includeNew: true });
        const acted = results.filter((r) => r.status !== "unchanged" || r.notices.length);
        const stamp = new Date().toLocaleTimeString();
        for (const r of acted) {
          const what = { pushed: "saved", created: "added", rejected: "rejected", conflict: "conflict", error: "error", untracked: "new", unchanged: "normalized" }[r.status];
          log(`${stamp}  ${what.padEnd(10)} ${r.path}`);
          for (const n of r.notices) log(`             ~ ${n}`);
          for (const e of r.errors) log(`             ✗ ${e}`);
          if (r.status === "conflict") log(`             changed elsewhere too: \`surface diff ${r.path}\`, then push --force or pull --force`);
        }
        for (const [id, st] of Object.entries(co.state.records)) {
          const gone = !fs.existsSync(path.join(co.root, st.path));
          if (gone && !missingReported.has(id)) {
            missingReported.add(id);
            log(`${stamp}  ${"removed".padEnd(10)} ${st.path}  (record kept: \`surface rm ${id}\` to delete it, \`surface pull\` to restore the file)`);
          } else if (!gone) missingReported.delete(id);
        }
        if (acted.length) opts.onPushed?.(results);
      });
    } catch (e) {
      log(`watch: ${(e as Error).message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, settle);
  }

  const root = getCo().root;
  const watcher = fs.watch(root, { recursive: true }, (_event, file) => {
    if (!file) return schedule();
    const rel = file.toString();
    if (IGNORE.test(rel)) return;
    if (!rel.toLowerCase().endsWith(".md") && !/^\.surface[\\/]views[\\/].*\.yaml$/.test(rel) && path.extname(rel)) return;
    schedule();
  });
  watcher.on("error", (e) => log(`watch: ${e.message}`));
  schedule(); // pick up anything edited while nothing was watching
  return { close: () => (timer && clearTimeout(timer), watcher.close()), flush: run };
}
