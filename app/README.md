# Surface apps

**Vault**, the writing app: workspace and personal sidebars, a live-preview Markdown editor, typed properties, and full-page views (table, board, list, calendar). One web build; today it runs in local mode, served by `surface serve` (see `docs/SPEC.md` §9).

**Separate data surface (decided Oct 18):** the Airtable-style table experience is intended to have its own standalone local entry point, workspace/type navigation, all records and saved views, independent of this writing app's shell. The grid currently integrated into this app's views is reusable groundwork; it is not the standalone surface. Both use the same Surface foundation. See `docs/SPEC.md` §5d.

**Vault** and **Data View** share one server: `/w/<workspace-id>/` for Vault and `/w/<workspace-id>/data/` for Data View. Each tab's API calls, event stream and attachments stay bound to that workspace. `surface data` opens the existing server; it does not launch another process. `surface service install` runs the server at login.

The top-left app name opens a switcher in both apps. Switching keeps the current workspace; open a link in a new tab to keep both apps open. Data View's unsaved record edits prompt before leaving.

Both apps use `AppShell` for the same top bar: app switcher, workspace, sync, version, updates and the Surface account signed in on this computer. The account's signup user ID is displayed independently of the local database's internal identity; this does not create another user or change assignment fields. No account credentials are sent to the browser. The Update menu checks and installs through the CLI updater, with backups and a restart of all local apps. Updates refuse uncommitted code changes. Each tab offers Reload after installation so another tab's draft isn't discarded automatically.

The top right keeps the version, Update button and account icon visible. Click the user icon for account details, sync status, and Appearance: System/Light/Dark theme and four accent colors. Appearance is saved in this browser on this computer and shared by every app and workspace on the same server. The app build version remains visible if an older server cannot yet provide its version or account information.

If the interface has been rebuilt while an older server is still running, run `surface restart --open` in the desktop's normal terminal. This restarts the installed code without pulling Git changes, keeps the same workspace and port, verifies the account/update API, and opens its link. It handles both a background service and the older unmanaged server; it verifies an unmanaged PID before stopping it. Save open edits before restarting. The web Update button can manage subsequent published updates once this server is running.

Drag the sidebar's right edge to resize it, or focus the divider and use the arrow keys. Double-click resets its width. The size is saved on this machine and shared between apps and tabs. The app-name column uses the same width, so app names never push the workspace selector around.

### Adding an app

1. Create an HTML entry in `app/` (for example `projects.html`) and its implementation. Wrap its content in `AppShell` from `src/AppShell.tsx`, pass its registry ID as `appId`, and put `SidebarResizeHandle` inside its sidebar. Use `var(--app-nav-width)` for the sidebar width, import `src/styles.css`, and use `workspaceUrl` from `src/api.ts` for workspace-scoped API requests. `AppShell` supplies the shared top bar; apps don't build their own. Explicit HTML links keep app switching working with older standalone servers too.
2. Add one entry to the repository's `surfaces.mts` registry: a unique `id`, `name`, `description`, `path` (for example `/projects/`), and `entry` (`projects.html`). Paths are `/` or a single directory; HTML entries live directly in `app/`.
3. Build and verify it, then commit and publish the changes to the update branch. Teammates run `surface update` (or use their configured automatic updates). The updater builds every registered app and restarts the existing server. Refresh open tabs to see the new switcher entry.

The same registry drives the switcher, Vite build entries, server routes and `surface apps --json`. Open any registered app with `surface open --app <id>`. Registering an app doesn't create its implementation or publish an update.

```sh
npm install
npm run build
```

`surface serve` serves the built `dist/` folder.

Hot reload (`npm run dev`) is not wired yet: the server's token cookie and Origin check don't accept the dev port. For now, rebuild and refresh.

| File | What it does |
|---|---|
| `src/App.tsx` | Routing (`#/r/<id>`, `#/g/<group>`, `#/v/<view>`), keyboard shortcuts, live updates, panels, toast |
| `src/Sidebar.tsx` | Workspace and personal sidebars: placed vs generated entries, drag, pin, menus |
| `src/treeEdit.ts` | Edits to a sidebar definition by location (insert, move, remove) |
| `src/ViewPage.tsx` | A saved view as a page: table, board, list, calendar |
| `src/ViewEditor.tsx` | Create or edit a view with pickers |
| `src/Panels.tsx` | Move to…, Settings, Share, record picker |
| `src/TypesPanel.tsx` | Types and fields: add types, add/edit/reorder/remove fields |
| `src/edits.ts` | Record changes with undo entries |
| `src/undo.ts` | The undo stack (⌘Z outside the editor) |
| `src/Page.tsx` | Title, properties, editor, autosave and conflicts |
| `src/Editor.tsx` | CodeMirror setup: slash menu, `[[` completion, shortcuts |
| `src/livePreview.ts` | Live preview decorations |
| `src/embeds.tsx` | Live views inside a page (```` ```surface ```` blocks, `![[View]]`) and rendered Markdown tables |
| `src/blockHandles.ts` | Block drag handles: move or select a block |
| `src/Properties.tsx` | Typed property editors |
| `src/GroupView.tsx` | A group as a table |
| `src/Switcher.tsx` | ⌘K find or create |
| `src/api.ts` | Calls to the local server |

## QA

`qa/qa-views.mjs` (24 checks: sidebars, pin, reorder, board drag, cell edit, undo, Move to…, view editor, settings, share, calendar) `qa/qa-embeds.mjs` (14 checks: live view in a page, Markdown table render and click-to-edit, image paste, types and fields) and `qa/qa-drag.mjs` (editor block handles) drive Chrome with puppeteer-core against a running `surface serve` on port 4317. Run them from a folder with `puppeteer-core` installed; they write screenshots to `shots/`. `qa-views.mjs` expects the demo workspace (jobs, tasks, selections, budget lines and the views in `.surface/views/`).
