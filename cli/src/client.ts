// Supabase client with the session kept in ~/.config/surface/session.json.
import path from "node:path";
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CONFIG_DIR, PUBLISHABLE_KEY, SUPABASE_URL, readJson, writeJson } from "./config.ts";
import { localClient } from "./local.ts";

const SESSION_FILE = path.join(CONFIG_DIR, "session.json");

const fileStorage = {
  getItem(key: string) {
    const all = readJson<Record<string, string>>(SESSION_FILE, {});
    return all[key] ?? null;
  },
  setItem(key: string, value: string) {
    const all = readJson<Record<string, string>>(SESSION_FILE, {});
    all[key] = value;
    writeJson(SESSION_FILE, all, 0o600);
  },
  removeItem(key: string) {
    const all = readJson<Record<string, string>>(SESSION_FILE, {});
    delete all[key];
    writeJson(SESSION_FILE, all, 0o600);
  },
};

let client: SupabaseClient | null = null;

const STORE_FILE = path.join(CONFIG_DIR, "store.json");

/** Where this computer's data lives: "local" (Surface's own Postgres, no account) or "cloud"
 *  (the hosted database, signed in). SURFACE_STORE overrides; computers that signed in to the
 *  cloud before local mode existed stay on the cloud. */
export function storeKind(): "local" | "cloud" {
  const env = process.env.SURFACE_STORE;
  if (env === "local" || env === "cloud") return env;
  const saved = readJson<{ store?: string }>(STORE_FILE, {}).store;
  if (saved === "local" || saved === "cloud") return saved;
  return fs.existsSync(SESSION_FILE) ? "cloud" : "local";
}
export function setStoreKind(kind: "local" | "cloud") {
  writeJson(STORE_FILE, { store: kind });
  client = null;
}

export function sb(): SupabaseClient {
  if (!client && storeKind() === "local") client = localClient() as unknown as SupabaseClient;
  if (!client) {
    client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

/** The hosted database, whatever this computer's store is (a sync hub for local workspaces). */
let cloud: SupabaseClient | null = null;
export function cloudClient(): SupabaseClient {
  if (storeKind() === "cloud") return sb();
  cloud ??= createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return cloud;
}

export async function requireUser() {
  const { data, error } = await sb().auth.getUser();
  if (error || !data.user) {
    throw new UserError(storeKind() === "local" ? `Local database unavailable: ${error?.message ?? "unknown error"}` : "Not signed in. Run `surface login` (or `surface signup`).");
  }
  return data.user;
}

export function clearSession() {
  if (fs.existsSync(SESSION_FILE)) fs.rmSync(SESSION_FILE);
}

/** An error meant for the person at the terminal: printed without a stack trace. */
export class UserError extends Error {}

/** Turn a Postgres/PostgREST error into a readable message. */
export function dbError(error: { message: string; details?: string | null; hint?: string | null }): UserError {
  let msg = error.message;
  for (const prefix of ["invalid_record: ", "invalid_field: ", "invalid_type: "]) {
    if (msg.startsWith(prefix)) msg = msg.slice(prefix.length);
  }
  if (msg.includes("row-level security")) msg = "You don't have permission to do that in this workspace.";
  return new UserError(msg);
}
