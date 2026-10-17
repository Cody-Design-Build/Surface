import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AppState, type Invite, type Member, type RecordFull, type Role, type Summary } from "./api.ts";
import { setFields, setParent } from "./edits.ts";
import { Icon, typeIcon } from "./Icon.tsx";

// ------------------------------------------------------------------ shared bits
function Panel({ title, onClose, children, foot, wide }: { title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`panel ${wide ? "panel-wide" : ""}`} role="dialog" aria-label={title}>
        <header className="panel-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="panel-body">{children}</div>
        {foot ? <footer className="panel-foot">{foot}</footer> : null}
      </div>
    </div>
  );
}

function score(t: string, q: string) {
  t = t.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  return 0;
}

// ------------------------------------------------------------------ record picker
export function RecordPicker({ app, title, filter, onPick, onClose }: { app: AppState; title: string; filter?: (r: Summary) => boolean; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return app.records
      .filter((r) => (filter ? filter(r) : true))
      .map((r) => ({ r, s: score(r.title, term) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.r.title.localeCompare(b.r.title))
      .slice(0, 40)
      .map((x) => x.r);
  }, [q, app.records, filter]);
  useEffect(() => setSel(0), [q]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-label={title}>
        <div className="switcher-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={title}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, list.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              if (e.key === "Enter" && list[sel]) onPick(list[sel].id);
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <ul className="switcher-list">
          {list.map((r, i) => (
            <li key={r.id} className={i === sel ? "is-sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => onPick(r.id)}>
              <Icon name={typeIcon(r.type)} size={15} />
              <div className="sw-text">
                <div className="sw-title">{r.title}</div>
              </div>
              <span className="sw-type">{app.types.find((t) => t.key === r.type)?.name ?? r.type}</span>
            </li>
          ))}
          {!list.length ? <li className="sw-empty">No matches</li> : null}
        </ul>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Move to…
// Moving changes data, so it's explicit: pick the target, then pick what "belongs to" means.
export function MoveTo({ app, id, onClose, onDone }: { app: AppState; id: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [target, setTarget] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.record(id).then((r) => setRec(r.record));
  }, [id]);
  const type = app.types.find((t) => t.key === rec?.type);
  if (!rec) return null;
  if (!target)
    return <RecordPicker app={app} title={`Move “${rec.title}” to…`} filter={(r) => r.id !== id} onPick={(tid) => setTarget(app.records.find((r) => r.id === tid) ?? null)} onClose={onClose} />;

  const links = (type?.fields ?? []).filter((f) => f.kind === "link" && (!f.target || f.target === target.type));
  const run = async (what: "nest" | string) => {
    setError(null);
    try {
      if (what === "nest") {
        await setParent(app, rec, target.id);
        onDone(`Moved inside ${target.title}`);
      } else {
        const f = links.find((x) => x.key === what)!;
        const cur = rec.fields[f.key];
        const v = f.multiple ? [...new Set([...(Array.isArray(cur) ? (cur as string[]) : []), target.id])] : target.id;
        await setFields(app, rec, { [f.key]: v }, `Set ${f.name} → ${target.title}`);
        onDone(`Set ${f.name} → ${target.title}`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <Panel title={`Move “${rec.title}”`} onClose={onClose}>
      <p className="panel-lede">
        to <strong>{target.title}</strong>. This changes the record, so it shows up wherever views look for it.
      </p>
      <div className="choice-list">
        {links.map((f) => (
          <button key={f.key} className="choice" onClick={() => run(f.key)}>
            <Icon name="link" size={15} />
            <span>
              <strong>Set {f.name}</strong> to {target.title}
              <small>{f.multiple ? `Adds it to ${rec.title}'s ${f.name.toLowerCase()}` : rec.fields[f.key] ? `Replaces the current ${f.name.toLowerCase()}` : `${rec.title} has no ${f.name.toLowerCase()} yet`}</small>
            </span>
          </button>
        ))}
        <button className="choice" onClick={() => run("nest")}>
          <Icon name="nest" size={15} />
          <span>
            <strong>Put it inside</strong> {target.title}
            <small>A sub-page of {target.title}{rec.parent ? ", no longer inside its current parent" : ""}</small>
          </span>
        </button>
      </div>
      {error ? <div className="ve-error">{error}</div> : null}
      <button className="link-btn" onClick={() => setTarget(null)}>
        ← Pick something else
      </button>
    </Panel>
  );
}

// ------------------------------------------------------------------ Settings
export function Settings({ app, onClose, setDisplay, onToast, openTypes }: { app: AppState; onClose: () => void; setDisplay: (d: "split" | "merged") => void; onToast: (m: string) => void; openTypes: (key?: string) => void }) {
  const isAdmin = app.role === "owner" || app.role === "admin";
  return (
    <Panel title="Settings" onClose={onClose}>
      <h4 className="panel-h">Sidebar</h4>
      <div className="seg">
        <button className={app.sidebar.display === "split" ? "is-on" : ""} onClick={() => setDisplay("split")}>
          <strong>Two sections</strong>
          <small>{app.workspace.name} and Personal, like Notion</small>
        </button>
        <button className={app.sidebar.display === "merged" ? "is-on" : ""} onClick={() => setDisplay("merged")}>
          <strong>One tree</strong>
          <small>No split. Your entries and the workspace's together</small>
        </button>
      </div>
      <p className="panel-note">Only changes how your sidebar looks. Working alone, one tree is the default.</p>

      <h4 className="panel-h">Records</h4>
      <p className="panel-note">How each type opens: as a document with its fields on top, or as fields only (a record like a contact or an invoice line).</p>
      <div className="type-rows">
        {app.types.map((t) => (
          <div className="type-row" key={t.key}>
            <Icon name={typeIcon(t.key)} size={15} />
            <button className="type-row-name link-btn" onClick={() => openTypes(t.key)} title="Edit fields">
              {t.name}
              <small>{t.fields.length} field{t.fields.length === 1 ? "" : "s"}</small>
            </button>
            <select
              className="ve-input"
              value={t.display}
              disabled={!isAdmin}
              title={isAdmin ? undefined : "Owners and admins change types"}
              onChange={async (e) => {
                try {
                  await api.setTypeDisplay(t.key, e.target.value as "document" | "fields");
                  onToast(`${t.name} opens as ${e.target.value === "fields" ? "fields" : "a document"}`);
                } catch (err) {
                  onToast((err as Error).message);
                }
              }}
            >
              <option value="document">Document</option>
              <option value="fields">Fields</option>
            </select>
          </div>
        ))}
      </div>
      <button className="ve-add" onClick={() => openTypes()}>
        <Icon name="sliders" size={13} /> {isAdmin ? "Edit types and fields" : "See types and fields"}
      </button>
    </Panel>
  );
}

// ------------------------------------------------------------------ Share
const ROLES: { role: Role; label: string; hint: string }[] = [
  { role: "admin", label: "Admin", hint: "Everything, including members and types" },
  { role: "member", label: "Member", hint: "Edit records and views" },
  { role: "viewer", label: "Viewer", hint: "Read only" },
];

export function Share({ app, onClose, onToast }: { app: AppState; onClose: () => void; onToast: (m: string) => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: Role | null; current: boolean }[]>([]);
  const [mine, setMine] = useState<Invite[]>([]);
  const [newWs, setNewWs] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const isAdmin = app.role === "owner" || app.role === "admin";
  const load = async () => {
    const [m, w] = await Promise.all([api.members(), api.workspaces()]);
    setMembers(m.members);
    setInvites(m.invites);
    setWorkspaces(w.workspaces);
    setMine(w.invites);
  };
  useEffect(() => {
    load();
  }, []);
  const invite = async () => {
    setError(null);
    try {
      await api.invite(email.trim(), role);
      onToast(`Invited ${email.trim()} as ${role}`);
      setEmail("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Panel title={`Share ${app.workspace.name}`} onClose={onClose} wide>
      {app.mode === "local" && app.members <= 1 ? <p className="panel-note">Only you are in this workspace. Invite someone and they'll see its records, views and workspace sidebar, never your personal sidebar.</p> : null}
      {isAdmin ? (
        <div className="invite-row">
          <input ref={input} className="ve-input" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && invite()} />
          <select className="ve-input ve-op" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r.role} value={r.role}>{r.label}</option>
            ))}
          </select>
          <button className="btn-primary" disabled={!email.trim()} onClick={invite}>Invite</button>
        </div>
      ) : (
        <p className="panel-note">Owners and admins invite people.</p>
      )}
      {error ? <div className="ve-error">{error}</div> : null}
      <ul className="people">
        {members.map((m) => (
          <li key={m.user_id}>
            <span className="avatar">{m.email.slice(0, 1).toUpperCase()}</span>
            <span className="person">
              {m.email}
              {m.user_id === app.user.id ? <small> (you)</small> : null}
            </span>
            {isAdmin && m.role !== "owner" && m.user_id !== app.user.id ? (
              <select
                className="ve-input ve-op"
                value={m.role}
                onChange={async (e) => {
                  try {
                    await api.setRole(m.user_id, e.target.value as Role);
                    load();
                  } catch (err) {
                    onToast((err as Error).message);
                  }
                }}
              >
                {ROLES.map((r) => (
                  <option key={r.role} value={r.role}>{r.label}</option>
                ))}
              </select>
            ) : (
              <span className="role">{m.role[0].toUpperCase() + m.role.slice(1)}</span>
            )}
            {isAdmin && m.role !== "owner" && m.user_id !== app.user.id ? (
              <button
                className="icon-btn"
                title="Remove from workspace"
                onClick={async () => {
                  if (!confirm(`Remove ${m.email} from ${app.workspace.name}?`)) return;
                  await api.removeMember(m.user_id);
                  load();
                }}
              >
                <Icon name="close" size={13} />
              </button>
            ) : (
              <span className="icon-btn-space" />
            )}
          </li>
        ))}
        {invites.map((i) => (
          <li key={i.id} className="is-pending">
            <span className="avatar">{i.email.slice(0, 1).toUpperCase()}</span>
            <span className="person">
              {i.email} <small>invited</small>
            </span>
            <span className="role">{i.role[0].toUpperCase() + i.role.slice(1)}</span>
            {isAdmin ? (
              <button
                className="icon-btn"
                title="Cancel invite"
                onClick={async () => {
                  await api.cancelInvite(i.id);
                  load();
                }}
              >
                <Icon name="close" size={13} />
              </button>
            ) : (
              <span className="icon-btn-space" />
            )}
          </li>
        ))}
      </ul>
      <p className="panel-note">They join when they sign in with that email (`surface workspace join`, or the app once it's hosted).</p>

      <h4 className="panel-h">Your workspaces</h4>
      <ul className="people">
        {workspaces.map((w) => (
          <li key={w.id}>
            <span className="avatar ws-avatar">{w.name.slice(0, 1).toUpperCase()}</span>
            <span className="person">
              {w.name}
              {w.current ? <small> (this one)</small> : null}
            </span>
            <span className="role">{w.role ? w.role[0].toUpperCase() + w.role.slice(1) : ""}</span>
            <span className="icon-btn-space" />
          </li>
        ))}
        {mine.map((i) => (
          <li key={i.id} className="is-pending">
            <span className="avatar ws-avatar">{(i.workspace ?? "?").slice(0, 1).toUpperCase()}</span>
            <span className="person">
              {i.workspace ?? i.workspace_id} <small>invited you as {i.role}</small>
            </span>
            <button
              className="btn-soft"
              onClick={async () => {
                await api.acceptInvite(i.id);
                onToast(`Joined ${i.workspace}. Check it out with \`surface checkout\`.`);
                load();
              }}
            >
              Join
            </button>
            <span className="icon-btn-space" />
          </li>
        ))}
      </ul>
      <div className="invite-row">
        <input className="ve-input" placeholder="New workspace name" value={newWs} onChange={(e) => setNewWs(e.target.value)} />
        <button
          className="btn-soft"
          disabled={!newWs.trim()}
          onClick={async () => {
            try {
              const { workspace } = await api.createWorkspace(newWs.trim());
              onToast(`Created ${workspace.name}. Open it with \`surface checkout ${workspace.id}\` in a new folder.`);
              setNewWs("");
              load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Create workspace
        </button>
      </div>
      <p className="panel-note">Each workspace is separate: its own types, records, views, members and sidebar. The app shows one at a time, the one this folder is checked out from.</p>
    </Panel>
  );
}
