/* ==========================================================================
   Machinedrum UW Sample Manager — Streamlined (Final Parity)
   Build: 2026-01-02

   - Single canonical SDS RX engine (modes: closed/open/stream)
   - Single canonical SDS TX engine (modes: closed/open/auto + fallback)
   - Transfer-focus wrapper (wake lock + active sensing + sysex filtering)
   - UI: slot grid (ROM + RAM), editor, selection, bulk ops, cancel
   - Import/Export: JSON, SYX, WAV, ZIP
   - Parity resend support via raw SDS packet capture when PCM unchanged
   - RAM buffers are RECEIVE-ONLY (TX gated)

   Integration:
   - mddt-midi.js forwards incoming messages to window.onMidiMessageUW(arr)
   - Uses window.selectedMidiOut for output (Web MIDI API)
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Guard
  // --------------------------------------------------------------------------
  if (window.__MDDT_UW_SAMPLE_MANAGER_STREAMLINED_FINAL__) return;
  window.__MDDT_UW_SAMPLE_MANAGER_STREAMLINED_FINAL__ = true;

  const BUILD = '2026-01-01';
  try { window.__UW_SAMPLE_MANAGER_BUILD = BUILD; } catch (_) {}

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------
  const MD_MEMORY_MKI = 1970152;
  const MD_MEMORY_MKII = 2615190;
  const MD_METADATA_OVERHEAD = 128;
  const MD_CLOCK = 1000000000; // used for samplePeriod <-> sampleRate in SDS header

  // SDS handshake / special messages (Universal SysEx: F0 7E dev cmd ... F7)
  const SDS_ACK = 0x7F;
  const SDS_NAK = 0x7E;
  const SDS_CANCEL = 0x7D;
  const SDS_WAIT = 0x7C;
  const SDS_EOF = 0x7B;

  // Export SDS constants for compatibility
  try {
    window.SDS_ACK = SDS_ACK;
    window.SDS_NAK = SDS_NAK;
    window.SDS_CANCEL = SDS_CANCEL;
    window.SDS_WAIT = SDS_WAIT;
    window.SDS_EOF = SDS_EOF;
  } catch (_) {}

  // --------------------------------------------------------------------------
  // Global flags used elsewhere in the app
  // --------------------------------------------------------------------------
  window.shiftKeyIsDown = !!window.shiftKeyIsDown;
  window.ignoreNonSampleManagerSysex = false;
  window.verificationMode = !!window.verificationMode;

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------
  const state = {
    busy: false,
    samples: null, // window.uwSamples binding
    selection: (window.selectedSlotIndices instanceof Set) ? window.selectedSlotIndices : new Set(),
    selectionAnchor: null,
    activeIndex: Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : 0,
    lastSampleName: '----',

    // OS 1.63 RX only: sampleNumber -> name4 mapping (Elektron SysEx 0x73)
    rxNameMap163: null,
    ui: {
      mounted: false,
      paused: false
    },
    rx: null,
    tx: null,
    bulk: {
      inProgress: false,
      abort: null,

      // Monotonic token so bulk end/cancel is idempotent even when async
      // loops complete after a newer bulk operation has already started.
      seq: 0,
      token: 0
    },
    clipboard: {
      slot: null
    },
    transferFocus: {
      depth: 0,
      saved: null,
      wakeLock: null,
      activeSenseTimer: null
    }
  };
  window.selectedSlotIndices = state.selection;

  // --------------------------------------------------------------------------
  // Samples model (ROM slots + RAM buffers)
  // --------------------------------------------------------------------------
  function getModel() {
    return (window.mdModel === 'MKI') ? 'MKI' : 'MKII';
  }
  function getMaxSlotsForModel(model) {
    return model === 'MKI' ? 32 : 48;
  }
  function getRamCountForModel(model) {
    return model === 'MKI' ? 2 : 4;
  }

  function normalizeName4(name) {
    const s = String(name || '----').replace(/\0/g, '').trim().toUpperCase();
    return (s + '    ').slice(0, 4);
  }

  function ensureSamplesModel() {
    const model = getModel();
    const maxSlots = getMaxSlotsForModel(model);
    const ramCount = getRamCountForModel(model);

    if (!window.uwSamples || typeof window.uwSamples !== 'object') {
      window.uwSamples = {
        model,
        maxSlots,
        slots: Array(maxSlots).fill(null),
        ram: Array(ramCount).fill(null)
      };
    }

    const uw = window.uwSamples;
    uw.model = model;
    uw.maxSlots = maxSlots;

    if (!Array.isArray(uw.slots)) uw.slots = [];
    if (uw.slots.length !== maxSlots) {
      const old = uw.slots.slice();
      uw.slots = Array(maxSlots).fill(null);
      for (let i = 0; i < Math.min(old.length, maxSlots); i++) uw.slots[i] = old[i];
    }

    if (!Array.isArray(uw.ram)) uw.ram = [];
    if (uw.ram.length !== ramCount) {
      const old = uw.ram.slice();
      uw.ram = Array(ramCount).fill(null);
      for (let i = 0; i < Math.min(old.length, ramCount); i++) uw.ram[i] = old[i];
    }

    function normalizeSlotObj(s, idx, isRam) {
      if (!s || typeof s !== 'object') return s;
      if (!s.name) s.name = isRam ? `R${idx + 1}` : '----';
      s.name = normalizeName4(s.name);
      if (!('rawPCM' in s)) s.rawPCM = null;
      if (!('rawPCMBase64' in s)) s.rawPCMBase64 = null;
      if (!('numSamples' in s)) s.numSamples = 0;
      if (!('originalSampleRate' in s)) s.originalSampleRate = 44100;
      if (!('targetSampleRate' in s)) s.targetSampleRate = s.originalSampleRate || 44100;
      if (!('sizeBytes' in s)) s.sizeBytes = (s.numSamples | 0) * 2;
      if (!('loopStart' in s)) s.loopStart = null;
      if (!('loopEnd' in s)) s.loopEnd = null;
      if (!('repitch' in s)) s.repitch = 0;
      if (!('__edited' in s)) s.__edited = false;
      if (!('__pcmCrc32' in s)) s.__pcmCrc32 = null;
      if (!('__sdsRawPackets' in s)) s.__sdsRawPackets = null;
      if (!('__rxStats' in s)) s.__rxStats = null;
      if (!('__hasCorruption' in s)) s.__hasCorruption = false;
      return s;
    }

    for (let i = 0; i < uw.slots.length; i++) uw.slots[i] = normalizeSlotObj(uw.slots[i], i, false);
    for (let i = 0; i < uw.ram.length; i++) uw.ram[i] = normalizeSlotObj(uw.ram[i], i, true);

    state.samples = uw;
    return uw;
  }

  function isRamIndex(uiIndex) {
    const uw = state.samples || ensureSamplesModel();
    return (uiIndex | 0) >= (uw.maxSlots | 0);
  }

  function getTotalUiSlots() {
    const uw = state.samples || ensureSamplesModel();
    return (uw.maxSlots | 0) + ((uw.ram && uw.ram.length) ? (uw.ram.length | 0) : 0);
  }

  function getSlotByUiIndex(uiIndex) {
    const uw = state.samples || ensureSamplesModel();
    const idx = uiIndex | 0;
    if (idx < 0) return null;
    if (idx < (uw.maxSlots | 0)) return uw.slots[idx] || null;
    const r = idx - (uw.maxSlots | 0);
    if (uw.ram && r >= 0 && r < uw.ram.length) return uw.ram[r] || null;
    return null;
  }

  function setSlotByUiIndex(uiIndex, slotObjOrNull) {
    const uw = state.samples || ensureSamplesModel();
    const idx = uiIndex | 0;
    if (idx < 0) return;
    if (idx < (uw.maxSlots | 0)) {
      uw.slots[idx] = slotObjOrNull ? slotObjOrNull : null;
      return;
    }
    const r = idx - (uw.maxSlots | 0);
    if (uw.ram && r >= 0 && r < uw.ram.length) {
      uw.ram[r] = slotObjOrNull ? slotObjOrNull : null;
    }
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------
  function clampInt(v, lo, hi) {
    v = v | 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  // Promise-based delay helper.
  //
  // NOTE: JavaScript does not provide a built-in `sleep()` in the browser.
  // Some older versions of this codebase expected a global helper, but this
  // streamlined module references `sleep()` directly in several async loops.
  //
  // Use as: `await sleep(40)`.
  function sleep(ms) {
    const n = Number(ms);
    const delay = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;

    // Extremely defensive: in the unlikely event setTimeout is unavailable,
    // don't throw—just yield on a resolved Promise.
    if (typeof setTimeout !== 'function') return Promise.resolve();

    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Optional compatibility export (no-op if something else already defines it).
  try {
    if (typeof window.sleep !== 'function') window.sleep = sleep;
  } catch (_) {}

  // Treat these as user cancellations / aborts (do not alert).
  function isAbortLikeError(err) {
    if (!err) return false;
    try {
      if (err.name === 'AbortError') return true;
    } catch (_) {}
    const msg = (err && err.message) ? String(err.message) : String(err);
    return msg === 'RX_ABORTED' || msg === 'TX_ABORTED' || msg === 'User cancelled' || msg === 'User canceled';
  }

  // --------------------------------------------------------------------------
  // Turbo helpers (pacing + negotiated factor)
  // --------------------------------------------------------------------------
  function getTurboFactor() {
    // Prefer factor negotiated by mddt-midi.js (TM-1 / Elektron Turbo).
    try {
      const f = Number(window.currentTurboFactor);
      if (Number.isFinite(f) && f > 0) return f;
    } catch (_) {}
    try {
      const s = String(window.turboSpeedFactor || '');
      const m = s.match(/x\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) {
        const f2 = parseFloat(m[1]);
        if (Number.isFinite(f2) && f2 > 0) return f2;
      }
    } catch (_) {}
    // Safe default if we can't detect the negotiated factor.
    return window.turboActive ? 5 : 1;
  }

  function scaleMsForTurbo(baseMs, { min = 0, max = Infinity } = {}) {
    let ms = Number(baseMs);
    if (!Number.isFinite(ms)) ms = 0;
    const f = getTurboFactor();
    if (window.turboActive && f > 1) ms = ms / f;
    ms = Math.round(ms);
    if (!Number.isFinite(ms)) ms = 0;
    if (Number.isFinite(min)) ms = Math.max(min, ms);
    if (Number.isFinite(max)) ms = Math.min(max, ms);
    return ms;
  }

  // Allow user overrides in console for troubleshooting.
  //   window.uwInterSlotDelayMs = 80;
  //   window.uwSdsInterPacketDelayMs = 4;
  function uwGetInterSlotDelayMs() {
    const override = Number(window.uwInterSlotDelayMs);
    if (Number.isFinite(override) && override >= 0) return Math.floor(override);

    // This is mostly a “settle time” between slot operations. At Turbo we can
    // reduce it, but keep a conservative floor for device readiness.
    return scaleMsForTurbo(120, { min: 40, max: 250 });
  }

  function uwGetSdsInterPacketDelayMs() {
    const override = Number(window.uwSdsInterPacketDelayMs);
    if (Number.isFinite(override) && override >= 0) return Math.floor(override);

    // Keep existing non-turbo behaviour, but scale at Turbo.
    // NOTE: This is *additional* pacing on top of raw MIDI line time.
    //
    // Robustness: many SDS paths become flaky once you push Turbo beyond
    // ~idx3. At those higher factors, an inter-packet delay that rounds down
    // to 0–2ms can overwhelm browser/driver scheduling (and increases the risk
    // of SysEx truncation). Clamp to a small floor in Turbo mode.
    const f = getTurboFactor();
    const minMs = window.turboActive
      ? (f >= 4 ? 6 : 4)
      : 0;
    return scaleMsForTurbo(12, { min: minMs, max: 12 });
  }

  // --------------------------------------------------------------------------
  // UW SDS + Turbo policy
  // --------------------------------------------------------------------------
  // Global dumps (kit/pattern/song/global) are fairly tolerant at high Turbo
  // factors because they are open-loop and our bulk engine uses a Turbo-aware
  // wire clock.
  //
  // SDS sample transfers are different: they are packetised (120-byte bodies)
  // and typically closed-loop (sender waits for ACK). On some setups, raising
  // Turbo beyond ~idx3 yields no throughput gain on RX but *does* increase
  // corruption/truncation risk.
  //
  // To keep the rest of MDDT fast, we optionally clamp Turbo *only while UW
  // sample transfers are active*, then restore the previous Turbo speed.
  const UW_TM1_SPEED_FACTORS = [
    1, 2, 3.33, 5, 6.66, 10, 13.33, 20, 26.66, 40, 53.33, 80
  ];

  function uwNearestTurboSpeedValForFactor(f) {
    const ff = Number(f);
    if (!Number.isFinite(ff) || ff <= 1) return 1;
    let bestIdx = 1;
    let bestDiff = Infinity;
    for (let i = 0; i < UW_TM1_SPEED_FACTORS.length; i++) {
      const d = Math.abs(UW_TM1_SPEED_FACTORS[i] - ff);
      if (d < bestDiff) { bestDiff = d; bestIdx = i + 1; }
    }
    return bestIdx;
  }

  function uwGetCurrentTurboSpeedValApprox() {
    // Prefer explicit cached speed value from mddt-midi.js
    const cached = Number(window.currentTurboSpeedVal);
    if (Number.isFinite(cached) && cached >= 1) return Math.floor(cached);

    // TM-1 detection cache
    const det = Number(window.detectedTurboIndex);
    if (Number.isFinite(det) && det >= 1) return Math.floor(det);

    // UI slider (if present)
    try {
      const slider = document.getElementById('turboSpeedSlider');
      const v = slider ? parseInt(slider.value, 10) : NaN;
      if (Number.isFinite(v) && v >= 1) return Math.floor(v);
    } catch (_) {}

    // Fallback: infer from negotiated factor
    return uwNearestTurboSpeedValForFactor(getTurboFactor());
  }

  function uwGetSdsTurboMaxSpeedVal(direction) {
    const dir = String(direction || '').toLowerCase();
    // Allow per-direction overrides
    const vDir = (dir === 'tx') ? Number(window.uwTurboTxMaxSpeedVal)
      : (dir === 'rx') ? Number(window.uwTurboRxMaxSpeedVal)
      : NaN;
    const vGlobal = Number(window.uwTurboMaxSpeedVal);

    // Respect the model max when available.
    const modelMax = Number(window.getModelMaxSpeedVal && window.getModelMaxSpeedVal());
    const maxV = Number.isFinite(modelMax) ? modelMax : 11;

    // Default (legacy): cap SDS at idx3 (≈3.33x) unless the user overrides.
    // To opt into a C6-like "no extra clamp" mode, set one of:
    //   window.uwSdsClampMode = 'c6'
    //   window.uwSdsClampMode = 'off'
    const mode = String(window.uwSdsClampMode || window.uwSdsTurboClampMode || 'legacy').toLowerCase();
    const fallback = (mode === 'c6' || mode === 'off' || mode === 'none' || mode === 'model' || mode === 'max')
      ? maxV
      : 3;

    const v = Number.isFinite(vDir) ? vDir : (Number.isFinite(vGlobal) ? vGlobal : fallback);
    return clampInt(Math.floor(v), 1, maxV);
  }

  async function uwMaybeClampTurboForSds(direction) {
    if (!window.turboActive) return { changed: false, reason: 'turboOff' };
    if (typeof window.setTurboSpeedVal !== 'function') return { changed: false, reason: 'noSetter' };

    const cur = uwGetCurrentTurboSpeedValApprox();
    const max = uwGetSdsTurboMaxSpeedVal(direction);
    if (cur <= max) return { changed: false, cur, max, reason: 'alreadySafe' };

    try {
      await window.setTurboSpeedVal(max);
      return { changed: true, cur, max };
    } catch (e) {
      return { changed: false, cur, max, reason: 'setFailed', error: e };
    }
  }

  function slotLabel(uiIndex) {
    const uw = state.samples || ensureSamplesModel();
    const idx = uiIndex | 0;
    if (idx < (uw.maxSlots | 0)) return String(idx + 1).padStart(2, '0');
    return `R${idx - (uw.maxSlots | 0) + 1}`;
  }

  function safeFilenamePart(str, fallback) {
    const s = String(str || fallback || '').trim() || (fallback || '----');
    return s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 48) || (fallback || '----');
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (_) {} }, 800);
  }

  function arrayBufferToBase64(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    } catch (_) {
      return null;
    }
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // CRC32 helper (IEEE)
  const __crcTable = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    try {
      let bytes;
      if (u8 instanceof ArrayBuffer) bytes = new Uint8Array(u8);
      else if (ArrayBuffer.isView(u8)) bytes = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
      else bytes = new Uint8Array(u8);
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) crc = __crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    } catch (_) {
      return 0 >>> 0;
    }
  }
  try { window.__uwCrc32 = window.__uwCrc32 || crc32; } catch (_) {}

  // 7-bit value encoding (LSB-first groups)
  function encodeValueTo7BitBytes(val, n) {
    const out = [];
    let v = (val >>> 0);
    for (let i = 0; i < n; i++) {
      out.push(v & 0x7F);
      v = v >>> 7;
    }
    return out;
  }

  function decode3x7(lsb, mid, msb) {
    return ((msb & 0x7F) << 14) | ((mid & 0x7F) << 7) | (lsb & 0x7F);
  }

  function sdsChecksumXor(dev, packetNo, data120u8) {
    let checksum = 0;
    checksum ^= 0x7E;
    checksum ^= (dev & 0x7F);
    checksum ^= 0x02;
    checksum ^= (packetNo & 0x7F);
    for (let i = 0; i < data120u8.length; i++) checksum ^= (data120u8[i] & 0x7F);
    return checksum & 0x7F;
  }

  function encodePCMTo7Bit(pcmBuffer, sampleFormat) {
    const pcmView = new DataView(pcmBuffer);
    const numSamples = (pcmBuffer.byteLength / 2) | 0;
    const n = (sampleFormat <= 14) ? 2 : 3;
    const offset = Math.pow(2, sampleFormat) / 2;
    const out = new Uint8Array(numSamples * n);
    let p = 0;
    for (let i = 0; i < numSamples; i++) {
      const sample = pcmView.getInt16(i * 2, true);
      const u = sample + offset;
      const temp = u << (8 - n);
      for (let j = n - 1; j >= 0; j--) out[p++] = (temp >> (7 * j)) & 0x7F;
    }
    return out;
  }

  function decodeSdsBodyIntoPcmBytes(decState, body7) {
    const fmt = (decState.sampleFormat | 0);
    const needed = (fmt <= 14) ? 2 : 3;
    const pending = Array.isArray(decState.pending7) ? decState.pending7 : [];
    const data7 = pending.concat(Array.from(body7, b => b & 0x7F));
    let i = 0;

    const hasTotal = Number.isFinite(decState.totalWords) && (decState.totalWords | 0) > 0;
    let remaining = hasTotal ? ((decState.totalWords | 0) - (decState.wordsSoFar | 0)) : Infinity;
    if (remaining < 0) remaining = 0;

    const offset = Math.pow(2, fmt) / 2;
    while ((i + needed) <= data7.length && remaining > 0) {
      let accum = 0;
      for (let c = 0; c < needed; c++) accum = (accum << 7) | (data7[i + c] & 0x7F);
      i += needed;

      accum = accum >> (8 - needed);

      let signed = accum - offset;
      let pcm16;
      if (fmt === 16) pcm16 = signed;
      else if (fmt < 16) pcm16 = signed << (16 - fmt);
      else pcm16 = signed >> (fmt - 16);

      if (pcm16 > 32767) pcm16 = 32767;
      if (pcm16 < -32768) pcm16 = -32768;

      decState.dataOutBytes.push(pcm16 & 0xFF, (pcm16 >> 8) & 0xFF);
      decState.wordsSoFar = (decState.wordsSoFar | 0) + 1;
      remaining--;
    }

    decState.pending7 = data7.slice(i);
  }

  function trimPcmBytesToWords(byteArr, totalWords) {
    const wantBytes = (totalWords | 0) * 2;
    if (!Array.isArray(byteArr)) return byteArr;
    if (wantBytes <= 0) return byteArr;
    if (byteArr.length > wantBytes) return byteArr.slice(0, wantBytes);
    return byteArr;
  }

  function convertPCMToWav(buffer, sampleRate) {
    const pcm = new Int16Array(buffer);
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = (sampleRate | 0) * blockAlign;
    const dataSize = pcm.length * bytesPerSample;
    const wav = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wav);

    function writeString(off, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate | 0, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < pcm.length; i++, offset += 2) view.setInt16(offset, pcm[i], true);
    return wav;
  }

  function resamplePCMBufferLinear(buffer, origRate, targetRate) {
    if (!buffer) return new ArrayBuffer(0);
    const o = Number(origRate);
    const t = Number(targetRate);
    if (!Number.isFinite(o) || o <= 0 || !Number.isFinite(t) || t <= 0) return buffer;
    if (o === t) return buffer;

    const src = new Int16Array(buffer);
    const srcLen = src.length | 0;
    if (srcLen <= 0) return new ArrayBuffer(0);

    let dstLen = Math.round(srcLen * (t / o));
    if (!Number.isFinite(dstLen) || dstLen <= 0) dstLen = 1;
    if (dstLen === srcLen) return buffer;

    const dst = new Int16Array(dstLen);
    if (srcLen === 1) { dst.fill(src[0] || 0); return dst.buffer; }
    if (dstLen === 1) { dst[0] = src[0] || 0; return dst.buffer; }

    const scale = (srcLen - 1) / (dstLen - 1);
    for (let i = 0; i < dstLen; i++) {
      const pos = i * scale;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s1 = src[idx] || 0;
      const s2 = (idx + 1 < srcLen) ? (src[idx + 1] || 0) : s1;
      dst[i] = Math.round(s1 + (s2 - s1) * frac);
    }
    return dst.buffer;
  }

  if (typeof window.resamplePCMBuffer !== 'function') window.resamplePCMBuffer = resamplePCMBufferLinear;

  // Compatibility exports
  window.arrayBufferToBase64 = window.arrayBufferToBase64 || arrayBufferToBase64;
  window.base64ToArrayBuffer = window.base64ToArrayBuffer || base64ToArrayBuffer;
  window.convertPCMToWav = window.convertPCMToWav || convertPCMToWav;
  window.encodePCMTo7Bit = window.encodePCMTo7Bit || encodePCMTo7Bit;

  // SDS parsing utilities
  function parseSdsHeaderMessage(bytes) {
    if (!bytes || bytes.length < 16) return null;
    const lsb = bytes[4] & 0x7F;
    const msb = bytes[5] & 0x7F;
    const sampleNumber = (msb << 7) | lsb;
    const sampleFormat = bytes[6] & 0x7F;
    const samplePeriod = decode3x7(bytes[7], bytes[8], bytes[9]);
    let sampleRate = Math.round(MD_CLOCK / (samplePeriod || 1));
    if (sampleRate === 44099 || sampleRate === 44101) sampleRate = 44100;
    const totalWords = decode3x7(bytes[10], bytes[11], bytes[12]);
    const loopStart = decode3x7(bytes[13], bytes[14], bytes[15]);
    const loopEnd = (bytes.length >= 19) ? decode3x7(bytes[16], bytes[17], bytes[18]) : 0;
    const loopType = (bytes.length > 19) ? (bytes[19] & 0x7F) : 0;
    return { sampleNumber, sampleFormat, fmt: sampleFormat, samplePeriod, sampleRate, totalWords, loopStart, loopEnd, loopType };
  }

  function verifySdsDataMessage(bytes) {
    if (!bytes || bytes.length < 8) return { ok: false, reason: 'TRUNC', packetNumber: 0 };
    const packetNumber = bytes[4] & 0x7F;
    const checksumByte = bytes[bytes.length - 2] & 0x7F;
    const body = bytes.slice(5, bytes.length - 2).map(b => b & 0x7F);
    if (body.length !== 120) return { ok: false, reason: 'TRUNC', packetNumber };
    let cs = 0;
    for (let i = 1; i < 5; i++) cs ^= (bytes[i] & 0x7F);
    for (let i = 0; i < body.length; i++) cs ^= (body[i] & 0x7F);
    cs &= 0x7F;
    return { ok: cs === checksumByte, reason: cs === checksumByte ? 'OK' : 'CS', packetNumber, body };
  }

  // Faster verifier for high-throughput (Turbo) receive paths.
  // Avoids allocating/mapping the 120-byte body on every packet.
  function verifySdsDataMessageFast(bytes) {
    if (!bytes || bytes.length < 8) return { ok: false, reason: 'TRUNC', packetNumber: 0, bodyOffset: 0 };
    const packetNumber = bytes[4] & 0x7F;

    // Standard SDS data packet length is fixed: 127 bytes.
    // F0 7E dev 02 pkt + 120 data + checksum + F7
    const bodyLen = (bytes.length | 0) - 7;
    if (bodyLen !== 120) return { ok: false, reason: 'TRUNC', packetNumber, bodyOffset: 5, bodyLen };

    const checksumByte = bytes[bytes.length - 2] & 0x7F;
    let cs = 0;
    for (let i = 1; i < 5; i++) cs ^= (bytes[i] & 0x7F);
    for (let i = 5; i < 125; i++) cs ^= (bytes[i] & 0x7F);
    cs &= 0x7F;
    return { ok: cs === checksumByte, reason: cs === checksumByte ? 'OK' : 'CS', packetNumber, bodyOffset: 5 };
  }

  function patchSdsHeaderPacket(pkt, sampleNumber, slotObj) {
    if (!pkt || pkt.length < 16) return pkt;
    if ((pkt[0] & 0xFF) !== 0xF0 || (pkt[1] & 0x7F) !== 0x7E) return pkt;
    if ((pkt[3] & 0x7F) !== 0x01) return pkt;
    const p = Array.isArray(pkt) ? pkt.slice() : Array.from(pkt);

    p[4] = sampleNumber & 0x7F;
    p[5] = (sampleNumber >> 7) & 0x7F;

    try {
      const targetRate = slotObj.targetSampleRate || slotObj.originalSampleRate || 44100;
      const samplePeriod = Math.round(MD_CLOCK / (targetRate || 44100));
      const tw = (slotObj.numSamples | 0) > 0
        ? (slotObj.numSamples | 0)
        : (slotObj.rawPCM ? ((slotObj.rawPCM.byteLength / 2) | 0) : 0);
      const hasLoop = (slotObj.loopStart != null && slotObj.loopEnd != null && slotObj.loopEnd > slotObj.loopStart);
      const loopStart = hasLoop ? (slotObj.loopStart | 0) : 0;
      const loopEnd = hasLoop ? (slotObj.loopEnd | 0) : 0;
      const loopType = hasLoop ? 0 : 0x7F;

      const sp = encodeValueTo7BitBytes(samplePeriod, 3);
      p[7] = sp[0]; p[8] = sp[1]; p[9] = sp[2];

      const tww = encodeValueTo7BitBytes(tw, 3);
      p[10] = tww[0]; p[11] = tww[1]; p[12] = tww[2];

      const ls = encodeValueTo7BitBytes(loopStart, 3);
      p[13] = ls[0]; p[14] = ls[1]; p[15] = ls[2];

      if (p.length >= 19) {
        const le = encodeValueTo7BitBytes(loopEnd, 3);
        p[16] = le[0]; p[17] = le[1]; p[18] = le[2];
      }
      if (p.length > 19) p[19] = loopType & 0x7F;
    } catch (_) {}

    return p;
  }

  // SDS header builder (shared by TX + SYX export)
  function buildSdsHeaderPacket(sampleNumber, slotObj, sampleFormat, totalWords, targetRate) {
    const samplePeriod = Math.round(MD_CLOCK / (targetRate || 44100));
    const hasLoop = (slotObj && slotObj.loopStart != null && slotObj.loopEnd != null && (slotObj.loopEnd | 0) > (slotObj.loopStart | 0));
    const loopStart = hasLoop ? (slotObj.loopStart | 0) : 0;
    const loopEnd = hasLoop ? (slotObj.loopEnd | 0) : 0;
    const loopType = hasLoop ? 0 : 0x7F;
    return [
      0xF0, 0x7E, 0x00, 0x01,
      sampleNumber & 0x7F, (sampleNumber >> 7) & 0x7F,
      sampleFormat & 0x7F,
      ...encodeValueTo7BitBytes(samplePeriod, 3),
      ...encodeValueTo7BitBytes(totalWords, 3),
      ...encodeValueTo7BitBytes(loopStart, 3),
      ...encodeValueTo7BitBytes(loopEnd, 3),
      loopType & 0x7F,
      0xF7
    ];
  }


  // --------------------------------------------------------------------------
  // UI Module (renderer + event dispatch)
  // --------------------------------------------------------------------------
  const ui = {
    GRID_COLS: 4,
    MINI_W: 112,
    MINI_H: 34,
    miniCache: new WeakMap(),
    // Cache the expensive full-resolution editor waveform (base layer w/out loop overlay)
    // keyed by rawPCM ArrayBuffer.
    editorWaveCache: new WeakMap(),
    elements: {
      mount: null,
      root: null,
      toolbar: null,
      grid: null,
      editor: null,
      statusSelected: null,
      statusMemory: null,
      statusConn: null,
      bulkStatus: null,
      bulkCancelBtn: null,
      fileInput: null,
      jsonInput: null
    },

    findMountPoint() {
      // Prefer a stable mount container (ui-shell.js also checks this id)
      let el = document.getElementById('uwPanelContent');
      if (el) return el;

      const panel = document.getElementById('uwPanel');
      if (panel) {
        el = document.createElement('div');
        el.id = 'uwPanelContent';
        panel.prepend(el);
        return el;
      }

      return document.querySelector('.panel[data-panel-id="uw"] .panel-content')
        || document.body;
    },

    hideLegacyUwDom() {
      // Safer mounting: hide known legacy UW UI instead of clearing the panel.
      const ids = [
        'uwSlotsList',
        'uwTools',
        'uwMemoryLabel',
        'uwMemoryBar',
        'uwToolbar',
        'uwEditor',
        'uwOverhaulRoot'
      ];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
    },

    injectCss() {
      const id = 'uw-sample-manager-streamlined-final-css';
      if (document.getElementById(id)) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = `
        /* Flex-height embedding so the UW panel scrolls internally (not the page) */
        #uwPanel{height:100%;min-height:0;}
        #uwPanelContent{height:100%;min-height:0;}

        #uwSampleManagerRoot{display:grid;grid-template-columns:1fr 420px;grid-template-rows:auto 1fr;grid-template-areas:"toolbar toolbar" "grid editor";gap:12px;align-items:stretch;padding:8px 0;height:calc(100vh - 210px);max-height:calc(100vh - 210px);min-height:0;overflow:hidden;}
        @media (max-width:980px){#uwSampleManagerRoot{grid-template-columns:1fr;grid-template-areas:"toolbar" "editor" "grid";height:calc(100vh - 240px);max-height:calc(100vh - 240px);}#uwSmEditor{position:static!important;}}
        #uwSmToolbar{grid-area:toolbar;display:flex;flex-direction:column;gap:8px;position:sticky;top:12px;z-index:20;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.10);border-radius:10px;padding:10px;backdrop-filter:blur(8px);} 
        .uw-sm-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
        .uw-sm-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-right:10px;border-right:1px solid rgba(255,255,255,0.10);} 
        .uw-sm-group:last-child{border-right:none;padding-right:0;}
        .uw-sm-btn{appearance:none;border:1px solid rgba(255,255,255,0.20);background:rgba(255,255,255,0.08);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;}
        .uw-sm-btn:hover{background:rgba(255,255,255,0.14);} .uw-sm-btn:disabled{opacity:0.45;cursor:not-allowed;}
        .uw-sm-btn.danger{border-color:rgba(255,80,80,0.50);} 
        .uw-sm-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);border-radius:999px;padding:4px 8px;font-size:12px;}
        .uw-sm-chip input{transform:translateY(1px);} #uwSmBulkStatus{font-size:12px;opacity:0.9;}

        #uwSmGrid{grid-area:grid;height:100%;min-height:0;overflow:auto;padding-right:6px;} 
        #uwSmGridList{display:grid;grid-template-columns:repeat(${this.GRID_COLS}, minmax(0,1fr));gap:10px;list-style:none;padding:0;margin:0;}
        .uw-tile{position:relative;border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:8px 8px 6px;background:rgba(255,255,255,0.04);outline:none;cursor:pointer;user-select:none;}
        .uw-tile:hover{background:rgba(255,255,255,0.07);} 
        .uw-tile.is-active{border-color:rgba(255,220,90,0.85);box-shadow:0 0 0 1px rgba(255,220,90,0.35) inset;} 
        .uw-tile.is-selected{box-shadow:0 0 0 2px rgba(90,170,255,0.65) inset;} 
        .uw-tile.is-ram{border-style:dashed;} 
        .uw-tile .uw-top{display:flex;justify-content:space-between;align-items:center;gap:6px;} 
        .uw-tile .uw-label{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;opacity:0.85;} 
        .uw-tile .uw-name{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;font-weight:700;letter-spacing:1px;} 
        .uw-badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;} 
        .uw-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid rgba(255,255,255,0.18);opacity:0.9;} 
        .uw-badge.corrupt{border-color:rgba(255,80,80,0.60);} .uw-badge.edited{border-color:rgba(255,180,0,0.60);} .uw-badge.ram{border-color:rgba(140,200,255,0.60);} 
        .uw-mini-wrap{display:flex;align-items:center;gap:6px;margin-top:6px;}
        .uw-mini{width:${this.MINI_W}px;height:${this.MINI_H}px;margin-top:0;display:block;border-radius:6px;background:rgba(255,255,255,0.04);flex:0 0 auto;} 
        .uw-mini-meta{flex:1;min-width:0;font-size:10px;opacity:0.75;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;} 
        .uw-progress{position:absolute;left:0;bottom:0;height:4px;background:rgba(255,220,90,0.55);border-radius:0 0 0 10px;width:0%;pointer-events:none;} 
        .uw-tile.is-sending .uw-progress{background:rgba(120,210,120,0.55);} 
        .uw-tile.is-receiving .uw-progress{background:rgba(255,220,90,0.55);} 
        .uw-tile.is-sending,.uw-tile.is-receiving{border-color:rgba(255,255,255,0.25);} 

        #uwSmEditor{grid-area:editor;position:sticky;top:12px;border:1px solid rgba(255,255,255,0.10);border-radius:10px;padding:10px;background:rgba(0,0,0,0.35);backdrop-filter:blur(8px);height:100%;min-height:0;overflow:auto;} 
        #uwSmEditor h3{margin:0 0 8px;font-size:14px;} 
        .uw-ed-row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap;} 
        /* Loop controls: keep toggle + start + end on one row */
        .uw-ed-loop-row{flex-wrap:nowrap;}
        .uw-ed-loop-row input[type=number]{flex:0 0 auto;min-width:0;width:86px;}
        @media (max-width:980px){.uw-ed-loop-row{flex-wrap:wrap;}.uw-ed-loop-row input[type=number]{flex:1;min-width:120px;width:auto;}}
        .uw-ed-row label{font-size:12px;opacity:0.9;min-width:86px;} 
        .uw-ed-row input[type=text],.uw-ed-row input[type=number]{flex:1;min-width:120px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#fff;border-radius:8px;padding:6px 8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;} 
        #uwEdWave{width:100%;height:110px;border-radius:10px;background:rgba(255,255,255,0.04);} 
        .uw-hint{font-size:11px;opacity:0.75;margin-top:6px;line-height:1.35;}
      `;
      document.head.appendChild(style);
    },

    mount() {
      if (state.ui.mounted) return;
      this.injectCss();
      this.hideLegacyUwDom();

      const mount = this.findMountPoint();
      this.elements.mount = mount;

      let root = document.getElementById('uwSampleManagerRoot');
      if (!root) {
        root = document.createElement('div');
        root.id = 'uwSampleManagerRoot';
        mount.prepend(root);
      }

      let toolbar = document.getElementById('uwSmToolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'uwSmToolbar';
        root.appendChild(toolbar);
      }

      let grid = document.getElementById('uwSmGrid');
      if (!grid) {
        grid = document.createElement('div');
        grid.id = 'uwSmGrid';
        root.appendChild(grid);
      }

      let editor = document.getElementById('uwSmEditor');
      if (!editor) {
        editor = document.createElement('div');
        editor.id = 'uwSmEditor';
        root.appendChild(editor);
      }

      this.elements.root = root;
      this.elements.toolbar = toolbar;
      this.elements.grid = grid;
      this.elements.editor = editor;

      this.buildToolbar();
      this.renderGrid();
      this.renderEditor();
      this.installKeyboardHandlers();

      state.ui.mounted = true;
    },

    // Render (compat shim): some entrypoints call ui.render()
    // Keep this lightweight: toolbar is built once in mount().
    render() {
      if (!state.ui.mounted) {
        try { this.mount(); } catch (_) {}
      }
      if (state.ui.paused) return;
      try { this.renderGrid(); } catch (_) {}
      try { this.renderEditor(); } catch (_) {}
      try { this.updateSelectedLabel(); } catch (_) {}
      try { this.updateMemoryLabel(); } catch (_) {}
      try { this.updateConnectionLabel(); } catch (_) {}
    },


    makeBtn(text, title, onClick, extraClass) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uw-sm-btn' + (extraClass ? (' ' + extraClass) : '');
      b.textContent = text;
      if (title) b.title = title;
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        try {
          const r = onClick && onClick(ev);
          if (r && typeof r.catch === 'function') {
            r.catch(e => {
              if (isAbortLikeError(e)) return;
              console.error(e);
              alert(String(e));
            });
          }
        } catch (e) {
          if (isAbortLikeError(e)) return;
          console.error(e);
          alert(String(e));
        }
      });
      return b;
    },

    buildToolbar() {
      const el = this.elements.toolbar;
      if (!el) return;
      el.innerHTML = '';

      const row1 = document.createElement('div');
      row1.className = 'uw-sm-row';

      const gRecv = document.createElement('div');
      gRecv.className = 'uw-sm-group';
      gRecv.appendChild(this.makeBtn('Receive Slot(s)', 'Receive active slot or selection', () => actions.receiveActiveOrSelection()));
      const btnRecvStream = this.makeBtn('Receive Stream', '', () => actions.receiveStreamOrAll());
      this.elements.recvStreamBtn = btnRecvStream;
      gRecv.appendChild(btnRecvStream);

      const gSend = document.createElement('div');
      gSend.className = 'uw-sm-group';
      gSend.appendChild(this.makeBtn('Send Slot(s)', 'Send active slot or selection', () => actions.sendActiveOrSelection()));

      const gMode = document.createElement('div');
      gMode.className = 'uw-sm-group';

      const chip = document.createElement('span');
      chip.className = 'uw-sm-chip';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = 'uwOpenLoopGlobalToggle';
      const lab = document.createElement('label');
      lab.setAttribute('for', chk.id);
      lab.textContent = 'Open-loop';

      // Hidden legacy toggles (other code reads these ids)
      let recvToggle = document.getElementById('openLoopRecvGlobal');
      if (!recvToggle) {
        recvToggle = document.createElement('input');
        recvToggle.type = 'checkbox';
        recvToggle.id = 'openLoopRecvGlobal';
        recvToggle.style.display = 'none';
        document.body.appendChild(recvToggle);
      }
      let sendToggle = document.getElementById('openLoopSendGlobal');
      if (!sendToggle) {
        sendToggle = document.createElement('input');
        sendToggle.type = 'checkbox';
        sendToggle.id = 'openLoopSendGlobal';
        sendToggle.style.display = 'none';
        document.body.appendChild(sendToggle);
      }

      chk.checked = !!(recvToggle.checked || sendToggle.checked);
      recvToggle.checked = chk.checked;
      sendToggle.checked = chk.checked;

      chk.addEventListener('change', () => {
        const v = !!chk.checked;
        recvToggle.checked = v;
        sendToggle.checked = v;
        this.updateConnectionLabel();
        this.updateRecvStreamButtonMode();
      });

      chip.appendChild(chk);
      chip.appendChild(lab);
      gMode.appendChild(chip);

      const slotBtn = this.makeBtn('Slot List', 'Request Machinedrum slot list (X mode)', () => actions.requestSlotListSafe());
      this.elements.slotListBtn = slotBtn;
      gMode.appendChild(slotBtn);
      try { this.updateSlotListButtonVisibility(); } catch (_) {}

      const gIO = document.createElement('div');
      gIO.className = 'uw-sm-group';
      gIO.appendChild(this.makeBtn('Import…', 'Import audio (.wav), syx, or json', () => this.elements.fileInput && this.elements.fileInput.click()));
      gIO.appendChild(this.makeBtn('Import JSON…', 'Import bank JSON', () => this.elements.jsonInput && this.elements.jsonInput.click()));
      gIO.appendChild(this.makeBtn('Export WAV/ZIP', 'Export selection/active as WAV (ZIP when multiple)', () => actions.exportSelectionWavZip()));
      gIO.appendChild(this.makeBtn('Export Bank SYX', 'Export bank as .syx (names + SDS)', () => actions.exportBankSyx()));
      gIO.appendChild(this.makeBtn('Export Bank JSON', 'Export bank JSON', () => actions.exportBankJson()));

      const gUtil = document.createElement('div');
      gUtil.className = 'uw-sm-group';
      gUtil.appendChild(this.makeBtn('Clear', 'Clear active slot or selection (local)', () => actions.clearActiveOrSelection({ confirm: true }), 'danger'));
      const btnCancel = this.makeBtn('Cancel', 'Cancel current bulk transfer', () => actions.cancelBulk(), '');
      btnCancel.style.display = 'none';
      this.elements.bulkCancelBtn = btnCancel;
      gUtil.appendChild(btnCancel);

      row1.appendChild(gRecv);
      row1.appendChild(gSend);
      row1.appendChild(gMode);
      row1.appendChild(gIO);
      row1.appendChild(gUtil);

      const row2 = document.createElement('div');
      row2.className = 'uw-sm-row';

      const statusSelected = document.createElement('span');
      statusSelected.className = 'uw-sm-chip';
      statusSelected.textContent = 'Selected: 0';

      const statusMemory = document.createElement('span');
      statusMemory.className = 'uw-sm-chip';
      statusMemory.textContent = 'Memory: —';

      const statusConn = document.createElement('span');
      statusConn.className = 'uw-sm-chip';
      statusConn.textContent = '—';

      const bulkStatus = document.createElement('span');
      bulkStatus.id = 'uwSmBulkStatus';
      bulkStatus.textContent = '';
      bulkStatus.style.marginLeft = '8px';

      row2.appendChild(statusSelected);
      row2.appendChild(statusMemory);
      row2.appendChild(statusConn);
      row2.appendChild(bulkStatus);

      el.appendChild(row1);
      el.appendChild(row2);

      this.elements.statusSelected = statusSelected;
      this.elements.statusMemory = statusMemory;
      this.elements.statusConn = statusConn;
      this.elements.bulkStatus = bulkStatus;

      // Hidden file inputs
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.accept = 'audio/*,.syx,.json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
        if (!files.length) return;
        actions.importFiles(files).catch(err => alert('Import error: ' + err));
      });
      el.appendChild(fileInput);
      this.elements.fileInput = fileInput;

      const jsonInput = document.createElement('input');
      jsonInput.type = 'file';
      jsonInput.accept = '.json,application/json';
      jsonInput.style.display = 'none';
      jsonInput.addEventListener('change', async () => {
        const f = (jsonInput.files && jsonInput.files[0]) ? jsonInput.files[0] : null;
        jsonInput.value = '';
        if (!f) return;
        try { await actions.importBankJsonFromFile(f); } catch (e) { alert('Import JSON error: ' + e); }
      });
      el.appendChild(jsonInput);
      this.elements.jsonInput = jsonInput;

      this.updateSelectedLabel();
      this.updateMemoryLabel();
      this.updateConnectionLabel();
      this.updateRecvStreamButtonMode();
    },

    // Selection helpers
    getEffectiveSelection() {
      const total = getTotalUiSlots();
      const sel = Array.from(state.selection).filter(i => Number.isFinite(i) && i >= 0 && i < total);
      if (sel.length) return sel.sort((a, b) => a - b);
      const idx = Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : 0;
      return [clampInt(idx, 0, total - 1)];
    },

    refreshSelectionClasses() {
      const list = document.getElementById('uwSmGridList');
      if (!list) return;
      const total = getTotalUiSlots();
      for (let i = 0; i < total; i++) {
        const el = list.querySelector(`.uw-tile[data-idx="${i}"]`);
        if (!el) continue;
        el.classList.toggle('is-active', i === (window.activeSlot | 0));
        el.classList.toggle('is-selected', state.selection.has(i));
      }
      this.updateSelectedLabel();
    },

    setActiveAndSelect(uiIndex, opts) {
      opts = opts || {};
      const total = getTotalUiSlots();
      const idx = clampInt(uiIndex | 0, 0, total - 1);

      const prev = Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : idx;
      const anchor = Number.isFinite(state.selectionAnchor) ? (state.selectionAnchor | 0) : prev;

      const range = !!opts.range;
      const toggle = !!opts.toggle;
      const clearSelection = !!opts.clearSelection;

      if (range) {
        const a = Math.min(anchor, idx);
        const b = Math.max(anchor, idx);
        state.selection.clear();
        for (let k = a; k <= b; k++) state.selection.add(k);
      } else if (toggle) {
        if (state.selection.has(idx)) state.selection.delete(idx);
        else state.selection.add(idx);
        state.selectionAnchor = idx;
      } else if (clearSelection) {
        state.selection.clear();
        state.selectionAnchor = idx;
      } else {
        state.selectionAnchor = idx;
      }

      window.activeSlot = idx;
      window.uwPanelActive = true;
      this.refreshSelectionClasses();
      this.renderEditor();
    },

    // Mini waveform
    computeMiniMinMax(rawPCM, width) {
      if (!rawPCM || !width) return null;
      const pcm = new Int16Array(rawPCM);
      const len = pcm.length | 0;
      if (!len) return null;
      const w = Math.max(8, width | 0);
      const minArr = new Int16Array(w);
      const maxArr = new Int16Array(w);
      for (let x = 0; x < w; x++) {
        const start = Math.floor((x * len) / w);
        const end = Math.floor(((x + 1) * len) / w);
        let mn = 32767, mx = -32768;
        const e = Math.max(end, start + 1);
        for (let i = start; i < e; i++) {
          const v = pcm[i] || 0;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        minArr[x] = mn;
        maxArr[x] = mx;
      }
      return { w, minArr, maxArr, len };
    },

    drawMiniWave(canvas, slotObj) {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (canvas.width !== this.MINI_W) canvas.width = this.MINI_W;
        if (canvas.height !== this.MINI_H) canvas.height = this.MINI_H;
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (!slotObj || !slotObj.rawPCM) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = '#fff';
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('—', w / 2, h / 2);
          ctx.globalAlpha = 1;
          return;
        }

        let cached = null;
        try { cached = this.miniCache.get(slotObj.rawPCM); } catch (_) {}
        if (!cached || cached.w !== w) {
          cached = this.computeMiniMinMax(slotObj.rawPCM, w);
          try { if (cached) this.miniCache.set(slotObj.rawPCM, cached); } catch (_) {}
        }
        if (!cached) return;

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#fff';
        const mid = (h / 2) | 0;
        for (let x = 0; x < w; x++) {
          const mn = cached.minArr[x] / 32768;
          const mx = cached.maxArr[x] / 32768;
          const y1 = mid - Math.round(mx * (h * 0.45));
          const y2 = mid - Math.round(mn * (h * 0.45));
          const top = Math.min(y1, y2);
          const bot = Math.max(y1, y2);
          ctx.fillRect(x, top, 1, Math.max(1, bot - top));
        }
        ctx.globalAlpha = 1;
      } catch (_) {}
    },


    // Mini meta text (duration/size) next to each waveform
    formatBytes(n) {
      const b = Math.max(0, Number(n) || 0);
      if (b < 1024) return `${Math.round(b)}B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
      return `${(b / (1024 * 1024)).toFixed(2)}MB`;
    },

    formatDurationMs(ms) {
      const v = Math.max(0, Number(ms) || 0);
      if (v < 1000) return `${Math.round(v)}ms`;
      const s = v / 1000;
      if (s < 10) return `${s.toFixed(2)}s`;
      if (s < 60) return `${s.toFixed(1)}s`;
      const m = Math.floor(s / 60);
      const r = Math.round(s - m * 60);
      return `${m}m${String(r).padStart(2, '0')}s`;
    },

    formatMiniMeta(slotObj) {
      if (!slotObj || !slotObj.rawPCM) return '';
      const rate = Number(slotObj.targetSampleRate || slotObj.originalSampleRate || 44100) || 44100;
      const numSamples = (slotObj.numSamples | 0) > 0 ? (slotObj.numSamples | 0) : ((slotObj.rawPCM.byteLength / 2) | 0);
      const ms = rate > 0 ? (numSamples / rate) * 1000 : 0;
      const bytes = (slotObj.sizeBytes | 0) > 0 ? (slotObj.sizeBytes | 0) : (slotObj.rawPCM.byteLength | 0);
      return `${this.formatDurationMs(ms)} · ${this.formatBytes(bytes)}`;
    },

    // Draw mini waveforms in a throttled queue so Turbo RX doesn't stutter.
    _miniDrawQueue: new Set(),
    _miniDrawRaf: 0,
    queueMiniWaveDraw(uiIndex) {
      try { this._miniDrawQueue.add(uiIndex | 0); } catch (_) { return; }
      if (this._miniDrawRaf) return;
      const doFrame = () => {
        this._miniDrawRaf = 0;
        const list = Array.from(this._miniDrawQueue);
        this._miniDrawQueue.clear();

        // At Turbo, keep UI work very small per frame.
        const maxPerFrame = window.turboActive ? 1 : 3;
        const head = list.slice(0, maxPerFrame);
        const rest = list.slice(maxPerFrame);

        for (const idx of head) {
          try { this.renderGridTile(idx, { forceWave: true }); } catch (_) {}
        }

        if (rest.length) {
          try { rest.forEach(i => this._miniDrawQueue.add(i)); } catch (_) {}
          this._miniDrawRaf = requestAnimationFrame(doFrame);
        }
      };
      try { this._miniDrawRaf = requestAnimationFrame(doFrame); } catch (_) { doFrame(); }
    },


    renderGrid() {
      const grid = this.elements.grid;
      if (!grid) return;
      const total = getTotalUiSlots();

      grid.innerHTML = '';
      const ul = document.createElement('ul');
      ul.id = 'uwSmGridList';
      grid.appendChild(ul);

      for (let i = 0; i < total; i++) {
        const li = document.createElement('li');
        li.className = 'uw-tile';
        li.tabIndex = 0;
        li.dataset.idx = String(i);
        if (isRamIndex(i)) li.classList.add('is-ram');

        const top = document.createElement('div');
        top.className = 'uw-top';

        const label = document.createElement('div');
        label.className = 'uw-label';
        label.textContent = slotLabel(i);

        const name = document.createElement('div');
        name.className = 'uw-name';
        const s = getSlotByUiIndex(i);
        name.textContent = s ? normalizeName4(s.name) : '----';

        top.appendChild(label);
        top.appendChild(name);

        const badges = document.createElement('div');
        badges.className = 'uw-badges';

        const badgeRam = document.createElement('span');
        badgeRam.className = 'uw-badge ram';
        badgeRam.textContent = 'RAM';
        badgeRam.style.display = isRamIndex(i) ? 'inline-flex' : 'none';

        const badgeEdited = document.createElement('span');
        badgeEdited.className = 'uw-badge edited';
        badgeEdited.textContent = 'EDIT';
        badgeEdited.style.display = (s && s.__edited) ? 'inline-flex' : 'none';

        const badgeCorrupt = document.createElement('span');
        badgeCorrupt.className = 'uw-badge corrupt';
        badgeCorrupt.textContent = '⚠';
        badgeCorrupt.style.display = (s && s.__hasCorruption) ? 'inline-flex' : 'none';

        badges.appendChild(badgeRam);
        badges.appendChild(badgeEdited);
        badges.appendChild(badgeCorrupt);

        const canvas = document.createElement('canvas');
        canvas.className = 'uw-mini';
        canvas.width = this.MINI_W;
        canvas.height = this.MINI_H;

        const miniWrap = document.createElement('div');
        miniWrap.className = 'uw-mini-wrap';
        const meta = document.createElement('div');
        meta.className = 'uw-mini-meta';
        meta.textContent = '';
        miniWrap.appendChild(canvas);
        miniWrap.appendChild(meta);

        const progress = document.createElement('div');
        progress.className = 'uw-progress';
        progress.style.width = '0%';

        li.appendChild(top);
        li.appendChild(badges);
        li.appendChild(miniWrap);
        li.appendChild(progress);

        li.addEventListener('click', (ev) => {
          const isMac = /Mac/i.test(navigator.platform || '');
          const metaOrCtrl = isMac ? ev.metaKey : ev.ctrlKey;
          this.setActiveAndSelect(i, {
            range: !!ev.shiftKey,
            toggle: !!metaOrCtrl,
            clearSelection: !ev.shiftKey && !metaOrCtrl
          });
        });

        li.addEventListener('focus', () => { window.uwPanelActive = true; });

        li.addEventListener('dragover', (ev) => { ev.preventDefault(); });
        li.addEventListener('drop', (ev) => {
          ev.preventDefault();
          const files = Array.from(ev.dataTransfer?.files || []);
          if (!files.length) return;
          actions.importFiles(files, { startAtUiIndex: i }).catch(err => alert('Import error: ' + err));
        });

        ul.appendChild(li);
        this.renderGridTile(i);
      }

      this.refreshSelectionClasses();
      this.updateSelectedLabel();
    },

    renderGridTile(uiIndex, opts) {
      opts = opts || {};
      const forceWave = !!opts.forceWave;
      const ul = document.getElementById('uwSmGridList');
      if (!ul) return;
      const li = ul.querySelector(`.uw-tile[data-idx="${uiIndex | 0}"]`);
      if (!li) return;

      const s = getSlotByUiIndex(uiIndex);
      const nameEl = li.querySelector('.uw-name');
      if (nameEl) nameEl.textContent = s ? normalizeName4(s.name) : '----';

      const badgeEdited = li.querySelector('.uw-badge.edited');
      if (badgeEdited) badgeEdited.style.display = (s && s.__edited) ? 'inline-flex' : 'none';

      const badgeCorrupt = li.querySelector('.uw-badge.corrupt');
      if (badgeCorrupt) badgeCorrupt.style.display = (s && s.__hasCorruption) ? 'inline-flex' : 'none';

      try {
        if (s && s.__hasCorruption && s.__rxStats) {
          li.title = `⚠ Receive integrity issues\nchecksum=${s.__rxStats.checksumErrors || 0}, outOfOrder=${s.__rxStats.outOfOrderErrors || 0}, trunc=${s.__rxStats.truncatedPackets || 0}`;
        } else if (s && s.__rxStats) {
          li.title = 'OK (checksum verified)';
        } else {
          li.title = '';
        }
      } catch (_) {}

      const meta = li.querySelector('.uw-mini-meta');
      if (meta) meta.textContent = this.formatMiniMeta(s);

      const canvas = li.querySelector('canvas.uw-mini');
      if (canvas && (!state.ui.paused || forceWave)) this.drawMiniWave(canvas, s);
    },

    drawEditorWave(canvas, slotObj) {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (!slotObj || !slotObj.rawPCM) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = '#fff';
          ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('No audio', w / 2, h / 2);
          ctx.globalAlpha = 1;
          return;
        }

        const pcm = new Int16Array(slotObj.rawPCM);
        const len = pcm.length | 0;
        if (!len) return;

        // Base layer caching (waveform only). This makes loop-handle dragging
        // responsive by avoiding re-scanning the entire buffer on every move.
        let usedCache = false;
        try {
          const cached = this.editorWaveCache.get(slotObj.rawPCM);
          if (cached && cached.base && cached.w === w && cached.h === h) {
            ctx.drawImage(cached.base, 0, 0);
            usedCache = true;
          }
        } catch (_) {}

        if (!usedCache) {
          const mid = (h / 2) | 0;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = '#fff';

          for (let x = 0; x < w; x++) {
            const start = Math.floor((x * len) / w);
            const end = Math.floor(((x + 1) * len) / w);
            let mn = 32767, mx = -32768;
            const e = Math.max(end, start + 1);
            for (let i = start; i < e; i++) {
              const v = pcm[i] || 0;
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            const y1 = mid - Math.round((mx / 32768) * (h * 0.45));
            const y2 = mid - Math.round((mn / 32768) * (h * 0.45));
            const top = Math.min(y1, y2);
            const bot = Math.max(y1, y2);
            ctx.fillRect(x, top, 1, Math.max(1, bot - top));
          }

          // Snapshot base layer for future draws
          try {
            const base = document.createElement('canvas');
            base.width = w;
            base.height = h;
            const bctx = base.getContext('2d');
            if (bctx) bctx.drawImage(canvas, 0, 0);
            this.editorWaveCache.set(slotObj.rawPCM, { w, h, base });
          } catch (_) {}
        }

        ctx.globalAlpha = 1;

        if (slotObj.loopStart != null && slotObj.loopEnd != null && slotObj.loopEnd > slotObj.loopStart) {
          const ls = slotObj.loopStart | 0;
          const le = slotObj.loopEnd | 0;
          const x1 = Math.floor((ls / len) * w);
          const x2 = Math.floor((le / len) * w);
          ctx.globalAlpha = 0.20;
          ctx.fillStyle = '#0af';
          ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
          // Loop handles
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#0af';
          ctx.fillRect(Math.max(0, x1 - 1), 0, 2, h);
          ctx.fillRect(Math.max(0, x2 - 1), 0, 2, h);
          ctx.globalAlpha = 1;
        }
      } catch (_) {}
    },

    installWaveLoopDrag(canvas, uiIndex) {
      // Drag loop-start/loop-end handles drawn on the editor waveform.
      // Uses cached base waveform rendering, so updates are cheap.
      try {
        if (!canvas) return;

        const idx = uiIndex | 0;
        const self = this;

        const HIT_PX = 8; // handle hit radius (in canvas pixels)
        let dragging = null; // 'start' | 'end'
        let pointerId = null;
        let raf = 0;
        let pendingX = null;

        const getSlotAndLen = () => {
          const slot = getSlotByUiIndex(idx);
          if (!slot) return { slot: null, len: 0 };
          const len = (slot.numSamples | 0) > 0
            ? (slot.numSamples | 0)
            : (slot.rawPCM ? ((slot.rawPCM.byteLength / 2) | 0) : 0);
          return { slot, len };
        };

        const canvasX = (ev) => {
          const r = canvas.getBoundingClientRect();
          const rx = (ev.clientX - r.left);
          const w = Math.max(1, r.width || canvas.width || 1);
          const x = (rx / w) * canvas.width;
          return Math.max(0, Math.min(canvas.width, x));
        };

        const posFromX = (x, len) => {
          if (len <= 0) return 0;
          const p = Math.round((x / canvas.width) * len);
          return Math.max(0, Math.min(len, p));
        };

        const handleHit = (x, len, slot) => {
          if (!slot || len <= 0) return null;
          if (slot.loopStart == null || slot.loopEnd == null || slot.loopEnd <= slot.loopStart) return null;
          const x1 = Math.floor(((slot.loopStart | 0) / len) * canvas.width);
          const x2 = Math.floor(((slot.loopEnd | 0) / len) * canvas.width);
          if (Math.abs(x - x1) <= HIT_PX) return 'start';
          if (Math.abs(x - x2) <= HIT_PX) return 'end';
          return null;
        };

        const updateCursor = (x) => {
          if (dragging) return;
          const { slot, len } = getSlotAndLen();
          const hit = handleHit(x, len, slot);
          canvas.style.cursor = hit ? 'ew-resize' : 'default';
        };

        const applyDrag = () => {
          raf = 0;
          const x = pendingX;
          pendingX = null;
          if (!dragging || x == null) return;
          const { slot, len } = getSlotAndLen();
          if (!slot || len <= 0) return;

          const p = posFromX(x, len);
          let a = (slot.loopStart == null) ? 0 : (slot.loopStart | 0);
          let b = (slot.loopEnd == null) ? len : (slot.loopEnd | 0);

          if (dragging === 'start') {
            a = Math.max(0, Math.min(Math.max(0, len - 1), p));
            if (b <= a) b = Math.min(len, a + 1);
          } else if (dragging === 'end') {
            b = Math.max(0, Math.min(len, p));
            if (b <= a) a = Math.max(0, b - 1);
          }

          slot.loopStart = a;
          slot.loopEnd = b;
          slot.__edited = true;

          // Keep editor fields in sync (without triggering change handlers)
          const inpA = document.getElementById('uwEdLoopStart');
          const inpB = document.getElementById('uwEdLoopEnd');
          if (inpA) inpA.value = String(a);
          if (inpB) inpB.value = String(b);

          // Redraw overlay
          self.drawEditorWave(canvas, slot);
        };

        canvas.addEventListener('pointermove', (ev) => {
          const x = canvasX(ev);
          if (!dragging) {
            updateCursor(x);
            return;
          }
          if (pointerId != null && ev.pointerId !== pointerId) return;
          pendingX = x;
          if (!raf) raf = requestAnimationFrame(applyDrag);
        });

        canvas.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          const { slot, len } = getSlotAndLen();
          if (!slot || len <= 0) return;
          const x = canvasX(ev);
          const hit = handleHit(x, len, slot);
          if (!hit) return;
          dragging = hit;
          pointerId = ev.pointerId;
          try { canvas.setPointerCapture(pointerId); } catch (_) {}
          ev.preventDefault();
        });

        const endDrag = () => {
          if (!dragging) return;
          dragging = null;
          pointerId = null;
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          pendingX = null;
          canvas.style.cursor = 'default';
          // Update mini + tile once (cheap + avoids DOM churn while dragging)
          try { self.renderGridTile(idx); } catch (_) {}
        };

        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('pointerleave', () => {
          // Only adjust cursor when not dragging
          if (!dragging) canvas.style.cursor = 'default';
        });
      } catch (_) {}
    },

    makeEditorRow(labelText, value, type, onChange, extra, inputId) {
      const row = document.createElement('div');
      row.className = 'uw-ed-row';

      const lab = document.createElement('label');
      lab.textContent = labelText;
      row.appendChild(lab);

      const inp = document.createElement('input');
      inp.type = type || 'text';
      if (inputId) inp.id = inputId;
      inp.value = value == null ? '' : String(value);
      inp.addEventListener('change', () => {
        try { onChange && onChange(inp.value); } catch (e) { console.warn(e); }
      });
      row.appendChild(inp);
      return row;
    },

    renderEditor() {
      const ed = this.elements.editor;
      if (!ed) return;

      const idx = Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : 0;
      const s = getSlotByUiIndex(idx);
      const isRam = isRamIndex(idx);

      const paused = !!state.ui.paused;

      ed.innerHTML = '';

      const h = document.createElement('h3');
      h.textContent = `Slot ${slotLabel(idx)} ${isRam ? '(RAM)' : ''}`;
      ed.appendChild(h);

      // During bulk receive/send we intentionally pause heavy UI work to keep
      // the MIDI event loop responsive. Still, we can provide a lightweight
      // read-only view so the user can inspect completed slots mid-transfer.
      if (paused) {
        const hint = document.createElement('div');
        hint.className = 'uw-hint';
        hint.textContent = 'Transfer in progress — editor is in lightweight mode to keep the MIDI stream stable.';
        ed.appendChild(hint);

        // Scaled-up mini waveform (cheap to render)
        try {
          const mini = document.createElement('canvas');
          mini.width = this.MINI_W;
          mini.height = this.MINI_H;
          mini.style.width = '100%';
          mini.style.height = '110px';
          ed.appendChild(mini);
          this.drawMiniWave(mini, s);
        } catch (_) {}

        const mkRO = (labelText, value) => {
          const row = document.createElement('div');
          row.className = 'uw-ed-row';
          const lab = document.createElement('label');
          lab.textContent = labelText;
          row.appendChild(lab);
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = value == null ? '' : String(value);
          inp.disabled = true;
          row.appendChild(inp);
          return row;
        };

        ed.appendChild(mkRO('Name', s ? s.name : '----'));
        ed.appendChild(mkRO('Rate', s ? (s.targetSampleRate || s.originalSampleRate || 44100) : 44100));
        ed.appendChild(mkRO('Repitch', s ? (s.repitch || 0) : 0));
        const loopEnabled = !!(s && s.loopStart != null && s.loopEnd != null && s.loopEnd > s.loopStart);
        ed.appendChild(mkRO('Loop', loopEnabled ? `${s.loopStart | 0} → ${s.loopEnd | 0}` : 'off'));

        return;
      }

      const wave = document.createElement('canvas');
      wave.id = 'uwEdWave';
      wave.width = 600;
      wave.height = 110;
      ed.appendChild(wave);
      this.drawEditorWave(wave, s);
      this.installWaveLoopDrag(wave, idx);

      const hint = document.createElement('div');
      hint.className = 'uw-hint';
      hint.textContent = isRam
        ? 'RAM buffers are receive-only. You can export them, but you cannot send them back to the Machinedrum.'
        : 'Shift-click selects ranges. Ctrl/Cmd-click toggles. Ctrl/Cmd+C/V/X to copy/paste/cut. Delete clears.';
      ed.appendChild(hint);

      // Name
      ed.appendChild(this.makeEditorRow(
        'Name',
        (s ? s.name : '----'),
        'text',
        (val) => {
          const slot = getSlotByUiIndex(idx);
          if (!slot) return;
          slot.name = normalizeName4(val);
          slot.__edited = true;
          this.renderGridTile(idx);
        },
        { applyToSelected: () => actions.applyFieldToSelection('name', normalizeName4(document.getElementById('uwEdName')?.value || '----')) },
        'uwEdName'
      ));

            // Rate (presets, still editable)
      const rateVal = s ? (s.targetSampleRate || s.originalSampleRate || 44100) : 44100;
      {
        const row = document.createElement('div');
        row.className = 'uw-ed-row';
        const lab = document.createElement('label');
        lab.textContent = 'Rate';
        row.appendChild(lab);

        const inp = document.createElement('input');
        inp.type = 'number';
        inp.id = 'uwEdRate';
        inp.min = '4000';
        inp.max = '96000';
        inp.step = '1';
        inp.value = String(rateVal);
        inp.setAttribute('list', 'uwRatePresets');
        inp.addEventListener('change', () => {
          const slot = getSlotByUiIndex(idx);
          if (!slot) return;
          const n = Math.max(4000, Math.min(96000, parseInt(inp.value, 10) || 44100));
          slot.targetSampleRate = n;
          slot.__edited = true;
          this.updateMemoryLabel();
          this.renderGridTile(idx);
        });
        row.appendChild(inp);

        // Explicit preset dropdown (more discoverable than datalist in some browsers)
        try {
          const presets = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
          const sel = document.createElement('select');
          sel.id = 'uwEdRatePreset';
          sel.title = 'Common sample-rate presets';
          sel.style.marginLeft = '6px';

          const opt0 = document.createElement('option');
          opt0.value = '';
          opt0.textContent = 'Presets';
          sel.appendChild(opt0);

          presets.forEach(v => {
            const o = document.createElement('option');
            o.value = String(v);
            o.textContent = String(v);
            sel.appendChild(o);
          });

          sel.addEventListener('change', () => {
            if (!sel.value) return;
            inp.value = sel.value;
            try { inp.dispatchEvent(new Event('change')); } catch (_) { try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {} }
            sel.value = '';
          });

          row.appendChild(sel);
        } catch (_) {}

        const dl = document.createElement('datalist');
        dl.id = 'uwRatePresets';
        [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].forEach(v => {
          const opt = document.createElement('option');
          opt.value = String(v);
          dl.appendChild(opt);
        });
        row.appendChild(dl);

        ed.appendChild(row);
      }

      // Repitch (slider + number)
      const rpVal = s ? (s.repitch || 0) : 0;
      {
        const row = document.createElement('div');
        row.className = 'uw-ed-row';
        const lab = document.createElement('label');
        lab.textContent = 'Repitch';
        row.appendChild(lab);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'uwEdRepitchSlider';
        slider.min = '-48';
        slider.max = '48';
        slider.step = '1';
        slider.value = String(rpVal);
        slider.setAttribute('list', 'uwRepitchTicks');

        const num = document.createElement('input');
        num.type = 'number';
        num.id = 'uwEdRepitch';
        num.min = '-48';
        num.max = '48';
        num.step = '1';
        num.value = String(rpVal);
        num.style.width = '76px';

        const apply = (valStr, render) => {
          const slot = getSlotByUiIndex(idx);
          if (!slot) return;
          const n = Math.max(-48, Math.min(48, parseInt(valStr, 10) || 0));
          slot.repitch = n;
          slot.__edited = true;
          this.updateMemoryLabel();
          if (render) this.renderGridTile(idx);
        };

        slider.addEventListener('input', () => {
          num.value = slider.value;
          apply(slider.value, false);
        });
        slider.addEventListener('change', () => {
          num.value = slider.value;
          apply(slider.value, true);
        });

        num.addEventListener('input', () => {
          slider.value = num.value;
          apply(num.value, false);
        });
        num.addEventListener('change', () => {
          slider.value = num.value;
          apply(num.value, true);
        });

        row.appendChild(slider);
        row.appendChild(num);

        const dl = document.createElement('datalist');
        dl.id = 'uwRepitchTicks';
        [-24, -12, 0, 12, 24].forEach(v => {
          const opt = document.createElement('option');
          opt.value = String(v);
          dl.appendChild(opt);
        });
        row.appendChild(dl);

        ed.appendChild(row);
      }

// Loop
      const loopEnabled = !!(s && s.loopStart != null && s.loopEnd != null && s.loopEnd > s.loopStart);
      const ls = loopEnabled ? (s.loopStart | 0) : '';
      const le = loopEnabled ? (s.loopEnd | 0) : '';
      const loopRow = document.createElement('div');
      loopRow.className = 'uw-ed-row uw-ed-loop-row';
      const lab = document.createElement('label');
      lab.textContent = 'Loop';
      loopRow.appendChild(lab);

      // Loop enabled toggle
      const loopToggle = document.createElement('input');
      loopToggle.type = 'checkbox';
      loopToggle.id = 'uwEdLoopEnabled';
      loopToggle.checked = loopEnabled;
      loopToggle.title = 'Enable/disable loop';
      loopToggle.addEventListener('change', () => {
        const slot = getSlotByUiIndex(idx);
        if (!slot) return;
        if (!loopToggle.checked) {
          slot.loopStart = null;
          slot.loopEnd = null;
        } else {
          const maxS = (slot.numSamples | 0) > 0 ? (slot.numSamples | 0) : ((slot.rawPCM ? (slot.rawPCM.byteLength / 2) | 0 : 0));
          if (maxS <= 0) {
            slot.loopStart = null;
            slot.loopEnd = null;
          } else {
            let a = (slot.loopStart == null) ? 0 : (slot.loopStart | 0);
            let b = (slot.loopEnd == null) ? maxS : (slot.loopEnd | 0);
            a = clampInt(a, 0, Math.max(0, maxS - 1));
            b = clampInt(b, 0, maxS);
            if (b <= a) { a = 0; b = Math.min(maxS, a + 1); }
            slot.loopStart = a;
            slot.loopEnd = b;
          }
        }
        slot.__edited = true;
        this.renderEditor();
        this.renderGridTile(idx);
      });

      const loopToggleLab = document.createElement('span');
      loopToggleLab.textContent = 'on';
      loopToggleLab.style.opacity = 0.8;
      loopToggleLab.style.marginRight = '6px';

      loopRow.appendChild(loopToggle);
      loopRow.appendChild(loopToggleLab);

      const inpLs = document.createElement('input');
      inpLs.type = 'number';
      inpLs.id = 'uwEdLoopStart';
      inpLs.placeholder = 'start';
      inpLs.value = String(ls);
      const inpLe = document.createElement('input');
      inpLe.type = 'number';
      inpLe.id = 'uwEdLoopEnd';
      inpLe.placeholder = 'end';
      inpLe.value = String(le);

      inpLs.disabled = !loopToggle.checked;
      inpLe.disabled = !loopToggle.checked;

      inpLs.addEventListener('change', () => actions.setLoopFromEditor(idx));
      inpLe.addEventListener('change', () => actions.setLoopFromEditor(idx));

      loopRow.appendChild(inpLs);
      loopRow.appendChild(inpLe);

      ed.appendChild(loopRow);

      // Actions
      const act = document.createElement('div');
      act.className = 'uw-ed-row';
      act.appendChild(this.makeBtn('Play', 'Preview this slot', () => actions.previewSlot(idx)));
      act.appendChild(this.makeBtn('Receive', 'Receive into this slot', () => actions.receiveSingle(idx)));
      const btnSend = this.makeBtn('Send', 'Send this slot', () => actions.sendSingle(idx));
      if (isRam) btnSend.disabled = true;
      act.appendChild(btnSend);
      ed.appendChild(act);
    },

    // Progress + marks
    markSlot(uiIndex, mode) {
      const ul = document.getElementById('uwSmGridList');
      if (!ul) return;
      const li = ul.querySelector(`.uw-tile[data-idx="${uiIndex | 0}"]`);
      if (!li) return;
      li.classList.toggle('is-sending', mode === 'sending');
      li.classList.toggle('is-receiving', mode === 'receiving');
    },

    updateProgress(uiIndex, frac) {
      const ul = document.getElementById('uwSmGridList');
      if (!ul) return;
      const li = ul.querySelector(`.uw-tile[data-idx="${uiIndex | 0}"]`);
      if (!li) return;
      const f = Math.max(0, Math.min(1, Number(frac) || 0));
      const p = li.querySelector('.uw-progress');
      if (p) p.style.width = `${(f * 100).toFixed(1)}%`;
    },

    clearAllMarks() {
      const ul = document.getElementById('uwSmGridList');
      if (!ul) return;
      ul.querySelectorAll('.uw-tile').forEach(li => {
        li.classList.remove('is-sending', 'is-receiving');
        const p = li.querySelector('.uw-progress');
        if (p) p.style.width = '0%';
      });
    },

    showCancel(show) {
      const btn = this.elements.bulkCancelBtn;
      if (btn) btn.style.display = show ? '' : 'none';
    },


    setBulkStatus(text) {
      if (this.elements.bulkStatus) this.elements.bulkStatus.textContent = text || '';
    },

    updateSelectedLabel() {
      if (this.elements.statusSelected) this.elements.statusSelected.textContent = `Selected: ${state.selection.size}`;
    },

    computeMemory() {
      const uw = state.samples || ensureSamplesModel();
      let used = 0;
      for (const s of (uw.slots || [])) {
        if (!s || !s.numSamples || !s.originalSampleRate) continue;
        const rp = s.repitch || 0;
        const rpF = Math.pow(2, rp / 12);
        const rate = s.targetSampleRate || s.originalSampleRate;
        const effFactor = (rate / s.originalSampleRate) / rpF;
        const newS = Math.floor((s.numSamples | 0) * effFactor);
        used += newS * 2 + MD_METADATA_OVERHEAD;
      }
      const limit = (uw.model === 'MKI') ? MD_MEMORY_MKI : MD_MEMORY_MKII;
      const free = Math.max(limit - used, 0);
      const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      return { used, limit, free, pct };
    },

    updateMemoryLabel() {
      const m = this.computeMemory();
      if (this.elements.statusMemory) this.elements.statusMemory.textContent = `Used ${(m.used / 1024).toFixed(1)}KB (${m.pct}%)`;
    },

    updateConnectionLabel() {
      if (!this.elements.statusConn) return;
      const parts = [];
      if (window.mdOSVersion) parts.push(`OS ${window.mdOSVersion}`);
      const uw = state.samples || ensureSamplesModel();
      if (uw && uw.model) parts.push(uw.model);
      if (window.mdSlotListSupported === true) parts.push('SlotList');
      parts.push(window.turboActive ? 'Turbo' : 'Std');
      try {
        const r = !!document.getElementById('openLoopRecvGlobal')?.checked;
        const s = !!document.getElementById('openLoopSendGlobal')?.checked;
        if (r || s) parts.push('Open-loop');
      } catch (_) {}
      this.elements.statusConn.textContent = parts.join(' • ') || '—';
      try { this.updateRecvStreamButtonMode(); } catch (_) {}
      try { this.updateSlotListButtonVisibility(); } catch (_) {}
    },


    updateRecvStreamButtonMode() {
      const btn = this.elements.recvStreamBtn;
      if (!btn) return;
      const openLoop = !!document.getElementById('openLoopRecvGlobal')?.checked;
      const forcedOpen = (window.mdOSVersion === '1.63');
      if (openLoop || forcedOpen) {
        btn.textContent = 'Receive Stream';
        btn.title = 'Open-loop stream capture (SEND > ALL on MD)';
      } else {
        btn.textContent = 'Receive All';
        btn.title = 'Closed-loop: request all UW slots sequentially (no SEND > ALL needed)';
      }
    },


    updateSlotListButtonVisibility() {
      const btn = this.elements.slotListBtn;
      if (!btn) return;
      // Slot List is an X-only feature; hide it in OS 1.63 mode.
      const os = window.mdOSVersion;
      if (os === '1.63') {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = '';
    },


    // Keyboard handling
    isTypingContext() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'button', 'submit'].includes(type);
      }
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    },

    installKeyboardHandlers() {
      if (document.__uwSmKeyHandlersInstalled) return;
      document.__uwSmKeyHandlersInstalled = true;

      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Shift') window.shiftKeyIsDown = true;
        if (window.activePanel && window.activePanel !== 'uw') return;
        if (!window.uwPanelActive) return;
        if (this.isTypingContext()) return;

        const total = getTotalUiSlots();
        let idx = Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : 0;
        idx = clampInt(idx, 0, total - 1);

        const isMac = /Mac/i.test(navigator.platform || '');
        const metaOrCtrl = isMac ? ev.metaKey : ev.ctrlKey;

        // Select all (group-aware)
        if (metaOrCtrl && ev.key.toLowerCase() === 'a') {
          ev.preventDefault();
          state.selection.clear();
          const uw = state.samples || ensureSamplesModel();
          if (idx >= uw.maxSlots) {
            for (let r = 0; r < uw.ram.length; r++) state.selection.add(uw.maxSlots + r);
          } else {
            for (let i = 0; i < uw.maxSlots; i++) state.selection.add(i);
          }
          this.refreshSelectionClasses();
          this.renderEditor();
          return;
        }

        // Clipboard
        if (metaOrCtrl && ev.key.toLowerCase() === 'c') { ev.preventDefault(); actions.copy(); return; }
        if (metaOrCtrl && ev.key.toLowerCase() === 'v') { ev.preventDefault(); actions.paste(); return; }
        if (metaOrCtrl && ev.key.toLowerCase() === 'x') { ev.preventDefault(); actions.cut(); return; }

        // Delete clears
        if (ev.key === 'Delete' || ev.key === 'Backspace') {
          ev.preventDefault();
          actions.clearActiveOrSelection({ confirm: true });
          return;
        }

        // Space preview
        if (ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          actions.previewSlot(idx);
          return;
        }

        // Escape clears selection
        if (ev.key === 'Escape') {
          if (state.selection.size) {
            ev.preventDefault();
            state.selection.clear();
            this.refreshSelectionClasses();
            this.renderEditor();
          }
          return;
        }

        // Navigation
        const rowJump = this.GRID_COLS;
        const stepUD = ev.altKey ? rowJump : 1;
        let next = null;
        if (ev.key === 'ArrowUp') next = idx - stepUD;
        else if (ev.key === 'ArrowDown') next = idx + stepUD;
        else if (ev.key === 'ArrowLeft') next = idx - 1;
        else if (ev.key === 'ArrowRight') next = idx + 1;
        else if (ev.key === 'PageUp') next = idx - rowJump;
        else if (ev.key === 'PageDown') next = idx + rowJump;

        if (next != null) {
          ev.preventDefault();
          const uw = state.samples || ensureSamplesModel();
          if (idx < uw.maxSlots) next = clampInt(next, 0, uw.maxSlots - 1);
          else {
            const start = uw.maxSlots;
            const end = uw.maxSlots + uw.ram.length - 1;
            next = clampInt(next, start, end);
          }

          this.setActiveAndSelect(next, { range: !!ev.shiftKey, toggle: false, clearSelection: false });
          const tile = document.querySelector(`.uw-tile[data-idx="${next}"]`);
          if (tile && tile.scrollIntoView) tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (tile && tile.focus) tile.focus();
          return;
        }
      }, true);

      document.addEventListener('keyup', (ev) => {
        if (ev.key === 'Shift') window.shiftKeyIsDown = false;
      }, true);
    }
  };

  // --------------------------------------------------------------------------
  // Bindings: activeSlot / uwPanelActive (compatibility)
  // --------------------------------------------------------------------------
  let _uwPanelActive = !!window.uwPanelActive;
  try {
    if (!Object.getOwnPropertyDescriptor(window, 'uwPanelActive') ||
        Object.getOwnPropertyDescriptor(window, 'uwPanelActive').configurable) {
      Object.defineProperty(window, 'uwPanelActive', {
        configurable: true,
        enumerable: false,
        get() { return _uwPanelActive; },
        set(v) { _uwPanelActive = !!v; }
      });
    }
  } catch (_) { window.uwPanelActive = _uwPanelActive; }

  let _activeSlot = Number.isFinite(window.activeSlot) ? (window.activeSlot | 0) : 0;
  try {
    if (!Object.getOwnPropertyDescriptor(window, 'activeSlot') ||
        Object.getOwnPropertyDescriptor(window, 'activeSlot').configurable) {
      Object.defineProperty(window, 'activeSlot', {
        configurable: true,
        enumerable: false,
        get() { return _activeSlot; },
        set(v) {
          const n = Number(v);
          _activeSlot = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
          state.activeIndex = _activeSlot;
          try { ui.renderEditor(); } catch (_) {}
          try { ui.refreshSelectionClasses(); } catch (_) {}
        }
      });
    }
  } catch (_) { window.activeSlot = _activeSlot; }


  // --------------------------------------------------------------------------
  // Transfer focus (wake lock + active sensing keepalive + sysex filtering)
  // --------------------------------------------------------------------------
  async function acquireWakeLock() {
    try {
      if (state.transferFocus.wakeLock) return;
      if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
      state.transferFocus.wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      state.transferFocus.wakeLock = null;
    }
  }
  async function releaseWakeLock() {
    try { if (state.transferFocus.wakeLock) await state.transferFocus.wakeLock.release(); } catch (_) {}
    state.transferFocus.wakeLock = null;
  }

  function startActiveSense(intervalMs) {
    stopActiveSense();
    const out = window.selectedMidiOut;
    if (!out || typeof out.send !== 'function') return;
    const ms = Math.max(80, intervalMs | 0);
    state.transferFocus.activeSenseTimer = setInterval(() => {
      try { out.send([0xFE]); } catch (_) {}
    }, ms);
  }
  function stopActiveSense() {
    if (state.transferFocus.activeSenseTimer) {
      try { clearInterval(state.transferFocus.activeSenseTimer); } catch (_) {}
      state.transferFocus.activeSenseTimer = null;
    }
  }

  function pauseHeavyUi() { state.ui.paused = true; }
  function resumeHeavyUi() { state.ui.paused = false; }

  async function enterTransferFocus(opts) {
    opts = opts || {};
    const wakeLock = (opts.wakeLock !== false);
    const activeSense = (opts.activeSense !== false);
    const keepAliveMs = Number.isFinite(opts.activeSenseIntervalMs) ? (opts.activeSenseIntervalMs | 0) : 150;

    // Optional: clamp Turbo speed for UW SDS transfers.
    // Rationale: many rigs are rock-solid at higher Turbo factors for the
    // Elektron dump formats (kit/pattern/song/global), but SDS can become
    // unreliable (or show no RX gain) beyond ~idx3.
    const sdsDir = (opts.uwSdsDirection || opts.sdsDirection || null);
    const wantTurboClamp = (opts.clampTurboForSds !== false) && (sdsDir === 'rx' || sdsDir === 'tx');

    state.transferFocus.depth++;
    if (state.transferFocus.depth > 1) return;

    state.transferFocus.saved = {
      ignoreNonSampleManagerSysex: !!window.ignoreNonSampleManagerSysex,
      blockSlotWrites: !!window.blockSlotWrites,
      bulkOperationInProgress: !!window.bulkOperationInProgress,

      // Turbo restore info (best-effort).
      turbo: {
        wasActive: !!window.turboActive,
        wasSpeedVal: uwGetCurrentTurboSpeedValApprox(),
        wasFactor: getTurboFactor(),
        direction: sdsDir,
        didClamp: false,
        clampResult: null
      }
    };

    window.ignoreNonSampleManagerSysex = true;
    window.blockSlotWrites = true;

    if (wantTurboClamp) {
      try {
        const r = await uwMaybeClampTurboForSds(sdsDir);
        state.transferFocus.saved.turbo.clampResult = r;
        state.transferFocus.saved.turbo.didClamp = !!(r && r.changed);
      } catch (e) {
        state.transferFocus.saved.turbo.clampResult = { changed: false, reason: 'exception', error: e };
        state.transferFocus.saved.turbo.didClamp = false;
      }
    }

    if (wakeLock) await acquireWakeLock();
    if (activeSense) startActiveSense(keepAliveMs);

    pauseHeavyUi();
  }

  async function exitTransferFocus() {
    if (state.transferFocus.depth <= 0) return;
    state.transferFocus.depth--;
    if (state.transferFocus.depth > 0) return;

    // Restore Turbo speed (if we clamped it for SDS) before we drop our
    // transfer focus guards.
    try {
      const saved = state.transferFocus.saved || {};
      const t = saved.turbo || null;
      if (t && t.didClamp && typeof window.setTurboSpeedVal === 'function') {
        if (t.wasActive) {
          await window.setTurboSpeedVal(t.wasSpeedVal);
        } else {
          await window.setTurboSpeedVal(1);
        }
      }
    } catch (_) {}

    stopActiveSense();
    await releaseWakeLock();
    resumeHeavyUi();

    // If we suppressed heavy renders during transfer focus, flush them now.
    if (state.ui.needsPostTransferRender) {
      try {
        requestAnimationFrame(() => {
          if (state.ui.paused) return;
          if (!state.ui.needsPostTransferRender) return;
          state.ui.needsPostTransferRender = false;
          try { ui.render(); } catch (_) {}
        });
      } catch (_) {
        try {
          if (!state.ui.paused) { state.ui.needsPostTransferRender = false; ui.render(); }
        } catch (_) {}
      }
    }

    const saved = state.transferFocus.saved || {};
    window.ignoreNonSampleManagerSysex = !!saved.ignoreNonSampleManagerSysex;
    window.blockSlotWrites = !!saved.blockSlotWrites;
    window.bulkOperationInProgress = !!saved.bulkOperationInProgress;
    state.transferFocus.saved = null;
  }

  async function withTransferFocus(fn, opts) {
    await enterTransferFocus(opts);
    try {
      return await fn();
    } finally {
      await exitTransferFocus();
    }
  }

  try {
    window.__uwEnterTransferFocus = enterTransferFocus;
    window.__uwExitTransferFocus = exitTransferFocus;
  } catch (_) {}

  // --------------------------------------------------------------------------
  // MIDI helpers
  // --------------------------------------------------------------------------
  function midiOut() { return window.selectedMidiOut || null; }
  function midiSend(bytes) {
    const out = midiOut();
    if (!out || typeof out.send !== 'function') throw new Error('No MIDI OUT selected');
    out.send(bytes);
  }

  // --------------------------------------------------------------------------
  // RX Engine (single canonical SDS receive pipeline)
  // --------------------------------------------------------------------------
  function createRxEngine() {
    const rx = {
      mode: null,           // 'closed' | 'open' | 'stream'
      collecting: false,
      destOverride: null,   // { uiIndex }
      desiredSlots: null,   // Set<uiIndex> for stream filtering
      captured: null,       // Set<uiIndex> captured in current stream
      lastStreamReport: null, // { captured: number[], corrupt: number[], ts } from the most recent stream
      lastPacketTime: 0,
      idleFinalizeTimer: null,
      idleStopTimer: null,
      current: null,
      abortSignal: null
    };

    function resetCurrent() {
      rx.collecting = false;
      rx.current = null;
      rx.lastPacketTime = 0;
      if (rx.idleFinalizeTimer) { clearTimeout(rx.idleFinalizeTimer); rx.idleFinalizeTimer = null; }
    }
    function resetAll() {
      resetCurrent();
      rx.mode = null;
      rx.destOverride = null;
      rx.desiredSlots = null;
      rx.captured = null;
      rx.abortSignal = null;
      state.rxNameMap163 = null;
      if (rx.idleStopTimer) { clearTimeout(rx.idleStopTimer); rx.idleStopTimer = null; }
    }

    function scheduleIdleFinalize(ms) {
      if (rx.idleFinalizeTimer) { clearTimeout(rx.idleFinalizeTimer); rx.idleFinalizeTimer = null; }
      const delay = Math.max(250, ms | 0);
      rx.idleFinalizeTimer = setTimeout(() => {
        if (!rx.collecting || !rx.current) return;
        const since = Date.now() - (rx.lastPacketTime || 0);
        if (since >= delay) finalize(null, 'idle');
      }, delay);
    }

    function scheduleIdleStop(ms) {
      if (rx.idleStopTimer) { clearTimeout(rx.idleStopTimer); rx.idleStopTimer = null; }
      const delay = Math.max(500, ms | 0);
      rx.idleStopTimer = setTimeout(() => {
        if (rx.mode !== 'stream') return;
        const since = Date.now() - (rx.lastPacketTime || 0);
        if (since >= delay) {
          try { if (rx.collecting && rx.current) finalize(null, 'stream-idle-stop'); } catch (_) {}
          stopStream();
        } else {
          scheduleIdleStop(delay);
        }
      }, delay);
    }

    function uiIndexFromSdsSampleNumber(sampleNumber) {
      const uw = state.samples || ensureSamplesModel();
      const max = uw.maxSlots | 0;
      const ramCount = (uw.ram && uw.ram.length) ? (uw.ram.length | 0) : 0;
      if (sampleNumber >= 0 && sampleNumber < max) return sampleNumber;
      const r = sampleNumber - max;
      if (r >= 0 && r < ramCount) return max + r;
      return clampInt(sampleNumber | 0, 0, max - 1);
    }

    function shouldCapture(uiIndex) {
      if (rx.mode !== 'stream') return true;
      if (!rx.desiredSlots || rx.desiredSlots.size === 0) return true;
      return rx.desiredSlots.has(uiIndex);
    }

    async function startClosed(uiIndex, opts) {
      opts = opts || {};
      const idx = uiIndex | 0;
      rx.mode = 'closed';
      rx.destOverride = { uiIndex: idx };
      rx.desiredSlots = null;
      rx.captured = null;
      rx.abortSignal = opts.abortSignal || null;
      resetCurrent();

      state.rxNameMap163 = (window.mdOSVersion === '1.63') ? new Map() : null;

      // Request SDS dump
      const sampleNumber = idx;
      midiSend([0xF0, 0x7E, 0x00, 0x03, sampleNumber & 0x7F, (sampleNumber >> 7) & 0x7F, 0xF7]);

      ui.markSlot(idx, 'receiving');
      ui.updateProgress(idx, 0);

      const timeoutMs = Number.isFinite(opts.headerTimeoutMs) ? (opts.headerTimeoutMs | 0) : 2500;
      const t0 = Date.now();
      while (!rx.collecting) {
        if (rx.abortSignal && rx.abortSignal.aborted) {
          // Best-effort: unblock the sender so subsequent slot requests don't fail.
          try { midiSend([0xF0, 0x7E, 0x00, SDS_CANCEL, 0x00, 0xF7]); } catch (_) {}
          resetAll();
          throw new Error('RX_ABORTED');
        }
        if (Date.now() - t0 > timeoutMs) {
          // Best-effort: unblock the sender so subsequent slot requests don't fail.
          try { midiSend([0xF0, 0x7E, 0x00, SDS_CANCEL, 0x00, 0xF7]); } catch (_) {}
          resetAll();
          throw new Error('NO_SAMPLE_HEADER');
        }
        await new Promise(r => setTimeout(r, 25));
      }
      return true;
    }

    async function startOpen(destUiIndex, opts) {
      opts = opts || {};
      const idx = destUiIndex | 0;
      rx.mode = 'open';
      rx.destOverride = { uiIndex: idx };
      rx.desiredSlots = null;
      rx.captured = null;
      rx.abortSignal = opts.abortSignal || null;
      resetCurrent();

      state.rxNameMap163 = (window.mdOSVersion === '1.63') ? new Map() : null;

      ui.markSlot(idx, 'receiving');
      ui.updateProgress(idx, 0);
      return true;
    }

    async function startStream(opts) {
      opts = opts || {};
      rx.mode = 'stream';
      rx.destOverride = null;
      rx.desiredSlots = opts.desiredSlots ? new Set(Array.from(opts.desiredSlots).map(n => n | 0)) : null;
      rx.captured = new Set();
      rx.abortSignal = opts.abortSignal || null;
      resetCurrent();

      state.rxNameMap163 = (window.mdOSVersion === '1.63') ? new Map() : null;

      ui.setBulkStatus('Receiving stream… (SEND > ALL on the Machinedrum)');
      scheduleIdleStop(Number.isFinite(opts.idleStopMs) ? (opts.idleStopMs | 0) : 2500);
      return true;
    }

    function stopStream() {
      if (rx.mode !== 'stream') return;

      // Snapshot what we captured so the actions layer can offer a repair pass.
      try {
        const captured = rx.captured ? Array.from(rx.captured) : [];
        const corrupt = captured.filter(i => {
          const s = getSlotByUiIndex(i | 0);
          return !!(s && s.__hasCorruption);
        });
        rx.lastStreamReport = { captured, corrupt, ts: Date.now() };
      } catch (_) {
        rx.lastStreamReport = { captured: [], corrupt: [], ts: Date.now() };
      }

      ui.setBulkStatus('');
      resetAll();
      ui.clearAllMarks();
    }

    function cancel(reason) {
      if (!rx.mode) return;
      // Best-effort: ask the sender to stop/unblock (especially in closed-loop).
      // IMPORTANT: Do NOT store a partial/corrupted sample on user cancel/abort.
      try {
        if (rx.mode === 'closed') {
          const pno = (rx.current && Number.isFinite(rx.current.expectedPacket)) ? (rx.current.expectedPacket & 0x7F) : 0;
          midiSend([0xF0, 0x7E, 0x00, SDS_CANCEL, pno, 0xF7]);
        }
      } catch (_) {}
      resetAll();
      ui.clearAllMarks();
    }

    function storeFinal(uiIndex, cur, rawPCM, meta) {
      const existing = getSlotByUiIndex(uiIndex);
      let mapped = null;
      if (window.mdOSVersion === '1.63' && state.rxNameMap163 && cur) {
        mapped = state.rxNameMap163.get(cur.sampleNumber | 0) || null;
      }

      // OS 1.63: avoid falling back to state.lastSampleName (not slot-safe during stream RX).
      const fallback = (window.mdOSVersion === '1.63') ? '----' : (state.lastSampleName || '----');
      const nameHint = normalizeName4(mapped || cur.nameHint || fallback);
      const finalName = (existing && existing.name && existing.name !== '----') ? normalizeName4(existing.name) : nameHint;

      const slotObj = (existing && typeof existing === 'object') ? existing : {};
      slotObj.name = finalName;
      slotObj.rawPCM = rawPCM;
      slotObj.rawPCMBase64 = null; // computed lazily as needed

      const actualWords = (rawPCM && rawPCM.byteLength) ? ((rawPCM.byteLength / 2) | 0) : 0;
      const declaredWords = (cur.totalWords | 0) > 0 ? (cur.totalWords | 0) : actualWords;

      // Always store the *actual* decoded length. (If the transfer was incomplete,
      // we do not want to lie about the size — that causes downstream glitches.)
      slotObj.numSamples = actualWords;
      slotObj.originalSampleRate = cur.sampleRate || 44100;
      slotObj.targetSampleRate = slotObj.originalSampleRate;
      slotObj.sizeBytes = slotObj.numSamples * 2;
      slotObj.repitch = slotObj.repitch || 0;

      // Keep the declared length from the SDS header for diagnostics.
      slotObj.__declaredWords = declaredWords;

      // Loop clamp (based on decoded length we actually have)
      const hasLoop = (cur.loopType !== 0x7F) && (cur.loopEnd | 0) > (cur.loopStart | 0);
      if (hasLoop) {
        const maxS = slotObj.numSamples | 0;
        let ls = clampInt(cur.loopStart | 0, 0, Math.max(0, maxS - 1));
        let le = clampInt(cur.loopEnd | 0, 0, maxS);
        if (le <= ls) { slotObj.loopStart = null; slotObj.loopEnd = null; }
        else { slotObj.loopStart = ls; slotObj.loopEnd = le; }
      } else {
        slotObj.loopStart = null;
        slotObj.loopEnd = null;
      }

      // Raw packet capture
      slotObj.__sdsRawPackets = Array.isArray(cur.rawPackets) ? cur.rawPackets : null;

      // RX stats + integrity flags
      const rxStats = cur.rxStats || { checksumErrors: 0, outOfOrderErrors: 0, truncatedPackets: 0 };
      slotObj.__rxStats = rxStats;
      const statsErr = ((rxStats.checksumErrors | 0) + (rxStats.outOfOrderErrors | 0) + (rxStats.truncatedPackets | 0) > 0);
      const lengthErr = (declaredWords > 0 && actualWords !== declaredWords);
      const explicitErr = !!(meta && meta.err);

      slotObj.__rxWhy = meta && meta.why ? String(meta.why) : null;
      slotObj.__rxError = explicitErr ? String(meta.err && (meta.err.message || meta.err)) : null;
      slotObj.__hasCorruption = (statsErr || lengthErr || explicitErr);

      // CRC snapshot for parity resend (only needed if we kept the raw SDS packets).
      slotObj.__pcmCrc32 = null;
      if (Array.isArray(slotObj.__sdsRawPackets) && slotObj.__sdsRawPackets.length) {
        try { slotObj.__pcmCrc32 = crc32(new Uint8Array(rawPCM)); } catch (_) { slotObj.__pcmCrc32 = null; }
      }

      // Device-received data clears edited flag
      slotObj.__edited = false;

      setSlotByUiIndex(uiIndex, slotObj);

      ui.markSlot(uiIndex, null);
      ui.updateProgress(uiIndex, 0);

      // During active transfers (Turbo stream etc.) keep UI work minimal so we
      // don't starve the MIDI event loop. We'll do full renders after transfer
      // focus ends.
      if (state.ui.paused) {
        state.ui.needsPostTransferRender = true;
        // Update cheap UI bits immediately (name/meta/badges).
        try { ui.renderGridTile(uiIndex); } catch (_) {}

        // IMPORTANT: While UI is paused we intentionally skip drawing the
        // waveform inside renderGridTile(). That keeps the MIDI event loop
        // responsive, but it can leave tiles showing an "empty" waveform
        // until another UI interaction triggers a redraw.
        //
        // Queue a throttled mini-wave redraw so completed slots update
        // robustly whenever audio data is present.
        try { ui.queueMiniWaveDraw(uiIndex); } catch (_) {}
        return;
      }

      ui.renderGridTile(uiIndex);
      ui.queueMiniWaveDraw(uiIndex);
      ui.renderEditor();
      ui.updateMemoryLabel();
    }

    function finalize(err, why) {
      const cur = rx.current;
      const mode = rx.mode;
      if (!cur) {
        resetCurrent();
        if (mode === 'stream') scheduleIdleStop(2500);
        else resetAll();
        return;
      }

      // Build raw PCM buffer.
      // NOTE: At Turbo speeds we may decode directly into a preallocated Int16Array
      // to reduce allocations/GC and improve RX robustness.
      let rawPCM = null;

      if (cur.pcm16 && cur.pcm16.buffer) {
        const haveWords = Math.max(0, cur.wordsSoFar | 0);
        rawPCM = cur.pcm16.buffer.slice(0, haveWords * 2);
      } else {
        // Trim to declared size (prevents end-clicks on complete transfers)
        if (!err && (cur.totalWords | 0) > 0) cur.dataBuffer = trimPcmBytesToWords(cur.dataBuffer, cur.totalWords | 0);

        const pcmBytes = new Uint8Array(cur.dataBuffer || []);
        rawPCM = pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength);
        if ((cur.totalWords | 0) > 0) {
          const want = (cur.totalWords | 0) * 2;
          if (rawPCM.byteLength > want) rawPCM = rawPCM.slice(0, want);
        }
      }

      const uiIndex = (rx.destOverride && Number.isFinite(rx.destOverride.uiIndex))
        ? (rx.destOverride.uiIndex | 0)
        : uiIndexFromSdsSampleNumber(cur.sampleNumber | 0);

      const actualWords = (rawPCM && rawPCM.byteLength) ? ((rawPCM.byteLength / 2) | 0) : 0;
      const declaredWords = (cur.totalWords | 0) > 0 ? (cur.totalWords | 0) : actualWords;
      const incomplete = (declaredWords > 0 && actualWords < declaredWords);

      // If we ended without an explicit error but did not receive the declared
      // number of words, treat as an error (prevents “silent corruption”).
      if (!err && incomplete) err = new Error('RX_INCOMPLETE');

      // Always store what we have, but mark corruption via meta flags.
      storeFinal(uiIndex, cur, rawPCM, { err, why, actualWords, declaredWords, incomplete });

      if (err) {
        const info = {
          why,
          mode,
          uiIndex,
          sampleNumber: cur.sampleNumber | 0,
          actualWords,
          declaredWords,
          rxStats: cur.rxStats || null,
        };

        // By default, avoid spamming stack traces for expected stream issues
        // (e.g. a single dropped packet in open-loop Turbo).
        // Enable full stacks via console:
        //   window.MDDT_LOG_SDS = true
        //   window.MDDT_LOG_SDS_TIMING = true
        //   window.uwLogSdsStacks = true
        const wantStacks = !!(window.MDDT_LOG_SDS || window.MDDT_LOG_SDS_TIMING || window.uwLogSdsStacks);
        if (wantStacks) {
          console.warn('[UW RX] finalize:', info, err);
        } else {
          console.warn('[UW RX] finalize:', info, (err && (err.message || err)));
        }
      }

      // In closed-loop RX, close politely if complete; otherwise cancel to unblock sender.
      if (mode === 'closed') {
        if (err) {
          const pno = (cur.expectedPacket | 0) & 0x7F;
          try { midiSend([0xF0, 0x7E, 0x00, SDS_CANCEL, pno, 0xF7]); } catch (_) {}
        } else {
          try { midiSend([0xF0, 0x7E, 0x00, SDS_EOF, 0xF7]); } catch (_) {}
        }
      }

      if (mode === 'stream' && rx.captured) {
        rx.captured.add(uiIndex);
        if (rx.desiredSlots && rx.desiredSlots.size > 0) {
          let all = true;
          for (const d of rx.desiredSlots) { if (!rx.captured.has(d)) { all = false; break; } }
          if (all) {
            ui.setBulkStatus('Stream complete.');
            stopStream();
            return;
          }
        }
        // continue listening
        resetCurrent();
        scheduleIdleStop(2500);
        return;
      }

      resetAll();
    }

    function handleHeader(bytes, receivedTime) {
      const h = parseSdsHeaderMessage(bytes);
      if (!h) return;

      if (rx.collecting && rx.current) finalize(null, 'new-header');

      const uiIndex = (rx.destOverride && Number.isFinite(rx.destOverride.uiIndex))
        ? (rx.destOverride.uiIndex | 0)
        : uiIndexFromSdsSampleNumber(h.sampleNumber | 0);

      if (!shouldCapture(uiIndex)) {
        rx.lastPacketTime = Date.now();
        scheduleIdleStop(2500);
        return;
      }

      rx.collecting = true;
      rx.lastPacketTime = Date.now();
      // Turbo RX can be CPU/GC-bound; use a low-allocation fast-path by default.
      const turbo = !!window.turboActive;
      const canFast16 = turbo && ((h.sampleFormat | 0) === 16) && ((h.totalWords | 0) > 0);

      // Capturing raw packets is convenient for "parity resend", but it is very
      // allocation-heavy (tens of thousands of arrays for large samples) and can
      // destabilize RX at Turbo. Default to disabling raw packet capture in Turbo.
      const captureRawPackets = (window.captureUwRawPackets === true)
        ? true
        : ((window.captureUwRawPackets !== false) && !turbo);

      const t0 = Number.isFinite(receivedTime)
        ? receivedTime
        : (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();

      const cur = {
        sampleNumber: h.sampleNumber | 0,
        sampleFormat: h.sampleFormat | 0,
        totalWords: h.totalWords | 0,
        sampleRate: h.sampleRate | 0,
        loopStart: h.loopStart | 0,
        loopEnd: h.loopEnd | 0,
        loopType: h.loopType | 0,
        expectedPacket: 0,
        pending7: [],
        dataBuffer: [],
        pcm16: null,
        wordsSoFar: 0,
        rawPackets: captureRawPackets ? [bytes] : null,
        rxStats: {
          checksumErrors: 0,
          outOfOrderErrors: 0,
          truncatedPackets: 0,

          // Timing instrumentation (helps diagnose "Turbo has no effect" cases)
          startAtMs: t0,
          packetCount: 0,
          lastDataAtMs: null,
          deltaCount: 0,
          deltaTotalMs: 0,
          deltaMinMs: null,
          deltaMaxMs: 0,
          ackCount: 0,
          ackTotalMs: 0,
          ackMinMs: null,
          ackMaxMs: 0
        },
        nameHint: (window.mdOSVersion === '1.63' && state.rxNameMap163)
          ? (state.rxNameMap163.get(h.sampleNumber | 0) || '----')
          : (state.lastSampleName || '----')
      };

      if (canFast16) {
        try {
          cur.pcm16 = new Int16Array(cur.totalWords | 0);
          cur.dataBuffer = null;
          cur.pending7 = null;
        } catch (_) {
          cur.pcm16 = null;
        }
      }

      rx.current = cur;

      ui.markSlot(uiIndex, 'receiving');
      ui.updateProgress(uiIndex, 0);

      if (rx.mode === 'closed') {
        try { midiSend([0xF0, 0x7E, 0x00, SDS_ACK, 0x00, 0xF7]); } catch (_) {}
      }

      scheduleIdleFinalize(5000);
      if (rx.mode === 'stream') scheduleIdleStop(2500);
    }

    function handleData(bytes, receivedTime) {
      if (!rx.collecting || !rx.current) return;

      rx.lastPacketTime = Date.now();
      scheduleIdleFinalize(5000);
      if (rx.mode === 'stream') scheduleIdleStop(2500);

      const cur = rx.current;

      // Timing instrumentation (optional but cheap):
      // - delta: cadence of inbound SDS data packets
      // - ackLatency: how long after a packet arrives we call out.send(ACK)
      const msgAt = Number.isFinite(receivedTime)
        ? receivedTime
        : (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();

      const stats = cur.rxStats || null;
      if (stats) {
        const last = stats.lastDataAtMs;
        if (Number.isFinite(last)) {
          const d = msgAt - last;
          stats.deltaCount = (stats.deltaCount | 0) + 1;
          stats.deltaTotalMs = Number(stats.deltaTotalMs || 0) + d;
          stats.deltaMinMs = (stats.deltaMinMs == null) ? d : Math.min(stats.deltaMinMs, d);
          stats.deltaMaxMs = Math.max(Number(stats.deltaMaxMs || 0), d);
        }
        stats.lastDataAtMs = msgAt;
      }
      // Fast-path (Turbo): avoid per-packet body allocations.
      const useFast = !!cur.pcm16;
      const ver = useFast ? verifySdsDataMessageFast(bytes) : verifySdsDataMessage(bytes);
      if (!ver.ok) {
        if (ver.reason === 'TRUNC') cur.rxStats.truncatedPackets++;
        else cur.rxStats.checksumErrors++;
        if (rx.mode === 'closed') {
          try { midiSend([0xF0, 0x7E, 0x00, SDS_NAK, ver.packetNumber & 0x7F, 0xF7]); } catch (_) {}
        }
        return;
      }

      const pno = ver.packetNumber | 0;

      if (stats) stats.packetCount = (stats.packetCount | 0) + 1;
      if (rx.mode === 'closed') {
        const expected = cur.expectedPacket & 0x7F;
        if (pno !== expected) {
          cur.rxStats.outOfOrderErrors++;
          try { midiSend([0xF0, 0x7E, 0x00, SDS_NAK, expected & 0x7F, 0xF7]); } catch (_) {}
          return;
        }
      } else {
        if (pno !== (cur.expectedPacket & 0x7F)) cur.rxStats.outOfOrderErrors++;
      }

      // In closed-loop mode, ACK immediately after accepting the packet (Turbo-safe).
      if (rx.mode === 'closed') {
        const tAck = (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();
        const a = tAck - msgAt;
        if (stats) {
          stats.ackCount = (stats.ackCount | 0) + 1;
          stats.ackTotalMs = Number(stats.ackTotalMs || 0) + a;
          stats.ackMinMs = (stats.ackMinMs == null) ? a : Math.min(stats.ackMinMs, a);
          stats.ackMaxMs = Math.max(Number(stats.ackMaxMs || 0), a);
        }
        try { midiSend([0xF0, 0x7E, 0x00, SDS_ACK, pno & 0x7F, 0xF7]); } catch (_) {}
      }

      // Optional raw packet capture (may be disabled at Turbo for robustness)
      if (cur.rawPackets) cur.rawPackets.push(bytes);

      if (useFast) {
        // Decode 16-bit SDS body (120 bytes => 40 words) directly into Int16Array.
        // SDS uses offset-binary packed into 7-bit bytes; for 16-bit, the samples
        // are left-justified into 21 bits and must be shifted right by 5.
        let w = cur.wordsSoFar | 0;
        const total = cur.totalWords | 0;
        // Body region is fixed [5..124] inclusive (120 bytes)
        for (let i = 5; i < 125 && w < total; i += 3) {
          const b0 = bytes[i] & 0x7F;
          const b1 = bytes[i + 1] & 0x7F;
          const b2 = bytes[i + 2] & 0x7F;
          let accum = (b0 << 14) | (b1 << 7) | b2;
          accum = accum >> 5;
          let signed = accum - 32768;
          // Clamp for safety
          if (signed > 32767) signed = 32767;
          else if (signed < -32768) signed = -32768;
          cur.pcm16[w++] = signed;
        }
        cur.wordsSoFar = w;
      } else {
        const decState = {
          sampleFormat: cur.sampleFormat,
          pending7: cur.pending7,
          dataOutBytes: cur.dataBuffer,
          wordsSoFar: (cur.dataBuffer.length / 2) | 0,
          totalWords: cur.totalWords
        };
        decodeSdsBodyIntoPcmBytes(decState, ver.body);
        cur.pending7 = decState.pending7;
        cur.dataBuffer = decState.dataOutBytes;
        cur.wordsSoFar = (cur.dataBuffer.length / 2) | 0;
      }
      cur.expectedPacket = (pno + 1) & 0x7F;

      // Progress
      try {
        const uiIndex = (rx.destOverride && Number.isFinite(rx.destOverride.uiIndex))
          ? (rx.destOverride.uiIndex | 0)
          : uiIndexFromSdsSampleNumber(cur.sampleNumber | 0);
        const wordsSoFar = useFast ? (cur.wordsSoFar | 0) : ((cur.dataBuffer.length / 2) | 0);
        const frac = (cur.totalWords > 0) ? Math.min(wordsSoFar / cur.totalWords, 1) : 0;
        const now = Date.now();
        const minInterval = (window.turboActive ? 90 : 60);
        if (!cur.lastProgressAt || (now - cur.lastProgressAt) >= minInterval || frac >= 1) {
          ui.updateProgress(uiIndex, frac);
          cur.lastProgressAt = now;
        }
} catch (_) {}

      if ((cur.totalWords | 0) > 0) {
        const wordsSoFar = useFast ? (cur.wordsSoFar | 0) : ((cur.dataBuffer.length / 2) | 0);
        if (wordsSoFar >= (cur.totalWords | 0)) finalize(null, 'complete');
      }
    }

    function handleEof(bytes) {
      if (!rx.collecting || !rx.current) { if (rx.mode === 'stream') scheduleIdleStop(2500); return; }
      if (rx.current.rawPackets) rx.current.rawPackets.push(Array.from(bytes));
      finalize(null, 'eof');
    }

    function handleCancel(bytes) {
      if (!rx.collecting || !rx.current) return;
      if (rx.current.rawPackets) rx.current.rawPackets.push(Array.from(bytes));
      // Device aborted the transfer. Treat like a cancel: stop cleanly and
      // do not store a partial sample.
      cancel('SDS_CANCEL');
    }

    function handleSysex(bytes, receivedTime) {
      if (!bytes || bytes.length < 4) return;
      if (rx.abortSignal && rx.abortSignal.aborted) { cancel('RX_ABORTED'); return; }
      const cmd = bytes[3] & 0x7F;
      if (cmd === 0x01) handleHeader(bytes, receivedTime);
      else if (cmd === 0x02) handleData(bytes, receivedTime);
      else if (cmd === SDS_EOF) handleEof(bytes);
      else if (cmd === SDS_CANCEL) handleCancel(bytes);
    }

    return {
      startClosed,
      startOpen,
      startStream,
      stopStream,
      cancel,
      handleSysex,
      get mode() { return rx.mode; },
      get collecting() { return rx.collecting; }
    };
  }

  // --------------------------------------------------------------------------
  // TX Engine (single canonical SDS send pipeline)
  // --------------------------------------------------------------------------
  function createTxEngine() {
    const tx = {
      inProgress: false,
      abortSignal: null,
      waiter: null
    };

    function clearWaiter() {
      if (tx.waiter && tx.waiter.timer) {
        try { clearTimeout(tx.waiter.timer); } catch (_) {}
      }
      tx.waiter = null;
    }

    function waitForHandshake(expectedPacket, timeoutMs) {
      clearWaiter();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (tx.waiter) tx.waiter = null;
          resolve({ ok: false, type: 'NO_HANDSHAKE', packet: expectedPacket & 0x7F });
        }, Math.max(50, timeoutMs | 0));
        tx.waiter = { expectedPacket: expectedPacket & 0x7F, resolve, timer };
      });
    }

    function handleHandshake(cmd, packetNo) {
      if (!tx.waiter) return;
      const w = tx.waiter;
      const p = packetNo & 0x7F;
      if (Number.isFinite(w.expectedPacket) && w.expectedPacket !== p) {
        // tolerate ack(0) for name/header
        if (!(w.expectedPacket === 0 && p === 0)) return;
      }
      clearWaiter();
      switch (cmd) {
        case SDS_ACK: w.resolve({ ok: true, type: 'ACK', packet: p }); break;
        case SDS_WAIT: w.resolve({ ok: true, type: 'WAIT', packet: p }); break;
        case SDS_EOF: w.resolve({ ok: true, type: 'EOF', packet: p }); break;
        case SDS_NAK: w.resolve({ ok: false, type: 'NAK', packet: p }); break;
        case SDS_CANCEL: w.resolve({ ok: false, type: 'CANCEL', packet: p }); break;
        default: w.resolve({ ok: false, type: 'UNKNOWN', packet: p }); break;
      }
    }

    function buildNameSysex(sampleNumber, name4) {
      const n = normalizeName4(name4);
      return [
        0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x73,
        sampleNumber & 0x7F,
        n.charCodeAt(0) & 0x7F,
        n.charCodeAt(1) & 0x7F,
        n.charCodeAt(2) & 0x7F,
        n.charCodeAt(3) & 0x7F,
        0xF7
      ];
    }

    async function sendNameBestEffort(sampleNumber, name4) {
      // Machinedrum does not SDS-ACK this Elektron name message.
      // Waiting for an SDS handshake here just adds a fixed timeout per sample.
      // Instead, send the name and give the device a short settle window to
      // reduce the chance of interleaving with the subsequent SDS header/data.
      try { midiSend(buildNameSysex(sampleNumber, name4)); } catch (_) {}

      // Scaled by Turbo factor, but keep a small floor for stability.
      // Preserve the previous (conservative) settle time when Turbo is off.
      const settleMs = window.turboActive ? 40 : 120;
      await sleep(scaleMsForTurbo(settleMs, { min: 8, max: settleMs }));
      return true;
    }

    function getInterPacketDelayMs() {
      // SDS pacing: keep normal behaviour, but scale at Turbo so TM-1 can run
      // at its negotiated rate. Users can override via:
      //   window.uwSdsInterPacketDelayMs = <ms>
      try {
        const ms = uwGetSdsInterPacketDelayMs();
        if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
      } catch (_) {}
      const turbo = !!window.turboActive;
      return turbo ? 6 : 12;
    }

    function canUseParityRawPackets(slotObj) {
      if (!slotObj || (!slotObj.rawPCM && !slotObj.rawPCMBase64)) return false;
      if (!Array.isArray(slotObj.__sdsRawPackets) || slotObj.__sdsRawPackets.length < 2) return false;
      if (typeof slotObj.__pcmCrc32 === 'number') {
        try {
          const pcm = slotObj.rawPCM || base64ToArrayBuffer(slotObj.rawPCMBase64);
          const now = crc32(new Uint8Array(pcm));
          if ((now >>> 0) !== (slotObj.__pcmCrc32 >>> 0)) return false;
        } catch (_) { return false; }
      }
      // if user edited metadata only (rate/loop/name), raw packets still usable (we patch header)
      return true;
    }

    function buildEncodedForSend(slotObj) {
      const sampleFormat = 16;
      const origRate = slotObj.originalSampleRate || 44100;
      const targetRate = slotObj.targetSampleRate || origRate;
      let pcm = slotObj.rawPCM;
      if (!pcm && slotObj.rawPCMBase64) pcm = base64ToArrayBuffer(slotObj.rawPCMBase64);
      if (!pcm) throw new Error('No PCM data');

      if (targetRate !== origRate && typeof window.resamplePCMBuffer === 'function') {
        pcm = window.resamplePCMBuffer(pcm, origRate, targetRate);
      }

      const totalWords = new Int16Array(pcm).length | 0;
      const enc7 = encodePCMTo7Bit(pcm, sampleFormat);
      const totalPackets = Math.ceil(enc7.length / 120);
      const header = buildSdsHeaderPacket(sampleFormat, sampleNumberTo7(sampleFormat, targetRate), totalWords, slotObj);
      // Actually buildSdsHeaderPacket expects sampleNumber; we build below, so keep separate
      return { sampleFormat, origRate, targetRate, pcm, totalWords, enc7, totalPackets };
    }

    function buildSdsHeaderPacket(sampleNumber, slotObj, sampleFormat, totalWords, targetRate) {
      const samplePeriod = Math.round(MD_CLOCK / (targetRate || 44100));
      const hasLoop = (slotObj.loopStart != null && slotObj.loopEnd != null && slotObj.loopEnd > slotObj.loopStart);
      const loopStart = hasLoop ? (slotObj.loopStart | 0) : 0;
      const loopEnd = hasLoop ? (slotObj.loopEnd | 0) : 0;
      const loopType = hasLoop ? 0 : 0x7F;
      return [
        0xF0, 0x7E, 0x00, 0x01,
        sampleNumber & 0x7F, (sampleNumber >> 7) & 0x7F,
        sampleFormat & 0x7F,
        ...encodeValueTo7BitBytes(samplePeriod, 3),
        ...encodeValueTo7BitBytes(totalWords, 3),
        ...encodeValueTo7BitBytes(loopStart, 3),
        ...encodeValueTo7BitBytes(loopEnd, 3),
        loopType & 0x7F,
        0xF7
      ];
    }

    async function sendDataPacketsClosed(enc7, totalPackets, progressCb) {
      const chunkSize = 120;
      let packetNo = 0;
      let offset = 0;
      let sent = 0;

      while (offset < enc7.length) {
        if (tx.abortSignal && tx.abortSignal.aborted) throw new Error('TX_ABORTED');

        const end = Math.min(offset + chunkSize, enc7.length);
        const data = new Uint8Array(chunkSize);
        data.set(enc7.subarray(offset, end), 0);
        const cs = sdsChecksumXor(0x00, packetNo, data);

        const pkt = new Uint8Array(1 + 1 + 1 + 1 + 1 + 120 + 1 + 1);
        let p = 0;
        pkt[p++] = 0xF0;
        pkt[p++] = 0x7E;
        pkt[p++] = 0x00;
        pkt[p++] = 0x02;
        pkt[p++] = packetNo & 0x7F;
        pkt.set(data, p); p += 120;
        pkt[p++] = cs & 0x7F;
        pkt[p++] = 0xF7;

        let needSend = true;
        let retries = 6;
        while (true) {
          if (needSend) { midiSend(pkt); needSend = false; }
          const r = await waitForHandshake(packetNo & 0x7F, 900);
          if (r.ok && r.type === 'WAIT') { await sleep(scaleMsForTurbo(25, { min: 4, max: 25 })); continue; }
          if (r.ok && (r.type === 'ACK' || r.type === 'EOF')) break;
          if (!r.ok && r.type === 'NAK') {
            retries--;
            if (retries <= 0) throw new Error('Too many NAKs');
            needSend = true;
            continue;
          }
          if (!r.ok && r.type === 'NO_HANDSHAKE') {
            return { ok: false, type: 'NO_HANDSHAKE', sentPackets: sent };
          }
          if (!r.ok && r.type === 'CANCEL') throw new Error('SDS_CANCEL');
          return { ok: false, type: r.type || 'UNKNOWN', sentPackets: sent };
        }

        sent++;
        if (typeof progressCb === 'function' && totalPackets > 0) {
          try { progressCb(Math.min(sent / totalPackets, 1)); } catch (_) {}
        }

        packetNo = (packetNo + 1) & 0x7F;
        offset = end;
        // Closed-loop SDS is already paced by the receiver's ACK.
        // Avoid adding extra per-packet delay here (it reduces throughput at Turbo).
      }
      return { ok: true, sentPackets: sent };
    }

    async function sendDataPacketsOpen(enc7, startPacketNo, totalPackets, progressCb) {
      const chunkSize = 120;
      let packetNo = startPacketNo & 0x7F;
      let offset = (startPacketNo | 0) * chunkSize;
      let sent = startPacketNo | 0;

      while (offset < enc7.length) {
        if (tx.abortSignal && tx.abortSignal.aborted) throw new Error('TX_ABORTED');

        const end = Math.min(offset + chunkSize, enc7.length);
        const data = new Uint8Array(chunkSize);
        data.set(enc7.subarray(offset, end), 0);
        const cs = sdsChecksumXor(0x00, packetNo, data);

        const pkt = new Uint8Array(1 + 1 + 1 + 1 + 1 + 120 + 1 + 1);
        let p = 0;
        pkt[p++] = 0xF0;
        pkt[p++] = 0x7E;
        pkt[p++] = 0x00;
        pkt[p++] = 0x02;
        pkt[p++] = packetNo & 0x7F;
        pkt.set(data, p); p += 120;
        pkt[p++] = cs & 0x7F;
        pkt[p++] = 0xF7;

        midiSend(pkt);

        sent++;
        if (typeof progressCb === 'function' && totalPackets > 0) {
          try { progressCb(Math.min(sent / totalPackets, 1)); } catch (_) {}
        }

        packetNo = (packetNo + 1) & 0x7F;
        offset = end;
        const delay = getInterPacketDelayMs();
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      }
      return { ok: true };
    }

    async function sendRawPacketsOpen(pkts, progressCb) {
      const msgs = (pkts || []).filter(p => p && p.length > 3 && p[0] === 0xF0 && p[p.length - 1] === 0xF7);
      const total = Math.max(1, msgs.length);
      let sent = 0;
      for (const msg of msgs) {
        if (tx.abortSignal && tx.abortSignal.aborted) throw new Error('TX_ABORTED');
        midiSend(msg);
        sent++;
        if (typeof progressCb === 'function') {
          try { progressCb(Math.min(sent / total, 1)); } catch (_) {}
        }
        const delay = getInterPacketDelayMs();
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    }

    async function sendRawDataPacketsClosed(pkts, totalPackets, progressCb) {
      const dataPkts = (pkts || []).filter(p => p && p.length > 6 && ((p[3] & 0x7F) === 0x02));
      const total = Math.max(1, dataPkts.length);
      let sent = 0;
      for (const pkt of dataPkts) {
        if (tx.abortSignal && tx.abortSignal.aborted) throw new Error('TX_ABORTED');
        const pno = pkt[4] & 0x7F;
        let needSend = true;
        let retries = 6;
        while (true) {
          if (needSend) { midiSend(pkt); needSend = false; }
          const r = await waitForHandshake(pno, 900);
          if (r.ok && r.type === 'WAIT') { await sleep(scaleMsForTurbo(25, { min: 4, max: 25 })); continue; }
          if (r.ok && (r.type === 'ACK' || r.type === 'EOF')) break;
          if (!r.ok && r.type === 'NAK') {
            retries--;
            if (retries <= 0) throw new Error('Too many NAKs');
            needSend = true;
            continue;
          }
          if (!r.ok && r.type === 'NO_HANDSHAKE') return { ok: false, type: 'NO_HANDSHAKE', sentPackets: sent };
          if (!r.ok && r.type === 'CANCEL') throw new Error('SDS_CANCEL');
          throw new Error('Handshake error: ' + (r.type || 'UNKNOWN'));
        }

        sent++;
        if (typeof progressCb === 'function') {
          try { progressCb(Math.min(sent / total, 1)); } catch (_) {}
        }
        // Closed-loop SDS is already paced by the receiver's ACK.
        // Avoid adding extra per-packet delay here (it reduces throughput at Turbo).
      }
      return { ok: true, sentPackets: sent };
    }

    
    function makeThrottledProgressCb(uiIndex) {
      const minInterval = window.turboActive ? 60 : 30;
      let lastAt = 0;
      let lastFrac = -1;
      return (frac) => {
        const f = Math.max(0, Math.min(1, Number(frac) || 0));
        const now = Date.now();
        if (f <= 0 || f >= 1 || !lastAt || (now - lastAt) >= minInterval) {
          try { ui.updateProgress(uiIndex, f); } catch (_) {}
          lastAt = now;
          lastFrac = f;
          return;
        }
        // Also refresh on larger jumps to avoid a "stuck" progress bar at high packet rates.
        if (Math.abs(f - lastFrac) >= 0.08) {
          try { ui.updateProgress(uiIndex, f); } catch (_) {}
          lastAt = now;
          lastFrac = f;
        }
      };
    }

async function sendSample(uiIndex, opts) {
      opts = opts || {};
      const mode = opts.mode || 'auto';
      const idx = uiIndex | 0;
      const uw = state.samples || ensureSamplesModel();

      if (idx < 0) throw new Error('Invalid slot index');
      if (idx >= (uw.maxSlots | 0)) throw new Error('RAM buffers are receive-only and cannot be sent.');

      const slotObj = getSlotByUiIndex(idx);
      if (!slotObj || (!slotObj.rawPCM && !slotObj.rawPCMBase64)) {
        // Not an error: empty slot (nothing to send).
        return false;
      }

      tx.inProgress = true;
      tx.abortSignal = opts.abortSignal || null;

      ui.markSlot(idx, 'sending');
      const progress = makeThrottledProgressCb(idx);
      progress(0);

      try {
        const sampleNumber = idx;
        await sendNameBestEffort(sampleNumber, slotObj.name);

        const forceOpen = (mode === 'open') || (!!document.getElementById('openLoopSendGlobal')?.checked);
        const wantClosed = (mode === 'closed') || (mode === 'auto' && !forceOpen);

        const parityOk = canUseParityRawPackets(slotObj);
        if (parityOk) {
          const rawPkts = slotObj.__sdsRawPackets.map(p => Array.isArray(p) ? p.slice() : Array.from(p));
          // Patch header sample number + loop/length/rate
          rawPkts[0] = patchSdsHeaderPacket(rawPkts[0], sampleNumber, slotObj);

          if (wantClosed) {
            midiSend(rawPkts[0]);
            const r0 = await waitForHandshake(0, 900);
            if (!r0.ok && r0.type === 'NO_HANDSHAKE') {
              await sendRawPacketsOpen(rawPkts, progress);
              progress(1);
              return true;
            }
            if (!r0.ok && r0.type === 'CANCEL') throw new Error('SDS_CANCEL');

            const r = await sendRawDataPacketsClosed(rawPkts, 0, progress);
            if (!r.ok && r.type === 'NO_HANDSHAKE') {
              await sendRawPacketsOpen(rawPkts, progress);
            }
            progress(1);
            return true;
          }

          await sendRawPacketsOpen(rawPkts, progress);
          progress(1);
          return true;
        }

        // Build from PCM
        const sampleFormat = 16;
        const origRate = slotObj.originalSampleRate || 44100;
        const targetRate = slotObj.targetSampleRate || origRate;
        let pcm = slotObj.rawPCM;
        if (!pcm && slotObj.rawPCMBase64) pcm = base64ToArrayBuffer(slotObj.rawPCMBase64);
        if (!pcm) throw new Error('No PCM');
        if (targetRate !== origRate && typeof window.resamplePCMBuffer === 'function') {
          pcm = window.resamplePCMBuffer(pcm, origRate, targetRate);
        }
        const totalWords = new Int16Array(pcm).length | 0;
        const enc7 = encodePCMTo7Bit(pcm, sampleFormat);
        const totalPackets = Math.ceil(enc7.length / 120);

        const header = buildSdsHeaderPacket(sampleNumber, slotObj, sampleFormat, totalWords, targetRate);

        if (wantClosed) {
          midiSend(header);
          const r0 = await waitForHandshake(0, 900);
          if (!r0.ok && r0.type === 'NO_HANDSHAKE') {
            await sendDataPacketsOpen(enc7, 0, totalPackets, progress);
            progress(1);
            return true;
          }
          if (!r0.ok && r0.type === 'CANCEL') throw new Error('SDS_CANCEL');

          const r = await sendDataPacketsClosed(enc7, totalPackets, progress);
          if (!r.ok && r.type === 'NO_HANDSHAKE') {
            const startPkt = r.sentPackets | 0;
            await sendDataPacketsOpen(enc7, startPkt, totalPackets, progress);
          }
          progress(1);
          return true;
        }

        // Open-loop
        midiSend(header);
        await sendDataPacketsOpen(enc7, 0, totalPackets, progress);
        progress(1);
        return true;
      } finally {
        tx.inProgress = false;
        tx.abortSignal = null;
        clearWaiter();
        ui.markSlot(idx, null);
        // Clear the bottom progress bar after completion (leave a tiny beat so it reads as “done”).
        try {
          setTimeout(() => { try { ui.updateProgress(idx, 0); } catch (_) {} }, 250);
        } catch (_) {
          try { ui.updateProgress(idx, 0); } catch (_) {}
        }
        ui.renderGridTile(idx);
      }
    }

    return {
      sendSample,
      handleHandshake
    };
  }

  // Instantiate engines
  state.rx = createRxEngine();
  state.tx = createTxEngine();

  // --------------------------------------------------------------------------
  // Machinedrum SysEx: slot list + sample name
  // --------------------------------------------------------------------------
  async function requestSlotList() {
    return withTransferFocus(async () => {
      const out = midiOut();
      if (!out) throw new Error('No MIDI OUT selected');

      window.slotListReceived = false;
      // Request: F0 00 20 3C 02 00 70 34 F7
      midiSend([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x70, 0x34, 0xF7]);

      const t0 = Date.now();
      const timeoutMs = 1200;
      while (!window.slotListReceived) {
        await new Promise(r => setTimeout(r, 25));
        if (Date.now() - t0 > timeoutMs) break;
      }
      ui.updateConnectionLabel();
      if (state.ui.needsPostTransferRender) {
        state.ui.needsPostTransferRender = false;
        ui.render();
        try { ui.updateMemoryLabel(); } catch (_) {}
      }
    }, { wakeLock: false, activeSense: false });
  }
  window.requestSlotList = requestSlotList;

  function parseMdSlotList(bytes) {
    if (!bytes || bytes.length < 9) return;
    const uw = state.samples || ensureSamplesModel();

    const n = Math.max(0, (bytes[8] | 0));
    let idx = 9;
    const limit = Math.min(n, uw.maxSlots | 0);

    for (let i = 0; i < limit; i++) {
      if ((idx + 5) > bytes.length) break;
      const nameBytes = bytes.slice(idx, idx + 4);
      idx += 4;
      const usedF = (bytes[idx++] & 0x7F);
      const isUsed = !!usedF;
      const remoteName4 = normalizeName4(String.fromCharCode.apply(null, nameBytes));

      const existing = uw.slots[i] || null;
      if (isUsed) {
        if (existing) {
          existing.__mdUsed = true;
          existing.__mdName = remoteName4;
          const hasLocal = !!existing.rawPCM || !!existing.rawPCMBase64 || ((existing.numSamples | 0) > 0);
          if (!hasLocal && !existing.__edited) existing.name = remoteName4;
        } else {
          uw.slots[i] = {
            name: remoteName4,
            rawPCM: null,
            rawPCMBase64: null,
            numSamples: 0,
            originalSampleRate: 44100,
            targetSampleRate: 44100,
            sizeBytes: 0,
            loopStart: null,
            loopEnd: null,
            repitch: 0,
            __mdUsed: true,
            __mdName: remoteName4,
            __edited: false,
            __pcmCrc32: null,
            __sdsRawPackets: null,
            __rxStats: null,
            __hasCorruption: false
          };
        }
      } else {
        if (existing) {
          const keep = !!existing.__edited || !!existing.rawPCM || !!existing.rawPCMBase64 || ((existing.numSamples | 0) > 0);
          if (keep) {
            existing.__mdUsed = false;
            existing.__mdName = null;
            existing.__mdEmpty = true;
          } else {
            uw.slots[i] = null;
          }
        } else {
          uw.slots[i] = null;
        }
      }
    }

    window.slotListReceived = true;
    window.mdSlotListSupported = true;
    window.mdSlotListLastSeen = Date.now();

    try { document.dispatchEvent(new CustomEvent('uwSlotListReceived', { detail: { count: limit, total: n } })); } catch (_) {}

    ui.renderGrid();
    ui.renderEditor();
    ui.updateMemoryLabel();
    ui.updateConnectionLabel();
  }

  function parseMdSampleName(bytes) {
    // Elektron side-channel name packet (cmd 0x73):
    //   F0 00 20 3C 02 00 73 <sampleNumber> <4 chars> F7
    if (!bytes || bytes.length < 13) return;

    const sn = bytes[7] & 0x7F;
    const nm = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).replace(/\0/g, '').trim();
    const name4 = normalizeName4(nm || '----');

    // Keep legacy "last seen" name for compatibility/UI.
    state.lastSampleName = name4;

    // OS 1.63 RX only: bind name to sampleNumber for robust slot naming during stream/open/closed RX.
    if (window.mdOSVersion === '1.63' && state.rxNameMap163) {
      state.rxNameMap163.set(sn, name4);
    }
  }

  // --------------------------------------------------------------------------
  // Import/export: JSON, SYX, WAV/ZIP, Audio
  // --------------------------------------------------------------------------
  function exportBankJson(opts) {
    opts = opts || {};
    const uw = state.samples || ensureSamplesModel();
    const payload = {
      __type: 'mddt-uw-bank',
      __version: 2,
      build: BUILD,
      model: uw.model,
      maxSlots: uw.maxSlots,
      ramCount: uw.ram ? uw.ram.length : 0,
      slots: (uw.slots || []).map(s => {
        if (!s) return null;
        return {
          name: s.name,
          rawPCMBase64: s.rawPCMBase64 || (s.rawPCM ? arrayBufferToBase64(s.rawPCM) : null),
          numSamples: s.numSamples | 0,
          originalSampleRate: s.originalSampleRate | 0,
          targetSampleRate: s.targetSampleRate | 0,
          sizeBytes: s.sizeBytes | 0,
          loopStart: (s.loopStart == null) ? null : (s.loopStart | 0),
          loopEnd: (s.loopEnd == null) ? null : (s.loopEnd | 0),
          repitch: s.repitch | 0,
          __edited: !!s.__edited,
          __sdsRawPackets: Array.isArray(s.__sdsRawPackets) ? s.__sdsRawPackets : null,
          __rxStats: s.__rxStats || null,
          __hasCorruption: !!s.__hasCorruption
        };
      }),
      ram: (uw.ram || []).map(s => {
        if (!s) return null;
        return {
          name: s.name,
          rawPCMBase64: s.rawPCMBase64 || (s.rawPCM ? arrayBufferToBase64(s.rawPCM) : null),
          numSamples: s.numSamples | 0,
          originalSampleRate: s.originalSampleRate | 0,
          targetSampleRate: s.targetSampleRate | 0,
          sizeBytes: s.sizeBytes | 0,
          loopStart: (s.loopStart == null) ? null : (s.loopStart | 0),
          loopEnd: (s.loopEnd == null) ? null : (s.loopEnd | 0),
          repitch: s.repitch | 0,
          __edited: !!s.__edited,
          __sdsRawPackets: Array.isArray(s.__sdsRawPackets) ? s.__sdsRawPackets : null,
          __rxStats: s.__rxStats || null,
          __hasCorruption: !!s.__hasCorruption
        };
      })
    };

    const json = JSON.stringify(payload, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json' }), opts.filename || 'md_uw_bank.json');
  }
  window.exportAllSlots = exportBankJson;

  async function importBankJsonFromFile(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.slots)) throw new Error('Invalid JSON bank');

    const uw = state.samples || ensureSamplesModel();
    const maxSlots = uw.maxSlots | 0;
    const ramCount = (uw.ram && uw.ram.length) ? (uw.ram.length | 0) : 0;

    for (let i = 0; i < maxSlots; i++) {
      const s = parsed.slots[i] || null;
      if (!s) { uw.slots[i] = null; continue; }
      const obj = {
        name: normalizeName4(s.name || '----'),
        rawPCMBase64: s.rawPCMBase64 || null,
        rawPCM: s.rawPCMBase64 ? base64ToArrayBuffer(s.rawPCMBase64) : null,
        numSamples: s.numSamples | 0,
        originalSampleRate: (s.originalSampleRate | 0) || 44100,
        targetSampleRate: (s.targetSampleRate | 0) || (s.originalSampleRate | 0) || 44100,
        sizeBytes: (s.sizeBytes | 0) || ((s.numSamples | 0) * 2),
        loopStart: (s.loopStart == null) ? null : (s.loopStart | 0),
        loopEnd: (s.loopEnd == null) ? null : (s.loopEnd | 0),
        repitch: s.repitch | 0,
        __edited: true,
        __sdsRawPackets: Array.isArray(s.__sdsRawPackets) ? s.__sdsRawPackets : null,
        __rxStats: s.__rxStats || null,
        __hasCorruption: !!s.__hasCorruption,
        __pcmCrc32: null
      };
      try { if (obj.rawPCM) obj.__pcmCrc32 = crc32(new Uint8Array(obj.rawPCM)); } catch (_) {}
      uw.slots[i] = obj;
    }

    const ramArr = Array.isArray(parsed.ram) ? parsed.ram : [];
    for (let i = 0; i < ramCount; i++) {
      const s = ramArr[i] || null;
      if (!s) { uw.ram[i] = null; continue; }
      const obj = {
        name: normalizeName4(s.name || `R${i + 1}`),
        rawPCMBase64: s.rawPCMBase64 || null,
        rawPCM: s.rawPCMBase64 ? base64ToArrayBuffer(s.rawPCMBase64) : null,
        numSamples: s.numSamples | 0,
        originalSampleRate: (s.originalSampleRate | 0) || 44100,
        targetSampleRate: (s.targetSampleRate | 0) || (s.originalSampleRate | 0) || 44100,
        sizeBytes: (s.sizeBytes | 0) || ((s.numSamples | 0) * 2),
        loopStart: (s.loopStart == null) ? null : (s.loopStart | 0),
        loopEnd: (s.loopEnd == null) ? null : (s.loopEnd | 0),
        repitch: s.repitch | 0,
        __edited: true,
        __sdsRawPackets: Array.isArray(s.__sdsRawPackets) ? s.__sdsRawPackets : null,
        __rxStats: s.__rxStats || null,
        __hasCorruption: !!s.__hasCorruption,
        __pcmCrc32: null
      };
      try { if (obj.rawPCM) obj.__pcmCrc32 = crc32(new Uint8Array(obj.rawPCM)); } catch (_) {}
      uw.ram[i] = obj;
    }

    ui.render();
  }

  function buildSdsDumpPacketsFromSlot(sampleNumber, slotObj) {
    if (!slotObj) return [];
    const sampleFormat = 16;
    const origRate = slotObj.originalSampleRate || 44100;
    const targetRate = slotObj.targetSampleRate || origRate;

    let pcm = slotObj.rawPCM;
    if (!pcm && slotObj.rawPCMBase64) pcm = base64ToArrayBuffer(slotObj.rawPCMBase64);
    if (!pcm) return [];

    if (targetRate !== origRate && typeof window.resamplePCMBuffer === 'function') {
      try { pcm = window.resamplePCMBuffer(pcm, origRate, targetRate); } catch (_) {}
    }

    const totalWords = new Int16Array(pcm).length | 0;
    const header = buildSdsHeaderPacket(sampleNumber, slotObj, sampleFormat, totalWords, targetRate);

    const enc7 = encodePCMTo7Bit(pcm, sampleFormat);
    const packets = [header];
    const chunkSize = 120;
    let offset = 0;
    let packetNo = 0;
    while (offset < enc7.length) {
      const end = Math.min(offset + chunkSize, enc7.length);
      const data = new Uint8Array(chunkSize);
      data.set(enc7.subarray(offset, end), 0);
      const cs = sdsChecksumXor(0x00, packetNo, data);

      const pkt = new Uint8Array(1 + 1 + 1 + 1 + 1 + 120 + 1 + 1);
      let p = 0;
      pkt[p++] = 0xF0;
      pkt[p++] = 0x7E;
      pkt[p++] = 0x00;
      pkt[p++] = 0x02;
      pkt[p++] = packetNo & 0x7F;
      pkt.set(data, p); p += 120;
      pkt[p++] = cs & 0x7F;
      pkt[p++] = 0xF7;

      packets.push(Array.from(pkt));
      offset = end;
      packetNo = (packetNo + 1) & 0x7F;
    }
    return packets;
  }

  function exportBankSyx(opts) {
    opts = opts || {};
    const uw = state.samples || ensureSamplesModel();
    const out = [];

    for (let i = 0; i < (uw.maxSlots | 0); i++) {
      const s = uw.slots[i];
      if (!s || (!s.rawPCM && !s.rawPCMBase64)) continue;

      // Name message
      const n = normalizeName4(s.name || '----');
      out.push(
        0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x73,
        i & 0x7F,
        n.charCodeAt(0) & 0x7F,
        n.charCodeAt(1) & 0x7F,
        n.charCodeAt(2) & 0x7F,
        n.charCodeAt(3) & 0x7F,
        0xF7
      );

      // Prefer raw capture if PCM unchanged
      let usedRaw = false;
      if (Array.isArray(s.__sdsRawPackets) && s.__sdsRawPackets.length > 1) {
        let ok = true;
        try {
          const pcm = s.rawPCM || base64ToArrayBuffer(s.rawPCMBase64);
          if (typeof s.__pcmCrc32 === 'number') {
            const now = crc32(new Uint8Array(pcm));
            if ((now >>> 0) !== (s.__pcmCrc32 >>> 0)) ok = false;
          }
        } catch (_) { ok = false; }

        if (ok) {
          const pkts = s.__sdsRawPackets.map(p => Array.isArray(p) ? p.slice() : Array.from(p));
          if (pkts[0] && (pkts[0][3] & 0x7F) === 0x01) pkts[0] = patchSdsHeaderPacket(pkts[0], i, s);
          pkts.forEach(pkt => out.push(...pkt));
          usedRaw = true;
        }
      }

      if (!usedRaw) {
        const pkts = buildSdsDumpPacketsFromSlot(i, s);
        pkts.forEach(pkt => out.push(...pkt));
      }
    }

    downloadBlob(new Blob([new Uint8Array(out)], { type: 'application/octet-stream' }), opts.filename || 'md_uw_bank.syx');
  }
  window.exportBankSyx = exportBankSyx;

  function exportSelectionWavZip() {
    const indices = ui.getEffectiveSelection();
    if (!indices.length) { alert('No active slot (or selection) to export.'); return; }

    const files = [];
    const skipped = [];

    for (const idx of indices) {
      const s = getSlotByUiIndex(idx);
      if (!s || !s.rawPCM) { skipped.push(idx); continue; }
      const rate = s.targetSampleRate || s.originalSampleRate || 44100;
      const wavBuf = convertPCMToWav(s.rawPCM, rate);
      const wavBytes = new Uint8Array(wavBuf);
      const label = safeFilenamePart(slotLabel(idx), 'SLOT');
      const nm = safeFilenamePart(s.name, '----');
      files.push({ name: `MD_UW_${label}_${nm}.wav`, data: wavBytes });
    }

    if (!files.length) { alert('No audio data found in the selected/active slot(s).'); return; }

    if (files.length === 1) {
      downloadBlob(new Blob([files[0].data], { type: 'audio/wav' }), files[0].name);
      if (skipped.length) alert(`${skipped.length} slot(s) had no audio and were skipped.`);
      return;
    }

    // Minimal ZIP (store only)
    const te = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    const encodeName = (name) => te ? te.encode(name) : new Uint8Array(Array.from(name).map(c => c.charCodeAt(0) & 0xFF));

    function localHeader(nameBytes, crc, size) {
      const buf = new ArrayBuffer(30 + nameBytes.length);
      const dv = new DataView(buf);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      new Uint8Array(buf, 30, nameBytes.length).set(nameBytes);
      return new Uint8Array(buf);
    }
    function centralHeader(nameBytes, crc, size, offset) {
      const buf = new ArrayBuffer(46 + nameBytes.length);
      const dv = new DataView(buf);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint16(14, 0, true);
      dv.setUint32(16, crc, true);
      dv.setUint32(20, size, true);
      dv.setUint32(24, size, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, offset, true);
      new Uint8Array(buf, 46, nameBytes.length).set(nameBytes);
      return new Uint8Array(buf);
    }
    function endCentral(num, size, offset) {
      const buf = new ArrayBuffer(22);
      const dv = new DataView(buf);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, num, true);
      dv.setUint16(10, num, true);
      dv.setUint32(12, size, true);
      dv.setUint32(16, offset, true);
      dv.setUint16(20, 0, true);
      return new Uint8Array(buf);
    }

    let offset = 0;
    const locals = [];
    const centrals = [];

    for (const f of files) {
      const nameBytes = encodeName(f.name);
      const c = crc32(f.data);
      const size = f.data.length >>> 0;
      const lh = localHeader(nameBytes, c, size);
      locals.push(lh);
      locals.push(f.data);
      const ch = centralHeader(nameBytes, c, size, offset);
      centrals.push(ch);
      offset += lh.length + size;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const c of centrals) centralSize += c.length;
    const eocd = endCentral(files.length, centralSize, centralOffset);

    const zipBlob = new Blob([...locals, ...centrals, eocd], { type: 'application/zip' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(zipBlob, `MD_UW_EXPORT_${stamp}.zip`);

    if (skipped.length) alert(`${skipped.length} slot(s) had no audio and were skipped.`);
  }
  window.uwExportSelection = exportSelectionWavZip;

  async function importAudioFileToSlot(file, uiIndex) {
    const idx = uiIndex | 0;
    const uw = state.samples || ensureSamplesModel();
    if (idx >= (uw.maxSlots | 0)) throw new Error('Cannot import audio into RAM buffer slot.');

    const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxCtor) throw new Error('AudioContext not available');

    actions.previewCtx = actions.previewCtx || new AudioCtxCtor();
    const ctx = actions.previewCtx;

    const arrBuf = await file.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrBuf);
    const originalRate = Math.abs(audioBuf.sampleRate - 44100) < 10 ? 44100 : audioBuf.sampleRate;

    const ch0 = audioBuf.getChannelData(0);
    const len = audioBuf.length | 0;
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) out[i] = Math.max(-32768, Math.min(32767, Math.floor(ch0[i] * 32767)));
    const rawPCM = out.buffer;

    let base = String(file.name || '').replace(/\.[^.]+$/, '');
    if (base.length > 4) base = base.slice(0, 2) + base.slice(-2);
    const name = normalizeName4(base);

    const slotObj = {
      name,
      rawPCM,
      rawPCMBase64: arrayBufferToBase64(rawPCM),
      numSamples: len,
      originalSampleRate: originalRate,
      targetSampleRate: originalRate,
      sizeBytes: len * 2,
      loopStart: null,
      loopEnd: null,
      repitch: 0,
      __edited: true,
      __pcmCrc32: null,
      __sdsRawPackets: null,
      __rxStats: null,
      __hasCorruption: false
    };
    try { slotObj.__pcmCrc32 = crc32(new Uint8Array(rawPCM)); } catch (_) {}

    setSlotByUiIndex(idx, slotObj);
  }

  function parseSyxMessages(u8) {
    const messages = [];
    let cur = null;
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i];
      if (b === 0xF0) cur = [0xF0];
      else if (!cur) continue;
      else cur.push(b);

      if (cur && b === 0xF7) {
        messages.push(cur);
        cur = null;
      }
    }
    return messages;
  }

  function importSyxMessagesToBank(messages) {
    const uw = state.samples || ensureSamplesModel();
    const nameMap = new Map(); // sampleNumber -> name4

    let cur = null;

    function finalizeCurrent() {
      if (!cur) return;
      const uiIndex = (cur.sampleNumber | 0) < (uw.maxSlots | 0) ? (cur.sampleNumber | 0) : (uw.maxSlots | 0) - 1;

      const totalWords = cur.totalWords | 0;
      cur.dataBuffer = trimPcmBytesToWords(cur.dataBuffer, totalWords);
      const pcmBytes = new Uint8Array(cur.dataBuffer || []);
      let rawPCM = pcmBytes.buffer;
      if (rawPCM.byteLength > totalWords * 2) rawPCM = rawPCM.slice(0, totalWords * 2);

      const slotObj = {
        name: normalizeName4(cur.nameHint || '----'),
        rawPCM,
        rawPCMBase64: arrayBufferToBase64(rawPCM),
        numSamples: totalWords,
        originalSampleRate: cur.sampleRate || 44100,
        targetSampleRate: cur.sampleRate || 44100,
        sizeBytes: totalWords * 2,
        loopStart: null,
        loopEnd: null,
        repitch: 0,
        __edited: true,
        __sdsRawPackets: cur.rawPackets.map(p => Array.isArray(p) ? p.slice() : Array.from(p)),
        __rxStats: cur.rxStats,
        __hasCorruption: ((cur.rxStats.checksumErrors | 0) + (cur.rxStats.outOfOrderErrors | 0) + (cur.rxStats.truncatedPackets | 0) > 0),
        __pcmCrc32: null
      };

      const hasLoop = (cur.loopType !== 0x7F) && (cur.loopEnd | 0) > (cur.loopStart | 0);
      if (hasLoop) {
        const maxS = slotObj.numSamples | 0;
        let ls = clampInt(cur.loopStart | 0, 0, Math.max(0, maxS - 1));
        let le = clampInt(cur.loopEnd | 0, 0, maxS);
        if (le > ls) { slotObj.loopStart = ls; slotObj.loopEnd = le; }
      }

      try { slotObj.__pcmCrc32 = crc32(new Uint8Array(rawPCM)); } catch (_) {}

      setSlotByUiIndex(uiIndex, slotObj);
      cur = null;
    }

    for (const msg of messages) {
      // Name message
      if (msg.length > 12 && msg[0] === 0xF0 && msg[1] === 0x00 && msg[2] === 0x20 && msg[3] === 0x3C && msg[4] === 0x02 && (msg[6] & 0x7F) === 0x73) {
        const sn = msg[7] & 0x7F;
        const nm = String.fromCharCode(msg[8], msg[9], msg[10], msg[11]).replace(/\0/g, '').trim();
        nameMap.set(sn, normalizeName4(nm || '----'));
        continue;
      }

      // SDS header/data
      if (msg.length >= 6 && msg[0] === 0xF0 && (msg[1] & 0x7F) === 0x7E) {
        const cmd = msg[3] & 0x7F;
        if (cmd === 0x01) {
          // new header
          finalizeCurrent();
          const h = parseSdsHeaderMessage(msg);
          if (!h) continue;
          cur = {
            sampleNumber: h.sampleNumber | 0,
            sampleFormat: h.sampleFormat | 0,
            totalWords: h.totalWords | 0,
            sampleRate: h.sampleRate | 0,
            loopStart: h.loopStart | 0,
            loopEnd: h.loopEnd | 0,
            loopType: h.loopType | 0,
            expectedPacket: 0,
            pending7: [],
            dataBuffer: [],
            rawPackets: [msg.slice()],
            rxStats: { checksumErrors: 0, outOfOrderErrors: 0, truncatedPackets: 0 },
            nameHint: nameMap.get(h.sampleNumber | 0) || '----'
          };
          continue;
        }
        if (cmd === 0x02 && cur) {
          const ver = verifySdsDataMessage(msg);
          if (!ver.ok) {
            if (ver.reason === 'TRUNC') cur.rxStats.truncatedPackets++;
            else cur.rxStats.checksumErrors++;
            continue;
          }
          const pno = ver.packetNumber | 0;
          if (pno !== (cur.expectedPacket & 0x7F)) cur.rxStats.outOfOrderErrors++;
          cur.rawPackets.push(msg.slice());

          const decState = {
            sampleFormat: cur.sampleFormat,
            pending7: cur.pending7,
            dataOutBytes: cur.dataBuffer,
            wordsSoFar: (cur.dataBuffer.length / 2) | 0,
            totalWords: cur.totalWords
          };
          decodeSdsBodyIntoPcmBytes(decState, ver.body);
          cur.pending7 = decState.pending7;
          cur.dataBuffer = decState.dataOutBytes;
          cur.expectedPacket = (pno + 1) & 0x7F;

          const wordsSoFar = (cur.dataBuffer.length / 2) | 0;
          if (wordsSoFar >= (cur.totalWords | 0)) finalizeCurrent();
          continue;
        }
        if (cmd === SDS_EOF && cur) {
          cur.rawPackets.push(msg.slice());
          finalizeCurrent();
          continue;
        }
      }
    }

    finalizeCurrent();
    ui.render();
  }

  async function importSyxFile(file) {
    const arrBuf = await file.arrayBuffer();
    const bytes = new Uint8Array(arrBuf);
    const messages = parseSyxMessages(bytes);
    if (!messages.length) throw new Error('No SysEx messages found');
    importSyxMessagesToBank(messages);
  }


  // --------------------------------------------------------------------------
  // Actions (UI -> engines)
  // --------------------------------------------------------------------------

  async function rxStartClosedRobust(uiIndex, abortSignal, { headerTimeoutMs = 2500, retries = 1 } = {}) {
    const idx = uiIndex | 0;
    let attempt = 0;
    while (attempt <= retries) {
      try {
        await state.rx.startClosed(idx, { abortSignal, headerTimeoutMs });
        return true;
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        if (msg === 'NO_SAMPLE_HEADER' && attempt < retries && !(abortSignal && abortSignal.aborted)) {
          console.warn('[UW RX] NO_SAMPLE_HEADER for slot', idx, '- retrying…');
          // Give the device a moment to settle, then retry.
          await sleep(Math.max(200, uwGetInterSlotDelayMs()));
          attempt++;
          continue;
        }
        throw e;
      }
    }
    return false;
  }

  const actions = {
    ensureNotBusy() {
      if (state.bulk.inProgress) throw new Error('A bulk transfer is already running.');
    },

    getSelectionOrActive() {
      return ui.getEffectiveSelection();
    },

    // Toolbar helpers (these functions exist elsewhere in this module; actions exposes them for the new UI)
    requestSlotListSafe() {
      try { return requestSlotList(); } catch (e) { alert('Slot list error: ' + e); }
    },

    exportSelectionWavZip() {
      try { return exportSelectionWavZip(); } catch (e) { alert('Export WAV/ZIP error: ' + e); }
    },

    exportBankSyx(opts) {
      try { return exportBankSyx(opts); } catch (e) { alert('Export SYX error: ' + e); }
    },

    exportBankJson(opts) {
      try { return exportBankJson(opts); } catch (e) { alert('Export JSON error: ' + e); }
    },

    async importBankJsonFromFile(file) {
      return importBankJsonFromFile(file);
    },

    _beginBulk(label) {
      state.bulk.seq = (state.bulk.seq | 0) + 1;
      state.bulk.token = state.bulk.seq;

      const ac = new AbortController();
      // Attach token so async loops can end idempotently.
      ac.__uwBulkToken = state.bulk.token;

      state.bulk.abort = ac;
      state.bulk.inProgress = true;
      window.bulkOperationInProgress = true;
      ui.showCancel(true);
      ui.setBulkStatus(label || 'Working…');
      return ac;
    },

    _endBulk(token) {
      // Idempotent bulk end: ignore stale completions (e.g. async loops that
      // finish after the user cancelled and started something else).
      if (!state.bulk.inProgress) return;
      if (Number.isFinite(token) && token !== state.bulk.token) return;

      state.bulk.inProgress = false;
      window.bulkOperationInProgress = false;
      state.bulk.abort = null;
      state.bulk.token = 0;
      ui.showCancel(false);
      ui.setBulkStatus('');
      ui.updateConnectionLabel();
      if (state.ui.needsPostTransferRender) {
        // If we are still in transfer focus (UI paused), defer the heavy render
        // until pause is lifted. Clearing the flag while paused would drop the
        // redraw entirely and can leave stale/empty waveforms on screen.
        if (!state.ui.paused) {
          state.ui.needsPostTransferRender = false;
          ui.render();
        }
      }
    },

    cancelBulk() {
      if (!state.bulk.inProgress) return;
      const token = state.bulk.token;
      const seq = state.bulk.seq;
      try { state.bulk.abort && state.bulk.abort.abort(); } catch (_) {}
      try { state.rx.cancel && state.rx.cancel('User cancelled'); } catch (_) {}
      this._endBulk(token);
      ui.setBulkStatus('Cancelled.');
      // Clear the status only if no newer bulk op started afterwards.
      setTimeout(() => {
        if (!state.bulk.inProgress && (state.bulk.seq === seq)) ui.setBulkStatus('');
      }, 800);
    },

    async receiveSingle(uiIndex) {
      this.ensureNotBusy();
      const idx = uiIndex | 0;
      const openLoop = !!document.getElementById('openLoopRecvGlobal')?.checked;

      const ac = this._beginBulk('Receiving…');
      const token = ac.__uwBulkToken;

      try {
        await withTransferFocus(async () => {
          try {
            if (openLoop || isRamIndex(idx) || window.mdOSVersion === '1.63') {
              await state.rx.startOpen(idx, { abortSignal: ac.signal });
            } else {
              try {
                await rxStartClosedRobust(idx, ac.signal, { headerTimeoutMs: (window.turboActive ? 3500 : 2500) });
              } catch (e) {
                const msg = (e && e.message) ? e.message : String(e);
                if (msg === 'NO_SAMPLE_HEADER') {
                  // Empty slot (or the device didn't respond with a header) — treat as non-fatal.
                  alert(`No sample in slot ${slotLabel(idx)} (NO_SAMPLE_HEADER).`);
                  return;
                }
                throw e;
              }
            }
            while (state.rx.mode && state.rx.mode !== 'stream') {
              if (ac.signal.aborted) throw new Error('RX_ABORTED');
              await sleep(40);
            }
          } finally {
            // status cleared by _endBulk
          }
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'rx' });
      } catch (e) {
        // User cancel/abort: stop cleanly (no alert).
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
      }
    },

    async receiveActiveOrSelection() {
      this.ensureNotBusy();
      const indices = ui.getEffectiveSelection();
      if (!indices.length) return;

      if (indices.length === 1) return await this.receiveSingle(indices[0]);

      const openLoop = !!document.getElementById('openLoopRecvGlobal')?.checked;
      if (openLoop || window.mdOSVersion === '1.63') {
        return await this.receiveStreamFromSelection(indices);
      }

      const ac = this._beginBulk(`Receiving ${indices.length} slot(s)…`);
      const token = ac.__uwBulkToken;
      let skippedEmpty = 0;
      try {
        await withTransferFocus(async () => {
          for (let k = 0; k < indices.length; k++) {
            const idx = indices[k] | 0;
            if (ac.signal.aborted) throw new Error('RX_ABORTED');
            ui.setBulkStatus(`Receiving ${k + 1}/${indices.length}…`);
            try {
              await rxStartClosedRobust(idx, ac.signal, { headerTimeoutMs: (window.turboActive ? 3500 : 2500) });
            } catch (e) {
              const msg = (e && e.message) ? e.message : String(e);
              if (msg === 'NO_SAMPLE_HEADER') {
                skippedEmpty++;
                await sleep(uwGetInterSlotDelayMs());
                continue;
              }
              throw e;
            }
            while (state.rx.mode && state.rx.mode !== 'stream') {
              if (ac.signal.aborted) throw new Error('RX_ABORTED');
              await sleep(40);
            }
            await sleep(uwGetInterSlotDelayMs());
          }
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'rx' });
      } catch (e) {
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
        if (skippedEmpty) {
          ui.setBulkStatus(`Skipped ${skippedEmpty} empty/no-header slot(s).`);
          const seq = state.bulk.seq;
          setTimeout(() => { if (!state.bulk.inProgress && (state.bulk.seq === seq)) ui.setBulkStatus(''); }, 1200);
        }
      }
    },


    // Toolbar "Receive Stream / Receive All" button:
    // - Open-loop ON (or forced): passive stream capture (user triggers SEND > ALL on MD)
    // - Open-loop OFF: closed-loop sequential requests (no prompt to press SEND)
    async receiveStreamOrAll(indicesMaybe) {
      const openLoop = !!document.getElementById('openLoopRecvGlobal')?.checked;
      const forcedOpen = (window.mdOSVersion === '1.63');
      if (openLoop || forcedOpen) {
        return await this.receiveStreamFromSelection(indicesMaybe);
      }
      return await this.receiveAllClosedLoop(indicesMaybe);
    },

    // Closed-loop "Receive All" (or selection if provided).
    async receiveAllClosedLoop(indicesMaybe) {
      this.ensureNotBusy();

      const uw = state.samples || ensureSamplesModel();
      const maxUw = uw.maxSlots | 0;

      let indices = [];
      if (Array.isArray(indicesMaybe) && indicesMaybe.length) {
        indices = indicesMaybe.map(i => i | 0);
      } else if (state.selection && state.selection.size) {
        indices = Array.from(state.selection).map(i => i | 0);
      } else {
        for (let i = 0; i < maxUw; i++) indices.push(i);
      }

      // Only UW (non-RAM) slots are eligible for closed-loop requests.
      indices = indices.filter(i => i >= 0 && i < maxUw);
      indices.sort((a, b) => (a | 0) - (b | 0));

      if (!indices.length) {
        alert('No UW slots to receive.');
        return;
      }

      const ac = this._beginBulk(`Receiving ${indices.length} slot(s)…`);
      const token = ac.__uwBulkToken;
      let skippedEmpty = 0;
      try {
        await withTransferFocus(async () => {
          for (let k = 0; k < indices.length; k++) {
            const idx = indices[k] | 0;
            if (ac.signal.aborted) throw new Error('RX_ABORTED');
            ui.setBulkStatus(`Receiving ${k + 1}/${indices.length}…`);
            try {
              await rxStartClosedRobust(idx, ac.signal, { headerTimeoutMs: (window.turboActive ? 3500 : 2500) });
            } catch (e) {
              const msg = (e && e.message) ? e.message : String(e);
              if (msg === 'NO_SAMPLE_HEADER') {
                skippedEmpty++;
                await sleep(uwGetInterSlotDelayMs());
                continue;
              }
              throw e;
            }
            while (state.rx.mode && state.rx.mode !== 'stream') {
              if (ac.signal.aborted) throw new Error('RX_ABORTED');
              await sleep(40);
            }
            await sleep(uwGetInterSlotDelayMs());
          }
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'rx' });
      } catch (e) {
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
        if (skippedEmpty) {
          ui.setBulkStatus(`Skipped ${skippedEmpty} empty/no-header slot(s).`);
          const seq = state.bulk.seq;
          setTimeout(() => { if (!state.bulk.inProgress && (state.bulk.seq === seq)) ui.setBulkStatus(''); }, 1200);
        }
      }
    },

    async receiveStreamFromSelection(indicesMaybe) {
      this.ensureNotBusy();
      // If indices are provided, filter stream capture to those.
      // If nothing is selected, default to capturing ALL slots.
      let desired = null;
      if (Array.isArray(indicesMaybe) && indicesMaybe.length) {
        desired = new Set(indicesMaybe.map(i => i | 0));
      } else if (state.selection && state.selection.size) {
        desired = new Set(Array.from(state.selection).map(i => i | 0));
      } else {
        desired = null;
      }

      const desiredMsg = (desired && desired.size)
        ? ('Capturing ' + desired.size + ' selected slot(s).')
        : 'Capturing ALL slots (no selection).';

      const ok = confirm(
        'Stream receive captures samples the Machinedrum sends in a continuous stream.\n\n' +
        desiredMsg + '\n\n' +
        'On the Machinedrum, go to SAMPLE MANAGER and use SEND > ALL (or SEND > SLOT).\n\n' +
        'Proceed?'
      );
      if (!ok) return;

      const ac = this._beginBulk('Receiving stream…');
      const token = ac.__uwBulkToken;
      try {
        await withTransferFocus(async () => {
          await state.rx.startStream({ desiredSlots: desired, abortSignal: ac.signal, idleStopMs: 2500 });
          while (state.rx.mode === 'stream') {
            if (ac.signal.aborted) throw new Error('RX_ABORTED');
            await sleep(80);
          }

          // Offer a repair pass for any slots that were incomplete/corrupt during the stream.
          // In open-loop stream mode a single dropped SysEx message can make a slot incomplete.
          // Closed-loop re-receive is fast for just a handful of slots and guarantees integrity.
          try {
            const rep = state.rx.lastStreamReport;
            const uw = state.samples || ensureSamplesModel();
            const maxUw = uw.maxSlots | 0;
            const corrupt = (rep && Array.isArray(rep.corrupt))
              ? rep.corrupt.map(i => i | 0).filter(i => i >= 0 && i < maxUw)
              : [];

            if (corrupt.length && window.mdOSVersion !== '1.63') {
              const labels = corrupt.map(i => slotLabel(i)).join(', ');
              const okRepair = confirm(
                `Stream receive finished, but ${corrupt.length} slot(s) look incomplete/corrupt:\n` +
                labels +
                `\n\nRe-receive these slot(s) now using closed-loop (recommended)?`
              );

              if (okRepair) {
                for (let k = 0; k < corrupt.length; k++) {
                  const idx = corrupt[k] | 0;
                  if (ac.signal.aborted) throw new Error('RX_ABORTED');
                  ui.setBulkStatus(`Repairing ${k + 1}/${corrupt.length}…`);
                  try {
                    await rxStartClosedRobust(idx, ac.signal, { headerTimeoutMs: (window.turboActive ? 3500 : 2500) });
                    while (state.rx.mode && state.rx.mode !== 'stream') {
                      if (ac.signal.aborted) throw new Error('RX_ABORTED');
                      await sleep(40);
                    }
                  } catch (e) {
                    if (!isAbortLikeError(e)) console.warn('[UW RX] repair failed for slot', idx, e);
                  }
                  await sleep(uwGetInterSlotDelayMs());
                }
              }
            }
          } catch (_) {}
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'rx' });
      } catch (e) {
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
      }
    },

    async sendSingle(uiIndex) {
      this.ensureNotBusy();
      const idx = uiIndex | 0;
      if (isRamIndex(idx)) {
        alert('RAM buffers are receive-only and cannot be sent.');
        return;
      }

      const slotObj = getSlotByUiIndex(idx);
      if (!slotObj || (!slotObj.rawPCM && !slotObj.rawPCMBase64)) {
        alert('Empty slot (no audio). Nothing to send.');
        return;
      }

      const openLoop = !!document.getElementById('openLoopSendGlobal')?.checked;
      const ac = this._beginBulk('Sending…');
      const token = ac.__uwBulkToken;
      try {
        await withTransferFocus(async () => {
          await state.tx.sendSample(idx, { mode: openLoop ? 'open' : 'auto', abortSignal: ac.signal });
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'tx' });
      } catch (e) {
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
      }
    },

    async sendActiveOrSelection() {
      this.ensureNotBusy();
      const indicesAll = ui.getEffectiveSelection();
      if (!indicesAll.length) return;

      const uw = state.samples || ensureSamplesModel();

      // Skip RAM slots (receive-only) and empty slots (no audio).
      const indicesUw = indicesAll.filter(i => (i | 0) < (uw.maxSlots | 0));
      const skippedRam = indicesAll.length - indicesUw.length;

      const indices = indicesUw.filter(i => {
        const s = getSlotByUiIndex(i | 0);
        return !!(s && (s.rawPCM || s.rawPCMBase64));
      });
      const skippedEmpty = indicesUw.length - indices.length;

      if (skippedRam || skippedEmpty) {
        const parts = [];
        if (skippedRam) parts.push(`${skippedRam} RAM slot(s) skipped (receive-only)`);
        if (skippedEmpty) parts.push(`${skippedEmpty} empty slot(s) skipped (no audio)`);
        alert(parts.join('\n'));
      }

      if (!indices.length) {
        alert('No audio to send in the selected slot(s).');
        return;
      }

      const openLoop = !!document.getElementById('openLoopSendGlobal')?.checked;
      const ac = this._beginBulk(`Sending ${indices.length} slot(s)…`);
      const token = ac.__uwBulkToken;

      try {
        await withTransferFocus(async () => {
          for (let k = 0; k < indices.length; k++) {
            const idx = indices[k] | 0;
            if (ac.signal.aborted) throw new Error('TX_ABORTED');
            ui.setBulkStatus(`Sending ${k + 1}/${indices.length}…`);
            const ok = await state.tx.sendSample(idx, { mode: openLoop ? 'open' : 'auto', abortSignal: ac.signal });
            if (ok === false) continue;
            await sleep(uwGetInterSlotDelayMs());
          }
        }, { wakeLock: true, activeSense: true, uwSdsDirection: 'tx' });
      } catch (e) {
        if (isAbortLikeError(e)) return;
        throw e;
      } finally {
        this._endBulk(token);
      }
    },

    clearActiveOrSelection(opts) {
      opts = opts || {};
      const indices = ui.getEffectiveSelection();
      if (!indices.length) return;
      const label = (state.selection.size ? `${indices.length} selected slot(s)` : `slot ${slotLabel(indices[0])}`);
      if (opts.confirm !== false) {
        const ok = confirm(`Clear ${label}? This only affects the local bank until you send.`);
        if (!ok) return;
      }
      for (const idx of indices) setSlotByUiIndex(idx, null);
      if (state.selection.size) state.selection.clear();
      ui.render();
    },

    applyFieldToSelection(field, value) {
      const indices = Array.from(state.selection).sort((a, b) => a - b);
      if (!indices.length) { alert('No slots selected.'); return; }
      for (const idx of indices) {
        const s = getSlotByUiIndex(idx);
        if (!s) continue;
        if (field === 'name') s.name = normalizeName4(value);
        else if (field === 'targetSampleRate') s.targetSampleRate = clampInt(parseInt(value, 10) || 44100, 4000, 96000);
        else if (field === 'repitch') s.repitch = clampInt(parseInt(value, 10) || 0, -48, 48);
        s.__edited = true;
      }
      ui.render();
    },

    setLoopFromEditor(activeIdx) {
      const idx = activeIdx | 0;
      const s = getSlotByUiIndex(idx);
      if (!s) return;
      const ls = parseInt(document.getElementById('uwEdLoopStart')?.value, 10);
      const le = parseInt(document.getElementById('uwEdLoopEnd')?.value, 10);
      if (!Number.isFinite(ls) || !Number.isFinite(le)) {
        s.loopStart = null;
        s.loopEnd = null;
      } else {
        const maxS = (s.numSamples | 0) > 0 ? (s.numSamples | 0) : ((s.rawPCM ? (s.rawPCM.byteLength / 2) | 0 : 0));
        let a = clampInt(ls | 0, 0, Math.max(0, maxS - 1));
        let b = clampInt(le | 0, 0, maxS);
        if (b <= a) { s.loopStart = null; s.loopEnd = null; }
        else { s.loopStart = a; s.loopEnd = b; }
      }
      s.__edited = true;
      ui.renderEditor();
      ui.renderGridTile(idx);
    },

    applyLoopToSelectionFromEditor() {
      const indices = Array.from(state.selection).sort((a, b) => a - b);
      if (!indices.length) { alert('No slots selected.'); return; }
      const ls = parseInt(document.getElementById('uwEdLoopStart')?.value, 10);
      const le = parseInt(document.getElementById('uwEdLoopEnd')?.value, 10);
      for (const idx of indices) {
        const s = getSlotByUiIndex(idx);
        if (!s) continue;
        const maxS = (s.numSamples | 0) > 0 ? (s.numSamples | 0) : ((s.rawPCM ? (s.rawPCM.byteLength / 2) | 0 : 0));
        if (!Number.isFinite(ls) || !Number.isFinite(le)) {
          s.loopStart = null; s.loopEnd = null;
        } else {
          let a = clampInt(ls | 0, 0, Math.max(0, maxS - 1));
          let b = clampInt(le | 0, 0, maxS);
          if (b <= a) { s.loopStart = null; s.loopEnd = null; }
          else { s.loopStart = a; s.loopEnd = b; }
        }
        s.__edited = true;
      }
      ui.render();
    },

    // Clipboard
    cloneSlotObj(slotObj) {
      if (!slotObj) return null;
      const s = slotObj;
      const out = {};
      for (const k in s) {
        if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
        const v = s[k];
        if (k === 'rawPCM' && v instanceof ArrayBuffer) out.rawPCM = v.slice(0);
        else if (k === '__sdsRawPackets' && Array.isArray(v)) out.__sdsRawPackets = v.map(p => Array.isArray(p) ? p.slice() : Array.from(p));
        else if (v && typeof v === 'object') {
          try { out[k] = JSON.parse(JSON.stringify(v)); } catch (_) { out[k] = v; }
        } else out[k] = v;
      }
      if (out.rawPCM && !out.rawPCMBase64) out.rawPCMBase64 = arrayBufferToBase64(out.rawPCM);
      out.__edited = true;
      try { if (out.rawPCM) out.__pcmCrc32 = crc32(new Uint8Array(out.rawPCM)); } catch (_) {}
      return out;
    },

    copy() {
      const indices = ui.getEffectiveSelection();
      const idx = (indices && indices.length) ? indices[0] : (window.activeSlot | 0);
      const s = getSlotByUiIndex(idx);
      if (!s) {
        state.clipboard.slot = null;
        ui.setBulkStatus('Copied empty slot');
        setTimeout(() => ui.setBulkStatus(''), 500);
        return;
      }
      state.clipboard.slot = this.cloneSlotObj(s);
      ui.setBulkStatus(`Copied ${slotLabel(idx)}`);
      setTimeout(() => ui.setBulkStatus(''), 700);
    },

    cut() {
      const indices = ui.getEffectiveSelection();
      const idx = (indices && indices.length) ? indices[0] : (window.activeSlot | 0);
      this.copy();
      setSlotByUiIndex(idx, null);
      ui.render();
      ui.setBulkStatus(`Cut ${slotLabel(idx)}`);
      setTimeout(() => ui.setBulkStatus(''), 700);
    },

    paste() {
      if (!state.clipboard.slot) {
        ui.setBulkStatus('Clipboard empty');
        setTimeout(() => ui.setBulkStatus(''), 500);
        return;
      }
      const targets = state.selection.size ? Array.from(state.selection).sort((a, b) => a - b) : [window.activeSlot | 0];
      if (!targets.length) return;
      if (targets.length > 1) {
        const ok = confirm(`Paste into ${targets.length} slot(s)? This will overwrite existing local data.`);
        if (!ok) return;
      }
      for (const idx of targets) setSlotByUiIndex(idx, this.cloneSlotObj(state.clipboard.slot));
      ui.render();
      ui.setBulkStatus(`Pasted to ${targets.length} slot(s)`);
      setTimeout(() => ui.setBulkStatus(''), 700);
    },

    // Preview
    previewCtx: null,
    previewSources: {},

    previewSlot(uiIndex) {
      const idx = uiIndex | 0;
      const s = getSlotByUiIndex(idx);
      if (!s || !s.rawPCM) return;

      const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxCtor) return;

      if (!this.previewCtx) this.previewCtx = new AudioCtxCtor();
      const ctx = this.previewCtx;

      if (this.previewSources[idx]) {
        try { this.previewSources[idx].stop(); } catch (_) {}
        delete this.previewSources[idx];
        return;
      }

      const baseRate = s.targetSampleRate || s.originalSampleRate || 44100;
      const rp = s.repitch || 0;
      const rpF = Math.pow(2, rp / 12);

      const int16 = new Int16Array(s.rawPCM);
      const floatArr = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) floatArr[i] = int16[i] / 32768;

      const buf = ctx.createBuffer(1, int16.length, baseRate);
      buf.copyToChannel(floatArr, 0);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (s.loopStart != null && s.loopEnd != null && s.loopEnd > s.loopStart) {
        src.loop = true;
        src.loopStart = s.loopStart / baseRate;
        src.loopEnd = s.loopEnd / baseRate;
      }
      src.playbackRate.value = rpF;
      src.connect(ctx.destination);
      src.start();
      this.previewSources[idx] = src;
      src.onended = () => { delete this.previewSources[idx]; };
    },

    // Import
    async importFiles(files, opts) {
      opts = opts || {};
      const startAt = Number.isFinite(opts.startAtUiIndex) ? (opts.startAtUiIndex | 0) : null;
      const list = Array.from(files || []);
      if (!list.length) return;

      const uw = state.samples || ensureSamplesModel();

      function findNextFree(from) {
        for (let i = from; i < uw.maxSlots; i++) if (!uw.slots[i]) return i;
        for (let i = 0; i < from; i++) if (!uw.slots[i]) return i;
        return -1;
      }

      let targets = [];
      if (startAt != null) {
        let cur = startAt;
        for (let k = 0; k < list.length; k++) targets.push(cur++);
      } else if (list.length === 1) {
        targets = ui.getEffectiveSelection();
      } else if (state.selection.size && state.selection.size === list.length) {
        targets = Array.from(state.selection).sort((a, b) => a - b);
      } else {
        let cur = 0;
        for (let k = 0; k < list.length; k++) {
          const t = findNextFree(cur);
          if (t < 0) break;
          targets.push(t);
          cur = t + 1;
        }
      }

      if (!targets.length) {
        alert('No target slots available (bank full or no selection).');
        return;
      }

      for (let k = 0; k < Math.min(list.length, targets.length); k++) {
        const f = list[k];
        const t = targets[k] | 0;
        const ext = (f.name || '').toLowerCase().split('.').pop();
        if (ext === 'json') { await importBankJsonFromFile(f); continue; }
        if (ext === 'syx') { await importSyxFile(f); continue; }
        await importAudioFileToSlot(f, t);
      }

      ui.render();
    }
  };

  // --------------------------------------------------------------------------
  // Public compatibility shims (legacy function names)
  // --------------------------------------------------------------------------
  window.toggleUIDisabled = window.toggleUIDisabled || function (disable) {
    const panel = document.getElementById('uwPanel');
    if (!panel) return;
    if (disable) panel.classList.add('disabled-overlay');
    else panel.classList.remove('disabled-overlay');
  };

  window.clearSlot = window.clearSlot || function () { actions.clearActiveOrSelection({ confirm: true }); };
  window.clearAllSlots = window.clearAllSlots || function () {
    const ok = confirm('Clear ALL slots (local only)?');
    if (!ok) return;
    const uw = state.samples || ensureSamplesModel();
    for (let i = 0; i < uw.maxSlots; i++) uw.slots[i] = null;
    for (let r = 0; r < uw.ram.length; r++) uw.ram[r] = null;
    state.selection.clear();
    ui.render();
  };

  window.receiveActiveSlot = window.receiveActiveSlot || function () { return actions.receiveSingle(window.activeSlot | 0); };
  window.sendActiveSample = window.sendActiveSample || function () { return actions.sendSingle(window.activeSlot | 0); };

  // Legacy: Receive All (stream capture). If there is a selection, use it; otherwise target all UW slots.
  window.startBulkReceiveAll = window.startBulkReceiveAll || function () {
    if (state.selection && state.selection.size) {
      return actions.receiveStreamFromSelection();
    }
    const uw = state.samples || ensureSamplesModel();
    const all = [];
    for (let i = 0; i < (uw.maxSlots | 0); i++) all.push(i);
    state.selection.clear();
    all.forEach(i => state.selection.add(i));
    window.activeSlot = 0;
    try { ui.refreshSelectionClasses(); } catch (_) {}
    return actions.receiveStreamFromSelection(all);
  };

  // Legacy: Send All (sends only non-empty UW slots).
  window.sendAllSamples = window.sendAllSamples || function () {
    const uw = state.samples || ensureSamplesModel();
    const indices = [];
    for (let i = 0; i < (uw.maxSlots | 0); i++) {
      const s = uw.slots[i];
      if (s && (s.rawPCM || s.rawPCMBase64)) indices.push(i);
    }
    if (!indices.length) { alert('No samples in UW slots to send.'); return; }
    state.selection.clear();
    indices.forEach(i => state.selection.add(i));
    window.activeSlot = indices[0] | 0;
    try { ui.refreshSelectionClasses(); } catch (_) {}
    return actions.sendActiveOrSelection();
  };

  window.startBulkSendAll = window.startBulkSendAll || function () { return actions.sendActiveOrSelection(); };
  window.cancelUwBulkOperation = window.cancelUwBulkOperation || function () { return actions.cancelBulk(); };

  window.openImportAudioModal = window.openImportAudioModal || function () {
    try { ui.mount(); } catch (_) {}
    try { ui.elements.fileInput && ui.elements.fileInput.click(); } catch (_) {}
  };
  window.openImportDataModal = window.openImportDataModal || function () {
    try { ui.mount(); } catch (_) {}
    try {
      if (ui.elements.jsonInput) ui.elements.jsonInput.click();
      else if (ui.elements.fileInput) ui.elements.fileInput.click();
    } catch (_) {}
  };

  window.uwReceiveActiveSlots = window.receiveActiveSlot;
  window.uwSendActiveSlots = window.sendActiveSample;

  // --------------------------------------------------------------------------
  // MIDI dispatch: window.onMidiMessageUW
  // --------------------------------------------------------------------------
  function isElektronSysex(bytes) {
    return bytes && bytes.length > 8 &&
      (bytes[0] & 0xFF) === 0xF0 &&
      (bytes[1] & 0xFF) === 0x00 &&
      (bytes[2] & 0xFF) === 0x20 &&
      (bytes[3] & 0xFF) === 0x3C &&
      (bytes[4] & 0xFF) === 0x02;
  }

  function isUniversalSysex(bytes) {
    return bytes && bytes.length >= 5 &&
      (bytes[0] & 0xFF) === 0xF0 &&
      (bytes[1] & 0x7F) === 0x7E &&
      (bytes[bytes.length - 1] & 0xFF) === 0xF7;
  }

    // --- UW SysEx joiner (fixes WebMIDI SysEx chunking/fragmentation, esp. at Turbo)
  const uwSysexJoiner = (() => {
    let buf = [];
    let inSysex = false;
    let lastAt = 0;
    let expectedLen = 0;
    const STALE_MS = 1000;
    const MAX_BYTES = 200000;

    function expectedLenForSdsCmd(cmd) {
      cmd = cmd & 0x7F;
      if (cmd === 0x01) return 21;     // SDS header
      if (cmd === 0x02) return 127;    // SDS data packet (120-byte body)
      if (cmd === SDS_EOF) return 5;   // EOF
      if (cmd === SDS_ACK || cmd === SDS_NAK || cmd === SDS_CANCEL || cmd === SDS_WAIT) return 6; // handshake
      return 0;
    }

    function reset() {
      buf = [];
      inSysex = false;
      lastAt = 0;
      expectedLen = 0;
    }

    function maybeSalvage(out) {
      try {
        if (!inSysex) return false;
        if (!buf || buf.length < 4) return false;
        if (expectedLen > 0 && buf.length === (expectedLen - 1)) {
          buf.push(0xF7);
          out.push(buf);
          buf = [];
          inSysex = false;
          expectedLen = 0;
          return true;
        }
      } catch (_) {}
      return false;
    }

    function feed(chunk, nowMs) {
      // Fast path: if this event already contains a single complete SysEx frame
      // (F0...F7) with only 7-bit payload bytes, forward it without copying.
      if (!inSysex && chunk && chunk.length >= 3) {
        const len = chunk.length | 0;
        if ((chunk[0] & 0xFF) === 0xF0 && (chunk[len - 1] & 0xFF) === 0xF7) {
          let ok = true;
          for (let i = 1; i < len - 1; i++) {
            const b = chunk[i] & 0xFF;
            // Any status byte inside means this wasn't a clean single SysEx message.
            if (b === 0xF0 || b >= 0x80) { ok = false; break; }
          }
          if (ok) return [chunk];
        }
      }

      const out = [];
      const now = Number.isFinite(nowMs)
        ? nowMs
        : (typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now();

      // Drop any half-SysEx if the stream goes stale (prevents permanent desync).
      // If it looks like we only missed the final EOX on a fixed-length SDS message, salvage it.
      if (inSysex && lastAt && (now - lastAt) > STALE_MS) {
        maybeSalvage(out);
        reset();
      }

      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i] & 0xFF;

        // Real-time bytes are allowed to interleave with SysEx on the wire; ignore them.
        if (b >= 0xF8) continue;

        if (!inSysex) {
          if (b === 0xF0) {
            inSysex = true;
            buf = [0xF0];
            expectedLen = 0;
          }
          continue;
        }

        // Resync if we see a new SysEx start byte mid-buffer.
        // If the previous message was one-byte-short of a known SDS length, salvage it.
        if (b === 0xF0) {
          maybeSalvage(out);
          buf = [0xF0];
          expectedLen = 0;
          inSysex = true;
          continue;
        }

        // In SysEx, all payload bytes are 7-bit (0x00..0x7F) except the terminator 0xF7.
        // If we see other status bytes here, ignore them (they are not valid SysEx payload).
        if (b >= 0x80 && b !== 0xF7) continue;

        buf.push(b);

        // Detect expected SDS message length early (helps salvage missing 0xF7 at Turbo).
        if (!expectedLen && buf.length >= 4 && buf[0] === 0xF0 && buf[1] === 0x7E) {
          expectedLen = expectedLenForSdsCmd(buf[3] & 0x7F) || 0;
        }

        if (b === 0xF7) {
          out.push(buf);
          buf = [];
          inSysex = false;
          expectedLen = 0;
          continue;
        }

        if (buf.length > MAX_BYTES) {
          // Safety reset to avoid runaway memory if something goes wrong.
          reset();
        }
      }

      lastAt = now;
      return out;
    }

    function inProgress() {
      return inSysex;
    }

    return { feed, reset, inProgress };
  })();

  // Wrapper that accepts raw WebMIDI chunks (which may contain partial or multiple SysEx messages),
  // reassembles them, then forwards complete SysEx frames to the original handler.
  function onMidiMessageUW(bytes, receivedTime) {
    try {
      if (!bytes || !bytes.length) return;

      const idxF0 = (typeof bytes.indexOf === "function") ? bytes.indexOf(0xF0) : -1;
      const hasF0 = (bytes[0] === 0xF0) || (idxF0 !== -1);

      // Ignore non-SysEx traffic unless we are currently assembling a SysEx.
      if (!uwSysexJoiner.inProgress() && !hasF0) return;

      // If we're in the middle of a SysEx and this event starts with a non-SysEx status byte,
      // drop it unless it also contains a SysEx start (then feed from the 0xF0).
      if (uwSysexJoiner.inProgress()) {
        const first = bytes[0] & 0xFF;
        const unsafeStatus = (first >= 0x80 && first < 0xF8 && first !== 0xF0 && first !== 0xF7);
        if (unsafeStatus) {
          if (idxF0 >= 0) {
            bytes = (bytes.subarray) ? bytes.subarray(idxF0) : Array.prototype.slice.call(bytes, idxF0);
          } else {
            return;
          }
        }
      }

      const msgs = uwSysexJoiner.feed(bytes, receivedTime);
      for (let i = 0; i < msgs.length; i++) {
        handleUwSysexMessage(msgs[i], receivedTime);
      }
    } catch (e) {
      console.warn('[UW] onMidiMessageUW error:', e);
    }
  }


function handleUwSysexMessage(bytes, receivedTime) {
    try {
      if (!bytes || bytes.length < 2) return;
      if (bytes[0] !== 0xF0 || bytes[bytes.length - 1] !== 0xF7) return;

      const rxOrTxBusy = !!(state.rx && state.rx.mode) || !!(state.tx && state.tx.inProgress);

      if (window.ignoreNonSampleManagerSysex) {
        // During active SDS transfers, be extremely strict: accept only Universal (SDS) SysEx.
        // This reduces UI/parse work and prevents unrelated SysEx from competing at Turbo rates.
        if (rxOrTxBusy) {
          if (!isUniversalSysex(bytes)) {
            const allowName =
              (window.mdOSVersion === '1.63') &&
              !!(state.rx && state.rx.mode) &&               // only while receiving
              isElektronSysex(bytes) &&
              ((bytes[6] & 0x7F) === 0x73);                  // name packet only

            if (!allowName) return;
          }
        } else {
          if (!isUniversalSysex(bytes) && !isElektronSysex(bytes)) return;
        }
      }

      if (isElektronSysex(bytes)) {
        const cmd = bytes[6] & 0x7F;
        if (cmd === 0x72 && (bytes[7] & 0x7F) === 0x34) parseMdSlotList(bytes);
        else if (cmd === 0x73) parseMdSampleName(bytes);
        return;
      }

      if (isUniversalSysex(bytes)) {
        const cmd = bytes[3] & 0x7F;

        // TX handshakes
        if (cmd === SDS_ACK || cmd === SDS_NAK || cmd === SDS_CANCEL || cmd === SDS_WAIT || cmd === SDS_EOF) {
          const packetNo = (bytes.length > 5) ? (bytes[4] & 0x7F) : 0;
          state.tx.handleHandshake(cmd, packetNo);
          // RX may want EOF/CANCEL
          if (cmd === SDS_EOF || cmd === SDS_CANCEL) {
            try { state.rx.handleSysex(bytes, receivedTime); } catch (_) {}
          }
          return;
        }

        // RX data/header
        if ((cmd === 0x01 || cmd === 0x02 || cmd === SDS_EOF || cmd === SDS_CANCEL) && state.rx.mode) {
          state.rx.handleSysex(bytes, receivedTime);
          return;
        }
      }
    } catch (e) {
      console.warn('[UW] onMidiMessageUW error:', e);
    }
  }


  window.onMidiMessageUW = onMidiMessageUW;

  // --------------------------------------------------------------------------
  // initUwPanel + boot
  // --------------------------------------------------------------------------
  function initUwPanel() {
    const unavailEl = document.getElementById('uwUnavailable');
    const panelEl = document.getElementById('uwPanel');

    if (!window.mdUWEnabled) {
      if (panelEl) panelEl.style.display = 'none';
      if (unavailEl) unavailEl.style.display = 'block';
      return;
    }

    if (unavailEl) unavailEl.style.display = 'none';
    if (panelEl) panelEl.style.display = '';

    ensureSamplesModel();

    window.activeSlot = 0;
    window.uwPanelActive = true;

    ui.mount();
    ui.render();
  }
  window.initUwPanel = initUwPanel;

  function boot() {
    try { ensureSamplesModel(); } catch (_) {}
    try { initUwPanel(); } catch (_) {}
    try { ui.updateConnectionLabel(); } catch (_) {}

    // Patch DOM selection updates when panel switching (best-effort)
    try {
      document.addEventListener('uwSlotListReceived', () => ui.updateConnectionLabel());
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
