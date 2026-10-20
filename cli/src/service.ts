// Background service definitions shared by setup, update, and the service command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR, readJson } from "./config.ts";
import { UserError } from "./client.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const MAIN = path.join(ROOT, "cli", "src", "main.ts");
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const unit = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
/** Persist operational settings only, never passwords, access tokens or hub tokens. */
export function serviceEnvironment(): Record<string,string> {
  const variables: Record<string,string> = { SURFACE_CONFIG_DIR: CONFIG_DIR, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? "") };
  for (const key of ["SURFACE_DATA_DIR", "SURFACE_STORE", "XDG_DATA_HOME", "XDG_STATE_HOME", "SURFACE_LOG", "SURFACE_LOG_FILE", "SURFACE_SYNC", "SURFACE_SYNC_MS", "SURFACE_SYNC_FULL_MS"])
    if (process.env[key]) variables[key] = process.env[key]!;
  return variables;
}
export function serviceDefinition(port = 4317, platform = process.platform, home = os.homedir()) {
  const log = path.join(CONFIG_DIR, "serve.log");
  const args = [process.execPath, "--no-warnings", MAIN, "serve", "--port", String(port)];
  const variables = serviceEnvironment();
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", "dev.surface.serve.plist");
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const body = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>dev.surface.serve</string><key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(CONFIG_DIR)}</string><key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
    return { file, body, commands: { install: [["launchctl","bootstrap",domain,file]], start: [["launchctl","bootstrap",domain,file]], stop: [["launchctl","bootout",`${domain}/dev.surface.serve`]], restart: [["launchctl","kickstart","-k",`${domain}/dev.surface.serve`]], status: [["launchctl","print",`${domain}/dev.surface.serve`]] } };
  }
  if (platform === "linux") {
    const file = path.join(home, ".config", "systemd", "user", "surface.service");
    const body = `[Unit]\nDescription=Surface (all workspaces)\n\n[Service]\nWorkingDirectory=${unit(CONFIG_DIR)}\nExecStart=${args.map(unit).join(" ")}\n${Object.entries(variables).map(([k,v]) => `Environment=${unit(k + "=" + v)}`).join("\n")}\nRestart=on-failure\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
    return { file, body, commands: { install: [["systemctl","--user","daemon-reload"],["systemctl","--user","enable","--now","surface.service"]], start: [["systemctl","--user","start","surface.service"]], stop: [["systemctl","--user","stop","surface.service"]], restart: [["systemctl","--user","restart","surface.service"]], status: [["systemctl","--user","status","surface.service","--no-pager"]] } };
  }
  throw new UserError("Background services currently support macOS and Linux. On Windows, use Surface through WSL.");
}
export function runCommand(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean; allowFailure?: boolean } = {}) {
  const r = spawnSync(cmd,args,{ cwd: opts.cwd ?? ROOT, encoding:"utf8", env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? "") }, stdio: opts.quiet ? "pipe" : "inherit" });
  if ((r.error || r.status !== 0) && !opts.allowFailure) throw new UserError(`${cmd} ${args.join(" ")} failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`);
  return r;
}
export function serviceInstalled() { return fs.existsSync(serviceDefinition().file); }
export function serviceAction(action: "install" | "start" | "stop" | "restart" | "status", port?: number) {
  const saved = readJson<{ port?: number }>(path.join(CONFIG_DIR,"serve.json"),{});
  const d = serviceDefinition(port ?? saved.port ?? 4317);
  fs.mkdirSync(CONFIG_DIR,{recursive:true});
  if (action === "install") {
    fs.mkdirSync(path.dirname(d.file),{recursive:true});
    if (fs.existsSync(d.file)) fs.copyFileSync(d.file,d.file + ".previous");
    if (process.platform === "darwin") for (const [cmd,...args] of d.commands.stop) runCommand(cmd,args,{quiet:true,allowFailure:true});
    fs.writeFileSync(d.file,d.body);
  }
  for (const [cmd,...args] of d.commands[action]) runCommand(cmd,args);
  return d.file;
}
