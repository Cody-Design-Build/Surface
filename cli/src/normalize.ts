// Lenient reading of hand-edited values. Safe, unambiguous fixes are applied and
// reported as notices; anything ambiguous is an error that blocks the push.
import type { FieldDef } from "./db.ts";

export interface Resolver {
  /** Resolve a link label ("Kitchen Remodel", "[[Kitchen Remodel|alias]]", or an id) to a record id. */
  link(label: string, targetTypeId?: string): string | null;
}

export interface Normalized {
  value: unknown;
  notice?: string; // a fix that was applied
  error?: string; // the value can't be used
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ].*)?$/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  // US style: 10/12/2026, 10/12/26, 10/12
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
    const mo = +m[1], d = +m[2];
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (y < 100) y += 2000;
    return validDate(y, mo, d) ? iso(y, mo, d) : null;
  }
  // Oct 12, October 12 2026, 12 Oct 2026
  if ((m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)) || (m = s.match(/^(\d{1,2}) ([a-z]+)\.?(?: (\d{4}))?$/))) {
    const [a, b] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mo = MONTHS.indexOf(a.slice(0, 3)) + 1;
    const d = +b;
    const y = m[3] ? +m[3] : new Date().getFullYear();
    if (mo > 0 && validDate(y, mo, d)) return iso(y, mo, d);
  }
  return null;
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const loose = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

function matchOption(raw: string, options: string[]): Normalized {
  if (options.includes(raw)) return { value: raw };
  const hit = options.find((o) => loose(o) === loose(raw));
  if (hit) return { value: hit, notice: `"${raw}" → "${hit}"` };
  const best = options
    .map((o) => ({ o, d: levenshtein(loose(o), loose(raw)) }))
    .sort((x, y) => x.d - y.d)[0];
  const hint = best && best.d <= 2 ? ` Did you mean "${best.o}"?` : "";
  return { value: raw, error: `"${raw}" isn't an option (${options.join(", ")}).${hint}` };
}

export function linkLabel(v: string): string {
  const m = v.trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  return (m ? m[1] : v).trim();
}

const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Normalize one front-matter value for a field. */
export function normalize(def: FieldDef, raw: unknown, resolve: Resolver): Normalized {
  if (empty(raw)) return { value: null };
  const asText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

  switch (def.kind) {
    case "text":
    case "phone": {
      if (typeof raw === "string") return { value: raw };
      if (Array.isArray(raw) || typeof raw === "object") return { value: raw, error: "must be text, not a list" };
      return { value: asText(raw), notice: `read ${JSON.stringify(raw)} as text` };
    }
    case "email": {
      const s = asText(raw).trim();
      const m = s.match(/^mailto:(.+)$/i);
      const v = m ? m[1] : s;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { value: s, error: `"${s}" isn't an email address` };
      return v === raw ? { value: v } : { value: v, notice: `"${raw}" → "${v}"` };
    }
    case "url": {
      const s = asText(raw).trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s === raw ? { value: s } : { value: s, notice: "trimmed" };
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return { value: `https://${s}`, notice: `"${s}" → "https://${s}"` };
      return { value: s, error: `"${s}" isn't a URL` };
    }
    case "number": {
      if (typeof raw === "number") return { value: raw };
      const s = asText(raw).trim();
      const cleaned = s.replace(/[$€£,\s]/g, "");
      if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
        const n = Number(cleaned);
        return s === String(n) ? { value: n } : { value: n, notice: `"${s}" → ${n}` };
      }
      return { value: s, error: `"${s}" isn't a number` };
    }
    case "checkbox": {
      if (typeof raw === "boolean") return { value: raw };
      const s = asText(raw).trim().toLowerCase();
      if (["yes", "y", "true", "1", "x", "done", "checked", "on"].includes(s)) return { value: true, notice: `"${raw}" → true` };
      if (["no", "n", "false", "0", "", "off", "unchecked"].includes(s)) return { value: false, notice: `"${raw}" → false` };
      return { value: raw, error: `"${raw}" isn't true or false` };
    }
    case "date": {
      if (raw instanceof Date) return { value: raw.toISOString().slice(0, 10) };
      const s = asText(raw);
      const d = parseDate(s);
      if (!d) return { value: s, error: `"${s}" isn't a date (use YYYY-MM-DD)` };
      return d === s ? { value: d } : { value: d, notice: `"${s}" → ${d}` };
    }
    case "select": {
      if (Array.isArray(raw)) {
        if (raw.length === 1) {
          const r = matchOption(asText(raw[0]), def.options ?? []);
          return { ...r, notice: r.notice ?? "single value unwrapped from a list" };
        }
        return { value: raw, error: "takes one option, not a list" };
      }
      return matchOption(asText(raw), def.options ?? []);
    }
    case "multi_select": {
      const items = Array.isArray(raw) ? raw.map(asText) : asText(raw).split(",").map((s) => s.trim()).filter(Boolean);
      const out: string[] = [];
      const notices: string[] = [];
      for (const it of items) {
        const r = matchOption(it, def.options ?? []);
        if (r.error) return { value: raw, error: r.error };
        if (r.notice) notices.push(r.notice);
        if (!out.includes(r.value as string)) out.push(r.value as string);
      }
      if (!Array.isArray(raw)) notices.push("split into a list");
      return { value: out, notice: notices.length ? notices.join("; ") : undefined };
    }
    case "link": {
      const items = Array.isArray(raw) ? raw : [raw];
      if (!def.multiple && items.length > 1) return { value: raw, error: "takes one link, not a list" };
      const ids: string[] = [];
      for (const it of items) {
        const label = linkLabel(asText(it));
        const id = resolve.link(label, def.target);
        if (!id) return { value: raw, error: `can't find a record "${label}" to link to` };
        ids.push(id);
      }
      return { value: def.multiple ? ids : ids[0] };
    }
  }
  return { value: raw, error: `unknown field kind ${def.kind}` };
}

/** Parse a `key=value` string from the command line into a raw value. */
export function cliValue(def: FieldDef, s: string): unknown {
  if (s === "") return null;
  if ((def.kind === "multi_select" || (def.kind === "link" && def.multiple)) && !s.startsWith("[[")) {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return s;
}
