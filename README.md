# Lithium

A desktop UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Lithium wraps Claude Code in a native desktop app with split panes, session management, a built-in browser, and dev server controls.

## Features

- **Multi-session terminals** — Run multiple Claude Code sessions side-by-side with split panes and tabs
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

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
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
