# Theme, focus mode & music player

> The app's visual theming (a single warm/amber palette), the distraction-free
> "focus mode" CSS, and the dockable lofi + system-media music player.

## Overview

Three loosely-related presentation features:

- **Theme** — Lithium ships a single dark, warm-amber theme. There is no theme
  switcher. The terminal palette lives in `src/renderer/theme.js`; the app-chrome
  palette lives as CSS custom properties in `src/styles/base.css`.
- **Focus mode** — a `body.focus-mode` CSS state (`src/styles/focus.css`) that
  hides all chrome for a full-bleed terminal. The styles exist but are currently
  **not wired** (see Gotchas).
- **Music player** — a dock/compact player that plays bundled lofi tracks
  (streamed from the app's `music/` folder via a custom `media://` protocol) or
  mirrors/controls the system "now playing" app (Spotify / Apple Music) over
  AppleScript.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/theme.js` | xterm.js terminal color theme object (single export) |
| `src/styles/base.css` | App-chrome theme tokens (`:root` custom properties) |
| `src/styles/focus.css` | `body.focus-mode` rules that hide chrome |
| `src/renderer/music.js` | Music player state, playback controls, lofi/device sourcing, UI sync |
| `src/main/media.js` | `media:now-playing` / `media:control` IPC via `osascript` |
| `main.js` | `music:list` IPC + `media://` protocol registration |
| `music/` | Bundled `.mp3` lofi tracks |

## Theme

### Terminal theme (`src/renderer/theme.js`)
A single plain object of xterm.js color keys (`background #0C0B09`, `foreground
#F0ECE3`, `cursor #E8A838`, plus the 16 ANSI colors and their bright variants).
It is `require`d once by `src/renderer/terminal.js:5` and passed to every xterm
instance. There is only this one theme — no alternates, no runtime switching.

### App-chrome theme (`src/styles/base.css:2-35`)
The UI chrome uses CSS custom properties on `:root` — e.g. `--bg #0C0B09`,
`--surface`, `--fg`, `--primary #E8A838` (amber), `--secondary #5BA88C` (green,
used for "running"/"alive" indicators), `--accent`, `--destructive #C94234`, plus
fonts (Playfair Display / DM Sans / JetBrains Mono), radii, and easing curves.
These mirror the terminal palette so the whole app reads as one warm theme.
"Applying a theme" means these tokens are consumed by every stylesheet; changing
the theme would mean editing these variables, as there is no theme-switch layer.

## Focus mode (`src/styles/focus.css`)

When `<body>` carries the class `focus-mode`, the CSS hides the chrome for a
full-bleed terminal:

- **Hidden** (`display: none`): `#sidebar` + its resize handle, `#browser-panel` +
  its resize handle, `.pane-tab-bar-wrapper`, `#music-dock`, and `.git-sidebar`
  (`focus.css:2-8`).
- **Flattened**: `#app` padding/gap removed, `#main` and `#terminal-area` borders
  and radii removed, `#titlebar` gets left padding for the traffic lights
  (`focus.css:10-14`).
- An `.exit-focus-btn` style (muted, destructive on hover) is defined for a way
  back out (`focus.css:16-17`).

Net effect: a borderless terminal filling the window with the sidebar, browser,
tab bar, music dock, and git panel all gone.

## Music player (`src/renderer/music.js`)

### Two sources
`musicPlayer.source` is `"lofi"` or `"device"` (`music.js:27`), toggled by the
source button (`handleSourceToggle`, `music.js:134`) and persisted to
`localStorage["musicSource"]`.

- **Lofi** — a single `Audio` element (`music.js:4`). Tracks come from
  `music:list` (see IPC), get shuffled (`shuffleArray`), and stream via
  `audio.src = "media://" + track.path` (`music.js:265`).
- **Device** — polls the system "now playing" app every 2 s
  (`pollDeviceMedia` on a `setInterval`, `music.js:159`) and sends transport
  commands to it. No local audio is played in this mode; the volume slider is
  hidden (`music.js:253-256`).

### Initialization (`initMusicPlayer`, `music.js:67-130`)
Awaits `music:list`, stores `lofiTracks`, seeds shuffled `tracks`, sets initial
volume from the `#mp-volume` slider, wires all dock + compact buttons, and
restores the saved source (`musicSource`) and player mode (`playerMode`). On lofi
`error` events it auto-skips to the next track (`music.js:82-86`); on `ended` it
advances (`music.js:79`).

### Playback controls
Dock buttons (`#mp-*`) and compact buttons (`#cp-*`) both bind to the same
handlers, and `syncCompactPlayer` keeps the compact bar's track name / play-pause
icon / `playing` class in sync (`music.js:46-65`).

| Control | Lofi behavior | Device behavior |
| --- | --- | --- |
| Play/pause (`togglePlay`, `music.js:272`) | pause/`audio.play()` (optimistic UI, reverts on failure) | `media:control { action: "toggle" }` then re-poll |
| Next (`playNextTrack`, `music.js:334`) | advance index; re-shuffle at end (avoiding an immediate repeat of the last track) | `media:control { action: "next" }` |
| Prev (`playPrevTrack`, `music.js:359`) | restart track if >3 s in, else previous | `media:control { action: "prev" }` |
| Volume (`#mp-volume`) | sets `audio.volume` (0–1) | hidden (N/A) |
| Seek (`handleTrackBarSeek`, `music.js:8`) | sets `audio.currentTime` from click x | `media:control { action: "seek", position }` |

Progress is driven by a `requestAnimationFrame` loop `updateTrackProgress`
(`music.js:310`, kicked off from `renderer.js:191`) that sets the
`--track-progress` CSS var on `.dock-track-bar` / `.cp-track-bar`. In device mode
it extrapolates position from the last poll + elapsed wall-clock time.

### Player mode (`setPlayerMode`, `music.js:35`)
`"full"` shows `#music-dock`, `"compact"` shows `#compact-player`, `"none"` hides
both. Persisted to `localStorage["playerMode"]`. This is the function the settings
"Player mode" cards call (see `docs/settings.md`).

## Media / IPC contract

### Bundled lofi tracks — `music:list` (`main.js:196-206`)
Reads `<appRoot>/music`, filters `.mp3|.m4a|.ogg|.wav|.flac`, and returns
`[{ name, path }]` where `name` is the filename without extension and `path` is an
absolute path. The `music/` folder currently holds nine `.mp3` lofi tracks.

### Custom `media://` protocol (`main.js:296-310`)
Registered as privileged (`stream: true, standard: true, supportFetchAPI: true`)
and handled by fetching `file://` + the decoded pathname. This is what lets
`audio.src = "media://" + absolutePath` stream a local file that `file://` would
otherwise be blocked from loading. `autoplay-policy` is set to
`no-user-gesture-required` (`main.js:302`) so playback can start programmatically.

### System media — `src/main/media.js`
Two `ipcMain.handle` channels driving `osascript -l JavaScript`:

- **`media:now-playing`** (`media.js:59`) → `{ title, duration, position,
  playing, app }` or `null`. Checks **Spotify** first, then **Music**
  (`NOW_PLAYING_SCRIPT`, `media.js:15-54`). Results are cached/debounced for
  `NOW_PLAYING_DEBOUNCE_MS = 800 ms` (`media.js:60-61`); durations are normalized
  to seconds. The `app` field records which player is active so control commands
  can target it.
- **`media:control`** (`media.js:74`) → `{ action, position }`, returns boolean.
  `action` maps to `playpause()` / `nextTrack()` / `previousTrack()` /
  `playerPosition = <n>` on the cached `app`. Returns `false` if nothing is
  playing (no cached app) or the AppleScript fails. `position` is coerced to a
  finite number before injection (`media.js:78`).

Registered in `main.js` via `registerMediaHandlers()` (`main.js:208`).

## Gotchas

- **Focus mode is not wired.** No JS toggles `body.focus-mode`, no button uses
  `.exit-focus-btn`, and `focus.css` is **not** imported by `src/styles/main.css`
  (which imports base/layout/terminal/music/settings/git/quickopen/searchbar/chat
  only). The styles are dormant; enabling focus mode means both importing
  `focus.css` and adding the toggle + exit button.
- **Device control depends on a prior poll.** `media:control` targets
  `_nowPlayingCache.data.app`; if `media:now-playing` hasn't populated the cache,
  control commands no-op. The player switches to device mode by immediately
  calling `pollDeviceMedia()` before starting the interval (`music.js:158-159`).
- **macOS only for device source.** `media.js` shells out to `osascript` against
  Spotify/Music — non-macOS platforms get `null` and an inert device mode.
- **Optimistic play UI.** `togglePlay` flips `playing` and updates the button
  before `audio.play()` resolves, reverting on rejection (`music.js:289-296`); the
  same optimism is used for device toggle.
- **Stale-poll guard.** `pollDeviceMedia` bails if `musicPlayer.source` changed
  while the async call was in flight (`music.js:204`) and uses
  `_devicePollInFlight` to avoid overlapping polls.
- **Track auto-skip on decode error** only fires while playing in lofi mode
  (`music.js:82-86`) — a bad file won't stall the queue.
- **`music:list` reads the app-relative `music/` dir** (`path.join(__dirname,
  "music")`); it must be packaged with the app or the list comes back empty.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
