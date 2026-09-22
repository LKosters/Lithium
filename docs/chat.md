# Agent chat

> Native Claude Code and Codex conversations in Lithium's own chat interface.

## Overview

New sessions open as chats. Existing records without `mode: "chat"` keep their
Claude Code terminal and resume behavior. Chats work in tabs and split panes.
**Settings → Chats** configures the provider, model, reasoning effort and native
permission defaults for new chats. Defaults are captured and saved on first open,
including empty chats; later changes do not alter existing sessions.
The composer includes provider, live model catalog, reasoning effort, image
attachments (including paste), and a per-session permission selector. The timeline
renders sanitized Markdown, highlighted/copyable code, collapsible reasoning,
tool output, file diffs, agent questions, and explicit approvals.

Claude uses `@anthropic-ai/claude-agent-sdk` with the locally installed `claude`
executable. Codex uses the locally installed `codex app-server` over JSONL stdio.
Both use their own persisted login and native conversation history. Chat currently
requires subscription authentication; it refuses API-key/third-party billing
instead of silently falling back to paid API usage. Authentication can succeed
while an account's inference entitlement is denied; that error appears in chat.

## Key files

| File | Responsibility |
| --- | --- |
| `src/renderer/chat.js` | Composer, timeline, settings menus, approvals/questions, drafts |
| `src/renderer/chat-markdown.js` | Markdown, highlighting and DOMPurify allowlist |
| `src/styles/chat.css` | Warm chat styling and responsive split-pane layouts |
| `src/shared/chat-options.js` | Native permission choices and settings validation |
| `src/main/chat.js` | IPC, owner checks, image picker and safe external web links |
| `src/main/chat/service.js` | Turn lifecycle, event stream, approval promises and persistence |
| `src/main/chat/claude.js` | Claude SDK, native permission callback and event normalization |
| `src/main/chat/codex.js` | Codex app-server, native RPC approvals and event normalization |
| `src/main/chat/process.js` | Executable resolution and bounded JSON-RPC request lifecycle |
| `src/main/chat/store.js` | Atomic transcript storage under `~/.synthcode/chats` |

## Native permissions

Modes are saved in the chat document and applied to the agent before a turn.
Controls are disabled while a turn is active. Unknown modes are rejected.

| Provider | UI choice | Native configuration |
| --- | --- | --- |
| Claude | Default | `permissionMode: default` |
| Claude | Accept edits | `permissionMode: acceptEdits` |
| Claude | Auto | `permissionMode: auto` (native account/model eligibility applies) |
| Claude | Plan | `permissionMode: plan` |
| Claude | Full access | `bypassPermissions` plus `allowDangerouslySkipPermissions: true` |
| Codex | Default | Freshly resolved native config; no policy overrides on thread creation |
| Codex | Read only | `read-only`, `on-request`, reviewer `user` |
| Codex | Workspace | `workspace-write`, `on-request`, reviewer `user` |
| Codex | Auto review | `workspace-write`, `on-request`, reviewer `auto_review` |
| Codex | Full access | `danger-full-access`, `never`, reviewer `user` |

Claude loads `user`, `project`, and `local` setting sources, including native
permission rules and hooks. `canUseTool` only answers requests the CLI forwards;
it does not automatically approve requests in any mode. A reported mode mismatch
stops the query. Plan mode is Claude's native planning mode, not an invented OS
sandbox. Full access does not override policies enforced by the provider.

Codex resolves the effective sandbox (including network, temporary-directory and
additional-root configuration) itself. Lithium forwards that exact policy on
`turn/start`. On resume, an ephemeral thread resolves current defaults before
applying them to the real thread; this prevents switching from Full access to
Default from accidentally retaining previous privileges. The effective policy
is exposed in the permission selector's tooltip. A Codex process remains alive
between turns in an open tab so native session-scoped approvals remain effective.
Stopping or closing the tab ends the process; later turns resume native history.

Unknown server requests fail closed. Closing/stopping a session denies pending
requests. Approval responses are bound to both session and owning window, and
expired request IDs cannot be reused. Codex supports command/file approvals,
permission grants, blocking questions, and primitive MCP forms. Unsupported MCP
forms can only be declined. Nonblocking Codex questions appear in the conversation
and are answered through the composer.

## IPC and persistence

All `chat:*` calls use `invoke`, returning `{ ok, value }` or `{ ok: false, error }`.

| Channel | Input / effect |
| --- | --- |
| `chat:open` | `{ sessionId }` → snapshot, settings, entries and pending requests |
| `chat:configure` | `{ sessionId, settings }` → validated saved settings |
| `chat:catalog` | `{ sessionId, provider }` → native account status and live models; no model prompt |
| `chat:send` | `{ sessionId, text, attachments }` → starts one turn |
| `chat:stop` / `chat:close` | `{ sessionId }` → interrupt / flush and release |
| `chat:reply` | `{ sessionId, requestId, answer }` → resolves an actual pending request |
| `chat:pick-images` | Native file picker; up to 4 images, 10 MB each |
| `chat:open-link` | `{ url }`; only HTTP(S) links can open externally |
| `chat:event` | Main → renderer: revisioned entry, state, request, resolution or persistence error |

Sessions, chat headers, ordered message records, settings and drafts now live in
`~/.synthcode/lithium.sqlite`. Streaming changes are debounced for 250 ms and
committed in transactions; unchanged messages are not rewritten. The renderer
still loads the whole selected conversation (pagination is not implemented).
Images remain in `chats/images/<sessionId>/`; the database stores references.
Deleting a chat removes its messages and image folder. See [storage.md](./storage.md)
for the migration, native module setup and export/import contracts.

Provider switching is available before the first message; start another session
to change providers afterwards. This avoids pretending incompatible native
histories can be resumed by another provider. Model/effort/permission selection
remains available between turns. No model invocation is used for title generation.

## Verification

`npm test` covers native policy mapping, SDK permission forwarding, mode mismatch,
approval ownership and explicit decisions, cancellation, duplicate sends, history,
RPC process failure, safe rendering and preserving typed answers during streaming.

`LITHIUM_DATA_DIR=/absolute/test/path` isolates metadata, chats, instructions and
Electron userData for manual testing; native provider credentials are unchanged.
Do not commit test-account data. On environments exporting `ELECTRON_RUN_AS_NODE`,
launch the UI with `env -u ELECTRON_RUN_AS_NODE npm start`.

## Change log

- **2026-09-22** — Moved chats/messages and draft preferences to SQLite; retained external images and native resume IDs. Added portable backup/restore.

- **2026-09-22** — Added app-wide chat defaults in Settings → Chats, live model
  discovery and explicit saves. Covered new-session inheritance, stable empty-chat
  restoration, invalid defaults, stale catalogs and offline selections with tests.
- **2026-09-22** — Added native Claude/Codex chat, session permission/model selectors,
  streaming timeline, tool/approval/question UI, image attachments, safe Markdown,
  persistent history and lifecycle tests. Live Codex send/resume verified. Claude
  authentication/catalog and native mode initialization verified; model calls in
  the test account were rejected by Anthropic with `oauth_not_allowed_for_organization`,
  also reproduced directly with the official CLI outside Lithium.
