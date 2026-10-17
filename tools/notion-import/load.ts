// Load a Notion import plan (tools/notion-import/plan.py output) into a Surface workspace.
//
//   node tools/notion-import/load.ts <plan.json> --workspace "cdb-os" [--create]
//
// Uses the CLI's session and the same write path as `surface push` (push_record), so every
// record is validated by the database. Two passes: create records without links, then set
// links and parents once every record has a Surface id. Idempotent: a map file next to the
// plan remembers which Notion id became which Surface id, so a re-run updates in place.
import fs from "node:fs";
import path from "node:path";
import { sb, requireUser } from "../../cli/src/client.ts";
import { fetchTypes, pushRecord, saveView, fetchViews, type TypeRow } from "../../cli/src/db.ts";

const args = process.argv.slice(2);
const planFile = args[0];
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const wsName = flag("workspace") ?? "cdb-os";
if (!planFile) throw new Error("usage: load.ts <plan.json> --workspace <name> [--create]");

interface PlanField { key: string; kind: string; name: string; target?: string; multiple?: boolean; options?: string[] }
interface PlanType { name: string; folder: string; display: "document" | "fields"; fields: PlanField[] }
interface PlanRecord { nid: string; type: string; title: string; fields: Record<string, unknown>; links: Record<string, string[]>; body: string; parent: string | null }
const plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as { types: Record<string, PlanType>; page_fields: PlanField[]; records: PlanRecord[] };
const mapFile = path.join(path.dirname(planFile), `idmap-${wsName}.json`);
const idmap: Record<string, { id: string; rev: number }> = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : {};
const saveMap = () => fs.writeFileSync(mapFile, JSON.stringify(idmap, null, 1));

await requireUser();

// ---- workspace
const { data: wss, error: wErr } = await sb().from("workspaces").select("id,name");
if (wErr) throw wErr;
let ws = wss.find((w) => w.name === wsName)?.id as string | undefined;
if (!ws) {
  if (!args.includes("--create")) throw new Error(`No workspace "${wsName}" (pass --create)`);
  const { data, error } = await sb().rpc("create_workspace", { p_name: wsName });
  if (error) throw error;
  ws = data.id as string;
  console.log(`created workspace ${wsName} (${ws})`);
}

// ---- types: create, then fields (links need every type's id first)
let types = await fetchTypes(ws);
for (const [key, t] of Object.entries(plan.types)) {
  if (types.some((x) => x.key === key)) continue;
  const { error } = await sb().from("types").insert({ workspace_id: ws, key, name: t.name, folder: t.folder, display: t.display });
  if (error) throw new Error(`type ${key}: ${error.message}`);
}
types = await fetchTypes(ws);
const tid = (key: string) => types.find((x) => x.key === key)!.id;
const fieldDefs = (fs_: PlanField[], existing: TypeRow) =>
  fs_.map((f) => {
    const prev = existing.fields.find((e) => e.key === f.key);
    const out: Record<string, unknown> = { ...(prev ? { id: prev.id } : {}), key: f.key, name: f.name, kind: f.kind };
    if (f.kind === "select" || f.kind === "multi_select") out.options = f.options;
    if (f.kind === "link") {
      out.target = tid(f.target!);
      out.multiple = !!f.multiple;
    }
    return out;
  });
for (const [key, t] of Object.entries(plan.types)) {
  const row = types.find((x) => x.key === key)!;
  const keep = row.fields.filter((e) => !t.fields.some((f) => f.key === e.key));
  const { error } = await sb().from("types").update({ fields: [...fieldDefs(t.fields, row), ...keep], display: t.display, name: t.name, folder: t.folder }).eq("id", row.id);
  if (error) throw new Error(`fields of ${key}: ${error.message}`);
}
{
  const page = types.find((x) => x.key === "page")!;
  const extra = plan.page_fields.filter((f) => !page.fields.some((e) => e.key === f.key));
  if (extra.length) {
    const { error } = await sb().from("types").update({ fields: [...page.fields, ...fieldDefs(extra, page)] }).eq("id", page.id);
    if (error) throw new Error(`page fields: ${error.message}`);
  }
}
types = await fetchTypes(ws);
console.log(`types: ${types.map((t) => `${t.key}(${t.fields.length})`).join(" ")}`);

// ---- pass 1: records without links/parent
const linkKeys = (type: string) => new Set((type === "page" ? plan.page_fields : plan.types[type].fields).filter((f) => f.kind === "link").map((f) => f.key));
const pool = async <T,>(items: T[], n: number, fn: (x: T) => Promise<void>) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
};
let done = 0;
const fail: string[] = [];
await pool(plan.records, 6, async (r) => {
  const t = types.find((x) => x.key === r.type)!;
  const plain = Object.fromEntries(Object.entries(r.fields).filter(([k]) => !linkKeys(r.type).has(k)));
  const prev = idmap[r.nid];
  const res = await pushRecord({ workspace: ws!, id: prev?.id ?? null, baseRev: prev?.rev ?? null, type: t.key, title: r.title, fields: plain, body: r.body, folder: t.folder });
  if (!res.ok) return void fail.push(`${r.type} "${r.title}": ${res.message}`);
  idmap[r.nid] = { id: res.record.id, rev: res.record.rev };
  if (++done % 50 === 0) { console.log(`  records ${done}/${plan.records.length}`); saveMap(); }
});
saveMap();
console.log(`pass 1: ${done} records, ${fail.length} failed`);
for (const f of fail.slice(0, 20)) console.log("  ✗", f);

// ---- pass 2: links and parents
let linked = 0;
const fail2: string[] = [];
await pool(plan.records.filter((r) => Object.keys(r.links).length || r.parent || r.type === "page"), 6, async (r) => {
  const m = idmap[r.nid];
  if (!m) return;
  const t = types.find((x) => x.key === r.type)!;
  const links = Object.fromEntries(
    Object.entries(r.links).map(([k, ids]) => {
      const f = t.fields.find((x) => x.key === k)!;
      const sids = ids.map((n) => idmap[n]?.id).filter(Boolean);
      return [k, f.multiple ? sids : sids[0] ?? null];
    }),
  );
  const plain = Object.fromEntries(Object.entries(r.fields).filter(([k]) => !linkKeys(r.type).has(k)));
  const parent = r.parent ? idmap[r.parent]?.id ?? "" : "";
  const res = await pushRecord({ workspace: ws!, id: m.id, baseRev: m.rev, type: t.key, title: r.title, fields: { ...plain, ...links }, body: r.body, folder: t.folder, parent });
  if (!res.ok) return void fail2.push(`${r.type} "${r.title}": ${res.message}`);
  idmap[r.nid] = { id: res.record.id, rev: res.record.rev };
  linked++;
});
saveMap();
console.log(`pass 2: ${linked} records linked, ${fail2.length} failed`);
for (const f of fail2.slice(0, 20)) console.log("  ✗", f);

// ---- views + sidebar
const views: [string, string, Record<string, unknown>][] = [
  ["all-jobs", "Jobs", { from: "job", sort: "title", where: "project_type!=company", layouts: [{ show: "board", by: "status" }, { show: "table", columns: ["status", "address", "contract_value", "owner"] }] }],
  ["active-jobs", "Active jobs", { from: "job", sort: "title", where: "status~Progress", layouts: [{ show: "table", columns: ["status", "address", "owner"] }] }],
  ["job-tasks", "Tasks", { from: "task", sort: "due", where: "job=this", layouts: [{ show: "board", by: "status" }, { show: "table", columns: ["status", "priority", "due", "contacts"] }] }],
  ["job-selections", "Selections", { from: "selection", sort: "area", where: "job=this", layouts: [{ show: "table", columns: ["area", "product", "finish", "quantity", "supplier", "order_status"] }, { show: "board", by: "order_status" }] }],
  ["job-orders", "Orders", { from: "order", sort: "-quote_date", where: "job=this", layouts: [{ show: "table", columns: ["status", "supplier", "quote_number", "total", "expected_delivery"] }, { show: "board", by: "status" }] }],
  ["job-tile", "Tile takeoff", { from: "tile_surface", sort: "sequence", where: "job=this", layouts: [{ show: "table", columns: ["room", "surface_type", "material_type", "net_sf", "sf_with_waste", "selection"] }] }],
  ["job-pages", "Pages", { from: "page", sort: "title", where: "job=this && parent=", layouts: [{ show: "list" }] }],
  ["all-tasks", "All tasks", { from: "task", sort: "due", where: "status!=Done && status!=Canceled", layouts: [{ show: "board", by: "status" }, { show: "table", columns: ["status", "priority", "due", "job", "category"] }, { show: "calendar", date: "due" }] }],
  ["procurement", "Procurement", { from: "selection", sort: "job", where: "order_status!=Received && order_status!=Cancelled", layouts: [{ show: "board", by: "order_status" }, { show: "table", columns: ["job", "area", "product", "supplier", "order_status"] }] }],
  ["all-orders", "Orders", { from: "order", sort: "-quote_date", layouts: [{ show: "table", columns: ["job", "status", "supplier", "total", "expected_delivery"] }, { show: "board", by: "status" }] }],
  ["contacts", "Contacts", { from: "contact", sort: "title", layouts: [{ show: "table", columns: ["organizations", "role", "email", "phone", "source_list"] }] }],
  ["organizations", "Organizations", { from: "organization", sort: "title", layouts: [{ show: "table", columns: ["category", "specialties", "phone", "email", "website"] }, { show: "board", by: "category" }] }],
  ["referral-leads", "Referral leads", { from: "lead", sort: "title", layouts: [{ show: "board", by: "status" }, { show: "table", columns: ["company", "trade", "chapter", "status", "next_follow_up"] }] }],
  ["notes", "Notes", { from: "page", sort: "title", where: "job=", layouts: [{ show: "list" }] }],
];
const have = await fetchViews(ws);
for (const [key, name, def] of views) {
  const prev = have.find((v) => v.key === key && !v.owner);
  const r = await saveView(ws, key, name, { surface_view: 1, name, ...def }, prev?.rev ?? null);
  if (!r.ok) console.log(`  ✗ view ${key}: ${r.message}`);
}
const sidebar = {
  surface_view: 1,
  name: "Sidebar",
  items: [
    { group: "Jobs", items: [
      { view: "active-jobs", label: "Active", unfold: true, each: [
        { view: "job-pages", label: "Pages", unfold: true },
        { view: "job-tasks", label: "Tasks" },
        { view: "job-selections", label: "Selections" },
        { view: "job-orders", label: "Orders" },
      ] },
      { view: "all-jobs", label: "All jobs" },
    ] },
    { group: "Work", items: [{ view: "all-tasks", label: "Tasks" }, { view: "procurement", label: "Procurement" }, { view: "all-orders", label: "Orders" }] },
    { group: "People", items: [{ view: "contacts", label: "Contacts" }, { view: "organizations", label: "Organizations" }, { view: "referral-leads", label: "Referral leads" }] },
    { group: "Notes", items: [{ view: "notes", label: "Notes", unfold: true }] },
  ],
};
const sb_ = have.find((v) => v.key === "sidebar" && !v.owner);
{
  const r = await saveView(ws, "sidebar", "Sidebar", sidebar, sb_?.rev ?? null);
  if (!r.ok) console.log(`  ✗ sidebar: ${r.message}`);
}
console.log(`views: ${views.length} + sidebar`);
console.log(`workspace id: ${ws}`);
process.exit(fail.length + fail2.length ? 1 : 0);
