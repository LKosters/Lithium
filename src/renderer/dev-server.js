const { ipcRenderer } = require("electron");
const app = require("./app");
const { state } = require("./state");

// ── DOM elements ─────────────────────────────────────
const btnDevServer = document.querySelector("#btn-dev-server");
const devPlayIcon = document.querySelector("#dev-server-play");
const devStopIcon = document.querySelector("#dev-server-stop");

let _devServerRunning = false;

// ── Functions ────────────────────────────────────────
function setDevServerUI(running) {
  _devServerRunning = running;
  btnDevServer.classList.toggle("running", running);
  btnDevServer.title = running ? "Stop Dev Server" : "Start Dev Server";
  devPlayIcon.classList.toggle("hidden", running);
  devStopIcon.classList.toggle("hidden", !running);
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

async function checkDevServerAvailable() {
  if (_devServerRunning) await stopDevServer();
  if (!state.currentDir) {
    btnDevServer.classList.add("hidden");
    return;
  }
  const has = await ipcRenderer.invoke("devserver:has-dev-script", { cwd: state.currentDir });
  btnDevServer.classList.toggle("hidden", !has);
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

ipcRenderer.on("devserver:url", (_e, url) => {
  if (app.openBrowserUrl) app.openBrowserUrl(url);
});

ipcRenderer.on("devserver:stopped", () => {
  setDevServerUI(false);
  if (app.closeBrowser) app.closeBrowser();
});

module.exports = { checkDevServerAvailable, restoreDevServer };
