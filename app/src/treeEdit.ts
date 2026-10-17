// Edits to a sidebar definition, addressed by `loc` (index path through `items`).
import type { TreeDef, TreeItem } from "./api.ts";

const MARK = Symbol("moving");

function listAt(def: TreeDef, parent: number[]): TreeItem[] {
  let list = def.items;
  for (const i of parent) {
    const it = list[i];
    if (!it) throw new Error("That sidebar entry moved. Try again.");
    it.items = it.items ?? [];
    list = it.items;
  }
  return list;
}

export function itemAt(def: TreeDef, loc: number[]): TreeItem | undefined {
  try {
    return listAt(structuredClone(def), loc.slice(0, -1))[loc[loc.length - 1]];
  } catch {
    return undefined;
  }
}

export type Where = { parent: number[]; index: number };

/** Where a drop lands: before/after a placed entry, or inside it at the end. */
export function whereFor(loc: number[], pos: "before" | "after" | "inside", def: TreeDef): Where {
  if (pos === "inside") {
    const it = itemAt(def, loc);
    return { parent: loc, index: it?.items?.length ?? 0 };
  }
  return { parent: loc.slice(0, -1), index: loc[loc.length - 1] + (pos === "after" ? 1 : 0) };
}

export function insert(def: TreeDef, at: Where, item: TreeItem): TreeDef {
  const next = structuredClone(def);
  const list = listAt(next, at.parent);
  list.splice(Math.min(at.index, list.length), 0, item);
  return next;
}

export function remove(def: TreeDef, loc: number[]): TreeDef {
  const next = structuredClone(def);
  listAt(next, loc.slice(0, -1)).splice(loc[loc.length - 1], 1);
  prune(next.items);
  return next;
}

export function update(def: TreeDef, loc: number[], patch: Partial<TreeItem>): TreeDef {
  const next = structuredClone(def);
  const it = listAt(next, loc.slice(0, -1))[loc[loc.length - 1]];
  Object.assign(it, patch);
  for (const k of Object.keys(patch) as (keyof TreeItem)[]) if (patch[k] === undefined) delete it[k];
  return next;
}

/** Move a placed entry. Marks the old spot, inserts, then drops the mark, so indices stay right. */
export function move(def: TreeDef, from: number[], at: Where): TreeDef {
  const next = structuredClone(def);
  const src = listAt(next, from.slice(0, -1));
  const item = src[from[from.length - 1]];
  src[from[from.length - 1]] = { [MARK]: true } as unknown as TreeItem;
  const dst = listAt(next, at.parent);
  dst.splice(Math.min(at.index, dst.length), 0, item);
  const strip = (list: TreeItem[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if ((list[i] as unknown as Record<symbol, boolean>)[MARK]) list.splice(i, 1);
      else if (list[i].items) strip(list[i].items!);
    }
  };
  strip(next.items);
  prune(next.items);
  return next;
}

/** `items: []` left behind on records reads as noise in YAML. */
function prune(list: TreeItem[]) {
  for (const it of list) {
    if (it.items) {
      prune(it.items);
      if (!it.items.length && it.group === undefined) delete it.items;
    }
  }
}

export function isInside(loc: number[], ancestor: number[]) {
  return ancestor.length <= loc.length && ancestor.every((x, i) => loc[i] === x);
}
