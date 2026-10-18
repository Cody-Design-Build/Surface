import { useEffect, useRef, useState } from "react";
import type { FieldDef, Summary } from "./api.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  fields: FieldDef[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  records: Summary[];
  typeKeyOf: (id: string) => string | undefined;
  onChange: (key: string, value: unknown) => void;
  onOpen: (id: string) => void;
}

export function Properties({ fields, values, errors, records, onChange, onOpen }: Props) {
  if (!fields.length) return null;
  return (
    <div className="props">
      {fields.map((f) => (
        <div className={`prop ${errors[f.key] ? "has-error" : ""}`} key={f.id}>
          <div className="prop-label" title={f.key}>
            {f.name}
            {f.required ? <span className="req">*</span> : null}
          </div>
          <div className="prop-value">
            <Value f={f} value={values[f.key]} records={records} onChange={(v) => onChange(f.key, v)} onOpen={onOpen} />
            {errors[f.key] ? <div className="prop-error">{errors[f.key]}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Value({ f, value, records, onChange, onOpen }: { f: FieldDef; value: unknown; records: Summary[]; onChange: (v: unknown) => void; onOpen: (id: string) => void }) {
  switch (f.kind) {
    case "checkbox":
      return (
        <button type="button" className={`check ${value ? "on" : ""}`} onClick={() => onChange(!value)} aria-pressed={!!value}>
          {value ? <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
        </button>
      );
    case "select":
      return <SelectValue options={f.options ?? []} value={value == null ? [] : [String(value)]} multiple={false} onChange={(v) => onChange(v[0] ?? null)} />;
    case "multi_select":
      return <SelectValue options={f.options ?? []} value={Array.isArray(value) ? value.map(String) : []} multiple onChange={(v) => onChange(v)} />;
    case "date":
      return <input className="prop-input date" type="date" value={value ? String(value) : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "link":
      return <LinkValue f={f} value={value} records={records} onChange={onChange} onOpen={onOpen} />;
    default:
      return <TextValue f={f} value={value} onChange={onChange} />;
  }
}

function TextValue({ f, value, onChange }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value == null ? "" : String(value));
  }, [value]);
  const commit = () => {
    const cur = value == null ? "" : String(value);
    if (text !== cur) onChange(text === "" ? null : f.kind === "number" ? text : text);
  };
  const isUrl = f.kind === "url" && text;
  return (
    <span className="text-value">
      <input
        className="prop-input"
        value={text}
        placeholder="Empty"
        inputMode={f.kind === "number" ? "decimal" : f.kind === "email" ? "email" : f.kind === "phone" ? "tel" : undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Commit on blur only; never let Enter implicitly submit an enclosing form with a stale value.
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            setText(value == null ? "" : String(value));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {isUrl ? (
        <a className="prop-open" href={text} target="_blank" rel="noopener" title="Open">
          <Icon name="external" size={13} />
        </a>
      ) : null}
    </span>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [active, onOut, ref]);
}

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Pill({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="pill" style={{ "--h": hue(label) } as React.CSSProperties}>
      {label}
      {onRemove ? (
        <button type="button" className="pill-x" onClick={(e) => (e.stopPropagation(), onRemove())} aria-label={`Remove ${label}`}>
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  );
}

function SelectValue({ options, value, multiple, onChange }: { options: string[]; value: string[]; multiple: boolean; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const toggle = (o: string) => {
    if (!multiple) {
      onChange(value[0] === o ? [] : [o]);
      setOpen(false);
    } else onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  };
  return (
    <div className="select" ref={ref}>
      <button type="button" className="select-btn" onClick={() => setOpen(!open)}>
        {value.length ? value.map((v) => <Pill key={v} label={v} />) : <span className="empty">Empty</span>}
      </button>
      {open ? (
        <div className="menu">
          {options.map((o) => (
            <button type="button" key={o} className={`menu-item ${value.includes(o) ? "is-on" : ""}`} onClick={() => toggle(o)}>
              <Pill label={o} />
              {value.includes(o) ? <span className="tick">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LinkValue({ f, value, records, onChange, onOpen }: { f: FieldDef; value: unknown; records: Summary[]; onChange: (v: unknown) => void; onOpen: (id: string) => void }) {
  const ids = value == null ? [] : (Array.isArray(value) ? value : [value]).map(String);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const byId = new Map(records.map((r) => [r.id, r]));
  const candidates = records
    .filter((r) => (!f.target || r.type === f.target) && !ids.includes(r.id) && r.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 12);
  const set = (next: string[]) => onChange(f.multiple ? next : next[0] ?? null);
  return (
    <div className="links" ref={ref}>
      {ids.map((id) => (
        <span className="link-chip" key={id}>
          <button type="button" className="link-chip-label" onClick={() => onOpen(id)}>
            {byId.get(id)?.title ?? id}
          </button>
          <button type="button" className="pill-x" onClick={() => set(ids.filter((x) => x !== id))} aria-label="Remove link">
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {f.multiple || !ids.length ? (
        <button type="button" className="link-add" onClick={() => setOpen(true)}>
          {ids.length ? <Icon name="plus" size={12} /> : <span className="empty">Empty</span>}
        </button>
      ) : null}
      {open ? (
        <div className="menu menu-search">
          <input autoFocus className="menu-input" placeholder={`Link a ${f.target ?? "record"}…`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") e.preventDefault();
            if (e.key === "Enter" && candidates[0]) {
              set(f.multiple ? [...ids, candidates[0].id] : [candidates[0].id]);
              setOpen(false);
              setQ("");
            }
          }} />
          {candidates.map((r) => (
            <button type="button" key={r.id} className="menu-item" onClick={() => {
              set(f.multiple ? [...ids, r.id] : [r.id]);
              setOpen(false);
              setQ("");
            }}>
              {r.title}
              <span className="menu-meta">{r.type}</span>
            </button>
          ))}
          {!candidates.length ? <div className="menu-empty">No matches</div> : null}
        </div>
      ) : null}
    </div>
  );
}
