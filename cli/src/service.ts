// Background service definitions shared by setup, update, and the service command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CONFIG_DIR, readJson } from "./config.ts";
import { UserError } from "./client.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const ACTIVE_LINK = path.join(CONFIG_DIR, "runtime", "current");
export function activeRoot() { return fs.existsSync(ACTIVE_LINK) ? fs.realpathSync(ACTIVE_LINK) : ROOT; }
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const unit = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
/** Persist operational settings only, never passwords, access tokens or hub tokens. */
export function serviceEnvironment(): Record<string,string> {
  const variables: Record<string,string> = { SURFACE_CONFIG_DIR: CONFIG_DIR, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? "") };
  for (const key of ["SURFACE_DATA_DIR", "SURFACE_STORE", "XDG_DATA_HOME", "XDG_STATE_HOME", "SURFACE_LOG", "SURFACE_LOG_FILE", "SURFACE_SYNC", "SURFACE_SYNC_MS", "SURFACE_SYNC_FULL_MS", "SURFACE_UPDATE_CHECK"])
    if (process.env[key]) variables[key] = process.env[key]!;
  return variables;
}
export function serviceDefinition(port = 4317, platform = process.platform, home = os.homedir()) {
  const log = path.join(CONFIG_DIR, "serve.log");
  const main = path.join(fs.existsSync(ACTIVE_LINK) ? ACTIVE_LINK : ROOT, "cli/src/main.ts");
  const args = [process.execPath, "--no-warnings", main, "serve", "--port", String(port)];
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
    const body = `[Unit]\nDescription=Surface (all workspaces)\n\n[Service]\nWorkingDirectory=${CONFIG_DIR.replace(/%/g, "%%")}\nExecStart=${args.map(unit).join(" ")}\n${Object.entries(variables).map(([k,v]) => `Environment=${unit(k + "=" + v)}`).join("\n")}\nRestart=on-failure\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
    return { file, body, commands: { install: [["systemctl","--user","daemon-reload"],["systemctl","--user","enable","--now","surface.service"]], start: [["systemctl","--user","start","surface.service"]], stop: [["systemctl","--user","stop","surface.service"]], restart: [["systemctl","--user","restart","surface.service"]], status: [["systemctl","--user","status","surface.service","--no-pager"]] } };
  }
  throw new UserError("Background services currently support macOS and Linux. On Windows, use Surface through WSL.");
}
export function runCommand(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean; allowFailure?: boolean; timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd,args,{ cwd: opts.cwd ?? ROOT, encoding:"utf8", timeout:opts.timeout, env: { ...process.env, ...opts.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? "") }, stdio: opts.quiet ? "pipe" : "inherit" });
  if ((r.error || r.status !== 0) && !opts.allowFailure) throw new UserError(`${cmd} ${args.join(" ")} failed: ${r.error?.message ?? r.stderr ?? `exit ${r.status}`}`);
  return r;
}
export function serviceInstalled() { return fs.existsSync(serviceDefinition().file); }
/** Read settings persisted by our service writer, including when its server is stopped. */
export function installedServiceEnvironment() {
  const body = fs.readFileSync(serviceDefinition().file,"utf8");
  const variables: Record<string,string> = {};
  if (process.platform === "darwin") {
    const dictionary = /<key>EnvironmentVariables<\/key><dict>([\s\S]*?)<\/dict>/.exec(body)?.[1] ?? "";
    const decode = (value:string) => value.replace(/&(amp|lt|gt|quot|apos);/g,(_match,key:string)=>({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}[key]!));
    for (const match of dictionary.matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)) variables[decode(match[1])] = decode(match[2]);
  } else {
    for (const match of body.matchAll(/^Environment="((?:\\.|[^"\\])*)"/gm)) {
      const entry = match[1].replace(/\\(["\\])/g,"$1").replace(/%%/g,"%");
      const split = entry.indexOf("=");
      if (split > 0) variables[entry.slice(0,split)] = entry.slice(split+1);
    }
  }
  return variables;
}
/** Change only the entry point; preserve the service's port, Node, environment and policy. */
export function writeServiceDefinition() {
  const d = serviceDefinition();
  const original = fs.readFileSync(d.file,"utf8");
  const main = path.join(ACTIVE_LINK,"cli/src/main.ts");
  const pattern = process.platform === "darwin"
    ? /(<string>--no-warnings<\/string>\s*)<string>[^<]*<\/string>/
    : /^(ExecStart=(?:"(?:\\.|[^"\\])*"|\S+)\s+(?:"--no-warnings"|--no-warnings)\s+)(?:"(?:\\.|[^"\\])*"|\S+)/m;
  if (!pattern.test(original)) throw new UserError("Unrecognized Surface service entry point; restore or reinstall its service definition before updating.");
  const body = original.replace(pattern,(_match,prefix:string)=>prefix + (process.platform === "darwin" ? `<string>${xml(main)}</string>` : unit(main)));
  fs.writeFileSync(d.file,body);
  if (process.platform === "linux") runCommand("systemctl",["--user","daemon-reload"],{quiet:true});
}
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
