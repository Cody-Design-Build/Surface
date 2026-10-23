// Real local Git releases, real npm installs/builds, real CLI and HTTP server.
// Run explicitly: npm run test:updates. npm packages may be downloaded; Git never leaves this fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { once } from "node:events";
const source = path.resolve(import.meta.dirname,"../..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"surface-releases-")));
const home = path.join(tmp,"home"), config = path.join(home,".config/surface-cli"), data = path.join(tmp,"data");
const publisher = path.join(tmp,"publisher"), installed = path.join(tmp,"installed"), workspace = path.join(tmp,"workspace");
const env = {...process.env,HOME:home,SURFACE_CONFIG_DIR:config,SURFACE_DATA_DIR:data,SURFACE_STORE:"local",SURFACE_UPDATE_CHECK:"0",
  XDG_RUNTIME_DIR:path.join(tmp,"runtime"),DBUS_SESSION_BUS_ADDRESS:`unix:path=${tmp}/no-session-bus`,XDG_STATE_HOME:path.join(tmp,"state"),XDG_CONFIG_HOME:path.join(home,".config"),
  SURFACE_LOG_FILE:path.join(tmp,"surface.log"),npm_config_cache:path.join(tmp,"npm-cache"),GIT_CONFIG_GLOBAL:path.join(tmp,"gitconfig"),GIT_CONFIG_NOSYSTEM:"1"};
fs.mkdirSync(home,{recursive:true}); fs.mkdirSync(publisher,{recursive:true});
const git = (cwd:string,...args:string[]) => execFileSync("git",args,{cwd,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const execute = promisify(execFile);
async function cli(args:string[], success=true) {
  try {
    const result = await execute(path.join(home,".local/bin/surface"),args,{cwd:workspace,env,timeout:240000,maxBuffer:16*1024*1024});
    if (!success) assert.fail(`Expected failure: surface ${args.join(" ")}`);
    return result.stdout + result.stderr;
  } catch (error) {
    if (success || error instanceof assert.AssertionError) throw error;
    const failure = error as {stdout?:string;stderr?:string};
    return (failure.stdout ?? "") + (failure.stderr ?? "");
  }
}
const active = () => fs.realpathSync(path.join(config,"runtime/current"));
const state = () => JSON.parse(fs.readFileSync(path.join(config,"update.json"),"utf8"));
const serverFile = path.join(config,"serve.json");
const server = () => JSON.parse(fs.readFileSync(serverFile,"utf8")) as {pid:number;port:number};
async function health() {
  const token = fs.readFileSync(path.join(config,"serve-token"),"utf8").trim();
  const response = await fetch(`http://127.0.0.1:${server().port}/api/_health`,{headers:{"x-surface-token":token},signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  return await response.json() as {commit:string};
}
async function waitForServer(commit:string) {
  const deadline = Date.now()+30000;
  while (Date.now()<deadline) {
    try { if ((await health()).commit === commit) return; } catch {}
    await delay(200);
  }
  assert.fail(`Server did not start at ${commit}; see ${tmp}`);
}
function publish(version:string, edit?:()=>void) {
  fs.writeFileSync(path.join(publisher,"release-marker"),version);
  edit?.();
  git(publisher,"add","."); git(publisher,"commit","-m",`Release ${version}`);
  git(publisher,"tag","-a",`v${version}`,"-m",`Surface ${version}`);
  return git(publisher,"rev-parse","HEAD");
}
let count = 0;
const ok = (message:string) => console.log(`ok ${++count} ${message}`);
try {
  // Start with the published client/schema, not two copies of today's code.
  const baseline = execFileSync("git",["archive","v0.1.1","cli","app","supabase","surfaces.mts",".gitignore"],{cwd:source,maxBuffer:32*1024*1024});
  execFileSync("tar",["-xf","-"],{cwd:publisher,input:baseline});
  fs.appendFileSync(path.join(publisher,".gitignore"),"\nnode_modules/\ndist/\n");
  git(publisher,"init","-b","main"); git(publisher,"config","user.email","release-test@example.invalid"); git(publisher,"config","user.name","Release test");
  const initial = publish("0.1.0");
  git(tmp,"clone",publisher,installed);
  await execute("npm",["ci","--no-fund","--no-audit"],{cwd:path.join(installed,"cli"),env,timeout:180000,maxBuffer:8*1024*1024});
  await execute(process.execPath,["--no-warnings",path.join(installed,"cli/src/main.ts"),"setup","--dir",workspace],{cwd:installed,env,timeout:240000,maxBuffer:8*1024*1024});
  await cli(["type","add","contact"]);
  await cli(["field","add","contact","phone","--kind","phone"]);
  await cli(["new","contact","Upgrade phone","phone=415.555.0123"]);
  assert.equal(JSON.parse(await cli(["query","contact","--json"]))[0].fields.phone,"415.555.0123");
  for (const name of ["cli","app","supabase","surfaces.mts"]) fs.cpSync(path.join(source,name),path.join(publisher,name),{recursive:true,
    filter: file => !["node_modules","dist",".git"].includes(path.basename(file))});
  const release = publish("0.2.0");
  publish("99.0.0-rc.1");
  fs.writeFileSync(path.join(publisher,"development-only"),"must not be installed\n");
  git(publisher,"add","."); git(publisher,"commit","-m","Unreleased development");
  fs.appendFileSync(path.join(installed,"release-marker"),"\nlocal work\n");
  const legacySchedule = process.platform === "darwin" ? path.join(home,"Library/LaunchAgents/dev.surface.update.plist") : path.join(home,".config/systemd/user/surface-update.timer");
  fs.mkdirSync(path.dirname(legacySchedule),{recursive:true});
  fs.writeFileSync(legacySchedule,"legacy schedule must remain unchanged during --check");
  await cli(["update","--check"]);
  assert.equal(state().available,release); assert.equal(state().availableVersion,"0.2.0");
  assert.equal(fs.readFileSync(legacySchedule,"utf8"),"legacy schedule must remain unchanged during --check");
  fs.rmSync(legacySchedule); // Never connect this fixture to a real service manager.
  assert.match(await cli(["update"],false),/local code changes/);
  assert.equal(active(),installed); assert.match(fs.readFileSync(path.join(installed,"release-marker"),"utf8"),/local work/);
  fs.writeFileSync(path.join(installed,"release-marker"),"0.1.0");
  ok("checks tolerate dirty code and choose annotated stable tags, never prerelease or branch tips");
  git(installed,"config","user.email","developer@example.invalid"); git(installed,"config","user.name","Developer");
  git(installed,"checkout","-b","local-work");
  fs.writeFileSync(path.join(installed,"developer-work"),"preserved");git(installed,"add",".");git(installed,"commit","-m","Local development");
  const developer = git(installed,"rev-parse","HEAD");
  assert.match(await cli(["update"],false),/diverge/);
  assert.equal(git(installed,"rev-parse","HEAD"),developer);assert.equal(active(),installed);
  git(installed,"checkout","--detach",initial);
  ok("divergent local commits are preserved on their named branch");
  const listener = net.createServer(); listener.listen(0,"127.0.0.1");
  await once(listener,"listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const closed = Promise.withResolvers<void>();
  listener.close(error=>error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  const log = fs.openSync(path.join(tmp,"initial-server.log"),"a");
  const child = spawn(path.join(home,".local/bin/surface"),["serve","--port",String(port)],{cwd:workspace,env,stdio:["ignore",log,log]});
  child.on("error",error=>console.error(error));fs.closeSync(log);
  await waitForServer(initial);
  fs.writeFileSync(path.join(data,"db","release-test-marker"),"pending local data");
  const originalPid = server().pid;
  // A genuine failing build must not stop the live server or switch the active release.
  const appFile = path.join(publisher,"app/package.json"), appPackage = fs.readFileSync(appFile,"utf8");
  publish("0.3.0",()=>{
    const pkg = JSON.parse(appPackage);pkg.scripts.build = 'node -e "process.exit(42)"';fs.writeFileSync(appFile,JSON.stringify(pkg,null,2)+"\n");
  });
  assert.match(await cli(["update"],false),/failed/);
  assert.equal(server().pid,originalPid);assert.equal((await health()).commit,initial);assert.equal(active(),installed);
  ok("real build failure leaves the active installation and running process unchanged");
  const next = publish("0.4.0",()=>fs.writeFileSync(appFile,appPackage));
  await cli(["update"]);
  assert.equal((await health()).commit,next);assert.notEqual(server().pid,originalPid);
  assert.equal(git(active(),"rev-parse","HEAD"),next);assert.equal(git(installed,"rev-parse","HEAD"),initial);
  assert.equal(fs.existsSync(path.join(active(),"development-only")),true,"stable release includes its intentional history");
  assert.equal(fs.readFileSync(path.join(state().backup,"db/release-test-marker"),"utf8"),"pending local data");
  assert.equal(JSON.parse(await cli(["query","contact","--json"]))[0].fields.phone,"415.555.0123","upgrade preserves existing phone values");
  await cli(["set","Upgrade phone","phone=(415) 555-0123 ext. 004"]);
  assert.deepEqual(JSON.parse(await cli(["query","contact","--json"]))[0].fields.phone,[{number:"+14155550123",extension:"004"}]);
  ok("published 0.1.1 database upgrades to phone schema before new writes; existing values survive");
  const previous = active();
  ok("prepared release activates atomically, restarts the prior server and verifies its actual commit; stopped data is backed up");
  // A real failed release opens/migrates the actual PGlite database before startup fails.
  const mainFile = path.join(publisher,"cli/src/main.ts"), main = fs.readFileSync(mainFile,"utf8");
  const failed = publish("0.5.0",()=>fs.writeFileSync(mainFile,`
import {localAdmin,closeLocal} from "./local.ts";
await localAdmin(async tx => {
  await tx.query("create table public.release_failure_probe (value text)");
  await tx.query("insert into public.release_failure_probe values ('attempted migration')");
});
await closeLocal();
throw new Error("intentional release startup failure");
`));
  assert.match(await cli(["update"],false),/previous installation recovered/);
  assert.equal(active(),previous);assert.equal((await health()).commit,next);
  assert.equal(fs.readFileSync(path.join(data,"db/release-test-marker"),"utf8"),"pending local data");
  const backupRoot = path.join(config,"update-backups");
  const failedBackup = fs.readdirSync(backupRoot).map(name=>path.join(backupRoot,name)).find(dir=>{
    return JSON.parse(fs.readFileSync(path.join(dir,"release.json"),"utf8")).commit === failed;
  });
  assert.ok(failedBackup,"failed activation retains its recovery metadata");
  const inspected = await execute(process.execPath,["--input-type=module","-e",`
import {createRequire} from "node:module";
const require = createRequire(process.argv[1] + "/cli/package.json");
const {PGlite} = require("@electric-sql/pglite");
const db = new PGlite(process.argv[2]);
console.log(JSON.stringify((await db.query("select value from public.release_failure_probe")).rows));
await db.close();
`,active(),path.join(failedBackup,"failed-db")],{env,timeout:30000,maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(inspected.stdout),[{value:"attempted migration"}]);
  const token = fs.readFileSync(path.join(config,"serve-token"),"utf8").trim();
  const restored = await fetch(`http://127.0.0.1:${server().port}/api/_db`,{method:"POST",headers:{"x-surface-token":token,"content-type":"application/json"},
    body:JSON.stringify({kind:"select",table:"release_failure_probe",filters:[],order:[],returning:false}),signal:AbortSignal.timeout(3000)});
  const restoredQuery = await restored.json() as {error?:{message?:string}};
  assert.match(restoredQuery.error?.message ?? "",/does not exist/,"restored live database must not retain the failed release's migration");
  ok("activation/startup failure restores previous code and the stopped local database snapshot");
  const final = publish("0.6.0",()=>fs.writeFileSync(mainFile,main));
  await cli(["update"]);assert.equal((await health()).commit,final);
  assert.equal(git(active(),"rev-parse","HEAD"),final);
  await cli(["update","--check"]);assert.equal(state().updateAvailable,false);
  assert.match(await cli(["update","auto","install"],false),/Usage: surface update/);
  assert.match(await cli(["update","--background"],false),/Usage: surface update|--background needs a value/);
  ok("the stable linked CLI performs repeat updates from an activated release; legacy automatic flags are rejected");
  process.kill(server().pid,"SIGTERM");
  for (let i=0;i<150 && fs.existsSync(serverFile);i++) await delay(200);
  assert.equal(fs.existsSync(serverFile),false);
  const stopped = publish("0.7.0");
  await cli(["update"]);assert.equal(git(active(),"rev-parse","HEAD"),stopped);
  assert.equal(fs.existsSync(serverFile),false,"a stopped server must stay stopped");
  ok("updating a stopped installation does not start a server");
  console.log(`all ${count} release integration checks passed`);
} finally {
  try { process.kill(server().pid,"SIGTERM"); await delay(1000); } catch {}
  if (process.env.SURFACE_KEEP_UPDATE_FIXTURE === "1") console.log(`Kept release fixture: ${tmp}`);
  else fs.rmSync(tmp,{recursive:true,force:true});
}
