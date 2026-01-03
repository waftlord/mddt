(function () {
  "use strict";

  // --------------------------------------------------------------------------
  // 1) GLOBAL STATE & HELPERS (NEW)
  // --------------------------------------------------------------------------
  window.songUndoStack           = [];
  window.songRedoStack           = [];
  window.currentSongSelectedRows = [];
  window.songEditorClipboard     = { type: null, data: null };

  // --------------------------------------------------------------------------
  // Song editor defaults
  // --------------------------------------------------------------------------
  // Most Machinedrum patterns are 16 steps. In the song editor we treat row
  // length as a UI-length (not the encoded end-step), so default to 16.
  const DEFAULT_SONG_ROW_UI_LENGTH = 16;

  // Shift-mode focus columns (kept in sync with table cell order)
  //   0 Pattern | 1 Repeats | 2 Offset | 3 Length | 4 BPM | 5 Mutes | 6 Row ops (#)
  const SONG_SHIFT_COL = {
    PATTERN: 0,
    REPEATS: 1,
    OFFSET: 2,
    LENGTH: 3,
    BPM: 4,
    MUTES: 5,
    ROWOPS: 6
  };
  const SONG_SHIFT_COL_COUNT = 7;

  function pushUndo(action) {
    window.songUndoStack.push(action);
    window.songRedoStack = [];
  }

  function applyAction(action) {
    switch (action.type) {
      case 'removeRows':
        action.indices
          .slice()
          .sort((a,b)=>b-a)
          .forEach(i => {
            window.currentSong.rows.splice(i, 1);
          });
        break;
      case 'insertRows':
        action.indices.forEach((i, idx) => {
          window.currentSong.rows.splice(i, 0, { data: action.newRows[idx].slice() });
        });
        break;
      case 'overwriteRows':
        action.indices.forEach((i, idx) => {
          window.currentSong.rows[i].data = action.newRows[idx].slice();
        });
        break;
    }
  }

  function applyInverse(action) {
    switch (action.type) {
      case 'removeRows':
        action.indices.forEach((i, idx) => {
          window.currentSong.rows.splice(i, 0, { data: action.oldRows[idx].data.slice() });
        });
        break;
      case 'insertRows':
        action.indices
          .slice()
          .sort((a,b)=>b-a)
          .forEach(i => {
            window.currentSong.rows.splice(i, 1);
          });
        break;
      case 'overwriteRows':
        action.indices.forEach((i, idx) => {
          window.currentSong.rows[i].data = action.oldRows[idx].data.slice();
        });
        break;
      // ...and so on...
    }
  }

  // Undo / Redo entrypoints
  function undoSongAction() {
    const action = window.songUndoStack.pop();
    if (!action) return;
    applyInverse(action);
    window.songRedoStack.push(action);
    fillSongUI();
  }
  function redoSongAction() {
    const action = window.songRedoStack.pop();
    if (!action) return;
    applyAction(action);
    window.songUndoStack.push(action);
    fillSongUI();
  }

  // --------------------------------------------------------------------------
  // Existing Machinedrum constants and definitions
  // --------------------------------------------------------------------------
  const MD_SYSEX_HEADER = [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];
  const MD_SONG_MESSAGE_ID = 0x69;
  const MD_SONG_REQUEST_ID = 0x6A;
  const MD_SAVE_SONG_ID = 0x6D;

  window.MD_SYSEX_HEADER = MD_SYSEX_HEADER;
  window.MD_SONG_MESSAGE_ID = MD_SONG_MESSAGE_ID;
  window.MD_SONG_REQUEST_ID = MD_SONG_REQUEST_ID;
  window.MD_SAVE_SONG_ID = MD_SAVE_SONG_ID;

  window.debugBpmConversion = true;

  // --------------------------------------------------------------------------
  // BPM conversion utilities
  // --------------------------------------------------------------------------
  window.rawToBpm = function (rawHi, rawLo) {
    if (rawHi === 0xFF && rawLo === 0xFF) return null;
    if (rawHi === 0 && rawLo === 0) return null;
    const rawVal = ((rawHi & 0xFF) << 8) | (rawLo & 0xFF);
    if (rawVal < 720 || rawVal > 7200) return null;
    return 30 + Math.round((rawVal - 720) / 24);
  };

  window.bpmToRaw = function (bpmInput) {
    if (!bpmInput || (typeof bpmInput === 'string' && bpmInput.trim() === '-')) {
      return { high: 0xFF, low: 0xFF };
    }
    const bpm = parseFloat(bpmInput);
    if (!isFinite(bpm) || bpm < 30 || bpm > 300) {
      return { high: 0xFF, low: 0xFF };
    }
    const rawVal = 720 + 24 * (bpm - 30);
    // must be exact multiple of 24 to store precisely
    if ((rawVal - 720) % 24 !== 0) {
      return { high: 0xFF, low: 0xFF };
    }
    return { high: (rawVal >> 8) & 0xFF, low: rawVal & 0xFF };
  };

  // --------------------------------------------------------------------------
  // Setup our initial song object if not present
  // --------------------------------------------------------------------------
  if (!window.currentSong) {
    window.currentSong = { slotIndex: 0, version: 2, revision: 2, name: "UNTITLED", rows: [] };
  }

  window.songShiftKeyDown       = false;
  window.songShiftFocusCol      = 0;
  window.songShiftMuteTrack     = 0;
  window.currentSongActiveRowIndex = 0;
  window.songEditorClipboard    = { type: null, data: null };
  window.lastSongUndoRecord     = { type: null, rowIndex: -1, oldData: null };
  window._songTruncatedRows     = null;
  window._songTruncatedIndex    = -1;

  // --------------------------------------------------------------------------
  // Reusable utility: read + mutate each valid row
  // --------------------------------------------------------------------------
  function updateSongRows(callback) {
    window.currentSong.rows.forEach((row, i) => {
      const rowData = row.data;
      if (getPseudoPatternValue(rowData, i) >= 0) {
        callback(rowData, i);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Various "reset / randomize" column helpers
  // --------------------------------------------------------------------------
  function resetPatternColumn() {
    updateSongRows(rowData => { rowData[0] = 0; });
  }
  function randomizePatternColumn() {
    updateSongRows(rowData => { rowData[0] = (Math.random() * 128) | 0; });
  }

  function resetRepeatsColumn() {
    updateSongRows(rowData => { rowData[2] = 0; });
  }
  function randomizeRepeatsColumn() {
    updateSongRows(rowData => { rowData[2] = (Math.random() * 64) | 0; });
  }

  function resetOffsetColumn() {
    updateSongRows(rowData => { rowData[8] = 0; });
  }
  function randomizeOffsetColumn() {
    updateSongRows(rowData => {
      const patMax = (window.mdModel === "MKI" ? 30 : 62);
      rowData[8] = Math.floor(Math.random() * (patMax + 1));
    });
  }

  function resetLengthColumn() {
    updateSongRows((rowData, i) => {
      const patMax = getPatternMaxLength(rowData, i);
      const offset = rowData[8];
      rowData[9] = Math.max(2, patMax - offset);
    });
  }
  function randomizeLengthColumn() {
    updateSongRows((rowData, i) => {
      const patMax = getPatternMaxLength(rowData, i);
      const offset = rowData[8];
      let maxLenForRow = patMax - offset;
      if (maxLenForRow < 2) maxLenForRow = 2;
      rowData[9] = 2 + Math.floor(Math.random() * (maxLenForRow - 1));
    });
  }

  function resetBpmColumn() {
    updateSongRows(rowData => {
      rowData[6] = 0xFF;
      rowData[7] = 0xFF;
    });
  }
  function randomizeBpmColumn() {
    updateSongRows(rowData => {
      const bpmVal = 30 + Math.floor(Math.random() * 271);
      const raw = window.bpmToRaw(bpmVal);
      rowData[6] = raw.high;
      rowData[7] = raw.low;
    });
  }

  function resetMutesColumn() {
    updateSongRows(rowData => {
      rowData[4] = 0;
      rowData[5] = 0;
    });
  }
  function randomizeMutesColumn() {
    updateSongRows(rowData => {
      const rnd = (Math.random() * 65536) | 0;
      rowData[4] = (rnd >> 8) & 0xFF;
      rowData[5] = rnd & 0xFF;
    });
  }

  // --------------------------------------------------------------------------
  // Mute bitmask helpers
  // --------------------------------------------------------------------------
  function isTrackMuted(rowData, trackIndex) {
    let lo = rowData[4] & 0xFF, hi = rowData[5] & 0xFF;
    let mask = ((hi << 8) | lo);
    mask = ((mask & 0xFF) << 8) | ((mask >> 8) & 0xFF);
    return !!(mask & (1 << trackIndex));
  }

  function setTrackMuted(rowData, trackIndex, muted) {
    let lo = rowData[4] & 0xFF, hi = rowData[5] & 0xFF;
    let mask = ((hi << 8) | lo);
    mask = ((mask & 0xFF) << 8) | ((mask >> 8) & 0xFF);
    if (muted) mask |= (1 << trackIndex);
    else mask &= ~(1 << trackIndex);
    let swapped = ((mask & 0xFF) << 8) | ((mask >> 8) & 0xFF);
    rowData[4] = swapped & 0xFF;
    rowData[5] = (swapped >> 8) & 0x7F;
  }

  // --------------------------------------------------------------------------
  // Pattern value decoding helpers
  // --------------------------------------------------------------------------
  function normalPatternLabel(idx) {
    const banks = ["A", "B", "C", "D", "E", "F", "G", "H"];
    if (idx < 0 || idx > 127) return "??";
    const b = Math.floor(idx / 16);
    const pn = (idx % 16) + 1;
    return banks[b] + String(pn).padStart(2, "0");
  }

  // returns <0 if special: -1 end, -2 jump back, -3 jump forward, -4 halt
  window.getPseudoPatternValue = function getPseudoPatternValue(rowData, rowIndex) {
    let raw = rowData[0] & 0xFF;
    if (raw === 0xFF) return -1;   // END
    if (raw === 0xFE) {           // special pattern
      let tgt = rowData[3] & 0xFF;
      if (tgt === rowIndex) return -4; // HALT
      // is it backward jump => -2 => LOOP
      return tgt > rowIndex ? -3 : -2;
    }
    // normal pattern
    return raw >= 0x80 ? (raw & 0x7F) : raw;
  };

  // --------------------------------------------------------------------------
  // Song row chunk decode/encode
  // --------------------------------------------------------------------------
  function decodeSongRow10FromStream(rawArr, startIndex, endIndex) {
    const out = [];
    let i = startIndex, bytesUsed = 0;
    while (out.length < 10 && i < endIndex) {
      let hdr = rawArr[i++] & 0x7F;
      bytesUsed++;
      for (let b = 0; b < 7; b++) {
        if (i >= endIndex) break;
        let lo = rawArr[i++] & 0x7F;
        bytesUsed++;
        let bit7 = (hdr & (1 << (6 - b))) ? 0x80 : 0;
        out.push(lo | bit7);
        if (out.length === 10) break;
      }
    }
    return { row10: out, bytesUsed };
  }

  function encodeSongRow10(raw10) {
    const out = [];
    let i = 0;
    while (i < raw10.length) {
      let block = raw10.slice(i, i + 7);
      i += 7;
      let hdr = 0;
      // insert placeholder for "header" byte
      out.push(0);
      let hdrPos = out.length - 1;
      for (let b = 0; b < block.length; b++) {
        let val = block[b] & 0xFF;
        if (val & 0x80) hdr |= (1 << (6 - b));
        out.push(val & 0x7F);
      }
      out[hdrPos] = hdr & 0x7F;
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Pattern-length caching
  // --------------------------------------------------------------------------
  function getPatternSlotLength(patIdx) {
    // Try to use the live Pattern slot cache if available.
    try {
      const slot = (window.allPatternSlots && window.allPatternSlots[patIdx])
        ? window.allPatternSlots[patIdx]
        : null;
      const L = slot && slot.pattern && slot.pattern.length;
      const n = (typeof L === "number") ? L : parseInt(L, 10);
      if (Number.isFinite(n) && n > 0) return n | 0;
    } catch (e) {
      // ignore
    }
    return null;
  }

  function buildPatternLengthCache() {
    const cache = {};
    window.currentSong.rows.forEach((row, i) => {
      const p = getPseudoPatternValue(row.data, i);
      if (p >= 0 && cache[p] == null) {
        // Prefer actual per-slot pattern length when available.
        const live = getPatternSlotLength(p);
        cache[p] = (live != null)
          ? live
          : (window.mdModel === "MKI" ? 32 : 64);
      }
    });
    window.patternLengthCache = cache;
  }
  function getPatternMaxLength(rowData, rowIndex) {
    const p = getPseudoPatternValue(rowData, rowIndex);
    const fallback = (window.mdModel === "MKI" ? 32 : 64);
    if (p < 0) return fallback;

    // Always prefer a live slot length if present, even if the cache is stale.
    const live = getPatternSlotLength(p);
    if (live != null) {
      window.patternLengthCache = window.patternLengthCache || {};
      window.patternLengthCache[p] = live;
      return live;
    }

    const cached = window.patternLengthCache && window.patternLengthCache[p];
    return (cached != null) ? cached : fallback;
  }

  // --------------------------------------------------------------------------
  // Main SYSEX receive: handleSongDump => receiveSongDump
  // --------------------------------------------------------------------------
  window.requestSongSysex = function (songSlot) {
    const s = (songSlot | 0) & 0x1F;
    return new Uint8Array([...MD_SYSEX_HEADER, MD_SONG_REQUEST_ID, s, 0xF7]);
  };

  window.receiveSongDump = function (sysexBody, songObj) {
    if (window.blockSlotWrites) return;
    songObj = songObj || window.currentSong;
    if ((sysexBody[0] & 0xFF) !== MD_SONG_MESSAGE_ID) return;

    const ver = sysexBody[1] & 0x7F,
          rev = sysexBody[2] & 0x7F,
          pos = sysexBody[3] & 0x1F;

    let offset = 4;
    const rawName = sysexBody.slice(offset, offset + 16);
    offset += 16;
    let nameStr = "";
    for (let i = 0; i < 16; i++) {
      let c = rawName[i] & 0x7F;
      if (c > 0) nameStr += String.fromCharCode(c);
    }

    songObj.slotIndex = pos;
    songObj.version   = ver;
    songObj.revision  = rev;
    songObj.name      = nameStr;
    songObj.rows      = [];

    const endOfRows = sysexBody.length - 5;
    while (offset < endOfRows) {
      const { row10, bytesUsed } = decodeSongRow10FromStream(sysexBody, offset, endOfRows);
      offset += bytesUsed;
      if (row10.length < 10) break;
      songObj.rows.push({ data: row10 });
      if ((row10[0] & 0xFF) === 0xFF) break;
      if (songObj.rows.length >= 256) break;
    }

    const len = sysexBody.length;
    songObj.checksumHi = sysexBody[len - 5] & 0x7F;
    songObj.checksumLo = sysexBody[len - 4] & 0x7F;
    const docHi = sysexBody[len - 3] & 0x7F,
          docLo = sysexBody[len - 2] & 0x7F;
    songObj.reportedDocLen = (docHi << 7) | docLo;
    songObj.rawSong = new Uint8Array(sysexBody);

    enforceSingleEndRow();

    window.allSongSlots[songObj.slotIndex] = structuredClone(songObj);
    // Keep slot-strip (top SONGS grid) in sync on any receive.
    // In vNext, buildSongSlotsUI is wrapped by slot-strip.js to re-render.
    if (typeof window.buildSongSlotsUI === "function") {
      try { window.buildSongSlotsUI(); } catch (e) { console.warn("[Song] buildSongSlotsUI failed", e); }
    }
    buildPatternLengthCache();
    if (!window.isBulkInProgress && !window.isReceiveAllInProgress) {
      window.currentSong = structuredClone(songObj);
      window.selectedSongSlotIndex = pos;

      requestAnimationFrame(() => {
        updateHeaderUI();
        refreshSongRows();
        console.log("Song UI updated with slot", pos);
      });
    } else {
      console.log("Bulk receive active: Song UI update suppressed");
    }
  };

  // --------------------------------------------------------------------------
  // Song Dump => Sysex
  // --------------------------------------------------------------------------
  window.createSongDump = function (songObj) {
    const out = [...MD_SYSEX_HEADER];
    const pos = (songObj.slotIndex | 0) & 0x1F;
    const ver = (songObj.version != null ? songObj.version : 2) & 0x7F;
    const rev = (songObj.revision != null ? songObj.revision : 2) & 0x7F;
    out.push(MD_SONG_MESSAGE_ID, ver, rev, pos);

    const nm = (songObj.name || "").slice(0, 16).padEnd(16, " ");
    for (let i = 0; i < 16; i++) {
      out.push(nm.charCodeAt(i) & 0x7F);
    }

    let hasEnd = false;
    for (let r = 0; r < songObj.rows.length; r++) {
      let row10 = (songObj.rows[r].data || []).slice(0, 10);

      // fix BPM if invalid
      if (window.rawToBpm(row10[6], row10[7]) === null) {
        row10[6] = 0xFF;
        row10[7] = 0xFF;
      }

      // clamp length for normal pattern
      if (row10[0] !== 0xFF && row10[0] !== 0xFE) {
        let offset = row10[8];
        let uiLength = row10[9];
        // if we have a patternLengths table, use that, else fallback
        let patMax = (row10[0] < 0x80 && window.patternLengths)
          ? (window.patternLengths[row10[0]] || (window.mdModel === "MKI" ? 32 : 64))
          : (window.mdModel === "MKI" ? 32 : 64);

        let encodedLength = uiLength + offset;
        if (encodedLength > patMax) encodedLength = patMax;
        row10[9] = encodedLength;
      }

      out.push(...encodeSongRow10(row10));
      if (row10[0] === 0xFF) {
        hasEnd = true;
        break;
      }
    }

    if (!hasEnd) {
      let endRow = new Array(10).fill(0);
      endRow[0] = 0xFF; // mark as end
      out.push(...encodeSongRow10(endRow));
    }

    // trailing 5 bytes: 2 for checksum, 2 for length, 1 for 0xF7
    out.push(0, 0, 0, 0, 0);

    const csumHiOff = out.length - 5;
    const csumLoOff = out.length - 4;
    const lenHiOff  = out.length - 3;
    const lenLoOff  = out.length - 2;
    out[out.length - 1] = 0xF7;

    // compute 14-bit checksum
    let sum14 = 0;
    for (let i = 9, end = csumHiOff - 1; i <= end; i++) {
      sum14 += out[i];
    }
    sum14 &= 0x3FFF;
    out[csumHiOff] = (sum14 >> 7) & 0x7F;
    out[csumLoOff] = sum14 & 0x7F;

    // store doc length
    const docLen = out.length - 10;
    out[lenHiOff] = (docLen >> 7) & 0x7F;
    out[lenLoOff] = docLen & 0x7F;

    return new Uint8Array(out);
  };

  // --------------------------------------------------------------------------
  // Single End-Row enforcement
  // --------------------------------------------------------------------------
  function restoreTruncatedRows() {
    if (window._songTruncatedRows && window._songTruncatedRows.length) {
      window.currentSong.rows.push(...window._songTruncatedRows);
    }
    window._songTruncatedRows = null;
    window._songTruncatedIndex = -1;
  }

  function enforceSingleEndRow() {
    const s = window.currentSong;
    if (!s || !s.rows) return;
    let endIndex = -1;
    for (let i = 0; i < s.rows.length; i++) {
      if (getPseudoPatternValue(s.rows[i].data, i) === -1) {
        endIndex = i;
        break;
      }
    }
    if (endIndex >= 0) {
      if (endIndex === s.rows.length - 1) {
        window._songTruncatedRows = null;
        window._songTruncatedIndex = -1;
        return;
      }
      s.rows = s.rows.slice(0, endIndex + 1);
      window._songTruncatedRows = null;
      window._songTruncatedIndex = endIndex;
    } else {
      let newEnd = { data: new Array(10).fill(0) };
      newEnd.data[0] = -1; // set to 0xFF effectively
      s.rows.push(newEnd);
      window._songTruncatedRows = null;
      window._songTruncatedIndex = s.rows.length - 1;
    }
  }

  // --------------------------------------------------------------------------
  // Normalization for readSongUI usage
  // --------------------------------------------------------------------------
  function normalizeSongRows(songObj) {
    if (!songObj || !songObj.rows) return;
    songObj.rows.forEach((row, i) => {
      if (!Array.isArray(row.data)) {
        row.data = new Array(10).fill(0);
      } else {
        while (row.data.length < 10) {
          row.data.push(0);
        }
        if (row.data.length > 10) {
          row.data = row.data.slice(0, 10);
        }
      }
      const pseudo = window.getPseudoPatternValue(row.data, i);
      if (pseudo < 0) return;

      if (typeof row.data[0] !== "number" || isNaN(row.data[0])) {
        row.data[0] = 0;
      }
      if (typeof row.data[2] !== "number" || isNaN(row.data[2])) {
        row.data[2] = 0;
      } else {
        row.data[2] = Math.max(0, Math.min(63, row.data[2]));
      }
      if (typeof row.data[4] !== "number" || isNaN(row.data[4])) {
        row.data[4] = 0;
      } else {
        row.data[4] = row.data[4] & 0xFF;
      }
      if (typeof row.data[5] !== "number" || isNaN(row.data[5])) {
        row.data[5] = 0;
      } else {
        row.data[5] = row.data[5] & 0x7F;
      }
      if (window.rawToBpm(row.data[6], row.data[7]) === null) {
        row.data[6] = 0xFF;
        row.data[7] = 0xFF;
      }
      let patMax = getPatternMaxLength(row.data, i);
      let encodedLength = row.data[9] + row.data[8];
      if (encodedLength > patMax) {
        encodedLength = patMax;
      }
      row.data[9] = encodedLength;
    });
  }

  // --------------------------------------------------------------------------
  // UI - Building the table headers
  // --------------------------------------------------------------------------
  function createHeaderCell(text, clickHandler) {
    const th = document.createElement("th");
    th.textContent = text;
    th.classList.add("shiftHover");
    th.style.userSelect = "none";
    th.onclick = (ev) => {
      ev.stopPropagation();
      clickHandler(ev);
      rebuildSongUI();
    };
    return th;
  }

  function updateHeaderUI() {
    const s = window.currentSong;
    const snEl = document.getElementById("songNameInput");
    if (snEl) {
      snEl.value = s.name || "";
      // UI fallback without mutating the stored name.
      snEl.placeholder = "UNTITLED";
    }
    const slotEl = document.getElementById("songNumberDisplay");
    if (slotEl) {
      const sel = (typeof window.selectedSongSlotIndex === "number") ? window.selectedSongSlotIndex : -1;
      slotEl.textContent = (sel >= 0) ? String((sel | 0) + 1) : "";
    }

    const table = document.getElementById("songTable");
    if (!table) return;
    let thead = table.querySelector("thead");
    if (!thead) {
      thead = document.createElement("thead");
      table.prepend(thead);
    }
    thead.innerHTML = "";

    const thr = document.createElement("tr");
    const thIdx = document.createElement("th");
    thIdx.textContent = "#";
    thr.appendChild(thIdx);

    thr.appendChild(createHeaderCell("Pattern", ev => {
      if (!ev.shiftKey) resetPatternColumn(); else randomizePatternColumn();
    }));
    thr.appendChild(createHeaderCell("Repeats", ev => {
      if (!ev.shiftKey) resetRepeatsColumn(); else randomizeRepeatsColumn();
    }));
    thr.appendChild(createHeaderCell("Offset", ev => {
      if (!ev.shiftKey) resetOffsetColumn(); else randomizeOffsetColumn();
    }));
    thr.appendChild(createHeaderCell("Length", ev => {
      if (!ev.shiftKey) resetLengthColumn(); else randomizeLengthColumn();
    }));
    thr.appendChild(createHeaderCell("BPM", ev => {
      if (!ev.shiftKey) resetBpmColumn(); else randomizeBpmColumn();
    }));
    thr.appendChild(createHeaderCell("Mutes", ev => {
      if (!ev.shiftKey) resetMutesColumn(); else randomizeMutesColumn();
    }));

    thead.appendChild(thr);
  }

  // --------------------------------------------------------------------------
  // 3) Shift+Click multi‑select highlight function
  // --------------------------------------------------------------------------
  function highlightSelectedRows() {
      const active = window.currentSongActiveRowIndex;
  document.querySelectorAll("#songRowsBody tr").forEach((tr, i) => {
    const isMulti = window.currentSongSelectedRows.includes(i) && i !== active;
    tr.classList.toggle("multi-selected", isMulti);
  });
  }

  // --------------------------------------------------------------------------
  // Rendering each row <tr>
  // --------------------------------------------------------------------------
  function createPatternSelect(rowData, rowIndex) {
    const container = document.createElement("div");
    container.style.position = "relative";

    const sel = document.createElement("select");
    const optEnd = document.createElement("option");
    optEnd.value = -1;
    optEnd.textContent = "END";
    sel.appendChild(optEnd);

    [
      { v: -2, l: "LOOP" },
      { v: -3, l: "JUMP" },
      { v: -4, l: "HALT" }
    ].forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.l;
      sel.appendChild(opt);
    });

    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "────────";
    sel.appendChild(sep);

    for (let i = 0; i < 128; i++) {
      const op = document.createElement("option");
      op.value = i;
      op.textContent = normalPatternLabel(i);
      sel.appendChild(op);
    }

    const subBox = document.createElement("div");
    subBox.classList.add("pattern-subbox");
    subBox.style.display = "none";

    function handleChangeToEND() {
      restoreTruncatedRows();
      if (rowIndex < window.currentSong.rows.length - 1) {
        window._songTruncatedRows = window.currentSong.rows.splice(rowIndex + 1);
        window._songTruncatedIndex = rowIndex;
      }
    }

    function handleUnsetEND() {
      if (window._songTruncatedIndex === rowIndex) {
        restoreTruncatedRows();
      }
    }

    function refreshSubBox() {
      subBox.innerHTML = "";
      let val = parseInt(sel.value, 10);

      if (val === -1) {
        // END
        rowData[0] = 0xFF;
        handleChangeToEND();
        subBox.style.display = "none";
        sel.value = -1;
      } else if (val === -2 || val === -3 || val === -4) {
        // LOOP/JUMP/HALT => 0xFE
        rowData[0] = 0xFE;
        handleUnsetEND();
        subBox.style.display = "block";
        let tgt = rowData[3] & 0xFF;
        const minTarget = 0,
              maxTarget = window.currentSong.rows.length - 1;
        if (tgt < minTarget || tgt > maxTarget) {
          tgt = window.currentSongActiveRowIndex;
          rowData[3] = tgt;
        }
        let mode = val;
        // ensure correct direction or halt
        if (mode === -2 && tgt >= rowIndex) {
          tgt = Math.max(minTarget, rowIndex - 1);
          rowData[3] = tgt;
        } else if (mode === -3 && tgt <= rowIndex) {
          tgt = Math.min(maxTarget, rowIndex + 1);
          rowData[3] = tgt;
        } else if (mode === -4 && tgt !== rowIndex) {
          tgt = rowIndex;
          rowData[3] = tgt;
        }

        const lbl = document.createElement("label");
        lbl.textContent =
          mode === -2 ? "Loop to row:" :
          mode === -3 ? "Jump to row:" : "Halt at row:";
        subBox.appendChild(lbl);

        const rowSel = buildRowReferenceSelect(tgt, minTarget, maxTarget);
        rowSel.value = tgt;
        rowSel.onchange = () => {
          rowData[3] = parseInt(rowSel.value, 10);
          const newTgt = rowData[3] & 0xFF;
          lbl.textContent =
            newTgt < rowIndex
              ? "Loop to row:"
              : newTgt === rowIndex
              ? "Halt at row:"
              : "Jump to row:";
          sel.value =
            newTgt < rowIndex ? -2 : (newTgt === rowIndex ? -4 : -3);

          // if we are now "LOOP," add 'times' input:
          if (sel.value == -2 && !subBox.querySelector("input[type='text']")) {
            addTimesInput();
          } else {
            const timesInput = subBox.querySelector("input[type='text']");
            const timesLabel = subBox.querySelector("label.timesLabel");
            if (timesInput) timesInput.remove();
            if (timesLabel) timesLabel.remove();
          }
        };
        subBox.appendChild(rowSel);

        if (sel.value == -2) {
          addTimesInput();
        }
      } else {
        // normal pattern
        rowData[0] = val & 0x7F;
        handleUnsetEND();
        subBox.style.display = "none";
      }
      enforceSingleEndRow();
    }

    function addTimesInput() {
      const lb2 = document.createElement("label");
      lb2.textContent = " Times:";
      lb2.style.marginLeft = "6px";
      lb2.className = "timesLabel";
      subBox.appendChild(lb2);

      const inTimes = document.createElement("input");
      inTimes.type = "text";
      inTimes.style.width = "3em";
      inTimes.value = (rowData[2] & 0xFF) === 0 ? "∞" : String(rowData[2] & 0xFF);

      inTimes.onfocus = () => {
        if (inTimes.value === "∞") inTimes.value = "";
      };
      inTimes.onchange = () => {
        const st = inTimes.value.trim();
        if (!st || st === "∞") {
          rowData[2] = 0;
          inTimes.value = "∞";
          return;
        }
        let n = parseInt(st, 10);
        if (isNaN(n) || n < 0) n = 0;
        if (n > 63) n = 63;
        rowData[2] = n;
        if (n === 0) inTimes.value = "∞";
      };
      subBox.appendChild(inTimes);
    }

    let pv = window.getPseudoPatternValue(rowData, rowIndex);
    sel.value = pv;
    refreshSubBox();

    sel.addEventListener("change", () => {
      if (window.getPseudoPatternValue(rowData, rowIndex) === -1) {
        restoreTruncatedRows();
      }
      refreshSubBox();
      rebuildSongUI();
    });

    container.appendChild(sel);
    container.appendChild(subBox);
    return container;
  }

  function buildRowReferenceSelect(defaultVal, minRow, maxRow) {
    const sel = document.createElement("select");
    for (let i = minRow; i <= maxRow; i++) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = String(i).padStart(3, "0");
      sel.appendChild(o);
    }
    sel.value = Math.max(minRow, Math.min(defaultVal, maxRow));
    return sel;
  }

  function renderSongRow(rowObj, rowIndex) {
    let rowData = rowObj.data || [];
    while (rowData.length < 10) rowData.push(0);

    const tr = document.createElement("tr");
    if (rowIndex === window.currentSongActiveRowIndex) tr.classList.add("selected");

    // row index cell
    const tdI = document.createElement("td");
    tdI.textContent = String(rowIndex).padStart(3, "0");
    tdI.classList.add("song-row-index");
    tdI.setAttribute("data-index", rowIndex);

    // ------------------------------------------------------------------------
    // REPLACE the old tdI.onclick with SHIFT+Click multi‑select logic (NEW)
    // ------------------------------------------------------------------------
    tdI.onclick = ev => {
      const clicked = rowIndex;
      if (ev.shiftKey && window.currentSongActiveRowIndex != null) {
        const a = window.currentSongActiveRowIndex;
        const [min, max] = [Math.min(a, clicked), Math.max(a, clicked)];
        window.currentSongSelectedRows = [];
        for (let i = min; i <= max; i++) {
          window.currentSongSelectedRows.push(i);
        }
      } else {
        window.currentSongSelectedRows = [clicked];
        setActiveSongRow(clicked);
      }
      highlightSelectedRows();
    };

    // Keep drag&drop row reordering
    tdI.draggable = true;
    tdI.addEventListener("dragstart", ev => {
      const currentIndex = parseInt(ev.target.getAttribute("data-index"), 10);
      ev.dataTransfer.setData("text/plain", currentIndex);
      ev.dataTransfer.effectAllowed = "move";
    });
    tdI.addEventListener("dragover", ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    });
    tdI.addEventListener("dragenter", () => {
      tr.classList.add("drag-over");
    });
    tdI.addEventListener("dragleave", () => {
      tr.classList.remove("drag-over");
    });
    tdI.addEventListener("drop", ev => {
      ev.preventDefault();
      tr.classList.remove("drag-over");
      const sourceIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const targetIndex = parseInt(tdI.getAttribute("data-index"), 10);
      if (isNaN(sourceIndex) || sourceIndex === targetIndex) return;

      const insertionIndex = (sourceIndex < targetIndex)
        ? targetIndex
        : (targetIndex + 1);
      const tbody = document.getElementById("songRowsBody");
      if (tbody) {
        const draggedEl = tbody.children[sourceIndex];
        tbody.removeChild(draggedEl);
        if (insertionIndex < tbody.children.length) {
          tbody.insertBefore(draggedEl, tbody.children[insertionIndex]);
        } else {
          tbody.appendChild(draggedEl);
        }
        const [movedRow] = window.currentSong.rows.splice(sourceIndex, 1);
        window.currentSong.rows.splice(insertionIndex, 0, movedRow);
        updateRowIndices();
      }
      document.querySelectorAll("#songRowsBody tr").forEach(r => r.classList.remove("selected"));
      enforceSingleEndRow();
      fillSongUI();
      setActiveSongRow(insertionIndex);
    });
    tr.appendChild(tdI);

    // pattern cell
    const tdP = document.createElement("td");
    tdP.appendChild(createPatternSelect(rowData, rowIndex));
    tr.appendChild(tdP);

    // check if row is special or end
    const pv = window.getPseudoPatternValue(rowData, rowIndex);
    const isEnd = (pv === -1);
    const isSpec = (pv === -2 || pv === -3 || pv === -4);
    if (isEnd || isSpec) {
      // fill with empty cells so table lines up
      for (let c = 0; c < 5; c++) {
        tr.appendChild(document.createElement("td"));
      }
      return tr;
    }

    // repeats cell
    const tdR = document.createElement("td");
    const selR = document.createElement("select");
    for (let i = 1; i <= 64; i++) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = (i === 1 ? "-" : String(i));
      selR.appendChild(o);
    }
    selR.value = rowData[2] + 1;
    selR.onchange = () => {
      let n = parseInt(selR.value, 10);
      if (isNaN(n) || n < 1) n = 1;
      if (n > 64) n = 64;
      rowData[2] = n - 1;
      updatePanelHeaderColors();
      updateSongRow(rowIndex);
    };
    tdR.appendChild(selR);
    tr.appendChild(tdR);

    // offset cell
    const tdOf = document.createElement("td");
    const selOf = document.createElement("select");
    const patMaxLen = getPatternMaxLength(rowData, rowIndex);
    for (let v = 0; v <= patMaxLen - 2; v++) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = String(v);
      selOf.appendChild(o);
    }
    if (rowData[8] < 0 || rowData[8] > (patMaxLen - 2)) {
      rowData[8] = 0;
    }
    selOf.value = rowData[8];
    tdOf.appendChild(selOf);
    tr.appendChild(tdOf);

    // length cell
    const tdL = document.createElement("td");
    const selL = document.createElement("select");
    tdL.appendChild(selL);
    tr.appendChild(tdL);

    function updateLen() {
      selL.innerHTML = "";
      let ofs = parseInt(selOf.value, 10);
      const pm = getPatternMaxLength(rowData, rowIndex);
      let maxLen = pm - ofs;
      if (maxLen < 2) maxLen = 2;

      for (let v = 2; v <= maxLen; v++) {
        const op = document.createElement("option");
        op.value = v;
        op.textContent = String(v);
        selL.appendChild(op);
      }
      if (rowData[9] < 2) rowData[9] = 2;
      if (rowData[9] > maxLen) rowData[9] = maxLen;
      selL.value = rowData[9];
    }
    updateLen();

    selOf.onchange = () => {
      rowData[8] = parseInt(selOf.value, 10);
      updateLen();
      updatePanelHeaderColors();
      updateSongRow(rowIndex);
    };
    selL.onchange = () => {
      rowData[9] = parseInt(selL.value, 10);
      updatePanelHeaderColors();
      updateSongRow(rowIndex);
    };

    // BPM cell
    const tdB = document.createElement("td");
    const selB = document.createElement("select");

    const optUnassigned = document.createElement("option");
    optUnassigned.value = "-";
    optUnassigned.textContent = "–";
    selB.appendChild(optUnassigned);

    for (let bpm = 30; bpm <= 300; bpm++) {
      const opt = document.createElement("option");
      opt.value = bpm;
      opt.textContent = bpm;
      selB.appendChild(opt);
    }
    const curBpm = window.rawToBpm(rowData[6], rowData[7]);
    selB.value = (curBpm === null ? "-" : curBpm);
    selB.onchange = () => {
      const selected = selB.value;
      if (selected === "-") {
        rowData[6] = 0xFF;
        rowData[7] = 0xFF;
      } else {
        const bpmVal = parseInt(selected, 10);
        const raw = window.bpmToRaw(bpmVal);
        rowData[6] = raw.high;
        rowData[7] = raw.low;
      }
      updatePanelHeaderColors();
      updateSongRow(rowIndex);
    };
    tdB.appendChild(selB);
    tr.appendChild(tdB);

    // Mutes cell
    const tdM = document.createElement("td");
    tdM.style.display = "grid";
    tdM.style.gridTemplateColumns = "repeat(4,1fr)";
    tdM.style.gridGap = "4px";
    for (let t = 0; t < 16; t++) {
      const b = document.createElement("button");
      b.textContent = String(t + 1);
      b.style.fontSize = "0.7em";
      b.style.padding = "3px";
      const muted = isTrackMuted(rowData, t);
      b.style.backgroundColor = muted ? "red" : "#ddd";
      // In dark themes the default button text may be too light on "#ddd".
      // Force high-contrast mute numbers.
      b.style.color = muted ? "#fff" : "#000";
      b.style.fontWeight = "700";
      b.onclick = ev => {
        if (ev.shiftKey) {
          // randomize entire 16-bit mask
          const rnd = (Math.random() * 65536) | 0;
          rowData[4] = (rnd >> 8) & 0xFF;
          rowData[5] = rnd & 0xFF;
          updateSongRow(rowIndex);
          updatePanelHeaderColors();
        } else {
          const now = !isTrackMuted(rowData, t);
          setTrackMuted(rowData, t, now);
          b.style.backgroundColor = now ? "red" : "#ddd";
          b.style.color = now ? "#fff" : "#000";
          updatePanelHeaderColors();
          updateSongRow(rowIndex);
        }
      };
      tdM.appendChild(b);
    }
    tr.appendChild(tdM);

    return tr;
  }

  // --------------------------------------------------------------------------
  // Refreshing + Rebuilding the Song Table
  // --------------------------------------------------------------------------
  function refreshSongRows() {
    const s = window.currentSong;
    const table = document.getElementById("songTable");
    if (!table) return;
    let tbody = document.getElementById("songRowsBody");
    if (!tbody) {
      tbody = document.createElement("tbody");
      tbody.id = "songRowsBody";
      table.appendChild(tbody);
    }
    const fragment = document.createDocumentFragment();
    s.rows.forEach((rowObj, idx) => {
      fragment.appendChild(renderSongRow(rowObj, idx));
    });
    tbody.innerHTML = "";
    tbody.appendChild(fragment);
  }

  function rebuildSongUI() {
    const tbody = document.getElementById("songRowsBody");
    if (tbody && tbody.children.length === window.currentSong.rows.length) {
      updateHeaderUI();
      window.currentSong.rows.forEach((_, idx) => updateSongRow(idx));
    } else {
      updateHeaderUI();
      refreshSongRows();
    }
  }

  function updateSongRow(rowIndex) {
    const tbody = document.getElementById("songRowsBody");
    if (!tbody) return;
    const s = window.currentSong;
    if (rowIndex < 0 || rowIndex >= s.rows.length) return;
    const newRow = renderSongRow(s.rows[rowIndex], rowIndex);
    const oldRow = tbody.children[rowIndex];
    if (oldRow) {
      tbody.replaceChild(newRow, oldRow);
    }
  }

  function updateRowIndices() {
    const tbody = document.getElementById("songRowsBody");
    if (!tbody) return;

    Array.from(tbody.children).forEach((rowEl, i) => {
      const idxCell = rowEl.querySelector("td.song-row-index");
      if (!idxCell) return;

      idxCell.textContent = String(i).padStart(3, "0");
      idxCell.setAttribute("data-index", i);

      // Preserve SHIFT+Click multi-select behavior even after DOM reindexing.
      idxCell.onclick = (ev) => {
        const clicked = i;
        if (ev && ev.shiftKey && window.currentSongActiveRowIndex != null) {
          const a = window.currentSongActiveRowIndex;
          const [min, max] = [Math.min(a, clicked), Math.max(a, clicked)];
          window.currentSongSelectedRows = [];
          for (let r = min; r <= max; r++) window.currentSongSelectedRows.push(r);
        } else {
          window.currentSongSelectedRows = [clicked];
          setActiveSongRow(clicked);
        }
        highlightSelectedRows();
      };
    });
  }

  // --------------------------------------------------------------------------
  // Song editor: sticky "+ Row" button (always visible under the table)
  // --------------------------------------------------------------------------
  function ensureSongAddRowButton() {
    const table = document.getElementById("songTable");
    if (!table) return;

    const host = table.closest(".song-card-body") || table.parentElement;
    if (!host) return;

    if (document.getElementById("songAddRowBar")) return;

    const bar = document.createElement("div");
    bar.id = "songAddRowBar";
    bar.style.position = "sticky";
    bar.style.bottom = "0";
    bar.style.zIndex = "5";
    bar.style.padding = "10px 0 2px";
    bar.style.marginTop = "10px";
    bar.style.display = "flex";
    bar.style.justifyContent = "center";
    bar.style.background = "var(--panel-2)";
    bar.style.borderTop = "1px solid var(--border)";

    const btn = document.createElement("button");
    btn.id = "songAddRowButton";
    btn.type = "button";
    btn.className = "tool-button tool-button--small";
    btn.textContent = "+ Row";
    btn.title = "Add a new row above END (duplicates the last row)";
    btn.addEventListener("click", () => {
      if (typeof window.addSongRowBeforeEnd === "function") {
        window.addSongRowBeforeEnd();
      }
    });

    bar.appendChild(btn);
    host.appendChild(bar);
  }

  // --------------------------------------------------------------------------
  // fillSongUI
  // --------------------------------------------------------------------------
  window.fillSongUI = function () {
    const s = window.currentSong;
    if (!s) return;
    enforceSingleEndRow();
    // rebuild with new or existing rows
    rebuildSongUI();
    // Ensure the song editor always has a visible "+ Row" button.
    ensureSongAddRowButton();
    // Keep the optional slot dropdown (if present) in sync with the active song.
    if (typeof window.populateSongSlotSelect === "function") {
      try { window.populateSongSlotSelect(); } catch (e) { console.warn("[Song] populateSongSlotSelect failed", e); }
    }
    if (typeof updatePanelHeaderColors === "function" && !window.waitingForSingleSongDump) {
      updatePanelHeaderColors();
    }
  };

  // --------------------------------------------------------------------------
  // Song Panel
  // --------------------------------------------------------------------------
  window.setActiveSongRow = function (idx) {
    window.activePanel = "song";
    const oldIndex = window.currentSongActiveRowIndex;
    window.currentSongActiveRowIndex = idx;
    updateSongRow(oldIndex);
    updateSongRow(idx);

    // Keep multi-select highlighting in sync when the active row changes.
    highlightSelectedRows();

    if (window.songShiftKeyDown) {
      applySongShiftHighlight();
    }
    const activeRow = document.querySelector("#songRowsBody tr.selected");
    if (activeRow) {
      activeRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  window.insertSongRow = function () {
    const current = window.currentSongActiveRowIndex;

    // Never insert *after* END (it would be truncated by enforceSingleEndRow).
    const rows = window.currentSong.rows || [];
    let endIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (getPseudoPatternValue(rows[i].data, i) === -1) { endIdx = i; break; }
    }
    if (endIdx < 0) endIdx = rows.length;

    const insertAt = Math.min(current + 1, endIdx);

    const newRow = { data: new Array(10).fill(0) };
    // Default row values: 16-step length, BPM unassigned.
    newRow.data[6] = 0xFF;
    newRow.data[7] = 0xFF;
    newRow.data[8] = 0;
    const pm = getPatternMaxLength(newRow.data, insertAt);
    const maxLen = Math.max(2, pm - newRow.data[8]);
    newRow.data[9] = Math.min(DEFAULT_SONG_ROW_UI_LENGTH, maxLen);

    pushUndo({
      type:    'insertRows',
      indices: [ insertAt ],
      newRows: [ { data: newRow.data.slice() } ]
    });

    window.currentSong.rows.splice(insertAt, 0, newRow);

    fillSongUI();
    setActiveSongRow(insertAt);

    window.currentSongSelectedRows = [ insertAt ];
    highlightSelectedRows();
  };

  // Add a row just above END, duplicating the last row before END.
  // This is used by the always-visible "+ Row" button beneath the table.
  window.addSongRowBeforeEnd = function () {
    if (!window.currentSong || !Array.isArray(window.currentSong.rows)) return;

    enforceSingleEndRow();

    const rows = window.currentSong.rows;
    let endIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (getPseudoPatternValue(rows[i].data, i) === -1) { endIdx = i; break; }
    }
    if (endIdx < 0) endIdx = rows.length;

    const insertAt = endIdx;
    const srcIdx = insertAt - 1;

    let data;
    if (srcIdx >= 0 && rows[srcIdx] && Array.isArray(rows[srcIdx].data)) {
      // Copy the last non-END row (special rows are allowed).
      const pv = getPseudoPatternValue(rows[srcIdx].data, srcIdx);
      if (pv !== -1) data = rows[srcIdx].data.slice(0, 10);
    }

    if (!data) {
      // If the song only contains END, fall back to a sensible default.
      data = new Array(10).fill(0);
      data[6] = 0xFF;
      data[7] = 0xFF;
      data[8] = 0;
      const pm = getPatternMaxLength(data, insertAt);
      const maxLen = Math.max(2, pm - data[8]);
      data[9] = Math.min(DEFAULT_SONG_ROW_UI_LENGTH, maxLen);
    }

    pushUndo({
      type: 'insertRows',
      indices: [insertAt],
      newRows: [{ data: data.slice() }]
    });

    rows.splice(insertAt, 0, { data: data.slice() });

    fillSongUI();
    setActiveSongRow(insertAt);
    window.currentSongSelectedRows = [insertAt];
    highlightSelectedRows();
  };

  window.removeSongRow = function (rowIndex) {
    if (!window.currentSong) return;
    if (rowIndex < 0 || rowIndex >= window.currentSong.rows.length) return;
    window.lastSongUndoRecord = {
      type: "removeRow",
      rowIndex,
      oldData: structuredClone(window.currentSong.rows[rowIndex])
    };
    window.currentSong.rows.splice(rowIndex, 1);
    if (rowIndex <= window.currentSongActiveRowIndex) {
      window.currentSongActiveRowIndex = Math.max(0, window.currentSongActiveRowIndex - 1);
    }
    refreshSongRows();
    updateRowIndices();
    updatePanelHeaderColors();
  };

  window.copySongRow = function () {
    const sel = window.currentSongSelectedRows;
    if (sel.length > 1) {
      const rows = sel.map(i => window.currentSong.rows[i].data.slice());
      window.songEditorClipboard = {
        type: "songRows",
        data: rows
      };
    } else {
      const ri = window.currentSongActiveRowIndex;
      window.songEditorClipboard = {
        type: "songRow",
        data: window.currentSong.rows[ri].data.slice()
      };
    }
  };

  window.cutSongRow = function () {
    const sel = window.currentSongSelectedRows.slice();
    if (sel.length > 1) {
      copySongRow();

      const indices = sel.sort((a,b) => b - a);
      const oldRows = indices.map(i =>
        ({ data: structuredClone(window.currentSong.rows[i].data) })
      );

      pushUndo({
        type:    'removeRows',
        indices: indices,
        oldRows: oldRows
      });

      indices.forEach(i => {
        window.currentSong.rows.splice(i, 1);
      });

      window.currentSongSelectedRows = [];
      fillSongUI();

    } else {
      copySongRow();
      removeSongRow(window.currentSongActiveRowIndex);
    }
  };

  window.pasteSongRow = function () {
    const i = window.currentSongActiveRowIndex;
    const clip = window.songEditorClipboard;

    if (clip.type === 'songRows') {
      const rowsToInsert = clip.data;
      const insertAt = i + 1;

      pushUndo({
        type: 'insertRows',
        indices: rowsToInsert.map((_, idx) => insertAt + idx),
        newRows: rowsToInsert.map(d => ({ data: d.slice() }))
      });


      rowsToInsert.forEach((rowData, idx) => {
        window.currentSong.rows.splice(insertAt + idx, 0, { data: rowData.slice() });
      });

      window.currentSongActiveRowIndex = insertAt;
      window.currentSongSelectedRows = rowsToInsert.map((_, idx) => insertAt + idx);

    } else if (clip.type === 'songRow') {

      pushUndo({
        type: 'insertRows',
        indices: [i + 1],
        newRows: [{ data: clip.data.slice() }]
      });

      window.currentSong.rows.splice(i + 1, 0, { data: clip.data.slice() });
      window.currentSongActiveRowIndex = i + 1;
      window.currentSongSelectedRows = [i + 1];
    } else {

      return;
    }

    fillSongUI();
    setActiveSongRow(window.currentSongActiveRowIndex);
    highlightSelectedRows();
  };



  window.undoSongRow = function () {
    const u = window.lastSongUndoRecord;
    if (!u || u.rowIndex < 0) return;
    if (u.type === "removeRow") {
      window.currentSong.rows.splice(u.rowIndex, 0, u.oldData);
      setActiveSongRow(u.rowIndex);
    } else if (u.type === "pasteRow") {
      window.currentSong.rows[u.rowIndex] = structuredClone(u.oldData);
      setActiveSongRow(u.rowIndex);
    }
    window.lastSongUndoRecord = { type: null, rowIndex: -1, oldData: null };
    rebuildSongUI();
  };

  window.readSongUI = function () {
    const sn = document.getElementById("songNameInput");
    if (sn) {
      window.currentSong.name = sn.value.trim() || "UNTITLED";
    }
  };

  // --------------------------------------------------------------------------
  // Slot helpers for the Song panel (drop-down + buttons)
  // --------------------------------------------------------------------------
  window.populateSongSlotSelect = function () {
    const sel = document.getElementById("songSlotSelect");
    if (!sel) return;

    // Build / refresh options (always 32 slots).
    sel.innerHTML = "";
    for (let i = 0; i < 32; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);

      const song = window.allSongSlots ? window.allSongSlots[i] : null;
      const filled = song && typeof window.isSongEmpty === "function" ? !window.isSongEmpty(song) : !!song;
      const nameRaw = (song && song.name != null) ? String(song.name) : "";
      const name = nameRaw.trim();

      const num = String(i + 1).padStart(2, "0");
      opt.textContent = filled ? `${num} — ${(name || "UNTITLED").slice(0, 16)}` : num;
      sel.appendChild(opt);
    }

    // Choose a sane default selection.
    const active = (Number.isFinite(window.selectedSongSlotIndex) && window.selectedSongSlotIndex >= 0)
      ? window.selectedSongSlotIndex
      : (Number.isFinite(window.currentSong?.slotIndex) ? window.currentSong.slotIndex : 0);
    sel.value = String(Math.max(0, Math.min(31, active)));
  };

  // "New Song" button compatibility for index.html
  window.newSong = function () {
    if (typeof window.resetSong === "function") {
      window.resetSong();
    } else {
      // Minimal fallback
      window.currentSong = window.currentSong || {};
      window.currentSong.name = "UNTITLED";
      window.currentSong.slotIndex = 0;
      window.currentSong.rows = [{ data: [0xFF, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0, 16] }];
      if (typeof window.fillSongUI === "function") window.fillSongUI();
    }
    if (typeof window.populateSongSlotSelect === "function") window.populateSongSlotSelect();
  };

  window.storeCurrentSongToSlot = function (explicitIndex) {
    const sel = document.getElementById("songSlotSelect");
    const fromSelect = sel ? parseInt(sel.value, 10) : NaN;
    const idx = Number.isFinite(explicitIndex)
      ? explicitIndex
      : (Number.isFinite(fromSelect) ? fromSelect
        : (Number.isFinite(window.selectedSongSlotIndex) && window.selectedSongSlotIndex >= 0
          ? window.selectedSongSlotIndex
          : (Number.isFinite(window.currentSong?.slotIndex) ? window.currentSong.slotIndex : 0)));
    const i = Math.max(0, Math.min(31, idx | 0));

    // Persist the current song buffer to the slot store.
    if (typeof window.storeSongSlot === "function") {
      window.storeSongSlot(i);
    } else {
      window.allSongSlots = window.allSongSlots || [];
      window.allSongSlots[i] = structuredClone(window.currentSong);
      if (typeof window.buildSongSlotsUI === "function") window.buildSongSlotsUI();
    }
    window.selectedSongSlotIndex = i;
    if (window.currentSong) window.currentSong.slotIndex = i;
    if (typeof window.populateSongSlotSelect === "function") window.populateSongSlotSelect();
  };

  window.loadSongFromSlot = function (explicitIndex) {
    const sel = document.getElementById("songSlotSelect");
    const fromSelect = sel ? parseInt(sel.value, 10) : NaN;
    const idx = Number.isFinite(explicitIndex)
      ? explicitIndex
      : (Number.isFinite(fromSelect) ? fromSelect
        : (Number.isFinite(window.selectedSongSlotIndex) && window.selectedSongSlotIndex >= 0
          ? window.selectedSongSlotIndex
          : (Number.isFinite(window.currentSong?.slotIndex) ? window.currentSong.slotIndex : 0)));
    const i = Math.max(0, Math.min(31, idx | 0));

    if (typeof window.loadOrResetSongSlot === "function") {
      window.loadOrResetSongSlot(i);
    } else {
      const s = window.allSongSlots ? window.allSongSlots[i] : null;
      if (s) window.currentSong = structuredClone(s);
      if (typeof window.fillSongUI === "function") window.fillSongUI();
    }
    window.selectedSongSlotIndex = i;
    if (window.currentSong) window.currentSong.slotIndex = i;
    if (typeof window.populateSongSlotSelect === "function") window.populateSongSlotSelect();
  };

  // --------------------------------------------------------------------------
  // Additional MD I/O
  // --------------------------------------------------------------------------
  window.handleSongDump = function (fullArr) {
    if (fullArr.length < 7) return;
    const body = fullArr.slice(6);
    window.receiveSongDump(body, window.currentSong);
    rebuildSongUI();
  };

  window.requestSongDump = function (indexOrOpts) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    let useRange = false, explicitIndex = null;
    if (typeof indexOrOpts === "number") {
      explicitIndex = indexOrOpts;
    } else if (indexOrOpts && indexOrOpts.useRange) {
      useRange = true;
    }

    const sliderVals = document.getElementById("slider-songs").noUiSlider.get();
    let startVal = parseInt(sliderVals[0], 10) || 1;
    let endVal   = parseInt(sliderVals[1], 10) || 1;
    if (startVal > endVal) [startVal, endVal] = [endVal, startVal];
    startVal = Math.max(1, Math.min(32, startVal));
    endVal   = Math.max(1, Math.min(32, endVal));

    if (useRange) {
      for (let sNum = startVal; sNum <= endVal; sNum++) {
        const sysexMsg = window.requestSongSysex(sNum - 1);
        window.selectedMidiOut.send(sysexMsg);
      }
      return;
    }

    let sIndex = (explicitIndex !== null)
      ? Math.max(0, Math.min(31, explicitIndex))
      : (startVal - 1);

    if (!window.isBulkInProgress) {
      window.waitingForSingleSongDump = true;
    }
    const syx = window.requestSongSysex(sIndex);
    window.selectedMidiOut.send(syx);
  };

  function sendSongToMD(opts) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    const useRange = (opts && opts.useRange);
    if (useRange) {
      const [startStr, endStr] = document.getElementById("slider-songs").noUiSlider.get();
      let start = parseInt(startStr, 10) || 1;
      let end   = parseInt(endStr,   10) || 1;
      if (start > end) [start, end] = [end, start];
      start = Math.max(1, Math.min(32, start));
      end   = Math.max(1, Math.min(32, end));
      for (let sNum = start; sNum <= end; sNum++) {
        const slotIndex = sNum - 1;
        window.currentSong.slotIndex = slotIndex;
        const syx = window.createSongDump(window.currentSong);
        window.selectedMidiOut.send(syx);

        const loadMsg = new Uint8Array([
          0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x6C, slotIndex, 0xF7
        ]);
        window.selectedMidiOut.send(loadMsg);
      }
      return;
    }

    const [startVal] = document.getElementById("slider-songs").noUiSlider.get();
    let sNum = parseInt(startVal, 10) || 1;
    sNum = Math.max(1, Math.min(32, sNum));
    const slotIndex = sNum - 1;
    window.currentSong.slotIndex = slotIndex;

    const syxSingle = window.createSongDump(window.currentSong);
    window.selectedMidiOut.send(syxSingle);

    const loadMsg = new Uint8Array([
      0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x6C, slotIndex, 0xF7
    ]);
    window.selectedMidiOut.send(loadMsg);
  }

  window.saveCurrentSongToMD = function () {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (!confirm("WARNING: This will overwrite Machinedrum song data. Continue?")) {
      return;
    }
    const doS = document.getElementById("sendCheckS").checked;
    if (!doS) {
      console.warn("Song send not checked? Aborting.");
      return;
    }

    const sRange = document.getElementById("slider-songs").noUiSlider.get();
    const sStart = parseInt(sRange[0], 10) || 1;
    const songIndex = Math.max(0, Math.min(31, sStart - 1));

    if (typeof readSongUI === "function") {
      readSongUI();
    }
    window.currentSong.slotIndex = songIndex;

    normalizeSongRows(window.currentSong);
    const syx = window.createSongDump(window.currentSong);
    window.selectedMidiOut.send(syx);

    const loadMsg = new Uint8Array([
      0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00,
      0x6C,
      songIndex & 0x1F,
      0xF7
    ]);
    window.selectedMidiOut.send(loadMsg);

    console.log("Sent single song to MD slot #", songIndex);
  };

  // --------------------------------------------------------------------------
  // SHIFT-key helper highlighting
  // (Retains original code but is used in tandem with multi‑select logic)
  // --------------------------------------------------------------------------
  function applySongShiftHighlight(forceOff) {
    if (forceOff) {
      document.querySelectorAll(".shift-highlight").forEach(e => e.classList.remove("shift-highlight"));
      document.querySelectorAll(".shift-highlight-mute").forEach(e => e.classList.remove("shift-highlight-mute"));
      return;
    }
    if (!window.songShiftKeyDown) return;

    document.querySelectorAll(".shift-highlight").forEach(e => e.classList.remove("shift-highlight"));
    document.querySelectorAll(".shift-highlight-mute").forEach(e => e.classList.remove("shift-highlight-mute"));

    const rowIndex = window.currentSongActiveRowIndex;
    const rowEls = document.querySelectorAll("#songRowsBody tr");
    if (rowIndex < 0 || rowIndex >= rowEls.length) return;
    const tr = rowEls[rowIndex];
    // In SHIFT-mode we move a "focus" across columns. Unlike earlier versions,
    // we include the Pattern column and move the row-ops (#) column to the end.
    let focusCol = (window.songShiftFocusCol | 0);
    if (focusCol < 0 || focusCol >= SONG_SHIFT_COL_COUNT) {
      focusCol = SONG_SHIFT_COL.PATTERN;
      window.songShiftFocusCol = focusCol;
    }

    let tdIndex;
    if (focusCol === SONG_SHIFT_COL.ROWOPS) {
      tdIndex = 0; // row index (#)
    } else if (focusCol === SONG_SHIFT_COL.MUTES) {
      tdIndex = 6; // mutes column
    } else {
      tdIndex = focusCol + 1; // Pattern..BPM map directly to table cells
    }
    const tds = tr.querySelectorAll("td");
    if (tdIndex >= tds.length) return;

    if (focusCol === SONG_SHIFT_COL.MUTES) {
      const bI = Math.max(0, Math.min(15, window.songShiftMuteTrack | 0));
      window.songShiftMuteTrack = bI;
      const btns = tds[tdIndex].querySelectorAll("button");
      if (bI < btns.length) {
        btns[bI].classList.add("shift-highlight-mute");
      }
    } else {
      tds[tdIndex].classList.add("shift-highlight");
    }
  }

  // --------------------------------------------------------------------------
  // 2) UPDATED Keyboard / SHIFT navigation listener (NEW)
  // --------------------------------------------------------------------------
  document.addEventListener("keydown", ev => {
    if (window.activePanel !== "song") return;
    const activeEl = document.activeElement;
    if (activeEl && /^(input|textarea)$/i.test(activeEl.tagName)) return;
    if (!window.currentSong) return;

    const rowCount   = window.currentSong.rows.length;
    const activeIndex = window.currentSongActiveRowIndex;

    // --- SHIFT key down toggles shift‑mode highlighting ---
    if (ev.key === "Shift") {
      window.songShiftKeyDown = true;
      applySongShiftHighlight();
      return;
    }

    // --- Cmd/Ctrl + ... ---
    if (ev.ctrlKey || ev.metaKey) {
      const k = ev.key.toLowerCase();

      // —— UNDO / REDO ——
      if (k === "z") {
        ev.preventDefault();
        if (ev.shiftKey) {
          // redo
          redoSongAction();
        } else {
          // undo
          undoSongAction();
        }
        updatePanelHeaderColors();
        return;
      }

      // —— COPY ——
      if (k === "c") {
        ev.preventDefault();
        if (window.currentSongSelectedRows.length > 1) {
          // multi‑row copy
          const idx = window.currentSongSelectedRows;
          window.songEditorClipboard = {
            type: 'songRows',
            data: idx.map(i => window.currentSong.rows[i].data.slice())
          };
        } else {
          // single row copy
          copySongRow();
        }
        return;
      }

      // —— CUT ——
      if (k === "x") {
        ev.preventDefault();
        if (window.currentSongSelectedRows.length > 1) {
        // multi-row cut (FIX: also populate clipboard as songRows)
        const selAsc = [...window.currentSongSelectedRows].sort((a, b) => a - b);

        // write clipboard in ascending order so paste preserves the visible order
        window.songEditorClipboard = {
          type: "songRows",
          data: selAsc.map(i => window.currentSong.rows[i].data.slice())
        };

        // remove rows in descending order to keep indices stable while splicing
        const idxDesc = selAsc.slice().sort((a, b) => b - a);
        const oldRows = idxDesc.map(i => ({ data: structuredClone(window.currentSong.rows[i].data) }));

        pushUndo({ type: "removeRows", indices: idxDesc, oldRows });

        idxDesc.forEach(i => window.currentSong.rows.splice(i, 1));

        // keep things sane: clear selection, refresh UI
        window.currentSongSelectedRows = [];
        fillSongUI();
        updatePanelHeaderColors();
        return;
      } else {
        // single-row cut
        const i = activeIndex;
        const oldData = { data: structuredClone(window.currentSong.rows[i].data) };
        pushUndo({ type:'removeRows', indices: [i], oldRows: [oldData] });
        cutSongRow();
        updatePanelHeaderColors();
        return;
      }
        return;
      }

      // —— PASTE ——
      if (k === "v") {
        ev.preventDefault();
        const ai = window.currentSongActiveRowIndex;

        // MULTI‑ROW PASTE
        if (window.songEditorClipboard.type === 'songRows') {
          const rowsToInsert = window.songEditorClipboard.data;
          const insertIndices = rowsToInsert.map((_, i) => ai + 1 + i);

          // record undo: removing these inserted rows
          pushUndo({
            type: 'insertRows',
            indices: insertIndices,
            newRows: rowsToInsert.map(d => ({ data: d.slice() }))
          });

          // perform insertion
          rowsToInsert.forEach((rowData, i) => {
            window.currentSong.rows.splice(ai + 1 + i, 0, { data: rowData.slice() });
          });

          // UI update & selection
          fillSongUI();
          // make the first pasted row active, and highlight all pasted rows
          const firstNew = ai + 1;
          setActiveSongRow(firstNew);
          window.currentSongSelectedRows = insertIndices.slice();
          highlightSelectedRows();

        // SINGLE‑ROW PASTE
        } else if (window.songEditorClipboard.type === 'songRow') {
          const rowData = window.songEditorClipboard.data.slice();
          const insertAt = ai + 1;

          // record undo: removing the inserted row
          pushUndo({
            type: 'insertRows',
            indices: [insertAt],
            newRows: [{ data: rowData }]
          });

          // perform insertion
          window.currentSong.rows.splice(insertAt, 0, { data: rowData });

          // UI update & selection
          fillSongUI();
          setActiveSongRow(insertAt);
          window.currentSongSelectedRows = [ insertAt ];
          highlightSelectedRows();
        }

        return;
      }
    }

    // --- Non‑shift arrow navigation (row up/down, pattern ←/→) ---
    if (!window.songShiftKeyDown) {
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActiveSongRow(Math.max(0, activeIndex - 1));
        updatePanelHeaderColors();
      } else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActiveSongRow(Math.min(rowCount - 1, activeIndex + 1));
        updatePanelHeaderColors();
      } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        // existing pattern‑left/right logic unchanged...
        if (activeIndex < 0 || activeIndex >= rowCount) return;
        const rowData = window.currentSong.rows[activeIndex].data;
        const pv = window.getPseudoPatternValue(rowData, activeIndex);
        // special pattern row => set normal if left/right
        if (pv < 0) {
          if (ev.key === "ArrowLeft") rowData[0] = 127;
          else                        rowData[0] = 0;
        } else {
          let newVal = (ev.key === "ArrowLeft")
            ? (pv - 1 + 128) % 128
            : (pv + 1)      % 128;
          rowData[0] = newVal;
        }
        const patMax = getPatternMaxLength(rowData, activeIndex);
        rowData[9] = Math.max(2, patMax - rowData[8]);

        enforceSingleEndRow();
        updateSongRow(activeIndex);
        updatePanelHeaderColors();
      }
      return;
    }

    // --- SHIFT is held: do row delete/dup or cell adjustments ---
    ev.preventDefault();
    if (activeIndex < 0 || activeIndex >= rowCount) return;

    let col = (window.songShiftFocusCol | 0);
    if (col < 0 || col >= SONG_SHIFT_COL_COUNT) {
      col = SONG_SHIFT_COL.PATTERN;
      window.songShiftFocusCol = col;
    }

    // SHIFT+← / SHIFT+→ to move which column is “focused”
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      if (ev.key === "ArrowLeft") {
        if (col === SONG_SHIFT_COL.MUTES) {
          if (window.songShiftMuteTrack > 0) {
            window.songShiftMuteTrack--;
          } else {
            window.songShiftFocusCol = SONG_SHIFT_COL.BPM;
          }
        } else {
          const next = (col + SONG_SHIFT_COL_COUNT - 1) % SONG_SHIFT_COL_COUNT;
          window.songShiftFocusCol = next;
          if (next === SONG_SHIFT_COL.MUTES) {
            // Coming into mutes from the right -> start on the last track.
            window.songShiftMuteTrack = 15;
          }
        }
      } else {
        if (col === SONG_SHIFT_COL.MUTES) {
          if (window.songShiftMuteTrack < 15) {
            window.songShiftMuteTrack++;
          } else {
            // Leaving mutes to the right.
            window.songShiftFocusCol = SONG_SHIFT_COL.ROWOPS;
            window.songShiftMuteTrack = 0;
          }
        } else {
          const next = (col + 1) % SONG_SHIFT_COL_COUNT;
          window.songShiftFocusCol = next;
          if (next === SONG_SHIFT_COL.MUTES) {
            // Entering mutes from the left -> start on track 1.
            window.songShiftMuteTrack = 0;
          }
        }
      }
      applySongShiftHighlight();
      updatePanelHeaderColors();
      return;
    }

    // SHIFT+↑ or ↓ in the RowOps (#) column = delete or duplicate row
    if (col === SONG_SHIFT_COL.ROWOPS) {
      const currentRow = window.currentSong.rows[activeIndex];
      const pvActive = window.getPseudoPatternValue(currentRow.data, activeIndex);
      // skip if end row
      if (pvActive === -1) return;

      const tbody = document.getElementById("songRowsBody");
      if (ev.key === "ArrowUp") {
        // delete
        pushUndo({
          type: 'removeRows',
          indices: [activeIndex],
          oldRows: [{ data: structuredClone(currentRow.data) }]
        });
        window.currentSong.rows.splice(activeIndex,1);
        if (tbody && tbody.children[activeIndex]) {
          tbody.removeChild(tbody.children[activeIndex]);
          updateRowIndices();
        }
        const newActive = Math.max(0, activeIndex - 1);
        setActiveSongRow(newActive);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        return;
      }
      if (ev.key === "ArrowDown") {
        // duplicate
        const cloneRow = structuredClone(currentRow);
        pushUndo({
          type: 'insertRows',
          indices: [activeIndex+1],
          newRows: [{ data: cloneRow.data }]
        });
        window.currentSong.rows.splice(activeIndex+1, 0, cloneRow);
        if (tbody) {
          const newRowEl = renderSongRow(cloneRow, activeIndex + 1);
          if (activeIndex + 1 < tbody.children.length) {
            tbody.insertBefore(newRowEl, tbody.children[activeIndex + 1]);
          } else {
            tbody.appendChild(newRowEl);
          }
          updateRowIndices();
        }
        setActiveSongRow(activeIndex + 1);
        enforceSingleEndRow();
        applySongShiftHighlight();
        updatePanelHeaderColors();
        return;
      }
    }

    // SHIFT+↑/↓ in other cols => existing value‑change logic
    const rowData = window.currentSong.rows[activeIndex].data;
    const pseudoVal = window.getPseudoPatternValue(rowData, activeIndex);
    const isEnd = (pseudoVal === -1), isSpec = (pseudoVal === -2 || pseudoVal === -3 || pseudoVal === -4);
    if (isEnd || isSpec) return;

    switch (col) {
      case SONG_SHIFT_COL.PATTERN: {
        // pattern (up = next, down = previous)
        const pv = pseudoVal;
        const newVal = (ev.key === "ArrowUp")
          ? (pv + 1) % 128
          : (pv - 1 + 128) % 128;
        rowData[0] = newVal;
        const patMax = getPatternMaxLength(rowData, activeIndex);
        rowData[9] = Math.max(2, patMax - (rowData[8] || 0));
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
      case SONG_SHIFT_COL.REPEATS: {
        // repeats
        let rep = rowData[2] + 1;
        rep = (ev.key === "ArrowUp") ? rep + 1 : rep - 1;
        rep = Math.max(1, Math.min(64, rep));
        rowData[2] = rep - 1;
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
      case SONG_SHIFT_COL.OFFSET: {
        // offset
        let ofs = rowData[8];
        ofs = (ev.key === "ArrowUp") ? ofs + 1 : ofs - 1;
        const patLen = getPatternMaxLength(rowData, activeIndex);
        const maxOfs = Math.max(0, patLen - 2);
        rowData[8] = Math.max(0, Math.min(maxOfs, ofs));
        // keep length within the remaining space
        const maxLen = Math.max(2, patLen - rowData[8]);
        if (rowData[9] < 2) rowData[9] = 2;
        if (rowData[9] > maxLen) rowData[9] = maxLen;
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
      case SONG_SHIFT_COL.LENGTH: {
        // length
        let ln = rowData[9];
        ln = (ev.key === "ArrowUp") ? ln + 1 : ln - 1;
        ln = Math.max(2, ln);
        const patLen = getPatternMaxLength(rowData, activeIndex);
        const maxLen = Math.max(2, patLen - (rowData[8] || 0));
        rowData[9] = Math.min(maxLen, ln);
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
      case SONG_SHIFT_COL.BPM: {
        // BPM
        let c = window.rawToBpm(rowData[6], rowData[7]);
        if (c == null) {
          c = (ev.key === "ArrowUp") ? 30 : 0;
          if (c === 0) {
            rowData[6] = 0;
            rowData[7] = 0;
            updateSongRow(activeIndex);
            applySongShiftHighlight();
            updatePanelHeaderColors();
            break;
          }
        } else {
          c = (ev.key === "ArrowUp") ? c + 1 : c - 1;
          c = Math.max(30, Math.min(300, c));
        }
        const rr = window.bpmToRaw(c);
        rowData[6] = rr.high;
        rowData[7] = rr.low;
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
      case SONG_SHIFT_COL.MUTES: {
        // Mutes
        const t = window.songShiftMuteTrack;
        setTrackMuted(rowData, t, !isTrackMuted(rowData, t));
        updateSongRow(activeIndex);
        applySongShiftHighlight();
        updatePanelHeaderColors();
        break;
      }
    }
  });

  document.addEventListener("keyup", ev => {
    if (window.activePanel !== "song") return;
    if (ev.key === "Shift") {
      window.songShiftKeyDown = false;
      document.querySelectorAll(".shift-highlight").forEach(e => e.classList.remove("shift-highlight"));
      document.querySelectorAll(".shift-highlight-mute").forEach(e => e.classList.remove("shift-highlight-mute"));
    }
  });

  // --------------------------------------------------------------------------
  // Sending single or range
  // --------------------------------------------------------------------------
  window.sendSongToMD = sendSongToMD;
})();
