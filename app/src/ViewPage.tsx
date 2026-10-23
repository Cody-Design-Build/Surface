import { phoneText, phoneEntries, phoneHref } from "../../cli/src/phone.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AppState, type FieldDef, type LayoutDef, type RecordFull, type Summary, type TypeInfo, type ViewDef, type ViewInfo } from "./api.ts";
import { defaultsFrom, deleteRecord, setFields } from "./edits.ts";
import { Grid, GridOptions, type Change, type LayoutPatch } from "./Grid.tsx";
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
  const [q, setQ] = useState("");
  // unsaved display changes (column order/widths, sort, grouping…): personal views save them
  // right away; shared views wait for "Save for everyone" so browsing never rewrites them
  const [draft, setDraft] = useState<ViewDef | null>(null);
  const [options, setOptions] = useState(false);
  const saveTimer = useRef<number | null>(null);

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
    setDraft(null);
    setQ("");
    setTab(Number(localStorage.getItem(tabKey) ?? 0));
    load();
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (remoteTick) load();
  }, [remoteTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => localStorage.setItem(tabKey, String(tab)), [tab, tabKey]);

  const type = useMemo(() => app.types.find((t) => t.key === data?.view.definition.from), [app.types, data]);
  const def: ViewDef | undefined = draft ?? data?.view.definition;
  const layouts: LayoutDef[] = def?.layouts?.length ? def.layouts : [{ show: "table" }];
  const tabIdx = Math.min(tab, layouts.length - 1);
  const layout = layouts[tabIdx];
  const canSaveShared = app.role === "owner" || app.role === "admin" || app.role === "member";

  const persist = async (next: ViewDef) => {
    if (!data) return;
    try {
      const { view } = await api.saveView(data.view.key, data.view.personal, { name: data.view.name, definition: next, baseRev: data.view.rev });
      setData((d) => (d ? { ...d, view } : d));
      setDraft(null);
    } catch (e) {
      onToast(`Couldn't save the view: ${(e as Error).message}`);
    }
  };
  const changeLayout = (p: LayoutPatch) => {
    if (!data || !def) return;
    const next: ViewDef = { ...def, layouts: layouts.map((l, i) => (i === tabIdx && p.layout ? clean({ ...l, ...p.layout }) : l)) };
    if ("sort" in p) {
      if (p.sort) next.sort = p.sort;
      else delete next.sort;
    }
    setDraft(next);
    if (data.view.personal) {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => persist(next), 400);
    }
  };
  const dirty = !!draft && !data?.view.personal;

  const saveChanges = async (changes: Change[]) => {
    // optimistic, then save one by one through the normal path (validation, revisions, undo)
    setData((d) => (d ? { ...d, records: d.records.map((r) => {
      const c = changes.find((x) => x.rec.id === r.id);
      return c ? { ...r, title: c.title ?? r.title, fields: { ...r.fields, ...(c.fields ?? {}) } } : r;
    }) } : d));
    const problems: string[] = [];
    let saved = 0;
    let last: RecordFull | null = null;
    for (const c of changes) {
      try {
        last = c.title !== undefined ? (await api.save(c.rec.id, { baseRev: c.rec.rev, title: c.title })).record : await setFields(app, c.rec, c.fields ?? {});
        saved++;
        const rec = last;
        setData((d) => (d ? { ...d, records: d.records.map((r) => (r.id === rec.id ? rec : r)) } : d));
      } catch (e) {
        const errs = e instanceof ApiError && e.errors ? Object.values(e.errors) : [];
        problems.push(`${c.rec.title}: ${errs.length ? errs.join("; ") : (e as Error).message}`);
      }
    }
    if (problems.length) {
      onToast(changes.length === 1 ? `Couldn't save: ${problems[0]}` : `Saved ${saved} of ${changes.length}. ${problems.length} refused: ${problems.slice(0, 2).join("; ")}${problems.length > 2 ? "…" : ""}`);
      load();
    } else if (changes.length > 1) onToast(`Saved ${saved} changes`);
    else if (last && changes[0].fields) onToast("");
  };
  const removeRows = async (ids: string[]) => {
    for (const id of ids) {
      const r = data?.records.find((x) => x.id === id);
      if (r) await deleteRecord(r).catch((e) => onToast(`Couldn't delete ${r.title}: ${(e as Error).message}`));
    }
    onToast(ids.length === 1 ? "Deleted 1 record" : `Deleted ${ids.length} records`);
    load();
  };

  const rows = useMemo(() => {
    let r = data?.records ?? [];
    const term = q.trim().toLowerCase();
    if (term) r = r.filter((x) => x.title.toLowerCase().includes(term));
    return r;
  }, [data, q]);

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
        {layout.show === "table" && type ? (
          <div className="menu-wrap">
            <button className={`btn-soft ${options ? "is-on" : ""}`} onClick={() => setOptions(!options)} title="Fields, grouping, row height">
              <Icon name="sliders" size={13} /> Display
            </button>
            {options ? <GridOptions type={type} layout={layout} onLayout={changeLayout} onClose={() => setOptions(false)} /> : null}
          </div>
        ) : null}
        {dirty ? (
          <span className="view-dirty">
            <button className="btn-soft" onClick={() => setDraft(null)} title="Go back to the saved view">
              Reset
            </button>
            {canSaveShared ? (
              <button className="btn-primary sm" onClick={() => draft && persist(draft)} title="Save these columns, sort and grouping in the shared view">
                Save for everyone
              </button>
            ) : null}
          </span>
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
        <Grid app={app} type={type} layout={layout} sort={def?.sort} rows={rows} open={open} readOnly={app.role === "viewer"} embedded={embedded} onLayout={changeLayout} onChanges={saveChanges} onDelete={removeRows} addRow={addRow} />
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
      <div className={`page-body wide ${layout.show === "table" ? "is-grid" : ""}`}>
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
  if (f.kind === "phone") {
    const entries = phoneEntries(v);
    return entries ? <>{entries.map((entry, i) => <span key={i}>{i > 0 ? "; " : ""}<a className="cell-url" href={phoneHref(entry)} onClick={e => e.stopPropagation()}>{phoneText([entry])}</a></span>)}</> : <>{phoneText(v)}</>;
  }
  if (f.kind === "checkbox") return v ? <span className="cell-check on">✓</span> : <span className="cell-check" />;
  if (f.kind === "select") return <Pill label={String(v)} />;
  if (f.kind === "multi_select") return <>{(v as string[]).map((x) => <Pill key={x} label={x} />)}</>;
  if (f.kind === "link") return <>{(Array.isArray(v) ? v : [v]).map((id) => <span key={String(id)} className="cell-link">{titleOf(app, String(id))}</span>)}</>;
  if (f.kind === "number") return <span className="num">{Number(v).toLocaleString()}</span>;
  if (f.kind === "date") return <>{new Date(String(v) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</>;
  if (f.kind === "url") return <a className="cell-url" href={String(v)} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>{String(v).replace(/^https?:\/\//, "")}</a>;
  return <>{String(v)}</>;
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

/** drop empty display keys so saved definitions stay tidy */
function clean(l: LayoutDef): LayoutDef {
  const out = { ...l } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === undefined || v === null || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length)) delete out[k];
  return out as unknown as LayoutDef;
}
