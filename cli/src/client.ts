// Supabase client with the session kept in ~/.config/surface/session.json.
import path from "node:path";
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CONFIG_DIR, PUBLISHABLE_KEY, SUPABASE_URL, readJson, writeJson } from "./config.ts";

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

export function sb(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

export async function requireUser() {
  const { data, error } = await sb().auth.getUser();
  if (error || !data.user) {
    throw new UserError("Not signed in. Run `surface login` (or `surface signup`).");
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
