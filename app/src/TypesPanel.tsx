import { useEffect, useState } from "react";
import { api, ApiError, type AppState, type FieldDef, type Kind, type TypeInfo } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";
import { FIELD_TYPES } from "./DataSchema.tsx";

// Types and fields: what records look like. Owners and admins edit; others read.
// Saves the same structure `surface field add/edit/rm` does; the database validates it.

const KINDS: { kind: Kind; label: string }[] = FIELD_TYPES;

const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1") || "field";

type Draft = Omit<FieldDef, "id"> & { id?: string; _new?: boolean };

export function TypesPanel({ app, onClose, onToast, initial, noun = "type" }: { app: AppState; onClose: () => void; onToast: (m: string) => void; initial?: string; noun?: "type" | "table" }) {
  const Noun = noun === "table" ? "Table" : "Type";
  const isAdmin = app.role === "owner" || app.role === "admin";
  const [sel, setSel] = useState(initial ?? app.types[0]?.key);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const t = app.types.find((x) => x.key === sel);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel panel-types" role="dialog" aria-label={`${Noun}s`}>
        <header className="panel-head">
          <h3>{Noun}s and fields</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="types-split">
          <nav className="types-nav">
            {app.types.map((x) => (
              <button key={x.key} className={`types-item ${x.key === sel ? "is-on" : ""}`} onClick={() => setSel(x.key)}>
                <Icon name={typeIcon(x.key)} size={14} />
                <span>{x.name}</span>
                <small>{app.records.filter((r) => r.type === x.key).length}</small>
              </button>
            ))}
            {isAdmin ? (
              adding ? (
                <div className="types-new">
                  <input
                    className="ve-input"
                    autoFocus
                    placeholder={`${Noun} name`}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Escape") setAdding(false);
                      if (e.key !== "Enter" || !newName.trim()) return;
                      try {
                        const { key } = await api.createType({ key: keyOf(newName), name: newName.trim() });
                        onToast(`Added the ${noun} ${newName.trim()}`);
                        setAdding(false);
                        setNewName("");
                        window.setTimeout(() => setSel(key), 600);
                      } catch (err) {
                        onToast((err as Error).message);
                      }
                    }}
                  />
                </div>
              ) : (
                <button className="ve-add" onClick={() => setAdding(true)}>
                  <Icon name="plus" size={13} /> New {noun}
                </button>
              )
            ) : null}
          </nav>
          <div className="types-body">{t ? <TypeEditor key={t.key + t.fields.map((f) => f.id).join()} app={app} t={t} readOnly={!isAdmin} onToast={onToast} noun={noun} /> : null}</div>
        </div>
      </div>
    </div>
  );
}

function TypeEditor({ app, t, readOnly, onToast, noun }: { app: AppState; t: TypeInfo; readOnly: boolean; onToast: (m: string) => void; noun: "type" | "table" }) {
  const [name, setName] = useState(t.name);
  const [fields, setFields] = useState<Draft[]>(t.fields.map((f) => ({ ...f })));
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [fields, name]);
  const dirty = name !== t.name || JSON.stringify(fields.map(strip)) !== JSON.stringify(t.fields.map(strip));
  const removed = t.fields.filter((f) => !fields.some((d) => d.id === f.id));

  const set = (i: number, patch: Partial<Draft>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = async () => {
    const untargeted = fields.find((f) => f._new && f.kind === "link" && !f.target);
    if (untargeted) { setError(`Choose which table “${untargeted.name || "the new field"}” links to.`); return; }
    if (removed.length && !confirm(`Remove ${removed.map((f) => `“${f.name}”`).join(", ")}? Values are dropped from every ${t.name.toLowerCase()} (they stay in history).`)) return;
    setBusy(true);
    try {
      await api.saveType(t.key, {
        name: name.trim() || t.name,
        fields: fields.map(({ _new, ...f }) => {
          const out: Draft = { ...f, key: f.key || keyOf(f.name) };
          if (!["select", "multi_select"].includes(out.kind)) delete out.options;
          if (out.kind !== "link") {
            delete out.target;
            delete out.multiple;
          }
          if (!out.required) delete out.required;
          void _new;
          return out as FieldDef;
        }),
      });
      onToast(`Saved ${name.trim() || t.name}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="type-editor">
      <div className="ve-row">
        <span className="ve-label">Name</span>
        <input className="ve-input" value={name} disabled={readOnly || t.builtin} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="ve-row">
        <span className="ve-label">Key</span>
        <code className="type-key">{t.key}</code>
        {t.builtin ? <span className="ve-hint">built in</span> : null}
      </div>
      <div className="ve-row">
        <span className="ve-label">Opens as</span>
        <select
          className="ve-input"
          value={t.display}
          disabled={readOnly}
          onChange={async (e) => {
            await api.saveType(t.key, { display: e.target.value as "document" | "fields" });
            onToast(`${t.name} opens as ${e.target.value === "fields" ? "fields" : "a document"}`);
          }}
        >
          <option value="document">Document (fields above the text)</option>
          <option value="fields">Fields (notes on request)</option>
        </select>
      </div>
      <h4 className="panel-h">Fields</h4>
      <ul className="field-list">
        {fields.map((f, i) => (
          <li key={f.id ?? `new-${i}`} className={open === i ? "is-open" : ""}>
            <div className="field-row" onClick={() => setOpen(open === i ? null : i)}>
              <span className="field-name">{f.name || <em>Untitled</em>}</span>
              <span className="field-kind">
                {KINDS.find((k) => k.kind === f.kind)?.label}
                {f.kind === "link" ? ` → ${app.types.find((x) => x.key === f.target)?.name ?? "any"}${f.multiple ? " (many)" : ""}` : ""}
                {f.required ? " · required" : ""}
              </span>
              {!readOnly ? (
                <span className="field-move">
                  <button className="icon-btn" disabled={i === 0} onClick={(e) => (e.stopPropagation(), setFields((fs) => swap(fs, i, i - 1)), setOpen(null))} aria-label="Move up">↑</button>
                  <button className="icon-btn" disabled={i === fields.length - 1} onClick={(e) => (e.stopPropagation(), setFields((fs) => swap(fs, i, i + 1)), setOpen(null))} aria-label="Move down">↓</button>
                </span>
              ) : null}
            </div>
            {open === i ? (
              <div className="field-detail">
                <div className="ve-row">
                  <span className="ve-label">Name</span>
                  <input className="ve-input" autoFocus={f._new} disabled={readOnly} value={f.name} onChange={(e) => set(i, f._new ? { name: e.target.value, key: keyOf(e.target.value) } : { name: e.target.value })} />
                </div>
                <div className="ve-row">
                  <span className="ve-label">Key</span>
                  <input className="ve-input mono" disabled={readOnly} value={f.key} onChange={(e) => set(i, { key: e.target.value })} />
                </div>
                <div className="ve-row">
                  <span className="ve-label">Field type</span>
                  <select className="ve-input" disabled={readOnly} value={f.kind} onChange={(e) => set(i, { kind: e.target.value as Kind, ...(["select", "multi_select"].includes(e.target.value) && !f.options?.length ? { options: ["Option 1"] } : {}) })}>
                    {KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>{k.label}</option>
                    ))}
                  </select>
                </div>
                {f.kind === "select" || f.kind === "multi_select" ? (
                  <div className="ve-row ve-top">
                    <span className="ve-label">Options</span>
                    <div className="ve-stack">
                      {(f.options ?? []).map((o, oi) => (
                        <div className="ve-cond" key={oi}>
                          <input className="ve-input" disabled={readOnly} value={o} onChange={(e) => set(i, { options: (f.options ?? []).map((x, j) => (j === oi ? e.target.value : x)) })} />
                          {!readOnly ? (
                            <button className="icon-btn" onClick={() => set(i, { options: (f.options ?? []).filter((_, j) => j !== oi) })} aria-label="Remove option">
                              <Icon name="close" size={13} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {!readOnly ? (
                        <button className="ve-add" onClick={() => set(i, { options: [...(f.options ?? []), `Option ${(f.options?.length ?? 0) + 1}`] })}>
                          <Icon name="plus" size={13} /> Add option
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {f.kind === "link" ? (
                  <>
                    <div className="ve-row">
                      <span className="ve-label">Link to table</span>
                      <select className="ve-input" disabled={readOnly} value={f.target ?? ""} onChange={(e) => set(i, { target: e.target.value || null })}>
                        <option value="" disabled={f._new}>{f._new ? "Choose a table…" : "Any record"}</option>
                        {app.types.map((x) => (
                          <option key={x.key} value={x.key}>{x.name}</option>
                        ))}
                      </select>
                    </div>
                    <label className="ve-row check-row">
                      <span className="ve-label" />
                      <input type="checkbox" disabled={readOnly} checked={!!f.multiple} onChange={(e) => set(i, { multiple: e.target.checked })} /> Allow linking to multiple records
                    </label>
                  </>
                ) : null}
                <label className="ve-row check-row">
                  <span className="ve-label" />
                  <input type="checkbox" disabled={readOnly} checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
                </label>
                {!readOnly ? (
                  <button className="btn-danger-soft" onClick={() => (setFields((fs) => fs.filter((_, j) => j !== i)), setOpen(null))}>
                    Remove field
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <button
          className="ve-add"
          onClick={() => {
            setFields((fs) => [...fs, { key: "", name: "", kind: "text", _new: true }]);
            setOpen(fields.length);
          }}
        >
          <Icon name="plus" size={13} /> Add field
        </button>
      ) : (
        <p className="panel-note">Owners and admins change {noun}s.</p>
      )}
      {error ? <div className="ve-error">{error}</div> : null}
      {!readOnly ? (
        <div className="type-foot">
          <span className="ve-hint">{dirty ? (removed.length ? `${removed.length} field${removed.length > 1 ? "s" : ""} will be removed` : "Unsaved changes") : ""}</span>
          <button className="btn-soft" disabled={!dirty} onClick={() => (setFields(t.fields.map((f) => ({ ...f }))), setName(t.name))}>Revert</button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>Save</button>
        </div>
      ) : null}
    </div>
  );
}

function strip(f: Partial<FieldDef> & { _new?: boolean }) {
  return { key: f.key, name: f.name, kind: f.kind, options: f.options ?? null, target: f.target ?? null, multiple: !!f.multiple, required: !!f.required };
}
function swap<T>(a: T[], i: number, j: number) {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}
