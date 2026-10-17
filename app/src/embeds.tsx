// Block widgets in the editor: live view embeds and rendered Markdown tables.
//
// A live view is written as plain Markdown, readable anywhere:
//
//   ```surface
//   view: job-tasks
//   ```
//
// or `![[Job tasks]]` on its own line when that's a saved view's name. In the app it renders as the
// view (tabs, editing, board drag), with `this` = the page it's on. Put the cursor inside to edit
// the source. GFM pipe tables render as tables; click one to edit its text.
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import type { AppState } from "./api.ts";
import { ViewPage } from "./ViewPage.tsx";

// ------------------------------------------------------------------ context for embeds
export interface EmbedCtx {
  app: AppState;
  thisId: string;
  remoteTick: number;
  open: (id: string) => void;
  openView: (key: string, personal: boolean, thisId: string | null, label?: string) => void;
  toast: (m: string) => void;
}
let ctx: EmbedCtx | null = null;
const listeners = new Set<() => void>();
export function setEmbedCtx(c: EmbedCtx) {
  ctx = c;
  for (const l of listeners) l();
}

function EmbedHost({ viewKey, personal }: { viewKey: string; personal: boolean }) {
  const c = ctx;
  if (!c) return null;
  const v = c.app.views.find((x) => x.key === viewKey && x.personal === personal) ?? c.app.views.find((x) => x.key === viewKey);
  if (!v) return <div className="embed-missing">No saved view “{viewKey}”. Views: {c.app.views.map((x) => x.key).join(", ") || "none"}</div>;
  return (
    <ViewPage
      app={c.app}
      viewKey={v.key}
      personal={v.personal}
      thisId={c.thisId}
      remoteTick={c.remoteTick}
      open={c.open}
      onToast={c.toast}
      onDeleted={() => {}}
      embedded
      onExpand={() => c.openView(v.key, v.personal, c.thisId, v.name)}
    />
  );
}

class ViewWidget extends WidgetType {
  root: Root | null = null;
  unsub: (() => void) | null = null;
  constructor(readonly key: string, readonly personal: boolean, readonly from: number) {
    super();
  }
  eq(o: ViewWidget) {
    return o.key === this.key && o.personal === this.personal;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-embed";
    wrap.contentEditable = "false";
    const bar = document.createElement("button");
    bar.className = "cm-embed-src";
    bar.textContent = "Edit source";
    bar.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 3 } });
      view.focus();
    };
    const host = document.createElement("div");
    wrap.append(host, bar);
    const root = createRoot(host);
    const render = () => root.render(<EmbedHost viewKey={this.key} personal={this.personal} />);
    render();
    listeners.add(render);
    this.root = root;
    this.unsub = () => listeners.delete(render);
    return wrap;
  }
  destroy() {
    this.unsub?.();
    const r = this.root;
    window.setTimeout(() => r?.unmount(), 0);
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 260;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly src: string, readonly from: number) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src;
  }
  toDOM(view: EditorView) {
    const rows = this.src
      .trim()
      .split("\n")
      .map((l) => splitRow(l));
    const align = (rows[1] ?? []).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : "left"));
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table";
    const t = document.createElement("table");
    const thead = t.createTHead().insertRow();
    for (const [i, c] of (rows[0] ?? []).entries()) {
      const th = document.createElement("th");
      th.textContent = stripInline(c);
      th.style.textAlign = align[i] ?? "left";
      thead.appendChild(th);
    }
    const tb = t.createTBody();
    rows.slice(2).forEach((r, ri) => {
      const tr = tb.insertRow();
      for (let i = 0; i < (rows[0]?.length ?? r.length); i++) {
        const td = tr.insertCell();
        td.textContent = stripInline(r[i] ?? "");
        td.style.textAlign = align[i] ?? "left";
        // click a cell: put the cursor in that cell's text
        td.onmousedown = (e) => {
          e.preventDefault();
          view.dispatch({ selection: { anchor: cellPos(this.src, this.from, ri + 2, i) } });
          view.focus();
        };
      }
    });
    t.querySelectorAll("th").forEach((th, i) => {
      (th as HTMLElement).onmousedown = (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: cellPos(this.src, this.from, 0, i) } });
        view.focus();
      };
    });
    wrap.appendChild(t);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function splitRow(line: string) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function stripInline(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\W)[_*](.+?)[_*](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}
function cellPos(src: string, from: number, row: number, col: number) {
  const lines = src.split("\n");
  let pos = from;
  for (let i = 0; i < row && i < lines.length; i++) pos += lines[i].length + 1;
  const line = lines[Math.min(row, lines.length - 1)] ?? "";
  let pipes = line.trim().startsWith("|") ? -1 : 0;
  const lead = line.length - line.trimStart().length;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") pipes++;
    if (pipes === col && (line[i] === "|" || i === lead)) {
      let j = line[i] === "|" ? i + 1 : i;
      while (line[j] === " ") j++;
      return pos + j;
    }
  }
  return pos;
}

// ------------------------------------------------------------------ decorations
function viewNameMap(): Map<string, { key: string; personal: boolean }> {
  const m = new Map<string, { key: string; personal: boolean }>();
  for (const v of ctx?.app.views ?? []) {
    m.set(v.name.toLowerCase(), { key: v.key, personal: v.personal });
    m.set(v.key.toLowerCase(), { key: v.key, personal: v.personal });
  }
  return m;
}

function build(state: EditorState, focused: boolean): DecorationSet {
  const doc = state.doc;
  const sel = state.selection.ranges;
  const touched = (a: number, b: number) => focused && sel.some((r) => r.from <= b && r.to >= a);
  const out: { from: number; to: number; deco: Decoration }[] = [];
  const names = viewNameMap();

  // ```surface blocks
  const text = doc.toString();
  const fence = /^```surface[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (touched(from, to)) continue;
    const key = /^\s*view:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(m[1])?.[1];
    const personal = /^\s*personal:\s*true\s*$/m.test(m[1]);
    if (!key) continue;
    out.push({ from, to, deco: Decoration.replace({ widget: new ViewWidget(key.trim(), personal, from), block: true }) });
  }
  // ![[View name]] alone on a line, when it names a saved view
  const emb = /^!\[\[([^\]|\n]+)\]\][ \t]*$/gm;
  while ((m = emb.exec(text))) {
    const hit = names.get(m[1].trim().toLowerCase());
    if (!hit) continue;
    const from = m.index;
    const to = from + m[0].length;
    if (touched(from, to)) continue;
    out.push({ from, to, deco: Decoration.replace({ widget: new ViewWidget(hit.key, hit.personal, from), block: true }) });
  }
  // GFM tables
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "FencedCode") return false;
      if (n.name !== "Table") return;
      const from = doc.lineAt(n.from).from;
      const to = doc.lineAt(n.to).to;
      if (!touched(from, to)) out.push({ from, to, deco: Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to), from), block: true }) });
      return false;
    },
  });
  out.sort((a, b) => a.from - b.from);
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const d of out) {
    if (d.from < last) continue;
    b.add(d.from, d.to, d.deco);
    last = d.to;
  }
  return b.finish();
}

const embedField = StateField.define<{ deco: DecorationSet; focused: boolean }>({
  create: (s) => ({ deco: build(s, false), focused: false }),
  update(v, tr) {
    const focused = tr.effects.some((e) => e.is(focusEffect)) ? tr.effects.find((e) => e.is(focusEffect))!.value : v.focused;
    if (tr.docChanged || tr.selection || focused !== v.focused || tr.effects.some((e) => e.is(refreshEffect)) || syntaxTree(tr.startState) !== syntaxTree(tr.state))
      return { deco: build(tr.state, focused), focused };
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const focusEffect = StateEffect.define<boolean>();
export const refreshEffect = StateEffect.define<null>();

export function embeds(): Extension {
  return [
    embedField,
    EditorView.focusChangeEffect.of((_s, focusing) => focusEffect.of(focusing)),
  ];
}
