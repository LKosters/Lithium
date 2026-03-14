const app = require("./app");
const { shuffleArray } = require("./helpers");

const musicPlayer = {
  audio: new Audio(),
  tracks: [],
  index: -1,
  playing: false,
  source: "lofi",       // "lofi" | "device"
  lofiTracks: [],
  devicePollTimer: null,
};

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

  musicPlayer.audio.addEventListener("ended", () => playNextTrack());

  mpPlay.addEventListener("click", togglePlay);
  mpPrev.addEventListener("click", playPrevTrack);
  mpNext.addEventListener("click", playNextTrack);
  mpVolume.addEventListener("input", () => {
    musicPlayer.audio.volume = parseInt(mpVolume.value, 10) / 100;
  });

  const dockTrackBar = document.querySelector(".dock-track-bar");
  if (dockTrackBar) {
    dockTrackBar.addEventListener("click", (e) => {
      const rect = dockTrackBar.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;

      if (musicPlayer.source === "device") {
        // Seek system media via stored duration
        if (musicPlayer._deviceDuration > 0) {
          const pos = pct * musicPlayer._deviceDuration;
          app.ipcRenderer.invoke("media:control", { action: "seek", position: pos });
        }
      } else {
        if (!musicPlayer.audio.duration) return;
        musicPlayer.audio.currentTime = pct * musicPlayer.audio.duration;
      }
    });
  }

  mpSourceBtn.addEventListener("click", handleSourceToggle);

  // Restore saved source preference
  const savedSource = localStorage.getItem("musicSource");
  if (savedSource === "device") {
    switchToDevice();
  } else if (musicPlayer.tracks.length > 0) {
    musicPlayer.index = 0;
    loadCurrentTrack();
  }
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
  }

  // Reset progress
  const dockTrackBar = document.querySelector(".dock-track-bar");
  if (dockTrackBar) dockTrackBar.style.setProperty("--track-progress", "0%");

  musicPlayer.playing = false;
  updatePlayButton();
}

async function pollDeviceMedia() {
  const info = await app.ipcRenderer.invoke("media:now-playing");
  const mpTrackName = document.querySelector("#mp-track-name");

  if (!info) {
    mpTrackName.textContent = "Nothing playing";
    mpTrackName.title = "";
    musicPlayer.playing = false;
    musicPlayer._deviceDuration = 0;
    musicPlayer._devicePosition = 0;
    const dockTrackBar = document.querySelector(".dock-track-bar");
    if (dockTrackBar) dockTrackBar.style.setProperty("--track-progress", "0%");
    updatePlayButton();
    return;
  }

  mpTrackName.textContent = info.title || "Unknown";
  mpTrackName.title = info.title || "";
  musicPlayer.playing = info.playing;
  musicPlayer._deviceDuration = info.duration;
  musicPlayer._devicePosition = info.position;
  musicPlayer._deviceLastPoll = Date.now();
  updatePlayButton();
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
  musicPlayer.audio.src = "file://" + track.path;
  mpTrackName.textContent = track.name;
  mpTrackName.title = track.name;
}

function togglePlay() {
  if (musicPlayer.source === "device") {
    app.ipcRenderer.invoke("media:control", { action: "toggle" });
    return;
  }

  if (musicPlayer.tracks.length === 0) return;
  if (musicPlayer.playing) {
    musicPlayer.audio.pause();
    musicPlayer.playing = false;
  } else {
    musicPlayer.audio.play();
    musicPlayer.playing = true;
  }
  updatePlayButton();
}

function updatePlayButton() {
  const mpIconPlay = document.querySelector("#mp-icon-play");
  const mpIconPause = document.querySelector("#mp-icon-pause");
  const mpTrackName = document.querySelector("#mp-track-name");
  mpIconPlay.classList.toggle("hidden", musicPlayer.playing);
  mpIconPause.classList.toggle("hidden", !musicPlayer.playing);
  mpTrackName.classList.toggle("playing", musicPlayer.playing);
  document.getElementById("music-player").classList.toggle("playing", musicPlayer.playing);
}

function updateTrackProgress() {
  const dockTrackBar = document.querySelector(".dock-track-bar");
  if (dockTrackBar) {
    if (musicPlayer.source === "lofi") {
      if (musicPlayer.audio.duration) {
        const pct = (musicPlayer.audio.currentTime / musicPlayer.audio.duration) * 100;
        dockTrackBar.style.setProperty("--track-progress", pct + "%");
      }
    } else if (musicPlayer._deviceDuration > 0) {
      // Interpolate position between polls for smooth progress
      let pos = musicPlayer._devicePosition;
      if (musicPlayer.playing && musicPlayer._deviceLastPoll) {
        pos += (Date.now() - musicPlayer._deviceLastPoll) / 1000;
      }
      const pct = Math.min(100, (pos / musicPlayer._deviceDuration) * 100);
      dockTrackBar.style.setProperty("--track-progress", pct + "%");
    }
  }
  requestAnimationFrame(updateTrackProgress);
}

function playNextTrack() {
  if (musicPlayer.source === "device") {
    app.ipcRenderer.invoke("media:control", { action: "next" });
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
    musicPlayer.audio.play();
  }
}

function playPrevTrack() {
  if (musicPlayer.source === "device") {
    app.ipcRenderer.invoke("media:control", { action: "prev" });
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
    musicPlayer.audio.play();
  }
}

module.exports = { initMusicPlayer, togglePlay, playNextTrack, playPrevTrack, updateTrackProgress };
