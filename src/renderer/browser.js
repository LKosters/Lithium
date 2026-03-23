const { ipcRenderer } = require("electron");
const app = require("./app");
const { startDragOverlay, stopDragOverlay } = require("./layout");

function initBrowser() {
  const browserPanel = document.querySelector("#browser-panel");
  const browserResizeHandle = document.querySelector("#browser-resize-handle");
  const browserWebview = document.querySelector("#browser-webview");
  const browserUrl = document.querySelector("#browser-url");
  const browserBack = document.querySelector("#browser-back");
  const browserForward = document.querySelector("#browser-forward");
  const browserReload = document.querySelector("#browser-reload");
  let browserOpen = false;

  function setBrowserOpen(open) {
    browserOpen = open;
    browserPanel.classList.toggle("hidden", !open);
    browserResizeHandle.classList.toggle("hidden", !open);
    localStorage.setItem("browserOpen", open ? "1" : "");
    requestAnimationFrame(() => app.fitAllVisibleTerminals());
  }

  browserUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      let url = browserUrl.value.trim();
      if (!url) return;
      // Block dangerous protocols
      if (/^(javascript|data|vbscript):/i.test(url)) return;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      browserWebview.src = url;
    }
  });

  browserWebview.addEventListener("did-navigate", (e) => {
    browserUrl.value = e.url;
    localStorage.setItem("browserUrl", e.url);
  });
  browserWebview.addEventListener("did-navigate-in-page", (e) => {
    if (e.isMainFrame) {
      browserUrl.value = e.url;
      localStorage.setItem("browserUrl", e.url);
    }
  });

  browserBack.addEventListener("click", () => {
    if (browserWebview.canGoBack()) browserWebview.goBack();
  });
  browserForward.addEventListener("click", () => {
    if (browserWebview.canGoForward()) browserWebview.goForward();
  });
  browserReload.addEventListener("click", () => browserWebview.reload());

  // Viewport size presets
  const viewportBtns = document.querySelectorAll(".browser-viewport-btn");
  const viewportFrame = document.querySelector("#browser-viewport-frame");
  const viewportLabel = document.querySelector("#browser-viewport-label");

  const viewportNames = {
    responsive: "Responsive",
    "375": "Mobile · 375px",
    "768": "Tablet · 768px",
    "1280": "Desktop · 1280px",
  };

  viewportBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const vp = btn.dataset.viewport;
      viewportBtns.forEach((b) => b.classList.toggle("active", b === btn));
      viewportLabel.textContent = viewportNames[vp] || vp;

      if (vp === "responsive") {
        viewportFrame.style.width = "100%";
        viewportFrame.style.maxWidth = "";
        viewportFrame.classList.remove("constrained");
      } else {
        const px = parseInt(vp, 10);
        viewportFrame.style.maxWidth = px + "px";
        viewportFrame.style.width = px + "px";
        viewportFrame.classList.add("constrained");
      }
    });
  });

  // Expose function to open a URL from outside
  app.openBrowserUrl = function (url) {
    if (!browserOpen) setBrowserOpen(true);
    browserWebview.src = url;
    browserUrl.value = url;
    localStorage.setItem("browserUrl", url);
  };

  // Expose function to close the browser panel
  app.closeBrowser = function () {
    if (browserOpen) setBrowserOpen(false);
  };

  // Browser panel resize
  {
    let dragging = false;
    browserResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      browserResizeHandle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      startDragOverlay("col-resize");
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const appRect = document.getElementById("app").getBoundingClientRect();
      const maxW = appRect.width * 0.6;
      const newWidth = Math.min(maxW, Math.max(280, appRect.right - e.clientX));
      browserPanel.style.width = newWidth + "px";
      app.fitAllVisibleTerminals();
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      browserResizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      stopDragOverlay();
    });
  }

  // Restore browser panel state from previous session
  const savedOpen = localStorage.getItem("browserOpen");
  const savedUrl = localStorage.getItem("browserUrl");
  if (savedOpen === "1") {
    if (savedUrl) {
      browserWebview.src = savedUrl;
      browserUrl.value = savedUrl;
    }
    setBrowserOpen(true);
  }
}

function initBrowserTools() {
  const browserPanel = document.querySelector("#browser-panel");
  const browserWebview = document.querySelector("#browser-webview");

  ipcRenderer.on("browser-tool:exec", async (_e, { requestId, tool, args }) => {
    const isOpen = browserPanel && !browserPanel.classList.contains("hidden");

    // browser_is_open always works regardless of panel state
    if (tool === "browser_is_open") {
      ipcRenderer.send("browser-tool:result", { requestId, result: isOpen });
      return;
    }

    if (!isOpen || !browserWebview) {
      ipcRenderer.send("browser-tool:result", {
        requestId,
        result: null,
        error: "Browser panel is not open",
      });
      return;
    }

    try {
      let result;

      switch (tool) {
        case "browser_screenshot": {
          const image = await browserWebview.capturePage();
          const png = image.toPNG();
          result = { _type: "image", data: png.toString("base64"), mimeType: "image/png" };
          break;
        }

        case "browser_navigate": {
          const url = args.url;
          if (!url) throw new Error("Missing url parameter");
          if (/^(javascript|data|vbscript):/i.test(url)) {
            throw new Error("Blocked protocol");
          }
          const loadUrl = /^https?:\/\//i.test(url) ? url : "https://" + url;
          browserWebview.src = loadUrl;
          // Wait for navigation to complete
          await new Promise((resolve, reject) => {
            const onDone = () => { cleanup(); resolve(); };
            const onFail = (_e, _code, desc) => { cleanup(); reject(new Error(desc || "Navigation failed")); };
            const cleanup = () => {
              browserWebview.removeEventListener("did-finish-load", onDone);
              browserWebview.removeEventListener("did-fail-load", onFail);
            };
            browserWebview.addEventListener("did-finish-load", onDone, { once: true });
            browserWebview.addEventListener("did-fail-load", onFail, { once: true });
            setTimeout(() => { cleanup(); resolve(); }, 15000); // 15s timeout
          });
          result = `Navigated to ${loadUrl}`;
          break;
        }

        case "browser_get_url": {
          result = browserWebview.getURL() || "about:blank";
          break;
        }

        case "browser_get_text": {
          result = await browserWebview.executeJavaScript("document.body.innerText");
          break;
        }

        case "browser_execute_js": {
          const code = args.code;
          if (!code) throw new Error("Missing code parameter");
          const jsResult = await browserWebview.executeJavaScript(code);
          result = jsResult === undefined ? "undefined" : JSON.stringify(jsResult);
          break;
        }

        case "browser_click": {
          const { x, y } = args;
          if (x == null || y == null) throw new Error("Missing x or y parameter");
          await browserWebview.executeJavaScript(
            `(function(){ var el = document.elementFromPoint(${Number(x)}, ${Number(y)}); if(el) el.click(); return el ? el.tagName : null; })()`
          );
          result = `Clicked at (${x}, ${y})`;
          break;
        }

        default:
          throw new Error(`Unknown tool: ${tool}`);
      }

      ipcRenderer.send("browser-tool:result", { requestId, result });
    } catch (err) {
      ipcRenderer.send("browser-tool:result", {
        requestId,
        result: null,
        error: err.message || String(err),
      });
    }
  });
}

module.exports = { initBrowser, initBrowserTools };
