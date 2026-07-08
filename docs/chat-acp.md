# Chat & ACP agent providers

> The chat pane is an alternative to the PTY terminal: instead of driving `claude`
> in a pseudo-terminal, it talks to an ACP (Agent Client Protocol) agent — Codex,
> Cursor, or Claude — over JSON-RPC, and renders streamed responses, tool calls,
> and permission prompts as chat bubbles.

## Overview

A Lithium session has a `mode`: either `"terminal"` (PTY-backed Claude Code, see
`docs/terminals-sessions.md`) or `"chat"`. A chat session picks a **provider**
(an ACP agent id like `acp`/`cursor-acp`/`claude-acp`) and shows a chat UI —
message bubbles, markdown rendering, inline tool-call chips, per-tool permission
approval buttons, image attachments, a model/provider dropdown, and a context-usage
meter.

The provider talks to a locally-spawned agent CLI (e.g. `npx @zed-industries/codex-acp`,
`cursor-agent acp`) as a stdio child process, exchanging newline-delimited JSON-RPC
2.0 messages that follow the ACP protocol (`initialize` → `authenticate` →
`session/new` → `session/prompt`, plus `session/update` notifications streamed back).

Two parallel implementations of the ACP plumbing exist in the tree. **Only the
generic factory path is wired into the app** (see the "Two implementations" gotcha).

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/chat.js` | Chat pane UI — DOM, markdown renderer, streaming, tool/permission UI, per-session chat state |
| `src/renderer.js` (lines 168–182) | Wires `agent:stream-start/chunk/stream-end/error` main→renderer events to chat.js handlers |
| `src/renderer/tabs.js`, `src/renderer/session-create.js` | Create a chat pane (`app.createChatPane`) when a session's `mode === "chat"` |
| `src/main/agents.js` | Main-process agent manager: all `agent:*` IPC handlers, chat-history persistence, `stopAllServers` |
| `src/main/provider-registry.js` | **Single source of truth** for ACP providers — one `PROVIDER_CONFIGS` array; builds a server + provider per entry |
| `src/main/acp-server-factory.js` | `createACPServerManager(config)` — generic stdio JSON-RPC process manager for any ACP agent |
| `src/main/providers/base-acp-provider.js` | `BaseACPProvider` — session mapping, streaming, context rotation; used for every registry entry |
| `src/main/acp-server.js` | **Legacy/unused** hand-written codex-acp server manager (superseded by the factory) |
| `src/main/cursor-acp-server.js` | **Legacy/unused** hand-written cursor-acp server manager |
| `src/main/providers/acp.js`, `providers/cursor-acp.js` | **Legacy/unused** provider classes wrapping the two legacy servers |
| `src/styles/chat.css` | Chat pane styling (`.chat-*` classes) |
| `main.js` (33–36, 115–129, 336–353) | Calls `registerAgentHandlers()`, handles `dialog:pick-images`, calls `stopAllServers()` on quit |

## Chat UI vs. terminal sessions

- A terminal session renders an xterm.js instance fed by `pty:data`; a chat session
  renders a `.chat-pane` built by `createChatPane` (`chat.js:83`). Both live in the
  same tab/pane layout; `tabs.js` and `session-create.js` branch on `s.mode`.
- Each chat pane keeps **renderer-side** per-session state in the module-level
  `chatStates` Map (`chat.js:7`, `getChatState` at `:9`): `messages`, `streaming`,
  `streamParts` (ordered mix of `text`/`tool`/`permission` parts), `contextUsed`,
  `contextSize`, `streamStartTime`, `provider`, `model`, `attachedImages`.
- The **main process** keeps its own authoritative copy in `chatHistories`
  (`agents.js:52`) plus `contextUsage` (`agents.js:43`), and persists it to disk at
  `~/.synthcode/chat/<sessionId>.json` (`agents.js:16`, `saveChatData` at `:33`).
  On pane creation the renderer reloads history via `agent:history` (`chat.js:247`).

### Rendering agent responses

- `renderMarkdown` (`chat.js:28`) is a hand-rolled regex markdown→HTML converter
  (code fences, inline code, bold/italic, headings, `ul`/`ol`, paragraphs). Input is
  `escapeHtml`'d first, so it is XSS-safe for text content.
- `renderMessages` (`chat.js:352`) rebuilds the whole message list. User bubbles show
  attached images + escaped text; assistant bubbles show `renderMarkdown(content)` plus
  a stats line (`formatDuration`, token count/percent).
- Streaming is rendered **inline** by `renderStreamInline` (`chat.js:402`) from
  `cs.streamParts`:
  - `text` part → an assistant bubble with `renderMarkdown`.
  - `tool` part → a `.chat-tool-call` chip with a kind-based icon (`getToolIcon` at
    `:703`; `edit`/`read`/`command`/default).
  - `permission` part → a `.chat-tool-approval` block with Always/Allow/Deny buttons.
  - Typing dots are shown when there is no content yet, or after a tool call while the
    agent is still working (but not while a permission is pending — `chat.js:509`).
- **Fast path:** when a text chunk arrives, `handleChunk` (`chat.js:591`) mutates the
  last `.chat-stream-text` element's `innerHTML` directly and scrolls, avoiding a full
  re-render. Tool calls and the first text chunk trigger a full `renderMessages`.

## ACP architecture

```
renderer/chat.js ──IPC(agent:*)──▶ main/agents.js
                                        │  getProvider(id)
                                        ▼
                            provider-registry.js  (PROVIDER_CONFIGS)
                              │ per config id:
                              ├─ BaseACPProvider  (providers/base-acp-provider.js)
                              │     maps chatSessionId ↔ acpSessionId, streams,
                              │     rotates context, forwards permissions
                              └─ ACP server manager (acp-server-factory.js)
                                    spawns the agent CLI, speaks JSON-RPC/ACP
                                    over stdio
```

### The registry (`provider-registry.js`)

`PROVIDER_CONFIGS` (line 6) is the one place providers are declared. Each entry:
`{ id, label, command, args, authMethodId }`. Current entries:

| id | label | command / args | authMethodId |
| --- | --- | --- | --- |
| `acp` | Codex | `npx @zed-industries/codex-acp` | `chatgpt` |
| `cursor-acp` | Cursor | `cursor-agent acp` | `cursor_login` |
| `claude-acp` | Claude | `npx @agentclientprotocol/claude-agent-acp` | `claude-login` |

For each config the registry eagerly builds a server manager
(`createACPServerManager`) **and** a `BaseACPProvider` wrapping it (lines 34–48), then
exposes `getProvider(id)`, `getServer(id)`, `getAllProviderIds()`, `getProviderLabel(id)`,
`getAllProviderConfigs()`.

**To add a new provider: add one object to `PROVIDER_CONFIGS`.** No other code
changes are required for the server/provider/IPC to exist. To make it selectable in
the model dropdown a user must also enable it (it is added to `config.enabledACPs`;
default is `["acp"]` — see `agent:set-acp-enabled` at `agents.js:254`).

### What a "provider" is

A provider is a `BaseACPProvider` instance (`providers/base-acp-provider.js`). It is
the stateful glue between a Lithium chat session and an ACP agent process:

- **Session maps** (constructor, `:12`): `_sessions` (chatSessionId → acpSessionId),
  `_sessionCwds` (chatSessionId → cwd), `_sessionUsage` (chatSessionId → {used,size}),
  `_activeCallbacks` (chatSessionId → onChunk), `_resolvers` (chatSessionId →
  {fullText}).
- On construction it registers `server.setUpdateCallback` and
  `server.setPermissionCallback` (`:18`, `:28`), routing agent notifications to the
  right chat session's `onChunk`.
- `sendMessage(sessionId, messages, opts, onChunk)` (`:139`) is the entry point the
  agent manager calls. It: ensures the server is in the right cwd, lazily creates an
  ACP session (or a new one if cwd changed), summarizes+rotates if context is near
  full, builds prompt parts (text + base64 images), sends the prompt, and resolves
  with the accumulated `{ content, role: "assistant" }` when the turn completes.

### The server manager (`acp-server-factory.js`)

`createACPServerManager({ name, command, args, authMethodId, logPrefix })` returns a
closure-based manager. It is a full JSON-RPC-over-stdio client:

- **`start(cwd)`** (`:26`) — spawns `command args` with `shell: true`, `cwd`, and the
  inherited `env`. No-ops if a live process already exists. Wires stdout→`processBuffer`,
  stderr→`lastError`, and `error`/`exit` handlers that clear state **only if the exiting
  process is still the current one** (`proc === thisProc`) — guards against a stale
  process from a prior restart clobbering the new one.
- **`doStartup()`** (`:124`) — sends `initialize` (protocolVersion 1, clientCapabilities
  `{ permissions: { supported: true }, _meta: { terminal_output: true } }`), then, if
  `authMethodId` is set, `authenticate` (which typically opens a browser for OAuth).
  Failures are swallowed and `ready` is set true anyway so the UI isn't blocked forever.
- **`processBuffer()` / `handleMessage()`** (`:156`, `:251`) — splits stdout on `\n`,
  parses each line as JSON. Routes responses (matching `pendingRequests` by id),
  `session/update` notifications (→ `onUpdateCallback`), and agent-initiated requests
  (see permissions below).
- **`createSession(cwd)`** (`:412`) — `session/new` with `cwd` and an optional
  `browser` MCP server (only when `getBridgePort()` is truthy; runs
  `browser-mcp-server.js`). Returns the ACP `sessionId`.
- **`sendPrompt(sessionId, promptOrText)`** (`:434`) — `session/prompt`. A string is
  wrapped as `[{ type: "text", text }]`. **The returned promise resolves when the
  agent's whole turn completes** — this is what `sendMessage` awaits.
- Public surface (`:508`): `start, stop, ensureCwd, isRunning, getStatus, getLastError,
  createSession, sendPrompt, setUpdateCallback, setPermissionCallback,
  respondPermission, abortPendingRequests`.

### Permission / tool-approval handling (factory)

Agent→client requests (`msg.method` with an `id`) are dispatched in `handleMessage`
(`:278`):

- **`session/request_permission`** (`:282`) — reads `toolApprovalMode` from config
  (`manual` default). In `auto` mode, or if the tool is project-approved
  (`isToolApproved`), it auto-selects an allow option and replies
  `{ outcome: { outcome: "selected", optionId } }`. Otherwise it stores the request in
  `pendingPermissions` and fires `onPermissionCallback` so the UI can prompt.
- **`terminal/create`** and **`fs/write_text_file`** (`:349`, `:359`) — treated as
  direct dangerous ops; routed through `requireToolApproval` (`:215`), which either
  auto-acks (auto mode / project-approved) with `result: {}` or prompts. These use a
  `directAck: true` pending entry so the response is a plain ack/error, not an ACP
  `outcome`.
- **`fs/read_text_file`** (`:367`) — auto-acked (read-only, safe).
- **`terminal/output`/`release`/`wait_for_exit`/`kill`** (`:371`) — auto-acked
  (the `create` was already approved).
- Anything else — auto-acked with `result: {}`.

**Per-project approved tools** are stored at `<cwd>/.lithium/approved-tools.json`
(`getApprovedToolsPath`, `:175`). `saveApprovedTool` (`:190`) is called when the user
picks "Always". Tool-name matching strips everything after the first `:` or `(`
(`isToolApproved`, `:205`). Generic names (`"Tool call"`, `"Unknown"`, `"tool_call"`)
are never saved or auto-approved (`GENERIC_TOOL_NAMES`, `:173`).

`respondPermission(permissionId, optionId, alwaysAllow)` (`:449`) looks up the pending
entry, optionally saves the tool as project-approved, and sends the correct reply
shape (direct ack/error for `directAck` entries, ACP `outcome` otherwise).

### Streaming: how `session/update` becomes chunks

`BaseACPProvider._handleUpdate` (`:49`) maps ACP `sessionUpdate` variants to the chunk
objects the renderer understands:

| ACP `update.sessionUpdate` | Emitted chunk (`onChunk`) |
| --- | --- |
| `agent_message_chunk` | `{ type: "text_delta", text }` (also appended to `_resolvers[sid].fullText`) |
| `usage_update` | `{ type: "usage", used, size }` (also stored in `_sessionUsage`) |
| `tool_call` | `{ type: "tool_call", title, status, kind, toolCallId }` |

Permission requests are emitted separately (via `setPermissionCallback`) as
`{ type: "permission_request", permissionId, title, description, options }` (`:28`).

Note the renderer keys text handling off `chunk.text` being present (`chat.js:577`,
`:591`) rather than the `text_delta` type string.

### Context rotation (auto-summarization)

`CONTEXT_THRESHOLD = 0.80` (`base-acp-provider.js:4`). Before sending a prompt,
`sendMessage` checks `_needsSummarization` (`:74`): if `used/size >= 0.80`, it calls
`_summarizeAndRotate` (`:80`):

1. Ask the current ACP session for a detailed conversation summary (response swallowed
   via a no-op callback; `fullText` accumulates it).
2. `createSession` a fresh ACP session, point `_sessions[sid]` at it, clear usage.
3. Prime the new session with the summary as context.
4. Emit a `text_delta` chunk telling the user the conversation was summarized/continued.

If the summary comes back empty the rotation is skipped.

## IPC contract

All channels are grouped by direction. Payloads are the object shapes actually sent.

### Renderer → main (chat flow)

| Channel | Kind | Payload | Handler |
| --- | --- | --- | --- |
| `agent:send` | `on` | `{ sessionId, provider, message, images, model, cwd }` | `agents.js:113` |
| `agent:abort` | `on` | `{ sessionId, provider }` | `agents.js:179` |
| `agent:clear-history` | `on` | `sessionId` (string) | `agents.js:199` |
| `agent:permission-response` | `on` | `{ permissionId, optionId, provider, alwaysAllow? }` | `agents.js:212` |
| `agent:history` | `invoke` | `sessionId` → `{ messages, contextUsed, contextSize }` | `agents.js:185` |

`images` is an array of `{ dataUrl, mimeType, name }`. `agent:send` pushes the user
message into `chatHistories`, persists, sends `agent:stream-start`, then awaits
`provider.sendMessage`, forwarding each chunk over `agent:chunk`.

### Main → renderer (streaming)

Wired in `renderer.js:168–182`, handled in `chat.js`.

| Channel | Payload | Renderer handler |
| --- | --- | --- |
| `agent:stream-start` | `{ sessionId }` | `handleStreamStart` (`chat.js:527`) |
| `agent:chunk` | `{ sessionId, chunk }` | `handleChunk` (`chat.js:535`) |
| `agent:stream-end` | `{ sessionId, aborted }` | `handleStreamEnd` (`chat.js:609`) |
| `agent:error` | `{ sessionId, error }` | `handleError` (`chat.js:637`) |

`chunk` variants the renderer understands (`handleChunk`): `{ type: "usage", used,
size }`, `{ type: "permission_request", permissionId, title, description, options }`,
`{ type: "tool_call", toolCallId, title, status, kind }`, and `{ text }` (text delta,
appended to the current text part).

### Renderer → main (config / metadata)

| Channel | Kind | Payload → return | Handler |
| --- | --- | --- | --- |
| `agent:providers` | `invoke` | → `[{ name, label, configured, models, defaultModel }]` (incl. synthetic `terminal`) | `agents.js:58` |
| `agent:configure` | `invoke` | `{ provider, config }` → `true` | `agents.js:99` |
| `agent:get-config` | `invoke` | `providerName` → config obj | `agents.js:107` |
| `agent:get-tool-approval-mode` | `invoke` | → `"manual"`/`"auto"` | `agents.js:223` |
| `agent:set-tool-approval-mode` | `invoke` | `mode` → `true` | `agents.js:228` |
| `agent:get-default` | `invoke` | → `config.defaultAgent` or `"terminal"` | `agents.js:236` |
| `agent:set-default` | `invoke` | `mode` → `true` | `agents.js:241` |
| `agent:get-enabled-acps` | `invoke` | → `config.enabledACPs` or `["acp"]` | `agents.js:249` |
| `agent:set-acp-enabled` | `invoke` | `{ provider, enabled }` → `true` | `agents.js:254` |
| `agent:get-default-model` | `invoke` | `providerName` → model or null | `agents.js:267` |
| `agent:set-default-model` | `invoke` | `{ provider, model }` → `true` | `agents.js:272` |
| `agent:get-provider-labels` | `invoke` | → `{ [id]: label }` | `agents.js:281` |

### Dynamic per-provider server channels

For every registry config, `registerAgentHandlers` registers three handlers
(`agents.js:78–96`), e.g. for `acp`:

| Channel | Return |
| --- | --- |
| `agent:acp-server-status` | `{ running, status, lastError }` |
| `agent:acp-server-start` | `true` (calls `server.start()`) |
| `agent:acp-server-stop` | `true` (calls `server.stop()`) |

(Also `agent:cursor-acp-server-*` and `agent:claude-acp-server-*`.)

### Related non-agent channels used by chat

- `dialog:pick-images` (`invoke`, `main.js:115`) → array of `{ dataUrl, mimeType,
  name }` from a native file picker.
- `sessions:save` / `persistSession` — chat.js persists the session's `provider` when
  the model dropdown changes (`chat.js:178`) and auto-titles from the first prompt
  (`chat.js:328`).

## Lifecycle

**Startup:** `main.js` calls `registerAgentHandlers()` at load (`main.js:36`). Servers
are **not** started here — the comment at `agents.js:55` notes ACP servers start
lazily on the first chat message so they spawn in the correct project directory.

**Sending a message** (renderer `sendMessage`, `chat.js:294`):
1. Push user message to `cs.messages`, clear the input & attached images, auto-title
   the session, render.
2. `send("agent:send", { sessionId, provider, message, images, model, cwd })` where
   `cwd = state.currentDir`.

**Main handles `agent:send`** (`agents.js:113`):
1. `getProvider(providerName)`; error if unknown.
2. If the provider isn't available **and** no cwd, error asking the user to start the
   server in Settings (`agents.js:124`).
3. Append user msg to `chatHistories`, persist, `send("agent:stream-start")`.
4. `await provider.sendMessage(sessionId, history, { model, cwd }, onChunk)` where
   `onChunk` intercepts `usage` chunks (to update `contextUsage`) and forwards every
   chunk via `agent:chunk` (guarded by `!sender.isDestroyed()`).
5. On success, push assistant `{ role, content }` to history, persist,
   `send("agent:stream-end", { aborted })`. On throw, `send("agent:error", { error })`.

**Provider `sendMessage`** (`base-acp-provider.js:139`): `server.ensureCwd(cwd)` →
create/reuse ACP session → maybe rotate context → `server.sendPrompt(...)` (awaits full
turn) → resolve `{ content: fullText, role }`.

**Server `ensureCwd`** (`acp-server-factory.js:110`): if the live process already uses
this cwd, just await startup; if cwd differs, `stop()` then `start(cwd)` (restart to
re-root the agent); if not running, `start(cwd)`.

**Streaming:** the agent emits `session/update` notifications → `handleMessage` →
`onUpdateCallback` → `BaseACPProvider._handleUpdate` → `onChunk` → `agent:chunk` →
renderer `handleChunk`.

**Stream end** (renderer `handleStreamEnd`, `chat.js:609`): unless aborted, joins all
`text` stream parts into a final assistant message (with duration + context stats),
clears `streamParts`, re-renders.

**Abort:** renderer stop button sends `agent:abort` and optimistically ends the stream
UI (`chat.js:224`). Main calls `provider.abort(sessionId)`. `BaseACPProvider.abort`
(`:201`) drops the active callback/resolver and calls `server.abortPendingRequests()`,
which rejects all pending JSON-RPC requests to unblock the awaiting `sendPrompt`; the
rejection message contains "aborted" so `sendMessage` returns `{ ..., aborted: true }`
instead of throwing (`base-acp-provider.js:194`).

**Clear history:** `agent:clear-history` (`agents.js:199`) deletes in-memory history,
context usage, the on-disk file, and calls `clearSession(sessionId)` on every provider
(drops the chatSessionId→acpSessionId mapping so the next message starts fresh).

**Shutdown:** `stopAllServers()` (`agents.js:302`) iterates `getAllProviderIds()` and
calls `server.stop()` on each. It runs on `window-all-closed`, `before-quit`, and
`will-quit` (`main.js:340,347,352`). `stop()` (`acp-server-factory.js:83`) rejects
pending requests, ends stdin, `SIGTERM`, then `SIGKILL` after 3s.

### Sessions & threads

- **Lithium session id** (`sessionId`) is the chat pane / tab identity — used as the
  key for `chatStates` (renderer), `chatHistories`/`contextUsage` (main), the persisted
  `~/.synthcode/chat/<sessionId>.json` file, and the provider's session maps.
- **ACP session id** (returned by `session/new`) is separate; the provider maps
  chatSessionId → acpSessionId. Context rotation swaps the ACP session id under the same
  Lithium session id.
- There is no explicit multi-thread concept — one ACP session per Lithium chat session,
  recreated when the cwd changes or after context rotation.

## Generic ACP vs. Cursor provider

In the **live (factory) path there is essentially no per-provider code difference** —
Codex, Cursor, and Claude are all `BaseACPProvider` instances over
`createACPServerManager`; they differ only by the `PROVIDER_CONFIGS` row (command,
args, `authMethodId`, label). Auth method ids: `chatgpt` (Codex), `cursor_login`
(Cursor), `claude-login` (Claude).

The **legacy standalone files** (`providers/acp.js` + `acp-server.js`,
`providers/cursor-acp.js` + `cursor-acp-server.js`) are near-duplicates that differ
from the factory in ways worth knowing if you ever revive them:

- Legacy servers **only** handle `session/request_permission` and always auto-approve
  it (`acp-server.js:171`, `cursor-acp-server.js:164`). They have **no** manual approval
  UI, no `terminal/create`/`fs/write_text_file` gating, no per-project approved-tools
  file, and no `setPermissionCallback` — every other agent request gets a blank ack.
- Legacy `initialize` sends empty `clientCapabilities: {}` (`acp-server.js:96`); the
  factory advertises `permissions.supported` and `_meta.terminal_output`
  (`acp-server-factory.js:127`).
- The two legacy servers differ from each other only in spawn command
  (`npx @zed-industries/codex-acp` vs. `cursor-agent acp`) and auth method — the exact
  code duplication the factory was built to remove.

## Gotchas & invariants

- **Two implementations; only the factory is wired in.** `agents.js` imports solely
  from `provider-registry.js`, which uses `acp-server-factory.js` + `base-acp-provider.js`.
  `acp-server.js`, `cursor-acp-server.js`, `providers/acp.js`, and `providers/cursor-acp.js`
  are **not required by any live code** (confirmed by grep) — they are legacy. Edit the
  factory/base/registry, not the standalone files. `getProviderLabel` is imported in
  `agents.js:11` but unused.
- **Servers start lazily, keyed on cwd.** A cwd change restarts the whole agent process
  (`ensureCwd`). The `proc === thisProc` guard in `error`/`exit` handlers is essential
  so a dying old process doesn't null out a freshly restarted one.
- **`sendPrompt` resolving == turn complete.** All streaming happens via `session/update`
  notifications *before* the `session/prompt` response arrives. Abort works by rejecting
  that pending request.
- **Two histories, one persisted.** The renderer (`chatStates`) and main (`chatHistories`)
  each maintain a message list. Main is the source of truth on disk
  (`~/.synthcode/chat/<id>.json`); the renderer reloads it via `agent:history` on pane
  creation. The user message is pushed on both sides; keep them in sync if you change the
  shape.
- **`agent:history` returns old or new format.** `loadChatData` accepts a bare array
  (legacy) or `{ messages, contextUsed, contextSize }`; the renderer (`chat.js:249`)
  also handles both. Preserve this when changing the persisted shape.
- **Always guard `sender.isDestroyed()`** before `.send()` in `agent:send` — the window
  may close mid-stream (`agents.js:156,168,172`).
- **Permission option selection is heuristic.** Both UI (`chat.js:449`) and server pick
  `allow_always` → `allow_once` → first option for allow, and `deny` → last option for
  deny. Providers must send sensible `options` with `kind` fields.
- **Tool-name normalization matters.** Approved-tool matching strips after `:`/`(` and
  refuses generic names; renaming a tool's title format can silently break "Always"
  approvals (`acp-server-factory.js:205,459`).
- **Enabled vs. registered.** Every registry entry is registered (server + IPC exist),
  but the chat model dropdown only lists `config.enabledACPs` (default `["acp"]`). A new
  provider won't appear until enabled via `agent:set-acp-enabled`.
- **`browser` MCP server is conditional.** `createSession` only attaches it when
  `getBridgePort()` is truthy (the browser bridge is running).
- **Markdown is regex-based, not a real parser.** `renderMarkdown` handles a fixed
  subset; nested/edge markdown may render imperfectly. Text is escaped first, so it's
  safe, but don't assume full CommonMark.

## Change log

Newest first. Each entry: date, who/what, and the change.

- **2026-07-08** — Initial doc created (documenting existing behavior; no code change).
