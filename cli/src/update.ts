// Explicit updates, read-only checks, and opt-in scheduled checks or idle updates.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG_DIR, knownCheckouts, readJson, writeJson } from "./config.ts";
import { UserError } from "./client.ts";
import { ROOT, runCommand, serviceAction, serviceInstalled, serviceEnvironment } from "./service.ts";
import { running, startServer } from "./open.ts";

const MAIN = path.join(ROOT,"cli","src","main.ts");
const STATE = path.join(CONFIG_DIR,"update.json");
const git = (...args: string[]) => runCommand("git",args,{cwd:ROOT,quiet:true}).stdout!.trim();

export function updateSchedule(mode: "check" | "install" | "off", platform = process.platform, home = os.homedir()) {
  const args = [process.execPath,"--no-warnings",MAIN,"update",mode === "install" ? "--background" : "--check"];
  const quote = (v: string) => '"' + v.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/%/g,"%%") + '"';
  const variables = serviceEnvironment();
  if (platform === "linux") {
    const dir = path.join(home,".config","systemd","user");
    return { files: [
      { file: path.join(dir,"surface-update.service"), body: `[Unit]\nDescription=Surface ${mode === "install" ? "idle update" : "update check"}\n[Service]\nType=oneshot\nWorkingDirectory=${quote(ROOT)}\n${Object.entries(variables).map(([key,value])=>`Environment=${quote(key+"="+value)}`).join("\n")}\nExecStart=${args.map(quote).join(" ")}\n` },
      { file: path.join(dir,"surface-update.timer"), body: `[Unit]\nDescription=Check Surface updates daily\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n` }
    ], commands: mode === "off" ? [["systemctl","--user","disable","--now","surface-update.timer"]] : [["systemctl","--user","daemon-reload"],["systemctl","--user","enable","--now","surface-update.timer"]] };
  }
  if (platform === "darwin") {
    const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const file = path.join(home,"Library","LaunchAgents","dev.surface.update.plist");
    const domain = `gui/${process.getuid?.() ?? 0}`;
    const log = path.join(CONFIG_DIR,"update.log");
    return { files: [{file,body:`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.surface.update</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${esc(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${esc(ROOT)}</string><key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([key,value])=>`<key>${key}</key><string>${esc(value)}</string>`).join("")}</dict><key>StartInterval</key><integer>86400</integer><key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string></dict></plist>\n`}],commands: mode === "off" ? [["launchctl","bootout",`${domain}/dev.surface.update`]] : [["launchctl","bootstrap",domain,file]] };
  }
  throw new UserError("Scheduled updates support macOS and Linux. On Windows use WSL or run surface update manually.");
}

export function configureUpdates(mode: string) {
  if (!["check","install","off"].includes(mode)) throw new UserError("Usage: surface update auto check|install|off");
  const plan = updateSchedule(mode as "check"|"install"|"off");
  fs.mkdirSync(CONFIG_DIR,{recursive:true});
  if (process.platform === "darwin" && mode !== "off") runCommand("launchctl",["bootout",`gui/${process.getuid?.() ?? 0}/dev.surface.update`],{quiet:true,allowFailure:true});
  if (mode !== "off") for (const {file,body} of plan.files) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,body); }
  for (const [cmd,...args] of plan.commands) runCommand(cmd,args,{quiet:true,allowFailure:mode === "off"});
  if (mode === "off") for (const {file} of plan.files) fs.rmSync(file,{force:true});
  writeJson(STATE,{...readJson(STATE,{}),automatic:mode});
  console.log(mode === "off" ? "Scheduled updates disabled." : mode === "check" ? "Daily update checks enabled. Run surface update to install an available update." : "Daily automatic updates enabled. Installation waits until all app tabs are disconnected and all edits are synced.");
}

export async function update(opts: { check?: boolean; background?: boolean } = {}) {
  fs.mkdirSync(CONFIG_DIR,{recursive:true});
  const lock = path.join(CONFIG_DIR,"update.lock");
  try { fs.writeFileSync(lock,String(process.pid),{flag:"wx"}); }
  catch {
    const pid = Number(fs.readFileSync(lock,"utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new UserError("Invalid update.lock; inspect it before retrying.");
    let alive = true;
    try { process.kill(pid,0); } catch(e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) throw new UserError("Another update is running.");
    fs.rmSync(lock); fs.writeFileSync(lock,String(process.pid),{flag:"wx"});
  }
  let resume: { port: number; root: string } | null = null;
  let managed = false;
  try {
    const branch = git("symbolic-ref","--quiet","--short","HEAD");
    if (!branch) throw new UserError("Surface is on a detached commit. Check out the intended release branch first.");
    if (git("status","--porcelain")) throw new UserError("Surface has local code changes. Preserve or commit them before updating; nothing was changed.");
    const upstream = git("rev-parse","--abbrev-ref","@{upstream}");
    const remote = git("config",`branch.${branch}.remote`);
    git("fetch","--prune",remote);
    const from = git("rev-parse","HEAD");
    const to = git("rev-parse",upstream);
    const relation = runCommand("git",["merge-base","--is-ancestor",from,to],{quiet:true,allowFailure:true});
    if (relation.error || relation.status !== 0) throw new UserError("Local Surface commits have diverged from the update branch. No code was changed.");
    writeJson(STATE,{...readJson(STATE,{}),checkedAt:new Date().toISOString(),current:from,available:to,updateAvailable:from !== to});
    if (opts.check || from === to) { console.log(from === to ? `Surface is current (${from.slice(0,12)}).` : `Surface update available: ${from.slice(0,12)} → ${to.slice(0,12)}. Run surface update.`); return; }
    resume = await running();
    const co = resume?.root ?? knownCheckouts()[0]?.root;
    if (!co) throw new UserError("No existing workspace found. Run surface setup first.");
    if (opts.background && resume) {
      const token = fs.readFileSync(path.join(CONFIG_DIR,"serve-token"),"utf8").trim();
      const health = await fetch(`http://127.0.0.1:${resume.port}/api/_health`,{headers:{"x-surface-token":token},signal:AbortSignal.timeout(2000)}).then(async r=>r.ok ? r.json() : null) as {clients:number;pending:number} | null;
      if (!health || health.clients || health.pending) { console.log("Update postponed: Surface is in use or has pending edits."); resume = null; return; }
    }
    managed = serviceInstalled();
    if (resume) {
      if (managed) serviceAction("stop");
      else {
        const pid = readJson<{pid:number}>(path.join(CONFIG_DIR,"serve.json"),{pid:0}).pid;
        if (!Number.isInteger(pid) || pid <= 0) throw new UserError("Invalid server PID; update cancelled.");
        process.kill(pid,"SIGTERM");
      }
      const deadline = Date.now()+30000;
      while (await running()) {
        if (Date.now()>deadline) throw new UserError("Surface did not stop cleanly; update cancelled.");
        await new Promise(r=>setTimeout(r,200));
      }
    }
    // A stopped physical backup preserves pending edits and auth/config without touching checkouts.
    const backup = path.join(CONFIG_DIR,"update-backups",new Date().toISOString().replace(/[:.]/g,"-"));
    fs.mkdirSync(backup,{recursive:true,mode:0o700});
    for (const file of fs.readdirSync(CONFIG_DIR)) {
      if (file.endsWith(".json")) fs.copyFileSync(path.join(CONFIG_DIR,file),path.join(backup,file));
    }
    const data = process.env.SURFACE_DATA_DIR ?? (process.platform === "darwin" ? path.join(os.homedir(),"Library","Application Support","Surface") : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(),".local","share"),"surface"));
    const held = readJson<{pid?:number}>(path.join(data,"db.lock"),{});
    if (held.pid) {
      let busy = true;
      try { process.kill(held.pid,0); } catch(e) { busy = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (busy) throw new UserError("A Surface process still owns the database. Update cancelled before copying or changing it.");
    }
    if (fs.existsSync(path.join(data,"db"))) fs.cpSync(path.join(data,"db"),path.join(backup,"db"),{recursive:true});
    if (git("status","--porcelain")) throw new UserError("Code changed during the update check; update cancelled.");
    git("merge","--ff-only",to);
    for (const folder of ["cli","app"]) runCommand("npm",["ci","--no-fund","--no-audit"],{cwd:path.join(ROOT,folder)});
    runCommand("npm",["run","build"],{cwd:path.join(ROOT,"app")});
    runCommand(process.execPath,["--no-warnings",MAIN,"doctor"],{cwd:co});
    if (resume) {
      if (managed) serviceAction("start"); else await startServer({ root:co } as import("./config.ts").Checkout,resume.port);
      const deadline = Date.now()+15000;
      while (!(await running())) {
        if (Date.now()>deadline) throw new UserError("Updated, but Surface did not restart. Run surface serve and check its log.");
        await new Promise(r=>setTimeout(r,200));
      }
    }
    writeJson(STATE,{...readJson(STATE,{}),current:to,updateAvailable:false,updatedAt:new Date().toISOString(),backup});
    console.log(`Updated Surface to ${to.slice(0,12)}. Backup: ${backup}`);
    resume = null;
  } catch (e) {
    if (resume) console.error("Surface may be stopped. Your data is preserved; resolve the update error, then run surface serve (or surface service start).");
    throw e;
  } finally { fs.rmSync(lock,{force:true}); }
}
