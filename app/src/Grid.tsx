// The table layout: an editable grid (React Data Grid) over a saved view.
//
// What it does is defined by the view (CLI first): `columns` (order), `widths`, `frozen`,
// `group`, `rows` (height) and the view's `sort` all live in the view definition, so an agent
// editing .surface/views/<key>.yaml gets the same grid. Edits go through the normal save path
// (validation, revisions, undo); several at once (paste, fill) are reported together.
// RDG uses iterator helpers that are absent in Safari 17. Syntax transpilation
// alone cannot supply these runtime methods.
import "core-js/actual/iterator/map.js";
import "core-js/actual/iterator/to-array.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DataGrid, TreeDataGrid, SelectColumn, type Column, type RenderEditCellProps, type RowsChangeData, type SortColumn } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import type { AppState, FieldDef, LayoutDef, RecordFull, TypeInfo } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { Pill } from "./Properties.tsx";
import { PhoneEditor } from "./PhoneEditor.tsx";
import { phoneText } from "../../cli/src/phone.ts";
import { CellView } from "./ViewPage.tsx";

export type LayoutPatch = { layout?: Partial<LayoutDef>; sort?: string | null };
export type Change = { rec: RecordFull; title?: string; fields?: Record<string, unknown> };

const ROW_H = { compact: 30, normal: 36, tall: 52 } as const;
const TEXTY = new Set(["text", "number", "email", "url"]);

interface Props {
  app: AppState;
  type: TypeInfo;
  layout: LayoutDef;
  sort: string | undefined;
  rows: RecordFull[];
  readOnly: boolean;
  embedded?: boolean;
  open: (id: string) => void;
  onLayout: (p: LayoutPatch) => void;
  onChanges: (changes: Change[]) => void;
  onDelete: (ids: string[]) => void;
  addRow?: () => void;
  /** a new object collapses or expands every group */
  groupCommand?: { action: "collapse" | "expand" };
}

// ------------------------------------------------------------------ values as text
function titleOf(app: AppState, id: string) {
  return app.records.find((r) => r.id === id)?.title ?? id;
}
export function textOf(app: AppState, f: FieldDef | undefined, rec: RecordFull): string {
  if (!f) return rec.title;
  const v = rec.fields[f.key];
  if (v == null || v === "") return "";
  if (f.kind === "phone") return phoneText(v).replace(/\n/g, "; ");
  if (f.kind === "checkbox") return v ? "true" : "false";
  if (f.kind === "link") return (Array.isArray(v) ? v : [v]).map((id) => titleOf(app, String(id))).join(", ");
  return Array.isArray(v) ? v.join(", ") : String(v);
}
/** Pasted text → a value for the field. The server still validates and normalizes it. */
function fromText(app: AppState, f: FieldDef, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (f.kind === "checkbox") return /^(true|yes|y|x|✓|1|checked|on)$/i.test(t);
  if (f.kind === "multi_select") return t.split(/\s*[,;\n]\s*/).filter(Boolean);
  if (f.kind === "link") {
    const ids = t.split(/\s*[,;\n]\s*/).filter(Boolean).map((name) => app.records.find((r) => (!f.target || r.type === f.target) && (r.title.toLowerCase() === name.toLowerCase() || r.id === name))?.id ?? name);
    return f.multiple ? ids : ids[0];
  }
  return t;
}

// ------------------------------------------------------------------ sorting (same order as the CLI)
export function parseSort(s: string | undefined | null): SortColumn[] {
  return (s ?? "").split(",").map((k) => k.trim()).filter(Boolean).map((k) => ({ columnKey: k.replace(/^-/, ""), direction: k.startsWith("-") ? "DESC" : "ASC" }));
}
export const sortString = (cols: readonly SortColumn[]) => cols.map((c) => (c.direction === "DESC" ? "-" : "") + c.columnKey).join(",") || null;

// ------------------------------------------------------------------ grouping
// `group` in a table layout is one field key or up to three separated by commas (outer first);
// a leading "-" orders that level's groups descending. Same shape as `sort`.
export const MAX_GROUP_LEVELS = 3;
export function parseGroup(s: string | undefined | null): SortColumn[] {
  return parseSort(s).slice(0, MAX_GROUP_LEVELS);
}

function sortRows(app: AppState, type: TypeInfo, rows: RecordFull[], cols: readonly SortColumn[]) {
  if (!cols.length) return rows;
  const val = (r: RecordFull, k: string): string | number | null => {
    if (k === "title") return r.title.toLowerCase();
    const f = type.fields.find((x) => x.key === k);
    const v = r.fields[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
    if (f?.kind === "select" && f.options?.includes(String(v))) return f.options.indexOf(String(v));
    if (f?.kind === "checkbox") return v ? 1 : 0;
    if (typeof v === "number") return v;
    return textOf(app, f, r).toLowerCase();
  };
  return [...rows].sort((a, b) => {
    for (const c of cols) {
      const x = val(a, c.columnKey), y = val(b, c.columnKey);
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * (c.direction === "DESC" ? -1 : 1);
    }
    return 0;
  });
}

// ------------------------------------------------------------------ editors
function TextEditor({ row, column, onRowChange, onClose, f }: RenderEditCellProps<RecordFull> & { f?: FieldDef }) {
  const value = f ? row.fields[f.key] : row.title;
  return (
    <input
      className="sg-input"
      autoFocus
      type={f?.kind === "date" ? "date" : "text"}
      inputMode={f?.kind === "number" ? "decimal" : f?.kind === "email" ? "email" : undefined}
      value={value == null ? "" : String(value)}
      ref={(el) => {
        if (el && f?.kind !== "date" && el.dataset.sel !== "1") {
          el.dataset.sel = "1";
          el.select();
        }
      }}
      onChange={(e) => {
        const v = e.target.value;
        onRowChange(f ? { ...row, fields: { ...row.fields, [f.key]: v === "" ? null : v } } : { ...row, title: v });
      }}
      onBlur={() => onClose(true, false)}
      aria-label={String(column.name)}
    />
  );
}

export function PhoneGridEditor({ row, onRowChange, onClose, f }: RenderEditCellProps<RecordFull> & { f: FieldDef }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const bounds = anchor.current?.closest(".rdg-cell")?.getBoundingClientRect();
    if (bounds) setPos({
      left: Math.max(8, Math.min(bounds.left, window.innerWidth - 428)),
      top: Math.max(8, Math.min(bounds.bottom + 2, window.innerHeight - 280)),
      width: Math.min(Math.max(bounds.width, 360), window.innerWidth - 16),
    });
  }, []);
  return <div ref={anchor} className="sg-choice">
    {pos ? createPortal(
      <div className="menu sg-menu sg-phone-menu" style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, maxHeight: Math.max(120, window.innerHeight - pos.top - 8) }} onMouseDown={event => event.stopPropagation()}>
        <PhoneEditor
          autoFocus
          value={row.fields[f.key]}
          onChange={(value, finish) => onRowChange({ ...row, fields: { ...row.fields, [f.key]: value } }, finish)}
          onCancel={() => onClose(false)}
        />
      </div>,
      document.body,
    ) : null}
  </div>;
}

/** Select, multi-select and link editing: a menu under the cell, typed to filter. */
function ChoiceEditor({ app, f, row, onRowChange, onClose }: RenderEditCellProps<RecordFull> & { app: AppState; f: FieldDef }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const multiple = f.kind === "multi_select" || (f.kind === "link" && !!f.multiple);
  const raw = row.fields[f.key];
  const selected = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);
  useEffect(() => {
    const r = anchor.current?.closest(".rdg-cell")?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 220) });
  }, []);
  const all = f.kind === "link" ? app.records.filter((r) => !f.target || r.type === f.target).map((r) => ({ id: r.id, label: r.title, meta: r.type })) : (f.options ?? []).map((o) => ({ id: o, label: o, meta: "" }));
  const term = q.trim().toLowerCase();
  const items = all.filter((x) => !term || x.label.toLowerCase().includes(term)).slice(0, 50);
  const set = (ids: string[], commit: boolean) => {
    const v = multiple ? ids : ids[0] ?? null;
    onRowChange({ ...row, fields: { ...row.fields, [f.key]: v } }, commit);
  };
  const choose = (id: string) => {
    if (multiple) set(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], false);
    else set(selected[0] === id ? [] : [id], true);
  };
  return (
    <div ref={anchor} className="sg-choice">
      {selected.map((id) => (f.kind === "link" ? <span key={id} className="cell-link">{titleOf(app, id)}</span> : <Pill key={id} label={id} />))}
      {pos
        ? createPortal(
            <div className="menu menu-search sg-menu" style={{ position: "fixed", left: pos.left, top: pos.top, minWidth: pos.width }} onMouseDown={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className="menu-input"
                placeholder={f.kind === "link" ? `Link a ${f.target ?? "record"}…` : "Find an option…"}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setHi(0);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, items.length - 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
                  else if (e.key === "Enter") {
                    e.preventDefault();
                    if (items[hi]) choose(items[hi].id);
                    else if (multiple) onClose(true);
                  } else if (e.key === "Escape" || e.key === "Tab") {
                    e.preventDefault();
                    onClose(multiple, true); // multi-choice keeps what was toggled
                  } else if (e.key === "Backspace" && !q && selected.length) set(selected.slice(0, -1), !multiple);
                }}
              />
              {items.map((x, i) => (
                <button key={x.id} className={`menu-item ${selected.includes(x.id) ? "is-on" : ""} ${i === hi ? "is-hi" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => choose(x.id)}>
                  {f.kind === "link" ? x.label : <Pill label={x.label} />}
                  {x.meta ? <span className="menu-meta">{x.meta}</span> : null}
                  {selected.includes(x.id) ? <span className="tick">✓</span> : null}
                </button>
              ))}
              {!items.length ? <div className="menu-empty">No matches</div> : null}
              {selected.length ? (
                <button className="menu-item sg-clear" onClick={() => set([], true)}>
                  Clear
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ------------------------------------------------------------------ the grid
/** TreeDataGrid's group rows are plain objects with childRows; records have an id and fields. */
const GROUP_PREFIX = "__group:";
const isGroupRow = (r: unknown) => !!r && typeof r === "object" && "childRows" in (r as object) && "groupKey" in (r as object);

export function Grid({ app, type, layout, sort, rows, readOnly, embedded, open, onLayout, onChanges, onDelete, addRow, groupCommand }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    // Update the grid's own column model, including virtualization and keyboard
    // scroll padding, rather than merely undoing sticky positioning with CSS.
    const measure = () => setNarrow(element.clientWidth <= 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fieldOf = (key: string) => type.fields.find((f) => f.key === key);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<unknown>>(() => new Set());
  const groupLevels = useMemo(() => parseGroup(layout.group).filter((g) => type.fields.some((f) => f.key === g.columnKey)), [layout.group, type.fields]);
  const groupKeys = useMemo(() => groupLevels.map((g) => g.columnKey), [groupLevels]);
  const widthTimer = useRef<number | null>(null);
  const pendingWidths = useRef<Record<string, number>>({});
  const sortColumns = useMemo(() => parseSort(sort), [sort]);
  const rowH = ROW_H[layout.rows ?? "normal"];

  const fields = useMemo(() => {
    const keys = layout.columns?.length ? layout.columns : type.fields.slice(0, 6).map((f) => f.key);
    return keys.map((k) => type.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f);
  }, [layout.columns, type.fields]);

  const columns = useMemo<Column<RecordFull>[]>(() => {
    const w = layout.widths ?? {};
    const frozen = narrow ? 0 : layout.frozen ?? 0;
    const title: Column<RecordFull> = {
      key: "title",
      name: "Title",
      frozen: !narrow,
      resizable: true,
      sortable: true,
      width: w.title ?? 260,
      minWidth: 120,
      editable: !readOnly,
      renderCell: ({ row }) => (
        <span className="sg-title-inner">
          <span className="sg-title-text">{row.title || "Untitled"}</span>
          <button
            className="sg-open"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              open(row.id);
            }}
            title="Open (Space)"
          >
            Open
          </button>
        </span>
      ),
      renderEditCell: (p) => <TextEditor {...p} />,
      // grouped tables: the group header is drawn here and its text runs across the row (CSS), so
      // record cells keep their columns
      cellClass: "sg-title",
      renderGroupCell: ({ groupKey, childRows, isExpanded, toggleGroup, row }) => {
        const level = (row as unknown as { level: number }).level ?? 0;
        const f = fieldOf(groupKeys[level]);
        return (
          <button className="sg-group" onClick={toggleGroup} tabIndex={-1} style={{ paddingInlineStart: level * 18 }}>
            <span className={`sg-chev ${isExpanded ? "is-open" : ""}`}>
              <Icon name="chevron" size={12} />
            </span>
            <span className="sg-group-field">{f?.name}</span>
            {groupKey === "" ? <span className="empty">No {f?.name.toLowerCase()}</span> : f?.kind === "select" || f?.kind === "multi_select" ? <Pill label={String(groupKey)} /> : <span className="sg-group-key">{String(groupKey)}</span>}
            <span className="sg-group-count">{childRows.length}</span>
          </button>
        );
      },
    };
    const cols: Column<RecordFull>[] = fields.map((f, i) => ({
      key: f.key,
      name: f.name,
      resizable: true,
      sortable: true,
      draggable: !readOnly,
      frozen: i < frozen,
      width: w[f.key] ?? (f.kind === "checkbox" ? 90 : f.kind === "date" || f.kind === "number" ? 130 : 170),
      minWidth: 60,
      editable: !readOnly && f.kind !== "checkbox",
      cellClass: `sg-cell sgk-${f.kind}`,
      headerCellClass: `sgh-${f.kind}`,
      editorOptions: { displayCellContent: false, ...(f.kind === "phone" ? { commitOnOutsideClick: false } : {}) },
      renderCell: ({ row }) =>
        f.kind === "checkbox" ? (
          <button
            className={`check ${row.fields[f.key] ? "on" : ""}`}
            tabIndex={-1}
            disabled={readOnly}
            aria-label={f.name}
            onClick={(e) => {
              e.stopPropagation();
              onChanges([{ rec: row, fields: { [f.key]: !row.fields[f.key] } }]);
            }}
          >
            {row.fields[f.key] ? (
              <svg viewBox="0 0 16 16" width="12" height="12">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        ) : (
          <CellView app={app} f={f} v={row.fields[f.key]} />
        ),
      renderEditCell: (p) => (f.kind === "phone" ? <PhoneGridEditor {...p} f={f} /> : TEXTY.has(f.kind) || f.kind === "date" ? <TextEditor {...p} f={f} /> : <ChoiceEditor {...p} app={app} f={f} />),
    }));
    // TreeDataGrid moves grouped columns to the front and freezes them. Group by zero-width stand-in
    // columns instead, so the real columns stay where they are.
    const groupCols: Column<RecordFull>[] = groupKeys.map((k) => ({
      key: GROUP_PREFIX + k, name: "", width: 0, minWidth: 0, maxWidth: 0, resizable: false, sortable: false, editable: false,
      cellClass: "sg-groupcol", headerCellClass: "sg-groupcol", renderCell: () => null, renderGroupCell: () => null,
    }));
    return readOnly ? [...groupCols, title, ...cols] : [{ ...SelectColumn, frozen: !narrow }, ...groupCols, title, ...cols];
  }, [fields, layout.widths, layout.frozen, groupKeys, readOnly, narrow, app, open, onChanges]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => sortRows(app, type, rows, sortColumns), [app, type, rows, sortColumns]);

  // edits from typing, menus, paste and fill all arrive here
  const onRowsChange = (next: RecordFull[], data: RowsChangeData<RecordFull>) => {
    const changes: Change[] = [];
    for (const i of data.indexes) {
      const n = next[i];
      const old = rowsById.get(n.id);
      if (!old) continue;
      if (data.column.key === "title") {
        if (n.title.trim() && n.title !== old.title) changes.push({ rec: old, title: n.title.trim() });
      } else {
        const k = data.column.key;
        if (JSON.stringify(n.fields[k] ?? null) !== JSON.stringify(old.fields[k] ?? null)) changes.push({ rec: old, fields: { [k]: n.fields[k] ?? null } });
      }
    }
    if (changes.length) onChanges(changes);
  };
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const common = {
    columns,
    rowKeyGetter: (r: RecordFull) => r.id,
    rowHeight: rowH,
    headerRowHeight: 34,
    className: `surface-grid sg-rows-${layout.rows ?? "normal"} ${readOnly ? "is-readonly" : ""}`,
    sortColumns,
    onSortColumnsChange: (cols: SortColumn[]) => onLayout({ sort: sortString(cols) }),
    selectedRows: readOnly ? undefined : selected,
    onSelectedRowsChange: readOnly ? undefined : (s: Set<string>) => setSelected(s),
    onRowsChange: readOnly ? undefined : onRowsChange,
    onColumnResize: (col: { key: string }, width: number) => {
      pendingWidths.current[col.key] = Math.round(width);
      if (widthTimer.current) window.clearTimeout(widthTimer.current);
      widthTimer.current = window.setTimeout(() => {
        onLayout({ layout: { widths: { ...(layout.widths ?? {}), ...pendingWidths.current } } });
        pendingWidths.current = {};
      }, 500);
    },
    onColumnsReorder: (source: string, target: string) => {
      const keys = fields.map((f) => f.key);
      const from = keys.indexOf(source), to = keys.indexOf(target);
      if (from < 0 || to < 0) return;
      keys.splice(to, 0, ...keys.splice(from, 1));
      onLayout({ layout: { columns: keys } });
    },
    onCellCopy: ({ row, column }: { row: RecordFull; column: { key: string } }, e: React.ClipboardEvent) => {
      if (column.key === "rdg-select-column") return;
      e.clipboardData.setData("text/plain", textOf(app, column.key === "title" ? undefined : fieldOf(column.key), row));
      e.preventDefault();
    },
    onCellPaste: ({ row, column }: { row: RecordFull; column: { key: string } }, e: React.ClipboardEvent) => {
      const text = e.clipboardData.getData("text/plain");
      if (readOnly || column.key === "rdg-select-column" || !text) return row;
      if (column.key === "title") return { ...row, title: text.trim() || row.title };
      const f = fieldOf(column.key);
      return f ? { ...row, fields: { ...row.fields, [f.key]: fromText(app, f, text) } } : row;
    },
    onFill: readOnly
      ? undefined
      : ({ columnKey, sourceRow, targetRow }: { columnKey: string; sourceRow: RecordFull; targetRow: RecordFull }) =>
          columnKey === "title" ? targetRow : { ...targetRow, fields: { ...targetRow.fields, [columnKey]: sourceRow.fields[columnKey] ?? null } },
    onCellKeyDown: (args: { mode: string; row?: RecordFull; column?: { key: string } }, e: React.KeyboardEvent & { preventGridDefault: () => void }) => {
      if (args.mode === "EDIT" || !args.row || !args.column) return;
      const f = fieldOf(args.column.key);
      if (args.column.key === "title" && e.key === " ") {
        e.preventGridDefault();
        e.preventDefault();
        open(args.row.id);
      } else if (f?.kind === "checkbox" && !readOnly && (e.key === " " || e.key === "Enter")) {
        e.preventGridDefault();
        e.preventDefault();
        onChanges([{ rec: args.row, fields: { [f.key]: !args.row.fields[f.key] } }]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly && f && f.kind !== "checkbox") {
        e.preventGridDefault();
        e.preventDefault();
        onChanges([{ rec: args.row, fields: { [f.key]: null } }]);
      }
    },
  };

  // grouping: up to three levels; group order per level (select fields by option order,
  // checkboxes unchecked first, others A→Z; empty values last), records keep the view's sort inside
  const groupId = (k: string, parent?: string) => (parent !== undefined ? `${parent}__${k}` : k);
  const rowGrouper = (rs: readonly RecordFull[], groupColumn: string) => {
    const key = groupColumn.startsWith(GROUP_PREFIX) ? groupColumn.slice(GROUP_PREFIX.length) : groupColumn;
    const f = fieldOf(key);
    const desc = groupLevels.find((g) => g.columnKey === key)?.direction === "DESC";
    const buckets = new Map<string, RecordFull[]>();
    for (const r of rs) {
      const k = f ? textOf(app, f, r) : "";
      const list = buckets.get(k);
      if (list) list.push(r);
      else buckets.set(k, [r]);
    }
    const rank = (k: string): [number, string | number] => {
      if (f?.kind === "select" && f.options?.includes(k)) return [0, f.options.indexOf(k)];
      if (f?.kind === "number" && k !== "" && !Number.isNaN(Number(k))) return [0, Number(k)];
      return [0, k.toLowerCase()];
    };
    const keys = [...buckets.keys()].sort((a, b) => {
      if (a === b) return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      const [, x] = rank(a), [, y] = rank(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
    });
    const out: Record<string, RecordFull[]> = {};
    for (const k of keys) out[k] = buckets.get(k)!;
    return out;
  };
  // every group id at every level, for expand/collapse and sizing
  const allGroups = useMemo(() => {
    const ids = new Set<string>();
    const walk = (rs: readonly RecordFull[], level: number, parent?: string) => {
      if (level >= groupKeys.length) return;
      for (const [k, child] of Object.entries(rowGrouper(rs, groupKeys[level]))) {
        const id = groupId(k, parent);
        ids.add(id);
        walk(child, level + 1, id);
      }
    };
    walk(sorted, 0);
    return ids;
  }, [sorted, groupKeys, groupLevels]); // eslint-disable-line react-hooks/exhaustive-deps
  const expanded = useMemo(() => new Set([...allGroups].filter((g) => !collapsed.has(g))), [allGroups, collapsed]);
  useEffect(() => {
    if (!groupCommand) return;
    setCollapsed(groupCommand.action === "collapse" ? new Set(allGroups) : new Set());
  }, [groupCommand]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupField = groupKeys.length ? fieldOf(groupKeys[0]) : undefined;
  const groups = groupKeys.length ? allGroups.size : 0;
  const contentH = 34 + (sorted.length + groups) * rowH + 2;
  const style = { blockSize: Math.max(contentH, 34 + rowH + 2), maxBlockSize: embedded ? 460 : "calc(100vh - 230px)" };

  const removing = [...selected].filter((id) => rowsById.has(id));
  return (
    <div className="sg-wrap" ref={wrapper}>
      {removing.length ? (
        <div className="sg-selection">
          <span>{removing.length} selected</span>
          <button className="btn-soft" onClick={() => (onDelete(removing), setSelected(new Set()))}>
            <Icon name="trash" size={13} /> Delete
          </button>
          <button className="btn-soft" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
      {groupField ? (
        <TreeDataGrid
          {...common}
          rows={sorted}
          style={style}
          groupBy={groupKeys.map((k) => GROUP_PREFIX + k)}
          rowGrouper={rowGrouper}
          expandedGroupIds={expanded}
          onExpandedGroupIdsChange={(ids) => setCollapsed(new Set([...allGroups].filter((g) => !ids.has(g))))}
          groupIdGetter={groupId}
        />
      ) : (
        <DataGrid {...common} rows={sorted} style={style} />
      )}
      {!readOnly && addRow ? (
        <button className="row-add" onClick={() => addRow()}>
          <Icon name="plus" size={13} /> New {type.name.toLowerCase()}
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ display options (table only)
export function GridOptions({ type, layout, onLayout, onClose, hideGroup }: { type: TypeInfo; layout: LayoutDef; onLayout: (p: LayoutPatch) => void; onClose: () => void; hideGroup?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  const shown = layout.columns?.length ? layout.columns : type.fields.slice(0, 6).map((f) => f.key);
  const toggle = (k: string) => onLayout({ layout: { columns: shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k] } });
  const groupable = type.fields.filter((f) => ["select", "checkbox", "link", "text", "multi_select", "date"].includes(f.kind));
  return (
    <div className="menu sg-options" ref={ref}>
      <div className="sg-opt-head sg-opt-head-row">
        <span>Fields shown</span>
        {type.fields.some((f) => !shown.includes(f.key)) ? <button className="sg-opt-link" onClick={() => onLayout({ layout: { columns: type.fields.map((f) => f.key) } })}>Show all</button> : null}
      </div>
      {type.fields.map((f) => (
        <button key={f.key} className={`menu-item ${shown.includes(f.key) ? "is-on" : ""}`} onClick={() => toggle(f.key)}>
          {f.name}
          {shown.includes(f.key) ? <span className="tick">✓</span> : null}
        </button>
      ))}
      {hideGroup ? null : <>
      <div className="sg-opt-head">Group by</div>
      <select className="sg-select" value={parseGroup(layout.group)[0]?.columnKey ?? ""} onChange={(e) => onLayout({ layout: { group: e.target.value || undefined } })}>
        <option value="">None</option>
        {groupable.map((f) => (
          <option key={f.key} value={f.key}>
            {f.name}
          </option>
        ))}
      </select>
      </>}
      <div className="sg-opt-head">Keep in view</div>
      <select className="sg-select" value={layout.frozen ?? 0} onChange={(e) => onLayout({ layout: { frozen: Number(e.target.value) || undefined } })}>
        <option value={0}>Title only</option>
        {shown.slice(0, 4).map((k, i) => (
          <option key={k} value={i + 1}>
            Title + {type.fields.find((f) => f.key === k)?.name ?? k}
            {i ? ` (${i + 1} columns)` : ""}
          </option>
        ))}
      </select>
      <div className="sg-opt-head">Row height</div>
      <div className="sg-seg">
        {(["compact", "normal", "tall"] as const).map((h) => (
          <button key={h} className={(layout.rows ?? "normal") === h ? "is-on" : ""} onClick={() => onLayout({ layout: { rows: h === "normal" ? undefined : h } })}>
            {h[0].toUpperCase() + h.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
