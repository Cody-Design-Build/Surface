// Exercise update orchestration without network access or changing the installed checkout.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"surface-update-test-"));
Object.assign(process.env,{SURFACE_CONFIG_DIR:path.join(tmp,"config"),SURFACE_DATA_DIR:path.join(tmp,"data"),SURFACE_STORE:"local"});
fs.mkdirSync(process.env.SURFACE_CONFIG_DIR!,{recursive:true});
fs.mkdirSync(path.join(process.env.SURFACE_DATA_DIR!,"db"),{recursive:true});
fs.writeFileSync(path.join(process.env.SURFACE_DATA_DIR!,"db","pending"),"a pending edit");
const workspace=path.join(tmp,"workspace"); fs.mkdirSync(path.join(workspace,".surface"),{recursive:true});
fs.writeFileSync(path.join(workspace,".surface","config.json"),JSON.stringify({workspace:"test",layout:"type"}));
fs.writeFileSync(path.join(process.env.SURFACE_CONFIG_DIR!,"checkouts.json"),JSON.stringify([{workspace:"test",root:workspace}]));
let dirty=false, fetchFails=false, diverged=false, current="a".repeat(40), target="b".repeat(40);
const calls:{cmd:string;args:string[]}[]=[];
const original=childProcess.spawnSync;
childProcess.spawnSync=((cmd:string,args:string[])=>{
  calls.push({cmd,args}); let stdout="";
  if(cmd==="git") {
    if(args[0]==="symbolic-ref") stdout="main";
    if(args[0]==="status") stdout=dirty ? " M cli/src/main.ts" : "";
    if(args[0]==="rev-parse") stdout=args[1]==="--abbrev-ref" ? "origin/main" : args[1]==="HEAD" ? current : target;
    if(args[0]==="config") stdout="origin";
    if(args[0]==="fetch" && fetchFails) return {status:1,stdout:"",stderr:"offline",error:undefined};
    if(args[0]==="merge-base" && diverged) return {status:1,stdout:"",stderr:"",error:undefined};
    if(args[0]==="merge") current=target;
  }
  return {status:0,stdout,stderr:"",error:undefined};
}) as typeof childProcess.spawnSync;
syncBuiltinESMExports();
const {update,updateSchedule,startUpdateJob,runUpdateJob,updateJobStatus,updateJobCommand}=await import("../src/update.ts");
const {serviceDefinition}=await import("../src/service.ts");
let count=0;const ok=(s:string)=>console.log(`ok ${++count} ${s}`);
try {
  dirty=true;
  await assert.rejects(update(),/local code changes/);
  assert.equal(calls.some(c=>c.args[0]==="fetch"),false);
  assert.equal(fs.existsSync(path.join(process.env.SURFACE_CONFIG_DIR!,"update.lock")),false);
  ok("local code changes stop an update before fetch, stop, or merge");
  dirty=false;calls.length=0;
  await update({check:true});
  assert.equal(current,"a".repeat(40));assert.equal(calls.some(c=>c.args[0]==="merge"),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.SURFACE_CONFIG_DIR!,"update.json"),"utf8")).updateAvailable,true);
  ok("check-only records availability without installing or restarting");
  diverged=true;await assert.rejects(update(),/diverged/);diverged=false;
  fetchFails=true;await assert.rejects(update(),/offline/);fetchFails=false;
  assert.equal(current,"a".repeat(40));
  ok("diverged branches and failed downloads leave the installed commit alone");
  calls.length=0;
  await update();
  assert.equal(current,target);
  const state=JSON.parse(fs.readFileSync(path.join(process.env.SURFACE_CONFIG_DIR!,"update.json"),"utf8"));
  assert.equal(fs.readFileSync(path.join(state.backup,"db","pending"),"utf8"),"a pending edit");
  assert.equal(calls.filter(c=>c.cmd==="npm" && c.args[0]==="ci").length,2);
  assert.ok(calls.some(c=>c.cmd==="npm" && c.args.join(" ")==="run build"));
  assert.ok(calls.some(c=>c.args.includes("doctor")));
  assert.equal(state.updateAvailable,false);
  ok("install backs up pending data, fast-forwards, installs locked dependencies, builds, and checks");
  target="c".repeat(40); calls.length=0;
  const realFetch=globalThis.fetch;
  const cfg=process.env.SURFACE_CONFIG_DIR!;
  fs.writeFileSync(path.join(cfg,"serve.json"),JSON.stringify({pid:process.pid,port:4317,root:workspace}));
  fs.writeFileSync(path.join(cfg,"serve-token"),"test-token");
  let health={clients:1,pending:0};
  globalThis.fetch=async () => new Response(JSON.stringify(health),{headers:{"content-type":"application/json"}});
  try {
    await update({background:true});
    health={clients:0,pending:1};await update({background:true});
    assert.equal(current,"b".repeat(40));assert.equal(calls.some(c=>c.args[0]==="merge"),false);
  } finally { globalThis.fetch=realFetch;fs.rmSync(path.join(cfg,"serve.json")); }
  ok("automatic installation waits for connected app tabs and pending changes");
  const linux=serviceDefinition(4317,"linux",tmp);
  assert.match(linux.body,/all workspaces/);assert.ok(linux.body.includes(`WorkingDirectory=${process.env.SURFACE_CONFIG_DIR}\n`),"WorkingDirectory is a raw path, not a quoted command argument");assert.doesNotMatch(linux.body,/WorkingDirectory=.*workspace/);
  assert.match(linux.body,/SURFACE_DATA_DIR=/);
  const mac=serviceDefinition(4317,"darwin",tmp); assert.match(mac.body,/<key>KeepAlive<\/key><true\/>/);
  const checks=updateSchedule("check","linux",tmp);assert.match(checks.files[0].body,/--check/);
  const automatic=updateSchedule("install","darwin",tmp);assert.match(automatic.files[0].body,/--background/);
  assert.ok(updateSchedule("off","linux",tmp).commands[0].includes("disable"));
  ok("service and scheduler definitions preserve directories and distinguish checks from idle installs");
  const originalSpawn=childProcess.spawn;
  let spawnFails=false;
  childProcess.spawn=((cmd:string,args:string[])=>{
    calls.push({cmd,args});
    const child=new EventEmitter() as EventEmitter & {unref:()=>void};child.unref=()=>{};
    queueMicrotask(()=>spawnFails ? child.emit("error",new Error("updater launch failed")) : child.emit("spawn"));
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const job=await startUpdateJob("check");
    assert.equal(updateJobStatus()?.state,"running");
    await assert.rejects(startUpdateJob("install"),/already running/);
    await runUpdateJob(job.id,"check");assert.equal(updateJobStatus()?.state,"complete");
    dirty=true;
    const install=await startUpdateJob("install");
    await assert.rejects(runUpdateJob(install.id,"install"),/local code changes/);
    assert.equal(updateJobStatus()?.state,"error");assert.match(updateJobStatus()?.error ?? "",/local code changes/);
    dirty=false;spawnFails=true;
    await assert.rejects(startUpdateJob("check"),/launch failed/);assert.equal(updateJobStatus()?.state,"error");
    const unit=updateJobCommand(job,true,"linux");assert.equal(unit.command,"systemd-run");
    assert.ok(unit.args.includes("--user"));assert.ok(unit.args.some(arg=>arg.includes("SURFACE_CONFIG_DIR=")));
    assert.ok(unit.args.some(arg=>arg.includes("StandardOutput=append:")));
    const launch=updateJobCommand(job,true,"darwin");assert.equal(launch.command,"launchctl");
    assert.ok(launch.args.includes("submit"));assert.ok(launch.args.includes("/usr/bin/env"));assert.ok(launch.args.includes(`SURFACE_CONFIG_DIR=${cfg}`));
    const detached=updateJobCommand(job,false);assert.equal(detached.command,process.execPath);assert.ok(detached.args.some(arg=>arg.endsWith("update-worker.ts")));
  } finally {childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
  ok("app update jobs report success, launch failures and rejected installs, with separate managed updater commands");
  console.log(`all ${count} update checks passed`);
} finally {
  childProcess.spawnSync=original;syncBuiltinESMExports();
  fs.rmSync(tmp,{recursive:true,force:true});
}
