// One phone field holds ordered numbers; the first entry is primary.
// Numbers are stored as E.164; punctuation belongs to the display, not identity.
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface PhoneEntry {
  number: string;
  extension?: string;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Accept plain input or readable YAML/JSON entries without labels. Never extract
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
    let number: unknown = item, extension: unknown;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      if ("label" in entry) throw new Error("phone labels are not supported; use number and optional extension, with the primary number first");
      if (Object.keys(entry).some(k => !["number", "extension"].includes(k))) throw new Error("phone entries accept only number and extension");
      ({ number, extension } = entry);
    }
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) number = String(number);
    if (typeof number !== "string") throw new Error("each phone entry needs a number");
    if (/^(?!tel:)[a-z][a-z0-9 _-]*:/i.test(number.trim())) throw new Error("phone labels are not supported; enter one number per line, with the primary number first");
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
    return { number: String(parsed.number), ...(extension != null ? { extension: String(extension) } : {}) };
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
    return `${number}${entry.extension ? " ext. " + entry.extension : ""}`;
  }).join("\n");
}

export function phoneHref(entry: PhoneEntry): string {
  return `tel:${entry.number}${entry.extension ? ";ext=" + entry.extension : ""}`;
}
