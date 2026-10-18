// `surface setup`: install and configure the whole system on this computer.
// `surface doctor`: check it. Both are safe to re-run.
//
// The shell bootstrap (../../install.sh) gets Node and the CLI's packages in place, then runs
// `surface setup`, which does everything else: the web UI build, `surface` on the PATH, the
// local database, a first workspace and checkout, and (optionally) a login service.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CONFIG_DIR } from "./config.ts";
import { setStoreKind, storeKind, UserError } from "./client.ts";

const CLI_DIR = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(CLI_DIR, "..");
const APP_DIR = path.join(ROOT, "app");
const BIN = path.join(CLI_DIR, "bin", "surface");

const green = (s: string) => (process.env.NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`);
const yellow = (s: string) => (process.env.NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`);
const red = (s: string) => (process.env.NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`);
const dim = (s: string) => (process.env.NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`);
const step = (s: string) => console.log(`\n${s}`);
const ok = (s: string) => console.log(`  ${green("✓")} ${s}`);
const warn = (s: string) => console.log(`  ${yellow("!")} ${s}`);
const bad = (s: string) => console.log(`  ${red("✗")} ${s}`);

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) throw new UserError(`\`${cmd} ${args.join(" ")}\` failed in ${cwd}:\n${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout;
}

function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

function nodeOk() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj > 23 || (maj === 23 && min >= 6);
}

function onPath(): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? ["surface"] : ["-c", "command -v surface"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Put `surface` on the PATH: a symlink in ~/.local/bin (no sudo). */
function linkBin(): string {
  const existing = onPath();
  if (existing) {
    try {
      if (fs.realpathSync(existing) === fs.realpathSync(BIN)) return existing;
    } catch {}
  }
  const dir = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, "surface");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(BIN, link);
  return link;
}

function serviceFiles(port: number, checkout: string) {
  const node = process.execPath;
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", "dev.surface.serve.plist");
    const log = path.join(os.homedir(), "Library", "Logs", "surface-serve.log");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.surface.serve</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>--no-warnings</string><string>${path.join(CLI_DIR, "src", "main.ts")}</string><string>serve</string><string>--port</string><string>${port}</string></array>
  <key>WorkingDirectory</key><string>${checkout}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
    return { file, body, start: [["launchctl", "unload", file], ["launchctl", "load", "-w", file]], logs: `tail -f ${log}` };
  }
  const file = path.join(os.homedir(), ".config", "systemd", "user", "surface.service");
  const body = `[Unit]
Description=Surface (surface serve)

[Service]
WorkingDirectory=${checkout}
ExecStart=${node} --no-warnings ${path.join(CLI_DIR, "src", "main.ts")} serve --port ${port}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  return { file, body, start: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "surface.service"]], logs: "journalctl --user -u surface -f" };
}

export async function setup(flags: Record<string, string | boolean>) {
  // keep what this computer already uses unless told otherwise (a signed-in computer stays on the cloud)
  const cloud = flags.local ? false : flags.cloud ? true : storeKind() === "cloud";
  const dir = path.resolve(String(flags.dir ?? path.join(os.homedir(), "Surface")).replace(/^~(?=\/|$)/, os.homedir()));
  const name = String(flags.name ?? "My workspace");
  const port = Number(flags.port ?? 4317);
  console.log(`Setting up Surface from ${ROOT}`);

  step("1. Node");
  if (!nodeOk()) throw new UserError(`Node ${process.versions.node} is too old: Surface needs 23.6 or newer (it runs TypeScript directly). Install a current Node (https://nodejs.org, or \`fnm install 24\`) and re-run.`);
  ok(`Node ${process.versions.node}`);

  step("2. Packages");
  sh("npm", ["install", "--no-fund", "--no-audit"], CLI_DIR);
  ok("CLI packages");
  if (flags["skip-app"]) warn("web UI skipped (--skip-app)");
  else {
    sh("npm", ["install", "--no-fund", "--no-audit"], APP_DIR);
    ok("web UI packages");
    const dist = path.join(APP_DIR, "dist", "index.html");
    if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < newest(path.join(APP_DIR, "src")) || flags.rebuild) {
      sh("npm", ["run", "build"], APP_DIR);
      ok("web UI built");
    } else ok("web UI already built");
  }

  step("3. The `surface` command");
  const link = linkBin();
  ok(`${link} → ${BIN}`);
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  if (!pathDirs.includes(path.dirname(link))) {
    const rc = process.env.SHELL?.endsWith("zsh") ? "~/.zshrc" : process.env.SHELL?.endsWith("fish") ? "~/.config/fish/config.fish" : "~/.bashrc";
    warn(`${path.dirname(link)} isn't on your PATH. Add it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}  (then open a new terminal)`);
  }

  step(`4. Where your data lives: ${cloud ? "your cloud (your Supabase project, signed in)" : "this computer (no account)"}`);
  setStoreKind(cloud ? "cloud" : "local");
  if (cloud) {
    const who = spawnSync(BIN, ["whoami"], { encoding: "utf8" });
    if (who.status === 0) ok(`signed in as ${who.stdout.trim()}`);
    else {
      const { cloudConfig } = await import("./config.ts");
      if (!cloudConfig()) throw new UserError("--cloud needs your own Supabase project. Connect it first: surface cloud connect <url> <publishable key>   (docs/CLOUD.md)");
      console.log(`  Sign in to your cloud (${cloudConfig()!.url}):`);
      const r = spawnSync(BIN, ["login"], { stdio: "inherit" });
      if (r.status !== 0) throw new UserError("Sign-in failed. Re-run `surface setup --cloud`, or `surface signup` first.");
    }
  } else {
    const { localInfo } = await import("./local.ts");
    const info = await localInfo();
    ok(`local database: ${info.dir}`);
    ok(`you are ${info.user.email} on this computer`);
    const { closeLocal } = await import("./local.ts");
    await closeLocal();
  }

  step("5. A workspace and its folder");
  if (fs.existsSync(path.join(dir, ".surface", "config.json"))) ok(`${dir} is already a checkout`);
  else {
    const list = spawnSync(BIN, ["workspace", "list"], { encoding: "utf8" });
    const rows = (list.stdout ?? "").trim().split("\n").slice(1).filter(Boolean);
    const args = rows.length && !flags.name ? ["init", dir, "--workspace", rows[0].split(/\s+/)[0]] : ["init", dir, "--create", name];
    const r = spawnSync(BIN, args, { encoding: "utf8" });
    if (r.status !== 0) throw new UserError((r.stderr || r.stdout).trim());
    ok(r.stdout.trim().split("\n").pop() ?? `checked out into ${dir}`);
  }

  step("6. Running the web UI");
  if (flags.service) {
    const s = serviceFiles(port, dir);
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, s.body);
    for (const c of s.start) spawnSync(c[0], c.slice(1), { stdio: "ignore" });
    ok(`starts at login: ${s.file}`);
    console.log(dim(`    logs: ${s.logs}`));
    if (process.platform === "linux") console.log(dim("    to keep it running after you log out (servers): loginctl enable-linger $USER"));
  } else console.log(`  Run it when you want it:  cd ${dir} && surface serve` + dim("   (or re-run setup with --service to start it at login)"));

  console.log(`\n${green("Surface is set up.")}`);
  console.log(`  Your folder:   ${dir}`);
  console.log(`  Web UI:        surface serve, then open the link it prints (http://127.0.0.1:${port}/?token=…)`);
  if (process.env.SSH_CONNECTION) console.log(`  From your own computer:  ssh -L ${port}:127.0.0.1:${port} ${os.userInfo().username}@${os.hostname()}   then open the same link locally`);
  console.log("  Agents:        point them at the folder; AGENTS.md tells them how to use `surface`.");
  console.log("  Check later:   surface doctor");
}

export async function doctor(port = 4317) {
  let problems = 0;
  const fail = (s: string) => (problems++, bad(s));
  console.log(`Surface at ${ROOT}`);
  nodeOk() ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node}: needs 23.6 or newer`);
  fs.existsSync(path.join(CLI_DIR, "node_modules", "@electric-sql", "pglite")) ? ok("CLI packages installed") : fail("CLI packages missing: run `surface setup`");
  const dist = path.join(APP_DIR, "dist", "index.html");
  if (!fs.existsSync(dist)) fail("web UI not built: run `surface setup`");
  else if (fs.statSync(dist).mtimeMs < newest(path.join(APP_DIR, "src"))) warn("web UI build is older than its source: run `surface setup --rebuild`");
  else ok("web UI built");
  const p = onPath();
  p ? ok(`surface on PATH: ${p}`) : fail("surface isn't on your PATH: run `surface setup`");
  const kind = storeKind();
  ok(`store: ${kind}${kind === "local" ? " (this computer, no account)" : " (hosted, signed in)"}`);
  if (kind === "local") {
    try {
      const { localInfo, closeLocal } = await import("./local.ts");
      const info = await localInfo();
      ok(`local database: ${info.dir} (${info.via}${info.migrations.length ? `, ${info.migrations.length} migrations` : ""})`);
      await closeLocal();
    } catch (e) {
      fail(`local database: ${(e as Error).message}`);
    }
  } else {
    const who = spawnSync(BIN, ["whoami"], { encoding: "utf8" });
    who.status === 0 ? ok(`signed in as ${who.stdout.trim()}`) : fail("not signed in: run `surface login`");
  }
  const known = path.join(CONFIG_DIR, "checkouts.json");
  if (fs.existsSync(known)) {
    const list = JSON.parse(fs.readFileSync(known, "utf8")) as { root: string; name?: string }[];
    for (const k of list) (fs.existsSync(path.join(k.root, ".surface")) ? ok : warn)(`checkout: ${k.root}${k.name ? ` (${k.name})` : ""}${fs.existsSync(k.root) ? "" : " — missing"}`);
  } else warn("no checkouts yet: `surface setup` or `surface init <folder>`");
  try {
    const r = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`], { encoding: "utf8", timeout: 2000 });
    r === "401" || r === "200" ? ok(`surface serve is running on port ${port}`) : console.log(dim(`  · surface serve isn't running on port ${port}`));
  } catch {
    console.log(dim(`  · surface serve isn't running on port ${port}`));
  }
  if (problems) {
    process.exitCode = 1;
    console.log(red(`\n${problems} problem(s).`));
  } else console.log(green("\nAll good."));
}
