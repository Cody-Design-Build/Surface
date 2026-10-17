// Undo for structural changes: sidebar edits, board moves, cell edits, Move to…, deletes.
// Text in the editor keeps CodeMirror's own undo; ⌘Z reaches this stack everywhere else.
// Each entry writes the old value back through the normal save path, so revision checks apply.
export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

type Listener = (e: { label: string; kind: "done" | "undone" | "redone" | "failed"; canUndo: boolean }) => void;

const past: UndoEntry[] = [];
const future: UndoEntry[] = [];
const listeners = new Set<Listener>();
let busy = false;

const emit = (label: string, kind: "done" | "undone" | "redone" | "failed") => {
  for (const l of listeners) l({ label, kind, canUndo: past.length > 0 });
};

/** Record a change that already happened. */
export function did(entry: UndoEntry) {
  past.push(entry);
  if (past.length > 100) past.shift();
  future.length = 0;
  emit(entry.label, "done");
}

export async function undo() {
  const e = past.pop();
  if (!e || busy) return;
  busy = true;
  try {
    await e.undo();
    future.push(e);
    emit(e.label, "undone");
  } catch (err) {
    emit(`Couldn't undo: ${(err as Error).message}`, "failed");
  } finally {
    busy = false;
  }
}

export async function redo() {
  const e = future.pop();
  if (!e || busy) return;
  busy = true;
  try {
    await e.redo();
    past.push(e);
    emit(e.label, "redone");
  } catch (err) {
    emit(`Couldn't redo: ${(err as Error).message}`, "failed");
  } finally {
    busy = false;
  }
}

export function onUndo(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** True when ⌘Z should go to a text field instead of this stack. */
export function typingTarget(el: Element | null) {
  if (!el) return false;
  if (el.closest(".cm-editor")) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}
