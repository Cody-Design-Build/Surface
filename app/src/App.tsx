import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, subscribe, type AppState, type TreeNode } from "./api.ts";
import { GroupView } from "./GroupView.tsx";
import { Page, type SaveStatus } from "./Page.tsx";
import { nodeKey, Sidebar } from "./Sidebar.tsx";
import { Switcher } from "./Switcher.tsx";

type Route = { kind: "record"; id: string } | { kind: "group"; key: string } | null;

function readRoute(): Route {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith("/r/")) return { kind: "record", id: h.slice(3) };
  if (h.startsWith("/g/")) return { kind: "group", key: h.slice(3) };
  return null;
}

function findGroup(nodes: TreeNode[], key: string, path: string[] = []): { node: TreeNode; labels: string[] } | null {
  for (const n of nodes) {
    const p = [...path, n.id ?? n.label];
    if (nodeKey(p) === key) return { node: n, labels: [...labelsOf(nodes, p)] };
    const hit = findGroup(n.children, key, p);
    if (hit) return hit;
  }
  return null;
}
function labelsOf(_nodes: TreeNode[], p: string[]) {
  return p;
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

  const reload = useCallback(async () => {
    try {
      setApp(await api.state());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? e.message : `Can't reach surface serve (${(e as Error).message}).`);
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

  const createPage = useCallback(
    async (parent: string | null, title = "Untitled") => {
      try {
        const { record } = await api.create({ type: "page", title, parent });
        await reload();
        openRecord(record.id);
      } catch (e) {
        alert((e as Error).message);
      }
    },
    [openRecord, reload],
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
      } else if (e.key === "Escape" && switcher) setSwitcher(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [switcher, createPage]);

  // first open: show the first record in the tree
  useEffect(() => {
    if (app && !route) {
      const id = firstRecord(app.tree);
      if (id) location.replace(`#/r/${id}`);
    }
  }, [app, route]);

  const group = useMemo(() => (app && route?.kind === "group" ? findGroup(app.tree, route.key) : null), [app, route]);

  useEffect(() => {
    if (!app) return;
    const t = route?.kind === "record" ? app.records.find((r) => r.id === route.id)?.title : group?.node.label;
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
        newPage={() => createPage(null)}
        newInside={(parent) => createPage(parent)}
        openSwitcher={() => setSwitcher(true)}
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
          />
        ) : group ? (
          <GroupView app={app} node={group.node} path={group.labels.map((l) => app.records.find((r) => r.id === l)?.title ?? l)} open={openRecord} />
        ) : (
          <div className="page-empty">Pick a page on the left, or press ⌘K.</div>
        )}
      </main>
      {switcher ? <Switcher records={app.records} onPick={openRecord} onCreate={(t) => (setSwitcher(false), createPage(null, t))} onClose={() => setSwitcher(false)} /> : null}
    </div>
  );
}
