const preferences = require('./preferences');
const app = require("./app");
// Shared seek handler for both dock and compact track bars
function handleTrackBarSeek(e, trackBar) {
  if (musicPlayer._deviceDuration <= 0) return;
  const rect = trackBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  app.ipcRenderer.invoke("media:control", {
    action: "seek", position: pct * musicPlayer._deviceDuration,
  }).catch(() => {});
}

const musicPlayer = {
  playing: false,
  devicePollTimer: null,
  _devicePollInFlight: false,
  _deviceDuration: 0,
  _devicePosition: 0,
  _deviceLastPoll: 0,
};

// ── Player mode (full / compact / none) ──────────────

function setPlayerMode(mode) {
  const dock = document.getElementById("music-dock");
  const compact = document.getElementById("compact-player");
  if (!dock || !compact) return;

  dock.classList.toggle("hidden", mode !== "full");
  compact.classList.toggle("hidden", mode !== "compact");
  musicPlayer.mode = mode;
  preferences.setItem("playerMode", mode);
}

function syncCompactPlayer() {
  const cpTrackName = document.querySelector("#cp-track-name");
  const mpTrackName = document.querySelector("#mp-track-name");
  if (cpTrackName && mpTrackName) {
    cpTrackName.textContent = mpTrackName.textContent;
    cpTrackName.title = mpTrackName.title || "";
  }

  // Sync play/pause icons
  const cpIconPlay = document.querySelector("#cp-icon-play");
  const cpIconPause = document.querySelector("#cp-icon-pause");
  if (cpIconPlay && cpIconPause) {
    cpIconPlay.classList.toggle("hidden", musicPlayer.playing);
    cpIconPause.classList.toggle("hidden", !musicPlayer.playing);
  }

  // Sync playing class on compact player
  const compact = document.getElementById("compact-player");
  if (compact) compact.classList.toggle("playing", musicPlayer.playing);
}

async function initMusicPlayer() {
  const mpPlay = document.querySelector("#mp-play");
  const mpPrev = document.querySelector("#mp-prev");
  const mpNext = document.querySelector("#mp-next");
  mpPlay.addEventListener("click", togglePlay);
  mpPrev.addEventListener("click", playPrevTrack);
  mpNext.addEventListener("click", playNextTrack);

  const dockTrackBar = document.querySelector(".dock-track-bar");
  if (dockTrackBar) {
    dockTrackBar.addEventListener("click", (e) => handleTrackBarSeek(e, dockTrackBar));
  }


  // Wire compact player buttons
  const cpPlay = document.querySelector("#cp-play");
  const cpPrev = document.querySelector("#cp-prev");
  const cpNext = document.querySelector("#cp-next");
  if (cpPlay) cpPlay.addEventListener("click", togglePlay);
  if (cpPrev) cpPrev.addEventListener("click", playPrevTrack);
  if (cpNext) cpNext.addEventListener("click", playNextTrack);

  // Compact player progress bar click-to-seek
  const cpTrackBar = document.querySelector(".cp-track-bar");
  if (cpTrackBar) {
    cpTrackBar.addEventListener("click", (e) => handleTrackBarSeek(e, cpTrackBar));
  }

  // Device media is the only audio source.
  preferences.removeItem("musicSource");
  pollDeviceMedia();
  if (musicPlayer.devicePollTimer) clearInterval(musicPlayer.devicePollTimer);
  musicPlayer.devicePollTimer = setInterval(pollDeviceMedia, 2000);

  // Restore player mode
  const savedMode = localStorage.getItem("playerMode") || "full";
  setPlayerMode(savedMode);
}

async function pollDeviceMedia() {
  if (musicPlayer._devicePollInFlight) return;
  musicPlayer._devicePollInFlight = true;
  let info;
  try {
    info = await app.ipcRenderer.invoke("media:now-playing");
  } catch {
    musicPlayer._devicePollInFlight = false;
    return;
  }
  musicPlayer._devicePollInFlight = false;
  const mpTrackName = document.querySelector("#mp-track-name");

  if (!info) {
    mpTrackName.textContent = "Nothing playing";
    mpTrackName.title = "";
    musicPlayer.playing = false;
    musicPlayer._deviceDuration = 0;
    musicPlayer._devicePosition = 0;
    const dockTrackBar = document.querySelector(".dock-track-bar");
    const cpTrackBar = document.querySelector(".cp-track-bar");
    if (dockTrackBar) dockTrackBar.style.setProperty("--track-progress", "0%");
    if (cpTrackBar) cpTrackBar.style.setProperty("--track-progress", "0%");
    updatePlayButton();
    syncCompactPlayer();
    return;
  }

  mpTrackName.textContent = info.title || "Unknown";
  mpTrackName.title = info.title || "";
  musicPlayer.playing = info.playing;
  musicPlayer._deviceDuration = info.duration;
  musicPlayer._devicePosition = info.position;
  musicPlayer._deviceLastPoll = Date.now();
  updatePlayButton();
  syncCompactPlayer();
}

function togglePlay() {
  musicPlayer.playing = !musicPlayer.playing;
  updatePlayButton();
  app.ipcRenderer.invoke("media:control", { action: "toggle" })
    .then(() => pollDeviceMedia())
    .catch(() => {});
}

function updatePlayButton() {
  const mpIconPlay = document.querySelector("#mp-icon-play");
  const mpIconPause = document.querySelector("#mp-icon-pause");
  const mpTrackName = document.querySelector("#mp-track-name");
  mpIconPlay.classList.toggle("hidden", musicPlayer.playing);
  mpIconPause.classList.toggle("hidden", !musicPlayer.playing);
  mpTrackName.classList.toggle("playing", musicPlayer.playing);
  document.getElementById("music-player").classList.toggle("playing", musicPlayer.playing);
  syncCompactPlayer();
}

function updateTrackProgress() {
  const dockTrackBar = document.querySelector(".dock-track-bar");
  const cpTrackBar = document.querySelector(".cp-track-bar");
  let pctStr = null;

  if (musicPlayer._deviceDuration > 0) {
    let pos = musicPlayer._devicePosition;
    if (musicPlayer.playing && musicPlayer._deviceLastPoll) {
      pos += (Date.now() - musicPlayer._deviceLastPoll) / 1000;
    }
    pctStr = Math.min(100, (pos / musicPlayer._deviceDuration) * 100) + "%";
  }

  if (pctStr) {
    if (dockTrackBar) dockTrackBar.style.setProperty("--track-progress", pctStr);
    if (cpTrackBar) cpTrackBar.style.setProperty("--track-progress", pctStr);
  }
  requestAnimationFrame(updateTrackProgress);
}

function playNextTrack() {
  app.ipcRenderer.invoke("media:control", { action: "next" })
    .then(() => pollDeviceMedia())
    .catch(() => {});
}

function playPrevTrack() {
  app.ipcRenderer.invoke("media:control", { action: "prev" })
    .then(() => pollDeviceMedia())
    .catch(() => {});
}

module.exports = { initMusicPlayer, togglePlay, playNextTrack, playPrevTrack, updateTrackProgress, setPlayerMode };
