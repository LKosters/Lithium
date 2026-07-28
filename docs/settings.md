# Settings

> The settings overlay and the on-disk config store that backs app preferences —
> sidebar view, player mode, projects directory, per-project start commands, and
> the update checker.

## Overview

Settings live in a full-screen overlay (`#settings-overlay`) opened from the
titlebar gear button or the app menu (`Cmd+,`). The overlay is tabbed; each nav
item toggles one panel. Individual settings persist through two mechanisms:

- **`~/.synthcode/config.json`** — the durable, main-process config store
  (`src/main/config.js`), read/written over IPC.
- **`localStorage`** — a fast renderer-side mirror used for a few UI-only
  preferences (`sidebarView`, `playerMode`, `musicSource`).

Some settings (sidebar view) are written to *both* stores; others live in only
one. There is no config → renderer broadcast: a change made in one window is not
pushed to another window until that window re-reads config.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/settings.js` | Settings overlay UI, tab switching, every setting's event wiring |
| `src/main/config.js` | On-disk config load/save, cached in memory; data-dir paths |
| `main.js` | Registers the `config:*`, `directory:pick`, `updater:*` IPC handlers |
| `src/renderer/music.js` | `setPlayerMode` (player-mode setting is applied here) |

## Settings exposed in the UI

All wiring is in `src/renderer/settings.js`.

### Sidebar view (`settings.js:20-49`)
Buttons carrying `data-sidebar-view` (`default` / `compact`). `setSidebarView`
(`settings.js:23`) writes to **both** `localStorage["sidebarView"]` and
`config.json` via `config:set`, then toggles `.sidebar-compact` on `#sidebar`.
Restored on load (`settings.js:45-49`) preferring `config:get` → `localStorage` →
`"default"`.

### Player mode (`settings.js:51-71`)
Buttons carrying `data-player-mode` (`full` / `compact` / `none`) with live
previews. Clicking calls `app.setPlayerMode(mode)` (implemented in `music.js:35`),
which toggles `#music-dock` / `#compact-player` visibility and saves
`localStorage["playerMode"]`. Note: `settings.js` itself does **not** persist the
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

### Update checker (`settings.js:300-371`)
- Current version shown via `updater:get-version`.
- **Check for Updates** → `updater:check` → `{ updateAvailable, latestVersion,
  currentVersion, downloadUrl, assetName, releaseUrl, error }`.
- **Download & Install** → `updater:download-and-install { downloadUrl, assetName }`,
  with progress streamed on the `updater:download-progress` event (percent). If
  there is no matching asset it falls back to `updater:open-release`.

## Config store (`src/main/config.js`)

**Location.** `DATA_DIR = ~/.synthcode` (`config.js:8`). Within it:
`config.json` (`CONFIG_PATH`, `config.js:10`), `sessions/` (`config.js:9`), and
`layout.json` (`config.js:11`). `DEFAULT_PROJECTS_DIR = ~/lithium-projects`
(`config.js:12`).

**Shape.** A flat JSON object, pretty-printed with 2-space indent
(`saveConfig`, `config.js:31-34`). Default when missing/unparseable is
`{ recentDirs: [] }` (`config.js:26`). Keys written by the app include:

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

**Caching.** `loadConfig` memoizes into `_configCache` (`config.js:19-29`);
`saveConfig` overwrites both the file and the cache. Because the cache is never
invalidated externally, all writes must go through `saveConfig` or the in-memory
copy drifts from disk.

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
  and `config.json`. Keep both in sync — `setSidebarView` writes both; the restore
  path prefers config but falls back to `localStorage`.
- **Player mode persistence is elsewhere:** clicking a player-mode card does not
  itself save anything; it delegates to `music.js` `setPlayerMode`, which owns the
  `localStorage["playerMode"]` write. Removing that call silently loses persistence.
- **Project settings are not in `config.json`:** they live in the project's own
  `.lithium/settings.json`, so they are per-repo and travel with it. Opening the
  overlay re-reads them for whatever workspace is current at that moment.
- **Config cache is process-local:** editing `config.json` on disk while the app
  runs has no effect until relaunch, because `loadConfig` returns the cached copy.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-22** — Removed the Agents/ACP panel along with ACP chat support.
  Replaced it with a **Project** panel that edits the current workspace's start
  commands, backed by a new per-project store (`<project>/.lithium/settings.json`)
  and the `project:get-settings` / `project:set-settings` IPC.
- **2026-07-08** — Initial doc created.
