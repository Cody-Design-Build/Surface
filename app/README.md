# Surface app

The dedicated Surface app: Views sidebar, a live-preview Markdown editor, typed properties and group tables. One web build; today it runs in local mode, served by `surface serve` (see `docs/SPEC.md` §9).

```sh
npm install
npm run build      # surface serve serves dist/
```

Hot reload (`npm run dev`) is not wired yet: the server's token cookie and Origin check don't accept the dev port. For now, rebuild and refresh.

| File | What it does |
|---|---|
| `src/App.tsx` | Routing (`#/r/<id>`, `#/g/<group>`), keyboard shortcuts, live updates |
| `src/Sidebar.tsx` | The Views tree |
| `src/Page.tsx` | Title, properties, editor, autosave and conflicts |
| `src/Editor.tsx` | CodeMirror setup: slash menu, `[[` completion, shortcuts |
| `src/livePreview.ts` | Live preview decorations |
| `src/Properties.tsx` | Typed property editors |
| `src/GroupView.tsx` | A group as a table |
| `src/Switcher.tsx` | ⌘K find or create |
| `src/api.ts` | Calls to the local server |
