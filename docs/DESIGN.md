# Visual Design Direction

Started Oct 13. David: use the visual style of **Bear** and **Margin**; both are very nice-looking apps.

The aim is to be *inspired by* their design language, not to copy it. Bear's red accent, icons, illustrations, themes and branding are Bear's own. Surface needs its own identity within the same calm, native, typographic school.

## What makes them look the way they do

### Bear (Apple Design Award, 2017)

- **Three panes:** a dark sidebar (tags and sections), a light note list, and a white editor. Panes are separated by hairline dividers.
- **One sparing accent colour:** Bear red, used only for selection bars, links and a few icons. Everything else is greys.
- **Typography carries the design:** a clean sans-serif, generous line height, large bold headings, and quiet small metadata.
- **Low density, lots of white space,** and generous padding in the editor.
- **Rich Markdown:** markers are visible but subdued. Tags render as soft grey pills.
- **Soft details:** rounded corners on selections, images and pills; thin-line icons (about 1–1.5 pt); minimal tables (light header, horizontal rules only).
- **The toolbar stays out of the way:** a small floating formatting bar and a minimal top bar.
- **Themes:** cosy, curated colour themes, light and dark.
- **Native Mac app,** with native controls and behaviour.

### Margin (gomargin.app)

- **No toolbar at all.** Everything comes from the keyboard and `/`.
- **Live inline preview:** "bold goes bold on the second asterisk." The markers step aside when the cursor leaves them. One document, with no preview pane.
- **Calm and minimal,** with a per-space colour tint to tell work from personal.
- **Small and fast:** a native Mac app of about 10 MB (macOS 14+, Apple silicon).
- **Plain-file honesty is part of the look:** the file on disk and the rendered note are shown side by side as a selling point.

## Principles for Surface

1. **Native Mac feel first:**
   - translucent (vibrancy) sidebars;
   - native window controls, toolbar and menus;
   - system fonts (SF Pro) or one carefully chosen typeface;
   - native scrolling and text behaviour.
2. **Typography is the design.** A readable measure (about 65–75 characters), generous line height, clear heading hierarchy, and quiet metadata.
3. **One accent colour, used sparingly.** Mostly greys; colour signals selection, links and state. Workspaces can carry a subtle tint (Margin's idea), so personal and team workspaces look different at a glance.
4. **Live preview, one document.** Markdown markers fade when not being edited. No separate preview mode.
5. **Keyboard and `/` first; minimal chrome.** Formatting is reachable from the keyboard. Toolbars appear only when they help.
6. **Low density by default for writing; denser for data.** Tables and boards can be tighter than the editor, but keep the same type, greys and hairlines.
7. **Soft, consistent details:** rounded selections and pills, thin-line icons, hairline dividers, and minimal tables.
8. **Light and dark themes** from day one, plus a few curated themes later.
9. **Structured data must look as calm as text.** This is where Surface goes beyond Bear and Margin: tables, boards, property panels, flags and agent-built views all follow the same quiet visual language. A Notion-style property header above the body should feel like part of the page, not a form.

## Implications for the app shell

A truly native Bear or Margin feel is easiest with a native Mac app (Swift/AppKit/SwiftUI). A web-based shell (Tauri, Electron) can get close with careful work: vibrancy, native traffic lights, system fonts and tuned scrolling. Text-editing feel is the hardest part to match. This trade-off is being weighed in `docs/research/APP-TECH.md`.

## To do

- Gather reference screenshots (Bear, Margin, plus Things 3, Craft and Linear for data-heavy screens) into `docs/design/refs/`.
- Pick a typeface and accent colour.
- Mock the main screens: sidebar, list, record page (fields and body), table view, the "needs attention" view.
