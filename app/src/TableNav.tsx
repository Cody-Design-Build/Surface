// Surface Data's table list, with folders. Folders are organization only: they live in the
// shared tree view "tables" (`group` items holding `query: { from: <table> }` items) and never
// change a record or a table. Tables not placed in a folder are listed after the folders.
import { useEffect, useRef, useState } from "react";
import { api, type AppState, type TablesItem, type TypeInfo } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";

type Folder = { name: string; tables: string[] };
const readFolders = (app: AppState): Folder[] =>
  (app.tables?.definition.items ?? [])
    .filter((it) => typeof it.group === "string")
    .map((it) => ({ name: it.group!, tables: (it.items ?? []).map((x) => x.query?.from).filter((k): k is string => !!k && app.types.some((t) => t.key === k)) }));
const toDefinition = (folders: Folder[]): { items: TablesItem[] } => ({ items: folders.map((f) => ({ group: f.name, items: f.tables.map((from) => ({ query: { from } })) })) });

export function TableNav({ app, active, search, disabled, onOpen, onChanged, toast }: { app: AppState; active?: string; search: string; disabled: boolean; onOpen: (key: string) => void; onChanged: () => void; toast: (m: string) => void }) {
  const canArrange = app.role === "owner" || app.role === "admin";
  const [folders, setFolders] = useState<Folder[]>(() => readFolders(app));
  const [closed, setClosed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("surface-data-folders-closed") ?? "[]")));
  const [menu, setMenu] = useState<{ kind: "table" | "folder"; key: string } | null>(null);
  const [naming, setNaming] = useState<{ folder?: string; forTable?: string } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const saving = useRef(false);
  useEffect(() => { if (!saving.current) setFolders(readFolders(app)); }, [app.tables?.rev, app.types.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".data-nav-menu")) setMenu(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const persist = async (next: Folder[]) => {
    const previous = folders;
    setFolders(next); setMenu(null); saving.current = true;
    try { await api.saveTables(toDefinition(next), app.tables?.rev ?? null); onChanged(); }
    catch (e) { setFolders(previous); toast(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; }
  };
  const toggle = (name: string) => setClosed((c) => {
    const n = new Set(c); if (n.has(name)) n.delete(name); else n.add(name);
    localStorage.setItem("surface-data-folders-closed", JSON.stringify([...n])); return n;
  });
  const moveTo = (table: string, folder: string | null) => persist(
    folders.map((f) => ({ ...f, tables: f.tables.filter((t) => t !== table) })).map((f) => (f.name === folder ? { ...f, tables: [...f.tables, table] } : f)),
  );
  const commitName = () => {
    const name = nameDraft.trim();
    const target = naming; setNaming(null); setNameDraft("");
    if (!name || !target) return;
    if (folders.some((f) => f.name === name && f.name !== target.folder)) return toast(`There's already a folder called ${name}.`);
    if (target.folder) return void persist(folders.map((f) => (f.name === target.folder ? { ...f, name } : f)));
    const next = [...folders.map((f) => ({ ...f, tables: f.tables.filter((t) => t !== target.forTable) })), { name, tables: target.forTable ? [target.forTable] : [] }];
    void persist(next);
  };
  const term = search.trim().toLowerCase();
  const matches = (t: TypeInfo) => t.name.toLowerCase().includes(term);
  const placed = new Set(folders.flatMap((f) => f.tables));
  const loose = app.types.filter((t) => !placed.has(t.key) && matches(t));
  const count = (key: string) => app.records.filter((r) => r.type === key).length;

  const tableRow = (t: TypeInfo, nested: boolean) => (
    <div key={t.key} className={`data-table-row ${nested ? "is-nested" : ""}`}>
      <button className={`data-table-link ${active === t.key ? "is-active" : ""}`} disabled={disabled} title={t.name} onClick={() => onOpen(t.key)}>
        <Icon name={typeIcon(t.key)} size={16} /><span>{t.name}</span><small>{count(t.key)}</small>
      </button>
      {canArrange && <button className="data-row-more" aria-label={`Organize ${t.name}`} title="Move to folder" onClick={() => setMenu(menu?.key === t.key ? null : { kind: "table", key: t.key })}><Icon name="more" size={14} /></button>}
      {menu?.kind === "table" && menu.key === t.key && (
        <div className="menu data-nav-menu" role="menu">
          <div className="menu-head">Move to folder</div>
          {folders.map((f) => <button key={f.name} className={`menu-item ${f.tables.includes(t.key) ? "is-on" : ""}`} onClick={() => void moveTo(t.key, f.name)}><Icon name="folder" size={13} />{f.name}</button>)}
          {placed.has(t.key) && <button className="menu-item" onClick={() => void moveTo(t.key, null)}>No folder</button>}
          <button className="menu-item" onClick={() => { setMenu(null); setNaming({ forTable: t.key }); }}><Icon name="plus" size={13} />New folder…</button>
        </div>
      )}
    </div>
  );
  const nameInput = (
    <input className="data-folder-input" autoFocus aria-label="Folder name" placeholder="Folder name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={commitName}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitName(); } if (e.key === "Escape") { setNaming(null); setNameDraft(""); } }} />
  );
  return (
    <nav className="data-table-tree">
      {folders.map((f) => {
        const tables = f.tables.map((k) => app.types.find((t) => t.key === k)!).filter((t) => t && matches(t));
        if (term && !tables.length) return null;
        const open = !closed.has(f.name) || !!term;
        return (
          <div key={f.name} className="data-folder">
            <div className="data-table-row">
              {naming?.folder === f.name ? nameInput : (
                <button className="data-folder-head" aria-expanded={open} title={f.name} onClick={() => toggle(f.name)}>
                  <span className={`data-folder-chev ${open ? "is-open" : ""}`}><Icon name="chevron" size={12} /></span><Icon name="folder" size={15} /><span>{f.name}</span><small>{f.tables.length}</small>
                </button>
              )}
              {canArrange && naming?.folder !== f.name && <button className="data-row-more" aria-label={`Folder ${f.name} options`} onClick={() => setMenu(menu?.key === f.name ? null : { kind: "folder", key: f.name })}><Icon name="more" size={14} /></button>}
              {menu?.kind === "folder" && menu.key === f.name && (
                <div className="menu data-nav-menu" role="menu">
                  <button className="menu-item" onClick={() => { setMenu(null); setNameDraft(f.name); setNaming({ folder: f.name }); }}><Icon name="rename" size={13} />Rename folder</button>
                  <button className="menu-item" onClick={() => void persist(folders.filter((x) => x.name !== f.name))}><Icon name="trash" size={13} />Remove folder (tables stay)</button>
                </div>
              )}
            </div>
            {open && tables.map((t) => tableRow(t, true))}
            {open && !tables.length && <div className="data-folder-empty">Empty folder</div>}
          </div>
        );
      })}
      {loose.map((t) => tableRow(t, false))}
      {naming && !naming.folder && <div className="data-table-row">{nameInput}</div>}
      {canArrange && !naming && !term && <button className="data-new-folder" onClick={() => setNaming({})}><Icon name="folder" size={14} />New folder</button>}
    </nav>
  );
}
