// Spike step 3 (LOCAL.md §8): the local store at 10,000 records.
// Run from cli/: node --no-warnings ../spikes/pglite/speed.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "surface-speed-"));
process.env.SURFACE_STORE = "local";
process.env.SURFACE_DATA_DIR = dir;
process.env.SURFACE_CONFIG_DIR = path.join(dir, "cfg");

const N = Number(process.env.N ?? 10000);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const { sb } = await import("../../cli/src/client.ts");
const { closeLocal } = await import("../../cli/src/local.ts");
const { fetchRecords, pushRecord } = await import("../../cli/src/db.ts");

let t = performance.now();
const { data: ws, error } = await sb().rpc("create_workspace", { p_name: "speed" });
if (error) throw new Error(error.message);
console.log(`open + migrate + create workspace: ${ms(t)}`);

await sb().from("types").insert({ workspace_id: ws.id, key: "task", name: "Task", folder: "Tasks", fields: [{ id: "f_status", key: "status", kind: "select", options: ["todo", "doing", "done"] }, { id: "f_due", key: "due", kind: "date" }] });

t = performance.now();
const body = "Some notes about this task. ".repeat(20);
for (let i = 0; i < N; i++) {
  const r = await pushRecord({ workspace: ws.id, id: null, baseRev: null, type: "task", title: `Task ${i}`, fields: { status: ["todo", "doing", "done"][i % 3], due: `2026-${String((i % 12) + 1).padStart(2, "0")}-15` }, body });
  if (!r.ok) throw new Error(r.message);
}
const pushTotal = performance.now() - t;
console.log(`${N} push_record: ${(pushTotal / 1000).toFixed(1)} s (${(pushTotal / N).toFixed(2)} ms each)`);

t = performance.now();
const all = await fetchRecords(ws.id);
console.log(`full snapshot (${all.length} records): ${ms(t)}`);

t = performance.now();
const one = await pushRecord({ workspace: ws.id, id: all[5000].id, baseRev: all[5000].rev, type: "task", title: all[5000].title, fields: { status: "done" }, body: "edited" });
console.log(`one edit at ${N} records: ${ms(t)} (${one.ok ? "ok" : one.message})`);

t = performance.now();
const { data: q } = await sb().from("records").select("id,rev").eq("workspace_id", ws.id).is("deleted_at", null);
console.log(`change-poll query (id,rev of all): ${ms(t)} (${(q as unknown[]).length})`);

await closeLocal();
t = performance.now();
const again = await fetchRecords(ws.id); // reopens the database from disk
console.log(`reopen from disk + snapshot: ${ms(t)} (${again.length})`);
await closeLocal();

const size = (p: string): number => fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + size(path.join(p, f)), 0) : fs.statSync(p).size;
console.log(`database on disk: ${(size(path.join(dir, "db")) / 1e6).toFixed(0)} MB`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
