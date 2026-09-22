# In-app updates

Lithium uses its own unsigned macOS updater. The UI offers **Download update**,
then **Restart and install**. No Apple Developer account, signing identity or
notarization credentials are required by this flow. It does not disable Gatekeeper
or strip quarantine attributes, so macOS can still show its own security prompts.

## Files

| File | Responsibility |
| --- | --- |
| `src/main/updater.js` | Main-process state, IPC, draft/chat flush, database backup and shutdown |
| `src/main/update/release.js` | Trusted GitHub release metadata, architecture selection, download and checksum |
| `src/main/update/mac.js` | App location checks, ZIP extraction, bundle verification, staging and helper startup |
| `src/main/update/install-mac.sh` | Detached installer, rename/rollback, launch and health acknowledgement |
| `src/main/maintenance.js` | Excludes simultaneous restore/install operations |
| `src/renderer/updates.js` | Shared About/toast state and per-window draft flush handshake |
| `scripts/update-manifest.js` | Generates checksums and sizes for all release targets |
| `.github/workflows/release.yml` | Builds both Mac architectures plus Windows/Linux, publishes manifest |

## Release contract

The fixed repository is `lkosters/lithium`. Only published stable releases with
plain `vX.Y.Z` tags are accepted; CI requires the tag to match `package.json`.
Assets use `Lithium-<version>-<os>-<arch>.<ext>` names (`mac`, `win`, `linux`).
macOS builds both DMG (first install) and ZIP (updates), separately on native
Apple Silicon and Intel runners. Windows builds NSIS x64 and Linux AppImage x64.

The release job refuses to generate `lithium-update.json` unless all four update
packages exist. Manifest shape:

```json
{
  "schemaVersion": 1,
  "version": "0.3.11",
  "assets": [{ "platform": "darwin", "arch": "arm64", "name": "Lithium-0.3.11-mac-arm64.zip", "size": 123, "sha256": "64 lowercase hex characters" }]
}
```

Metadata/assets are resolved by main from the fixed repository. IPC never accepts
an arbitrary executable URL or destination path. HTTPS redirects are allowlisted
and limited to five hops, with socket timeouts and size limits. An update must
match the exact current process architecture. Size and SHA-256 are checked after
download and again before install. These checks establish integrity against the
GitHub manifest; they are **not** an independent publisher signature. Trust remains
in the GitHub repository, release workflow and HTTPS connection.

Old releases without a manifest get a manual release-page fallback. Users of the
old DMG-opening updater need one manual installation of this updater-enabled build;
subsequent compatible releases can install in-app. No release is published merely
by building locally: publishing still requires the existing release/tag workflow.

## macOS installation

1. Require a packaged `.app` in a writable install directory. A mounted DMG or
   App Translocation path explains that the app must first be moved to Applications.
2. Verify the download. Check archive layout, extract with `ditto`, verify bundle ID
   `com.lithium.app`, version and executable. Copy to a unique hidden sibling `.app`
   in the install directory, so final renames stay on the same filesystem.
3. Before shutdown, freeze window input and request every renderer to flush its
   pending preferences/drafts; no acknowledgement within five seconds aborts.
   Stop native agents and flush all chats. Save SQLite with its backup API to
   `~/.synthcode/backups/before-update-<timestamp>.sqlite`. A backup/save failure
   aborts without closing Lithium.
4. Copy the shell helper outside the installed app, pass all paths as positional
   arguments, and require a readiness handshake/installation lock before exiting.
5. The detached helper waits for the old PID to exit, renames the old app to
   `.Lithium-previous-<UUID>.app`, then moves the staged app into the original path.
   If replacement fails, restore the original app. If `open -n` reports a launch
   failure, move the new app aside, restore and reopen the original.
6. Launch the new app with a one-time token. The new renderer reports healthy only
   after initialization. Without acknowledgement, record `installed-unconfirmed`
   and retain both app versions. Never automatically downgrade after the new app
   has launched: it might already have migrated the database.

App data is outside the bundle and is never moved by the helper. Previous app
copies and database backups are deliberately retained, not silently pruned. For
manual recovery after a startup failure, quit Lithium before replacing the app;
if a schema migration occurred, use the matching pre-update database backup too.
Downloaded ZIPs/staging logs are under `~/.synthcode/updates`. Downloads are not
resumed automatically after quitting; check/download again if needed.

No sudo/password prompt is implemented: an unwritable install location produces
an actionable error instead. A single-instance lock gives one process ownership of app data and updates;
additional windows still work inside that process. There is no force-kill of
unrelated app processes.

## Other platforms

Windows downloads/checks the manifest-selected installer, saves work, launches
NSIS without shell interpolation and exits. Linux currently opens the release
page for manual package installation; there is no in-place AppImage replacement.
The detailed detached swap/rollback mechanism above is macOS-specific.

## UI and IPC

State values: `idle`, `checking`, `current`, `available`, `downloading`, `ready`,
`installing`, `error`. About and the startup toast subscribe to one shared state;
listeners are registered once, so retries do not multiply progress handlers.
Normal startup checks in the background. A successful update's recovery location
is shown before a delayed check. Previous install errors remain visible until
another explicit check. Downloading does not stop work; installation does.

Invoke (no user-supplied paths/URLs): `updater:state`, `updater:check`,
`updater:download`, `updater:install`, `updater:get-version`, `updater:open-release`.
`updater:state` events broadcast to every window. `updater:flush` carries a token;
only the matching sender's `updater:flushed` acknowledgement is accepted.
`updater:resume` unlocks windows when preparation fails. `updater:healthy` confirms
new-version startup against the persisted install token.

## Verification

Automated tests cover version/architecture selection, trusted URLs, legacy
fallback, checksum/size failures and partial cleanup, manifest generation, bundle
validation, literal shell paths, parent-exit ordering, replacement/launch rollback,
shared UI state and persistence-before-shutdown (including a disk error). Packaging
and actual ZIP extraction/staging are checked against the built app. A temporary
native fixture also verifies replacement and launch through macOS LaunchServices.
Use `original-fs` to remove temporary bundle directories: Electron otherwise
treats their `app.asar` as a virtual directory. A published
old-to-new GitHub upgrade still needs two compatible published releases.

## Change log

- **2026-09-22** — Fixed release manifest generation for Linux: electron-builder
  expands AppImage `${arch}` to `x86_64`, while updater platform metadata remains
  `x64`. The regression fixture uses the installed builder's architecture naming;
  missing-artifact errors list the expected name and available files.
- **2026-09-22** — Replaced DMG-opening macOS updates with a verified ZIP download,
  detached replacement helper and explicit restart action. Added draft/chat flush,
  SQLite backup, rollback on swap/open failure, dual-architecture CI and manifests.
- **2026-07-08** — Initial manual installer-download implementation.
