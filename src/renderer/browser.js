const app = require("./app");
const { startDragOverlay, stopDragOverlay } = require("./layout");

function initBrowser() {
  const browserPanel = document.querySelector("#browser-panel");
  const browserResizeHandle = document.querySelector("#browser-resize-handle");
  const btnToggleBrowser = document.querySelector("#btn-toggle-browser");
  const browserWebview = document.querySelector("#browser-webview");
  const browserUrl = document.querySelector("#browser-url");
  const browserBack = document.querySelector("#browser-back");
  const browserForward = document.querySelector("#browser-forward");
  const browserReload = document.querySelector("#browser-reload");
  const browserTiktok = document.querySelector("#browser-tiktok");

  let browserOpen = false;

  btnToggleBrowser.addEventListener("click", () => {
    browserOpen = !browserOpen;
    browserPanel.classList.toggle("hidden", !browserOpen);
    browserResizeHandle.classList.toggle("hidden", !browserOpen);
    btnToggleBrowser.classList.toggle("active", browserOpen);
    requestAnimationFrame(() => app.fitAllVisibleTerminals());
  });

  browserUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      let url = browserUrl.value.trim();
      if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
      browserWebview.src = url;
    }
  });

  browserWebview.addEventListener("did-navigate", (e) => {
    browserUrl.value = e.url;
  });
  browserWebview.addEventListener("did-navigate-in-page", (e) => {
    if (e.isMainFrame) browserUrl.value = e.url;
  });

  browserBack.addEventListener("click", () => {
    if (browserWebview.canGoBack()) browserWebview.goBack();
  });
  browserForward.addEventListener("click", () => {
    if (browserWebview.canGoForward()) browserWebview.goForward();
  });
  browserReload.addEventListener("click", () => browserWebview.reload());

  browserTiktok.addEventListener("click", () => {
    browserWebview.src = "https://www.tiktok.com";
    browserUrl.value = "https://www.tiktok.com";
  });

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
      const newWidth = Math.min(600, Math.max(280, appRect.right - e.clientX));
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
}

module.exports = { initBrowser };
