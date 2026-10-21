// Reproduce the catalog damage seen on an upgraded machine without touching its data.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { repairOutboxSequence } from "../src/local-repair.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const populated of [false,true]) {
  const db = new PGlite();
  try {
    await db.exec(`create schema surface_local;
      create table surface_local.outbox (
        sequence bigint generated always as identity, workspace_id text not null,
        record_id text not null, before_row jsonb, after_row jsonb not null,
        generation bigint not null default 1, primary key(workspace_id,record_id));`);
    if (populated) await db.exec(`
      insert into surface_local.outbox(workspace_id,record_id,before_row,after_row,generation)
      values('ws','one','{"title":"before"}','{"title":"pending"}',7),('ws','two',null,'{"title":"new"}',2);
      update surface_local.outbox set sequence=default where record_id='two';`);
    const before = (await db.query("select * from surface_local.outbox order by sequence")).rows;
    const table = (await db.query("select 'surface_local.outbox'::regclass::oid as oid")).rows[0];
    // Mimic the observed missing internal dependency; the sequence itself still exists.
    await db.exec(`delete from pg_depend where classid='pg_class'::regclass
      and objid='surface_local.outbox_sequence_seq'::regclass and deptype='i';`);
    await assert.rejects(db.exec(`insert into surface_local.outbox(workspace_id,record_id,after_row) values('ws','three','{}')`),/no owned sequence found/);
    await repairOutboxSequence(db);
    assert.deepEqual((await db.query("select * from surface_local.outbox order by sequence")).rows,before,"pending payloads, generation and order survive");
    assert.deepEqual((await db.query("select 'surface_local.outbox'::regclass::oid as oid")).rows[0],table,"repair preserves the table");
    await db.exec(`insert into surface_local.outbox(workspace_id,record_id,after_row) values('ws','three','{}')`);
    const sequence = (await db.query<{sequence:number}>("select sequence from surface_local.outbox where record_id='three'")).rows[0].sequence;
    assert(sequence > (populated ? 3 : 0),"new changes follow existing pending changes");
    const identity = (await db.query("select pg_get_serial_sequence('surface_local.outbox','sequence') as name")).rows;
    await repairOutboxSequence(db);
    assert.deepEqual((await db.query("select pg_get_serial_sequence('surface_local.outbox','sequence') as name")).rows,identity,"healthy queues are left alone");
    console.log(`PASS ${populated ? "populated" : "empty"} damaged queue: reproduced failure, repaired identity, preserved pending edits, idempotent retry`);
  } finally { await db.close(); }
}

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"surface-repair-startup-"));
Object.assign(process.env,{SURFACE_CONFIG_DIR:path.join(tmp,"config"),SURFACE_DATA_DIR:path.join(tmp,"data"),SURFACE_LOG_FILE:"off"});
const local=await import("../src/local.ts");
const must=(result:any)=>{if(result.error)throw new Error(result.error.message);return result.data;};
try {
  await local.localInfo();
  const ws=must(await local.exec({kind:"rpc",fn:"create_workspace",args:{p_name:"Repair QA"}})).id;
  must(await local.exec({kind:"insert",table:"types",values:{workspace_id:ws,key:"contact",name:"Contact",fields:[]},filters:[],order:[],returning:false}));
  const save=(id:string|null,rev:number|null,title:string)=>local.exec({kind:"rpc",fn:"push_record",args:{p_workspace:ws,p_id:id,p_base_rev:rev,p_type:"contact",p_title:title,p_fields:{},p_body:""}});
  const record=must(await save(null,null,"Before repair"));
  await local.localAdmin(async tx=>{
    await tx.query("insert into surface_local.sync_workspaces(workspace_id,hub) values($1,'{}')",[ws]);
    await tx.exec("delete from pg_depend where classid='pg_class'::regclass and objid='surface_local.outbox_sequence_seq'::regclass and deptype='i'");
  });
  assert.match((await save(record.id,record.rev,"Pending edit")).error?.message ?? "",/no owned sequence found/);
  await local.closeLocal();await local.localInfo();
  const saved=must(await save(record.id,record.rev,"Saved after startup repair"));
  assert.equal(saved.title,"Saved after startup repair");
  assert.equal(saved.rev,record.rev+1);
  console.log("PASS real local startup repairs the queue; the same record save then succeeds through the normal API");
}finally{await local.closeLocal();fs.rmSync(tmp,{recursive:true,force:true});}
