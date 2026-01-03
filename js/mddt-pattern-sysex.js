/*
 * mddt-pattern-sysex.js
 */

(function () {
  "use strict";

  // ====================== UNDO SUPPORT ======================
  // Before any mutating action on a single track, call recordTrackUndo(t).
  // Before any action that affects the entire pattern, call recordPatternUndo().

  function recordTrackUndo(t) {
    window.lastUndoRecord = {
      type: "patternTrack",
      trackOrRow: t,
      oldData: window.getPatternTrackData(t)
    };
  }

  function recordPatternUndo() {
    window.lastUndoRecord = {
      type: "pattern",
      oldPattern: JSON.parse(JSON.stringify(window.pattern))
    };
  }

  // ---------------- GLOBAL UNDO ON CMD+Z ----------------
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
      if (window.activePanel !== "pattern") return;
      e.preventDefault();
      const ur = window.lastUndoRecord;
      if (!ur) return;

      if (ur.type === "patternTrack") {
        // restore just that one track…
        applyPatternTrackData(ur.trackOrRow, ur.oldData);
        // rebuild only its bitfields & locks UI
        buildLockAndBitfieldUI_SYSEX();
        // re‑highlight & recolor
        highlightPatternTrack(ur.trackOrRow);
        updatePanelHeaderColors();
      } else if (ur.type === "pattern") {
        // full‑pattern undo: restore everything
        window.pattern = JSON.parse(JSON.stringify(ur.oldPattern));
        if (typeof window.initUI === "function") { window.initUI(); }
        updatePanelHeaderColors();
      }

      // clear undo record so further Z’s are no‑ops
      window.lastUndoRecord = { type: null, trackOrRow: -1, oldData: null };
    }
  }, true);

  // ====================== CORE HELPERS ======================
  const patternsAreEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Pattern Index Helpers
  window.patternIndexToLabel = function (index) {
    const bankLabels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const bank = Math.floor(index / 16);
    const number = (index % 16) + 1;
    return bankLabels[bank] + String(number).padStart(2, "0");
  };

  window.patternLabelToIndex = function (label) {
    const match = label.match(/^([A-H])(\d{2})$/);
    if (!match) {
      console.warn("patternLabelToIndex: unexpected label format", label);
      return 0;
    }
    const letter = match[1];
    const num = parseInt(match[2], 10) || 1;
    const bankMapping = { A: 0, B: 16, C: 32, D: 48, E: 64, F: 80, G: 96, H: 112 };
    return bankMapping[letter] + (num - 1);
  };

  // ---------------- CONSTANTS ----------------
  const TOTAL_PLENGTH_32 = 2763;
  const TOTAL_PLENGTH_64 = 5278;

  const OFFSETS_32 = {
    MSG_ID: 6,
    VERSION: 7,
    REVISION: 8,
    ORIG_POS: 9,
    TRIG_PATTERN: 0x0A,
    LEN_TRIG_PATTERN: 74,
    LOCK_PATTERN: 0x54,
    LEN_LOCK_PATTERN: 74,
    ACCENT_PATTERN: 0x9E,
    LEN_ACCENT_PATTERN: 19,
    ACCENT_AMOUNT: 0xB1,
    PATTERN_LENGTH: 0xB2,
    TEMPO_MULTIPLIER: 0xB3,
    SCALE: 0xB4,
    KIT: 0xB5,
    LOCK_COUNT: 0xB6,
    LOCKS: 0xB7,
    LEN_LOCKS: 2341,
    EXTRA_PATTERN: 2524,
    LEN_EXTRA_PATTERN: 234,
    CHECKSUM_HI: 2758,
    CHECKSUM_LO: 2759,
    PLENGTH_HI: 2760,
    PLENGTH_LO: 2761,
    SYSEX_END: 2762
  };

  const OFFSETS_64 = {
    MSG_ID: 6,
    VERSION: 7,
    REVISION: 8,
    ORIG_POS: 9,
    TRIG_PATTERN: 0x0A,
    LEN_TRIG_PATTERN: 74,
    LOCK_PATTERN: 0x54,
    LEN_LOCK_PATTERN: 74,
    ACCENT_PATTERN: 0x9E,
    LEN_ACCENT_PATTERN: 19,
    ACCENT_AMOUNT: 0xB1,
    PATTERN_LENGTH: 0xB2,
    TEMPO_MULTIPLIER: 0xB3,
    SCALE: 0xB4,
    KIT: 0xB5,
    LOCK_COUNT: 0xB6,
    LOCKS: 0xB7,
    LEN_LOCKS: 2341,
    EXTRA_TRIG: 2524,
    LEN_EXTRA_TRIG: 74,
    EXTRA_LOCK: 2598,
    LEN_EXTRA_LOCK: 74,
    EXTRA_ACCENT: 2672,
    LEN_EXTRA_ACCENT: 19,
    SKIP_6: 2691,
    SKIP_1: 2697,
    EXTRA_MATRIX: 2698,
    LEN_EXTRA_MATRIX: 2341,
    EXTRA_PATTERN: 5039,
    LEN_EXTRA_PATTERN: 234,
    PCHECKSUM_HI: 5273,
    PCHECKSUM_LO: 5274,
    PLENGTH_HI: 5275,
    PLENGTH_LO: 5276,
    PSYSEX_END: 5277
  };

  // ---------------- 7-BIT ENCODING & HELPERS ----------------
  const encode7Bit = (rawBytes) => {
    const out = [];
    for (let i = 0; i < rawBytes.length; i += 7) {
      const block = rawBytes.slice(i, i + 7);
      let header = 0;
      for (let j = 0; j < block.length; j++) {
        if (block[j] & 0x80) header |= (1 << (6 - j));
      }
      out.push(header & 0x7F);
      for (let j = 0; j < block.length; j++) {
        out.push(block[j] & 0x7F);
      }
    }
    return new Uint8Array(out);
  };

  function encode7BitLockBlock(raw64) {
    const out = new Uint8Array(74);
    let inPos = 0, outPos = 0;
    for (let group = 0; group < 9; group++) {
      let header = 0;
      for (let j = 0; j < 7; j++) {
        const b = inPos < 64 ? raw64[inPos++] : 0;
        if (b & 0x80) header |= 1 << (6 - j);
        out[outPos + 1 + j] = b & 0x7F;
      }
      out[outPos] = header & 0x7F;
      outPos += 8;
    }
    let header = 0;
    const b = inPos < 64 ? raw64[inPos++] : 0;
    if (b & 0x80) header |= 1 << 6;
    out[outPos] = header & 0x7F;
    out[outPos + 1] = b & 0x7F;
    return out;
  }

  const padOrSlice = (arr, length, fillValue = 0) => {
    if (arr.length === length) return arr;
    if (arr.length > length) return arr.slice(0, length);
    const out = new Uint8Array(length);
    out.fill(fillValue);
    out.set(arr, 0);
    return out;
  };

  const readBE32 = (arr, off) => {
    if (off + 3 >= arr.length) return 0;
    return (
      ((arr[off] << 24) >>> 0) |
      ((arr[off + 1] << 16) >>> 0) |
      ((arr[off + 2] << 8) >>> 0) |
      (arr[off + 3] >>> 0)
    );
  };

  const writeBE32 = (arr, off, val) => {
    arr[off] = (val >>> 24) & 0xff;
    arr[off + 1] = (val >>> 16) & 0xff;
    arr[off + 2] = (val >>> 8) & 0xff;
    arr[off + 3] = val & 0xff;
  };

  const flattenMatrix = (mat, rows, cols) => {
    const out = new Uint8Array(rows * cols);
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out[idx++] = (mat[r] && typeof mat[r][c] === "number") ? mat[r][c] : 0xff;
      }
    }
    return out;
  };

  // ---------------- SWING & ACCENT UTILITIES ----------------
  const convertSwingToMdFormat = (swingVal) => {
    let pct = 50 + (swingVal / 127) * 30;
    pct = Math.max(50, Math.min(pct, 80));
    return Math.round(((pct - 50) / 30) * 9830);
  };

  const convertSwingRawTo0_127 = (raw) => {
    let pct = 50 + (raw / 9830) * 30;
    pct = Math.max(50, Math.min(pct, 80));
    return Math.max(0, Math.min(Math.round(((pct - 50) / 30) * 127), 127));
  };

  const encodeAccentNib = (a) =>
    Math.round((a & 0x0f) * (127 / 15)) & 0x7f;

  // ---------------- BUILDING TRIG & LOCK BLOCKS ----------------
  function buildTriggerBlock(pattern, startStep, endStep) {
    const totalTracks = 16;
    const out = new Uint8Array(totalTracks * 4);
    const steps = endStep - startStep;
    for (let t = 0; t < totalTracks; t++) {
      let w = 0;
      for (let i = 0; i < steps && i < 32; i++) {
        const step = startStep + i;
        if (step >= 64) break;
        const bIndex = step >>> 3;
        const bPos = step & 7;
        if (pattern.trigBitsPerTrack[t][bIndex] & (1 << bPos)) {
          w |= 1 << i;
        }
      }
      writeBE32(out, t * 4, w >>> 0);
    }
    return out;
  }

  function buildLockBlock(pattern, isExtra = false) {
    const out = new Uint8Array(16 * 4);
    const lockMasks = pattern[isExtra ? "lockMasks2" : "lockMasks"];
    if (!lockMasks) {
      for (let i = 0; i < 16; i++) {
        writeBE32(out, i * 4, 0);
      }
      return out;
    }
    for (let t = 0; t < 16; t++) {
      writeBE32(out, t * 4, lockMasks[t] >>> 0);
    }
    return out;
  }

  function extract32Bits(bits, startStep, L) {
    let w = 0;
    for (let i = 0; i < 32; i++) {
      const s = startStep + i;
      if (s >= L || s >= 64) break;
      const bIndex = s >>> 3;
      const bPos = s & 7;
      if (bits[bIndex] & (1 << bPos)) {
        w |= 1 << i;
      }
    }
    return w >>> 0;
  }

  function buildAccentBlock(pattern, startStep) {
    const block = new Uint8Array(16);
    const accentGlobal = pattern.accentBitsGlobal || new Uint8Array(8);
    const slideGlobal  = pattern.slideBitsGlobal  || new Uint8Array(8);
    const swingGlobal  = pattern.swingBitsGlobal  || new Uint8Array(8);
    const aw = extract32Bits(accentGlobal, startStep, pattern.length);
    const sw = extract32Bits(slideGlobal, startStep, pattern.length);
    const ww = extract32Bits(swingGlobal, startStep, pattern.length);
    const wr = convertSwingToMdFormat(pattern.swingAmount || 0);
    writeBE32(block,  0, aw >>> 0);
    writeBE32(block,  4, sw >>> 0);
    writeBE32(block,  8, ww >>> 0);
    writeBE32(block, 12, wr >>> 0);
    return block;
  }

  function buildExtraPatternBlock(pattern) {
    const raw = new Uint8Array(51 * 4);
    writeBE32(raw, 0, pattern.accentEditAll ? 1 : 0);
    writeBE32(raw, 4, pattern.slideEditAll ? 1 : 0);
    writeBE32(raw, 8, pattern.swingEditAll ? 1 : 0);
    let off = 12;
    for (let t = 0; t < 16; t++) {
      const trackAcc = pattern.accentBitsPerTrack[t] || new Uint8Array(8);
      const mask = extract32Bits(trackAcc, 0, pattern.length);
      writeBE32(raw, off, mask >>> 0);
      off += 4;
    }
    for (let t = 0; t < 16; t++) {
      const trackSlide = pattern.slideBitsPerTrack[t] || new Uint8Array(8);
      const mask = extract32Bits(trackSlide, 0, pattern.length);
      writeBE32(raw, off, mask >>> 0);
      off += 4;
    }
    for (let t = 0; t < 16; t++) {
      const trackSwing = pattern.swingBitsPerTrack[t] || new Uint8Array(8);
      const mask = extract32Bits(trackSwing, 0, pattern.length);
      writeBE32(raw, off, mask >>> 0);
      off += 4;
    }
    return raw;
  }

  // ---------------- UPDATE LOCK MATRICES ----------------
  function updateLockMatricesFromLocks(pattern) {
    const L = pattern.length >>> 0;
    if (!pattern.locks || !pattern.locks.length) {
      pattern.lockCount = 0;
      pattern.paramMatrixMain = Array.from({ length: 64 }, () =>
        new Uint8Array(32).fill(0xff)
      );
      pattern.paramMatrixExtra = L > 32
        ? Array.from({ length: 64 }, () => new Uint8Array(32).fill(0xff))
        : null;
      pattern.lockMasks = new Array(16).fill(0);
      pattern.lockMasks2 = (L > 32) ? new Array(16).fill(0) : null;
      return;
    }
    const allCombos = [];
    for (const lk of pattern.locks) {
      if (lk.step >= L) continue;
      if (lk.paramID < 1 || lk.paramID > 24) continue;
      const comboKey = (lk.track << 8) | (lk.paramID & 0xff);
      if (!allCombos.includes(comboKey)) allCombos.push(comboKey);
    }
    allCombos.sort((a, b) => a - b);

    pattern.paramMatrixMain = Array.from({ length: 64 }, () =>
      new Uint8Array(32).fill(0xff)
    );
    pattern.paramMatrixExtra = L > 32
      ? Array.from({ length: 64 }, () => new Uint8Array(32).fill(0xff))
      : null;
    pattern.lockMasks = new Array(16).fill(0);
    pattern.lockMasks2 = (L > 32) ? new Array(16).fill(0) : null;
    const usedRows = Math.min(64, allCombos.length);
    for (let rowIndex = 0; rowIndex < usedRows; rowIndex++) {
      const comboKey = allCombos[rowIndex];
      const track = (comboKey >>> 8) & 0xff;
      const paramID = comboKey & 0xff;
      const mainRow  = pattern.paramMatrixMain[rowIndex];
      const extraRow = pattern.paramMatrixExtra ? pattern.paramMatrixExtra[rowIndex] : null;
      const paramBitIndex = paramID - 1;
      pattern.lockMasks[track] |= (1 << paramBitIndex);
      if (pattern.lockMasks2) {
        pattern.lockMasks2[track] |= (1 << paramBitIndex);
      }
      for (const lk of pattern.locks) {
        if (lk.track !== track || lk.paramID !== paramID) continue;
        const s = lk.step >>> 0;
        if (s < L) {
          if (s < 32) {
            mainRow[s] = lk.paramVal & 0x7f;
          } else if (extraRow) {
            extraRow[s - 32] = lk.paramVal & 0x7f;
          }
        }
      }
    }
    pattern.lockCount = usedRows;
  }
  window.updateLockMatricesFromLocks = updateLockMatricesFromLocks;

  // ---------------- CREATE (ENCODE) PATTERN DUMP ----------------
  function createPatternDump(pattern) {
    if (!pattern.length) pattern.length = 16;
    updateLockMatricesFromLocks(pattern);
    const use64 = pattern.length > 32;
    const dump = new Uint8Array(use64 ? TOTAL_PLENGTH_64 : TOTAL_PLENGTH_32);
    dump.fill(0);

    const hdr = window.MD_SYSEX_HEADER || [0xf0, 0x00, 0x20, 0x3c, 0x02, 0x00];
    dump.set(hdr, 0);

    if (use64) {
      dump[OFFSETS_64.MSG_ID]     = window.MD_PATTERN_MESSAGE_ID;
      dump[OFFSETS_64.VERSION]    = (pattern.version != null ? pattern.version : 3) & 0x7f;
      dump[OFFSETS_64.REVISION]   = (pattern.revision != null ? pattern.revision : 1) & 0x7f;
      dump[OFFSETS_64.ORIG_POS]   = (pattern.origPos != null ? pattern.origPos : 0) & 0x7f;
    } else {
      dump[OFFSETS_32.MSG_ID]     = window.MD_PATTERN_MESSAGE_ID;
      dump[OFFSETS_32.VERSION]    = (pattern.version != null ? pattern.version : 3) & 0x7f;
      dump[OFFSETS_32.REVISION]   = (pattern.revision != null ? pattern.revision : 1) & 0x7f;
      dump[OFFSETS_32.ORIG_POS]   = (pattern.origPos != null ? pattern.origPos : 0) & 0x7f;
    }

    const len = pattern.length >>> 0;

    // Main block (steps 0..31)
    const trigA  = buildTriggerBlock(pattern, 0, Math.min(32, len));
    const trig7A = encode7Bit(trigA);
    if (use64) {
      dump.set(trig7A, OFFSETS_64.TRIG_PATTERN);
    } else {
      dump.set(trig7A, OFFSETS_32.TRIG_PATTERN);
    }

    const lockA  = buildLockBlock(pattern, false);
    const lock7A = encode7BitLockBlock(lockA);
    if (use64) {
      dump.set(lock7A, OFFSETS_64.LOCK_PATTERN);
    } else {
      dump.set(lock7A, OFFSETS_32.LOCK_PATTERN);
    }

    const ascA  = buildAccentBlock(pattern, 0);
    const asc7A = padOrSlice(
      encode7Bit(ascA),
      use64 ? OFFSETS_64.LEN_ACCENT_PATTERN : OFFSETS_32.LEN_ACCENT_PATTERN
    );
    if (use64) {
      dump.set(asc7A, OFFSETS_64.ACCENT_PATTERN);
    } else {
      dump.set(asc7A, OFFSETS_32.ACCENT_PATTERN);
    }

    // Meta fields
    if (use64) {
      dump[OFFSETS_64.ACCENT_AMOUNT]       = encodeAccentNib(pattern.accentAmount || 0);
      dump[OFFSETS_64.PATTERN_LENGTH]      = len & 0x7f;
      dump[OFFSETS_64.TEMPO_MULTIPLIER]    = (pattern.tempoMult || 0) & 0x7f;
      dump[OFFSETS_64.SCALE]               = (pattern.scale || 0) & 0x7f;
      dump[OFFSETS_64.KIT]                 = (pattern.assignedKitNumber != null ? pattern.assignedKitNumber : 0) & 0x7f;
      dump[OFFSETS_64.LOCK_COUNT]          = pattern.lockCount & 0x7f;
    } else {
      dump[OFFSETS_32.ACCENT_AMOUNT]       = encodeAccentNib(pattern.accentAmount || 0);
      dump[OFFSETS_32.PATTERN_LENGTH]      = len & 0x7f;
      dump[OFFSETS_32.TEMPO_MULTIPLIER]    = (pattern.tempoMult || 0) & 0x7f;
      dump[OFFSETS_32.SCALE]               = (pattern.scale || 0) & 0x7f;
      dump[OFFSETS_32.KIT]                 = (pattern.assignedKitNumber != null ? pattern.assignedKitNumber : 0) & 0x7f;
      dump[OFFSETS_32.LOCK_COUNT]          = pattern.lockCount & 0x7f;
    }

    // Param Matrix Main
    const numColsMain = 32;
    if (!pattern.paramMatrixMain) {
      pattern.paramMatrixMain = Array.from({ length: 64 }, () =>
        new Uint8Array(numColsMain).fill(0xff)
      );
    } else {
      if (pattern.paramMatrixMain.length < 64) {
        const missing = 64 - pattern.paramMatrixMain.length;
        const padRows = Array.from({ length: missing }, () => new Uint8Array(numColsMain).fill(0xff));
        pattern.paramMatrixMain = pattern.paramMatrixMain.concat(padRows);
      } else if (pattern.paramMatrixMain.length > 64) {
        pattern.paramMatrixMain = pattern.paramMatrixMain.slice(0, 64);
      }
    }
    const mainFlat = flattenMatrix(pattern.paramMatrixMain, 64, numColsMain);
    const main7 = padOrSlice(
      encode7Bit(mainFlat),
      use64 ? OFFSETS_64.LEN_LOCKS : OFFSETS_32.LEN_LOCKS,
      0x7f
    );
    if (use64) {
      dump.set(main7, OFFSETS_64.LOCKS);
    } else {
      dump.set(main7, OFFSETS_32.LOCKS);
    }

    // Handle extra 64-step patterns
    if (use64 && len > 32) {
      const trigB  = buildTriggerBlock(pattern, 32, Math.min(64, len));
      const trig7B = padOrSlice(encode7Bit(trigB), OFFSETS_64.LEN_EXTRA_TRIG);
      dump.set(trig7B, OFFSETS_64.EXTRA_TRIG);

      const lockB  = buildLockBlock(pattern, true);
      const lock7B = encode7BitLockBlock(lockB);
      dump.set(lock7B, OFFSETS_64.EXTRA_LOCK);

      const ascB  = buildAccentBlock(pattern, 32);
      const asc7B = padOrSlice(encode7Bit(ascB), OFFSETS_64.LEN_EXTRA_ACCENT);
      dump.set(asc7B, OFFSETS_64.EXTRA_ACCENT);

      dump.set(new Uint8Array(6), OFFSETS_64.SKIP_6);
      dump.set(new Uint8Array(1), OFFSETS_64.SKIP_1);

      if (!pattern.paramMatrixExtra) {
        pattern.paramMatrixExtra = Array.from({ length: 64 }, () =>
          new Uint8Array(numColsMain).fill(0xff)
        );
      } else {
        if (pattern.paramMatrixExtra.length < 64) {
          const missing = 64 - pattern.paramMatrixExtra.length;
          const padRows = Array.from({ length: missing }, () => new Uint8Array(numColsMain).fill(0xff));
          pattern.paramMatrixExtra = pattern.paramMatrixExtra.concat(padRows);
        } else if (pattern.paramMatrixExtra.length > 64) {
          pattern.paramMatrixExtra = pattern.paramMatrixExtra.slice(0, 64);
        }
      }
      const extraFlat = flattenMatrix(pattern.paramMatrixExtra, 64, numColsMain);
      const extra7 = padOrSlice(encode7Bit(extraFlat), OFFSETS_64.LEN_EXTRA_MATRIX, 0x7f);
      dump.set(extra7, OFFSETS_64.EXTRA_MATRIX);
    }

    // Extra block
    const extraBlockRaw = buildExtraPatternBlock(pattern);
    const extraBlock7 = padOrSlice(
      encode7Bit(extraBlockRaw),
      use64 ? OFFSETS_64.LEN_EXTRA_PATTERN : OFFSETS_32.LEN_EXTRA_PATTERN
    );
    if (use64) {
      dump.set(extraBlock7, OFFSETS_64.EXTRA_PATTERN);
    } else {
      dump.set(extraBlock7, OFFSETS_32.EXTRA_PATTERN);
    }

    // Checksum
    let sum = 0;
    if (use64) {
      for (let i = OFFSETS_64.ORIG_POS; i < OFFSETS_64.PCHECKSUM_HI; i++) {
        sum += dump[i];
      }
      sum &= 0x3fff;
      dump[OFFSETS_64.PCHECKSUM_HI] = (sum >> 7) & 0x7f;
      dump[OFFSETS_64.PCHECKSUM_LO] = sum & 0x7f;
      const docLen = TOTAL_PLENGTH_64 - 10;
      dump[OFFSETS_64.PLENGTH_HI] = (docLen >> 7) & 0x7f;
      dump[OFFSETS_64.PLENGTH_LO] = docLen & 0x7f;
      dump[OFFSETS_64.PSYSEX_END] = 0xf7;
    } else {
      for (let i = OFFSETS_32.ORIG_POS; i < OFFSETS_32.CHECKSUM_HI; i++) {
        sum += dump[i];
      }
      sum &= 0x3fff;
      dump[OFFSETS_32.CHECKSUM_HI] = (sum >> 7) & 0x7f;
      dump[OFFSETS_32.CHECKSUM_LO] = sum & 0x7f;
      const docLen = TOTAL_PLENGTH_32 - 10;
      dump[OFFSETS_32.PLENGTH_HI] = (docLen >> 7) & 0x7f;
      dump[OFFSETS_32.PLENGTH_LO] = docLen & 0x7f;
      dump[OFFSETS_32.SYSEX_END] = 0xf7;
    }

    return dump;
  }
  window.createPatternDump = createPatternDump;

  window.storePatternSysex = (pNum, pattern) => {
    pattern = pattern || window.pattern;
    pattern.origPos = pNum & 0x7f;
    return createPatternDump(pattern);
  };

  window.requestPatternSysex = (pNum) =>
    new Uint8Array([
      0xf0, 0x00, 0x20, 0x3c, 0x02, 0x00,
      window.MD_PATTERN_REQUEST_ID, (pNum & 0x7f),
      0xf7
    ]);

  // ---------------- PATTERN DUMP DECODING ----------------
  window.receivePatternDump = function (fullData, patternObj) {
    if (window.blockSlotWrites) {
      return;
    }
    const idx67 = fullData.indexOf(0x67);
    if (idx67 < 0) return;
    const data = fullData.slice(idx67);
    if (data.length < 10) return;

    const version = data[1] & 0x7f;
    const revision = data[2] & 0x7f;
    const slot = data[3] & 0x7f;
    patternObj = patternObj || window.pattern;
    patternObj.version = version;
    patternObj.revision = revision;
    patternObj.origPos = slot;
    let idx = 4;

    const decode7Bit = (enc, off, length) => {
      const portion = enc.slice(off, off + length);
      const out = [];
      let i = 0;
      while (i < portion.length) {
        const head = portion[i++] & 0x7f;
        const chunkCount = Math.min(7, portion.length - i);
        for (let j = 0; j < chunkCount; j++) {
          const db = portion[i++];
          const msb = (head >> (6 - j)) & 1;
          out.push(((msb << 7) | (db & 0x7f)) >>> 0);
        }
      }
      return out;
    };

    const parseTrigBlockBE32 = (decoded) => {
      const arr = new Array(16).fill(0);
      for (let t = 0; t < 16; t++) {
        const off = t * 4;
        if (off + 3 < decoded.length) {
          arr[t] = readBE32(decoded, off) >>> 0;
        }
      }
      return arr;
    };

    const parse16x4_BE32 = (decoded) => {
      const out = [];
      for (let t = 0; t < 16; t++) {
        const off = t * 4;
        out[t] = off + 3 < decoded.length ? readBE32(decoded, off) >>> 0 : 0;
      }
      return out;
    };

    const parse64x32 = (decoded) => {
      const arr2D = [];
      let pos = 0;
      for (let r = 0; r < 64; r++) {
        const row = decoded.slice(pos, pos + 32);
        pos += 32;
        arr2D.push(row);
      }
      return arr2D;
    };

    const decodeAccentNib = (b) => {
      const tab = [0,8,1,9,2,10,3,11,4,12,5,13,6,14,7,15];
      const nib = b & 0xf;
      const i2 = tab.indexOf(nib);
      return i2 < 0 ? 0 : i2;
    };

    const trig7 = decode7Bit(data, idx, OFFSETS_64.LEN_TRIG_PATTERN);
    idx += OFFSETS_64.LEN_TRIG_PATTERN;
    const trigArr = parseTrigBlockBE32(trig7);

    const encLockBlockA = data.slice(idx, idx + OFFSETS_64.LEN_LOCK_PATTERN);
    idx += OFFSETS_64.LEN_LOCK_PATTERN;
    const decode7BitLockBlock = (encoded74) => {
      const raw64 = new Uint8Array(64);
      let inPos = 0, outPos = 0;
      for (let group = 0; group < 9; group++) {
        if (group < 8) {
          const header = encoded74[inPos++];
          for (let j = 0; j < 7; j++) {
            const dataByte = encoded74[inPos++];
            const msb = (header >> (6 - j)) & 1;
            raw64[outPos++] = ((msb << 7) | (dataByte & 0x7f)) & 0xff;
          }
        } else {
          const header = encoded74[inPos++];
          for (let j = 0; j < 7; j++) {
            if (inPos >= 74 - 2) break;
            const dataByte = encoded74[inPos++];
            const msb = (header >> (6 - j)) & 1;
            raw64[outPos++] = ((msb << 7) | (dataByte & 0x7f)) & 0xff;
          }
        }
      }
      const finalHeader = encoded74[inPos++];
      const finalData = encoded74[inPos++];
      const msb = (finalHeader >> 6) & 1;
      raw64[outPos++] = ((msb << 7) | (finalData & 0x7f)) & 0xff;
      return raw64;
    };
    const raw64A = decode7BitLockBlock(encLockBlockA);
    const lockMasks = parse16x4_BE32(raw64A);

    const asc7 = decode7Bit(data, idx, OFFSETS_64.LEN_ACCENT_PATTERN);
    idx += OFFSETS_64.LEN_ACCENT_PATTERN;
    const aw = readBE32(asc7, 0);
    const sw = readBE32(asc7, 4);
    const ww = readBE32(asc7, 8);
    const wr = readBE32(asc7, 12);

    patternObj.swingRaw = wr;
    patternObj.swingAmount = convertSwingRawTo0_127(wr);

    if (idx + 6 <= data.length) {
      const accNib = data[idx++] & 0x7f;
      const patLength = data[idx++] & 0x7f;
      const tempoMult = data[idx++] & 0x7f;
      const sc = data[idx++] & 0x7f;
      const kitAssign = data[idx++] & 0x7f;
      const lockCount = data[idx++] & 0x7f;
      patternObj.accentAmount = decodeAccentNib(accNib);
      patternObj.length = patLength;
      patternObj.tempoMult = tempoMult;
      patternObj.scale = sc;
      patternObj.assignedKitNumber = kitAssign;
    }

    const main7Decoded = decode7Bit(data, idx, OFFSETS_64.LEN_LOCKS);
    idx += OFFSETS_64.LEN_LOCKS;
    const paramMain = parse64x32(main7Decoded);

    if (patternObj.length > 32) {
      const t2 = decode7Bit(data, idx, OFFSETS_64.LEN_EXTRA_TRIG);
      idx += OFFSETS_64.LEN_EXTRA_TRIG;
      const trigArr2 = parseTrigBlockBE32(t2);

      const encLockBlockB = data.slice(idx, idx + OFFSETS_64.LEN_EXTRA_LOCK);
      idx += OFFSETS_64.LEN_EXTRA_LOCK;
      const raw64B = decode7BitLockBlock(encLockBlockB);
      const lockMasks2 = parse16x4_BE32(raw64B);

      const a2 = decode7Bit(data, idx, OFFSETS_64.LEN_EXTRA_ACCENT);
      idx += OFFSETS_64.LEN_EXTRA_ACCENT;
      const aw2 = readBE32(a2, 0);
      const sw2 = readBE32(a2, 4);
      const ww2 = readBE32(a2, 8);
      const wr2 = readBE32(a2, 12);

      idx += OFFSETS_64.SKIP_6;
      idx += OFFSETS_64.SKIP_1;

      const pmx2 = decode7Bit(data, idx, OFFSETS_64.LEN_EXTRA_MATRIX);
      idx += OFFSETS_64.LEN_EXTRA_MATRIX;
      const paramExtra = parse64x32(pmx2);

      patternObj.trigPatterns2 = trigArr2;
      patternObj.lockMasks2 = lockMasks2;
      patternObj.accentWord2 = aw2;
      patternObj.slideWord2 = sw2;
      patternObj.swingWord2 = ww2;
      patternObj.swingRaw2 = wr2;
      patternObj.paramMatrixExtra = paramExtra;
    }

    if (idx + OFFSETS_64.LEN_EXTRA_PATTERN <= data.length) {
      const x7 = decode7Bit(data, idx, OFFSETS_64.LEN_EXTRA_PATTERN);
      idx += OFFSETS_64.LEN_EXTRA_PATTERN;
      const valA = readBE32(x7, 0);
      const valS = readBE32(x7, 4);
      const valW = readBE32(x7, 8);
      patternObj.accentEditAll = !!valA;
      patternObj.slideEditAll  = !!valS;
      patternObj.swingEditAll  = !!valW;
      let offs = 12;
      patternObj.trackAccentMasks = [];
      patternObj.trackSlideMasks = [];
      patternObj.trackSwingMasks = [];
      for (let t = 0; t < 16; t++) {
        patternObj.trackAccentMasks[t] = readBE32(x7, offs); offs += 4;
      }
      for (let t = 0; t < 16; t++) {
        patternObj.trackSlideMasks[t] = readBE32(x7, offs); offs += 4;
      }
      for (let t = 0; t < 16; t++) {
        patternObj.trackSwingMasks[t] = readBE32(x7, offs); offs += 4;
      }
    }

    patternObj.trigPatterns = trigArr;
    patternObj.lockMasks = lockMasks;
    patternObj.accentWord = aw;
    patternObj.slideWord = sw;
    patternObj.swingWord = ww;
    patternObj.swingRaw = wr;
    patternObj.paramMatrixMain = paramMain;

    function reconstructFromParsed(p) {
      const len = p.length || 16;
      p.trigBitsPerTrack = [];
      for (let t = 0; t < 16; t++) {
        p.trigBitsPerTrack[t] = new Uint8Array(8);
      }
      const applyTrigBlock = (arr32, startStep) => {
        for (let t = 0; t < 16; t++) {
          let w = arr32[t] >>> 0;
          for (let i = 0; i < 32; i++) {
            if (w & (1 << i)) {
              const step = startStep + i;
              if (step < len) {
                const bIndex = step >>> 3;
                const bPos = step & 7;
                p.trigBitsPerTrack[t][bIndex] |= (1 << bPos);
              }
            }
          }
        }
      };
      applyTrigBlock(p.trigPatterns, 0);
      if (len > 32 && p.trigPatterns2) {
        applyTrigBlock(p.trigPatterns2, 32);
      }

      p.accentBitsGlobal = new Uint8Array(8);
      p.slideBitsGlobal = new Uint8Array(8);
      p.swingBitsGlobal = new Uint8Array(8);
      const fillGlobal = (bitsArr, word, start, end) => {
        const count = end - start;
        for (let i = 0; i < count && i < 32; i++) {
          if (word & (1 << i)) {
            const st = start + i;
            if (st >= len) break;
            const bIndex = st >>> 3;
            const bPos = st & 7;
            bitsArr[bIndex] |= (1 << bPos);
          }
        }
      };
      fillGlobal(p.accentBitsGlobal, p.accentWord, 0, Math.min(32, len));
      if (p.accentWord2 != null) {
        fillGlobal(p.accentBitsGlobal, p.accentWord2, 32, Math.min(64, len));
      }
      fillGlobal(p.slideBitsGlobal, p.slideWord, 0, Math.min(32, len));
      if (p.slideWord2 != null) {
        fillGlobal(p.slideBitsGlobal, p.slideWord2, 32, Math.min(64, len));
      }
      fillGlobal(p.swingBitsGlobal, p.swingWord, 0, Math.min(32, len));
      if (p.swingWord2 != null) {
        fillGlobal(p.swingBitsGlobal, p.swingWord2, 32, Math.min(64, len));
      }

      p.accentBitsPerTrack = Array.from({ length: 16 }, () => new Uint8Array(8));
      p.slideBitsPerTrack  = Array.from({ length: 16 }, () => new Uint8Array(8));
      p.swingBitsPerTrack  = Array.from({ length: 16 }, () => new Uint8Array(8));

      const fillTrackBits = (bits8, mask32, maxSteps) => {
        const w = mask32 >>> 0;
        for (let s = 0; s < maxSteps && s < 64; s++) {
          if (w & (1 << s)) {
            const bIndex = s >>> 3;
            const bPos = s & 7;
            bits8[bIndex] |= (1 << bPos);
          }
        }
      };
      if (p.trackAccentMasks) {
        for (let t = 0; t < 16; t++) {
          fillTrackBits(p.accentBitsPerTrack[t], p.trackAccentMasks[t], len);
        }
      }
      if (p.trackSlideMasks) {
        for (let t = 0; t < 16; t++) {
          fillTrackBits(p.slideBitsPerTrack[t], p.trackSlideMasks[t], len);
        }
      }
      if (p.trackSwingMasks) {
        for (let t = 0; t < 16; t++) {
          fillTrackBits(p.swingBitsPerTrack[t], p.trackSwingMasks[t], len);
        }
      }

      const buildLocksFromMatrices = (pp) => {
        const locksOut = [];
        const L = pp.length || 16;
        if (!pp.paramMatrixMain) return locksOut;
        let rowIndex = 0;
        for (let tr = 0; tr < 16; tr++) {
          const mask = pp.lockMasks ? (pp.lockMasks[tr] >>> 0) : 0;
          for (let paramID = 0; paramID < 24; paramID++) {
            if ((mask >> paramID) & 1) {
              const row = pp.paramMatrixMain[rowIndex];
              for (let s = 0; s < Math.min(32, L); s++) {
                const v = row[s];
                if (v !== 0xff) {
                  locksOut.push({ track: tr, step: s, paramID: paramID + 1, paramVal: v });
                }
              }
              rowIndex++;
            }
          }
        }
        if (L > 32 && pp.lockMasks2 && pp.paramMatrixExtra) {
          let row2Index = 0;
          for (let tr = 0; tr < 16; tr++) {
            const mask2 = pp.lockMasks2[tr] >>> 0;
            for (let paramID = 0; paramID < 24; paramID++) {
              if ((mask2 >> paramID) & 1) {
                const rowE = pp.paramMatrixExtra[row2Index];
                for (let s = 32; s < Math.min(64, L); s++) {
                  const col = s - 32;
                  const v = rowE[col];
                  if (v !== 0xff) {
                    locksOut.push({ track: tr, step: s, paramID: paramID + 1, paramVal: v });
                  }
                }
                row2Index++;
              }
            }
          }
        }
        return locksOut;
      };
      p.locks = buildLocksFromMatrices(p);
    }
    reconstructFromParsed(patternObj);
    // Normalize arrays post-decode so legacy (array) vs modern (TypedArray) behave the same
    if (typeof window.ensurePatternTrackArraysExist === "function") {
      window.ensurePatternTrackArraysExist();
    }


    const kitInput = document.getElementById("assignedKitNumber");
    if (kitInput) {
      kitInput.value = String(patternObj.assignedKitNumber + 1);
    }
    patternObj.rawPattern = new Uint8Array(fullData);

    // vNext DOM-compat: keep Pattern slot library + slot strip in sync on single receives.
    //
    // The legacy UI expects allPatternSlots to reflect received dumps even when
    // the dump was requested outside of a bulk flow (e.g., single/range receives).
    try {
      const slotIndex = (typeof patternObj.origPos === "number") ? (patternObj.origPos & 0x7F) : null;
      if (slotIndex != null && slotIndex >= 0 && slotIndex < 128) {
        // Ensure a consistent slot index property for downstream UI code.
        patternObj.patternNumber = slotIndex;

        // Store/overwrite the slot cache.
        if (window.allPatternSlots) {
          if (window.isPatternEmpty && window.isPatternEmpty(patternObj)) {
            window.allPatternSlots[slotIndex] = null;
          } else {
            window.allPatternSlots[slotIndex] = {
              kit: null,
              pattern: JSON.parse(JSON.stringify(patternObj)),
              kitColorIndex: patternObj.assignedKitNumber || 0
            };
          }
        }

        // If this was a *single* requested pattern (not bulk), keep the selection
        // in sync so the top pattern bank highlights the active slot.
        if (window.waitingForSinglePatternDump && !window.isBulkInProgress) {
          window.selectedPatternSlotIndex = slotIndex;
        }

        // Range receives (or unsolicited dumps) won't necessarily trigger initUI(),
        // so refresh the Pattern slot strip when we're not in a bulk receive flow.
        const inBulkReceive = !!window.isBulkInProgress || (window.midiOperationState && window.midiOperationState.inboundMode === "receivingBulk");
        if (!inBulkReceive && !window.waitingForSinglePatternDump) {
          if (typeof window.buildTopPatternBanksUI === "function") window.buildTopPatternBanksUI();
          if (typeof window.attachBankSlotClickHandlers === "function") window.attachBankSlotClickHandlers();
          if (typeof window.colorizeSlots === "function") window.colorizeSlots();
          if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();
        }
      }
    } catch (e) {
      console.warn("[receivePatternDump] Slot-sync failed", e);
    }


    if (window.waitingForSinglePatternDump && !window.isBulkInProgress) {
      window.waitingForSinglePatternDump = false;
      window.pattern = patternObj;
      if (typeof window.initUI === "function") {
        window.initUI();
      }
    } else if (window.isBulkInProgress && Number.isFinite(window.bulkPatternIndex) && Number.isFinite(window.bulkPatternEnd)) {
      if (window.isPatternEmpty && window.isPatternEmpty(patternObj)) {
        if (window.allPatternSlots) {
          window.allPatternSlots[window.bulkPatternIndex] = null;
        }
      } else {
        if (typeof window.storePatternSlot === "function") {
          window.storePatternSlot(window.bulkPatternIndex);
        } else if (window.allPatternSlots) {
          window.allPatternSlots[window.bulkPatternIndex] = {
            kit: null,
            pattern: JSON.parse(JSON.stringify(patternObj)),
            kitColorIndex: patternObj.assignedKitNumber || 0
          };
        }
      }
      if (typeof window.initUI === "function") {
        window.initUI();
      }
      if (window.bulkPatternIndex < window.bulkPatternEnd) {
        window.bulkPatternIndex++;
        requestAnimationFrame(() => {
          requestOnePattern(window.bulkPatternIndex);
        });
      } else {
        window.requestingPatterns = false;
        window.isBulkInProgress = false;
        if (typeof window.initUI === "function") {
          window.initUI();
        }
      }
    }
  };

  // ---------------- SHIFT LOGIC & UI FOR PATTERN ----------------
  window.patternShiftColumns = ["step", "trig", "accent", "swing", "slide"];
  window.shiftPatternColumnIndex = 1;
  window.patternShiftMode = false;

  function getBitfield(field, t) {
    switch (field) {
      case "trig":
        return window.pattern.trigBitsPerTrack[t];
      case "accent":
        return window.pattern.accentEditAll ? window.pattern.accentBitsGlobal : window.pattern.accentBitsPerTrack[t];
      case "swing":
        return window.pattern.swingEditAll ? window.pattern.swingBitsGlobal : window.pattern.swingBitsPerTrack[t];
      case "slide":
        return window.pattern.slideEditAll ? window.pattern.slideBitsGlobal : window.pattern.slideBitsPerTrack[t];
      default:
        return null;
    }
  }

  function scrollToSelectedTrack() {
    const trackRow = document.querySelector(`.pattern-track-row[data-track-index="${window.selectedPatternTrackIndex}"]`);
    if (trackRow) {
      trackRow.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function shiftAllPatternTracks(direction) {
    for (let t = 0; t < 16; t++) {
      shiftBitfield(t, "trig", direction);
      if (!window.pattern.accentEditAll || t === 0) {
        shiftBitfield(t, "accent", direction);
      }
      if (!window.pattern.swingEditAll || t === 0) {
        shiftBitfield(t, "swing", direction);
      }
      if (!window.pattern.slideEditAll || t === 0) {
        shiftBitfield(t, "slide", direction);
      }
      shiftParamLocksOnTrack(t, direction);
    }
  }

  function shiftParamLocksOnTrack(t, shiftAmount) {
    const L = window.pattern.length || 16;
    window.pattern.locks = window.pattern.locks || [];
    for (const lk of window.pattern.locks) {
      if (lk.track !== t) continue;
      let newStep = (lk.step + shiftAmount) % L;
      if (newStep < 0) newStep += L;
      lk.step = newStep;
    }
  }

  function shiftBitfield(t, field, direction) {
    const L = window.pattern.length || 16;
    let bitsArr = getBitfield(field, t);
    if (!bitsArr || bitsArr.length < 8) {
      console.warn(`Bitfield for ${field} on track ${t} is not properly initialized.`);
      return;
    }
    let full64 = 0n;
    for (let i = 0; i < 8; i++) {
      full64 |= BigInt(bitsArr[i]) << BigInt(i * 8);
    }
    const mask = (1n << BigInt(L)) - 1n;
    let relevant = full64 & mask;
    if (direction > 0) {
      const topBit = (relevant >> BigInt(L - 1)) & 1n;
      relevant = ((relevant << 1n) & mask) | topBit;
    } else {
      const lowBit = relevant & 1n;
      relevant = (relevant >> 1n) | (lowBit << BigInt(L - 1));
      relevant &= mask;
    }
    const new64 = (full64 & ~mask) | relevant;
    for (let i = 0; i < 8; i++) {
      bitsArr[i] = Number((new64 >> BigInt(i * 8)) & 0xffn);
    }
  }

  function applyPatternShiftHighlight(forceOff) {
    const highlightElems = document.querySelectorAll(".shift-param-highlight");
    highlightElems.forEach(el => el.classList.remove("shift-param-highlight"));
    if (forceOff || !window.patternShiftMode) return;
    const track = window.selectedPatternTrackIndex || 0;
    const colIndex = window.shiftPatternColumnIndex;
    const trackDiv = document.querySelector(`.pattern-track-row[data-track-index="${track}"]`);
    if (!trackDiv) return;
    const tbody = trackDiv.querySelector("table.pattern-step-table tbody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll("tr");
    if (rows[colIndex]) {
      const rowHeaderCell = rows[colIndex].querySelector("td");
      if (rowHeaderCell) {
        rowHeaderCell.classList.add("shift-param-highlight");
      }
    }
  }

  function patternKeydownHandler(e) {
    if (window.activePanel !== "pattern") return;

    // Don't hijack typing / slider interactions
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) {
      return;
    }
    if (e.key === "Shift") {
      if (!window.patternShiftMode) {
        window.patternShiftMode = true;
        applyPatternShiftHighlight(false);
      }
      return;
    }

    // =========== SHIFTING ALL TRACKS (Meta + ArrowLeft/ArrowRight) WITH PATTERN UNDO ===========
    if (e.metaKey && e.key === "ArrowLeft") {
      e.preventDefault();
      recordPatternUndo();
      shiftAllPatternTracks(-1);
      buildLockAndBitfieldUI_SYSEX();
      updatePanelHeaderColors();
      applyPatternShiftHighlight(false);
      highlightPatternTrack(selectedPatternTrackIndex);
      return;
    }
    if (e.metaKey && e.key === "ArrowRight") {
      e.preventDefault();
      recordPatternUndo();
      shiftAllPatternTracks(+1);
      buildLockAndBitfieldUI_SYSEX();
      updatePanelHeaderColors();
      applyPatternShiftHighlight(false);
      highlightPatternTrack(selectedPatternTrackIndex);
      return;
    }

    if (window.patternShiftMode) {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          window.shiftPatternColumnIndex =
            (window.shiftPatternColumnIndex + window.patternShiftColumns.length - 1) %
            window.patternShiftColumns.length;
          applyPatternShiftHighlight(false);
          return;
        case "ArrowDown":
          e.preventDefault();
          window.shiftPatternColumnIndex =
            (window.shiftPatternColumnIndex + 1) % window.patternShiftColumns.length;
          applyPatternShiftHighlight(false);
          return;
        case "ArrowLeft":
          e.preventDefault();
          {
            const field = window.patternShiftColumns[window.shiftPatternColumnIndex];
            let targetTrack = window.selectedPatternTrackIndex;
            if (
              (field === "accent" && window.pattern.accentEditAll) ||
              (field === "swing" && window.pattern.swingEditAll) ||
              (field === "slide" && window.pattern.slideEditAll)
            ) {
              targetTrack = 0;
            }
            if (field === "step") {
              shiftBitfield(window.selectedPatternTrackIndex, "trig", -1);
              shiftBitfield(targetTrack, "accent", -1);
              shiftBitfield(targetTrack, "swing", -1);
              shiftBitfield(targetTrack, "slide", -1);
              shiftParamLocksOnTrack(window.selectedPatternTrackIndex, -1);
            } else {
              shiftBitfield(targetTrack, field, -1);
              if (field === "trig") {
                shiftParamLocksOnTrack(window.selectedPatternTrackIndex, -1);
              }
            }
            if (typeof window.buildLockAndBitfieldUI_SYSEX === "function") {
              window.buildLockAndBitfieldUI_SYSEX();
            }
            updatePanelHeaderColors();
            applyPatternShiftHighlight(false);
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          }
          return;
        case "ArrowRight":
          e.preventDefault();
          {
            const field = window.patternShiftColumns[window.shiftPatternColumnIndex];
            let targetTrack = window.selectedPatternTrackIndex;
            if (
              (field === "accent" && window.pattern.accentEditAll) ||
              (field === "swing" && window.pattern.swingEditAll) ||
              (field === "slide" && window.pattern.slideEditAll)
            ) {
              targetTrack = 0;
            }
            if (field === "step") {
              shiftBitfield(window.selectedPatternTrackIndex, "trig", +1);
              shiftBitfield(targetTrack, "accent", +1);
              shiftBitfield(targetTrack, "swing", +1);
              shiftBitfield(targetTrack, "slide", +1);
              shiftParamLocksOnTrack(window.selectedPatternTrackIndex, +1);
            } else {
              shiftBitfield(targetTrack, field, +1);
              if (field === "trig") {
                shiftParamLocksOnTrack(window.selectedPatternTrackIndex, +1);
              }
            }
            if (typeof window.buildLockAndBitfieldUI_SYSEX === "function") {
              window.buildLockAndBitfieldUI_SYSEX();
            }
            updatePanelHeaderColors();
            applyPatternShiftHighlight(false);
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          }
          return;
      }
    } else {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const track = window.selectedPatternTrackIndex || 0;
        if (track > 0) {
          window.selectedPatternTrackIndex = track - 1;
          if (typeof window.highlightPatternTrack === "function") {
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          }
          scrollToSelectedTrack();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const track = window.selectedPatternTrackIndex || 0;
        if (track < 15) {
          window.selectedPatternTrackIndex = track + 1;
          if (typeof window.highlightPatternTrack === "function") {
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          }
          scrollToSelectedTrack();
        }
      }
    }
  }

  function patternKeyupHandler(e) {
    if (e.key === "Shift" && window.patternShiftMode) {
      window.patternShiftMode = false;
      applyPatternShiftHighlight(true);
    }
  }

  // ---------------- UI HELPER FUNCTIONS ----------------
  window.randomBitfield = function (field, t) {
    const arr = window.getBitsArray(field, t);
    if (!arr) return;
    for (let b = 0; b < 8; b++) {
      arr[b] = Math.floor(Math.random() * 256) & 0x7f;
    }
  };

  window.hasLockOnStep = window.hasLockOnStep || function (track, step) {
    if (!window.pattern.locks) return false;
    return window.pattern.locks.some(lk => lk.track === track && lk.step === step);
  };

window.clearBitfield = function (field, track) {
  window.ensurePatternTrackArraysExist();

  if (!(window.pattern.accentBitsGlobal instanceof Uint8Array)) {
    window.pattern.accentBitsGlobal = new Uint8Array(8);
  }
  if (!(window.pattern.swingBitsGlobal  instanceof Uint8Array)) {
    window.pattern.swingBitsGlobal  = new Uint8Array(8);
  }
  if (!(window.pattern.slideBitsGlobal  instanceof Uint8Array)) {
    window.pattern.slideBitsGlobal  = new Uint8Array(8);
  }

  let arr;

  switch (field) {
    case "trig":
      arr = window.pattern.trigBitsPerTrack[track];
      break;

    case "accent":
      if (window.pattern.accentEditAll) {
        window.pattern.accentBitsGlobal.fill(0);
        return;
      }
      arr = window.pattern.accentBitsPerTrack[track];
      break;

    case "swing":
      if (window.pattern.swingEditAll) {
        window.pattern.swingBitsGlobal.fill(0);
        return;
      }
      arr = window.pattern.swingBitsPerTrack[track];
      break;

    case "slide":
      if (window.pattern.slideEditAll) {
        window.pattern.slideBitsGlobal.fill(0);
        return;
      }
      arr = window.pattern.slideBitsPerTrack[track];
      break;

    default:
      console.warn(`clearBitfield: unknown field "${field}"`);
      return;
  }

  if (arr && typeof arr.fill === "function") {
    arr.fill(0);
  }

  if (field === "trig") {
    window.removeLocksForClearedTrigs();
  }
};

  window.getBitFromArray = function (arr, step) {
    if (!arr || step < 0 || step > 63) return false;
    const bIndex = step >> 3;
    const bPos = step & 7;
    return !!(arr[bIndex] & (1 << bPos));
  };

  window.setBitInArray = function (arr, step, isOn) {
    if (!arr || step < 0 || step > 63) return;
    const bIndex = step >> 3;
    const bPos = step & 7;
    if (isOn) arr[bIndex] |= (1 << bPos);
    else arr[bIndex] &= ~(1 << bPos);
  };

  window.updateCircleAppearance = function (elem, isOn, colorOn) {
    if (isOn) {
      elem.style.backgroundColor = colorOn;
      elem.style.border = "2px solid " + colorOn;
    } else {
      elem.style.backgroundColor = "#fff";
      elem.style.border = "2px solid #333";
    }
  };

  // ---------------- BUILD LOCKS/BITFIELDS UI ----------------
  window.buildLocksSubUIForTrack_SYSEX = function (t) {
    const wrap = document.createElement("div");
    wrap.className = "plock-track-locks";
    wrap.style.marginTop = "0.5em";
    wrap.style.borderTop = "1px dashed #999";
    const h5 = document.createElement("h5");
    wrap.appendChild(h5);

    const trackLocks = (window.pattern.locks || []).filter(lk => lk.track === t);
    if (trackLocks.length === 0) {
      const p = document.createElement("p");
      wrap.appendChild(p);
      return wrap;
    }
    const map = {};
    trackLocks.forEach(lk => {
      const st = lk.step;
      if (!map[st]) map[st] = [];
      map[st].push(lk);
    });
    Object.keys(map)
      .map(x => parseInt(x, 10))
      .sort((a, b) => a - b)
      .forEach(step => {
        const lockArr = map[step];
        const rowDiv = document.createElement("div");
        rowDiv.className = "plock-row";
        rowDiv.style.marginBottom = "0.3em";
        const header = document.createElement("span");
        header.className = "plock-row-header";
        header.textContent = `Step ${step + 1}`;
        rowDiv.appendChild(header);

        lockArr.forEach((_, idx) => {
          rowDiv.appendChild(window.makeParamCell_SYSEX(t, step, lockArr, idx));
        });

        const plusBtn = document.createElement("button");
        plusBtn.textContent = "+Param";
        plusBtn.onclick = () => {
          recordTrackUndo(t);
          const usedParamIDs = window.pattern.locks
            .filter(lk => lk.track === t && lk.step === step)
            .map(lk => lk.paramID);
          let newParamID = 1;
          while (usedParamIDs.includes(newParamID) && newParamID < 24) newParamID++;
          window.pattern.locks.push({ track: t, step, paramID: newParamID, paramVal: 64 });
          window.buildLockAndBitfieldUI_SYSEX();
          updatePanelHeaderColors();
          window.highlightPatternTrack(window.selectedPatternTrackIndex);
        };
        rowDiv.appendChild(plusBtn);

        const delBtn = document.createElement("button");
        delBtn.textContent = "DelRow";
        delBtn.style.marginLeft = "0.3em";
        delBtn.onclick = () => {
          window.pattern.locks = window.pattern.locks.filter(
            lx => !(lx.track === t && lx.step === step)
          );
          window.buildLockAndBitfieldUI_SYSEX();
          updatePanelHeaderColors();
          window.highlightPatternTrack(window.selectedPatternTrackIndex);
        };
        rowDiv.appendChild(delBtn);
        wrap.appendChild(rowDiv);
      });
    return wrap;
  };

  window.makeParamCell_SYSEX = function (track, step, lockArr, idx) {
    const lk = lockArr[idx];
    const cell = document.createElement("span");
    cell.className = "plock-cell";

    const machineID =
      (window.kit && window.kit.machineAssignments &&
       (window.kit.machineAssignments[track] !== undefined ? window.kit.machineAssignments[track] : 1));

    const paramSelect = document.createElement("select");

    const usedParamIDs = lockArr
      .filter((lock, i) => i !== idx)
      .map(lock => lock.paramID);

    for (let p = 1; p <= 24; p++) {
      const option = document.createElement("option");
      option.value = p;

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
      if (category === "trackFx") {
        label = getSpecialTrackFxLabel(machineID, paramIndex);
      } else if (category === "routing") {
        label = getSpecialRoutingLabel(machineID, paramIndex);
      }
      if (!label) {
        label = (typeof getParamLabel === "function"
                 ? getParamLabel(machineID, paramIndex, category)
                 : `Param#${p}`);
      }
      option.textContent = label;

      if (usedParamIDs.includes(p)) {
        option.disabled = true;
      }

      paramSelect.appendChild(option);
    }

    paramSelect.value = String(lk.paramID);
    paramSelect.addEventListener("change", function () {
      const newVal = parseInt(this.value, 10);
      lk.paramID = newVal;
      if (typeof rebuildLocksUI === "function") {
        rebuildLocksUI();
      }
    });

    cell.appendChild(paramSelect);

    const pval = document.createElement("input");
    pval.type = "range";
    pval.min = "0";
    pval.max = "127";
    pval.value = lk.paramVal;
    pval.style.width = "80px";

    const valueLabel = document.createElement("span");
    valueLabel.style.marginLeft = "4px";
    valueLabel.textContent = pval.value;

    pval.addEventListener("input", function () {
      const newValue = parseInt(this.value, 10);
      lk.paramVal = newValue;
      valueLabel.textContent = newValue;
    });

    cell.appendChild(pval);
    cell.appendChild(valueLabel);

    const xbtn = document.createElement("button");
    xbtn.textContent = "X";
    xbtn.style.marginLeft = "0.3em";
    xbtn.addEventListener("click", function () {
      recordTrackUndo(track);
      window.pattern.locks = window.pattern.locks.filter(lock => lock !== lk);
      if (typeof window.rebuildLocksUI === "function") { window.rebuildLocksUI(); }
      window.highlightPatternTrack(window.selectedPatternTrackIndex);
    });
    cell.appendChild(xbtn);

    return cell;
  };

  window.buildLockAndBitfieldUI_SYSEX = function () {
    window.ensurePatternTrackArraysExist();
    const cont = document.getElementById("bitfieldsUI");
    if (!cont) return;
    cont.innerHTML = "";

    window.removeEventListener("keydown", patternKeydownHandler);
    window.removeEventListener("keyup", patternKeyupHandler);
    window.addEventListener("keydown", patternKeydownHandler);
    window.addEventListener("keyup", patternKeyupHandler);

    const topCtrl = document.createElement("div");
    topCtrl.className = "pattern-global-controls";

    const globalToggles = [
      ["Global Accent", "accentEditAll"],
      ["Global Swing",  "swingEditAll"],
      ["Global Slide",  "slideEditAll"]
    ];

    globalToggles.forEach(([labelText, editFlag]) => {
      const isOn = !!window.pattern[editFlag];

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pattern-global-btn";
      btn.classList.toggle("is-on", isOn);
      btn.setAttribute("aria-pressed", isOn ? "true" : "false");
      btn.dataset.flag = editFlag;
      btn.textContent = labelText;

      btn.addEventListener("click", () => {
        window.pattern[editFlag] = !window.pattern[editFlag];
        window.buildLockAndBitfieldUI_SYSEX();
        updatePanelHeaderColors();
      });

      topCtrl.appendChild(btn);
    });
    cont.appendChild(topCtrl);

    const gap = document.createElement("div");
    gap.style.height = "1px";
    cont.appendChild(gap);

    for (let t = 0; t < 16; t++) {
      const trackDiv = document.createElement("div");
      trackDiv.classList.add("pattern-track-row");
      trackDiv.dataset.trackIndex = t;

      const labelRow = document.createElement("div");
      labelRow.className = "pattern-track-header";
      const labelClicker = document.createElement("span");
      labelClicker.className = "pattern-track-label";
      labelClicker.onclick = () => {
        window.onClickPatternTrack(t);
      };
      let machineName = "Machine #?";
      if (window.kit && window.kit.machineAssignments && window.getMachineName) {
        const mID = window.kit.machineAssignments[t] || 0;
        machineName = window.getMachineName(mID);
      }
      labelClicker.textContent = `Track ${t + 1} – ${machineName}`;
      labelRow.appendChild(labelClicker);
      trackDiv.appendChild(labelRow);

      const table = document.createElement("table");
      table.className = "pattern-step-table";
      const tb = document.createElement("tbody");
      table.appendChild(tb);

      let tr = document.createElement("tr");
      let td = document.createElement("td");
      td.textContent = "Step#";
      td.style.cursor = "pointer";
      td.onmouseover = () => { td.style.backgroundColor = "#eee"; };
      td.onmouseout  = () => { td.style.backgroundColor = ""; };
      td.onclick = (evt) => {
        window.selectedPatternTrackIndex = t;
        recordTrackUndo(t);
        if (evt.shiftKey) {
          ["trig", "accent", "swing", "slide"].forEach(field =>
            window.randomBitfield(field, t)
          );
        } else {
          ["trig", "accent", "swing", "slide"].forEach(field =>
            window.clearBitfield(field, t)
          );
        }
        window.removeLocksForClearedTrigs();
        window.updateLockMatricesFromLocks(window.pattern);
        window.buildLockAndBitfieldUI_SYSEX();
        updatePanelHeaderColors();
        window.highlightPatternTrack(t);
      };
      tr.appendChild(td);
      const stepLabelEvery =
        window.pattern.length <= 32 ? 1 :
        window.pattern.length <= 48 ? 4 : 8;
      for (let s = 0; s < window.pattern.length; s++) {
        let td = document.createElement("td");
        td.className = "pattern-step-num";
        const stepNum = s + 1;
        // For lengths > 32, show the *first* step of each bar group (e.g. 1, 9, 17, 25, 33…)
        // while keeping 1–32 fully labelled.
        const showLabel =
          stepLabelEvery === 1 ||
          stepNum === window.pattern.length ||
          (((stepNum - 1) % stepLabelEvery) === 0);
        td.textContent = showLabel ? String(stepNum) : "";
        td.title = `Step ${stepNum}`;
        td.style.cursor = 'pointer';
        td.onmouseover = () => {
          td.style.backgroundColor = "#eee";
        };
        td.onmouseout = () => {
          td.style.backgroundColor = "";
        };
        td.onclick = (evt) => {
          window.selectedPatternTrackIndex = t;
          if (!evt.shiftKey) return;
          const trigArr = window.pattern.trigBitsPerTrack[t];
          if (trigArr && !window.getBitFromArray(trigArr, s)) {
            window.setBitInArray(trigArr, s, true);
          }
          const existing = (window.pattern.locks || []).filter(lk => lk.track === t && lk.step === s);
          if (!existing.length) {
            window.pattern.locks.push({ track: t, step: s, paramID: 1, paramVal: 64 });
          }
          window.buildLockAndBitfieldUI_SYSEX();
          updatePanelHeaderColors();
          window.highlightPatternTrack(window.selectedPatternTrackIndex);
        };
        tr.appendChild(td);
      }
      tb.appendChild(tr);

      const rowsDef = [
        { field: "trig",   label: "Trig",  color: "#f44" },
        { field: "accent", label: "Acc",   color: "#0f0" },
        { field: "swing",  label: "Swng",  color: "#00f" },
        { field: "slide",  label: "Sld",   color: "#ff0" }
      ];
      rowsDef.forEach(({ field, label, color }) => {
        const row = document.createElement("tr");
        const rowHeader = document.createElement("td");
        rowHeader.textContent = label;
        rowHeader.style.cursor = "pointer";
        rowHeader.onmouseover = () => {
          rowHeader.style.backgroundColor = "#eee";
        };
        rowHeader.onmouseout = () => {
          rowHeader.style.backgroundColor = "";
        };
        rowHeader.onclick = (evt) => {
          window.selectedPatternTrackIndex = t;
          if (evt.shiftKey) {
            recordTrackUndo(t);
            const arr = window.getBitsArray(field, t);
            for (let b = 0; b < 8; b++) arr[b] = Math.floor(Math.random() * 256) & 0x7f;
            removeLocksForClearedTrigs();
            updateLockMatricesFromLocks(window.pattern);
            buildLockAndBitfieldUI_SYSEX();
            updatePanelHeaderColors();
            highlightPatternTrack(selectedPatternTrackIndex);
          } else {
            window.clearBitfield(field, t);
            removeLocksForClearedTrigs();
            updateLockMatricesFromLocks(window.pattern);
            window.buildLockAndBitfieldUI_SYSEX();
            updatePanelHeaderColors();
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          }
        };
        row.appendChild(rowHeader);

        const bitsArr = window.getBitsArray(field, t);
        for (let s = 0; s < window.pattern.length; s++) {
          const cell = document.createElement("td");
          cell.className = "pattern-step-cell";
          cell.title = `${label} step ${s + 1}`;

          const dot = document.createElement("div");
          dot.className = "pattern-step-dot";

          const isOn = window.getBitFromArray(bitsArr, s);
          window.updateCircleAppearance(dot, isOn, color);
          if (window.hasLockOnStep(t, s)) {
            dot.classList.add("blink-selected");
          }

          // Make the whole cell clickable (better target at 64 steps)
          cell.onclick = () => {
            window.selectedPatternTrackIndex = t;
            const nowOn = !window.getBitFromArray(bitsArr, s);
            window.setBitInArray(bitsArr, s, nowOn);
            window.updateCircleAppearance(dot, nowOn, color);

            if (field === "trig") {
              if (!nowOn) {
                removeLocksForClearedTrigs();
                window.buildLockAndBitfieldUI_SYSEX();
              }
            } else if (window.pattern[field + "EditAll"]) {
              window.buildLockAndBitfieldUI_SYSEX();
            }

            updatePanelHeaderColors();
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          };

          cell.appendChild(dot);
          row.appendChild(cell);
        }
        tb.appendChild(row);
      });

      trackDiv.appendChild(table);
      trackDiv.appendChild(window.buildLocksSubUIForTrack_SYSEX(t));
      cont.appendChild(trackDiv);
    }

    const locksContainer = document.getElementById("locksScroller");
    if (locksContainer) {
      locksContainer.innerHTML = "";
      for (let t = 0; t < 16; t++) {
        const trackLocks = (window.pattern.locks || []).filter(lk => lk.track === t);
        if (!trackLocks.length) continue;
        const trackDiv = document.createElement("div");
        trackDiv.className = "plock-track-block";
        const h4 = document.createElement("h4");
        h4.textContent = `Track ${t + 1} Parameter Locks`;
        trackDiv.appendChild(h4);

        trackLocks.sort((a, b) => a.step - b.step);
        let currentStep = null, rowDiv = null, stepLocks = [];
        trackLocks.forEach(lk => {
          if (lk.step !== currentStep) {
            if (rowDiv && stepLocks.length) {
              const plusBtn = document.createElement("button");
              plusBtn.textContent = "+Param";
              plusBtn.onclick = () => {
                recordTrackUndo(t);
                const usedParamIDs = window.pattern.locks
                  .filter(x => x.track === t && x.step === currentStep)
                  .map(x => x.paramID);
                let newParamID = 1;
                while (usedParamIDs.includes(newParamID) && newParamID < 24) newParamID++;
                window.pattern.locks.push({ track: t, step: currentStep, paramID: newParamID, paramVal: 64 });
                window.buildLockAndBitfieldUI_SYSEX();
                updatePanelHeaderColors();
                window.highlightPatternTrack(window.selectedPatternTrackIndex);
              };
              rowDiv.appendChild(plusBtn);

              const delBtn = document.createElement("button");
              delBtn.textContent = "DelRow";
              delBtn.style.marginLeft = "0.3em";
              delBtn.onclick = () => {
                window.pattern.locks = window.pattern.locks.filter(
                  lx => !(lx.track === t && lx.step === currentStep)
                );
                window.buildLockAndBitfieldUI_SYSEX();
                updatePanelHeaderColors();
                window.highlightPatternTrack(window.selectedPatternTrackIndex);
              };
              rowDiv.appendChild(delBtn);
              trackDiv.appendChild(rowDiv);
            }
            currentStep = lk.step;
            stepLocks = [];
            rowDiv = document.createElement("div");
            rowDiv.className = "plock-row";
            const rowHeader = document.createElement("span");
            rowHeader.className = "plock-row-header";
            rowHeader.textContent = `Step ${lk.step + 1}`;
            rowDiv.appendChild(rowHeader);
          }
          stepLocks.push(lk);
          rowDiv.appendChild(window.makeParamCell_SYSEX(t, lk.step, stepLocks, stepLocks.length - 1));
        });
        if (rowDiv && stepLocks.length) {
          const plusBtn = document.createElement("button");
          plusBtn.textContent = "+Param";
          plusBtn.onclick = () => {
            recordTrackUndo(t);
            const usedParamIDs = window.pattern.locks
              .filter(x => x.track === t && x.step === currentStep)
              .map(x => x.paramID);
            let newParamID = 1;
            while (usedParamIDs.includes(newParamID) && newParamID < 24) newParamID++;
            window.pattern.locks.push({ track: t, step: currentStep, paramID: newParamID, paramVal: 64 });
            window.buildLockAndBitfieldUI_SYSEX();
            updatePanelHeaderColors();
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          };
          rowDiv.appendChild(plusBtn);

          const delBtn = document.createElement("button");
          delBtn.textContent = "DelRow";
          delBtn.style.marginLeft = "0.3em";
          delBtn.onclick = () => {
            window.pattern.locks = window.pattern.locks.filter(
              lx => !(lx.track === t && lx.step === currentStep)
            );
            window.buildLockAndBitfieldUI_SYSEX();
            updatePanelHeaderColors();
            window.highlightPatternTrack(window.selectedPatternTrackIndex);
          };
          rowDiv.appendChild(delBtn);
          trackDiv.appendChild(rowDiv);
        }
        locksContainer.appendChild(trackDiv);
      }
    }
  };

  window.removeLocksForClearedTrigs = function removeLocksForClearedTrigs() {
    if (!window.pattern || !window.pattern.trigBitsPerTrack) return;
    window.pattern.locks = window.pattern.locks.filter(lk => {
      const track = lk.track;
      const step = lk.step;
      const trigArr = window.pattern.trigBitsPerTrack[track];
      return window.getBitFromArray(trigArr, step);
    });
  };

  window.updateGlobalLocks = function (track, step, newLockArrayForThatStep) {
    window.pattern.locks = window.pattern.locks.filter(lk => !(lk.track === track && lk.step === step));
    newLockArrayForThatStep.forEach(lock => {
      const value = typeof lock.paramVal === "number" ? lock.paramVal : 64;
      window.pattern.locks.push({
        track: track,
        step: step,
        paramID: lock.paramID,
        paramVal: value,
      });
    });
  };

  // ---------------- SCALE / LENGTH ----------------
  window.updateScaleForLength = function (newLen) {
    const breakpoints = [16, 32, 48, 64];
    let newScaleIndex = breakpoints.findIndex(bp => newLen <= bp);
    if (newScaleIndex < 0) newScaleIndex = breakpoints.length - 1;
    window.pattern.scale = newScaleIndex;

    // Keep the Scale dropdown in sync when users drag the Length slider.
    const scaleSelect = document.getElementById("patScaleSelect");
    if (scaleSelect) {
      scaleSelect.value = String(window.pattern.scale);
    }

    if (newLen > breakpoints[newScaleIndex]) {
      window.pattern.length = breakpoints[newScaleIndex];
    }
  };

  window.enforceLockStepsInRange = function () { };

  window.onLengthSliderChange = function (newLength) {
    const isMKI = (window.mdModel === "MKI");
    const maxLen = isMKI ? 32 : 64;
    let L = Math.max(2, Math.min(maxLen, newLength));
    window.pattern.length = L;
    window.updateScaleForLength(L);
    window.enforceLockStepsInRange();
    if (typeof window.updatePatternHeaderDisplay === "function") {
      window.updatePatternHeaderDisplay();
    }
    const lengthLabel = document.getElementById("patLengthLabel");
    if (lengthLabel) {
      lengthLabel.textContent = L;
    }
    if (typeof window.buildLockAndBitfieldUI_SYSEX === "function") {
      window.buildLockAndBitfieldUI_SYSEX();
    }
    updatePanelHeaderColors();
  };

  window.updatePatternHeaderDisplay = function () {
    const header = document.getElementById("patternHeaderDisplay");
    if (!header) return;
    const breakpoints = [16, 32, 48, 64];
    header.textContent =
      "Length: " + window.pattern.length +
      " / Scale: " + breakpoints[window.pattern.scale];
  };

  // ---------------- REQUEST PATTERN DUMP ----------------
  function requestPatternDump(opts) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (!window.isBulkInProgress && !confirm("Overwrite pattern data?")) {
      return;
    }
    let useRange = opts && opts.useRange;
    if (useRange) {
      const [startS, endS] = document.getElementById("slider-patterns").noUiSlider.get();
      let start = window.patternLabelToIndex(startS);
      let end = window.patternLabelToIndex(endS);
      if (start > end) [start, end] = [end, start];
      start = Math.max(0, Math.min(127, start));
      end = Math.max(0, Math.min(127, end));
      for (let p = start; p <= end; p++) {
        window.waitingForSinglePatternDump = true;
        const syx = window.MD_SYSEX_HEADER.concat([window.MD_PATTERN_REQUEST_ID, (p & 0x7F), 0xF7]);
        window.selectedMidiOut.send(syx);
      }
      return;
    }
    const [startVal] = document.getElementById("slider-patterns").noUiSlider.get();
    let patNum = window.patternLabelToIndex(startVal);
    patNum = Math.max(0, Math.min(127, patNum));
    window.waitingForSinglePatternDump = true;
    const syxSingle = window.MD_SYSEX_HEADER.concat([window.MD_PATTERN_REQUEST_ID, (patNum & 0x7F), 0xF7]);
    window.selectedMidiOut.send(syxSingle);
  }
  window.requestPatternDump = requestPatternDump;

  // ---------------- WRITE PATTERN TO MD (Unified) ----------------
  function writePatternToMD(opts) {
    // Ensure arrays (including global bitfields) are correctly shaped/typed before writing
    if (typeof window.ensurePatternTrackArraysExist === "function") {
      window.ensurePatternTrackArraysExist();
    }

    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (!confirm("WARNING: This will overwrite Machinedrum pattern data. Continue?")) {
      return;
    }
    const accentChk = document.querySelector('input[name="accentEditAll"]');
    const swingChk  = document.querySelector('input[name="swingEditAll"]');
    const slideChk  = document.querySelector('input[name="slideEditAll"]');
    if (accentChk) window.pattern.accentEditAll = accentChk.checked;
    if (swingChk)  window.pattern.swingEditAll  = swingChk.checked;
    if (slideChk)  window.pattern.slideEditAll  = slideChk.checked;
    let useRange = opts && opts.useRange;
    if (useRange) {
      const [startS, endS] = document.getElementById("slider-patterns").noUiSlider.get();
      let start = window.patternLabelToIndex(startS);
      let end = window.patternLabelToIndex(endS);
      if (start > end) [start, end] = [end, start];
      start = Math.max(0, Math.min(127, start));
      end = Math.max(0, Math.min(127, end));
      for (let p = start; p <= end; p++) {
        window.pattern.origPos = p;
        window.pattern.patternNumber = p;
        const syx = window.storePatternSysex(p, window.pattern);
        window.selectedMidiOut.send(syx);
      }
      return;
    }
    const [sv] = document.getElementById("slider-patterns").noUiSlider.get();
    let patNum = window.patternLabelToIndex(sv);
    patNum = Math.max(0, Math.min(127, patNum));
    window.pattern.origPos = patNum;
    window.pattern.patternNumber = patNum;
    const syxSingle = window.storePatternSysex(patNum, window.pattern);
    window.selectedMidiOut.send(syxSingle);
  }
  window.writePatternToMD = writePatternToMD;

  window.requestOnePattern = function (index) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    const syx = window.requestPatternSysex(index);
    window.selectedMidiOut.send(syx);
  };

  // ---------------- ENSURE PATTERN ARRAYS ----------------
  // Accepts: Uint8Array, normal Array/array-like, OR a JSON'd object {"0":..,"1":..}
  window.ensurePatternTrackArraysExist = function () {
    if (!window.pattern) window.pattern = {};

    function toUint8_8(x) {
      if (x instanceof Uint8Array && x.length === 8) return x;

      const out = new Uint8Array(8);
      if (!x) return out;

      // Case 1: array-like (has a numeric length)
      if (Array.isArray(x) || (typeof x.length === "number")) {
        for (let i = 0; i < 8; i++) out[i] = (x[i] ?? 0) & 0xFF;
        return out;
      }
      // Case 2: JSON-objectified TA: {"0":..,"1":..} (no length)
      if (typeof x === "object") {
        for (let i = 0; i < 8; i++) out[i] = (x[i] ?? 0) & 0xFF;
        return out;
      }
      return out;
    }

    function to16x8(arr) {
      const src = Array.isArray(arr) ? arr : [];
      const out = new Array(16);
      for (let t = 0; t < 16; t++) out[t] = toUint8_8(src[t]);
      return out;
    }

    // Global bitfields (always 8 bytes)
    window.pattern.accentBitsGlobal = toUint8_8(window.pattern.accentBitsGlobal);
    window.pattern.swingBitsGlobal  = toUint8_8(window.pattern.swingBitsGlobal);
    window.pattern.slideBitsGlobal  = toUint8_8(window.pattern.slideBitsGlobal);

    // Per‑track bitfields (16 × 8 bytes)
    window.pattern.trigBitsPerTrack   = to16x8(window.pattern.trigBitsPerTrack);
    window.pattern.accentBitsPerTrack = to16x8(window.pattern.accentBitsPerTrack);
    window.pattern.swingBitsPerTrack  = to16x8(window.pattern.swingBitsPerTrack);
    window.pattern.slideBitsPerTrack  = to16x8(window.pattern.slideBitsPerTrack);

    // Locks array sanity
    if (!Array.isArray(window.pattern.locks)) window.pattern.locks = [];
  };

  function arrayIsAllZero(arr) {
    if (!arr || !arr.length) return true;
    return arr.every(x => x === 0);
  }
  function copyToUint8Array(src, len) {
    const dst = new Uint8Array(len);
    if (!src) return dst;

    // Arrays or typed arrays
    if (typeof src.length === "number") {
      const n = Math.min(len, src.length >>> 0);
      for (let i = 0; i < n; i++) dst[i] = (src[i] ?? 0) & 0xFF;
      return dst;
    }
    // {"0":..,"1":..} shape (no length)
    if (typeof src === "object") {
      for (let i = 0; i < len; i++) dst[i] = (src[i] ?? 0) & 0xFF;
    }
    return dst;
  }
  function getPatternTrackData(t) {
    const trig = window.pattern.trigBitsPerTrack[t] || new Uint8Array(8);
    const accent = window.pattern.accentBitsPerTrack[t] || new Uint8Array(8);
    const swing = window.pattern.swingBitsPerTrack[t] || new Uint8Array(8);
    const slide = window.pattern.slideBitsPerTrack[t] || new Uint8Array(8);

    const trigArr = Array.from(copyToUint8Array(trig, 8));
    const accentArr = Array.from(copyToUint8Array(accent, 8));
    const swingArr = Array.from(copyToUint8Array(swing, 8));
    const slideArr = Array.from(copyToUint8Array(slide, 8));

    const accentGlobal = Array.from(copyToUint8Array(window.pattern.accentBitsGlobal, 8));
const swingGlobal  = Array.from(copyToUint8Array(window.pattern.swingBitsGlobal, 8));
const slideGlobal  = Array.from(copyToUint8Array(window.pattern.slideBitsGlobal, 8));

    const locks = (window.pattern.locks || [])
      .filter(lk => lk.track === t)
      .map(lk => Object.assign({}, lk));

    return {
      trigBits: trigArr,
      accentBits: accentArr,
      swingBits: swingArr,
      slideBits: slideArr,
      locks,
      accentGlobalBits: accentGlobal,
      swingGlobalBits: swingGlobal,
      slideGlobalBits: slideGlobal
    };
  }
  window.getPatternTrackData = getPatternTrackData;
  function applyPatternTrackData(t, data) {
    if (!window.pattern.trigBitsPerTrack) {
      window.pattern.trigBitsPerTrack = Array.from({ length: 16 }, () => new Uint8Array(8));
    }
    if (!window.pattern.accentBitsPerTrack) {
      window.pattern.accentBitsPerTrack = Array.from({ length: 16 }, () => new Uint8Array(8));
    }
    if (!window.pattern.swingBitsPerTrack) {
      window.pattern.swingBitsPerTrack = Array.from({ length: 16 }, () => new Uint8Array(8));
    }
    if (!window.pattern.slideBitsPerTrack) {
      window.pattern.slideBitsPerTrack = Array.from({ length: 16 }, () => new Uint8Array(8));
    }
    window.pattern.trigBitsPerTrack[t] = copyToUint8Array(data.trigBits, 8);
    window.pattern.accentBitsPerTrack[t] = copyToUint8Array(data.accentBits, 8);
    window.pattern.swingBitsPerTrack[t] = copyToUint8Array(data.swingBits, 8);
    window.pattern.slideBitsPerTrack[t] = copyToUint8Array(data.slideBits, 8);

    if (data.accentGlobalBits && data.accentGlobalBits.length === 8 && !arrayIsAllZero(data.accentGlobalBits)) {
      window.pattern.accentBitsGlobal = copyToUint8Array(data.accentGlobalBits, 8);
    }
    if (data.swingGlobalBits && data.swingGlobalBits.length === 8 && !arrayIsAllZero(data.swingGlobalBits)) {
      window.pattern.swingBitsGlobal = copyToUint8Array(data.swingGlobalBits, 8);
    }
    if (data.slideGlobalBits && data.slideGlobalBits.length === 8 && !arrayIsAllZero(data.slideGlobalBits)) {
      window.pattern.slideBitsGlobal = copyToUint8Array(data.slideGlobalBits, 8);
    }
    ["accent", "swing", "slide"].forEach(field => {
      if (window.pattern[field + "EditAll"]) {
        const globalField = window.pattern[field + "BitsGlobal"];
        if (globalField && Array.from(globalField).some(b => b !== 0)) {
          for (let t = 0; t < 16; t++) {
            const perTrack = window.pattern[field + "BitsPerTrack"][t];
            if (arrayIsAllZero(perTrack)) {
              perTrack.set(globalField);
            }
          }
        }
      }
    });

    window.pattern.locks = window.pattern.locks || [];
    window.pattern.locks = window.pattern.locks.filter(lk => lk.track !== t);
    if (data.locks && Array.isArray(data.locks)) {
      data.locks.forEach(lk => {
        window.pattern.locks.push(Object.assign({}, lk, { track: t }));
      });
    }
  }
  window.applyPatternTrackData = applyPatternTrackData;

  function storePatternSlot(idx) {
    if (!window.pattern) return;

    // Prefer the canonical commit helper (stamps metadata like origPos and
    // also clears SlotStrip dirty state on local store).
    if (typeof window.commitPatternSlot === "function") {
      const isEmpty = (window.isPatternEmpty && window.isPatternEmpty(window.pattern));
      if (isEmpty) window.pattern.assignedKitNumber = -1;
      window.commitPatternSlot(idx, isEmpty ? null : window.pattern, { silent: false });
      if (window.colorizeSlots) window.colorizeSlots();
      return;
    }

    if (window.isPatternEmpty && window.isPatternEmpty(window.pattern)) {
      window.pattern.assignedKitNumber = -1;
      window.allPatternSlots[idx] = null;
    } else {
      window.allPatternSlots[idx] = {
        kit: null,
        pattern: JSON.parse(JSON.stringify(window.pattern)),
        kitColorIndex: window.pattern.assignedKitNumber || 0
      };
    }
    if (window.buildTopPatternBanksUI) window.buildTopPatternBanksUI();
    if (window.attachBankSlotClickHandlers) window.attachBankSlotClickHandlers();
    if (window.colorizeSlots) window.colorizeSlots();
  }
  window.storePatternSlot = storePatternSlot;

  // ---------------- COPY, CUT, PASTE, CLEAR TRACK, ETC. ----------------
  window.copyPatternTrack = function () {
    const t = window.selectedPatternTrackIndex;
    const data = window.getPatternTrackData
                 ? window.getPatternTrackData(t)
                 : getPatternTrackData(t);
    window.editorClipboard = {
      type: "patternTrack",
      data: JSON.parse(JSON.stringify(data))
    };
  };

window.clearPatternTrack = function (t) {
  recordTrackUndo(t);
  [ window.pattern.trigBitsPerTrack[t],
    window.pattern.accentBitsPerTrack[t],
    window.pattern.swingBitsPerTrack[t],
    window.pattern.slideBitsPerTrack[t]
  ].forEach(a => a.fill(0));
  window.pattern.locks = window.pattern.locks.filter(lk => lk.track !== t);
  buildLockAndBitfieldUI_SYSEX();
  updatePanelHeaderColors();
  highlightPatternTrack(t);
};

// --- “Cut track” (with undo) ---
window.cutPatternTrack = function () {
  const t = window.selectedPatternTrackIndex;
  recordTrackUndo(t);
  window.copyPatternTrack();
  window.clearPatternTrack(t);
  buildLockAndBitfieldUI_SYSEX();
  highlightPatternTrack(t);
  updatePanelHeaderColors();
};

// --- “Paste track” (with undo) ---
window.pastePatternTrack = function () {
  const t = window.selectedPatternTrackIndex;
  if (window.editorClipboard.type !== "patternTrack") return;
  recordTrackUndo(t);
  applyPatternTrackData(t, window.editorClipboard.data);
  buildLockAndBitfieldUI_SYSEX();
  highlightPatternTrack(t);
  updatePanelHeaderColors();
};

window.addEventListener("keydown", (e) => {
  if (window.activePanel !== "pattern") return;

  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) {
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === "c") {
      e.preventDefault();
      window.copyPatternTrack();
    } else if (k === "x") {
      e.preventDefault();
      window.cutPatternTrack();
    } else if (k === "v") {
      e.preventDefault();
      window.pastePatternTrack();
    }
  }
});

  window.highlightPatternTrack = function (t) {
    const rows = document.querySelectorAll(".pattern-track-row");
    rows.forEach((row, i) => row.classList.toggle("selected", i === t));
  };

  window.onClickPatternTrack = function (t) {
    window.selectedPatternTrackIndex = t;
    window.activePanel = "pattern";
    window.highlightPatternTrack(t);
  };

  // ---------------- BUILD "GENERAL" UI ----------------
  window.buildPatternGeneralUI = function () {
    if (window.refreshScaleDropdownForMDModel) {
      window.refreshScaleDropdownForMDModel();
    }
    const elNum = document.getElementById("patNumber");
    if (elNum) {
      const label = window.patternIndexToLabel(window.pattern.patternNumber);

      // Pat # is display-only (like Kit # in the Kit panel)
      if (elNum.tagName === "INPUT") {
        // Legacy fallback (older HTML) — keep it read-only and non-editing.
        elNum.value = label;
        elNum.readOnly = true;
        elNum.onchange = null;
      } else {
        elNum.textContent = label;
      }
    }
    const elExt = document.getElementById("patExtended");
    if (elExt) elExt.checked = !!window.pattern.extendedFlag;
    const elTm = document.getElementById("patTempoMult");
    if (elTm) {
      elTm.value = window.pattern.tempoMult;
      elTm.onchange = () => {
        window.pattern.tempoMult = parseInt(elTm.value, 10) || 0;
        updatePanelHeaderColors();
      };
    }
    const swS = document.getElementById("patSwingSlider");
    const swL = document.getElementById("patSwingLabel");
    if (swS && swL) {
      const raw = window.pattern.swingAmount || 0;
      const mapped = 50 + (raw / 127) * 30;
      swS.value = Math.round(mapped);
      swL.textContent = Math.round(mapped);
      swS.oninput = () => {
        const val = Math.round(swS.value);
        swL.textContent = val;
        window.pattern.swingAmount = Math.round(((val - 50) / 30) * 127);
        updatePanelHeaderColors();
      };
    }
    const accentSlider = document.getElementById("accentSlider");
    const accentLabel = document.getElementById("accentLabel");
    if (accentSlider && accentLabel) {
      const nib = (window.pattern.accentAmount || 0) & 0x0f;
      accentSlider.value = nib;
      accentLabel.textContent = nib;
      accentSlider.oninput = () => {
        const n = parseInt(accentSlider.value, 10) || 0;
        accentLabel.textContent = n;
        window.pattern.accentAmount = n;
        updatePanelHeaderColors();
      };
    }
    const kitNumInput = document.getElementById("assignedKitNumber");
    if (kitNumInput) {
      const currentKit = (window.pattern.assignedKitNumber != null)
        ? window.pattern.assignedKitNumber + 1
        : 1;
      kitNumInput.value = String(currentKit);

      // Kit # is editable with spinner / ↑↓ keys. Store as 0-based internally.
      kitNumInput.oninput = () => {
        let val = parseInt(kitNumInput.value, 10);
        if (!Number.isFinite(val)) return; // allow temporary blank while editing
        val = Math.max(1, Math.min(64, val));
        if (String(val) !== kitNumInput.value) kitNumInput.value = String(val);
        window.pattern.assignedKitNumber = val - 1;
        updatePanelHeaderColors();
      };
    }
    const lengthSlider = document.getElementById("patLengthSlider");
    const lengthLabel  = document.getElementById("patLengthLabel");
    if (lengthSlider && lengthLabel) {
      const isMKI = (window.mdModel === "MKI");
      lengthSlider.max = isMKI ? 32 : 64;
      const initialValue = Math.min(
        window.pattern.length || 16,
        parseInt(lengthSlider.max, 10) || 64
      );
      lengthSlider.value = initialValue;
      lengthLabel.textContent = initialValue;
      lengthSlider.oninput = () => {
        let newLen = parseInt(lengthSlider.value, 10) || 16;
        window.onLengthSliderChange(newLen);
      };
    }
    const scaleSelect = document.getElementById("patScaleSelect");
    if (scaleSelect) {
      scaleSelect.value = String(window.pattern.scale || 0);
      scaleSelect.onchange = () => {
        const newScale = parseInt(scaleSelect.value, 10);
        const possibleLengths = [16, 32, 48, 64];
        const desiredLen = possibleLengths[isNaN(newScale) ? 0 : newScale] || 16;

        // Route through the same code path as the Length slider so:
        // - the step grid rebuilds
        // - scale/length stay consistent
        // - header colors update
        if (typeof window.onLengthSliderChange === "function") {
          window.onLengthSliderChange(desiredLen);
        } else {
          window.pattern.length = desiredLen;
          window.updateScaleForLength(desiredLen);
          if (typeof window.buildLockAndBitfieldUI_SYSEX === "function") {
            window.buildLockAndBitfieldUI_SYSEX();
          }
          updatePanelHeaderColors();
        }
      };
    }
  };

  if (window.pattern && window.pattern.trigBitsPerTrack) {
    window.copyPatternTrack();
  }

  window.editorClipboard = window.editorClipboard || { type: null, data: null };
  window.lastUndoRecord = window.lastUndoRecord  || { type: null, trackOrRow: -1, oldData: null };
  window.activePanel = window.activePanel || "kit";
  window.selectedPatternTrackIndex = window.selectedPatternTrackIndex || 0;

})();

function isPatternEmpty(pattern) {
  // A pattern is considered non-empty if any trig bit is set or any lock exists.
  if (!pattern || !pattern.trigBitsPerTrack) {
    return true;
  }

  for (let t = 0; t < 16; t++) {
    const trackTrigs = pattern.trigBitsPerTrack[t];
    if (!trackTrigs) continue;

    // Some patterns come from JSON, which objectifies Uint8Array (no .length/.some).
    // We therefore scan by numeric indexing.
    const len = (typeof trackTrigs.length === "number" && isFinite(trackTrigs.length) && trackTrigs.length > 0)
      ? trackTrigs.length
      : 8;

    for (let i = 0; i < len; i++) {
      if ((trackTrigs[i] || 0) !== 0) {
        return false;
      }
    }
  }

  if (pattern.locks && pattern.locks.length > 0) {
    return false;
  }

  return true;
}
if (typeof window !== 'undefined') window.isPatternEmpty = isPatternEmpty;
