import { workspaceUrl } from "./api.ts";
// Live preview for Markdown in CodeMirror 6: markers step aside when the cursor leaves the line.
import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSet, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

class BulletWidget extends WidgetType {
  constructor(readonly ordered: string | null) {
    super();
  }
  eq(o: BulletWidget) {
    return o.ordered === this.ordered;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.ordered ? "cm-ol-mark" : "cm-bullet";
    s.textContent = this.ordered ?? "•";
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-task" + (this.checked ? " is-done" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    };
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class CalloutWidget extends WidgetType {
  constructor(readonly kind: string, readonly showLabel: boolean) {
    super();
  }
  eq(o: CalloutWidget) {
    return o.kind === this.kind && o.showLabel === this.showLabel;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-callout-label";
    s.textContent = this.showLabel ? this.kind.charAt(0).toUpperCase() + this.kind.slice(1) : "";
    return s;
  }
}

// Where relative image paths resolve (the open record's folder in the checkout).
let imageBase = "";
export function setImageBase(folder: string) {
  imageBase = folder;
}
function imageUrl(src: string) {
  if (/^(https?:|data:)/i.test(src)) return src;
  const clean = decodeURI(src.replace(/^<|>$/g, ""));
  const parts = (clean.startsWith("/") ? clean.slice(1) : imageBase ? `${imageBase}/${clean}` : clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return workspaceUrl(`/api/file?path=${encodeURIComponent(out.join("/"))}`);
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = imageUrl(this.src);
    img.alt = this.alt;
    img.loading = "lazy";
    img.onerror = () => {
      wrap.classList.add("is-broken");
      wrap.textContent = `Image not found: ${this.src}`;
    };
    wrap.appendChild(img);
    return wrap;
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-hr-line";
    return hr;
  }
}

const hide = Decoration.replace({});
const lineDeco = (cls: string) => Decoration.line({ class: cls });

function activeLines(state: EditorState, focused: boolean): Set<number> {
  const set = new Set<number>();
  if (!focused) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

function build(view: EditorView): { all: DecorationSet; hidden: DecorationSet } {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state, view.hasFocus);
  const decos: Range<Decoration>[] = [];
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  // Inline markers are revealed only when the selection touches that element.
  const touches = (a: number, b: number) => view.hasFocus && state.selection.ranges.some((r) => r.from <= b && r.to >= a);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) {
          const line = doc.lineAt(node.from);
          decos.push(lineDeco(`cm-h cm-h${h[1]}`).range(line.from));
          return;
        }
        if (name === "SetextHeading1" || name === "SetextHeading2") {
          decos.push(lineDeco(`cm-h cm-h${name.endsWith("1") ? 1 : 2}`).range(doc.lineAt(node.from).from));
          return;
        }
        if (name === "HeaderMark") {
          if (!isActive(node.from)) {
            const after = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            if (doc.lineAt(node.from).from === node.from) decos.push(hide.range(node.from, after));
            else decos.push(hide.range(node.from, node.to));
          } else decos.push(Decoration.mark({ class: "cm-mark" }).range(node.from, node.to));
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark" || (name === "CodeMark" && node.node.parent?.name === "InlineCode")) {
          const p = node.node.parent!;
          if (!touches(p.from, p.to)) decos.push(hide.range(node.from, node.to));
          else decos.push(Decoration.mark({ class: "cm-mark" }).range(node.from, node.to));
          return;
        }
        if (name === "InlineCode") {
          decos.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
          return;
        }
        if (name === "Link") {
          const text = doc.sliceString(node.from, node.to);
          const m = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)$/.exec(text);
          if (m) {
            const url = m[2];
            const tFrom = node.from + 1;
            const tTo = tFrom + m[1].length;
            decos.push(Decoration.mark({ class: "cm-url-link", attributes: { "data-url": url, title: url } }).range(tFrom, tTo));
            if (!touches(node.from, node.to)) {
              decos.push(hide.range(node.from, tFrom));
              decos.push(hide.range(tTo, node.to));
            } else {
              decos.push(Decoration.mark({ class: "cm-mark" }).range(node.from, tFrom));
              decos.push(Decoration.mark({ class: "cm-mark" }).range(tTo, node.to));
            }
          }
          return false;
        }
        if (name === "Image") {
          const text = doc.sliceString(node.from, node.to);
          const m = /^!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)[^)]*\)$/.exec(text);
          if (m && !touches(node.from, node.to)) decos.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(node.from, node.to));
          return false;
        }
        if (name === "URL" && node.node.parent?.name !== "Link" && node.node.parent?.name !== "Image") {
          const url = doc.sliceString(node.from, node.to);
          decos.push(Decoration.mark({ class: "cm-url-link", attributes: { "data-url": url } }).range(node.from, node.to));
          return;
        }
        if (name === "ListMark") {
          const mark = doc.sliceString(node.from, node.to);
          const parentList = node.node.parent?.parent?.name;
          const next = node.node.nextSibling;
          if (next?.name === "Task") {
            const tm = next.firstChild;
            const end = tm && tm.name === "TaskMarker" ? tm.to : next.from;
            if (!touches(node.from, end)) decos.push(hide.range(node.from, Math.min(node.to + 1, next.from)));
            return;
          }
          if (!touches(node.from, node.to + 1)) {
            const ordered = parentList === "OrderedList" ? mark : null;
            decos.push(Decoration.replace({ widget: new BulletWidget(ordered) }).range(node.from, node.to));
          }
          return;
        }
        if (name === "TaskMarker") {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          const lm = node.node.parent?.prevSibling;
          const startTouch = lm && lm.name === "ListMark" ? lm.from : node.from;
          if (!touches(startTouch, node.to)) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
          if (checked) {
            const line = doc.lineAt(node.from);
            if (node.to + 1 < line.to) decos.push(Decoration.mark({ class: "cm-task-done" }).range(node.to + 1, line.to));
          }
          return;
        }
        if (name === "Blockquote") {
          const first = doc.lineAt(node.from);
          const lastNo = doc.lineAt(node.to).number;
          const c = /^(\s*>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/.exec(first.text);
          if (c) {
            const kind = c[2].toLowerCase();
            for (let l = first.number; l <= lastNo; l++) {
              const cls = ["cm-callout", `cm-callout-${kind}`, l === first.number ? "cm-callout-first" : "", l === lastNo ? "cm-callout-last" : ""].join(" ");
              decos.push(lineDeco(cls).range(doc.line(l).from));
            }
            const mFrom = first.from + c[1].length;
            const mTo = mFrom + c[0].length - c[1].length - c[3].length;
            if (!isActive(first.from)) decos.push(Decoration.replace({ widget: new CalloutWidget(kind, !c[3]) }).range(mFrom, mTo));
            else decos.push(Decoration.mark({ class: "cm-mark" }).range(mFrom, mTo));
            if (c[3]) decos.push(Decoration.mark({ class: "cm-callout-title" }).range(mTo, first.to));
            return;
          }
          for (let l = first.number; l <= lastNo; l++) decos.push(lineDeco("cm-quote").range(doc.line(l).from));
          return;
        }
        if (name === "QuoteMark") {
          if (!isActive(node.from)) {
            const after = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            decos.push(hide.range(node.from, after));
          }
          return;
        }
        if (name === "HorizontalRule") {
          if (!isActive(node.from)) decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let l = first; l <= last; l++) {
            const cls = ["cm-codeblock", l === first ? "cm-codeblock-first" : "", l === last ? "cm-codeblock-last" : ""].join(" ");
            decos.push(lineDeco(cls).range(doc.line(l).from));
          }
          return;
        }
        if (name === "CodeInfo" || (name === "CodeMark" && node.node.parent?.name === "FencedCode")) {
          decos.push(Decoration.mark({ class: "cm-code-fence" }).range(node.from, node.to));
          return;
        }
      },
    });

    // [[wikilinks]] and #tags (not part of CommonMark)
    const text = doc.sliceString(from, to);
    const wl = /\[\[([^\[\]\n|#]+)(#[^\[\]\n|]*)?(\|[^\[\]\n]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wl.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (insideCode(state, start)) continue;
      if (start > 0 && doc.sliceString(start - 1, start) === "!" && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(m[1].trim())) continue;
      const target = m[1].trim();
      const alias = m[3] ? m[3].slice(1) : null;
      const labelFrom = alias ? end - 2 - alias.length : start + 2;
      const labelTo = end - 2;
      decos.push(Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": target } }).range(labelFrom, labelTo));
      if (!touches(start, end)) {
        decos.push(hide.range(start, labelFrom));
        decos.push(hide.range(labelTo, end));
      } else {
        decos.push(Decoration.mark({ class: "cm-mark" }).range(start, labelFrom));
        decos.push(Decoration.mark({ class: "cm-mark" }).range(labelTo, end));
      }
    }
    const emb = /!\[\[([^\[\]\n|]+\.(?:png|jpe?g|gif|webp|svg|avif))(\|[^\]]*)?\]\]/gi;
    while ((m = emb.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (!touches(start, end)) decos.push(Decoration.replace({ widget: new ImageWidget(m[1], m[1]) }).range(start, end));
    }
    const tag = /(^|[\s(])#([A-Za-z][\w/-]*)/g;
    while ((m = tag.exec(text))) {
      const start = from + m.index + m[1].length;
      const end = start + 1 + m[2].length;
      if (insideCode(state, start)) continue;
      if (doc.lineAt(start).from === start && /^#{1,6}\s/.test(doc.lineAt(start).text)) continue;
      decos.push(Decoration.mark({ class: "cm-tag" }).range(start, end));
    }
  }
  const all = Decoration.set(decos, true);
  const hidden = Decoration.set(decos.filter((d) => (d.value as unknown as { point?: boolean }).point), true);
  return { all, hidden };
}

function insideCode(state: EditorState, pos: number) {
  let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
  for (; n; n = n.parent) if (n.name === "InlineCode" || n.name === "FencedCode" || n.name === "CodeBlock") return true;
  return false;
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    hidden: DecorationSet;
    constructor(view: EditorView) {
      const b = build(view);
      this.decorations = b.all;
      this.hidden = b.hidden;
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        const b = build(u.view);
        this.decorations = b.all;
        this.hidden = b.hidden;
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Atomic hidden ranges so the cursor skips over hidden markers.
const atomic = EditorView.atomicRanges.of((view) => view.plugin(livePreviewPlugin)?.hidden ?? RangeSet.empty);

export function livePreview(opts: { openLink: (target: string) => void; openUrl: (url: string) => void }): Extension {
  return [
    livePreviewPlugin,
    atomic,
    EditorView.domEventHandlers({
      mousedown(e) {
        const el = (e.target as HTMLElement).closest("[data-target],[data-url]") as HTMLElement | null;
        if (!el) return false;
        const active = el.closest(".cm-line")?.querySelector(".cm-mark");
        // On the line being edited, a plain click places the cursor; ⌘/Ctrl-click always follows.
        if (active && !(e.metaKey || e.ctrlKey)) return false;
        e.preventDefault();
        if (el.dataset.target) opts.openLink(el.dataset.target);
        else if (el.dataset.url) opts.openUrl(el.dataset.url);
        return true;
      },
    }),
  ];
}
