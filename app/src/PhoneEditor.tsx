import { useEffect, useId, useRef, useState } from "react";
import { normalizePhones, phoneEntries, phoneText, type PhoneEntry } from "../../cli/src/phone.ts";

interface Draft {
  id: number;
  number: string;
  extension: string;
}

interface Props {
  value: unknown;
  onChange: (value: PhoneEntry[] | null, finish: boolean) => void;
  autoFocus?: boolean;
  onCancel?: () => void;
}

/** Blank and invalid rows stay local. Only complete, unlabeled entries cross the field boundary. */
export function PhoneEditor({ value, onChange, autoFocus, onCancel }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const errorId = useId();
  const fromValue = (raw: unknown): Draft[] => {
    const entries = phoneEntries(raw);
    if (entries) return entries.map(entry => ({ id: nextId.current++, number: phoneText([{ number: entry.number }]), extension: entry.extension ?? "" }));
    const text = phoneText(raw);
    return text ? [{ id: nextId.current++, number: text, extension: "" }] : [];
  };
  const [rows, setRows] = useState(() => fromValue(value));
  const drafts = useRef(rows);
  const committed = useRef(rows);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [focusId, setFocusId] = useState<number | null>(null);
  const canonical = phoneText(value, false);
  const saved = useRef(canonical);
  const replace = (next: Draft[]) => {
    drafts.current = next;
    setRows(next);
  };

  useEffect(() => {
    if (canonical === saved.current || root.current?.contains(document.activeElement)) return;
    const next = fromValue(value);
    saved.current = canonical;
    committed.current = next;
    replace(next);
    setErrors({});
  }, [canonical]); // The serialized value, not object identity, marks an external update.

  useEffect(() => {
    if (autoFocus) root.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (focusId == null) return;
    root.current?.querySelector<HTMLInputElement>(`input[data-phone-id="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId]);

  const publish = (next: Draft[], finish = false): boolean => {
    const entries: PhoneEntry[] = [];
    const normalized: Draft[] = [];
    const invalid: Record<number, string> = {};
    for (const row of next) {
      if (!row.number.trim() && !row.extension.trim()) {
        normalized.push(row);
        continue;
      }
      try {
        const parsed = normalizePhones([{ number: row.number, ...(row.extension ? { extension: row.extension } : {}) }]);
        if (parsed) {
          entries.push(...parsed);
          normalized.push({ ...row, number: phoneText([{ number: parsed[0].number }]), extension: parsed[0].extension ?? "" });
        }
      } catch (error) {
        invalid[row.id] = error instanceof Error ? error.message : String(error);
      }
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return false;
    const result = entries.length ? entries : null;
    const text = phoneText(result, false);
    const changed = text !== saved.current;
    saved.current = text;
    committed.current = normalized;
    replace(normalized);
    if (changed || finish) onChange(result, finish);
    return true;
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // RDG's outside-click handler would commit its previous row before local input
  // reaches onRowChange. Own that boundary so the complete current draft is sent once.
  useEffect(() => {
    if (!onCancel) return;
    const outside = (event: MouseEvent) => {
      if (!root.current || root.current.contains(event.target as Node)) return;
      if (!publishRef.current(drafts.current, true)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("mousedown", outside, true);
    return () => document.removeEventListener("mousedown", outside, true);
  }, [onCancel]);

  const update = (id: number, key: "number" | "extension", text: string) => {
    replace(drafts.current.map(row => row.id === id ? { ...row, [key]: text } : row));
    setErrors(previous => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  };
  const populated = rows.filter(row => row.number.trim());
  const primaryId = populated[0]?.id;
  return <div
    ref={root}
    className="phone-editor"
    role="group"
    aria-label="Phone numbers"
    onBlur={event => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      publish(drafts.current, !!onCancel);
    }}
    onKeyDown={event => {
      // Keep arrows, Tab and button activation inside this multi-control editor,
      // rather than letting the grid treat them as cell navigation or submission.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        replace(committed.current.map(row => ({ ...row })));
        setErrors({});
        onCancel?.();
      } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        publish(drafts.current, !!onCancel);
      }
    }}
  >
    {rows.map((row, index) => <div className="phone-entry" key={row.id}>
      <div className="phone-entry-controls">
        <input
          data-phone-id={row.id}
          className="prop-input phone-number"
          type="tel"
          aria-label={`Phone number ${index + 1}`}
          aria-invalid={!!errors[row.id]}
          aria-describedby={errors[row.id] ? `${errorId}-${row.id}` : undefined}
          placeholder="Phone number"
          value={row.number}
          onChange={event => update(row.id, "number", event.target.value)}
        />
        <input
          className="prop-input phone-extension"
          inputMode="numeric"
          aria-label={`Extension ${index + 1}`}
          aria-invalid={!!errors[row.id]}
          aria-describedby={errors[row.id] ? `${errorId}-${row.id}` : undefined}
          placeholder="Ext."
          value={row.extension}
          onChange={event => update(row.id, "extension", event.target.value)}
        />
        {populated.length > 1 && row.number.trim() ? <button
          type="button"
          className="phone-primary"
          aria-label={row.id === primaryId ? "Primary phone number" : `Make phone number ${index + 1} primary`}
          title={row.id === primaryId ? "Primary phone number" : "Make primary"}
          aria-pressed={row.id === primaryId}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            const next = [row, ...drafts.current.filter(entry => entry.id !== row.id)];
            replace(next);
            publish(next);
          }}
        >{row.id === primaryId ? "★" : "☆"}</button> : null}
        <button
          type="button"
          className="phone-remove"
          aria-label={`Remove phone number ${index + 1}`}
          title="Remove number"
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            const next = drafts.current.filter(entry => entry.id !== row.id);
            replace(next);
            publish(next);
          }}
        >×</button>
      </div>
      {errors[row.id] ? <div className="prop-error" role="alert" id={`${errorId}-${row.id}`}>{errors[row.id]}</div> : null}
    </div>)}
    <button
      type="button"
      className="phone-add"
      disabled={rows.length >= 20}
      onClick={() => {
        const row = { id: nextId.current++, number: "", extension: "" };
        setFocusId(row.id);
        replace([...drafts.current, row]);
      }}
    >Add number</button>
  </div>;
}
