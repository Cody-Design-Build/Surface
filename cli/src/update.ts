// Stable Git release discovery and explicit, staged CLI installation. Never installs in a server.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_DIR, readJson, writeJson } from "./config.ts";
import { UserError } from "./client.ts";
import { activeRoot, ACTIVE_LINK, runCommand, serviceAction, serviceInstalled, serviceDefinition, writeServiceDefinition, installedServiceEnvironment } from "./service.ts";
import { running } from "./open.ts";

const STATE = path.join(CONFIG_DIR,"update.json");
const LOCK = path.join(CONFIG_DIR,"update.lock");
const NETWORK_ENV = { ...process.env, GIT_TERMINAL_PROMPT:"0", GCM_INTERACTIVE:"never", GIT_SSH_COMMAND:`${process.env.GIT_SSH_COMMAND ?? "ssh"} -oBatchMode=yes -oConnectTimeout=15` };
const git = (root: string, ...args: string[]) => runCommand("git",args,{cwd:root,quiet:true,env:NETWORK_ENV,timeout:60000}).stdout!.trim();
interface UpdateState { current?: string; available?: string; availableVersion?: string; updateAvailable?: boolean; checkedAt?: string; attemptedAt?: string }
export interface Release {tag: string; version: string; commit: string}
export const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;
export function cachedUpdate(current: string | null) {
  const state = readJson<UpdateState>(STATE,{});
  const matches = !!current && state.current === current;
  return { available: matches && !!state.updateAvailable, availableCommit: matches ? state.available ?? null : null,
    availableVersion: matches ? state.availableVersion ?? null : null, checkedAt: matches ? state.checkedAt ?? null : null };
}
export function updateNotification(current: string | null) {
  const status = cachedUpdate(current);
  return status.available ? `Surface ${status.availableVersion} available — installed: ${current?.slice(0,7)}, available: ${status.availableCommit?.slice(0,7)}. Run surface update to install.` : null;
}

/** Accept only plain stable SemVer tags; branches, prereleases and build aliases are not releases. */
export function latestRelease(refs: string): Release {
  const tags = new Map<string,{commit:string; peeled?:string}>();
  for (const line of refs.trim().split("\n")) {
    const match = /^([a-f0-9]{40,64})\s+refs\/tags\/(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(line);
    if (!match) continue;
    const entry = tags.get(match[2]) ?? {commit:match[1]};
    if (match[3]) entry.peeled = match[1]; else entry.commit = match[1];
    tags.set(match[2],entry);
  }
  const ordered = [...tags].map(([tag,ref])=>({tag,version:tag.replace(/^v/,""),commit:ref.peeled ?? ref.commit}));
  const compare = (a: typeof ordered[number], b: typeof ordered[number]) => {
    const aa = a.version.split(".").map(BigInt), bb = b.version.split(".").map(BigInt);
    for (let i=0;i<3;i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? -1 : 1;
    return 0;
  };
  ordered.sort(compare);
  if (!ordered.length) throw new UserError("origin has no stable release tags (vMAJOR.MINOR.PATCH). No installation was changed.");
  if (ordered[1] && compare(ordered[0],ordered[1]) === 0 && ordered[0].commit !== ordered[1].commit)
    throw new UserError("origin has conflicting stable release tags for the same version.");
  return ordered[0];
}
function saveDiscovery(current: string, release: Release) {
  writeJson(STATE,{...readJson(STATE,{}),current,available:release.commit,availableVersion:release.version,
    updateAvailable:current !== release.commit,checkedAt:new Date().toISOString()});
}
let checking: Promise<void> | null = null;
/** Bounded, in-process read-only discovery: no worker, scheduler, installation or restart. */
export async function maybeCheckForUpdates() {
  if (checking) return checking;
  const state = readJson<UpdateState>(STATE,{}), now = Date.now();
  if (process.env.SURFACE_UPDATE_CHECK === "0" || fs.existsSync(LOCK) ||
      now-Date.parse(state.checkedAt ?? "") < UPDATE_CHECK_INTERVAL || now-Date.parse(state.attemptedAt ?? "") < 15*60*1000) return;
  checking = (async()=>{
    writeJson(STATE,{...state,attemptedAt:new Date().toISOString()});
    try {
      const root = activeRoot();
      const current = git(root,"rev-parse","HEAD");
      const result = await promisify(execFile)("git",["ls-remote","--tags","origin"],{cwd:root,env:NETWORK_ENV,timeout:60000,maxBuffer:8*1024*1024});
      if (!fs.existsSync(LOCK) && activeRoot() === root) saveDiscovery(current,latestRelease(result.stdout));
    } catch { /* A failed currency check is not evidence that the computer is offline. */ }
  })().finally(()=>{ checking = null; });
  return checking;
}

/** Remove only legacy Surface update schedules, never create an automatic installer. */
export function removeLegacyUpdateSchedules() {
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(),".config/systemd/user");
    const files = ["surface-update.timer","surface-update.service"].map(file=>path.join(dir,file));
    if (files.some(file=>fs.existsSync(file))) {
      for (const unit of ["surface-update.timer","surface-update.service"]) {
        runCommand("systemctl",["--user","disable","--now",unit],{quiet:true,allowFailure:true});
        const active = runCommand("systemctl",["--user","is-active",unit],{quiet:true,allowFailure:true});
        if (active.error || !["inactive","failed","unknown"].includes(active.stdout?.trim() ?? "")) throw new UserError(`Cannot disable or inspect legacy ${unit}; stop it before updating.`);
      }
      for (const file of files) fs.rmSync(file,{force:true});
      runCommand("systemctl",["--user","daemon-reload"],{quiet:true});
    }
  } else if (process.platform === "darwin") {
    const file = path.join(os.homedir(),"Library/LaunchAgents/dev.surface.update.plist");
    if (fs.existsSync(file)) {
      const label = `gui/${process.getuid?.() ?? 0}/dev.surface.update`;
      runCommand("launchctl",["bootout",label],{quiet:true,allowFailure:true});
      const loaded = runCommand("launchctl",["print",label],{quiet:true,allowFailure:true});
      if (loaded.status === 0 || loaded.error) throw new UserError("Cannot unload the legacy Surface update agent; stop it before updating.");
      fs.rmSync(file);
    }
  }
}
function alive(pid?: number) {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid,0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function activate(root: string) {
  fs.mkdirSync(path.dirname(ACTIVE_LINK),{recursive:true});
  const temporary = `${ACTIVE_LINK}.${process.pid}`;
  fs.symlinkSync(root,temporary,"dir");
  try { fs.renameSync(temporary,ACTIVE_LINK); } finally { fs.rmSync(temporary,{force:true}); }
}
async function waitStopped() {
  const deadline = Date.now()+30000;
  while (alive(readJson<{pid?:number}>(path.join(CONFIG_DIR,"serve.json"),{}).pid) || alive(startedPid)) {
    if (Date.now() > deadline) throw new UserError("Surface did not stop cleanly; activation/recovery cancelled.");
    await delay(200);
  }
}
async function stop(managed: boolean) {
  if (managed) serviceAction("stop");
  else {
    const pid = readJson<{pid?:number}>(path.join(CONFIG_DIR,"serve.json"),{}).pid;
    if (alive(pid)) process.kill(pid!,"SIGTERM");
    if (startedPid !== pid && alive(startedPid)) process.kill(startedPid!,"SIGTERM");
  }
  await waitStopped();
}
let startedPid: number | undefined;
async function start(managed: boolean, resume: {port:number;root:string}, commit: string, data: string, store?: "local" | "cloud") {
  if (managed) serviceAction("start");
  else {
    const out = fs.openSync(path.join(CONFIG_DIR,"serve.log"),"a");
    try {
      const child = spawn(process.execPath,["--no-warnings",path.join(activeRoot(),"cli/src/main.ts"),"serve","--port",String(resume.port)],
        {cwd:resume.root,detached:true,stdio:["ignore",out,out],env:{...process.env,SURFACE_DATA_DIR:data,...(store ? {SURFACE_STORE:store} : {})}});
      const {promise,resolve,reject} = Promise.withResolvers<void>();
      child.once("spawn",resolve); child.once("error",reject);
      await promise;
      startedPid = child.pid;
      child.once("exit",()=>{ if (startedPid === child.pid) startedPid = undefined; });
      child.unref();
    } finally { fs.closeSync(out); }
  }
  const deadline = Date.now()+20000;
  while (Date.now() < deadline) {
    try {
      const token = fs.readFileSync(path.join(CONFIG_DIR,"serve-token"),"utf8").trim();
      const response = await fetch(`http://127.0.0.1:${resume.port}/api/_health`,{headers:{"x-surface-token":token},signal:AbortSignal.timeout(2000)});
      const health = await response.json() as {commit?:string};
      if (response.ok && health.commit === commit) return;
      // Pre-cutover servers exposed the captured revision through /api/system.
      if (response.ok && !health.commit) {
        const old = await fetch(`http://127.0.0.1:${resume.port}/api/system`,{headers:{cookie:`surface_token=${token}`},signal:AbortSignal.timeout(2000)});
        const info: unknown = await old.json();
        if (old.ok && info && typeof info === "object" && "runningVersion" in info) {
          const revision = info.runningVersion;
          if (revision && typeof revision === "object" && "commit" in revision && revision.commit === commit) return;
        }
      }
    } catch { /* Startup is not ready yet. */ }
    await delay(200);
  }
  throw new UserError(`Surface failed its running-revision health check (${commit.slice(0,12)}). See ${path.join(CONFIG_DIR,"serve.log")}.`);
}
function assertDatabaseStopped(data: string) {
  if (alive(readJson<{pid?:number}>(path.join(data,"db.lock"),{}).pid)) throw new UserError("A Surface process still owns the database; no code or data was changed.");
}

export async function update(opts: {check?:boolean} = {}) {
  fs.mkdirSync(CONFIG_DIR,{recursive:true});
  try { fs.writeFileSync(LOCK,String(process.pid),{flag:"wx"}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(fs.readFileSync(LOCK,"utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new UserError("Invalid update.lock; inspect it before retrying.");
    if (alive(pid)) throw new UserError("Another update is running.");
    fs.rmSync(LOCK); fs.writeFileSync(LOCK,String(process.pid),{flag:"wx"});
  }
  let prepared: string | null = null;
  try {
    const previous = activeRoot(), from = git(previous,"rev-parse","HEAD");
    const release = latestRelease(git(previous,"ls-remote","--tags","origin"));
    saveDiscovery(from,release);
    if (opts.check) {
      console.log(from === release.commit ? `Surface is current (${release.version}, ${from.slice(0,12)}).` : `Surface ${release.version} available (${release.commit.slice(0,12)}). Run surface update.`);
      return;
    }
    if (git(previous,"status","--porcelain")) throw new UserError("Surface has local code changes. Preserve or commit them before updating; nothing was changed.");
    if (from === release.commit) { removeLegacyUpdateSchedules(); console.log(`Surface is current (${release.version}).`); return; }
    const origin = git(previous,"remote","get-url","origin");
    // Relative local origins are relative to the installed repository, not the release directory.
    const source = /^[a-z][a-z0-9+.-]*:|^[^/]+@[^:]+:/i.test(origin) ? origin : path.resolve(previous,origin);
    const releases = path.join(CONFIG_DIR,"runtime/releases");
    fs.mkdirSync(releases,{recursive:true});
    prepared = fs.mkdtempSync(path.join(releases,`${release.version}-${release.commit.slice(0,12)}-`));
    console.log(`Preparing Surface ${release.version}; the existing server stays running…`);
    runCommand("git",["clone","--no-checkout","--no-hardlinks","--no-tags","--",source,prepared],{env:NETWORK_ENV,timeout:120000});
    git(prepared,"fetch","--no-tags","origin",`refs/tags/${release.tag}`);
    git(prepared,"checkout","--detach","FETCH_HEAD");
    if (git(prepared,"rev-parse","HEAD") !== release.commit) throw new UserError("The release tag moved during preparation. No installation was changed.");
    const relation = runCommand("git",["merge-base","--is-ancestor",from,release.commit],{cwd:prepared,quiet:true,allowFailure:true});
    if (relation.error || relation.status !== 0) throw new UserError("Installed Surface commits diverge from the release. Your developer checkout was preserved; no installation was changed.");
    for (const folder of ["cli","app"]) runCommand("npm",["ci","--no-fund","--no-audit"],{cwd:path.join(prepared,folder)});
    runCommand("npm",["run","build"],{cwd:path.join(prepared,"app")});
    if (!fs.existsSync(path.join(prepared,"app/dist/index.html"))) throw new UserError("Release build did not produce app/dist/index.html.");
    if (git(previous,"rev-parse","HEAD") !== from || git(previous,"status","--porcelain")) throw new UserError("Installed code changed during preparation; activation cancelled.");
    const resume = await running();
    if (!resume && alive(readJson<{pid?:number}>(path.join(CONFIG_DIR,"serve.json"),{}).pid)) throw new UserError("A Surface server is running but unreachable; stop it explicitly before updating.");
    const managed = serviceInstalled();
    const definition = managed ? serviceDefinition(resume?.port) : null;
    const oldService = definition ? fs.readFileSync(definition.file) : null;
    const hadActive = fs.existsSync(ACTIVE_LINK);
    const savedEnvironment: Record<string,string> = managed ? installedServiceEnvironment() : {};
    let data = savedEnvironment.SURFACE_DATA_DIR ?? process.env.SURFACE_DATA_DIR ?? (process.platform === "darwin" ? path.join(os.homedir(),"Library/Application Support/Surface") : path.join(savedEnvironment.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(),".local/share"),"surface"));
    let resumeStore: "local" | "cloud" | undefined;
    if (resume) {
      const token = fs.readFileSync(path.join(CONFIG_DIR,"serve-token"),"utf8").trim();
      const response = await fetch(`http://127.0.0.1:${resume.port}/api/_health`,{headers:{"x-surface-token":token},signal:AbortSignal.timeout(3000)});
      if (!response.ok) throw new UserError("Cannot inspect the running server before backup; no installation was changed.");
      const health = await response.json() as {dataDir?:unknown};
      if (typeof health.dataDir === "string") { data = health.dataDir; resumeStore = "local"; }
      else if (health.dataDir === null) resumeStore = "cloud";
    }
    let stopped = false, activated = false, backup: string | null = null;
    try {
      removeLegacyUpdateSchedules();
      if (resume) { stopped = true; await stop(managed); }
      assertDatabaseStopped(data);
      backup = path.join(CONFIG_DIR,"update-backups",`${new Date().toISOString().replace(/[:.]/g,"-")}-${process.pid}`);
      fs.mkdirSync(backup,{recursive:true,mode:0o700});
      for (const file of fs.readdirSync(CONFIG_DIR)) if (file.endsWith(".json")) fs.copyFileSync(path.join(CONFIG_DIR,file),path.join(backup,file));
      if (fs.existsSync(path.join(data,"db"))) fs.cpSync(path.join(data,"db"),path.join(backup,"db"),{recursive:true});
      writeJson(path.join(backup,"release.json"),{previous,from,target:prepared,commit:release.commit,data,serviceFile:definition?.file,hadDatabase:fs.existsSync(path.join(data,"db")),resume});
      if (oldService) fs.writeFileSync(path.join(backup,"service-definition"),oldService);
      activate(prepared); activated = true;
      if (managed) writeServiceDefinition();
      if (resume) await start(managed,resume,release.commit,data,resumeStore);
      writeJson(STATE,{...readJson(STATE,{}),current:release.commit,updateAvailable:false,updatedAt:new Date().toISOString(),backup});
      console.log(`Updated Surface to ${release.version} (${release.commit.slice(0,12)}). Backup: ${backup}`);
      prepared = null; // Keep activated releases, including the previous release, for recovery.
    } catch (error) {
      try {
        if (activated) {
          // A failed new process may have migrated local data. Stop it before restoring the stopped snapshot.
          if (resume) await stop(managed);
          assertDatabaseStopped(data);
          activate(previous);
          if (!hadActive) fs.rmSync(ACTIVE_LINK);
          activated = false;
          if (definition && oldService) {
            fs.writeFileSync(definition.file,oldService);
            if (process.platform === "linux") runCommand("systemctl",["--user","daemon-reload"],{quiet:true});
          }
          if (backup) {
            if (fs.existsSync(path.join(data,"db"))) fs.renameSync(path.join(data,"db"),path.join(backup,"failed-db"));
            if (fs.existsSync(path.join(backup,"db"))) fs.cpSync(path.join(backup,"db"),path.join(data,"db"),{recursive:true});
          }
        }
        if (stopped && resume && !(await running())) await start(managed,resume,from,data,resumeStore);
      } catch (recovery) {
        // Do not remove a release that may still be active after an interrupted recovery.
        prepared = null;
        throw new UserError(`Update failed: ${(error as Error).message}\nRecovery also failed: ${(recovery as Error).message}\nPrevious code: ${previous}\nBackup: ${backup ?? "not yet created"}. Keep the server stopped until local data compatibility is resolved. Cloud migrations are never rolled back.`);
      }
      throw new UserError(`Update failed; previous installation recovered: ${(error as Error).message}\nBackup: ${backup ?? "not needed"}. Local database snapshot restored if activation occurred; cloud migrations are never applied or rolled back.`);
    }
  } finally {
    if (prepared) fs.rmSync(prepared,{recursive:true,force:true});
    fs.rmSync(LOCK,{force:true});
  }
}
