# Feature docs

One markdown file per feature. Each captures what the feature does, where it lives,
how main ↔ renderer talk to each other for it, known gotchas, and a **dated change
log** of what agents (or humans) have changed.

See the root [`CLAUDE.md`](../CLAUDE.md) for the workflow: read the relevant doc
before you start, update or create one after you touch a feature or fix a bug.

## How to add a doc

1. Copy [`_TEMPLATE.md`](./_TEMPLATE.md) to `docs/<feature-name>.md`.
2. Fill it in.
3. Add a row to the index below.

## Index

Start with **[architecture.md](./architecture.md)** — it explains the main/renderer
split, the full IPC channel catalog, and where data is persisted on disk. Every
other doc assumes that context.

| Feature | Doc | Summary |
| --- | --- | --- |
| Architecture (read first) | [architecture.md](./architecture.md) | Process split, module load order, IPC catalog, `~/.synthcode` persistence |
| Terminals / sessions | [terminals-sessions.md](./terminals-sessions.md) | PTY-backed terminal sessions, xterm setup, resume, lifecycle |
| Chat / ACP agents | [chat-acp.md](./chat-acp.md) | Chat panes and the ACP agent-provider system (`agent:*` IPC) |
| Split-pane layout & tabs | [layout-tabs.md](./layout-tabs.md) | Binary-tree panes, per-pane tabs, drag/split, layout persistence |
| Built-in browser preview | [browser-preview.md](./browser-preview.md) | `<webview>` preview + MCP/TCP bridge for agent browser control |
| Dev server controls | [dev-server.md](./dev-server.md) | Start/stop `npm run dev`, URL detection, auto-open preview |
| Git integration | [git.md](./git.md) | Git sidebar, `runGit` primitive, `git:*` IPC, polling refresh |
| Projects & workspaces | [projects-directories.md](./projects-directories.md) | Scaffolding (create-next-app), workspace/directory switching |
| Settings | [settings.md](./settings.md) | Settings overlay and `config.json` store |
| Quick open & search | [quick-open-search.md](./quick-open-search.md) | Search bar (double-Shift / Cmd+P), project search, session matcher |
| Theme, focus & music | [theme-focus-music.md](./theme-focus-music.md) | Theming tokens, focus mode, lofi + system-media music player |
| Auto-update | [auto-update.md](./auto-update.md) | Custom GitHub-Releases updater, macOS quarantine handling |

<!-- Add new features above this line. -->

## Notes / known dead code

These were flagged while documenting (recorded, not changed) — verify before relying on them:

- **`~/.synthcode`** is the on-disk config/session/layout directory (historical name).
- **Focus mode** (`src/styles/focus.css`) is not imported by `main.css` nor toggled by any JS — currently dead. See [theme-focus-music.md](./theme-focus-music.md).
- **Quick-open modal** (`openQuickOpen` in `quick-open.js`) is never invoked; the active launcher is the search bar. See [quick-open-search.md](./quick-open-search.md).
- **Legacy ACP files** (`acp-server.js`, `cursor-acp-server.js`, `providers/acp.js`, `providers/cursor-acp.js`) appear superseded by the generic factory and not wired into live code. See [chat-acp.md](./chat-acp.md).
