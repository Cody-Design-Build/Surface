// Surface Data schema dialogs, Airtable-style and generic:
// a new table starts empty (name only); every column is added as a field with an explicit
// field type. Relationships are just one field type ("Link to another record") whose
// target table is chosen when the field is created.
import { useState } from "react";
import { api, ApiError, type AppState, type FieldDef, type Kind, type TypeInfo } from "./api.ts";
import { Icon } from "./Icon.tsx";

export const FIELD_TYPES: { kind: Kind; label: string; hint: string }[] = [
  { kind: "text", label: "Single line text", hint: "A name, a short note, a code" },
  { kind: "number", label: "Number", hint: "Quantities, prices, measurements" },
  { kind: "select", label: "Single select", hint: "Pick one option from a list" },
  { kind: "multi_select", label: "Multiple select", hint: "Pick several options from a list" },
  { kind: "date", label: "Date", hint: "A calendar date" },
  { kind: "checkbox", label: "Checkbox", hint: "Yes or no" },
  { kind: "link", label: "Link to another record", hint: "Relate records in this table to records in another table" },
  { kind: "email", label: "Email", hint: "An email address" },
  { kind: "phone", label: "Phone number", hint: "Multiple numbers; first is primary. Extensions supported." },
  { kind: "url", label: "URL", hint: "A web address" },
];
export const fieldTypeLabel = (k: Kind) => FIELD_TYPES.find((x) => x.kind === k)?.label ?? k;

export const keyOf = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1") || "field";
const uniqueKey = (base: string, taken: string[]) => {
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`;
  return key;
};
const message = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function NewTableDialog({ app, onClose, onCreated }: { app: AppState; onClose: () => void; onCreated: (key: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError("");
    try {
      const { key } = await api.createType({ key: uniqueKey(keyOf(n), app.types.map((t) => t.key)), name: n, display: "fields" });
      onCreated(key);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="panel data-schema-panel" role="dialog" aria-modal="true" aria-label="New table" onSubmit={(e) => (e.preventDefault(), void submit())} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <header className="panel-head">
          <h3>New table</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>
        </header>
        <div className="data-schema-body">
          <label>Table name<input autoFocus required value={name} placeholder="For example, Equipment" onChange={(e) => setName(e.target.value)} /></label>
          <p>The table starts empty with just a Title column. Add the fields you need, including links to other tables, from the table itself.</p>
          {error && <p className="data-schema-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="btn-soft" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create table"}</button>
          </footer>
        </div>
      </form>
    </div>
  );
}

export function FieldDialog({ app, type, onClose, onSaved }: { app: AppState; type: TypeInfo; onClose: () => void; onSaved: (field: FieldDef) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("text");
  const [options, setOptions] = useState<string[]>(["Option 1", "Option 2"]);
  const [target, setTarget] = useState("");
  const [multiple, setMultiple] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSelect = kind === "select" || kind === "multi_select";
  const ready = !!name.trim() && (kind !== "link" || !!target) && (!isSelect || options.some((o) => o.trim()));
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    const field = {
      key: uniqueKey(keyOf(name.trim()), ["title", "type", "folder", "parent", "id", ...type.fields.map((f) => f.key)]),
      name: name.trim(),
      kind,
      ...(isSelect ? { options: [...new Set(options.map((o) => o.trim()).filter(Boolean))] } : {}),
      ...(kind === "link" ? { target, multiple } : {}),
    } as FieldDef;
    try {
      await api.saveType(type.key, { fields: [...type.fields, field] });
      onSaved(field);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const meta = FIELD_TYPES.find((x) => x.kind === kind);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="panel data-schema-panel" role="dialog" aria-modal="true" aria-label="Add field" onSubmit={(e) => (e.preventDefault(), void submit())} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
        <header className="panel-head">
          <h3>Add a field to {type.name}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>
        </header>
        <div className="data-schema-body">
          <label>Field name<input autoFocus required value={name} placeholder="Field name" onChange={(e) => setName(e.target.value)} /></label>
          <label>Field type
            <select aria-label="Field type" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {FIELD_TYPES.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
            </select>
          </label>
          {meta && <p>{meta.hint}.</p>}
          {isSelect && (
            <div className="data-schema-options">
              <span>Options</span>
              {options.map((o, i) => (
                <div key={i} className="data-schema-option">
                  <input aria-label={`Option ${i + 1}`} value={o} onChange={(e) => setOptions((os) => os.map((x, j) => (j === i ? e.target.value : x)))} />
                  <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
                </div>
              ))}
              <button type="button" className="ve-add" onClick={() => setOptions((os) => [...os, `Option ${os.length + 1}`])}><Icon name="plus" size={13} /> Add option</button>
            </div>
          )}
          {kind === "link" && (
            <>
              <label>Link to table
                <select aria-label="Link to table" required value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="" disabled>Choose a table…</option>
                  {app.types.map((t) => <option key={t.key} value={t.key}>{t.name}{t.key === type.key ? " (this table)" : ""}</option>)}
                </select>
              </label>
              <label className="data-schema-check"><input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />Allow linking to multiple records</label>
            </>
          )}
          {error && <p className="data-schema-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="btn-soft" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" disabled={busy || !ready}>{busy ? "Adding…" : "Create field"}</button>
          </footer>
        </div>
      </form>
    </div>
  );
}
