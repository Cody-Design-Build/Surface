import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type AppState, type SystemInfo } from "./api.ts";
import { appUrl } from "../../surfaces.mts";
import { AppSwitcher } from "./AppSwitcher.tsx";
import { SyncBadge } from "./SyncBadge.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { workspaceViewTypes } from "./viewTypes.ts";
import packageInfo from "../../cli/package.json" with { type: "json" };

const SidebarSize = createContext<{ width: number; maxWidth: number; setWidth: (width: number) => void } | null>(null);
const boundedWidth = (width: number) => Math.max(160, Math.min(480, width));

/** Every app uses this shell: shared account, workspace, version, updates and column sizing. */
export function AppShell({ appId, app, online, tick, openRecord, beforeNavigate, onNavigationError, onSwitching, updatesBlocked, className = "", children }: {
  appId: string; app: AppState; online: boolean; tick?: number; openRecord: (id: string) => void;
  beforeNavigate?: () => boolean; onNavigationError?: () => void; onSwitching?: (busy: boolean) => void; updatesBlocked?: string;
  className?: string; children: ReactNode;
}) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("surface.sidebar-width"));
    return boundedWidth(saved || 220);
  });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const maxWidth = Math.max(160, Math.min(480, Math.floor(viewportWidth / 2)));
  const visibleWidth = Math.min(width, maxWidth);
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === "surface.sidebar-width") setWidth(boundedWidth(Number(event.newValue) || 220));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const resize = (next: number) => { const value = Math.min(boundedWidth(next), maxWidth); setWidth(value); localStorage.setItem("surface.sidebar-width", String(value)); };
  return <SidebarSize.Provider value={{ width: visibleWidth, maxWidth, setWidth: resize }}>
    <div className={`surface-app ${className}`} style={{ "--app-sidebar-size": `${visibleWidth}px` } as CSSProperties}>
      <AppHeader appId={appId} app={app} online={online} tick={tick} openRecord={openRecord} beforeNavigate={beforeNavigate} onNavigationError={onNavigationError} onSwitching={onSwitching} updatesBlocked={updatesBlocked} />
      <div className="app-content">{children}</div>
    </div>
  </SidebarSize.Provider>;
}

export function SidebarResizeHandle() {
  const size = useContext(SidebarSize);
  const drag = useRef<{ x: number; width: number } | null>(null);
  if (!size) return null;
  return <div className="sidebar-resize" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={size.maxWidth} aria-valuenow={size.width} tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      if (drag.current) size.setWidth(drag.current.width + event.clientX - drag.current.x);
    }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => size.setWidth(220)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); size.setWidth(event.key === "Home" ? 160 : event.key === "End" ? size.maxWidth : size.width + (event.key === "ArrowRight" ? 16 : -16));
    }} />;
}

function AppHeader({ appId, app, online, tick, openRecord, beforeNavigate, onNavigationError, onSwitching, updatesBlocked }: {
  appId: string; app: AppState; online: boolean; tick?: number; openRecord: (id: string) => void;
  beforeNavigate?: () => boolean; onNavigationError?: () => void; onSwitching?: (busy: boolean) => void; updatesBlocked?: string;
}) {
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof api.workspaces>>["workspaces"]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemUnavailable, setSystemUnavailable] = useState(false);
  const [systemRetry, setSystemRetry] = useState(0);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const updateRef = useRef<HTMLDivElement>(null);
  const initialCommit = useRef<string | null>(null);
  const activeJob = system?.update.job?.state === "running";
  useEffect(() => {
    let active = true;
    api.workspaces().then(result => { if (active) setWorkspaces(result.workspaces); }).catch(err => { if (active) setError(String(err.message ?? err)); });
    return () => { active = false; };
  }, [app.workspace.id]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const info = await api.system();
        if (!active) return;
        initialCommit.current ??= info.version.commit;
        setSystem(info);
        setSystemUnavailable(false);
      } catch { if (active) setSystemUnavailable(true); /* Keep polling through a server restart. */ }
    };
    void load();
    const timer = window.setInterval(load, activeJob ? 1500 : 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activeJob, systemRetry]);
  useEffect(() => {
    if (!updateOpen) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !updateRef.current?.contains(event.target)) setUpdateOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [updateOpen]);
  const changeWorkspace = async (id: string) => {
    if (!system || systemUnavailable || switching) return;
    if (id === app.workspace.id || (beforeNavigate && !beforeNavigate())) return;
    setSwitching(true); onSwitching?.(true); setError("");
    try {
      const next = await api.switchWorkspace(id);
      const target = await api.workspaceState(id);
      const available = workspaceViewTypes(target);
      const view = available.find(view => view.id === appId) ?? available[0];
      location.assign(next.url && view ? appUrl(view, next.url) : next.url || location.pathname);
    } catch (err) { onNavigationError?.(); setError(String((err as Error).message)); setSwitching(false); onSwitching?.(false); }
  };
  const startUpdate = async (operation: "check" | "install") => {
    if (operation === "install" && updatesBlocked) { setError(updatesBlocked); return; }
    setRequesting(true); setError("");
    try {
      const result = await api.updateSystem(operation);
      setSystem(current => current ? {...current, update: {...current.update, job: result.job}} : current);
    }
    catch (err) { setError(String((err as Error).message)); }
    finally { setRequesting(false); }
  };
  const job = system?.update.job;
  const changed = !!(system?.version.commit && initialCommit.current && system.version.commit !== initialCommit.current);
  const updateStatus = changed ? "Reload to finish" : system?.update.available ? "Update available" : activeJob ? "Checking…" : systemUnavailable || job?.state === "error" ? "Check unavailable" : system?.update.checkedAt && system.update.availableCommit === system.version.commit ? "Up to date" : "Not checked";
  const updateTone = changed || system?.update.available ? "available" : updateStatus === "Up to date" ? "current" : "unknown";
  const availableVersion = system?.update.availableCommit ? `${system.update.availableVersion ? `v${system.update.availableVersion} · ` : ""}${system.update.availableCommit.slice(0, 7)}` : "unknown";
  return <header className="app-topbar">
    <div className="app-name-column"><label className="app-workspace"><select aria-label="Workspace" value={app.workspace.id} disabled={!system || systemUnavailable || switching || !!activeJob} onChange={event => void changeWorkspace(event.target.value)}>
      {!workspaces.some(workspace => workspace.id === app.workspace.id) && <option value={app.workspace.id}>{app.workspace.name}</option>}
      {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select></label></div>
    <div className="app-view-type"><AppSwitcher key={app.workspace.id} appId={appId} workspaceId={app.workspace.id} disabled={!system || systemUnavailable || switching || !!activeJob} availableViews={workspaceViewTypes(app)} beforeNavigate={beforeNavigate} /></div>
    <div className="app-topbar-right">
      {switching && <span className="app-operation" role="status">Opening workspace…</span>}
      <div className="app-update" ref={updateRef} onKeyDown={event => { if (event.key === "Escape") { setUpdateOpen(false); updateRef.current?.querySelector("button")?.focus(); } }}>
        <span className="app-version" title={system ? `Installed on ${system.machine}` : "App build version"}><small>{system ? "Installed" : "App build"}</small><span>v{system?.version.number ?? packageInfo.version}{system?.version.commit && ` · ${system.version.commit.slice(0, 7)}`}</span></span>
        <span className={`app-update-status ${updateTone}`} role="status"><span>{updateStatus}</span><small>Available · {availableVersion}</small></span>
        <button className={`app-update-trigger${system?.update.available || changed ? " has-update" : ""}`} aria-expanded={updateOpen} onClick={() => setUpdateOpen(value => !value)}>{activeJob ? job?.operation === "check" ? "Checking…" : "Updating…" : changed ? "Reload" : "Update"}</button>
        {updateOpen && <div className="app-update-menu" aria-label="App updates">
          <strong>Updates for all apps</strong>
          <p className="app-build-info">Installed: v{system?.version.number ?? packageInfo.version}{system?.version.commit && ` · ${system.version.commit.slice(0, 7)}`}</p>
          <p className="app-build-info">Available: {availableVersion}</p>
          {system?.update.checkedAt && <p>Last checked: {new Date(system.update.checkedAt).toLocaleString()}</p>}
          {!system && systemUnavailable && <p>Reconnect or restart the local server to use update controls.</p>}
          {changed ? <><p>The update is installed. Reload to use it.</p><button className="btn-soft" onClick={() => { if (!beforeNavigate || beforeNavigate()) location.reload(); }}>Reload app</button></> : <>
            <p>{activeJob ? job?.operation === "check" ? "Checking for updates…" : "Installing and restarting apps…" : system?.update.available ? "An update is available." : system?.update.checkedAt ? "No update was found at the last check." : "Check for the latest version."}</p>
            {job?.state === "error" && <p role="alert">{job.error}</p>}
            <button className="btn-soft" disabled={requesting || !!activeJob || !system} onClick={() => void startUpdate("check")}>Check for updates</button>
            {system?.update.available && <><p>Installing restarts all apps on this computer. Save any open edits first.</p>{updatesBlocked && <p>{updatesBlocked}</p>}<button className="btn-soft" disabled={requesting || !!activeJob || !!updatesBlocked} onClick={() => void startUpdate("install")}>Install and restart apps</button></>}
          </>}
        </div>}
      </div>
      <AccountMenu system={system} unavailable={systemUnavailable} onRetry={() => setSystemRetry(value => value + 1)}>
        <SyncBadge tick={tick} onOpenRecord={openRecord} serverOnline={online} />
      </AccountMenu>
    </div>
    {(error || systemUnavailable) && <div className="app-header-error" role="alert">{error || "Workspace and view switching need a reachable, current Surface server. Restart Surface, then reload this page."}{error && <button aria-label="Dismiss error" onClick={() => setError("")}>×</button>}</div>}
  </header>;
}
