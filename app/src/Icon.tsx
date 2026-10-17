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
  board: "M4.5 5h4.5v14H4.5z M10.75 5h4.5v9h-4.5z M17 5h2.5v11.5H17z",
  list: "M9 7h11 M9 12h11 M9 17h11 M4.5 7h.01 M4.5 12h.01 M4.5 17h.01",
  calendar: "M4.5 6.5h15v13h-15z M4.5 10.5h15 M8.5 4v4 M15.5 4v4",
  sliders: "M5 7h8 M17 7h2 M5 17h2 M11 17h8 M15 5v4 M9 15v4",
  pin: "M9.5 4.5h5l-.8 5.5 3.3 3v1.5H7V13l3.3-3z M12 14.5V20",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 14.5c2 .8 3 2.8 3 5.5",
  move: "M5 12h14 M15 8l4 4-4 4 M5 5v14",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  undo: "M9 14L4.5 9.5 9 5 M4.5 9.5H15a5 5 0 0 1 0 10h-3",
  lock: "M6.5 11h11v9h-11z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  rename: "M4.5 19.5h4l10-10-4-4-10 10z M13 7l4 4",
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
