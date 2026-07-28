# Dev server

> Start/stop a project's app from a toolbar play button using the start
> command(s) configured for that project, and detect its local URL from the
> output so the browser preview can be opened on it.

## Overview

Every project can define its own **start commands** (Settings → Project, stored
in `<project>/.lithium/settings.json`). When a project has any — either
configured, or the conventional `npm run dev` script — a play/stop button
appears in the toolbar. Clicking it runs every command in the workspace
directory. Lithium watches the output for a `http://localhost:<port>` URL and
remembers it.

Starting the app **does not** open the browser preview. A separate preview
button (`#btn-browser-preview`) appears next to the play button while the app is
running, and toggles the preview panel on the detected URL. Stopping the app (or
the processes exiting) closes the preview and hides the button again.

## Key files

| File | Responsibility |
| --- | --- |
| `src/main/dev-server.js` | Resolves the start commands, spawns/kills the processes, detects the URL, IPC handlers |
| `src/renderer/dev-server.js` | Play button + preview button UI, start/stop, persistence |
| `src/main/config.js` | `loadProjectSettings` / `saveProjectSettings` — the `.lithium/settings.json` store |
| `src/main/project.js` | `project:get-settings` / `project:set-settings` IPC |
| `src/renderer/settings.js` | The Project settings panel that edits the start commands |

## How it works

**Resolving the commands** (`main/dev-server.js:23-30`): `resolveStartCommands(cwd)`
returns `loadProjectSettings(cwd).startCommands` when non-empty, else
`["npm run dev"]` when `<cwd>/package.json` has a `dev` script, else `[]`. An
empty result means the project has nothing to start and the play button stays
hidden.

**Availability** (`renderer/dev-server.js`): `refreshDevServerButton()` invokes
`devserver:start-commands` with `{ cwd: state.currentDir }` and shows the play
button only when the array is non-empty. `checkDevServerAvailable()` (called on
workspace switch) stops any running server first, then refreshes the button.
Saving the Project settings panel calls `refreshDevServerButton()` **only** — it
must not tear down a running server.

**Starting** (`main/dev-server.js:32-77`): `devserver:start` refuses if anything
is already running (`_devServerProcs` is a module singleton — one app at a time
across the whole application) or if there are no commands. Otherwise it spawns
**one process per command**, each with
`spawn(command, { cwd, shell: true, detached: true, env: { ...process.env }, stdio: ["ignore","pipe","pipe"] })`.
`detached: true` puts each child in its own process group so its whole tree can
be killed later. Returns `{ ok: true, commands }`.

**URL detection**: every process's `stdout` and `stderr` is matched against
`LOCALHOST_URL_RE = /https?:\/\/localhost:\d+/`. Each match sends `devserver:url`
to the renderer, which stores it as `_devServerUrl` and — only if the preview is
already open — re-points it at the URL. It never opens the panel by itself.

**The preview button**: hidden unless the app is running. Clicking it closes the
preview if open, else opens it on `_devServerUrl` (or on the last-visited URL
when no URL has been detected yet). It gets an `.active` class while the panel is
open.

**Stopping** (`main/dev-server.js:79-98`): `killDevServer()` empties
`_devServerProcs` and kills each process group with
`process.kill(-pid, "SIGTERM")` (negative PID = whole group, hence `detached`),
falling back to `proc.kill()`. The renderer's `stopDevServer()` also calls
`app.closeBrowser()`.

**Process exit**: `handleDevServerExit(proc)` removes that process from the list
and sends `devserver:stopped` **only when the last one is gone**, latched by
`reportedStopped` so a manual stop (which empties the list before the `close`
events arrive) reports exactly once.

**Persistence / restore**: `setDevServerUI(running)` writes `devServerRunning`
and `devServerDir` to `localStorage`. On load, `restoreDevServer()` re-invokes
`devserver:start` only if the saved flag is set AND the saved dir equals the
current workspace. This restarts the commands; it does not re-attach to
processes from a previous app run.

### IPC contract

Renderer → main (`ipcRenderer.invoke`):
- `devserver:start-commands` — `{ cwd }` → `string[]` (resolved commands; `[]` = nothing to start).
- `devserver:start` — `{ cwd }` → `{ ok: true, commands }` or `{ ok: false, error }`.
- `devserver:stop` — no payload → `{ ok: true }` / `{ ok: false }` (false when nothing was running).
- `project:get-settings` — `dir` → `{ startCommands: string[] }`.
- `project:set-settings` — `{ dir, settings }` → `{ ok: boolean }`.

Main → renderer (`sender.send`):
- `devserver:url` — a bare URL `string`.
- `devserver:stopped` — no payload; fired once when the last process closes or errors.

Exported: `main/dev-server.js` → `{ killDevServer }`; `renderer/dev-server.js` →
`{ checkDevServerAvailable, refreshDevServerButton, restoreDevServer }`.

## Gotchas

- **Single instance, global state.** `_devServerProcs`/`_devServerDir` are module
  singletons. Only one project's app runs at a time; a second `devserver:start`
  returns an error rather than starting another.
- **`detached: true` is load-bearing.** Killing uses the negative-PID group kill.
  Without `detached`, the actual bundler/server children would survive `SIGTERM`
  and orphan.
- **Commands run in parallel, not in sequence.** They are all spawned at once and
  are all killed together; there is no ordering or dependency between them.
- **Commands run through a shell.** They are passed to `spawn` as a single string
  with `shell: true`, so shell syntax works — and so does anything else the user
  types. The value comes from the project's own `.lithium/settings.json`.
- **URL regex only matches `localhost`.** A server printing `127.0.0.1`,
  `0.0.0.0`, or a LAN IP will run fine but leave the preview without a URL; the
  preview button then just opens the panel on its last URL.
- **`checkDevServerAvailable()` stops the server.** It is the workspace-switch
  path. Use `refreshDevServerButton()` when you only want to re-evaluate
  visibility.
- **Restore restarts, not re-attaches.**
- **`stdout` and `stderr` are both scanned** — many dev servers print the URL to
  stderr.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-22** — Per-project start commands: `devserver:has-dev-script`
  replaced by `devserver:start-commands`; `devserver:start` now runs every
  command from `<project>/.lithium/settings.json` (falling back to `npm run dev`)
  as one process each. Starting no longer auto-opens the browser preview — a new
  toolbar preview button, visible only while the app runs, toggles it. Added
  `refreshDevServerButton()` so saving project settings doesn't kill a running
  server.
- **2026-07-08** — Initial doc created.
