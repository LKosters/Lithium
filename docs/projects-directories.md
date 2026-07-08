# Projects & directories

> Scaffolding new projects, and picking/switching/starring the workspace directory
> that scopes everything else (sessions, git, dev server, search).

## Overview

Lithium is organized around a single active **workspace directory** (`state.currentDir`).
Almost every other feature is scoped to it: terminal sessions only show when their
`directory` matches the active workspace, git status refreshes on switch, the dev
server button re-checks availability, and the search bar re-scopes.

There are two entry points for getting a workspace:

1. **New Project** — scaffold a fresh project (Next.js or Node.js) into a "projects
   directory", then auto-switch to it (`src/renderer/new-project.js`,
   `src/main/project.js`).
2. **Directory picker / workspaces list** — pick any existing folder, or switch
   between recent/starred/session-derived workspaces in the sidebar
   (`src/renderer/directory.js`).

Recent and starred directories persist to disk; the active directory persists to
both `config.json` and `localStorage`.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/new-project.js` | New Project modal: framework pick, validation, kicks off `project:create`, progress UI |
| `src/main/project.js` | `project:create` IPC handler — actually scaffolds the project on disk |
| `src/renderer/directory.js` | Workspaces sidebar list, recent/favorites dropdown, star/remove, framework-icon rendering, `setDirectory` (the switch fn) |
| `main.js` (lines ~104–236) | Directory + config + framework-detection IPC handlers, `dialog.showOpenDialog` |
| `src/main/config.js` | `recentDirs`/`starredDirs`/`projectsDir` persistence in `~/.synthcode/config.json`; `DEFAULT_PROJECTS_DIR` |
| `src/renderer/helpers.js` | `shortDir` (home → `~`), `dirName` (basename) |
| `src/index.html` (lines ~784–856) | New Project modal + confirm-remove modal markup; framework `.np-fw-card` buttons |
| `src/assets/framework-icons/*.svg` | Devicon/simple-icons SVGs cached at startup for the workspace list |

## New project scaffolding

### Supported frameworks

Only **two** framework cards exist in the modal (`src/index.html:800`, `:812`), and
`project:create` only accepts these two (`src/main/project.js:18–43`):

| `data-framework` | Card label | How it scaffolds |
| --- | --- | --- |
| `nextjs` | Next.js | Runs `npx create-next-app@latest <name> --yes` |
| `nodejs` | Node.js | Writes files directly (no subprocess) |

Any other value returns `{ ok: false, error: "Unknown framework: <framework>" }`
(`src/main/project.js:42`). Note the workspace-list icon set (`ICON_FILES` in
`directory.js:11`) covers ~22 frameworks — but that is only for *detecting/displaying*
existing projects, not for scaffolding.

### The flow (renderer → main → renderer)

`openNewProject()` (`new-project.js:19`) is bound to `#btn-new-project`
(`new-project.js:128`). On open it:

1. Resolves the projects directory via `config:resolve-projects-dir`
   (`new-project.js:20`) and shows it (`shortDir`, muted if unset).
2. Resets framework selection, name input, error, and swaps the modal back to the
   form state (hides `#np-progress`).

Clicking **Create** (`#np-create`, `new-project.js:77`) validates in the renderer
before any IPC:

- A framework must be selected (`_npFramework` set by clicking a `.np-fw-card`).
- Name must be non-empty.
- Name must match `^[a-zA-Z0-9_-]+$` (letters, numbers, dash, underscore only)
  (`new-project.js:91`). The main process **re-validates** this exact regex
  (`project.js:9`) — never trust the renderer alone.
- If no projects dir is set yet, it lazily creates the default one via
  `config:create-default-projects-dir` (`new-project.js:97`).

Then it swaps to the progress state (spinner + "Creating project...", the
`#np-progress` div) and `await`s `project:create` (`new-project.js:105`).

### What `project:create` actually does (`src/main/project.js`)

Payload: `{ framework, name, projectsDir }`.

1. Re-validate `name` against `^[a-zA-Z0-9_-]+$` → error if invalid.
2. `targetDir = path.join(projectsDir, name)`. If it already exists →
   `{ ok:false, error: 'Directory "<name>" already exists in projects folder.' }`.
3. **Next.js** — `spawn("npx", ["create-next-app@latest", name, "--yes"])` with
   `cwd: projectsDir`, `shell: true`, inheriting `process.env`, stdout ignored /
   stderr piped. On `close`:
   - `code === 0` **and** `targetDir` exists → `addRecentDir(targetDir)`, return
     `{ ok:true, dir: targetDir }`.
   - Otherwise it filters `npm warn ...` lines out of stderr and returns the
     remaining meaningful text (or `Process exited with code <code>`) as the error.
   - A spawn `error` event resolves `{ ok:false, error: err.message }`.
4. **Node.js** — synchronous, no subprocess. `fs.mkdirSync(targetDir, {recursive})`,
   then writes:
   - `package.json` with `scripts: { start: "node index.js", dev: "node --watch index.js" }`
   - `index.js` → `console.log("Hello from <name>!");`
   - `.gitignore` → `node_modules/`

   Then `addRecentDir(targetDir)` and returns `{ ok:true, dir: targetDir }`.

### On success (back in renderer, `new-project.js:111`)

- Ensures the new dir is in `state.recentDirs` (unshift if missing).
- `app.setDirectory(result.dir)` — switches the active workspace to the new project.
- `app.newSession()` — opens a fresh Claude Code session in it.
- Closes the modal and **unhides `#btn-dev-server`** (`new-project.js:119`).

On failure it swaps back from progress to the form and shows `result.error` in
`#np-error`.

### Progress reporting caveat

The "progress" is only a **spinner + static text** (`#np-progress`). There is **no
streaming of `create-next-app` output** — stdout is `"ignore"`d
(`project.js:50`) and nothing is sent back until the process closes. A Next.js
scaffold (npx download + install) can take a while with zero incremental feedback.

## Where projects live — the projects directory

Distinct from the *active workspace*. The projects directory is the parent folder new
projects are scaffolded into. Resolution order (`config:resolve-projects-dir`,
`main.js:219`):

1. `config.projectsDir` if set.
2. Else if `DEFAULT_PROJECTS_DIR` (= `~/lithium-projects`, `config.js:12`) already
   exists on disk → adopt and persist it.
3. Else return `null` (UI shows "Not set", muted).

`config:create-default-projects-dir` (`main.js:230`) `mkdir -p`s `~/lithium-projects`
and persists it as `projectsDir`. Changing it from the modal (`#np-dir-change`,
`new-project.js:61`) opens `directory:pick`, then `config:set { key:"projectsDir" }`,
and refreshes `state.recentDirs`/`state.starredDirs` from the pick result.

## Directory / workspace management

### Switching the active workspace — `setDirectory(dir)` (`directory.js:69`)

The single choke point for changing workspace. It:

- Sets `state.currentDir` and the `#current-dir-label` text (`shortDir`).
- Persists to `localStorage.currentDir` **and** `config:set { key:"currentDir" }`.
- Sends `directory:add-recent` (bumps it to the front of `recentDirs` on disk).
- Fires side-effects if present: `app.refreshGit()`, `app.checkDevServerAvailable()`,
  `app.updateSearchBarWorkspace()`.
- Re-renders the projects list (to move the `active` highlight) and the session list
  (sessions are filtered by workspace).

### Picking a new folder — `pickDirectory()` (`directory.js:59`)

Bound to `#btn-open-finder` (`directory.js:275`). Invokes `directory:pick` →
`dialog.showOpenDialog({ properties: ["openDirectory"] })` (`main.js:105`). On a
non-cancelled pick: `setDirectory`, then refreshes `state.recentDirs` /
`state.starredDirs` from the returned payload and re-renders.

### The workspaces list — `renderProjectsList()` (`directory.js:95`)

Renders `#projects-list`. Builds a **deduped** ordered set of directories:

1. Starred dirs first (`state.starredDirs`).
2. Then recent dirs (`state.recentDirs`).
3. Then any `directory` referenced by an existing session but not already listed
   (`directory.js:103`) — so a workspace with sessions never disappears from the list.

Filtered live by `#projects-search` (matches basename or full path,
`directory.js:130`). For each dir it shows a framework icon (see below), the
basename, a session-count badge (`state.sessions` where `s.directory === dir`), and a
trash button. Clicking the row (but not the trash) → `setDirectory`. Empty →
"No workspaces yet".

### Recent / favorites dropdown — `renderRecentDirs()` (`directory.js:189`)

Bound to `#btn-pick-dir` (toggles `#recent-dirs-dropdown`, `directory.js:263`). Two
tabs (`#dropdown-tabs`): **favorites** and **recent**. If there are no starred dirs
the tab bar hides and it forces the `recent` tab. Favorites tab = recents that are
starred; recent tab = recents that are **not** starred. Each item has a star toggle
and, on click, switches workspace and animates the dropdown closed.

### Framework icons (`directory.js:7–37`)

At module load, all SVGs in `ICON_FILES` are read from
`src/assets/framework-icons/`, stripped of their `width`/`height` attrs and forced to
14×14, and cached in `iconCache` (with a `vue`↔`vuejs` alias fallback). `vue`/`vuejs`
are aliased to each other. `getProjectIcon(framework)` returns the cached SVG or a
generic folder icon. The framework for each dir comes from `project:detect-framework`
(cached per-dir in the module-level `frameworkCache` Map, `directory.js:39`,
populated lazily by `detectFrameworks`, `directory.js:83`).

### Framework detection — `project:detect-framework` (`main.js:139–184`)

Given a dir, inspects (in order): `package.json` deps (next → nuxt → tanstack →
sveltekit → remix → gatsby → astro → svelte → angular → vue → react → typescript →
javascript), then `composer.json` (symfony/laravel/php), then marker files
(`tsconfig.json`→typescript, `Cargo.toml`→rust, `go.mod`→go,
`pyproject.toml`/`requirements.txt`/`setup.py`→python, `Gemfile`→ruby). Returns
`null` if nothing matches. This is display-only.

### Starring — `directory:toggle-star` (`main.js:186`)

The renderer optimistically mutates `state.starredDirs` then sends
`directory:toggle-star` (`directory.js:246`). Main toggles the dir in
`config.starredDirs` and `saveConfig`s.

### Removing a workspace

Trash button → `showRemoveConfirm` → the `#confirm-remove-modal`. Confirming calls
`removeWorkspace(dir)` (`directory.js:303`), which filters the dir out of
`state.recentDirs` / `state.starredDirs`, deletes it from `frameworkCache`, sends
`directory:remove`, and — if it was the active workspace — clears `currentDir` in
state, label, `localStorage`, and `config:set { currentDir: null }`.

> **Removal is not persisted to `recentDirs` on disk.** There is **no
> `directory:remove` handler in main** — the `send` at `directory.js:307` is a no-op.
> The dir vanishes from the in-memory list but `config.json`'s `recentDirs` still
> contains it, so it can reappear after relaunch (or the next `addRecentDir`). Removal
> also never touches files on disk — it only forgets the workspace.

## Persistence & startup

- Config lives at `~/.synthcode/config.json` (note the `.synthcode` dir name, not
  `.lithium`), cached in memory (`config.js:8–34`). Relevant keys: `recentDirs`,
  `starredDirs`, `projectsDir`, `currentDir`.
- `addRecentDir` (`config.js:40`) prepends the dir, dedupes, and caps at
  `MAX_RECENT_DIRS = 10`.
- On startup `init()` (`src/renderer.js:200`) loads `directory:recents`
  (`{ recents, starred }`), renders the dropdown, then restores the last workspace
  from `config:get "currentDir"` (falling back to `localStorage.currentDir`) and calls
  `setDirectory`.

## How this ties into sessions

- A session carries a `directory` field. The session list and terminal rendering
  filter to `s.directory === state.currentDir`, so **switching workspace changes which
  sessions you see** (see `terminals-sessions.md`).
- `setDirectory` calls `app.renderSessionList()` on every switch.
- New Project calls `app.newSession()` immediately after switching, so the scaffolded
  project opens with a live Claude Code session in it.
- A workspace with any session is always shown in the list even if not recent/starred
  (`directory.js:103`), so you can never "lose" a directory that has work in it.

## Full IPC contract

### `invoke`/`handle` (renderer awaits a return value)

| Channel | Payload → Return | Where |
| --- | --- | --- |
| `project:create` | `{ framework, name, projectsDir }` → `{ ok:true, dir }` \| `{ ok:false, error }` | `project.js:8` |
| `project:detect-framework` | `dir` (string) → framework name string \| `null` | `main.js:178` |
| `directory:pick` | *(none)* → `{ dir, recents, starred }` \| `null` (cancelled) | `main.js:105` |
| `directory:recents` | *(none)* → `{ recents, starred }` | `main.js:131` |
| `config:get` | `key` (string) → value \| `null` | `main.js:211` |
| `config:resolve-projects-dir` | *(none)* → projectsDir string \| `null` | `main.js:219` |
| `config:create-default-projects-dir` | *(none)* → `~/lithium-projects` (created) | `main.js:230` |

### `send`/`on` (fire-and-forget, no return)

| Channel | Payload | Effect | Where |
| --- | --- | --- | --- |
| `config:set` | `{ key, value }` | Sets & persists one config key | `main.js:213` |
| `directory:add-recent` | `dir` (string) | `addRecentDir(dir)` | `main.js:136` |
| `directory:toggle-star` | `dir` (string) | Toggle in `config.starredDirs` | `main.js:186` |
| `directory:remove` | `dir` (string) | **No handler — no-op** | (sent at `directory.js:307`) |

## Gotchas & invariants

- **`directory:remove` has no main handler** — removal is in-memory only; the dir
  persists in `config.json` and can reappear. If you need durable removal, add the
  handler.
- **Two-tier "directory" concept:** the *projects directory* (parent for scaffolding,
  `config.projectsDir`) vs the *active workspace* (`config.currentDir` /
  `state.currentDir`). Don't conflate them — the modal's "Projects directory" row
  edits the former, the sidebar edits the latter.
- **Name regex is enforced twice** (`new-project.js:91` and `project.js:9`) — keep
  them in sync; the main-side check is the real guard.
- **`targetDir` existence check blocks scaffolding**, but for Node.js the dir is
  created by `mkdirSync` after the check; a concurrent create could race (no lock).
- **No scaffold progress streaming** — `create-next-app` stdout is discarded; the UI
  is a static spinner until the process closes.
- **Config dir is `~/.synthcode`, `projectsDir` default is `~/lithium-projects`** — a
  naming legacy; don't assume they share a name.
- **`setDirectory` is the only correct way to switch** — it wires up git/dev-server/
  search/session-list side-effects and dual persistence. Bypassing it desyncs the UI.
- **Framework-icon list ≠ scaffoldable frameworks.** `ICON_FILES` (~22 frameworks) and
  `detectFramework` support many stacks for *display*, but only `nextjs`/`nodejs` can
  be *created*.
- **`frameworkCache` is a module-level `Map`, never invalidated except on remove** — a
  dir's detected framework is cached for the app lifetime; changing a project's deps
  won't update its icon until relaunch.
- **`config.json` writes are last-write-wins on a cached object** (`config.js:31`) —
  every `config:set`/star/recent mutates the same in-memory cache then serializes it,
  so there is no external-edit reconciliation.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created (documenting existing behavior; no code change).
