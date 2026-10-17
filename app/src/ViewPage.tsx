import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AppState, type FieldDef, type LayoutDef, type RecordFull, type Summary, type TypeInfo, type ViewInfo } from "./api.ts";
import { defaultsFrom, setFields } from "./edits.ts";
import { Icon, typeIcon } from "./Icon.tsx";
import { Pill, Value } from "./Properties.tsx";
import { ViewEditor } from "./ViewEditor.tsx";

interface Props {
  app: AppState;
  viewKey: string;
  personal: boolean;
  thisId: string | null;
  label?: string;
  remoteTick: number;
  open: (id: string) => void;
  onToast: (msg: string) => void;
  onDeleted: () => void;
  /** shown inside a page (```surface block): compact header, link to open full-page */
  embedded?: boolean;
  onExpand?: () => void;
}

const LAYOUT_NAMES: Record<string, string> = { table: "Table", board: "Board", list: "List", calendar: "Calendar" };
const LAYOUT_ICONS: Record<string, string> = { table: "table", board: "board", list: "list", calendar: "calendar" };

export function ViewPage({ app, viewKey, personal, thisId, label, remoteTick, open, onToast, onDeleted, embedded, onExpand }: Props) {
  const [data, setData] = useState<{ view: ViewInfo; records: RecordFull[]; problem: string | null; this: Summary | null } | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const tabKey = `surface.layout.${embedded ? "e:" : ""}${personal ? "p:" : ""}${viewKey}`;
  const [tab, setTab] = useState(() => Number(localStorage.getItem(tabKey) ?? 0));
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.view(viewKey, { personal, this: thisId }));
      setMissing(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    }
  }, [viewKey, personal, thisId]);
  useEffect(() => {
    setData(null);
    setSort(null);
    setQ("");
    setTab(Number(localStorage.getItem(tabKey) ?? 0));
    load();
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (remoteTick) load();
  }, [remoteTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => localStorage.setItem(tabKey, String(tab)), [tab, tabKey]);

  const type = useMemo(() => app.types.find((t) => t.key === data?.view.definition.from), [app.types, data]);
  const layouts: LayoutDef[] = data?.view.definition.layouts?.length ? data.view.definition.layouts : [{ show: "table" }];
  const layout = layouts[Math.min(tab, layouts.length - 1)];

  const rows = useMemo(() => {
    let r = data?.records ?? [];
    const term = q.trim().toLowerCase();
    if (term) r = r.filter((x) => x.title.toLowerCase().includes(term));
    if (sort) {
      const titleOf = (id: string) => app.records.find((x) => x.id === id)?.title ?? id;
      const val = (x: RecordFull) => {
        if (sort.key === "title") return x.title.toLowerCase();
        const v = x.fields[sort.key];
        if (v == null || v === "") return null;
        const f = type?.fields.find((ff) => ff.key === sort.key);
        if (f?.kind === "link") return (Array.isArray(v) ? v : [v]).map((id) => titleOf(String(id))).join(", ").toLowerCase();
        if (f?.kind === "select") return (f.options ?? []).indexOf(String(v));
        if (typeof v === "number") return v;
        return Array.isArray(v) ? v.join(", ").toLowerCase() : String(v).toLowerCase();
      };
      r = [...r].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (x < y ? -1 : 1) * (sort.desc ? -1 : 1);
      });
    }
    return r;
  }, [data, q, sort, type, app.records]);

  const update = async (rec: RecordFull, patch: Record<string, unknown>, label?: string) => {
    // optimistic
    setData((d) => (d ? { ...d, records: d.records.map((r) => (r.id === rec.id ? { ...r, fields: { ...r.fields, ...patch } } : r)) } : d));
    try {
      const saved = await setFields(app, rec, patch, label);
      setData((d) => (d ? { ...d, records: d.records.map((r) => (r.id === rec.id ? saved : r)) } : d));
      onToast(label ?? "");
    } catch (e) {
      onToast(`Couldn't save: ${(e as Error).message}`);
      load();
    }
  };

  const addRow = async (extra: Record<string, unknown> = {}) => {
    if (!type || !data) return;
    const fields = { ...defaultsFrom(data.view.definition.where, type, thisId), ...extra };
    try {
      const { record } = await api.create({ type: type.key, title: "Untitled", fields });
      await load();
      open(record.id);
    } catch (e) {
      onToast(`Couldn't create: ${(e as Error).message}`);
    }
  };

  if (missing) return <div className="page-empty">This view was removed. Its sidebar entry shows as not found.</div>;
  if (!data) return <div className="page-loading" />;
  const { view } = data;

  const bar = (
    <div className="view-bar">
      <div className="view-tabs" role="tablist">
        {embedded ? (
          <button className="embed-title" onClick={onExpand} title="Open as a page">
            {view.name}
            <Icon name="external" size={12} />
          </button>
        ) : null}
        {layouts.length > 1 || !embedded
          ? layouts.map((l, i) => (
              <button key={i} role="tab" aria-selected={i === tab} className={`view-tab ${i === Math.min(tab, layouts.length - 1) ? "is-on" : ""}`} onClick={() => setTab(i)}>
                <Icon name={LAYOUT_ICONS[l.show] ?? "table"} size={14} />
                {l.name ?? LAYOUT_NAMES[l.show]}
              </button>
            ))
          : null}
      </div>
      <div className="view-tools">
        {!embedded ? (
          <div className="view-search">
            <Icon name="search" size={13} />
            <input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        ) : null}
        <span className="view-count">
          {rows.length} {type?.name.toLowerCase() ?? "record"}
          {rows.length === 1 ? "" : "s"}
        </span>
        {embedded ? (
          <button className="icon-btn" title="Edit view" onClick={() => setEditing(true)} aria-label="Edit view">
            <Icon name="sliders" size={14} />
          </button>
        ) : null}
        {app.role !== "viewer" && type ? (
          <button className="btn-soft" onClick={() => addRow()}>
            <Icon name="plus" size={13} /> New
          </button>
        ) : null}
      </div>
    </div>
  );
  const body = (
    <>
      {data.problem ? <div className="banner">{data.problem}</div> : null}
      {!type ? null : layout.show === "board" ? (
        <Board app={app} type={type} layout={layout} rows={rows} open={open} update={update} addRow={addRow} readOnly={app.role === "viewer"} />
      ) : layout.show === "list" ? (
        <ListLayout rows={rows} open={open} type={type} app={app} />
      ) : layout.show === "calendar" ? (
        <Calendar type={type} layout={layout} rows={rows} open={open} update={update} readOnly={app.role === "viewer"} />
      ) : (
        <Table app={app} type={type} layout={layout} rows={rows} open={open} update={update} sort={sort} setSort={setSort} addRow={addRow} readOnly={app.role === "viewer"} />
      )}
      {!rows.length && !data.problem ? <div className="page-empty small">{q ? "No matches." : "Nothing here yet."}</div> : null}
    </>
  );
  const editor = editing ? (
    <ViewEditor
      app={app}
      initial={view}
      onClose={() => setEditing(false)}
      onSaved={() => {
        setEditing(false);
        load();
      }}
      onDeleted={onDeleted}
    />
  ) : null;
  if (embedded)
    return (
      <div className="view-embed">
        {bar}
        {body}
        {editor}
      </div>
    );

  return (
    <article className="page view-page">
      <header className="page-head">
        <div className="crumbs">
          {data.this ? (
            <span className="crumb">
              <button onClick={() => open(data.this!.id)}>{data.this.title}</button>
              <span className="crumb-sep">/</span>
            </span>
          ) : null}
        </div>
        <div className="page-actions">
          <button className="icon-btn" title="Edit view" onClick={() => setEditing(true)} aria-label="Edit view">
            <Icon name="sliders" size={17} />
          </button>
        </div>
      </header>
      <div className="page-body wide">
        <h1 className="group-title">{label ?? view.name}</h1>
        {bar}
        {body}
      </div>
      {editor}
    </article>
  );
}

// ------------------------------------------------------------------ cells
function titleOf(app: AppState, id: string) {
  return app.records.find((r) => r.id === id)?.title ?? id;
}

export function CellView({ app, f, v }: { app: AppState; f: FieldDef; v: unknown }) {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return <span className="empty">—</span>;
  if (f.kind === "checkbox") return v ? <span className="cell-check on">✓</span> : <span className="cell-check" />;
  if (f.kind === "select") return <Pill label={String(v)} />;
  if (f.kind === "multi_select") return <>{(v as string[]).map((x) => <Pill key={x} label={x} />)}</>;
  if (f.kind === "link") return <>{(Array.isArray(v) ? v : [v]).map((id) => <span key={String(id)} className="cell-link">{titleOf(app, String(id))}</span>)}</>;
  if (f.kind === "number") return <span className="num">{Number(v).toLocaleString()}</span>;
  if (f.kind === "date") return <>{new Date(String(v) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</>;
  if (f.kind === "url") return <a className="cell-url" href={String(v)} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{String(v).replace(/^https?:\/\//, "")}</a>;
  return <>{String(v)}</>;
}

function Cell({ app, f, rec, update, readOnly }: { app: AppState; f: FieldDef; rec: RecordFull; update: (r: RecordFull, p: Record<string, unknown>) => void; readOnly: boolean }) {
  const [edit, setEdit] = useState(false);
  const ref = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    if (!edit) return;
    // focus the editor inside the cell (text inputs; menus focus themselves)
    window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLInputElement>(".cell-editor input, .cell-editor textarea");
      el?.focus();
      el?.select();
    }, 0);
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest(".menu")) setEdit(false);
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setEdit(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [edit]);
  if (f.kind === "checkbox")
    return (
      <td className="cell" onClick={(e) => e.stopPropagation()}>
        <button className={`check ${rec.fields[f.key] ? "on" : ""}`} disabled={readOnly} onClick={() => update(rec, { [f.key]: !rec.fields[f.key] })} aria-label={f.name}>
          {rec.fields[f.key] ? <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
        </button>
      </td>
    );
  return (
    <td
      ref={ref}
      className={`cell ${edit ? "is-editing" : ""} ${readOnly ? "" : "is-editable"}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!readOnly) setEdit(true);
      }}
    >
      {edit ? (
        <div className="cell-editor">
          <Value
            f={f}
            value={rec.fields[f.key]}
            records={app.records}
            onChange={(v) => {
              update(rec, { [f.key]: v });
              if (!["multi_select", "link"].includes(f.kind) || !f.multiple) setEdit(false);
            }}
            onOpen={() => {}}
          />
        </div>
      ) : (
        <CellView app={app} f={f} v={rec.fields[f.key]} />
      )}
    </td>
  );
}

// ------------------------------------------------------------------ table
function Table({ app, type, layout, rows, open, update, sort, setSort, addRow, readOnly }: {
  app: AppState; type: TypeInfo; layout: LayoutDef; rows: RecordFull[]; open: (id: string) => void;
  update: (r: RecordFull, p: Record<string, unknown>) => void; sort: { key: string; desc: boolean } | null;
  setSort: (s: { key: string; desc: boolean } | null) => void; addRow: () => void; readOnly: boolean;
}) {
  const cols = (layout.columns?.length ? layout.columns.map((k) => type.fields.find((f) => f.key === k)).filter(Boolean) : type.fields.slice(0, 6)) as FieldDef[];
  const head = (key: string, name: string) => (
    <th key={key} onClick={() => setSort(sort?.key === key ? (sort.desc ? null : { key, desc: true }) : { key, desc: false })} className={sort?.key === key ? "is-sorted" : ""}>
      <span className="th-inner">
        {name}
        {sort?.key === key ? <span className="sort-mark">{sort.desc ? "↓" : "↑"}</span> : null}
      </span>
    </th>
  );
  return (
    <div className="table-wrap">
      <table className="grid editable">
        <thead>
          <tr>
            {head("title", "Title")}
            {cols.map((c) => head(c.key, c.name))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="cell-title" onClick={() => open(r.id)}>
                <span className="cell-title-inner">
                  <Icon name={typeIcon(r.type)} size={14} />
                  <span className="cell-title-text">{r.title}</span>
                  <span className="cell-open">Open</span>
                </span>
              </td>
              {cols.map((c) => (
                <Cell key={c.id} app={app} f={c} rec={r} update={update} readOnly={readOnly} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly ? (
        <button className="row-add" onClick={() => addRow()}>
          <Icon name="plus" size={13} /> New {type.name.toLowerCase()}
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ list
function ListLayout({ app, type, rows, open }: { app: AppState; type: TypeInfo; rows: RecordFull[]; open: (id: string) => void }) {
  const show = type.fields.filter((f) => ["select", "date", "link"].includes(f.kind)).slice(0, 3);
  return (
    <ul className="view-list">
      {rows.map((r) => (
        <li key={r.id} onClick={() => open(r.id)}>
          <Icon name={typeIcon(r.type)} size={15} />
          <span className="vl-title">{r.title}</span>
          <span className="vl-meta">
            {show.map((f) => (r.fields[f.key] != null && r.fields[f.key] !== "" ? <span key={f.key}><CellView app={app} f={f} v={r.fields[f.key]} /></span> : null))}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ board
// Dragging a card to another column sets the field the board groups by. Nothing else.
function Board({ app, type, layout, rows, open, update, addRow, readOnly }: {
  app: AppState; type: TypeInfo; layout: LayoutDef; rows: RecordFull[]; open: (id: string) => void;
  update: (r: RecordFull, p: Record<string, unknown>, label?: string) => void; addRow: (extra?: Record<string, unknown>) => void; readOnly: boolean;
}) {
  const f = type.fields.find((x) => x.key === layout.by);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; w: number; dx: number; dy: number } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const colRefs = useRef(new Map<string, HTMLElement>());
  if (!f) return <div className="banner">This board groups by "{layout.by}", which isn't a field of {type.name}. Edit the view to pick one.</div>;
  const cols: { key: string; label: string; value: unknown }[] =
    f.kind === "checkbox"
      ? [{ key: "false", label: "Not checked", value: false }, { key: "true", label: "Checked", value: true }]
      : [...(f.options ?? []).map((o) => ({ key: o, label: o, value: o as unknown })), { key: "", label: `No ${f.name.toLowerCase()}`, value: null }];
  const colOf = (r: RecordFull) => {
    const v = r.fields[f.key];
    if (f.kind === "checkbox") return v ? "true" : "false";
    return v == null || v === "" ? "" : String(v);
  };
  const empty = cols.filter((c) => c.key === "" && !rows.some((r) => colOf(r) === ""));
  const shown = cols.filter((c) => !empty.includes(c));
  const showMeta = type.fields.filter((x) => x.key !== f.key && ["date", "link", "select", "checkbox"].includes(x.kind)).slice(0, 3);

  const start = (e: React.PointerEvent, r: RecordFull) => {
    if (readOnly || e.button !== 0) return;
    const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    let target: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      moved = true;
      setDrag({ id: r.id, x: ev.clientX, y: ev.clientY, w: card.width, dx: sx - card.left, dy: sy - card.top });
      target = null;
      for (const [k, el] of colRefs.current) {
        const b = el.getBoundingClientRect();
        if (ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top - 40 && ev.clientY <= b.bottom + 40) target = k;
      }
      setOver(target);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setDrag(null);
      setOver(null);
      if (!moved) return open(r.id);
      if (target !== null && target !== colOf(r)) {
        const c = cols.find((x) => x.key === target)!;
        update(r, { [f.key]: c.value }, `Set ${f.name} → ${c.value == null ? "empty" : c.label}`);
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const dragged = drag ? rows.find((r) => r.id === drag.id) : null;
  return (
    <div className={`board ${drag ? "is-dragging" : ""}`}>
      {shown.map((c) => {
        const items = rows.filter((r) => colOf(r) === c.key);
        return (
          <section key={c.key} className={`board-col ${over === c.key && dragged && colOf(dragged) !== c.key ? "is-over" : ""}`} ref={(el) => void (el ? colRefs.current.set(c.key, el) : colRefs.current.delete(c.key))}>
            <header className="board-head">
              {c.key ? <Pill label={c.label} /> : <span className="board-none">{c.label}</span>}
              <span className="board-n">{items.length}</span>
            </header>
            <div className="board-cards">
              {items.map((r) => (
                <div key={r.id} className={`card ${drag?.id === r.id ? "is-lifted" : ""}`} onPointerDown={(e) => start(e, r)}>
                  <div className="card-title">{r.title}</div>
                  <div className="card-meta">
                    {showMeta.map((m) =>
                      r.fields[m.key] != null && r.fields[m.key] !== "" && r.fields[m.key] !== false ? (
                        <span key={m.key} className="card-field" title={m.name}>
                          <CellView app={app} f={m} v={r.fields[m.key]} />
                        </span>
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
              {over === c.key && dragged && colOf(dragged) !== c.key ? <div className="card-slot">Set {f.name} → {c.value == null ? "empty" : c.label}</div> : null}
            </div>
            {!readOnly ? (
              <button className="board-add" onClick={() => addRow({ [f.key]: c.value })}>
                <Icon name="plus" size={13} /> New
              </button>
            ) : null}
          </section>
        );
      })}
      {drag && dragged ? (
        <div className="card card-ghost" style={{ left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w }}>
          <div className="card-title">{dragged.title}</div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ calendar
function Calendar({ type, layout, rows, open, update, readOnly }: {
  type: TypeInfo; layout: LayoutDef; rows: RecordFull[]; open: (id: string) => void;
  update: (r: RecordFull, p: Record<string, unknown>, label?: string) => void; readOnly: boolean;
}) {
  const f = type.fields.find((x) => x.key === layout.date);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!f) return <div className="banner">This calendar uses "{layout.date}", which isn't a date field of {type.name}.</div>;
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const first = new Date(month);
  first.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start Monday
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const byDay = new Map<string, RecordFull[]>();
  for (const r of rows) {
    const v = r.fields[f.key];
    if (v) byDay.set(String(v), [...(byDay.get(String(v)) ?? []), r]);
  }
  const undated = rows.filter((r) => !r.fields[f.key]);
  const today = iso(new Date());
  return (
    <div className="cal">
      <div className="cal-bar">
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
          <Icon name="chevron" size={14} className="flip" />
        </button>
        <span className="cal-month">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
        <button className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
          <Icon name="chevron" size={14} />
        </button>
        <button className="btn-soft" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
      </div>
      <div className="cal-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="cal-dow">{d}</div>
        ))}
        {days.map((d) => {
          const k = iso(d);
          return (
            <div
              key={k}
              className={`cal-day ${d.getMonth() !== month.getMonth() ? "is-out" : ""} ${k === today ? "is-today" : ""} ${over === k ? "is-over" : ""}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOver(k);
              }}
              onDragLeave={() => over === k && setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                const r = rows.find((x) => x.id === dragId);
                setDragId(null);
                setOver(null);
                if (r && r.fields[f.key] !== k) update(r, { [f.key]: k }, `Set ${f.name} → ${new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
              }}
            >
              <span className="cal-n">{d.getDate()}</span>
              {(byDay.get(k) ?? []).map((r) => (
                <button key={r.id} className="cal-item" draggable={!readOnly} onDragStart={() => setDragId(r.id)} onDragEnd={() => (setDragId(null), setOver(null))} onClick={() => open(r.id)}>
                  {r.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {undated.length ? (
        <div className="cal-undated">
          <h4>No {f.name.toLowerCase()}</h4>
          {undated.map((r) => (
            <button key={r.id} className="cal-item" draggable={!readOnly} onDragStart={() => setDragId(r.id)} onDragEnd={() => (setDragId(null), setOver(null))} onClick={() => open(r.id)}>
              {r.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
