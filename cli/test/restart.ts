// Exercise the legacy-server handoff without starting or killing a real process.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { apps } from "../../surfaces.mts";
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"surface-restart-test-"));
process.env.SURFACE_CONFIG_DIR=path.join(tmp,"config");process.env.SURFACE_STORE="local";
fs.mkdirSync(process.env.SURFACE_CONFIG_DIR,{recursive:true});
const workspace=path.join(tmp,"workspace");fs.mkdirSync(path.join(workspace,".surface"),{recursive:true});
fs.writeFileSync(path.join(workspace,".surface/config.json"),JSON.stringify({workspace:"abc123",layout:"type"}));
const discovery=path.join(process.env.SURFACE_CONFIG_DIR,"serve.json");
const oldPid=34567,newPid=34568;
const oldRecord=()=>fs.writeFileSync(discovery,JSON.stringify({pid:oldPid,port:4317,root:workspace}));oldRecord();
fs.writeFileSync(path.join(process.env.SURFACE_CONFIG_DIR,"serve-token"),"test-token");
// These modules capture CONFIG_DIR at import time; load only after fixture setup.
const {ROOT,serviceDefinition}=await import("../src/service.ts");
const {installedVersion}=await import("../src/system.ts");
const version=installedVersion();
const fixtureHtml=path.join(tmp,"current.html");fs.writeFileSync(fixtureHtml,"<!doctype html><h1>Current fixture UI</h1>");
const buildStamp=path.join(ROOT,"app/dist/surface-build.json");
const appEntries=new Set(apps.map(app=>path.join(ROOT,"app/dist",app.entry)));
const original={spawn:childProcess.spawn,spawnSync:childProcess.spawnSync,kill:process.kill,fetch:globalThis.fetch,exists:fs.existsSync,read:fs.readFileSync,stat:fs.statSync,mkdtemp:fs.mkdtempSync,cwd:process.cwd()};
let alive=true,valid=true,systemChecks=0,failBuild=false,buildAttempts=0;const stopped:number[]=[];const started:{args:string[];cwd:string}[]=[];
const serviceFile=serviceDefinition().file;
fs.existsSync=((file:fs.PathLike)=>String(file)===serviceFile ? false : original.exists(file)) as typeof fs.existsSync;
// The real preflight sees a complete current build, but no installed app files
// are read or changed. Failed preflights stage output only inside this fixture.
fs.readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
  if(String(file)===buildStamp){
    if(failBuild)throw Object.assign(new Error("Fixture build stamp is absent"),{code:"ENOENT"});
    return JSON.stringify(version);
  }
  return (original.read as Function)(file,...args);
}) as typeof fs.readFileSync;
fs.statSync=((file:fs.PathLike,...args:unknown[])=>(original.stat as Function)(appEntries.has(String(file)) ? fixtureHtml : file,...args)) as typeof fs.statSync;
fs.mkdtempSync=((prefix:string,...args:unknown[])=>(original.mkdtemp as Function)(prefix.startsWith(path.join(ROOT,"app")+path.sep) ? path.join(tmp,"app-build-") : prefix,...args)) as typeof fs.mkdtempSync;
process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{
  if(pid!==oldPid && pid!==newPid) throw new Error("Refusing to touch a real process");
  if(signal===0){if(pid===oldPid&&!alive)throw Object.assign(new Error("gone"),{code:"ESRCH"});return true;}
  assert.equal(signal,"SIGTERM");assert.equal(pid,oldPid);stopped.push(pid);alive=false;return true;
}) as typeof process.kill;
childProcess.spawnSync=((command:string,args:string[])=>{
  if(command==="npm"){
    assert(failBuild,"a current build must not invoke npm");buildAttempts++;
    assert.deepEqual(args.slice(0,4),["run","build","--","--outDir"]);
    assert(path.resolve(args[4]).startsWith(tmp+path.sep),"failed build must stage outside the installed app");
    return {status:17,stdout:"",stderr:"Fixture npm build failed; existing server must stay running"};
  }
  assert.equal(command,"ps");assert.deepEqual(args,["-p",String(oldPid),"-o","command="]);
  return {status:0,stdout:valid ? `${process.execPath} ${ROOT}/cli/src/main.ts serve --port 4317` : "node unrelated-program.js",stderr:""};
}) as typeof childProcess.spawnSync;
childProcess.spawn=((command:string,args:string[],options:{cwd:string})=>{
  assert.equal(command,process.execPath);started.push({args,cwd:options.cwd});
  const child=new EventEmitter() as EventEmitter&{unref:()=>void;exitCode:null};child.unref=()=>{};child.exitCode=null;
  queueMicrotask(()=>fs.writeFileSync(discovery,JSON.stringify({pid:newPid,port:4317,root:workspace,protocol:2})));
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
const healthyFetch: typeof fetch=async input=>{
  const url=String(input);if(url.endsWith("/api/system")){systemChecks++;return new Response(JSON.stringify({version:{number:"0.1.0"},account:{id:"signup-user",email:"person@example.com"}}));}
  assert(url.endsWith("/api/state"));return new Response(JSON.stringify({workspace:{id:"abc123"}}));
};
globalThis.fetch=healthyFetch;
try {
  const {restartLocal}=await import("../src/restart.ts");
  const result=await restartLocal();
  assert.deepEqual(stopped,[oldPid]);assert.equal(started.length,1);assert.equal(started[0].cwd,workspace);
  assert.ok(started[0].args.includes("serve"));assert.ok(started[0].args.includes("4317"));
  assert.ok(systemChecks>0);assert.match(result.url,/4317\/w\/abc123\//);
  alive=true;oldRecord();failBuild=true;
  await assert.rejects(restartLocal(),/build|npm/i);
  assert.equal(buildAttempts,1,"restart attempted the stale app preflight");
  assert.equal(stopped.length,1,"a build failure must not stop the existing server");
  assert.equal(started.length,1,"a build failure must not launch a replacement server");
  assert.equal(alive,true);
  failBuild=false;
  alive=true;valid=false;oldRecord();
  await assert.rejects(restartLocal(),/Cannot verify/);assert.equal(stopped.length,1);assert.equal(started.length,1);
  globalThis.fetch=async()=>{throw new Error("isolated network");};
  await assert.rejects(restartLocal(),/No reachable Surface server/);assert.equal(stopped.length,1);
  fs.rmSync(discovery);
  process.chdir(workspace);
  globalThis.fetch=healthyFetch;
  const recovered=await restartLocal();
  assert.equal(started.length,2,"restart also starts a server that has crashed");
  assert.equal(stopped.length,1,"recovery never kills an unverified process");
  assert.match(recovered.url,/4317\/w\/abc123\//);
  console.log("Restart: verified legacy PID, preserved workspace and port, build failure before server stop, ready account/update API, unrelated-process refusal and unreachable-server handling passed.");
} finally {
  process.chdir(original.cwd);process.kill=original.kill;childProcess.spawn=original.spawn;childProcess.spawnSync=original.spawnSync;globalThis.fetch=original.fetch;fs.existsSync=original.exists;fs.readFileSync=original.read;fs.statSync=original.stat;fs.mkdtempSync=original.mkdtemp;syncBuiltinESMExports();fs.rmSync(tmp,{recursive:true,force:true});
}
