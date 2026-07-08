# Architecture

> How Lithium is wired together: the Electron process split, the main-process module
> load order, how the renderer bootstraps, the full IPC channel catalog, and where
> state lives on disk.

## Overview

Lithium is an Electron desktop app that wraps Claude Code (and other agent providers)
in a multi-pane terminal/chat UI. It is a classic two-process Electron app:

- **Main process** (`main.js` + `src/main/*.js`) — Node.js. Owns the OS: spawns PTYs
  and child processes, reads/writes disk, talks to GitHub / AppleScript / git, hosts a
  TCP bridge, and registers every IPC handler.
- **Renderer process** (`src/index.html` + `src/renderer.js` + `src/renderer/*.js`) —
  the Chromium window. Owns the DOM, xterm.js terminals, chat panes, the split layout
  tree, and all user interaction.

There is **no preload script and no context isolation** — the renderer runs with full
Node integration (see below), so it `require("electron")` directly and calls
`ipcRenderer` itself. IPC is therefore the boundary of convenience, not of security.

The app is `lithium` v0.3.7 (`package.json`); `main` entry is `main.js`. Note the
on-disk data directory is still `~/.synthcode` (a legacy name), not `~/.lithium`.

## Key files

| File | Responsibility |
| --- | --- |
| `main.js` | App entry: window creation, lifecycle, top-level IPC (pty/sessions/layout/directory/config/music), module loading |
| `src/main/shell-env.js` | PATH fix (must run first) |
| `src/main/config.js` | Config, session, and layout persistence in `~/.synthcode` |
| `src/main/pty.js` | `node-pty` terminal spawning for Claude Code sessions |
| `src/main/agents.js` | Chat-mode agent manager + all `agent:*` IPC |
| `src/main/provider-registry.js` | Single source of truth for ACP providers (Codex/Cursor/Claude) |
| `src/main/git.js` | git IPC (side-effect module) |
| `src/main/project.js` | Project scaffolding IPC (side-effect module) |
| `src/main/dev-server.js` | `npm run dev` runner + URL detection |
| `src/main/media.js` | macOS now-playing / media control via `osascript` |
| `src/main/browser-bridge.js` | TCP↔IPC bridge for the browser MCP server |
| `src/main/updater.js` | GitHub-release self-updater |
| `src/index.html` | Single HTML document; loads `renderer.js` at the end |
| `src/renderer.js` | Renderer entry: wires the `app` hub, binds global events, `init()` |
| `src/renderer/app.js` | The shared hub object (see below) |
| `src/renderer/state.js` | Global renderer state + layout-tree utilities |
| `src/renderer/helpers.js` | Pure-ish helper utilities |

## Process split, `webPreferences`, and the IPC boundary

The single `BrowserWindow` is created in `createWindow()` (`main.js:40`) with:

```js
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  webviewTag: true,
  backgroundThrottling: false,
}
```

Implications a future agent must understand:

- **`nodeIntegration: true` + `contextIsolation: false`** — the renderer shares the
  Node context. `src/renderer.js:1` does `require("electron")` and pulls `ipcRenderer`
  directly; renderer modules `require("../package.json")`, `require("../renderer/state")`,
  etc. There is **no `preload.js`** and **no `contextBridge`**. Do not assume a sandbox.
- **`webviewTag: true`** — the in-app browser panel uses a `<webview>` element.
- **`backgroundThrottling: false`** — timers/animation keep running when the window is
  backgrounded (needed for live terminal streaming and the music/track-progress loop).
- Window chrome is `titleBarStyle: "hiddenInset"` with custom traffic-light position;
  background `#0C0B09`.

Because there is no isolation, IPC is used as a *structural* boundary: the main process
still owns anything that touches the OS (PTYs, child processes, disk, network), and the
renderer reaches it through `ipcRenderer.invoke` / `.send`. Two directions exist:

- **Request/response**: `ipcRenderer.invoke(channel, payload)` ⇄ `ipcMain.handle(...)`.
- **Fire-and-forget / streaming**: `ipcRenderer.send(...)` → `ipcMain.on(...)`, and
  main → renderer pushes via `webContents.send(...)` → `ipcRenderer.on(...)`.

## Main-process module load order (and why it matters)

`main.js` loads modules top-to-bottom, and the order is deliberate:

1. **`require("./src/main/shell-env").fixPath()`** (`main.js:8`) — **runs before anything
   else that could spawn a child process.** GUI-launched Electron apps on macOS/Linux
   don't inherit the login shell's `PATH`, so `#!/usr/bin/env node` shebangs used by
   `claude`, `npx`, and the ACP servers fail at spawn with `env: node: No such file or
   directory`. `fixPath()` (`shell-env.js:102`) queries the login shell once
   (`$SHELL -ilc` — interactive+login so `.zshrc`/`.zprofile` shims load, `shell-env.js:82`),
   merges in fallback dirs (Homebrew, `/usr/local`, npm-global, nvm, Volta, fnm, asdf —
   `shell-env.js:17`), dedupes, and rewrites `process.env.PATH`. It is guarded by a
   `fixed` flag so it only runs once. **Any new module that spawns processes must be
   required after this line.**
2. **`./src/main/config`** (`main.js:11`) — persistence primitives; pure Node, no side
   effects beyond an in-memory cache. Everything else depends on it.
3. **`./src/main/pty`** (`main.js:24`) — exports `ptyProcesses`, `spawnSession`,
   `killSession`. Resolves the `claude` binary at require time (`pty.js:9`).
4. **`./src/main/media`** (`registerMediaHandlers`, called later at `main.js:208`).
5. **`./src/main/dev-server`** (`main.js:26`) — registers its `devserver:*` handlers as a
   side effect of being required.
6. **`./src/main/git` and `./src/main/project`** (`main.js:29-30`) — **side-effect
   modules**: they are `require`d only for the `ipcMain.handle(...)` calls at module top
   level. Nothing is destructured from them. (See Conventions.)
7. **`./src/main/agents`, `./src/main/browser-bridge`, `./src/main/updater`**
   (`main.js:33-35`), then `registerAgentHandlers()` and `registerUpdaterHandlers()` are
   called explicitly (`main.js:36-37`). These modules expose a `register*()` function
   rather than registering on require — so their handlers attach at a controlled moment.

IPC handlers defined directly in `main.js` (pty, sessions, layout, directory, config,
music, framework detection) register as the file evaluates. `app.whenReady()`
(`main.js:304`) then runs `ensureDirs()`, builds the menu, starts the browser bridge +
`registerBridgeIPC()`, registers the custom `media://` protocol handler, and creates the
window.

## Renderer bootstrap

`src/index.html` is a single static document. Its only script is
`<script src="renderer.js"></script>` at `src/index.html:1884` (last thing in `<body>`,
so the DOM exists when it runs). xterm's CSS is pulled straight from `node_modules`.

`src/renderer.js` is the bootstrap and runs in three phases:

1. **Create the hub, then require feature modules** (`renderer.js:4-18`). `app` (from
   `renderer/app.js`) is required first and `app.ipcRenderer` is set immediately, because
   nearly every feature module reaches the main process through `app.ipcRenderer`. Then
   all feature modules are required (`state`, `terminal`, `layout`, `tabs`, `sessions`,
   `browser`, `music`, `settings`, `git`, `directory`, `chat`).
2. **Wire functions onto `app`** (`renderer.js:21-59`). This is the crux of the module
   design: `app.state`, `app.dom` (cached DOM refs), and cross-module functions
   (`app.createTerminal`, `app.openTab`, `app.refreshLayout`, `app.createChatPane`, …)
   are attached to the hub. Modules call `app.foo()` at *call time* instead of importing
   each other, which avoids circular `require`s. Feature modules that depend on this
   wiring are required *after* it (`renderer.js:52-59`).
3. **Bind global UI + run `init()`** (`renderer.js:62-296`). Version tag, sidebar-resize
   drag, button handlers, the double-Shift and global keydown shortcuts, the four
   `ipcRenderer.on` PTY/agent listeners, a `ResizeObserver` on the terminal area, browser
   panel init, then `init()` (`renderer.js:198`).

`init()` (async) restores prior state: pulls recents/starred (`directory:recents`), the
saved current dir (`config:get "currentDir"` with a `localStorage` fallback), the session
list (`sessions:list`), and the saved layout (localStorage first, then `layout:load` from
disk). It prunes the layout tree against surviving session ids, re-creates each pane
(terminal → `pty:spawn` with `resume: true`; chat → `createChatPane`), renders the
sidebar, restores any dev server, and auto-checks for updates.

### The `app` hub

`renderer/app.js` exports a plain object (`app`). It starts nearly empty
(`{ ipcRenderer: null }`) plus one utility, `app.animateClose(el, animName, duration)`
(`app.js:14`). Everything else is grafted on by `renderer.js`. Treat `app` as the
renderer's service locator: if module A needs a function owned by module B, B's function
is registered on `app` in `renderer.js` and A calls `app.thatFunction()`.

### Global renderer state (`renderer/state.js`)

`state` (`state.js:1`) is the single mutable store:

- `sessions` — all persisted sessions (loaded from disk via `sessions:list`).
- `currentDir`, `recentDirs`, `starredDirs` — workspace selection.
- `layout` — the split-pane **binary tree** (see below).
- `focusedPaneId` — id of the active leaf.
- Computed getters (defined with `Object.defineProperty`): `state.openTabs`
  (`getAllTabs(layout)`) and `state.activeId` (the `activeTab` of the focused leaf).

**Layout tree.** The layout is a binary tree of nodes. A `leaf` node has
`{ type: "leaf", id, tabs: [sessionId…], activeTab }`; a split node has
`{ type, children: [nodeA, nodeB] }`. `state.js` exports the tree utilities every layout
operation relies on: `genPaneId` (`state.js:12`), `getAllLeaves`, `getAllTabs`,
`findLeafById`, `findLeafBySession`, `findParent`, and `cleanupEmptyLeaves` (which
collapses empty leaves and unwraps single-child splits). Also exported: `terminals` — a
`Map<sessionId, { term|paneEl, alive, isChat? }>` that is the renderer's registry of live
panes — and `collapsedDirs` (a `Set` for sidebar UI).

### Helper utilities (`renderer/helpers.js`)

Small shared helpers used across renderer modules: `shortDir` (home-relative path
display), `timeAgo`, `escapeHtml` (via a detached `<div>`), `dirName`,
`groupSessionsByDir` (Map grouping + sort by `updatedAt`), `getSession(id)` (lookup in
`app.state.sessions`), `persistSession(s)` (stamps `updatedAt` and fires `sessions:save`),
and `shuffleArray`. Note `getSession`/`persistSession` reach through the `app` hub, so
helpers must be used after `app.state` is wired.

## IPC channel catalog

Grouped by feature. `invoke`⇄`handle` is request/response; `send`→`on` is one-way; the
main→renderer pushes are listened to with `ipcRenderer.on`.

### PTY / terminal sessions (`main.js`, `src/main/pty.js`)

| Channel | Kind | Payload | Notes |
| --- | --- | --- | --- |
| `pty:spawn` | renderer→main (`on`) | `{ sessionId, cwd, resume }` | `main.js:89` → `spawnSession` |
| `pty:input` | renderer→main | `{ sessionId, data }` | write to PTY (`main.js:75`) |
| `pty:resize` | renderer→main | `{ sessionId, cols, rows }` | `main.js:80` |
| `pty:kill` | renderer→main | `{ sessionId }` | `main.js:93` |
| `pty:data` | main→renderer (`send`) | `{ sessionId, data }` | streamed output (`pty.js:63`) |
| `pty:exit` | main→renderer | `{ sessionId, exitCode, resume, lifetime }` | `pty.js:71` |

### Sessions & layout (`main.js`, `src/main/config.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `sessions:list` | invoke/handle | → array of session objects (`main.js:98`) |
| `sessions:save` | send/on | session object (`main.js:99`) |
| `sessions:delete` | send/on | `sessionId` (`main.js:100`) |
| `layout:save` | send/on | layout blob (`main.js:101`) |
| `layout:load` | invoke/handle | → saved layout or `null` (`main.js:102`) |

### Directory / workspace (`main.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `directory:pick` | invoke/handle | → `{ dir, recents, starred }` or `null` (opens native dialog, `main.js:105`) |
| `directory:recents` | invoke/handle | → `{ recents, starred }` (`main.js:131`) |
| `directory:add-recent` | send/on | `dir` (`main.js:136`) |
| `directory:toggle-star` | send/on | `dir` (`main.js:186`) |
| `dialog:pick-images` | invoke/handle | → `[{ dataUrl, mimeType, name }]` (`main.js:115`) |

### Config (`main.js`, `src/main/config.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `config:get` | invoke/handle | `key` → value or `null` (`main.js:211`) |
| `config:set` | send/on | `{ key, value }` (`main.js:213`) |
| `config:resolve-projects-dir` | invoke/handle | → projects dir path or `null` (`main.js:219`) |
| `config:create-default-projects-dir` | invoke/handle | → creates & returns `~/lithium-projects` (`main.js:230`) |

### Project (`src/main/project.js`, `main.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `project:detect-framework` | invoke/handle | `dir` → framework string or `null` (`main.js:178`; detector at `main.js:139`) |
| `project:create` | invoke/handle | `{ framework, name, projectsDir }` → `{ ok, dir }` / `{ ok:false, error }` (`project.js:8`; supports `nextjs`, `nodejs`) |

### Git (`src/main/git.js`) — side-effect module

All git handlers run `git` via `execFile` with a 5s timeout. Simple commands (built by
the `registerGitCommand` factory, `git.js:17`) return a boolean success:

- `git:stage-all`, `git:stage-file` `{ cwd, file }`, `git:unstage-file` `{ cwd, file }`,
  `git:commit` `{ cwd, message }`, `git:push`, `git:pull`, `git:fetch`,
  `git:discard-file` `{ cwd, file }`.
- `git:init` `{ cwd }` → bool; `git:add-remote` `{ cwd, url }` → bool.
- `git:status` `{ cwd }` → `{ branch, staged, changes, log, repoName, remoteUrl, ahead, behind }` (`git.js:43`).
- `git:branches` `{ cwd }` → `[{ name, current }]` (`git.js:101`).
- `git:checkout` / `git:create-branch` `{ cwd, branch }` → bool.

### Agents / chat mode (`src/main/agents.js`)

Registered by `registerAgentHandlers()`. Providers come from `provider-registry.js`
(`acp`=Codex, `cursor-acp`=Cursor, `claude-acp`=Claude), plus a synthetic `terminal`.

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `agent:providers` | invoke/handle | → provider list with status (`agents.js:58`) |
| `agent:<id>-server-status` | invoke/handle | → `{ running, status, lastError }` (per provider, `agents.js:81`) |
| `agent:<id>-server-start` / `-server-stop` | invoke/handle | → `true` (`agents.js:87`/`92`) |
| `agent:configure` | invoke/handle | `{ provider, config }` (`agents.js:99`) |
| `agent:get-config` | invoke/handle | `providerName` → config obj (`agents.js:107`) |
| `agent:send` | send/on | `{ sessionId, provider, message, images, model, cwd }` (`agents.js:113`) |
| `agent:abort` | send/on | `{ sessionId, provider }` (`agents.js:179`) |
| `agent:history` | invoke/handle | `sessionId` → `{ messages, contextUsed, contextSize }` (`agents.js:185`) |
| `agent:clear-history` | send/on | `sessionId` (`agents.js:199`) |
| `agent:permission-response` | send/on | `{ permissionId, optionId, provider, alwaysAllow }` (`agents.js:212`) |
| `agent:get-tool-approval-mode` / `agent:set-tool-approval-mode` | invoke/handle | `"manual"` default (`agents.js:223`) |
| `agent:get-default` / `agent:set-default` | invoke/handle | `"terminal"` or provider id (`agents.js:236`) |
| `agent:get-enabled-acps` / `agent:set-acp-enabled` | invoke/handle | `["acp"]` default (`agents.js:249`) |
| `agent:get-default-model` / `agent:set-default-model` | invoke/handle | per provider (`agents.js:267`) |
| `agent:get-provider-labels` | invoke/handle | → `{ id: label }` map (`agents.js:281`) |

Streaming pushes (main→renderer, `agents.js`): `agent:stream-start` `{ sessionId }`,
`agent:chunk` `{ sessionId, chunk }`, `agent:stream-end` `{ sessionId, aborted }`,
`agent:error` `{ sessionId, error }`. The renderer listeners are in `renderer.js:168-182`.

### Dev server (`src/main/dev-server.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `devserver:has-dev-script` | invoke/handle | `{ cwd }` → bool (`dev-server.js:11`) |
| `devserver:start` | invoke/handle | `{ cwd }` → `{ ok }` (`dev-server.js:20`) |
| `devserver:stop` | invoke/handle | → `{ ok }` (`dev-server.js:71`) |
| `devserver:url` | main→renderer | detected `http://localhost:PORT` (`dev-server.js:38`) |
| `devserver:stopped` | main→renderer | (no payload) on exit (`dev-server.js:46`) |

### Media / music (`main.js`, `src/main/media.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `music:list` | invoke/handle | → `[{ name, path }]` from the bundled `music/` dir (`main.js:196`) |
| `media:now-playing` | invoke/handle | → now-playing object (Spotify/Music via `osascript`, `media.js:59`) |
| `media:control` | invoke/handle | `{ action, position }` → bool (`toggle`/`next`/`prev`/`seek`, `media.js:74`) |

Local audio streams via a privileged custom `media://` protocol registered at
`main.js:296` and handled at `main.js:307`.

### Browser bridge (`src/main/browser-bridge.js`)

The bridge lets an external MCP server drive the in-app `<webview>`. A TCP server on a
random localhost port receives tool requests, forwards them to the renderer, and relays
results back:

| Channel | Kind | Payload |
| --- | --- | --- |
| `browser-tool:exec` | main→renderer | `{ requestId, tool, args }` (`browser-bridge.js:76`) |
| `browser-tool:result` | renderer→main (`on`) | `{ requestId, result, error }` (`browser-bridge.js:99`) |

Requests time out after 30s (`browser-bridge.js:79`). `registerBridgeIPC()` is called in
`whenReady` (`main.js:319`).

### Updater (`src/main/updater.js`)

| Channel | Kind | Payload / return |
| --- | --- | --- |
| `updater:check` | invoke/handle | → release info incl. `updateAvailable`, `latestVersion`, `downloadUrl` (`updater.js:119`) |
| `updater:download-and-install` | invoke/handle | `{ downloadUrl, assetName }` → `{ success }` / `{ error }` (`updater.js:148`) |
| `updater:download-progress` | main→renderer | percent number (`updater.js:155`) |
| `updater:get-version` | invoke/handle | → `pkg.version` (`updater.js:166`) |
| `updater:open-release` | send/on | url → opens externally (`updater.js:169`) |

### Menu (`main.js`)

| Channel | Kind | Payload |
| --- | --- | --- |
| `menu:open-settings` | main→renderer | (none) — from the macOS `Settings…` menu item (`main.js:253`) |

## Config & persistence

Everything lives under **`~/.synthcode`** (`config.js:8`), created lazily by
`ensureDirs()` (`config.js:14`, also called in `whenReady`). Layout:

```
~/.synthcode/
  config.json         # app config (recentDirs, starredDirs, currentDir, agent settings…)
  layout.json         # last split-pane layout (written by layout:save)
  sessions/
    <sessionId>.json  # one file per terminal session
  chat/
    <sessionId>.json  # one file per chat session: { messages, contextUsed, contextSize }
```

- **Config** (`config.js:21`) is read once and cached in `_configCache`; `saveConfig`
  writes pretty-printed JSON and refreshes the cache. A missing file yields
  `{ recentDirs: [] }`. `addRecentDir` keeps the 10 most-recent dirs (`MAX_RECENT_DIRS`).
- **Sessions** (`config.js:48-77`): `loadAllSessions` reads every `*.json` in
  `sessions/`, tolerates parse failures, and sorts by `updatedAt` desc. `saveSession` /
  `deleteSession` validate the id against `SESSION_ID_RE` (`^[a-zA-Z0-9_-]+$`, <256 chars)
  before touching disk — a guard against path traversal in the filename.
- **Layout** (`config.js:80-94`): `saveLayoutToDisk` / `loadLayoutFromDisk` write/read
  `layout.json` (compact JSON), returning `null` on any read error.
- **Chat history** lives separately in `~/.synthcode/chat/` and is managed by
  `agents.js` (`CHAT_DIR`, `agents.js:16`), with in-memory maps `chatHistories` and
  `contextUsage` fronting the files.
- **`DEFAULT_PROJECTS_DIR`** is `~/lithium-projects` (`config.js:12`) — the default
  scaffolding target, created on demand by `config:create-default-projects-dir`.

**Save/load lifecycle.** On startup `init()` (renderer) hydrates `state` from
`directory:recents`, `config:get`, `sessions:list`, and layout (localStorage → disk).
During use, session changes go through `persistSession` (helpers) → `sessions:save`, and
layout changes through `layout:save`. On quit the main process kills all PTYs, the dev
server, ACP servers, and the browser bridge (`main.js:336-353`).

## Key global objects

| Object | Where | What |
| --- | --- | --- |
| `ptyProcesses` | `pty.js:21` (main) | `Map<sessionId, { proc, webContents }>` of live PTYs |
| `chatHistories` / `contextUsage` | `agents.js:52,43` (main) | in-memory chat state per session |
| `servers` / `providers` | `provider-registry.js` (main) | ACP server managers + provider instances |
| `pendingRequests` | `browser-bridge.js:10` (main) | in-flight browser-tool requests |
| `app` | `renderer/app.js` (renderer) | the service-locator hub |
| `state` | `renderer/state.js` (renderer) | global renderer state + layout tree |
| `terminals` | `renderer/state.js:68` (renderer) | `Map<sessionId, pane>` of live panes |

## Conventions a future agent must follow

- **PATH fix runs first.** Never require a process-spawning module before
  `require("./src/main/shell-env").fixPath()` in `main.js`.
- **Side-effect IPC modules.** `git.js`, `project.js`, `dev-server.js`, and `media.js`
  register handlers as a side effect (git/project/dev-server register at require time;
  media via `registerMediaHandlers()`). When adding an IPC feature, follow the existing
  pattern in the file you extend — and if you add a `register*()` function, remember to
  call it in `main.js`.
- **Add providers in one place.** New ACP providers go in `PROVIDER_CONFIGS`
  (`provider-registry.js:6`); `agents.js` builds per-provider server IPC handlers by
  iterating that list, so no other file needs editing.
- **The `app` hub avoids circular deps.** In the renderer, don't import feature modules
  into each other. Register the function on `app` in `renderer.js` and call `app.fn()`.
  Anything a module needs at call time (state, DOM, cross-module fns) is on `app`.
- **Guard `webContents` before pushing.** Every main→renderer `send` first checks
  `!senderWebContents.isDestroyed()` (e.g. `pty.js:47,62,70`; `agents.js:156,168`) — the
  window can be gone by the time async output arrives. Preserve this.
- **Validate session ids before disk I/O.** Use `isValidSessionId` (`config.js:36`) for
  anything that turns an id into a filename.
- **Config is cached.** Mutate via `loadConfig()` → mutate object → `saveConfig()`; don't
  write `config.json` directly, or the in-memory cache goes stale.
- **No preload / no context isolation.** The renderer has full Node access. Don't add a
  `contextBridge` layer without a deliberate migration — lots of code assumes direct
  `ipcRenderer` and `require`.

## Gotchas

- On-disk directory is `~/.synthcode`, not `~/.lithium` — a legacy name that persists for
  backwards compatibility.
- The renderer's saved-layout restore (`renderer.js:210`) reads **localStorage first**,
  then falls back to the disk `layout.json` — two sources of truth that must stay
  reconciled.
- macOS-specific: `media.js` (AppleScript now-playing) and the `Settings…` menu item are
  gated on `process.platform === "darwin"`; the dev server is killed with a
  process-group signal (`process.kill(-pid)`, `dev-server.js:61`) because it's spawned
  `detached`.
- `agent:send`'s `terminal` "provider" is synthetic (added in `agent:providers`,
  `agents.js:67`); it is not a real ACP provider and has no server.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
