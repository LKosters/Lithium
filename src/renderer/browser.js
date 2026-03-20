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

module.exports = { initBrowser };
