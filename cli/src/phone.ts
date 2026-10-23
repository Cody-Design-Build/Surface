// One phone field can hold several labeled numbers without losing extensions.
// Numbers are stored as E.164; punctuation belongs to the display, not identity.
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface PhoneEntry {
  number: string;
  label?: string;
  extension?: string;
}

const LABEL = /^[a-z][a-z0-9 _-]{0,39}$/i;
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Accept plain input, labeled lines, or readable YAML/JSON entries. Never extract
 * a number from arbitrary prose: malformed or ambiguous input must be reviewed. */
export function normalizePhones(raw: unknown): PhoneEntry[] | null {
  if (raw == null || (typeof raw === "string" && !raw.trim()) || (Array.isArray(raw) && !raw.length)) return null;
  let input: unknown = raw;
  if (typeof input === "string" && input.trim().startsWith("[")) {
    try { input = JSON.parse(input); } catch { throw new Error("phone entries must be valid JSON, or one number per line"); }
  }
  const items: unknown[] = Array.isArray(input) ? input : typeof input === "string"
    ? input.split(/\r?\n|;(?!\s*ext=)/i).filter(s => s.trim()) : [input];
  if (!items.length || items.length > 20) throw new Error("use between 1 and 20 phone entries");
  const entries = items.map(item => {
    let number: unknown = item, label: unknown, extension: unknown;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      if (Object.keys(entry).some(k => !["number", "label", "extension"].includes(k))) throw new Error("phone entries accept only number, label and extension");
      ({ number, label, extension } = entry);
    } else if (typeof item === "string") {
      const match = item.trim().match(/^([a-z][a-z0-9 _-]{0,39}):\s*(.+)$/i);
      if (match && match[1].toLowerCase() !== "tel") { label = match[1]; number = match[2]; }
    }
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) number = String(number);
    if (typeof number !== "string") throw new Error("each phone entry needs a number");
    const text = number.trim().replace(/^tel:/i, "");
    // Seven-digit local numbers are ambiguous. US/Canada is the default only
    // when no country code is supplied; international numbers need a leading +.
    const parsed = parsePhoneNumberFromString(text, { defaultCountry: "US", extract: false });
    if (!parsed || !parsed.isPossible() || !E164.test(parsed.number)) throw new Error(`"${text}" isn't a complete phone number; include an area code, or + and the country code for international numbers`);
    if (parsed.countryCallingCode === "1" && !/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(parsed.number)) throw new Error("US/Canadian phone numbers need a valid 3-digit area code and 7-digit number");
    if (!text.startsWith("+") && parsed.countryCallingCode !== "1") throw new Error("international phone numbers need + and a country code");
    if (extension != null && (typeof extension !== "string" || !/^[0-9]{1,10}$/.test(extension))) throw new Error("extensions must be 1–10 digits, stored as text");
    if (parsed.ext && extension != null && extension !== parsed.ext) throw new Error("conflicting phone extensions; keep one extension per entry");
    extension ??= parsed.ext;
    if (extension != null && !/^[0-9]{1,10}$/.test(String(extension))) throw new Error("extensions must be 1–10 digits");
    if (label != null && (typeof label !== "string" || !LABEL.test(label.trim()))) throw new Error("phone labels must start with a letter and use at most 40 letters, digits, spaces, - or _");
    return { number: String(parsed.number), ...(label != null ? { label: String(label).trim().toLowerCase() } : {}), ...(extension != null ? { extension: String(extension) } : {}) };
  });
  // PostgreSQL JSONB orders object keys independently of JavaScript. Keep an
  // already-canonical value intact so check/push do not report perpetual edits.
  if (Array.isArray(input) && input.length === entries.length && input.every((item, i) =>
    item && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === Object.keys(entries[i]).length &&
    Object.entries(entries[i]).every(([key, value]) => item[key] === value))) return input as PhoneEntry[];
  return entries;
}

/** Also handles legacy strings so upgrades never render [object Object]. */
export function phoneEntries(value: unknown): PhoneEntry[] | null {
  try { return normalizePhones(value); } catch { return null; }
}

export function phoneText(value: unknown, readable = true): string {
  if (value == null) return "";
  const entries = phoneEntries(value);
  if (!entries) return typeof value === "string" ? value : JSON.stringify(value);
  return entries.map(entry => {
    const parsed = parsePhoneNumberFromString(entry.number);
    const number = readable && parsed ? parsed.countryCallingCode === "1" ? parsed.formatNational() : parsed.formatInternational() : entry.number;
    return `${entry.label ? entry.label + ": " : ""}${number}${entry.extension ? " ext. " + entry.extension : ""}`;
  }).join("\n");
}

export function phoneHref(entry: PhoneEntry): string {
  return `tel:${entry.number}${entry.extension ? ";ext=" + entry.extension : ""}`;
}
