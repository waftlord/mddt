/**
 * mddt-import-sysex.js — SysEx importer for MDDT.
 */
(() => {
  "use strict";

  const MD_HDR = [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];
  const ID = { GLOBAL:0x50, KIT:0x52, PATTERN:0x67, SONG:0x69 };

  function eqHeader(arr, off = 0) {
    for (let i = 0; i < MD_HDR.length; i++) if (arr[off + i] !== MD_HDR[i]) return false;
    return true;
  }

  function clone(obj){ return JSON.parse(JSON.stringify(obj)); }

  function deepClonePreserveTypedArrays(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    const isTA = (v) => (v && typeof v === "object" && ArrayBuffer.isView(v) && !(v instanceof DataView));
    const isObj = (v) => v && typeof v === "object";
    if (isTA(value)) return new value.constructor(value);
    if (Array.isArray(value)) return value.map(deepClonePreserveTypedArrays);
    if (isObj(value)) {
      const out = {};
      for (const k in value) out[k] = deepClonePreserveTypedArrays(value[k]);
      return out;
    }
    return value;
  }

  function sysexUnpack7to8(packed) {
    const src = (packed instanceof Uint8Array) ? packed : new Uint8Array(packed);
    const out = [];
    for (let i = 0; i < src.length; ) {
      const remain = src.length - i;
      const blk = Math.min(8, remain);
      const msb = src[i++];
      for (let b = 0; b < blk - 1; b++) {
        const lsb = src[i++];
        const bit = (msb >> (6 - b)) & 0x01;
        out.push(((bit << 7) | (lsb & 0x7F)) & 0xFF);
      }
    }
    return new Uint8Array(out);
  }

  function chooseKitBody(fullMsg) {
    const expectedVer = fullMsg[7] & 0x7F;
    const body = fullMsg.slice(7, -1);
    if ((body[0] & 0x7F) === expectedVer) return body;
    try {
      const unpacked = sysexUnpack7to8(body);
      if ((unpacked[0] & 0x7F) === expectedVer) return unpacked;
      return body;
    } catch (_) {
      return body;
    }
  }

  function resolveIndex(dstArray, wanted, { overwrite, findNextEmpty, clampLen }) {
    let idx = Math.max(0, Math.min(clampLen - 1, wanted|0));
    if (overwrite) return idx;
    if (!dstArray[idx]) return idx;
    if (findNextEmpty) {
      for (let i = idx + 1; i < clampLen; i++) if (!dstArray[i]) return i;
      for (let i = 0; i < idx; i++) if (!dstArray[i]) return i;
    }
    return null;
  }

  function sanitizeKitName(input) {
    let s = "";
    if (typeof input === "string") s = input;
    else if (Array.isArray(input)) s = input.join("");
    else if (input && typeof input[Symbol.iterator] === "function") s = Array.from(input).join("");
    s = (s || "").replace(/[^\x20-\x7E]/g, " ").trim();
    if (!s) return "";
    // MD shows 16 chars; we also cap to 16, but should be 10!?
    return s.slice(0, 16);
  }

  function readNullTerminatedAscii16(bytes16) {
    const arr = Array.from(bytes16, b => b & 0x7F);
    const cut = arr.indexOf(0x00);
    const view = (cut >= 0) ? arr.slice(0, cut) : arr;
    return (String.fromCharCode(...view).replace(/[^\x20-\x7E]/g, " ").trim()).slice(0, 16);
  }

  function _wrapCreateKitDumpForImport() {
    const _orig = window.createKitDump;
    window.createKitDump = function safeCreateKitDump(dataObj) {
      let nameStr = sanitizeKitName(dataObj && dataObj.kitName);
      if (!nameStr) nameStr = " ";
      return _orig(Object.assign({}, dataObj, { kitName: nameStr }));
    };
    return () => { window.createKitDump = _orig; };
  }

  function isKitEmpty(k) {
    return !k || !k.machineAssignments || k.machineAssignments.every(id => (id|0) === 0);
  }
  function isPatternEmpty(p) {
    return !p || !p.trigBitsPerTrack || p.trigBitsPerTrack.every(row => row.every(b => (b|0) === 0));
  }

  function applyMessage(fullMsg, summary, opts, filters) {
    const msgId   = fullMsg[6] & 0x7F;
    const ver     = fullMsg[7] & 0x7F;
    const rev     = fullMsg[8] & 0x7F;
    const wireSlot = fullMsg.length > 9 ? (fullMsg[9] & 0x7F) : 0;

    switch (msgId) {
      case ID.GLOBAL: {
        if (filters?.globals && !filters.globals.has(wireSlot)) return;
        if (typeof window.receiveGlobalDump !== "function") return;
        try {
          window.receiveGlobalDump(fullMsg.slice(7, -1));
        } catch (e1) {
          try {
            const bodyPacked = fullMsg.slice(10, -1);
            window.receiveGlobalDump(sysexUnpack7to8(bodyPacked));
          } catch (e2) {
            console.error("[SYX][GLOBAL] Decoder threw:", e1, e2); return;
          }
        }
        const pos = (window.globalData && typeof window.globalData.globalPosition === "number")
          ? window.globalData.globalPosition : wireSlot;
        const dst = resolveIndex(window.globalLibrary, pos + (opts.globalOffset|0),
          { overwrite: opts.overwriteGlobals, findNextEmpty: opts.fillNextEmptyGlobals, clampLen: 8 });
        if (dst == null) return;
        if (typeof window.commitGlobalSlot === "function") {
          window.commitGlobalSlot(dst, window.globalData, { silent: true });
        } else {
          window.globalLibrary[dst] = clone(window.globalData);
          if (window.globalLibrary[dst]) window.globalLibrary[dst].globalPosition = dst;
        }
        summary.globals.push({ slot: dst + 1, ver, rev });
        if (!opts.silentUI) { if (typeof window.buildGlobalSlotsUI === "function") window.buildGlobalSlotsUI(); }
        break;
      }

      case ID.KIT: {
        if (filters?.kits && !filters.kits.has(wireSlot)) return;
        if (typeof window.receiveKitDump !== "function") return;
        const restoreCreate = _wrapCreateKitDumpForImport();

        let kitBody = null;
        try {
          kitBody = chooseKitBody(fullMsg);
          window.receiveKitDump(kitBody);
        } catch (e) {
          console.error("[SYX][KIT] Decoder threw:", e);
          restoreCreate();
          return;
        }
        restoreCreate();

        // --- Normalise/repair kit name ---
        if (window.kit) {
          let nameStr = sanitizeKitName(window.kit.kitName);

          if (!nameStr) {
            try { nameStr = readNullTerminatedAscii16(kitBody.slice(3, 3 + 16)); } catch {}
          }

          if (!nameStr) {
            try { nameStr = readNullTerminatedAscii16(fullMsg.slice(0x0A, 0x0A + 16)); } catch {}
          }

          window.kit.kitName = (nameStr && nameStr.length) ? nameStr.split("") : [" "];
        }

        const dst = resolveIndex(window.kitLibrary, wireSlot + (opts.kitOffset|0),
          { overwrite: opts.overwriteKits, findNextEmpty: opts.fillNextEmptyKits, clampLen: 64 });
        if (dst == null) return;

        if (typeof window.commitKitSlot === "function") {
          window.commitKitSlot(dst, isKitEmpty(window.kit) ? null : window.kit, { silent: true });
        } else {
          const kitObj = !isKitEmpty(window.kit) ? clone(window.kit) : null;
          if (kitObj) {
            kitObj.sysexPosition = dst;
            kitObj.sysexVersion = kitObj.sysexVersion || 6;
            kitObj.sysexRevision = kitObj.sysexRevision || 1;
            kitObj.rawKit = null;
          }
          window.kitLibrary[dst] = kitObj ? { data: kitObj, colorIndex: dst } : null;
        }

        summary.kits.push({ slot: dst + 1, ver, rev, name: sanitizeKitName(window.kit && window.kit.kitName) });
        if (!opts.silentUI) { if (typeof window.buildKitSlotsUI === "function") window.buildKitSlotsUI(); }
        break;
      }

      case ID.PATTERN: {
        if (filters?.patterns && !filters.patterns.has(wireSlot)) return;
        if (typeof window.receivePatternDump !== "function") return;
        try {
          window.receivePatternDump(fullMsg.slice(0, -1), window.pattern);
         if (window.normalizePatternInPlace) window.normalizePatternInPlace(window.pattern);
        } catch (e) { console.error("[SYX][PATTERN] Decoder threw:", e); return; }

        if (window.pattern && (window.pattern.assignedKitNumber == null || isNaN(window.pattern.assignedKitNumber))) {
          const kitByte = fullMsg.length > 0xB5 ? (fullMsg[0xB5] & 0x7F) : 0;
          window.pattern.assignedKitNumber = kitByte;
        }

        const pos = (window.pattern && typeof window.pattern.origPos === "number")
          ? window.pattern.origPos : wireSlot;
        const dst = resolveIndex(window.allPatternSlots, pos + (opts.patternOffset|0),
          { overwrite: opts.overwritePatterns, findNextEmpty: opts.fillNextEmptyPatterns, clampLen: 128 });

        if (dst == null) return;

        const storedPattern = deepClonePreserveTypedArrays(window.pattern);

        if (typeof window.commitPatternSlot === "function") {
          if (isPatternEmpty(window.pattern)) {
            try { storedPattern.assignedKitNumber = -1; } catch (_) {}
            window.commitPatternSlot(dst, null, { silent: true });
          } else {
            window.commitPatternSlot(dst, storedPattern, { silent: true });
          }
        } else {
          if (!isPatternEmpty(window.pattern) && storedPattern) {
            storedPattern.origPos = dst;
            storedPattern.patternNumber = dst;
            storedPattern.sysexVersion = storedPattern.sysexVersion || 3;
            storedPattern.sysexRevision = storedPattern.sysexRevision || 1;
            storedPattern.rawPattern = null;
          }
          window.allPatternSlots[dst] = isPatternEmpty(window.pattern) ? null : {
            kit: null,
            pattern: storedPattern,
            kitColorIndex: Math.max(0, Math.min(63, window.pattern.assignedKitNumber || 0))
          };
        }

        summary.patterns.push({
          label: window.patternIndexToLabel ? window.patternIndexToLabel(dst) : (dst + 1),
          ver, rev
        });

        if (!opts.silentUI) {
        if (typeof window.buildPatternSlotsUI === "function") window.buildPatternSlotsUI();
                if (typeof window.buildTopPatternBanksUI === "function") window.buildTopPatternBanksUI();
                if (typeof window.attachBankSlotClickHandlers === "function") window.attachBankSlotClickHandlers();
                if (typeof window.colorizeSlots === "function") window.colorizeSlots();
        }
        break;
      }

      case ID.SONG: {
        if (filters?.songs && !filters.songs.has(wireSlot)) return;
        const sysexBody = fullMsg.slice(6);
        if (typeof window.receiveSongDump !== "function") return;
        let decodedSong = null;
        {
          const prevBulk = !!window.isBulkInProgress;
          const prevRecvAll = !!window.isReceiveAllInProgress;
          const prevSlots = window.allSongSlots;
          const prevBuild = window.buildSongSlotsUI;

          window.isBulkInProgress = true;
          window.isReceiveAllInProgress = true;
          window.allSongSlots = new Array(32).fill(null);
          window.buildSongSlotsUI = () => {};

          const tmpObj = {};
          try {
            window.receiveSongDump(sysexBody, tmpObj);
            decodedSong = tmpObj;
          } catch (e) {
            console.error("[SYX][SONG] Decoder threw:", e);
          } finally {
            window.allSongSlots = prevSlots;
            window.buildSongSlotsUI = prevBuild;
            window.isBulkInProgress = prevBulk;
            window.isReceiveAllInProgress = prevRecvAll;
          }
        }
        if (!decodedSong || typeof decodedSong !== "object") return;

        const srcIdx = wireSlot;
        const dstIdx = resolveIndex(window.allSongSlots, srcIdx + (opts.songOffset|0),
          { overwrite: opts.overwriteSongs, findNextEmpty: opts.fillNextEmptySongs, clampLen: 32 });
        if (dstIdx == null) return;

        const songEmpty = (typeof window.isSongEmpty === "function")
          ? window.isSongEmpty(decodedSong)
          : (typeof isSongEmpty === "function" ? isSongEmpty(decodedSong) : false);
        const songToStore = songEmpty ? null : decodedSong;

        if (typeof window.commitSongSlot === "function") {
          window.commitSongSlot(dstIdx, songToStore, { silent: true });
        } else {
          if (!songToStore) {
            window.allSongSlots[dstIdx] = null;
          } else {
            const songClone = (typeof structuredClone === "function")
              ? structuredClone(songToStore)
              : JSON.parse(JSON.stringify(songToStore));
            songClone.slotIndex = dstIdx;
            songClone.rawSong = null;
            window.allSongSlots[dstIdx] = songClone;
          }
        }

        const songName = (window.allSongSlots[dstIdx] && window.allSongSlots[dstIdx].name) || "";
        summary.songs.push({ slot: dstIdx + 1, ver, rev, name: songName });
        if (!opts.silentUI) {
        if (typeof window.buildSongSlotsUI === "function") window.buildSongSlotsUI();
        if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();
        }
        break;
      }

      default:
        summary.skipped.push({ id: "0x" + toHex2(msgId), len: fullMsg.length });
    }
  }

  window.importSysexBytes = function importSysexBytes(bytes, options = {}) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const opts = {
      kitOffset: 0, patternOffset: 0, songOffset: 0, globalOffset: 0,
      overwriteKits: true, overwritePatterns: true, overwriteSongs: true, overwriteGlobals: true,
      fillNextEmptyKits: false, fillNextEmptyPatterns: false, fillNextEmptySongs: false, fillNextEmptyGlobals: false,
      onlyKits: null, onlyPatterns: null, onlySongs: null, onlyGlobals: null,
      silentUI: false,
    };
    Object.assign(opts, options);

    const filters = {
      kits:     Array.isArray(opts.onlyKits)     ? new Set(opts.onlyKits.map(n => n|0)) : null,
      patterns: Array.isArray(opts.onlyPatterns) ? new Set(opts.onlyPatterns.map(n => n|0)) : null,
      songs:    Array.isArray(opts.onlySongs)    ? new Set(opts.onlySongs.map(n => n|0)) : null,
      globals:  Array.isArray(opts.onlyGlobals)  ? new Set(opts.onlyGlobals.map(n => n|0)) : null
    };
    const summary = { kits: [], patterns: [], songs: [], globals: [], skipped: [] };
    let cursor = 0;

    const __prevImportFlag = window.__mddtImporting;
    window.__mddtImporting = true;
    try {
      while (true) {
      const span = findNextSysEx(view, cursor);
      if (!span) break;
      const [start, end] = span;
      const msg = view.slice(start, end + 1);
      if (msg.length >= 10 && eqHeader(msg, 0)) applyMessage(msg, summary, opts, filters);
      else summary.skipped.push({ id: "N/A", len: msg.length });
      cursor = end + 1;
      }
    } finally {
      window.__mddtImporting = __prevImportFlag;
    }

    if (!opts.silentUI && typeof window.initUI === "function") window.initUI();
    return summary;
  };

  window.importSysexFile = function importSysexFile(file, options) {
    if (!file) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.onload = () => {
        try {
          const bytes = new Uint8Array(reader.result);
          const result = window.importSysexBytes(bytes, options);
          resolve(result);
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  };

  // --------- Scanner utilities ---------
  function toHex2(n){ return ("0" + (n & 0xFF).toString(16)).slice(-2).toUpperCase(); }
  function findNextSysEx(view, start = 0) {
    let i = start;
    const end = view.length;
    for (; i < end - 1; i++) {
      if (view[i] === 0xF0) {
        let j = i + 1;
        while (j < end && view[j] !== 0xF7) j++;
        if (j < end) return [i, j];
        break;
      }
    }
    return null;
  }
  function patternIndexToLabel(idx) {
    const bank = "ABCDEFGH"[Math.floor(idx / 16)] || "?";
    const num  = (idx % 16) + 1;
    return `${bank}${String(num).padStart(2, "0")}`;
  }

  window.isLikelySysexFile = async function isLikelySysexFile(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".syx")) return true;
    const buf = await file.slice(0, 64).arrayBuffer();
    const v = new Uint8Array(buf);
    for (let off = 0; off <= v.length - MD_HDR.length; off++) {
      let ok = true;
      for (let i = 0; i < MD_HDR.length; i++) if (v[off + i] !== MD_HDR[i]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  };

  window.scanSysexBytes = function scanSysexBytes(bytes) {
    const v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const result = { types:{kits:0,patterns:0,songs:0,globals:0,unknown:0}, kits:[], patterns:[], songs:[], globals:[], messages:0 };
    let cursor = 0;
    while (true) {
      const span = findNextSysEx(v, cursor);
      if (!span) break;
      const [start, end] = span;
      const m = v.slice(start, end + 1);
      result.messages++;
      if (m.length >= 10 && eqHeader(m, 0)) {
        const id = m[6] & 0x7F;
        const wireSlot = (m.length > 9) ? (m[9] & 0x7F) : 0;
        switch (id) {
          case ID.GLOBAL:  result.types.globals++;  if (!result.globals.includes(wireSlot))  result.globals.push(wireSlot);  break;
          case ID.KIT:     result.types.kits++;     if (!result.kits.includes(wireSlot))     result.kits.push(wireSlot);     break;
          case ID.PATTERN: result.types.patterns++; if (!result.patterns.includes(wireSlot)) result.patterns.push(wireSlot); break;
          case ID.SONG:    result.types.songs++;    if (!result.songs.includes(wireSlot))    result.songs.push(wireSlot);    break;
          default:         result.types.unknown++; break;
        }
      } else result.types.unknown++;
      cursor = end + 1;
    }
    result.kits.sort((a,b)=>a-b); result.patterns.sort((a,b)=>a-b); result.songs.sort((a,b)=>a-b); result.globals.sort((a,b)=>a-b);
    return result;
  };

  window.sysexScanToBackupLike = function sysexScanToBackupLike(scan, meta = {}) {
    const kits = scan.kits.map(idx => ({ slot: idx, slotHuman: idx + 1, name: "(from .syx)" }));
    const patterns = scan.patterns.map(idx => ({ slot: idx, label: patternIndexToLabel(idx), steps: null }));
    const songs = scan.songs.map(idx => ({ slot: idx, slotHuman: idx + 1, name: "(from .syx)" }));
    return { __source: "syx", meta: { ...meta, messages: scan.messages }, kits, patterns, songs };
  };
})();
