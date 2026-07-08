# Browser preview & MCP bridge

> A built-in browser panel for previewing the dev server (with mobile/tablet/desktop
> viewport presets) plus an MCP bridge that lets a coding agent drive that same
> browser — screenshot, navigate, read text, run JS, click.

## Overview

Lithium embeds a browser in a right-hand panel (`#browser-panel`). A user can type a
URL, navigate back/forward/reload, and switch between responsive/mobile/tablet/desktop
viewport widths. When the built-in dev server starts, its URL is auto-loaded into this
panel (see `renderer/dev-server.js`).

The same panel is exposed to agents as an **MCP server** named `browser`. An agent
running under one of the ACP backends can call tools like `browser_screenshot`,
`browser_navigate`, `browser_get_text`, `browser_execute_js`, and `browser_click` to
inspect and manipulate exactly what the user sees in the panel. This works through a
three-hop chain: the MCP server (a standalone stdio child process) → a TCP bridge in
the Electron main process → IPC to the renderer → the `<webview>`.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/browser.js` | Browser panel UI + the renderer-side handler for agent tool requests (`initBrowser`, `initBrowserTools`) |
| `src/index.html` | Panel markup: toolbar, viewport bar, and the `<webview>` (lines 382–489) |
| `src/main/browser-bridge.js` | TCP bridge in the main process (`startBrowserBridge`, `stopBrowserBridge`, `registerBridgeIPC`, `getBridgePort`) |
| `src/main/browser-mcp-server.js` | Standalone stdio MCP server, spawned per agent session; talks to the bridge over TCP |
| `main.js` | Starts the bridge at app-ready (lines 315–319), tears it down on window-all-closed (line 341); sets `webviewTag: true` (line 53) |
| `src/main/acp-server.js`, `acp-server-factory.js`, `cursor-acp-server.js` | Register the `browser` MCP server on `session/new` using `getBridgePort()` |
| `src/renderer/dev-server.js` | Auto-opens the panel to the dev-server URL; closes it on stop |

## The browser panel (renderer UI)

### It's an Electron `<webview>`, not BrowserView or iframe

The preview is an Electron `<webview>` tag (`src/index.html:484`, `id="browser-webview"`),
enabled by `webviewTag: true` in the window's `webPreferences` (`main.js:53`). This is
why the code can call webview-only methods like `capturePage()`, `getURL()`,
`executeJavaScript()`, `canGoBack()/goBack()`, `reload()`, and listen to
`did-navigate` / `did-finish-load` / `did-fail-load` events. The default `src` is
`https://www.google.com` (`src/index.html:486`).

### Open/close & persistence (`initBrowser`, `browser.js:5`)

- `setBrowserOpen(open)` (`browser.js:15`) toggles the `hidden` class on both
  `#browser-panel` and `#browser-resize-handle`, persists the flag to
  `localStorage["browserOpen"]` (`"1"` / `""`), and re-fits all visible terminals on
  the next animation frame (the panel steals horizontal space).
- On init (`browser.js:127`) it restores `browserOpen` + `browserUrl` from
  `localStorage`, re-pointing `browserWebview.src` and re-opening the panel if it was
  open last session.
- `app.openBrowserUrl(url)` (`browser.js:85`) — opens the panel if needed, sets the
  webview `src`, updates the URL input, and persists the URL. This is the hook the dev
  server uses.
- `app.closeBrowser()` (`browser.js:93`) — closes the panel if open. Used by the dev
  server on stop.

### URL bar & navigation (`browser.js:23`)

- Enter in `#browser-url` reads the trimmed value; **blocks** `javascript:`, `data:`,
  and `vbscript:` protocols (`browser.js:28`); prefixes `https://` if no `http(s)://`
  scheme is present (`browser.js:29`); then sets `browserWebview.src`.
- `did-navigate` and `did-navigate-in-page` (main-frame only) sync the URL input and
  persist `localStorage["browserUrl"]` (`browser.js:34`–43).
- Back/forward/reload buttons guard with `canGoBack()` / `canGoForward()` before
  calling `goBack()` / `goForward()` / `reload()` (`browser.js:45`–51).

### Viewport presets (`browser.js:54`)

Four buttons (`.browser-viewport-btn`, `data-viewport` attribute) drive
`#browser-viewport-frame` width. Names come from `viewportNames` (`browser.js:58`):

| `data-viewport` | Label | Effect on `#browser-viewport-frame` |
| --- | --- | --- |
| `responsive` | Responsive | `width: 100%`, clears `maxWidth`, removes `.constrained` |
| `375` | Mobile · 375px | `width` + `maxWidth` = `375px`, adds `.constrained` |
| `768` | Tablet · 768px | `width` + `maxWidth` = `768px`, adds `.constrained` |
| `1280` | Desktop · 1280px | `width` + `maxWidth` = `1280px`, adds `.constrained` |

This is pure CSS box sizing of the frame that wraps the webview — it constrains the
render width so a responsive layout reflows, it does not spoof a device user-agent or
touch emulation. The active button gets `.active`, and `#browser-viewport-label` shows
the label (`browser.js:68`–69).

### Panel resize (`browser.js:98`)

`#browser-resize-handle` is a col-resize drag. Width is clamped between `280px` and
`60%` of the app width (`browser.js:111`–112), computed from `appRect.right - clientX`.
During drag it uses `startDragOverlay`/`stopDragOverlay` (from `layout.js`) and re-fits
terminals on every mousemove.

## The MCP bridge (main process, `browser-bridge.js`)

### What each exported function does

- **`startBrowserBridge()`** (`browser-bridge.js:12`) — creates a `net` TCP server
  bound to `127.0.0.1` on **port 0 (OS-assigned random port)** (`browser-bridge.js:53`).
  Stores the assigned port in module-level `bridgePort` and resolves the promise with
  it. Each incoming socket is read as **line-delimited JSON** (`\n` separated); each
  line is `JSON.parse`d and passed to `handleBridgeRequest`. Called once at app-ready
  in `main.js:316`.
- **`registerBridgeIPC()`** (`browser-bridge.js:98`) — registers the single
  `ipcMain.on("browser-tool:result", …)` listener that routes renderer results back to
  the correct waiting TCP socket via `pendingRequests`. Called once in `main.js:319`.
- **`stopBrowserBridge()`** (`browser-bridge.js:107`) — closes the server, nulls
  `server`/`bridgePort`, and clears `pendingRequests`. Called on `window-all-closed`
  (`main.js:341`).
- **`getBridgePort()`** (`browser-bridge.js:117`) — returns the current `bridgePort`
  (or `null` if the bridge isn't up). The ACP servers use this to decide whether to
  register the `browser` MCP server and what port to hand it.

### Request routing (`handleBridgeRequest`, `browser-bridge.js:61`)

1. A TCP message `{ id, tool, args }` arrives from the MCP server.
2. A unique `requestId = \`bridge-${id}-${Date.now()}\`` is minted and stored in
   `pendingRequests` as `requestId -> { socket, id }` (so the reply can be routed back
   to the originating socket and its JSON-RPC-ish `id`).
3. The request is forwarded to the **first** application window
   (`BrowserWindow.getAllWindows()[0]`) via
   `win.webContents.send("browser-tool:exec", { requestId, tool, args })`
   (`browser-bridge.js:76`). If no window exists, it immediately replies with error
   `"No application window available"`.
4. A **30s timeout** (`browser-bridge.js:79`) deletes the pending entry and replies
   `"Request timed out"` if the renderer never answers.

`sendBridgeResponse` (`browser-bridge.js:87`) writes `{ id, result }` or `{ id, error }`
back to the socket as one JSON line (guards `socket.destroyed`). On socket `close`, all
pending requests for that socket are dropped (`browser-bridge.js:37`).

## The MCP server (`browser-mcp-server.js`)

### What it is and how it's launched

A **standalone Node script with zero npm dependencies** (`browser-mcp-server.js:1`),
run as a **stdio child process** and speaking **MCP JSON-RPC 2.0 over stdin/stdout**
(line-delimited). It is *not* a network server itself — the "transport" to the agent is
stdio; its only network activity is an outbound TCP connection to the bridge.

The ACP backends register it on `session/new`. Example (`acp-server.js:231`–239, mirrored
in `acp-server-factory.js:416` and `cursor-acp-server.js:221`):

```js
const bridgePort = getBridgePort();
const mcpServers = bridgePort
  ? [{
      name: "browser",
      command: "node",
      args: [path.join(__dirname, "browser-mcp-server.js")],
      env: [{ name: "BROWSER_BRIDGE_PORT", value: String(bridgePort) }],
    }]
  : [];
```

So the agent runtime spawns `node browser-mcp-server.js` with `BROWSER_BRIDGE_PORT` set
to the bridge's random port. If `getBridgePort()` is null (bridge never started), the
`browser` server is simply not registered. The server exits immediately if
`BROWSER_BRIDGE_PORT` is unset/invalid (`browser-mcp-server.js:9`).

### How it connects to the bridge

On startup it eagerly calls `connectBridge()` (`browser-mcp-server.js:219`), opening a
TCP connection to `127.0.0.1:BRIDGE_PORT`. If that fails it logs and retries lazily —
`tools/call` calls `connectBridge()` on demand if `bridge` is null/destroyed
(`browser-mcp-server.js:164`). `callBridge(tool, args)` (`browser-mcp-server.js:53`)
writes `{ id, tool, args }` (auto-incrementing `id`) as a JSON line and resolves/rejects
from the matching `{ id, result | error }` reply, with its own **30s timeout**.

### MCP protocol handling (`handleRequest`, `browser-mcp-server.js:136`)

- `initialize` → replies `protocolVersion: "2024-11-05"`, `capabilities: { tools: {} }`,
  `serverInfo: { name: "browser-mcp", version: "1.0.0" }`.
- `notifications/initialized` → no reply.
- `tools/list` → returns the static `TOOLS` array.
- `tools/call` → ensures the bridge is connected, calls `callBridge`, and wraps the
  result. If the bridge result is `{ _type: "image", data, mimeType }` it returns an MCP
  **image** content part; otherwise a **text** part (strings passed through, other values
  `JSON.stringify`ed). Errors return a text part with `isError: true`.
- Unknown method with a non-null id → JSON-RPC error `-32601`.

### Tools exposed (`TOOLS`, `browser-mcp-server.js:72`)

| Tool | Input schema | What it does |
| --- | --- | --- |
| `browser_screenshot` | none | PNG screenshot of the webview (base64 image) |
| `browser_navigate` | `url: string` (required) | Navigate the panel to a URL |
| `browser_get_url` | none | Current URL of the panel |
| `browser_get_text` | none | `document.body.innerText` of the page |
| `browser_execute_js` | `code: string` (required) | Run JS in the page, return the result |
| `browser_click` | `x: number, y: number` (required) | Click at viewport coordinates |
| `browser_is_open` | none | Whether the panel is open/visible |

## Renderer-side tool execution (`initBrowserTools`, `browser.js:138`)

The renderer listens on `ipcRenderer.on("browser-tool:exec", …)` and executes against
the live `<webview>`, then replies with `ipcRenderer.send("browser-tool:result", …)`.

- **Open-state gating**: `browser_is_open` always answers (returns the boolean)
  regardless of panel state (`browser.js:146`). Every other tool short-circuits with
  `error: "Browser panel is not open"` if `#browser-panel` has the `hidden` class or the
  webview is missing (`browser.js:151`).
- `browser_screenshot` → `browserWebview.capturePage()` → `image.toPNG()` → returns
  `{ _type: "image", data: <base64>, mimeType: "image/png" }` (`browser.js:164`).
- `browser_navigate` → same protocol blocking + `https://` prefixing as the URL bar,
  sets `src`, then **awaits navigation** by racing `did-finish-load` (resolve) vs
  `did-fail-load` (reject) with a **15s fallback resolve** (`browser.js:171`–192).
- `browser_get_url` → `getURL() || "about:blank"`.
- `browser_get_text` → `executeJavaScript("document.body.innerText")`.
- `browser_execute_js` → `executeJavaScript(code)`; result is `JSON.stringify`ed
  (`"undefined"` when the value is `undefined`).
- `browser_click` → runs `document.elementFromPoint(x, y)?.click()` in-page
  (`browser.js:213`). Coordinates are page/viewport CSS pixels, coerced with `Number()`.
- Any throw is caught and returned as `{ result: null, error }` (`browser.js:228`).

## Full IPC & wire contract

### IPC: main ↔ renderer

| Channel | Direction | Payload |
| --- | --- | --- |
| `browser-tool:exec` | main → renderer | `{ requestId: string, tool: string, args: object }` |
| `browser-tool:result` | renderer → main | `{ requestId: string, result: any, error?: string }` |

`result` for `browser_screenshot` is the object `{ _type: "image", data, mimeType }`;
for `browser_is_open` a boolean; for others a string. On failure, `result` is `null` and
`error` is set.

### TCP: MCP server ↔ bridge (line-delimited JSON on `127.0.0.1:<bridgePort>`)

| Direction | Payload |
| --- | --- |
| MCP server → bridge | `{ id: number, tool: string, args: object }` |
| bridge → MCP server | success `{ id, result }` / failure `{ id, error: string }` |

### stdio: agent ↔ MCP server (MCP JSON-RPC 2.0, line-delimited)

Standard MCP `initialize` / `tools/list` / `tools/call` requests in, `{ jsonrpc: "2.0",
id, result }` or `{ …, error: { code, message } }` out.

### End-to-end flow

```
agent
  └─(stdio JSON-RPC tools/call)→ browser-mcp-server.js
        └─(TCP {id,tool,args})→ browser-bridge.js (main)
              └─(IPC browser-tool:exec {requestId,tool,args})→ renderer browser.js
                    └─ <webview> method (capturePage/executeJavaScript/…)
              ←─(IPC browser-tool:result {requestId,result,error})─┘
        ←─(TCP {id,result|error})─┘
  ←─(stdio JSON-RPC result: content[])─┘
```

## Dev-server integration (`renderer/dev-server.js`)

- When the main-process dev server emits its URL, the renderer receives
  `ipcRenderer.on("devserver:url", …)` and calls `app.openBrowserUrl(url)`
  (`dev-server.js:65`) — auto-opening the panel to the running app.
- Stopping the dev server (`devserver:stop` invoke, or a `devserver:stopped` push)
  calls `app.closeBrowser()` (`dev-server.js:31`, `dev-server.js:71`).

## Gotchas & invariants

- **It's a `<webview>`.** `webviewTag: true` in `main.js:53` is load-bearing; without it
  the panel and every webview method break. The renderer runs with
  `nodeIntegration: true` / `contextIsolation: false`, so `require("electron")` works
  directly in `browser.js`.
- **Bridge port is random and ephemeral.** It's chosen at app-ready (port 0) and only
  valid while the bridge is up. Always fetch it via `getBridgePort()` at
  `session/new` time; never cache it. If it's null, the `browser` MCP server is omitted.
- **`browser-tool:exec` targets `getAllWindows()[0]` only** (`browser-bridge.js:69`).
  With multiple windows, tools always hit the first window's panel, not necessarily the
  focused one.
- **Two independent 30s timeouts** (bridge → renderer at `browser-bridge.js:79`; MCP
  server → bridge at `browser-mcp-server.js:62`) plus a **15s navigation fallback**
  (`browser.js:189`). A hung page returns a timeout error rather than blocking forever.
- **Protocol blocking is duplicated.** Both the URL bar (`browser.js:28`) and
  `browser_navigate` (`browser.js:174`) reject `javascript:`/`data:`/`vbscript:` and
  force `https://` when no scheme is present. Keep both in sync.
- **Open-state gating**: only `browser_is_open` works when the panel is closed; all other
  agent tools error out with `"Browser panel is not open"`. An agent should call
  `browser_is_open` (or `browser_navigate`, which opens nothing itself) before assuming
  it can act — nothing auto-opens the panel for the agent.
- **Panel visibility is inferred from the `hidden` class**, and the panel width steals
  from the terminal area, so toggling it calls `fitAllVisibleTerminals()`.
- **Persistence**: `browserOpen` and `browserUrl` live in `localStorage` and are restored
  on init; the last-visited URL survives relaunch.
- **Line framing**: every TCP and stdio hop is newline-delimited JSON with a residual
  buffer (`buffer = lines.pop()`), so partial reads across packet boundaries are handled;
  malformed lines are logged and skipped, never crashing the socket.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created.
