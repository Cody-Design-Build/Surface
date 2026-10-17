// Drag handles for Markdown blocks: hover a paragraph, heading, list item, quote, table or code
// block to get a ⋮⋮ handle in the margin. Drag it to move the block; click it to select the block.
// The file stays plain Markdown: a move is just its lines cut and pasted elsewhere.
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

interface Block {
  from: number; // start of the first line
  to: number; // end of the last line
  list: boolean; // list items are separated by one newline, other blocks by a blank line
}

const BLOCKS = new Set([
  "Paragraph", "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2", "Blockquote", "FencedCode", "CodeBlock", "HorizontalRule", "Table", "HTMLBlock",
]);

/** The block at a document position: the innermost list item, else the top-level block. */
function blockAt(state: EditorState, pos: number): Block | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return null;
  let node = syntaxTree(state).resolveInner(line.from + (line.text.length - line.text.trimStart().length), 1);
  let top: typeof node | null = null;
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name === "ListItem") {
      // a paragraph inside a list item belongs to the item
      return { from: doc.lineAt(n.from).from, to: doc.lineAt(n.to - (n.to > n.from && doc.sliceString(n.to - 1, n.to) === "\n" ? 1 : 0)).to, list: true };
    }
    if (n.parent?.name === "Document" && (BLOCKS.has(n.name) || n.name.endsWith("List"))) top = n;
  }
  if (!top) return { from: line.from, to: line.to, list: false };
  const end = top.to > top.from && doc.sliceString(top.to - 1, top.to) === "\n" ? top.to - 1 : top.to;
  return { from: doc.lineAt(top.from).from, to: doc.lineAt(end).to, list: false };
}

/** Move `src` so it starts where `before` starts (or to the end of the document when null). */
function moveBlock(view: EditorView, src: Block, target: { pos: number; list: boolean } | null) {
  const doc = view.state.doc;
  const text = doc.sliceString(src.from, src.to);
  const sep = src.list ? "\n" : "\n\n";
  // what to remove: the block, its newline, and one following blank line for non-list blocks
  let delFrom = src.from;
  let delTo = src.to;
  const last = doc.lineAt(src.to);
  if (last.number < doc.lines) {
    delTo = last.to + 1;
    const next = doc.line(last.number + 1);
    if (!src.list && !next.text.trim() && next.number < doc.lines) delTo = next.to + 1;
  } else if (src.from > 0) {
    delFrom = src.from - 1;
    const prev = doc.lineAt(delFrom);
    if (!src.list && !prev.text.trim() && prev.from > 0) delFrom = prev.from - 1;
  }
  let insPos: number;
  let ins: string;
  if (target) {
    if (target.pos >= delFrom && target.pos <= delTo) return; // dropped onto itself
    insPos = target.pos;
    ins = text + (src.list && target.list ? "\n" : sep);
  } else {
    insPos = doc.length;
    if (insPos >= delFrom && insPos <= delTo) return;
    const tail = doc.sliceString(Math.max(0, insPos - 2), insPos);
    ins = (tail.endsWith("\n") ? "" : "\n") + (src.list || tail === "\n\n" ? "" : "\n") + text;
  }
  const changes = [
    { from: delFrom, to: delTo, insert: "" },
    { from: insPos, insert: ins },
  ].sort((a, b) => a.from - b.from);
  const tx = view.state.update({ changes, scrollIntoView: true, userEvent: "move.drop" });
  const start = tx.changes.mapPos(insPos, -1) + (target ? 0 : ins.length - text.length);
  view.dispatch(tx, { selection: { anchor: start, head: start + text.length } });
  view.focus();
}

const handlePlugin = ViewPlugin.fromClass(
  class {
    handle: HTMLElement;
    marker: HTMLElement;
    block: Block | null = null;
    hideTimer = 0;
    dragging = false;
    constructor(readonly view: EditorView) {
      this.handle = document.createElement("div");
      this.handle.className = "cm-block-handle";
      this.handle.setAttribute("aria-label", "Drag to move, click to select");
      this.handle.title = "Drag to move · click to select";
      this.handle.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>';
      this.marker = document.createElement("div");
      this.marker.className = "cm-drop-marker";
      view.dom.appendChild(this.handle);
      view.dom.appendChild(this.marker);
      view.dom.addEventListener("mousemove", this.onMove);
      view.dom.addEventListener("mouseleave", this.onLeave);
      this.handle.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
      this.handle.addEventListener("pointerdown", this.onDown);
    }
    update(u: ViewUpdate) {
      if (u.docChanged && !this.dragging) this.hide();
    }
    destroy() {
      this.handle.remove();
      this.marker.remove();
      this.view.dom.removeEventListener("mousemove", this.onMove);
      this.view.dom.removeEventListener("mouseleave", this.onLeave);
    }
    blockAtY(y: number): Block | null {
      const v = this.view;
      const rect = v.contentDOM.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) return null;
      const lb = v.lineBlockAtHeight(y - v.documentTop);
      return blockAt(v.state, lb.from);
    }
    place(b: Block) {
      const v = this.view;
      const top = v.lineBlockAt(b.from).top + v.documentTop - v.dom.getBoundingClientRect().top;
      const lineH = v.lineBlockAt(b.from).height;
      // centre on the first line of text (headings have extra top padding)
      const first = v.domAtPos(b.from).node;
      const el = (first.nodeType === 1 ? first : first.parentElement) as HTMLElement | null;
      const lineEl = el?.closest(".cm-line") as HTMLElement | null;
      let y = top + Math.min(lineH, 28) / 2;
      if (lineEl) {
        const cs = getComputedStyle(lineEl);
        const pt = parseFloat(cs.paddingTop) || 0;
        const lh = parseFloat(cs.lineHeight) || 26;
        y = lineEl.getBoundingClientRect().top - v.dom.getBoundingClientRect().top + pt + lh / 2;
      }
      this.handle.style.top = `${y - 11}px`;
      this.handle.classList.add("is-on");
    }
    hide() {
      this.handle.classList.remove("is-on");
      this.block = null;
    }
    onMove = (e: MouseEvent) => {
      if (this.dragging || e.buttons) return;
      if (this.handle.contains(e.target as Node)) return;
      window.clearTimeout(this.hideTimer);
      const b = this.blockAtY(e.clientY);
      if (!b) return void (this.hideTimer = window.setTimeout(() => this.hide(), 250));
      if (this.block && b.from === this.block.from && b.to === this.block.to) return;
      this.block = b;
      this.place(b);
    };
    onLeave = () => {
      if (this.dragging) return;
      this.hideTimer = window.setTimeout(() => this.hide(), 300);
    };
    // drop target for a pointer position: before the block under it, or after it when below its middle
    targetAt(y: number): { pos: number; list: boolean; y: number } | "end" | null {
      const v = this.view;
      const rect = v.contentDOM.getBoundingClientRect();
      const domTop = v.dom.getBoundingClientRect().top;
      if (y > rect.bottom - 4) return "end";
      const b = this.blockAtY(Math.max(y, rect.top + 1)) ?? this.nearestBlock(y);
      if (!b) return null;
      const top = v.lineBlockAt(b.from).top + v.documentTop;
      const bottom = v.lineBlockAt(b.to).bottom + v.documentTop;
      if (y < (top + bottom) / 2) return { pos: b.from, list: b.list, y: top - domTop };
      const last = v.state.doc.lineAt(b.to);
      // after this block: the start of the next non-blank line
      for (let n = last.number + 1; n <= v.state.doc.lines; n++) {
        const l = v.state.doc.line(n);
        if (l.text.trim()) {
          const nb = blockAt(v.state, l.from);
          return { pos: l.from, list: !!nb?.list, y: bottom - domTop };
        }
      }
      return "end";
    }
    nearestBlock(y: number): Block | null {
      // pointer over a blank line: look a little up and down
      for (let d = 6; d < 60; d += 6) {
        const b = this.blockAtY(y - d) ?? this.blockAtY(y + d);
        if (b) return b;
      }
      return null;
    }
    onDown = (e: PointerEvent) => {
      const src = this.block;
      if (!src || e.button !== 0) return;
      e.preventDefault();
      const v = this.view;
      const startY = e.clientY;
      let moved = false;
      let target: ReturnType<typeof this.targetAt> = null;
      const scroller = v.dom.closest(".main") as HTMLElement | null;
      let raf = 0;
      let lastY = e.clientY;
      const autoscroll = () => {
        if (!scroller) return;
        const r = scroller.getBoundingClientRect();
        const edge = 60;
        const dy = lastY < r.top + edge ? -12 : lastY > r.bottom - edge ? 12 : 0;
        if (dy) scroller.scrollTop += dy;
        raf = requestAnimationFrame(autoscroll);
      };
      const move = (ev: PointerEvent) => {
        lastY = ev.clientY;
        if (!moved && Math.abs(ev.clientY - startY) < 4) return;
        if (!moved) {
          moved = true;
          this.dragging = true;
          v.dom.classList.add("is-dragging-block");
          raf = requestAnimationFrame(autoscroll);
        }
        target = this.targetAt(ev.clientY);
        if (!target) return void this.marker.classList.remove("is-on");
        const y = target === "end" ? v.contentDOM.getBoundingClientRect().bottom - v.dom.getBoundingClientRect().top : target.y;
        this.marker.style.top = `${y - 1}px`;
        this.marker.classList.add("is-on");
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        cancelAnimationFrame(raf);
        this.marker.classList.remove("is-on");
        v.dom.classList.remove("is-dragging-block");
        this.dragging = false;
        if (!moved) {
          // click: select the block
          v.dispatch({ selection: { anchor: src.from, head: src.to } });
          v.focus();
          return;
        }
        if (target) moveBlock(v, src, target === "end" ? null : target);
        this.hide();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
  },
);

export function blockHandles(): Extension {
  return [handlePlugin, EditorView.theme({ "&": { position: "relative" } })];
}

export { blockAt, moveBlock };
