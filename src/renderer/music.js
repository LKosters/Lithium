const app = require("./app");
const { shuffleArray } = require("./helpers");

const _audio = new Audio();
_audio.preload = "auto";

// Shared seek handler for both dock and compact track bars
function handleTrackBarSeek(e, trackBar) {
  const rect = trackBar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (musicPlayer.source === "device") {
    if (musicPlayer._deviceDuration > 0) {
      const pos = pct * musicPlayer._deviceDuration;
      app.ipcRenderer.invoke("media:control", { action: "seek", position: pos });
    }
  } else {
    if (!musicPlayer.audio.duration) return;
    musicPlayer.audio.currentTime = pct * musicPlayer.audio.duration;
  }
}

const musicPlayer = {
  audio: _audio,
  tracks: [],
  index: -1,
  playing: false,
  source: "lofi",       // "lofi" | "device"
  lofiTracks: [],
  devicePollTimer: null,
  _devicePollInFlight: false,
};

// ── Player mode (full / compact / none) ──────────────

function setPlayerMode(mode) {
  const dock = document.getElementById("music-dock");
  const compact = document.getElementById("compact-player");
  if (!dock || !compact) return;

  dock.classList.toggle("hidden", mode !== "full");
  compact.classList.toggle("hidden", mode !== "compact");
  musicPlayer.mode = mode;
  localStorage.setItem("playerMode", mode);
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
  const mpVolume = document.querySelector("#mp-volume");
  const mpSourceBtn = document.querySelector("#mp-source-btn");

  const tracks = await app.ipcRenderer.invoke("music:list");
  musicPlayer.lofiTracks = tracks || [];
  musicPlayer.tracks = shuffleArray(musicPlayer.lofiTracks);
  musicPlayer.audio.volume = parseInt(mpVolume.value, 10) / 100;

  musicPlayer.audio.addEventListener("ended", () => { playNextTrack(); });

  // If a track fails to load/decode, skip to the next one
  musicPlayer.audio.addEventListener("error", () => {
    if (musicPlayer.playing && musicPlayer.source === "lofi") {
      playNextTrack();
    }
  });

  mpPlay.addEventListener("click", togglePlay);
  mpPrev.addEventListener("click", playPrevTrack);
  mpNext.addEventListener("click", playNextTrack);
  mpVolume.addEventListener("input", () => {
    musicPlayer.audio.volume = parseInt(mpVolume.value, 10) / 100;
  });

  const dockTrackBar = document.querySelector(".dock-track-bar");
  if (dockTrackBar) {
    dockTrackBar.addEventListener("click", (e) => handleTrackBarSeek(e, dockTrackBar));
  }

  mpSourceBtn.addEventListener("click", handleSourceToggle);

  // Wire compact player buttons
  const cpPlay = document.querySelector("#cp-play");
  const cpPrev = document.querySelector("#cp-prev");
  const cpNext = document.querySelector("#cp-next");
  const cpSourceBtn = document.querySelector("#cp-source-btn");
  if (cpPlay) cpPlay.addEventListener("click", togglePlay);
  if (cpPrev) cpPrev.addEventListener("click", playPrevTrack);
  if (cpNext) cpNext.addEventListener("click", playNextTrack);
  if (cpSourceBtn) cpSourceBtn.addEventListener("click", handleSourceToggle);

  // Compact player progress bar click-to-seek
  const cpTrackBar = document.querySelector(".cp-track-bar");
  if (cpTrackBar) {
    cpTrackBar.addEventListener("click", (e) => handleTrackBarSeek(e, cpTrackBar));
  }

  // Restore saved source preference
  const savedSource = localStorage.getItem("musicSource");
  if (savedSource === "device") {
    switchToDevice();
  } else if (musicPlayer.tracks.length > 0) {
    musicPlayer.index = 0;
    loadCurrentTrack();
  }

  // Restore player mode
  const savedMode = localStorage.getItem("playerMode") || "full";
  setPlayerMode(savedMode);
}

// ── Source switching ───────────────────────────────────

async function handleSourceToggle() {
  if (musicPlayer.source === "lofi") {
    switchToDevice();
  } else {
    switchToLofi();
  }
}

function switchToDevice() {
  // Stop lofi playback
  if (musicPlayer.playing) {
    musicPlayer.audio.pause();
    musicPlayer.playing = false;
    updatePlayButton();
  }

  musicPlayer.source = "device";
  localStorage.setItem("musicSource", "device");
  musicPlayer._deviceDuration = 0;
  musicPlayer._devicePosition = 0;
  musicPlayer._deviceLastPoll = 0;
  updateSourceButton();

  // Start polling system media
  pollDeviceMedia();
  musicPlayer.devicePollTimer = setInterval(pollDeviceMedia, 2000);
}

function switchToLofi() {
  // Stop device polling
  if (musicPlayer.devicePollTimer) {
    clearInterval(musicPlayer.devicePollTimer);
    musicPlayer.devicePollTimer = null;
  }

  musicPlayer.source = "lofi";
  localStorage.setItem("musicSource", "lofi");
  musicPlayer.tracks = shuffleArray(musicPlayer.lofiTracks);
  updateSourceButton();

  if (musicPlayer.tracks.length > 0) {
    musicPlayer.index = 0;
    loadCurrentTrack();
  } else {
    document.querySelector("#mp-track-name").textContent = "No music";
    syncCompactPlayer();
  }

  // Reset progress
  const dockTrackBar = document.querySelector(".dock-track-bar");
  const cpTrackBar = document.querySelector(".cp-track-bar");
  if (dockTrackBar) dockTrackBar.style.setProperty("--track-progress", "0%");
  if (cpTrackBar) cpTrackBar.style.setProperty("--track-progress", "0%");

  musicPlayer.playing = false;
  updatePlayButton();
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
  // Ignore stale response if source changed while polling
  if (musicPlayer.source !== "device") return;
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

function updateSourceButton() {
  const mpSourceBtn = document.querySelector("#mp-source-btn");
  const iconLofi = document.querySelector("#mp-source-icon-lofi");
  const iconDevice = document.querySelector("#mp-source-icon-device");
  const label = document.querySelector("#mp-source-label");

  const isDevice = musicPlayer.source === "device";
  iconLofi.classList.toggle("hidden", isDevice);
  iconDevice.classList.toggle("hidden", !isDevice);
  label.textContent = isDevice ? "Device" : "Lofi";
  mpSourceBtn.classList.toggle("active", isDevice);

  // Sync compact player source button
  const cpSourceBtn = document.querySelector("#cp-source-btn");
  const cpIconLofi = document.querySelector("#cp-source-icon-lofi");
  const cpIconDevice = document.querySelector("#cp-source-icon-device");
  if (cpSourceBtn) cpSourceBtn.classList.toggle("active", isDevice);
  if (cpIconLofi) cpIconLofi.classList.toggle("hidden", isDevice);
  if (cpIconDevice) cpIconDevice.classList.toggle("hidden", !isDevice);

  // Hide/show volume (doesn't apply to device)
  const mpVolume = document.querySelector("#mp-volume");
  const volumeIcon = document.querySelector(".volume-icon");
  mpVolume.style.display = isDevice ? "none" : "";
  volumeIcon.style.display = isDevice ? "none" : "";
}

// ── Lofi playback ─────────────────────────────────────

function loadCurrentTrack() {
  const track = musicPlayer.tracks[musicPlayer.index];
  if (!track) return;
  const mpTrackName = document.querySelector("#mp-track-name");
  musicPlayer.audio.src = "media://" + track.path;
  musicPlayer.audio.load();
  mpTrackName.textContent = track.name;
  mpTrackName.title = track.name;
  syncCompactPlayer();
}

function togglePlay() {
  if (musicPlayer.source === "device") {
    // Update UI immediately so the button feels instant
    musicPlayer.playing = !musicPlayer.playing;
    updatePlayButton();
    app.ipcRenderer.invoke("media:control", { action: "toggle" })
      .then(() => pollDeviceMedia())
      .catch(() => {});
    return;
  }

  if (musicPlayer.tracks.length === 0) return;
  if (musicPlayer.playing) {
    musicPlayer.audio.pause();
    musicPlayer.playing = false;
    updatePlayButton();
  } else {
    // Update UI immediately for responsiveness, revert if play fails
    musicPlayer.playing = true;
    updatePlayButton();
    musicPlayer.audio.play().catch(() => {
      musicPlayer.playing = false;
      updatePlayButton();
    });
  }
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

  if (musicPlayer.source === "lofi") {
    if (musicPlayer.audio.duration) {
      pctStr = (musicPlayer.audio.currentTime / musicPlayer.audio.duration) * 100 + "%";
    }
  } else if (musicPlayer._deviceDuration > 0) {
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
  if (musicPlayer.source === "device") {
    app.ipcRenderer.invoke("media:control", { action: "next" })
      .then(() => pollDeviceMedia())
      .catch(() => {});
    return;
  }

  if (musicPlayer.tracks.length === 0) return;
  musicPlayer.index++;
  if (musicPlayer.index >= musicPlayer.tracks.length) {
    const lastTrack = musicPlayer.tracks[musicPlayer.tracks.length - 1];
    musicPlayer.tracks = shuffleArray(musicPlayer.tracks);
    if (musicPlayer.tracks.length > 1 && musicPlayer.tracks[0] === lastTrack) {
      const swapIdx = 1 + Math.floor(Math.random() * (musicPlayer.tracks.length - 1));
      [musicPlayer.tracks[0], musicPlayer.tracks[swapIdx]] = [musicPlayer.tracks[swapIdx], musicPlayer.tracks[0]];
    }
    musicPlayer.index = 0;
  }
  loadCurrentTrack();
  if (musicPlayer.playing) {
    musicPlayer.audio.play().catch(() => {});
  }
}

function playPrevTrack() {
  if (musicPlayer.source === "device") {
    app.ipcRenderer.invoke("media:control", { action: "prev" })
      .then(() => pollDeviceMedia())
      .catch(() => {});
    return;
  }

  if (musicPlayer.tracks.length === 0) return;
  if (musicPlayer.audio.currentTime > 3) {
    musicPlayer.audio.currentTime = 0;
    return;
  }
  musicPlayer.index = (musicPlayer.index - 1 + musicPlayer.tracks.length) % musicPlayer.tracks.length;
  loadCurrentTrack();
  if (musicPlayer.playing) {
    musicPlayer.audio.play().catch(() => {});
  }
}

module.exports = { initMusicPlayer, togglePlay, playNextTrack, playPrevTrack, updateTrackProgress, setPlayerMode };
