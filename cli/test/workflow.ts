// Real PGlite stores and HTTP handlers, in one process: no accounts, sockets or subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-workflow-"));
Object.assign(process.env, { SURFACE_STORE:"local", SURFACE_CONFIG_DIR:path.join(tmp,"config"), SURFACE_DATA_DIR:path.join(tmp,"hub"), SURFACE_LOG_FILE:"off", SURFACE_SYNC:"off" });
const hub = await import(new URL("../src/local.ts?workflow-hub",import.meta.url).href);
await hub.localInfo();
process.env.SURFACE_DATA_DIR = path.join(tmp,"local");
const local = await import("../src/local.ts");
await local.localInfo();
const { sb } = await import("../src/client.ts");
const sync = await import("../src/sync.ts");
const { saveCheckout, findCheckout } = await import("../src/config.ts");
const db = sb();
const must = (r: any) => { if (r.error) throw new Error(r.error.message); return r.data; };
let offline = false, lostReply = false, legacyAliases = false;
let duringPush: (() => Promise<void>) | null = null;
let duringPull: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("http://workflow-hub/")) return realFetch(input,init);
  if (offline) throw new Error("fetch failed: offline");
  const descriptor = JSON.parse(String(init?.body));
  // The second local module is the simulated cloud. Execute its schema writes under
  // its authenticated role directly, so they don't route through this client's module.
  const result = descriptor.table === "types" && descriptor.kind !== "select"
    ? await hub.localAdmin(async (tx:any) => {
        await tx.exec("set local role authenticated");
        const values:unknown[]=[];
        const bind=(v:unknown)=>{values.push(v && typeof v === "object" ? JSON.stringify(v) : v);return `$${values.length}`;};
        const quote=(v:string)=>`"${v}"`;
        const entries=Object.entries(descriptor.values ?? {});
        let sql=descriptor.kind === "insert"
          ? `insert into public.types (${entries.map(([k])=>quote(k)).join(",")}) values (${entries.map(([,v])=>bind(v)).join(",")})`
          : descriptor.kind === "delete" ? "delete from public.types"
          : `update public.types set ${entries.map(([k,v])=>`${quote(k)}=${bind(v)}`).join(",")}`;
        if(descriptor.filters.length) sql += " where " + descriptor.filters.map((f:any)=>`${quote(f.col)}=${bind(f.value)}`).join(" and ");
        const rows=(await tx.query(sql+" returning *",values)).rows;
        return {data:descriptor.single ? rows[0] ?? null : rows,error:null};
      })
    : await hub.exec(descriptor);
  if (descriptor.table === "records" && descriptor.kind === "update") {
    if (duringPush) { const fn = duringPush; duringPush = null; await fn(); }
    if (lostReply) { lostReply = false; throw new Error("fetch failed: acknowledgement lost"); }
  }
  if (duringPull && descriptor.table === "records" && descriptor.kind === "select" && descriptor.columns === "*" && descriptor.filters.some((f:any)=>f.op==="in")) {
    const fn=duringPull;duringPull=null;await fn();
  }
  if (legacyAliases && descriptor.table === "records" && result.data) {
    for (const row of Array.isArray(result.data) ? result.data : [result.data]) delete row.aliases;
  }
  return new Response(JSON.stringify(result),{headers:{"content-type":"application/json"}});
};
let count = 0;
const ok = (name:string) => console.log(`ok ${++count} ${name}`);
let server: import("node:http").Server | undefined;
const query = async (id:string) => must(await db.from("records").select("*").eq("id",id).single());
const push = async (ws:string,id:string|null,title:string,fields:Record<string,unknown>,body="") => must(await db.rpc("push_record",{p_workspace:ws,p_id:id,p_base_rev:id ? (await query(id)).rev : null,p_type:"task",p_title:title,p_fields:fields,p_body:body}));
try {
  const ws = must(await db.rpc("create_workspace",{p_name:"Business"})).id as string;
  must(await db.from("types").insert({workspace_id:ws,key:"task",name:"Task",fields:[{key:"status",kind:"text"},{key:"phone",kind:"text"}]}));
  const t = must(await db.from("types").select("*").eq("workspace_id",ws).eq("key","task").single());
  const statusId = t.fields.find((f:any)=>f.key==="status").id;
  const phoneId = t.fields.find((f:any)=>f.key==="phone").id;
  const record = await push(ws,null,"Vendor",{status:"todo",phone:"111"},"Initial body");
  const root = path.join(tmp,"Business");
  saveCheckout({root,config:{workspace:ws,workspaceName:"Business",layout:"type"},state:{records:{}}});
  const h = await sync.enableSync(ws,{kind:"surface",url:"http://workflow-hub",token:"test"});
  let report = await sync.syncWorkspace(ws);
  assert.deepEqual(report.errors,[]); assert.ok(report.pushed);
  const hubRow = async () => must(await hub.exec({kind:"select",table:"records",columns:"*",filters:[{col:"id",op:"eq",value:record.id}],order:[],single:"one",returning:false}));
  const cloudEdit = async (patch:Record<string,unknown>) => hub.localAdmin(async (tx:any) => {
    if (patch.fields) await tx.query("update public.records set fields=fields || $2::jsonb where id=$1",[record.id,JSON.stringify(patch.fields)]);
    if (patch.body) await tx.query("update public.records set body=$2 where id=$1",[record.id,patch.body]);
  });
  const ht = must(await hub.exec({kind:"select",table:"types",columns:"*",filters:[{col:"workspace_id",op:"eq",value:h.workspace},{col:"key",op:"eq",value:"task"}],order:[],single:"one",returning:false}));
  const hs = ht.fields.find((f:any)=>f.key==="status").id;
  const hp = ht.fields.find((f:any)=>f.key==="phone").id;
  ok("existing local workspace uploads through the normal validated path");

  await push(ws,record.id,"Vendor",{status:"doing",phone:"111"},"Initial body");
  await cloudEdit({fields:{[hp]:"222"}});
  report = await sync.syncWorkspace(ws);
  assert.deepEqual(report.errors,[]); assert.equal(report.conflicts.length,0);
  let row = await query(record.id);
  assert.equal(row.fields[statusId],"doing"); assert.equal(row.fields[phoneId],"222");
  assert.equal((await hubRow()).fields[hs],"doing"); assert.equal((await hubRow()).fields[hp],"222");
  ok("concurrent changes to different fields survive on both sides");

  await push(ws,record.id,"Vendor",{status:"done",phone:"222"},"Initial body");
  await cloudEdit({fields:{[hs]:"done"}});
  const rev = (await hubRow()).rev;
  report = await sync.syncWorkspace(ws);
  assert.deepEqual(report.errors,[]); assert.equal(report.conflicts.length,0); assert.equal((await hubRow()).rev,rev);
  ok("identical changes acknowledge without another revision or conflict copy");

  await push(ws,record.id,"Vendor",{status:"mine",phone:"222"},"Initial body");
  await cloudEdit({fields:{[hs]:"theirs"}});
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);assert.equal(report.conflicts.length,1);
  const fieldConflict=(await sync.syncStatus(ws))!.conflicts[0];
  assert.equal((await query(record.id)).fields[statusId],"theirs");
  assert.equal((await query(fieldConflict.copy_id)).fields[statusId],"mine");
  await sync.syncWorkspace(ws);
  must(await db.from("records").update({deleted_at:new Date().toISOString()}).eq("id",fieldConflict.copy_id));
  await sync.resolveConflict(ws,record.id);await sync.syncWorkspace(ws);
  await push(ws,record.id,"Vendor",{status:"done",phone:"222"},"Initial body");await sync.syncWorkspace(ws);
  ok("competing edits to the same structured field keep an explicit recoverable copy");

  await push(ws,record.id,"Vendor",{status:"offline",phone:"222"},"Initial body");
  offline = true;
  report = await sync.syncWorkspace(ws);
  assert.equal(report.offline,true); assert.equal((await query(record.id)).fields[statusId],"offline");
  assert.equal((await sync.syncStatus(ws))!.pending.record,1);
  const queued = await local.localAdmin(async tx => (await tx.query<any>("select before_row,after_row from surface_local.outbox")).rows);
  assert.equal(queued.length,1); assert.equal(queued[0].before_row.fields[statusId],"done");
  // Close/reopen proves the outbox is durable, rather than only an in-memory queue.
  await local.closeLocal(); await local.localInfo();
  offline = false;
  report = await sync.syncWorkspace(ws);
  assert.deepEqual(report.errors,[]); assert.equal((await hubRow()).fields[hs],"offline");
  assert.deepEqual((await sync.syncStatus(ws))!.pending,{});
  ok("offline edits and their baseline survive database restart and reconnect");

  await push(ws,record.id,"Vendor",{status:"retry",phone:"222"},"Initial body");
  lostReply = true;
  report = await sync.syncWorkspace(ws); assert.equal(report.offline,true);
  const retryRev = (await hubRow()).rev;
  report = await sync.syncWorkspace(ws);
  assert.deepEqual(report.errors,[]); assert.equal(report.conflicts.length,0); assert.equal((await hubRow()).rev,retryRev);
  ok("lost acknowledgements retry without duplicate revisions or conflicts");

  await push(ws,record.id,"Vendor",{status:"in-flight",phone:"222"},"Initial body");
  duringPush = async () => { await push(ws,record.id,"Vendor",{status:"newer",phone:"222"},"New body during sync"); };
  report = await sync.syncWorkspace(ws); assert.deepEqual(report.errors,[]);
  assert.equal((await query(record.id)).fields[statusId],"newer");
  assert.equal((await sync.syncStatus(ws))!.pending.record,1);
  report = await sync.syncWorkspace(ws); assert.deepEqual(report.errors,[]);
  assert.equal((await hubRow()).fields[hs],"newer"); assert.equal((await hubRow()).body,"New body during sync");
  ok("an edit made during upload remains visible, queued, and is sent next");

  await push(ws,record.id,"Vendor",{status:"newer",phone:"222"},"My competing body");
  await cloudEdit({body:"Their competing body"});
  report = await sync.syncWorkspace(ws); assert.deepEqual(report.errors,[]); assert.equal(report.conflicts.length,1);
  assert.equal((await query(record.id)).body,"Their competing body");
  const conflicts = (await sync.syncStatus(ws))!.conflicts;
  assert.equal((await query(conflicts[0].copy_id)).body,"My competing body");
  await sync.syncWorkspace(ws); await sync.resolveConflict(ws,record.id);
  ok("competing body edits preserve the local version as an explicit conflict copy");

  // Removing a shared field executes remotely; its local rewrite is a pull, not another edit.
  const currentType = must(await db.from("types").select("*").eq("id",t.id).single());
  must(await db.from("types").update({fields:currentType.fields.filter((f:any)=>f.key!=="phone")}).eq("id",t.id));
  assert.equal((await query(record.id)).fields[phoneId],undefined);
  assert.deepEqual((await sync.syncStatus(ws))!.pending,{});
  assert.equal((await sync.syncStatus(ws))!.conflicts.length,0);
  offline = true;
  const rejected = await db.from("types").update({name:"Offline schema change"}).eq("id",t.id);
  assert.ok(rejected.error); offline = false;
  assert.equal(must(await db.from("types").select("name").eq("id",t.id).single()).name,"Task");
  ok("shared schema edits run at the hub; offline schema changes leave local data intact");

  // A remote field rename retains its permanent local id even with a pending value.
  await push(ws,record.id,"Vendor",{status:"pending rename"},"Their competing body");
  await hub.localAdmin(async (tx:any) => {
    const type = (await tx.query("select * from public.types where id=$1",[ht.id])).rows[0];
    const fields = type.fields.map((f:any)=>({...f,key:f.key==="status" ? "stage" : f.key}));
    await tx.query("update public.types set fields=$2::jsonb where id=$1",[ht.id,JSON.stringify(fields)]);
  });
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);assert.equal(report.conflicts.length,0);
  const renamed=must(await db.from("types").select("*").eq("id",t.id).single());
  assert.equal(renamed.fields.find((f:any)=>f.key==="stage").id,statusId);
  assert.equal((await hubRow()).fields[hs],"pending rename");
  ok("a cloud field rename preserves permanent ids and unsent values");

  const toDelete=must(await db.from("types").insert({workspace_id:ws,key:"temporary",name:"Temporary"}).select("*").single());
  must(await db.rpc("push_record",{p_workspace:ws,p_id:null,p_base_rev:null,p_type:"temporary",p_title:"Keep this",p_fields:{},p_body:"Move me"}));
  await sync.syncWorkspace(ws);
  await sync.syncCall("removeType",ws,toDelete.id,"task",false);
  assert.equal(must(await db.from("types").select("*").eq("id",toDelete.id).maybeSingle()),null);
  assert.equal(must(await db.from("records").select("*").eq("workspace_id",ws).eq("title","Keep this").single()).type_id,t.id);
  ok("shared type removal moves records on the hub and follows with a local pull");

  // Revoked write access must never turn into a clean acknowledgement.
  must(await db.from("records").update({title:"Pending permission"}).eq("id",record.id));
  await hub.localAdmin(async (tx:any)=>tx.query("update public.members set role='viewer' where workspace_id=$1",[h.workspace]));
  report=await sync.syncWorkspace(ws);assert.ok(report.errors.length);
  assert.equal((await sync.syncStatus(ws))!.pending.record,1);
  await hub.localAdmin(async (tx:any)=>tx.query("update public.members set role='owner' where workspace_id=$1",[h.workspace]));
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  ok("permission failures preserve queued edits for a later successful retry");

  legacyAliases=true;
  must(await db.from("records").update({title:"Legacy hub accepted"}).eq("id",record.id));
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  assert.deepEqual((await query(record.id)).aliases,[]);
  legacyAliases=false;
  ok("a pre-alias cloud response can still acknowledge edits without dropping local data");

  await cloudEdit({body:"Cloud body during pull"});
  duringPull=async()=>{must(await db.from("records").update({title:"Edited during pull"}).eq("id",record.id));};
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  assert.equal((await query(record.id)).title,"Edited during pull");
  assert.equal((await sync.syncStatus(ws))!.pending.record,1);
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  assert.equal((await hubRow()).title,"Edited during pull");assert.equal((await query(record.id)).body,"Cloud body during pull");
  ok("a local edit racing a cloud pull is preserved and reconciled on the next round");

  must(await db.from("records").update({deleted_at:new Date().toISOString()}).eq("id",record.id));
  await cloudEdit({body:"An edit wins over deletion"});
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  assert.equal((await query(record.id)).deleted_at,null);assert.equal((await query(record.id)).body,"An edit wins over deletion");
  await hub.localAdmin(async(tx:any)=>tx.query("update public.records set deleted_at=now() where id=$1",[record.id]));
  must(await db.from("records").update({title:"Restored by local edit"}).eq("id",record.id));
  report=await sync.syncWorkspace(ws);assert.deepEqual(report.errors,[]);
  assert.equal((await hubRow()).deleted_at,null);assert.equal((await hubRow()).title,"Restored by local edit");
  ok("edits win over concurrent deletion in either direction");

  const privateWs = must(await db.rpc("create_workspace",{p_name:"Private"})).id as string;
  const privateRoot = path.join(tmp,"Private");
  saveCheckout({root:privateRoot,config:{workspace:privateWs,workspaceName:"Private",layout:"type"},state:{records:{}}});
  const { serve } = await import("../src/serve.ts");
  const { pull } = await import("../src/checkout.ts");
  await pull(findCheckout(root)!); await pull(findCheckout(privateRoot)!);
  const otherRoot=path.join(tmp,"Second-vault");
  saveCheckout({root:otherRoot,config:{workspace:ws,workspaceName:"Business",layout:"type"},state:{records:{}}});
  await pull(findCheckout(otherRoot)!);
  ({server} = await serve(findCheckout(root)!,{port:4317,watch:true,listen:false}));
  const token = fs.readFileSync(path.join(tmp,"config","serve-token"),"utf8").trim();
  async function request(url:string, method="GET", body?:unknown, extra:Record<string,string>={}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req,{url,method,headers:{host:"127.0.0.1:4317",cookie:`surface_token=${token}`,...extra}});
    const chunks:Buffer[]=[];
    const res = new Writable({write(chunk,_enc,done){chunks.push(Buffer.from(chunk));done();}}) as Writable & {statusCode:number;headersSent:boolean;writeHead:(status:number,headers:unknown)=>void;headers:unknown};
    res.statusCode=200; res.headersSent=false;
    res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;res.headersSent=true;};
    const finished = new Promise<void>((resolve,reject)=>{res.once("finish",resolve);res.once("error",reject);});
    server!.emit("request",req,res); await finished;
    const text=Buffer.concat(chunks).toString();
    return {status:res.statusCode,headers:res.headers,data:()=>JSON.parse(text),text};
  }
  const businessUrl = `/w/${ws}/api/state`, privateUrl = `/w/${privateWs}/api/state`;
  const states = await Promise.all([request(businessUrl),request(privateUrl)]);
  assert.equal(states[0].data().workspace.id,ws); assert.equal(states[1].data().workspace.id,privateWs);
  const switched = await request(`/w/${ws}/api/workspace/switch`,"POST",{id:privateWs});
  assert.equal(switched.data().url,`/w/${privateWs}/`);
  assert.equal((await request(businessUrl)).data().workspace.id,ws);
  assert.equal((await request(privateUrl)).data().workspace.home,"local");
  const forbidden=await request(privateUrl,"GET",undefined,{cookie:""}); assert.equal(forbidden.status,401);
  const invalid=await request("/w/not-a-workspace/api/state"); assert.equal(invalid.status,404);
  ok("one HTTP server isolates workspaces and tab switches, with auth on every workspace");
  const dataPage=await request(`/w/${ws}/data/`); assert.equal(dataPage.status,200); assert.match(dataPage.text,/data-/);
  for (const app of (await import("../../surfaces.mts")).apps) {
    const page=await request(`/w/${ws}${app.path}`);
    assert.equal(page.status,200); assert.match(page.text,/<!doctype html>/i);
    assert.ok(page.text.includes(`<title>${app.name}</title>`),`route opens ${app.name}, not another app's HTML`);
    const direct=await request(`/${app.entry}`);
    assert.equal(direct.status,302); assert.equal((direct.headers as Record<string,string>).location,`/w/${ws}${app.path}`);
    const signedIn=await request(`${app.path}?token=${token}`,"GET",undefined,{cookie:""});
    assert.equal(signedIn.status,302); assert.equal((signedIn.headers as Record<string,string>).location,`/w/${ws}${app.path}`);
    assert.equal((await request(`/w/${ws}${app.path}`,"GET",undefined,{cookie:""})).status,401);
  }
  const system=await request(`/w/${ws}/api/system`); assert.equal(system.status,200); assert.ok(system.data().version.number);
  assert.equal((await request("/api/system","GET",undefined,{cookie:""})).status,401);
  assert.equal((await request("/api/system/update","POST",{operation:"install"},{origin:"https://example.com"})).status,403);
  assert.equal((await request("/api/system/update","POST",{operation:"arbitrary-command"})).status,400);
  assert.equal((await request("/api/system/update","POST",{operation:"install"},{cookie:""})).status,401);
  const realSpawn=childProcess.spawn;
  childProcess.spawn=(()=>{const child=new EventEmitter() as EventEmitter & {unref:()=>void};child.unref=()=>{};queueMicrotask(()=>child.emit("spawn"));return child;}) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const scheduled=await request(`/w/${ws}/api/system/update`,"POST",{operation:"check"});
    assert.equal(scheduled.status,202);
    const status=await request("/api/system");
    assert.equal(status.data().update.job.id,scheduled.data().job.id);assert.equal(status.data().update.job.state,"running");
  } finally {childProcess.spawn=realSpawn;syncBuiltinESMExports();fs.rmSync(path.join(tmp,"config","update-job.json"),{force:true});}
  const health=await request("/api/_health","GET",undefined,{"x-surface-token":token}); assert.equal(health.status,200); assert.equal(health.data().pending,0);
  await assert.rejects(serve(findCheckout(privateRoot)!,{port:4318,watch:false,listen:false}),/Another Surface/);
  ok("writing and data share the server, and a second server is refused");
  const stateFile=findCheckout(otherRoot)!.state.records[record.id].path;
  const file=path.join(otherRoot,stateFile);
  fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace((await query(record.id)).body,"Edited in the second Markdown vault"));
  const deadline=Date.now()+8000;
  while (!(await query(record.id)).body.includes("Edited in the second Markdown vault")) {
    if(Date.now()>deadline) assert.fail("second Markdown checkout was not watched");
    await new Promise(r=>setTimeout(r,100));
  }
  ok("the single server watches additional Markdown vaults for the same workspace");
  server.emit("close"); server=undefined;
  console.log(`all ${count} workflow checks passed`);
} finally {
  if (server) server.emit("close");
  globalThis.fetch=realFetch;
  await local.closeLocal();
  process.env.SURFACE_DATA_DIR=path.join(tmp,"hub"); await hub.closeLocal();
  fs.rmSync(tmp,{recursive:true,force:true});
}
