# Local storage and backups

Lithium keeps durable app data in `~/.synthcode/lithium.sqlite`, outside the app
bundle. App updates do not replace it. `LITHIUM_DATA_DIR` isolates data and Electron
userData for testing. Never test a restore against the user's real data directory.

## Files and schema

- `src/main/database.js`: lazy singleton, SQLite schema/versioning, JSON migration.
- `src/main/config.js`: compatible config/session/layout facade. Project settings
  and editable global `instructions.md` remain files.
- `src/main/chat/store.js`: chat persistence and external image references.
- `src/main/backup.js`: versioned logical backup, validation, staged restore.
- `src/main/data.js`: native dialogs, confirmation, recovery backup and restart.
- `src/renderer/preferences.js`: SQLite-backed preferences with localStorage mirror.
- `src/renderer/data-settings.js`: Settings → Data & backups.

SQLite uses WAL, foreign keys and FULL synchronous writes. `user_version=1` is
checked before schema changes; newer versions are refused instead of downgraded.
Tables: `settings(key,value)`, indexed `sessions(id,directory,updated_at,data)`,
`chats(id,data)` headers and `messages(chat_id,position,entry_id,data)`. Message
payloads remain JSON to preserve provider-specific fields. Message/header changes
commit in one transaction. Unchanged message rows do not cause writes. Streaming
uses ChatService's 250 ms debounce and explicit turn/shutdown flushes. The current
renderer still loads an entire selected conversation; pagination/search are future work.

Images remain under `chats/images/<sessionId>/<assetId>`. Native Claude/Codex
history and credentials remain provider-owned; we preserve native resume IDs.
No app update, migration or export rewrites those provider files.

## One-time migration and update safety

At startup, before windows open, copy legacy `config.json`, `layout.json`,
`sessions/`, `chats/` and `instructions.md` to `backups/before-sqlite-<timestamp>/`.
Import config, layout, sessions and chats transactionally. Only then write the
`legacyMigrated` marker. Originals stay in place but are never re-read after the
marker, including when sessions are deleted. Invalid input aborts migration and
startup with a recoverable error; no partial data or skipped chats are accepted.

Future schema changes must increment `user_version`, back up first and migrate in
transactions. Never delete/recreate the database for a version upgrade. Do not
copy just the active `.sqlite` file while WAL is in use; use the export flow or
SQLite's backup API.

## Preferences

`preferences:bootstrap` is a synchronous, one-time startup IPC before renderer
modules load. It migrates allowed localStorage settings on the first run, then
hydrates the mirror from SQLite. Durable keys: sidebar view, player mode, browser
URL, and `lithium-chat-draft-<sessionId>`. `preferences:set` batches draft/preference
changes at 200 ms; export/import buttons flush pending changes. Layout and current
project are hydrated from their authoritative SQLite records. Live dev-server
state is not exported and is cleared after restore using a persisted restore token.
There is no live preference broadcast between windows.

## Export and restore

`data:info`, `data:export`, `data:import` invoke responses use `{ok,value}` or
`{ok:false,error}`. Native pickers choose paths. Export is a single
`.lithium-backup.json` file with `format`, `version=1`, `createdAt`, SHA-256 checksum
of `data`, and the logical snapshot. Images are base64 inside the export only.
Limits: 512 MB file, 10 MB image input (14 MB encoded cap on import). Backups are
not encrypted. A checksum detects damage, not whether a backup's author is trusted.

Imports validate version, checksum, IDs, duplicates, settings and image references
before displaying counts and a replacement confirmation. They **replace**, not
merge. Missing project folders are reported. After confirmation:

1. Block new chat turns/session edits, interrupt agents and flush chat state.
2. Save a portable `backups/before-import-<timestamp>.lithium-backup.json`. If this
   fails, stop without replacing any data.
3. Stage imported assets under fresh UUIDs; retain old assets. Replace database
   records in one transaction and persist the instructions restore job and a token.
4. Clear old runtimes, stop child processes, restart. Never flush old state after
   the commit. Startup applies the durable instructions job atomically; retrying
   after interruption is safe. Preferences bootstrap overwrites stale local caches.

On transaction failure, old records remain and new staged files are removed.
Unused old images are retained after restore to avoid deleting recovery data;
normal session deletion removes the session image directory. Instructions remain
editable at `~/.synthcode/instructions.md` after restoration.

Included: app config/defaults/preferences, drafts, layout, session metadata,
messages, image assets, global instructions. Excluded: project files and their
`.lithium/settings.json`, provider credentials/native transcripts, dev-server
process state. On another computer, history can be retained but native continuation
also requires the corresponding provider history and project directory.

## Native module development

`better-sqlite3` is built for Electron's Node ABI. `npm install` runs
`electron-rebuild -w better-sqlite3`; `npm run rebuild` rebuilds all native modules.
`npm test` uses `scripts/test.js` to run the test suite with Electron in
`ELECTRON_RUN_AS_NODE=1` mode, avoiding the host-Node ABI mismatch. Packaging must
include the native binding (electron-builder automatically unpacks it).

## Verification

Tests cover migration/restart idempotency, originals/backups, corrupt migration
rollback, newer-schema rejection, unchanged-row writes, failed message transaction,
image/settings/draft/instruction export roundtrip, checksums, path traversal,
rollback and staged-file cleanup. Existing chat permission/lifecycle/UI tests
continue to run with the SQLite store. Manual UI tests use isolated data directories.

## Change log

- **2026-09-22** — Introduced SQLite, preserved JSON migration backups, durable
  app preferences/drafts and Settings export/import with recovery backup and restart.
