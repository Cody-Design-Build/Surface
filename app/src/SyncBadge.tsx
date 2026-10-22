// One workspace status entry; connection and release diagnostics live in its details.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
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

const hubName = (s: SyncState) => (s.hub === "the cloud" ? "cloud" : "hub");

export function syncLabel(s: SyncState): { text: string; tone: "ok" | "warn" | "bad" | "busy" } {
  const n = s.conflicts?.length ?? 0;
  const hub = hubName(s);
  if (s.database?.state === "error") return { text: s.database.errorKind === "auth" ? "Database · sign-in required" : "Database unavailable", tone: "bad" };
  if (s.database?.state === "checking") return { text: "Checking database…", tone: "busy" };
  if (n) return { text: `${n} conflict${n > 1 ? "s" : ""}`, tone: "bad" };
  if (s.store === "cloud") return { text: "Cloud connected", tone: "ok" };
  if (!s.enabled) return { text: "Local only", tone: "ok" };
  if (s.offline || s.state === "unreachable") return { text: "Cloud offline · saved here", tone: "warn" };
  if (s.error) return { text: s.errorKind === "auth" ? `${hub[0].toUpperCase()}${hub.slice(1)} · sign-in required` : "Sync error", tone: "bad" };
  if (s.syncing) return { text: "Syncing…", tone: "busy" };
  if (s.pending) return { text: "Sync pending", tone: "warn" };
  if (!s.lastSync) return { text: "Not yet synced", tone: "warn" };
  if (s.loopEnabled === false) return { text: "Sync paused", tone: "warn" };
  return { text: "Synced", tone: "ok" };
}

/** Never show a stale successful sync after losing the status endpoint. */
export function SyncBadge({ tick, onOpenRecord, serverOnline = true, children }: { tick?: number; onOpenRecord?: (id: string) => void; serverOnline?: boolean; children?: ReactNode }) {
  const [s, setS] = useState<SyncState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const load = useCallback(async () => {
    try { const next = await syncApi.status(); setS(next); setUnavailable(false); }
    catch { setUnavailable(true); }
  }, []);
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
  const available = serverOnline && !unavailable && s !== null;
  const { text, tone } = !serverOnline ? { text: "Reconnecting…", tone: "bad" }
    : unavailable ? { text: "Status unavailable", tone: "warn" }
    : !s ? { text: "Checking status…", tone: "busy" } : syncLabel(s);
  const now = async () => {
    setBusy(true);
    try { setS(await syncApi.now()); setUnavailable(false); } catch { setUnavailable(true); } finally { setBusy(false); }
  };
  return (
    <div className="sync-badge" ref={ref} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    }}>
      <button ref={trigger} className={`sync-chip is-${tone}`} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} title="Surface status">
        <i aria-hidden="true" /><span role="status">{text}</span>
      </button>
      {open && <div className="sync-pop" id={id} role="dialog" aria-label="Surface status">
        <div className="sync-sub">Workspace</div>
        {!available ? <>
          <p className="sync-note">{!serverOnline ? "This page cannot reach Surface. Reconnecting automatically; database and sync status are unknown." : unavailable ? "Database and sync status could not be retrieved. Previous successful observations are not current." : "Checking database and sync status…"}</p>
          {serverOnline && <button className="btn-soft" onClick={() => void load()}>Retry status</button>}
        </> : <>
        <div className="sync-row"><span>Database</span><strong>{s.database?.state === "error" ? "Unavailable" : s.database?.state === "checking" ? "Checking" : s.store === "cloud" ? "Cloud" : "Local"}</strong></div>
        {s.database?.error && <p className="sync-note is-bad">{s.database.error}</p>}
        {s.enabled ? <>
          <div className="sync-row"><span>Syncs with</span><strong>{s.hub}</strong></div>
          <div className="sync-row"><span>Last successful sync</span><strong>{ago(s.lastSync)}</strong></div>
          <div className="sync-row"><span>Waiting to go up</span><strong>{s.pending ? `${s.pending} change${s.pending > 1 ? "s" : ""}` : "nothing"}</strong></div>
          {s.loopEnabled === false && <p className="sync-note">Automatic sync is paused. Run surface serve without SURFACE_SYNC=0 to resume.</p>}
        </> : <p className="sync-note">{s.store === "cloud" ? "This workspace uses the cloud database directly; no local sync queue." : "Saved only on this device. Enable cloud sync with surface sync enable."}</p>}
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
        {s.enabled && <button className="btn-soft sync-now" disabled={busy || s.syncing} onClick={now}><Icon name="refresh" size={13} />{busy || s.syncing ? "Syncing…" : "Sync now"}</button>}
        </>}
        {children}
      </div>}
    </div>
  );
}
