const { shuffleArray } = require("./helpers");

// ── Rekordbox DJ mode ─────────────────────────────────────────
// Two-deck DJ player that reuses the bundled lofi library, powered
// by the Web Audio API. Each deck has its own audio element, gain
// node, and analyser; a crossfader blends between them into a
// shared master gain before the destination.

const rekordbox = {
  ctx: null,
  master: null,
  masterVol: 0.7,
  xfader: 0.5, // 0 = full A, 1 = full B
  decks: { a: null, b: null },
  rafId: null,
  active: false,
  library: [],
};

// Palette per deck (rekordbox feels: A is blue/cyan, B is warm/red)
const DECK_COLORS = {
  a: { wave: "#3da9fc", glow: "rgba(61,169,252,0.55)", accent: "#7fd3ff" },
  b: { wave: "#e8a838", glow: "rgba(232,168,56,0.55)", accent: "#ffc97a" },
};

function createDeck(id) {
  const audio = new Audio();
  audio.preload = "auto";
  return {
    id,
    audio,
    src: null,           // MediaElementAudioSourceNode
    gain: null,          // per-deck gain (user-controlled GAIN knob)
    xfaderGain: null,    // crossfader contribution
    analyser: null,
    freqData: null,
    timeData: null,
    trackIndex: -1,
    trackName: "— load —",
    playing: false,
    bpm: 0,
    level: 0,            // smoothed VU level (0..1)
    canvas: null,
    canvasCtx: null,
  };
}

function ensureAudioGraph() {
  if (rekordbox.ctx) return;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();

  const master = ctx.createGain();
  master.gain.value = rekordbox.masterVol;
  master.connect(ctx.destination);

  for (const id of ["a", "b"]) {
    const deck = createDeck(id);

    deck.src = ctx.createMediaElementSource(deck.audio);
    deck.gain = ctx.createGain();
    deck.gain.value = 0.8;
    deck.xfaderGain = ctx.createGain();
    deck.xfaderGain.gain.value = equalPowerGain(id, rekordbox.xfader);

    deck.analyser = ctx.createAnalyser();
    deck.analyser.fftSize = 512;
    deck.analyser.smoothingTimeConstant = 0.75;
    deck.freqData = new Uint8Array(deck.analyser.frequencyBinCount);
    deck.timeData = new Uint8Array(deck.analyser.fftSize);

    // audio → deckGain → analyser → xfaderGain → master
    deck.src.connect(deck.gain);
    deck.gain.connect(deck.analyser);
    deck.analyser.connect(deck.xfaderGain);
    deck.xfaderGain.connect(master);

    deck.audio.addEventListener("ended", () => nextTrack(deck));
    deck.audio.addEventListener("error", () => nextTrack(deck));

    rekordbox.decks[id] = deck;
  }

  rekordbox.ctx = ctx;
  rekordbox.master = master;
}

// Equal-power crossfade curve — smoother mix than linear
function equalPowerGain(deckId, xf) {
  // xf: 0 (full A) .. 1 (full B)
  const t = deckId === "a" ? 1 - xf : xf;
  return Math.cos((1 - t) * 0.5 * Math.PI);
}

function applyXfader() {
  const { a, b } = rekordbox.decks;
  if (!a || !b) return;
  const t = rekordbox.ctx ? rekordbox.ctx.currentTime : 0;
  a.xfaderGain.gain.setTargetAtTime(equalPowerGain("a", rekordbox.xfader), t, 0.02);
  b.xfaderGain.gain.setTargetAtTime(equalPowerGain("b", rekordbox.xfader), t, 0.02);
}

// ── Track loading / transport ───────────────────────────────────

function loadTrack(deck, index) {
  if (!rekordbox.library.length) return;
  const n = rekordbox.library.length;
  deck.trackIndex = ((index % n) + n) % n;
  const track = rekordbox.library[deck.trackIndex];
  deck.trackName = track.name;
  deck.audio.src = "media://" + track.path;
  deck.audio.load();
  // Assign a pseudo-BPM derived from the filename so it's stable per track.
  deck.bpm = derivePseudoBpm(track.name);
  updateDeckUI(deck);
}

function derivePseudoBpm(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return 86 + Math.abs(h) % 42; // 86..127
}

function nextTrack(deck) {
  loadTrack(deck, deck.trackIndex + 1);
  if (deck.playing) playDeck(deck);
}

function prevTrack(deck) {
  if (deck.audio.currentTime > 3) {
    deck.audio.currentTime = 0;
    return;
  }
  loadTrack(deck, deck.trackIndex - 1);
  if (deck.playing) playDeck(deck);
}

function playDeck(deck) {
  if (rekordbox.ctx && rekordbox.ctx.state === "suspended") {
    rekordbox.ctx.resume().catch(() => {});
  }
  deck.audio.play().then(() => {
    deck.playing = true;
    updateDeckUI(deck);
  }).catch(() => {
    deck.playing = false;
    updateDeckUI(deck);
  });
}

function pauseDeck(deck) {
  deck.audio.pause();
  deck.playing = false;
  updateDeckUI(deck);
}

function toggleDeck(deck) {
  if (deck.playing) pauseDeck(deck);
  else playDeck(deck);
}

function cueDeck(deck) {
  deck.audio.currentTime = 0;
  if (!deck.playing) {
    deck.canvas && flashPlayhead(deck);
  }
}

// ── UI updates ───────────────────────────────────────────────

function updateDeckUI(deck) {
  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;
  const titleEl = panel.querySelector(`.rb-deck-title[data-deck="${deck.id}"]`);
  const bpmEl = panel.querySelector(`.rb-deck-bpm[data-deck="${deck.id}"]`);
  const playBtn = panel.querySelector(`.rb-play[data-deck="${deck.id}"]`);

  if (titleEl) {
    titleEl.textContent = deck.trackName || "— load —";
    titleEl.title = deck.trackName || "";
  }
  if (bpmEl) bpmEl.textContent = deck.bpm ? `${deck.bpm} BPM` : "--- BPM";
  if (playBtn) {
    playBtn.classList.toggle("playing", deck.playing);
    const iconPlay = playBtn.querySelector(".rb-icon-play");
    const iconPause = playBtn.querySelector(".rb-icon-pause");
    if (iconPlay) iconPlay.classList.toggle("hidden", deck.playing);
    if (iconPause) iconPause.classList.toggle("hidden", !deck.playing);
  }
  const deckEl = panel.querySelector(`.rb-deck-${deck.id}`);
  if (deckEl) deckEl.classList.toggle("playing", deck.playing);
}

function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function flashPlayhead(deck) {
  if (!deck.canvas) return;
  deck.canvas.parentElement.classList.add("cue-flash");
  setTimeout(() => deck.canvas && deck.canvas.parentElement.classList.remove("cue-flash"), 280);
}

// ── Rendering (waveform + VU) ────────────────────────────────

function resizeCanvas(deck) {
  const canvas = deck.canvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  deck.canvasCtx = canvas.getContext("2d");
  deck.canvasCtx.scale(dpr, dpr);
}

function drawDeck(deck) {
  const ctx = deck.canvasCtx;
  const canvas = deck.canvas;
  if (!ctx || !canvas) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  const colors = DECK_COLORS[deck.id];
  deck.analyser.getByteTimeDomainData(deck.timeData);
  deck.analyser.getByteFrequencyData(deck.freqData);

  // Background — subtle grid
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(12,11,9,0.9)";
  ctx.fillRect(0, 0, w, h);

  // Horizontal mid-line
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Frequency bars behind the waveform — rekordbox "energy" feel
  const bins = deck.freqData.length;
  const barCount = Math.min(64, Math.floor(w / 4));
  const barW = w / barCount;
  let total = 0;
  for (let i = 0; i < barCount; i++) {
    const bin = Math.floor((i / barCount) * bins * 0.7); // skip high hiss
    const v = deck.freqData[bin] / 255;
    total += v;
    const bh = v * h * 0.9;
    const grad = ctx.createLinearGradient(0, h / 2 - bh / 2, 0, h / 2 + bh / 2);
    grad.addColorStop(0, colors.accent);
    grad.addColorStop(0.5, colors.wave);
    grad.addColorStop(1, colors.accent);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(i * barW + 1, h / 2 - bh / 2, barW - 2, bh);
  }
  ctx.globalAlpha = 1;

  // Smooth VU level (RMS-ish from freq data)
  const avg = total / barCount;
  deck.level = deck.level * 0.75 + avg * 0.25;

  // Time-domain waveform on top
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.wave;
  ctx.shadowColor = colors.glow;
  ctx.shadowBlur = deck.playing ? 8 : 0;
  ctx.beginPath();
  const samples = deck.timeData.length;
  const step = w / samples;
  for (let i = 0; i < samples; i++) {
    const v = (deck.timeData[i] - 128) / 128; // -1..1
    const x = i * step;
    const y = h / 2 + v * (h / 2) * 0.95;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Idle state: dim the whole canvas
  if (!deck.playing) {
    ctx.fillStyle = "rgba(12,11,9,0.45)";
    ctx.fillRect(0, 0, w, h);
  }
}

function updateVuBar(deck) {
  const bar = document.querySelector(`.rb-vu-bar[data-deck="${deck.id}"]`);
  if (!bar) return;
  // Boost perceived level slightly and clamp
  const pct = Math.min(1, deck.level * 1.6);
  bar.style.setProperty("--rb-vu", `${pct * 100}%`);
}

function updateTimeAndPlayhead(deck) {
  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;
  const timeEl = panel.querySelector(`.rb-deck-time[data-deck="${deck.id}"]`);
  const dur = deck.audio.duration || 0;
  const cur = deck.audio.currentTime || 0;
  if (timeEl) timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;

  const deckEl = panel.querySelector(`.rb-deck-${deck.id}`);
  const head = deckEl && deckEl.querySelector(".rb-playhead");
  if (head && dur > 0) {
    const pct = Math.min(100, (cur / dur) * 100);
    head.style.left = pct + "%";
  }
}

function renderLoop() {
  if (!rekordbox.active) return;
  for (const id of ["a", "b"]) {
    const deck = rekordbox.decks[id];
    if (!deck) continue;
    drawDeck(deck);
    updateVuBar(deck);
    updateTimeAndPlayhead(deck);
  }
  rekordbox.rafId = requestAnimationFrame(renderLoop);
}

// ── Activation / wiring ─────────────────────────────────────

function activateRekordbox() {
  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;

  ensureAudioGraph();
  bindCanvasesToDecks();

  // Seed both decks with different starting tracks from the shuffled library
  if (rekordbox.library.length) {
    const shuffled = shuffleArray(rekordbox.library.slice());
    rekordbox.library = shuffled;
    const a = rekordbox.decks.a;
    const b = rekordbox.decks.b;
    if (a.trackIndex < 0) loadTrack(a, 0);
    if (b.trackIndex < 0) loadTrack(b, Math.min(1, shuffled.length - 1));
  }

  // Sync initial crossfader + gain knob positions to current DOM values
  const xfader = document.getElementById("rb-xfader");
  if (xfader) rekordbox.xfader = parseInt(xfader.value, 10) / 100;
  applyXfader();

  const masterVol = document.getElementById("rb-master-vol");
  if (masterVol && rekordbox.master) {
    rekordbox.masterVol = parseInt(masterVol.value, 10) / 100;
    rekordbox.master.gain.value = rekordbox.masterVol;
  }

  panel.querySelectorAll(".rb-gain").forEach((input) => {
    const deck = rekordbox.decks[input.dataset.deck];
    if (deck && deck.gain) deck.gain.gain.value = parseInt(input.value, 10) / 100;
  });

  panel.classList.remove("hidden");
  rekordbox.active = true;

  // Size canvases after they become visible
  requestAnimationFrame(() => {
    for (const id of ["a", "b"]) {
      const deck = rekordbox.decks[id];
      if (deck && deck.canvas) resizeCanvas(deck);
    }
    if (rekordbox.rafId == null) rekordbox.rafId = requestAnimationFrame(renderLoop);
  });
}

function deactivateRekordbox() {
  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;
  panel.classList.add("hidden");
  rekordbox.active = false;

  // Pause both decks, keep their graph intact for fast re-entry
  for (const id of ["a", "b"]) {
    const deck = rekordbox.decks[id];
    if (deck && deck.playing) pauseDeck(deck);
  }
  if (rekordbox.rafId != null) {
    cancelAnimationFrame(rekordbox.rafId);
    rekordbox.rafId = null;
  }
}

function isActive() { return rekordbox.active; }

function bindCanvasesToDecks() {
  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;
  for (const id of ["a", "b"]) {
    const deck = rekordbox.decks[id];
    if (!deck) continue;
    if (!deck.canvas) {
      deck.canvas = panel.querySelector(`canvas.rb-waveform[data-deck="${id}"]`);
    }
  }
}

function withDeck(fn) {
  return (btn) => {
    ensureAudioGraph();
    bindCanvasesToDecks();
    const deck = rekordbox.decks[btn.dataset.deck];
    if (deck) fn(deck);
  };
}

function initRekordbox(library) {
  rekordbox.library = library || [];

  const panel = document.getElementById("rekordbox-panel");
  if (!panel) return;

  // Per-deck transport buttons — instantiate audio graph lazily on first interaction
  panel.querySelectorAll(".rb-play").forEach((btn) => {
    btn.addEventListener("click", () => withDeck(toggleDeck)(btn));
  });
  panel.querySelectorAll(".rb-prev").forEach((btn) => {
    btn.addEventListener("click", () => withDeck(prevTrack)(btn));
  });
  panel.querySelectorAll(".rb-next").forEach((btn) => {
    btn.addEventListener("click", () => withDeck(nextTrack)(btn));
  });
  panel.querySelectorAll(".rb-cue").forEach((btn) => {
    btn.addEventListener("click", () => withDeck(cueDeck)(btn));
  });

  // Gain knobs
  panel.querySelectorAll(".rb-gain").forEach((input) => {
    input.addEventListener("input", () => {
      ensureAudioGraph();
      const deck = rekordbox.decks[input.dataset.deck];
      if (!deck) return;
      const v = parseInt(input.value, 10) / 100;
      const t = rekordbox.ctx ? rekordbox.ctx.currentTime : 0;
      deck.gain.gain.setTargetAtTime(v, t, 0.02);
    });
  });

  // Waveform click → seek
  panel.querySelectorAll(".rb-wave-wrap").forEach((wrap) => {
    wrap.addEventListener("click", (e) => {
      ensureAudioGraph();
      const deckEl = wrap.closest(".rb-deck");
      if (!deckEl) return;
      const id = deckEl.dataset.deck;
      const deck = rekordbox.decks[id];
      if (!deck || !deck.audio.duration) return;
      const rect = wrap.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      deck.audio.currentTime = Math.max(0, Math.min(deck.audio.duration, pct * deck.audio.duration));
    });
  });

  // Crossfader
  const xfader = document.getElementById("rb-xfader");
  if (xfader) {
    xfader.addEventListener("input", () => {
      rekordbox.xfader = parseInt(xfader.value, 10) / 100;
      if (rekordbox.ctx) applyXfader();
    });
  }

  // Master volume
  const masterVol = document.getElementById("rb-master-vol");
  if (masterVol) {
    masterVol.addEventListener("input", () => {
      rekordbox.masterVol = parseInt(masterVol.value, 10) / 100;
      if (rekordbox.master) {
        const t = rekordbox.ctx.currentTime;
        rekordbox.master.gain.setTargetAtTime(rekordbox.masterVol, t, 0.02);
      }
    });
  }

  // Resize redraw
  window.addEventListener("resize", () => {
    if (!rekordbox.active) return;
    for (const id of ["a", "b"]) {
      const deck = rekordbox.decks[id];
      if (deck && deck.canvas) resizeCanvas(deck);
    }
  });
}

module.exports = {
  initRekordbox,
  activateRekordbox,
  deactivateRekordbox,
  isActive,
};
