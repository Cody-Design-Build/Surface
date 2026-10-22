# Surface apps

**Vault**, the writing app: workspace and personal sidebars, a live-preview Markdown editor, typed properties, and full-page views (table, board, list, calendar). One web build; today it runs in local mode, served by `surface serve` (see `docs/SPEC.md` §9).

**Separate data surface (decided Oct 18):** the Airtable-style table experience is intended to have its own standalone local entry point, workspace/type navigation, all records and saved views, independent of this writing app's shell. The grid currently integrated into this app's views is reusable groundwork; it is not the standalone surface. Both use the same Surface foundation. See `docs/SPEC.md` §5d.

**Vault** and **Data View** share one server: `/w/<workspace-id>/` for Vault and `/w/<workspace-id>/data/` for Data View. Each tab's API calls, event stream and attachments stay bound to that workspace. `surface data` opens the existing server; it does not launch another process. `surface service install` runs the server at login.

The top-left control selects the workspace. The adjacent View type menu shows views available in that workspace: Vault for a Markdown checkout, and Data View when the workspace has defined types (each type has an All records table). Installed surfaces without a workspace view are omitted. Switching view type keeps the workspace; switching workspace preserves the view type when available and otherwise opens an available one. Open a link in a new tab to keep both views open. Data View's unsaved record edits prompt before leaving.

Two-way link fields are stored once. An inverse field such as Organization → Contacts computes its values from Contact → Organizations; both use the normal link picker and can be edited from either side. Editing the inverse updates the stored forward links atomically, and stale relationship edits are refused rather than overwriting newer memberships. Computed reverse values are not written to Markdown. Configure the inverse through `surface field add … --inverse <stored-field>`; a synced workspace requires migration `0007_inverse_relationships.sql` on its cloud hub before configuration. Local schema support alone is not enough.

Data View uses one table pane flush with the navigation divider and main content edge. Short tables end after the last record with the count and actions directly below; long tables fill the available height and scroll inside the grid. The surrounding layout does not add another scrollbar or an empty rounded frame.

Both apps use `AppShell` for the same top bar: workspace, view type, one workspace-status control, and the Surface account signed in on this computer. The status reads **Local only**, **Cloud connected**, or **Synced** when healthy; pending sync, conflicts, database failures and lost connections remain visible. These describe persisted workspace data, not whether an editor draft has been saved. The account's signup user ID is displayed independently of the local database's internal identity; this does not create another user or change assignment fields. No account credentials are sent to the browser.

Click the workspace status to open **Surface status**: database location, sync queue, last successful sync, conflict actions, running version, release discovery and device/cloud diagnostics. The commit is under Technical details. “Up to date” and missing or stale release checks live only in these details, not in the normal header. Currency requires a matching check less than four hours old. The popover remains available during a disconnect but does not present cached database success as current; Escape closes it and returns focus to the trigger.

Updates are exclusively CLI operations: `surface update --check` checks stable release tags and `surface update` installs them. The browser cannot install or schedule updates. Tabs poll read-only server status every 15 seconds. Once the running server differs from the browser build, a separate **New version ready → Reload** action appears without hiding workspace failures or conflicts. It never reloads automatically. Reload refuses while Vault has queued/in-flight edits, a save error or conflict, or Data View has unsaved record edits. Save or resolve the draft, then choose Reload again. Installed code that the server has not loaded instead points to `surface restart` inside the status details.

Database sync details distinguish a local-only database, direct cloud access, first sync, active sync, queued changes, paused automatic sync, conflicts and failures. An empty queue before the first successful sync is not “Synced”; database/auth failures and a lost status endpoint cannot preserve a green cached success. Device connection is a timestamped observation from the server computer to its configured cloud endpoint—not `navigator.onLine` on a potentially different browser device. “Cloud unreachable” does not prove that the entire internet connection is offline; a reachable endpoint does not establish database authorization or successful synchronization. A failed version/account request does not itself prove the database disconnected. Click the user icon for account details and Appearance:

- **Theme:** System, Light or Dark. System follows changes to your operating system's color scheme.
- **Color theme:** Teal, Blue, Violet, Amber, Rose, Orange, Green or Slate. Each uses [Radix Colors](https://www.radix-ui.com/colors) light/dark scales and an automatically paired neutral: Sage for Teal/Green, Slate for Blue/Slate, Mauve for Violet/Rose, and Sand for Amber/Orange. Rose uses Radix Crimson.

The header stays neutral. Backgrounds, borders, hover/selected states, text, focus, solid controls, status indicators and editor syntax use shared semantic tokens. Solid accent controls use a paired foreground (dark text for Amber). Labels retain distinct colors using Radix scales. The former independent background palette selector is removed.

Appearance is saved in this browser on this computer and shared by every app and workspace on the same server. Existing settings keep their light/dark/system mode and accent; old background palette values are ignored. If server details cannot be retrieved, Surface status retains the app build or last observed version alongside recovery instructions; workspace and view switching remain disabled until the current server API is available.

`src/appearance.ts` applies the official `@radix-ui/colors` scales before either app mounts and when preferences or the system color scheme change. `src/styles.css` maps scale steps to semantic CSS variables; components should consume these tokens rather than add literal colors. Use steps 1–2 for surfaces, 3–5 for interaction states, 6–8 for borders/focus, 9–10 for solid controls, and 11–12 for text. Color contrast still needs verification on the actual component and surface.

If the interface has been rebuilt while an older server is still running, run `surface restart --open` in the desktop's normal terminal. This restarts the installed code without fetching a release, keeps the same workspace and port, verifies the server API, and opens its link. If the server has stopped, run the command from a workspace folder to start it again. It handles both a background service and the older unmanaged server; it verifies an unmanaged PID before stopping it. Save open edits before restarting. Use `surface update` in the terminal for subsequent published releases.

Drag the sidebar's right edge to resize it, or focus the divider and use the arrow keys. Double-click resets its width. The size is saved on this machine and shared between apps and tabs. The workspace column uses the same width, keeping workspace identity aligned with the sidebar.

### Adding an app

1. Create an HTML entry in `app/` (for example `projects.html`) and its implementation. Wrap its content in `AppShell` from `src/AppShell.tsx`, pass its registry ID as `appId`, and put `SidebarResizeHandle` inside its sidebar. Editable apps must pass `beforeReload`, returning false while drafts, queued/in-flight saves or unresolved save errors remain. Use `var(--app-nav-width)` for the sidebar width, import `src/styles.css`, and use `workspaceUrl` from `src/api.ts` for workspace-scoped API requests. `AppShell` supplies the shared top bar; apps don't build their own. Explicit HTML links keep app switching working with older standalone servers too.
2. Add one entry to the repository's `surfaces.mts` registry: a unique `id`, `name`, `description`, `path` (for example `/projects/`), and `entry` (`projects.html`). Paths are `/` or a single directory; HTML entries live directly in `app/`.
3. Build and verify it, then commit and publish a stable release tag (`vMAJOR.MINOR.PATCH`) to `origin`; see the CLI README's release procedure. Teammates run `surface update`. The updater prepares every registered app before downtime, activates the release and restarts a previously running server. Refresh saved tabs to see the new switcher entry.

The same registry drives the switcher, Vite build entries, server routes and `surface apps --json`. Open any registered app with `surface open --app <id>`. Registering an app doesn't create its implementation or publish an update. Add its workspace availability rule to `src/viewTypes.ts` before exposing it in the View type menu.

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

Workspace and view navigation requires the current server code. An older server may serve the latest HTML while lacking workspace routes. The header disables switching until the server API is reachable; HTML returned by an API route produces a recoverable load error instead of a blank interface. `surface restart --open` loads the installed server code without a Git update.

### Safari compatibility and installable apps

The build targets Safari 17 and newer (including iOS/iPadOS), Chrome 120+, and Firefox 121+. React Data Grid also needs iterator `map` and `toArray` at runtime; the grid imports those two core-js polyfills because transpiling JavaScript syntax does not supply missing browser APIs. Targeting a browser is not certification on every OS release.

The shared grid keeps row/column virtualization, but overrides RDG's `content-visibility: auto` and paint containment. This avoids an extra deferred rendering boundary around sticky columns in WebKit. It is a mitigation for stale painting during scrolling, not a claim that the reported intermittent Safari compositor bug has been reproduced on every device. WebKit tracks a related [stale content-visibility layout issue](https://bugs.webkit.org/show_bug.cgi?id=321501).

Tables narrower than 600px temporarily unfreeze columns in the grid's column model so horizontal scrolling, virtual columns, and keyboard navigation agree; the saved view keeps its desktop frozen settings. New mobile sessions start with the navigation collapsed. Existing navigation preferences still apply. The root uses the dynamic viewport height, and grid controls inherit the selected theme's color scheme.

Both entry points have a manifest and PNG Apple touch/installation icons. The production server supplies app/workspace-specific manifest IDs, start URLs, and scopes, so an installed Data View opens that same workspace's Data View. Manifests and other unversioned public files revalidate; hashed build assets remain immutable. Restart the local server to load manifest route changes.

Run the production browser suite from `app/`:

```sh
npx playwright install webkit chromium
npm run qa:browsers
```

It uses installed Chrome plus Playwright WebKit desktop, iPhone, and iPad profiles. Port 4394 must be free. It creates a disposable local Postgres workspace with 320 records, exercises the built app against the real HTTP API, and never uses business data. Coverage includes rapid two-axis/wheel scrolling, header/cell alignment, frozen columns, grouping, selection, sorting, row heights, hidden fields, search, record and grid edits, dates, Markdown autosave, saved views, appearance persistence, viewport bounds, manifests/icons, and the missing iterator-helper runtime case. Failure traces and screenshots go in `test-results/`. WebKit device profiles emulate viewports/touch; they are not physical iOS devices or the installed Safari app.

Before claiming Safari release parity, repeat inertial trackpad/touch scrolling, browser zoom, on-screen keyboard entry, native clipboard operations, and Add to Dock/Home Screen launch/relaunch in actual Safari on macOS and a physical iPhone/iPad. Safari WebDriver requires Settings → Developer → Allow remote automation.

On macOS, `npm run qa:safari` additionally runs the installed Safari browser through its bundled WebDriver. Enable Safari Settings → Advanced → Show features for web developers, then Developer → Allow remote automation. This suite needs ports 4394 and 4445 free and creates its own disposable database. It checks 32 two-axis scroll reversals, virtualization, short-table sizing and pane alignment, selection/sorting/grouping/search, row height, keyboard opening of records, persisted record edits, Markdown autosave, saved views, theme persistence, resizing, and app/workspace-specific manifests. Screenshots and results go in `test-results/native-safari/`.

October 21, 2026 verification: all 24 browser checks passed across installed Chrome and the three WebKit profiles; app build, existing `qa:apps` checks, and CLI TypeScript checking passed. After remote automation was enabled, all seven installed Safari 26.6.2 check groups passed, including 32 two-axis scroll reversals with header/cell geometry checks. A native UI smoke test also kept rows aligned through repeated scrolling reversals. The original intermittent stagger was not reproduced conclusively; the containment change remains a targeted mitigation pending normal-use confirmation. Physical iOS keyboard, inertial gestures, native clipboard and installation/relaunch are still unverified.

Phone deployment remains a separate architectural step: the current server binds to the local computer's loopback address with local token authentication. A phone cannot use the Mac's `127.0.0.1`; hosted/reachable HTTPS and an appropriate authentication flow are still needed. No service worker or browser-side offline data store is implemented. Installation metadata does not make this local-server UI an offline mobile app; desktop offline use still requires the local server/database to be running.
