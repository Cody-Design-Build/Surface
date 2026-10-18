// The cloud is optional and yours: a Supabase project you (or your team) own. Surface has no
// hosted service. This file holds the helpers to set one up and to bring teammates in:
//
//   surface cloud connect <url> <publishable key>   point this computer at a project
//   surface cloud schema [--out file]               the SQL that sets up a new project
//   surface cloud status                            which project, signed in as, schema ready?
//   surface workspace invite <email>                invite + a message with a `surface join` code
//   surface join <code>                             a teammate's one command: connect, sign in, join, copy
//
// The URL and publishable key are designed to ship in clients (row-level security protects the
// data), so an invite code carries them in the clear. It carries no password or secret key.
import fs from "node:fs";
import path from "node:path";
import { CLOUD_FILE, cloudConfig, saveCloudConfig, type CloudConfig } from "./config.ts";
import { MIGRATIONS_DIR } from "./local.ts";

export const INVITE_PREFIX = "surface-invite:";

export interface InviteCode {
  url: string;
  key: string;
  workspace: string;
  workspaceName?: string;
  email: string;
  project?: string;
}

export function encodeInvite(i: InviteCode): string {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(i)).toString("base64url");
}

export function decodeInvite(code: string): InviteCode {
  const raw = code.trim().replace(/^["']|["']$/g, "");
  if (!raw.startsWith(INVITE_PREFIX)) throw new Error("That isn't a Surface invite code (it starts with surface-invite:).");
  let i: InviteCode;
  try {
    i = JSON.parse(Buffer.from(raw.slice(INVITE_PREFIX.length), "base64url").toString("utf8")) as InviteCode;
  } catch {
    throw new Error("That invite code is damaged. Copy the whole line again.");
  }
  if (!i.url || !i.key || !i.workspace || !i.email) throw new Error("That invite code is incomplete.");
  return i;
}

/** Normalize what people paste: a project ref, a dashboard link, or the API URL. */
export function projectUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  const ref = /supabase\.com\/dashboard\/project\/([a-z0-9]{20})/.exec(s)?.[1] ?? (/^[a-z0-9]{20}$/.test(s) ? s : null);
  if (ref) return `https://${ref}.supabase.co`;
  if (!/^https?:\/\//.test(s)) throw new Error(`"${input}" doesn't look like a Supabase project URL (https://<ref>.supabase.co).`);
  return s;
}

export function checkKey(key: string) {
  const k = key.trim();
  if (k.startsWith("sb_secret_") || /service_role/.test(Buffer.from(k.split(".")[1] ?? "", "base64").toString("utf8")))
    throw new Error("That's a secret (service role) key. Surface needs the publishable key (sb_publishable_…, or the legacy anon key). Never share the secret key.");
  if (!k.startsWith("sb_publishable_") && !k.startsWith("eyJ")) throw new Error("That doesn't look like a Supabase publishable key (sb_publishable_…).");
  return k;
}

export function connect(c: CloudConfig): { replaced: CloudConfig | null } {
  const before = cloudConfig();
  saveCloudConfig({ ...c, url: projectUrl(c.url), publishableKey: checkKey(c.publishableKey) });
  return { replaced: before && before.url !== c.url ? before : null };
}

export function disconnect() {
  fs.rmSync(CLOUD_FILE, { force: true });
}

/** Every migration in order, as one script for the Supabase SQL editor (or psql). */
export function schemaSql(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const head = `-- Surface schema: paste into your Supabase project's SQL editor (Dashboard → SQL Editor → New query) and Run.
-- Creates Surface's tables, rules and functions in a new, empty project. Generated from supabase/migrations (${files.length} files).
-- Safe to read: it creates tables, row-level security policies and functions. It reads no existing data.
`;
  return head + files.map((f) => `\n-- ===== ${f} =====\n` + fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).join("\n");
}

export function dashboardSqlUrl(url: string): string | null {
  const ref = /^https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(url)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : null;
}

/** Ready-to-send invite text. Plain enough for email, Slack or a text message. */
export function inviteMessage(i: InviteCode, from?: string): { subject: string; body: string; code: string } {
  const code = encodeInvite(i);
  const ws = i.workspaceName ?? "our workspace";
  const subject = `Join "${ws}" on Surface`;
  const body = `${from ? `${from} invited you` : "You're invited"} to "${ws}" on Surface.

1. Install Surface (Mac or Linux), once:

   git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
   ~/Developer/Surface/install.sh

2. Join, with this one command:

   surface join ${code}

It connects to the team's database, asks you to create an account (or sign in) as ${i.email}, and puts a copy of "${ws}" on your computer. It keeps working offline and syncs when you're online.

The code contains the team database's address and your email, nothing secret. It only works for ${i.email}.
`;
  return { subject, body, code };
}

export function mailtoUrl(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
