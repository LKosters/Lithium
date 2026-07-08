# Split-pane layout & tabs

> The tiling split-pane workspace and per-pane tab bars that host terminal/chat
> sessions, plus how that arrangement persists and restores across relaunch.

## Overview

The terminal area is a **tiling layout** built from a binary tree. Each **leaf**
is a pane that owns an ordered list of **tabs** (session IDs) and one active tab.
Each **split** node divides its space between exactly two children, either
`horizontal` (side-by-side) or `vertical` (stacked), at an adjustable ratio.

Users can:

- Split off a new session left/right (`Cmd+D`) or top/bottom (`Cmd+Shift+D`).
- Drag a tab onto another pane's drop zones to move it (center) or spawn a new
  split (left/right/top/bottom).
- Resize splits by dragging the handle between children.
- Reorder/close tabs, close a pane, or close everything via the tab context menu.

The whole tree is serialized to `localStorage` **and** to disk on every layout
change, so the exact arrangement of panes and tabs is restored on next launch.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/state.js` | The layout tree data model + tree utilities (`findLeafById`, `cleanupEmptyLeaves`, `getAllLeaves`, …) and `state.layout` / `state.focusedPaneId` |
| `src/renderer/layout.js` | Renders the tree to DOM, split-handle resize, drag/drop between panes, tab context menu, tab rename, persistence (`saveLayoutState`/`getSavedLayout`) |
| `src/renderer/tabs.js` | `openTab`/`closeTab`, `newSession`, `splitNewSession` |
| `src/renderer.js` | Wires shortcuts, restores saved layout on boot (lines ~209-247) |
| `src/main/config.js` | `saveLayoutToDisk`/`loadLayoutFromDisk` — writes `~/.synthcode/layout.json` |
| `main.js` | Registers the `layout:save` / `layout:load` IPC handlers (lines 101-102) |
| `src/styles/layout.css` | Sidebar/panel styling (split-container & pane styles live in other CSS) |

## The layout tree model

`state.layout` (`state.js:6`) is either `null` (nothing open — the welcome screen
shows) or the **root node** of a binary tree. Two node shapes exist:

**Leaf (a pane):**
```js
{ type: 'leaf', id: 'pane-3', tabs: ['sessA', 'sessB'], activeTab: 'sessB' }
```
- `tabs` — ordered array of session IDs; tab order is array order.
- `activeTab` — the currently visible session in that pane (or `null` if empty).

**Split (a divider):**
```js
{ type: 'split', id: 'pane-5', direction: 'horizontal'|'vertical',
  ratio: 0.5, children: [node, node] }
```
- Exactly two `children`, each a leaf or another split.
- `ratio` (0.1–0.9) is the fraction of space the **first** child gets; the second
  gets `1 - ratio`.
- `direction: 'horizontal'` = children side-by-side (a vertical divider you drag
  left/right); `'vertical'` = children stacked (a horizontal divider).

Node IDs come from `genPaneId()` (`state.js:11-12`), a monotonic `pane-<n>`
counter. The counter (`_paneCounter`) is module-level and resets to 0 on each
launch, so a restored tree keeps whatever string IDs were serialized to disk while
newly generated IDs start again at `pane-1`. IDs are treated as opaque and are only
ever looked up by exact value (`findLeafById`), so their numbering is not
load-bearing.

**`state.focusedPaneId`** (`state.js:7`) tracks which leaf is "active" for new
tabs and keyboard focus. `state.activeId` (`state.js:59-66`) is a computed getter
returning the focused pane's `activeTab`. `state.openTabs` (`state.js:56-58`)
flattens every tab in the tree.

### Tree utilities (`state.js`)

| Function | Purpose |
| --- | --- |
| `getAllLeaves(node)` (`14`) | DFS list of every leaf |
| `getAllTabs(node)` (`20`) | flatMap of every leaf's `tabs` |
| `findLeafById(node, id)` (`24`) | leaf whose `id` matches |
| `findLeafBySession(node, sessionId)` (`30`) | leaf whose `tabs` contains the session |
| `findParent(root, nodeId)` (`36`) | `{ parent, index }` of a node's containing split |
| `cleanupEmptyLeaves(root)` (`44`) | prunes empty leaves and collapses single-child splits; returns the new root (or `null`) |

`cleanupEmptyLeaves` is the invariant-keeper: a leaf with `tabs.length === 0` is
removed, and a split that ends up with only one surviving child is **replaced by
that child** (the split "unwraps"). It runs after every close/move.

## How it works

### Rendering (`renderLayout` / `refreshLayout`)

`refreshLayout()` (`layout.js:328`) is the single re-render entry point, called
after every mutation. It:

1. Detaches every terminal's `paneEl` from the DOM and clears `.active`
   (`layout.js:333-336`) — terminal DOM nodes are **reparented, not recreated**, so
   xterm/chat state survives re-renders.
2. Removes all children of the terminal area except the welcome element.
3. If `state.layout` is set, hides the welcome screen and calls
   `renderLayout(state.layout, terminalArea)`; otherwise shows the welcome screen.
4. Uses a **double `requestAnimationFrame`** before calling
   `app.fitAllVisibleTerminals()` so flexbox has finished sizing before xterm's
   fit addon measures (`layout.js:354-365`), then focuses the focused pane's active
   terminal.
5. Calls `saveLayoutState()` (`layout.js:371`) to persist.

`renderLayout(node, parentEl)` (`layout.js:100`) recurses:

- **Leaf** → builds a `.pane-container` (gets `.focused` when
  `node.id === state.focusedPaneId`), a `.pane-tab-bar` with one `.pane-tab` per
  session, a `.pane-terminal` area holding the active tab's `paneEl`, and a
  `.drop-overlay` with five `.drop-zone`s (center/left/right/top/bottom).
- **Split** → builds `.split-container <direction>`, a first child wrapper with
  `flex: ratio`, a `.split-handle`, and a second child wrapper with
  `flex: 1 - ratio`, recursing into each child.

### Focus tracking

Clicking a pane's body (`mousedown`, `layout.js:246-260`) sets
`state.focusedPaneId` to that leaf and, if the pane's active session has a
different `directory`, switches the workspace via `app.setDirectory`. Clicking a
tab (`layout.js:148-157`) also sets `activeTab` + `focusedPaneId` and syncs the
workspace directory. The focused pane is where `openTab` drops new tabs.

### Opening / activating tabs (`openTab`, `tabs.js:6`)

`openTab(sessionId)`:
1. If the session is already a tab somewhere, just activates it there and focuses
   that pane (`tabs.js:8-14`) — **a session lives in at most one pane**.
2. Otherwise ensures a terminal/chat pane exists for it (spawning the PTY with
   `resume: true`, or `createChatPane` for `mode === 'chat'`).
3. Places it: if there's no layout, creates the root leaf; else appends to the
   focused leaf (falling back to the first leaf) and makes it the active tab.
4. `refreshLayout()`.

Callers of `openTab` include the session list, search bar, quick-open, and
session-create.

### Creating sessions (`newSession` / `splitNewSession`, `tabs.js:93` / `136`)

Both create a session object (`uuidv4` id, `directory: currentDir`, title from
`shortDir`), resolve the default mode (`terminal` vs `chat`, via
`agent:get-default` / `agent:get-enabled-acps`), `unshift` it into
`state.sessions`, and `persistSession`.

- `newSession` then calls `openTab(id)` (adds a tab to the focused pane).
- `splitNewSession(direction)` **splits the focused leaf in two**: it converts the
  current leaf node in-place into a `split` (`type`, `direction`, `ratio: 0.5`,
  `children: [oldCopy, newLeaf]`, deleting `tabs`/`activeTab`, assigning a fresh
  split id) and focuses the new leaf (`tabs.js:187-201`). The new session goes in
  the second child. Bound to `Cmd+D` (horizontal) and `Cmd+Shift+D` (vertical) in
  `renderer.js:129-139`.

The in-place mutation + `oldCopy = { ...currentLeaf }` pattern matters: the
original object is reused as the split node, and a shallow copy preserves the old
pane's tabs as one of the children.

### Closing tabs & panes (`closeTab`, `tabs.js:51`)

`closeTab(sessionId)`:
1. Tears down the runtime: chat panes remove the element, delete chat state, and
   send `agent:clear-history`; terminal panes send `pty:kill`, dispose the xterm
   instance, remove the element (`tabs.js:53-68`).
2. Removes the id from its leaf's `tabs`; if it was the `activeTab`, promotes the
   **last remaining tab** (`tabs.length - 1`) or `null` (`tabs.js:71-77`).
3. `state.layout = cleanupEmptyLeaves(state.layout)` — an emptied leaf disappears
   and its sibling split unwraps.
4. If `focusedPaneId` no longer resolves to a leaf, re-points it to the first
   surviving leaf, or `null` when the tree is gone (`tabs.js:81-87`).
5. `refreshLayout()`.

**Closing the last tab of the last pane** sets `state.layout = null` and
`focusedPaneId = null` → the welcome screen returns.

The tab context menu (`showTabCtxMenu`, `layout.js:28`) offers Close Tab, Close
Other Tabs (when >1), Close All Tabs in Pane, and Close All Tabs — each just loops
`app.closeTab` over the relevant ids.

### Resizing splits

The `.split-handle`'s `mousedown` (`layout.js:280-313`) starts a drag: it shows a
full-window drag overlay (so the cursor doesn't flicker over iframes/terminals),
and on each `mousemove` computes `ratio` from the pointer position relative to the
split container's bounding rect, clamps to `[0.1, 0.9]`, writes `node.ratio`,
updates both child wrappers' `flex`, and calls `fitAllVisibleTerminals()` live.
Resize does **not** call `refreshLayout`, so the new ratio is only persisted on the
next layout change (see gotchas).

### Drag & drop between panes (`handleTabDrop`, `layout.js:423`)

Dragging a `.pane-tab` (`dragstart`, `layout.js:175-180`) stores `_dragSessionId`
and reveals every pane's drop overlay. Dropping on a zone calls
`handleTabDrop(sessionId, targetPaneId, zone)`:

- **`center`** — move the tab into the target pane. Removes it from the source
  leaf (promoting a new active tab there), pushes it onto the target's `tabs`, and
  focuses the target. No-op if source === target.
- **`left`/`right`/`top`/`bottom`** — split the target pane. `left`/`right` →
  `horizontal`; `top`/`bottom` → `vertical`. The dragged session becomes a new
  leaf; the target leaf is converted in-place into a split whose children are
  ordered `[new, old]` for left/top or `[old, new]` for right/bottom
  (`layout.js:451-467`).

Afterward it runs `cleanupEmptyLeaves` and repairs `focusedPaneId` before
`refreshLayout` (`layout.js:470-476`). Because the source tab is removed first, a
split-drop can empty the source pane, which then gets pruned.

### Tab reorder & rename

- **Reorder:** tabs are `draggable` but there is **no within-bar reorder handler** —
  dragging a tab always targets a pane drop zone (move or split). Order within a
  pane is just append order.
- **Rename:** the pencil button calls `startTabRename` (`layout.js:479`), which
  swaps the title span for an input; Enter/blur commits to `s.title` +
  `persistSession`, Escape cancels.

## Persistence & restore

### Save (`saveLayoutState`, `layout.js:374`)

On every `refreshLayout`, the layout is written **twice**:

- `localStorage.setItem("layoutState", JSON.stringify(state.layout))` and
  `localStorage.setItem("focusedPaneId", …)`.
- IPC `layout:save` → main → `saveLayoutToDisk` writes
  `~/.synthcode/layout.json` (`config.js:80-86`, path at `config.js:11`) as a
  disk backup that "survives crashes".

The saved payload shape is `{ layout, focusedPaneId }`. When `state.layout` is
`null`, both stores are cleared and `layout:save` is sent `null`.

### IPC contract

| Channel | Direction | Payload |
| --- | --- | --- |
| `layout:save` | renderer → main (`ipcMain.on`) | `{ layout, focusedPaneId }` or `null` |
| `layout:load` | renderer → main (`ipcMain.handle`) | returns saved `{ layout, focusedPaneId }` or `null` |

Registered in `main.js:101-102`.

### Restore (`renderer.js:209-247`)

On boot: try `getSavedLayout()` (localStorage) first; if that has no layout, fall
back to `ipcRenderer.invoke("layout:load")` (disk). Then **reconcile against
existing sessions**:

1. For each leaf, filter `tabs` to session IDs that still exist
   (`sessions:list`); fix `activeTab` if it was pruned.
2. `cleanupEmptyLeaves` the whole tree.
3. For every surviving tab, recreate its runtime (`createChatPane` for chat, else
   `createTerminal` + `pty:spawn { resume: true }`).
4. Adopt the cleaned tree as `state.layout`; set `focusedPaneId` to the saved id if
   it still resolves, else the first leaf. If nothing survived, `clearSavedLayout()`.

This is why deleting a session's on-disk data cleanly drops its restored tab
instead of leaving a broken pane.

## Relationship: layout ↔ tabs ↔ sessions

- A **session** (`state.sessions`, persisted per file, see terminals-sessions.md)
  is the source of truth for title/directory/mode/provider. It's independent of
  layout.
- A **tab** is just a session ID living in a leaf's `tabs` array. A session is a
  tab in **at most one pane at a time** (`openTab` re-activates rather than
  duplicating).
- The **runtime** for a session (xterm terminal or chat pane, in the `terminals`
  Map) is created on demand and reparented into whichever pane currently shows it.
- Closing a tab kills its runtime; deleting a session elsewhere is reconciled out
  of the layout on next restore.

## Gotchas

- **Reparented, not recreated:** `refreshLayout` moves existing `paneEl` DOM nodes.
  Never assume a fresh render creates new terminal DOM — it reuses the `terminals`
  Map entries.
- **Ratio persistence lag:** dragging a split handle mutates `node.ratio` but does
  **not** call `refreshLayout`, so a resize alone is not persisted until the next
  layout-changing action (open/close/split/drop) triggers `saveLayoutState`. A
  relaunch immediately after only resizing may restore the pre-drag ratio.
- **Active-tab promotion is "last", not "previous":** when the active tab closes or
  moves away, the promoted tab is `tabs[tabs.length - 1]`, i.e. the last in the
  array, not the neighbor you were next to.
- **Empty leaves must be pruned:** always route close/move through
  `cleanupEmptyLeaves` and then repair `focusedPaneId`. Leaving a zero-tab leaf in
  the tree renders an empty pane and breaks the single-child-split invariant.
- **Last pane closes → `state.layout = null`:** both layout and `focusedPaneId`
  become `null` and the welcome screen shows. Code reading `state.layout` must
  null-check (most helpers already do).
- **`focusedPaneId` can dangle:** after tree surgery it may point at a removed id;
  every mutation re-resolves it to the first surviving leaf (or `null`).
- **Splits are strictly binary:** there is no N-way pane container. A three-pane row
  is a split whose one child is itself a split — nesting, not a flat list.
- **Double-rAF before fit:** terminal fit runs after two animation frames so
  flexbox sizing settles first; shortening this races xterm's measurement.
- **Two persistence stores can disagree:** localStorage is authoritative on restore
  (checked first); disk (`layout.json`) is only the fallback. If they diverge (e.g.
  a crash before localStorage wrote), the disk copy may be older or newer than
  expected.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
