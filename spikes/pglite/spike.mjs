import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
const M = process.env.HOME + "/Developer/Surface/supabase/migrations/";
const t0 = Date.now();
const db = new PGlite("./db");
const UID = "00000000-0000-0000-0000-000000000001";
// auth shim: what Supabase provides that the migrations use
await db.exec(`
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
insert into auth.users values ('${UID}', 'local@this-computer') on conflict do nothing;
create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select jsonb_build_object('sub', auth.uid(), 'email', (select email from auth.users where id = auth.uid())) $f$;
grant usage on schema auth to authenticated;
grant select on auth.users to authenticated;
grant execute on function auth.uid() to authenticated; grant execute on function auth.jwt() to authenticated;
`);
const applied = [];
for (const f of fs.readdirSync(M).sort()) {
  try { await db.exec(fs.readFileSync(M + f, "utf8")); applied.push(f + " ok"); }
  catch (e) { applied.push(f + " FAIL: " + e.message); break; }
}
console.log(applied.join("\n"));
console.log("migrations ms", Date.now() - t0);
// act as the local user, through the same role and RLS as the cloud
await db.exec(`grant usage on schema public to authenticated; grant all on all tables in schema public to authenticated;`);
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${UID}', false);`);
const ws = (await db.query(`select (public.create_workspace('local test')).id as id`)).rows[0].id;
console.log("workspace", ws);
const tdef = { fields: [{ key: "status", kind: "select", options: ["Todo", "Done"] }] };
const ins = await db.query(`insert into public.types (workspace_id, key, name, fields) values ($1,'task','Task',$2) returning key`, [ws, JSON.stringify(tdef.fields)]).catch(e => ({ err: e.message }));
console.log("type", ins.err ?? "ok");
const t1 = Date.now();
for (let i = 0; i < 200; i++) await db.query(`select public.push_record($1, null, null, 'task', $2, $3::jsonb, 'body', null, null)`, [ws, 'Task ' + i, JSON.stringify({ status: i % 2 ? 'Done' : 'Todo' })]);
console.log("200 push_record ms", Date.now() - t1);
const bad = await db.query(`select public.push_record($1, null, null, 'task', 'Bad', '{"status":"Nope"}'::jsonb, '', null, null)`, [ws]).then(() => "ACCEPTED (bad)").catch(e => "rejected: " + e.message.slice(0, 90));
console.log("invalid value", bad);
console.log("count", (await db.query(`select count(*)::int n from public.records where workspace_id=$1`, [ws])).rows[0].n);
const sig = (await db.query(`select pg_get_function_identity_arguments(p.oid) a from pg_proc p where proname='push_record' order by pronargs desc limit 1`)).rows[0].a;
console.log("push_record(", sig, ")");
await db.close();
