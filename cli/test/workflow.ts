// Real PGlite stores and HTTP handlers, in one process: no accounts, sockets or subprocesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { FieldDef, RecordRow, TypeRow } from "../src/db.ts";
import type * as LocalDatabase from "../src/local.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-workflow-"));
Object.assign(process.env, { SURFACE_STORE:"local", SURFACE_CONFIG_DIR:path.join(tmp,"config"), SURFACE_DATA_DIR:path.join(tmp,"hub"), SURFACE_LOG_FILE:"off", SURFACE_SYNC:"off" });
delete process.env.SURFACE_SUPABASE_URL; delete process.env.SURFACE_PUBLISHABLE_KEY;
// Separate runtime module instances capture each isolated database directory after env setup.
const hub: typeof LocalDatabase = await import(new URL("../src/local.ts?workflow-hub",import.meta.url).href);
await hub.localInfo();
process.env.SURFACE_DATA_DIR = path.join(tmp,"local");
const local = await import("../src/local.ts");
await local.localInfo();
const { sb } = await import("../src/client.ts");
const sync = await import("../src/sync.ts");
const { saveCheckout, findCheckout } = await import("../src/config.ts");
const db = sb();
const must = (r: any) => { if (r.error) throw new Error(r.error.message); return r.data; };
// Runtime database modules must load after this fixture selects its isolated data directories.
const { fetchRecords, fetchTypes, materializeInverseLinks } = await import("../src/db.ts");
let offline = false, lostReply = false, legacyAliases = false;
let legacyInverse = false;
let duringPush: (() => Promise<void>) | null = null;
let duringPull: (() => Promise<void>) | null = null;
let authFailure = false;
let beforeHubRequest: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("http://workflow-hub/")) return realFetch(input,init);
  if (offline) throw new Error("fetch failed: offline");
  if (beforeHubRequest) { const wait = beforeHubRequest; beforeHubRequest = null; await wait(); }
  if (authFailure) return Response.json({ data: null, error: { message: "JWT expired", code: "PGRST301" } });
  const descriptor = JSON.parse(String(init?.body));
  if (legacyInverse && descriptor.kind === "rpc" && descriptor.fn === "surface_schema_version") {
    return Response.json({ data: null, error: { code: "PGRST202", message: "Could not find public.surface_schema_version" } });
  }
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
  const lastAccepted = (await sync.syncStatus(ws))!.last_sync;
  report=await sync.syncWorkspace(ws);assert.ok(report.errors.length);
  assert.equal((await sync.syncStatus(ws))!.pending.record,1);
  assert.equal(JSON.stringify((await sync.syncStatus(ws))!.last_sync), JSON.stringify(lastAccepted), "partial failures never advance the last successful sync");
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

  // Real inverse sync with deliberately different permanent source field IDs.
  // Only the missing capability response is simulated; all schema and record writes
  // below go through the actual shared-schema routing and both real databases.
  const relationWorkspace: { id: string } = must(await db.rpc("create_workspace", { p_name: "Relationships" }));
  const relationWs = relationWorkspace.id;
  const organization: TypeRow = must(await db.from("types").insert({ workspace_id: relationWs, key: "organization", name: "Organization" }).select("*").single());
  const contact: TypeRow = must(await db.from("types").insert({
    workspace_id: relationWs, key: "contact", name: "Contact",
    fields: [{ key: "organizations", kind: "link", multiple: true, target: organization.id }],
  }).select("*").single());
  const forward = contact.fields.find(f => f.key === "organizations")!;
  const pushRelation = async (type: string, title: string, fields: Record<string, unknown>, existing?: RecordRow): Promise<RecordRow> => must(await db.rpc("push_record", {
    p_workspace: relationWs, p_id: existing?.id ?? null, p_base_rev: existing?.rev ?? null,
    p_type: type, p_title: title, p_fields: fields, p_body: existing?.body ?? "",
  }));
  const org = await pushRelation("organization", "Cody Design Build", {});
  const anna = await pushRelation("contact", "Anna", { organizations: [org.id] });
  const ben = await pushRelation("contact", "Ben", {});
  const remoteWorkspace: { id: string } = must(await hub.exec({ kind: "rpc", fn: "create_workspace", args: { p_name: "Relationship hub" } }));
  const hubContact = await hub.localAdmin(async tx => {
    const target = (await tx.query<TypeRow>("insert into public.types (workspace_id,key,name) values ($1,'organization','Organization') returning *", [remoteWorkspace.id])).rows[0];
    return (await tx.query<TypeRow>("insert into public.types (workspace_id,key,name,fields) values ($1,'contact','Contact',$2::jsonb) returning *",
      [remoteWorkspace.id, JSON.stringify([{ key: "organizations", kind: "link", multiple: true, target: target.id }])])).rows[0];
  });
  const hubForward = hubContact.fields.find(f => f.key === "organizations")!;
  assert.notEqual(forward.id, hubForward.id, "the fixture must exercise genuine field-id remapping");
  await sync.enableSync(relationWs, { kind: "surface", url: "http://workflow-hub", token: "test", workspace: remoteWorkspace.id });
  assert.deepEqual((await sync.syncWorkspace(relationWs)).errors, []);
  const hubRelationTypes = () => hub.localAdmin(async tx => (await tx.query<TypeRow>("select * from public.types where workspace_id=$1 order by id", [remoteWorkspace.id])).rows);
  const hubRelationRecords = () => hub.localAdmin(async tx => (await tx.query<RecordRow>("select * from public.records where workspace_id=$1 order by id", [remoteWorkspace.id])).rows);
  const reverseDraft: Omit<FieldDef, "id" | "name"> = { key: "contacts", kind: "link", multiple: true, target: contact.id, inverse: forward.id };
  const localSchemaBefore = await fetchTypes(relationWs);
  const hubSchemaBefore = await hubRelationTypes();
  const syncBefore = (await sync.syncStatus(relationWs))!;
  legacyInverse = true;
  try {
    const refused = await db.from("types").update({ fields: [...organization.fields, reverseDraft] }).eq("id", organization.id);
    assert.ok(refused.error, "an old hub must refuse inverse metadata before any schema write");
  } finally { legacyInverse = false; }
  assert.deepEqual(await fetchTypes(relationWs), localSchemaBefore);
  assert.deepEqual(await hubRelationTypes(), hubSchemaBefore);
  const syncAfterRefusal = (await sync.syncStatus(relationWs))!;
  assert.deepEqual(syncAfterRefusal.hub, syncBefore.hub);
  assert.deepEqual(syncAfterRefusal.pending, syncBefore.pending);
  assert.deepEqual(syncAfterRefusal.last_sync, syncBefore.last_sync);
  assert.deepEqual((await query(anna.id)).fields[forward.id], [org.id]);
  ok("an old hub capability refusal preserves real schemas, memberships and sync bookkeeping");

  must(await db.from("types").update({ fields: [...organization.fields, reverseDraft] }).eq("id", organization.id));
  const relationTypes = await fetchTypes(relationWs);
  const localReverse = relationTypes.find(type => type.id === organization.id)!.fields.find(f => f.key === "contacts")!;
  const remoteTypes = await hubRelationTypes();
  const remoteOrganization = remoteTypes.find(type => type.key === "organization")!;
  const remoteReverse = remoteOrganization.fields.find(f => f.key === "contacts")!;
  assert.equal(localReverse.inverse, forward.id);
  assert.equal(remoteReverse.inverse, hubForward.id);
  assert.notEqual(localReverse.inverse, remoteReverse.inverse);
  const shownLocal = materializeInverseLinks(await fetchRecords(relationWs), relationTypes);
  const shownHub = materializeInverseLinks(await hubRelationRecords(), remoteTypes);
  assert.deepEqual(shownLocal.find(r => r.id === org.id)!.fields[localReverse.id], [anna.id]);
  assert.deepEqual(shownHub.find(r => r.id === org.id)!.fields[remoteReverse.id], [anna.id]);
  assert.deepEqual((await hubRelationRecords()).find(r => r.id === anna.id)!.fields[hubForward.id], [org.id]);

  await pushRelation("organization", org.title, { contacts: [ben.id] }, await query(org.id));
  assert.equal((await query(anna.id)).fields[forward.id], undefined);
  assert.deepEqual((await query(ben.id)).fields[forward.id], [org.id]);
  const hubBeforeRefusedSync = await hubRelationRecords();
  const queuedBeforeRefusedSync = (await sync.syncStatus(relationWs))!;
  legacyInverse = true;
  try {
    const refusedRound = await sync.syncWorkspace(relationWs);
    assert.ok(refusedRound.errors.length, "inverse-bearing sync must stop before writing to an old hub");
  } finally { legacyInverse = false; }
  assert.deepEqual(await hubRelationRecords(), hubBeforeRefusedSync);
  assert.deepEqual(await fetchTypes(relationWs), relationTypes);
  const afterRefusedSync = (await sync.syncStatus(relationWs))!;
  assert.deepEqual(afterRefusedSync.pending, queuedBeforeRefusedSync.pending);
  assert.deepEqual(afterRefusedSync.hub, queuedBeforeRefusedSync.hub);
  assert.deepEqual(afterRefusedSync.last_sync, queuedBeforeRefusedSync.last_sync);
  assert.deepEqual((await query(ben.id)).fields[forward.id], [org.id]);
  assert.deepEqual((await sync.syncWorkspace(relationWs)).errors, []);
  const syncedHub = await hubRelationRecords();
  assert.equal(syncedHub.find(r => r.id === anna.id)!.fields[hubForward.id], undefined);
  assert.deepEqual(syncedHub.find(r => r.id === ben.id)!.fields[hubForward.id], [org.id]);
  assert.deepEqual(materializeInverseLinks(syncedHub, remoteTypes).find(r => r.id === org.id)!.fields[remoteReverse.id], [ben.id]);
  assert.equal(Object.hasOwn((await query(org.id)).fields, localReverse.id), false);
  assert.equal(Object.hasOwn(syncedHub.find(r => r.id === org.id)!.fields, remoteReverse.id), false);
  const persistedInverseCount = await local.localAdmin(async tx => (await tx.query<{ n: number }>(
    "select count(*)::int as n from public.history where workspace_id=$1 and fields ? $2", [relationWs, localReverse.id])).rows[0].n);
  const remoteInverseCount = await hub.localAdmin(async tx => (await tx.query<{ n: number }>(
    "select count(*)::int as n from public.history where workspace_id=$1 and fields ? $2", [remoteWorkspace.id, remoteReverse.id])).rows[0].n);
  assert.equal(persistedInverseCount, 0);
  assert.equal(remoteInverseCount, 0);
  assert.deepEqual((await sync.syncStatus(relationWs))!.pending, {});
  ok("shared inverse schemas remap ids, show existing links and sync reverse edits as canonical source values only");

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
  // Switching, refreshing and returning through history must all work as direct
  // requests. No route may depend on the server's last selected workspace.
  for (const [workspace,view] of [[ws,"data/"],[privateWs,""],[privateWs,"data/"],[ws,"data/"],[ws,""]]) {
    const route=`/w/${workspace}/${view}`;
    for (let refresh=0;refresh<2;refresh++) {
      const page=await request(route);
      assert.equal(page.status,200);
      assert.match(page.text,new RegExp(`<title>${view ? "Data View" : "Vault"}</title>`));
      const state=await request(`/w/${workspace}/api/state`);
      assert.equal(state.status,200);assert.equal(state.data().workspace.id,workspace);
    }
  }
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
  assert.equal(system.data().cloudConnectivity.state, "unconfigured");
  assert.equal("job" in system.data().update, false);
  for (const prefix of ["", `/w/${ws}`]) {
    for (const operation of ["check", "install", "arbitrary-command"]) {
      assert.equal((await request(`${prefix}/api/system/update`, "POST", { operation })).status, 404, "browser update endpoints do not exist");
    }
  }
  assert.equal(fs.existsSync(path.join(tmp, "config", "update-job.json")), false);
  const localStatus = (await request(`/w/${privateWs}/api/sync`)).data();
  assert.equal(localStatus.state, "local");
  assert.equal(localStatus.database.state, "ready");
  assert.ok(localStatus.database.checkedAt);
  await sync.enableSync(privateWs, { kind: "surface", url: "http://workflow-hub", token: "test" });
  const syncUrl = `/w/${privateWs}/api/sync`;
  const neverSynced = (await request(syncUrl)).data();
  assert.equal(neverSynced.state, "never-synced");
  assert.equal(neverSynced.lastSync, null);
  assert.equal(neverSynced.syncing, false);
  assert.equal(neverSynced.loopEnabled, false);
  offline = true;
  await sync.syncWorkspace(privateWs);
  const unreachable = (await request(syncUrl)).data();
  assert.equal(unreachable.state, "unreachable");
  assert.equal(unreachable.errorKind, "network");
  assert.ok(unreachable.error, "hub errors retain their reason instead of becoming an internet-offline assertion");
  assert.equal(unreachable.lastSync, null);
  assert.equal(unreachable.database.state, "ready", "hub failure does not make the local database unavailable");
  offline = false; authFailure = true;
  await sync.syncWorkspace(privateWs);
  const unauthorized = (await request(syncUrl)).data();
  assert.equal(unauthorized.state, "error");
  assert.equal(unauthorized.errorKind, "auth");
  assert.equal(unauthorized.offline, false);
  assert.equal(unauthorized.lastSync, null);
  authFailure = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeHubRequest = async () => { entered.resolve(); await release.promise; };
  const round = sync.syncWorkspace(privateWs);
  await entered.promise;
  try {
    const inFlight = (await request(syncUrl)).data();
    assert.equal(inFlight.state, "syncing");
    assert.equal(inFlight.syncing, true);
    assert.equal(inFlight.lastSync, null);
  } finally { release.resolve(); await round; }
  const synced = (await request(syncUrl)).data();
  assert.equal(synced.state, "synced");
  assert.ok(synced.lastSync);
  assert.equal(synced.error, null);
  assert.equal(synced.syncing, false);
  must(await db.rpc("push_record", { p_workspace: privateWs, p_id: null, p_base_rev: null, p_type: "page", p_title: "Waiting", p_fields: {}, p_body: "" }));
  const pending = (await request(syncUrl)).data();
  assert.equal(pending.state, "pending");
  assert.ok(pending.pending > 0);
  await sync.disableSync(privateWs);
  ok("status distinguishes local readiness, never synced, in-flight, pending, hub reachability and auth failures");
  const health=await request("/api/_health","GET",undefined,{"x-surface-token":token}); assert.equal(health.status,200); assert.equal(health.data().pending,0);
  assert.equal(health.data().commit, system.data().runningVersion.commit, "updater health checks observe this process's revision, not a checkout changed underneath it");
  assert.equal(health.data().dataDir, path.join(tmp, "local"), "updater backups locate the running server's database, not the invoking shell's directory");
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
