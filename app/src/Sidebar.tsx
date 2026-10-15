import { useEffect, useState } from "react";
import type { AppState, TreeNode } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";

export function nodeKey(path: string[]) {
  return path.join("/");
}

interface Props {
  app: AppState;
  current: { kind: "record"; id: string } | { kind: "group"; key: string } | null;
  online: boolean;
  status: string;
  openRecord: (id: string) => void;
  openGroup: (key: string) => void;
  newPage: () => void;
  newInside: (parent: string) => void;
  openSwitcher: () => void;
}

const EXPANDED_KEY = "surface.expanded";

export function Sidebar({ app, current, online, status, openRecord, openGroup, newPage, newInside, openSwitcher }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)), [expanded]);
  const toggle = (k: string, def: boolean) => setExpanded((e) => ({ ...e, [k]: !(e[k] ?? def) }));

  // reveal the open record
  useEffect(() => {
    if (current?.kind !== "record") return;
    const found: string[] = [];
    const walk = (nodes: TreeNode[], path: string[]): boolean => {
      for (const n of nodes) {
        const p = [...path, n.id ?? n.label];
        if (n.id === current.id) return true;
        if (walk(n.children, p)) {
          found.push(nodeKey(p));
          return true;
        }
      }
      return false;
    };
    walk(app.tree, []);
    if (found.length) setExpanded((e) => Object.fromEntries([...Object.entries(e), ...found.map((k) => [k, true])]));
  }, [current, app.tree]);

  const render = (nodes: TreeNode[], path: string[], depth: number) =>
    nodes.map((n, i) => {
      const p = [...path, n.id ?? n.label];
      const k = nodeKey(p);
      const hasKids = n.children.length > 0;
      const isGroup = n.kind === "group";
      const open = expanded[k] ?? (isGroup && depth === 0);
      const selected = current?.kind === "record" ? current.id === n.id && !isGroup : current?.kind === "group" && current.key === k;
      return (
        <li key={`${k}:${i}`}>
          <div
            className={`node ${isGroup ? "is-group" : ""} ${selected ? "is-selected" : ""} ${depth === 0 && isGroup ? "is-section" : ""}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            onClick={() => (isGroup ? (depth === 0 ? toggle(k, true) : openGroup(k)) : openRecord(n.id!))}
          >
            <button
              className={`twirl ${hasKids ? "" : "is-leaf"} ${open ? "is-open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasKids) toggle(k, isGroup && depth === 0);
              }}
              tabIndex={-1}
              aria-label={open ? "Collapse" : "Expand"}
            >
              {hasKids ? <Icon name="chevron" size={12} /> : null}
            </button>
            {depth === 0 && isGroup ? null : <Icon name={isGroup ? "folder" : typeIcon(n.type)} size={15} className="node-icon" />}
            <span className="node-label">{n.label}</span>
            {depth === 0 && isGroup ? (
              <button
                className="section-open"
                title={`Open ${n.label} as a list`}
                onClick={(e) => {
                  e.stopPropagation();
                  openGroup(k);
                }}
              >
                <Icon name="table" size={13} />
              </button>
            ) : isGroup && hasKids ? (
              <span className="node-count">{n.children.length}</span>
            ) : !isGroup ? (
              <button
                className="node-add"
                title="Add a page inside"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((x) => ({ ...x, [k]: true }));
                  newInside(n.id!);
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            ) : null}
          </div>
          {hasKids && open ? <ul>{render(n.children, p, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="ws">
          <div className="ws-mark">{app.workspace.name.slice(0, 1).toUpperCase()}</div>
          <div className="ws-text">
            <div className="ws-name">{app.workspace.name}</div>
            <div className="ws-user">{app.user.email}</div>
          </div>
        </div>
        <button className="search-btn" onClick={openSwitcher}>
          <Icon name="search" size={15} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="tree">
        <ul>{render(app.tree, [], 0)}</ul>
        {!app.hasSidebar ? <div className="tree-hint">Showing a group per type. Shape this sidebar in <code>.surface/views/sidebar.yaml</code>.</div> : null}
      </nav>
      <div className="side-bottom">
        <button className="new-btn" onClick={newPage}>
          <Icon name="plus" size={15} /> New page
        </button>
        <span className={`sync ${online ? "" : "is-off"}`} title={online ? `Connected · ${app.root}` : "Not connected to surface serve"}>
          <span className="dot" />
          {online ? status : "Offline"}
        </span>
      </div>
    </aside>
  );
}
