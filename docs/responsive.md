# Responsive desktop and web interface

The shared renderer adapts to small Electron windows, tablets and phones.
`src/styles/responsive.css` is loaded after the feature styles; platform-only web
styles remain in `src/web/web.css`. `src/renderer/responsive.js` owns navigation,
the compact split-pane selector and visual viewport handling.

- From 701–1100px, a persistent sidebar stacks projects above sessions beside
  the conversation. Larger desktop layouts retain their existing arrangement.
- At 700px and below, bottom navigation opens full-screen Projects, Chats and
  Settings views. Selecting a chat opens its conversation with a back button.
  Settings drill into individual categories with a back-to-settings action.
  Only the focused split pane is displayed, with a selector for the other panes.
  The stored split tree, tabs and ratios are preserved for larger screens.
- Coarse pointers get larger controls, visible action buttons and 16px inputs
  to avoid automatic input zoom on iOS. Device safe-area insets are respected.
- Dynamic viewport units resize the interface with browser chrome. When the
  software keyboard makes the visual viewport smaller than the layout viewport,
  CSS variables constrain the app height and offset; normal resize clears them.
  Short phone layouts reduce header space to keep the composer reachable.
- Electron minimum window size is 360 × 400. Preview and Git panels overlay the
  main content on narrow screens; dialogs scroll within the viewport.

Browser UI tests use an isolated mock host, without running real agents. Checks
covered 375px/390px phone layouts, 768px/820px/1024px tablet sizes, a 360px desktop
layout and reduced viewport height. DOM tests cover screen navigation, settings drill-down, keyboard
viewport updates and split-pane switching. Physical iOS keyboard/Safari testing
is still required for device-specific behavior.

## Change log

- **2026-09-22** — Replaced the mobile drawer with full-screen tab navigation,
  settings drill-down and a compact composer; tablets use a persistent sidebar.

- **2026-09-22** — Added shared responsive navigation, settings, chat and dialog
  layouts, preserved desktop splits on phones and handled visual viewport changes.
