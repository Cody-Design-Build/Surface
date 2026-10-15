# App Tech Options

> **Research history; current direction clarified Oct 14:** a dedicated Surface app is planned for Obsidian-like writing and browsing, Bear/Margin visual polish, and team and type management (SPEC §3a, §9). Its shell and stack remain open. The recommendations below were researched for an earlier local-database architecture; they are not implementation decisions. Supabase is now the truth, files are a pull/push checkout, and no Rust core or CRDT engine is required by that design. Editor, view and shell comparisons remain input to a future decision. External surfaces can also run outside the dedicated app; their hosts and data connections remain open.

**Status: research, nothing decided.** Feeds SPEC §9 (The app) and §10 (Agents). Written Oct 13, 2026.
Where something comes from my own knowledge rather than a source I checked today, it's marked *(unverified)*. GitHub activity figures were checked with `gh api` on Oct 13, 2026.

## Summary

| Question | Options looked at | Recommendation | Confidence |
|---|---|---|---|
| App shell | Tauri 2, Electron, native Swift, web-only | **Tauri 2** (Rust core + web UI), polished for a Bear/Margin look. Fallback: native Swift shell around the same Rust core | Medium-high |
| Markdown editor | CodeMirror 6, TipTap, Milkdown, BlockNote, Lexical | **CodeMirror 6** with an Obsidian-style live preview | High |
| Collaborative editing binding | loro-codemirror, y-codemirror.next, automerge-codemirror | Follow whatever SYNC-TECH picks. CM6 has a binding for all three | High |
| Table / board / calendar | TanStack Table, AG Grid, Glide Data Grid, dnd-kit, FullCalendar, Schedule-X | **TanStack Table + TanStack Virtual**, **dnd-kit** for boards, **Schedule-X or FullCalendar** for calendars | Medium |
| Query language for ` ```surface ` blocks | Raw SQL, a small YAML language (like Obsidian Bases) | **Small YAML language** that compiles to SQL, with read-only SQL as an expert escape hatch | Medium-high |
| Agent access | Files, CLI, local MCP server | **All three, sharing one core.** MCP over Streamable HTTP on `127.0.0.1`, plus `surface mcp` (stdio) for clients that only launch commands | High |
| Agent-built views | Sandboxed HTML in an iframe | **Sandboxed iframe + message-based data API**, modeled on the MCP Apps standard | Medium |

The one-line version: **a Rust core (database, file watcher, merge, CRDT, MCP server, CLI) with a TypeScript/React UI in Tauri, CodeMirror 6 as the editor.** Margin, one of the two apps you want Surface to look like, is built exactly this way.

---

## 1. App shell

### What comparable apps use

| App | Shell | Source |
|---|---|---|
| **Margin** (gomargin.app) | **Tauri v2 + CodeMirror 6**, Rust file watcher (`notify` crate). 10 MB download, macOS 14+, Apple silicon | Author's post: https://discuss.codemirror.net/t/showcase-margin-a-local-first-markdown-notes-app-for-macos-built-on-cm6/9867 ; https://gomargin.app/features/ |
| **Bear** | Native Apple app, not Electron. Has a separate web app (Bear Web) | https://bear.app/ ("Fast, native"); https://community.bear.app/t/getting-started-with-bear-web/14625. Whether it's AppKit, Objective-C or Swift is *unverified* (community claims only: https://www.reddit.com/r/bearapp/comments/rqb770/) |
| Obsidian | Electron, CodeMirror 6 editor | *(unverified, widely documented)* |
| Anytype | Electron UI + Go "heart" middleware for sync, encryption and storage | https://github.com/anyproto/anytype-ts ; https://github.com/anyproto/anytype-heart |
| Notion | Electron desktop. Uses SQLite locally (WASM SQLite in the browser) | https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite |
| Linear | Electron wrapper around the web app | https://linear.app/changelog/2019-04-25-linear-desktop-app |
| AFFiNE | Electron + Rust native parts (y-octo, a Rust Yjs engine) | https://docs.affine.pro/develop-wip/frontend/electron ; https://github.com/toeverything/AFFiNE |
| AppFlowy | Flutter UI + Rust backend | https://appflowy.com/blog/tech-design-flutter-rust |
| Zed | Custom GPU UI in Rust (GPUI). Took years to reach Linux/Windows | https://gpui.rs/ ; https://zed.dev/blog/zed-decoded-linux-when |

### Comparison

| | **Tauri 2** | **Electron** | **Native Swift (SwiftUI/AppKit)** | **Web-only / PWA** |
|---|---|---|---|---|
| Download size | Small (Hopp's benchmark: 8.6 MiB; Margin: 10 MB) | Large (Hopp: 244 MiB) | Smallest | None |
| Memory | Lower (Hopp: 172 MB vs 409 MB) | Higher | Lowest | Browser tab |
| Rendering engine on Mac | WKWebView, the same engine as Safari | Bundled Chromium | Native | Whatever browser |
| Back end (DB, files, sync) | **Rust**: `rusqlite`, `notify`, the Loro/Automerge Rust core run natively | Node: `better-sqlite3` (native-module packaging pain), chokidar, CRDT through WASM | Swift: GRDB (excellent). CRDT through `loro-swift` (41★) or `automerge-swift` (328★) | Browser storage and WASM SQLite. **Can't watch a folder on disk**, so it can't host the Markdown mirror |
| Shares code with CLI, MCP, sync server | **Yes**: one Rust crate builds the app, CLI and server | Yes, in TypeScript/Node | Mac-only. The CLI and server would need a second codebase | n/a |
| Mobile | iOS/Android in Tauri 2 (younger, but people have shipped to the App Store: https://v2.tauri.app/distribute/app-store/) | None (Obsidian uses a separate mobile wrapper *(unverified)*) | iOS from the same code | Works, weakly offline |
| Windows / Linux | Yes. Linux uses WebKitGTK, which has known rendering and performance problems (https://v2.tauri.app/develop/debug/linux-graphics/ ; https://github.com/tauri-apps/tauri/issues/3988) | Best: identical everywhere | No | Yes |
| Auto-update | Built-in plugin, signed updates required (https://v2.tauri.app/plugin/updater/) | Mature (electron-updater, Squirrel) | Sparkle / App Store | Free |
| Maturity | 111.8k★, active | 123.3k★, active, most proven | Apple | n/a |

Hopp's numbers come from one real app, not a lab test: https://www.gethopp.app/blog/tauri-vs-electron.

### Achieving the Bear/Margin look

**What the two reference apps are built with:**
- **Margin is Tauri v2 with a web UI** (verified, see above). Its native feel comes from design work, not from native widgets. This is the strongest single data point: one of your two targets already reaches the look with Tauri.
- **Bear is fully native** (verified that it's native and not Electron; the exact framework is unverified). Bear has spent about ten years tuning its text engine. A web UI can get close to it but won't be identical.

**What a web UI in Tauri or Electron can match, and how:**

| Native trait | Tauri 2 | Electron | Notes |
|---|---|---|---|
| Translucent (vibrancy) sidebar | `window-vibrancy` crate (official, 1k★): real `NSVisualEffectView` behind a transparent webview. https://github.com/tauri-apps/window-vibrancy | `vibrancy: "sidebar"` option (https://buttondown.com/steveharrison/archive/translucent-sidebars-in-electron-apps/) | Both use the real macOS effect, not a CSS imitation |
| Native traffic lights in a unified title bar | `titleBarStyle: "Overlay"` + `trafficLightPosition` (https://stackoverflow.com/questions/79600424) | `titleBarStyle: "hiddenInset"` + `trafficLightPosition` | Equivalent in both |
| Toolbar | Imitated in HTML with a drag region (https://v2.tauri.app/learn/window-customization/) | Same | **Gap.** Neither gives you a real `NSToolbar`. It looks right if styled carefully, but it isn't one |
| SF Pro and system fonts | `font-family: -apple-system, system-ui` | Same | Fine. In Tauri, text renders with Safari's engine, the closest a web view gets to native text |
| Smooth / elastic scrolling | WKWebView scrolls like Safari, natively | Chromium scrolling, slightly less Mac-like *(unverified, subjective)* | Small edge to Tauri |
| Menus, context menus | Native menu API | Native menu API | Both are real menus |
| Text feel: spellcheck, dictation, autocorrect, IME, emoji picker | Mostly works, because CodeMirror uses the browser's native editable text | Same | **Gap**, though small. Look-up, writing tools and some services behave slightly differently than in a native text view *(unverified, test needed)* |
| Native controls (switches, segmented controls, popovers) | Rebuilt in HTML/CSS | Same | **Gap**, a design cost. They must be hand-styled to look like macOS (https://www.reddit.com/r/tauri/comments/1vlflf6/) |

**Does this push toward native Swift?** Not by itself:
- The window chrome (vibrancy, traffic lights, fonts, scrolling, menus) is reachable in Tauri.
- The real gaps (a true toolbar, native controls, the last few percent of text feel) cost design time, not architecture.
- Native Swift would buy those last few percent at a high price:
  - a Mac-only UI;
  - building a TextKit 2 Markdown editor with live preview yourself (people do: https://github.com/nodes-app/swift-markdown-engine), instead of starting from CodeMirror 6's mature ecosystem;
  - no shared code for Windows, Linux or a web client.

**The hedge:** keep all logic in the Rust core. If the web shell ever feels "not Bear enough," you can build a native SwiftUI/AppKit shell (real sidebar, toolbar and controls) around the same Rust core (via UniFFI *(unverified that it's the best bridge)*), embedding the same CodeMirror editor in a WKWebView. Hybrid apps are built this way. Tauri now keeps that door open; Electron (logic in Node) closes it.

**Recommendation:** Tauri 2. Treat "Mac polish" as a named design workstream from day one (visual direction: `docs/DESIGN.md`):
- vibrancy sidebar;
- overlay title bar;
- system fonts and accent color;
- macOS-style controls;
- native menus;
- a performance budget for scrolling.

The Electron alternative is reasonable if the team is TypeScript-only and wants maximum consistency across platforms. It gives up the Safari-engine text rendering, the smaller app and the shared Rust core.

---

## 2. Markdown editor

**The deciding constraint:** the SPEC says the body is **one flat Markdown string**.
- **CodeMirror 6** edits the text itself, so the file stays exactly as typed: zero round-trip loss by construction. Live preview (hide the `**` markers away from the cursor, render callouts, tables, wikilinks and checkboxes as widgets) is a layer of decorations on top. Obsidian and Margin both do this (Margin's post describes the exact technique).
- **ProseMirror-based editors** (TipTap, Milkdown, BlockNote) convert Markdown into a tree and **re-generate** the Markdown on save. Re-generating normalizes things the user typed:
  - list markers;
  - `*` vs `_`;
  - spacing;
  - unknown syntax.

| Editor | Markdown fidelity | Evidence |
|---|---|---|
| **CodeMirror 6** | Lossless (it *is* the text) | Margin, Obsidian |
| TipTap | Two-way Markdown is an "early release" with edge cases; round-trip bugs have been reported | https://tiptap.dev/docs/editor/markdown ; https://github.com/ueberdosis/tiptap/issues/7147 |
| BlockNote | Its docs call Markdown import and export **"lossy"** | https://www.blocknotejs.org/docs/features/export/markdown |
| Milkdown | Built on remark, so better than most, but still re-serializes from a tree *(normalization unverified in detail)* | https://milkdown.dev/ |
| Lexical | Markdown is an import/export plugin, so the same tree problem applies *(unverified)* | — |

**Collaborative binding.** The CRDT holds one text value, which binds straight to CodeMirror:
- `loro-codemirror` (MIT, active Sep 2026; syncs text, cursors and undo): https://github.com/loro-dev/loro-codemirror
- `y-codemirror.next` (209★): https://github.com/yjs/y-codemirror.next
- `automerge-codemirror` (40★): https://github.com/automerge/automerge-codemirror

ProseMirror bindings (`loro-prosemirror`, `automerge-prosemirror`) sync a *tree*, which contradicts the flat-body decision.

**Block-like feel on CodeMirror.** All buildable as extensions:
- slash commands (autocompletion);
- drag a line or section to move it (Margin has this);
- folding;
- checkbox widgets;
- table widgets.

Inline database views (` ```surface ` blocks) render as block widgets that mount a React component.

**Recommendation: CodeMirror 6.** The cost is that a polished live preview is real work: Margin's author says it's where most of his time went. Plan for it.

---

## 3. Views and the query language

**Components** (all MIT unless noted):

| Need | Pick | Why |
|---|---|---|
| Table | **TanStack Table** (28.5k★) + **TanStack Virtual** (7.1k★) | Headless (you own every pixel, which matters for the Bear look) and handles thousands of rows. More build work than an off-the-shelf grid |
| Spreadsheet-feel grid (later) | Glide Data Grid (5.4k★, canvas, very fast) | Activity slowed (last push Jan 2026). Canvas drawing looks less native |
| — | AG Grid | Very complete, but the best features need a paid Enterprise license *(unverified which)*, and its default look is "enterprise" |
| Board | dnd-kit (17.7k★) | Standard React drag-and-drop |
| Calendar | Schedule-X (2.6k★, active) or FullCalendar (20.7k★; premium plugins for timeline/resources *(unverified)*) | Both themeable |

**Query language for ` ```surface ` blocks and saved views:**

| | Raw SQL over SQLite | Small YAML language (like Obsidian Bases) |
|---|---|---|
| Readable in a Markdown file | Poor | Good |
| Safe for agents and humans to write | Can query internal tables; ties views to the internal schema | Only fields and records, validated against type schemas |
| Survives internal DB changes | No | Yes (compiled to SQL internally) |
| Power | Unlimited | Covers filter, sort, group, formulas, summaries |
| Precedent | — | Obsidian Bases: `filters`, `formulas`, `views` in YAML (https://obsidian.md/help/bases/syntax ; https://github.com/kepano/obsidian-skills/blob/main/skills/obsidian-bases/SKILL.md) |

**Recommendation:** a small YAML language, close enough to Bases that generating `.base` files (SPEC §5) is a simple translation. Add `surface query --sql` (read-only, against documented views) for agents and power users.

---

## 4. Agent connection

**Three doors, one core:**
1. **Files.** Agents edit Markdown; the watcher reconciles changes (SPEC §6). Works with Surface closed.
2. **CLI (`surface`).** Built from the same Rust core, for example `surface get task_…`, `surface set task_… status=done`, `surface query …`, `surface patch-body … --section "Notes"`.
   - When the app is running, the CLI talks to it (live path).
   - When the app is closed, it opens the workspace directly (with a lock).
3. **MCP server.** Same operations, exposed as tools.

**Transport facts (verified):**
- **Claude Code:** stdio servers or HTTP URLs (`claude mcp add …`). https://code.claude.com/docs/en/mcp
- **Codex / ChatGPT desktop:** stdio and Streamable HTTP, set in `~/.codex/config.toml` and shared across Codex clients. https://developers.openai.com/codex/mcp
- **Claude Desktop:**
  - Local servers run as stdio commands or one-click "desktop extensions" (.mcpb): https://support.claude.com/en/articles/10949351
  - **"Custom connectors" connect from Anthropic's cloud, not your Mac, so a `localhost` URL won't work there:** https://support.claude.com/en/articles/11175166
- **Security rules for local HTTP MCP servers:** they **MUST validate the `Origin` header** (to block DNS-rebinding attacks from websites) and **SHOULD bind to 127.0.0.1** and require authentication. https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

**Recommended setup:**
- The running app serves MCP over **Streamable HTTP on 127.0.0.1**, with a per-workspace token, written to a file only the user can read.
- `surface mcp` is a tiny **stdio bridge** that forwards to the running app, or falls back to direct mode. This one command works everywhere: Claude Desktop config or `.mcpb`, Claude Code, Codex, Hermes.
- The official Rust MCP SDK exists (https://github.com/modelcontextprotocol/rust-sdk, 4k★, active).

**Tool design:**
- Field-level edits and section patches, never whole-file rewrites (SPEC §10).
- Each write is tagged with the agent's identity, for history and permissions.
- Use the MCP `instructions` field to teach conventions (Codex reads it).

**Agent-built views (dashboards):**
- **Storage:** a view is a record (for example `view_…`) holding HTML/JS plus the queries it needs. That makes it synced, versioned and editable like anything else.
- **Rendering:** in an `<iframe sandbox="allow-scripts">` **without `allow-same-origin`**, with a strict Content-Security-Policy (no network: `connect-src 'none'`).
- **Data access:** only through a `postMessage` JSON-RPC bridge.
  - Reads are scoped to the queries the view declared.
  - Writes need a user click or confirmation and are logged.
- **Standard to follow:** this matches the official **MCP Apps** extension (UI as `ui://` resources, sandboxed iframes, auditable JSON-RPC, user consent for UI-triggered tool calls; supported in Claude, ChatGPT, VS Code, Goose): https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/ ; spec: https://github.com/modelcontextprotocol/ext-apps. Following it means a Surface view could also render inside Claude or ChatGPT.
- **Main risk:** prompt injection. An agent that read hostile content could build a view that tries to leak data. Blocking all network access and allowing writes only after user action contain this.

---

## 5. Suggested architecture

```
                 ┌──────────────── Surface.app (Tauri 2) ────────────────┐
                 │  Web UI (React + TS, WKWebView)                        │
                 │   • CodeMirror 6 editor + live preview                 │
                 │   • TanStack Table / dnd-kit board / calendar          │
                 │   • Sandboxed iframes for agent views (postMessage)    │
                 │   • Mac polish: vibrancy, overlay title bar, SF Pro    │
                 │            ▲ Tauri commands / events                   │
                 │            ▼                                           │
                 │  surface-core (Rust library)                           │
                 │   • SQLite (rusqlite): records, history, base versions │
                 │   • CRDT docs (Loro/Automerge/Yjs: per SYNC-TECH)     │
                 │   • File watcher (notify) + 3-way merge + flags        │
                 │   • Markdown writer (canonical front matter)           │
                 │   • Query compiler (YAML → SQL)                        │
                 │   • MCP server: Streamable HTTP @127.0.0.1 + token     │
                 └──────┬───────────────────────┬────────────────────────┘
                        │ read/write .md         │ sync (optional, later)
         ┌──────────────▼─────────┐     ┌────────▼─────────────┐
         │ Markdown mirror (disk) │     │ Relay server (Rust,   │
         │ edited by Obsidian,    │     │ same core crate)      │
         │ vim, agents            │     └──────────────────────┘
         └────────────────────────┘
  Agents ──► files │ `surface` CLI (same core) │ `surface mcp` stdio bridge ──► app
```

### Risks
- **Mac polish in a web view** takes sustained design effort. The fallback is the native shell around the same core (see §1).
- **Live-preview editor work** is the biggest single UI cost.
- **Rust skills** are needed for the core. AI coding agents reduce this risk, but don't remove it.
- **Linux (WebKitGTK)** quality, later.
- **Tauri mobile** is younger than the desktop version. Decide on mobile when you get there.
- **Concurrency:** the CLI in direct mode vs the running app needs a clear locking rule.

### First milestone (MVP), solo, Mac only
1. Open a workspace folder; SQLite index; ID generation; type schemas from `.surface/types/`.
2. Editor: CodeMirror 6 live preview (headings, emphasis, lists, to-dos, callouts, wikilinks, code), a front-matter field panel, slash menu.
3. File watcher + three-way merge + the "needs attention" flags view.
4. One table view and one board view over a type, saved as YAML; ` ```surface ` block rendering inside pages.
5. `surface` CLI (get, set, query, create, patch-body) and the `surface mcp` bridge with the same tools; tested from Claude Code and Codex.
6. Mac polish baseline: vibrancy sidebar, overlay title bar, system fonts, dark mode.

**Out of scope for the MVP:** sync, collaboration, agent-built views (do them second; they're mostly a sandboxing exercise), calendar, Windows/Linux, mobile.

### Open questions
1. Is a ~95% Bear look (web UI, Margin-style) good enough, or is the real native toolbar and controls a must-have from day one? A must-have points to the native Swift shell around the Rust core.
2. Will the core be written mainly by AI agents with you reviewing? That changes how much the Rust learning curve matters.
