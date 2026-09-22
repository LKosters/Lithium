# Settings

> The settings overlay and the on-disk config store that backs app preferences —
> sidebar view, player mode, projects directory, per-project start commands, and
> the update checker.

## Overview

Settings live in a full-screen tabbed overlay opened from the titlebar gear or
`Cmd+,`. Durable app config, appearance preferences and chat drafts are stored in
`~/.synthcode/lithium.sqlite`. The renderer keeps a localStorage mirror initialized
from SQLite before loading other modules. See [storage.md](./storage.md).
Changes are re-read on opening a window; there is no live cross-window preference broadcast.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/settings.js` | Settings overlay UI, tab switching, every setting's event wiring |
| `src/main/config.js` | SQLite config facade; per-project settings and data-dir paths |
| `main.js` | Registers the `config:*`, `directory:pick`, `updater:*` IPC handlers |
| `src/renderer/music.js` | `setPlayerMode` (player-mode setting is applied here) |

## Settings exposed in the UI

Overlay wiring is in `src/renderer/settings.js`; chat defaults use `src/renderer/chat-settings.js`.

### Chat defaults
The **Chats** tab selects provider, live model, model-supported reasoning effort,
and native permission mode. **Save defaults** persists a validated settings object
under the SQLite config object’s `chatDefaults` key, through `chat:defaults:get/set` (invoke, using
the chat `{ ok, value/error }` response envelope). `chat:defaults:catalog` loads
models using the provider's native login in the home directory, without a model
prompt. Missing providers/offline catalogs preserve saved choices. Provider/model
changes reset incompatible choices; stale catalog responses are ignored.

New chat documents snapshot these defaults on first open and are persisted even
when empty. Existing chats are never rewritten by a defaults change. Native
“Provider default” model/effort and permission settings still resolve in each
chat's workspace. Invalid stored defaults fall back to Claude's default mode.

### Sidebar view (`settings.js:20-49`)
Buttons carrying `data-sidebar-view` (`default` / `compact`). `setSidebarView`
(`settings.js:23`) writes to **both** `localStorage["sidebarView"]` and
SQLite via `config:set`, then toggles `.sidebar-compact` on `#sidebar`.
Restored on load (`settings.js:45-49`) preferring `config:get` → `localStorage` →
`"default"`.

### Player mode (`settings.js:51-71`)
Buttons carrying `data-player-mode` (`full` / `compact` / `none`) with live
previews. Clicking calls `app.setPlayerMode(mode)` (implemented in `music.js:35`),
which toggles `#music-dock` / `#compact-player` visibility and saves
SQLite through the preferences facade and its `localStorage["playerMode"]` mirror. Note: `settings.js` itself does **not** persist the
player mode — persistence lives in `music.js:43`.

### Projects directory (`settings.js:111-157`)
Shows the resolved default projects directory. `loadProjectsDirSetting` calls
`config:resolve-projects-dir`; the picker button calls `directory:pick` then
`config:set { key: "projectsDir" }`; the create button calls
`config:create-default-projects-dir` (creates `~/lithium-projects`).

### Project settings (`settings.js:157-215`)
Settings for the workspace that is currently open (`app.state.currentDir`), stored
**with the project** rather than in `config.json` — see "Per-project settings"
below. The panel is disabled with a "No project selected" label when there is no
current workspace.

- **Start commands** — a `#settings-start-commands` textarea, one command per
  line. `loadProjectSettings()` fills it from `project:get-settings`;
  `#btn-save-start-commands` splits/trims the lines and sends
  `project:set-settings { dir, settings: { startCommands } }`, then calls
  `app.refreshDevServerButton()` so the toolbar play button reflects the new
  commands. It deliberately does **not** call `app.checkDevServerAvailable()`,
  which would stop a running app.

### Updates
The About panel and startup toast share `src/renderer/updates.js`. Download and
installation are separate actions. The main process owns release metadata,
checksum verification and update state; the renderer never supplies executable
URLs. See [auto-update.md](./auto-update.md) for the unsigned macOS installer,
rollback, release manifest and save-before-restart protocol.

## Config store (`src/main/config.js`)

**Location:** `~/.synthcode/lithium.sqlite`, or `LITHIUM_DATA_DIR/lithium.sqlite`.
Config remains a JSON-shaped object exposed by `loadConfig`/`saveConfig`, now stored
as a SQLite setting. Reads are detached; writes are transactional. Legacy JSON is
imported once and preserved. Keys include:

| Key | Written by | Meaning |
| --- | --- | --- |
| `recentDirs` | `addRecentDir` (`config.js:40`), capped at `MAX_RECENT_DIRS` = 10 | Recently opened workspace dirs, newest first |
| `starredDirs` | `directory:toggle-star` (`main.js:186`) | Favorited workspace dirs |
| `projectsDir` | `config:set`, `config:resolve/create-default-projects-dir` | Root for new projects |
| `currentDir` | `config:set` from `directory.js` | Last active workspace |
| `sidebarView` | `config:set` from `settings.js` | `"default"` / `"compact"` |

## Per-project settings (`<project>/.lithium/settings.json`)

Settings that belong to a project, not to the app, live next to the project's AI
docs in `<project>/.lithium/settings.json`, so they travel with the repo.
`loadProjectSettings(dir)` / `saveProjectSettings(dir, settings)` (`config.js`)
are the only accessors; both normalize the shape and never throw — a missing or
unreadable file reads as `{ startCommands: [] }`, and saving to a non-existent
directory returns `false`.

| Key | Meaning |
| --- | --- |
| `startCommands` | `string[]` — what the toolbar play button runs for this project (see [dev-server.md](./dev-server.md)) |

Values are trimmed and non-string/blank entries dropped on both read and write,
so callers can rely on getting a clean `string[]`.

## Data & backups

The **Data & backups** tab (`src/renderer/data-settings.js`) shows the database
location and counts. Export creates a checksummed versioned JSON backup including
images. Import validates the file, previews session/chat counts, requires an
explicit restore confirmation, saves a recovery backup, replaces app data and
restarts. Project files and native provider credentials/history are excluded.
See [storage.md](./storage.md) for limits and IPC.

## IPC contract

Renderer → main, all registered in `main.js`:

| Channel | Kind | Payload → Return | Location |
| --- | --- | --- | --- |
| `config:get` | invoke | `key` → `config[key] ?? null` | `main.js:211` |
| `config:set` | send | `{ key, value }` → (none) | `main.js:213` |
| `config:resolve-projects-dir` | invoke | → dir string or `null` (auto-adopts `~/lithium-projects` if it exists) | `main.js:219` |
| `config:create-default-projects-dir` | invoke | → creates + returns `~/lithium-projects` | `main.js:230` |
| `directory:pick` | invoke | → `{ dir, recents, starred }` or `null` | `main.js:105` |
| `project:get-settings` | invoke | `dir` → `{ startCommands: string[] }` | `project.js:9` |
| `project:set-settings` | invoke | `{ dir, settings }` → `{ ok }` | `project.js:11` |

Main → renderer:

| Channel | Payload | Purpose |
| --- | --- | --- |
| `menu:open-settings` | (none) | `Cmd+,` menu item opens the overlay (`settings.js:374`) |
| `updater:download-progress` | `percent` | Download progress ticks (`settings.js:351`) |

## How changes propagate

Settings take effect **immediately in the current renderer** — the handlers
directly mutate the DOM (toggle `.sidebar-compact`, call `setPlayerMode`, etc.).
`config:set` is fire-and-forget with no acknowledgement or rebroadcast, so:

- The change is durable on disk but is **not** pushed to other open windows.
- Anything relying on config re-reads it on next open (e.g. the overlay restores
  its UI state each time `openSettings` runs, `settings.js:73-90`).

## Gotchas

- **Dual-write invariant for `sidebarView`:** it is stored in both `localStorage`
  and SQLite. Keep both in sync — `setSidebarView` writes both; the restore
  path prefers config but falls back to `localStorage`.
- **Player mode persistence is elsewhere:** clicking a player-mode card does not
  itself save anything; it delegates to `music.js` `setPlayerMode`, which owns the
  preferences facade write. Removing that call silently loses persistence.
- **Project settings are not in `config.json`:** they live in the project's own
  `.lithium/settings.json`, so they are per-repo and travel with it. Opening the
  overlay re-reads them for whatever workspace is current at that moment.
- **Legacy JSON is archival:** editing `config.json` has no effect after the one-time
  migration. Use app settings or the validated import flow.

## Change log

- **2026-09-22** — Added Web access: explicit start/stop, remembered port, LAN/Tailscale addresses and access code. Hosting controls stay desktop-only. See [web-access.md](web-access.md).

Newest first. Each entry: date, who/what, and the change.

- **2026-09-22** — About/toast now share update state with separate download and restart/install actions. Removed duplicated download listeners.

- **2026-09-22** — Added Data & backups, migrated app settings/drafts to SQLite and initialized renderer mirrors from the database before module startup.

- **2026-09-22** — Added Chats settings for provider/model/effort/permissions,
  acknowledged saves and live catalogs. New sessions capture defaults once;
  existing and reopened empty chats retain their own settings. Config cache is
  updated after the write succeeds so failed default saves do not take effect.

- **2026-07-22** — Removed the Agents/ACP panel along with ACP chat support.
  Replaced it with a **Project** panel that edits the current workspace's start
  commands, backed by a new per-project store (`<project>/.lithium/settings.json`)
  and the `project:get-settings` / `project:set-settings` IPC.
- **2026-07-08** — Initial doc created.
