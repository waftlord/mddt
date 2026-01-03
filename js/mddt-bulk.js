// bulk.js

// ────────────────────────────────────────────────────────────────────────────────
// T U R B O   D E L A Y   T U N I N G
// ────────────────────────────────────────────────────────────────────────────────

// When window.turboActive === true, we’ll wait turboDelayPerSlot instead of 38ms.
// Increase or decrease this until the TM-1 no longer drops/freeze under turbo.
window.turboDelayPerSlot = 5;    // <–– start at 5ms; you can tweak at runtime

"use strict";

window.toolsPanelState = { busyOperations: 0 };

/* ──────────────────────────────────────────────────────────────────────────────
   WIRE-CLOCK: Align UI to the real wire drain (Turbo-aware, abortable)
   - accountBytes(n): accumulate on-wire deadline based on MIDI bit rate and Turbo factor
   - waitForDrain(signal?): await until all queued bytes should have exited the wire (+ small guard)
   - reset(): start a fresh per-slot clock
   - setTurboFactor(f): optional external setter (if you parse an exact turbo factor elsewhere)
────────────────────────────────────────────────────────────────────────────── */
window.MidiWireClock = (function () {
  let deadlineMs = 0;
  const BASE_BPS       = 31250; // MIDI bit rate
  const BITS_PER_BYTE  = 10;    // start + 8 data + stop
  const DEFAULT_TURBO  = 1.0;
  // Tail guard (adaptive via tailGuardMs())
const TAIL_GUARD_MS  = 12;    // small cushion for driver/LED fall time

  function now() { return performance.now(); }
  function turboFactor() {
    // If your Turbo negotiation populates window.currentTurboFactor (e.g., 1, 2, 3.33, 5, 6.66, …),
    // we’ll use it; otherwise default to 1×.
    const f = (typeof window.currentTurboFactor === "number" && window.currentTurboFactor > 0)
      ? window.currentTurboFactor
      : DEFAULT_TURBO;
    return f || DEFAULT_TURBO;
  }

  function tailGuardMs() {
    const f = turboFactor();
    return (f >= 10) ? 3 : (f >= 5 ? 6 : 12);
  }
function msForBytes(nBytes) {
    const bytesPerSecond = (BASE_BPS / BITS_PER_BYTE) * turboFactor(); // ≈ 3125 * F
    return (nBytes / bytesPerSecond) * 1000.0;
  }
  function accountBytes(nBytes) {
    const start = Math.max(now(), deadlineMs);
    const need  = msForBytes(nBytes);
    deadlineMs  = start + need;
    return deadlineMs;
  }
  function waitForDrain(signal, extraMs) {
    if (extraMs == null) extraMs = tailGuardMs();
    return new Promise((resolve, reject) => {
      const target = Math.max(now(), deadlineMs) + (extraMs || 0);
      const delay  = target - now();
      if (delay <= 0) return resolve();
      const t = setTimeout(resolve, delay);
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("Cancelled"));
        }, { once: true });
      }
    });
  }
  function reset() { deadlineMs = 0; }
  function setTurboFactor(f) { window.currentTurboFactor = Math.max(1, +f || 1); }

  return { accountBytes, waitForDrain, reset, setTurboFactor, msForBytes };
})();

/* Wrap MIDI sends so we can count bytes for the wire clock */
function sendWireCounted(msg, when /* optional Web MIDI timestamp */) {
  if (!window.selectedMidiOut) return;
  window.selectedMidiOut.send(msg, when);
  const n = (msg && msg.byteLength !== undefined)
    ? msg.byteLength
    : (Array.isArray(msg) ? msg.length : 0);
  window.MidiWireClock.accountBytes(n);
}

function cancellableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Cancelled"));
      },
      { once: true }
    );
  });
}

function flashToolsPanel(color) {
  const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
  if (header) header.style.backgroundColor = color || "blue";
}

function restoreToolsPanelColor() {
  const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
  if (header) {
    header.style.backgroundColor = "";
    header.style.background = "";
  }
}
function setToolsPanelBusy(color) {
  window.toolsPanelState.busyOperations++;
  flashToolsPanel(color);
}

function clearToolsPanelBusy() {
  if (window.toolsPanelState.busyOperations > 0) {
    window.toolsPanelState.busyOperations--;
  }
  if (window.toolsPanelState.busyOperations === 0) {
    restoreToolsPanelColor();
    const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
    if (header) header.textContent = "Tools";
  }
}

function resetToolsPanelHeader() {
  const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
  if (header) {
    header.textContent = "Tools";
    header.style.background = "";
  }
}

function showCancelBtn(direction, show) {
  const id = direction === "receive" ? "bulkCancelReceiveBtn" : "bulkCancelSendBtn";
  const btn = document.getElementById(id);
  if (btn) btn.style.display = show ? "inline-block" : "none";
}

function cancelBulkOperation(direction) {
  if (window.bulkAbortController) window.bulkAbortController.abort();
  window.bulkAbortController = null;

  // If an "Everything" pipeline is running and we're in the UW stage, make sure
  // we also stop the UW bulk operation.
  try {
    if (window.__everythingInProgress && typeof cancelUwBulkOperation === "function") {
      cancelUwBulkOperation({ skipConfirm: true });
    }
  } catch (e) {
    // ignore
  }
  window.__everythingInProgress = null;
  if (direction === "receive") {
    window.isReceiveAllInProgress = false;
  } else {
    window.isSendAllInProgress = false;
  }
  window.isBulkInProgress = false;
  showCancelBtn(direction, false);
  restoreToolsPanelColor();
  const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
  if (header) header.textContent = "Tools";
  window.toolsPanelState.busyOperations = 0;
  clearToolsPanelBusy();
}

function getBulkDelay(extra) {
  // ──── if Turbo is on, use a much smaller “breathing” delay ────
  if (window.turboActive) {
    // Only wait exactly turboDelayPerSlot + any optional “extra” padding
    return (window.turboDelayPerSlot || 0) + (extra || 0);
  }

  // ──── otherwise, do your original 38 ms + user-provided offset ────
  const baseDelay    = 45;
  const delayInput   = document.getElementById("bulkDelayInput");
  const userDelayNum = delayInput ? parseInt(delayInput.value, 10) : NaN;
  const additional   = isNaN(userDelayNum) ? 0 : userDelayNum;
  return baseDelay + additional + (extra || 0);
}

/** structuredClone wrapper used by bulk ops (preserves TypedArrays when available) */
function safeClone(obj) {
  try {
    if (typeof structuredClone === "function") return structuredClone(obj);
  } catch (e) {
    // ignore and fall back
  }
  return JSON.parse(JSON.stringify(obj));
}

async function runBulkOperations(opList, directionLabel, onComplete) {
  // Bulk receive uses a promise/await pipeline (request*DumpAsync → _awaitMachinedrumSysexResponse)
  // which attaches its own MIDI event listener.
  // While that is running, the normal onmidimessage handler can still fire and
  // (historically) decode dumps + trigger full initUI() rebuilds for every slot.
  // That creates lag/stutter and can even trigger browser "long task" warnings.
  //
  // Fix: temporarily suppress redundant inbound SysEx handling while bulk RECEIVE
  // is active. CC messages remain allowed.

  const signal = window.bulkAbortController?.signal;
  const isReceive = String(directionLabel || "").toLowerCase().includes("receive");
  const mos = window.midiOperationState;

  const prevIgnoreAll = mos ? !!mos.ignoreAllIncoming : false;
  const prevInboundMode = mos ? mos.inboundMode : "idle";

  if (isReceive && mos) {
    mos.ignoreAllIncoming = true;
    mos.inboundMode = "receivingBulkAsync";
  }

  try {
    for (const opItem of opList) {
      if (signal?.aborted) break;
      const { func, start, end } = opItem;
      try {
        await func(start, end);
      } catch (err) {
        if (err?.message === "Cancelled" || err?.message === "Aborted") break;
      }
      if (signal?.aborted) break;
    }
    if (!signal?.aborted && typeof onComplete === "function") onComplete();
  } finally {
    if (isReceive && mos) {
      mos.ignoreAllIncoming = prevIgnoreAll;
      mos.inboundMode = prevInboundMode;
    }
  }
}

// -----------------------------------------------------------------------------
// Fast "empty slot" detection (bulk receive)
// -----------------------------------------------------------------------------

// Kits are fixed-size dumps. Decoding a full kit just to discover it's "empty"
// (all machine assignments = 0) wastes CPU. We can inspect only the MODEL7 block.
function fastIsKitDumpEmpty(kitBody) {
  try {
    if (!kitBody || kitBody.length < 500) return null;
    const arr = Array.isArray(kitBody) ? kitBody : Array.from(kitBody);

    // Offsets are relative to the *body* (header+msgId removed):
    // [ver, rev, pos] + kitName(16) + trackParams(16*24) + trackLevels(16) = 419
    const modelEncStart = 3 + 16 + (16 * 24) + 16;
    const modelRawBytes = 64;
    if (modelEncStart >= arr.length) return null;
    if (typeof window.decode7BitDynamic !== "function") return null;

    const dec = window.decode7BitDynamic(arr, modelEncStart, modelRawBytes);
    const raw = dec && dec.result;
    if (!raw || raw.length < modelRawBytes) return null;

    for (let t = 0; t < 16; t++) {
      const base = t * 4;
      const rawVal =
        ((raw[base + 0] & 0xFF) << 24) |
        ((raw[base + 1] & 0xFF) << 16) |
        ((raw[base + 2] & 0xFF) << 8) |
        (raw[base + 3] & 0xFF);
      const machineId = rawVal & 0xFFFF;
      if (machineId !== 0) return false;
    }
    return true;
  } catch (_) {
    return null;
  }
}

// Patterns can be very large (especially 64-step). For "empty" patterns we only
// care about the trig bitfields + lock count. We can inspect those quickly and
// skip the expensive full decode.
function decode7bitBlockHasAnyNonZero(enc74) {
  let i = 0;
  while (i < enc74.length) {
    const head = enc74[i++] & 0x7F;
    const chunkCount = Math.min(7, enc74.length - i);
    for (let j = 0; j < chunkCount; j++) {
      const db = enc74[i++] & 0x7F;
      const msb = (head >> (6 - j)) & 1;
      const restored = ((msb << 7) | db) & 0xFF;
      if (restored !== 0) return true;
    }
  }
  return false;
}

function fastIsPatternDumpEmpty(fullData) {
  try {
    if (!fullData || fullData.length < 200) return null;
    const arr = Array.isArray(fullData) ? fullData : Array.from(fullData);
    const idx67 = arr.indexOf(0x67);
    if (idx67 < 0) return null;
    const data = arr.slice(idx67); // starts at 0x67
    if (data.length < 180) return null;

    // Offsets are relative to the 0x67 slice.
    // trig block A: offset 4, len 74
    // after trig+lock+accent blocks, metadata bytes start at offset 171
    // pattern length byte at 171+1 = 172, lockCount at 171+5 = 176
    const patLen = data[172] & 0x7F;
    const lockCount = data[176] & 0x7F;
    if (lockCount > 0) return false;

    const trigA = data.slice(4, 4 + 74);
    if (decode7bitBlockHasAnyNonZero(trigA)) return false;

    // Only check the extra trig block when the *pattern length* indicates 64-step.
    // (Matches receivePatternDump semantics; avoids flagging hidden/unused 2nd-half data
    // in a 64-step dump when the effective length is <= 32.)
    const needsExtraTrig = patLen > 32;
    const extraTrigOff = 2518;
    if (needsExtraTrig && data.length >= extraTrigOff + 74) {
      const trigB = data.slice(extraTrigOff, extraTrigOff + 74);
      if (decode7bitBlockHasAnyNonZero(trigB)) return false;
    }

    return true;
  } catch (_) {
    return null;
  }
}

function buildOperationList(isReceive) {
  const gRange = document.getElementById("slider-globals").noUiSlider.get();
  const kRange = document.getElementById("slider-kits").noUiSlider.get();
  const pRange = document.getElementById("slider-patterns").noUiSlider.get();
  const sRange = document.getElementById("slider-songs").noUiSlider.get();
  const gStart = parseInt(gRange[0], 10) || 1,
        gEnd = parseInt(gRange[1], 10) || 1;
  const kStart = parseInt(kRange[0], 10) || 1,
        kEnd = parseInt(kRange[1], 10) || 1;
  const pStart = window.patternLabelToIndex(pRange[0]),
        pEnd   = window.patternLabelToIndex(pRange[1]);
  const sStart = parseInt(sRange[0], 10) || 1,
        sEnd = parseInt(sRange[1], 10) || 1;

  const receives = [
    { name: "Globals", func: doBulkReceiveGlobals, start: Math.min(gStart, gEnd), end: Math.max(gStart, gEnd), checkboxId: "recvCheckG" },
    { name: "Kits", func: doBulkReceiveKits, start: Math.min(kStart, kEnd), end: Math.max(kStart, kEnd), checkboxId: "recvCheckK" },
    { name: "Patterns", func: doBulkReceivePatterns, start: Math.min(pStart, pEnd), end: Math.max(pStart, pEnd), checkboxId: "recvCheckP" },
    { name: "Songs", func: doBulkReceiveSongs, start: Math.min(sStart, sEnd), end: Math.max(sStart, sEnd), checkboxId: "recvCheckS" },
  ];

  const sends = [
    { name: "Globals", func: doBulkSendGlobals, start: Math.min(gStart, gEnd), end: Math.max(gStart, gEnd), checkboxId: "sendCheckG" },
    { name: "Kits", func: doBulkSendKits, start: Math.min(kStart, kEnd), end: Math.max(kStart, kEnd), checkboxId: "sendCheckK" },
    { name: "Patterns", func: doBulkSendPatterns, start: Math.min(pStart, pEnd), end: Math.max(pStart, pEnd), checkboxId: "sendCheckP" },
    { name: "Songs", func: doBulkSendSongs, start: Math.min(sStart, sEnd), end: Math.max(sStart, sEnd), checkboxId: "sendCheckS" },
  ];

  return (isReceive ? receives : sends).filter(op => {
    const cb = document.getElementById(op.checkboxId);
    return cb && cb.checked;
  });
}

async function onClickReceiveAll() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (window.isBulkInProgress) {
    alert("Bulk already in progress. Please wait until completion.");
    return;
  }
  if (!confirm("Overwrite data?")) return;

  setToolsPanelBusy("#e0f0ff");
  window.isBulkInProgress = true;
  window.isReceiveAllInProgress = true;
  showCancelBtn("receive", true);
  window.bulkAbortController = new AbortController();

  const ops = buildOperationList(true);
  try {
    await runBulkOperations(ops, "receive", () => {
      window.isReceiveAllInProgress = false;
      window.isBulkInProgress = false;
      showCancelBtn("receive", false);
      clearToolsPanelBusy();
      resetToolsPanelHeader();
      if (typeof resetPattern === "function") resetPattern();
       window.selectedPatternSlotIndex = -1;
      if (typeof initUI === "function") initUI();
    });
  } catch (err) {
    // Error handling omitted
  }
  if (window.bulkAbortController?.signal.aborted) {
    window.isReceiveAllInProgress = false;
    window.isBulkInProgress = false;
    showCancelBtn("receive", false);
    clearToolsPanelBusy();
    resetToolsPanelHeader();
  }
}

async function onClickSendAll() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (window.isBulkInProgress) {
    alert("Bulk already in progress. Please wait until completion.");
    return;
  }
  if (!confirm("WARNING: Sending data will overwrite current data on your Machinedrum.  Have you backed up? Continue?")) return;

  setToolsPanelBusy("#e0f0ff");
  window.isBulkInProgress = true;
  window.isSendAllInProgress = true;
  showCancelBtn("send", true);
  window.bulkAbortController = new AbortController();

  const ops = buildOperationList(false);
  try {
    await runBulkOperations(ops, "send", () => {
      window.isSendAllInProgress = false;
      window.isBulkInProgress = false;
      showCancelBtn("send", false);
      clearToolsPanelBusy();
      resetToolsPanelHeader();
      if (typeof initUI === "function") initUI();
    });
  } catch (err) {
    // Error handling omitted intentionally
  }
  if (window.bulkAbortController?.signal.aborted) {
    window.isSendAllInProgress = false;
    window.isBulkInProgress = false;
    showCancelBtn("send", false);
    clearToolsPanelBusy();
    resetToolsPanelHeader();
  }
}

// ------------------------------------------------------------
// EVERYTHING (G+K+P+S then UW samples if enabled)
// ------------------------------------------------------------

async function onClickReceiveEverything() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (window.isBulkInProgress) {
    alert("Bulk already in progress. Please wait until completion.");
    return;
  }

  const includeUW = !!window.mdUWEnabled;
  const msg = includeUW
    ? "Overwrite in-browser data?\n\nThis will RECEIVE: Globals (8) + Kits (64) + Patterns (128) + Songs (32) + UW Samples (all slots).\n\nContinue?"
    : "Overwrite in-browser data?\n\nThis will RECEIVE: Globals (8) + Kits (64) + Patterns (128) + Songs (32).\n\nContinue?";

  if (!confirm(msg)) return;

  setToolsPanelBusy("#e0f0ff");
  window.isBulkInProgress = true;
  window.isReceiveAllInProgress = true;
  window.__everythingInProgress = { direction: "receive" };
  showCancelBtn("receive", true);
  window.bulkAbortController = new AbortController();

  try {
    const ops = [
      { name: "Globals", func: doBulkReceiveGlobals, start: 1, end: 8 },
      { name: "Kits", func: doBulkReceiveKits, start: 1, end: 64 },
      { name: "Patterns", func: doBulkReceivePatterns, start: 0, end: 127 },
      { name: "Songs", func: doBulkReceiveSongs, start: 1, end: 32 },
    ];

    await runBulkOperations(ops, "receive");
    if (window.bulkAbortController?.signal.aborted) throw new Error("Bulk receive aborted");

    if (includeUW && typeof startBulkReceiveAll === "function") {
      // UW bulk receive has its own UI/flow; we just sequence it last.
      const total = window.uwSamples?.maxSlots || window.uwSamples?.slots?.length || 0;
      const uwMsg =
        window.mdOSVersion === "1.63"
          ? "UW stage: on the Machinedrum, open SAMPLE MGR and press SEND > ALL now.\n\nPress OK to begin the UW transfer."
          : "UW stage: on the Machinedrum, open SAMPLE MGR. The app will request each active slot in turn.\n\nPress OK to begin the UW transfer.";
      if (confirm(uwMsg)) {
        updateBulkProgress("Receiving UW Samples", 0, total || 1);
        await Promise.resolve(startBulkReceiveAll({ skipConfirm: true }));
        updateBulkProgress("Receiving UW Samples", total || 1, total || 1);
      }
    }
  } catch (err) {
    // Swallow; cancel + errors are handled by cleanup.
  } finally {
    window.__everythingInProgress = null;
    window.isReceiveAllInProgress = false;
    window.isBulkInProgress = false;
    showCancelBtn("receive", false);
    clearToolsPanelBusy();
    resetToolsPanelHeader();
    if (typeof resetPattern === "function") resetPattern();
    window.selectedPatternSlotIndex = -1;
    if (typeof initUI === "function") initUI();
  }
}

async function onClickSendEverything() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (window.isBulkInProgress) {
    alert("Bulk already in progress. Please wait until completion.");
    return;
  }

  const includeUW = !!window.mdUWEnabled;
  const msg = includeUW
    ? "WARNING: This will overwrite data on your Machinedrum.\n\nThis will SEND: Globals (8) + Kits (64) + Patterns (128) + Songs (32) + UW Samples (all slots).\n\nHave you backed up? Continue?"
    : "WARNING: This will overwrite data on your Machinedrum.\n\nThis will SEND: Globals (8) + Kits (64) + Patterns (128) + Songs (32).\n\nHave you backed up? Continue?";

  if (!confirm(msg)) return;

  setToolsPanelBusy("#e0f0ff");
  window.isBulkInProgress = true;
  window.isSendAllInProgress = true;
  window.__everythingInProgress = { direction: "send" };
  showCancelBtn("send", true);
  window.bulkAbortController = new AbortController();

  try {
    const ops = [
      { name: "Globals", func: doBulkSendGlobals, start: 1, end: 8 },
      { name: "Kits", func: doBulkSendKits, start: 1, end: 64 },
      { name: "Patterns", func: doBulkSendPatterns, start: 0, end: 127 },
      { name: "Songs", func: doBulkSendSongs, start: 1, end: 32 },
    ];

    await runBulkOperations(ops, "send");
    if (window.bulkAbortController?.signal.aborted) throw new Error("Bulk send aborted");

    if (includeUW && typeof sendAllSamples === "function") {
      const total =
        window.uwSamples?.maxSlots || window.uwSamples?.slots?.length || 0;
      const uwMsg =
        window.mdOSVersion === "1.63"
          ? "UW stage: on the Machinedrum, open SAMPLE MGR and press RECV > ALL now.\n\nPress OK to begin the UW transfer."
          : "UW stage: on the Machinedrum, open SAMPLE MGR.\n\nPress OK to begin the UW transfer.";
      if (!confirm(uwMsg)) {
        // Skip UW stage
        return;
      }
      updateBulkProgress("Sending UW Samples", 0, total || 1);
      await Promise.resolve(sendAllSamples({ skipConfirm: true }));
      if (total > 0) updateBulkProgress("Sending UW Samples", total, total);
    }
  } catch (err) {
    // Swallow; cancel + errors are handled by cleanup.
  } finally {
    window.__everythingInProgress = null;
    window.isSendAllInProgress = false;
    window.isBulkInProgress = false;
    showCancelBtn("send", false);
    clearToolsPanelBusy();
    resetToolsPanelHeader();
    if (typeof initUI === "function") initUI();
  }
}

function onClickReceiveGlobal() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("Overwrite global panel data?")) return;

  const gRange = document.getElementById("slider-globals").noUiSlider.get();
  const gStart = parseInt(gRange[0], 10) || 1;
  const gEnd = parseInt(gRange[1], 10) || 1;
  if (gStart === gEnd) {
    requestGlobalDump(gStart - 1);
  } else {
    doBulkReceiveGlobals(Math.min(gStart, gEnd), Math.max(gStart, gEnd));
  }
}

function onClickReceiveKit() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("Overwrite kit panel data?")) return;

  const start = parseInt(document.getElementById("kitStart").value, 10) || 1;
  const end = parseInt(document.getElementById("kitEnd").value, 10) || 1;
  if (start === end) {
    window.singleKitReceiveMode = true;
    requestKitDump();
  } else {
    doBulkReceiveKits(Math.min(start, end), Math.max(start, end));
  }
}
function onClickReceivePattern() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("Overwrite pattern panel data?")) return;

  const pRange = document.getElementById("slider-patterns").noUiSlider.get();
  const pStart = window.patternLabelToIndex(pRange[0]),
        pEnd = window.patternLabelToIndex(pRange[1]);
  if (pStart !== pEnd) {
    doBulkReceivePatterns(Math.min(pStart, pEnd), Math.max(pStart, pEnd));
    return;
  }
  window.waitingForSinglePatternDump = true;
  const patIndex = Math.max(0, Math.min(127, pStart));
  const syx = [...window.MD_SYSEX_HEADER, window.MD_PATTERN_REQUEST_ID, (patIndex & 0x7F), 0xF7];
  window.selectedMidiOut.send(syx);
}

function onClickReceiveSong() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  const sRange = document.getElementById("slider-songs").noUiSlider.get();
  const sStart = parseInt(sRange[0], 10) || 1;
  const sEnd = parseInt(sRange[1], 10) || 1;
  if (sStart !== sEnd) {
    doBulkReceiveSongs(Math.min(sStart, sEnd), Math.max(sStart, sEnd));
    return;
  }
  window.waitingForSingleSongDump = true;
  const songIndex = Math.max(0, Math.min(31, sStart - 1));
  const syx = [...window.MD_SYSEX_HEADER, window.MD_SONG_REQUEST_ID, (songIndex & 0x1F), 0xF7];
  window.selectedMidiOut.send(syx);
}

function onClickSendGlobal() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("WARNING: This will overwrite Machinedrum global data. Continue?")) return;

  const gRange = document.getElementById("slider-globals").noUiSlider.get();
  const gStart = parseInt(gRange[0], 10) || 1;
  if (typeof window.saveGlobalSettings === "function") window.saveGlobalSettings();
  window.globalData.globalPosition = gStart - 1;
  const syx = window.createGlobalDump();
  window.selectedMidiOut.send(syx);
  const loadMsg = new Uint8Array([...window.MD_SYSEX_HEADER, 0x56, (gStart - 1) & 0x07, 0xF7]);
  window.selectedMidiOut.send(loadMsg);
}

function onClickSendKit() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("WARNING: This will overwrite Machinedrum kit data. Continue?")) return;

  const start = parseInt(document.getElementById("kitStart").value, 10) || 1;
  window.kit.sysexPosition = start - 1;
  const syx = window.createKitDump(window.kit);
  window.selectedMidiOut.send(syx);
  const loadMsg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x58, (start - 1) & 0x3F, 0xF7]);
  window.selectedMidiOut.send(loadMsg);
}

function onClickSendPattern() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("WARNING: This will overwrite Machinedrum pattern data. Continue?")) return;

  const pRange = document.getElementById("slider-patterns").noUiSlider.get();
  const pStart = window.patternLabelToIndex(pRange[0]);
  if (typeof readPatternUI === "function") readPatternUI();
  window.pattern.origPos = pStart;
  window.pattern.patternNumber = pStart;
  const syx = window.createPatternDump(window.pattern);
  window.selectedMidiOut.send(syx);
}

function onClickSendSong() {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("WARNING: This will overwrite Machinedrum song data. Continue?")) return;

  const sRange = document.getElementById("slider-songs").noUiSlider.get();
  const sStart = parseInt(sRange[0], 10) || 1;
  const songIndex = Math.max(0, Math.min(31, sStart - 1));
  if (typeof readSongUI === "function") readSongUI();
  window.currentSong.slotIndex = songIndex;
  const syx = window.createSongDump(window.currentSong);
  window.selectedMidiOut.send(syx);
  const loadMsg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x6C, songIndex & 0x1F, 0xF7]);
  window.selectedMidiOut.send(loadMsg);
}

function onClickResetAll(e) {
  if (e && e.shiftKey) return;
  if (!confirm("WARNING: This will reset slot data. Continue?")) return;
  window.toolsPanelState.busyOperations = 0;
  setToolsPanelBusy("#efe0f0ff");
  return new Promise(resolve => {
    setTimeout(async () => {
      let [gStart, gEnd] = document.getElementById("slider-globals").noUiSlider.get().map(v => parseInt(v, 10) || 1);
      if (gStart > gEnd) [gStart, gEnd] = [gEnd, gStart];
      let [sStart, sEnd] = document.getElementById("slider-songs").noUiSlider.get().map(v => parseInt(v, 10) || 1);
      if (sStart > sEnd) [sStart, sEnd] = [sEnd, sStart];
      let [kStart, kEnd] = document.getElementById("slider-kits").noUiSlider.get().map(v => parseInt(v, 10) || 1);
      if (kStart > kEnd) [kStart, kEnd] = [kEnd, kStart];
      let [pStart, pEnd] = document.getElementById("slider-patterns").noUiSlider.get().map(v => window.patternLabelToIndex(v));
      if (pStart > pEnd) [pStart, pEnd] = [pEnd, pStart];

      if (document.getElementById("resetCheckS")?.checked) await doBulkResetSongsIncremental(sStart, sEnd);
      if (document.getElementById("resetCheckP")?.checked) await doBulkResetPatternsIncremental(pStart, pEnd);
      if (document.getElementById("resetCheckK")?.checked) await doBulkResetKitsIncremental(kStart, kEnd);
      if (document.getElementById("resetCheckG")?.checked) await doBulkResetGlobalsIncremental(gStart, gEnd);
      if (typeof initUI === "function") initUI();
      setTimeout(() => {
        clearToolsPanelBusy();
        clearBlinkingSlots();
        resolve();
      }, 1);
    }, 1);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Tools > SLOTS : Copy / Paste / Clear (range-aware, GKPS-aware)
// ──────────────────────────────────────────────────────────────────────────────

// In-memory clipboard for slot operations (kept simple + robust)
window.slotOpsClipboard = window.slotOpsClipboard || null;

function slotOpsSetStatus(text) {
  const el = document.getElementById("slotOpsStatus");
  if (el) el.textContent = text;
}

function slotOpsGetSelectedTypes() {
  return {
    global: !!document.getElementById("resetCheckG")?.checked,
    kit: !!document.getElementById("resetCheckK")?.checked,
    pattern: !!document.getElementById("resetCheckP")?.checked,
    song: !!document.getElementById("resetCheckS")?.checked
  };
}

function slotOpsHasAnyTypeSelected(sel) {
  return !!(sel && (sel.global || sel.kit || sel.pattern || sel.song));
}

function slotOpsClamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function slotOpsGetRanges() {
  // Returns 0-based inclusive [startIdx,endIdx] plus UI labels.
  const ranges = {
    global: { startIdx: 0, endIdx: 7, uiStart: 1, uiEnd: 8 },
    kit: { startIdx: 0, endIdx: 63, uiStart: 1, uiEnd: 64 },
    pattern: { startIdx: 0, endIdx: 127, uiStart: 0, uiEnd: 127 },
    song: { startIdx: 0, endIdx: 31, uiStart: 1, uiEnd: 32 }
  };

  // Globals (1..8)
  try {
    const g = document.getElementById("slider-globals")?.noUiSlider?.get?.();
    if (g) {
      let a = parseInt(g[0], 10) || 1;
      let b = parseInt(g[1], 10) || 1;
      if (a > b) [a, b] = [b, a];
      a = slotOpsClamp(a, 1, 8);
      b = slotOpsClamp(b, 1, 8);
      ranges.global = { startIdx: a - 1, endIdx: b - 1, uiStart: a, uiEnd: b };
    }
  } catch (e) {}

  // Kits (1..64)
  try {
    const k = document.getElementById("slider-kits")?.noUiSlider?.get?.();
    if (k) {
      let a = parseInt(k[0], 10) || 1;
      let b = parseInt(k[1], 10) || 1;
      if (a > b) [a, b] = [b, a];
      a = slotOpsClamp(a, 1, 64);
      b = slotOpsClamp(b, 1, 64);
      ranges.kit = { startIdx: a - 1, endIdx: b - 1, uiStart: a, uiEnd: b };
    }
  } catch (e) {}

  // Patterns (0..127, UI shows labels)
  try {
    const p = document.getElementById("slider-patterns")?.noUiSlider?.get?.();
    if (p && typeof window.patternLabelToIndex === "function") {
      let a = window.patternLabelToIndex(p[0]);
      let b = window.patternLabelToIndex(p[1]);
      if (a > b) [a, b] = [b, a];
      a = slotOpsClamp(a, 0, 127);
      b = slotOpsClamp(b, 0, 127);
      ranges.pattern = { startIdx: a, endIdx: b, uiStart: a, uiEnd: b };
    }
  } catch (e) {}

  // Songs (1..32)
  try {
    const s = document.getElementById("slider-songs")?.noUiSlider?.get?.();
    if (s) {
      let a = parseInt(s[0], 10) || 1;
      let b = parseInt(s[1], 10) || 1;
      if (a > b) [a, b] = [b, a];
      a = slotOpsClamp(a, 1, 32);
      b = slotOpsClamp(b, 1, 32);
      ranges.song = { startIdx: a - 1, endIdx: b - 1, uiStart: a, uiEnd: b };
    }
  } catch (e) {}

  return ranges;
}

function slotOpsPatternLabel(idx) {
  return (typeof window.patternIndexToLabel === "function")
    ? window.patternIndexToLabel(idx)
    : String(idx);
}

function slotOpsClipboardSummary(clip) {
  if (!clip) return "Clipboard: empty";
  const parts = [];
  if (clip.globals?.items?.length) {
    parts.push(`G ${clip.globals.label} (${clip.globals.items.length})`);
  }
  if (clip.kits?.items?.length) {
    parts.push(`K ${clip.kits.label} (${clip.kits.items.length})`);
  }
  if (clip.patterns?.items?.length) {
    parts.push(`P ${clip.patterns.label} (${clip.patterns.items.length})`);
  }
  if (clip.songs?.items?.length) {
    parts.push(`S ${clip.songs.label} (${clip.songs.items.length})`);
  }
  return parts.length ? `Clipboard: ${parts.join(" | ")}` : "Clipboard: empty";
}

function slotOpsEnsureLibraries() {
  if (!Array.isArray(window.globalLibrary)) window.globalLibrary = new Array(8).fill(null);
  if (!Array.isArray(window.kitLibrary)) window.kitLibrary = new Array(64).fill(null);
  if (!Array.isArray(window.allPatternSlots)) window.allPatternSlots = new Array(128).fill(null);
  if (!Array.isArray(window.allSongSlots)) window.allSongSlots = new Array(32).fill(null);
}

function slotOpsRebuildUI(types) {
  if (types.global && typeof window.buildGlobalSlotsUI === "function") window.buildGlobalSlotsUI();
  if (types.kit && typeof window.buildKitSlotsUI === "function") window.buildKitSlotsUI();
  if (types.pattern) {
    if (typeof window.buildTopPatternBanksUI === "function") window.buildTopPatternBanksUI();
    if (typeof window.attachBankSlotClickHandlers === "function") window.attachBankSlotClickHandlers();
    if (typeof window.colorizeSlots === "function") window.colorizeSlots();
  }
  if (types.song && typeof window.buildSongSlotsUI === "function") window.buildSongSlotsUI();
  if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();
  window.SlotStrip?.renderIndicators?.();
}

function onClickSlotsCopy() {
  const types = slotOpsGetSelectedTypes();
  if (!slotOpsHasAnyTypeSelected(types)) {
    alert("Select at least one slot category (G/K/P/S) to Copy.");
    return;
  }
  slotOpsEnsureLibraries();
  const r = slotOpsGetRanges();

  const clip = {
    createdAt: Date.now(),
    globals: null,
    kits: null,
    patterns: null,
    songs: null
  };

  if (types.global) {
    const items = [];
    for (let i = r.global.startIdx; i <= r.global.endIdx; i++) items.push(safeClone(window.globalLibrary[i]));
    clip.globals = { items, label: `${r.global.uiStart}–${r.global.uiEnd}` };
  }

  if (types.kit) {
    const items = [];
    for (let i = r.kit.startIdx; i <= r.kit.endIdx; i++) items.push(safeClone(window.kitLibrary[i]));
    clip.kits = { items, label: `${r.kit.uiStart}–${r.kit.uiEnd}` };
  }

  if (types.pattern) {
    const items = [];
    for (let i = r.pattern.startIdx; i <= r.pattern.endIdx; i++) items.push(safeClone(window.allPatternSlots[i]));
    clip.patterns = { items, label: `${slotOpsPatternLabel(r.pattern.startIdx)}–${slotOpsPatternLabel(r.pattern.endIdx)}` };
  }

  if (types.song) {
    const items = [];
    for (let i = r.song.startIdx; i <= r.song.endIdx; i++) items.push(safeClone(window.allSongSlots[i]));
    clip.songs = { items, label: `${r.song.uiStart}–${r.song.uiEnd}` };
  }

  window.slotOpsClipboard = clip;
  slotOpsSetStatus(slotOpsClipboardSummary(clip));
}

function onClickSlotsPaste() {
  const clip = window.slotOpsClipboard;
  if (!clip || (!clip.globals && !clip.kits && !clip.patterns && !clip.songs)) {
    alert("Clipboard is empty. Click Copy first.");
    return;
  }

  const types = slotOpsGetSelectedTypes();
  if (!slotOpsHasAnyTypeSelected(types)) {
    alert("Select at least one slot category (G/K/P/S) to Paste.");
    return;
  }

  slotOpsEnsureLibraries();
  const r = slotOpsGetRanges();

  // Determine whether we will overwrite any existing destination slots
  let overwriteCount = 0;
  const countFilled = (arr, startIdx, endIdx) => {
    let c = 0;
    for (let i = startIdx; i <= endIdx; i++) if (arr[i]) c++;
    return c;
  };

  if (types.global && clip.globals?.items?.length) overwriteCount += countFilled(window.globalLibrary, r.global.startIdx, r.global.endIdx);
  if (types.kit && clip.kits?.items?.length) overwriteCount += countFilled(window.kitLibrary, r.kit.startIdx, r.kit.endIdx);
  if (types.pattern && clip.patterns?.items?.length) overwriteCount += countFilled(window.allPatternSlots, r.pattern.startIdx, r.pattern.endIdx);
  if (types.song && clip.songs?.items?.length) overwriteCount += countFilled(window.allSongSlots, r.song.startIdx, r.song.endIdx);

  if (overwriteCount > 0) {
    if (!confirm(`Overwrite existing data in ${overwriteCount} destination slot(s)?`)) return;
  }

  let didAnything = false;

  // Globals
  if (types.global && clip.globals?.items?.length) {
    const src = clip.globals.items;
    const srcLen = src.length;
    const destLen = r.global.endIdx - r.global.startIdx + 1;
    for (let j = 0; j < destLen; j++) {
      const destIdx = r.global.startIdx + j;
      const v = safeClone(src[j % srcLen]);
      if (v && typeof v === "object") v.globalPosition = destIdx;
      window.globalLibrary[destIdx] = v;
    }
    didAnything = true;
  }

  // Kits
  if (types.kit && clip.kits?.items?.length) {
    const src = clip.kits.items;
    const srcLen = src.length;
    const destLen = r.kit.endIdx - r.kit.startIdx + 1;
    for (let j = 0; j < destLen; j++) {
      const destIdx = r.kit.startIdx + j;
      const v = safeClone(src[j % srcLen]);
      if (v && typeof v === "object") {
        if (typeof v.colorIndex === "number") v.colorIndex = destIdx;
        if (v.data && typeof v.data === "object") v.data.sysexPosition = destIdx;
      }
      window.kitLibrary[destIdx] = v;
    }
    didAnything = true;
  }

  // Patterns
  if (types.pattern && clip.patterns?.items?.length) {
    const src = clip.patterns.items;
    const srcLen = src.length;
    const destLen = r.pattern.endIdx - r.pattern.startIdx + 1;
    for (let j = 0; j < destLen; j++) {
      const destIdx = r.pattern.startIdx + j;
      const v = safeClone(src[j % srcLen]);
      if (v && typeof v === "object" && v.pattern && typeof v.pattern === "object") {
        v.pattern.origPos = destIdx;
        v.pattern.patternNumber = destIdx;
      }
      window.allPatternSlots[destIdx] = v;
    }
    didAnything = true;
  }

  // Songs
  if (types.song && clip.songs?.items?.length) {
    const src = clip.songs.items;
    const srcLen = src.length;
    const destLen = r.song.endIdx - r.song.startIdx + 1;
    for (let j = 0; j < destLen; j++) {
      const destIdx = r.song.startIdx + j;
      const v = safeClone(src[j % srcLen]);
      if (v && typeof v === "object") v.slotIndex = destIdx;
      window.allSongSlots[destIdx] = v;
    }
    didAnything = true;
  }

  if (!didAnything) {
    alert("Nothing to paste for the currently selected GKPS types.\n\nTip: Copy with those types checked first.");
    return;
  }

  slotOpsRebuildUI(types);
  slotOpsSetStatus(`Pasted. ${slotOpsClipboardSummary(clip)}`);
}

function onClickSlotsClear() {
  const types = slotOpsGetSelectedTypes();
  if (!slotOpsHasAnyTypeSelected(types)) {
    alert("Select at least one slot category (G/K/P/S) to Clear.");
    return;
  }

  slotOpsEnsureLibraries();
  const r = slotOpsGetRanges();

  const countFilled = (arr, startIdx, endIdx) => {
    let c = 0;
    for (let i = startIdx; i <= endIdx; i++) if (arr[i]) c++;
    return c;
  };

  let filled = 0;
  if (types.global) filled += countFilled(window.globalLibrary, r.global.startIdx, r.global.endIdx);
  if (types.kit) filled += countFilled(window.kitLibrary, r.kit.startIdx, r.kit.endIdx);
  if (types.pattern) filled += countFilled(window.allPatternSlots, r.pattern.startIdx, r.pattern.endIdx);
  if (types.song) filled += countFilled(window.allSongSlots, r.song.startIdx, r.song.endIdx);

  // If the user is clearing a range that is already empty, keep it quiet.
  if (filled === 0) {
    slotOpsSetStatus("Nothing to clear in the selected range(s).");
    return;
  }

  if (!confirm(`Clear ${filled} filled slot(s) in the selected range(s)?`)) return;

  if (types.global) {
    for (let i = r.global.startIdx; i <= r.global.endIdx; i++) window.globalLibrary[i] = null;
  }
  if (types.kit) {
    for (let i = r.kit.startIdx; i <= r.kit.endIdx; i++) window.kitLibrary[i] = null;
  }
  if (types.pattern) {
    for (let i = r.pattern.startIdx; i <= r.pattern.endIdx; i++) window.allPatternSlots[i] = null;
  }
  if (types.song) {
    for (let i = r.song.startIdx; i <= r.song.endIdx; i++) window.allSongSlots[i] = null;
  }

  slotOpsRebuildUI(types);
  slotOpsSetStatus("Cleared selected range(s). Clipboard unchanged.");
}

function clearBlinkingSlots() {
  document.querySelectorAll(".blink-selected").forEach(el => el.classList.remove("blink-selected"));
}

function updateSlotUI(type, slotIndex, status) {
  const slotEl = document.querySelector(`.${type}-slot[data-idx="${slotIndex}"]`);
  if (!slotEl) return;

  slotEl.classList.remove("processing-slot", "processed-slot", "failed-slot");
  if (status === "processing") {
    slotEl.classList.add("processing-slot");
  } else if (status === "done") {
    slotEl.classList.add("processed-slot");
    setTimeout(() => slotEl.classList.remove("processed-slot"), 500);
  } else if (status === "failed") {
    slotEl.classList.add("failed-slot");
    setTimeout(() => slotEl.classList.remove("failed-slot"), 1500);
  }
}

// updateBulkProgress defined...
function onClickResetGlobal() {
  if (!confirm("WARNING: This will reset the global panel data to default. Continue?")) {
    return;
  }
  window.resetGlobal();
  if (typeof window.initGlobalUI === "function") {
    window.initGlobalUI();
  }
  if (typeof updatePanelHeaderColors === "function") {
    updatePanelHeaderColors();
  }
}

function onClickResetKit() {
  if (!confirm("WARNING: This will delete current Kit data. Continue?")) return;
  const kRange = document.getElementById("slider-kits").noUiSlider.get();
  let kSlot = parseInt(kRange[0], 10) || 1;
  doBulkResetKitsIncremental(kSlot, kSlot);
}

function onClickResetPattern() {
  if (!confirm("WARNING: This will delete current Pattern data. Continue?")) return;
  const pRange = document.getElementById("slider-patterns").noUiSlider.get();
  let pSlot = window.patternLabelToIndex(pRange[0]);
  doBulkResetPatternsIncremental(pSlot, pSlot);
}

function onClickResetSong() {
  if (!confirm("WARNING: This will delete current Song data. Continue?")) return;
  const sRange = document.getElementById("slider-songs").noUiSlider.get();
  let sSlot = parseInt(sRange[0], 10) || 1;
  doBulkResetSongsIncremental(sSlot, sSlot);
  updatePanelHeaderColors();
}

async function doBulkResetGlobalsIncremental(start, end) {
  let s = Math.max(1, start),
      e = Math.min(8, end);
  if (s > e) [s, e] = [e, s];
  for (let i = e; i >= s; i--) {
    window.globalLibrary[i - 1] = null;
    if (typeof buildGlobalSlotsUI === "function") buildGlobalSlotsUI();
    await new Promise(res => setTimeout(res, 1));
  }
}

async function doBulkResetKitsIncremental(start, end) {
  let s = Math.max(1, start),
      e = Math.min(64, end);
  for (let i = e; i >= s; i--) {
    window.kitLibrary[i - 1] = null;
    if (typeof buildKitSlotsUI === "function") buildKitSlotsUI();
    await new Promise(res => setTimeout(res, 1));
  }
}

async function doBulkResetPatternsIncremental(start, end) {
  let s = Math.max(0, start),
      e = Math.min(127, end);
  for (let i = e; i >= s; i--) {
    window.allPatternSlots[i] = null;
    const slot = document.querySelector(`.pattern-slot[data-idx="${i}"]`);
    if (slot) {
      slot.classList.remove("filled");
      slot.classList.add("empty-slot");
      slot.style.backgroundColor = "#ddd";
    }
    await new Promise(res => setTimeout(res, 5));
  }
  if (typeof buildTopPatternBanksUI === "function") buildTopPatternBanksUI();
  if (typeof attachBankSlotClickHandlers === "function") attachBankSlotClickHandlers();
  if (typeof colorizeSlots === "function") colorizeSlots();
}

async function doBulkResetSongsIncremental(start, end) {
  let s = Math.max(1, start),
      e = Math.min(32, end);
  for (let i = e; i >= s; i--) {
    window.allSongSlots[i - 1] = null;
    if (typeof buildSongSlotsUI === "function") buildSongSlotsUI();
    await new Promise(res => setTimeout(res, 1));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// bulk.js
// ──────────────────────────────────────────────────────────────────────────────

/** Receive Globals sequentially, waiting for each 0xF7 before next */
async function doBulkReceiveGlobals(start, end) {
  const signal = window.bulkAbortController.signal;
  const s = Math.max(1, start), e = Math.min(8, end), total = e - s + 1;

  // Bulk receive should populate libraries only — it must NOT “load” a Global into
  // the editor or mark any slot as selected. Otherwise the UI looks like a slot
  // was clicked (e.g. Global #8 blinking after Receive All).
  for (let i = s; i <= e; i++) {
    const idx = i - 1;
    if (signal.aborted) break;
    updateSlotUI("global", idx, "processing");
    try {
      // 1) get raw payload
      const payload = await requestGlobalDumpAsync(idx, signal);

      // 2) decode, but suppress any auto-select / UI refresh side-effects
      const prevImporting = !!window.__mddtImporting;
      const prevSelected  = window.selectedGlobalSlotIndex;
      const prevBase      = window.currentBaseChannel;
      const prevGlobal    = window.globalData ? safeClone(window.globalData) : window.globalData;

      let decoded = null;
      window.__mddtImporting = true;
      try {
        window.receiveGlobalDump(payload);
        decoded = safeClone(window.globalData);
      } finally {
        // Restore the live buffer/selection so “receive” does not behave like “load”
        window.selectedGlobalSlotIndex = prevSelected;
        window.currentBaseChannel      = prevBase;
        window.globalData              = prevGlobal;
        window.__mddtImporting         = prevImporting;
      }

      // 3) stash decoded in the library for coloring/UI (normalize & clear dirty if possible)
      if (decoded) {
        if (typeof window.commitGlobalSlot === "function") {
          window.commitGlobalSlot(idx, decoded, { silent: true });
        } else {
          window.globalLibrary[idx] = decoded;
        }
      }

      if (typeof window.buildGlobalSlotsUI === "function") window.buildGlobalSlotsUI();

      // 4) mark done
      updateSlotUI("global", idx, "done");
    } catch (err) {
      if (err.message === "Aborted") break;
      updateSlotUI("global", idx, "failed");
    }
    updateBulkProgress("Receiving Globals", i - s + 1, total);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// bulk.js
// ──────────────────────────────────────────────────────────────────────────────

/** Receive Kits sequentially, then build & color the UI just like your old code did */
async function doBulkReceiveKits(start, end) {
  const signal = window.bulkAbortController.signal;
  const s      = Math.max(1, start);
  const e      = Math.min(64, end);
  const total  = e - s + 1;

  for (let i = s; i <= e; i++) {
    const idx = i - 1;
    if (signal.aborted) break;

     if (i > s) {
      await cancellableDelay(getBulkDelay(), signal);
    }

    // 1) Mark it as “processing”
    updateSlotUI("kit", idx, "processing");

    try {
      // 2) Wait for the SysEx payload
      const payload = await requestKitDumpAsync(idx, signal);

      // 2.5) Fast-path: if the kit is empty, avoid the full decode.
      // This matches the existing semantics (empty → null slot), but is much faster.
      const emptyQuick = fastIsKitDumpEmpty(payload);
      if (emptyQuick === true) {
        window.kitLibrary[idx] = null;
        if (typeof window.updateKitSlotUI === "function") {
          window.updateKitSlotUI(idx);
        }
        updateSlotUI("kit", idx, "done");
        updateBulkProgress("Receiving Kits", i - s + 1, total);
        continue;
      }

      // 3) Feed it into your normal “receive” logic
      window.receiveKitDump(payload);

      // 4) Push into your library, copy & color-index
      window.kitLibrary[idx] = window.isKitEmpty(window.kit)
        ? null
        : {
            // Use structuredClone when available so TypedArrays (if any) and
            // nested objects survive a bulk receive without being mangled by
            // JSON.stringify/parse.
            data: safeClone(window.kit),
            colorIndex: idx
          };

      // 5) Incremental UI update (avoid rebuilding the entire slot strip per kit)
      if (typeof window.updateKitSlotUI === "function") {
        window.updateKitSlotUI(idx);
      } else if (typeof window.buildKitSlotsUI === "function") {
        window.buildKitSlotsUI();
      }

      // 6) Finally mark it “done”
      updateSlotUI("kit", idx, "done");
    } catch (err) {
      if (err.message === "Aborted") break;
      // mark failure in UI
      updateSlotUI("kit", idx, "failed");
    }

    // 7) Advance your progress bar
    updateBulkProgress("Receiving Kits", i - s + 1, total);

    // 8) (Optional) small safety delay
  }

  // Ensure patterns re-color at least once after kit changes.
  // (Full initUI at the end of Receive All also does this, but this makes
  // stand-alone kit receives behave nicely.)
  if (typeof window.colorizeSlots === "function") {
    window.colorizeSlots();
  }
}

/** Receive Patterns sequentially, then assign & color them */
// ────────────────
// 2) Promise-driven bulk loop for patterns
// ────────────────
async function doBulkReceivePatterns(start, end) {
  const signal = window.bulkAbortController.signal;
  const s      = Math.max(0, start);
  const e      = Math.min(127, end);
  const total  = e - s + 1;

  const canUpdatePatternSlotUI = (typeof window.updatePatternSlotUI === "function");

  for (let i = s; i <= e; i++) {
    if (signal.aborted) break;

    // 1) mark slot UI
    updateSlotUI("pattern", i, "processing");

    try {
      // 2) wait for the assembled payload
      const payload = await requestPatternDumpAsync(i, signal);

      // 2.5) Fast-path: detect truly empty patterns without full decode.
      // Empty patterns still arrive as full-size dumps; decoding them is expensive.
      const emptyQuick = fastIsPatternDumpEmpty(payload);
      if (emptyQuick === true) {
        window.allPatternSlots[i] = null;
        if (canUpdatePatternSlotUI) window.updatePatternSlotUI(i);
        updateSlotUI("pattern", i, "done");
        updateBulkProgress("Receiving Patterns", i - s + 1, total);
        const delayUsed = getBulkDelay(50);
        await cancellableDelay(delayUsed, signal);
        continue;
      }

      // 3) decode into window.pattern
      window.receivePatternDump(payload, window.pattern);

      // 4) store into your master array
      window.pattern.origPos        = i;
      window.pattern.patternNumber = i;
      window.allPatternSlots[i] = window.isPatternEmpty(window.pattern)
        ? null
        : {
            kit: null,
            pattern: safeClone(window.pattern),
            kitColorIndex: Math.max(
              0,
              Math.min(63, window.pattern.assignedKitNumber || 0)
            )
          };

      // 5) Incremental UI update (avoid rebuilding the entire pattern bank UI per slot)
      if (canUpdatePatternSlotUI) window.updatePatternSlotUI(i);

      // 6) done!
      updateSlotUI("pattern", i, "done");
    } catch (err) {
      if (err.message === "Aborted") break;
      updateSlotUI("pattern", i, "failed");
      console.error(`[ERROR][PATTERNS] slot ${i} failed:`, err);
    }

    // 7) progress bar
    updateBulkProgress("Receiving Patterns", i - s + 1, total);

    // 8) small safety delay
    const delayUsed = getBulkDelay(50);
    await cancellableDelay(delayUsed, signal);
  }

  // Fallback if incremental updater isn't available
  if (!canUpdatePatternSlotUI && typeof window.buildTopPatternBanksUI === "function") {
    window.buildTopPatternBanksUI();
    if (typeof window.attachBankSlotClickHandlers === "function") {
      window.attachBankSlotClickHandlers();
    }
  }

  // One-time recolor after the batch.
  if (typeof window.colorizeSlots === "function") {
    window.colorizeSlots();
  }

  // finally, re-enable buttons if you disabled them (guarded)
  if (typeof window.disableImportExportButtons === "function") {
    window.disableImportExportButtons(false);
  }
}

/** Receive Songs sequentially, decode & color each slot */
async function doBulkReceiveSongs(start, end) {
  const signal = window.bulkAbortController.signal;
  const s      = Math.max(1, start);
  const e      = Math.min(32, end);
  const total  = e - s + 1;

  for (let i = s; i <= e; i++) {
    const idx = i - 1;
    if (signal.aborted) break;

    // 1) Show “processing” on this slot
    updateSlotUI("song", idx, "processing");

    try {
      // 2) Request the dump
      // requestSongDumpAsync returns the *song sysex body* starting at messageId (0x69)
      // and including the trailing 0xF7, which is exactly what receiveSongDump expects.
      const sysexBody = await requestSongDumpAsync(idx, signal);

      // 3) Decode & store (receiveSongDump already updates allSongSlots + UI)
      window.receiveSongDump(sysexBody, {});

      // 6) Mark “done”
      updateSlotUI("song", idx, "done");
    } catch (err) {
      if (err.message === "Aborted") break;
      // on error, mark “failed”
      updateSlotUI("song", idx, "failed");
    }

    // 7) Advance the progress bar
    updateBulkProgress("Receiving Songs", i - s + 1, total);

    // 8) Tiny safety delay (optional)
    await cancellableDelay(getBulkDelay(), signal);
  }
}

/** Send Globals sequentially, marking each slot as processed (wire-drain aligned) */
async function doBulkSendGlobals(start, end) {
  const signal = window.bulkAbortController.signal;
  const s = Math.max(1, start), e = Math.min(8, end), total = e - s + 1;

  for (let i = s; i <= e; i++) {
    const idx = i - 1;
    if (signal.aborted) break;

        // wait only *between* slots, not before the first
    if (i > s) await cancellableDelay(getBulkDelay(), signal);

    const obj = window.globalLibrary[idx];
    updateSlotUI("global", idx, obj ? "processing" : "failed");
    if (!obj) {
      updateBulkProgress("Sending Globals", i - s + 1, total);
      continue;
    }

    obj.globalPosition = idx;

    // NEW: wire-clock per slot
    window.MidiWireClock.reset();

    // send dump + instruct device to load to idx
    sendWireCounted(window.createGlobalDump(obj));
    sendWireCounted(new Uint8Array([...window.MD_SYSEX_HEADER, 0x56, idx & 0x07, 0xF7]));

    // align UI with physical wire drain
    await window.MidiWireClock.waitForDrain(signal);

    updateSlotUI("global", idx, "done");
    updateBulkProgress("Sending Globals", i - s + 1, total);
  }
}

/** Send Kits sequentially (wire-drain aligned) */
async function doBulkSendKits(start, end) {
  const signal = window.bulkAbortController.signal;
  const s = Math.max(1, start), e = Math.min(64, end), total = e - s + 1;

  for (let i = s; i <= e; i++) {
    const idx = i - 1;
    if (signal.aborted) break;

        // wait only *between* slots, not before the first
    if (i > s) await cancellableDelay(getBulkDelay(), signal);

    const kit = window.kitLibrary[idx];
    updateSlotUI("kit", idx, kit ? "processing" : "failed");
    if (!kit) {
      updateBulkProgress("Sending Kits", i - s + 1, total);
      continue;
    }

    kit.data.sysexPosition = idx;

    // NEW: wire-clock per slot
    window.MidiWireClock.reset();

    // send dump + instruct device to load to idx
    sendWireCounted(window.createKitDump(kit.data));
    sendWireCounted(new Uint8Array([...window.MD_SYSEX_HEADER, 0x58, idx & 0x3F, 0xF7]));

    // align UI with physical wire drain
    await window.MidiWireClock.waitForDrain(signal);

    updateSlotUI("kit", idx, "done");
    updateBulkProgress("Sending Kits", i - s + 1, total);
  }
}

/** Send Patterns sequentially (wire-drain aligned) */
async function doBulkSendPatterns(start, end) {
  const signal = window.bulkAbortController.signal;
  const s = Math.max(0, start), e = Math.min(127, end), total = e - s + 1;

  for (let i = s; i <= e; i++) {
    if (signal.aborted) break;

        // wait only *between* slots, not before the first
    if (i > s) await cancellableDelay(getBulkDelay(), signal);
const slot = window.allPatternSlots[i];
    updateSlotUI("pattern", i, slot && slot.pattern ? "processing" : "failed");
    if (slot && slot.pattern) {
      slot.pattern.origPos       = i;
      slot.pattern.patternNumber = i;

      // NEW: wire-clock per slot
      window.MidiWireClock.reset();

      // send dump only for patterns
      sendWireCounted(window.createPatternDump(slot.pattern));

      // align UI with physical wire drain
      await window.MidiWireClock.waitForDrain(signal);

      updateSlotUI("pattern", i, "done");
    }

    updateBulkProgress("Sending Patterns", i - s + 1, total);
  }
}

/** Send Songs sequentially (wire-drain aligned) */
async function doBulkSendSongs(start, end) {
  const signal = window.bulkAbortController.signal;
  const s = Math.max(1, start), e = Math.min(32, end);
  const toSend = [];

  // First, build the list of “non-null” songs
  for (let i = s; i <= e; i++) {
    const song = window.allSongSlots[i - 1];
    if (song) {
      song.slotIndex = i - 1;
      toSend.push(song);
    }
  }

  const total = toSend.length;
  for (let i = 0; i < total; i++) {
    if (signal.aborted) break;

        // wait only *between* slots, not before the first
    if (i > 0) await cancellableDelay(getBulkDelay(), signal);

    const song = toSend[i];
    updateSlotUI("song", song.slotIndex, "processing");

    // NEW: wire-clock per slot
    window.MidiWireClock.reset();

    // send dump + load-to-slot command
    sendWireCounted(window.createSongDump(song));
    sendWireCounted(new Uint8Array([...window.MD_SYSEX_HEADER, 0x6C, song.slotIndex & 0x1F, 0xF7]));

    // align UI with physical wire drain
    await window.MidiWireClock.waitForDrain(signal);

    updateSlotUI("song", song.slotIndex, "done");
    updateBulkProgress("Sending Songs", i + 1, total);
  }
}

/* NOTE: There are two updateBulkProgress declarations in this file.
   The following one (Tools header gradient) will shadow the earlier
   “bulkProgress-<type>” element updater. Keeping both to preserve your
   current behavior & calls. */
function updateBulkProgress(operation, current, total) {
  const header = document.querySelector('.panel[data-panel-id="midi"] .panel-header');
  if (!header) return;
  const percentage = Math.round((current / total) * 100);
  const isDark = document.body.classList.contains("dark-mode");
  const progressColor = isDark ? "#2c3a4f" : "#e0f0ff";
  const defaultColor = isDark ? "#3c4043" : "#eee";
  header.textContent = `${operation}: ${current} / ${total}`;
  header.style.background = `linear-gradient(90deg, ${progressColor} ${percentage}%, ${defaultColor} ${percentage}%)`;
}

"use strict";

function debounce(func, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delay);
  };
}

function updateSliderPositions(values, handle) {
  window.currentSliderValues = values;
}

function initRangeSliders() {
  const setReadout = (key, values) => {
    const startEl = document.getElementById(`pos-${key}-start`);
    const endEl = document.getElementById(`pos-${key}-end`);
    if (startEl) startEl.textContent = values?.[0] ?? "";
    if (endEl) endEl.textContent = values?.[1] ?? "";
  };

  const wireSlider = (el, key) => {
    if (!el || !el.noUiSlider) return;

    // Initial fill
    try {
      setReadout(key, el.noUiSlider.get());
    } catch (e) {}

    el.noUiSlider.on(
      "update",
      debounce((values, handle) => {
        updateSliderPositions(values, handle);
        setReadout(key, values);
      }, 50)
    );
  };

  const globalsEl = document.getElementById("slider-globals");
  if (globalsEl && !globalsEl.noUiSlider) {
    noUiSlider.create(globalsEl, {
      start: [1, 8],
      connect: true,
      step: 1,
      range: { min: 1, max: 8 },
      // Prevent noUiSlider's default "1.00" formatting.
      format: {
        to: (value) => String(Math.round(Number(value))),
        from: (value) => Number(value)
      }
    });
  }
  wireSlider(globalsEl, "globals");

  const songsEl = document.getElementById("slider-songs");
  if (songsEl && !songsEl.noUiSlider) {
    noUiSlider.create(songsEl, {
      start: [1, 32],
      connect: true,
      step: 1,
      range: { min: 1, max: 32 },
      // Prevent noUiSlider's default "1.00" formatting.
      format: {
        to: (value) => String(Math.round(Number(value))),
        from: (value) => Number(value)
      }
    });
  }
  wireSlider(songsEl, "songs");

  const kitsEl = document.getElementById("slider-kits");
  if (kitsEl && !kitsEl.noUiSlider) {
    noUiSlider.create(kitsEl, {
      start: [1, 64],
      connect: true,
      step: 1,
      range: { min: 1, max: 64 },
      // Prevent noUiSlider's default "1.00" formatting.
      format: {
        to: (value) => String(Math.round(Number(value))),
        from: (value) => Number(value)
      }
    });
  }
  wireSlider(kitsEl, "kits");

  const patternsEl = document.getElementById("slider-patterns");
  if (patternsEl && !patternsEl.noUiSlider) {
    noUiSlider.create(patternsEl, {
      start: [0, 127],
      connect: true,
      step: 1,
      range: { min: 0, max: 127 },
      format: {
        to: (value) => {
          const rounded = Math.round(value);
          return window.patternIndexToLabel ? window.patternIndexToLabel(rounded) : String(rounded);
        },
        from: (value) => {
          if (!isNaN(value)) return Number(value);
          return window.patternLabelToIndex(String(value));
        }
      }
    });
  }
  wireSlider(patternsEl, "patterns");

  // One-time hover affordances for the Tools panel.
  // (Pulses the relevant slider handles when hovering Receive/Send/Reset buttons.)
  initToolsHoverPulses();
}

function initToolsHoverPulses() {
  if (window.__mddtToolsHoverPulsesInited) return;
  window.__mddtToolsHoverPulsesInited = true;

  const SLIDERS = {
    globals: "slider-globals",
    kits: "slider-kits",
    patterns: "slider-patterns",
    songs: "slider-songs"
  };

  const CHECKS_BY_SCOPE = {
    receive: {
      globals: "recvCheckG",
      kits: "recvCheckK",
      patterns: "recvCheckP",
      songs: "recvCheckS"
    },
    send: {
      globals: "sendCheckG",
      kits: "sendCheckK",
      patterns: "sendCheckP",
      songs: "sendCheckS"
    },
    reset: {
      globals: "resetCheckG",
      kits: "resetCheckK",
      patterns: "resetCheckP",
      songs: "resetCheckS"
    }
  };

  const clearPulses = () => {
    document
      .querySelectorAll(".noUi-handle.mddt-pulse")
      .forEach(el => el.classList.remove("mddt-pulse"));
  };

  const getHandles = (key) => {
    const sliderId = SLIDERS[key];
    const sliderEl = sliderId ? document.getElementById(sliderId) : null;
    if (!sliderEl) return { lower: null, upper: null };
    return {
      lower: sliderEl.querySelector(".noUi-handle-lower"),
      upper: sliderEl.querySelector(".noUi-handle-upper")
    };
  };

  const pulse = (key, which) => {
    const { lower, upper } = getHandles(key);
    if (!lower && !upper) return;
    if (which === "both") {
      lower && lower.classList.add("mddt-pulse");
      upper && upper.classList.add("mddt-pulse");
      return;
    }
    // default: lower
    lower && lower.classList.add("mddt-pulse");
  };

  const getScopeKeys = (scope) => {
    const ids = CHECKS_BY_SCOPE[scope];
    if (!ids) return Object.keys(SLIDERS);
    const keys = [];
    for (const key of Object.keys(SLIDERS)) {
      const id = ids[key];
      const el = id ? document.getElementById(id) : null;
      if (!el) continue;
      if (el.checked) keys.push(key);
    }
    return keys.length ? keys : Object.keys(SLIDERS);
  };

  const btns = document.querySelectorAll("[data-pulse-target]");
  btns.forEach(btn => {
    btn.addEventListener("mouseenter", () => {
      const target = btn.dataset.pulseTarget;
      const scope = btn.dataset.pulseScope;
      const which = btn.dataset.pulseWhich || "lower";
      clearPulses();

      if (target === "all") {
        getScopeKeys(scope).forEach(k => pulse(k, "both"));
        return;
      }
      if (SLIDERS[target]) {
        pulse(target, which);
      }
    });
    btn.addEventListener("mouseleave", clearPulses);
    btn.addEventListener("blur", clearPulses);
  });
}

