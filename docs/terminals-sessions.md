# Terminals / sessions

> PTY-backed Claude Code terminal sessions — spawning, resuming, rendering, and the
> session list UI.

## Overview

Each terminal session is a Claude Code process running in a pseudo-terminal (PTY)
managed by `node-pty` in the main process, mirrored into an xterm.js instance in the
renderer. Sessions are scoped to a workspace directory, persisted to disk as one
JSON file per session, restored across relaunches, and resumed (`--resume`) when a
saved layout re-opens them.

Sessions come in two `mode`s: `terminal` (classic PTY, documented here) and `chat`
(the ACP/agent chat panes). This doc focuses on the terminal/PTY lifecycle; chat
panes share the same `sessions` array, persistence, and list UI but stream over the
`agent:*` IPC channels instead of `pty:*`.

## Key files

| File | Responsibility |
| --- | --- |
| `src/main/pty.js` | Spawns/kills/resizes PTYs (`node-pty`), streams data to the renderer |
| `main.js` (l.74–102) | IPC bridge for `pty:*` and `sessions:*` / `layout:*` |
| `src/renderer/terminal.js` | xterm.js terminal instances, fit/web-links addons, resize fitting |
| `src/renderer.js` (l.143–164, 207–247) | `pty:data`/`pty:exit` consumers, session/layout restore |
| `src/renderer/sessions.js` | Sidebar session list rendering, rename, delete |
| `src/renderer/session-create.js` | Creating new sessions (uuid, shape, persistence) |
| `src/renderer/tabs.js` | Opening/closing tabs, resume-on-open, kill-on-close |
| `src/renderer/state.js` | `state.sessions`, the `terminals` Map, layout tree helpers |
| `src/renderer/helpers.js` | `persistSession`, `getSession`, `groupSessionsByDir`, `timeAgo` |
| `src/main/config.js` | Session/layout persistence on disk (`~/.synthcode`) |
| `src/styles/terminal.css` | Terminal styling |

## The xterm.js terminal (`src/renderer/terminal.js`)

`createTerminal(sessionId)` (`terminal.js:8`) builds one xterm.js `Terminal` per
session with a fixed config (`terminal.js:9`): JetBrains Mono 14px, `lineHeight`
1.4, blinking bar cursor (width 2), `scrollback: 10000`, `allowProposedApi: true`,
`macOptionIsMeta: true`, `drawBoldTextInBrightColors: true`. The theme object comes
from `./theme`.

**Addons** (`terminal.js:23–25`):
- `FitAddon` — kept as `fitAddon` on the terminal record so it can be re-fit on
  resize. It sizes the terminal grid (cols/rows) to the pane's pixel dimensions.
- `WebLinksAddon` — makes URLs in output clickable (loaded but not retained).

The terminal is opened into a freshly created `div.terminal-pane` whose
`dataset.sessionId` tags it (`terminal.js:27–31`). Two event wires connect xterm to
the PTY (`terminal.js:33–34`):
- `term.onData(data => ipcRenderer.send("pty:input", { sessionId, data }))` — every
  keystroke / paste is forwarded to the PTY.
- `term.onResize(({ cols, rows }) => ipcRenderer.send("pty:resize", { sessionId, cols, rows }))`
  — **yes, cols/rows are sent to the PTY.** xterm fires `onResize` after the
  FitAddon changes the grid dimensions, and the main process calls
  `proc.resize(cols, rows)` (see IPC contract below).

The record `{ term, fitAddon, paneEl, alive: true }` is stored in the `terminals`
Map keyed by `sessionId` (`terminal.js:36`). `alive` starts `true` and is flipped to
`false` when the PTY exits (see `pty:exit` handling). This `alive` flag is the single
source of truth for the live/dead status dot in the sidebar and tab strip.

**Reading data into the terminal:** the renderer listens for `pty:data` and calls
`t.term.write(data)` (`renderer.js:143–146`). There is no manual buffering — xterm's
own write queue handles backpressure.

### Resize / fitting (`fitAllVisibleTerminals`, `terminal.js:42`)

`fitAllVisibleTerminals()` walks all layout leaves (`getAllLeaves(state.layout)`),
and for each leaf's `activeTab` terminal that is actually visible
(`paneEl.offsetParent !== null`) calls `fitAddon.fit()` inside a try/catch. It then
schedules a **second fit ~100ms later** (`_fitRetryTimer`, `terminal.js:59–71`)
because the first fit can measure before the browser has finished computing final
container dimensions after a layout change.

This is driven by a `ResizeObserver` on the terminal area (`renderer.js:185–188`),
which calls `fitAllVisibleTerminals()` inside `requestAnimationFrame` on every
resize. Each successful `fit()` that changes the grid triggers `term.onResize`,
which pushes the new `cols/rows` down to the PTY — so the Claude Code process always
sees a terminal size matching the visible pane.

## Session creation flow (`src/renderer/session-create.js`)

`createSessionAndOpen({ name, dir, provider, model, onDone })` (`session-create.js:19`)
is the single entry point used by both the quick-open modal and the search bar.

1. **Guard:** returns `false` immediately if `dir` is falsy (`session-create.js:20`).
2. **Mode:** `mode = (provider && provider !== "terminal") ? "chat" : "terminal"`
   (`session-create.js:22`).
3. **ID:** `id = uuidv4()` (`session-create.js:23`, from the `uuid` package). This
   uuid is used verbatim as the Claude Code `--session-id`, so it must satisfy
   `config.js`'s `isValidSessionId` regex — which it does (uuid is `[a-zA-Z0-9-]`).
4. **Session object shape** (`session-create.js:24–33`):
   ```js
   { id, directory: dir, title: name || shortDir(dir), mode,
     provider: provider || "terminal", model: model || null,
     createdAt: Date.now(), updatedAt: Date.now() }
   ```
   `title` defaults to the shortened directory (`~/...`) when no name is given.
5. **In-memory + disk:** `state.sessions.unshift(session)` then
   `persistSession(session)` (`session-create.js:35–36`). `persistSession`
   (`helpers.js:44`) stamps `updatedAt = Date.now()` and sends `sessions:save`.
6. **Open the process:**
   - `chat` mode → `app.createChatPane(id, provider, model)` (`session-create.js:40`).
   - `terminal` mode → `app.createTerminal(id)` then
     `ipcRenderer.send("pty:spawn", { sessionId: id, cwd: dir })` **with no `resume`
     flag** so main spawns with `--session-id` (a brand-new session)
     (`session-create.js:45–46`).
7. **Directory + UI:** if `dir` differs from `state.currentDir`, `app.setDirectory(dir)`
   is called; then `app.openTab(id)` and `app.renderSessionList()`
   (`session-create.js:49–53`).

## Session IPC contract

All PTY IPC is registered in `main.js:74–95`; session/layout persistence in
`main.js:97–102`.

### PTY channels

| Channel | Direction | Payload | Handler |
| --- | --- | --- | --- |
| `pty:spawn` | renderer → main | `{ sessionId, cwd, resume }` | `main.js:89` → `spawnSession(sessionId, cwd, resume, e.sender)` |
| `pty:input` | renderer → main | `{ sessionId, data }` | `main.js:75` → `entry.proc.write(data)` |
| `pty:resize` | renderer → main | `{ sessionId, cols, rows }` | `main.js:80` → `entry.proc.resize(cols, rows)` (try/catch, logs on failure) |
| `pty:kill` | renderer → main | `{ sessionId }` | `main.js:93` → `killSession(sessionId)` |
| `pty:data` | main → renderer | `{ sessionId, data }` | `renderer.js:143` → `term.write(data)` |
| `pty:exit` | main → renderer | `{ sessionId, exitCode, resume, lifetime }` | `renderer.js:148` |

`pty:input`, `pty:resize`, and `pty:kill` all silently no-op in main if
`ptyProcesses` has no entry for the id — safe to call after a process has already
exited.

### Session / layout channels

| Channel | Direction | Payload / return | Handler |
| --- | --- | --- | --- |
| `sessions:list` | renderer → main (invoke) | returns `Session[]` sorted by `updatedAt` desc | `main.js:98` → `loadAllSessions()` |
| `sessions:save` | renderer → main (send) | full `Session` object | `main.js:99` → `saveSession(session)` |
| `sessions:delete` | renderer → main (send) | `sessionId` (string) | `main.js:100` → `deleteSession(sessionId)` |
| `layout:save` | renderer → main (send) | layout tree + `focusedPaneId` | `main.js:101` → `saveLayoutToDisk` |
| `layout:load` | renderer → main (invoke) | returns saved layout or `null` | `main.js:102` → `loadLayoutFromDisk` |

## Spawning in main (`src/main/pty.js`)

`spawnSession(sessionId, cwd, resume, senderWebContents)` (`pty.js:23`):

- **No-op guard:** returns immediately if `ptyProcesses.has(sessionId)` (`pty.js:24`)
  — one PTY per id, so re-spawning an already-running session does nothing.
- **Binary resolution:** `CLAUDE_BIN` is resolved once at module load (`pty.js:9–19`)
  by probing `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`,
  `~/.npm-global/bin/claude`, falling back to bare `claude` on `PATH`.
- **Env:** copies `process.env`, sets `TERM=xterm-256color` and
  `COLORTERM=truecolor`, and **deletes `CLAUDECODE`** (`pty.js:26–27`) so the child
  Claude Code doesn't think it's nested inside another Claude Code.
- **Args (resume vs new)** (`pty.js:33–38`):
  - `resume` truthy → `["--resume", sessionId]`
  - otherwise → `["--session-id", sessionId]`
- **Global instruction prompt** (`pty.js:40–44`): after the resume/new arg,
  `loadGlobalInstructions()` (from `config.js`) is read; if it returns a non-empty
  string, `["--append-system-prompt", instructions]` is appended. See the section
  below — blank by default, so normally nothing extra is added.
- **Spawn:** `pty.spawn(CLAUDE_BIN, args, { name: "xterm-256color", cols: 80,
  rows: 24, cwd: cwd || os.homedir(), env })` (`pty.js:38`). Initial size is the
  `DEFAULT_COLS`/`DEFAULT_ROWS` 80×24 (`pty.js:6–7`); the first FitAddon resize
  corrects it.
- **Spawn failure is graceful** (`pty.js:45–56`): a `try/catch` around `pty.spawn`
  writes a red `Failed to start claude: …` message via `pty:data` and emits
  `pty:exit` with `exitCode: 1, lifetime: 0`, then returns — it never throws.
- **On success** (`pty.js:58–73`): stores `{ proc, webContents }` in `ptyProcesses`,
  records `spawnTime`, and wires:
  - `proc.onData` → `pty:data` (guarded by `!senderWebContents.isDestroyed()`).
  - `proc.onExit(({ exitCode }))` → deletes the map entry, computes
    `lifetime = Date.now() - spawnTime`, and sends `pty:exit` (same destroyed guard).

`killSession(sessionId)` looks up the entry, calls `proc.kill()`, and deletes it
from `ptyProcesses`.

## Global instruction prompt (`src/main/config.js`)

A single, project-independent instruction file that Lithium appends to the system
prompt of **every** Claude Code CLI session, in every project — the app-level
equivalent of a `CLAUDE.md`, but owned by Lithium rather than committed to each repo.

- **File:** `~/.synthcode/instructions.md` (`INSTRUCTIONS_PATH`). Created on demand by
  `ensureInstructionsFile()`, which `pty.js` calls once at module load so the file
  always exists.
- **Ships with a default** (`DEFAULT_INSTRUCTIONS`): it tells the agent to silently
  maintain per-**area** AI hand-off docs under each project's `.lithium/docs/` — one
  `<area>.md` per feature/area, with every meaningful change (feature, **bug fix**,
  refactor, config/behavior change) logged as a dated change-log entry under the area
  it affects (not a new file per change). Read the matching doc before working, append
  after, and **never surface any of this to the user** (not in replies, not in commits).
  This makes per-project AI docs happen automatically without any repo-committed CLAUDE.md.
- **Comment-stripping:** `loadGlobalInstructions()` strips `<!-- … -->` comments and
  trims. Users can comment out or empty the file to inject nothing; a file that reduces
  to `""` means the `--append-system-prompt` flag is omitted entirely.
- **Injection point:** `pty.js` spawn args — `--append-system-prompt <instructions>`
  is appended only when `loadGlobalInstructions()` is non-empty.
- **Note on `.lithium/`:** the ACP path already uses a per-project `.lithium/` folder
  for `approved-tools.json`; this default reuses the same `.lithium/` convention for
  `docs/`, but the docs themselves are written by the agent at runtime, not by Lithium.
- **Status:** no settings UI yet; the file is edited by hand. Intent is a future
  Settings pane to edit this content.

## Exit handling & resume crash guard (`src/renderer.js:148–164`)

On `pty:exit` the renderer:
1. Looks up `terminals.get(sessionId)`; **if absent, returns immediately**
   (`renderer.js:153`) — an absent record means the tab was closed intentionally
   (the close path deletes the record first), so the session must NOT be deleted.
2. **Resume crash auto-delete** (`renderer.js:156–159`): if the process was a
   `resume` AND `lifetime < 5000` ms AND `exitCode !== 0`, it calls
   `deleteSession(sessionId)` and returns. This purges sessions whose underlying
   Claude Code transcript is gone/corrupt so they can't resume — they'd otherwise
   crash on every relaunch.
3. Otherwise: sets `t.alive = false`, writes a dim `[session ended]` line into the
   terminal, and calls `refreshLayout()` to repaint status dots.

## Session list UI (`src/renderer/sessions.js`)

`renderSessionList()` (`sessions.js:5`):
- Shows/hides the "New session" button based on whether a workspace is selected
  (`sessions.js:7–8`).
- **Workspace filter:** `state.sessions.filter(s => s.directory === state.currentDir)`
  — a session only appears under its own workspace (`sessions.js:12–14`). With no
  current dir the list is empty.
- **Sort:** by `updatedAt` desc (`sessions.js:17`).
- Each row renders a status dot (`.alive` from `terminals.get(s.id)?.alive`), the
  title (HTML-escaped), a `timeAgo(updatedAt)` meta label, and rename/delete buttons
  (`sessions.js:24–41`).
- Row click opens the tab (`app.openTab`), ignoring clicks inside the actions area
  (`sessions.js:52–57`).

**Delete** — `deleteSession(id)` (`sessions.js:72`): `app.closeTab(id)` (which kills
the PTY), sends `sessions:delete` to remove the disk file, filters the session out of
`state.sessions`, and re-renders. Note the `renderer.js` auto-delete path calls the
same exported `deleteSession`.

**Rename** — `startRename(sessionId)` (`sessions.js:79`): swaps the title span for an
`input` pre-filled with the current title. On commit (`blur`, or `Enter`) it sets
`s.title` (falling back to the old title if blank), calls `persistSession(s)` (which
bumps `updatedAt` and writes to disk via `sessions:save`), and `app.refreshLayout()`.
`Escape` restores the old title and blurs without persisting a change
(`sessions.js:98–109`).

The quick-open / search-bar list (`session-create.js:144`) is a separate renderer
that lists sessions **across all workspaces** (no `currentDir` filter), matching on
title or directory substring, always prefixed with a "New Session" row.

## Opening & closing tabs (`src/renderer/tabs.js`)

**Open** (`tabs.js`): if the session has no live terminal record
(`!terminals.has(sessionId)`), it recreates one and **resumes** the PTY:
`createTerminal(sessionId)` + `pty:spawn { sessionId, cwd: s.directory, resume: true }`
(`tabs.js:22–25`). So re-opening a previously-closed session resumes it rather than
starting fresh. It then inserts the tab into the focused leaf of the layout tree.

**Close** — `closeTab(sessionId)` (`tabs.js:51`): for terminal sessions sends
`pty:kill`, then disposes the xterm instance, removes the pane element, and
**deletes the `terminals` record** (`tabs.js:60–68`). Deleting the record first is
what makes the subsequent `pty:exit` a no-op (see exit handling step 1) — closing a
tab must not delete the persisted session.

## Persistence & restore (`src/main/config.js`)

**On-disk layout** — everything lives under `~/.synthcode` (`config.js:8–11`):
- `~/.synthcode/sessions/<id>.json` — one file per session.
- `~/.synthcode/config.json` — recent dirs, starred dirs, `currentDir`, etc.
- `~/.synthcode/layout.json` — the persisted split-pane layout + `focusedPaneId`.

**Session file shape** is exactly the object from `session-create.js` (id,
directory, title, mode, provider, model, createdAt, updatedAt) — `saveSession`
serializes it verbatim with `JSON.stringify(session, null, 2)` (`config.js:64–71`).

**ID validation** — `isValidSessionId` (`config.js:36`) requires a string, length
1–255, matching `/^[a-zA-Z0-9_-]+$/`. Both `saveSession` and `deleteSession` bail if
the id is invalid, which prevents path traversal via the `<id>.json` filename.

**Load** — `loadAllSessions()` (`config.js:48`) ensures the dir exists, reads every
`*.json` in `sessions/`, JSON-parses each (skipping and logging any that fail), and
returns them sorted by `updatedAt` desc.

**Delete** — `deleteSession(sessionId)` (`config.js:73`) unlinks
`sessions/<id>.json` if present.

**Layout** — `saveLayoutToDisk` / `loadLayoutFromDisk` (`config.js:80–94`) write/read
`layout.json`; both are wrapped so a missing/corrupt file yields `null` rather than
throwing.

### Restore on launch (`src/renderer.js:198–247`)

`init()`:
1. Loads recent/starred dirs and the saved `currentDir`.
2. `state.sessions = await ipcRenderer.invoke("sessions:list")` (`renderer.js:207`).
3. Loads the saved layout (localStorage first, then `layout:load` from disk).
4. **Prunes** the layout: filters each leaf's `tabs` to session ids that still exist,
   repoints a dangling `activeTab`, and drops now-empty leaves via
   `cleanupEmptyLeaves` (`renderer.js:216–224`).
5. For every session id still referenced by a surviving leaf that has no live
   terminal record, it recreates the pane and **resumes**: terminal sessions call
   `createTerminal(sid)` + `pty:spawn { sessionId: sid, cwd: s.directory, resume: true }`
   (`renderer.js:230–236`); chat sessions call `createChatPane`.

So the resume path (`--resume`) is used both on relaunch restore and on re-opening a
closed tab; the fresh path (`--session-id`) is used only by `createSessionAndOpen`
for brand-new sessions.

## State model (`src/renderer/state.js`)

- `state.sessions` — flat array of all session objects (all workspaces, all modes).
- `terminals` — a `Map<sessionId, { term, fitAddon, paneEl, alive }>` for live
  terminal panes (chat panes store a different record with `isChat`). Presence in
  this Map means "has a live pane"; `alive` means "PTY still running".
- `state.layout` — a binary split-pane tree of `leaf`/`split` nodes; leaves hold
  `tabs` (session ids) and an `activeTab`. `getAllLeaves`, `findLeafBySession`,
  `cleanupEmptyLeaves`, etc. operate on it (`state.js:14–53`).
- `state.activeId` — computed getter: the `activeTab` of the focused leaf
  (`state.js:59–66`).

## Gotchas

- One PTY per `sessionId`; `spawnSession` no-ops if the id is already running
  (`pty.js:24`), and `pty:input`/`resize`/`kill` no-op if no entry exists.
- Always guard `senderWebContents.isDestroyed()` before `.send()` — the window may be
  gone when data/exit arrives (`pty.js:47, 62, 70`).
- If the `claude` binary isn't found or spawn fails, it reports via `pty:data` +
  `pty:exit` (exitCode 1) rather than throwing (`pty.js:45–56`).
- Closing a tab deletes the `terminals` record **before** the PTY's `pty:exit`
  arrives; the exit handler relies on that absence to avoid deleting the session
  (`renderer.js:153`). Don't reorder those steps.
- Resume + fast non-zero exit (`< 5s`) auto-deletes the session (`renderer.js:156`) —
  intentional cleanup of unresumable sessions, but it means a session can silently
  disappear if its Claude Code transcript is missing.
- Sessions are filtered by workspace in the sidebar (`s.directory === currentDir`) but
  NOT in the quick-open/search list — the same session shows up differently in each.
- `title` is a UI label only; Claude Code identifies the process solely by the uuid
  `--session-id` / `--resume` id, which must stay within `isValidSessionId`.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Broadened the default from per-feature to **per-area**: docs now cover any meaningful change (features, bug fixes, refactors, config changes) as change-log entries under the affected area's `<area>.md`, with a `feat|fix|refactor|chore` tag in the entry heading.
- **2026-07-08** — Global instruction prompt (`~/.synthcode/instructions.md`) now ships with a `DEFAULT_INSTRUCTIONS` default: the agent silently maintains AI docs under each project's `.lithium/docs/` (read before working, dated change-log after) without surfacing it to the user. Adapted from the `feature-docs` skill, moved from `~/…/ai-docs/<project>` to per-project `.lithium/docs/`.
- **2026-07-08** — Added a global instruction-prompt scaffold: `~/.synthcode/instructions.md`, injected into every CLI session via `--append-system-prompt` when non-blank (`config.js` `ensureInstructionsFile`/`loadGlobalInstructions`, wired in `pty.js`). No UI yet; edit the file by hand. Future work: a Settings pane to edit it.
- **2026-07-08** — Expanded doc with full terminal/session lifecycle, IPC contract, and persistence details.
- **2026-07-08** — Initial doc created (documenting existing behavior; no code change).
