// Global config (session, server) and checkout config (.surface/ in a folder).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Public project values (src/project.json). The publishable key is designed to be shipped
// in clients; row-level security does the protecting. Override with env vars.
const project = JSON.parse(fs.readFileSync(new URL("./project.json", import.meta.url), "utf8")) as { url: string; publishableKey: string };
export const SUPABASE_URL = process.env.SURFACE_SUPABASE_URL ?? project.url;
export const PUBLISHABLE_KEY = process.env.SURFACE_PUBLISHABLE_KEY ?? project.publishableKey;

export const CONFIG_DIR = process.env.SURFACE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "surface-cli"); // ~/.config/surface holds an older, unrelated tool

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode });
}

export type Layout = "type" | "flat" | "folder";

export interface CheckoutConfig {
  workspace: string;
  workspaceName?: string;
  layout: Layout;
  only?: string[]; // limit the checkout to these type keys
}

export interface FileState {
  path: string; // relative to the checkout root
  rev: number;
  hash: string; // hash of the file as Surface last wrote it
}

export interface CheckoutState {
  records: Record<string, FileState>;
  pulledAt?: string;
}

export interface Checkout {
  root: string;
  config: CheckoutConfig;
  state: CheckoutState;
}

export function findCheckout(start = process.cwd()): Checkout | null {
  let dir = path.resolve(start);
  while (true) {
    const cfg = path.join(dir, ".surface", "config.json");
    if (fs.existsSync(cfg)) {
      return {
        root: dir,
        config: readJson<CheckoutConfig>(cfg, { workspace: "", layout: "type" }),
        state: readJson<CheckoutState>(path.join(dir, ".surface", "state.json"), { records: {} }),
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function saveCheckout(co: Checkout) {
  writeJson(path.join(co.root, ".surface", "config.json"), co.config);
  writeJson(path.join(co.root, ".surface", "state.json"), co.state);
}
