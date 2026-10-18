// Sync state for the current workspace: a small chip ("Synced", "Offline · 3 waiting", "1 conflict")
// with a popover for details, Sync now, and conflicts. Hidden when the workspace doesn't sync.
import { useCallback, useEffect, useRef, useState } from "react";
import { syncApi, type SyncState } from "./api.ts";
import { Icon } from "./Icon.tsx";

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

export function syncLabel(s: SyncState): { text: string; tone: "ok" | "warn" | "bad" | "busy" } {
  const n = s.conflicts?.length ?? 0;
  if (n) return { text: `${n} conflict${n > 1 ? "s" : ""}`, tone: "bad" };
  if (s.offline) return { text: s.pending ? `Offline · ${s.pending} waiting` : "Offline", tone: "warn" };
  if (s.error) return { text: "Sync error", tone: "bad" };
  if (s.pending) return { text: `Syncing ${s.pending}…`, tone: "busy" };
  return { text: "Synced", tone: "ok" };
}

export function SyncBadge({ tick, onOpenRecord, className = "" }: { tick?: number; onOpenRecord?: (id: string) => void; className?: string }) {
  const [s, setS] = useState<SyncState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const load = useCallback(() => syncApi.status().then(setS, () => {}), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load, tick]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!s?.enabled) return null;
  const { text, tone } = syncLabel(s);
  const now = async () => {
    setBusy(true);
    try { setS(await syncApi.now()); } catch {} finally { setBusy(false); }
  };
  return (
    <div className={`sync-badge ${className}`} ref={ref}>
      <button className={`sync-chip is-${tone}`} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open} title={`Syncs with ${s.hub}`}>
        <i />{text}
      </button>
      {open && <div className="sync-pop" role="dialog" aria-label="Sync">
        <div className="sync-row"><span>Syncs with</span><strong>{s.hub}</strong></div>
        <div className="sync-row"><span>Last sync</span><strong>{ago(s.lastSync)}</strong></div>
        <div className="sync-row"><span>Waiting to go up</span><strong>{s.pending ? `${s.pending} change${s.pending > 1 ? "s" : ""}` : "nothing"}</strong></div>
        {s.offline && <p className="sync-note">Can't reach {s.hub}. Keep working: everything is saved on this computer and goes up when the connection is back.</p>}
        {s.error && <p className="sync-note is-bad">{s.error}</p>}
        {!!s.conflicts?.length && <div className="sync-conflicts">
          <div className="sync-sub">Conflicts</div>
          <p className="sync-note">These changed on another computer too. The other version is kept; yours is a copy. Keep one, delete the other, then mark it done.</p>
          {s.conflicts.map(c => <div className="sync-conflict" key={c.id}>
            <div className="sync-conflict-title">{c.title}</div>
            <div className="sync-conflict-actions">
              {onOpenRecord && <button className="btn-soft" onClick={() => { onOpenRecord(c.record_id); setOpen(false); }}>Theirs</button>}
              {onOpenRecord && c.copy_id && <button className="btn-soft" onClick={() => { onOpenRecord(c.copy_id); setOpen(false); }}>Yours</button>}
              <button className="btn-soft" onClick={async () => setS(await syncApi.resolve(c.record_id))}>Done</button>
            </div>
          </div>)}
        </div>}
        <button className="btn-soft sync-now" disabled={busy} onClick={now}><Icon name="refresh" size={13} />{busy ? "Syncing…" : "Sync now"}</button>
      </div>}
    </div>
  );
}
