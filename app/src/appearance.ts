import { useEffect, useState } from "react";

export const ACCENTS = [
  { id: "teal", name: "Teal", color: "#2f7466" },
  { id: "blue", name: "Blue", color: "#426db3" },
  { id: "violet", name: "Violet", color: "#7957ab" },
  { id: "amber", name: "Amber", color: "#99641d" },
] as const;
export interface Appearance { theme: "system" | "light" | "dark"; accent: typeof ACCENTS[number]["id"] }
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

export function applyAppearance(appearance = readAppearance()) {
  const dark = appearance.theme === "dark" || (appearance.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.accent = appearance.accent;
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
