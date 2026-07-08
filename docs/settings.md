# Settings

> The settings overlay and the on-disk config store that backs app preferences —
> sidebar view, player mode, projects directory, agent/ACP configuration, and the
> update checker.

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

### Agent / ACP settings (`settings.js:159-237`)
- **Default agent mode** — `.agent-card` elements (`terminal` vs `acp`).
  Loaded via `agent:get-default`, saved via `agent:set-default`.
- **Enabled ACP providers** — `data-acp-toggle` checkboxes. Loaded via
  `agent:get-enabled-acps`, toggled via `agent:set-acp-enabled { provider, enabled }`.
- **Tool approval mode** — `#toggle-tool-approval`. Checked ⇒ `"manual"`,
  unchecked ⇒ `"auto"`. Loaded via `agent:get-tool-approval-mode`, saved via
  `agent:set-tool-approval-mode`.
- **ACP server start/stop** — `data-acp-server` buttons call
  `agent:<providerId>-server-status|-start|-stop`. Status is polled every 3 s
  while the overlay is open (`pollACPServerStatus`, `settings.js:284-291`) and
  the polling interval is cleared on close (`stopACPStatusPolling`).

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
- **ACP status polling leaks if not stopped:** `openSettings` starts a 3 s
  interval; `closeSettings` must call `stopACPStatusPolling` (it does) or the
  interval keeps firing `agent:*-server-status` after the overlay closes.
- **Config cache is process-local:** editing `config.json` on disk while the app
  runs has no effect until relaunch, because `loadConfig` returns the cached copy.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
