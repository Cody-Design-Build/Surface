// Links in page text.
//
// Stored form (database):  [[id:<record id>]], [[id:<id>#Heading]], [[id:<id>|label]], ![[id:<id>…]]
// Shown form (files, app):  [[Current Title]], [[Current Title#Heading]], [[Current Title|label]]
//
// The database keeps ids, so a rename changes nothing stored; every surface renders the current
// name. Text that matches no record is kept as typed and reported as unresolved.
// Links inside code (`…` and ``` fences) are left alone.

export interface LinkNames {
  /** id -> the name to show in [[…]] (a vault uses the file's basename) */
  name: (id: string) => string | null;
  /** typed name -> id: filename, then alias, then title (Obsidian's order). null = unresolved. */
  resolve: (typed: string) => string | null;
}

const LINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

/** Apply fn to text outside code spans and fenced blocks. */
function outsideCode(text: string, fn: (s: string) => string): string {
  const out: string[] = [];
  const parts = text.split(/(^```[\s\S]*?^```[ \t]*$|^~~~[\s\S]*?^~~~[ \t]*$)/m);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { out.push(parts[i]); continue; }
    const inline = parts[i].split(/(`[^`\n]*`)/);
    out.push(inline.map((s, j) => (j % 2 === 1 ? s : fn(s))).join(""));
  }
  return out.join("");
}

function split(inner: string) {
  const bar = inner.indexOf("|");
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? inner.slice(bar + 1) : null;
  const hash = target.indexOf("#");
  return { name: (hash >= 0 ? target.slice(0, hash) : target).trim(), sub: hash >= 0 ? target.slice(hash) : "", label };
}

/** Typed names -> stored ids. Returns the new text and the names that matched nothing. */
export function toStored(body: string, names: LinkNames): { body: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = outsideCode(body, (s) =>
    s.replace(LINK, (whole, bang: string, inner: string) => {
      const { name, sub, label } = split(inner);
      if (!name || name.startsWith("id:")) return whole;
      if (/\.(png|jpe?g|gif|svg|webp|pdf|mp4|mov|mp3|m4a|wav|canvas|base)$/i.test(name)) return whole; // attachments stay paths
      const id = names.resolve(name);
      if (!id) {
        unresolved.push(name);
        return whole;
      }
      // keep what was typed as the label when it isn't the target's own name, so the text reads the same
      const shown = names.name(id);
      const keepLabel = label ?? (shown && shown.toLowerCase() !== name.toLowerCase() ? name : null);
      return `${bang}[[id:${id}${sub}${keepLabel != null ? `|${keepLabel}` : ""}]]`;
    }),
  );
  return { body: out, unresolved };
}

/** Stored ids -> current names. Links to records that are gone show their last known text or the id. */
export function toShown(body: string, names: LinkNames): string {
  if (!body.includes("[[id:")) return body;
  return outsideCode(body, (s) =>
    s.replace(LINK, (whole, bang: string, inner: string) => {
      if (!inner.startsWith("id:")) return whole;
      const { name, sub, label } = split(inner);
      const id = name.slice(3);
      const shown = names.name(id) ?? `missing ${id}`;
      // drop a label that just repeats the name
      const l = label != null && label.toLowerCase() !== shown.toLowerCase() ? `|${label}` : "";
      return `${bang}[[${shown}${sub}${l}]]`;
    }),
  );
}

/** Ids a stored body links to. */
export function linkedIds(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[id:([0-9a-z]+)/g)) out.add(m[1]);
  return [...out];
}

/** Names a stored body links to that matched nothing (still typed text). */
export function unresolvedNames(body: string): string[] {
  const out: string[] = [];
  outsideCode(body, (s) => {
    for (const m of s.matchAll(LINK)) {
      const { name } = split(m[2]);
      if (name && !name.startsWith("id:") && !/\.(png|jpe?g|gif|svg|webp|pdf|mp4|mov|mp3|m4a|wav|canvas|base)$/i.test(name)) out.push(name);
    }
    return s;
  });
  return out;
}
