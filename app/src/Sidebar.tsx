import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AppState, type SidebarInfo, type TreeDef, type TreeItem, type TreeNode, type ViewInfo } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";
import { SyncBadge } from "./SyncBadge.tsx";
import { insert, isInside, itemAt, move, remove, update, type Where } from "./treeEdit.ts";

// The sidebar organizes. Nothing here changes a record's fields.
//
// Two scopes, like Notion: the workspace sidebar (everyone sees it; owners and admins arrange it)
// and a personal one per member. Shown as two sections or merged into one tree (a personal setting).
//
// Entries are either *placed* (folders, records, views someone put there: they carry `loc`, their
// path in the definition) or *generated* (results of a view or query: their place comes from data).
// Placed entries drag freely. Generated entries can't be rearranged, but dragging one onto placed
// entries pins a copy there. The same record or view can be placed any number of times.

export type Scope = "workspace" | "personal";
export type Route =
  | { kind: "record"; id: string }
  | { kind: "group"; key: string }
  | { kind: "view"; key: string; personal: boolean; thisId: string | null; label?: string }
  | null;

export function nodeKey(path: string[]) {
  return path.join("/");
}

export interface SidebarChange {
  scope: Scope;
  def: TreeDef;
}

interface Props {
  app: AppState;
  current: Route;
  online: boolean;
  status: string;
  openRecord: (id: string) => void;
  openGroup: (key: string) => void;
  openView: (key: string, personal: boolean, thisId: string | null, label?: string) => void;
  newPage: () => void;
  newInside: (parent: string) => void;
  openSwitcher: () => void;
  /** Apply sidebar edits (saved, with undo). */
  saveSidebar: (changes: SidebarChange[], label: string) => Promise<void>;
  pickRecord: (title: string, onPick: (id: string) => void) => void;
  newView: (scope: Scope, onCreated: (v: ViewInfo) => void) => void;
  editView: (key: string, personal: boolean) => void;
  moveTo: (id: string) => void;
  openSettings: () => void;
  openShare: () => void;
}

type Src = { kind: "placed"; scope: Scope; loc: number[]; label: string } | { kind: "generated"; id: string; label: string };
type Pos = "before" | "after" | "inside" | "inside-start";
interface Target {
  scope: Scope;
  loc: number[] | null; // null: the end of the scope's root list
  pos: Pos;
  ok: boolean;
  msg: string;
  rowKey: string;
}

const SCOPE_NAME: Record<Scope, string> = { workspace: "Workspace", personal: "Personal" };

export function Sidebar(props: Props) {
  const { app, current, online, status, openRecord, openGroup, openView, newPage, newInside, openSwitcher, saveSidebar } = props;
  const canWs = app.role === "owner" || app.role === "admin";
  const merged = app.sidebar.display === "merged";
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("surface.expanded") ?? "{}");
    } catch {
      return {};
    }
  });
  const [closedS, toggleS] = useClosedSections();
  const [drag, setDrag] = useState<{ src: Src; x: number; y: number; copy: boolean } | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ scope: Scope; loc: number[]; value: string } | null>(null);
  const suppressClick = useRef(false);
  const treeRef = useRef<HTMLElement>(null);

  useEffect(() => localStorage.setItem("surface.expanded", JSON.stringify(expanded)), [expanded]);
  const toggle = (k: string, dflt: boolean) => setExpanded((e) => ({ ...e, [k]: !(e[k] ?? dflt) }));

  const sb: Record<Scope, SidebarInfo> = app.sidebar;
  const canEdit = (s: Scope) => s === "personal" || canWs;

  // reveal the current record
  useEffect(() => {
    if (current?.kind !== "record") return;
    const found: string[] = [];
    const walk = (nodes: TreeNode[], path: string[]): boolean => {
      for (const n of nodes) {
        const p = [...path, n.id ?? n.view ?? n.label];
        if (n.kind === "record" && n.id === current.id) return true;
        if (walk(n.children, p)) {
          found.push(nodeKey(p));
          return true;
        }
      }
      return false;
    };
    for (const s of ["personal", "workspace"] as Scope[]) if (walk(sb[s].tree, [s])) break;
    if (found.length) setExpanded((e) => ({ ...e, ...Object.fromEntries(found.map((k) => [k, true])) }));
  }, [current, sb.workspace.tree, sb.personal.tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const refFor = (id: string) => {
    const r = app.records.find((x) => x.id === id);
    if (!r) return id;
    return app.records.filter((x) => x.title.toLowerCase() === r.title.toLowerCase()).length === 1 ? `[[${r.title}]]` : id;
  };

  // ---------------------------------------------------------------- drag
  const findTarget = (x: number, y: number, src: Src, copy: boolean): Target | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const section = el?.closest("[data-section]") as HTMLElement | null;
    const row = el?.closest("[data-row]") as HTMLElement | null;
    let scope: Scope, loc: number[] | null, pos: Pos, rowKey: string;
    let generatedFrom: string | null = null;
    if (row) {
      scope = row.dataset.scope as Scope;
      rowKey = row.dataset.key!;
      if (row.dataset.gen) generatedFrom = row.dataset.from || "a view";
      loc = row.dataset.loc ? row.dataset.loc.split(",").map(Number) : null;
      const b = row.getBoundingClientRect();
      const rel = (y - b.top) / b.height;
      const container = row.dataset.container === "1";
      const open = row.dataset.open === "1";
      if (container && rel > 0.28 && rel < 0.72) pos = "inside";
      else if (rel < 0.5) pos = "before";
      else pos = container && open ? "inside-start" : "after";
    } else if (section) {
      scope = section.dataset.section as Scope;
      loc = null;
      pos = "inside";
      rowKey = `section:${scope}`;
    } else return null;
    const verb = (() => {
      if (src.kind === "generated") return "Pin here";
      if (copy) return "Copy here";
      if (src.scope === scope) return "Move here";
      return canEdit(src.scope) ? `Move to ${SCOPE_NAME[scope]}` : `Copy to ${SCOPE_NAME[scope]}`;
    })();
    const no = (msg: string): Target => ({ scope, loc, pos, ok: false, msg, rowKey });
    if (generatedFrom) return no(`Listed by “${generatedFrom}”. Its place comes from the data.`);
    if (!canEdit(scope)) return no("Only owners and admins arrange the workspace sidebar");
    if (row && !loc) return no("Can't drop here");
    if (src.kind === "placed" && src.scope === scope && !copy && loc && isInside(loc, src.loc)) return no("Can't drop an entry into itself");
    return { scope, loc, pos, ok: true, msg: verb, rowKey };
  };

  const startDrag = (e: React.PointerEvent, src: Src) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    let last: Target | null = null;
    let copy = e.altKey;
    const moveH = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!started) document.body.classList.add("is-dragging-side");
      started = true;
      copy = ev.altKey;
      last = findTarget(ev.clientX, ev.clientY, src, copy);
      setDrag({ src, x: ev.clientX, y: ev.clientY, copy });
      setTarget(last);
      // scroll near the edges
      const t = treeRef.current?.getBoundingClientRect();
      if (t && treeRef.current) {
        if (ev.clientY < t.top + 28) treeRef.current.scrollTop -= 8;
        else if (ev.clientY > t.bottom - 28) treeRef.current.scrollTop += 8;
      }
    };
    const end = (commit: boolean) => {
      document.removeEventListener("pointermove", moveH);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("keydown", key);
      document.body.classList.remove("is-dragging-side");
      setDrag(null);
      setTarget(null);
      if (started) {
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 0);
      }
      if (commit && started && last?.ok) drop(src, last, copy);
    };
    const up = () => end(true);
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && end(false);
    document.addEventListener("pointermove", moveH);
    document.addEventListener("pointerup", up);
    document.addEventListener("keydown", key);
  };

  const whereOf = (t: Target): Where => {
    const def = sb[t.scope].definition;
    if (!t.loc) return { parent: [], index: def.items.length };
    if (t.pos === "inside") return { parent: t.loc, index: itemAt(def, t.loc)?.items?.length ?? 0 };
    if (t.pos === "inside-start") return { parent: t.loc, index: 0 };
    return { parent: t.loc.slice(0, -1), index: t.loc[t.loc.length - 1] + (t.pos === "after" ? 1 : 0) };
  };
  const placeName = (t: Target) => {
    if (!t.loc || t.pos === "before" || t.pos === "after") {
      const parent = t.loc ? t.loc.slice(0, -1) : [];
      return parent.length ? labelAt(sb[t.scope].definition, parent) : SCOPE_NAME[t.scope];
    }
    return labelAt(sb[t.scope].definition, t.loc);
  };
  const labelAt = (def: TreeDef, loc: number[]) => {
    const it = itemAt(def, loc);
    if (!it) return "there";
    if (it.group !== undefined) return it.group;
    if (it.label) return it.label;
    if (it.view) return app.views.find((v) => v.key === it.view)?.name ?? it.view;
    if (it.record) return it.record.replace(/^\[\[|\]\]$/g, "");
    return "there";
  };

  const drop = async (src: Src, t: Target, copy: boolean) => {
    const at = whereOf(t);
    const into = placeName(t);
    if (src.kind === "generated") {
      await saveSidebar([{ scope: t.scope, def: insert(sb[t.scope].definition, at, { record: refFor(src.id) }) }], `Pinned “${src.label}” to ${into}`);
      return;
    }
    const item = itemAt(sb[src.scope].definition, src.loc);
    if (!item) return;
    if (src.scope === t.scope && !copy) {
      await saveSidebar([{ scope: t.scope, def: move(sb[t.scope].definition, src.loc, at) }], `Moved “${src.label}” to ${into}`);
    } else if (copy || !canEdit(src.scope)) {
      await saveSidebar([{ scope: t.scope, def: insert(sb[t.scope].definition, at, structuredClone(item)) }], `Copied “${src.label}” to ${into}`);
    } else {
      await saveSidebar(
        [
          { scope: t.scope, def: insert(sb[t.scope].definition, at, structuredClone(item)) },
          { scope: src.scope, def: remove(sb[src.scope].definition, src.loc) },
        ],
        `Moved “${src.label}” to ${into}`,
      );
    }
  };

  // ---------------------------------------------------------------- menus
  const addTo = async (scope: Scope, loc: number[] | null, item: TreeItem, label: string) => {
    const def = sb[scope].definition;
    const at: Where = loc ? { parent: loc, index: itemAt(def, loc)?.items?.length ?? 0 } : { parent: [], index: def.items.length };
    await saveSidebar([{ scope, def: insert(def, at, item) }], label);
    // show what was just added
    const newLoc = [...at.parent, at.index].join(",");
    window.setTimeout(() => document.querySelector(`.node[data-scope="${scope}"][data-loc="${newLoc}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
  };
  const addMenu = (scope: Scope, loc: number[] | null, x: number, y: number): MenuItem[] => {
    const where = loc ? labelAt(sb[scope].definition, loc) : SCOPE_NAME[scope];
    const views = app.views.filter((v) => (scope === "workspace" ? !v.personal : true));
    return [
      {
        icon: "folder",
        label: "Folder",
        run: async () => {
          const def = sb[scope].definition;
          const newLoc = loc ? [...loc, itemAt(def, loc)?.items?.length ?? 0] : [def.items.length];
          await addTo(scope, loc, { group: "New folder", items: [] }, `Added a folder to ${where}`);
          setRenaming({ scope, loc: newLoc, value: "New folder" });
        },
      },
      { icon: "page", label: "Existing record…", run: () => props.pickRecord(`Add to ${where}`, (id) => addTo(scope, loc, { record: refFor(id) }, `Added “${app.records.find((r) => r.id === id)?.title}” to ${where}`)) },
      { sep: true },
      ...views.slice(0, 12).map((v) => ({
        icon: v.definition.layouts?.[0]?.show ?? "table",
        label: v.name,
        meta: v.personal ? "only you" : undefined,
        run: () => addTo(scope, loc, { view: v.key }, `Added the view “${v.name}” to ${where}`),
      })),
      { icon: "plus", label: "New view…", run: () => props.newView(scope, (v) => addTo(scope, loc, { view: v.key }, `Added the view “${v.name}” to ${where}`)) },
    ].map((m) => ({ ...m, x, y })) as MenuItem[];
  };
  const nodeMenu = (n: TreeNode, scope: Scope, generatedFrom: string | null, x: number, y: number) => {
    const items: MenuItem[] = [];
    if (n.kind === "record" && n.id) {
      items.push({ icon: "external", label: "Open", run: () => openRecord(n.id!) });
      items.push({ icon: "nest", label: "New page inside", run: () => newInside(n.id!) });
      items.push({ icon: "move", label: "Move to… (changes the record)", run: () => props.moveTo(n.id!) });
    }
    if (n.kind === "view" && n.view) {
      items.push({ icon: "external", label: "Open as a page", run: () => openView(n.view!, !!n.personal, n.thisId ?? null, n.label) });
      items.push({ icon: "sliders", label: "Edit view…", run: () => props.editView(n.view!, !!n.personal) });
    }
    if (!n.loc && n.kind === "record" && n.id) {
      items.push({ sep: true });
      items.push({ icon: "pin", label: "Pin to Personal", run: () => addTo("personal", null, { record: refFor(n.id!) }, `Pinned “${n.label}” to Personal`) });
      if (canWs) items.push({ icon: "pin", label: "Pin to Workspace", run: () => addTo("workspace", null, { record: refFor(n.id!) }, `Pinned “${n.label}” to Workspace`) });
      items.push({ note: `Listed by “${generatedFrom}”. Its place comes from the data.` });
    }
    if (n.loc && canEdit(scope)) {
      const def = sb[scope].definition;
      const it = itemAt(def, n.loc);
      items.push({ sep: true });
      if (it?.view !== undefined) {
        items.push({
          icon: it.unfold ? "external" : "list",
          label: it.unfold ? "Open as a page instead of listing" : "List its records in the sidebar",
          run: () => saveSidebar([{ scope, def: update(def, n.loc!, { unfold: it.unfold ? undefined : true }) }], it.unfold ? `“${n.label}” opens as a page` : `“${n.label}” lists its records`),
        });
      }
      if (it?.group !== undefined || it?.record !== undefined) items.push({ icon: "plus", label: "Add inside…", submenu: () => addMenu(scope, n.loc!, x, y) });
      if (it?.group !== undefined || it?.view !== undefined) items.push({ icon: "rename", label: "Rename", run: () => setRenaming({ scope, loc: n.loc!, value: n.label }) });
      items.push({ icon: "copy", label: "Duplicate", run: () => saveSidebar([{ scope, def: insert(def, { parent: n.loc!.slice(0, -1), index: n.loc![n.loc!.length - 1] + 1 }, structuredClone(it!)) }], `Duplicated “${n.label}”`) });
      const other: Scope = scope === "workspace" ? "personal" : "workspace";
      if (canEdit(other)) items.push({ icon: "copy", label: `Copy to ${SCOPE_NAME[other]}`, run: () => addTo(other, null, structuredClone(it!), `Copied “${n.label}” to ${SCOPE_NAME[other]}`) });
      items.push({ icon: "close", label: "Remove from sidebar", danger: true, run: () => saveSidebar([{ scope, def: remove(def, n.loc!) }], `Removed “${n.label}” from the sidebar`) });
      if (n.kind === "record" || n.kind === "view") items.push({ note: n.kind === "record" ? "Removing the entry doesn't delete the record." : "Removing the entry doesn't delete the view." });
    } else if (n.loc && !canEdit(scope)) {
      items.push({ sep: true });
      items.push({ icon: "copy", label: "Copy to Personal", run: () => addTo("personal", null, structuredClone(itemAt(sb[scope].definition, n.loc!)!), `Copied “${n.label}” to Personal`) });
    }
    setMenu({ x, y, items });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { scope, loc, value } = renaming;
    setRenaming(null);
    const def = sb[scope].definition;
    const it = itemAt(def, loc);
    if (!it || !value.trim()) return;
    if (it.group !== undefined && it.group !== value.trim()) await saveSidebar([{ scope, def: update(def, loc, { group: value.trim() }) }], `Renamed folder to “${value.trim()}”`);
    else if (it.view !== undefined) {
      const viewName = app.views.find((v) => v.key === it.view)?.name;
      const label = value.trim() === viewName ? undefined : value.trim();
      if (label !== it.label) await saveSidebar([{ scope, def: update(def, loc, { label }) }], `Renamed entry to “${value.trim()}”`);
    }
  };

  // ---------------------------------------------------------------- render
  const isSelected = (n: TreeNode, k: string) => {
    if (!current) return false;
    if (current.kind === "record") return n.kind === "record" && current.id === n.id;
    if (current.kind === "view") return n.kind === "view" && current.key === n.view && (current.thisId ?? null) === (n.thisId ?? null);
    return n.kind === "group" && current.key === k;
  };

  const render = (nodes: TreeNode[], scope: Scope, path: string[], depth: number, from: string | null): React.ReactNode =>
    nodes.map((n, i) => {
      const p = [...path, n.id ?? n.view ?? n.label];
      const k = nodeKey(p);
      const hasKids = n.children.length > 0;
      const isGroup = n.kind === "group";
      const placed = !!n.loc;
      const notFound = isGroup && n.label.endsWith("(not found)");
      const open = expanded[k] ?? (isGroup && depth === 0 && placed);
      const selected = isSelected(n, k);
      const item = placed ? itemAt(sb[scope].definition, n.loc!) : undefined;
      const container = placed && (item?.group !== undefined || item?.record !== undefined);
      const isTarget = target?.rowKey === k;
      const draggable = (placed && canEdit(scope)) || (placed && !canEdit(scope)) || (!placed && n.kind === "record");
      const icon = n.kind === "view" ? (n.unfold ? "list" : app.views.find((v) => v.key === n.view)?.definition.layouts?.[0]?.show ?? "table") : isGroup ? "folder" : typeIcon(n.type);
      const childFrom = n.kind === "view" ? n.label : item?.query ? n.label : from;
      const isRenaming = renaming && renaming.scope === scope && placed && renaming.loc.join(",") === n.loc!.join(",");
      return (
        <li key={`${k}:${i}`}>
          <div
            data-row=""
            data-key={k}
            data-scope={scope}
            data-loc={placed ? n.loc!.join(",") : undefined}
            data-gen={placed ? undefined : "1"}
            data-from={placed ? undefined : from ?? ""}
            data-container={container ? "1" : undefined}
            data-open={open && hasKids ? "1" : undefined}
            className={`node ${isGroup ? "is-group" : ""} ${n.kind === "view" ? "is-view" : ""} ${selected ? "is-selected" : ""} ${placed ? "is-placed" : "is-generated"} ${notFound ? "is-missing" : ""}`}
            style={{ paddingLeft: 4 + depth * 14 }}
            data-drop={isTarget ? (target!.ok ? target!.pos : "no") : undefined}
            data-dragging={drag && drag.src.kind === "placed" && placed && drag.src.scope === scope && drag.src.loc.join(",") === n.loc!.join(",") ? "" : drag && drag.src.kind === "generated" && !placed && drag.src.id === n.id ? "" : undefined}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button,input")) return;
              if (!draggable) return;
              startDrag(e, placed ? { kind: "placed", scope, loc: n.loc!, label: n.label } : { kind: "generated", id: n.id!, label: n.label });
            }}
            onClick={() => {
              if (suppressClick.current || isRenaming) return;
              if (n.kind === "view") openView(n.view!, !!n.personal, n.thisId ?? null, n.label);
              else if (isGroup) hasKids ? toggle(k, depth === 0 && placed) : openGroup(k);
              else openRecord(n.id!);
            }}
            onDoubleClick={() => {
              if (isGroup && !notFound) openGroup(k);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              nodeMenu(n, scope, from, e.clientX, e.clientY);
            }}
            title={placed ? undefined : `Listed by “${from}”`}
          >
            <button
              className={`twirl ${hasKids ? "" : "is-leaf"} ${open ? "is-open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasKids) toggle(k, isGroup && depth === 0 && placed);
              }}
              tabIndex={-1}
              aria-label={open ? "Collapse" : "Expand"}
            >
              {hasKids ? <Icon name="chevron" size={12} weight={2} /> : null}
            </button>
            <Icon name={icon} size={15} className="node-icon" />
            {isRenaming ? (
              <input
                className="node-rename"
                autoFocus
                value={renaming!.value}
                onChange={(e) => setRenaming({ ...renaming!, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={commitRename}
                onFocus={(e) => e.target.select()}
              />
            ) : (
              <span className="node-label">{n.label}</span>
            )}
            {isGroup && hasKids && !open ? <span className="node-count">{n.children.length}</span> : null}
            {n.kind === "record" && n.id ? (
              <button
                className="node-add"
                title="New page inside"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((x) => ({ ...x, [k]: true }));
                  newInside(n.id!);
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            ) : container && canEdit(scope) ? (
              <button
                className="node-add"
                title="Add inside"
                onClick={(e) => {
                  e.stopPropagation();
                  const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setExpanded((x) => ({ ...x, [k]: true }));
                  setMenu({ x: b.left, y: b.bottom + 4, items: addMenu(scope, n.loc!, b.left, b.bottom) });
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            ) : null}
            <button
              className="node-more"
              title="More"
              onClick={(e) => {
                e.stopPropagation();
                const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
                nodeMenu(n, scope, from, b.left, b.bottom + 4);
              }}
            >
              <Icon name="more" size={14} />
            </button>
          </div>
          {hasKids && open ? <ul style={{ "--guide": `${13 + depth * 14}px` } as React.CSSProperties}>{render(n.children, scope, p, depth + 1, childFrom)}</ul> : null}
        </li>
      );
    });

  const dropAt = (scope: Scope) => (target?.rowKey === `section:${scope}` ? (target.ok ? "inside" : "no") : undefined);
  const addButton = (scope: Scope, label: string) =>
    canEdit(scope) ? (
      <button
        className="section-add"
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: b.left, y: b.bottom + 4, items: addMenu(scope, null, b.left, b.bottom) });
        }}
      >
        <Icon name="plus" size={13} />
      </button>
    ) : null;
  const countOf = (scope: Scope) => sb[scope].tree.length;
  // the entries of one scope (no header)
  const body = (scope: Scope) => {
    const info = sb[scope];
    const empty = !info.tree.length;
    return (
      <div key={scope}>
        <ul>{render(info.tree, scope, [scope], 0, null)}</ul>
        {empty && (scope === "personal" ? !merged : !sb.personal.tree.length) ? (
          <div className="tree-hint" data-section={scope} data-drop={dropAt(scope)}>
            {scope === "personal" ? "Your own entries. Only you see them. Drag pages here, or use + to add folders and views." : "Arrange your own folders, pages and views here. Use + to add a view or a folder, or drag pages in."}
          </div>
        ) : null}
        {!empty ? <div className="section-tail" data-section={scope} data-drop={dropAt(scope)} /> : null}
      </div>
    );
  };
  // split display: Views (the workspace's) and Personal, each folding on its own
  const section = (scope: Scope) => {
    const key = scope === "workspace" ? "views" : "personal";
    const closed = !!closedS[key];
    return (
      <section className={`side-section ${closed ? "is-closed" : ""}`} key={scope}>
        <SectionHead name={scope === "workspace" ? "Views" : "Personal"} closed={closed} onToggle={() => toggleS(key)} count={countOf(scope)} section={scope} drop={dropAt(scope)}>
          {scope === "workspace" && !canWs ? (
            <span className="section-lock" title="Owners and admins arrange this section. Copy entries to Personal to arrange them yourself.">
              <Icon name="lock" size={11} />
            </span>
          ) : null}
          {addButton(scope, `Add to ${SCOPE_NAME[scope]}`)}
        </SectionHead>
        {!closed ? body(scope) : null}
      </section>
    );
  };

  // merged: one tree. Personal entries first when the user isn't an admin (their own things),
  // workspace entries first otherwise; no headers.
  const order: Scope[] = merged ? (canWs ? ["workspace", "personal"] : ["personal", "workspace"]) : ["workspace", "personal"];

  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="ws">
          <WorkspaceMenu app={app} />
          <button className="icon-btn ws-btn" title="Share" onClick={props.openShare}>
            <Icon name="people" size={15} />
          </button>
          <button className="icon-btn ws-btn" title="Settings" onClick={props.openSettings}>
            <Icon name="settings" size={15} />
          </button>
        </div>
        <SyncBadge className="side-sync" onOpenRecord={openRecord} serverOnline={online} />
        <button className="search-btn" onClick={openSwitcher}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="tree" ref={treeRef}>
        <VaultSection app={app} current={current} openRecord={openRecord} closed={!!closedS.vault} onToggle={() => toggleS("vault")} />
        {merged ? (
          <section className={`side-section ${closedS.views ? "is-closed" : ""}`}>
            <SectionHead name="Views" closed={!!closedS.views} onToggle={() => toggleS("views")} count={countOf("workspace") + countOf("personal")} section={canWs ? "workspace" : "personal"} drop={dropAt(canWs ? "workspace" : "personal")} title="Your own arrangement: folders, pages and views">
              {addButton(canWs ? "workspace" : "personal", "Add a folder, page or view")}
            </SectionHead>
            {!closedS.views ? order.map(body) : null}
          </section>
        ) : (
          order.map(section)
        )}
      </nav>
      <div className="side-bottom">
        <button className="new-btn" onClick={newPage}>
          <Icon name="plus" size={15} /> New page
        </button>
        {online ? (
          <span className="sync" title={`Your edits are saved to this computer's database (${app.root})`}>
            <span className="dot" />
            {status}
          </span>
        ) : null}
      </div>
      {drag ? (
        <div className={`drag-tag ${target && !target.ok ? "is-no" : ""}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
          <span className="drag-tag-label">{drag.src.label}</span>
          <span className="drag-tag-msg">{target ? target.msg : drag.src.kind === "generated" ? "Drop on your entries to pin" : "Drop to place"}</span>
        </div>
      ) : null}
      {menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null}
    </aside>
  );
}

// ------------------------------------------------------------------ menu
export interface MenuItem {
  icon?: string;
  label?: string;
  meta?: string;
  danger?: boolean;
  sep?: boolean;
  note?: string;
  run?: () => void | Promise<void>;
  submenu?: () => MenuItem[];
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const [list, setList] = useState(items);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => setList(items), [items]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - b.width - 8), y: y + b.height > window.innerHeight - 8 ? Math.max(8, y - b.height - 8) : y });
  }, [x, y, list]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.setTimeout(() => document.addEventListener("mousedown", h), 0);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [onClose]);
  const shown = useMemo(() => list.filter((m, i) => !(m.sep && (i === 0 || list[i - 1]?.sep))), [list]);
  return (
    <div className="menu menu-fixed" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {shown.map((m, i) =>
        m.sep ? (
          <div key={i} className="menu-sep" />
        ) : m.note ? (
          <div key={i} className="menu-note">{m.note}</div>
        ) : (
          <button
            key={i}
            className={`menu-item ${m.danger ? "danger" : ""}`}
            onClick={() => {
              if (m.submenu) return setList(m.submenu());
              onClose();
              m.run?.();
            }}
          >
            {m.icon ? <Icon name={m.icon} size={14} /> : null}
            <span className="menu-label">{m.label}</span>
            {m.meta ? <span className="menu-meta">{m.meta}</span> : null}
            {m.submenu ? <Icon name="chevron" size={12} weight={2} /> : null}
          </button>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ workspace switcher
function WorkspaceMenu({ app }: { app: AppState }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; role: string | null; current: boolean; checkout: string | null }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    api.workspaces().then((r) => setList(r.workspaces)).catch((e) => setErr(String(e.message ?? e)));
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);
  const go = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      const next = await api.switchWorkspace(id);
      location.assign(next.url ?? location.pathname);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <div className="ws-menu" ref={ref}>
      <button className="ws-switch" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Switch workspace">
        <div className="ws-mark">{app.workspace.name.slice(0, 1).toUpperCase()}</div>
        <div className="ws-text">
          <div className="ws-name">
            {app.workspace.name}
            <Icon name="chevron" size={11} className="ws-caret" />
          </div>
          <div className="ws-user">{app.workspace.home ? `${app.workspace.home === "cloud" ? "Cloud" : "Local"} · ` : ""}{app.user.email}</div>
        </div>
      </button>
      {open ? (
        <div className="menu ws-pop" role="menu">
          <div className="menu-label">Workspaces</div>
          {!list ? <div className="menu-note">Loading…</div> : null}
          {list?.map((w) => (
            <button key={w.id} role="menuitem" className={`menu-item ws-item ${w.current ? "is-on" : ""}`} disabled={!!busy} onClick={() => (w.current ? setOpen(false) : go(w.id))}>
              <span className="ws-mark sm">{w.name.slice(0, 1).toUpperCase()}</span>
              <span className="ws-item-text">
                <span>{w.name}</span>
                <small>{busy === w.id ? (w.checkout ? "Opening…" : "Downloading…") : w.checkout ? w.checkout.replace(/^\/Users\/[^/]+/, "~") : "Not on this computer yet"}</small>
              </span>
              {w.current ? <span className="tick">✓</span> : null}
            </button>
          ))}
          {err ? <div className="menu-note err">{err}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ vault
// The vault's folders exactly as they are on disk, the way Obsidian shows them: folders first,
// then notes, alphabetical. Read-only here (folders come from the files); the sections below
// are where custom views and arrangements go.
interface VNode {
  name: string;
  path: string;
  id?: string;
  type?: string;
  kids: VNode[];
}

function buildVault(records: AppState["records"]): VNode[] {
  const root: VNode = { name: "", path: "", kids: [] };
  for (const r of records) {
    if (!r.path) continue;
    const parts = r.path.split("/");
    let at = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = at.kids.find((k) => !k.id && k.path === p);
      if (!next) at.kids.push((next = { name: parts[i], path: p, kids: [] }));
      at = next;
    }
    at.kids.push({ name: parts[parts.length - 1].replace(/\.md$/i, ""), path: r.path, id: r.id, type: r.type, kids: [] });
  }
  const sort = (n: VNode) => {
    n.kids.sort((a, b) => Number(!!a.id) - Number(!!b.id) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    n.kids.forEach(sort);
  };
  sort(root);
  return root.kids;
}

function VaultSection({ app, current, openRecord, closed, onToggle }: { app: AppState; current: Route; openRecord: (id: string) => void; closed: boolean; onToggle: () => void }) {
  const tree = useMemo(() => buildVault(app.records), [app.records]);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("surface.vault.open") ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => localStorage.setItem("surface.vault.open", JSON.stringify(open)), [open]);
  // reveal the open note: unfold the folders above it
  useEffect(() => {
    if (current?.kind !== "record") return;
    const p = app.records.find((r) => r.id === current.id)?.path;
    if (!p || !p.includes("/")) return;
    const parts = p.split("/").slice(0, -1);
    setOpen((o) => ({ ...o, ...Object.fromEntries(parts.map((_, i) => [parts.slice(0, i + 1).join("/"), true])) }));
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tree.length) return null;

  const count = (n: VNode): number => n.kids.reduce((s, k) => s + (k.id ? 1 : count(k)), 0);
  const render = (nodes: VNode[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      const folder = !n.id;
      const isOpen = !!open[n.path];
      const selected = !folder && current?.kind === "record" && current.id === n.id;
      return (
        <li key={n.path}>
          <div
            className={`node ${folder ? "is-group" : ""} ${selected ? "is-selected" : ""}`}
            style={{ paddingLeft: 4 + depth * 14 }}
            title={n.path}
            onClick={() => (folder ? setOpen((o) => ({ ...o, [n.path]: !isOpen })) : openRecord(n.id!))}
          >
            <span className={`twirl ${folder ? "" : "is-leaf"} ${isOpen ? "is-open" : ""}`}>{folder ? <Icon name="chevron" size={12} weight={2} /> : null}</span>
            <Icon name={folder ? "folder" : "page"} size={15} className="node-icon" />
            <span className="node-label">{n.name}</span>
            {folder && !isOpen ? <span className="node-count">{count(n)}</span> : null}
          </div>
          {folder && isOpen ? <ul className="tree-kids" style={{ "--guide": `${13 + depth * 14}px` } as React.CSSProperties}>{render(n.kids, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <section className={`side-section ${closed ? "is-closed" : ""}`}>
      <SectionHead name="Vault" closed={closed} onToggle={onToggle} count={app.records.filter((r) => r.path).length} title={`The folders in ${app.root}, as Obsidian and other editors see them`} />
      {!closed ? <ul>{render(tree, 0)}</ul> : null}
    </section>
  );
}

/** One header style for every sidebar section: chevron, name, count when folded, actions on hover. */
function SectionHead({ name, closed, onToggle, count, title, children, drop, section }: { name: string; closed: boolean; onToggle: () => void; count?: number; title?: string; children?: React.ReactNode; drop?: string; section?: string }) {
  return (
    <div className="section-head" onClick={onToggle} title={title} role="button" aria-expanded={!closed} data-section={section} data-drop={drop}>
      <span className={`section-chev ${closed ? "" : "is-open"}`}>
        <Icon name="chevron" size={12} weight={2} />
      </span>
      <span className="section-name">{name}</span>
      {closed && count ? <span className="section-count">{count}</span> : null}
      {children}
    </div>
  );
}

/** Folded sections, remembered per browser (vault, workspace, personal). */
function useClosedSections() {
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("surface.sections.closed") ?? "{}");
      if (localStorage.getItem("surface.vault.closed") === "1") saved.vault = true; // earlier setting
      return saved;
    } catch {
      return {};
    }
  });
  useEffect(() => localStorage.setItem("surface.sections.closed", JSON.stringify(closed)), [closed]);
  return [closed, (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }))] as const;
}
