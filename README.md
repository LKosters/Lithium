# Lithium

A desktop chat UI for [Claude Code](https://code.claude.com/docs) and [Codex](https://developers.openai.com/codex).

Lithium connects to your installed agents with streaming chat, native session permissions,
model selection, tool approvals, split panes, a built-in browser, and dev server controls.
Existing terminal sessions remain available. See [chat setup and architecture](docs/chat.md).

## Features

- **Agent chats** — Claude and Codex side-by-side, with streaming Markdown, code blocks, images and tool activity
- **Native permissions** — Per-session modes, including Auto and Full access, with in-chat approvals
- **Split panes and tabs** — Keep multiple chats and existing terminal sessions open
- **Session persistence** — Sessions and layout restore automatically on relaunch
- **Built-in browser** — Preview your app with responsive viewport presets (mobile, tablet, desktop)
- **Dev server controls** — Start/stop your dev server with one click, auto-opens the browser preview
- **Project scaffolding** — Create new Next.js projects directly from the app
- **Git integration** — View branch, status, and changes at a glance
- **Focus mode** — Distraction-free interface for deep work
- **Ambient music** — Built-in background music player
- **Quick open** — Fast workspace and directory switching
- **Themes** — Dark UI designed for long coding sessions

## Requirements

- Install the official CLI for each provider you want to use: [Claude Code](https://code.claude.com/docs) and/or [Codex](https://developers.openai.com/codex)
- Sign in with `claude auth login` and/or `codex login` using an eligible subscription
- Node.js 18+

## Development

```bash
npm install
npm start
```

## Building

```bash
# macOS
npm run build

# Windows
npm run build:win

# Linux (AppImage)
npm run build:linux

# All platforms
npm run build:all
```

Cross-platform builds with native modules (like `node-pty`) need to be built on the target platform. The GitHub Actions workflow handles this automatically — push a version tag to create a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## macOS: "Lithium.app is damaged" on install or update

The macOS builds are ad‑hoc signed but not notarized (no paid Apple Developer account). When you download the DMG in a browser, Gatekeeper applies a quarantine attribute and may block the app with either "unidentified developer" or "Lithium.app is damaged and can't be opened".

After dragging `Lithium.app` into `/Applications`, run once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Lithium.app
```

Then open the app normally. Alternatively, right‑click `Lithium.app` → **Open** and confirm the prompt.

The in‑app updater strips this attribute automatically, so updates triggered from inside the app don't need the manual step.

## License

MIT

### Data and backups

Chats, sessions and app preferences are stored in `~/.synthcode/lithium.sqlite`,
outside the application, so normal updates preserve them. Existing JSON data is
backed up and migrated automatically on first launch. Use **Settings → Data & backups**
to export or restore a portable backup, including chat images and drafts. Restoring
replaces app data after confirmation, creates a recovery backup and restarts Lithium.
Project files and native provider credentials/history are separate. See
[storage documentation](docs/storage.md).

### In-app updates

On macOS, new releases can be downloaded and installed with **Restart and install**
without dragging another DMG into Applications. The updater verifies the download,
saves chats/drafts, backs up SQLite and retains the previous app. This uses no paid
Apple signing account; macOS can still show its own security prompts. Existing
versions using the old updater need one manual installation of an updater-enabled
build. See [update documentation](docs/auto-update.md).
