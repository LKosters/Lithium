# Auto-update

> Checks GitHub Releases for a newer version, downloads the platform installer
> with progress, and launches it — stripping macOS quarantine so Gatekeeper
> doesn't flag an unsigned build as "damaged".

## Overview

Lithium rolls its own updater against the GitHub Releases REST API (it does
**not** use `electron-updater` / Squirrel). On demand it fetches the latest
release, compares versions, and if a newer one exists picks the asset matching
the current OS (`.dmg` / `.exe` / `.AppImage`). The renderer can then trigger a
download (with percentage progress) and install. Install behavior is
platform-specific; on macOS the downloaded DMG has its `com.apple.quarantine`
attribute stripped before opening.

## Key files

| File | Responsibility |
| --- | --- |
| `src/main/updater.js` | GitHub release fetch, version compare, download, platform install, IPC handlers |
| `package.json` | Source of the current `version` compared against the release tag |

## How it works

**Repo / endpoint** (`main/updater.js:8-9`, `11-34`): targets
`REPO_OWNER = "lkosters"` / `REPO_NAME = "lithium"`. `fetchLatestRelease()`
does a plain `https.get` to
`api.github.com/repos/lkosters/lithium/releases/latest` with a
`User-Agent: Lithium-Updater` header (GitHub rejects requests without a UA).
Non-200 rejects with `GitHub API returned <status>`; the body is `JSON.parse`d.

**Version compare** (`main/updater.js:36-47`): `compareVersions(current, latest)`
strips a leading `v`, splits on `.`, coerces each part to a number, and compares
segment by segment. Returns `1` if latest > current. Missing segments default to
`0`. Note it's purely numeric-dotted — pre-release/build suffixes (e.g.
`-beta.1`) become `NaN` and are not handled specially.

**Platform asset selection** (`main/updater.js:49-56`, `127-130`):
`getPlatformAssetPattern()` returns a regex per `process.platform` — `darwin`
→ `/\.dmg$/i`, `win32` → `/\.exe$/i`, `linux` → `/\.AppImage$/i`, otherwise
`null`. The first release asset whose `name` matches is chosen. If no asset
matches (or platform unsupported), `downloadUrl`/`assetName` come back `null`.

**Download with progress** (`main/updater.js:58-91`): `downloadFile` follows 3xx
redirects manually (`res.headers.location`) — required because GitHub asset URLs
redirect to a signed S3 URL. It picks `http`/`https` per URL scheme, streams to
`destPath`, and calls `onProgress(percent)` computed from `content-length`. On
stream error it `fs.unlink`s the partial file. If `content-length` is absent,
`onProgress` is never called (progress stays at its last value).

**Install** (`main/updater.js:93-116`): `installUpdate(filePath)` branches on
platform, then `app.quit()`s 1s later so the installer/app can take over:
- **darwin**: `xattr -dr com.apple.quarantine "<file>"` then `open "<file>"`. Stripping quarantine keeps Gatekeeper from flagging the unsigned/un-notarized DMG (and the app dragged out of it) as "damaged and can't be opened". The `open` mounts the DMG for the user to drag to Applications.
- **win32**: `start "" "<file>"` runs the NSIS `.exe` installer.
- **linux**: `fs.chmodSync(filePath, 0o755)` then `"<file>" &` launches the AppImage.

### IPC contract

Renderer → main (`ipcRenderer.invoke`):
- `updater:check` — no payload → object `{ currentVersion, latestVersion, updateAvailable, releaseUrl, downloadUrl, assetName, assetSize, releaseName, publishedAt }`, or `{ error }` on failure (`main/updater.js:119-146`).
- `updater:download-and-install` — payload `{ downloadUrl, assetName }` → `{ success: true }` or `{ error }`. Emits progress events while downloading, then installs and quits (`main/updater.js:148-164`).
- `updater:get-version` — no payload → the current `pkg.version` string (`main/updater.js:166`).

Main → renderer (`event.sender.send`):
- `updater:download-progress` — payload is an integer `percent` (0–100) (`main/updater.js:155`).

Renderer → main (legacy, `ipcRenderer.send`):
- `updater:open-release` — payload is a URL string; opens it in the external browser via `shell.openExternal` (`main/updater.js:169-171`). Kept as a fallback path (open the release page manually instead of in-app download).

Exported: `main/updater.js` exports `{ registerUpdaterHandlers }`, called once
during app init to register all the above handlers.

## Gotchas

- **Not `electron-updater`.** No delta updates, no signature verification, no
  auto-relaunch of the new version — it just downloads and opens the installer,
  then quits the current app. The user completes the install manually.
- **macOS quarantine strip is essential for unsigned builds.** Without
  `xattr -dr com.apple.quarantine`, Gatekeeper marks the DMG/app as "damaged".
  The command is run with `2>/dev/null` and its result is ignored — if `xattr`
  isn't available or fails, `open` still runs and the user may hit the Gatekeeper
  warning.
- **`app.quit()` fires 1s after `exec` starts, not after install completes.** The
  `setTimeout(() => app.quit(), 1000)` runs regardless of whether the installer
  actually opened. On macOS/linux the launched process is detached enough to
  survive; on Windows the `start` shim returns immediately.
- **Version compare is numeric-only.** Tags must be plain `vX.Y.Z`. A
  pre-release suffix produces `NaN` segments and the comparison result is
  undefined behavior — don't publish semver pre-releases as "latest".
- **`releases/latest` excludes pre-releases and drafts** on GitHub's side, so a
  draft/pre-release build won't be offered even if it's newer.
- **No auth header.** Uses unauthenticated GitHub API calls — subject to the
  ~60 req/hour/IP rate limit. Repeated checks can return 429/403 and surface as
  `{ error }`.
- **Redirect following is manual and unbounded in depth logic** (it recurses on
  each 3xx). A redirect loop would recurse indefinitely; in practice GitHub → S3
  is a single hop.
- **`assetSize` vs actual download.** `assetSize` comes from the GitHub API
  metadata; progress percentage is computed from the response `content-length`,
  which is the S3 object size after redirect — normally identical.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
