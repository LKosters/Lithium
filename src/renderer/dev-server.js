const { ipcRenderer } = require("electron");
const app = require("./app");
const { state } = require("./state");

// ── DOM elements ─────────────────────────────────────
const btnDevServer = document.querySelector("#btn-dev-server");
const devPlayIcon = document.querySelector("#dev-server-play");
const devStopIcon = document.querySelector("#dev-server-stop");
const btnBrowserPreview = document.querySelector("#btn-browser-preview");

let _devServerRunning = false;
// Last localhost URL the running dev server printed. Starting the server no
// longer opens the preview by itself — the user opens it with the preview
// button, which is only available while the server runs.
let _devServerUrl = null;

// ── Functions ────────────────────────────────────────
function setDevServerUI(running) {
  _devServerRunning = running;
  btnDevServer.classList.toggle("running", running);
  btnDevServer.title = running ? "Stop App" : "Start App";
  devPlayIcon.classList.toggle("hidden", running);
  devStopIcon.classList.toggle("hidden", !running);
  btnBrowserPreview.classList.toggle("hidden", !running);
  if (!running) {
    _devServerUrl = null;
    btnBrowserPreview.classList.remove("active");
  }
  btnBrowserPreview.title = "Open preview";
  localStorage.setItem("devServerRunning", running ? "1" : "");
  if (running) {
    localStorage.setItem("devServerDir", state.currentDir || "");
  } else {
    localStorage.removeItem("devServerDir");
  }
}

async function stopDevServer() {
  if (!_devServerRunning) return;
  await ipcRenderer.invoke("devserver:stop");
  setDevServerUI(false);
  if (app.closeBrowser) app.closeBrowser();
}

// Shows the play button only when the project has something to start.
async function refreshDevServerButton() {
  if (!state.currentDir) {
    btnDevServer.classList.add("hidden");
    return;
  }
  const commands = await ipcRenderer.invoke("devserver:start-commands", { cwd: state.currentDir });
  btnDevServer.classList.toggle("hidden", !commands.length);
}

async function checkDevServerAvailable() {
  if (_devServerRunning) await stopDevServer();
  await refreshDevServerButton();
}

async function restoreDevServer() {
  const savedDevDir = localStorage.getItem("devServerDir");
  const savedDevRunning = localStorage.getItem("devServerRunning") === "1";
  if (savedDevRunning && savedDevDir && state.currentDir === savedDevDir) {
    btnDevServer.classList.remove("hidden");
    const result = await ipcRenderer.invoke("devserver:start", { cwd: savedDevDir });
    if (result.ok) setDevServerUI(true);
  }
}

// ── Event listeners ──────────────────────────────────
btnDevServer.addEventListener("click", async () => {
  if (_devServerRunning) {
    await stopDevServer();
  } else {
    if (!state.currentDir) return;
    const result = await ipcRenderer.invoke("devserver:start", { cwd: state.currentDir });
    if (result.ok) setDevServerUI(true);
  }
});

function syncPreviewButton() {
  const open = !!(app.isBrowserOpen && app.isBrowserOpen());
  btnBrowserPreview.classList.toggle("active", open);
  btnBrowserPreview.title = open ? "Close preview" : "Open preview";
}

btnBrowserPreview.addEventListener("click", () => {
  if (!_devServerRunning) return;
  if (app.isBrowserOpen && app.isBrowserOpen()) {
    app.closeBrowser();
  } else if (_devServerUrl) {
    app.openBrowserUrl(_devServerUrl);
  } else {
    app.openBrowser();
  }
  syncPreviewButton();
});

ipcRenderer.on("devserver:url", (_e, url) => {
  _devServerUrl = url;
  // If the preview is already open, keep it pointed at the running app.
  if (app.isBrowserOpen && app.isBrowserOpen()) app.openBrowserUrl(url);
});

ipcRenderer.on("devserver:stopped", () => {
  setDevServerUI(false);
  if (app.closeBrowser) app.closeBrowser();
});

module.exports = { checkDevServerAvailable, refreshDevServerButton, restoreDevServer };
