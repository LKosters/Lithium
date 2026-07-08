# CLAUDE.md

Guidance for AI agents (Claude Code) working in this repository.

## What Lithium is

Lithium is an **Electron desktop UI for Claude Code** — it wraps the Claude Code CLI
(and other ACP agent providers) in a native app with split-pane terminals, session
management, a built-in browser preview, dev-server controls, and Git integration.

- App name: **Lithium** (`package.json` → `name: "lithium"`)
- Type: Electron desktop app (macOS / Windows / Linux)
- Entry point: `main.js` (Electron main process)

## Architecture

Electron's two-process split is the most important thing to understand:

```
main.js                     Electron main process entry — creates the window,
                            wires up IPC, loads all src/main/* modules.

src/main/*.js               Main process (Node.js). Owns the OS: PTYs, child
                            processes, filesystem, Git, ACP agent servers,
                            dev server, auto-updater, config on disk.

src/renderer/*.js           Renderer process (browser context). Owns the UI:
                            terminals (xterm), tabs, layout/split panes, chat,
                            settings, browser preview, music, quick-open.

src/renderer.js             Renderer bootstrap; src/index.html is the shell.
src/styles/*.css            One stylesheet per UI area.
```

Main ↔ renderer communicate over Electron **IPC**. When a renderer feature needs
OS access, there is almost always a matching handler in `src/main/`.

## Feature → file map (starting points)

Each row has a matching deep-dive in `docs/` (see the next section).

| Feature | Renderer | Main | Doc |
| --- | --- | --- | --- |
| Terminals / sessions | `renderer/terminal.js`, `renderer/sessions.js`, `renderer/session-create.js` | `main/pty.js`, `main/agents.js` | `docs/terminals-sessions.md` |
| Split-pane layout & tabs | `renderer/layout.js`, `renderer/tabs.js` | — | `docs/layout-tabs.md` |
| Chat (ACP agents) | `renderer/chat.js` | `main/agents.js`, `main/acp-server-factory.js`, `main/provider-registry.js`, `main/providers/*` | `docs/chat-acp.md` |
| Built-in browser preview | `renderer/browser.js` | `main/browser-bridge.js`, `main/browser-mcp-server.js` | `docs/browser-preview.md` |
| Dev server controls | `renderer/dev-server.js` | `main/dev-server.js` | `docs/dev-server.md` |
| Git integration | `renderer/git.js` | `main/git.js` | `docs/git.md` |
| Projects / scaffolding | `renderer/new-project.js`, `renderer/directory.js` | `main/project.js` | `docs/projects-directories.md` |
| Quick open / search | `renderer/quick-open.js`, `renderer/search-bar.js` | — | `docs/quick-open-search.md` |
| Settings | `renderer/settings.js` | `main/config.js` | `docs/settings.md` |
| Theme / focus mode | `renderer/theme.js` | — | `docs/theme-focus-music.md` |
| Music player | `renderer/music.js` | `main/media.js` | `docs/theme-focus-music.md` |
| Auto-update | — | `main/updater.js` | `docs/auto-update.md` |

Config, sessions, and layout persist on disk under **`~/.synthcode`** (historical
name) — see `main/config.js` and `docs/architecture.md`.

## Running & building

```bash
npm install       # postinstall patches the Electron app name
npm start         # launch the app (npx electron .)
npm run build     # build macOS DMG (build:win / build:linux / build:all)
```

Native modules (`node-pty`) must be built on the target platform — cross-platform
releases go through the GitHub Actions workflow (push a `vX.Y.Z` tag).

## Docs: read and update them (IMPORTANT)

This repo keeps **per-feature documentation in `docs/`** — one markdown file per
feature — so that any agent picking up the project has the context a past agent
learned. Treat this as part of the definition of done.

`docs/README.md` is the index; start with `docs/architecture.md` for the
main/renderer split, the full IPC channel catalog, and where data is persisted.
The per-feature docs map 1:1 to the feature table above.

**Before** working on a feature or bug:
1. Check `docs/` for a matching feature file (see `docs/README.md` for the index).
2. Read it — it captures gotchas, IPC contracts, and past decisions.

**After** you touch a feature or fix a bug:
1. If a doc for that feature exists, **add a dated entry to its Change Log**
   describing what you changed and why.
2. If no doc exists yet, **create one** from `docs/_TEMPLATE.md` and add a link to
   it in `docs/README.md`.
3. Keep it to one file per feature (map features using the table above).

Keep doc entries short and factual: what changed, why, and anything non-obvious a
future agent must know (edge cases, IPC message names, invariants). Do not
duplicate what the code already makes obvious.

## Conventions

- Match the style of the surrounding file (naming, comments, formatting).
- Main-process modules are often side-effect IPC registrations (`require("./...")`
  in `main.js`). Follow that pattern when adding new main-process handlers.
- Renderer code is plain ES modules manipulating the DOM + xterm — no framework.
- Don't add dependencies without a clear need; the dependency list is intentionally small.
