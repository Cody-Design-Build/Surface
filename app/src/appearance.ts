import { useEffect, useState } from "react";
import {
  teal, tealDark, blue, blueDark, violet, violetDark, amber, amberDark,
  crimson, crimsonDark, orange, orangeDark, green, greenDark, slate, slateDark,
  sage, sageDark, mauve, mauveDark, sand, sandDark, red, redDark, blackA,
} from "@radix-ui/colors";

// Each accent owns its neutral pairing; arbitrary background/accent mixes are not themes.
export const ACCENTS = [
  { id: "teal", name: "Teal", light: teal, dark: tealDark, neutral: sage, neutralDark: sageDark, color: teal.teal9, contrast: "white" },
  { id: "blue", name: "Blue", light: blue, dark: blueDark, neutral: slate, neutralDark: slateDark, color: blue.blue9, contrast: "white" },
  { id: "violet", name: "Violet", light: violet, dark: violetDark, neutral: mauve, neutralDark: mauveDark, color: violet.violet9, contrast: "white" },
  { id: "amber", name: "Amber", light: amber, dark: amberDark, neutral: sand, neutralDark: sandDark, color: amber.amber9, contrast: sand.sand12 },
  { id: "rose", name: "Rose", light: crimson, dark: crimsonDark, neutral: mauve, neutralDark: mauveDark, color: crimson.crimson9, contrast: "white" },
  { id: "orange", name: "Orange", light: orange, dark: orangeDark, neutral: sand, neutralDark: sandDark, color: orange.orange9, contrast: "white" },
  { id: "green", name: "Green", light: green, dark: greenDark, neutral: sage, neutralDark: sageDark, color: green.green9, contrast: "white" },
  { id: "slate", name: "Slate", light: slate, dark: slateDark, neutral: slate, neutralDark: slateDark, color: slate.slate9, contrast: "white" },
] as const;
export interface Appearance {
  theme: "system" | "light" | "dark";
  accent: typeof ACCENTS[number]["id"];
}
const KEY = "surface.appearance";

function parseAppearance(value: string | null): Appearance {
  try {
    const saved = JSON.parse(value ?? "null");
    return {
      theme: ["system", "light", "dark"].includes(saved?.theme) ? saved.theme : "system",
      accent: ACCENTS.some(accent => accent.id === saved?.accent) ? saved.accent : "teal",
    };
  } catch { return { theme: "system", accent: "teal" }; }
}

export function readAppearance(): Appearance {
  try { return parseAppearance(localStorage.getItem(KEY)); }
  catch { return { theme: "system", accent: "teal" }; }
}

function applyScale(prefix: string, scale: Record<string, string>) {
  for (const [name, value] of Object.entries(scale)) {
    const step = name.match(/\d+$/)![0];
    document.documentElement.style.setProperty(`--${prefix}-${step}`, value);
  }
}

export function applyAppearance(appearance = readAppearance()) {
  const dark = appearance.theme === "dark" || (appearance.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.accent = appearance.accent;
  const accent = ACCENTS.find(value => value.id === appearance.accent)!;
  applyScale("neutral", dark ? accent.neutralDark : accent.neutral);
  applyScale("brand", dark ? accent.dark : accent.light);
  applyScale("red", dark ? redDark : red);
  applyScale("green", dark ? greenDark : green);
  applyScale("amber", dark ? amberDark : amber);
  applyScale("blue", dark ? blueDark : blue);
  applyScale("violet", dark ? violetDark : violet);
  const style = document.documentElement.style;
  style.setProperty("--brand-contrast", accent.contrast);
  style.setProperty("--shadow-color", dark ? blackA.blackA8 : blackA.blackA4);
  style.setProperty("--overlay-color", dark ? blackA.blackA9 : blackA.blackA6);
}

export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => {
    applyAppearance(appearance);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => applyAppearance(appearance);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [appearance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setAppearance(parseAppearance(event.key === null ? null : event.newValue));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const update = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Settings still work for this tab if storage is unavailable. */ }
    setAppearance(next);
  };
  return [appearance, update] as const;
}
