// Airtable-style Group and Sort panels for the Surface Data toolbar.
// Both edit the view definition in place (unsaved until "Save changes"/"Save as view"):
//   group → the table layout's `group` ("status,-due": up to three levels, "-" = descending)
//   sort  → the view's `sort`        ("status,-due": any number of levels)
import { useEffect, useRef } from "react";
import type { SortColumn } from "react-data-grid";
import type { FieldDef, Kind, TypeInfo } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { MAX_GROUP_LEVELS, parseGroup, parseSort, sortString } from "./Grid.tsx";

// Airtable's direction words per field kind
function directionLabels(kind: Kind | "title"): [string, string] {
  if (kind === "number") return ["1 → 9", "9 → 1"];
  if (kind === "date") return ["First → Last", "Last → First"];
  if (kind === "checkbox") return ["Unchecked → Checked", "Checked → Unchecked"];
  if (kind === "select" || kind === "multi_select") return ["First → Last", "Last → First"];
  return ["A → Z", "Z → A"];
}

function usePopover(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const target = e.target as Element;
      if (ref.current && !ref.current.contains(target) && !target.closest?.("[data-popover-toggle]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  return ref;
}

function LevelList({ title, empty, levels, choices, max, kindOf, onChange, addLabel, footer }: {
  title: string; empty: string; levels: SortColumn[]; choices: { key: string; name: string }[]; max?: number;
  kindOf: (key: string) => Kind | "title"; onChange: (levels: SortColumn[]) => void; addLabel: string; footer?: React.ReactNode;
}) {
  const used = new Set(levels.map((l) => l.columnKey));
  const free = choices.filter((c) => !used.has(c.key));
  const set = (i: number, patch: Partial<SortColumn>) => onChange(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) => { const n = [...levels]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  return <>
    <div className="data-pop-head">{title}</div>
    {!levels.length && <p className="data-pop-empty">{empty}</p>}
    {levels.map((l, i) => {
      const [asc, desc] = directionLabels(kindOf(l.columnKey));
      const name = choices.find((c) => c.key === l.columnKey)?.name ?? l.columnKey;
      return <div className="data-pop-level" key={l.columnKey}>
        <span className="data-pop-level-label">{i === 0 ? (max ? "Group by" : "Sort by") : max ? "then by" : "then by"}</span>
        <select aria-label={`${max ? "Group" : "Sort"} level ${i + 1} field`} value={l.columnKey} onChange={(e) => set(i, { columnKey: e.target.value })}>
          <option value={l.columnKey}>{name}</option>
          {free.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
        <select aria-label={`${max ? "Group" : "Sort"} level ${i + 1} direction`} value={l.direction} onChange={(e) => set(i, { direction: e.target.value as SortColumn["direction"] })}>
          <option value="ASC">{asc}</option>
          <option value="DESC">{desc}</option>
        </select>
        <span className="data-pop-level-tools">
          <button type="button" className="icon-btn" disabled={i === 0} aria-label={`Move ${name} up`} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="icon-btn" disabled={i === levels.length - 1} aria-label={`Move ${name} down`} onClick={() => move(i, 1)}>↓</button>
          <button type="button" className="icon-btn" aria-label={`Remove ${name}`} onClick={() => onChange(levels.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
        </span>
      </div>;
    })}
    {(!max || levels.length < max) && free.length > 0 && (
      <label className="data-pop-add">
        <Icon name="plus" size={13} />
        <select aria-label={addLabel} value="" onChange={(e) => e.target.value && onChange([...levels, { columnKey: e.target.value, direction: "ASC" }])}>
          <option value="">{addLabel}</option>
          {free.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
      </label>
    )}
    {footer}
  </>;
}

export function GroupPanel({ type, group, onChange, onCollapseAll, onExpandAll, onClose }: {
  type: TypeInfo; group: string | undefined; onChange: (group: string | undefined) => void; onCollapseAll: () => void; onExpandAll: () => void; onClose: () => void;
}) {
  const ref = usePopover(onClose);
  // Airtable groups by most field types; long free text makes poor groups, so it is still allowed but listed last
  const choices = [...type.fields].sort((a, b) => rank(a) - rank(b)).map((f) => ({ key: f.key, name: f.name }));
  const levels = parseGroup(group).filter((l) => type.fields.some((f) => f.key === l.columnKey));
  return <div className="menu data-pop" ref={ref} role="dialog" aria-label="Group records">
    <LevelList title="Group records" empty="Group rows that share a value, like every task with the same status. Add up to three levels."
      levels={levels} choices={choices} max={MAX_GROUP_LEVELS} kindOf={(k) => type.fields.find((f) => f.key === k)?.kind ?? "text"}
      onChange={(l) => onChange(sortString(l) ?? undefined)} addLabel={levels.length ? "Add subgroup" : "Pick a field to group by"}
      footer={levels.length ? <div className="data-pop-foot"><button type="button" onClick={onCollapseAll}>Collapse all</button><button type="button" onClick={onExpandAll}>Expand all</button></div> : null} />
  </div>;
}

export function SortPanel({ type, sort, onChange, onClose }: { type: TypeInfo; sort: string | undefined; onChange: (sort: string | undefined) => void; onClose: () => void }) {
  const ref = usePopover(onClose);
  const choices = [{ key: "title", name: "Title" }, ...type.fields.map((f) => ({ key: f.key, name: f.name }))];
  const levels = parseSort(sort).filter((l) => choices.some((c) => c.key === l.columnKey));
  return <div className="menu data-pop" ref={ref} role="dialog" aria-label="Sort records">
    <LevelList title="Sort records" empty="No sort yet. Records appear in the order they were added."
      levels={levels} choices={choices} kindOf={(k) => (k === "title" ? "title" : type.fields.find((f) => f.key === k)?.kind ?? "text")}
      onChange={(l) => onChange(sortString(l) ?? undefined)} addLabel={levels.length ? "Add another sort" : "Pick a field to sort by"} />
  </div>;
}

function rank(f: FieldDef) {
  return { select: 0, checkbox: 1, link: 2, multi_select: 3, date: 4, number: 5, text: 6, email: 7, phone: 7, url: 8 }[f.kind] ?? 9;
}
