# Dev server

> Start/stop a project's `npm run dev` from a toolbar button, auto-detect the
> local URL from its output, and open it in the in-app browser preview.

## Overview

When the active workspace has a `dev` script in its `package.json`, a play/stop
button appears in the toolbar. Clicking it runs `npm run dev` in the workspace
directory. Lithium watches the process output for a `http://localhost:<port>`
URL and, when it finds one, opens the in-app browser preview at that URL.
Clicking again (or the process exiting) stops the server and closes the preview.
The running state is persisted so a server can be re-attached across relaunches.

## Key files

| File | Responsibility |
| --- | --- |
| `src/main/dev-server.js` | Spawns/kills the `npm run dev` process, detects the URL, IPC handlers |
| `src/renderer/dev-server.js` | Toolbar button UI, start/stop, persistence, opens/closes preview |

## How it works

**Availability detection** (`renderer/dev-server.js:34-42`,
`main/dev-server.js:11-18`): `checkDevServerAvailable()` invokes
`devserver:has-dev-script` with `{ cwd: state.currentDir }`. The main handler
reads `<cwd>/package.json` and returns `!!(pkg.scripts && pkg.scripts.dev)`
(any parse/read error returns `false`). The button is hidden when there's no
current dir, or no `dev` script. Note: calling `checkDevServerAvailable()` first
stops any already-running server (`main/dev-server.js:35`) — switching workspace
tears down the previous dev server.

**Starting** (`renderer/dev-server.js:55-63`, `main/dev-server.js:20-56`):
clicking the button (when not running) invokes `devserver:start` with
`{ cwd: state.currentDir }`. The main handler:
- Refuses if a process already exists — returns `{ ok: false, error: "Dev server already running" }` (`main/dev-server.js:21`). Only one dev server can run at a time process-wide (module-level `_devServerProc`).
- Spawns `npm run dev` via `spawn("npm", ["run", "dev"], { cwd, shell: true, detached: true, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] })` (`main/dev-server.js:24-30`). `detached: true` puts the child in its own process group so the whole tree can be killed later.
- Returns `{ ok: true }`. The renderer flips the UI to "running" only when `result.ok` is truthy.

**URL detection** (`main/dev-server.js:6`, `35-40`, `50-51`): both `stdout` and
`stderr` are piped through `detectAndSendUrl`, which matches each chunk against
`LOCALHOST_URL_RE = /https?:\/\/localhost:\d+/`. On the first (and every) match
it sends `devserver:url` with the matched URL string to the renderer (guarded by
`!sender.isDestroyed()`). The renderer forwards it to `app.openBrowserUrl(url)`
(`renderer/dev-server.js:65-67`), which opens the in-app browser preview.

**Stopping** (`renderer/dev-server.js:27-32`, `main/dev-server.js:58-75`):
`stopDevServer()` invokes `devserver:stop`, sets the UI to not-running, and calls
`app.closeBrowser()`. The main handler calls `killDevServer()`, which kills the
process group: `process.kill(-_devServerProc.pid, "SIGTERM")` (negative PID =
whole group, hence `detached`). If that throws it falls back to
`_devServerProc.kill()`. It then nulls `_devServerProc`/`_devServerDir`.

**Process exit** (`main/dev-server.js:42-53`): `handleDevServerExit` runs on both
`close` and `error`. It clears the module state and sends `devserver:stopped` to
the renderer, which resets the button and closes the preview
(`renderer/dev-server.js:69-72`). So a dev server that dies on its own (crash,
Ctrl-C in an external terminal, compile failure) still updates the UI.

**Persistence / restore** (`renderer/dev-server.js:19-24`, `44-52`):
`setDevServerUI(running)` writes `devServerRunning` ("1" or "") and
`devServerDir` (the workspace path) to `localStorage`. On load,
`restoreDevServer()` re-invokes `devserver:start` **only if** the saved flag is
set AND the saved dir equals the current workspace. Note this restarts a fresh
`npm run dev`; it does not re-attach to a process still running from a prior
session (the OS process from the previous app instance is unrelated).

### IPC contract

Renderer → main (`ipcRenderer.invoke`, all return values shown):
- `devserver:has-dev-script` — payload `{ cwd }` → `boolean`.
- `devserver:start` — payload `{ cwd }` → `{ ok: true }` or `{ ok: false, error }`.
- `devserver:stop` — no payload → `{ ok: true }` or `{ ok: false }` (false when nothing was running).

Main → renderer (`sender.send`):
- `devserver:url` — payload is a bare URL `string` (e.g. `"http://localhost:5173"`).
- `devserver:stopped` — no payload; fired when the process closes or errors.

Exported: `main/dev-server.js` exports `{ killDevServer }` (called on app
shutdown elsewhere to avoid orphaning the process). `renderer/dev-server.js`
exports `{ checkDevServerAvailable, restoreDevServer }`.

## Gotchas

- **Single instance, global state.** `_devServerProc`/`_devServerDir` are module
  singletons. Only one dev server runs at a time across the whole app; a second
  `devserver:start` returns an error rather than starting another.
- **`detached: true` is load-bearing.** Killing uses `process.kill(-pid, ...)`
  (the negative-PID group kill). Without `detached`, `npm run dev`'s child
  processes (the actual bundler/server) would survive `SIGTERM` and orphan.
- **URL regex only matches `localhost`.** `LOCALHOST_URL_RE` matches
  `http(s)://localhost:<digits>` only. A dev server that prints `127.0.0.1`,
  `0.0.0.0`, a LAN IP, or a bare host without a port will not trigger the browser
  preview even though the server is up.
- **Every matching chunk re-sends `devserver:url`.** The handler doesn't
  dedupe — if the dev server reprints the URL, the preview re-opens/navigates
  each time.
- **Switching workspace stops the server.** `checkDevServerAvailable()` calls
  `stopDevServer()` first, so navigating to a new project tears down any running
  dev server before checking the new project's scripts.
- **Restore restarts, not re-attaches.** After relaunch, restore spawns a new
  `npm run dev`. Any process from the previous app run is not tracked and, if it
  was killed on shutdown via `killDevServer`, is already gone.
- **`stdout` and `stderr` both scanned.** Many dev servers (Vite, etc.) print the
  URL to stderr, so both streams are matched.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
