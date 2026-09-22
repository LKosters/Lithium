# Web access

Lithium can host its existing interface for browsers on the LAN or the same
Tailscale network. Enable it with **Settings → Web access → Start web version**.
Open one of the displayed addresses on another device and enter the access code.
The desktop process runs the agents, terminals, Git and project commands; the
browser does not need Node, Electron, provider CLIs or a separate provider login.
Each address has a **Show QR** button so a phone or tablet can scan and sign in
automatically. The QR link includes the access code in its `#code=…` fragment.
The browser removes it from the address bar before making requests and exchanges
it through the existing login endpoint. Invalid or expired codes leave the manual
login form available. QR codes grant the same access as the displayed access code.

## Connection and lifecycle

- Hosting is off at launch. The chosen port is remembered (default `3210`), but
  starting is explicit each time. Bind address is `0.0.0.0` (IPv4).
- Settings lists localhost and the host's IPv4 interfaces. Addresses in
  `100.64.0.0/10` are labelled Tailscale. Both devices need network reachability;
  the host firewall and Tailscale access rules must permit the selected port.
- LAN traffic uses HTTP. Tailscale encrypts the connection between its devices.
  The access code grants access to host agents and projects; it is not a
  restricted guest account. Do not expose this port publicly.
- Each server start generates a fresh 256-bit random code kept only in memory.
  Login exchanges it for a random HttpOnly, SameSite=Strict session cookie with
  a 24-hour lifetime. Stopping invalidates cookies/code and closes web-owned
  chats and terminals. Quitting Lithium also stops hosting. Closing the last
  desktop window keeps the process alive while hosting is enabled.
- HTTP POST requests require a matching Origin and JSON content type. RPC uses
  an explicit allowlist; hosting controls, updates, native dialogs, backups,
  arbitrary config reads/writes and local-file serving are not exposed.
- Browser tabs have separate event streams and owner identities. A dropped
  stream can reconnect within 30 seconds; a reload reuses a disconnected owner
  and reloads chat snapshots. After the grace period, its sessions are closed.
  Existing chat ownership rules apply: a running chat cannot be opened on another
  device; stop/close it there first. This is not simultaneous chat co-editing.

## Browser behavior

The web build shares the desktop renderer, with an HTTP/SSE replacement for
Electron IPC. Projects, saved sessions and chat history come from the host.
Appearance, current project, drafts and tab layout remain in browser storage,
so opening the web app does not replace the desktop layout or open its tabs.
Choose existing projects from the sidebar or enter an absolute **host** folder
path in the browser picker. Image attachments are uploaded from the client device.

The native embedded preview is replaced by a new browser tab. Localhost preview
URLs use the host's current address; the project's dev server must also listen on
the network interface and allow the chosen host. Lithium does not proxy arbitrary
ports. Music control, native backup/restore and app updates remain desktop-only.
Phones use bottom navigation for Projects, Chats and Settings. Tablets keep a
persistent sidebar. See [responsive interface](responsive.md) for phone/tablet behavior.

## Key files

| File | Role |
| --- | --- |
| `src/main/web-server.js` | HTTP server, login, asset allowlist, RPC, SSE and clients |
| `src/main/web.js` | Desktop hosting IPC, session validation and cleanup |
| `src/main/ipc.js` | Registers native handlers and exposes shared dispatch |
| `src/renderer/web-settings.js` | Start/stop UI, port, addresses and access code |
| `src/web/entry.js`, `electron.js`, `browser.js` | Web login and platform adapters |
| `scripts/build-web.js` | esbuild bundle with browser-only module replacements |

`npm run web:build` generates ignored `src/web/app.bundle.js`. It runs before
`npm start`, tests and the npm build commands; CI runs it before electron-builder.
The generated bundle ships under the existing `src/**/*` packaging rule. Direct
`npx electron .` / `npx electron-builder` invocations need `npm run web:build` first.

## Validation

`tests/web-server.test.js` exercises real HTTP login, denied operations/origins,
client isolation, streaming, stop/restart revocation, port conflicts and interface
labels. `web-renderer.test.js` boots the bundled renderer in a browser-like DOM
without Node, authenticates and creates a chat through mocked RPC. The desktop
settings test checks start failure recovery, port persistence and stop behavior.
These tests do not replace testing reachability from another physical device.

## Change log

- **2026-09-22** — Matched the Web access navigation icon to other settings tabs;
  access code now uses a labelled, read-only field with select-on-focus and an
  inline copy button, constrained to the same width as the address cards.
- **2026-09-22** — QR links now include an access-code fragment for automatic
  login, with immediate address-bar cleanup and manual fallback on failure.
- **2026-09-22** — Added expandable QR codes for each localhost, LAN and
  Tailscale address. Codes are generated locally and never contain the access code.
- **2026-09-22** — Added optional authenticated LAN/Tailscale web hosting using the
  shared renderer and native IPC implementations, browser adapters and build hooks.
