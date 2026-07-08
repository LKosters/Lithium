# Quick open & search bar

> Two overlays for finding and opening sessions by typing — the titlebar search
> bar (double-Shift / `Cmd+P`) and the quick-open modal. Both filter sessions and
> can spin up a new session inline.

## Overview

The app has two closely-related "type to find a session" surfaces that share one
renderer (`renderSessionList` in `src/renderer/session-create.js`):

- **Search bar** (`src/renderer/search-bar.js`) — the always-visible input in the
  titlebar. This is the one wired to keyboard shortcuts and is the primary entry
  point. Its newer "create session" form also has a **project search input** for
  filtering the list of workspaces/directories (added by the "Added input bar for
  search projects" commit).
- **Quick open** (`src/renderer/quick-open.js`) — a centered modal
  (`#quick-open`) with the same session-search + create-form pattern. In the
  current build its `openQuickOpen` is exported but **not invoked anywhere**
  (only `closeQuickOpen` / `isQuickOpenVisible` are imported in `renderer.js:54`),
  so it is effectively dormant — the code path exists but no shortcut opens it.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/search-bar.js` | Titlebar search bar: session search, create form, project search input |
| `src/renderer/quick-open.js` | Quick-open modal (dormant — no invoker) |
| `src/renderer/session-create.js` | Shared `renderSessionList` (matching + rows) and `renderDirDropdown`, `createSessionAndOpen` |
| `src/renderer.js` | Keyboard shortcuts that open the search bar; Escape handling |
| `src/renderer/directory.js` | `getProjectIcon`, `detectFrameworks`, framework cache used by the project list |

## What each surface searches over

### Session matching (shared, `session-create.js:144-150`)
Both surfaces filter `state.sessions` with a simple **case-insensitive substring**
test — not a fuzzy/scored algorithm:

```
q = query.toLowerCase().trim()
match if !q || title.includes(q) || dir.includes(q)
```

So a session matches when the query is a substring of its **title** or its
**directory path**. An empty query lists all sessions. Results always lead with a
"New Session" row (index 0). The search bar renders with `showWorkspace: true`
(each row shows its workspace basename); quick open uses `showWorkspace: false`
(shows the short dir instead).

### Project/directory search (search bar create form, `search-bar.js:97-165`)
When you open the create form, `renderSbProjectList` builds the workspace list the
same way the sidebar does: **starred dirs → recent dirs → session dirs**
(deduped), with the current workspace hoisted to the top. The
`#sb-project-search` input (`search-bar.js:272-283`) filters that list by
`dirName(dir).toLowerCase().includes(query)` — i.e. substring match on the last
path segment only. Each row shows a framework icon (`getProjectIcon` +
`detectFrameworks`) and a session count.

## Keyboard shortcuts (open the search bar)

Registered in `src/renderer.js`:

- **Double-Shift** — two `Shift` key-ups within 350 ms opens the search bar
  (`renderer.js:103-113`).
- **`Cmd/Ctrl+P`** (no Shift) — opens the search bar (`renderer.js:123-127`).
- Clicking or focusing the bar also opens it (`search-bar.js:204-210`).

Inside a surface (both use the same key model):

| Key | Action |
| --- | --- |
| `ArrowUp` / `ArrowDown` | Move selection (clamped; index 0 = "New Session" row) |
| `Enter` on index 0 | Open the inline create form |
| `Enter` on a session | Open that session's tab (search bar also switches workspace via `app.setDirectory` if the session lives elsewhere) |
| `Escape` | Close the surface (search-bar create form: `Escape` returns to the list) |

The search bar sets `_sbKeyboardNav` so the newly-selected row is scrolled into
view (`search-bar.js:196-200`). Escape is also handled globally in
`renderer.js:118-119` to close whichever surface is visible.

## Create-session flow

Selecting "New Session" opens the inline form:

- **Search bar** (`sbShowCreateForm`, `search-bar.js:60-78`): seeds the name from
  the query, loads the default provider via `agent:get-default`, renders the
  project list, and creates via `createSessionAndOpen({ name, dir, provider,
  model: null, onDone: closeSearchBar })`.
- **Quick open** (`showCreateForm` / `doCreateSession`, `quick-open.js:57-74`):
  seeds the name, uses a directory dropdown (`renderDirDropdown` with
  favorites/recent tabs) instead of an inline project list, and calls
  `createSessionAndOpen({ name, dir, onDone: closeQuickOpen })`.

If no directory is selected, both flash the picker border red rather than
creating (`search-bar.js:82-86`, `quick-open.js:68-71`).

## IPC

These surfaces are almost entirely renderer-side (they read `state.sessions`,
`state.starredDirs`, `state.recentDirs` in memory). The only IPC calls:

| Channel | Kind | Where | Purpose |
| --- | --- | --- | --- |
| `directory:pick` | invoke | `quick-open.js:189`, `search-bar` via create flow | Native folder picker; returns `{ dir, recents, starred }` and refreshes `state.recentDirs`/`state.starredDirs` |
| `agent:get-default` | invoke | `search-bar.js:71` | Preselect the provider for a new session |

Session creation itself is delegated to `createSessionAndOpen`
(`session-create.js`), which performs the session-spawn IPC.

## Gotchas

- **Matching is substring, not fuzzy.** Typing `qopn` will not match a
  `quick-open` session — only contiguous substrings of title or full directory
  path match. Project search matches only the directory basename.
- **Quick open is currently dead code from the user's perspective** — nothing
  calls `openQuickOpen`. If you wire a shortcut to it, mirror the search bar's
  Escape handling already present in `renderer.js:119`.
- **Search bar closes on outside mousedown and on blur** (`search-bar.js:286-299`).
  The blur handler is deferred 150 ms to survive titlebar drag-area clicks that
  swallow `mousedown`; shortening that delay can cause the bar to close mid-click.
- **Workspace switch on open (search bar only):** opening a session from another
  workspace calls `app.setDirectory` first, so the sidebar/context follows the
  session. Quick open does not switch directory on select.
- **Selection index is 1-based over sessions** (index 0 is always the New Session
  row); off-by-one here breaks both arrow-nav and Enter.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
