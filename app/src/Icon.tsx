// Thin-line icons (1.5px strokes), drawn for Surface.
const paths: Record<string, string> = {
  page: "M7 3.5h6.5L17 7v13.5H7z M13.5 3.5V7H17",
  folder: "M3.5 7.5a2 2 0 0 1 2-2h3.6l1.8 2h7.6a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  chevron: "M9.5 6.5l5 5.5-5 5.5",
  search: "M10.8 17.2a6.4 6.4 0 1 0 0-12.8 6.4 6.4 0 0 0 0 12.8z M15.5 15.5l4.5 4.5",
  plus: "M12 5v14 M5 12h14",
  sidebar: "M4 5.5h16v13H4z M9.5 5.5v13",
  more: "M6 12h.01 M12 12h.01 M18 12h.01",
  trash: "M5 7h14 M10 7V4.5h4V7 M7 7l1 12.5h8L17 7",
  link: "M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1 M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1",
  task: "M5 5.5h14v13H5z M8.5 12l2.5 2.5 4.5-5",
  project: "M4 7h16v12H4z M9 7V4.5h6V7",
  close: "M6.5 6.5l11 11 M17.5 6.5l-11 11",
  external: "M14 4.5h5.5V10 M19.5 4.5L11 13 M17 14v5.5H4.5V7H10",
  copy: "M8.5 8.5h11v11h-11z M15.5 8.5v-4h-11v11h4",
  refresh: "M19 12a7 7 0 1 1-2.05-4.95 M19 4.5V9h-4.5",
  table: "M4 5.5h16v13H4z M4 10h16 M10 10v8.5",
  nest: "M6 4.5v8a3 3 0 0 0 3 3h9 M15 12.5l3 3-3 3",
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {(paths[name] ?? paths.page).split(" M").map((d, i) => (
        <path key={i} d={i ? "M" + d : d} />
      ))}
    </svg>
  );
}

export function typeIcon(type: string | undefined) {
  if (type === "task") return "task";
  if (type === "project" || type === "job") return "project";
  return "page";
}
