# Git integration

> A right-hand sidebar that shows the current repo's branch, staged/unstaged
> changes, and recent commits, and lets the user stage, commit, push/pull/fetch,
> switch/create branches, and `git init` a folder — all by shelling out to the
> system `git` binary.

## Overview

The Git panel is a slide-in sidebar (`#git-sidebar`) toggled from the toolbar
Git button (`#btn-git`). It is scoped to the **current workspace directory**
(`app.state.currentDir`) — everything it shows and every command it runs uses
that directory as `cwd`.

While open it displays, for the active workspace:

- **Repo header** — repo name (basename of the repo top-level) and a clickable
  remote URL that opens the project's web page in the OS browser.
- **Branch bar** — the current branch name plus an ahead/behind indicator
  (`2↑ 1↓`); clicking it opens a searchable branch dropdown for
  checkout/create.
- **Staged** and **Changes** sections — lists of files with a one-letter status
  badge. Click a change to stage it, click a staged file to unstage it, or use
  the inline `+` (stage) / `✕` (discard) icons.
- **Commit input** — type a message and press Enter (or the commit button).
- **Action bars** — Stage-all, plus sync actions Push / Pull / Fetch.
- **Recent commits** — last 10 commits (message, short hash, relative time).

If the workspace is **not a git repo**, the panel instead shows a "No git
repository" empty state with an **Initialize Repository** button and an optional
"add remote" input.

There is **no diff viewer** — the panel shows *which* files changed and their
status letters, but never the line-level diff of a file.

## Key files

| File | Responsibility |
| --- | --- |
| `src/main/git.js` | Registers all `git:*` IPC handlers; runs `git` via `execFile` and parses output |
| `src/renderer/git.js` | Sidebar open/close, polling, rendering, and all user actions |
| `src/styles/git.css` | Sidebar layout, status colors, dropdown, empty state |
| `src/index.html` | Static markup for the sidebar (`#git-sidebar`, lists, inputs, empty state) |
| `main.js` | `require("./src/main/git")` at startup registers the handlers (side-effect module) |

## How it works

### Main process: running git

`src/main/git.js:7` defines the single primitive `runGit(args, cwd)`:

```js
execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
  if (err) resolve(null);
  else resolve(stdout.trim());
});
```

- Uses `child_process.execFile` (not `exec`) — args are passed as an array, so
  **no shell is involved** and filenames/messages are not shell-interpolated.
- `GIT_TIMEOUT_MS = 5000` (`git.js:5`) — any command that runs longer than 5s is
  killed and resolves `null`.
- The promise **never rejects**: on any error (non-zero exit, timeout, git not
  installed) it resolves `null`. Callers treat `null` as "failed / not a repo".
  Only `stdout` is captured; `stderr` is discarded.

Simple mutating commands are registered through the `registerGitCommand(channel,
argsBuilder)` factory (`git.js:17`), which runs the built args and returns a
**boolean** (`res !== null`) indicating success:

| Channel | git command | Payload |
| --- | --- | --- |
| `git:stage-all` | `git add -A` | `{ cwd }` |
| `git:stage-file` | `git add -- <file>` | `{ cwd, file }` |
| `git:unstage-file` | `git reset HEAD -- <file>` | `{ cwd, file }` |
| `git:commit` | `git commit -m <message>` | `{ cwd, message }` |
| `git:push` | `git push` | `{ cwd }` |
| `git:pull` | `git pull` | `{ cwd }` |
| `git:fetch` | `git fetch` | `{ cwd }` |
| `git:discard-file` | `git checkout -- <file>` | `{ cwd, file }` |
| `git:init` | `git init` | `{ cwd }` |
| `git:add-remote` | `git remote add origin <url>` | `{ cwd, url }` |
| `git:checkout` | `git checkout <branch>` | `{ cwd, branch }` |
| `git:create-branch` | `git checkout -b <branch>` | `{ cwd, branch }` |

All of the above **return `boolean`** (`true` = git exited 0). The `--` before
`<file>` in stage/unstage/discard is a pathspec separator that prevents a
filename from being interpreted as a flag.

### `git:status` — the main read (`git.js:43`)

This is the workhorse the renderer polls. It runs several git commands in
sequence and returns an aggregate object (or `null` if not a repo):

1. `git rev-parse --abbrev-ref HEAD` → current branch. **If this is `null`, the
   handler returns `null` immediately** (the directory is not a git repo, or git
   is unavailable). This is the sole "is this a repo?" gate.
2. `git status --porcelain` → parsed into `staged[]` and `changes[]` (see
   parsing below).
3. `git log --oneline --format=%h||%s||%cr||%an -10` → last 10 commits, split on
   the `||` delimiter into `{ hash, msg, time, author }`.
4. `git rev-parse --show-toplevel` → repo root; `repoName` = its basename.
5. `git remote get-url origin` → `remoteUrl` (may be `null` if no origin).
6. Ahead/behind: `git rev-parse --abbrev-ref --symbolic-full-name @{u}` to find
   the upstream tracking branch; if present,
   `git rev-list --left-right --count <tracking>...HEAD` yields
   `behind<TAB>ahead`. Parsed as `behind = parts[0]`, `ahead = parts[1]`
   (`git.js:88-96`).

**Return shape:**

```js
{
  branch:    "main",                 // string
  staged:    [{ file, status }],     // status = X column letter
  changes:   [{ file, status }],     // status = Y column letter, or "?" / "U"
  log:       [{ hash, msg, time, author }],
  repoName:  "Lithium" | null,
  remoteUrl: "git@github.com:..." | null,
  ahead:     0,                      // commits HEAD is ahead of upstream
  behind:    0,                      // commits HEAD is behind upstream
}
```

### Porcelain parsing (`git.js:51-69`)

`git status --porcelain` emits `XY<space><path>` lines where `X` is the staged
(index) status and `Y` is the worktree status. The parser:

- Skips lines shorter than 4 chars and empty filenames.
- Detects **unmerged/conflict** states: either column is `U`, or `DD`, or `AA`
  (`git.js:60`). These are excluded from `staged`.
- **Staged** (`git.js:62`): pushed when not unmerged and `X` is neither space
  nor `?` — i.e. there is a real index-side change. `status` = the `X` letter.
- **Changes** (`git.js:65`): pushed when `Y` is not a space, **or** `X === "?"`
  (untracked). `status` = `?` for untracked, `U` for unmerged, else the `Y`
  letter.

Note a file with both staged and unstaged changes (e.g. `MM`) appears in **both**
lists. Renames are not fully parsed — the `oldname -> newname` porcelain form is
taken as-is via `substring(3)`, so the arrow ends up in the displayed filename.

### Renderer: rendering (`renderer/git.js:60`)

`renderGitData(data)` writes the aggregate into the DOM:

- `data === null` → show `#git-no-repo` empty state, hide the scrollable content,
  actions, sync bar, commit input, and sync status; reset counts to `0`.
- Otherwise → fill repo header, branch name, ahead/behind (`↑`/`↓`, hidden when
  both are 0), staged/changes counts and lists, and the commit log.
- **Status letters → badge** via `STATUS_MAP` (`renderer/git.js:10`):
  `M`→modified, `A`/`?`→added/untracked (green), `D`→deleted (red),
  `R`→renamed (blue), `U`→conflict (rendered as `!`). Untracked `?` shows the
  label `U`.
- Long paths are shortened to `.../<parent>/<file>` for display (`shortPath`,
  `renderer/git.js:23`); the full path is the `title` tooltip.
- All interpolated values pass through `escapeHtml` — filenames, commit
  messages, branch names, hashes are HTML-escaped before entering `innerHTML`.
- Remote URL: `cleanUrl` strips `.git`/scheme for display; `gitUrlToWeb`
  converts an `scp`-style `git@host:path` SSH URL into `https://host/path` and
  opens it with `require("electron").shell.openExternal` on click
  (`renderer/git.js:33-42`, `106-109`).

### User actions → IPC (renderer/git.js)

- **Stage all** button → `git:stage-all` (`stageAll`, line 178).
- **Stage a change**: click the filename or `+` icon → `git:stage-file`
  (delegated on `#git-changes-list`, line 369).
- **Discard a change**: click the `✕` icon → `git:discard-file` (line 371).
  Untracked files (`?`) get **no** discard icon (line 156).
- **Unstage**: click a staged item → `git:unstage-file` (delegated on
  `#git-staged-list`, line 360).
- **Commit**: Enter in `#git-commit-input` or the commit button → `git:commit`;
  empty message just refocuses and no-ops (`commitChanges`, line 185).
- **Push / Pull / Fetch** buttons → `git:push` / `git:pull` / `git:fetch`.
- **Branches** (`toggleBranches`, line 264): clicking the branch bar invokes
  `git:branches` and opens the dropdown. `git:branches` runs
  `git branch -a --format=%(refname:short)||%(HEAD)` and returns
  `[{ name, current }]` (`git.js:101`). Typing filters the cached list;
  clicking a non-current branch → `git:checkout`. Pressing Enter checks out an
  exact match, otherwise **creates** a new branch via `git:create-branch`
  (`git checkout -b`) (lines 288-306). A "create <name>" hint shows when the
  query has no exact match.
- **Init flow**: on the no-repo empty state, `#btn-git-init` → `git:init`, then
  reveals the remote-setup input; `#btn-git-add-remote` → `git:add-remote`
  (lines 413-433).

Every action awaits its IPC call and then calls `refreshGit()` — the UI updates
from the next `git:status` read, not from the action's return value (the boolean
result is ignored; there is no success/failure toast).

### When the renderer refreshes

Refresh is **debounced** and **polled**:

- `scheduleRefresh()` (line 48) coalesces bursts: it sets `refreshPending` and a
  100 ms timer; overlapping calls within the window collapse into one
  `doRefreshGit()`. This guards against races when several actions fire quickly.
- `doRefreshGit()` (line 314): if no `currentDir`, renders the empty state;
  otherwise invokes `git:status` and renders the result.
- **Opening** the panel (`openGit`, line 335) triggers an immediate
  `scheduleRefresh()` and starts a **3-second poll** (`setInterval(scheduleRefresh,
  3000)`).
- `refreshGit()` (line 324, the exported one) resets the poll interval (so a
  manual refresh re-centers the 3s clock) and schedules a refresh. It is exported
  and also called externally: **`setDirectory` in `renderer/directory.js:75`
  calls `app.refreshGit()` whenever the workspace changes**, so switching
  projects re-reads git state even while the panel is open.
- **Closing** (`closeGit`, line 343) clears the poll interval and pending
  timeout, so no git commands run while the sidebar is hidden.

### IPC transport

`app.ipcRenderer` is Electron's raw `ipcRenderer` (the app runs with
`nodeIntegration: true`, `contextIsolation: false`, per `main.js`), so renderer
code calls `app.ipcRenderer.invoke("git:...", payload)` directly against the
`ipcMain.handle` handlers. All git channels are **invoke/handle** (request →
response); none are one-way sends and none push events back to the renderer.

## Gotchas

- **Not-a-repo detection is entirely `git rev-parse --abbrev-ref HEAD`.** If that
  fails, `git:status` returns `null` and the whole panel collapses to the empty
  state. A brand-new repo with **no commits** has no `HEAD`, so `rev-parse` fails
  and the repo will still read as "no repository" until the first commit exists.
- **Errors are silent.** `runGit` swallows all failures into `null`/`false` and
  discards stderr. A failed push (auth prompt, no upstream), a rejected pull
  (merge conflict), or a rejected commit produces **no user-visible error** — the
  panel just re-reads state. Mutations that "did nothing" look identical to
  successes in the UI.
- **5-second timeout on every command.** A push/pull that needs network or a
  credential prompt can hang and be killed at 5s, silently. Long operations are
  not supported.
- **No interactive credential handling.** Commands run with the app's
  environment (PATH is fixed at startup by `shell-env`); anything that would open
  an interactive prompt (SSH passphrase, HTTPS username/password) will fail
  silently rather than prompt.
- **Polling only while open.** State is stale until the panel is opened; there is
  a 3s poll and the debounce means UI can lag reality by up to ~3.1s. Actions
  refresh immediately, so user-driven changes appear right away.
- **Files with both staged and unstaged changes appear in both lists.** Staging
  the change side then re-reading is the intended flow; the two lists are derived
  from the `X` and `Y` porcelain columns independently.
- **Conflicts** show a yellow `!` badge (status `U`) and are deliberately kept
  out of the `staged` list; there is no conflict-resolution UI beyond staging the
  file after resolving it on disk.
- **`--` pathspec guard** matters: stage/unstage/discard pass `-- <file>` so a
  file named like a flag can't inject options. Because `execFile` is used (no
  shell), filenames, commit messages, and remote URLs are safe from shell
  injection — but they are still HTML-escaped on render to protect the DOM.
- **Ahead/behind requires an upstream.** With no tracking branch (`@{u}` fails),
  both stay `0` and the `↑/↓` indicator hides — even if the branch is actually
  ahead of some remote.
- **`git:add-remote` hardcodes `origin`.** It always runs
  `git remote add origin <url>`; adding a differently-named remote or a second
  origin is not supported and will fail (silently) if `origin` already exists.
- **`git log` uses `||` as a field delimiter.** A commit whose subject literally
  contains `||` would mis-split into extra fields; only `hash`/`msg`/`time`/
  `author` are read so trailing junk is ignored, but the message would be
  truncated at the first `||`.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
