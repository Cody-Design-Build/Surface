import { useMemo, useState } from "react";
import { api, ApiError, type AppState, type LayoutDef, type LayoutKind, type ViewDef, type ViewInfo } from "./api.ts";
import { Icon } from "./Icon.tsx";

// Build or edit a saved view with pickers: type, filters, sort, layouts. The result is the same
// definition agents and power users write in .surface/views/<key>.yaml.

interface Cond {
  key: string;
  op: string;
  value: string;
}

const OPS: { op: string; label: string }[] = [
  { op: "=", label: "is" },
  { op: "!=", label: "is not" },
  { op: "~", label: "contains" },
  { op: "<", label: "before / less than" },
  { op: ">", label: "after / more than" },
];

function parse(where: string | undefined): Cond[] {
  if (!where) return [];
  return where
    .split(/\s*&&\s*/)
    .filter(Boolean)
    .map((w) => {
      const m = w.trim().match(/^([a-z_][a-z0-9_]*)\s*(!=|>=|<=|=|>|<|~)\s*(.*)$/);
      return m ? { key: m[1], op: m[2], value: m[3].replace(/^["']|["']$/g, "") } : { key: "title", op: "~", value: w };
    });
}
const join = (cs: Cond[]) => cs.filter((c) => c.key).map((c) => `${c.key}${c.op}${c.value}`).join(" && ");

interface Props {
  app: AppState;
  initial?: ViewInfo;
  /** for a new view: start from this type, personal or shared */
  start?: { from?: string; personal?: boolean; where?: string };
  onClose: () => void;
  onSaved: (v: ViewInfo) => void;
  onDeleted?: () => void;
  /** Adjust a table's draft filters without writing a saved view. */
  onApply?: (definition: ViewDef) => void;
}

export function ViewEditor({ app, initial, start, onClose, onSaved, onDeleted, onApply }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [from, setFrom] = useState(initial?.definition.from ?? start?.from ?? app.types.find((t) => t.key !== "page")?.key ?? "page");
  const [conds, setConds] = useState<Cond[]>(parse(initial?.definition.where ?? start?.where));
  const [sort, setSort] = useState(initial?.definition.sort ?? "");
  const [layouts, setLayouts] = useState<LayoutDef[]>(initial?.definition.layouts?.length ? initial.definition.layouts : [{ show: "table" }]);
  const [personal, setPersonal] = useState(initial?.personal ?? start?.personal ?? app.role === "viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const type = app.types.find((t) => t.key === from);
  const keys = useMemo(
    () => [{ key: "title", name: "Title", kind: "text" }, ...(type?.fields ?? []).map((f) => ({ key: f.key, name: f.name, kind: f.kind })), { key: "parent", name: "Inside (parent)", kind: "link" }, { key: "folder", name: "Folder", kind: "text" }],
    [type],
  );
  const groupable = (type?.fields ?? []).filter((f) => f.kind === "select" || f.kind === "checkbox");
  const dated = (type?.fields ?? []).filter((f) => f.kind === "date");

  const setLayout = (i: number, l: Partial<LayoutDef>) => setLayouts((ls) => ls.map((x, j) => (j === i ? { ...x, ...l } : x)));
  const addLayout = (show: LayoutKind) => {
    const l: LayoutDef = { show };
    if (show === "board") l.by = groupable[0]?.key;
    if (show === "calendar") l.date = dated[0]?.key;
    setLayouts((ls) => [...ls, l]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const definition: ViewDef = {
      from,
      ...(join(conds) ? { where: join(conds) } : {}),
      ...(sort ? { sort } : {}),
      layouts: layouts.map((l) => {
        const out: LayoutDef = { ...l };
        if (l.name) out.name = l.name;
        if (l.show === "table" && l.columns?.length) out.columns = l.columns;
        if (l.show === "board") out.by = l.by;
        if (l.show === "calendar") out.date = l.date;
        return out;
      }),
    };
    try {
      if (onApply) { onApply(definition); return; }
      const n = name.trim() || `${type?.name ?? from}s`;
      const res = initial ? await api.saveView(initial.key, initial.personal, { name: n, definition, baseRev: initial.rev }) : await api.createView({ name: n, definition, personal });
      onSaved(res.view);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const valueInput = (c: Cond, i: number) => {
    const f = type?.fields.find((x) => x.key === c.key);
    const set = (value: string) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, value } : x)));
    if (c.key === "parent" || f?.kind === "link") {
      const targets = app.records.filter((r) => !f?.target || r.type === f.target);
      return (
        <select className="ve-input" value={c.value} onChange={(e) => set(e.target.value)}>
          <option value="">(empty)</option>
          <option value="this">this (the record the view sits under)</option>
          {targets.map((r) => (
            <option key={r.id} value={r.title}>{r.title}</option>
          ))}
        </select>
      );
    }
    if (f?.kind === "select" || f?.kind === "multi_select")
      return (
        <select className="ve-input" value={c.value} onChange={(e) => set(e.target.value)}>
          <option value="">(empty)</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    if (f?.kind === "checkbox")
      return (
        <select className="ve-input" value={c.value} onChange={(e) => set(e.target.value)}>
          <option value="true">checked</option>
          <option value="false">not checked</option>
        </select>
      );
    return <input className="ve-input" type={f?.kind === "date" ? "date" : "text"} value={c.value} placeholder={c.op === "=" ? "(empty)" : ""} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel" role="dialog" aria-label={onApply ? "Filter table" : initial ? "Edit view" : "New view"}>
        <header className="panel-head">
          <h3>{onApply ? "Filter table" : initial ? "Edit view" : "New view"}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="panel-body">
          {!onApply && <label className="ve-row">
            <span className="ve-label">Name</span>
            <input className="ve-input" autoFocus value={name} placeholder={`${type?.name ?? "Record"}s`} onChange={(e) => setName(e.target.value)} />
          </label>}
          <label className="ve-row">
            <span className="ve-label">Shows</span>
            <select className="ve-input" value={from} disabled={!!onApply} onChange={(e) => (setFrom(e.target.value), setConds([]), setSort(""), setLayouts([{ show: "table" }]))}>
              {app.types.map((t) => (
                <option key={t.key} value={t.key}>{t.name} records</option>
              ))}
            </select>
          </label>
          <div className="ve-row ve-top">
            <span className="ve-label">Where</span>
            <div className="ve-stack">
              {conds.map((c, i) => (
                <div className="ve-cond" key={i}>
                  <select className="ve-input" value={c.key} onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, key: e.target.value, value: "" } : x)))}>
                    {keys.map((k) => (
                      <option key={k.key} value={k.key}>{k.name}</option>
                    ))}
                  </select>
                  <select className="ve-input ve-op" value={c.op} onChange={(e) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
                    {OPS.map((o) => (
                      <option key={o.op} value={o.op}>{o.label}</option>
                    ))}
                  </select>
                  {valueInput(c, i)}
                  <button className="icon-btn" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove condition">
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <button className="ve-add" onClick={() => setConds((cs) => [...cs, { key: keys[1]?.key ?? "title", op: "=", value: "" }])}>
                <Icon name="plus" size={13} /> Add a condition
              </button>
            </div>
          </div>
          <label className="ve-row">
            <span className="ve-label">Sort by</span>
            <span className="ve-pair">
              <select className="ve-input" value={sort.replace(/^-/, "")} onChange={(e) => setSort(e.target.value ? (sort.startsWith("-") ? "-" : "") + e.target.value : "")}>
                <option value="">Title</option>
                {keys.filter((k) => k.key !== "title" && k.key !== "parent").map((k) => (
                  <option key={k.key} value={k.key}>{k.name}</option>
                ))}
              </select>
              <select className="ve-input ve-op" value={sort.startsWith("-") ? "desc" : "asc"} onChange={(e) => setSort((s) => (e.target.value === "desc" ? "-" : "") + s.replace(/^-/, ""))}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </span>
          </label>
          <div className="ve-row ve-top" hidden={!!onApply} style={onApply ? { display: "none" } : undefined}>
            <span className="ve-label">Layouts</span>
            <div className="ve-stack">
              {layouts.map((l, i) => (
                <div className="ve-layout" key={i}>
                  <Icon name={l.show === "table" ? "table" : l.show} size={14} />
                  <span className="ve-layout-name">{l.show[0].toUpperCase() + l.show.slice(1)}</span>
                  {l.show === "board" ? (
                    <select className="ve-input" value={l.by ?? ""} onChange={(e) => setLayout(i, { by: e.target.value })}>
                      {!groupable.length ? <option value="">No select or checkbox fields</option> : null}
                      {groupable.map((f) => (
                        <option key={f.key} value={f.key}>Columns by {f.name}</option>
                      ))}
                    </select>
                  ) : l.show === "calendar" ? (
                    <select className="ve-input" value={l.date ?? ""} onChange={(e) => setLayout(i, { date: e.target.value })}>
                      {!dated.length ? <option value="">No date fields</option> : null}
                      {dated.map((f) => (
                        <option key={f.key} value={f.key}>On {f.name}</option>
                      ))}
                    </select>
                  ) : l.show === "table" ? (
                    <div className="ve-cols">
                      {(type?.fields ?? []).map((f) => {
                        const on = l.columns?.length ? l.columns.includes(f.key) : (type?.fields ?? []).slice(0, 6).includes(f);
                        return (
                          <button
                            key={f.key}
                            className={`ve-chip ${on ? "is-on" : ""}`}
                            onClick={() => {
                              const cur = l.columns?.length ? l.columns : (type?.fields ?? []).slice(0, 6).map((x) => x.key);
                              setLayout(i, { columns: on ? cur.filter((k) => k !== f.key) : [...cur, f.key] });
                            }}
                          >
                            {f.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="ve-hint">Titles with key fields</span>
                  )}
                  <button className="icon-btn" disabled={layouts.length === 1} onClick={() => setLayouts((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove layout">
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <div className="ve-addrow">
                {(["table", "board", "list", "calendar"] as LayoutKind[]).map((k) => (
                  <button key={k} className="ve-add" disabled={(k === "board" && !groupable.length) || (k === "calendar" && !dated.length)} onClick={() => addLayout(k)}>
                    <Icon name="plus" size={13} /> {k[0].toUpperCase() + k.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {!initial ? (
            <label className="ve-row">
              <span className="ve-label">Who sees it</span>
              <select className="ve-input" value={personal ? "me" : "ws"} onChange={(e) => setPersonal(e.target.value === "me")}>
                <option value="ws" disabled={app.role === "viewer"}>Everyone in {app.workspace.name}</option>
                <option value="me">Only me</option>
              </select>
            </label>
          ) : null}
          {error ? <div className="ve-error">{error}</div> : null}
        </div>
        <footer className="panel-foot">
          {initial && onDeleted ? (
            <button
              className="btn-danger-soft"
              onClick={async () => {
                if (!confirm(`Remove the view "${initial.name}"? Records aren't affected.`)) return;
                await api.removeView(initial.key, initial.personal);
                onDeleted();
              }}
            >
              Remove view
            </button>
          ) : (
            <span />
          )}
          <span className="panel-actions">
            <button className="btn-soft" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={save}>
              {onApply ? "Apply filters" : initial ? "Save" : "Create view"}
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
