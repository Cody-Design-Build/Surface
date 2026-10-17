import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, subscribe, type AppState, type TreeDef, type TreeNode, type ViewInfo } from "./api.ts";
import { GroupView } from "./GroupView.tsx";
import { Page, type SaveStatus } from "./Page.tsx";
import { MoveTo, RecordPicker, Settings, Share } from "./Panels.tsx";
import { nodeKey, Sidebar, type Route, type Scope, type SidebarChange } from "./Sidebar.tsx";
import { Switcher } from "./Switcher.tsx";
import { did, onUndo, redo, typingTarget, undo } from "./undo.ts";
import { ViewEditor } from "./ViewEditor.tsx";
import { ViewPage } from "./ViewPage.tsx";

function readRoute(): Route {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("/r/")) return { kind: "record", id: h.slice(3) };
  if (h.startsWith("/g/")) return { kind: "group", key: h.slice(3) };
  if (h.startsWith("/v/")) {
    // /v/<key>[?personal=1&this=<id>&label=...]
    const [key, qs] = h.slice(3).split("?");
    const p = new URLSearchParams(qs ?? "");
    return { kind: "view", key, personal: p.get("personal") === "1", thisId: p.get("this"), label: p.get("label") ?? undefined };
  }
  return null;
}

function findGroup(scopes: Record<Scope, TreeNode[]>, key: string): { node: TreeNode; labels: string[] } | null {
  const walk = (nodes: TreeNode[], path: string[]): { node: TreeNode; labels: string[] } | null => {
    for (const n of nodes) {
      const p = [...path, n.id ?? n.view ?? n.label];
      if (nodeKey(p) === key) return { node: n, labels: p.slice(1) };
      const hit = walk(n.children, p);
      if (hit) return hit;
    }
    return null;
  };
  return walk(scopes.workspace, ["workspace"]) ?? walk(scopes.personal, ["personal"]);
}

function firstRecord(nodes: TreeNode[]): string | null {
  for (const n of nodes) {
    if (n.kind === "record" && n.id) return n.id;
    const c = firstRecord(n.children);
    if (c) return c;
  }
  return null;
}

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(readRoute());
  const [switcher, setSwitcher] = useState(false);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("surface.sidebar") !== "closed");
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState<{ s: SaveStatus; msg?: string }>({ s: "saved" });
  const [remote, setRemote] = useState<{ tick: number; ids: string[] }>({ tick: 0, ids: [] });
  const [toast, setToast] = useState<{ msg: string; undo: boolean; n: number } | null>(null);
  const [panel, setPanel] = useState<
    | { kind: "settings" }
    | { kind: "share" }
    | { kind: "move"; id: string }
    | { kind: "pick"; title: string; onPick: (id: string) => void }
    | { kind: "newView"; scope: Scope; onCreated: (v: ViewInfo) => void }
    | { kind: "editView"; view: ViewInfo }
    | null
  >(null);
  const appRef = useRef<AppState | null>(null);
  appRef.current = app;

  const reload = useCallback(async () => {
    try {
      const s = await api.state();
      setApp(s);
      setError(null);
      return s;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? e.message : `Can't reach surface serve (${(e as Error).message}).`);
      return null;
    }
  }, []);

  useEffect(() => {
    reload();
    return subscribe(
      (msg) => {
        reload();
        setRemote((r) => ({ tick: r.tick + 1, ids: msg.ids ?? [] }));
      },
      (on) => {
        setOnline(on);
        if (on) reload();
      },
    );
  }, [reload]);

  const showToast = useCallback((msg: string, canUndo = false) => {
    if (!msg) return;
    setToast((t) => ({ msg, undo: canUndo, n: (t?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.undo ? 6000 : 3500);
    return () => window.clearTimeout(t);
  }, [toast]);
  useEffect(
    () =>
      onUndo((e) => {
        if (e.kind === "done") showToast(e.label, true);
        else if (e.kind === "undone") showToast(`Undone: ${e.label}`);
        else if (e.kind === "redone") showToast(`Redone: ${e.label}`);
        else showToast(e.label);
        if (e.kind !== "done") {
          reload();
          setRemote((r) => ({ tick: r.tick + 1, ids: [] }));
        }
      }),
    [showToast, reload],
  );

  useEffect(() => {
    const h = () => setRoute(readRoute());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  useEffect(() => localStorage.setItem("surface.sidebar", sidebar ? "open" : "closed"), [sidebar]);

  const openRecord = useCallback((id: string) => {
    location.hash = `/r/${id}`;
    setSwitcher(false);
    try {
      const recent = JSON.parse(localStorage.getItem("surface.recent") ?? "[]").filter((x: string) => x !== id);
      localStorage.setItem("surface.recent", JSON.stringify([id, ...recent].slice(0, 12)));
    } catch {}
  }, []);
  const openGroup = useCallback((key: string) => (location.hash = `/g/${key}`), []);
  const openView = useCallback((key: string, personal: boolean, thisId: string | null, label?: string) => {
    const p = new URLSearchParams({ ...(personal ? { personal: "1" } : {}), ...(thisId ? { this: thisId } : {}), ...(label ? { label } : {}) });
    location.hash = `/v/${key}${p.toString() ? `?${p}` : ""}`;
  }, []);

  const createPage = useCallback(
    async (parent: string | null, title = "Untitled") => {
      try {
        const { record } = await api.create({ type: "page", title, parent });
        await reload();
        openRecord(record.id);
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [openRecord, reload, showToast],
  );

  const openTitle = useCallback(
    (target: string) => {
      if (!app) return;
      const t = target.toLowerCase();
      const hit = app.records.find((r) => r.title.toLowerCase() === t || (r.path && r.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase() === t));
      if (hit) openRecord(hit.id);
      else if (confirm(`No page called "${target}" yet. Create it?`)) createPage(null, target);
    },
    [app, openRecord, createPage],
  );

  // Sidebar edits: write each scope's definition, optimistic, with undo.
  const writeSidebars = useCallback(
    async (changes: SidebarChange[]) => {
      const cur = appRef.current!;
      setApp({ ...cur, sidebar: { ...cur.sidebar, ...Object.fromEntries(changes.map((c) => [c.scope, { ...cur.sidebar[c.scope], definition: c.def }])) } });
      for (const c of changes) {
        const latest = appRef.current!.sidebar[c.scope];
        try {
          await api.saveSidebar(c.scope, c.def, (await api.state()).sidebar[c.scope].rev ?? null);
        } catch (e) {
          await reload();
          throw e;
        }
        void latest;
      }
      await reload();
    },
    [reload],
  );
  const saveSidebar = useCallback(
    async (changes: SidebarChange[], label: string) => {
      const before = changes.map((c) => ({ scope: c.scope, def: structuredClone(appRef.current!.sidebar[c.scope].definition) }));
      // a missing sidebar row means the default tree is showing; keep that as the starting point
      try {
        await writeSidebars(changes);
        did({ label, undo: () => writeSidebars(before), redo: () => writeSidebars(changes) });
      } catch (e) {
        showToast(`Couldn't change the sidebar: ${(e as Error).message}`);
      }
    },
    [writeSidebars, showToast],
  );
  const setDisplay = useCallback(
    async (display: "split" | "merged") => {
      const def: TreeDef = { ...structuredClone(appRef.current!.sidebar.personal.definition), display };
      try {
        await writeSidebars([{ scope: "personal", def }]);
        showToast(display === "merged" ? "Sidebar shows one tree" : "Sidebar shows two sections");
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [writeSidebars, showToast],
  );

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "p" || e.key === "o")) {
        e.preventDefault();
        setSwitcher((s) => !s);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (mod && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createPage(null);
      } else if (mod && e.key === "[") {
        e.preventDefault();
        history.back();
      } else if (mod && e.key === "]") {
        e.preventDefault();
        history.forward();
      } else if (mod && e.key.toLowerCase() === "z" && !typingTarget(document.activeElement)) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key === "Escape" && switcher) setSwitcher(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [switcher, createPage]);

  // first open: show the first record in the tree
  useEffect(() => {
    if (app && !route) {
      const id = firstRecord(app.sidebar.workspace.tree) ?? firstRecord(app.sidebar.personal.tree);
      if (id) location.replace(`#/r/${id}`);
    }
  }, [app, route]);

  const group = useMemo(() => (app && route?.kind === "group" ? findGroup({ workspace: app.sidebar.workspace.tree, personal: app.sidebar.personal.tree }, route.key) : null), [app, route]);

  useEffect(() => {
    if (!app) return;
    const t =
      route?.kind === "record"
        ? app.records.find((r) => r.id === route.id)?.title
        : route?.kind === "view"
          ? route.label ?? app.views.find((v) => v.key === route.key)?.name
          : group?.node.label;
    document.title = t ? `${t} — Surface` : app.workspace.name;
  }, [app, route, group]);

  if (error && !app) {
    return (
      <div className="fatal">
        <h2>Surface</h2>
        <p>{error}</p>
        <button onClick={reload}>Try again</button>
      </div>
    );
  }
  if (!app) return <div className="boot" />;

  const statusText = status.s === "saving" ? "Saving…" : status.s === "conflict" ? "Conflict" : status.s === "error" ? status.msg ?? "Error" : "Saved";

  return (
    <div className={`shell ${sidebar ? "" : "side-closed"}`}>
      <Sidebar
        app={app}
        current={route}
        online={online}
        status={statusText}
        openRecord={openRecord}
        openGroup={openGroup}
        openView={openView}
        newPage={() => createPage(null)}
        newInside={(parent) => createPage(parent)}
        openSwitcher={() => setSwitcher(true)}
        saveSidebar={saveSidebar}
        pickRecord={(title, onPick) => setPanel({ kind: "pick", title, onPick })}
        newView={(scope, onCreated) => setPanel({ kind: "newView", scope, onCreated })}
        editView={(key, personal) => {
          const v = app.views.find((x) => x.key === key && x.personal === personal);
          if (v) setPanel({ kind: "editView", view: v });
        }}
        moveTo={(id) => setPanel({ kind: "move", id })}
        openSettings={() => setPanel({ kind: "settings" })}
        openShare={() => setPanel({ kind: "share" })}
      />
      <main className="main">
        <button className="side-toggle" onClick={() => setSidebar(!sidebar)} title="Toggle sidebar (⌘\)" aria-label="Toggle sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 5.5h16v13H4z M9.5 5.5v13" /></svg>
        </button>
        {route?.kind === "record" ? (
          <Page
            key={route.id}
            id={route.id}
            app={app}
            remoteTick={remote.tick}
            remoteIds={remote.ids}
            open={openRecord}
            openTitle={openTitle}
            createPage={(parent) => createPage(parent)}
            onStatus={(s, msg) => setStatus({ s, msg })}
            onDeleted={() => {
              reload();
              history.back();
            }}
            onMove={() => setPanel({ kind: "move", id: route.id })}
          />
        ) : route?.kind === "view" ? (
          <ViewPage
            key={`${route.key}:${route.personal}:${route.thisId}`}
            app={app}
            viewKey={route.key}
            personal={route.personal}
            thisId={route.thisId}
            label={route.label}
            remoteTick={remote.tick}
            open={openRecord}
            onToast={(m) => showToast(m)}
            onDeleted={() => {
              reload();
              history.back();
            }}
          />
        ) : group ? (
          <GroupView app={app} node={group.node} path={group.labels.map((l) => app.records.find((r) => r.id === l)?.title ?? l)} open={openRecord} />
        ) : (
          <div className="page-empty">Pick something on the left, or press ⌘K.</div>
        )}
      </main>
      {switcher ? <Switcher records={app.records} onPick={openRecord} onCreate={(t) => (setSwitcher(false), createPage(null, t))} onClose={() => setSwitcher(false)} /> : null}
      {panel?.kind === "settings" ? <Settings app={app} onClose={() => setPanel(null)} setDisplay={setDisplay} onToast={(m) => (showToast(m), reload())} /> : null}
      {panel?.kind === "share" ? <Share app={app} onClose={() => setPanel(null)} onToast={(m) => showToast(m)} /> : null}
      {panel?.kind === "move" ? (
        <MoveTo
          app={app}
          id={panel.id}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            reload();
            setRemote((r) => ({ tick: r.tick + 1, ids: [panel.id] }));
          }}
        />
      ) : null}
      {panel?.kind === "pick" ? (
        <RecordPicker
          app={app}
          title={panel.title}
          onPick={(id) => {
            const p = panel;
            setPanel(null);
            p.onPick(id);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel?.kind === "newView" ? (
        <ViewEditor
          app={app}
          start={{ personal: panel.scope === "personal" }}
          onClose={() => setPanel(null)}
          onSaved={async (v) => {
            const p = panel;
            setPanel(null);
            await reload();
            p.onCreated(v);
          }}
        />
      ) : null}
      {panel?.kind === "editView" ? (
        <ViewEditor
          app={app}
          initial={panel.view}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            reload();
            setRemote((r) => ({ tick: r.tick + 1, ids: [] }));
          }}
          onDeleted={() => {
            setPanel(null);
            reload();
          }}
        />
      ) : null}
      {toast ? (
        <div className="toast" key={toast.n} role="status">
          <span>{toast.msg}</span>
          {toast.undo ? (
            <button
              onClick={() => {
                setToast(null);
                undo();
              }}
            >
              Undo <kbd>⌘Z</kbd>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
