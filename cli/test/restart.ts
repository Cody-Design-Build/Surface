// Exercise the legacy-server handoff without starting or killing a real process.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"surface-restart-test-"));
process.env.SURFACE_CONFIG_DIR=path.join(tmp,"config");process.env.SURFACE_STORE="local";
fs.mkdirSync(process.env.SURFACE_CONFIG_DIR,{recursive:true});
const workspace=path.join(tmp,"workspace");fs.mkdirSync(path.join(workspace,".surface"),{recursive:true});
fs.writeFileSync(path.join(workspace,".surface/config.json"),JSON.stringify({workspace:"abc123",layout:"type"}));
const discovery=path.join(process.env.SURFACE_CONFIG_DIR,"serve.json");
const oldPid=34567,newPid=34568;
const oldRecord=()=>fs.writeFileSync(discovery,JSON.stringify({pid:oldPid,port:4317,root:workspace}));oldRecord();
fs.writeFileSync(path.join(process.env.SURFACE_CONFIG_DIR,"serve-token"),"test-token");
const {ROOT,serviceDefinition}=await import("../src/service.ts");
const original={spawn:childProcess.spawn,spawnSync:childProcess.spawnSync,kill:process.kill,fetch:globalThis.fetch,exists:fs.existsSync};
let alive=true,valid=true,systemChecks=0;const stopped:number[]=[];const started:{args:string[];cwd:string}[]=[];
const serviceFile=serviceDefinition().file;
fs.existsSync=((file:fs.PathLike)=>String(file)===serviceFile ? false : original.exists(file)) as typeof fs.existsSync;
process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{
  if(pid!==oldPid && pid!==newPid) throw new Error("Refusing to touch a real process");
  if(signal===0){if(pid===oldPid&&!alive)throw Object.assign(new Error("gone"),{code:"ESRCH"});return true;}
  assert.equal(signal,"SIGTERM");assert.equal(pid,oldPid);stopped.push(pid);alive=false;return true;
}) as typeof process.kill;
childProcess.spawnSync=((command:string,args:string[])=>{
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
globalThis.fetch=async input=>{
  const url=String(input);if(url.endsWith("/api/system")){systemChecks++;return new Response(JSON.stringify({version:{number:"0.1.0"},account:{id:"signup-user",email:"person@example.com"}}));}
  assert(url.endsWith("/api/state"));return new Response(JSON.stringify({workspace:{id:"abc123"}}));
};
try {
  const {restartLocal}=await import("../src/restart.ts");
  const result=await restartLocal();
  assert.deepEqual(stopped,[oldPid]);assert.equal(started.length,1);assert.equal(started[0].cwd,workspace);
  assert.ok(started[0].args.includes("serve"));assert.ok(started[0].args.includes("4317"));
  assert.ok(systemChecks>0);assert.match(result.url,/4317\/w\/abc123\//);
  alive=true;valid=false;oldRecord();
  await assert.rejects(restartLocal(),/Cannot verify/);assert.equal(stopped.length,1);assert.equal(started.length,1);
  globalThis.fetch=async()=>{throw new Error("isolated network");};
  await assert.rejects(restartLocal(),/No reachable Surface server/);assert.equal(stopped.length,1);
  console.log("Restart: verified legacy PID, preserved workspace and port, ready account/update API, unrelated-process refusal and unreachable-server handling passed.");
} finally {
  process.kill=original.kill;childProcess.spawn=original.spawn;childProcess.spawnSync=original.spawnSync;globalThis.fetch=original.fetch;fs.existsSync=original.exists;syncBuiltinESMExports();fs.rmSync(tmp,{recursive:true,force:true});
}
