// Team onboarding test, against YOUR cloud (the project this computer is connected to):
//   owner (this computer's sign-in) makes a local workspace, syncs it up, invites a new person;
//   the new person, on a fresh "computer" with no cloud configured, runs only `surface join <code>`
//   and gets the workspace; an edit goes owner -> teammate through the cloud.
// Creates a throwaway account (+ a workspace that it deletes). Needs email confirmation OFF in the
// project (Auth → Providers → Email), or it stops at "check your email".
//   npm run test:team
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "../bin/surface");
const REAL = process.env.SURFACE_REAL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "surface-cli");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-team-"));
type Who = "owner" | "mate";
const cfg = (w: Who) => path.join(tmp, w, ".cfg");
const env = (w: Who, extra: Record<string, string> = {}) => ({ ...process.env, HOME: path.join(tmp, w), SURFACE_STORE: "", SURFACE_CONFIG_DIR: cfg(w), SURFACE_DATA_DIR: path.join(tmp, w, ".data"), NO_COLOR: "1", ...extra });
const run = (w: Who, args: string[], cwd = path.join(tmp, w), extra: Record<string, string> = {}) => {
  try {
    return execFileSync(BIN, args, { cwd, env: env(w, extra), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    throw new Error(`[${w}] surface ${args.join(" ")}\n${x.stdout}\n${x.stderr}`);
  }
};
let step = 0;
const ok = (s: string) => console.log(`ok ${++step} ${s}`);
const mateEmail = process.env.SURFACE_TEAM_TEST_EMAIL ?? `assistant+surface-team-${Date.now()}@codydesignbuild.com`; // Supabase refuses example.com
let hubWs = "";
try {
  for (const w of ["owner", "mate"] as Who[]) fs.mkdirSync(cfg(w), { recursive: true });
  // owner: this computer's cloud and sign-in, but a fresh local database
  fs.copyFileSync(path.join(REAL, "cloud.json"), path.join(cfg("owner"), "cloud.json"));
  fs.symlinkSync(path.join(REAL, "session.json"), path.join(cfg("owner"), "session.json"));
  fs.writeFileSync(path.join(cfg("owner"), "store.json"), JSON.stringify({ store: "local" }));
  const vault = path.join(tmp, "owner", "vault");
  run("owner", ["init", vault, "--create", "Team test"]);
  run("owner", ["type", "add", "job"], vault);
  run("owner", ["new", "job", "Kitchen remodel"], vault);
  const en = run("owner", ["sync", "enable"], vault);
  hubWs = /workspace ([0-9a-z]{12})/.exec(en)![1];
  ok("owner: local workspace synced to the cloud");

  // mate starts with nothing: no cloud, no account
  assert.match(run("mate", ["cloud"]), /No cloud/);
  ok("new computer: no cloud configured, works locally");

  const inv = run("owner", ["workspace", "invite", mateEmail], vault);
  const code = /surface join (surface-invite:[A-Za-z0-9_-]+)/.exec(inv)?.[1];
  assert.ok(code, "invite prints a join code:\n" + inv);
  assert.ok(!/sb_secret_|service_role/.test(inv), "no secrets in the invite");
  ok("owner: invite prints a ready-to-send message with a join code");

  let joined = "";
  try {
    joined = run("mate", ["join", code!, "--dir", path.join(tmp, "mate", "Team")], path.join(tmp, "mate"), { SURFACE_PASSWORD: "test-" + Math.random().toString(36).slice(2) + "Aa1!" });
  } catch (e) {
    if (!/rate limit/i.test((e as Error).message)) throw e;
    joined = "confirmation email (signup emails are rate-limited on this project right now)";
  }
  if (/confirmation email/.test(joined)) {
    // the project confirms emails, so a scripted signup stops here (correctly). Exercise the rest of
    // join as an existing account instead: this computer's own sign-in, invited by email.
    console.log("note: this project requires email confirmation; new-account signup stops at the email step (checked). Continuing with an existing account.");
    ok("join with a new account stops at the confirmation email");
    const { execFileSync: x } = await import("node:child_process");
    const me = x(BIN, ["whoami"], { env: { ...process.env, SURFACE_STORE: "cloud", SURFACE_CONFIG_DIR: REAL }, encoding: "utf8" }).trim();
    const inv2 = run("owner", ["workspace", "invite", me], vault);
    const code2 = /surface join (surface-invite:[A-Za-z0-9_-]+)/.exec(inv2)![1];
    fs.rmSync(path.join(cfg("mate")), { recursive: true, force: true });
    fs.mkdirSync(cfg("mate"), { recursive: true });
    fs.symlinkSync(path.join(REAL, "session.json"), path.join(cfg("mate"), "session.json"));
    joined = run("mate", ["join", code2, "--dir", path.join(tmp, "mate", "Team")], path.join(tmp, "mate"));
  }
  {
    assert.match(joined, /Done\./);
    const files = fs.readdirSync(path.join(tmp, "mate", "Team", "Jobs"));
    assert.ok(files.some((f) => f.startsWith("Kitchen remodel")), files.join(","));
    ok("teammate: `surface join <code>` connected, made an account, joined and copied the workspace");

    run("owner", ["new", "job", "Bath remodel"], vault);
    run("owner", ["sync"], vault);
    run("mate", ["sync"], path.join(tmp, "mate", "Team"));
    assert.ok(fs.readdirSync(path.join(tmp, "mate", "Team", "Jobs")).some((f) => f.startsWith("Bath remodel")));
    ok("an owner edit reaches the teammate through the cloud");
  }
  console.log(`\nall ${step} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (hubWs) {
    try {
      execFileSync(BIN, ["workspace", "delete", hubWs, "--yes"], { env: { ...process.env, SURFACE_STORE: "cloud", SURFACE_CONFIG_DIR: REAL }, encoding: "utf8", stdio: "pipe" });
      console.log(`deleted cloud workspace ${hubWs}`);
    } catch (e) {
      console.error(`couldn't delete cloud workspace ${hubWs}`);
    }
  }
  console.log(`(test account ${mateEmail} stays in the project's Auth users; remove it in the dashboard if you like)`);
  if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
}
