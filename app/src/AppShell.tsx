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

/** Shared account, workspace status and column sizing. Installation stays in the CLI. */
export function AppShell({ appId, app, online, tick, openRecord, beforeNavigate, beforeReload, onNavigationError, onSwitching, className = "", children }: {
  appId: string; app: AppState; online: boolean; tick?: number; openRecord: (id: string) => void;
  beforeNavigate?: () => boolean; beforeReload?: () => boolean; onNavigationError?: () => void; onSwitching?: (busy: boolean) => void;
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
      <AppHeader appId={appId} app={app} online={online} tick={tick} openRecord={openRecord} beforeNavigate={beforeNavigate} beforeReload={beforeReload} onNavigationError={onNavigationError} onSwitching={onSwitching} />
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

function AppHeader({ appId, app, online, tick, openRecord, beforeNavigate, beforeReload, onNavigationError, onSwitching }: {
  appId: string; app: AppState; online: boolean; tick?: number; openRecord: (id: string) => void;
  beforeNavigate?: () => boolean; beforeReload?: () => boolean; onNavigationError?: () => void; onSwitching?: (busy: boolean) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof api.workspaces>>["workspaces"]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemUnavailable, setSystemUnavailable] = useState(false);
  const [systemRetry, setSystemRetry] = useState(0);
  const [reloadBlocked, setReloadBlocked] = useState(false);
  const initialCommit = useRef<string | null>(typeof __SURFACE_BUILD_COMMIT__ === "string" ? __SURFACE_BUILD_COMMIT__ : null);
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
        initialCommit.current ??= info.runningVersion?.commit ?? info.version.commit;
        setSystem(info);
        setSystemUnavailable(false);
      } catch { if (active) setSystemUnavailable(true); /* Keep polling through a server restart. */ }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [systemRetry]);
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
  const runningCommit = system?.runningVersion?.commit ?? system?.version.commit;
  const changed = !!(runningCommit && initialCommit.current && runningCommit !== initialCommit.current);
  const restartNeeded = !!(system?.runningVersion?.commit && system.version.commit && system.runningVersion.commit !== system.version.commit);
  const checked = !!system?.update.checkedAt && Date.now() - Date.parse(system.update.checkedAt) < 4 * 60 * 60 * 1000;
  const updateStatus = !online || systemUnavailable ? "Version status unavailable" : changed ? "New version ready" : restartNeeded ? "Restart Surface to load installed version" : system?.update.available ? `Surface ${system.update.availableVersion ?? "update"} available` : checked && system?.update.availableCommit === system.version.commit ? "Up to date" : "Version not checked recently";
  const version = system?.runningVersion ?? system?.version;
  const releaseDetails = system?.update.checkedAt ? `Last checked ${new Date(system.update.checkedAt).toLocaleString()}. Run surface update --check to refresh.` : "Run surface update --check to check published releases.";
  const connectivity = system?.cloudConnectivity;
  const connectivityState = !online || systemUnavailable ? "unknown" : connectivity?.state ?? "unknown";
  const deviceStatus = !online || systemUnavailable ? "Device status unavailable" : connectivityState === "online" ? "Device · cloud reachable" : connectivityState === "unreachable" ? "Device · cloud unreachable" : connectivityState === "unconfigured" ? "Device · cloud not configured" : "Device · checking cloud";
  const deviceDetails = `${system?.machine ?? "Server device"}${connectivity?.target ? ` → ${connectivity.target}` : ""}. ${connectivity?.checkedAt ? `Observed ${new Date(connectivity.checkedAt).toLocaleString()}.` : "No connectivity observation yet."} Cloud reachability does not establish database access or successful sync.`;
  const reload = () => {
    if (beforeReload && !beforeReload()) { setReloadBlocked(true); return; }
    location.reload();
  };
  return <header className="app-topbar">
    <div className="app-name-column"><label className="app-workspace"><select aria-label="Workspace" value={app.workspace.id} disabled={!system || systemUnavailable || switching} onChange={event => void changeWorkspace(event.target.value)}>
      {!workspaces.some(workspace => workspace.id === app.workspace.id) && <option value={app.workspace.id}>{app.workspace.name}</option>}
      {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select></label></div>
    <div className="app-view-type"><AppSwitcher key={app.workspace.id} appId={appId} workspaceId={app.workspace.id} disabled={!system || systemUnavailable || switching} availableViews={workspaceViewTypes(app)} beforeNavigate={beforeNavigate} /></div>
    <div className="app-topbar-right">
      {switching && <span className="app-operation" role="status">Opening workspace…</span>}
      <div className="app-status">
        <SyncBadge key={app.workspace.id} tick={tick} onOpenRecord={openRecord} serverOnline={online}>
          <div className="sync-sub">Surface</div>
          <div className="sync-row"><span>{system ? "Running version" : "App build"}</span><strong>v{version?.number ?? packageInfo.version}</strong></div>
          {systemUnavailable && <p className="sync-note">Version and account details are unavailable; any displayed version is the last observation. Workspace switching needs the current server API. Run <code>surface restart</code>, then reload after saving.</p>}
          {version?.commit && <details className="surface-technical"><summary>Technical details</summary><p className="sync-note">Commit <code>{version.commit}</code></p></details>}
          <p className="sync-note">{updateStatus}</p>
          {system?.update.available && <p className="sync-note">Install in your terminal: <code>surface update</code>.</p>}
          {restartNeeded && <p className="sync-note">Run <code>surface restart</code>, then reload this page after saving.</p>}
          <p className="sync-note">{releaseDetails}</p>
          <div className="sync-sub">Device connection</div>
          <p className="sync-note">{deviceStatus}</p>
          <p className="sync-note">{deviceDetails}</p>
        </SyncBadge>
        {online && !systemUnavailable && changed && <div className="app-reload-notice" role="status">
          <span>New version ready</span><button className="btn-soft" onClick={reload}>Reload</button>
          {reloadBlocked && <span className="app-reload-blocked">Save or resolve unsaved edits before reloading.</span>}
        </div>}
      </div>
      <AccountMenu system={system} unavailable={systemUnavailable} onRetry={() => setSystemRetry(value => value + 1)} />
    </div>
    {error && <div className="app-header-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
  </header>;
}
