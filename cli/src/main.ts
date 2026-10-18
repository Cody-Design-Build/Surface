#!/usr/bin/env node
// surface: a types engine on Supabase, with Markdown checkouts.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { checkLayout, findCheckout, saveCheckout, type Checkout, type Layout } from "./config.ts";
import { clearSession, dbError, requireUser, sb, UserError } from "./client.ts";
import {
  deleteView, fetchInvites, fetchMembers, fetchRecord, fetchRecords, fetchTypes, fetchViews, fieldByKey, KINDS, myInvites, pushRecord, saveView, typeByKey,
  type FieldDef, type Kind, type RecordRow, type TypeRow,
} from "./db.ts";
import { localEdits, localViewEdits, makeResolver, pull, push, snapshot, status, prepare, type FileResult } from "./checkout.ts";
import { matches, parseWhere, sortRows, type QueryCtx } from "./query.ts";
import { asTreeDef, defaultTree, drawTree, isTreeDef, resolveTree, validateDataView, validateTree, type TreeNode } from "./tree.ts";
import { cliValue, normalize } from "./normalize.ts";
import { basename, parse, render } from "./markdown.ts";
import { writeAgentFiles } from "./skills.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const BOOL = new Set(["force", "dry-run", "new", "json", "multiple", "single", "required", "optional", "deleted", "yes", "help", "all", "paths", "open", "personal", "no-watch", "service", "cloud", "local", "rebuild", "skip-app", "tab", "print"]);

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) out.flags[k] = v;
      else if (BOOL.has(k)) out.flags[k] = true;
      else if (i + 1 < argv.length) out.flags[k] = argv[++i];
      else throw new UserError(`--${k} needs a value`);
    } else if (a === "-h") out.flags.help = true;
    else out._.push(a);
  }
  return out;
}

const flag = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c("32"), red = c("31"), yellow = c("33"), dim = c("2"), bold = c("1");

function table(rows: string[][]) {
  if (!rows.length) return;
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const [n, r] of rows.entries()) {
    const line = r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(w[i]))).join("  ");
    console.log(n === 0 ? bold(line) : line);
  }
}

async function prompt(q: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(q)) out.output.write(s);
      else if (s === "\r\n" || s === "\n") out.output.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(ans);
    }),
  );
}

function requireCheckout(): Checkout {
  const co = findCheckout();
  if (!co) throw new UserError("Not in a Surface checkout. Run `surface init <folder> --workspace <id>` first.");
  return co;
}

/** Workspace from --workspace, the checkout, or the only workspace you're in. */
async function workspaceId(a: Args): Promise<string> {
  const w = flag(a, "workspace");
  if (w) return resolveWorkspace(w);
  const co = findCheckout();
  if (co) return co.config.workspace;
  const { data, error } = await sb().from("workspaces").select("id,name");
  if (error) throw dbError(error);
  if (data.length === 1) return data[0].id;
  throw new UserError(data.length ? "Several workspaces: pass --workspace <id or name>, or run inside a checkout." : "No workspace yet: `surface workspace create <name>`.");
}

async function resolveWorkspace(w: string): Promise<string> {
  const { data, error } = await sb().from("workspaces").select("id,name");
  if (error) throw dbError(error);
  const hit = data.find((x) => x.id === w) ?? data.find((x) => x.name.toLowerCase() === w.toLowerCase());
  if (!hit) throw new UserError(`No workspace "${w}". Yours: ${data.map((x) => `${x.name} (${x.id})`).join(", ") || "none"}`);
  return hit.id;
}

/** Find a record by id, filename or title. */
async function findRecord(ws: string, ref: string, co: Checkout | null, opts: { includeDeleted?: boolean } = {}): Promise<RecordRow> {
  const direct = await fetchRecord(ref);
  if (direct && direct.workspace_id === ws && (opts.includeDeleted || !direct.deleted_at)) return direct;
  if (co) {
    const rel = path.relative(co.root, path.resolve(ref));
    const byPath = Object.entries(co.state.records).find(([, st]) => st.path === rel || basename(st.path).toLowerCase() === basename(ref).toLowerCase());
    if (byPath) {
      const r = await fetchRecord(byPath[0]);
      if (r) return r;
    }
  }
  const all = await fetchRecords(ws, { includeDeleted: opts.includeDeleted });
  const hits = all.filter((r) => r.title.toLowerCase() === ref.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new UserError(`Several records are called "${ref}": ${hits.map((h) => h.id).join(", ")}. Use the id.`);
  throw new UserError(`No record "${ref}".`);
}

/** Field values keyed by key, as the database stores them (ids for links). */
function fieldsByKey(r: RecordRow, t: TypeRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of t.fields) if (r.fields[f.id] !== undefined) out[f.key] = r.fields[f.id];
  return out;
}

async function refreshCheckout(co: Checkout | null) {
  if (!co) return;
  const rep = await pull(co);
  if (rep.skipped.length) console.log(yellow(`Kept ${rep.skipped.length} file(s) with unpushed edits: ${rep.skipped.join(", ")}`));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
type Cmd = (a: Args) => Promise<void>;

const commands: Record<string, Cmd> = {
  async signup(a) {
    const email = flag(a, "email") ?? (await prompt("Email: "));
    const password = process.env.SURFACE_PASSWORD ?? (await prompt("Choose a password: ", true));
    const { data, error } = await sb().auth.signUp({ email, password });
    if (error) throw new UserError(error.message);
    if (!data.session) console.log("Check your email to confirm the account, then run `surface login`.");
    else console.log(green(`Signed up and signed in as ${email}.`));
  },

  async login(a) {
    const email = flag(a, "email") ?? (await prompt("Email: "));
    const password = process.env.SURFACE_PASSWORD ?? (await prompt("Password: ", true));
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw new UserError(error.message);
    console.log(green(`Signed in as ${email}.`));
  },

  async logout() {
    await sb().auth.signOut().catch(() => {});
    clearSession();
    console.log("Signed out.");
  },

  async whoami() {
    const u = await requireUser();
    console.log(u.email);
  },

  async watch() {
    await requireUser();
    const co = requireCheckout();
    const { watchCheckout } = await import("./watch.ts");
    watchCheckout(() => co);
    console.log(`Watching ${co.root}: saves in any editor go to the database. Ctrl-C to stop.`);
    console.log(dim("(surface serve watches too; run one or the other.)"));
    await new Promise(() => {});
  },

  async setup(a) {
    const { setup } = await import("./setup.ts");
    await setup(a.flags);
  },

  async doctor(a) {
    const { doctor } = await import("./setup.ts");
    await doctor(Number(flag(a, "port") ?? 4317));
  },

  async store(a) {
    const { storeKind, setStoreKind } = await import("./client.ts");
    const k = a._[0];
    if (!k) return void console.log(storeKind() === "local" ? "local: this computer's own database, no account" : "cloud: the hosted database (signed in)");
    if (k !== "local" && k !== "cloud") throw new UserError("Usage: surface store [local | cloud]");
    setStoreKind(k);
    console.log(green(`This computer now uses the ${k} store.`) + (k === "cloud" ? " Run `surface login` if you haven't." : ""));
  },

  async workspace(a) {
    await requireUser();
    const sub = a._[0];
    if (sub === "create") {
      const name = a._.slice(1).join(" ");
      if (!name) throw new UserError("Usage: surface workspace create <name>");
      const { data, error } = await sb().rpc("create_workspace", { p_name: name });
      if (error) throw dbError(error);
      console.log(green(`Created workspace "${data.name}" (${data.id}) with the built-in type "page".`));
      return;
    }
    if (sub === "delete" || sub === "rm") {
      const id = await resolveWorkspace(a._.slice(1).join(" "));
      if (!a.flags.yes) throw new UserError("This deletes the workspace and every record in it. Re-run with --yes to confirm.");
      const { data, error } = await sb().from("workspaces").delete().eq("id", id).select("id");
      if (error) throw dbError(error);
      if (!data.length) throw new UserError("Only the workspace owner can delete it.");
      console.log(green(`Deleted workspace ${id}. Checkouts of it are now disconnected; their files are untouched.`));
      return;
    }
    if (sub === "members") {
      const ws = await workspaceId(a);
      const members = await fetchMembers(ws);
      table([["EMAIL", "ROLE", "SINCE"], ...members.map((m) => [m.email, m.role, new Date(m.created_at).toLocaleDateString()])]);
      const invites = await fetchInvites(ws).catch(() => []);
      if (invites.length) {
        console.log(bold("\nInvited, not yet accepted:"));
        table([["EMAIL", "ROLE", "ID"], ...invites.map((i) => [i.email, i.role, i.id])]);
      }
      return;
    }
    if (sub === "invite") {
      const ws = await workspaceId(a);
      const email = a._[1];
      const role = flag(a, "role") ?? "member";
      if (!email) throw new UserError("Usage: surface workspace invite <email> [--role admin|member|viewer]");
      if (!["admin", "member", "viewer"].includes(role)) throw new UserError("--role must be admin, member or viewer.");
      const { error } = await sb().from("invites").upsert({ workspace_id: ws, email: email.toLowerCase(), role }, { onConflict: "workspace_id,email" });
      if (error) throw dbError(error);
      console.log(green(`Invited ${email} as ${role}. They join with \`surface workspace join\` after signing in with that email.`));
      return;
    }
    if (sub === "uninvite") {
      const ws = await workspaceId(a);
      const email = (a._[1] ?? "").toLowerCase();
      const { data, error } = await sb().from("invites").delete().eq("workspace_id", ws).eq("email", email).select("id");
      if (error) throw dbError(error);
      console.log(data.length ? green(`Cancelled the invite for ${email}.`) : `No invite for ${email}.`);
      return;
    }
    if (sub === "role") {
      const ws = await workspaceId(a);
      const [email, role] = [a._[1], a._[2]];
      if (!email || !["owner", "admin", "member", "viewer"].includes(role ?? "")) throw new UserError("Usage: surface workspace role <email> owner|admin|member|viewer");
      const m = (await fetchMembers(ws)).find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!m) throw new UserError(`${email} isn't a member. Invite them with \`surface workspace invite ${email}\`.`);
      const { data, error } = await sb().from("members").update({ role }).eq("workspace_id", ws).eq("user_id", m.user_id).select("role");
      if (error) throw dbError(error);
      if (!data.length) throw new UserError("Only owners and admins can change roles.");
      console.log(green(`${email} is now ${role}.`));
      return;
    }
    if (sub === "remove-member") {
      const ws = await workspaceId(a);
      const email = a._[1] ?? "";
      const m = (await fetchMembers(ws)).find((x) => x.email.toLowerCase() === email.toLowerCase());
      if (!m) throw new UserError(`${email} isn't a member.`);
      const { data, error } = await sb().from("members").delete().eq("workspace_id", ws).eq("user_id", m.user_id).select("user_id");
      if (error) throw dbError(error);
      if (!data.length) throw new UserError("Only owners and admins can remove members.");
      console.log(green(`Removed ${email}. Files already on their computer stay there; they can no longer pull or push.`));
      return;
    }
    if (sub === "join" || sub === "invites") {
      const mine = await myInvites();
      const pick = a._[1];
      if (sub === "invites" || (!pick && mine.length !== 1)) {
        if (!mine.length) return void console.log("No invites for you right now.");
        table([["ID", "WORKSPACE", "ROLE"], ...mine.map((i) => [i.id, i.workspace, i.role])]);
        if (sub === "join") console.log("\nJoin one with `surface workspace join <id>`.");
        return;
      }
      const inv = pick ? mine.find((i) => i.id === pick || i.workspace.toLowerCase() === pick.toLowerCase()) : mine[0];
      if (!inv) throw new UserError(`No invite "${pick}". \`surface workspace invites\` lists yours.`);
      const { error } = await sb().rpc("accept_invite", { p_invite: inv.id });
      if (error) throw dbError(error);
      console.log(green(`Joined "${inv.workspace}" as ${inv.role}. Check it out with \`surface init <folder> --workspace ${inv.workspace_id}\`.`));
      return;
    }
    if (sub === "list" || !sub) {
      const { data, error } = await sb().from("workspaces").select("id,name,members(role,user_id)");
      if (error) throw dbError(error);
      const me = (await requireUser()).id;
      table([["ID", "NAME", "YOUR ROLE"], ...data.map((w) => [w.id, w.name, (w.members as { role: string; user_id: string }[]).find((m) => m.user_id === me)?.role ?? ""])]);
      return;
    }
    throw new UserError("Usage: surface workspace [list | create <name> | delete <name> --yes | members | invite <email> [--role r] | uninvite <email> | role <email> <role> | remove-member <email> | invites | join [id]]");
  },

  async init(a) {
    await requireUser();
    const dir = path.resolve(a._[0] ?? ".");
    let ws: string;
    const create = flag(a, "create");
    if (create) {
      const { data, error } = await sb().rpc("create_workspace", { p_name: create });
      if (error) throw dbError(error);
      ws = data.id;
      console.log(green(`Created workspace "${create}" (${ws}).`));
    } else ws = await workspaceId(a);
    const layout = (flag(a, "layout") ?? "type") as Layout;
    const bad = checkLayout(layout);
    if (bad) throw new UserError(bad);
    if (fs.existsSync(path.join(dir, ".surface", "config.json")) && !a.flags.force) throw new UserError(`${dir} is already a checkout (use --force to re-initialise).`);
    const { data: w } = await sb().from("workspaces").select("name").eq("id", ws).single();
    const co: Checkout = { root: dir, config: { workspace: ws, workspaceName: w?.name, layout, only: list(flag(a, "only")) }, state: { records: {} } };
    fs.mkdirSync(dir, { recursive: true });
    saveCheckout(co);
    const rep = await pull(co);
    console.log(green(`Checked out "${w?.name}" into ${dir} (${layout} layout): ${rep.written.length} file(s).`));
    const existing = (await status(co)).untracked.length;
    if (existing) console.log(`${existing} existing Markdown file(s) aren't in Surface yet. Review with \`surface check\`, import with \`surface push --new\`.`);
  },

  async pull(a) {
    await requireUser();
    const co = requireCheckout();
    const rep = await pull(co, { force: !!a.flags.force });
    for (const p of rep.written) console.log(`${green("wrote")}   ${p}`);
    for (const p of rep.moved) console.log(`${green("moved")}   ${p}`);
    for (const p of rep.removed) console.log(`${yellow("removed")} ${p}`);
    for (const p of rep.skipped) console.log(`${yellow("kept")}    ${p} ${dim("(unpushed edits: push them, or pull --force to discard)")}`);
    if (!rep.written.length && !rep.moved.length && !rep.removed.length) console.log("Up to date.");
  },

  async layout(a) {
    await requireUser();
    const co = requireCheckout();
    const layout = a._[0];
    if (!layout) return void console.log(`This checkout uses the "${co.config.layout}" layout${co.config.only?.length ? ` (only: ${co.config.only.join(", ")})` : ""}.`);
    const bad = checkLayout(layout);
    if (bad) throw new UserError(bad);
    const edited = localEdits(co);
    if (edited.size) throw new UserError(`${edited.size} file(s) have unpushed edits. Push them first (or pull --force to discard).`);
    co.config.layout = layout;
    if (flag(a, "only") !== undefined) co.config.only = list(flag(a, "only"));
    saveCheckout(co);
    const rep = await pull(co);
    console.log(green(`Now using the "${layout}" layout: ${rep.moved.length} file(s) moved.`));
  },

  async push(a) {
    await requireUser();
    const co = requireCheckout();
    const results = await push(co, { files: a._, includeNew: !!a.flags.new, dryRun: !!a.flags["dry-run"], defaultType: flag(a, "type") });
    report(results, !!a.flags["dry-run"]);
    if (results.some((r) => ["rejected", "conflict", "error"].includes(r.status))) process.exitCode = 1;
  },

  async check(a) {
    await requireUser();
    const co = requireCheckout();
    const results = await push(co, { files: a._.length ? a._ : undefined, includeNew: true, dryRun: true, defaultType: flag(a, "type") });
    // Also flag stored values that no longer fit their type (e.g. after an option was removed)
    const snap = await snapshot(co);
    const resolver = makeResolver(co, snap);
    const stale: string[] = [];
    for (const r of snap.records) {
      const t = snap.typeMap.get(r.type_id)!;
      for (const f of t.fields) {
        const v = r.fields[f.id];
        if (v === undefined || v === null) {
          if (f.required) stale.push(`${r.title}: ${f.key} is required but empty`);
          continue;
        }
        const n = normalize(f, f.kind === "link" ? v : v, { link: (id, target) => (snap.byId.has(id) && (!target || snap.byId.get(id)!.type_id === target) ? id : resolver.link(id, target)) });
        if (n.error || JSON.stringify(n.value) !== JSON.stringify(v)) stale.push(`${r.title}: ${f.key} ${n.error ?? "isn't in canonical form"}`);
      }
    }
    report(results, true);
    if (stale.length) {
      console.log(yellow(`\nIn the database, ${stale.length} value(s) don't fit their type:`));
      for (const s of stale) console.log(`  ${s}`);
    }
    if (!results.length && !stale.length) console.log("All good.");
    if (results.some((r) => ["rejected", "conflict", "error"].includes(r.status)) || stale.length) process.exitCode = 1;
  },

  async status() {
    await requireUser();
    const co = requireCheckout();
    const s = await status(co);
    const section = (title: string, items: string[], color: (x: string) => string, hint: string) => {
      if (!items.length) return;
      console.log(bold(title) + dim(`  ${hint}`));
      for (const i of items) console.log(`  ${color(i)}`);
    };
    section("Edited, not pushed:", s.edited, yellow, "surface push");
    section("Not in Surface:", s.untracked, red, "surface push --new");
    section("Missing files:", s.missing, red, "surface pull restores them; surface rm <name> deletes the record");
    section("Changed in Surface since pull:", s.behind, green, "surface pull");
    section("Deleted in Surface:", s.remoteDeleted, dim, "surface pull removes them");
    if (s.remoteNew) console.log(bold(`${s.remoteNew} new record(s) in Surface`) + dim("  surface pull"));
    if (!s.edited.length && !s.untracked.length && !s.missing.length && !s.behind.length && !s.remoteDeleted.length && !s.remoteNew) console.log("Clean: files match Surface.");
  },

  async diff(a) {
    await requireUser();
    const co = requireCheckout();
    const snap = await snapshot(co);
    const resolver = makeResolver(co, snap);
    const files = a._.length ? a._.map((f) => path.relative(co.root, path.resolve(f))) : [...localEdits(co)].map((id) => co.state.records[id].path);
    for (const rel of files) {
      const p = prepare(co, snap, rel, resolver);
      if (!("type" in p) || !p.id) {
        console.log(`${rel}: ${"errors" in p ? p.errors.join("; ") : "not in Surface"}`);
        continue;
      }
      const cur = snap.byId.get(p.id);
      if (!cur) {
        console.log(`${rel}: deleted in Surface`);
        continue;
      }
      console.log(bold(`${rel}`) + dim(`  (file rev ${p.rev ?? "?"}, Surface rev ${cur.rev})`));
      const t = snap.typeMap.get(cur.type_id)!;
      if (cur.title !== p.title) console.log(`  title: ${red(cur.title)} → ${green(p.title)}`);
      if (t.id !== p.type.id) console.log(`  type: ${red(t.key)} → ${green(p.type.key)}`);
      const was = fieldsByKey(cur, t);
      for (const f of p.type.fields) {
        const a1 = JSON.stringify(was[f.key] ?? null), b1 = JSON.stringify(p.fields[f.key] ?? null);
        if (a1 !== b1) console.log(`  ${f.key}: ${red(a1)} → ${green(b1)}`);
      }
      if (cur.body !== p.body) console.log(`  body: changed (${cur.body.length} → ${p.body.length} chars)`);
      for (const e of p.errors) console.log(`  ${red("✗")} ${e}`);
    }
  },

  async types(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const types = await fetchTypes(ws);
    if (a.flags.json) return console.log(JSON.stringify(types, null, 2));
    table([["KEY", "NAME", "FOLDER", "FIELDS"], ...types.map((t) => [t.key + (t.is_builtin ? " *" : ""), t.name, t.folder ?? "", t.fields.map((f) => f.key).join(", ") || "-"])]);
  },

  async type(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const [sub, key] = a._;
    const co = findCheckout();
    const types = await fetchTypes(ws);
    if (sub === "add") {
      if (!key) throw new UserError("Usage: surface type add <key> [--name Name] [--folder Folder] [--icon x]");
      const name = flag(a, "name") ?? key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
      const { error } = await sb().from("types").insert({ workspace_id: ws, key, name, folder: flag(a, "folder") ?? `${name}s`, icon: flag(a, "icon") ?? null });
      if (error) throw dbError(error.code === "23505" ? { message: `A type "${key}" already exists.` } : error);
      console.log(green(`Added type "${key}" (${name}). Add fields with: surface field add ${key} <field> --kind <kind>`));
    } else if (sub === "show") {
      const t = typeByKey(types, key ?? "");
      if (a.flags.json) return console.log(JSON.stringify(t, null, 2));
      console.log(`${bold(t.name)} (${t.key})${t.is_builtin ? dim(" built in") : ""}  folder: ${t.folder ?? "-"}  opens as: ${t.display === "fields" ? "fields" : "document"}`);
      table([["FIELD", "KIND", "DETAILS"], ...t.fields.map((f) => [f.key, f.kind, fieldDetails(f, types)])]);
    } else if (sub === "edit") {
      const t = typeByKey(types, key ?? "");
      const patch: Record<string, unknown> = {};
      if (flag(a, "name")) patch.name = flag(a, "name");
      if (flag(a, "folder")) patch.folder = flag(a, "folder");
      if (flag(a, "icon")) patch.icon = flag(a, "icon");
      if (flag(a, "key")) patch.key = flag(a, "key");
      if (flag(a, "display")) {
        if (!["document", "fields"].includes(flag(a, "display")!)) throw new UserError("--display must be document (body first) or fields (properties first).");
        patch.display = flag(a, "display");
      }
      if (!Object.keys(patch).length) throw new UserError("Nothing to change: use --name, --key, --folder, --icon or --display.");
      const { error } = await sb().from("types").update(patch).eq("id", t.id);
      if (error) throw dbError(error);
      console.log(green(`Updated type "${t.key}".`));
    } else if (sub === "rm" || sub === "remove") {
      const t = typeByKey(types, key ?? "");
      if (t.is_builtin) throw new UserError(`"${t.key}" is built in and can't be removed.`);
      const all = await fetchRecords(ws, { typeIds: [t.id], includeDeleted: true });
      const live = all.filter((r) => !r.deleted_at);
      const into = flag(a, "move-to");
      if (live.length && into) {
        const dest = typeByKey(types, into);
        for (const r of live) {
          const res = await pushRecord({ workspace: ws, id: r.id, baseRev: r.rev, type: dest.key, title: r.title, fields: carryFields(r, t, dest), body: r.body, folder: dest.folder });
          if (!res.ok) throw new UserError(`Couldn't move "${r.title}": ${res.message}`);
        }
        console.log(`Moved ${live.length} record(s) to "${dest.key}" (matching fields kept).`);
      } else if (live.length && !a.flags.force) {
        throw new UserError(`"${t.key}" has ${live.length} record(s). Use --move-to <type> to keep them, or --force to delete them too.`);
      }
      const leftovers = into ? all.filter((r) => r.deleted_at) : all;
      if (leftovers.length) {
        const { error } = await sb().from("records").delete().in("id", leftovers.map((r) => r.id));
        if (error) throw dbError(error);
      }
      const { error } = await sb().from("types").delete().eq("id", t.id);
      if (error) throw dbError(error);
      console.log(green(`Removed type "${t.key}".`));
    } else throw new UserError("Usage: surface type [add|show|edit|rm] <key> …");
    await refreshCheckout(co);
  },

  async field(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const [sub, typeKey, key] = a._;
    const co = findCheckout();
    const types = await fetchTypes(ws);
    const t = typeByKey(types, typeKey ?? "");
    let fields: FieldDef[] = t.fields.map((f) => ({ ...f }));
    if (sub === "add") {
      if (!key) throw new UserError("Usage: surface field add <type> <key> --kind <kind> [--options a,b] [--target type] [--multiple] [--required] [--name Label]");
      const kind = (flag(a, "kind") ?? "text") as Kind;
      if (!KINDS.includes(kind)) throw new UserError(`--kind must be one of: ${KINDS.join(", ")}`);
      const f: Record<string, unknown> = { key, kind };
      if (flag(a, "name")) f.name = flag(a, "name");
      if (kind === "select" || kind === "multi_select") {
        const opts = list(flag(a, "options"));
        if (!opts) throw new UserError(`A ${kind} field needs --options a,b,c`);
        f.options = opts;
      }
      if (kind === "link") {
        const target = flag(a, "target");
        if (target) f.target = target === t.key ? t.id : typeByKey(types, target).id;
        f.multiple = !!a.flags.multiple;
      }
      if (a.flags.required) f.required = true;
      fields.push(f as unknown as FieldDef);
    } else if (sub === "rm" || sub === "remove") {
      const f = fieldByKey(t, key ?? "");
      fields = fields.filter((x) => x.id !== f.id);
    } else if (sub === "edit") {
      const f = fields.find((x) => x.key === key);
      if (!f) throw new UserError(`Type "${t.key}" has no field "${key}".`);
      if (flag(a, "key")) f.key = flag(a, "key")!;
      if (flag(a, "name")) f.name = flag(a, "name")!;
      if (flag(a, "kind")) {
        const kind = flag(a, "kind") as Kind;
        if (!KINDS.includes(kind)) throw new UserError(`--kind must be one of: ${KINDS.join(", ")}`);
        f.kind = kind;
      }
      if (flag(a, "options")) f.options = list(flag(a, "options"));
      for (const o of list(flag(a, "add-option")) ?? []) f.options = [...(f.options ?? []), o].filter((v, i, arr) => arr.indexOf(v) === i);
      for (const o of list(flag(a, "remove-option")) ?? []) f.options = (f.options ?? []).filter((x) => x !== o);
      if (a.flags.required) f.required = true;
      if (a.flags.optional) delete f.required;
      if (a.flags.multiple) f.multiple = true;
      if (a.flags.single) f.multiple = false;
      if (flag(a, "target")) f.target = typeByKey(types, flag(a, "target")!).id;
    } else throw new UserError("Usage: surface field [add|edit|rm] <type> <key> …");
    const { error } = await sb().from("types").update({ fields }).eq("id", t.id);
    if (error) throw dbError(error);
    console.log(green(`${sub === "add" ? "Added" : sub === "edit" ? "Updated" : "Removed"} field "${key}" on "${t.key}".`));
    if (sub === "rm" || sub === "remove") console.log(dim("Its values were removed from every record (they stay in history)."));
    if (sub === "edit" && (a.flags["remove-option"] || flag(a, "kind"))) console.log(dim("Existing values that no longer fit are left as they are; `surface check` lists them."));
    await refreshCheckout(co);
  },

  async new(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const [typeKey, title, ...assigns] = a._;
    if (!typeKey || !title) throw new UserError('Usage: surface new <type> "Title" [field=value …] [--body "text"] [--folder A/B]');
    const types = await fetchTypes(ws);
    const t = typeByKey(types, typeKey);
    const parentRef = flag(a, "parent") ?? assigns.find((x) => x.startsWith("parent="))?.slice(7);
    const { fields, notices } = await applyAssignments(ws, co, t, {}, assigns.filter((x) => !x.startsWith("parent=")));
    const parent = parentRef ? (await findRecord(ws, parentRef, co)).id : null;
    const res = await pushRecord({ workspace: ws, id: null, baseRev: null, type: t.key, title, fields, body: flag(a, "body") ?? "", folder: flag(a, "folder") ?? null, parent });
    if (!res.ok) throw new UserError(res.message);
    for (const n of notices) console.log(dim(`  ${n}`));
    await refreshCheckout(co);
    const p = co?.state.records[res.record.id]?.path;
    console.log(green(`Created ${t.key} "${title}" (${res.record.id})${p ? ` → ${p}` : ""}`));
  },

  async set(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const [ref, ...assigns] = a._;
    if (!ref || !assigns.length) throw new UserError("Usage: surface set <id or name> field=value … (title=…, type=…, body=…, folder=…, parent=… also work)");
    const r = await findRecord(ws, ref, co);
    if (co && localEdits(co).has(r.id)) throw new UserError(`${co.state.records[r.id].path} has unpushed edits. Push them first, or pull --force to discard.`);
    const types = await fetchTypes(ws);
    let t = types.find((x) => x.id === r.type_id)!;
    let title = r.title;
    let body = r.body;
    let folder = r.folder;
    let parent: string | null = null; // null = keep
    const rest: string[] = [];
    for (const s of assigns) {
      const [k, v = ""] = s.split(/=(.*)/s, 2);
      if (k === "title") title = v;
      else if (k === "body") body = v;
      else if (k === "folder") folder = v;
      else if (k === "parent") parent = v.trim() ? (await findRecord(ws, v.replace(/^\[\[|\]\]$/g, ""), co)).id : "";
      else if (k === "type") t = typeByKey(types, v);
      else rest.push(s);
    }
    const prevType = types.find((x) => x.id === r.type_id)!;
    const base = t.id === prevType.id ? fieldsByKey(r, t) : carryFields(r, prevType, t);
    const { fields, notices } = await applyAssignments(ws, co, t, base, rest);
    const res = await pushRecord({ workspace: ws, id: r.id, baseRev: r.rev, type: t.key, title, fields, body, folder, parent });
    if (!res.ok) throw new UserError(res.message);
    for (const n of notices) console.log(dim(`  ${n}`));
    await refreshCheckout(co);
    console.log(res.record.rev === r.rev ? "No change." : green(`Updated "${title}" (rev ${res.record.rev}).`));
  },

  async show(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const r = await findRecord(ws, a._.join(" "), co, { includeDeleted: true });
    const types = await fetchTypes(ws);
    const t = types.find((x) => x.id === r.type_id)!;
    if (a.flags.json) return console.log(JSON.stringify({ ...r, type: t.key, fields: fieldsByKey(r, t) }, null, 2));
    const titles = new Map((await fetchRecords(ws)).map((x) => [x.id, x.title]));
    if (r.deleted_at) console.log(red(`(deleted ${r.deleted_at})`));
    process.stdout.write(render(r, t, (id) => titles.get(id) ?? id));
  },

  async query(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const types = await fetchTypes(ws);
    const t = a._[0] ? typeByKey(types, a._[0]) : null;
    const all = await fetchRecords(ws, { includeDeleted: !!a.flags.deleted });
    let rows = all.filter((r) => !t || r.type_id === t.id);
    if (a.flags.deleted) rows = rows.filter((r) => r.deleted_at);
    const titles = new Map(all.map((r) => [r.id, r.title]));
    const typeOf = new Map(types.map((x) => [x.id, x]));
    let thisId: string | null = null;
    if (flag(a, "this")) thisId = (await findRecord(ws, flag(a, "this")!, findCheckout())).id;
    const ctx: QueryCtx = { typeOf, titles, thisId };
    const conds = parseWhere(flag(a, "where"));
    rows = rows.filter((r) => matches(r, conds, ctx));
    rows = sortRows(rows, flag(a, "sort"), ctx);
    const limit = flag(a, "limit") ? Number(flag(a, "limit")) : undefined;
    if (limit) rows = rows.slice(0, limit);
    if (a.flags.json) {
      return console.log(JSON.stringify(rows.map((r) => {
        const rt = typeOf.get(r.type_id)!;
        return { id: r.id, type: rt.key, title: r.title, rev: r.rev, fields: fieldsByKey(r, rt), updated_at: r.updated_at };
      }), null, 2));
    }
    const cols = t ? t.fields.slice(0, 5) : [];
    const show = (r: RecordRow, f: FieldDef) => {
      const v = r.fields[f.id];
      if (v == null) return "";
      if (f.kind === "link") return (Array.isArray(v) ? v : [v]).map((id) => titles.get(id as string) ?? id).join(", ");
      return Array.isArray(v) ? v.join(", ") : String(v);
    };
    table([["ID", ...(t ? [] : ["TYPE"]), "TITLE", ...cols.map((f) => f.key.toUpperCase())], ...rows.map((r) => [r.id, ...(t ? [] : [typeOf.get(r.type_id)!.key]), r.title, ...cols.map((f) => show(r, f))])]);
    console.log(dim(`${rows.length} record(s)`));
  },

  async rm(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const r = await findRecord(ws, a._.join(" "), co);
    const { error } = await sb().from("records").update({ deleted_at: new Date().toISOString() }).eq("id", r.id);
    if (error) throw dbError(error);
    await refreshCheckout(co);
    console.log(green(`Deleted "${r.title}" (${r.id}). Undo with: surface restore ${r.id}`));
  },

  async restore(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const r = await findRecord(ws, a._.join(" "), co, { includeDeleted: true });
    if (!r.deleted_at) return console.log(`"${r.title}" isn't deleted.`);
    const { error } = await sb().from("records").update({ deleted_at: null }).eq("id", r.id);
    if (error) throw dbError(error);
    await refreshCheckout(co);
    console.log(green(`Restored "${r.title}".`));
  },

  async history(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const r = await findRecord(ws, a._.join(" "), findCheckout(), { includeDeleted: true });
    const { data, error } = await sb().from("history").select("rev,op,title,changed_at,changed_by").eq("record_id", r.id).order("rev");
    if (error) throw dbError(error);
    table([["REV", "OP", "WHEN", "TITLE"], ...data.map((h) => [String(h.rev), h.op, new Date(h.changed_at).toLocaleString(), h.title])]);
  },

  async mv(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const to = flag(a, "to") ?? (a._.length >= 2 ? a._[a._.length - 1] : undefined);
    if (to === undefined) throw new UserError('Usage: surface mv <record> [<record> …] <folder>   or   surface mv --type task --where "project=Steiner" --to <folder>');
    const folder = to.replace(/^\/+|\/+$/g, "");
    let targets: RecordRow[];
    if (flag(a, "where") || flag(a, "type")) {
      const types = await fetchTypes(ws);
      const t = flag(a, "type") ? typeByKey(types, flag(a, "type")!) : null;
      const all = await fetchRecords(ws);
      const ctx: QueryCtx = { typeOf: new Map(types.map((x) => [x.id, x])), titles: new Map(all.map((r) => [r.id, r.title])) };
      const conds = parseWhere(flag(a, "where"));
      targets = all.filter((r) => (!t || r.type_id === t.id) && matches(r, conds, ctx));
    } else {
      const refs = flag(a, "to") ? a._ : a._.slice(0, -1);
      if (!refs.length) throw new UserError("Name at least one record to move.");
      targets = [];
      for (const ref of refs) targets.push(await findRecord(ws, ref, co));
    }
    if (co) {
      const edited = localEdits(co);
      const blocked = targets.filter((r) => edited.has(r.id));
      if (blocked.length) throw new UserError(`Unpushed edits in: ${blocked.map((r) => co.state.records[r.id].path).join(", ")}. Push them first.`);
    }
    const types = await fetchTypes(ws);
    let moved = 0;
    for (const r of targets) {
      if ((r.folder ?? "") === folder) continue;
      const t = types.find((x) => x.id === r.type_id)!;
      const res = await pushRecord({ workspace: ws, id: r.id, baseRev: r.rev, type: t.key, title: r.title, fields: fieldsByKey(r, t), body: r.body, folder });
      if (!res.ok) throw new UserError(`Couldn't move "${r.title}": ${res.message}`);
      moved++;
    }
    await refreshCheckout(co);
    console.log(green(`Moved ${moved} record(s) to "${folder || "(top level)"}".`));
    if (co && co.config.layout !== "folder") console.log(dim(`This checkout uses the "${co.config.layout}" layout, so files don't follow folders here. \`surface layout folder\` switches it.`));
  },

  async folders(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const rows = await fetchRecords(ws);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const f = r.folder ?? "";
      const parts = f ? f.split("/") : [];
      counts.set("", (counts.get("") ?? 0) + (parts.length ? 0 : 1));
      for (let i = 1; i <= parts.length; i++) {
        const k = parts.slice(0, i).join("/");
        counts.set(k, (counts.get(k) ?? 0) + (i === parts.length ? 1 : 0));
      }
    }
    const keys = [...counts.keys()].filter((k) => k).sort();
    if (a.flags.json) return console.log(JSON.stringify(keys.map((k) => ({ folder: k, records: counts.get(k) })), null, 2));
    if (counts.get("")) console.log(`(top level)  ${counts.get("")}`);
    for (const k of keys) console.log(`${"  ".repeat(k.split("/").length - 1)}${k.split("/").pop()}/  ${dim(String(counts.get(k)))}`);
  },

  async folder(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const [sub, from, to] = a._;
    if (sub === "rename" || sub === "mv") {
      if (!from || to === undefined) throw new UserError("Usage: surface folder rename <folder> <new folder>");
      if (co && localEdits(co).size) throw new UserError("Some files have unpushed edits. Push them first.");
      const { data, error } = await sb().rpc("rename_folder", { p_workspace: ws, p_old: from, p_new: to });
      if (error) throw dbError(error);
      await refreshCheckout(co);
      console.log(green(`Moved ${data} record(s) from "${from}" to "${to || "(top level)"}".`));
      return;
    }
    throw new UserError("Usage: surface folder rename <folder> <new folder>   (list folders with `surface folders`)");
  },

  async tree(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const sub = a._[0];
    const personal = !!a.flags.personal;
    const types = await fetchTypes(ws);
    const views = await fetchViews(ws);
    const key = flag(a, "view") ?? "sidebar";
    const skey = personal ? `personal/${key}` : key;
    const existing = views.find((v) => v.key === key && !!v.owner === personal);
    const dataViews = views.filter((v) => !isTreeDef(v.key, v.definition));
    if (sub === "init") {
      if (existing && !a.flags.force) throw new UserError(`That sidebar already exists. Edit .surface/views/${skey}.yaml and push, or use --force to reset it.`);
      const def = personal ? { display: "split", items: [] } : defaultTree(types);
      const res = await saveView(ws, key, personal ? "My sidebar" : key === "sidebar" ? "Sidebar" : key, def as unknown as Record<string, unknown>, existing?.rev ?? null, personal);
      if (!res.ok) throw new UserError(res.message);
      await refreshCheckout(co);
      console.log(green(`Created ${personal ? "your personal sidebar" : `the "${key}" tree`}${co ? ` (.surface/views/${skey}.yaml)` : ""}. Edit it, then \`surface push\`.`));
      return;
    }
    if (sub === "check") {
      if (!co) throw new UserError("Run inside a checkout to check .surface/views files.");
      const file = path.join(co.root, ".surface", "views", `${skey}.yaml`);
      const YAML = (await import("yaml")).default;
      const { surface_view: _v, name: _n, ...def } = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
      const errors = validateTree(def, types, dataViews);
      if (errors.length) {
        for (const e of errors) console.log(red(`✗ ${e}`));
        process.exitCode = 1;
      } else console.log("The tree is valid.");
      return;
    }
    if (sub) throw new UserError("Usage: surface tree [init [--force] | check] [--personal] [--view key] [--json] [--paths]");
    if (!existing) throw new UserError(personal ? "No personal sidebar yet. Create one with `surface tree init --personal`." : `No "${key}" tree yet. Create a starting one with \`surface tree init\`.`);
    const records = await fetchRecords(ws);
    const nodes = resolveTree(asTreeDef(existing.definition), records, types, dataViews);
    if (a.flags.json) return console.log(JSON.stringify(nodes, null, 2));
    const pathOf = a.flags.paths && co ? (id: string) => co.state.records[id]?.path : undefined;
    console.log(drawTree(nodes, pathOf));
    if (co && localViewEdits(co).includes(skey)) console.log(yellow(`\n.surface/views/${skey}.yaml has unpushed edits (shown above is the pushed version).`));
  },

  async views(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const views = await fetchViews(ws);
    if (!views.length) return console.log("No saved views yet. `surface view new` makes a table or board; `surface tree init` the sidebar.");
    const kind = (v: (typeof views)[number]) => (isTreeDef(v.key, v.definition) ? "sidebar" : ((v.definition.layouts as { show: string }[] | undefined) ?? [{ show: "table" }]).map((l) => l.show).join(", "));
    table([["KEY", "NAME", "SHOWS", "WHOSE", "REV"], ...views.map((v) => [v.key, v.name, kind(v), v.owner ? "yours" : "workspace", String(v.rev)])]);
  },

  async view(a) {
    await requireUser();
    const ws = await workspaceId(a);
    const co = findCheckout();
    const sub = a._[0];
    const types = await fetchTypes(ws);
    const views = await fetchViews(ws);
    const personal = !!a.flags.personal;
    if (sub === "new") {
      const name = a._.slice(1).join(" ");
      const from = flag(a, "from");
      if (!name || !from) throw new UserError('Usage: surface view new "Name" --from <type> [--where "…"] [--sort key] [--show table,board] [--by field] [--date field] [--columns a,b] [--key k] [--personal]');
      const key = flag(a, "key") ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (views.some((v) => v.key === key && !!v.owner === personal)) throw new UserError(`A view "${key}" already exists. Pick another --key, or edit .surface/views/${personal ? "personal/" : ""}${key}.yaml.`);
      const shows = list(flag(a, "show")) ?? ["table"];
      // board:status and calendar:due name the field inline; --by/--date work too
      const layouts = shows.map((raw) => {
        const [show, inline] = raw.split(":");
        return {
        show,
        ...(show === "table" && flag(a, "columns") ? { columns: list(flag(a, "columns")) } : {}),
        ...(show === "board" ? { by: inline || flag(a, "by") } : {}),
        ...(show === "calendar" ? { date: inline || flag(a, "date") } : {}),
        };
      });
      const def: Record<string, unknown> = { from, ...(flag(a, "where") ? { where: flag(a, "where") } : {}), ...(flag(a, "sort") ? { sort: flag(a, "sort") } : {}), layouts };
      const errors = validateDataView(def, types);
      if (errors.length) throw new UserError(errors.join("\n"));
      const res = await saveView(ws, key, name, def, null, personal);
      if (!res.ok) throw new UserError(res.message);
      await refreshCheckout(co);
      console.log(green(`Created the view "${name}" (${key}). Add it to a sidebar with \`- view: ${key}\`.`));
      return;
    }
    if (sub === "rm" || sub === "remove") {
      const key = a._[1];
      if (!key || key === "sidebar") throw new UserError("Usage: surface view rm <key> [--personal]   (the sidebar itself can't be removed)");
      await deleteView(ws, key, personal);
      await refreshCheckout(co);
      console.log(green(`Removed the view "${key}". Sidebar entries pointing to it now show as not found.`));
      return;
    }
    if (sub === "show" || (sub && !["new", "rm"].includes(sub))) {
      const key = sub === "show" ? a._[1] : sub;
      const v = views.find((x) => x.key === key && (personal ? !!x.owner : true));
      if (!v) throw new UserError(`No view "${key}". \`surface views\` lists them.`);
      if (isTreeDef(v.key, v.definition)) throw new UserError(`"${key}" is a sidebar: use \`surface tree${v.owner ? " --personal" : ""}\`.`);
      const d = v.definition as { from: string; where?: string; sort?: string };
      const records = await fetchRecords(ws);
      const t = typeByKey(types, d.from);
      const typeOf = new Map(types.map((x) => [x.id, x]));
      const titles = new Map(records.map((r) => [r.id, r.title]));
      const thisRef = flag(a, "this");
      const thisId = thisRef ? (await findRecord(ws, thisRef, co)).id : null;
      const ctx: QueryCtx = { typeOf, titles, thisId };
      const rows = sortRows(records.filter((r) => r.type_id === t.id && matches(r, parseWhere(d.where), ctx)), d.sort ?? "title", ctx);
      if (a.flags.json) return console.log(JSON.stringify(rows.map((r) => ({ id: r.id, title: r.title })), null, 2));
      console.log(bold(v.name) + dim(`  ${rows.length} record(s)`));
      for (const r of rows) console.log(`  ${r.title}`);
      return;
    }
    throw new UserError('Usage: surface view new "Name" --from <type> … | view show <key> [--this record] | view rm <key>   (list with `surface views`)');
  },

  async serve(a) {
    await requireUser();
    const co = requireCheckout();
    const { serve } = await import("./serve.ts");
    const port = Number(flag(a, "port") ?? 4317);
    const { link } = await serve(co, { port, watch: !a.flags["no-watch"] });
    if (a.flags.open) (await import("./open.ts")).openWindow(link, { tab: !!a.flags.tab });
    await new Promise(() => {}); // run until stopped
  },

  async data(a) {
    await requireUser();
    const co = requireCheckout();
    const { serve } = await import("./serve.ts");
    const port = Number(flag(a, "port") ?? 4318);
    const { link } = await serve(co, { port, watch: !a.flags["no-watch"], surface: "data" });
    if (a.flags.open) (await import("./open.ts")).openWindow(link, { tab: !!a.flags.tab });
    await new Promise(() => {});
  },

  async open(a) {
    await requireUser();
    const co = requireCheckout();
    const ref = a._.join(" ").trim();
    let target: { view?: string; record?: string } | null = null;
    if (ref) {
      const views = await fetchViews(co.config.workspace);
      const v = views.find((x) => x.key === ref) ?? views.find((x) => x.name.toLowerCase() === ref.toLowerCase());
      if (v && !isTreeDef(v.key, v.definition)) target = { view: v.key };
      else target = { record: (await findRecord(co.config.workspace, ref, co)).id };
    }
    const { openSurface } = await import("./open.ts");
    const r = await openSurface(co, target, { port: Number(flag(a, "port") ?? 4317), tab: !!a.flags.tab, print: !!a.flags.print });
    if (r.started) console.log(dim(`Started surface serve in the background (log: ~/.config/surface-cli/serve.log).`));
    console.log(r.how === "printed" ? r.url : `Opened in ${r.how}.`);
  },

  async skills() {
    await requireUser();
    const co = requireCheckout();
    writeAgentFiles(co, await fetchTypes(co.config.workspace));
    console.log(green("Wrote AGENTS.md, .agents/skills/surface/SKILL.md, .claude/skills/surface/SKILL.md and .surface/types/."));
  },
};

function fieldDetails(f: FieldDef, types: TypeRow[]) {
  const bits: string[] = [];
  if (f.options) bits.push(f.options.join(", "));
  if (f.kind === "link") bits.push(`→ ${types.find((t) => t.id === f.target)?.key ?? "any"}${f.multiple ? " (several)" : ""}`);
  if (f.required) bits.push("required");
  if (f.name.toLowerCase() !== f.key.replace(/_/g, " ")) bits.push(`label "${f.name}"`);
  return bits.join("; ");
}

/** When a record changes type, keep values whose field key and kind match. */
function carryFields(r: RecordRow, from: TypeRow, to: TypeRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of from.fields) {
    const g = to.fields.find((x) => x.key === f.key && x.kind === f.kind);
    if (g && r.fields[f.id] !== undefined) out[g.key] = r.fields[f.id];
  }
  return out;
}

async function applyAssignments(ws: string, co: Checkout | null, t: TypeRow, base: Record<string, unknown>, assigns: string[]) {
  const fields = { ...base };
  const notices: string[] = [];
  let resolver: { link(label: string, target?: string): string | null } | null = null;
  for (const s of assigns) {
    const m = s.match(/^([^=]+)=(.*)$/s);
    if (!m) throw new UserError(`Expected field=value, got "${s}"`);
    const def = fieldByKey(t, m[1].trim());
    if (def.kind === "link" && !resolver) {
      const records = await fetchRecords(ws);
      const byId = new Map(records.map((r) => [r.id, r]));
      resolver = co
        ? makeResolver(co, { types: [], typeMap: new Map(), records, all: records, byId })
        : { link: (label, target) => {
            if (byId.has(label)) return !target || byId.get(label)!.type_id === target ? label : null;
            const hits = records.filter((r) => r.title.toLowerCase() === label.toLowerCase() && (!target || r.type_id === target));
            return hits.length === 1 ? hits[0].id : null;
          } };
    }
    const n = normalize(def, cliValue(def, m[2]), resolver ?? { link: () => null });
    if (n.error) throw new UserError(`${def.key}: ${n.error}`);
    if (n.notice) notices.push(`${def.key}: ${n.notice}`);
    fields[def.key] = n.value;
  }
  return { fields, notices };
}

function report(results: FileResult[], dry: boolean) {
  const label: Record<FileResult["status"], string> = {
    unchanged: dim("ok"),
    pushed: green(dry ? "would push" : "pushed"),
    created: green(dry ? "would add" : "added"),
    rejected: red("rejected"),
    conflict: red("conflict"),
    untracked: yellow("new"),
    error: red("error"),
  };
  for (const r of results) {
    if (r.status === "unchanged" && !r.notices.length) continue;
    console.log(`${label[r.status].padEnd(tty ? 19 : 10)} ${r.path}`);
    for (const n of r.notices) console.log(dim(`    ~ ${n}`));
    for (const e of r.errors) console.log(red(`    ✗ ${e}`));
  }
  const count = (s: FileResult["status"]) => results.filter((r) => r.status === s).length;
  const parts = [
    count("pushed") && `${count("pushed")} ${dry ? "to push" : "pushed"}`,
    count("created") && `${count("created")} ${dry ? "to add" : "added"}`,
    count("rejected") && `${count("rejected")} rejected`,
    count("conflict") && `${count("conflict")} conflict(s)`,
    count("untracked") && `${count("untracked")} new (use --new to add)`,
    count("error") && `${count("error")} error(s)`,
  ].filter(Boolean);
  console.log(parts.length ? parts.join(", ") : "Nothing to push.");
}

const HELP = `surface: typed records and Markdown files, in your own database or a shared one

Install
  setup [--dir ~/Surface] [--name <workspace>] [--service] [--local | --cloud] [--rebuild]
                                      install and configure everything on this computer:
                                      packages, web UI, PATH, database, a first workspace
  doctor                              check the installation
  store [local | cloud]               where this computer's data lives (default: local, no account)

Account (cloud store only)
  signup | login | logout | whoami
  workspace [list | create <name> | delete <name> --yes]   (sharing: see below)

Checkout
  init <folder> [--workspace <id|name> | --create <name>] [--layout <layout>] [--only type,type]
  layout [<layout>] [--only type,type]  show or change this checkout's layout (files move)
      layouts: type (a folder per type, default) | folder (your folders) | flat
               link:<field> (under the linked record, e.g. link:project; link:parent nests pages)
  pull [--force]                      database → files (keeps files with unpushed edits)
  push [files] [--new] [--dry-run]    files → database: normalize, validate, check rev
                                      (also sends edited .surface/views/*.yaml)
  open [view|record] [--tab] [--print] show it in its own browser window (starts serve if needed)
  watch                               push on save: send edits from any editor automatically
                                      (surface serve does this too; --no-watch turns it off)
  status | diff [files] | check       what's changed, and whether it's valid
  skills                              regenerate AGENTS.md and agent skills

Types
  types                               list types
  type add <key> [--name N] [--folder F]
  type show <key> | type edit <key> [--name --key --folder --icon --display document|fields]
  type rm <key> [--move-to <type> | --force]
  field add <type> <key> --kind <kind> [--options a,b] [--target <type>] [--multiple] [--required] [--name Label]
  field edit <type> <key> [--key --name --kind --options --add-option --remove-option --required --optional --multiple --single --target]
  field rm <type> <key>
  kinds: ${KINDS.join(", ")}

Records
  new <type> "Title" [field=value …] [--body text] [--folder A/B] [--parent <record>]
  set <id|name> field=value …         (also title=, type=, body=, folder=, parent= ; parent= clears)
  show <id|name> [--json]
  query [type] [--where "status=doing && due<2026-11-01"] [--sort -due] [--limit n] [--this <record>] [--json]
      where keys: any field, title, type, folder, parent; "parent=" means no parent; "project=this" uses --this
  rm <id|name> | restore <id|name> | history <id|name>

Folders (where files live, in the folder layout)
  folders                             list folders with record counts
  mv <record> [<record> …] <folder>   move records (or: mv --type task --where "…" --to <folder>)
  folder rename <folder> <new>        move everything under a folder

App
  serve [--port 4317] [--open]        run the Surface app for this checkout on http://127.0.0.1
  data [--port 4318] [--open]         run the standalone editable data surface

Sidebars (organization only: arranging never changes records)
  tree [--personal] [--paths] [--json] show the workspace sidebar, or your own
  tree init [--personal] [--force]    create one (workspace: a group per type; personal: empty)
  tree check [--personal]             validate .surface/views/[personal/]sidebar.yaml before pushing
  Edit the YAML, then \`surface push\`. Items: group / record / view (+ unfold, each, label) / query.

Views (tables, boards, lists, calendars over records)
  views                               list saved views
  view new "Name" --from <type> [--where "…"] [--sort key] [--show table,board,list,calendar]
           [--by <select field>] [--date <date field>] [--columns a,b] [--key k] [--personal]
  view show <key> [--this <record>]   list what a view matches
  view rm <key> [--personal]

Sharing
  workspace members                   who's in this workspace, and pending invites
  workspace invite <email> [--role admin|member|viewer]
  workspace uninvite <email> | role <email> <role> | remove-member <email>
  workspace invites | join [id]       invites for you; accept one

Options: --workspace <id|name> works with any command outside a checkout.
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return void console.log(HELP);
  const fn = commands[cmd];
  if (!fn) throw new UserError(`Unknown command "${cmd}". Run \`surface help\`.`);
  const args = parseArgs(rest);
  if (args.flags.help) return void console.log(HELP);
  await fn(args);
}

main()
  .catch((e) => {
    if (e instanceof UserError) console.error(red(`✗ ${e.message}`));
    else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    sb().auth.stopAutoRefresh().catch(() => {});
    import("./local.ts").then((l) => l.closeLocal()).finally(() => setTimeout(() => process.exit(), 10).unref());
  });
