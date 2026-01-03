// skewclid.js

(function(){
  "use strict";

  // -----------------------------
  // Skewclid behavior flags (health-check defaults)
  //   - Override by defining `window.SKEWCLID_OPTS` *before* this script loads.
  //   - These switches let you ship a "fixed" release without breaking legacy behavior.
  // -----------------------------
  const SKEWCLID_OPTS = (() => {
    const defaults = {
      euclidAlgorithm: "correct",   // "correct" | "legacy"
      skewTiming: "v2",             // "v2" | "legacy"
      skewGate: "all",       // "legacyHalf" | "all" | "none"
      skewCurvesUseTime: true       // if true: in skew mode, curves use (ofs/A) instead of event index
    };
    const user = (typeof window !== "undefined" &&
                  window.SKEWCLID_OPTS &&
                  typeof window.SKEWCLID_OPTS === "object")
      ? window.SKEWCLID_OPTS
      : {};
    return Object.assign({}, defaults, user);
  })();

  function _clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  // ─────────────────────────────────────────────────────────────
  // Cycle‑lock (Tidal‑like) mode
  //   - When enabled, ALL tracks share one master loop length (cycleBeats).
  //   - A/B still defines the internal rhythm, but timing is "squeezed" into the same cycle.
  //   - Stored in localStorage.
  // ─────────────────────────────────────────────────────────────
  const CYCLE_MODE_KEY  = "skewclidCycleMode";   // "0" | "1"
  const CYCLE_BEATS_KEY = "skewclidCycleBeats";  // integer
  const CYCLE_BEATS_CHOICES = [4, 8, 12, 16, 24, 32, 48, 64];

  let cycleMode  = false; // false = legacy LCM super-loop, true = single fixed cycle
  let cycleBeats = 16;    // master cycle length in beats (when cycleMode is enabled)

  (function _loadCyclePrefs(){
    try { cycleMode = (localStorage.getItem(CYCLE_MODE_KEY) === "1"); } catch (_) {}
    try {
      const b = parseInt(localStorage.getItem(CYCLE_BEATS_KEY), 10);
      if (Number.isFinite(b) && b > 0) cycleBeats = b;
    } catch (_) {}
  })();



  // -----------------------------
  // Tone.js lazy-loader (Skewclid only)
  //   - Avoids "AudioContext not allowed to start" warnings on page-load
  //   - Loads on Skewclid open / Start click (user gesture)
  // -----------------------------
  const TONE_VERSION_PIN = "15.1.22"; // bump after testing
  const TONE_URL_PINNED = `https://cdn.jsdelivr.net/npm/tone@${TONE_VERSION_PIN}/build/Tone.js`;
  const TONE_URL_PINNED_FALLBACK = `https://unpkg.com/tone@${TONE_VERSION_PIN}/build/Tone.js`;
  const TONE_URL_LATEST = "https://cdn.jsdelivr.net/npm/tone@latest/build/Tone.js";

  let _toneLoadPromise = null;
  let _toneTransportWired = false;
  let _pendingBpm = null;

  function _skewclidPreferToneLatest() {
    try {
      return /[?&]tone=latest\b/i.test(location.search) || localStorage.getItem("toneLatest") === "1";
    } catch (_) {
      return /[?&]tone=latest\b/i.test(location.search);
    }
  }

  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error("Missing script src"));

      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset && existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }

      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.addEventListener("load", () => {
        try { s.dataset.loaded = "true"; } catch (_) {}
        resolve();
      }, { once: true });
      s.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
      document.head.appendChild(s);
    });
  }

  function _validateTone() {
    const T = window.Tone;
    if (!T) throw new Error("Tone missing");
    if (!T.Transport) throw new Error("Tone.Transport missing");
    if (typeof T.start !== "function") throw new Error("Tone.start missing");
    if (typeof T.now !== "function") throw new Error("Tone.now missing");
    if (typeof T.Part !== "function") throw new Error("Tone.Part missing");
    if (!T.Draw || typeof T.Draw.schedule !== "function") throw new Error("Tone.Draw.schedule missing");
    if (!T.Transport.bpm) throw new Error("Tone.Transport.bpm missing");
  }

  async function ensureToneLoaded() {
    if (window.Tone) return window.Tone;
    if (_toneLoadPromise) return _toneLoadPromise;

    const preferLatest = _skewclidPreferToneLatest();
    const candidates = preferLatest
      ? [TONE_URL_LATEST, TONE_URL_PINNED, TONE_URL_PINNED_FALLBACK]
      : [TONE_URL_PINNED, TONE_URL_PINNED_FALLBACK, TONE_URL_LATEST];

    _toneLoadPromise = (async () => {
      let lastErr = null;
      for (const url of candidates) {
        try {
          await _loadScript(url);
          _validateTone();
          return window.Tone;
        } catch (e) {
          lastErr = e;
        }
      }
      _toneLoadPromise = null;
      throw lastErr || new Error("Failed to load Tone.js");
    })();

    return _toneLoadPromise;
  }

  function wireToneTransportOnce() {
    if (_toneTransportWired) return;
    if (!window.Tone || !Tone.Transport || typeof Tone.Transport.on !== "function") return;
    _toneTransportWired = true;

    Tone.Transport.on("loopEnd", () => {
      if (window.Tone && Tone.Transport && Tone.Transport.state === "started") {
        if (cycleMode) return; // cycle mode doesn't need forced per-loop rescheduling
        const master = calculateMasterLoopLength();
        tracks.forEach((t) => {
          stopTrack(t);
          t.stepIndex = 0;
        });
        tracks.forEach((t) => startTrack(t, master, isTransportReverse));
      }
    });
  }

  async function ensureToneStarted() {
    await ensureToneLoaded();
    wireToneTransportOnce();

    // Apply any pending BPM before we start/resume the audio context.
    if (_pendingBpm != null) {
      try { Tone.Transport.bpm.value = Number(_pendingBpm) || 60; } catch (_) {}
    }

    if (!toneInitialized) {
      await Tone.start(); // must be called from a user gesture
      toneInitialized = true;
    } else {
      // Some browsers can suspend again; try to resume.
      try { await Tone.context?.resume?.(); } catch (_) {}
    }

    // Re-apply BPM post-start (Tone can clamp/normalize).
    if (_pendingBpm != null) {
      try { Tone.Transport.bpm.value = Number(_pendingBpm) || 60; } catch (_) {}
    }

    return window.Tone;
  }

  // Expose a preload hook so the shell can warm Tone up on panel-open (user gesture).
  window.preloadToneForSkewclid = function preloadToneForSkewclid() {
    ensureToneLoaded().catch((e) => console.warn("[Skewclid] Tone preload failed", e));
  };


  // ── 1. GCD & LCM utilities ──────────────────────────
  function calculateGCD(a, b) {
    return b ? calculateGCD(b, a % b) : a;
  }
  function calculateLCM(a, b) {
    return (a * b) / calculateGCD(a, b);
  }

  // ── 1b. BigInt GCD/LCM (for long, speed-aware super-loops) ─────────
  function calculateGCDBigInt(a, b) {
    a = BigInt(a);
    b = BigInt(b);
    while (b !== 0n) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a < 0n ? -a : a;
  }
  function calculateLCMBigInt(a, b) {
    a = BigInt(a);
    b = BigInt(b);
    if (a === 0n || b === 0n) return 0n;
    return (a / calculateGCDBigInt(a, b)) * b;
  }

  // Convert a decimal string ("1", "1.25", "0.05") to a reduced BigInt fraction.
  function decimalStringToFraction(str) {
    const s = String(str || "").trim();
    if (!s) return { num: 1n, den: 1n };
    if (!s.includes(".")) {
      // Integer
      try {
        return { num: BigInt(s), den: 1n };
      } catch {
        return { num: 1n, den: 1n };
      }
    }
    const [ip, fpRaw] = s.split(".");
    const fp = (fpRaw || "").replace(/[^0-9]/g, "");
    const intPart = (ip || "0").replace(/[^0-9-]/g, "");
    const den = 10n ** BigInt(fp.length || 1);
    const numStr = `${intPart}${fp}`.replace(/^(-?)0+(\d)/, "$1$2");
    let num;
    try {
      num = BigInt(numStr || "0");
    } catch {
      return { num: 1n, den: 1n };
    }
    const g = calculateGCDBigInt(num, den);
    return { num: num / g, den: den / g };
  }

  // Per-track loop length as a reduced fraction of beats.
  // - In euclid mode (A<=B): loop is B beats at speed=1
  // - In skew mode (A>B):   loop is A beats at speed=1
  // - Speed scales loop length: beats = len / speed
  function getTrackLoopBeatsFraction(track) {
    const A = parseInt(track.aSlider.value, 10) || 1;
    const B = parseInt(track.bSlider.value, 10) || 1;
    const len = (A <= B) ? B : A;
    const sp = decimalStringToFraction(track.speedSlider.value);
    // speed = sp.num/sp.den  =>  beats = len / speed = len * sp.den / sp.num
    let num = BigInt(len) * sp.den;
    let den = sp.num === 0n ? 1n : sp.num;
    const g = calculateGCDBigInt(num, den);
    num /= g;
    den /= g;
    return { num, den };
  }

  // Find the least common multiple of multiple rational beat lengths.
  // Returns {num, den} where beats = num/den.
  function computeMasterLoopBeatsFraction() {
    // Cycle-lock mode: fixed master loop length (Tidal-style "cycle")
    if (cycleMode) {
      const b = Math.max(1, (parseInt(cycleBeats, 10) || 16));
      return { num: BigInt(b), den: 1n };
    }

    if (!tracks.length) return { num: 1n, den: 1n };

    const fracs = tracks.map(getTrackLoopBeatsFraction);
    const commonDen = fracs.reduce((acc, f) => calculateLCMBigInt(acc, f.den), 1n);
    const ints = fracs.map(f => f.num * (commonDen / f.den)); // integers
    const commonNum = ints.reduce((acc, v) => calculateLCMBigInt(acc, v), 1n);
    const g = calculateGCDBigInt(commonNum, commonDen);
    return { num: commonNum / g, den: commonDen / g };
  }

  function bigFractionToNumber(num, den) {
    // Best-effort float conversion (used for Transport loopEnd & UI). For huge values
    // this will lose precision, but remains deterministic for typical musical ranges.
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    return n / d;
  }

  function formatSeconds(secs) {
    if (!Number.isFinite(secs) || secs < 0) return "—";
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  // Loop scrubber UI state
  let _masterLoopBeatsNum = 1n;
  let _masterLoopBeatsDen = 1n;
  let _masterLoopSeconds  = 0;
  let _loopScrubSlider    = null;
  let _loopScrubInfo      = null;
  let _loopScrubPos       = null;
  let _loopScrubPendingSec = 0;
  let _loopScrubIsScrubbing = false;
  let _loopScrubRAF = 0;

  function getCurrentBpm() {
    if (window.Tone && Tone.Transport && Tone.Transport.bpm) {
      const v = Number(Tone.Transport.bpm.value);
      return Number.isFinite(v) && v > 0 ? v : 60;
    }
    if (globalBpmSlider) {
      const v = parseInt(globalBpmSlider.value, 10);
      return Number.isFinite(v) && v > 0 ? v : 60;
    }
    return 60;
  }

  function updateLoopScrubLabels(previewSeconds = null) {
    if (!_loopScrubInfo) return;
    const bpm = getCurrentBpm();
    const beats = bigFractionToNumber(_masterLoopBeatsNum, _masterLoopBeatsDen);
    const loopSecs = beats > 0 ? (beats * 60 / bpm) : 0;
    _masterLoopSeconds = loopSecs;

    // Loop length label
    const beatsStr = (_masterLoopBeatsNum % _masterLoopBeatsDen === 0n)
      ? `${(_masterLoopBeatsNum / _masterLoopBeatsDen).toString()}`
      : `${beats.toFixed(3)}`;
    _loopScrubInfo.textContent = `Loop: ${beatsStr} beats  ·  ~${formatSeconds(loopSecs)} @ ${Math.round(bpm)} BPM`;

    // Position label
    if (_loopScrubPos) {
      const sec = (previewSeconds != null) ? previewSeconds : (window.Tone && Tone.Transport ? Tone.Transport.seconds : 0);
      const pos = (loopSecs > 0) ? (((sec % loopSecs) + loopSecs) % loopSecs) : 0;
      const posBeats = (bpm > 0) ? (pos * bpm / 60) : 0;
      _loopScrubPos.textContent = `Pos: ${posBeats.toFixed(2)} beats`;
    }
  }

  function startLoopScrubRAF() {
    if (_loopScrubRAF) cancelAnimationFrame(_loopScrubRAF);
    const tick = () => {
      if (_loopScrubSlider && !_loopScrubIsScrubbing) {
        // Keep slider tracking Transport when running, or pending seek when stopped.
        const bpm = getCurrentBpm();
        const loopSecs = _masterLoopSeconds;
        if (loopSecs > 0) {
          let sec = _loopScrubPendingSec;
          if (window.Tone && Tone.Transport) {
            const st = Tone.Transport.state;
            if (st === "started" || st === "paused") {
              sec = Tone.Transport.seconds;
            }
          }
          const pos = (((sec % loopSecs) + loopSecs) % loopSecs);
          _loopScrubSlider.value = String(pos / loopSecs);
          updateLoopScrubLabels(sec);
        }
      }
      _loopScrubRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  function seekTransportToFraction(frac) {
    const f = Math.min(1, Math.max(0, Number(frac) || 0));
    const loopSecs = _masterLoopSeconds;
    if (!(loopSecs > 0)) return;
    const targetSec = f * loopSecs;
    _loopScrubPendingSec = targetSec;

    // If Tone isn't started yet, just cache the offset.
    if (!window.Tone || !toneInitialized) {
      updateLoopScrubLabels(targetSec);
      return;
    }

    const st = Tone.Transport.state;
    const wasStarted = (st === "started");
    const wasPaused  = (st === "paused");

    // Seeking while playing: pause → set seconds → resume
    if (wasStarted) {
      Tone.Transport.pause();
    }
    Tone.Transport.seconds = targetSec;

    // Don't change play/pause state (if paused, remain paused)
    if (wasStarted && !wasPaused) {
      Tone.Transport.start();
    }

    updateLoopScrubLabels(targetSec);
  }

  // Master loop length across all tracks (speed-aware).
  // Returns loop length in beats (float approximation), but also updates:
  //   - _masterLoopBeatsNum/_masterLoopBeatsDen (exact BigInt fraction)
  //   - Tone.Transport.loopEnd (seconds)
  //   - loop scrubber UI labels
  function calculateMasterLoopLength() {
    const frac = computeMasterLoopBeatsFraction();
    _masterLoopBeatsNum = frac.num;
    _masterLoopBeatsDen = frac.den;

    // Update UI first (also computes _masterLoopSeconds from BPM)
    updateLoopScrubLabels();

    // Only touch Tone.Transport if Tone exists
    if (window.Tone && Tone.Transport) {
      Tone.Transport.loop = true;
      Tone.Transport.loopStart = 0;
      // Use seconds so fractional beat lengths (from speed ratios) remain exact enough.
      Tone.Transport.loopEnd = _masterLoopSeconds;
    }

    return bigFractionToNumber(frac.num, frac.den);
  }

  function rescheduleTrack(track) {
    if (!window.Tone || !Tone.Transport) return;
    if (window.Tone && Tone.Transport && Tone.Transport.state === "started") {
      stopTrack(track);
      const master = calculateMasterLoopLength();
      startTrack(track, master, isTransportReverse);
    }
  }

  function rescheduleAll() {
    if (!window.Tone || !Tone.Transport) return;
    if (window.Tone && Tone.Transport && Tone.Transport.state === "started") {
      const master = calculateMasterLoopLength();
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }

  let globalBpmSlider = null;
  let currentPresetIndex = -1;
  const TRACK_COUNT = 8;
  const SLOT_COUNT_PER_TRK = 4;
  const PRESET_COUNT = 32;
  const PRESETS_KEY  = "euclidPresetsV2";

  let presets            = new Array(PRESET_COUNT).fill(null);
  let toneInitialized    = false;
  let isTransportRunning = false;
  let isTransportPaused  = false;
  // Set per-play session (shift+click Start) — resets to false on Stop.
  let isTransportReverse = false;

  const tracks = [];

  // -----------------------------
  // Overlay + DOM Setup
  // -----------------------------
  const overlay = document.getElementById("euclidOverlay");
  if (!overlay) {
    console.error("No #euclidOverlay found in HTML.");
    return;
  }

  // Embedded mode: when mounted inside the app panel (Topic), behave like a normal
  // panel child (no full-screen fixed overlay).
  const isEmbedded = overlay?.dataset?.embedded === "true";
  // UI density/compaction knobs (embedded panel vs full-screen overlay)
  const UI = {
    embedded: isEmbedded,
    overlayPadding: isEmbedded ? 12 : 20,
    trackGap: isEmbedded ? 12 : 20,
    trackMin: isEmbedded ? 240 : 280,

    sliderAB: isEmbedded ? "110px" : "150px",
    sliderBpm: isEmbedded ? "90px" : "100px",
    sliderRot: isEmbedded ? "50px" : "60px",
    sliderSpeed: isEmbedded ? "90px" : "100px",
    sliderProb: isEmbedded ? "90px" : "100px",
    sliderTV: isEmbedded ? "70px" : "80px",
    sliderVel: isEmbedded ? "70px" : "80px",
    sliderCC: isEmbedded ? "70px" : "80px",

    readoutW: isEmbedded ? 24 : 30,
    numberW: isEmbedded ? 48 : 60,

    presetBox: isEmbedded ? 14 : 18,
    miniButton: isEmbedded ? 16 : 18,
    miniFont: isEmbedded ? 10 : 11
  };


  // Base visuals + theme vars
  overlay.dataset.embedded = isEmbedded ? "true" : "false";

  // Local theme vars (so full-screen overlay can stay dark even in light mode)
  overlay.style.setProperty("--skew-bg",      isEmbedded ? "var(--panel, rgba(0,0,0,0.85))"   : "rgba(0,0,0,0.85)");
  overlay.style.setProperty("--skew-fg",      isEmbedded ? "var(--fg, #ddd)"      : "#ddd");
  overlay.style.setProperty("--skew-muted",   isEmbedded ? "var(--muted, rgba(255,255,255,0.75))"   : "rgba(255,255,255,0.75)");
  overlay.style.setProperty("--skew-panel",   isEmbedded ? "var(--panel, #222)"   : "#222");
  overlay.style.setProperty("--skew-panel-2", isEmbedded ? "var(--panel-2, #2a2a2a)" : "#2a2a2a");
  overlay.style.setProperty("--skew-border",  isEmbedded ? "var(--border, rgba(255,255,255,0.16))"  : "rgba(255,255,255,0.16)");
  overlay.style.setProperty("--skew-accent",  isEmbedded ? "var(--accent, #4ea3ff)"  : "#4ea3ff");
  overlay.style.setProperty("--skew-danger",  isEmbedded ? "var(--danger, #ff4d4d)"  : "#ff4d4d");
  overlay.style.setProperty("--skew-ok",      isEmbedded ? "var(--ok, #2ecc71)"      : "#2ecc71");

  overlay.style.backgroundColor = "var(--skew-bg)";
  overlay.style.color           = "var(--skew-fg)";
  overlay.style.padding         = UI.overlayPadding + "px";
  overlay.style.boxSizing       = "border-box";
  overlay.style.overflowY       = "auto";
  overlay.style.overflowX       = "hidden";
  overlay.style.fontFamily      = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  overlay.style.display         = "none";

  if (isEmbedded) {
    overlay.style.position = "absolute";
    overlay.style.inset    = "0";
    overlay.style.width    = "100%";
    overlay.style.height   = "100%";
    overlay.style.zIndex   = "1";
  } else {
    overlay.style.position = "fixed";
    overlay.style.top      = "0";
    overlay.style.left     = "0";
    overlay.style.width    = "100vw";
    overlay.style.height   = "100vh";
    overlay.style.zIndex   = "9999";
  }

  // Close button + ESC-to-close only make sense in full-screen mode.
  if (!isEmbedded) {
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Exit Skewclid";
    closeBtn.style.float = "right";
    closeBtn.style.margin = "-8px -8px 0 0";
    closeBtn.style.padding = "5px 10px";
    closeBtn.style.cursor  = "pointer";
    closeBtn.style.background = "#c00";
    closeBtn.style.border     = "none";
    closeBtn.style.color      = "#fff";
    closeBtn.style.fontWeight = "bold";
    closeBtn.addEventListener("click", () => {
      onStop();
      hideEuclidOverlay();
    });
    overlay.appendChild(closeBtn);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideEuclidOverlay();
    });
  }


  // Root wrapper (lets us scale/compact the UI in embedded mode without affecting the panel container)
  const uiRoot = document.createElement("div");
  uiRoot.id = "skewclidRoot";
  uiRoot.style.width = "100%";
  uiRoot.style.maxWidth = "100%";
  uiRoot.style.boxSizing = "border-box";
  overlay.appendChild(uiRoot);

  // Embedded UI scale (like a per-tool zoom)
  const UI_SCALE_KEY = "skewclidUiScale";
  const DEFAULT_EMBED_SCALE = 0.75;
  const SCALE_STEPS = [1, 0.85, 0.75, 0.65, 0.55];

  function clampScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(0.55, Math.min(1, n));
  }

  function applyUiScale(scale) {
    const s = clampScale(scale);
    uiRoot.dataset.uiScale = String(s);

    // Prefer non‑standard `zoom` in Chromium (where WebMIDI lives), fall back to transforms.
    if ("zoom" in uiRoot.style) {
      uiRoot.style.zoom = String(s);
      uiRoot.style.transform = "";
      uiRoot.style.transformOrigin = "";
      uiRoot.style.width = "100%";
    } else {
      uiRoot.style.zoom = "";
      uiRoot.style.transformOrigin = "top left";
      uiRoot.style.transform = `scale(${s})`;
      uiRoot.style.width = `calc(100% / ${s})`;
    }

    if (isEmbedded) {
      try { localStorage.setItem(UI_SCALE_KEY, String(s)); } catch (_) {}
    }
  }

  function cycleUiScale() {
    const cur = clampScale(uiRoot.dataset.uiScale || uiRoot.style.zoom || 1);
    const idx = SCALE_STEPS.findIndex(v => Math.abs(v - cur) < 0.01);
    const next = SCALE_STEPS[(idx >= 0 ? idx + 1 : 1) % SCALE_STEPS.length];
    applyUiScale(next);
  }

  // Initialize scale (embedded panels default to a smaller UI)
  if (isEmbedded) {
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(UI_SCALE_KEY)); } catch (_) {}
    applyUiScale(Number.isFinite(saved) ? saved : DEFAULT_EMBED_SCALE);
  } else {
    applyUiScale(1);
  }

let rKeyDown = false;
  document.addEventListener("keydown", e => {
    if(e.key.toLowerCase() === 'r') rKeyDown = true;
  });
  document.addEventListener("keyup", e => {
    if(e.key.toLowerCase() === 'r') rKeyDown = false;
  });

  // -----------------------------
  // Global Shift Detection
  // -----------------------------
  let shiftDown = false;
  document.addEventListener("keydown", e => {
    if(e.key.toLowerCase() === 'shift') shiftDown = true;
  });
  document.addEventListener("keyup", e => {
    if(e.key.toLowerCase() === 'shift') shiftDown = false;
  });

  // ─────────────────────────────────────────────────────────────
  // 0) Global “batch‐mode” flag to suppress intermediate reschedules
  // ─────────────────────────────────────────────────────────────
  let isBatchUpdating = false;

  // ─────────────────────────────────────────────────────────────
  // Reschedule coalescing (prevents spamming stop/start while dragging)
  // ─────────────────────────────────────────────────────────────
  let _rescheduleAllPending = false;
  function requestRescheduleAll() {
    // Only relevant while playing, and never during batch updates
    if (isBatchUpdating) return;
    if (!window.Tone || !Tone.Transport) return;
    if (Tone.Transport.state !== "started") return;
    if (_rescheduleAllPending) return;
    _rescheduleAllPending = true;
    requestAnimationFrame(() => {
      _rescheduleAllPending = false;
      rescheduleAll();
    });
  }


  function attachShiftSync(slider, getTargetSlider) {
    slider.addEventListener("input", function(e) {
      if (isBatchUpdating) return;
      if (!shiftDown) return;
      const newVal = slider.value;
      isBatchUpdating = true;
      tracks.forEach(t => {
        const target = getTargetSlider(t);
        if (target && target !== slider) {
          target.value = newVal;
          target.dispatchEvent(new Event("input"));
        }
      });
      isBatchUpdating = false;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Undo / Redo (snapshot-based)
  //   - Coalesces drags (pointerdown → pointerup)
  //   - Captures full Skewclid state (BPM + all track params)
  // ─────────────────────────────────────────────────────────────
  let undoManager = null;
  let _undoBtnMini = null;
  let _redoBtnMini = null;
  let _cycleBtnMini = null;

  function _cloneSkewState(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
  }

  function _statesEqual(a, b) {
    // Robust equality for plain data snapshots.
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }

  function _setMiniButtonEnabled(el, enabled) {
    if (!el) return;
    el.dataset.enabled = enabled ? "true" : "false";
    el.style.opacity = enabled ? "1" : "0.35";
    el.style.pointerEvents = enabled ? "auto" : "none";
  }

  function createUndoManager() {
    const MAX = 120;
    const undoStack = [];
    const redoStack = [];
    let pending = null;
    let applying = false;

    function updateButtons() {
      _setMiniButtonEnabled(_undoBtnMini, undoStack.length > 0);
      _setMiniButtonEnabled(_redoBtnMini, redoStack.length > 0);
    }

    function safeGather() {
      try { return gatherState(); } catch (_) { return null; }
    }

    function begin(_label) {
      if (applying) return;
      if (pending) return;
      const snap = safeGather();
      if (!snap) return;
      pending = _cloneSkewState(snap);
    }

    function commit(_label) {
      if (applying) return;
      if (!pending) return;
      const cur = safeGather();
      if (!cur) { pending = null; return; }

      if (!_statesEqual(cur, pending)) {
        undoStack.push(pending);
        if (undoStack.length > MAX) undoStack.shift();
        redoStack.length = 0;
      }
      pending = null;
      updateButtons();
    }

    function undo() {
      if (applying) return;
      if (!undoStack.length) return;
      applying = true;
      try {
        const cur = safeGather();
        if (cur) redoStack.push(_cloneSkewState(cur));
        const prev = undoStack.pop();
        try { applyPreset(prev, { fromUndoRedo: true }); } catch (_) {}
      } finally {
        applying = false;
        pending = null;
        updateButtons();
      }
    }

    function redo() {
      if (applying) return;
      if (!redoStack.length) return;
      applying = true;
      try {
        const cur = safeGather();
        if (cur) undoStack.push(_cloneSkewState(cur));
        const next = redoStack.pop();
        try { applyPreset(next, { fromUndoRedo: true }); } catch (_) {}
      } finally {
        applying = false;
        pending = null;
        updateButtons();
      }
    }

    function clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      pending = null;
      updateButtons();
    }

    function isApplying() { return applying; }

    return { begin, commit, undo, redo, clear, updateButtons, isApplying };
  }

  function withUndo(label, fn) {
    if (!undoManager) return fn();
    if (undoManager.isApplying && undoManager.isApplying()) return fn();
    undoManager.begin(label);
    try { return fn(); }
    finally { undoManager.commit(label); }
  }

  function wireUndoForRange(el, label) {
    if (!el) return;
    el.addEventListener("pointerdown", () => undoManager?.begin(label));
    el.addEventListener("pointerup", () => undoManager?.commit(label));
    el.addEventListener("pointercancel", () => undoManager?.commit(label));
    el.addEventListener("blur", () => undoManager?.commit(label));
    el.addEventListener("change", () => undoManager?.commit(label));
    el.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown" ||
          k === "Home" || k === "End" || k === "PageUp" || k === "PageDown") {
        undoManager?.begin(label);
      }
    });
  }

  function wireUndoForNumber(el, label) {
    if (!el) return;
    el.addEventListener("focus", () => undoManager?.begin(label));
    el.addEventListener("blur", () => undoManager?.commit(label));
    el.addEventListener("change", () => undoManager?.commit(label));
    el.addEventListener("keydown", (e) => {
      if (e.key && e.key.length === 1) undoManager?.begin(label);
    });
  }

  function wireUndoForSelect(el, label) {
    if (!el) return;
    el.addEventListener("pointerdown", () => undoManager?.begin(label));
    el.addEventListener("mousedown", () => undoManager?.begin(label));
    el.addEventListener("change", () => undoManager?.commit(label));
    el.addEventListener("blur", () => undoManager?.commit(label));
  }

  // Initialize manager early (buttons will be assigned once created)
  undoManager = createUndoManager();

  // Keyboard shortcuts (when Skewclid is visible):
  //   Undo: Ctrl/Cmd+Z
  //   Redo: Ctrl/Cmd+Y or Shift+Ctrl/Cmd+Z
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    const ov = document.getElementById("euclidOverlay");
    if (!ov || ov.style.display === "none") return;

    const k = (e.key || "").toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) undoManager?.redo();
      else undoManager?.undo();
    } else if (k === "y") {
      e.preventDefault();
      undoManager?.redo();
    }
  }, true);



  // -----------------------------
  // Helper: Show/Hide Skew Dropdown
  // -----------------------------
  function checkSkewDropdownVisibility(trk) {
    const A = parseFloat(trk.aSlider.value) || 1;
    const B = parseFloat(trk.bSlider.value) || 1;
    const isSkew = (A > B);

    // Show/hide the skew curve selector
    if (trk.skewSelect && trk.skewSelect.parentNode) {
      trk.skewSelect.parentNode.style.display = isSkew ? "inline-block" : "none";
    }

    // Clarify A/B meaning (no functional changes)
    try {
      if (trk.labelAEl && trk.labelAEl.firstChild && trk.labelAEl.firstChild.nodeType === 3) {
        trk.labelAEl.firstChild.nodeValue = isSkew ? "A (Length): " : "A (Hits): ";
        trk.labelAEl.title = isSkew
          ? "Skew mode: A = loop length, B = hits (hits are skewed in time)"
          : "Euclid mode: A = hits, B = steps";
      }
      if (trk.labelBEl && trk.labelBEl.firstChild && trk.labelBEl.firstChild.nodeType === 3) {
        trk.labelBEl.firstChild.nodeValue = isSkew ? "B (Hits): " : "B (Steps): ";
        trk.labelBEl.title = isSkew
          ? "Skew mode: A = loop length, B = hits (hits are skewed in time)"
          : "Euclid mode: A = hits, B = steps";
      }
      if (trk.skewLabelEl && trk.skewLabelEl.firstChild && trk.skewLabelEl.firstChild.nodeType === 3) {
        trk.skewLabelEl.firstChild.nodeValue = "Timing curve: ";
      }
    } catch (_) {}
  }

  // -----------------------------
  // Heading (removed)
  // -----------------------------
  // The embedded panel already provides a "Skewclid" header.
  // Removing the in-UI heading gives back vertical space.

  const topRowDiv = document.createElement("div");
  topRowDiv.style.display = "flex";
  topRowDiv.style.flexWrap = isEmbedded ? "wrap" : "nowrap";
  topRowDiv.style.alignItems = "center";
  topRowDiv.style.gap = isEmbedded ? "0.75em" : "1em";
  uiRoot.appendChild(topRowDiv);

  const transportDiv = document.createElement("div");
  transportDiv.style.marginBottom = "0";
  topRowDiv.appendChild(transportDiv);

  // Start/Pause/Resume button
  const startBtn = document.createElement("button");
  startBtn.id = "startBtn";
  startBtn.textContent = "Start";
  startBtn.style.marginRight = "10px";
  startBtn.addEventListener("click", onStartPauseResume);
  transportDiv.appendChild(startBtn);

  // Stop button
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", onStop);
  transportDiv.appendChild(stopBtn);

  // BPM slider
  const bpmWrap = createSliderWithValue(5, 600, 60, UI.sliderBpm, true, true, 1);

  // Ensure the BPM readout shows the full number (e.g. 120 / 600) even in embedded/scaled UI.
  // In embedded mode the whole UI is zoomed down, so the default number input can look truncated.
  try {
    if (bpmWrap && bpmWrap.readout && bpmWrap.readout.style) {
      bpmWrap.readout.style.width = "5.5em";
      bpmWrap.readout.style.minWidth = "5.5em";
      bpmWrap.readout.style.boxSizing = "border-box";
    }
  } catch (_) {}

  // Keep the BPM label in front of the slider+readout (horizontal row)
  const bpmRow = document.createElement("div");
  bpmRow.style.display = "inline-flex";
  bpmRow.style.alignItems = "center";
  bpmRow.style.gap = "6px";
  const bpmTxt = document.createElement("span");
  bpmTxt.textContent = "BPM:";
  bpmTxt.style.fontSize = "12px";
  bpmRow.appendChild(bpmTxt);
  bpmRow.appendChild(bpmWrap.wrapper);
  transportDiv.appendChild(bpmRow);
  bpmWrap.slider.addEventListener("input", () => {
    const bpm = parseInt(bpmWrap.slider.value, 10);
    // If Tone isn't loaded yet, keep the value locally and apply later.
    _pendingBpm = Number.isFinite(bpm) ? bpm : 60;
    if (window.Tone && Tone.Transport && Tone.Transport.bpm) {
      try {
        Tone.Transport.bpm.value = _pendingBpm;
      } catch (_) {}
    }
    // BPM changes loop duration in seconds
    calculateMasterLoopLength();
    requestRescheduleAll();
  });
  globalBpmSlider = bpmWrap.slider;
  // Initialize pending BPM from the UI default.
  _pendingBpm = parseInt(globalBpmSlider.value, 10) || 60;

  // Preset container
  const presetContainer = document.createElement("div");
  presetContainer.style.marginLeft = "1em";
  presetContainer.style.display = "flex";
  presetContainer.style.alignItems = "center";
  topRowDiv.appendChild(presetContainer);

  const presetTitle = document.createElement("h4");
  presetTitle.textContent = "";
  presetTitle.style.margin = "0";
  presetTitle.style.padding = "0";
  presetContainer.appendChild(presetTitle);

  // Preset grid: arrange preset boxes inline
  const presetGrid = document.createElement("div");
  presetGrid.style.display = "flex";
  presetGrid.style.flexWrap = "nowrap";
  presetGrid.style.gap = isEmbedded ? "1px" : "2px";
  presetGrid.style.alignItems = "center";
  // In embedded mode this row can get very wide; allow local horizontal scroll instead of clipping/wrapping.
  presetGrid.style.overflowX = isEmbedded ? "auto" : "visible";
  presetGrid.style.maxWidth = "100%";
  presetGrid.style.minWidth = "0";
  presetContainer.appendChild(presetGrid);

  // Load presets from localStorage
  {
    let stored = null;
    try { stored = localStorage.getItem(PRESETS_KEY); } catch (e) { stored = null; }
    if (stored) {
      try {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr) && arr.length === PRESET_COUNT) {
          presets = arr;
        }
      } catch (e) {
        console.warn("Failed to parse presets", e);
      }
    }
  }


  // Preset box helpers (also used by Import JSON)
  const presetBoxes = new Array(PRESET_COUNT);

  function renderPresetBox(i) {
    const box = presetBoxes[i];
    if (!box) return;

    const has = !!presets[i];
    const hue = Math.floor((i / PRESET_COUNT) * 300);

    box.title = has
      ? `Preset ${i + 1} (click: load • shift+click: clear)`
      : `Empty preset ${i + 1} (click: save current state)`;

    if (has) {
      box.style.background = `hsl(${hue}, 70%, 40%)`;
      box.style.borderColor = "yellow";
    } else {
      box.style.background = "#555";
      box.style.borderColor = "#999";
    }
  }

  function renderAllPresetBoxes() {
    for (let i = 0; i < PRESET_COUNT; i++) renderPresetBox(i);
  }

  // Build preset boxes
  for (let i = 0; i < PRESET_COUNT; i++){
    const box = document.createElement("div");
    box.style.width = UI.presetBox + "px";
    box.style.height = UI.presetBox + "px";
    box.style.border = "1px solid var(--skew-border)";
    box.style.cursor = "pointer";
    box.style.marginRight = isEmbedded ? "2px" : "3px";

    presetBoxes[i] = box;
    renderPresetBox(i);

    box.addEventListener("click", (evt) => {
      if (evt.shiftKey) {
        presets[i] = null;
        if (currentPresetIndex === i){ currentPresetIndex = -1; }
        renderPresetBox(i);
        flashPresetBox(box);
        savePresets();
      } else {
        if (presets[i]){
          if (currentPresetIndex === i && isTransportRunning){
            return;
          } else {
            currentPresetIndex = i;
            withUndo("Apply preset", () => applyPreset(presets[i]));
          }
        } else {
          presets[i] = gatherState();
          currentPresetIndex = i;
          renderPresetBox(i);
          flashPresetBox(box);
          savePresets();
          withUndo("Apply preset", () => applyPreset(presets[i]));
        }
      }
    });
    presetGrid.appendChild(box);
  }

  // Make the preset row fill remaining width so we can right-align utility buttons
  presetContainer.style.flex = "1";
  presetContainer.style.minWidth = "0";

  // Export / Import presets (JSON) — parity with the MMDT overlay.
  const presetIo = document.createElement("div");
  presetIo.style.display = "flex";
  presetIo.style.flexWrap = "nowrap";
  presetIo.style.alignItems = "center";
  presetIo.style.gap = isEmbedded ? "4px" : "6px";
  presetIo.style.marginLeft = "8px";
  presetIo.style.flex = "0 0 auto";

  function makePresetIoButton(label, title) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title || label;
    b.style.cursor = "pointer";
    b.style.padding = isEmbedded ? "1px 6px" : "2px 8px";
    b.style.background = "var(--skew-panel-2)";
    b.style.color = "var(--skew-fg)";
    b.style.border = "1px solid var(--skew-border)";
    b.style.borderRadius = "8px";
    b.style.fontSize = isEmbedded ? "11px" : "12px";
    b.style.whiteSpace = "nowrap";
    // Prevent accidental drag-select in some browsers
    b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  }

  const exportPresetsBtn = makePresetIoButton(
    "Export JSON",
    "Download all preset slots as a JSON file"
  );
  const importPresetsBtn = makePresetIoButton(
    "Import JSON",
    "Load preset slots from a JSON file (replaces current presets)"
  );

  presetIo.appendChild(exportPresetsBtn);
  presetIo.appendChild(importPresetsBtn);
  presetContainer.appendChild(presetIo);

  exportPresetsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const data = JSON.stringify(presets, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "skewclid-presets.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch (err) {
      console.warn("Preset export failed:", err);
      alert("Failed to export presets.");
    }
  });

  importPresetsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";

    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;

      try {
        const txt = await f.text();
        const parsed = JSON.parse(txt);

        // Allow either a raw array export OR a {presets:[...]} wrapper.
        let arr = null;
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && Array.isArray(parsed.presets)) arr = parsed.presets;

        if (!arr || !Array.isArray(arr)) {
          alert("Invalid preset file (expected a JSON array).");
          return;
        }

        // Normalize length to PRESET_COUNT (pad with nulls / truncate extras)
        const normalized = new Array(PRESET_COUNT).fill(null);
        for (let i = 0; i < PRESET_COUNT; i++) {
          normalized[i] = (i < arr.length) ? (arr[i] ?? null) : null;
        }

        presets = normalized;
        if (currentPresetIndex >= 0 && !presets[currentPresetIndex]) currentPresetIndex = -1;

        savePresets();
        renderAllPresetBoxes();

        alert("Presets imported.");
      } catch (err) {
        console.warn("Preset import failed:", err);
        alert("Failed to import presets.");
      }
    };

    inp.click();
  });

  // ─────────────────────────────────────────────────────────────
  // Preset-row utility buttons (randomize / reset) aligned to the right
  // ─────────────────────────────────────────────────────────────
  const utilGrid = document.createElement("div");
  utilGrid.style.display = "flex";
  utilGrid.style.flexWrap = "nowrap";
  utilGrid.style.alignItems = "center";
  utilGrid.style.gap = "2px";
  utilGrid.style.marginLeft = "auto";
  utilGrid.style.paddingLeft = "12px";
  utilGrid.style.borderLeft = "1px solid var(--skew-border)";
  presetContainer.appendChild(utilGrid);

  function makeMiniSquareButton(symbol, tooltip, onClick) {
    const b = document.createElement("div");
    b.textContent = symbol;
    b.title = tooltip;
    b.style.width = UI.miniButton + "px";
    b.style.height = UI.miniButton + "px";
    b.style.border = "1px solid var(--skew-border)";
    b.style.background = "var(--skew-panel-2)";
    b.style.color = "var(--skew-fg)";
    b.style.display = "flex";
    b.style.alignItems = "center";
    b.style.justifyContent = "center";
    b.style.cursor = "pointer";
    b.style.userSelect = "none";
    b.style.fontSize = UI.miniFont + "px";
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick && onClick(e);
    });
    b.addEventListener("mouseover", () => { b.style.background = "var(--skew-panel)"; });
    b.addEventListener("mouseout",  () => { b.style.background = "var(--skew-panel-2)"; });
    return b;
  }

  // Suggested button set (Undo/Redo + randomize + reset)
  _undoBtnMini = makeMiniSquareButton("↶", "Undo (Ctrl/Cmd+Z)", () => undoManager?.undo());
  _redoBtnMini = makeMiniSquareButton("↷", "Redo (Ctrl/Cmd+Y / Shift+Ctrl/Cmd+Z)", () => undoManager?.redo());
  utilGrid.appendChild(_undoBtnMini);
  utilGrid.appendChild(_redoBtnMini);


  // ─────────────────────────────────────────────────────────────
  // Cycle-lock toggle (Tidal-like "one master loop")
  //   - 🌊 click: toggle cycleMode
  //   - 🌊 shift+click: cycle through common cycle lengths (beats)
  // ─────────────────────────────────────────────────────────────
  function saveCyclePrefs() {
    try { localStorage.setItem(CYCLE_MODE_KEY, cycleMode ? "1" : "0"); } catch (_) {}
    try {
      const b = Math.max(1, (parseInt(cycleBeats, 10) || 16));
      localStorage.setItem(CYCLE_BEATS_KEY, String(b));
    } catch (_) {}
  }

  function updateCycleUi() {
    if (!_cycleBtnMini) return;
    const b = Math.max(1, (parseInt(cycleBeats, 10) || 16));
    _cycleBtnMini.title =
      "Cycle-lock (Tidal-like)\n" +
      "• Click: toggle\n" +
      "• Shift+click: change cycle length\n" +
      `State: ${cycleMode ? "ON" : "OFF"} · ${b} beats`;
    _cycleBtnMini.style.borderColor = cycleMode ? "var(--skew-accent)" : "var(--skew-border)";
    _cycleBtnMini.style.color = cycleMode ? "var(--skew-accent)" : "var(--skew-fg)";
  }

  _cycleBtnMini = makeMiniSquareButton("🌊", "Cycle-lock (Tidal-like)", (e) => {
    if (e && e.shiftKey) {
      const b = Math.max(1, (parseInt(cycleBeats, 10) || 16));
      let idx = CYCLE_BEATS_CHOICES.indexOf(b);
      if (idx < 0) idx = 0;
      cycleBeats = CYCLE_BEATS_CHOICES[(idx + 1) % CYCLE_BEATS_CHOICES.length];
    } else {
      cycleMode = !cycleMode;
    }

    saveCyclePrefs();
    updateCycleUi();

    // Update loop + reschedule if playing
    calculateMasterLoopLength();
    rescheduleAll();
  });
  utilGrid.appendChild(_cycleBtnMini);
  updateCycleUi();


  utilGrid.appendChild(makeMiniSquareButton(
    "🎲",
    "Randomize ALL parameters (all tracks + CC values)\n" +
    "Shift+click: deterministic envelopes (no fixed/random/random-inverse curves)",
    (e) => {
      if (e && e.shiftKey) {
        withUndo("Randomize all (det env)", () => randomizeAllParametersDeterministicEnvelopes());
      } else {
        withUndo("Randomize all", () => randomizeAllParameters());
      }
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton(
    "AB",
    "Randomize A/B ratios (all tracks)\nShift+click: musical A/B (biased Euclid + Skew)",
    (e) => {
      if (e && e.shiftKey) withUndo("Randomize A/B (musical)", () => randomizeAllABMusical());
      else withUndo("Randomize A/B", () => randomizeAllAB());
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton(
    "⟳",
    "Randomize rotations (all tracks)\nShift+click: one global rotation for all tracks",
    (e) => {
      if (e && e.shiftKey) withUndo("Randomize rotations (global)", () => randomizeAllRotationsGlobal());
      else withUndo("Randomize rotations", () => randomizeAllRotations());
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton(
    "⚡",
    "Randomize speeds (all tracks)\nShift+click: true-random continuous speeds (not quantized)",
    (e) => {
      if (e && e.shiftKey) withUndo("Randomize speeds (true)", () => randomizeAllSpeedsTrueRandom());
      else withUndo("Randomize speeds", () => randomizeAllSpeeds());
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton(
    "CC",
    "Randomize CC destinations (all tracks)\nShift+click: choose one destination per slot (coherent across tracks)",
    (e) => {
      if (e && e.shiftKey) withUndo("Randomize CC dest (by slot)", () => randomizeAllParamDestinationsBySlot());
      else withUndo("Randomize CC dest", () => randomizeAllParamDestinations());
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton(
    "≋",
    "Randomize CC values + curves (all tracks)\nShift+click: deterministic CC envelopes (no fixed/random) + non-zero mod",
    (e) => {
      if (e && e.shiftKey) withUndo("Randomize CC values (det env)", () => randomizeAllCCValuesDeterministic());
      else withUndo("Randomize CC values", () => randomizeAllCCValues());
    }
  ));

  utilGrid.appendChild(makeMiniSquareButton("⟲", "Reset ALL parameters", () => withUndo("Reset all", () => resetAllParameters())));

  // Start with undo/redo disabled until a first change occurs
  try { undoManager?.updateButtons?.(); } catch (_) {}

  // UI scale toggle (embedded panel only)
  if (isEmbedded) {
    utilGrid.appendChild(makeMiniSquareButton("🔎", "Cycle UI scale (embedded panel)\nStored in localStorage", () => cycleUiScale()));
  }

  // ─────────────────────────────────────────────────────────────
  // Loop scrub bar (under transport + presets)
  // ─────────────────────────────────────────────────────────────
  const loopBar = document.createElement("div");
  loopBar.style.display = "flex";
  loopBar.style.alignItems = "center";
  loopBar.style.gap = "10px";
  loopBar.style.marginTop = isEmbedded ? "6px" : "10px";
  loopBar.style.width = "100%";
  uiRoot.appendChild(loopBar);

  const loopInfo = document.createElement("div");
  loopInfo.style.whiteSpace = "nowrap";
  loopInfo.style.fontSize = "12px";
  loopInfo.textContent = "Loop: —";
  loopBar.appendChild(loopInfo);
  _loopScrubInfo = loopInfo;

  const loopSlider = document.createElement("input");
  loopSlider.type = "range";
  loopSlider.min = "0";
  loopSlider.max = "1";
  loopSlider.step = "0.0001";
  loopSlider.value = "0";
  loopSlider.style.flex = "1";
  loopSlider.style.cursor = "pointer";
  loopBar.appendChild(loopSlider);
  _loopScrubSlider = loopSlider;

  const loopPos = document.createElement("div");
  loopPos.style.whiteSpace = "nowrap";
  loopPos.style.fontSize = "12px";
  loopPos.textContent = "Pos: 0.00 beats";
  loopBar.appendChild(loopPos);
  _loopScrubPos = loopPos;

  loopSlider.addEventListener("pointerdown", (e) => {
    _loopScrubIsScrubbing = true;
    try { loopSlider.setPointerCapture(e.pointerId); } catch {}
  });
  loopSlider.addEventListener("pointerup", (e) => {
    if (!_loopScrubIsScrubbing) return;
    _loopScrubIsScrubbing = false;
    try { loopSlider.releasePointerCapture(e.pointerId); } catch {}
    seekTransportToFraction(loopSlider.value);
  });
  loopSlider.addEventListener("pointercancel", () => {
    _loopScrubIsScrubbing = false;
  });

  // While dragging: update the text readout (without forcing a seek every frame)
  loopSlider.addEventListener("input", () => {
    const loopSecs = _masterLoopSeconds;
    if (loopSecs > 0) {
      const f = Math.min(1, Math.max(0, parseFloat(loopSlider.value) || 0));
      const targetSec = f * loopSecs;
      _loopScrubPendingSec = targetSec;
      updateLoopScrubLabels(targetSec);
    }
  });
  // Keyboard interaction / accessibility
  loopSlider.addEventListener("change", () => {
    seekTransportToFraction(loopSlider.value);
  });

  // Start the visual playhead updater (only when visible)
  // startLoopScrubRAF();
  {
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      @keyframes flashAnime {
        50%  { opacity: 0.8; }
        100% { opacity: 0; }
      }

      /* Skewclid polish (no layout changes) */
      #euclidOverlay {
        background: var(--skew-bg);
        color: var(--skew-fg);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }

      #euclidOverlay button {
        background: var(--skew-panel-2);
        color: var(--skew-fg);
        border: 1px solid var(--skew-border);
        border-radius: 8px;
      }

      #euclidOverlay input[type="range"] {
        accent-color: var(--skew-accent);
      }

      #euclidOverlay input[type="number"],
      #euclidOverlay select {
        background: var(--skew-panel);
        color: var(--skew-fg);
        border: 1px solid var(--skew-border);
        border-radius: 6px;
        padding: 2px 6px;
        font-variant-numeric: tabular-nums;
      }

      #euclidOverlay label {
        font-size: 12px;
        line-height: 1.15;
      }

      #euclidOverlay .track-card h3 {
        font-size: 13px;
        font-weight: 650;
        letter-spacing: 0.01em;
      }

      #euclidOverlay .track-card h4 {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--skew-muted);
      }

      #euclidOverlay .skewclid-control {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        max-width: 100%;
      }

      #euclidOverlay .skewclid-readout {
        font-variant-numeric: tabular-nums;
        color: var(--skew-muted);
        min-width: 2.6em;
      }

      #euclidOverlay .shiftable {
        text-decoration: underline dotted;
        text-decoration-color: rgba(255,255,255,0.25);
        text-underline-offset: 2px;
      }
      #euclidOverlay[data-embedded="true"] .shiftable {
        text-decoration-color: rgba(0,0,0,0.25);
      }

      /* Add a bit more breathing room between Stop and BPM */
#euclidOverlay #startBtn + button {   /* "Stop" is the next button after Start */
  margin-right: 12px;                /* tweak to taste (10–18px) */
}

/* (Optional) belt-and-braces: also nudge the BPM label itself */
#euclidOverlay #startBtn + button + label {
  margin-left: 2px;
}

      .track-card {
        width: 100%;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(styleEl);
  }

  function flashPresetBox(bx){
    const fx = document.createElement("div");
    fx.style.position = "absolute";
    fx.style.top = "0";
    fx.style.left = "0";
    fx.style.width = "100%";
    fx.style.height = "100%";
    fx.style.background = "#fff";
    fx.style.opacity = "0";
    fx.style.animation = "flashAnime 0.2s forwards";
    bx.style.position = "relative";
    bx.appendChild(fx);
    fx.addEventListener("animationend", () => {
      if(fx.parentNode) fx.parentNode.removeChild(fx);
    });
  }
  function savePresets(){
    try {
      localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
    } catch (e) {
      console.warn("Failed to save presets", e);
    }
  }

  // Track list container
  const trackList = document.createElement("div");
  trackList.style.display = "grid";
  // Compact 4×2 track layout (8 tracks total): 4 across, then the remaining 4.
  // Using minmax(0, 1fr) ensures columns can shrink without forcing horizontal overflow.
  trackList.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
  trackList.style.gridAutoRows = "auto";
  trackList.style.gap = UI.trackGap + "px";
  trackList.style.marginTop = "1em";
  trackList.style.alignItems = "start";
  uiRoot.appendChild(trackList);

  // -----------------------------
  // Build each track UI
  // -----------------------------
  for(let i = 0; i < TRACK_COUNT; i++){
    let index = i;
    const trackCard = document.createElement("div");
    trackCard.classList.add("track-card");
    trackCard.style.background   = "var(--skew-panel)";
    trackCard.style.border       = "1px solid var(--skew-border)";
    trackCard.style.borderRadius = "10px";
    trackCard.style.padding      = isEmbedded ? "8px" : "10px";
    trackCard.style.position     = "relative";
    // Allow grid columns to shrink without the card forcing overflow.
    trackCard.style.minWidth     = "0";

    // Title
    const title = document.createElement("h3");
    title.textContent = "Track " + (index + 1);
    title.style.marginTop = "0";
    title.style.marginBottom = "0.5em";
    title.style.transition = "background-color 0.2s ease";
    title.addEventListener("mouseover", () => {
      title.style.backgroundColor = "rgba(255,255,255,0.15)";
    });
    title.addEventListener("mouseout", () => {
      title.style.backgroundColor = "transparent";
    });
    trackCard.appendChild(title);

    title.addEventListener("click", (e) => {
      const track = tracks.find(t => t.card === title.parentNode);
      if (!track) return;

      if (e.shiftKey && e.target === e.currentTarget) {
        withUndo("Randomize track", () => randomizeTrack(track));
      } else if (!e.shiftKey) {
        withUndo("Reset track", () => resetTrack(track));
      }
    });

    const indicator = document.createElement("div");
    indicator.style.position = "absolute";
    indicator.style.top = "10px";
    indicator.style.right = "10px";
    indicator.style.width = "15px";
    indicator.style.height = "15px";
    indicator.style.background = "#666";
    indicator.style.borderRadius = "50%";
    indicator.style.transition = "background 0.2s";
    trackCard.appendChild(indicator);

    // Two-column compact layout per track:
    // - LEFT: track placement + timing + velocity (down to Velocity Curve)
    // - RIGHT: CC Param Controls
    const trackGrid = document.createElement("div");
    trackGrid.className = "track-grid";
    trackGrid.style.display = "grid";
    trackGrid.style.gridTemplateColumns = "1fr 1fr";
    trackGrid.style.gap = isEmbedded ? "8px" : "10px";
    trackGrid.style.alignItems = "start";
    trackGrid.style.minWidth = "0";
    trackGrid.style.marginTop = isEmbedded ? "6px" : "8px";
    trackCard.appendChild(trackGrid);

    const leftCol = document.createElement("div");
    leftCol.className = "track-col-left";
    leftCol.style.display = "flex";
    leftCol.style.flexDirection = "column";
    leftCol.style.gap = "6px";
    leftCol.style.minWidth = "0";
    trackGrid.appendChild(leftCol);

    const rightCol = document.createElement("div");
    rightCol.className = "track-col-right";
    rightCol.style.display = "flex";
    rightCol.style.flexDirection = "column";
    rightCol.style.gap = "6px";
    rightCol.style.minWidth = "0";
    trackGrid.appendChild(rightCol);

    // Mute / Solo row
    const muteSoloRow = document.createElement("div");
    muteSoloRow.style.display = "flex";
    muteSoloRow.style.gap = "8px";
    leftCol.appendChild(muteSoloRow);

    const muteBtn = document.createElement("button");
    muteBtn.textContent = "Mute";
    muteBtn.style.cursor = "pointer";
    muteBtn.addEventListener("click", (e) => {
      if(e.shiftKey && e.target === e.currentTarget){
        withUndo("Mute all", () => {
          const anyMuted = tracks.some(t => t.isMuted);
          tracks.forEach(t => { t.isMuted = anyMuted ? false : true; });
          updateAllMuteSoloStates();
        });
      } else {
        withUndo("Mute track", () => {
          trackObj.isMuted = !trackObj.isMuted;
          updateAllMuteSoloStates();
        });
      }
    });
    muteSoloRow.appendChild(muteBtn);

    const soloBtn = document.createElement("button");
    soloBtn.textContent = "Solo";
    soloBtn.style.cursor = "pointer";
    soloBtn.addEventListener("click", () => {
      withUndo("Solo track", () => {
        trackObj.isSolo = !trackObj.isSolo;
        updateAllMuteSoloStates();
      });
    });
    muteSoloRow.appendChild(soloBtn);

    const machinePlaceholder = document.createElement("div");
    machinePlaceholder.className = "machinePlaceholder";
    leftCol.appendChild(machinePlaceholder);

    const rowAB = document.createElement("div");
    // Stack A + B vertically so each track can stay narrow (4 across).
    rowAB.style.display = "flex";
    rowAB.style.flexDirection = "column";
    rowAB.style.gap = "6px";

    // Label A
    const labelA = document.createElement("label");
    labelA.textContent = "A:";
    labelA.classList.add("shiftable");
    labelA.addEventListener("mousedown", function(e) {
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize A (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            t.aSlider.value = String(1 + Math.floor(Math.random() * 64));
            t.aSlider.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const aWrap = createSliderWithValue(1, 64, 1, UI.sliderAB, true);
    attachShiftSync(aWrap.slider, t => t.aSlider);
    labelA.appendChild(aWrap.wrapper);
    rowAB.appendChild(labelA);

    // Label B
    const labelB = document.createElement("label");
    labelB.textContent = "B:";
    labelB.classList.add("shiftable");
    labelB.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize B (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            t.bSlider.value = String(1 + Math.floor(Math.random() * 64));
            t.bSlider.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const bWrap = createSliderWithValue(1, 64, 1, UI.sliderAB, true);
    attachShiftSync(bWrap.slider, t => t.bSlider);
    labelB.appendChild(bWrap.wrapper);

    const skewLabel = document.createElement("label");
    skewLabel.textContent = "Timing curve: ";
    skewLabel.classList.add("shiftable");
    skewLabel.style.marginLeft = "6px";
    skewLabel.style.cursor = "pointer";
    skewLabel.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        const savedShiftDown = shiftDown;
        shiftDown = false;
        const skewOpts = ["sine","elastic","exponential","logarithmic"];
        tracks.forEach(t => {
          if(t.skewSelect){
            t.skewSelect.value = skewOpts[Math.floor(Math.random() * skewOpts.length)];
            t.skewSelect.dispatchEvent(new Event("change"));
          }
        });
        shiftDown = savedShiftDown;
      }
    });
    const skewSelect = document.createElement("select");
    ["sine", "elastic", "exponential", "logarithmic"].forEach(type => {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = type;
      skewSelect.appendChild(opt);
    });
    skewSelect.value = "sine";
    wireUndoForSelect(skewSelect, "Timing curve");
    skewLabel.appendChild(skewSelect);
    skewLabel.style.display = "none";
    labelB.appendChild(skewLabel);
    rowAB.appendChild(labelB);
    leftCol.appendChild(rowAB);

    // Row 2: Rot and Speed
    const rowRotSpeed = document.createElement("div");
    rowRotSpeed.style.display = "flex";
    rowRotSpeed.style.flexDirection = "column";
    rowRotSpeed.style.gap = "6px";

    const labelRot = document.createElement("label");
    labelRot.textContent = "Rot:";
    labelRot.classList.add("shiftable");
    labelRot.style.cursor = "pointer";
    labelRot.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize rotation (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            t.rotNum.value = String(Math.floor(Math.random() * 64));
            t.rotNum.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const rotWrap = createSliderWithValue(0, 63, 0, UI.sliderRot, false, true);
    attachShiftSync(rotWrap.slider, t => t.rotNum);
    labelRot.appendChild(rotWrap.wrapper);
    rowRotSpeed.appendChild(labelRot);

    const labelSpeed = document.createElement("label");
    labelSpeed.textContent = "Speed:";
    labelSpeed.classList.add("shiftable");
    labelSpeed.style.cursor = "pointer";
    labelSpeed.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize speed (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            const sp = 0.05 + Math.random() * 5.95;
            t.speedSlider.value = sp.toFixed(2);
            t.speedSlider.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const spWrap = createSliderWithValue(0.25, 5, 1, UI.sliderSpeed, true, true, 0.25);
    attachShiftSync(spWrap.slider, t => t.speedSlider);
    labelSpeed.appendChild(spWrap.wrapper);
    rowRotSpeed.appendChild(labelSpeed);
    leftCol.appendChild(rowRotSpeed);

    // Row 3: Probability + Timing Var
    const rowProbTime = document.createElement("div");
    rowProbTime.style.display = "flex";
    rowProbTime.style.flexDirection = "column";
    rowProbTime.style.gap = "6px";

    const labelProb = document.createElement("label");
    labelProb.textContent = "Probability:";
    labelProb.classList.add("shiftable");
    labelProb.style.cursor = "pointer";
    labelProb.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        const savedShiftDown = shiftDown;
        shiftDown = false;
        tracks.forEach(t => {
          t.probSlider.value = String(Math.floor(Math.random() * 101));
          t.probSlider.dispatchEvent(new Event("input"));
        });
        shiftDown = savedShiftDown;
      }
    });
    const prWrap = createSliderWithValue(0, 100, 100, UI.sliderProb, true);
    attachShiftSync(prWrap.slider, t => t.probSlider);
    labelProb.appendChild(prWrap.wrapper);
    rowProbTime.appendChild(labelProb);

    const labelTV = document.createElement("label");
    labelTV.textContent = "Timing Var:";
    labelTV.classList.add("shiftable");
    labelTV.style.cursor = "pointer";
    labelTV.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        const savedShiftDown = shiftDown;
        shiftDown = false;
        tracks.forEach(t => {
          t.tvSlider.value = String(Math.floor(Math.random() * 201) - 100);
          t.tvSlider.dispatchEvent(new Event("input"));
        });
        shiftDown = savedShiftDown;
      }
    });
    const tvWrap = createSliderWithValue(-100, 100, 0, UI.sliderTV, true);
    attachShiftSync(tvWrap.slider, t => t.tvSlider);
    labelTV.appendChild(tvWrap.wrapper);
    rowProbTime.appendChild(labelTV);
    leftCol.appendChild(rowProbTime);

    // Row 4: Velocity controls
    const rowVel = document.createElement("div");
    rowVel.style.marginTop = "0";

    const velDefLabel = document.createElement("label");
    velDefLabel.textContent = "Velocity: ";
    velDefLabel.classList.add("shiftable");
    velDefLabel.style.cursor = "pointer";
    velDefLabel.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize velocity (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            t.velDef.value = String(Math.floor(Math.random() * 128));
            t.velDef.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const velDefWrap = createSliderWithValue(0, 127, 100, UI.sliderVel, true);
    attachShiftSync(velDefWrap.slider, t => t.velDef);
    velDefLabel.appendChild(velDefWrap.wrapper);
    rowVel.appendChild(velDefLabel);

    const velModLabel = document.createElement("label");
    velModLabel.textContent = "Vel mod: ";
    velModLabel.classList.add("shiftable");
    velModLabel.style.cursor = "pointer";
    velModLabel.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize vel mod (all tracks)", () => {
          const savedShiftDown = shiftDown;
          shiftDown = false;
          tracks.forEach(t => {
            t.velMod.value = String(Math.floor(Math.random() * 127) - 63);
            t.velMod.dispatchEvent(new Event("input"));
          });
          shiftDown = savedShiftDown;
        });
      }
    });
    const velModWrap = createSliderWithValue(-63, 63, 0, UI.sliderVel, true);
    attachShiftSync(velModWrap.slider, t => t.velMod);
    velModLabel.appendChild(velModWrap.wrapper);
    rowVel.appendChild(velModLabel);

    const lineBreak = document.createElement("br");
    rowVel.appendChild(lineBreak);

    const labelVel = document.createElement("label");
    labelVel.textContent = "Velocity Curve: ";
    labelVel.classList.add("shiftable");
    labelVel.style.cursor = "pointer";
    labelVel.addEventListener("mousedown", function(e){
      if(e.shiftKey && e.target === this){
        e.preventDefault();
        e.stopPropagation();
        const savedShiftDown = shiftDown;
        shiftDown = false;
        const vcList = [
          "fixed","linear","exponential","linear-inverse","exponential-inverse",
          "sine-wave","logarithmic","spike","sawtooth","random","random-inverse"
        ];
        tracks.forEach(t => {
          t.velSel.value = vcList[Math.floor(Math.random() * vcList.length)];
          t.velSel.dispatchEvent(new Event("change"));
        });
        shiftDown = savedShiftDown;
      }
    });
    const velSel = document.createElement("select");
    [
      "fixed","linear","exponential","linear-inverse","exponential-inverse",
      "sine-wave","logarithmic","spike","sawtooth","random","random-inverse"
    ].forEach(optVal => {
      const opt = document.createElement("option");
      opt.value = optVal;
      opt.textContent = optVal;
      velSel.appendChild(opt);
    });
    wireUndoForSelect(velSel, "Velocity curve");
    labelVel.appendChild(velSel);
    rowVel.appendChild(labelVel);
    leftCol.appendChild(rowVel);

    const paramContainer = document.createElement("div");
    paramContainer.style.marginTop = "0";
    paramContainer.style.background = "var(--skew-panel-2)";
    paramContainer.style.border = "1px solid var(--skew-border)";
    paramContainer.style.padding = "6px";
    paramContainer.style.borderRadius = "4px";

    const paramTitle = document.createElement("h4");
    paramTitle.textContent = "Param Controls";
    paramTitle.classList.add("shiftable");
    paramTitle.style.margin = "0 0 8px 0";
    paramTitle.setAttribute("data-enabled", "false");
    paramContainer.appendChild(paramTitle);

    const paramRows = [];

    const trackObj = {
      index: index,
      card: trackCard,
      indicator: indicator,
      aSlider: aWrap.slider,
      aNum: aWrap.readout,
      bSlider: bWrap.slider,
      bNum: bWrap.readout,
      labelAEl: labelA,
      labelBEl: labelB,
      skewLabelEl: skewLabel,
      rotNum: rotWrap.slider,
      speedSlider: spWrap.slider,
      speedNum: spWrap.readout,
      probSlider: prWrap.slider,
      probNum: prWrap.readout,
      tvSlider: tvWrap.slider,
      tvNum: tvWrap.readout,
      velSel: velSel,
      velDef: velDefWrap.slider,
      velMod: velModWrap.slider,
      machSel: null,
      skewSelect: skewSelect,
      paramRows: paramRows,
      pattern: [],
      patternLen: 0,
      loopObj: null,
      stepIndex: 0,
      isMuted: false,
      isSolo: false,
      isActive: true,
      ccEnabled: false,
      paramTitle: paramTitle,
      paramContainer: paramContainer
    };

    trackObj.aSlider.addEventListener("input", () => {
      checkSkewDropdownVisibility(trackObj);
      if (!isBatchUpdating) calculateMasterLoopLength();
      requestRescheduleAll();
    });
    trackObj.bSlider.addEventListener("input", () => {
      checkSkewDropdownVisibility(trackObj);
      if (!isBatchUpdating) calculateMasterLoopLength();
      requestRescheduleAll();
    });

    // Timing‑critical controls (only these need re‑scheduling)
    trackObj.rotNum.addEventListener("input", () => requestRescheduleAll());
    trackObj.speedSlider.addEventListener("input", () => {
      if (!isBatchUpdating) calculateMasterLoopLength();
      requestRescheduleAll();
    });
    if (trackObj.skewSelect) {
      trackObj.skewSelect.addEventListener("change", () => {
        if (!isBatchUpdating) calculateMasterLoopLength();
        requestRescheduleAll();
      });
    }

    paramTitle.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();

      // R key: toggle ALL tracks' CC enable
      if (rKeyDown) {
        withUndo("Toggle CC enabled (all tracks)", () => {
          const anyOn = tracks.some(t => t.ccEnabled);
          const on = !anyOn;
          tracks.forEach(t => setTrackCCEnabled(t, on));
        });
        return;
      }

      // Shift-click: randomize ALL CC destinations + values for THIS track
      if (e.shiftKey) {
        withUndo("Randomize CC (track)", () => {
          const savedShift = shiftDown;
          shiftDown = false;

          const vcList = [
            "fixed","linear","exponential","linear-inverse","exponential-inverse",
            "sine-wave","logarithmic","spike","sawtooth","random","random-inverse"
          ];
          paramRows.forEach(row => {
            row.paramSel.value = String(1 + Math.floor(Math.random() * 24));
            row.paramSel.dispatchEvent(new Event("change"));
            row.defRange.value = String(Math.floor(Math.random() * 128));
            row.defRange.dispatchEvent(new Event("input"));
            row.modRange.value = String(Math.floor(Math.random() * 127) - 63);
            row.modRange.dispatchEvent(new Event("input"));
            row.curveSel.value = vcList[Math.floor(Math.random() * vcList.length)];
            row.curveSel.dispatchEvent(new Event("change"));
          });

          shiftDown = savedShift;
        });
        return;
      }

      // Normal click: toggle THIS track's CC enable
      withUndo("Toggle CC enabled (track)", () => {
        const isEnabled = (paramTitle.getAttribute("data-enabled") === "true");
        setTrackCCEnabled(trackObj, !isEnabled);
      });
    });

    // Build each CC control row for this track
    for (let c = 0; c < SLOT_COUNT_PER_TRK; c++) {
      const currentIndex = c;
      const rowDiv = document.createElement("div");
      rowDiv.style.display = "flex";
      rowDiv.style.flexWrap = "wrap";
      rowDiv.style.gap = "6px";
      rowDiv.style.marginBottom = "6px";

      const lbl = document.createElement("strong");
      lbl.textContent = `CC ${c + 1}: `;
      rowDiv.appendChild(lbl);

      // Destination dropdown
      const paramLabel = document.createElement("label");
      paramLabel.textContent = "Param: ";
      paramLabel.classList.add("shiftable");
      paramLabel.style.cursor = "pointer";
      paramLabel.addEventListener("mousedown", function(e) {
        if (e.shiftKey && e.target === this) {
          e.preventDefault();
          e.stopPropagation();
          withUndo(`Randomize CC destination (slot ${currentIndex + 1})`, () => {
            tracks.forEach(t => {
              if (t.paramRows && t.paramRows[currentIndex]) {
                t.paramRows[currentIndex].paramSel.value = String(1 + Math.floor(Math.random() * 24));
                t.paramRows[currentIndex].paramSel.dispatchEvent(new Event("change"));
              }
            });
          });
        }
      });
      const paramSel = document.createElement("select");
      buildParamSelectOptions(paramSel, 0);
      paramSel.value = String(c + 1);
      wireUndoForSelect(paramSel, "CC destination");
      paramLabel.appendChild(paramSel);
      rowDiv.appendChild(paramLabel);

      // "Value" Slider
      const defLabel = document.createElement("label");
      defLabel.textContent = "Value: ";
      defLabel.style.cursor = "pointer";
      defLabel.addEventListener("mousedown", function(e) {
        if (e.shiftKey && e.target === this) {
          e.preventDefault();
          e.stopPropagation();
          withUndo(`Randomize CC value (slot ${currentIndex + 1})`, () => {
            const savedShiftDown = shiftDown;
            shiftDown = false;
            tracks.forEach(t => {
              if (t.paramRows && t.paramRows[currentIndex]) {
                const slider = t.paramRows[currentIndex].defRange;
                const minVal = Number(slider.min);
                const maxVal = Number(slider.max);
                const step = Number(slider.step) || 1;
                const numSteps = Math.floor((maxVal - minVal) / step);
                const newValue = String(minVal + Math.floor(Math.random() * (numSteps + 1)) * step);
                slider.value = newValue;
                slider.dispatchEvent(new Event("input"));
              }
            });
            shiftDown = savedShiftDown;
          });
        }
      });
      const defWrap = createSliderWithValue(0, 127, 64, UI.sliderCC, true);
      attachShiftSync(defWrap.slider, t => t.paramRows && t.paramRows[currentIndex] && t.paramRows[currentIndex].defRange);
      defLabel.appendChild(defWrap.wrapper);
      rowDiv.appendChild(defLabel);

      // "Mod" Slider
      const modLabel = document.createElement("label");
      modLabel.textContent = "Mod: ";
      modLabel.style.cursor = "pointer";
      modLabel.addEventListener("mousedown", function(e) {
        if (e.shiftKey && e.target === this) {
          e.preventDefault();
          e.stopPropagation();
          withUndo(`Randomize CC mod (slot ${currentIndex + 1})`, () => {
            const savedShiftDown = shiftDown;
            shiftDown = false;
            tracks.forEach(t => {
              if (t.paramRows && t.paramRows[currentIndex]) {
                const slider = t.paramRows[currentIndex].modRange;
                const minVal = Number(slider.min);
                const maxVal = Number(slider.max);
                const step = Number(slider.step) || 1;
                const numSteps = Math.floor((maxVal - minVal) / step);
                const newValue = String(minVal + Math.floor(Math.random() * (numSteps + 1)) * step);
                slider.value = newValue;
                slider.dispatchEvent(new Event("input"));
              }
            });
            shiftDown = savedShiftDown;
          });
        }
      });
      const modWrap = createSliderWithValue(-63, 63, 0, UI.sliderCC, true);
      attachShiftSync(modWrap.slider, t => t.paramRows && t.paramRows[currentIndex] && t.paramRows[currentIndex].modRange);
      modLabel.appendChild(modWrap.wrapper);
      rowDiv.appendChild(modLabel);

      // "Curve" Dropdown
      const curveLabel = document.createElement("label");
      curveLabel.textContent = "Curve: ";
      curveLabel.style.cursor = "pointer";
      curveLabel.addEventListener("mousedown", function(e) {
        if (e.shiftKey && e.target === this) {
          e.preventDefault();
          e.stopPropagation();
          withUndo(`Randomize CC curve (slot ${currentIndex + 1})`, () => {
            const savedShiftDown = shiftDown;
            shiftDown = false;
            const curveOpts = [
              "fixed","linear","exponential","linear-inverse","exponential-inverse",
              "sine-wave","logarithmic","spike","sawtooth","random","random-inverse"
            ];
            tracks.forEach(t => {
              if (t.paramRows && t.paramRows[currentIndex]) {
                const dropdown = t.paramRows[currentIndex].curveSel;
                dropdown.value = curveOpts[Math.floor(Math.random() * curveOpts.length)];
                dropdown.dispatchEvent(new Event("change"));
              }
            });
            shiftDown = savedShiftDown;
          });
        }
      });
      const curveSel = document.createElement("select");
      [
        "fixed","linear","exponential","linear-inverse","exponential-inverse",
        "sine-wave","logarithmic","spike","sawtooth","random","random-inverse"
      ].forEach(cvVal => {
        const opt = document.createElement("option");
        opt.value = cvVal;
        opt.textContent = cvVal;
        curveSel.appendChild(opt);
      });
      wireUndoForSelect(curveSel, "CC curve");
      curveLabel.appendChild(curveSel);
      rowDiv.appendChild(curveLabel);

      paramContainer.appendChild(rowDiv);
      paramRows.push({
        paramSel: paramSel,
        defRange: defWrap.slider,
        modRange: modWrap.slider,
        curveSel: curveSel
      });
    }

    rightCol.appendChild(paramContainer);
    trackList.appendChild(trackCard);

    tracks.push(trackObj);

    updateMachineSelector(trackCard, index);
    tracks[index].machSel.dispatchEvent(new Event("change"));
    checkSkewDropdownVisibility(trackObj);
  }

  // ─────────────────────────────────────────────────────────────
  // 1) createSliderWithValue
  // ─────────────────────────────────────────────────────────────
  function createSliderWithValue(minVal, maxVal, defVal, width, showReadout, numericOnly = false, stepVal = 1) {
    const wrapper = document.createElement("span");
    wrapper.classList.add("skewclid-control");
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "6px";
    wrapper.style.maxWidth = "100%";

    const slider  = document.createElement("input");
    slider.classList.add("skewclid-range");
    slider.type   = "range";
    slider.min    = minVal;
    slider.max    = maxVal;
    slider.step   = stepVal;
    slider.value  = defVal;
    slider.style.width = width;
    slider.style.flex = "1 1 auto";
    slider.style.minWidth = "40px";

    const readout = numericOnly
      ? Object.assign(document.createElement("input"), {
          type: "number",
          min: minVal,
          max: maxVal,
          step: stepVal,
          value: defVal,
          style: `width:${UI.numberW}px`
        })
      : Object.assign(document.createElement("span"), {
          textContent: defVal,
          style: showReadout
            ? `display:inline-block;width:${UI.readoutW}px;text-align:right`
            : "display:none"
        });

    if (numericOnly) {
      readout.classList.add("skewclid-number");
    } else {
      readout.classList.add("skewclid-readout");
    }

    // Undo wiring (drag / type coalesces into one history step)
    try { wireUndoForRange(slider, "range"); } catch (_) {}
    if (numericOnly) {
      try { wireUndoForNumber(readout, "number"); } catch (_) {}
    }

    slider.addEventListener("input", () => {
      if (numericOnly) {
        readout.value = slider.value;
      } else if (showReadout) {
        readout.textContent = slider.value;
      }
    });

    if (numericOnly) {
      readout.addEventListener("input", () => {
        slider.value = readout.value;
        slider.dispatchEvent(new Event("input"));
      });
    }

    wrapper.append(slider, readout);
    return { wrapper, slider, readout };
  }

  // -----------------------------
  // Show / Hide overlay
  // -----------------------------
  function showEuclidOverlay(){
      const overlay = document.getElementById("euclidOverlay");
      if (overlay) {
        overlay.style.display = "block";
        // Preload Tone.js on first open (user gesture) so Start is instant
        // and we avoid AudioContext warnings on page-load.
        try { window.preloadToneForSkewclid?.(); } catch (_) {}
        // Only animate the scrubber/playhead while visible.
        try { startLoopScrubRAF(); } catch (e) { /* ignore */ }
      }
  }
  window.showEuclidOverlay = showEuclidOverlay;

  function hideEuclidOverlay(){
    // Stop audio when leaving the panel / hiding the overlay (prevents "ghost playback").
    try { onStop(); } catch (_) {}

    const overlay = document.getElementById("euclidOverlay");
    if (overlay) overlay.style.display = "none";
    // Stop the scrubber RAF loop when hidden (saves CPU in embedded mode).
    if (_loopScrubRAF) {
      cancelAnimationFrame(_loopScrubRAF);
      _loopScrubRAF = 0;
    }
  }
  window.hideEuclidOverlay = hideEuclidOverlay;

  function refreshSkewclidTrackSelectors() {
      tracks.forEach((trackObj, idx) => {
        updateMachineSelector(trackObj.card, idx);
      });
  }
  window.refreshSkewclidTrackSelectors = refreshSkewclidTrackSelectors;

  // -----------------------------
  // Transport functions
  // -----------------------------
  async function onStartPauseResume(e) {
    const btn = this;
    try {
      await ensureToneStarted();
    } catch (e) {
      console.error("[Skewclid] Failed to load/start Tone.js", e);
      alert("Skewclid failed to start Tone.js (see console for details).");
      return;
    }

    // Ensure Tone gets the current BPM before any scheduling.
    if (_pendingBpm != null && window.Tone && Tone.Transport && Tone.Transport.bpm) {
      try {
        Tone.Transport.bpm.value = Number(_pendingBpm) || 60;
      } catch (_) {}
    }

    if (!isTransportRunning) {
      isTransportRunning = true;
      isTransportPaused = false;
      // Shift+click Start = play this session in reverse.
      isTransportReverse = !!(e && e.shiftKey);
      btn.textContent = "Pause";

      // Recalculate loop (speed-aware) and start from the scrubber offset
      const master = calculateMasterLoopLength();
      try { Tone.Transport.seconds = _loopScrubPendingSec || 0; } catch (_) {}
      Tone.Transport.start();
      tracks.forEach(stopTrack);
      tracks.forEach((t) => startTrack(t, master, isTransportReverse));
    } else {
      if (!isTransportPaused) {
        isTransportPaused = true;
        Tone.Transport.pause();
        btn.textContent = "Resume";
      } else {
        isTransportPaused = false;
        btn.textContent = "Pause";
        Tone.Transport.start();
      }
    }
  }


  function onStop() {
    if (!isTransportRunning && !isTransportPaused) return;
    isTransportRunning = false;
    isTransportPaused = false;
    isTransportReverse = false;

    const overlayEl = document.getElementById("euclidOverlay");
    if (overlayEl) {
      const btns = overlayEl.querySelectorAll("button");
      btns.forEach((b) => {
        if (b.textContent === "Pause" || b.textContent === "Resume") {
          b.textContent = "Start";
        }
      });
    }

    // Stop Tone transport if available
    if (window.Tone && Tone.Transport) {
      try { Tone.Transport.stop(); } catch (_) {}
      try { Tone.Transport.position = 0; } catch (_) {}
    }

    // Reset loop scrubber
    _loopScrubPendingSec = 0;
    if (_loopScrubSlider) _loopScrubSlider.value = "0";
    updateLoopScrubLabels(0);

    tracks.forEach((t) => {
      stopTrack(t);
      t.stepIndex = 0;
    });
  }


  // ─────────────────────────────────────────────────────────────
  // 2) startTrack
  // ─────────────────────────────────────────────────────────────
  function startTrack(track, masterLoopLength, reverse = false) {
    if (!window.Tone || !Tone.Transport) return;
    const A     = +track.aSlider.value || 1;
    const B     = +track.bSlider.value || 1;
    const speed = +track.speedSlider.value || 1;
    const spb   = 60 / Tone.Transport.bpm.value;
    const rot   = +track.rotNum.value || 0;

    // build Euclid or skew pattern
    const pattern = (A <= B)
      ? ((SKEWCLID_OPTS.euclidAlgorithm === "legacy") ? bjorklundLegacy(B, A) : bjorklund(B, A))
      : ((SKEWCLID_OPTS.skewTiming === "legacy")
          ? generateSkewedTimingLegacy(A, B, track.skewSelect.value)
          : generateSkewedTiming(A, B, track.skewSelect.value));

    if (!pattern.length) return;

    track.pattern   = pattern;
    track.patternLen = pattern.length;

    // Loop duration (seconds):
    //   - Legacy/LCM mode: each track loops according to its own A/B length and Speed.
    //   - Cycle mode: ALL tracks share the master loop duration (Transport.loopEnd seconds).
    const baseLenBeats = (A <= B ? B : A);
    const legacyLoopDuration = ((baseLenBeats * spb) / speed);

    // In cycle mode, calculateMasterLoopLength() already cached this in seconds.
    // Fallback: derive from cycleBeats + BPM if needed.
    let cycleLoopDuration = _masterLoopSeconds;
    if (!(cycleLoopDuration > 0)) {
      const bpm = Number(Tone.Transport.bpm.value) || 60;
      const beats = Math.max(1, (parseInt(cycleBeats, 10) || 16));
      cycleLoopDuration = (beats * 60) / bpm;
    }

    const loopDuration = cycleMode ? cycleLoopDuration : legacyLoopDuration;
    const phaseShift   = (rot / 64) * loopDuration;

    let events = pattern.map((ofs, i) => {
      if (A <= B) {
        // Euclid: evenly spaced step-grid across the loop.
        return { time: i * (loopDuration / pattern.length), stepIdx: i };
      }

      // Skew: pattern[] is offsets in beats across A.
      // Cycle mode: normalize (ofs/A) then map into the shared master loop.
      if (cycleMode) {
        const phaseRaw = (Number(ofs) / (A || 1));
        const phase = Math.max(0, Math.min(0.999999999, phaseRaw)); // keep < 1 (avoid loopEnd)
        return { time: phase * loopDuration, stepIdx: i };
      }

      // Legacy mode: offsets are in beats, then scaled by Speed.
      return { time: (Number(ofs) * spb) / speed, stepIdx: i };
    });

    // Shift+click Start can run in reverse: mirror event times within the loop.
    if (reverse) {
      events = events.map(ev => {
        let t = loopDuration - ev.time;
        // If the original time was 0, we'd get loopDuration — wrap that to 0.
        if (t >= loopDuration) t = 0;
        // Safety clamp for any floating-point weirdness.
        if (t < 0) t = 0;
        return { time: t, stepIdx: ev.stepIdx };
      });
      // Tone.Part is happiest when events are time-sorted.
      events.sort((a, b) => a.time - b.time);
    }

    const part = new Tone.Part((time, ev) => {
      handleStep(track, ev.stepIdx, time);
    }, events)
      .start(phaseShift);

    part.loop    = true;
    part.loopEnd = loopDuration;
    track.loopObj = part;
  }

  function stopTrack(track) {
    if (track.loopObj) {
      const now = (window.Tone && typeof Tone.now === "function") ? Tone.now() : 0;
      try { track.loopObj.stop(now); } catch (_) {}
      try { track.loopObj.dispose(); } catch (_) {}
      track.loopObj = null;
    }
    if (track.indicator) track.indicator.style.background = "#666";
  }


  function handleStep(track, stepIdx, time){
    sendParamAndNote(track, stepIdx, time);
    track.stepIndex = (track.stepIndex + 1) % track.patternLen;
  }

  // Transport loopEnd handler is installed lazily after Tone loads (see wireToneTransportOnce).

  // -----------------------------
  // Mute / Solo logic
  // -----------------------------
  function isTrackActive(t){
    const anySolo = tracks.some(x => x.isSolo);
    if(anySolo){
      return t.isSolo;
    } else {
      return !t.isMuted;
    }
  }

  function updateAllMuteSoloStates(){
    const anySolo = tracks.some(t => t.isSolo);
    tracks.forEach(t => {
      t.isActive = (anySolo) ? t.isSolo : !t.isMuted;
      if(t.isSolo){
        t.card.style.borderColor = "var(--skew-ok)";
      } else if(t.isMuted){
        t.card.style.borderColor = "var(--skew-danger)";
      } else {
        t.card.style.borderColor = "var(--skew-border)";
      }
      t.card.style.background = t.isActive ? "var(--skew-panel-2)" : "var(--skew-panel)";
    });
  }

  // -----------------------------
  // CC enable/disable helper (keeps UI + state in sync)
  // -----------------------------
  function setTrackCCEnabled(trackObj, on) {
    const enabled = !!on;
    trackObj.ccEnabled = enabled;

    // Header toggle
    if (trackObj.paramTitle) {
      trackObj.paramTitle.setAttribute("data-enabled", String(enabled));
    }

    // Grey out the container
    if (trackObj.paramContainer) {
      trackObj.paramContainer.style.opacity = enabled ? "1" : "0.55";
    }

    // Disable/enable every control in the CC rows
    if (trackObj.paramRows && trackObj.paramRows.forEach) {
      trackObj.paramRows.forEach(row => {
        if (!row) return;
        if (row.paramSel)  row.paramSel.disabled  = !enabled;
        if (row.defRange)  row.defRange.disabled  = !enabled;
        if (row.modRange)  row.modRange.disabled  = !enabled;
        if (row.curveSel)  row.curveSel.disabled  = !enabled;
      });
    }
  }


  // -----------------------------
  // Send parameter / note messages
  // -----------------------------
  function sendParamAndNote(track, step, time) {
    if (!isTrackActive(track)) return;

    // MD base channel encoding: 0..12 => MIDI ch 1..13, 13 => OFF
    let midiChan = (window.globalData && typeof window.globalData.midiBase === "number")
                     ? (window.globalData.midiBase | 0)
                     : 0;
    if (midiChan === 13) {
      if (!window.__warnedBaseOffSkewclid) {
        console.warn("[Skewclid] MIDI Base Channel is OFF. Set it to 1–13 to use Skewclid.");
        window.__warnedBaseOffSkewclid = true;
      }
      return;
    }
    if (midiChan < 0) midiChan = 0;
    if (midiChan > 12) midiChan = 12;
    const prob = parseInt(track.probSlider.value, 10) || 100;
    if (Math.random() * 100 > prob) return;

    const midiOut = window.selectedMidiOut;
    if (!midiOut) return;

    const tv = parseInt(track.tvSlider.value, 10) || 0;
    let offsetSec = (tv >= 0) ? Math.random() * (tv / 1000) : -Math.random() * (Math.abs(tv) / 1000);
    const scheduledTime = Math.max(time + offsetSec, Tone.now());
    const startMs = (scheduledTime - Tone.now()) * 1000 + performance.now();

    const A = parseFloat(track.aSlider.value) || 1;
    const B = parseFloat(track.bSlider.value) || 1;
    const isSkew = (A > B);

    const velType = track.velSel.value;

    // Curve progress:
    //   - Euclid mode: event index (legacy behavior)
    //   - Skew mode: (optionally) use time position (ofs/A) so curves "follow the loop"
    const eventIndexFrac = step / ((track.patternLen - 1) || 1);
    const timeFrac = isSkew ? (Number(track.pattern[step]) / (A || 1)) : eventIndexFrac;
    const curveFrac = (isSkew && SKEWCLID_OPTS.skewCurvesUseTime)
      ? _clamp01(timeFrac)
      : _clamp01(eventIndexFrac);

    let curveVal = calculateCurveValue(velType, curveFrac);
    let velDef = parseInt(track.velDef.value, 10) || 100;
    let velMod = parseInt(track.velMod.value, 10) || 0;
    let velocity = velDef + curveVal * velMod;
    if (velocity < 1) velocity = 1;
    if (velocity > 127) velocity = 127;
    velocity = Math.round(velocity);

    // Global keymap may be:
    //  - track->note (length >= 16)
    //  - note->track (MD global dump, length >= 128, often Uint8Array)
    // Accept both Arrays and TypedArrays.
    const __defaultTrackNotes = [36, 38, 40, 41, 43, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60, 62];
    const rawMap = window.globalData && window.globalData.keymap;
    let keymap = null;
    if (rawMap && (Array.isArray(rawMap) || ArrayBuffer.isView(rawMap))) {
      // If it's a full 128-byte map, treat as note->track and invert.
      if (rawMap.length >= 128) {
        const out = __defaultTrackNotes.slice();
        for (let t = 0; t < 16; t++) {
          let found = -1;
          for (let note = 0; note < 128; note++) {
            if ((rawMap[note] & 0x7F) === t) { found = note; break; }
          }
          if (found >= 0) out[t] = found;
        }
        keymap = out;
      } else if (rawMap.length >= 16) {
        const out = [];
        for (let t = 0; t < 16; t++) {
          const n = Number(rawMap[t]);
          out[t] = Number.isFinite(n) ? (n & 0x7F) : __defaultTrackNotes[t];
        }
        keymap = out;
      }
    }
    if (!keymap) keymap = __defaultTrackNotes;
    const selValue   = track.machSel.value;
    const trackIndex = parseInt(selValue, 10) - 1;
    const midiNote   = keymap[trackIndex] || 36;

    // CC Message
    if (track.ccEnabled) {
      track.paramRows.forEach(slot => {
        const chosenParam = (parseInt(slot.paramSel.value, 10) || 1) - 1;
        const defVal = parseInt(slot.defRange.value, 10) || 64;
        const modVal = parseInt(slot.modRange.value, 10) || 0;
        const ccCurve = slot.curveSel.value;
        let scv = calculateCurveValue(ccCurve, curveFrac);
        let finalVal = defVal + scv * modVal;
        if (finalVal < 0) finalVal = 0;
        if (finalVal > 127) finalVal = 127;

        const mdTrack = parseInt(track.machSel.value, 10) || 1;
        const mapObj = window.MD_CC_MAP && window.MD_CC_MAP[mdTrack];
        const ccNum = (mapObj && mapObj.param[chosenParam] !== undefined)
                      ? mapObj.param[chosenParam]
                      : ((chosenParam + 30) & 0x7F);

        const group = Math.floor((mdTrack - 1) / 4) + 1;
        const ccChannel = midiChan + (group - 1);
        midiOut.send([0xB0 | (ccChannel & 0x0F), ccNum, Math.round(finalVal)], startMs);
      });
    }

    // Decide if we trigger a note:
    let triggerNote = false;
    if (isSkew) {
      const mode = String(SKEWCLID_OPTS.skewGate || "legacyHalf");
      if (mode === "all") {
        // v2/default (recommended): every skew event is a hit → exactly B hits in an A-beat loop
        triggerNote = true;
      } else if (mode === "none") {
        triggerNote = false;
      } else {
        // legacyHalf: only trigger notes for events in the latter half of the loop
        const threshold = A * 0.5;
        const ofs = Number(track.pattern[step]);
        if (Number.isFinite(ofs) && ofs >= threshold) triggerNote = true;
      }
    } else {
      if (track.pattern[step] === 1) triggerNote = true;
    }

    if (triggerNote) {
      midiOut.send([0x90 | midiChan, midiNote, velocity], startMs);
      midiOut.send([0x80 | midiChan, midiNote, 0], startMs + 150);
      if (track.indicator) {
        Tone.Draw.schedule(() => {
          track.indicator.style.background = "lime";
          setTimeout(() => {
            track.indicator.style.background = "#666";
          }, 100);
        }, scheduledTime);
      }
    }
  }

  function calculateCurveValue(type, frac){
    switch(type){
      case "linear":              return frac;
      case "exponential":         return frac * frac;
      case "linear-inverse":      return 1 - frac;
      case "exponential-inverse": return 1 - (frac * frac);
      case "sine-wave":           return 0.5 + 0.5 * Math.sin(frac * Math.PI * 2);
      case "logarithmic": {
        const safeFrac = Math.max(0.00001, frac);
        return Math.log(safeFrac * 9 + 1) / Math.log(10);
      }
      case "spike":               return (frac > 0.49 && frac < 0.51) ? 1 : 0.2;
      case "sawtooth":            return frac;
      case "random":              return Math.random();
      case "random-inverse":      return 1 - Math.random();
      default:                    return 1.0;
    }
  }

  function buildParamSelectOptions(selectEl, machineID) {
    selectEl.innerHTML = "";
    for(let p = 1; p <= 24; p++){
      const opt = document.createElement("option");
      opt.value = String(p);
      let category, paramIndex;
      if (p <= 8) {
        category = "machineParams";
        paramIndex = p - 1;
      } else if (p <= 16) {
        category = "trackFx";
        paramIndex = p - 9;
      } else {
        category = "routing";
        paramIndex = p - 17;
      }
      let label = "";
      if (category === "trackFx" && typeof getSpecialTrackFxLabel === "function") {
        label = getSpecialTrackFxLabel(machineID, paramIndex);
      } else if (category === "routing" && typeof getSpecialRoutingLabel === "function") {
        label = getSpecialRoutingLabel(machineID, paramIndex);
      }
      if (!label && typeof getParamLabel === "function") {
        label = getParamLabel(machineID, paramIndex, category);
      }
      if (!label) {
        label = `Param#${p}`;
      }
      opt.textContent = label;
      selectEl.appendChild(opt);
    }
  }

  // -----------------------------
  // Bjorklund / Skew timing
  // -----------------------------
  function bjorklundLegacy(steps, pulses){
    // NOTE: Legacy implementation kept for backwards-compatibility only.
    // It can return a pattern length != steps for some A/B combos.
    if(pulses > steps) pulses = steps;
    if(pulses === 0)   return new Array(steps).fill(0);
    if(pulses === steps)return new Array(steps).fill(1);

    let pattern=[], counts=[], remainders=[];
    let divisor = steps - pulses;
    let remainder = pulses;
    remainders.push(remainder);
    let level = 0;
    while(true){
      counts.push(Math.floor(divisor / remainder));
      remainders.push(divisor % remainder);
      divisor = remainder;
      remainder = remainders[level];
      level++;
      if(remainder <= 1) break;
    }
    counts.push(divisor);
    function build(l){
      if(l === -1) pattern.push(0);
      else if(l === -2) pattern.push(1);
      else{
        for(let i = 0; i < counts[l]; i++){
          build(l - 1);
        }
        if(remainders[l] !== 0){
          build(l - 2);
        }
      }
    }
    build(level);
    return pattern;
  }

  function bjorklund(steps, pulses){
    // Correct Bjorklund (Euclidean rhythm) implementation.
    steps  = Math.max(1, steps | 0);
    pulses = Math.max(0, Math.min(steps, pulses | 0));

    if (pulses === 0)     return new Array(steps).fill(0);
    if (pulses === steps) return new Array(steps).fill(1);

    const pattern   = [];
    const counts    = [];
    const remainders = [];

    let divisor = steps - pulses;
    remainders.push(pulses);

    let level = 0;
    while (true) {
      counts.push(Math.floor(divisor / remainders[level]));
      remainders.push(divisor % remainders[level]);
      divisor = remainders[level];
      level += 1;
      if (remainders[level] <= 1) break;
    }
    counts.push(divisor);

    function build(l) {
      if (l === -1) pattern.push(0);
      else if (l === -2) pattern.push(1);
      else {
        for (let i = 0; i < counts[l]; i++) build(l - 1);
        if (remainders[l] !== 0) build(l - 2);
      }
    }

    build(level);
    return pattern.reverse(); // orientation isn't important (rotation/phase handles it)
  }

  function generateSkewedTimingLegacy(A, B, curveType = "sine"){
    // NOTE: Legacy generator kept for backwards-compatibility only.
    // It can generate offsets in [0, A] (inclusive), and can produce duplicates.
    const total = A;
    const arr = [];
    for(let i = 0; i < B; i++){
      let frac = (B === 1) ? 0.5 : i / (B - 1);
      let val;
      switch(curveType){
        case "elastic": {
          const osc = 3;
          const damping = 0.5;
          let elast = Math.sin(frac * Math.PI * osc) * Math.exp(-frac * damping);
          elast = (elast + 1) / 2;
          val = elast;
          break;
        }
        case "exponential":
          val = Math.pow(frac, 2);
          break;
        case "logarithmic":
          val = Math.log1p(frac * 9) / Math.log(10);
          break;
        default:
          // "sine"
          val = (Math.sin(frac * Math.PI) + 1) / 2;
      }
      arr.push(val * total);
    }
    arr.sort((x, y) => x - y);
    return arr;
  }

  function generateSkewedTiming(A, B, curveType = "sine"){
    // v2 skew generator:
    //   - uses frac in [0, 1) so we never schedule an event exactly at loopEnd
    //   - "sine" is a 0..1 easing (not the legacy 0.5..1..0.5 back-loaded shape)
    //   - clamps and de-dupes times to avoid doubled events at the same offset
    const total = Math.max(1e-9, Number(A) || 1);
    const hits  = Math.max(1, (Number(B) || 1) | 0);

    const MAX_F = 0.999999999; // keep < 1 to avoid ofs === A (loopEnd)
    const EPS   = 1e-6;        // minimum spacing in beats (after sorting)

    function ease(type, x){
      switch(type){
        case "exponential":
          return x * x;
        case "logarithmic":
          return Math.log1p(x * 9) / Math.log(10);
        case "sine":
          // easeInOutSine: 0..1 (monotonic)
          return 0.5 - 0.5 * Math.cos(x * Math.PI);
        case "elastic": {
          // Keep the "wiggle", but clamp after.
          const osc = 3;
          const damping = 0.5;
          let elast = Math.sin(x * Math.PI * osc) * Math.exp(-x * damping);
          return (elast + 1) / 2;
        }
        default:
          return x;
      }
    }

    const arr = new Array(hits);
    for(let i = 0; i < hits; i++){
      const frac = (hits === 1) ? 0.5 : (i / hits); // max < 1
      let v = ease(curveType, frac);
      if (!Number.isFinite(v)) v = 0;
      v = Math.max(0, Math.min(MAX_F, v));
      arr[i] = v * total;
    }

    // Elastic isn't monotonic, so always sort.
    arr.sort((x, y) => x - y);

    // De-dup / enforce increasing (prevents double events at identical times).
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] <= arr[i - 1]) {
        arr[i] = Math.min(total - EPS, arr[i - 1] + EPS);
      }
    }
    return arr;
  }

  // -----------------------------
  // Reset / Randomize
  // -----------------------------
  function resetAllParameters(){
    isBatchUpdating = true;

    tracks.forEach(t => {
      t.aSlider.value = "1"; t.aSlider.dispatchEvent(new Event("input"));
      t.bSlider.value = "1"; t.bSlider.dispatchEvent(new Event("input"));
      t.rotNum.value  = "0"; t.rotNum.dispatchEvent(new Event("input"));
      t.speedSlider.value = "1"; t.speedSlider.dispatchEvent(new Event("input"));
      t.probSlider.value  = "100"; t.probSlider.dispatchEvent(new Event("input"));
      t.tvSlider.value    = "0";   t.tvSlider.dispatchEvent(new Event("input"));
      t.velSel.value = "fixed";
      t.velDef.value = "100"; t.velDef.dispatchEvent(new Event("input"));
      t.velMod.value = "0";   t.velMod.dispatchEvent(new Event("input"));
      if (t.skewSelect) t.skewSelect.value = "sine";
      t.paramRows.forEach((row, i) => {
        row.paramSel.value    = String(i+1);
        row.defRange.value    = "64"; row.defRange.dispatchEvent(new Event("input"));
        row.modRange.value    = "0";  row.modRange.dispatchEvent(new Event("input"));
        row.curveSel.value    = "fixed";
      });
      t.machSel.value = String(t.index+1);
      // Default: start with Param Controls OFF (greyed out)
      setTrackCCEnabled(t, false);
    });

    updateAllMuteSoloStates();
    isBatchUpdating = false;

    // Always refresh the computed loop (so the scrubber reflects new settings)
    const master = calculateMasterLoopLength();

    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.resetAllParameters = resetAllParameters;

  // ─────────────────────────────────────────────────────────────
  // 3) randomizeAllParameters
  // ─────────────────────────────────────────────────────────────
  function randomizeAllParameters() {
    const ov = document.getElementById("euclidOverlay");
    ov.style.visibility = "hidden";

    isBatchUpdating = true;

    tracks.forEach(t => {
      // — A & B —
      const A = 1 + Math.floor(Math.random() * 64);
      t.aSlider.value = A;
      t.aNum.textContent = A;
      t.aSlider.dispatchEvent(new Event("input"));

      const B = 1 + Math.floor(Math.random() * 64);
      t.bSlider.value = B;
      t.bNum.textContent = B;
      t.bSlider.dispatchEvent(new Event("input"));

      // — Rotation —
      const R = Math.floor(Math.random() * 64);
      t.rotNum.value = String(R);
      t.rotNum.dispatchEvent(new Event("input"));

      // — Speed —
      // Quantize to the UI step (0.25) so speed-aware super-loops stay reasonable
      const spMin = 0.25;
      const spMax = 5;
      const spStep = 0.25;
      const spSteps = Math.round((spMax - spMin) / spStep);
      const S = (spMin + spStep * Math.floor(Math.random() * (spSteps + 1))).toFixed(2);
      t.speedSlider.value = S;
      t.speedSlider.dispatchEvent(new Event("input"));

      // — Probability —
      const P = Math.floor(Math.random() * 101);
      t.probSlider.value = P;
      t.probNum.textContent = P;

      // — Timing Var —
      const TV = Math.floor(Math.random() * 201) - 100;
      t.tvSlider.value = TV;
      t.tvNum.textContent = TV;

      // — Velocity Def/Mod & Curve —
      const VD = Math.floor(Math.random() * 128);
      t.velDef.value = VD;
      t.velDef.nextElementSibling.textContent = VD;

      const VM = Math.floor(Math.random() * 127) - 63;
      t.velMod.value = VM;
      t.velMod.nextElementSibling.textContent = VM;

      t.velSel.value = ["fixed","linear","exponential","random"][Math.floor(Math.random()*4)];

      // — Skew Curve —
      if (t.skewSelect) {
        t.skewSelect.value = ["sine","elastic","exponential","logarithmic"][Math.floor(Math.random()*4)];
      }

      // — CC slots —
      t.paramRows.forEach(r => {
        const D = Math.floor(Math.random() * 128);
        r.defRange.value = D;
        r.defRange.nextElementSibling.textContent = D;

        const M2 = Math.floor(Math.random() * 127) - 63;
        r.modRange.value = M2;
        r.modRange.nextElementSibling.textContent = M2;

        r.curveSel.value = ["fixed","linear","exponential","random"][Math.floor(Math.random()*4)];
      });
    });

    // one single update of mute/solo visuals
    updateAllMuteSoloStates();

    isBatchUpdating = false;
    // restore overlay
    ov.style.visibility = "visible";

    // one single re‑sync of the loop
    if (window.Tone && Tone.Transport && Tone.Transport.state === "started") {
      const master = calculateMasterLoopLength();
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllParameters = randomizeAllParameters;

  // ─────────────────────────────────────────────────────────────
  // Shift+click 🎲 : same randomize, but forces *deterministic, active* envelopes
  //   - excludes: fixed, random, random-inverse
  // ─────────────────────────────────────────────────────────────
  function randomizeAllParametersDeterministicEnvelopes() {
    const ov = document.getElementById("euclidOverlay");
    ov.style.visibility = "hidden";

    // Active, deterministic curve types (shared by velocity + CC envelopes)
    const detCurveOpts = [
      "linear",
      "exponential",
      "linear-inverse",
      "exponential-inverse",
      "sine-wave",
      "logarithmic",
      "spike",
      "sawtooth"
    ];

    isBatchUpdating = true;

    tracks.forEach(t => {
      // — A & B —
      const A = 1 + Math.floor(Math.random() * 64);
      t.aSlider.value = A;
      t.aNum.textContent = A;
      t.aSlider.dispatchEvent(new Event("input"));

      const B = 1 + Math.floor(Math.random() * 64);
      t.bSlider.value = B;
      t.bNum.textContent = B;
      t.bSlider.dispatchEvent(new Event("input"));

      // — Rotation —
      const R = Math.floor(Math.random() * 64);
      t.rotNum.value = String(R);
      t.rotNum.dispatchEvent(new Event("input"));

      // — Speed — (keep the regular quantized behaviour)
      const spMin = 0.25;
      const spMax = 5;
      const spStep = 0.25;
      const spSteps = Math.round((spMax - spMin) / spStep);
      const S = (spMin + spStep * Math.floor(Math.random() * (spSteps + 1))).toFixed(2);
      t.speedSlider.value = S;
      t.speedSlider.dispatchEvent(new Event("input"));

      // — Probability —
      const P = Math.floor(Math.random() * 101);
      t.probSlider.value = P;
      t.probNum.textContent = P;

      // — Timing Var —
      const TV = Math.floor(Math.random() * 201) - 100;
      t.tvSlider.value = TV;
      t.tvNum.textContent = TV;

      // — Velocity Def/Mod & Curve —
      const VD = Math.floor(Math.random() * 128);
      t.velDef.value = VD;
      t.velDef.nextElementSibling.textContent = VD;

      const VM = Math.floor(Math.random() * 127) - 63;
      t.velMod.value = VM;
      t.velMod.nextElementSibling.textContent = VM;

      t.velSel.value = detCurveOpts[Math.floor(Math.random() * detCurveOpts.length)];

      // — Skew Curve —
      if (t.skewSelect) {
        t.skewSelect.value = ["sine","elastic","exponential","logarithmic"][Math.floor(Math.random()*4)];
      }

      // — CC slots —
      t.paramRows.forEach(r => {
        const D = Math.floor(Math.random() * 128);
        r.defRange.value = D;
        r.defRange.nextElementSibling.textContent = D;

        const M2 = Math.floor(Math.random() * 127) - 63;
        r.modRange.value = M2;
        r.modRange.nextElementSibling.textContent = M2;

        r.curveSel.value = detCurveOpts[Math.floor(Math.random() * detCurveOpts.length)];
      });
    });

    updateAllMuteSoloStates();

    isBatchUpdating = false;
    ov.style.visibility = "visible";

    if (window.Tone && Tone.Transport && Tone.Transport.state === "started") {
      const master = calculateMasterLoopLength();
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllParametersDeterministicEnvelopes = randomizeAllParametersDeterministicEnvelopes;

  // ─────────────────────────────────────────────────────────────
  // Targeted randomization helpers (for the preset-row mini buttons)
  // ─────────────────────────────────────────────────────────────
  function randomizeAllAB() {
    isBatchUpdating = true;
    tracks.forEach(t => {
      const A = 1 + Math.floor(Math.random() * 64);
      const B = 1 + Math.floor(Math.random() * 64);
      t.aSlider.value = String(A);
      t.aSlider.dispatchEvent(new Event("input"));
      t.bSlider.value = String(B);
      t.bSlider.dispatchEvent(new Event("input"));
    });
    isBatchUpdating = false;

    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllAB = randomizeAllAB;

  // Shift+click AB: bias towards musically useful step-counts and avoid always-64 chaos.
  // Mixes Euclid (A<=B) and Skew (A>B) for variety.
  function randomizeAllABMusical() {
    const stepChoices = [4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64];
    isBatchUpdating = true;
    tracks.forEach(t => {
      const useSkew = Math.random() < 0.35; // keep it mostly Euclid, but sprinkle Skew

      if (!useSkew) {
        // Euclid: A = hits, B = steps
        const B = stepChoices[Math.floor(Math.random() * stepChoices.length)];
        const maxA = Math.max(1, Math.min(64, B - 1));
        // Prefer non-trivial hit counts.
        const minA = Math.min(maxA, (B >= 8 ? 2 : 1));
        const A = minA + Math.floor(Math.random() * (maxA - minA + 1));

        t.aSlider.value = String(A);
        t.aSlider.dispatchEvent(new Event("input"));
        t.bSlider.value = String(B);
        t.bSlider.dispatchEvent(new Event("input"));
      } else {
        // Skew: A = length (beats/steps), B = hits
        const A = stepChoices[Math.floor(Math.random() * stepChoices.length)];
        const maxB = Math.max(1, Math.min(64, Math.min(16, A - 1)));
        const B = 1 + Math.floor(Math.random() * maxB);

        t.aSlider.value = String(A);
        t.aSlider.dispatchEvent(new Event("input"));
        t.bSlider.value = String(B);
        t.bSlider.dispatchEvent(new Event("input"));
      }
    });
    isBatchUpdating = false;

    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllABMusical = randomizeAllABMusical;

  function randomizeAllRotations() {
    isBatchUpdating = true;
    tracks.forEach(t => {
      t.rotNum.value = String(Math.floor(Math.random() * 64));
      t.rotNum.dispatchEvent(new Event("input"));
    });
    isBatchUpdating = false;

    // Rotation doesn't change loop length, but DOES require rescheduling for phase shift.
    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllRotations = randomizeAllRotations;

  // Shift+click ⟳: one shared rotation across all tracks (more coherent groove-phase).
  function randomizeAllRotationsGlobal() {
    const R = Math.floor(Math.random() * 64);
    isBatchUpdating = true;
    tracks.forEach(t => {
      t.rotNum.value = String(R);
      t.rotNum.dispatchEvent(new Event("input"));
    });
    isBatchUpdating = false;

    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllRotationsGlobal = randomizeAllRotationsGlobal;

  function randomizeAllSpeeds() {
    const spMin = 0.25;
    const spMax = 5;
    const spStep = 0.25;
    const spSteps = Math.round((spMax - spMin) / spStep);
    isBatchUpdating = true;
    tracks.forEach(t => {
      const sp = spMin + spStep * Math.floor(Math.random() * (spSteps + 1));
      t.speedSlider.value = sp.toFixed(2);
      t.speedSlider.dispatchEvent(new Event("input"));
    });
    isBatchUpdating = false;

    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllSpeeds = randomizeAllSpeeds;

  // Shift+click ⚡: un-quantized speeds for wilder polyrhythms.
  function randomizeAllSpeedsTrueRandom() {
    const spMin = 0.25;
    const spMax = 5;
    isBatchUpdating = true;
    tracks.forEach(t => {
      const sp = spMin + Math.random() * (spMax - spMin);
      t.speedSlider.value = sp.toFixed(2);
      t.speedSlider.dispatchEvent(new Event("input"));
    });
    isBatchUpdating = false;

    const master = calculateMasterLoopLength();
    if (window.Tone && Tone.Transport.state === "started") {
      tracks.forEach(stopTrack);
      tracks.forEach(t => startTrack(t, master, isTransportReverse));
    }
  }
  window.randomizeAllSpeedsTrueRandom = randomizeAllSpeedsTrueRandom;

  function randomizeAllCCValues() {
    const curveOpts = ["fixed", "linear", "exponential", "random"];
    isBatchUpdating = true;
    tracks.forEach(t => {
      t.paramRows.forEach(r => {
        const D = Math.floor(Math.random() * 128);
        r.defRange.value = String(D);
        r.defRange.dispatchEvent(new Event("input"));

        const M = Math.floor(Math.random() * 127) - 63;
        r.modRange.value = String(M);
        r.modRange.dispatchEvent(new Event("input"));

        r.curveSel.value = curveOpts[Math.floor(Math.random() * curveOpts.length)];
      });
    });
    isBatchUpdating = false;

    // CC value changes are not timing-critical; no transport reschedule needed.
    calculateMasterLoopLength();
  }
  window.randomizeAllCCValues = randomizeAllCCValues;

  // Shift+click ≋: deterministic (no fixed/random) CC envelopes, and ensure modulation isn't zero.
  function randomizeAllCCValuesDeterministic() {
    const curveOpts = [
      "linear",
      "exponential",
      "linear-inverse",
      "exponential-inverse",
      "sine-wave",
      "logarithmic",
      "spike",
      "sawtooth"
    ];

    isBatchUpdating = true;
    tracks.forEach(t => {
      t.paramRows.forEach(r => {
        const D = Math.floor(Math.random() * 128);
        r.defRange.value = String(D);
        r.defRange.dispatchEvent(new Event("input"));

        // Non-zero modulation so the envelope is actually "active".
        let M = Math.floor(Math.random() * 127) - 63;
        if (M === 0) {
          const mag = 1 + Math.floor(Math.random() * 62);
          M = (Math.random() < 0.5 ? -mag : mag);
        }
        r.modRange.value = String(M);
        r.modRange.dispatchEvent(new Event("input"));

        r.curveSel.value = curveOpts[Math.floor(Math.random() * curveOpts.length)];
      });
    });
    isBatchUpdating = false;

    // CC changes are not timing-critical.
    calculateMasterLoopLength();
  }
  window.randomizeAllCCValuesDeterministic = randomizeAllCCValuesDeterministic;

  function randomizeAllParamDestinations(){
    tracks.forEach(t => {
      t.paramRows.forEach(row => {
        row.paramSel.value = String(1 + Math.floor(Math.random() * 24));
      });
    });
  }

  // Shift+click CC: pick one destination per slot index (shared across all tracks)
  function randomizeAllParamDestinationsBySlot(){
    for (let s = 0; s < SLOT_COUNT_PER_TRK; s++) {
      const dest = String(1 + Math.floor(Math.random() * 24));
      tracks.forEach(t => {
        const row = t.paramRows && t.paramRows[s];
        if (row && row.paramSel) row.paramSel.value = dest;
      });
    }
  }
  window.randomizeAllParamDestinationsBySlot = randomizeAllParamDestinationsBySlot;

  function resetTrack(track) {
    track.aSlider.value = "1"; track.aSlider.dispatchEvent(new Event("input"));
    track.bSlider.value = "1"; track.bSlider.dispatchEvent(new Event("input"));
    track.rotNum.value  = "0"; track.rotNum.dispatchEvent(new Event("input"));
    track.speedSlider.value = "1"; track.speedSlider.dispatchEvent(new Event("input"));
    track.probSlider.value  = "100"; track.probSlider.dispatchEvent(new Event("input"));
    track.tvSlider.value    = "0";   track.tvSlider.dispatchEvent(new Event("input"));
    track.velSel.value      = "fixed";
    track.velDef.value      = "100"; track.velDef.dispatchEvent(new Event("input"));
    track.velMod.value      = "0";   track.velMod.dispatchEvent(new Event("input"));
    if(track.skewSelect) track.skewSelect.value = "sine";
    track.paramRows.forEach((row, i) => {
      row.paramSel.value = String(i + 1);
      row.defRange.value = "64"; row.defRange.dispatchEvent(new Event("input"));
      row.modRange.value = "0";  row.modRange.dispatchEvent(new Event("input"));
      row.curveSel.value = "fixed";
    });
    setTrackCCEnabled(track, false);
  }

  function randomizeTrack(track) {
    const savedShiftDown = shiftDown;
    shiftDown = false;
    track.aSlider.value = String(1 + Math.floor(Math.random() * 64));
    track.aSlider.dispatchEvent(new Event("input"));
    track.bSlider.value = String(1 + Math.floor(Math.random() * 64));
    track.bSlider.dispatchEvent(new Event("input"));
    track.rotNum.value = String(Math.floor(Math.random() * 64));
    track.rotNum.dispatchEvent(new Event("input"));
    const spMin = 0.25;
    const spMax = 5;
    const spStep = 0.25;
    const spSteps = Math.round((spMax - spMin) / spStep);
    const sp = spMin + spStep * Math.floor(Math.random() * (spSteps + 1));
    track.speedSlider.value = sp.toFixed(2);
    track.speedSlider.dispatchEvent(new Event("input"));
    track.probSlider.value = String(Math.floor(Math.random() * 101));
    track.probSlider.dispatchEvent(new Event("input"));
    track.tvSlider.value = String(Math.floor(Math.random() * 201) - 100);
    track.tvSlider.dispatchEvent(new Event("input"));
    const vcList = [
      "fixed", "linear", "exponential", "linear-inverse", "exponential-inverse",
      "sine-wave", "logarithmic", "spike", "sawtooth", "random", "random-inverse"
    ];
    track.velSel.value = vcList[Math.floor(Math.random() * vcList.length)];
    track.velDef.value = String(Math.floor(Math.random() * 128));
    track.velDef.dispatchEvent(new Event("input"));
    track.velMod.value = String(Math.floor(Math.random() * 127) - 63);
    track.velMod.dispatchEvent(new Event("input"));
    if(track.skewSelect){
      const skewOpts = ["sine", "elastic", "exponential", "logarithmic"];
      track.skewSelect.value = skewOpts[Math.floor(Math.random() * skewOpts.length)];
    }
    track.paramRows.forEach((row, i) => {
      row.defRange.value = String(Math.floor(Math.random() * 128));
      row.defRange.dispatchEvent(new Event("input"));
      row.modRange.value = String(Math.floor(Math.random() * 127) - 63);
      row.modRange.dispatchEvent(new Event("input"));
      row.curveSel.value = vcList[Math.floor(Math.random() * vcList.length)];
    });
        shiftDown = savedShiftDown;
  }

  // -----------------------------
  // Preset gather / apply
  // -----------------------------
  function gatherState(){
    const data = {
      bpm: parseInt(globalBpmSlider.value, 10),
      cycleMode: !!cycleMode,
      cycleBeats: Math.max(1, (parseInt(cycleBeats, 10) || 16)),
      tracks: []
    };
    tracks.forEach(t => {
      const obj = {
        A: parseInt(t.aSlider.value, 10),
        B: parseInt(t.bSlider.value, 10),
        rot: parseInt(t.rotNum.value, 10),
        speed: parseFloat(t.speedSlider.value),
        probability: parseInt(t.probSlider.value, 10),
        timingVar: parseInt(t.tvSlider.value, 10),
        velCurve: t.velSel.value,
        trackSel: parseInt(t.machSel.value, 10),
        velDef: parseInt(t.velDef.value, 10),
        velMod: parseInt(t.velMod.value, 10),
        skewCurve: t.skewSelect ? t.skewSelect.value : "sine",
        isMuted: !!t.isMuted,
        isSolo: !!t.isSolo,
        ccEnabled: (t.ccEnabled !== undefined ? !!t.ccEnabled : true),
        paramSlots: []
      };
      t.paramRows.forEach(r => {
        obj.paramSlots.push({
          paramID: r.paramSel.value,
          defVal : r.defRange.value,
          modVal : r.modRange.value,
          curve  : r.curveSel.value
        });
      });
      data.tracks.push(obj);
    });
    return data;
  }
  window.gatherState = gatherState;

  // ─────────────────────────────────────────────────────────────
  // 4) applyPreset → same batch‐mode pattern for instant load
  // ─────────────────────────────────────────────────────────────
  function applyPreset(pre, _opts = {}) {
    if (!pre || !pre.tracks) return;

    // Restore cycle-lock settings if present (backwards-compatible with older presets)
    if (pre.cycleMode != null) {
      cycleMode = !!pre.cycleMode;
    }
    if (pre.cycleBeats != null) {
      const b = parseInt(pre.cycleBeats, 10);
      if (Number.isFinite(b) && b > 0) cycleBeats = b;
    }
    try { saveCyclePrefs(); } catch (_) {}
    try { updateCycleUi(); } catch (_) {}


    const wasPlaying = (window.Tone && Tone.Transport && Tone.Transport.state === "started" && !isTransportPaused);

    isBatchUpdating = true;

    // set BPM (store locally if Tone isn't loaded yet)
    if (pre.bpm != null) {
      _pendingBpm = pre.bpm;
      globalBpmSlider.value = pre.bpm;
      globalBpmSlider.dispatchEvent(new Event("input"));
      if (window.Tone && Tone.Transport && Tone.Transport.bpm) {
        try { Tone.Transport.bpm.value = pre.bpm; } catch (_) {}
      }
    }

    // apply each track
    pre.tracks.forEach((pt, i) => {
      const t = tracks[i];
      if (!t) return;

      // A/B: set slider + dispatch its input so readout updates
      t.aSlider.value = `${pt.A || 1}`;
      t.aSlider.dispatchEvent(new Event("input"));
      t.bSlider.value = `${pt.B || 1}`;
      t.bSlider.dispatchEvent(new Event("input"));

      // rot/speed/prob/tv (these already dispatch in your original)
      t.rotNum.value      = `${pt.rot || 0}`;      t.rotNum.dispatchEvent(new Event("input"));
      t.speedSlider.value = `${pt.speed || 1}`;    t.speedSlider.dispatchEvent(new Event("input"));
      t.probSlider.value  = `${pt.probability || 100}`; t.probSlider.dispatchEvent(new Event("input"));
      t.tvSlider.value    = `${pt.timingVar || 0}`;     t.tvSlider.dispatchEvent(new Event("input"));

      // velocity & skew
      t.velSel.value = pt.velCurve || "fixed";
      t.velDef.value = `${pt.velDef || 100}`; t.velDef.dispatchEvent(new Event("input"));
      t.velMod.value = `${pt.velMod || 0}`;   t.velMod.dispatchEvent(new Event("input"));
      if (t.skewSelect) {
        t.skewSelect.value = pt.skewCurve || "sine";
      }

      // CC slots
      pt.paramSlots.forEach((ps, idx) => {
        const r = t.paramRows[idx];
        if (!r) return;
        r.paramSel.value = ps.paramID || r.paramSel.value;
        r.defRange.value = `${ps.defVal || r.defRange.value}`; r.defRange.dispatchEvent(new Event("input"));
        r.modRange.value = `${ps.modVal || r.modRange.value}`; r.modRange.dispatchEvent(new Event("input"));
        r.curveSel.value = ps.curve || r.curveSel.value;
      });

      // machine selector
      t.machSel.value = `${pt.trackSel || (i + 1)}`;
      t.machSel.dispatchEvent(new Event("change"));

      // mute/solo/CC enable (if present in preset)
      if (pt.isMuted != null) t.isMuted = !!pt.isMuted;
      if (pt.isSolo  != null) t.isSolo  = !!pt.isSolo;
      if (pt.ccEnabled != null) setTrackCCEnabled(t, !!pt.ccEnabled);
    });

    updateAllMuteSoloStates();
    isBatchUpdating = false;


    // Refresh master loop display/Transport.loopEnd (important when applying while stopped)
    calculateMasterLoopLength();
    if (wasPlaying) {
      rescheduleAll();
    }
  }

  resetAllParameters();

  // -----------------------------
  // updateMachineSelector
  // -----------------------------
  function updateMachineSelector(trackCard, trackIndex) {
    const labelMach = document.createElement("label");
    labelMach.textContent = "Track: ";
    // Make sure the label/select can shrink inside the compact 2-column track cards.
    labelMach.style.display = "block";

    labelMach.addEventListener("mousedown", function(e) {
      if (e.shiftKey && e.target === this) {
        e.preventDefault();
        e.stopPropagation();
        withUndo("Randomize track assignments", () => {
          const savedShift = shiftDown;
          shiftDown = false;

          const nums = Array.from({ length: 16 }, (_, i) => i + 1);
          for (let i = nums.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [nums[i], nums[j]] = [nums[j], nums[i]];
          }

          tracks.forEach((t, idx) => {
            t.machSel.value = String(nums[idx]);
            t.machSel.dispatchEvent(new Event("change"));
          });

          shiftDown = savedShift;
        });
      }
    });

    const machSel = document.createElement("select");
    machSel.style.width = "100%";
    machSel.style.maxWidth = "100%";
    machSel.style.minWidth = "0";
    for (let tnum = 1; tnum <= 16; tnum++) {
      const opt = document.createElement("option");
      opt.value = String(tnum);
      let machineId;
      if (window.kit && Array.isArray(window.kit.machineAssignments)) {
        machineId = window.kit.machineAssignments[tnum - 1];
      } else {
        machineId = (tnum <= 8) ? tnum : 0;
      }
      const machineName = machineId
          ? (window.getMachineName ? window.getMachineName(machineId) : `ID#${machineId}`)
          : "GND-EMPTY";
      opt.textContent = `${tnum} - ${machineName}`;
      machSel.appendChild(opt);
    }
    wireUndoForSelect(machSel, "Track assignment");
    machSel.addEventListener("change", () => {
      const tnum = parseInt(machSel.value, 10) - 1;
      const machineID = (window.kit && window.kit.machineAssignments)
                        ? window.kit.machineAssignments[tnum]
                        : 0;
      tracks[trackIndex].paramRows.forEach(row => {
        const prev = row.paramSel.value;
        buildParamSelectOptions(row.paramSel, machineID);
        row.paramSel.value = prev;
      });
    });

    machSel.value = String(trackIndex + 1);
    labelMach.appendChild(machSel);
    const rowMach = document.createElement("div");
    rowMach.classList.add("machRow");
    rowMach.style.marginTop = "0";
    rowMach.appendChild(labelMach);

    const existingRow = trackCard.querySelector(".machRow");
    if(existingRow){
        existingRow.replaceWith(rowMach);
    } else {
        const placeholder = trackCard.querySelector(".machinePlaceholder");
        if (placeholder) {
            // In the compact layout the placeholder lives inside the left column.
            // Replace it in-place so the machine selector stays in that column.
            placeholder.replaceWith(rowMach);
        } else {
            trackCard.appendChild(rowMach);
        }
    }
    tracks[trackIndex].machSel = machSel;
  }

})();
