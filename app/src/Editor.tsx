import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder, type KeyBinding } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { livePreview } from "./livePreview.ts";
import { blockHandles } from "./blockHandles.ts";

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--text-strong)" },
  { tag: t.strong, fontWeight: "650", color: "var(--text-strong)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--text-muted)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)" },
  { tag: t.quote, color: "var(--text-soft)" },
  { tag: t.processingInstruction, color: "var(--text-faint)" },
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: t.comment, color: "var(--text-faint)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom], color: "var(--code-number)" },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: "var(--code-fn)" },
  { tag: t.typeName, color: "var(--code-type)" },
]);

/** Wrap the selection (or the word at the cursor) in a marker like ** or _. */
function wrap(marker: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const text = view.state.sliceDoc(range.from, range.to);
        const n = marker.length;
        if (text.startsWith(marker) && text.endsWith(marker) && text.length >= 2 * n) {
          return { changes: { from: range.from, to: range.to, insert: text.slice(n, -n) }, range: EditorSelection.range(range.from, range.to - 2 * n) };
        }
        return {
          changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
          range: EditorSelection.range(range.from + n, range.to + n),
        };
      }),
    );
    return true;
  };
}

/** Toggle a line prefix such as "- [ ] " or "# ". */
function linePrefix(prefix: string, re: RegExp) {
  return (view: EditorView) => {
    const changes = [];
    const seen = new Set<number>();
    for (const r of view.state.selection.ranges) {
      for (let pos = r.from; pos <= r.to; ) {
        const line = view.state.doc.lineAt(pos);
        if (!seen.has(line.number)) {
          seen.add(line.number);
          const m = re.exec(line.text);
          if (m && m[0] === prefix) changes.push({ from: line.from, to: line.from + m[0].length, insert: "" });
          else if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: prefix });
          else changes.push({ from: line.from, insert: prefix });
        }
        pos = line.to + 1;
      }
    }
    view.dispatch({ changes });
    return true;
  };
}

const blockRe = /^(#{1,6} |- \[[ xX]\] |[-*+] |\d+\. |> )/;

function toggleTask(view: EditorView) {
  const changes = [];
  for (const r of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(r.head);
    const m = /^(\s*)([-*+] )\[([ xX])\]/.exec(line.text);
    if (m) {
      const pos = line.from + m[1].length + m[2].length + 1;
      changes.push({ from: pos, to: pos + 1, insert: m[3] === " " ? "x" : " " });
    } else {
      const lead = /^(\s*)([-*+] )?/.exec(line.text)!;
      changes.push({ from: line.from + lead[1].length, to: line.from + lead[0].length, insert: "- [ ] " });
    }
  }
  view.dispatch({ changes });
  return true;
}

/** Continue lists and tasks on Enter; an empty item ends the list. */
function continueList(view: EditorView) {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) return false;
  const line = state.doc.lineAt(r.head);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. |> )/.exec(line.text);
  if (!m || r.head < line.from + m[0].length) return false;
  if (line.text.trim() === m[0].trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
    return true;
  }
  let next = m[2];
  if (/\[[xX]\]/.test(next)) next = next.replace(/\[[xX]\]/, "[ ]");
  if (m[3]) next = `${Number(m[3]) + 1}. `;
  const insert = "\n" + m[1] + next;
  view.dispatch({ changes: { from: r.head, insert }, selection: { anchor: r.head + insert.length }, scrollIntoView: true });
  return true;
}

const SLASH: { label: string; detail: string; insert: string; line?: boolean }[] = [
  { label: "Heading 1", detail: "#", insert: "# ", line: true },
  { label: "Heading 2", detail: "##", insert: "## ", line: true },
  { label: "Heading 3", detail: "###", insert: "### ", line: true },
  { label: "To-do", detail: "- [ ]", insert: "- [ ] ", line: true },
  { label: "Bulleted list", detail: "-", insert: "- ", line: true },
  { label: "Numbered list", detail: "1.", insert: "1. ", line: true },
  { label: "Quote", detail: ">", insert: "> ", line: true },
  { label: "Code block", detail: "```", insert: "```\n\n```", line: true },
  { label: "Divider", detail: "---", insert: "---\n", line: true },
  { label: "Link to page", detail: "[[ ]]", insert: "[[" },
  { label: "Table", detail: "| |", insert: "| Column | Column |\n| --- | --- |\n|  |  |\n", line: true },
];

export interface EditorProps {
  docKey: string;
  value: string;
  titles: () => string[];
  onChange: (value: string) => void;
  openLink: (target: string) => void;
  onEscapeUp?: () => void;
  extraKeys?: KeyBinding[];
}

export function Editor({ docKey, value, titles, onChange, openLink, onEscapeUp }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, openLink, titles, onEscapeUp });
  cb.current = { onChange, openLink, titles, onEscapeUp };
  const applying = useRef(false);

  useEffect(() => {
    const linkComplete = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\[\[[^\]\n]*/);
      if (!m) return null;
      const q = m.text.slice(2);
      const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
      return {
        from: m.from + 2,
        options: cb.current.titles().map((title) => ({ label: title, type: "text", apply: after === "]]" ? title : `${title}]]` })),
        validFor: /^[^\]\n]*$/,
        filter: true,
        ...(q ? {} : {}),
      };
    };
    const slashComplete = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/(?:^|\s)\/[\w ]*$/);
      if (!m) return null;
      const slash = m.from + m.text.indexOf("/");
      return {
        from: slash,
        filter: false,
        options: SLASH.filter((s) => s.label.toLowerCase().includes(m.text.slice(m.text.indexOf("/") + 1).toLowerCase().trim())).map((s) => ({
          label: s.label,
          detail: s.detail,
          type: "keyword",
          apply: (v: EditorView, _c: unknown, from: number, to: number) => {
            const line = v.state.doc.lineAt(from);
            const start = s.line && line.text.slice(0, from - line.from).trim() === "" ? line.from : from;
            const cursor = s.insert.includes("```\n") ? start + 4 : start + s.insert.length;
            v.dispatch({ changes: { from: start, to, insert: s.insert }, selection: { anchor: cursor } });
          },
        })),
      };
    };

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      closeBrackets(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(highlight),
      livePreview({ openLink: (target) => cb.current.openLink(target), openUrl: (url) => window.open(url, "_blank", "noopener") }),
      autocompletion({ override: [linkComplete, slashComplete], icons: false }),
      blockHandles(),
      search({ top: true }),
      highlightSelectionMatches(),
      placeholder("Write, or type / for blocks and [[ to link a page…"),
      Prec.high(
        keymap.of([
          { key: "Enter", run: continueList },
          { key: "Mod-b", run: wrap("**") },
          { key: "Mod-i", run: wrap("_") },
          { key: "Mod-e", run: wrap("`") },
          { key: "Mod-Shift-x", run: wrap("~~") },
          { key: "Mod-Enter", run: toggleTask },
          { key: "Alt-ArrowUp", run: moveLineUp },
          { key: "Alt-ArrowDown", run: moveLineDown },
          { key: "Mod-Alt-1", run: linePrefix("# ", blockRe) },
          { key: "Mod-Alt-2", run: linePrefix("## ", blockRe) },
          { key: "Mod-Alt-3", run: linePrefix("### ", blockRe) },
          { key: "Mod-Shift-8", run: linePrefix("- ", blockRe) },
          { key: "Mod-Shift-7", run: linePrefix("1. ", blockRe) },
          {
            key: "ArrowUp",
            run: (v) => {
              const r = v.state.selection.main;
              if (r.empty && v.state.doc.lineAt(r.head).number === 1 && cb.current.onEscapeUp) {
                cb.current.onEscapeUp();
                return true;
              }
              return false;
            },
          },
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applying.current) cb.current.onChange(u.state.doc.toString());
      }),
      EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current! });
    view.current = v;
    (window as unknown as { __surfaceEditor?: EditorView }).__surfaceEditor = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Remote change while not typing: replace the text, keep the cursor where it was.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === value) return;
    applying.current = true;
    const head = Math.min(v.state.selection.main.head, value.length);
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, selection: { anchor: head } });
    applying.current = false;
  }, [value]);

  return <div className="editor" ref={host} />;
}

export function focusEditor(atStart = true) {
  const v = (window as unknown as { __surfaceEditor?: EditorView }).__surfaceEditor;
  if (!v) return;
  v.focus();
  if (atStart) v.dispatch({ selection: { anchor: 0 } });
}
