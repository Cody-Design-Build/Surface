// Relationship map: every record as a dot, every link field as a line, coloured by table.
//
// Adapted from Morrow's GraphView (https://github.com/Aarav2709/Morrow,
// src/app/components/GraphView.tsx), Copyright Aarav Gupta and Morrow contributors,
// licensed under the Apache License 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Changes for Surface: the graph is built from Surface records and typed link fields instead of
// Markdown pages, tags and wiki links; nodes are coloured by table; a table filter and a
// "focus on a record" depth mode replace Morrow's tag/subpage toggles; clicking opens the
// record sheet; options are stored under surface-data-graph.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AppState, type RecordFull } from "./api.ts";
import { Icon } from "./Icon.tsx";

export interface GraphNode { id: string; label: string; table: string; degree: number }
export interface GraphLink { source: string; target: string; field: string }
export interface GraphData { nodes: GraphNode[]; links: GraphLink[] }

/** Build the graph from records and the link fields of their tables. Pure, so it is easy to test. */
export function buildGraph(app: AppState, records: RecordFull[], opts: { tables: Set<string>; orphans: boolean; focus: string | null; depth: number }): GraphData {
  const linkFields = new Map(app.types.map((t) => [t.key, t.fields.filter((f) => f.kind === "link")]));
  const byId = new Map(records.map((r) => [r.id, r]));
  const all: GraphLink[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const f of linkFields.get(r.type) ?? []) {
      const v = r.fields[f.key];
      for (const id of v == null ? [] : (Array.isArray(v) ? v : [v]).map(String)) {
        if (!byId.has(id) || id === r.id) continue;
        const key = r.id < id ? `${r.id}|${id}|${f.key}` : `${id}|${r.id}|${f.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ source: r.id, target: id, field: f.name });
      }
    }
  }
  let keep: Set<string>;
  if (opts.focus && byId.has(opts.focus)) {
    // breadth-first from the focused record, across every table (filter applies after)
    const adj = new Map<string, string[]>();
    for (const l of all) {
      (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
      (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
    }
    keep = new Set([opts.focus]);
    let frontier = [opts.focus];
    for (let d = 0; d < opts.depth; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) { keep.add(n); next.push(n); }
      frontier = next;
    }
  } else keep = new Set(records.map((r) => r.id));
  for (const id of [...keep]) if (id !== opts.focus && !opts.tables.has(byId.get(id)!.type)) keep.delete(id);
  const links = all.filter((l) => keep.has(l.source) && keep.has(l.target));
  const degree = new Map<string, number>();
  for (const l of links) { degree.set(l.source, (degree.get(l.source) ?? 0) + 1); degree.set(l.target, (degree.get(l.target) ?? 0) + 1); }
  const nodes = [...keep]
    .filter((id) => opts.orphans || opts.focus === id || degree.has(id))
    .map((id) => { const r = byId.get(id)!; return { id, label: r.title || "Untitled", table: r.type, degree: degree.get(id) ?? 0 }; });
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
}

// a fixed, readable palette; each table keeps its colour by position in the workspace's table list
const PALETTE = ["#4c9aff", "#f5a524", "#3fbf7f", "#a879ff", "#ff6fa8", "#e6c229", "#ff6b5e", "#5cc8d6", "#b98a5b", "#8fa1b3"];
export const tableColor = (app: AppState, table: string) => PALETTE[Math.max(0, app.types.findIndex((t) => t.key === table)) % PALETTE.length];

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { field: string };
const OPTIONS_KEY = "surface-data-graph";

export function RelationshipGraph({ app, tick, open }: { app: AppState; tick: number; open: (id: string) => void }) {
  const [records, setRecords] = useState<RecordFull[] | null>(null);
  const [error, setError] = useState("");
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") as { hidden?: string[]; orphans?: boolean; depth?: number }; } catch { return {}; } }, []);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(saved.hidden ?? []));
  const [orphans, setOrphans] = useState(saved.orphans ?? false);
  const [depth, setDepth] = useState(saved.depth === 2 || saved.depth === 3 ? saved.depth : 1);
  const [focus, setFocus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => { localStorage.setItem(OPTIONS_KEY, JSON.stringify({ hidden: [...hidden], orphans, depth })); }, [hidden, orphans, depth]);

  // all records with their fields: one query per table (the state summary has no field values)
  useEffect(() => {
    let live = true;
    Promise.all(app.types.map((t) => api.query({ from: t.key }).then((r) => r.records)))
      .then((lists) => { if (live) { setRecords(lists.flat()); setError(""); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [app.types, tick]);

  const tables = useMemo(() => new Set(app.types.map((t) => t.key).filter((k) => !hidden.has(k))), [app.types, hidden]);
  const graph = useMemo(() => (records ? buildGraph(app, records, { tables, orphans, focus, depth }) : { nodes: [], links: [] }), [app, records, tables, orphans, focus, depth]);
  const counts = useMemo(() => { const c = new Map<string, number>(); for (const n of graph.nodes) c.set(n.table, (c.get(n.table) ?? 0) + 1); return c; }, [graph]);
  const latest = useRef({ open, setFocus });
  latest.current = { open, setFocus };

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const style = getComputedStyle(wrap);
    const read = (n: string, fallback: string) => style.getPropertyValue(n).trim() || fallback;
    const colors = { link: read("--line", "#8884"), text: read("--text-muted", "#999"), strong: read("--text-strong", "#eee"), accent: read("--accent", "#287d86") };
    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = graph.links.map((l) => ({ source: l.source, target: l.target, field: l.field }));
    const neighbours = new Map<string, Set<string>>();
    for (const l of graph.links) {
      neighbours.set(l.source, (neighbours.get(l.source) ?? new Set()).add(l.target));
      neighbours.set(l.target, (neighbours.get(l.target) ?? new Set()).add(l.source));
    }
    const term = query.trim().toLowerCase();
    const matches = (n: SimNode) => !term || n.label.toLowerCase().includes(term);
    let width = 0, height = 0, view = { x: 0, y: 0, k: 1 };
    let hover: SimNode | null = null, dragging: SimNode | null = null, moved = false, frame = 0;
    let panning: { x: number; y: number; vx: number; vy: number } | null = null;
    const radius = (n: SimNode) => 3.5 + Math.sqrt(n.degree) * 1.6 + (n.id === focus ? 3 : 0);

    const draw = () => {
      frame = 0;
      const ratio = window.devicePixelRatio || 1;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(width / 2 + view.x, height / 2 + view.y);
      context.scale(view.k, view.k);
      const lit = hover ? new Set([hover.id, ...(neighbours.get(hover.id) ?? [])]) : null;
      context.lineWidth = 1 / view.k;
      for (const l of links) {
        const s = l.source as SimNode, t = l.target as SimNode;
        const on = lit && lit.has(s.id) && lit.has(t.id);
        context.strokeStyle = on ? colors.accent : colors.link;
        context.globalAlpha = lit && !on ? 0.12 : on ? 1 : 0.7;
        context.beginPath(); context.moveTo(s.x ?? 0, s.y ?? 0); context.lineTo(t.x ?? 0, t.y ?? 0); context.stroke();
      }
      for (const n of nodes) {
        const on = !lit || lit.has(n.id), found = matches(n);
        context.globalAlpha = on && found ? 1 : 0.15;
        context.fillStyle = tableColor(app, n.table);
        context.beginPath(); context.arc(n.x ?? 0, n.y ?? 0, radius(n), 0, Math.PI * 2); context.fill();
        if (n.id === focus || n === hover || (term && found)) {
          context.strokeStyle = colors.strong; context.lineWidth = 1.5 / view.k; context.stroke(); context.lineWidth = 1 / view.k;
        }
      }
      context.textAlign = "center"; context.textBaseline = "top";
      const fontSize = 11 / Math.max(view.k, 0.6);
      context.font = `${fontSize}px ${style.fontFamily}`;
      const labelOf = (n: SimNode) => (n.label.length > 36 ? `${n.label.slice(0, 35)}…` : n.label);
      for (const n of nodes) {
        if (n === hover) continue;
        const show = view.k > 1.3 || (lit && lit.has(n.id)) || n.id === focus || (term && matches(n)) || (nodes.length < 40);
        if (!show) continue;
        context.globalAlpha = lit && !lit.has(n.id) ? 0.2 : 0.9;
        context.fillStyle = colors.text;
        context.fillText(labelOf(n), n.x ?? 0, (n.y ?? 0) + radius(n) + 3 / view.k);
      }
      if (hover) {
        context.globalAlpha = 1; context.fillStyle = colors.strong; context.textBaseline = "bottom";
        context.fillText(labelOf(hover), hover.x ?? 0, (hover.y ?? 0) - radius(hover) - 5 / view.k);
      }
      context.globalAlpha = 1;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      schedule();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    const simulation: Simulation<SimNode, SimLink> = forceSimulation(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((n) => n.id).distance(46).strength(0.6))
      .force("charge", forceManyBody().strength(-80).distanceMax(380))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.05))
      .force("y", forceY(0).strength(0.05))
      .force("collide", forceCollide<SimNode>((n) => radius(n) + 3))
      .on("tick", schedule);
    const toWorld = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left - width / 2 - view.x) / view.k, y: (e.clientY - rect.top - height / 2 - view.y) / view.k };
    };
    const nodeAt = (e: PointerEvent | MouseEvent) => {
      const p = toWorld(e);
      let best: SimNode | null = null, dist = Infinity;
      for (const n of nodes) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
        if (d < Math.max(radius(n) + 4, 8 / view.k) && d < dist) { best = n; dist = d; }
      }
      return best;
    };
    const onDown = (e: PointerEvent) => {
      moved = false;
      const n = nodeAt(e);
      canvas.setPointerCapture(e.pointerId);
      if (n) { dragging = n; simulation.alphaTarget(0.3).restart(); }
      else panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    };
    const onMove = (e: PointerEvent) => {
      if (dragging) { const p = toWorld(e); dragging.fx = p.x; dragging.fy = p.y; moved = true; }
      else if (panning) {
        view = { ...view, x: panning.vx + e.clientX - panning.x, y: panning.vy + e.clientY - panning.y };
        moved = moved || Math.abs(e.clientX - panning.x) + Math.abs(e.clientY - panning.y) > 3;
        schedule();
      } else {
        const next = nodeAt(e);
        if (next !== hover) { hover = next; canvas.style.cursor = next ? "pointer" : "grab"; canvas.title = next ? `${next.label} · ${app.types.find((t) => t.key === next.table)?.name ?? next.table}` : ""; schedule(); }
      }
    };
    const onUp = (e: PointerEvent) => {
      if (dragging) {
        const n = dragging;
        dragging.fx = null; dragging.fy = null; simulation.alphaTarget(0);
        // click opens the record; shift-click focuses the map on it
        if (!moved) (e.shiftKey ? latest.current.setFocus(n.id) : latest.current.open(n.id));
      }
      dragging = null; panning = null;
      canvas.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - width / 2, py = e.clientY - rect.top - height / 2;
      const k = Math.min(6, Math.max(0.1, view.k * Math.exp(-e.deltaY / 300)));
      view = { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k };
      schedule();
    };
    const onLeave = () => { hover = null; schedule(); };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      simulation.stop(); observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [graph, query, focus, app]);

  const focused = focus ? records?.find((r) => r.id === focus) : undefined;
  const toggleTable = (key: string) => setHidden((h) => { const n = new Set(h); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return <section className="data-graph" aria-label="Relationship map">
    <div className="data-table-heading"><h1>{focused ? `Around ${focused.title}` : "Relationship map"}</h1><span className="data-graph-sub">{records ? `${graph.nodes.length} records · ${graph.links.length} links` : "Loading records…"}</span></div>
    {error && <div className="banner" role="alert">{error}</div>}
    <div className="data-graph-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="data-graph-canvas" role="img" aria-label={`Relationship map of ${graph.nodes.length} records and ${graph.links.length} links. Click a dot to open its record; shift-click to focus on it.`} />
      <div className="data-graph-controls menu">
        <label className="data-graph-search"><Icon name="search" size={13} /><input aria-label="Find in map" placeholder="Find in map" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="data-graph-legend" role="group" aria-label="Tables shown">
          {app.types.map((t) => <label key={t.key} className={hidden.has(t.key) ? "is-off" : ""}><input type="checkbox" checked={!hidden.has(t.key)} onChange={() => toggleTable(t.key)} /><i style={{ background: tableColor(app, t.key) }} />{t.name}<small>{counts.get(t.key) ?? 0}</small></label>)}
        </div>
        {focus ? <>
          <label className="data-graph-row">Depth<select aria-label="Depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))}><option value={1}>1 link away</option><option value={2}>2 links away</option><option value={3}>3 links away</option></select></label>
          <button type="button" className="data-graph-link" onClick={() => setFocus(null)}>Show the whole map</button>
        </> : <label className="data-graph-row"><input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} />Show records with no links</label>}
        <p className="data-graph-hint">Click a dot to open it. Shift-click to see only what's connected to it. Drag to move, scroll to zoom.</p>
      </div>
    </div>
  </section>;
}
