import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, subscribe, type AppState, type LayoutDef, type RecordFull, type TypeInfo, type ViewDef, type ViewInfo } from "./api.ts";
import { Grid, GridOptions, textOf, type Change, type LayoutPatch } from "./Grid.tsx";
import { Icon, typeIcon } from "./Icon.tsx";
import { Properties } from "./Properties.tsx";
import { TypesPanel } from "./TypesPanel.tsx";
import { FieldDialog, NewTableDialog } from "./DataSchema.tsx";
import { TableNav } from "./TableNav.tsx";
import { GroupPanel, SortPanel } from "./DataToolbar.tsx";
import { parseGroup, parseSort } from "./Grid.tsx";
import { ViewEditor } from "./ViewEditor.tsx";
import { defaultsFrom, deleteRecord } from "./edits.ts";
import { did, onUndo, redo, typingTarget, undo } from "./undo.ts";

type Route = { type: string; view?: string; personal: boolean };
function readRoute(): Route {
  const [path, query] = location.hash.slice(1).split("?");
  const params = new URLSearchParams(query);
  return { type: path?.startsWith("/table/") ? decodeURIComponent(path.slice(7)) : "", view: params.get("view") || undefined, personal: params.get("personal") === "1" };
}
function navigate(type: string, view?: ViewInfo) {
  const params = new URLSearchParams(view ? { view: view.key, ...(view.personal ? { personal: "1" } : {}) } : {});
  location.hash = `/table/${encodeURIComponent(type)}${params.size ? `?${params}` : ""}`;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function DataApp() {
  const [app, setApp] = useState<AppState | null>(null);
  const [route, setRoute] = useState(readRoute);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [typeSearch, setTypeSearch] = useState("");
  const [schema, setSchema] = useState(false);
  const [newTable, setNewTable] = useState(false);
  const [addField, setAddField] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [newFolderSignal, setNewFolderSignal] = useState(0);
  useEffect(() => {
    if (!addMenu) return;
    const close = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".data-add-wrap")) setAddMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [addMenu]);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof api.workspaces>>["workspaces"]>([]);
  const [switching, setSwitching] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem("surface-data-nav") === "collapsed");
  const toggleNav = () => setNavCollapsed(c => { localStorage.setItem("surface-data-nav", c ? "open" : "collapsed"); return !c; });
  const sheetDirty = useRef(false);
  const reload = useCallback(async () => {
    try { setApp(await api.state()); setError(""); }
    catch (e) { setError(message(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const lastHash = useRef(location.hash);
  useEffect(() => {
    // Covers browser back/forward and typed URLs. In-app navigation clears the draft first, so this prompts at most once.
    const change = () => {
      if (location.hash === lastHash.current) return;
      if (sheetDirty.current && !window.confirm("Discard unsaved record edits?")) { history.replaceState(null, "", lastHash.current || location.pathname); return; }
      sheetDirty.current = false; lastHash.current = location.hash;
      setRoute(readRoute()); setRecordId(null);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => subscribe(() => { void reload(); setTick(t => t + 1); }, setOnline), [reload]);
  useEffect(() => {
    if (!app) return;
    let active = true;
    api.workspaces().then(r => { if (active) setWorkspaces(r.workspaces); }).catch(e => setToast(message(e)));
    return () => { active = false; };
  }, [app?.workspace.id]);
  useEffect(() => onUndo(e => {
    setToast(e.label);
    if (e.kind !== "done") { void reload(); setTick(t => t + 1); }
  }), [reload]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (sheetDirty.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || typingTarget(document.activeElement)) return;
      event.preventDefault(); void (event.shiftKey ? redo() : undo());
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  const type = app?.types.find(t => t.key === route.type) ?? app?.types.find(t => t.key === "contact") ?? app?.types[0];
  const view = app?.views.find(v => v.key === route.view && v.personal === route.personal && v.definition.from === type?.key);
  const views = app?.views.filter(v => v.definition.from === type?.key && !/\bthis\b/.test(v.definition.where ?? "") && (!v.definition.layouts?.length || v.definition.layouts.some(l => l.show === "table"))) ?? [];
  const changed = () => { void reload(); setTick(t => t + 1); };
  const canLeaveSheet = () => !sheetDirty.current || window.confirm("Discard unsaved record edits?");
  const closeSheet = () => { if (canLeaveSheet()) { sheetDirty.current = false; setRecordId(null); } };
  const openRecord = (id: string) => { if (canLeaveSheet()) { sheetDirty.current = false; setRecordId(id); } };
  const go = (key: string, v?: ViewInfo) => { if (!canLeaveSheet()) return; sheetDirty.current = false; setRecordId(null); navigate(key, v); };
  const switchWorkspace = async (id: string) => {
    if (!canLeaveSheet()) return;
    setSwitching(true); setRecordId(null); sheetDirty.current = false;
    try { await api.switchWorkspace(id); await reload(); navigate(""); setTick(t => t + 1); }
    catch (e) { setError(message(e)); }
    finally { setSwitching(false); }
  };
  if (!app) return <div className="data-boot"><div className="data-emblem">S</div><h1>Surface Data</h1><p>{error || "Opening your workspace…"}</p>{error && <button className="btn-soft" onClick={reload}>Try again</button>}</div>;
  return <div className="data-app">
    <header className="data-topbar">
      <div className="data-brand"><span className="data-emblem">S</span><strong>Surface <span>Data</span></strong></div>
      <span className="data-top-divider" />
      <label className="data-workspace"><Icon name="project" /><select aria-label="Workspace" value={app.workspace.id} disabled={switching} onChange={e => void switchWorkspace(e.target.value)}>
        {!workspaces.length && <option value={app.workspace.id}>{app.workspace.name}</option>}
        {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select></label>
      <span className="data-connection"><i className={online ? "is-online" : ""} />{switching ? "Opening workspace…" : online ? "Connected" : "Reconnecting…"}</span>
      <span className="data-account">{app.user.email}</span>
    </header>
    <div className="data-shell" aria-busy={switching}>
      <aside className={`data-nav ${navCollapsed ? "is-collapsed" : ""}`} aria-label="Tables">
        <div className="data-nav-top">
          <label className="data-table-search"><Icon name="search" size={14} /><input aria-label="Find a table" placeholder="Find a table" value={typeSearch} onChange={e => setTypeSearch(e.target.value)} /></label>
          <button className="icon-btn data-nav-toggle" onClick={toggleNav} aria-label={navCollapsed ? "Expand tables list" : "Collapse tables list"} aria-expanded={!navCollapsed} title={navCollapsed ? "Expand tables list" : "Collapse tables list"}><Icon name="sidebar" size={15} /></button>
        </div>
        <TableNav app={app} active={type?.key} search={typeSearch} disabled={switching} onOpen={go} onChanged={changed} toast={setToast} newFolderSignal={newFolderSignal} />
        <div className="data-nav-bottom">
          {(app.role === "owner" || app.role === "admin") && <span className="data-add-wrap">
            <button className="data-nav-action" onClick={() => setAddMenu(m => !m)} aria-label="Add table or folder" aria-expanded={addMenu} title="Add a table or folder"><Icon name="plus" size={15} /><span>Add</span></button>
            {addMenu && <div className="menu data-nav-menu data-add-menu" role="menu"><button className="menu-item" onClick={() => { setAddMenu(false); setNewTable(true); }}><Icon name="table" size={13} />New table</button><button className="menu-item" onClick={() => { setAddMenu(false); if (navCollapsed) toggleNav(); setNewFolderSignal(n => n + 1); }}><Icon name="folder" size={13} />New folder</button></div>}
          </span>}
          <button className="data-nav-action" title="Tables and fields" onClick={() => setSchema(true)}><Icon name="settings" size={15} /><span>Tables and fields</span></button>
        </div>
      </aside>
      <main className="data-main">
        {error && <div className="banner" role="alert">{error}<button className="btn-soft" onClick={reload}>Retry</button></div>}
        {type && !switching ? <>
          <div className="data-table-heading"><h1>{type.name}</h1><nav className="data-view-tabs" aria-label="Saved table views"><button className={!view ? "is-active" : ""} onClick={() => go(type.key)}><Icon name="table" size={14} />All records</button>{views.map(v => <button key={`${v.personal}:${v.key}`} className={view?.key === v.key && view.personal === v.personal ? "is-active" : ""} onClick={() => go(type.key, v)}><Icon name={v.personal ? "lock" : "table"} size={13} />{v.name}</button>)}</nav>{(app.role === "owner" || app.role === "admin") && <button className="data-edit-fields" onClick={() => setAddField(true)}><Icon name="plus" size={13} />Add field</button>}<button className="data-edit-fields data-edit-fields-secondary" onClick={() => setSchema(true)}><Icon name="sliders" size={13} />Edit fields</button></div>
          {route.view && !view && <div className="banner">That view is unavailable. Showing all records in this table.</div>}
          <DataTable key={`${app.workspace.id}:${type.key}:${view?.personal}:${view?.key ?? "all"}`} app={app} type={type} initial={view} tick={tick} changed={changed} open={openRecord} toast={setToast} onView={v => { changed(); navigate(type.key, v); }} />
        </> : <div className="data-loading">{switching ? "Opening workspace and downloading its records…" : "Create your first table to get started."}</div>}
      </main>
    </div>
    {toast && <div className="data-toast" role="status"><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><Icon name="close" size={14} /></button></div>}
    {schema && <TypesPanel app={app} noun="table" initial={type?.key} onClose={() => { setSchema(false); changed(); }} onToast={m => { setToast(m); changed(); }} />}
    {newTable && <NewTableDialog app={app} onClose={() => setNewTable(false)} onCreated={key => { setNewTable(false); setToast("Table created"); changed(); window.setTimeout(() => go(key), 300); }} />}
    {addField && type && <FieldDialog app={app} type={type} onClose={() => setAddField(false)} onSaved={f => { setAddField(false); setToast(`Added the field ${f.name}`); changed(); }} />}
    {recordId && <RecordSheet key={`${app.workspace.id}:${recordId}`} id={recordId} app={app} onDirty={dirty => { sheetDirty.current = dirty; }} close={closeSheet} open={openRecord} changed={changed} toast={setToast} />}
  </div>;
}

function DataTable({ app, type, initial, tick, changed, open, toast, onView }: { app: AppState; type: TypeInfo; initial?: ViewInfo; tick: number; changed: () => void; open: (id: string) => void; toast: (s: string) => void; onView: (v: ViewInfo) => void }) {
  const [definition, setDefinition] = useState<ViewDef>(() => initial?.definition ?? { from: type.key, sort: "title", layouts: [{ show: "table", columns: type.fields.map(f => f.key) }] });
  const [saved, setSaved] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [rows, setRows] = useState<RecordFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState(false);
  const [panel, setPanel] = useState<"group" | "sort" | null>(null);
  const [groupCommand, setGroupCommand] = useState<{ action: "collapse" | "expand" } | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [editingView, setEditingView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [personal, setPersonal] = useState(true);
  const busy = useRef(false);
  const loadSequence = useRef(0);
  const layoutIndex = Math.max(0, definition.layouts?.findIndex(l => l.show === "table") ?? 0);
  const layout: LayoutDef = definition.layouts?.[layoutIndex] ?? { show: "table" };
  const canWrite = app.role !== "viewer";
  const canSave = !!saved && (saved.personal || app.role === "owner" || app.role === "admin" || app.role === "member");
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const result = await api.query({ from: type.key, where: definition.where, sort: definition.sort });
      if (sequence !== loadSequence.current) return;
      setRows(definition.limit ? result.records.slice(0, definition.limit) : result.records); setError("");
    } catch (e) { if (sequence === loadSequence.current) setError(message(e)); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [type.key, definition.where, definition.sort, definition.limit]);
  useEffect(() => { void load(); return () => { loadSequence.current++; }; }, [load, tick]);
  const patchLayout = (patch: LayoutPatch) => {
    setDefinition(d => ({ ...d, ...("sort" in patch ? { sort: patch.sort ?? undefined } : {}), layouts: (d.layouts ?? [{ show: "table" }]).map((l, i) => i === layoutIndex ? { ...l, ...patch.layout } : l) }));
    setDirty(true);
  };
  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter(r => [r.title, ...type.fields.map(f => textOf(app, f, r))].some(s => s.toLowerCase().includes(term))) : rows;
  }, [rows, search, type.fields, app.records]);
  const mutate = async (operation: () => Promise<void>) => {
    if (busy.current) { toast("Please wait for the current change to finish."); return; }
    busy.current = true; setSaving(true);
    try { await operation(); setError(""); }
    catch (e) { setError(message(e)); toast(message(e)); }
    finally { busy.current = false; setSaving(false); await load(); changed(); }
  };
  const saveChanges = (changes: Change[]) => void mutate(async () => {
    const problems: string[] = [];
    for (const c of changes) {
      try {
        const patch = { ...(c.title !== undefined ? { title: c.title } : {}), ...(c.fields ? { fields: c.fields } : {}) };
        const previous = { ...(c.title !== undefined ? { title: c.rec.title } : {}), ...(c.fields ? { fields: Object.fromEntries(Object.keys(c.fields).map(k => [k, c.rec.fields[k] ?? null])) } : {}) };
        const result = await api.save(c.rec.id, { baseRev: c.rec.rev, ...patch });
        let rev = result.record.rev;
        did({ label: `Updated ${result.record.title}`, undo: async () => { rev = (await api.save(c.rec.id, { baseRev: rev, ...previous })).record.rev; }, redo: async () => { rev = (await api.save(c.rec.id, { baseRev: rev, ...patch })).record.rev; } });
      } catch (e) { problems.push(`${c.rec.title}: ${message(e)}`); }
    }
    if (problems.length) throw new Error(`Saved ${changes.length - problems.length} of ${changes.length} changes. ${problems.slice(0, 2).join("; ")}`);
  });
  const addRow = () => void mutate(async () => {
    const result = await api.create({ type: type.key, title: `New ${type.name.toLowerCase()}`, fields: defaultsFrom(definition.where, type, null) });
    open(result.record.id);
  });
  const removeRows = (ids: string[]) => {
    if (!window.confirm(`Delete ${ids.length} selected record${ids.length === 1 ? "" : "s"}? You can undo this.`)) return;
    void mutate(async () => {
      const failures: string[] = [];
      for (const id of ids) { try { const r = rows.find(x => x.id === id); if (r) await deleteRecord(r); } catch (e) { failures.push(message(e)); } }
      if (failures.length) throw new Error(`${failures.length} records could not be deleted: ${failures[0]}`);
      toast(`Deleted ${ids.length} records. Ctrl+Z to undo.`);
    });
  };
  const saveView = async (asNew: boolean) => {
    if (!asNew && !canSave) return;
    setSaving(true);
    try {
      const result = asNew ? await api.createView({ name: viewName.trim() || `${type.name} view`, personal, definition }) : await api.saveView(saved!.key, saved!.personal, { name: saved!.name, baseRev: saved!.rev, definition });
      setSaved(result.view); setDirty(false); setSaveDialog(false); toast("View saved"); onView(result.view);
    } catch (e) { setError(message(e)); }
    finally { setSaving(false); }
  };
  const groupCount = parseGroup(layout.group).filter(l => type.fields.some(f => f.key === l.columnKey)).length;
  const sortCount = parseSort(definition.sort).length;
  const editDefinition: ViewInfo = saved ? { ...saved, definition } : { key: "", name: "", personal: true, rev: 0, updated_at: "", definition };
  return <section className="data-table-content" aria-label={`${type.name} records`}>
    <div className="data-toolbar">
      <div className="data-toolbar-start">{saved && <span className="data-scope">{saved.personal ? "Personal" : "Shared"}</span>}{definition.where && <div className="data-filter-summary"><Icon name="sliders" size={12} /><code title={definition.where}>{definition.where}</code><button onClick={() => { setDefinition(d => ({ ...d, where: undefined })); setDirty(true); }} aria-label="Clear filters"><Icon name="close" size={11} /></button></div>}</div>
      <div className="data-toolbar-actions">
        <button className={`btn-soft ${definition.where ? "is-on" : ""}`} onClick={() => setEditingView(true)}><Icon name="sliders" size={14} />Filter</button>
        <div className="data-options"><button className={`btn-soft ${options ? "is-on" : ""}`} onClick={() => setOptions(!options)}><Icon name="eye" size={14} />Columns</button>{options && <GridOptions type={type} layout={layout} hideGroup onLayout={patchLayout} onClose={() => setOptions(false)} />}</div>
        <div className="data-options"><button data-popover-toggle className={`btn-soft ${panel === "group" || groupCount ? "is-on" : ""}`} aria-expanded={panel === "group"} onClick={() => setPanel(p => p === "group" ? null : "group")}><Icon name="list" size={14} />{groupCount ? `Grouped by ${groupCount} field${groupCount > 1 ? "s" : ""}` : "Group"}</button>{panel === "group" && <GroupPanel type={type} group={layout.group} onChange={g => patchLayout({ layout: { group: g } })} onCollapseAll={() => setGroupCommand({ action: "collapse" })} onExpandAll={() => setGroupCommand({ action: "expand" })} onClose={() => setPanel(null)} />}</div>
        <div className="data-options"><button data-popover-toggle className={`btn-soft ${panel === "sort" || sortCount ? "is-on" : ""}`} aria-expanded={panel === "sort"} onClick={() => setPanel(p => p === "sort" ? null : "sort")}><Icon name="move" size={14} />{sortCount ? `Sorted by ${sortCount} field${sortCount > 1 ? "s" : ""}` : "Sort"}</button>{panel === "sort" && <SortPanel type={type} sort={definition.sort} onChange={s => patchLayout({ sort: s ?? null })} onClose={() => setPanel(null)} />}</div>
        <label className="data-record-search"><Icon name="search" size={14} /><input aria-label="Search records" placeholder="Search this table" value={search} onChange={e => setSearch(e.target.value)} /></label>
        {dirty && canSave && <button className="btn-soft" disabled={saving} onClick={() => void saveView(false)}>{saved?.personal ? "Save changes" : "Save for everyone"}</button>}
        <button className="btn-soft" onClick={() => { setViewName(saved ? `${saved.name} copy` : ""); setSaveDialog(true); }}>Save as view</button>
        {canWrite && <button className="btn-primary" disabled={saving} onClick={addRow}><Icon name="plus" size={14} />Add record</button>}
      </div>
    </div>
    {error && <div className="banner" role="alert">{error}<button className="btn-soft" onClick={load}>Reload records</button></div>}
    {loading ? <div className="data-loading">Loading records…</div> : <div className="data-grid-area"><Grid app={app} type={type} layout={layout} sort={definition.sort} rows={visibleRows} readOnly={!canWrite || saving} open={open} onLayout={patchLayout} onChanges={saveChanges} onDelete={removeRows} addRow={addRow} groupCommand={groupCommand} />{!rows.length && !error && <div className="data-empty">No records yet. {canWrite ? "Add a record to start using this table." : "This table is empty."}</div>}</div>}
    <footer className="data-footer"><span>{visibleRows.length.toLocaleString()} {visibleRows.length === 1 ? "record" : "records"}{search ? ` of ${rows.length}` : ""}</span><span>{saving ? "Saving…" : !canWrite ? "Read only" : dirty ? "View settings have unsaved changes" : "Changes save to your workspace"}</span><button onClick={() => void undo()}><Icon name="undo" size={13} />Undo</button><button onClick={() => { changed(); void load(); }}><Icon name="refresh" size={13} />Refresh</button></footer>
    {editingView && <ViewEditor app={app} initial={editDefinition} onClose={() => setEditingView(false)} onSaved={() => {}} onApply={d => { setDefinition(cur => ({ ...cur, where: d.where, sort: d.sort })); setDirty(true); setEditingView(false); }} />}
    {saveDialog && <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setSaveDialog(false)}><form className="panel data-save-panel" role="dialog" aria-modal="true" aria-label="Save table view" onSubmit={e => { e.preventDefault(); void saveView(true); }}><header className="panel-head"><h3>Save this table view</h3><button type="button" aria-label="Close" onClick={() => setSaveDialog(false)}><Icon name="close" /></button></header><div className="data-save-body"><label>View name<input autoFocus required value={viewName} placeholder="For example, Active contacts" onChange={e => setViewName(e.target.value)} /></label><label>Who can see this view?<select value={personal ? "personal" : "shared"} onChange={e => setPersonal(e.target.value === "personal")}><option value="personal">Only me</option>{app.role !== "viewer" && <option value="shared">Everyone in this workspace</option>}</select></label><p>Your columns, widths, sorting, grouping and filters are saved together.</p>{error && <p role="alert">{error}</p>}<button className="btn-primary" disabled={saving}>Save view</button></div></form></div>}
  </section>;
}

function RecordSheet({ id, app, onDirty, close, open, changed, toast }: { id: string; app: AppState; onDirty: (b: boolean) => void; close: () => void; open: (id: string) => void; changed: () => void; toast: (s: string) => void }) {
  const [record, setRecord] = useState<RecordFull | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const readOnly = app.role === "viewer";
  const loadSequence = useRef(0);
  useEffect(() => () => { loadSequence.current++; }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try { const { record: r } = await api.record(id); if (sequence !== loadSequence.current) return; setRecord(r); setTitle(r.title); setBody(r.body); setFields(r.fields); setDirty(false); onDirty(false); setError(""); setConflict(false); setFieldErrors({}); }
    catch (e) { if (sequence === loadSequence.current) setError(message(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const edit = () => { setDirty(true); onDirty(true); };
  const type = app.types.find(t => t.key === record?.type);
  const save = async () => {
    if (!record || readOnly) return;
    setBusy(true); setError("");
    try { const result = await api.save(id, { baseRev: record.rev, title, body, fields }); setRecord(result.record); setTitle(result.record.title); setBody(result.record.body); setFields(result.record.fields); setDirty(false); onDirty(false); setConflict(false); setFieldErrors({}); changed(); toast("Record saved"); }
    catch (e) { setError(message(e)); setFieldErrors(e instanceof ApiError ? e.errors ?? {} : {}); setConflict(e instanceof ApiError && e.status === 409); }
    finally { setBusy(false); }
  };
  const duplicate = async () => {
    if (!record) return;
    setBusy(true);
    try { const { record: copy } = await api.create({ type: record.type, title: `${record.title} copy`, body: record.body, fields: record.fields }); changed(); open(copy.id); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <div className="data-sheet-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && close()}>
    <section className="data-sheet" role="dialog" aria-modal="true" aria-label="Record details" onKeyDown={e => { if (e.key === "Escape" && !busy) { e.stopPropagation(); close(); } }}>
      <header><span><Icon name="table" size={15} />{type?.name ?? "Record"}</span><button className="icon-btn" disabled={busy} onClick={close} aria-label="Close record"><Icon name="close" /></button></header>
      {error && <div className="banner" role="alert">{error}{conflict && <><p>Your draft is kept. Another edit reached the database first.</p><button className="btn-soft" onClick={() => { if (window.confirm("Discard your draft and load the current record?")) void load(); }}>Load current record</button></>}</div>}
      {!record ? <div className="data-loading">{error ? "Could not open this record." : "Opening record…"}</div> : <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={readOnly || busy}><label className="data-record-title">Title<input aria-label="Record title" value={title} onChange={e => { setTitle(e.target.value); edit(); }} /></label>
          {type && <Properties fields={type.fields} values={fields} errors={fieldErrors} records={app.records} typeKeyOf={recordId => app.records.find(r => r.id === recordId)?.type} onChange={(key, value) => { setFields(f => ({ ...f, [key]: value })); edit(); }} onOpen={open} />}
          <label className="data-body-label">Notes<textarea aria-label="Record notes" value={body} onChange={e => { setBody(e.target.value); edit(); }} placeholder="Write notes in Markdown…" /></label>
        </fieldset>
        <footer><span>{readOnly ? "Read only" : dirty ? "Unsaved changes" : "Saved"}</span>{!readOnly && <><button type="button" className="btn-soft" disabled={busy || dirty} onClick={() => void duplicate()}><Icon name="copy" size={13} />Duplicate</button><button className="btn-primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save record"}</button></>}</footer>
      </form>}
    </section>
  </div>;
}
