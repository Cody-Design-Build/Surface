import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Summary } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";

interface Props {
  records: Summary[];
  onPick: (id: string) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}

function score(title: string, q: string): number {
  const t = title.toLowerCase();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const i = t.indexOf(q);
  if (i >= 0) return 60 - Math.min(i, 30);
  // fuzzy: all characters in order
  let j = 0;
  for (const c of t) if (c === q[j]) j++;
  return j === q.length ? 20 : 0;
}

export function Switcher({ records, onPick, onCreate, onClose }: Props) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [bodyHits, setBodyHits] = useState<(Summary & { snippet: string })[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const recent = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("surface.recent") ?? "[]") as string[];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setBodyHits([]);
    const t = window.setTimeout(() => api.search(term).then((r) => setBodyHits(r.results.filter((x) => x.snippet))).catch(() => {}), 120);
    return () => window.clearTimeout(t);
  }, [q]);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list: (Summary & { snippet?: string })[];
    if (!term) {
      const byId = new Map(records.map((r) => [r.id, r]));
      const rec = recent.map((id) => byId.get(id)).filter(Boolean) as Summary[];
      const rest = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).filter((r) => !recent.includes(r.id));
      list = [...rec, ...rest].slice(0, 30);
    } else {
      list = records
        .map((r) => ({ r, s: score(r.title, term) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.r.title.localeCompare(b.r.title))
        .map((x) => x.r)
        .slice(0, 30);
      const seen = new Set(list.map((r) => r.id));
      list = [...list, ...bodyHits.filter((h) => !seen.has(h.id))].slice(0, 40);
    }
    return list;
  }, [q, records, recent, bodyHits]);

  const canCreate = q.trim() && !records.some((r) => r.title.toLowerCase() === q.trim().toLowerCase());
  const total = items.length + (canCreate ? 1 : 0);
  useEffect(() => setSel(0), [q]);

  const choose = (i: number) => {
    if (i < items.length) onPick(items[i].id);
    else if (canCreate) onCreate(q.trim());
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="switcher-input">
          <Icon name="search" size={17} />
          <input
            ref={input}
            value={q}
            placeholder="Find or create a page…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, total - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), choose(sel));
            }}
          />
        </div>
        <ul className="switcher-list">
          {items.map((r, i) => (
            <li key={r.id} className={i === sel ? "is-sel" : ""} onMouseEnter={() => setSel(i)} onMouseDown={() => choose(i)}>
              <Icon name={typeIcon(r.type)} size={15} />
              <div className="sw-text">
                <div className="sw-title">{r.title}</div>
                {r.snippet ? <div className="sw-snippet">…{r.snippet}…</div> : r.path ? <div className="sw-path">{r.path}</div> : null}
              </div>
              <span className="sw-type">{r.type}</span>
            </li>
          ))}
          {canCreate ? (
            <li className={sel === items.length ? "is-sel" : ""} onMouseEnter={() => setSel(items.length)} onMouseDown={() => choose(items.length)}>
              <Icon name="plus" size={15} />
              <div className="sw-text">
                <div className="sw-title">
                  Create page “{q.trim()}”
                </div>
              </div>
            </li>
          ) : null}
          {!total ? <li className="sw-empty">Nothing found</li> : null}
        </ul>
        <div className="switcher-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
