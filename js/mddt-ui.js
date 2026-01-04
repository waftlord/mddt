/* ui.js */

window.shiftKeyIsDown = false;
["keydown", "keyup"].forEach(evt => {
  window.addEventListener(evt, e => {
    if (e.key === "Shift") {
      window.shiftKeyIsDown = (evt === "keydown");
    }
  });
});

window.panelStates = {};
window.editorClipboard = { type: null, data: null };
window.lastUndoRecord = { type: null, trackOrRow: -1, oldData: null };
window.activePanel = "kit";
window.selectedKitTrackIndex = 0;
window.selectedPatternTrackIndex = 0;
window.selectedSongRowIndex = -1;

// --- External Lab Module Registry + Host Adapter (for SwingLoom etc.) ---
(function(){
  // Registry for Lab modules (bundled + imported). The tabbed Lab host renders from this.
  window.MDDT = window.MDDT || {};
  const registry = Array.isArray(window.MDDT._labModules) ? window.MDDT._labModules : [];
  window.MDDT._labModules = registry;

  function normalizeId(mod){
    const id = (mod && mod.id != null) ? String(mod.id) : "";
    return id.trim();
  }

  function upsert(mod){
    const id = normalizeId(mod);
    if (!id) return;

    const i = registry.findIndex(m => m && String(m.id) === id);
    if (i === -1) registry.push(mod);
    else registry[i] = Object.assign(registry[i], mod);
  }

  // Called by external modules (e.g., SwingLoom) and by the Import tab.
  window.MDDT.registerLabModule = function(mod){
    if (!mod || typeof mod.mount !== "function") return;

    const id = normalizeId(mod);
    if (!id) return;

    // Tag import source (used by the Import tab)
    const ctx = window.MDDT && window.MDDT._labImportContext;
    const now = Date.now();
    const importing = !!(ctx && (typeof ctx.until !== "number" || now <= ctx.until));

    if (!mod.__labSource) mod.__labSource = importing ? "imported" : "bundled";
    if (importing && ctx && ctx.fileName && !mod.__labImportedFrom) {
      mod.__labImportedFrom = ctx.fileName;
    }

    upsert(mod);

    // Notify the tab host if it exists
    try {
      if (window.MDDT_LabHost && typeof window.MDDT_LabHost.onRegister === "function") {
        window.MDDT_LabHost.onRegister(mod);
      }
    } catch (e) {
      console.warn("[Lab] onRegister failed:", e);
    }
  };

  // Some modules look for a plain global registrar.
  if (typeof window.registerLabModule !== "function") {
    window.registerLabModule = window.MDDT.registerLabModule;
  }
})();

// Host function shims expected by external modules.
  if (typeof window.sendSysex !== 'function') {
    window.sendSysex = function(bytes) {
      if (!window.selectedMidiOut) throw new Error("No MIDI Out selected");
      window.selectedMidiOut.send(bytes);
    };
  }

// ---- Pattern: commit to local library and refresh UI (no SysEx required)
if (typeof window.commitPatternSlot !== 'function') {
  window.commitPatternSlot = function commitPatternSlot(slotIndex, patternObj, opts = {}) {
    const idx = (slotIndex|0) & 0x7F;

    // Clearing a slot is allowed
    if (!patternObj) {
      try {
        window.allPatternSlots = window.allPatternSlots || new Array(128).fill(null);
        window.allPatternSlots[idx] = null;
        if (!opts.silent) {
          window.buildPatternSlotsUI?.();
          window.buildTopPatternBanksUI?.();
          window.attachBankSlotClickHandlers?.();
          window.updatePanelHeaderColors?.();
        }

        // SlotStrip: local commit means this slot is now clean.
        try {
          const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
            ? window.MDDTSlotMap.buildUiSlotId({ type: "pattern", index: idx })
            : `pattern:${idx}`;
          window.UIBus?.emit("slot:clean", { uiSlotId, type: "pattern", index: idx, fn: "commitPatternSlot" });
        } catch (_) {}

      } catch (_) {}
      return null;
    }

    // 1) Normalize for MD encoding
    try { window.ensurePatternTrackArraysExist?.(); } catch (_) {}
    let pat = Object.assign({}, patternObj, {
      origPos: idx,
      patternNumber: idx,
      sysexVersion: 3,
      sysexRevision: 1,
      rawPattern: null
    });
    if (typeof window.normalizePattern === 'function') {
      pat = window.normalizePattern(pat) || pat;
    }

    // 2) Store a clean copy to the app's slot library so the UI shows it
    try {
      const cleaned = (typeof window.sanitizePattern === 'function')
        ? window.sanitizePattern(pat)
        : JSON.parse(JSON.stringify(pat));
      window.allPatternSlots = window.allPatternSlots || new Array(128).fill(null);
      window.allPatternSlots[idx] = {
        kit: null,
        pattern: cleaned,
        kitColorIndex: cleaned.assignedKitNumber || 0
      };

      // SlotStrip: local commit means this slot is now clean.
      try {
        const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
          ? window.MDDTSlotMap.buildUiSlotId({ type: "pattern", index: idx })
          : `pattern:${idx}`;
        window.UIBus?.emit("slot:clean", { uiSlotId, type: "pattern", index: idx, fn: "commitPatternSlot" });
      } catch (_) {}
    } catch (e) {
      console.warn('[commitPatternSlot] Failed to update local library', e);
    }

    // 3) UI refresh
    if (!opts.silent) {
      try { window.buildPatternSlotsUI?.(); } catch (_) {}
      try { window.buildTopPatternBanksUI?.(); } catch (_) {}
      try { window.attachBankSlotClickHandlers?.(); } catch (_) {}
      try { window.updatePanelHeaderColors?.(); } catch (_) {}
    }
    return pat;
  };
}

// ---- Pattern: writer used by external modules (optionally pushes SysEx when MIDI Out is present)
window.writePatternSlot = function writePatternSlot(slotIndex, patternObj, opts = { sendToMD: true }) {
  const pat = window.commitPatternSlot(slotIndex, patternObj, opts);
  if (!pat) return;

  try {
    if (opts && opts.sendToMD && window.selectedMidiOut) {
      const dump =
        (typeof window.createPatternDump === 'function')
          ? window.createPatternDump(pat)
          : (typeof window.storePatternSysex === 'function'
              ? window.storePatternSysex(pat.origPos|0, pat)
              : null);
      if (dump) window.selectedMidiOut.send(dump);
    }
  } catch (e) {
    console.warn('[writePatternSlot] MIDI send failed:', e);
  }
};

// ---- Kit: commit to local library + refresh UI
if (typeof window.commitKitSlot !== 'function') {
  window.commitKitSlot = function commitKitSlot(slotIndex, kitObj, opts = {}) {
    const idx = (slotIndex|0) & 0x3F;
    window.kitLibrary = window.kitLibrary || new Array(64).fill(null);

    // Allow clearing
    if (!kitObj) {
      window.kitLibrary[idx] = null;
      if (!opts.silent) {
        try { window.buildKitSlotsUI?.(); } catch (_) {}
        try { window.colorizeSlots?.(); } catch (_) {}
        try { window.updatePanelHeaderColors?.(); } catch (_) {}
      }
      try {
        if (window.mdDataRefs?.kits?.kitLibraryArray) {
          window.mdDataRefs.kits.kitLibraryArray[idx] = null;
        }
      } catch (_) {}

      // SlotStrip: clearing a slot should also clear the "dirty" indicator.
      try {
        const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
          ? window.MDDTSlotMap.buildUiSlotId({ type: "kit", index: idx })
          : `kit:${idx}`;
        window.UIBus?.emit("slot:clean", { uiSlotId, type: "kit", index: idx, fn: "commitKitSlot" });
      } catch (_) {}
      return null;
    }

    const kit = (typeof structuredClone === 'function')
      ? structuredClone(kitObj)
      : JSON.parse(JSON.stringify(kitObj));

    // Stamp minimal SysEx metadata so later exports / sends work reliably
    const is163 = (String(window.mdOSVersion) === "1.63") || (parseFloat(window.mdOSVersion) === 1.63);
    kit.sysexVersion  = is163 ? 4 : (kit.sysexVersion || 64);
    kit.sysexRevision = 1;
    kit.sysexPosition = idx;
    kit.rawKit = null;

    // OS 1.63: tonal flags are not round-tripped, so force them off
    if (is163 && Array.isArray(kit.machineTonalFlags)) {
      kit.machineTonalFlags = kit.machineTonalFlags.map(() => 0);
    }

    window.kitLibrary[idx] = { data: kit, colorIndex: idx };

    try {
      if (window.mdDataRefs?.kits?.kitLibraryArray) {
        window.mdDataRefs.kits.kitLibraryArray[idx] = window.kitLibrary[idx];
      }
    } catch (_) {}

    // SlotStrip: local commit means this slot is now clean.
    try {
      const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
        ? window.MDDTSlotMap.buildUiSlotId({ type: "kit", index: idx })
        : `kit:${idx}`;
      window.UIBus?.emit("slot:clean", { uiSlotId, type: "kit", index: idx, fn: "commitKitSlot" });
    } catch (_) {}

    if (!opts.silent) {
      try { window.buildKitSlotsUI?.(); } catch (_) {}
      try { window.colorizeSlots?.(); } catch (_) {}
      try { window.updatePanelHeaderColors?.(); } catch (_) {}
    }

    return kit;
  };
}

// ---- Kit: writer (optionally pushes SysEx when MIDI Out is present)
window.writeKitSlot = function writeKitSlot(slotIndex, kitObj, opts = { sendToMD: true }) {
  const kit = window.commitKitSlot(slotIndex, kitObj, opts);
  if (!kit) return;

  try {
    if (opts && opts.sendToMD && window.selectedMidiOut && typeof window.createKitDump === 'function') {
      const dump = window.createKitDump(kit);
      window.selectedMidiOut.send(dump);
    }
  } catch (e) {
    console.warn('[writeKitSlot] MIDI send failed:', e);
  }
};



// ---- Utilities: cloning + global normalisation (used by Global dirty indicator & imports)
try {
  window.MDDT = window.MDDT || {};
  window.MDDT.util = window.MDDT.util || {};

  if (typeof window.MDDT.util.deepClonePreserveTypedArrays !== 'function') {
    window.MDDT.util.deepClonePreserveTypedArrays = function deepClonePreserveTypedArrays(value) {
      const seen = new Map();
      const clone = (v) => {
        if (v === null || v === undefined) return v;
        const t = typeof v;
        if (t !== 'object') return v;
        if (seen.has(v)) return seen.get(v);

        // ArrayBuffer
        if (v instanceof ArrayBuffer) {
          const out = v.slice(0);
          seen.set(v, out);
          return out;
        }

        // Typed arrays / DataView
        if (ArrayBuffer.isView(v)) {
          if (v instanceof DataView) {
            const out = new DataView(clone(v.buffer));
            seen.set(v, out);
            return out;
          }
          const out = new v.constructor(v);
          seen.set(v, out);
          return out;
        }

        if (Array.isArray(v)) {
          const arr = [];
          seen.set(v, arr);
          for (const item of v) arr.push(clone(item));
          return arr;
        }

        const out = {};
        seen.set(v, out);
        for (const k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) {
            out[k] = clone(v[k]);
          }
        }
        return out;
      };
      return clone(value);
    };
  }

  if (typeof window.MDDT.util.normalizeGlobalObject !== 'function') {
    window.MDDT.util.normalizeGlobalObject = function normalizeGlobalObject(globalObj, slotIndex) {
      if (!globalObj || typeof globalObj !== 'object') return globalObj;

      const idx = (slotIndex | 0) & 0x07;
      if (typeof slotIndex === 'number' && Number.isFinite(slotIndex)) {
        globalObj.globalPosition = idx;
      }

      // Drum routing (16 values, 0..6)
      const drIn = Array.isArray(globalObj.drumRouting) ? globalObj.drumRouting : [];
      const dr = new Array(16);
      for (let i = 0; i < 16; i++) {
        let v = Number(drIn[i]);
        if (!Number.isFinite(v)) v = 0;
        v = Math.max(0, Math.min(6, v | 0));
        dr[i] = v;
      }
      globalObj.drumRouting = dr;

      // Keymap (128 values, default 0x7F). JSON/clone paths sometimes turn Uint8Array into
      // an Array or an object with numeric keys; we normalize to Uint8Array to avoid false
      // dirty indicators.
      const kmIn = globalObj.keymap;
      const km = new Uint8Array(128);
      km.fill(0x7F);
      for (let i = 0; i < 128; i++) {
        let v = undefined;
        if (kmIn && kmIn[i] != null) v = kmIn[i];
        if (v == null && kmIn && kmIn[String(i)] != null) v = kmIn[String(i)];
        if (v != null) {
          let n = Number(v);
          if (!Number.isFinite(n)) n = 0x7F;
          n = Math.max(0, Math.min(127, n | 0));
          km[i] = n;
        }
      }
      globalObj.keymap = km;

      // Tempo: MD stores tempo as a 14-bit integer in 1/24 BPM steps.
      let tempo = Number(globalObj.tempo);
      if (!Number.isFinite(tempo)) {
        if (Number.isFinite(globalObj.tempoHigh) && Number.isFinite(globalObj.tempoLow)) {
          const raw = ((globalObj.tempoHigh & 0x7F) << 7) | (globalObj.tempoLow & 0x7F);
          tempo = raw / 24;
        } else {
          tempo = 120;
        }
      }
      const rawTempo = Math.max(0, Math.min(0x3FFF, Math.round(tempo * 24)));
      globalObj.tempo = rawTempo / 24;
      globalObj.tempoHigh = (rawTempo >> 7) & 0x7F;
      globalObj.tempoLow = rawTempo & 0x7F;

      // Basic 7-bit sanitization for common numeric fields (keeps UI + SysEx sane)
      const n7 = (x, defVal = 0) => {
        const n = Number(x);
        return Number.isFinite(n) ? ((n | 0) & 0x7F) : defVal;
      };
      globalObj.midiBase = n7(globalObj.midiBase, 0);
      globalObj.mechanicalSettings = n7(globalObj.mechanicalSettings, 0);
      globalObj.extendedMode = n7(globalObj.extendedMode, 0);
      globalObj.flags = n7(globalObj.flags, 0);
      globalObj.localOn = n7(globalObj.localOn, 0);

      globalObj.drumLeft = n7(globalObj.drumLeft, 0);
      globalObj.drumRight = n7(globalObj.drumRight, 0);
      globalObj.gateLeft = n7(globalObj.gateLeft, 0);
      globalObj.gateRight = n7(globalObj.gateRight, 0);
      globalObj.senseLeft = n7(globalObj.senseLeft, 0);
      globalObj.senseRight = n7(globalObj.senseRight, 0);
      globalObj.minLevelLeft = n7(globalObj.minLevelLeft, 0);
      globalObj.minLevelRight = n7(globalObj.minLevelRight, 0);
      globalObj.maxLevelLeft = n7(globalObj.maxLevelLeft, 0);
      globalObj.maxLevelRight = n7(globalObj.maxLevelRight, 0);

      globalObj.programChangeMode = n7(globalObj.programChangeMode, 0) & 0x03;
      globalObj.programChangeChannel = n7(globalObj.programChangeChannel, 0) & 0x0F;
      globalObj.trigMode = n7(globalObj.trigMode, 0) & 0x03;

      // Minimal SysEx metadata
      globalObj.sysexVersion = n7(globalObj.sysexVersion, 6);
      globalObj.sysexRevision = n7(globalObj.sysexRevision, 1);

      // Strip non-semantic or derived fields that can cause false dirty markers
      try { globalObj.rawGlobal = null; } catch (_) {}
      try { globalObj.raw = null; } catch (_) {}
      try { globalObj.sysexEnd = null; } catch (_) {}
      try { delete globalObj.checksum; } catch (_) {}
      try { delete globalObj.messageLength; } catch (_) {}
      try { delete globalObj.programChange; } catch (_) {}

      return globalObj;
    };
  }

  if (typeof window.MDDT.util.makeGlobalComparable !== 'function') {
    window.MDDT.util.makeGlobalComparable = function makeGlobalComparable(globalObj) {
      if (!globalObj) return null;
      const clone = (typeof structuredClone === 'function')
        ? structuredClone(globalObj)
        : window.MDDT.util.deepClonePreserveTypedArrays(globalObj);
      window.MDDT.util.normalizeGlobalObject(clone, Number.isFinite(clone.globalPosition) ? clone.globalPosition : undefined);

      return {
        midiBase: clone.midiBase,
        mechanicalSettings: clone.mechanicalSettings,
        tempo: clone.tempo,
        extendedMode: clone.extendedMode,
        flags: clone.flags,
        localOn: clone.localOn,

        drumLeft: clone.drumLeft,
        drumRight: clone.drumRight,
        gateLeft: clone.gateLeft,
        gateRight: clone.gateRight,
        senseLeft: clone.senseLeft,
        senseRight: clone.senseRight,
        minLevelLeft: clone.minLevelLeft,
        minLevelRight: clone.minLevelRight,
        maxLevelLeft: clone.maxLevelLeft,
        maxLevelRight: clone.maxLevelRight,

        programChangeMode: clone.programChangeMode,
        programChangeChannel: clone.programChangeChannel,
        trigMode: clone.trigMode,

        drumRouting: Array.isArray(clone.drumRouting) ? clone.drumRouting.slice(0, 16) : [],
        keymap: Array.from(clone.keymap || new Uint8Array(128).fill(0x7F))
      };
    };
  }
} catch (e) {
  console.warn('[MDDT.util] helper init failed:', e);
}
// ---- Global: commit to local library + refresh UI
// (Matches the Kit/Pattern/Song commit helpers, and also stamps globalPosition so SysEx
// exports/send operations target the intended slot.)
if (typeof window.commitGlobalSlot !== 'function') {
  window.commitGlobalSlot = function commitGlobalSlot(slotIndex, globalObj, opts = {}) {
    const idx = (slotIndex|0) & 0x07;
    window.globalLibrary = window.globalLibrary || new Array(8).fill(null);

    // Allow clearing
    if (!globalObj) {
      window.globalLibrary[idx] = null;
      if (!opts.silent) {
        try { window.buildGlobalSlotsUI?.(); } catch (_) {}
        try { window.updatePanelHeaderColors?.(); } catch (_) {}
      }

      // SlotStrip: clearing a slot should also clear the "dirty" indicator.
      try {
        const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
          ? window.MDDTSlotMap.buildUiSlotId({ type: "global", index: idx })
          : `global:${idx}`;
        window.UIBus?.emit("slot:clean", { uiSlotId, type: "global", index: idx, fn: "commitGlobalSlot" });
      } catch (_) {}

      return null;
    }

    let gd;
    try {
      gd = (typeof structuredClone === 'function')
        ? structuredClone(globalObj)
        : (window.MDDT?.util?.deepClonePreserveTypedArrays
            ? window.MDDT.util.deepClonePreserveTypedArrays(globalObj)
            : JSON.parse(JSON.stringify(globalObj)));
    } catch (e) {
      gd = JSON.parse(JSON.stringify(globalObj));
    }

    // Normalize so equality checks + SysEx exports behave consistently (esp. keymap/tempo).
    try {
      if (window.MDDT?.util?.normalizeGlobalObject) {
        window.MDDT.util.normalizeGlobalObject(gd, idx);
      }
    } catch (_) {}

    // Stamp minimal SysEx metadata so later exports / sends work reliably
    gd.sysexVersion   = (gd.sysexVersion != null ? gd.sysexVersion : 6) & 0x7F;
    gd.sysexRevision  = (gd.sysexRevision != null ? gd.sysexRevision : 1) & 0x7F;
    gd.globalPosition = idx;
    gd.rawGlobal = null;

    window.globalLibrary[idx] = gd;

    // SlotStrip: local commit means this slot is now clean.
    try {
      const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
        ? window.MDDTSlotMap.buildUiSlotId({ type: "global", index: idx })
        : `global:${idx}`;
      window.UIBus?.emit("slot:clean", { uiSlotId, type: "global", index: idx, fn: "commitGlobalSlot" });
    } catch (_) {}

    if (!opts.silent) {
      try { window.buildGlobalSlotsUI?.(); } catch (_) {}
      try { window.updatePanelHeaderColors?.(); } catch (_) {}
    }
    return gd;
  };
}



  
  // ---- Global: writer (optionally pushes SysEx when MIDI Out is present)
  if (typeof window.writeGlobalSlot !== 'function') {
    window.writeGlobalSlot = function writeGlobalSlot(slotIndex, globalObj, opts = { sendToMD: true }) {
      const gd = window.commitGlobalSlot ? window.commitGlobalSlot(slotIndex, globalObj, opts) : null;
      if (!gd) return;

      try {
        if (opts && opts.sendToMD && window.selectedMidiOut && typeof window.createGlobalDump === 'function') {
          const dump = window.createGlobalDump(gd);
          window.selectedMidiOut.send(dump);

          // (Optional) load the written global into the active buffer
          const idx = (slotIndex|0) & 0x07;
          const loadMsg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x56, idx & 0x07, 0xF7]);
          window.selectedMidiOut.send(loadMsg);
        }
      } catch (e) {
        console.warn('[writeGlobalSlot] MIDI send failed:', e);
      }
    };
  }

if (typeof window.writeSongSlot !== 'function') {
    window.writeSongSlot = function(slotIndex, songObj) {
      if (!window.selectedMidiOut) throw new Error("No MIDI Out selected");
      const song = Object.assign({}, songObj, { slotIndex: (slotIndex|0) & 0x1F });
      if (typeof window.createSongDump !== 'function') throw new Error("No song encoder");
      const dump = window.createSongDump(song);
      window.selectedMidiOut.send(dump);

      // (Optional) load the written song into the active buffer
      const loadMsg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x6C, song.slotIndex & 0x1F, 0xF7]);
      window.selectedMidiOut.send(loadMsg);
    };
  }

  // Optional helpers SwingLoom can use; safe no‑ops if your core already handles this.
  if (typeof window.normalizePattern !== 'function') {
    window.normalizePattern = function(p) {
      const out = Object.assign({}, p || {});
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v|0));
      const makeBytes = () => new Uint8Array(8);
      const asU8 = (src, len = 8) => {
        // Support Uint8Array, Array, and JSON-objectified typed arrays
        if (src instanceof Uint8Array) return src;
        const out8 = new Uint8Array(len);
        if (!src) return out8;
        for (let i = 0; i < len; i++) {
          const v = src[i];
          out8[i] = (typeof v === 'number' && isFinite(v)) ? (v & 0xFF) : 0;
        }
        return out8;
      };
      const ensure16 = (arr) => {
        const A = new Array(16);
        for (let t = 0; t < 16; t++) {
          const src = (arr && arr[t]) || makeBytes();
          const u = asU8(src);
          A[t] = (u.length === 8) ? u : makeBytes();
        }
        return A;
      };

      // --- core scalars ---
      const len = clamp((out.length ?? out.len ?? 4), 2, 64);
      out.length = len;            // SwingLoom uses this
      out.len = len;               // many encoders read this

      const scale = (out.scale != null)
        ? out.scale
        : (len <= 16 ? 16 : (len <= 32 ? 32 : (len <= 48 ? 48 : 64)));
      out.scale = scale;

      // tempo multiplier (Machinedrum: 0=1x,1=2x,2=3/4x,3=3/2x)
      const tm = (out.tempoMult ?? out.tempoMultiplier ?? 0) & 3;
      out.tempoMult = tm;
      out.tempoMultiplier = tm;

      out.swingAmount = Math.max(0, Math.min(127, out.swingAmount ?? 0));
      out.swingEditAll = !!out.swingEditAll;

      // --- 16×8 byte blocks (provide all common aliases) ---
      const trig = out.trigBitsPerTrack || out.trigBytesPerTrack || out.trigs || out.trigBytes;
      const swing = out.swingBitsPerTrack || out.swingBytesPerTrack || out.swingMaskPerTrack || out.swingBytes;

      const trig16  = ensure16(trig);
      const swing16 = ensure16(swing);

      out.trigBitsPerTrack = trig16;  out.trigBytesPerTrack = trig16;
      out.trigs            = trig16;  out.trigBytes        = trig16;

      out.swingBitsPerTrack = swing16; out.swingBytesPerTrack = swing16;
      out.swingMaskPerTrack = swing16; out.swingBytes         = swing16;

      const gSwing = out.globalSwingBits || out.globalSwingBytes || null;
      out.globalSwingBits  = (gSwing instanceof Uint8Array && gSwing.length === 8) ? gSwing : new Uint8Array(8);
      out.globalSwingBytes = out.globalSwingBits;

       const accent = out.accentBitsPerTrack || out.accentBytesPerTrack || out.accents || out.accentBytes;
 const slide  = out.slideBitsPerTrack  || out.slideBytesPerTrack  || out.slides  || out.slideBytes;
 const acc16  = ensure16(accent);
 const sld16  = ensure16(slide);
 out.accentBitsPerTrack  = acc16; out.accentBytesPerTrack  = acc16; out.accents    = acc16; out.accentBytes = acc16;
 out.slideBitsPerTrack   = sld16; out.slideBytesPerTrack   = sld16; out.slides     = sld16; out.slideBytes  = sld16;
 const gAcc = out.accentBitsGlobal || out.globalAccentBits || out.globalAccentBytes || null;
 const gSld = out.slideBitsGlobal  || out.globalSlideBits  || out.globalSlideBytes  || null;
 out.accentBitsGlobal = (gAcc instanceof Uint8Array && gAcc.length === 8) ? gAcc : new Uint8Array(8);
 out.slideBitsGlobal  = (gSld instanceof Uint8Array && gSld.length === 8) ? gSld : new Uint8Array(8);
 // keep legacy aliases in sync
 out.globalAccentBits  = out.accentBitsGlobal;  out.globalAccentBytes = out.accentBitsGlobal;
 out.globalSlideBits   = out.slideBitsGlobal;   out.globalSlideBytes  = out.slideBitsGlobal;
 // booleans for extra block header
 out.accentEditAll = !!out.accentEditAll;
 out.slideEditAll  = !!out.slideEditAll;

      // kit index (optional)
      out.kit = (out.kit != null ? out.kit : out.kitNumber) ?? null;

      // locks (param locks) – keep array shape even if unused
      out.locks = Array.isArray(out.locks) ? out.locks : [];

      // slot bookkeeping some encoders use
      if (typeof out.origPos !== 'number' && typeof out.slot === 'number') out.origPos = out.slot|0;

      return out;
    };
  }
  if (typeof window.clampSongRowForPattern !== 'function') {
    // SwingLoom calls this if present; ensure Offset/Length are legal for the MD model.
    window.clampSongRowForPattern = function(row) {
      if (!row || !Array.isArray(row.data)) return;
      const mdIsMKI = (window.mdModel === "MKI");
      const patMax = mdIsMKI ? 32 : 64;
      const offMax = mdIsMKI ? 30 : 62;
      row.data[8] = Math.max(0, Math.min(offMax, row.data[8]|0));
      const remaining = patMax - row.data[8];
      row.data[9] = Math.max(2, Math.min(patMax, row.data[9]|0, remaining));
    };
  }

  // ---- Song: commit to local library and refresh UI
if (typeof window.commitSongSlot !== 'function') {
  window.commitSongSlot = function commitSongSlot(slotIndex, songObj, opts = {}) {
    const idx = (slotIndex|0) & 0x1F;
    window.allSongSlots = window.allSongSlots || new Array(32).fill(null);

    // Allow clearing a slot
    if (!songObj) {
      window.allSongSlots[idx] = null;
      if (!opts.silent) {
        if (typeof window.buildSongSlotsUI === 'function') window.buildSongSlotsUI();
        if (typeof window.updatePanelHeaderColors === 'function') window.updatePanelHeaderColors();
      }

      // SlotStrip: clearing a slot should also clear the "dirty" indicator.
      try {
        const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
          ? window.MDDTSlotMap.buildUiSlotId({ type: "song", index: idx })
          : `song:${idx}`;
        window.UIBus?.emit("slot:clean", { uiSlotId, type: "song", index: idx, fn: "commitSongSlot" });
      } catch (_) {}
      return null;
    }

    // Safe clone (fallback if structuredClone is unavailable)
    const song = (typeof structuredClone === 'function')
      ? structuredClone(songObj)
      : JSON.parse(JSON.stringify(songObj));

    song.slotIndex = idx;

    // Keep Song rows well-formed and legal for the MD model
    try { if (typeof window.normalizeEndMarker === 'function') window.normalizeEndMarker(song); } catch (_) {}
    try {
      if (typeof window.clampSongRowForPattern === 'function' && Array.isArray(song.rows)) {
        song.rows.forEach(r => window.clampSongRowForPattern(r));
      }
    } catch (_) {}

    // 1) Persist to the app’s source of truth
    window.allSongSlots[idx] = song;

    // SlotStrip: local commit means this slot is now clean.
    try {
      const uiSlotId = window.MDDTSlotMap?.buildUiSlotId
        ? window.MDDTSlotMap.buildUiSlotId({ type: "song", index: idx })
        : `song:${idx}`;
      window.UIBus?.emit("slot:clean", { uiSlotId, type: "song", index: idx, fn: "commitSongSlot" });
    } catch (_) {}

    // 2) UI refresh (single shot)
    if (!opts.silent) {
      if (typeof window.buildSongSlotsUI === 'function') window.buildSongSlotsUI();
      if (typeof window.updatePanelHeaderColors === 'function') window.updatePanelHeaderColors();
    }
    return song;
  };
}

// ---- Song: writer used by SwingLoom and other modules
// Always commit locally; optionally push SysEx when MIDI Out is present
window.writeSongSlot = function writeSongSlot(slotIndex, songObj, opts = { sendToMD: true }) {
  // Always commit first so the grid reflects the new data immediately
  window.commitSongSlot(slotIndex, songObj, opts);

  // Optionally send to the Machinedrum
  try {
    if (opts.sendToMD && window.selectedMidiOut && typeof window.createSongDump === 'function') {
      const idx = (slotIndex|0) & 0x1F;
      const dump = window.createSongDump(window.allSongSlots[idx]);
      window.selectedMidiOut.send(dump);
      // Load the written song into the active buffer (F0 00 20 3C 02 00 6C <slot> F7)
      const loadMsg = new Uint8Array([0xF0,0x00,0x20,0x3C,0x02,0x00,0x6C,(idx & 0x1F),0xF7]);
      window.selectedMidiOut.send(loadMsg);
    }
  } catch (e) {
    console.warn('[writeSongSlot] MIDI send failed:', e);
  }
};


// ---- Expose a stable Host API for Lab modules (built-in + imported)
// Modules should prefer MDDT.host over reaching into random globals.
(function(){
  const host = window.MDDT.host = window.MDDT.host || {};
  // Host API version for Lab modules (bundled + imported).
  // v2 adds machine metadata + UI range helpers + safer defaults for SysEx sending.
  host.apiVersion = 3;

  host.clone = function(obj){
    if (typeof structuredClone === 'function') return structuredClone(obj);
    if (window.MDDT && window.MDDT.util && typeof window.MDDT.util.deepClonePreserveTypedArrays === 'function') {
      return window.MDDT.util.deepClonePreserveTypedArrays(obj);
    }
    return JSON.parse(JSON.stringify(obj));
  };

  host.getRefs = function(){
    return {
      globals: window.globalLibrary,
      kits: window.kitLibrary,
      patterns: window.allPatternSlots,
      songs: window.allSongSlots
    };
  };

  host.getSelected = function(){
    return {
      kitSlot: window.selectedKitSlotIndex|0,
      patternSlot: window.selectedPatternSlotIndex|0,
      songSlot: window.selectedSongSlotIndex|0,
      globalSlot: window.selectedGlobalSlotIndex|0,
      activePanel: window.activePanel || ''
    };
  };

  host.labels = {
    patternIndexToLabel: (typeof window.patternIndexToLabel === 'function') ? window.patternIndexToLabel : null,
    patternLabelToIndex: (typeof window.patternLabelToIndex === 'function') ? window.patternLabelToIndex : null
  };

  // Writers / committers (local-first)
  host.commitKitSlot     = window.commitKitSlot;
  host.commitPatternSlot = window.commitPatternSlot;
  host.commitSongSlot    = window.commitSongSlot;
  host.commitGlobalSlot  = window.commitGlobalSlot;

  // NOTE: For Lab modules we default to NOT sending SysEx immediately.
  // If a module wants to push to the hardware, it must pass { sendToMD: true }.
  host.writeKitSlot = function(slotIndex, kitObj, opts = {}) {
    const o = Object.assign({}, opts);
    if (typeof o.sendToMD !== "boolean") o.sendToMD = false;
    return window.writeKitSlot ? window.writeKitSlot(slotIndex, kitObj, o) : null;
  };
  host.writePatternSlot = function(slotIndex, patternObj, opts = {}) {
    const o = Object.assign({}, opts);
    if (typeof o.sendToMD !== "boolean") o.sendToMD = false;
    return window.writePatternSlot ? window.writePatternSlot(slotIndex, patternObj, o) : null;
  };
  host.writeSongSlot = function(slotIndex, songObj, opts = {}) {
    const o = Object.assign({}, opts);
    if (typeof o.sendToMD !== "boolean") o.sendToMD = false;
    return window.writeSongSlot ? window.writeSongSlot(slotIndex, songObj, o) : null;
  };


  host.writeGlobalSlot = function(slotIndex, globalObj, opts = {}) {
    const o = Object.assign({}, opts);
    if (typeof o.sendToMD !== "boolean") o.sendToMD = false;
    return window.writeGlobalSlot ? window.writeGlobalSlot(slotIndex, globalObj, o) : null;
  };

  // Back-compat: keep direct access to the underlying window writers.
  // (Some modules intentionally want the old behavior.)
  host._unsafeWriteKitSlot     = window.writeKitSlot;
  host._unsafeWritePatternSlot = window.writePatternSlot;
  host._unsafeWriteSongSlot    = window.writeSongSlot;
  host._unsafeWriteGlobalSlot  = window.writeGlobalSlot;

  // Environment / model info (useful for "wordy" AI modules)
  host.getEnv = function getEnv(){
    const mdModel = window.mdModel || "MKII";
    const mdUWEnabled = !!window.mdUWEnabled;
    const mdOSVersion = window.mdOSVersion || "X";
    const modelConsts = (window.MD_MODEL_CONSTS && window.MD_MODEL_CONSTS[mdModel]) ? window.MD_MODEL_CONSTS[mdModel] : null;
    const maxPatternLength = (mdModel === "MKI") ? 32 : 64;
    return {
      mdModel,
      mdUWEnabled,
      mdOSVersion,
      maxPatternLength,
      romSlotCount: modelConsts?.romSlotCount ?? (mdModel === "MKI" ? 32 : 48),
      ramRecordPlayCount: modelConsts?.ramRecordPlayCount ?? (mdModel === "MKI" ? 2 : 4),
      slots: { globals: 8, kits: 64, patterns: 128, songs: 32 }
    };
  };

  // ───────────────────────────────────────────────────────────
  // Machine metadata + search helpers
  // ───────────────────────────────────────────────────────────
  host.machines = host.machines || {};

  function _machineNameFor(id){
    try {
      if (typeof window.getMachineName === "function") return window.getMachineName(id);
    } catch (_) {}
    const map = window.FULL_MACHINE_NAMES || {};
    return map[id] || (id === 0 ? "GND-EMPTY" : `(unknown #${id})`);
  }

  function _machineTagsFor(name){
    const tags = new Set();
    const n = String(name || "");
    if (!n) return [];

    const upper = n.toUpperCase();
    const parts = upper.split(/[-\s]+/g).filter(Boolean);
    parts.forEach(p => tags.add(p.toLowerCase()));

    // Friendly synonyms for common MD abbreviations
    if (parts.includes("BD") || upper.includes("-BD")) {
      tags.add("kick");
      tags.add("bass");
      tags.add("bassdrum");
    }
    if (parts.includes("SD") || parts.includes("SN")) tags.add("snare");
    if (parts.includes("CH")) { tags.add("hihat"); tags.add("hat"); tags.add("closedhat"); }
    if (parts.includes("OH")) { tags.add("hihat"); tags.add("hat"); tags.add("openhat"); }
    if (parts.includes("CY")) tags.add("cymbal");
    if (parts.includes("CP")) tags.add("clap");
    if (parts.includes("RS")) tags.add("rim");

    return Array.from(tags);
  }

  function _validMachineMapFor(opts = {}){
    const env = host.getEnv();
    const model = opts.mdModel || env.mdModel;
    const uw = (typeof opts.mdUWEnabled === "boolean") ? opts.mdUWEnabled : env.mdUWEnabled;

    let map = {};
    try {
      if (typeof window.getValidMachineEntries === "function") {
        map = window.getValidMachineEntries(model) || {};
      }
    } catch (_) {}

    // If UW is OFF, stay within the "classic" machine id range.
    if (!uw) {
      const filtered = {};
      Object.keys(map).forEach(k => {
        const id = parseInt(k, 10);
        if (Number.isFinite(id) && id <= 123) filtered[id] = map[k];
      });
      map = filtered;
    }

    // OS 1.63: remove machines only available under X OS
    try {
      if (String(env.mdOSVersion) === "1.63" && Array.isArray(window.X_OS_ONLY_MACHINES)) {
        const filtered = {};
        Object.keys(map).forEach(k => {
          const id = parseInt(k, 10);
          if (!window.X_OS_ONLY_MACHINES.includes(id)) filtered[id] = map[k];
        });
        map = filtered;
      }
    } catch (_) {}

    return map;
  }

  host.machines.getAll = function getAll(){
    const map = window.FULL_MACHINE_NAMES || {};
    const out = [];
    Object.keys(map).forEach(k => {
      const id = parseInt(k, 10);
      if (!Number.isFinite(id)) return;
      const name = map[k];
      out.push({ id, name, tags: _machineTagsFor(name) });
    });
    out.sort((a,b) => a.id - b.id);
    return out;
  };

  host.machines.getAllMap = function getAllMap(){
    const map = window.FULL_MACHINE_NAMES || {};
    // Return a shallow copy (avoid accidental mutation of the global map).
    const out = {};
    Object.keys(map).forEach(k => { out[k|0] = map[k]; });
    return out;
  };

  host.machines.getValid = function getValid(opts = {}){
    const map = _validMachineMapFor(opts);
    const out = [];
    Object.keys(map).forEach(k => {
      const id = parseInt(k, 10);
      if (!Number.isFinite(id)) return;
      const name = map[k] || _machineNameFor(id);
      out.push({ id, name, tags: _machineTagsFor(name) });
    });
    out.sort((a,b) => a.id - b.id);
    return out;
  };

  host.machines.getValidMap = function getValidMap(opts = {}){
    const map = _validMachineMapFor(opts);
    const out = {};
    Object.keys(map).forEach(k => { out[k|0] = map[k]; });
    return out;
  };

  // Resolve either a numeric id or a machine name (exact match, case-insensitive).
  // Returns a numeric id, or null if not found.
  host.machines.resolve = function resolve(nameOrId, opts = {}){
    if (typeof nameOrId === "number" && Number.isFinite(nameOrId)) return nameOrId|0;
    const s = String(nameOrId || "").trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10) | 0;

    const list = (opts.validOnly === false) ? host.machines.getAll() : host.machines.getValid(opts);
    const up = s.toUpperCase();
    const hit = list.find(m => String(m.name || "").toUpperCase() === up);
    return hit ? (hit.id|0) : null;
  };

  host.machines.search = function search(query, opts = {}){
    const q = String(query || "").trim();
    const list = (opts.validOnly === false) ? host.machines.getAll() : host.machines.getValid(opts);
    if (!q) return list;

    const qUpper = q.toUpperCase();
    const useRegex = !!opts.regex;
    let rx = null;
    if (useRegex) {
      try { rx = new RegExp(q, opts.regexFlags || "i"); } catch (_) { rx = null; }
    }

    return list.filter(m => {
      const name = String(m.name || "");
      if (rx) return rx.test(name);
      return name.toUpperCase().includes(qUpper);
    });
  };

  host.machines.findIds = function findIds(query, opts = {}){
    return host.machines.search(query, opts).map(m => m.id);
  };

  host.machines.getName = function getName(id){
    return _machineNameFor(id|0);
  };

  host.machines.getParamLabels = function getParamLabels(id){
    try {
      if (typeof window.getParamLabels === "function") return window.getParamLabels(id|0) || [];
    } catch (_) {}
    const base = (window.MACHINE_PARAM_LABELS && window.MACHINE_PARAM_LABELS[id|0]) ? window.MACHINE_PARAM_LABELS[id|0] : [];
    return Array.isArray(base) ? base.slice() : [];
  };

  host.machines.supportsTonal = function supportsTonal(id){
    try {
      return !!(window.MACHINES_THAT_SUPPORT_TONAL && window.MACHINES_THAT_SUPPORT_TONAL.has(id|0));
    } catch (_) {
      return false;
    }
  };

  // ───────────────────────────────────────────────────────────
  // Parameter label helpers (machine + FX + routing)
  // ───────────────────────────────────────────────────────────
  host.params = host.params || {};
  host.params.getLabel = function getLabel(machineID, paramIndex, category = "machineParams"){
    try {
      if (typeof window.getParamLabel === "function") {
        return window.getParamLabel(machineID|0, paramIndex|0, category);
      }
    } catch (_) {}
    return `${category}:${(paramIndex|0)+1}`;
  };
  host.params.machineParamLabels = window.MACHINE_PARAM_LABELS || {};
  host.params.trackFxLabels      = window.DEFAULT_TRACK_FX_LABELS || [];
  host.params.routingLabels      = window.DEFAULT_ROUTING_LABELS || [];
  host.params.masterFxNames      = window.masterFxNames || [];

  // ───────────────────────────────────────────────────────────
  // UI helpers: read noUiSlider ranges for slot/track targeting
  // ───────────────────────────────────────────────────────────
  host.ui = host.ui || {};

  function _getElById(id){
    try { return document.getElementById(String(id)); } catch (_) { return null; }
  }

  function _parseSliderValue(slider, v){
    const raw = (v != null) ? String(v) : "";
    try {
      const fmt = slider?.options?.format;
      if (fmt && typeof fmt.from === "function") {
        const parsed = fmt.from(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
    } catch (_) {}
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : raw;
  }

  host.ui.getSliderValues = function getSliderValues(idOrEl){
    const el = (typeof idOrEl === "string") ? _getElById(idOrEl) : idOrEl;
    if (!el) return null;
    const slider = el.noUiSlider;
    if (!slider || typeof slider.get !== "function") return null;
    try {
      const vals = slider.get();
      if (Array.isArray(vals)) return vals.map(v => _parseSliderValue(slider, v));
      return [_parseSliderValue(slider, vals)];
    } catch (_) {
      return null;
    }
  };

  host.ui.getRangeValues = function getRangeValues(id){
    // Accept "foo" (hidden input), "foo_slider" (slider), or a Tools slider id.
    const baseId = String(id || "");
    const sliderVals = host.ui.getSliderValues(baseId + "_slider") || host.ui.getSliderValues(baseId);
    if (sliderVals && sliderVals.length) return sliderVals.map(v => Number.isFinite(v) ? (v|0) : v);

    const input = _getElById(baseId);
    if (input && typeof input.value === "string" && input.value.includes(",")) {
      const parts = input.value.split(",").map(s => parseFloat(s.trim()));
      if (parts.length >= 2 && parts.every(Number.isFinite)) return [parts[0]|0, parts[1]|0];
    }
    return null;
  };

  // Scoped variant: read a hidden-range input / slider that lives inside a given element.
  // This avoids ID collisions when multiple Lab tabs define similar controls.
  host.ui.getRangeValuesIn = function getRangeValuesIn(scopeEl, id){
    const scope = (scopeEl && typeof scopeEl.querySelector === "function") ? scopeEl : null;
    if (!scope) return null;
    const baseId = String(id || "");

    const q = (sel) => { try { return scope.querySelector(sel); } catch (_) { return null; } };

    const sliderVals = host.ui.getSliderValues(q("#" + baseId + "_slider")) || host.ui.getSliderValues(q("#" + baseId));
    if (sliderVals && sliderVals.length) return sliderVals.map(v => Number.isFinite(v) ? (v|0) : v);

    const input = q("#" + baseId);
    if (input && typeof input.value === "string" && input.value.includes(",")) {
      const parts = input.value.split(",").map(s => parseFloat(String(s).trim()));
      if (parts.length >= 2 && parts.every(Number.isFinite)) return [parts[0]|0, parts[1]|0];
    }
    return null;
  };



  host.ui.getSlotRange = function getSlotRange(type, opts = {}){
    const t = String(type || "").toLowerCase();
    const prefer = (opts.prefer === "tools" || opts.prefer === "lab") ? opts.prefer : "lab";
    const scope = (opts.scope && typeof opts.scope.querySelector === "function") ? opts.scope : null;
    const explicitId = (opts.id != null) ? String(opts.id)
      : (opts.rangeId != null) ? String(opts.rangeId)
      : null;

    const clampSlotIndex = (n) => {
      const env = host.getEnv();
      const max = (t === "kit") ? (env.slots.kits - 1)
        : (t === "pattern") ? (env.slots.patterns - 1)
        : (t === "song") ? (env.slots.songs - 1)
        : (t === "global") ? (env.slots.globals - 1)
        : null;
      const x = n|0;
      if (max == null) return Math.max(0, x);
      return Math.max(0, Math.min(max|0, x));
    };

    const normalize = (a, b, source) => {
      const s = clampSlotIndex(Math.min(a|0, b|0));
      const e = clampSlotIndex(Math.max(a|0, b|0));
      return { start: s, end: e, source: source || "unknown" };
    };

    // 1) Prefer reading from a scoped Lab module UI (if provided).
    const fromScope = () => {
      if (!scope) return null;

      // Explicit id
      if (explicitId) {
        const vals = host.ui.getRangeValuesIn(scope, explicitId);
        if (vals) return normalize(vals[0], vals[1], "scope");
      }

      // Data-attribute driven (recommended for imported modules)
      try {
        const el = scope.querySelector('[data-mddt-role="slotRange"][data-kind="' + t + '"]');
        if (el) {
          const id = el.id ? String(el.id) : null;
          const vals = id ? host.ui.getRangeValuesIn(scope, id) : null;
          if (vals) return normalize(vals[0], vals[1], "scope");
          if (typeof el.value === "string" && el.value.includes(",")) {
            const parts = el.value.split(",").map(v => parseFloat(String(v).trim()));
            if (parts.length >= 2 && parts.every(Number.isFinite)) return normalize(parts[0], parts[1], "scope");
          }
        }
      } catch (_) {}

      // Legacy ids (inside the scope)
      const legacyId = (t === "kit") ? "kitSlotRange"
        : (t === "pattern") ? "patternSlotRange"
        : (t === "song") ? "songSlotRange"
        : (t === "global") ? "globalSlotRange"
        : null;
      if (legacyId) {
        const vals = host.ui.getRangeValuesIn(scope, legacyId);
        if (vals) return normalize(vals[0], vals[1], "scope");
      }
      return null;
    };

    const fromLab = () => {
      const id = (t === "kit") ? "kitSlotRange"
        : (t === "pattern") ? "patternSlotRange"
        : (t === "song") ? "songSlotRange"
        : null;
      if (!id) return null;
      const vals = host.ui.getRangeValues(id);
      if (!vals) return null;
      return normalize(vals[0], vals[1], "lab");
    };

    const fromTools = () => {
      const id = (t === "global") ? "slider-globals"
        : (t === "kit") ? "slider-kits"
        : (t === "pattern") ? "slider-patterns"
        : (t === "song") ? "slider-songs"
        : null;
      if (!id) return null;
      const vals = host.ui.getSliderValues(id);
      if (!vals || vals.length < 2) return null;
      let a = vals[0], b = vals[1];
      // Tools sliders are 1-based for everything except patterns.
      if (t === "global" || t === "kit" || t === "song") {
        a = (a|0) - 1;
        b = (b|0) - 1;
      } else {
        a = a|0;
        b = b|0;
      }
      return normalize(a, b, "tools");
    };

    const scoped = fromScope();
    if (scoped) return scoped;

    const r = (prefer === "lab") ? (fromLab() || fromTools()) : (fromTools() || fromLab());
    if (r) return r;

    // Fallback: current selected slot
    const sel = host.getSelected();
    if (t === "kit") return normalize(sel.kitSlot|0, sel.kitSlot|0, "selected");
    if (t === "pattern") return normalize(sel.patternSlot|0, sel.patternSlot|0, "selected");
    if (t === "song") return normalize(sel.songSlot|0, sel.songSlot|0, "selected");
    if (t === "global") return normalize((window.selectedGlobalSlotIndex|0) & 7, (window.selectedGlobalSlotIndex|0) & 7, "selected");
    return normalize(0, 0, "fallback");
  };



  host.ui.getTrackRange = function getTrackRange(type, opts = {}){
    const t = String(type || "").toLowerCase();
    const scope = (opts.scope && typeof opts.scope.querySelector === "function") ? opts.scope : null;
    const explicitId = (opts.id != null) ? String(opts.id)
      : (opts.rangeId != null) ? String(opts.rangeId)
      : null;

    const clampTrack = (n) => Math.max(0, Math.min(15, n|0));
    const normalize = (a, b, source) => {
      const s = clampTrack(Math.min(a|0, b|0));
      const e = clampTrack(Math.max(a|0, b|0));
      return { start: s, end: e, source: source || "unknown" };
    };

    const fromScope = () => {
      if (!scope) return null;

      if (explicitId) {
        const vals = host.ui.getRangeValuesIn(scope, explicitId);
        if (vals) return normalize(vals[0], vals[1], "scope");
      }

      try {
        const el = scope.querySelector('[data-mddt-role="trackRange"][data-kind="' + t + '"]');
        if (el) {
          const id = el.id ? String(el.id) : null;
          const vals = id ? host.ui.getRangeValuesIn(scope, id) : null;
          if (vals) return normalize(vals[0], vals[1], "scope");
          if (typeof el.value === "string" && el.value.includes(",")) {
            const parts = el.value.split(",").map(v => parseFloat(String(v).trim()));
            if (parts.length >= 2 && parts.every(Number.isFinite)) return normalize(parts[0], parts[1], "scope");
          }
        }
      } catch (_) {}

      const legacyId = (t === "kit") ? "kitTrackRange"
        : (t === "pattern") ? "patternTrackRange"
        : null;
      if (legacyId) {
        const vals = host.ui.getRangeValuesIn(scope, legacyId);
        if (vals) return normalize(vals[0], vals[1], "scope");
      }
      return null;
    };

    const scoped = fromScope();
    if (scoped) return scoped;

    const id = (t === "kit") ? "kitTrackRange" : (t === "pattern") ? "patternTrackRange" : null;
    if (!id) return normalize(0, 15, "default");

    const vals = host.ui.getRangeValues(id);
    if (!vals) return normalize(0, 15, "default");
    return normalize(vals[0], vals[1], "lab");
  };


  // Convenience: refresh slot UIs after doing many silent commits.
  // opts can be { kits:true, patterns:true, songs:true, globals:true }.
  host.ui.refreshSlots = function refreshSlots(opts = {}) {
    const o = Object.assign({ kits: true, patterns: true, songs: true, globals: true }, opts);
    try {
      if (o.kits) {
        window.buildKitSlotsUI?.();
        window.colorizeSlots?.();
      }
      if (o.patterns) {
        window.buildPatternSlotsUI?.();
        window.buildTopPatternBanksUI?.();
        window.attachBankSlotClickHandlers?.();
      }
      if (o.songs) {
        window.buildSongSlotsUI?.();
      }
      if (o.globals) {
        window.buildGlobalSlotsUI?.();
      }
      window.updatePanelHeaderColors?.();
    } catch (_) {}
  };



  // ───────────────────────────────────────────────────────────
  // Lab UI controls (noUiSlider + consistent styling)
  // ───────────────────────────────────────────────────────────
  host.ui.controls = host.ui.controls || {};
  (function initLabControls(){
    const controls = host.ui.controls;
    const LS_PREFIX = "labSlider:";

    const _safeGet = (k) => {
      try {
        if (typeof window.safeStorageGet === "function") return window.safeStorageGet(k);
        return localStorage.getItem(k);
      } catch (_) { return null; }
    };
    const _safeSet = (k, v) => {
      try {
        if (typeof window.safeStorageSet === "function") return window.safeStorageSet(k, v);
        return localStorage.setItem(k, v);
      } catch (_) { /* ignore */ }
    };
    const _safeDel = (k) => {
      try {
        if (typeof window.safeStorageRemove === "function") return window.safeStorageRemove(k);
        return localStorage.removeItem(k);
      } catch (_) { /* ignore */ }
    };

    controls.loadSliderValue = function loadSliderValue(id){
      const key = LS_PREFIX + String(id || "");
      const raw = _safeGet(key);
      if (!raw) return null;
      const parts = String(raw).split(",").map(v => parseFloat(String(v).trim()));
      return (parts.length >= 2 && parts.every(Number.isFinite)) ? parts : null;
    };

    controls.saveSliderValue = function saveSliderValue(id, values){
      const key = LS_PREFIX + String(id || "");
      const arr = Array.isArray(values) ? values : [];
      const nums = arr.map(v => Math.round(parseFloat(v))).filter(v => Number.isFinite(v));
      if (nums.length >= 2) _safeSet(key, nums.join(","));
    };

    controls.clearSliderValue = function clearSliderValue(id){
      const key = LS_PREFIX + String(id || "");
      _safeDel(key);
    };

    controls.miniButton = function miniButton(label, title, onClick){
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lab-mini-btn";
      btn.textContent = String(label || "Button");
      if (title) btn.title = String(title);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { if (typeof onClick === "function") onClick(); } catch (err) { console.warn("[Lab] Action failed:", err); }
      });
      return btn;
    };

    controls.subpanel = function subpanel(opts = {}){
      const section = document.createElement("section");
      section.className = "lab-subpanel";
      if (opts.id) section.id = String(opts.id);

      const header = document.createElement("div");
      header.className = "lab-subpanel-header";

      const titles = document.createElement("div");
      titles.className = "lab-subpanel-titles";

      const h = document.createElement("h3");
      h.className = "lab-subpanel-title";
      h.textContent = (opts.title != null) ? String(opts.title) : "Section";
      titles.appendChild(h);

      if (opts.subtitle) {
        const sub = document.createElement("div");
        sub.className = "lab-subpanel-subtitle";
        sub.textContent = String(opts.subtitle);
        titles.appendChild(sub);
      }

      header.appendChild(titles);

      const actions = document.createElement("div");
      actions.className = "lab-subpanel-actions";

      // Optional standard actions
      if (opts.actions && typeof opts.actions === "object") {
        if (typeof opts.actions.reset === "function") {
          actions.appendChild(controls.miniButton("Reset", "Reset section controls", opts.actions.reset));
        }
        if (typeof opts.actions.randomize === "function") {
          actions.appendChild(controls.miniButton("Random", "Randomize section controls", opts.actions.randomize));
        }
        if (Array.isArray(opts.actions.extra)) {
          opts.actions.extra.forEach((a) => {
            if (!a) return;
            actions.appendChild(controls.miniButton(a.label || "Action", a.title || "", a.onClick));
          });
        }
      }

      header.appendChild(actions);

      const body = document.createElement("div");
      body.className = "lab-subpanel-body";
      if (opts.contentEl) body.appendChild(opts.contentEl);

      section.appendChild(header);
      section.appendChild(body);

      return { section, body, header, actions, titles, titleEl: h };
    };

    function _uniqueId(prefix){
      const p = String(prefix || "mddt");
      const r = Math.random().toString(36).slice(2, 7);
      return p.replace(/\s+/g, "_") + "_" + Date.now().toString(36) + "_" + r;
    }
    controls.uniqueId = _uniqueId;

    controls.inputRow = function inputRow(labelText, type, id, defaultValue, attributes){
      const row = document.createElement("div");
      row.style.marginBottom = "8px";

      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = String(labelText || "") + " ";
      row.appendChild(label);

      let input;
      if (String(type).toLowerCase() === "textarea") {
        input = document.createElement("textarea");
      } else {
        input = document.createElement("input");
        input.type = String(type || "text");
      }
      input.id = String(id || _uniqueId("labInput"));
      if (defaultValue != null) input.value = String(defaultValue);
      input.dataset.defaultValue = String(defaultValue != null ? defaultValue : "");
      if (attributes && typeof attributes === "object") {
        Object.keys(attributes).forEach(attr => {
          try { input.setAttribute(attr, attributes[attr]); } catch (_) {}
        });
      }
      row.appendChild(input);
      return { row, input };
    };

    controls.rangeRow = function rangeRow(labelText, id, startVal, endVal, min, max, step, formatFn, opts = {}){
      const row = document.createElement("div");
      row.style.marginBottom = "12px";

      const label = document.createElement("label");
      // Center the label above the slider so modules don't look left-biased
      // when the slider has a max-width.
      label.style.display = "block";
      label.style.textAlign = "center";
      row.appendChild(label);

      const sliderContainer = document.createElement("div");
      const baseId = String(id || _uniqueId("labRange"));
      sliderContainer.id = baseId + "_slider";
      // Center the slider within the module.
      sliderContainer.style.margin = "8px auto";
      sliderContainer.className = "lab-slider";
      row.appendChild(sliderContainer);

      const hiddenInput = document.createElement("input");
      hiddenInput.type = "hidden";
      hiddenInput.id = baseId;

      // Optional semantic tags for scoped reads
      if (opts.role) hiddenInput.dataset.mddtRole = String(opts.role);
      if (opts.kind) hiddenInput.dataset.kind = String(opts.kind);

      // Persisted value (optional)
      const persist = (opts.persist !== false);
      const storageKey = (opts.storageKey != null) ? String(opts.storageKey) : baseId;
      const stored = persist ? controls.loadSliderValue(storageKey) : null;

      const initial = (stored && stored.length >= 2) ? [stored[0], stored[1]] : [startVal, endVal];

      hiddenInput.value = initial.map(v => Math.round(parseFloat(v))).join(",");
      hiddenInput.dataset.defaultValue = String(startVal) + "," + String(endVal);

      const disp0 = formatFn ? formatFn(initial[0]) : initial[0];
      const disp1 = formatFn ? formatFn(initial[1]) : initial[1];
      label.textContent = String(labelText || "") + " " + disp0 + " - " + disp1;

      row.appendChild(hiddenInput);

      // noUiSlider if available, otherwise fall back to two number inputs.
      if (typeof window.noUiSlider === "object" && typeof window.noUiSlider.create === "function") {
        window.noUiSlider.create(sliderContainer, {
          start: initial,
          connect: true,
          step: step,
          range: { min: min, max: max }
        });

        sliderContainer.noUiSlider.on("update", function (values) {
          const nums = values.map(v => Math.round(parseFloat(v)));
          hiddenInput.value = nums.join(",");
          const d0 = formatFn ? formatFn(nums[0]) : nums[0];
          const d1 = formatFn ? formatFn(nums[1]) : nums[1];
          label.textContent = String(labelText || "") + " " + d0 + " - " + d1;
        });

        sliderContainer.noUiSlider.on("set", function (values) {
          if (!persist) return;
          const nums = values.map(v => Math.round(parseFloat(v)));
          controls.saveSliderValue(storageKey, nums);
        });
      } else {
        // Fallback UI: two number inputs
        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.gap = "8px";

        const a = document.createElement("input");
        a.type = "number";
        a.min = String(min);
        a.max = String(max);
        a.step = String(step);
        a.value = String(initial[0]);

        const b = document.createElement("input");
        b.type = "number";
        b.min = String(min);
        b.max = String(max);
        b.step = String(step);
        b.value = String(initial[1]);

        const sync = () => {
          const va = Math.round(parseFloat(a.value));
          const vb = Math.round(parseFloat(b.value));
          const lo = Math.max(min, Math.min(max, Math.min(va, vb)));
          const hi = Math.max(min, Math.min(max, Math.max(va, vb)));
          hiddenInput.value = lo + "," + hi;
          const d0 = formatFn ? formatFn(lo) : lo;
          const d1 = formatFn ? formatFn(hi) : hi;
          label.textContent = String(labelText || "") + " " + d0 + " - " + d1;
          if (persist) controls.saveSliderValue(storageKey, [lo, hi]);
        };

        a.addEventListener("input", sync);
        b.addEventListener("input", sync);

        wrap.appendChild(a);
        wrap.appendChild(b);
        row.appendChild(wrap);
      }

      return {
        row,
        id: baseId,
        inputEl: hiddenInput,
        sliderEl: sliderContainer,
        get: () => host.ui.getRangeValues(baseId),
        set: (pair) => {
          const arr = Array.isArray(pair) ? pair : [];
          const v0 = (arr[0] != null) ? (arr[0]|0) : (startVal|0);
          const v1 = (arr[1] != null) ? (arr[1]|0) : (endVal|0);
          const lo = Math.min(v0, v1);
          const hi = Math.max(v0, v1);
          hiddenInput.value = lo + "," + hi;
          if (sliderContainer.noUiSlider) sliderContainer.noUiSlider.set([lo, hi]);
          if (persist) controls.saveSliderValue(storageKey, [lo, hi]);
        }
      };
    };

    const _oneBased = (v) => String((v|0) + 1);

    controls.slotRangeRow = function slotRangeRow(kind, opts = {}){
      const t = String(kind || "kit").toLowerCase();
      const env = host.getEnv();
      const max = (t === "kit") ? (env.slots.kits - 1)
        : (t === "pattern") ? (env.slots.patterns - 1)
        : (t === "song") ? (env.slots.songs - 1)
        : (t === "global") ? (env.slots.globals - 1)
        : 0;

      const id = opts.id || _uniqueId(t + "SlotRange");
      const label = opts.label || ((t === "kit") ? "Kit Slot Destination:"
        : (t === "pattern") ? "Pattern Slot Destination:"
        : (t === "song") ? "Song Slot Destination:"
        : (t === "global") ? "Global Slot Destination:"
        : "Slot Destination:");

      const start = (opts.start != null) ? (opts.start|0) : 0;
      const end = (opts.end != null) ? (opts.end|0) : max;

      const fmt = (t === "pattern" && host.labels && typeof host.labels.patternIndexToLabel === "function")
        ? (v) => host.labels.patternIndexToLabel(v|0)
        : _oneBased;

      return controls.rangeRow(label, id, start, end, 0, max, 1, fmt, Object.assign({}, opts, { role: "slotRange", kind: t }));
    };

    controls.trackRangeRow = function trackRangeRow(kind, opts = {}){
      const t = String(kind || "kit").toLowerCase();
      const id = opts.id || _uniqueId(t + "TrackRange");
      const label = opts.label || ((t === "pattern") ? "Track Range:" : "Track Range:");
      const start = (opts.start != null) ? (opts.start|0) : 0;
      const end = (opts.end != null) ? (opts.end|0) : 15;
      return controls.rangeRow(label, id, start, end, 0, 15, 1, _oneBased, Object.assign({}, opts, { role: "trackRange", kind: t }));
    };

    controls.resetPanel = function resetPanel(panelEl){
      const panel = (panelEl && typeof panelEl.querySelectorAll === "function") ? panelEl : null;
      if (!panel) return;

      const nodes = panel.querySelectorAll("input[data-default-value], textarea[data-default-value], select[data-default-value]");
      nodes.forEach((node) => {
        try {
          const def = node.dataset.defaultValue;
          if (def == null) return;

          if (node.type === "checkbox") {
            node.checked = (String(def) === "true" || String(def) === "1");
          } else {
            node.value = String(def);
          }

          // Try to drive the paired slider if present
          if (node.id) {
            const sliderContainer = panel.querySelector("#" + node.id + "_slider");
            if (sliderContainer && sliderContainer.noUiSlider) {
              if (String(node.value).includes(",")) {
                const parts = String(node.value).split(",").map(v => parseFloat(String(v).trim()));
                if (parts.length >= 2 && parts.every(Number.isFinite)) sliderContainer.noUiSlider.set(parts);
              } else {
                const v = parseFloat(String(node.value));
                if (Number.isFinite(v)) sliderContainer.noUiSlider.set(v);
              }
            }
          }
        } catch (_) {}
      });
    };

    controls.randomizePanel = function randomizePanel(panelEl){
      const panel = (panelEl && typeof panelEl.querySelectorAll === "function") ? panelEl : null;
      if (!panel) return;

      const sliders = panel.querySelectorAll("div[id$='_slider']");
      sliders.forEach((sliderContainer) => {
        const slider = sliderContainer.noUiSlider;
        if (!slider) return;
        try {
          const options = slider.options;
          const min = options.range.min;
          const max = options.range.max;
          const step = options.step || 1;
          const inputId = String(sliderContainer.id).replace("_slider", "");
          const hiddenInput = panel.querySelector("#" + inputId);

          if (hiddenInput && String(hiddenInput.value).includes(",")) {
            let v1 = Math.random() * (max - min) + min;
            let v2 = Math.random() * (max - min) + min;
            if (v1 > v2) { const tmp = v1; v1 = v2; v2 = tmp; }
            v1 = Math.round(v1 / step) * step;
            v2 = Math.round(v2 / step) * step;
            slider.set([v1, v2]);
          } else {
            let v = Math.random() * (max - min) + min;
            v = Math.round(v / step) * step;
            slider.set(v);
          }
        } catch (_) {}
      });
    };
  })();
// ───────────────────────────────────────────────────────────
  // Pattern helpers (bitfields + safe trim)
  // ───────────────────────────────────────────────────────────
  host.pattern = host.pattern || {};

  host.pattern.bitfieldFromSteps = function bitfieldFromSteps(length, steps){
    const len = Math.max(0, Math.min(64, length|0));
    const arr = new Uint8Array(8);
    const effectiveBytes = Math.ceil(len / 8);
    const list = Array.isArray(steps) ? steps : [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]|0;
      if (s < 0 || s >= len) continue;
      const bIndex = (s / 8) | 0;
      const bPos = s % 8;
      if (bIndex < effectiveBytes) arr[bIndex] |= (1 << bPos);
    }
    return arr;
  };

  host.pattern.stepsFromBitfield = function stepsFromBitfield(bitArr, length){
    const len = Math.max(0, Math.min(64, length|0));
    const out = [];
    const effectiveBytes = Math.ceil(len / 8);
    for (let b = 0; b < effectiveBytes; b++) {
      const byte = (bitArr && bitArr[b]) ? (bitArr[b] & 0xFF) : 0;
      for (let bit = 0; bit < 8; bit++) {
        const step = b * 8 + bit;
        if (step >= len) break;
        if (byte & (1 << bit)) out.push(step);
      }
    }
    return out;
  };

  host.pattern.trimToLength = function trimToLength(patternObj, newLength){
    if (!patternObj) return patternObj;
    const max = (host.getEnv().mdModel === "MKI") ? 32 : 64;
    const len = Math.max(2, Math.min(max, newLength|0));
    const p = patternObj;
    p.length = len;

    const clearBeyond = (bits) => {
      if (!(bits instanceof Uint8Array) || bits.length < 8) return;
      for (let step = len; step < 64; step++) {
        const bIndex = (step / 8) | 0;
        const bPos = step % 8;
        bits[bIndex] &= ~(1 << bPos);
      }
    };

    try {
      if (Array.isArray(p.trigBitsPerTrack)) p.trigBitsPerTrack.forEach(clearBeyond);
      if (p.accentBitsGlobal) clearBeyond(p.accentBitsGlobal);
      if (Array.isArray(p.accentBitsPerTrack)) p.accentBitsPerTrack.forEach(clearBeyond);
      if (p.swingBitsGlobal) clearBeyond(p.swingBitsGlobal);
      if (Array.isArray(p.swingBitsPerTrack)) p.swingBitsPerTrack.forEach(clearBeyond);
      if (p.slideBitsGlobal) clearBeyond(p.slideBitsGlobal);
      if (Array.isArray(p.slideBitsPerTrack)) p.slideBitsPerTrack.forEach(clearBeyond);
    } catch (_) {}

    return p;
  };

  // A compact, JSON-friendly summary that LLM-driven modules can consume.
  host.getKnowledge = function getKnowledge(opts = {}) {
    // Intended for LLM / tooling: a self-contained snapshot of what's possible.
    const env = (typeof host.getEnv === "function") ? host.getEnv() : {};

    const machines = (host.machines && typeof host.machines.getValid === "function")
      ? host.machines.getValid().map(m => ({ id: m.id, name: m.name, type: m.type, uw: !!m.uw }))
      : [];

    const params = {
      masterFxNames: (host.params && typeof host.params.getMasterFxName === "function")
        ? Array.from({ length: 32 }, (_, i) => host.params.getMasterFxName(i))
        : [],
      routingNames: (host.params && typeof host.params.getRoutingName === "function")
        ? Array.from({ length: 8 }, (_, i) => host.params.getRoutingName(i))
        : [],
      trackFxNames: (host.params && typeof host.params.getTrackFxName === "function")
        ? Array.from({ length: 16 }, (_, i) => host.params.getTrackFxName(i))
        : []
    };

    const schema = {
      // --- Slot libraries
      libraries: {
        globals: { slots: 8, ref: "globals" },
        kits: { slots: 64, ref: "kits" },
        patterns: { slots: 128, ref: "patternSlots" },
        songs: { slots: 32, ref: "songs" }
      },

      // --- Kit object (kitLibrary[])
      kit: {
        fields: [
          "kitName", "sysexVersion", "sysexPosition",
          "machineAssignments", "machineTonalFlags", "trackLevels",
          "muteTrigRelations", "lfoBlocks",
          "controllers", "trackFx", "routing", "masterFx",
          "uWBlock",
          "rawKit"
        ],
        arrays: {
          machineAssignments: { type: "number[]", shape: [16], range: "0..127 (machine ID)" },
          machineTonalFlags: { type: "number[]", shape: [16], range: "0|1" },
          trackLevels: { type: "number[]", shape: [16], range: "0..127" },
          muteTrigRelations: { type: "number[][]", shape: [16, 2], range: "0..16 (0='--')" },
          lfoBlocks: { type: "number[][]", shape: [16, 36], range: "0..127 (7-bit)" },
          controllers: { type: "number[][]", shape: [16, 24], range: "0..127" },
          trackFx: { type: "number[][]", shape: [16, 16], range: "0..127" },
          routing: { type: "number[][]", shape: [16, 8], range: "0..127" },
          masterFx: { type: "number[]", shape: [32], range: "0..127" },
          uWBlock: { type: "number[]", shape: [12], range: "0..127 (UW-only bytes)" }
        },
        notes: [
          "Most numeric values are 7-bit (0..127) as stored in Machinedrum SysEx.",
          "controllers holds 24 machine parameters per track (P1..P24).",
          "trackFx holds 16 values per track (used by the Track FX UI).",
          "rawKit is optional and is used for round-tripping/diagnostics."
        ]
      },

      // --- Pattern slot object (allPatternSlots[])
      patternSlot: {
        shape: {
          kit: "optional (often null)",
          kitColorIndex: "number (UI only)",
          pattern: "Pattern"
        },
        notes: [
          "allPatternSlots[i] may be null (empty slot) or an object containing a Pattern."
        ]
      },

      // --- Pattern object (slot.pattern)
      pattern: {
        fields: [
          "patternNumber", "origPos", "assignedKitNumber",
          "version", "revision", "extendedFlag",
          "length", "tempoMult", "scale",
          "swingAmount", "accentAmount",
          "accentEditAll", "swingEditAll", "slideEditAll",
          "trigBitsPerTrack", "accentBitsPerTrack", "swingBitsPerTrack", "slideBitsPerTrack",
          "accentBitsGlobal", "swingBitsGlobal", "slideBitsGlobal",
          "trackAccentMasks", "trackSwingMasks", "trackSlideMasks",
          "locks",
          "rawPattern",
          "lockMasks", "lockMasks2", "paramMatrixMain", "paramMatrixExtra"
        ],
        bitfields: {
          perTrack: { shape: [16, 8], type: "Uint8Array(8) or number[8]", meaning: "64-step bitfield" },
          global: { shape: [8], type: "Uint8Array(8) or number[8]", meaning: "64-step bitfield" }
        },
        locks: {
          item: { track: "0..15", step: "0..63", paramID: "1..48", paramVal: "0..127" },
          notes: [
            "paramID 1..24 = main params, 25..48 = extra params.",
            "locks[] is the easiest API to edit; the encoder rebuilds matrices from locks."
          ]
        },
        matrices: {
          lockMasks: { shape: [16, 8], type: "Uint8Array(8) or number[8]" },
          lockMasks2: { shape: [16, 8], type: "Uint8Array(8) or number[8]" },
          paramMatrixMain: { shape: [16, 24], type: "Uint8Array(24) or number[24]" },
          paramMatrixExtra: { shape: [16, 24], type: "Uint8Array(24) or number[24]" }
        }
      },

      // --- Song object (allSongSlots[])
      song: {
        fields: ["slotIndex", "name", "version", "revision", "rows"],
        row: {
          fields: ["index", "data"],
          dataBytes: 10,
          byteMap: [
            "0: patternOrCommand (0..127, 0xFE=special command, 0xFF=END)",
            "1: reserved (preserve)",
            "2: repeats (0..63 => 1..64) OR LOOP times (0=∞)",
            "3: targetRow (for LOOP/JUMP/HALT commands)",
            "4: mute mask (low byte; UI combines with byte 5)",
            "5: mute mask (high byte)",
            "6: BPM high (0xFF if inherit)",
            "7: BPM low  (0xFF if inherit)",
            "8: offset (0..63 steps)",
            "9: endStep = offset + length (UI edits length via endStep-offset)"
          ],
          commands: [
            "END: patternOrCommand = 0xFF",
            "LOOP/JUMP/HALT: patternOrCommand = 0xFE and byte 3 = target row, byte 2 = LOOP times (only for LOOP)"
          ]
        }
      }
    };

    // UI ranges are optional (depends on where getKnowledge() is called from).
    const scopeEl = opts && opts.scopeEl ? opts.scopeEl : document;
    const ui = {
      ranges: {
        kit: host.ui && host.ui.getSlotRange ? host.ui.getSlotRange("kit", { scope: scopeEl }) : null,
        pattern: host.ui && host.ui.getSlotRange ? host.ui.getSlotRange("pattern", { scope: scopeEl }) : null,
        song: host.ui && host.ui.getSlotRange ? host.ui.getSlotRange("song", { scope: scopeEl }) : null,
        global: host.ui && host.ui.getSlotRange ? host.ui.getSlotRange("global", { scope: scopeEl }) : null
      },
      trackRanges: {
        kit: host.ui && host.ui.getTrackRange ? host.ui.getTrackRange("kit", { scope: scopeEl }) : null,
        pattern: host.ui && host.ui.getTrackRange ? host.ui.getTrackRange("pattern", { scope: scopeEl }) : null
      }
    };

    const notes = [
      "Slot indices are 0-based in the API (kit 0..63, pattern 0..127, song 0..31, global 0..7).",
      "Most values are stored as raw 7-bit numbers (0..127). Use host.params + host.machines helpers for names.",
      "Use host.clone() before editing shared objects from host.getRefs()."
    ];

    return { apiVersion: host.apiVersion, env, schema, machines, params, ui, notes };
  };

  // A tiny logging helper for imported modules
  host.log   = (...args) => console.log('[MDDT Lab]', ...args);
  host.warn  = (...args) => console.warn('[MDDT Lab]', ...args);
  host.error = (...args) => console.error('[MDDT Lab]', ...args);

  // ───────────────────────────────────────────────────────────
  // MIDI helper for Lab modules (wrapper around the app-selected ports)
  // ───────────────────────────────────────────────────────────
  host.midi = host.midi || {};

  Object.defineProperty(host.midi, "in", {
    configurable: true,
    enumerable: true,
    get: () => window.selectedMidiIn || null
  });

  Object.defineProperty(host.midi, "out", {
    configurable: true,
    enumerable: true,
    get: () => window.selectedMidiOut || null
  });

  // Send raw MIDI bytes (Note On/Off, CC, etc.)
  // If timestampMs is provided, uses MIDIOutput.send(data, timestampMs).
  // Returns true if the message was sent.
  host.midi.send = function send(data, timestampMs) {
    const out = window.selectedMidiOut;
    if (!out || typeof out.send !== "function") return false;

    const bytes = (data instanceof Uint8Array) ? data : new Uint8Array(data);

    try {
      if (typeof timestampMs === "number" && Number.isFinite(timestampMs)) out.send(bytes, timestampMs);
      else out.send(bytes);
      return true;
    } catch (e) {
      console.warn("[host.midi.send] failed:", e);
      return false;
    }
  };

  // Subscribe to incoming MIDI messages from the selected input.
  // Returns an unsubscribe function.
  host.midi.onMessage = function onMessage(handler) {
    const input = window.selectedMidiIn;
    if (!input || !handler) return () => {};

    const fn = (ev) => { try { handler(ev); } catch (e) { console.warn("[host.midi.onMessage] handler error:", e); } };

    try {
      input.addEventListener("midimessage", fn);
      return () => { try { input.removeEventListener("midimessage", fn); } catch (_) {} };
    } catch (_) {
      const prev = input.onmidimessage;
      input.onmidimessage = fn;
      return () => { try { input.onmidimessage = prev || null; } catch (_) {} };
    }
  };

  // ───────────────────────────────────────────────────────────
  // Tone.js helpers for Lab modules (lazy loader + user-gesture start)
  // ───────────────────────────────────────────────────────────
  host.audio = host.audio || {};

  const TONE_VERSION_PIN = "15.1.22"; // bump after testing
  const TONE_URLS = [
    `https://cdn.jsdelivr.net/npm/tone@${TONE_VERSION_PIN}/build/Tone.js`,
    `https://unpkg.com/tone@${TONE_VERSION_PIN}/build/Tone.js`,
    "https://cdn.jsdelivr.net/npm/tone@latest/build/Tone.js"
  ];

  let _toneLoadPromise = null;
  let _toneStarted = false;

  function _loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset && existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", resolve, { once: true });
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
  }

  // Loads Tone.js (lazy). Safe to call multiple times.
  host.audio.ensureToneLoaded = async function ensureToneLoaded() {
    if (window.Tone) return window.Tone;
    if (_toneLoadPromise) return _toneLoadPromise;

    _toneLoadPromise = (async () => {
      let lastErr = null;
      for (const url of TONE_URLS) {
        try {
          await _loadScriptOnce(url);
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
  };

  // Calls ensureToneLoaded(), then starts/resumes the audio context.
  // MUST be called from a user gesture (button click) in most browsers.
  host.audio.ensureToneStarted = async function ensureToneStarted() {
    const Tone = await host.audio.ensureToneLoaded();

    if (!_toneStarted) {
      await Tone.start();
      _toneStarted = true;
    } else {
      try { await Tone.context?.resume?.(); } catch (_) {}
    }
    return Tone;
  };

  // Convert a Tone.js scheduled time (seconds) to a WebMIDI timestamp (ms)
  // suitable for MIDIOutput.send(data, timestampMs).
  host.audio.toneTimeToMidiMs = function toneTimeToMidiMs(toneTimeSeconds) {
    const Tone = window.Tone;
    if (!Tone || typeof Tone.now !== "function") return performance.now();
    return (toneTimeSeconds - Tone.now()) * 1000 + performance.now();
  };

  // Also mirror a few common entry points directly on MDDT for convenience/compat.
  window.MDDT.commitKitSlot     = window.commitKitSlot;
  window.MDDT.writeKitSlot      = window.writeKitSlot;
  window.MDDT.commitPatternSlot = window.commitPatternSlot;
  window.MDDT.writePatternSlot  = window.writePatternSlot;
  window.MDDT.commitSongSlot    = window.commitSongSlot;
  window.MDDT.writeSongSlot     = window.writeSongSlot;
  window.MDDT.commitGlobalSlot  = window.commitGlobalSlot;
})();

// Used by initLabPanel to mount anything registered before the panel is built.
  window._mountRegisteredLabModules = function(){
    // Legacy no-op: the tabbed Lab host renders from MDDT._labModules.
    try {
      if (window.MDDT_LabHost && typeof window.MDDT_LabHost.onRegister === "function") {
        window.MDDT_LabHost.onRegister();
      }
    } catch (_) {}
  };



// Single-mode dark theme: the new shell always runs in dark mode.
// (We keep the optional toggle handler only if a toggle button exists,
// to stay backward-compatible with older HTML.)
document.addEventListener("DOMContentLoaded", function () {
  document.body.classList.add("dark-mode");

  const sg = (typeof window.safeStorageGet === "function")
    ? window.safeStorageGet
    : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const ss = (typeof window.safeStorageSet === "function")
    ? window.safeStorageSet
    : (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  ss("darkMode", "enabled");

  // Persist/restore CC Link toggle (helps "pick up where you left off").
  const ccLink = document.getElementById("ccLinkCheckbox");
  if (ccLink) {
    const saved = sg("ccLinkEnabled");
    if (saved != null) {
      ccLink.checked = (saved === "1" || saved === "true" || saved === "enabled");
    }
    ccLink.addEventListener("change", () => {
      ss("ccLinkEnabled", ccLink.checked ? "1" : "0");
    });
  }
});

const _darkModeToggleBtn = document.getElementById("darkModeToggleBtn");
if (_darkModeToggleBtn) {
  _darkModeToggleBtn.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    if (document.body.classList.contains("dark-mode")) {
      if (typeof window.safeStorageSet === "function") window.safeStorageSet("darkMode", "enabled");
      else try { localStorage.setItem("darkMode", "enabled"); } catch (_) {}
    } else {
      if (typeof window.safeStorageSet === "function") window.safeStorageSet("darkMode", "disabled");
      else try { localStorage.setItem("darkMode", "disabled"); } catch (_) {}
    }
    updateSongPanelHeader();
    buildSongSlotsUI();
  });
}

function rememberPanelStates() {
  document.querySelectorAll(".panel").forEach(panel => {
    const content = panel.querySelector(".panel-content");
    if (content) {
      const pid = panel.dataset.panelId;
      const isOpen = content.classList.contains("visible");
      window.panelStates[pid] = isOpen;
    }
  });
}

function applyPanelStates() {
  document.querySelectorAll(".panel").forEach(panel => {
    const isOpen = window.panelStates[panel.dataset.panelId];
    panel.querySelector(".panel-content").classList.toggle("visible", isOpen);
  });
}

function getDefaultSlotColor() {
  return document.body.classList.contains("dark-mode") ? "#3c4043" : "#eee";
}

const defaultColor = getDefaultSlotColor();

document.body.addEventListener("click", (e) => {
  const header = e.target.closest(".panel-header");
  if (!header) return;

  // vNext UI behaviour:
  // Panel headers are *not* interactive toggles. The left navigation controls
  // which panel is visible, and the header is just a title bar.
  // Keep this listener (for backwards compatibility with older HTML) but
  // make it a no-op so headers never open/close panels.
  return;

  const panel = header.closest(".panel");
  if (!panel) return;

  const panelId = panel.dataset.panelId;
  const content = panel.querySelector(".panel-content");
  if (panelId === "uw" && (bulkOperationInProgress || window.slotReceiveInProgress)) {
    return;
  }

  if (!panel.dataset.initialized) {
    console.log(`Initializing panel: ${panelId}`);
    switch (panelId) {
      case 'kit':     buildKitEditors(); break;
      case 'pattern': buildPatternEditors(); break;
      case 'song':    if (typeof fillSongUI === 'function') fillSongUI(); break;
      case 'global':  if (window.initGlobalUI) initGlobalUI(); break;
      case 'uw':      if (typeof initUwPanel === 'function') initUwPanel(); break;
    }
    panel.dataset.initialized = 'true';
  }
  content.classList.toggle("visible");
  window.panelStates = window.panelStates || {};
  window.panelStates[panelId] = content.classList.contains("visible");
});

function loadSinglePatternSlot(idx) {
  const slotData = window.allPatternSlots[idx];
  if (!slotData || !slotData.pattern) {
    resetPattern();
    window.pattern.patternNumber = idx;
    window.pattern.origPos = idx;
  } else {
    window.pattern = JSON.parse(JSON.stringify(slotData.pattern));
   if (typeof window.ensurePatternTrackArraysExist === "function") {
     window.ensurePatternTrackArraysExist();
   }
    window.pattern.patternNumber = idx;
    window.pattern.origPos = idx;
  }
  if (window.allPatternSlots[idx]) {
    window.allPatternSlots[idx].pattern = JSON.parse(JSON.stringify(window.pattern));
  }
  const assignedKitNum = window.pattern.assignedKitNumber;
  if (
    typeof assignedKitNum === "number" &&
    assignedKitNum >= 0 &&
    assignedKitNum < 64
  ) {
    if (window.kitLibrary && window.kitLibrary[assignedKitNum]) {
      window.kit = JSON.parse(JSON.stringify(window.kitLibrary[assignedKitNum].data));
    } else {
      window.kit = JSON.parse(JSON.stringify(window.DEFAULTS.kit));
    }
    window.selectedKitSlotIndex = assignedKitNum;
    updateKitSlotUI(assignedKitNum);
    buildKitEditors();
    if (typeof refreshSkewclidTrackSelectors === "function") {
      refreshSkewclidTrackSelectors();
    }
    if (typeof window.colorizeSlots === "function") {
      window.colorizeSlots();
    }
  }
  window.selectedPatternSlotIndex = idx;
  updatePatternSlotUI(idx);
  buildPatternEditors();
   if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
}

function updateKitSlotUI(i) {
  document.querySelectorAll(".kit-slot").forEach(div => {
    div.classList.remove("blink-selected");
  });
  const slotDiv = document.querySelector(`.kit-slot[data-idx="${i}"]`);
  if (!slotDiv) return;
  slotDiv.classList.remove("filled", "empty-slot");
  const kitObj = window.kitLibrary[i];
  if (kitObj && kitObj.data) {
    slotDiv.classList.add("filled");
    slotDiv.style.backgroundColor = getKitNameColor(kitObj.data);
  } else {
    slotDiv.classList.add("empty-slot");
    slotDiv.style.backgroundColor = defaultColor;
  }
  if (i === window.selectedKitSlotIndex) {
    slotDiv.classList.add("blink-selected");
  }
}

function buildPatternEditors() {
  if (window.buildPatternGeneralUI) window.buildPatternGeneralUI();
  if (window.buildLockAndBitfieldUI) window.buildLockAndBitfieldUI();
}

function buildKitEditors() {
  if (window.buildKitNameUI) window.buildKitNameUI();
  if (window.buildTrackOverviewUI) window.buildTrackOverviewUI();
  if (window.buildMasterFxUI) window.buildMasterFxUI();
  if (typeof window.buildKnobGrid === "function") {
    window.buildKnobGrid("machineParamsUI", window.kit.machineParams, [
      "Param1","Param2","Param3","Param4","Param5","Param6","Param7","Param8"
    ], true);
    window.buildKnobGrid("trackFxUI", window.kit.trackFx, [
      "AMdep","AMfrq","EQfrq","EQgain","FltBase","FltWidth","FltQ","SRR"
    ], true);
    window.buildKnobGrid("routingUI", window.kit.routing, [
      "Dist","Vol","Pan","DelSnd","RevSnd","LFOspd","LFOdep","LFOmix"
    ], true);
  }
}

window.getBitsArray = (field, t) => {
  window.pattern = window.pattern || {};
  const initArray = (name, perTrack) => {
    if (!window.pattern[name]) {
      window.pattern[name] = perTrack
        ? Array.from({ length: 16 }, () => new Uint8Array(8))
        : new Uint8Array(8);
    }
  };
  initArray("trigBitsPerTrack", true);
  initArray("accentBitsPerTrack", true);
  initArray("swingBitsPerTrack", true);
  initArray("slideBitsPerTrack", true);
  initArray("accentBitsGlobal", false);
  initArray("swingBitsGlobal", false);
  initArray("slideBitsGlobal", false);
  switch (field) {
    case "trig":
      return window.pattern.trigBitsPerTrack[t];
    case "accent":
      return window.pattern.accentEditAll
        ? window.pattern.accentBitsGlobal
        : window.pattern.accentBitsPerTrack[t];
    case "swing":
      return window.pattern.swingEditAll
        ? window.pattern.swingBitsGlobal
        : window.pattern.swingBitsPerTrack[t];
    case "slide":
      return window.pattern.slideEditAll
        ? window.pattern.slideBitsGlobal
        : window.pattern.slideBitsPerTrack[t];
    default:
      return null;
  }
};

function populatePatternDropdown(preserveValue) {
  const select = document.getElementById("patReqNumberSelect");
  if (!select) return;
  preserveValue = preserveValue === undefined ? select.value : preserveValue;
  select.innerHTML = "";
  for (let i = 0; i < 128; i++) {
    const opt = document.createElement("option");
    opt.value = i.toString();
    opt.textContent = window.patternIndexToLabel(i);
    select.appendChild(opt);
  }
  if (preserveValue !== null && preserveValue !== "") {
    select.value = preserveValue;
  } else {
    select.value =
      window.mdRequestPatternNumber != null
        ? window.mdRequestPatternNumber.toString()
        : window.pattern.patternNumber.toString();
  }
}

function onSelectPatternIndexChange() {
  const sel = document.getElementById("patReqNumberSelect");
  if (!sel) return;
  const newIndex = parseInt(sel.value, 10);
  window.mdRequestPatternNumber = newIndex;
}

function onTextPatternLabelChange() {
  const patNumEl = document.getElementById("patNumber");
  if (!patNumEl) return;

  // Only meaningful when Pat # is an editable <input>.
  if (patNumEl.tagName !== "INPUT") return;

  const numericIndex = window.patternLabelToIndex((patNumEl.value || "").trim());
  if (window.pattern && Number.isFinite(numericIndex)) {
    window.pattern.patternNumber = numericIndex;
  }
  const sel = document.getElementById("patReqNumberSelect");
  if (sel && Number.isFinite(numericIndex)) {
    sel.value = numericIndex.toString();
  }
}

window.refreshScaleDropdownForMDModel = function () {
  const scaleSelect = document.getElementById("patScaleSelect");
  if (!scaleSelect) return;
  scaleSelect.innerHTML = "";
  const isMk2 = window.mdModel === "MKII";
  const scaleOptions = isMk2
    ? [
        { val: 0, label: "16" },
        { val: 1, label: "32" },
        { val: 2, label: "48" },
        { val: 3, label: "64" }
      ]
    : [
        { val: 0, label: "16" },
        { val: 1, label: "32" }
      ];
  scaleOptions.forEach(opt => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.val;
    optionEl.textContent = opt.label;
    scaleSelect.appendChild(optionEl);
  });
  if (typeof window.pattern.scale !== "number") window.pattern.scale = 0;
  if (!isMk2 && window.pattern.scale > 1) window.pattern.scale = 1;
  scaleSelect.value = window.pattern.scale.toString();
};

window.buildPatternGeneralUI = function () {
  if (window.refreshScaleDropdownForMDModel) window.refreshScaleDropdownForMDModel();
  const elNum = document.getElementById("patNumber");
  if (elNum) {
    const label = window.patternIndexToLabel(window.pattern.patternNumber);

    // Pat # is display-only in the current UI.
    if (elNum.tagName === "INPUT") {
      // Legacy fallback
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
    };
  }
  const kitNumInput = document.getElementById("assignedKitNumber");
  if (kitNumInput) {
    kitNumInput.value = (window.pattern.assignedKitNumber + 1).toString();
    kitNumInput.onchange = () => {
      let val = parseInt(kitNumInput.value, 10);
      if (!isNaN(val)) {
        window.pattern.assignedKitNumber = Math.max(0, Math.min(63, val - 1));
      }
    };
  }
  const lengthSlider = document.getElementById("patLengthSlider");
  const lengthLabel = document.getElementById("patLengthLabel");
  if (lengthSlider && lengthLabel) {
    lengthSlider.value = window.pattern.length;
    lengthLabel.textContent = window.pattern.length;
    lengthSlider.oninput = () => {
      let newLen = parseInt(lengthSlider.value, 10) || 16;
      newLen = Math.max(2, Math.min(newLen, 64));
      onLengthSliderChange(newLen);
    };
  }
};

window.updateSwingLabel = function () {
  const slider = document.getElementById("patSwingSlider");
  const label = document.getElementById("patSwingLabel");
  if (!slider || !label) return;
  let val = Math.max(50, Math.min(80, parseInt(slider.value, 10) || 50));
  label.textContent = val;
  window.pattern.swingAmount = Math.max(
    0,
    Math.min(127, Math.round(((val - 50) / 30) * 127))
  );
};

if (document.getElementById("patSwingSlider")) {
  document.getElementById("patSwingSlider").oninput = function () {
    const slider = this;
    const label = document.getElementById("patSwingLabel");
    const displayValue = parseInt(slider.value, 10);
    label.textContent = displayValue;
    window.pattern.swingAmount = Math.max(
      0,
      Math.min(127, Math.round(((displayValue - 50) / 30) * 127))
    );
  };
}

window.updateAccentLabel = function () {
  const slider = document.getElementById("accentSlider");
  const label = document.getElementById("accentLabel");
  if (!slider || !label) return;
  const raw = parseInt(slider.value, 10) || 0;
  window.pattern.accentAmount = (Math.max(0, Math.min(15, raw)) & 0x0f);
  label.textContent = window.pattern.accentAmount;
};

if (document.getElementById("patScaleSelect")) {
  document.getElementById("patScaleSelect").onchange = function () {
    let newScale = parseInt(this.value, 10) || 0;
    if (window.mdModel === "MKI" && newScale > 1) {
      newScale = 1;
      this.value = "1";
    }
    const newLen = [16, 32, 48, 64][newScale] || 16;
    window.pattern.scale = newScale;
    window.pattern.length =
      window.mdModel === "MKI" && newLen > 32 ? 32 : newLen;
    const ls = document.getElementById("patLengthSlider"),
      lb = document.getElementById("patLengthLabel");
    if (ls && lb) {
      ls.value = window.pattern.length;
      lb.textContent = window.pattern.length;
    }
    window.buildLockAndBitfieldUI && window.buildLockAndBitfieldUI();
  };
}

window.updateLengthLabel = function () {
  const sliderEl = document.getElementById("patLengthSlider");
  let rawLength = parseInt(sliderEl.value, 10) || 16;
  if (window.mdModel === "MKI" && rawLength > 32) {
    rawLength = 32;
    sliderEl.value = 32;
  }
  window.pattern.length = rawLength;
  window.pattern.scale =
    rawLength <= 16 ? 0 :
    rawLength <= 32 ? 1 :
    rawLength <= 48 ? 2 : 3;
  const lb = document.getElementById("patLengthLabel");
  if (lb) lb.textContent = rawLength;
  window.buildLockAndBitfieldUI && window.buildLockAndBitfieldUI();
};

window.buildLockAndBitfieldUI = function () {
  if (typeof window.buildLockAndBitfieldUI_SYSEX === "function") {
    window.buildLockAndBitfieldUI_SYSEX();
  }
};

window.rebuildLocksUI = function () {
  window.buildLockAndBitfieldUI && window.buildLockAndBitfieldUI();
};

window.buildTopPatternBanksUI = function () {
  const banks = [
    ["A", 0, "E", 64],
    ["B", 16, "F", 80],
    ["C", 32, "G", 96],
    ["D", 48, "H", 112]
  ];
  const cols = [
    document.getElementById("bankColAE"),
    document.getElementById("bankColBF"),
    document.getElementById("bankColCG"),
    document.getElementById("bankColDH")
  ];
  if (cols.some(col => !col)) return;
  cols.forEach((col, i) => {
    const [label1, start1, label2, start2] = banks[i];
    col.innerHTML = buildOneBank(start1, label1) + buildOneBank(start2, label2);
  });
  function buildOneBank(startIdx, bankLetter) {
    let html = '<div class="pattern-bank-grid">';
    for (let i = 0; i < 16; i++) {
      const idx = startIdx + i;
      const slot = window.allPatternSlots[idx];
      const slotLabel = bankLetter + String(i + 1).padStart(2, "0");
      const fillClass = slot ? "filled" : "empty-slot";
      const blinkClass = idx === window.selectedPatternSlotIndex ? "blink-selected" : "";
      let inlineStyle = '';
      if (slot) {
        const patObj = slot.pattern;
        const assignedKitNum = patObj ? patObj.assignedKitNumber : -1;
        let color = getDefaultSlotColor();
        if (
          assignedKitNum >= 0 &&
          window.kitLibrary &&
          window.kitLibrary[assignedKitNum]
        ) {
          color = getKitNameColor(window.kitLibrary[assignedKitNum].data);
        }
        inlineStyle = ` style="background-color: ${color};"`;
      }
      html += `<div class="pattern-slot ${fillClass} ${blinkClass}" data-idx="${idx}" data-slot-type="pattern"${inlineStyle}>
            ${slotLabel}
         </div>`;
    }
    return html + "</div>";
  }
};

window.attachBankSlotClickHandlers = function () {
  document.querySelectorAll("#topPatternBanks .pattern-slot").forEach(div => {
    div.addEventListener("click", ev => {
      const idx = +div.dataset.idx;
      if (ev.shiftKey) {
        if (window.allPatternSlots[idx] && !confirm("Overwrite Pattern Slot?")) return;
        window.storePatternSlot && window.storePatternSlot(idx);
        div.classList.add("slot-just-saved");
        setTimeout(() => div.classList.remove("slot-just-saved"), 300);
      } else {
        loadSinglePatternSlot(idx);
      }
      if (window.buildTopPatternBanksUI) window.buildTopPatternBanksUI();
      if (window.attachBankSlotClickHandlers) window.attachBankSlotClickHandlers();
    });

    div.draggable = true;

    // start drag
    div.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", div.dataset.idx);
      ev.dataTransfer.setData("slotType", div.dataset.slotType);
      ev.dataTransfer.effectAllowed = "move";
      div.classList.add("slot-dragging");
    });

    // end drag: remove dragging & any highlight
    div.addEventListener("dragend", () => {
      div.classList.remove("slot-dragging", "drag-over");
    });

    // when something is dragged over this slot, allow drop & show highlight
    div.addEventListener("dragover", ev => {
      ev.preventDefault();
      div.classList.add("drag-over");
    });

    // when the cursor leaves, clear the highlight
    div.addEventListener("dragleave", () => {
      div.classList.remove("drag-over");
    });

    // on drop: clear highlight then swap
    div.addEventListener("drop", ev => {
      ev.preventDefault();
      div.classList.remove("drag-over");

      const draggedType = ev.dataTransfer.getData("slotType");
      const targetType = div.dataset.slotType;
      if (draggedType !== targetType) {
        console.warn("Incompatible slot drop");
        return;
      }
      const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const toIndex = parseInt(div.dataset.idx, 10);
      if (fromIndex === toIndex) return;
      const temp = window.allPatternSlots[fromIndex];
      window.allPatternSlots[fromIndex] = window.allPatternSlots[toIndex];
      window.allPatternSlots[toIndex] = temp;
      if (window.allSongSlots) {
        window.allSongSlots.forEach(song => {
          if (song && song.rows) {
            song.rows.forEach(row => {
              const raw = row.data[0];
              if (raw === 0xFF || raw === 0xFE) return;
              let flag = raw >= 0x80 ? 0x80 : 0;
              let patNum = raw >= 0x80 ? (raw & 0x7F) : raw;
              if (patNum === fromIndex) row.data[0] = flag | toIndex;
              else if (patNum === toIndex) row.data[0] = flag | fromIndex;
            });
          }
        });
      }
      buildTopPatternBanksUI();
      attachBankSlotClickHandlers();
    });
  });
};

window.sendParamChange = function (category, track, paramIdx, value) {
};

window.writePatternToMD = function () {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  let patNum;
  const patSelect = document.getElementById("patReqNumberSelect");
  if (patSelect) {
    patNum = parseInt(patSelect.value, 10);
  } else {
    const patNumEl = document.getElementById("patNumber");
    if (patNumEl && patNumEl.tagName === "INPUT") {
      patNum = window.patternLabelToIndex(patNumEl.value);
    } else if (window.pattern && typeof window.pattern.patternNumber === "number") {
      patNum = window.pattern.patternNumber;
    } else {
      patNum = 0;
    }
  }
  window.pattern.origPos = patNum;
  window.pattern.patternNumber = patNum;
  const accentChk = document.querySelector('input[name="accentEditAll"]');
  const swingChk = document.querySelector('input[name="swingEditAll"]');
  const slideChk = document.querySelector('input[name="slideEditAll"]');
  if (accentChk) window.pattern.accentEditAll = accentChk.checked;
  if (swingChk) window.pattern.swingEditAll = swingChk.checked;
  if (slideChk) window.pattern.slideEditAll = slideChk.checked;
  const syx = window.storePatternSysex(patNum, window.pattern);
  window.selectedMidiOut.send(syx);
};

window.onClickWriteKit = function () {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (typeof window.saveCurrentKitToMD === "function") {
    window.saveCurrentKitToMD();
  } else {
    alert("Kit sysex not available.");
  }
};

window.kitColorForIndex = i => {
  const hue = Math.round((i / 64) * 360) % 360;
  return `hsl(${hue},70%,60%)`;
};

function isSongEmpty(song) {
  if (!song || !song.rows) return true;
  const hasNormalPatternRows = song.rows.some((row, index) => {
    if (!row || !row.data) return false;
    const pseudoValue = window.getPseudoPatternValue(row.data, index);
    return pseudoValue >= 0;
  });
  return !hasNormalPatternRows;
}

function resetSong() {
  Object.assign(window.currentSong, window.cloneData(window.DEFAULTS.song));
  typeof fillSongUI === "function" && fillSongUI();
}

function resetPattern() {
  Object.assign(window.pattern, window.cloneData(window.DEFAULTS.pattern));
  window.buildPatternGeneralUI && window.buildPatternGeneralUI();
  window.buildLockAndBitfieldUI && window.buildLockAndBitfieldUI();
  if (window.updatePanelHeaderColors) updatePanelHeaderColors();
}

function getKitNameColor(kitObj) {
  if (!kitObj || !kitObj.kitName) return "#ddd";
  let name = Array.isArray(kitObj.kitName) ? kitObj.kitName.join("") : kitObj.kitName;
  name = name.slice(0, 10).toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  hash = Math.abs(hash);
  const hue = hash % 360;
  const sat = 40 + (Math.abs(hash >> 10) % 61);
  const light = 30 + (Math.abs(hash >> 20) % 41);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function getSongGradientForSlot(song) {
  if (!song || !Array.isArray(song.rows)) return "linear-gradient(90deg, red, red)";
  const segments = [];
  let totalEffectiveLength = 0;
  song.rows.forEach(row => {
    const data = row.data;
    if (!data || data.length < 10) return;
    if (data[0] === 0xFF || data[0] === 0xFE) return;
    const repeats = (data[2] || 0) + 1;
    const offset = data[8] || 0;
    const len = data[9] || 16;
    const effectiveLength = (offset + len) * repeats;
    totalEffectiveLength += effectiveLength;
    const raw = data[0];
    const patNum = raw >= 0x80 ? (raw & 0x7F) : raw;
    let color = getDefaultSlotColor();
    if (
      typeof patNum === "number" &&
      window.allPatternSlots &&
      patNum < window.allPatternSlots.length
    ) {
      const slotObj = window.allPatternSlots[patNum];
      if (slotObj && slotObj.pattern) {
        const assignedKitNum = slotObj.pattern.assignedKitNumber;
        if (
          assignedKitNum >= 0 &&
          window.kitLibrary &&
          window.kitLibrary[assignedKitNum]
        ) {
          color = getKitNameColor(window.kitLibrary[assignedKitNum].data);
        }
      }
    }
    segments.push({ color, effectiveLength });
  });
  if (!segments.length) return "linear-gradient(90deg, red, red)";
  let gradientStops = [];
  let currentPct = 0;
  segments.forEach(seg => {
    const pct = (seg.effectiveLength / totalEffectiveLength) * 100;
    gradientStops.push(
      `${seg.color} ${currentPct.toFixed(2)}%, ${seg.color} ${(currentPct + pct).toFixed(2)}%`
    );
    currentPct += pct;
  });
  return `linear-gradient(90deg, ${gradientStops.join(", ")})`;
}

function buildGlobalSlotsUI() {
  const container = document.getElementById("globalSlotsContainer");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const slotDiv = document.createElement("div");
    slotDiv.className = "global-slot";
    slotDiv.dataset.idx = String(i);
    slotDiv.dataset.slotType = "global";
    slotDiv.textContent = i + 1;
    slotDiv.title = `Global ${i + 1}`;
    slotDiv.setAttribute("aria-label", `Global ${i + 1}`);
    if (globalLibrary[i]) {
      slotDiv.classList.add("filled");
      // Use CSS tokenized slot colors (keeps Globals consistent with other slot types)
      // Optional: if you prefer per-global hues, set slotDiv.style.backgroundColor = globalColorForIndex(i);
      slotDiv.style.backgroundColor = "";
    } else {
      slotDiv.classList.add("empty-slot");
      slotDiv.style.backgroundColor = "";
    }

    // Keep selection feedback consistent with kits/patterns/songs
    if (i === window.selectedGlobalSlotIndex) {
      slotDiv.classList.add("blink-selected");
    }
    slotDiv.draggable = true;
    slotDiv.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", String(i));
      ev.dataTransfer.setData("slotType", slotDiv.dataset.slotType);
      ev.dataTransfer.effectAllowed = "move";
      slotDiv.classList.add("slot-dragging");
    });

    slotDiv.addEventListener("dragend", () => {
      slotDiv.classList.remove("slot-dragging");
      slotDiv.classList.remove("drag-over");
    });

    // allow drop and show highlight
    slotDiv.addEventListener("dragover", ev => {
      ev.preventDefault();
      slotDiv.classList.add("drag-over");
    });
    slotDiv.addEventListener("dragleave", () => {
      slotDiv.classList.remove("drag-over");
    });
    slotDiv.addEventListener("drop", ev => {
      ev.preventDefault();
      slotDiv.classList.remove("drag-over");

      const draggedType = ev.dataTransfer.getData("slotType");
      const targetType  = slotDiv.dataset.slotType;
      if (draggedType !== targetType) {
        console.warn(
          "Dropped data from incompatible slot type:",
          draggedType, "on", targetType
        );
        return;
      }
      const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const toIndex = i;
      if (fromIndex === toIndex) return;

      // Swap GLOBAL slots only (do not touch kits/patterns)
      if (!Array.isArray(window.globalLibrary)) window.globalLibrary = new Array(8).fill(null);

      const tmp = window.globalLibrary[fromIndex];
      window.globalLibrary[fromIndex] = window.globalLibrary[toIndex];
      window.globalLibrary[toIndex] = tmp;

      // Keep selection tracking the moved item
      if (window.selectedGlobalSlotIndex === fromIndex) window.selectedGlobalSlotIndex = toIndex;
      else if (window.selectedGlobalSlotIndex === toIndex) window.selectedGlobalSlotIndex = fromIndex;

      // Normalize stored position metadata (if present)
      if (window.globalLibrary[fromIndex] && typeof window.globalLibrary[fromIndex] === "object") {
        window.globalLibrary[fromIndex].globalPosition = fromIndex;
      }
      if (window.globalLibrary[toIndex] && typeof window.globalLibrary[toIndex] === "object") {
        window.globalLibrary[toIndex].globalPosition = toIndex;
      }

      buildGlobalSlotsUI();
      if (typeof window.initGlobalUI === "function") window.initGlobalUI();
      if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();
      window.SlotStrip?.renderIndicators?.();
    });
    slotDiv.onclick = ev => {
      if (ev.shiftKey) {
        if (globalLibrary[i] && !confirm("Overwrite Global Data?")) return;

        // Ensure any in-panel edits are committed to globalData before we snapshot it.
        if (typeof window.saveGlobalSettings === "function") {
          window.saveGlobalSettings();
        }

        if (window.globalData) {
          // Route through the canonical commit helper so slot metadata stays correct
          // and the SlotStrip "dirty" indicator clears.
          if (typeof window.commitGlobalSlot === "function") {
            window.commitGlobalSlot(i, window.globalData, { silent: true });
          } else {
            globalLibrary[i] = JSON.parse(JSON.stringify(window.globalData));
            try { globalLibrary[i].globalPosition = i; } catch (_) {}
          }
          slotDiv.classList.add("slot-just-saved");
          setTimeout(() => slotDiv.classList.remove("slot-just-saved"), 300);
        }
      } else {
        // Selecting a slot should always update selection (even if it's empty)
        window.selectedGlobalSlotIndex = i;

        // Update UI + local state
        if (globalLibrary[i]) {
          let gd;
          try {
            if (window.MDDT?.util?.deepClonePreserveTypedArrays) {
              gd = window.MDDT.util.deepClonePreserveTypedArrays(globalLibrary[i]);
            } else if (typeof structuredClone === "function") {
              gd = structuredClone(globalLibrary[i]);
            } else {
              gd = JSON.parse(JSON.stringify(globalLibrary[i]));
            }
          } catch (e) {
            gd = JSON.parse(JSON.stringify(globalLibrary[i]));
          }
          try {
            if (window.MDDT?.util?.normalizeGlobalObject) {
              window.MDDT.util.normalizeGlobalObject(gd, i);
            } else {
              gd.globalPosition = i;
            }
          } catch (_) {}
          window.globalData = gd;
        } else {
          try {
            if (typeof initGlobalData === "function") {
              window.globalData = initGlobalData(i);
            }
          } catch (_) {}
        }

        window.currentBaseChannel = window.globalData?.midiBase;
        if (typeof initGlobalUI === "function") initGlobalUI();

        const disp = document.getElementById("globalNumberDisplay");
        if (disp) disp.textContent = i + 1;

        // Mirror selection to the Machinedrum if a MIDI out is selected.
        // (MD has 8 global slots; load command id 0x56)
        if (window.selectedMidiOut && Array.isArray(window.MD_SYSEX_HEADER)) {
          try {
            const loadMsg = new Uint8Array([
              ...window.MD_SYSEX_HEADER,
              0x56,
              i & 0x07,
              0xF7
            ]);
            window.selectedMidiOut.send(loadMsg);
          } catch (e) {
            // ignore MIDI send errors
          }
        }
      }

      buildGlobalSlotsUI();
      if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();
      window.SlotStrip?.renderIndicators?.();
    };
    container.appendChild(slotDiv);
  }
  updatePanelHeaderColors();
}

function buildSongSlotsUI() {
  const container = document.getElementById("songSlotsContainer");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < 32; i++) {
    const slotDiv = document.createElement("div");
    slotDiv.className = "song-slot";
    slotDiv.dataset.idx = i.toString();
    slotDiv.dataset.slotType = "song";
    slotDiv.textContent = i + 1;
    slotDiv.title = `Song ${i + 1}`;
    slotDiv.setAttribute("aria-label", `Song ${i + 1}`);
    const song = window.allSongSlots ? window.allSongSlots[i] : null;
    if (song && !isSongEmpty(song)) {
      slotDiv.classList.add("filled");
      const gradientStr = getSongGradientForSlot(song);
      slotDiv.style.background = gradientStr || "red";
    } else {
      slotDiv.classList.add("empty-slot");
     slotDiv.style.background = "";
    }
    if (i === window.selectedSongSlotIndex) slotDiv.classList.add("blink-selected");
    slotDiv.draggable = true;
    slotDiv.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", String(i));
      ev.dataTransfer.setData("slotType", slotDiv.dataset.slotType);
      ev.dataTransfer.effectAllowed = "move";
      slotDiv.classList.add("slot-dragging");
    });
    slotDiv.addEventListener("dragend", () => {
      slotDiv.classList.remove("slot-dragging");
      slotDiv.classList.remove("drag-over");
    });

    // when something is dragged *over* this slot, allow the drop and add the highlight
    slotDiv.addEventListener("dragover", ev => {
      ev.preventDefault();           // must do this to allow drop
      slotDiv.classList.add("drag-over");
    });

    // clear the highlight if the cursor leaves the slot
    slotDiv.addEventListener("dragleave", () => {
      slotDiv.classList.remove("drag-over");
    });

    // on drop, remove the highlight and then run your existing logic
    slotDiv.addEventListener("drop", ev => {
      ev.preventDefault();
      slotDiv.classList.remove("drag-over");

      const draggedType = ev.dataTransfer.getData("slotType");
      const targetType  = slotDiv.dataset.slotType;
      if (draggedType !== targetType) {
        console.warn(
          "Dropped data from incompatible slot type:",
          draggedType, "on", targetType
        );
        return;
      }
      const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const toIndex = i;
      if (fromIndex === toIndex) return;
      const temp = window.allSongSlots[fromIndex];
      window.allSongSlots[fromIndex] = window.allSongSlots[toIndex];
      window.allSongSlots[toIndex] = temp;

      // Restamp embedded slot indices so later single-slot exports/sends target correctly.
      if (window.allSongSlots[fromIndex]) window.allSongSlots[fromIndex].slotIndex = fromIndex;
      if (window.allSongSlots[toIndex]) window.allSongSlots[toIndex].slotIndex = toIndex;

      // Keep selection tracking the moved item (and keep editor metadata aligned).
      if (window.selectedSongSlotIndex === fromIndex) window.selectedSongSlotIndex = toIndex;
      else if (window.selectedSongSlotIndex === toIndex) window.selectedSongSlotIndex = fromIndex;
      if (window.currentSong && typeof window.currentSong === "object") {
        if (window.currentSong.slotIndex === fromIndex) window.currentSong.slotIndex = toIndex;
        else if (window.currentSong.slotIndex === toIndex) window.currentSong.slotIndex = fromIndex;
      }

      buildSongSlotsUI();
      try { window.updatePanelHeaderColors?.(); } catch (_) {}
      window.SlotStrip?.renderIndicators?.();
    });
    slotDiv.onclick = ev => {
      if (ev.shiftKey) {
        if (window.allSongSlots[i] && !confirm("Overwrite Song Data?")) return;
        storeSongSlot(i);
      } else {
        loadOrResetSongSlot(i);
      }
      updateSongSlotUI(i);
      updatePanelHeaderColors();
    };
    container.appendChild(slotDiv);
  }
  updatePanelHeaderColors();
}

function storeSongSlot(i) {
  if (!window.currentSong) return;

  // Store via the canonical commit helper so slotIndex metadata is correct
  // (createSongDump relies on it) and the SlotStrip "dirty" indicator clears.
  const songToStore = (typeof isSongEmpty === "function" && isSongEmpty(window.currentSong))
    ? null
    : window.currentSong;

  if (typeof window.commitSongSlot === "function") {
    window.commitSongSlot(i, songToStore, { silent: true });
  } else {
    window.allSongSlots[i] = songToStore ? JSON.parse(JSON.stringify(songToStore)) : null;
    if (window.allSongSlots[i] && typeof window.allSongSlots[i] === "object") {
      window.allSongSlots[i].slotIndex = i;
    }
  }

  window.lastSongSnapshot = null;
  updatePanelHeaderColors();
  updateSongSlotUI(i);

  const slotEl = document.querySelector(`.song-slot[data-idx="${i}"]`);
  if (slotEl) {
    slotEl.classList.add("slot-just-saved");
    setTimeout(() => slotEl.classList.remove("slot-just-saved"), 300);
  }
}

function updateSongSlotUI(idx) {
  document.querySelectorAll(".song-slot").forEach(s => s.classList.remove("blink-selected"));

  const slotDiv = document.querySelector(`.song-slot[data-idx="${idx}"]`);
  if (!slotDiv) return;

  slotDiv.classList.remove("filled", "empty-slot");
  slotDiv.style.background = "";

  const song = window.allSongSlots ? window.allSongSlots[idx] : null;
  if (song && !isSongEmpty(song)) {
    slotDiv.classList.add("filled");
    const gradientStr = getSongGradientForSlot(song);
    slotDiv.style.background = gradientStr || getDefaultSlotColor();
  } else {
    slotDiv.classList.add("empty-slot");
    slotDiv.style.background = "";
  }

  if (idx === window.selectedSongSlotIndex) {
    slotDiv.classList.add("blink-selected");
  }
}

function loadOrResetSongSlot(i) {
  if (!window.allSongSlots[i] || isSongEmpty(window.allSongSlots[i])) {
    // IMPORTANT:
    // resetSong() invokes fillSongUI(), which reads currentSong.slotIndex
    // to populate the Song header (#songNumberDisplay).
    //
    // The old flow was:
    //   resetSong() -> fillSongUI() -> header shows default slot (1)
    //   then we set slotIndex = i (but never refreshed the header)
    //
    // Result: clicking an *empty* song slot would not update the editor's
    // "Song #" display.
    resetSong();
    window.currentSong.slotIndex = i;
    window.selectedSongSlotIndex = i;

    // Re-sync the editor header now that slotIndex is correct.
    // (fillSongUI() will call updateHeaderUI() internally.)
    if (typeof fillSongUI === "function") {
      fillSongUI();
    } else {
      const display = document.getElementById("songNumberDisplay");
      if (display) display.textContent = i + 1;
    }
  } else {
    loadSongSlot(i);
  }
  buildSongSlotsUI();
  if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
}

function loadSongSlot(i) {
  showProcessingPopup();
  setTimeout(function() {
    if (!window.allSongSlots[i] || isSongEmpty(window.allSongSlots[i])) return;

    window.currentSong = JSON.parse(JSON.stringify(window.allSongSlots[i]));
    window.currentSong.slotIndex = i;
    window.selectedSongSlotIndex = i;
    window.lastSongSnapshot = null;

    const display = document.getElementById("songNumberDisplay");
    if (display) display.textContent = i + 1;

    // fillSongUI() enforces/normalizes song rows (e.g. single END row).
    // That can legitimately mutate currentSong, which would look "dirty" if we diff
    // against the pre-normalized slot.
    //
    // Suppress header updates during this normalization pass and run a single
    // updatePanelHeaderColors() after we snapshot the normalized song back into the slot.
    const prevWait = window.waitingForSingleSongDump;
    try {
      window.waitingForSingleSongDump = true;
      if (typeof fillSongUI === "function") fillSongUI();
    } finally {
      window.waitingForSingleSongDump = prevWait;
    }

    // Snapshot the normalized song back into the slot so diff-based dirty checks
    // reflect the true "loaded" baseline.
    window.allSongSlots[i] = JSON.parse(JSON.stringify(window.currentSong));

    updateSongSlotUI(i);

    // Now compute header/SlotStrip state from the normalized baseline.
    if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();

    hideProcessingPopup();
  }, 0);
}

function showProcessingPopup() {
  document.getElementById("processingPopup").style.display = "block";
}

function hideProcessingPopup() {
  document.getElementById("processingPopup").style.display = "none";
}


function buildKitSlotsUI() {
  const container = document.getElementById("kitSlotsContainer");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < 64; i++) {
    const slotDiv = document.createElement("div");
    slotDiv.className = "kit-slot";
    slotDiv.dataset.idx = i.toString();
    slotDiv.dataset.slotType = "kit";
    slotDiv.textContent = i + 1;
    if (window.kitLibrary && window.kitLibrary[i]) {
      slotDiv.classList.add("filled");
      slotDiv.style.backgroundColor = getKitNameColor(window.kitLibrary[i].data);
    } else {
      slotDiv.classList.add("empty-slot");
      slotDiv.style.backgroundColor = defaultColor;
    }
    if (i === window.selectedKitSlotIndex) slotDiv.classList.add("blink-selected");
    slotDiv.draggable = true;
    slotDiv.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", slotDiv.dataset.idx);
      ev.dataTransfer.setData("slotType", slotDiv.dataset.slotType);
      ev.dataTransfer.effectAllowed = "move";
      slotDiv.classList.add("slot-dragging");
    });
    slotDiv.addEventListener("dragend", () => {
      slotDiv.classList.remove("slot-dragging");
      slotDiv.classList.remove("drag-over");
    });

    // when something is dragged *over* this slot, allow the drop and add the highlight
    slotDiv.addEventListener("dragover", ev => {
      ev.preventDefault();           // must do this to allow drop
      slotDiv.classList.add("drag-over");
    });

    // clear the highlight if the cursor leaves the slot
    slotDiv.addEventListener("dragleave", () => {
      slotDiv.classList.remove("drag-over");
    });

    // on drop, remove the highlight and then run your existing logic
    slotDiv.addEventListener("drop", ev => {
      ev.preventDefault();
      slotDiv.classList.remove("drag-over");

      const draggedType = ev.dataTransfer.getData("slotType");
      const targetType  = slotDiv.dataset.slotType;
      if (draggedType !== targetType) {
        console.warn(
          "Dropped data from incompatible slot type:",
          draggedType, "on", targetType
        );
        return;
      }
      const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const toIndex = i;
      if (fromIndex === toIndex) return;
      // Use the canonical swap so pattern kit assignments remain correct.
      if (typeof window.swapKitSlots === "function") {
        window.swapKitSlots(fromIndex, toIndex);
      } else {
        const temp = window.kitLibrary[fromIndex];
        window.kitLibrary[fromIndex] = window.kitLibrary[toIndex];
        window.kitLibrary[toIndex] = temp;
      }

      // Keep selection pointing at the same underlying kit after a swap.
      if (window.selectedKitSlotIndex === fromIndex) window.selectedKitSlotIndex = toIndex;
      else if (window.selectedKitSlotIndex === toIndex) window.selectedKitSlotIndex = fromIndex;

      // Keep editor metadata aligned with the selected slot
      if (window.kit && typeof window.kit === "object" && window.selectedKitSlotIndex >= 0) {
        try { window.kit.sysexPosition = window.selectedKitSlotIndex; } catch (_) {}
      }

      buildKitSlotsUI();
      try { window.colorizeSlots?.(); } catch (_) {}
      try { window.updatePanelHeaderColors?.(); } catch (_) {}
    });
    slotDiv.onclick = ev => {
      if (ev.shiftKey) {
        if (window.kitLibrary[i] && !confirm("Overwrite Kit Data?")) return;
        if (!window.kit) return;
        const kitToStore = (window.isKitEmpty && window.isKitEmpty(window.kit)) ? null : window.kit;
        if (typeof window.commitKitSlot === "function") {
          window.commitKitSlot(i, kitToStore, { silent: true });
        } else {
          // Fallback to previous behavior
          window.kitLibrary[i] = kitToStore
            ? { data: JSON.parse(JSON.stringify(kitToStore)), colorIndex: i }
            : null;
        }
        slotDiv.classList.add("slot-just-saved");
        setTimeout(() => slotDiv.classList.remove("slot-just-saved"), 300);
        try { window.colorizeSlots?.(); } catch (_) {}
        try { window.updatePanelHeaderColors?.(); } catch (_) {}
      } else {
        if (window.kitLibrary && window.kitLibrary[i]) {
          window.kit = JSON.parse(JSON.stringify(window.kitLibrary[i].data));
          // Ensure embedded slot index matches the slot we clicked (important for SysEx writers)
          window.kit.sysexPosition = i;
          window.selectedKitSlotIndex = i;
          const kitNumDisplay = document.getElementById("kitNumberDisplay");
          if (kitNumDisplay) kitNumDisplay.textContent = i + 1;
        } else {
          Object.assign(window.kit, {
            sysexVersion: 64,
            sysexRevision: 1,
            // Keep metadata aligned with the slot the user clicked.
            sysexPosition: i,
            machineAssignments: Array(16).fill(0),
            machineTonalFlags: Array(16).fill(0),
            machineParams: Array.from({ length: 16 }, () => Array(8).fill(64)),
            trackFx: Array.from({ length: 16 }, () => Array(8).fill(0)),
            routing: Array.from({ length: 16 }, () => Array(8).fill(0)),
            muteTrigRelations: Array.from({ length: 16 }, () => [128, 128]),
            lfoBlocks: Array.from({ length: 16 }, () => Array(36).fill(0)),
            masterFx: [...DEFAULT_MASTER_FX],
            trackLevels: Array(16).fill(100),
            kitName: "DEFAULT".split(""),
            rawKit: null
          });
          for (let t = 0; t < 16; t++) {
            window.kit.lfoBlocks[t][0] = t;
          }
          window.selectedKitSlotIndex = i;
          const kitNumDisplay = document.getElementById("kitNumberDisplay");
          if (kitNumDisplay) kitNumDisplay.textContent = i + 1;
        }
        if (window.buildKitNameUI) window.buildKitNameUI();
        if (window.buildTrackOverviewUI) window.buildTrackOverviewUI();
        if (window.buildMasterFxUI) window.buildMasterFxUI();
        if (typeof window.buildKnobGrid === "function") {
          window.buildKnobGrid("machineParamsUI", window.kit.machineParams, [
            "Param1", "Param2", "Param3", "Param4",
            "Param5", "Param6", "Param7", "Param8"
          ], true);
          window.buildKnobGrid("trackFxUI", window.kit.trackFx, [
            "AMdep", "AMfrq", "EQfrq", "EQgain",
            "FltBase", "FltWidth", "FltQ", "SRR"
          ], true);
          window.buildKnobGrid("routingUI", window.kit.routing, [
            "Dist", "Vol", "Pan", "DelSnd",
            "RevSnd", "LFOspd", "LFOdep", "LFOmix"
          ], true);
        }
        updatePanelHeaderColors();
      }
      buildKitSlotsUI();
      if (typeof refreshSkewclidTrackSelectors === "function") {
        refreshSkewclidTrackSelectors();
      }
    };
    container.appendChild(slotDiv);
  }
  updatePanelHeaderColors();
    if (typeof refreshSkewclidTrackSelectors === "function") {
      refreshSkewclidTrackSelectors();
    }
}

function buildPatternSlotsUI() {
  const container = document.getElementById("patternSlotsContainer");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < 128; i++) {
    const slotDiv = document.createElement("div");
    slotDiv.className = "pattern-slot";
    slotDiv.dataset.idx = i.toString();
    slotDiv.dataset.slotType = "pattern";
    slotDiv.textContent = window.patternIndexToLabel(i);
    if (window.allPatternSlots && window.allPatternSlots[i]) {
      slotDiv.classList.add("filled");
      const patObj = window.allPatternSlots[i].pattern;
      const assignedKitNum = patObj ? patObj.assignedKitNumber : -1;
      let color = getDefaultSlotColor();
      if (
        assignedKitNum >= 0 &&
        window.kitLibrary &&
        window.kitLibrary[assignedKitNum]
      ) {
        color = getKitNameColor(window.kitLibrary[assignedKitNum].data);
      }
      slotDiv.style.backgroundColor = color;
    } else {
      slotDiv.classList.add("empty-slot");
      slotDiv.style.backgroundColor = getDefaultSlotColor();
    }
    if (i === window.selectedPatternSlotIndex) slotDiv.classList.add("blink-selected");
    slotDiv.draggable = true;

    // start drag: mark dragging
    slotDiv.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/plain", slotDiv.dataset.idx);
      ev.dataTransfer.setData("slotType", slotDiv.dataset.slotType);
      ev.dataTransfer.effectAllowed = "move";
      slotDiv.classList.add("slot-dragging");
    });

    // clean up both dragging *and* any lingering highlight
    slotDiv.addEventListener("dragend", () => {
      slotDiv.classList.remove("slot-dragging", "drag-over");
    });

    // when something is dragged *over* this slot, allow the drop and add the highlight
    slotDiv.addEventListener("dragover", ev => {
      ev.preventDefault();             // must do this to allow drop
      slotDiv.classList.add("drag-over");
    });

    // clear the highlight if the cursor leaves the slot
    slotDiv.addEventListener("dragleave", () => {
      slotDiv.classList.remove("drag-over");
    });

    // on drop, remove the highlight and then run your existing logic
    slotDiv.addEventListener("drop", ev => {
      ev.preventDefault();
      slotDiv.classList.remove("drag-over");

      const draggedType = ev.dataTransfer.getData("slotType");
      const targetType  = slotDiv.dataset.slotType;
      if (draggedType !== targetType) {
        console.warn(
          "Dropped data from incompatible slot type:",
          draggedType, "on", targetType
        );
        return;
      }

      const fromIndex = parseInt(ev.dataTransfer.getData("text/plain"), 10);
      const toIndex = i;
      if (fromIndex === toIndex) return;
      swapPatternSlots(fromIndex, toIndex);
      buildPatternSlotsUI();
      if (typeof buildSongSlotsUI === "function") buildSongSlotsUI();
      if (typeof buildTopPatternBanksUI === "function") {
        buildTopPatternBanksUI();
        attachBankSlotClickHandlers();
      }
      if (window.selectedPatternSlotIndex === fromIndex) {
        window.selectedPatternSlotIndex = toIndex;
      } else if (window.selectedPatternSlotIndex === toIndex) {
        window.selectedPatternSlotIndex = fromIndex;
      }

      // Keep editor metadata aligned with the selected slot
      if (window.pattern && typeof window.selectedPatternSlotIndex === "number" && window.selectedPatternSlotIndex >= 0) {
        window.pattern.patternNumber = window.selectedPatternSlotIndex;
        window.pattern.origPos = window.selectedPatternSlotIndex;
      }
      if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
      if (typeof colorizeSlots === "function") colorizeSlots();
    });
    slotDiv.onclick = ev => {
      if (ev.shiftKey) {
        if (window.storePatternSlot) window.storePatternSlot(i);
        slotDiv.classList.add("slot-just-saved");
        setTimeout(() => slotDiv.classList.remove("slot-just-saved"), 300);
      } else {
        const prevSelected = document.querySelector(".pattern-slot.blink-selected");
        if (prevSelected && prevSelected !== slotDiv) {
          prevSelected.classList.remove("blink-selected");
        }
        window.selectedPatternSlotIndex = i;
        slotDiv.classList.add("blink-selected");
        if (window.allPatternSlots[i]) {
          loadSinglePatternSlot(i);
        } else {
          resetPattern();
          window.pattern.patternNumber = i;
          window.pattern.origPos = i;
          const patNumEl = document.getElementById("patNumber");
          if (patNumEl) {
            const label = window.patternIndexToLabel(i);
            if (patNumEl.tagName === "INPUT") patNumEl.value = label;
            else patNumEl.textContent = label;
          }
          if (window.buildPatternGeneralUI) window.buildPatternGeneralUI();
          updatePanelHeaderColors();
        }
        updatePatternSlotUI(i);
      }
    };
    container.appendChild(slotDiv);
  }
}

function updatePatternSlotUI(idx) {
  const slotDiv = document.querySelector(`.pattern-slot[data-idx="${idx}"]`);
  if (!slotDiv) return;
  slotDiv.classList.remove("filled", "empty-slot", "blink-selected");
  if (window.allPatternSlots && window.allPatternSlots[idx]) {
    slotDiv.classList.add("filled");
    const patObj = window.allPatternSlots[idx].pattern;
    const assignedKitNum = patObj ? patObj.assignedKitNumber : -1;
    let color = getDefaultSlotColor();
    if (
      assignedKitNum >= 0 &&
      window.kitLibrary &&
      window.kitLibrary[assignedKitNum]
    ) {
      color = getKitNameColor(window.kitLibrary[assignedKitNum].data);
    }
    slotDiv.style.backgroundColor = color;
  } else {
    slotDiv.classList.add("empty-slot");
    slotDiv.style.backgroundColor = getDefaultSlotColor();
  }
  if (idx === window.selectedPatternSlotIndex) {
    slotDiv.classList.add("blink-selected");
  }
}

window.colorizeSlots = function () {
  document.querySelectorAll(".pattern-slot.filled").forEach(div => {
    const idx = +div.dataset.idx;
    const slot = window.allPatternSlots[idx];
    if (!slot) {
      div.style.backgroundColor = "#ddd";
      return;
    }
    const patObj = slot.pattern;
    const assignedKitNum = patObj ? patObj.assignedKitNumber : -1;
    let color = getDefaultSlotColor();
    if (
      assignedKitNum >= 0 &&
      window.kitLibrary &&
      window.kitLibrary[assignedKitNum]
    ) {
      color = getKitNameColor(window.kitLibrary[assignedKitNum].data);
    }
    div.style.backgroundColor = color;
  });
};

window.panelHeaderDebounceEnabled = true;
let colorUpdateTimer = null;
window.updatePanelHeaderColors = function () {
  if (window.panelHeaderDebounceEnabled) {
    if (colorUpdateTimer) clearTimeout(colorUpdateTimer);
    colorUpdateTimer = setTimeout(() => {
      updatePanelHeaderColorsCore();
      colorUpdateTimer = null;
    }, 100);
  } else {
    updatePanelHeaderColorsCore();
  }
};

window.lastSongSnapshot = null;
function setNavButtonAccent(panelId, cssValue) {
  const btn = document.querySelector(`.nav-btn[data-panel="${panelId}"]`);
  if (!btn) return;
  if (!cssValue) {
    btn.classList.remove("has-accent");
    btn.style.removeProperty("--nav-accent");
    return;
  }
  btn.classList.add("has-accent");
  btn.style.setProperty("--nav-accent", cssValue);
}

// -----------------------------------------------------------------------------
// SlotStrip dirty markers
// -----------------------------------------------------------------------------
const __slotStripLastUiSlotIdByType = { kit: null, pattern: null, song: null, global: null };

let __slotStripDidFullReset = false;

function __slotStripResetAllOnce() {
  if (__slotStripDidFullReset) return;
  if (!window.UIBus) return;
  __slotStripDidFullReset = true;

  const buildUiSlotId = window.MDDTSlotMap?.buildUiSlotId
    ? (type, index) => window.MDDTSlotMap.buildUiSlotId({ type, index })
    : (type, index) => `${type}:${index}`;

  const counts = { kit: 64, pattern: 128, song: 32, global: 8 };
  Object.entries(counts).forEach(([type, count]) => {
    for (let i = 0; i < count; i++) {
      try {
        const uiSlotId = buildUiSlotId(type, i);
        window.UIBus.emit("slot:clean", {
          uiSlotId,
          type,
          index: i,
          fn: "slotStripResetAllOnce",
          reason: "diff-reset"
        });
      } catch (_) {}
    }
  });
}
function __emitSlotStripState(type, index, isDirty, fnName) {
  if (!window.UIBus) return;

  __slotStripResetAllOnce();

  const buildUiSlotId = (t, i) => window.MDDTSlotMap?.buildUiSlotId
    ? window.MDDTSlotMap.buildUiSlotId({ type: t, index: i })
    : `${t}:${i}`;
  const parseUiSlotId = (id) => window.MDDTSlotMap?.parseUiSlotId
    ? window.MDDTSlotMap.parseUiSlotId(id)
    : (() => {
        const m = /^([^:]+):(\d+)$/.exec(id || "");
        return m ? { type: m[1], index: Number(m[2]) } : null;
      })();

  const safeIndex = (typeof index === "number" && index >= 0) ? index : -1;
  const prevId = __slotStripLastUiSlotIdByType[type];

  // If selection moved (or became invalid), clear the previous marker.
  if (prevId) {
    const expectedId = (safeIndex >= 0) ? buildUiSlotId(type, safeIndex) : null;
    if (!expectedId || prevId !== expectedId) {
      const prev = parseUiSlotId(prevId);
      window.UIBus.emit("slot:clean", {
        uiSlotId: prevId,
        type: prev?.type || type,
        index: prev?.index,
        fn: fnName,
        reason: "selection-changed"
      });
      __slotStripLastUiSlotIdByType[type] = null;
    }
  }

  if (safeIndex < 0) return;

  const uiSlotId = buildUiSlotId(type, safeIndex);
  window.UIBus.emit(isDirty ? "slot:dirty" : "slot:clean", {
    uiSlotId,
    type,
    index: safeIndex,
    fn: fnName,
    source: "diff"
  });
  __slotStripLastUiSlotIdByType[type] = uiSlotId;
}

// Deep equality for plain objects/arrays/typed arrays.
const __GLOBAL_EPHEMERAL_KEYS = new Set([
  "rawGlobal",
  "raw",
  "sysexVersion",
  "sysexRevision",
  "tempoHigh",
  "tempoLow",
  "globalPosition",
  "checksum",
  "messageLength",
  "sysexEnd",
  "programChange"
]);

function __isTypedArray(v) {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function __deepEqual(a, b, ignoreKeys, depth = 0) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;

  // Primitives
  if (ta !== "object") {
    // Handle NaN
    if (ta === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
    return Object.is(a, b);
  }
  // Typed arrays (also tolerate JSON-serialized forms)
  if (__isTypedArray(a) || __isTypedArray(b)) {
    const aIsTA = __isTypedArray(a);
    const bIsTA = __isTypedArray(b);

    // TypedArray <-> TypedArray
    if (aIsTA && bIsTA) {
      if (a.constructor !== b.constructor) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    // TypedArray <-> Array or numeric-key object (common after JSON import/clone)
    const typed = aIsTA ? a : b;
    const other = aIsTA ? b : a;

    if (Array.isArray(other)) {
      if (typed.length !== other.length) return false;
      for (let i = 0; i < typed.length; i++) {
        if (typed[i] !== (other[i] & 0xFF)) return false;
      }
      return true;
    }

    if (other && typeof other === "object") {
      // JSON.stringify(Uint8Array) -> {"0":..., "1":...} (no length).
      for (let i = 0; i < typed.length; i++) {
        let v = other[i];
        if (v == null && other[String(i)] != null) v = other[String(i)];
        // Treat missing values as mismatch (avoids silently equating partial keymaps).
        if (v == null) return false;
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        if (typed[i] !== (n & 0xFF)) return false;
      }
      return true;
    }

    return false;
  }

  // Arrays
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!__deepEqual(a[i], b[i], ignoreKeys, depth + 1)) return false;
    }
    return true;
  }

  // Objects
  const aKeys = Object.keys(a).filter(k => !ignoreKeys?.has(k)).sort();
  const bKeys = Object.keys(b).filter(k => !ignoreKeys?.has(k)).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const k of aKeys) {
    if (!__deepEqual(a[k], b[k], ignoreKeys, depth + 1)) return false;
  }
  return true;
}

function __globalsAreEqual(a, b) {
  try {
    const util = window.MDDT && window.MDDT.util;
    if (util && typeof util.makeGlobalComparable === "function") {
      return JSON.stringify(util.makeGlobalComparable(a)) === JSON.stringify(util.makeGlobalComparable(b));
    }
  } catch (_) {
    // fall through
  }
  return __deepEqual(a, b, __GLOBAL_EPHEMERAL_KEYS);
}

function updateSongPanelHeader() {
  const songPanel = document.querySelector('.panel[data-panel-id="song"] .panel-header');
  if (!songPanel || !window.currentSong) return;

  const strippedCurrent = JSON.stringify(stripSongEphemeral(window.currentSong));
  const isEmpty = isSongEmpty(window.currentSong);

  // A song slot is considered "loaded" only after the user explicitly clicks a slot.
  const sIndex = (typeof window.selectedSongSlotIndex === "number" && window.selectedSongSlotIndex >= 0)
    ? window.selectedSongSlotIndex
    : -1;

  // No slot selected: do not mark anything dirty/clean in the slot strip and keep
  // the header in its default (neutral) state.
  if (sIndex < 0) {
    songPanel.style.background = getDefaultSlotColor();
    songPanel.setAttribute("data-default", "true");
    setNavButtonAccent("song", "");
    __emitSlotStripState("song", -1, false, "updateSongPanelHeader");
    window.lastSongSnapshot = strippedCurrent;
    return;
  }

  // Keep buffer metadata aligned with the selected slot.
  try { window.currentSong.slotIndex = sIndex; } catch (_) {}

  let newBackground;
  if (isEmpty) {
    newBackground = getDefaultSlotColor();
  } else {
    newBackground = getSongGradientForSlot(window.currentSong);
  }

  // Dirty semantics:
  let isDirty = false;
  let stored = null;
  if (sIndex >= 0 && window.allSongSlots) {
    stored = window.allSongSlots[sIndex] || null;
  }

  if (stored && !isSongEmpty(stored)) {
    isDirty = !songsAreEqual(window.currentSong, stored);
  } else {
    // Empty slot baseline: only "dirty" if the buffer has content.
    isDirty = !isEmpty;
  }

  const shouldUseDefaultHeader = isEmpty || isDirty;

  if (shouldUseDefaultHeader) {
    songPanel.style.background = getDefaultSlotColor();
    songPanel.setAttribute("data-default", "true");
  } else {
    songPanel.style.background = newBackground;
    songPanel.removeAttribute("data-default");
  }

  setNavButtonAccent("song", songPanel.getAttribute("data-default") ? "" : songPanel.style.background);

  __emitSlotStripState("song", sIndex, isDirty, "updateSongPanelHeader");

  window.lastSongSnapshot = strippedCurrent;
}

function updatePanelHeaderColorsCore() {
  if (window.toolsPanelState && window.toolsPanelState.busyOperations > 0) return;
  const defaultColor = "#eee";
  // --- Kit Panel Header ---
  const kitPanel = document.querySelector('.panel[data-panel-id="kit"] .panel-header');
  if (kitPanel) {
    const kIndex = (typeof window.selectedKitSlotIndex === "number" && window.selectedKitSlotIndex >= 0)
      ? window.selectedKitSlotIndex
      : -1;

    let isKitDirty = false;
    let computedColor = defaultColor;

    if (kIndex >= 0) {
      const entry = window.kitLibrary && window.kitLibrary[kIndex] ? window.kitLibrary[kIndex] : null;
      const originalKit = entry && entry.data ? entry.data : null;
      const isEmpty = (window.kit && typeof window.isKitEmpty === "function") ? window.isKitEmpty(window.kit) : true;

      if (originalKit) {
        isKitDirty = !!(window.kit && !kitsAreEqual(window.kit, originalKit));
        if (!isKitDirty) {
          computedColor = getKitNameColor(originalKit);
        }
      } else {
        // No stored baseline: only mark dirty if buffer has content.
        isKitDirty = !isEmpty;
      }
    }

    if (computedColor === defaultColor) {
      kitPanel.setAttribute("data-default", "true");
      kitPanel.style.backgroundColor = "";
    } else {
      kitPanel.removeAttribute("data-default");
      kitPanel.style.backgroundColor = computedColor;
    }

    setNavButtonAccent("kit", computedColor === defaultColor ? "" : computedColor);

    // If no slot selected (kIndex < 0) this also clears any previous dirty marker.
    __emitSlotStripState("kit", kIndex, isKitDirty, "updatePanelHeaderColorsCore");
  }
  // --- Pattern Panel Header ---
  const patternPanel = document.querySelector('.panel[data-panel-id="pattern"] .panel-header');
  if (patternPanel) {
    const pIndex = (typeof window.selectedPatternSlotIndex === "number" && window.selectedPatternSlotIndex >= 0)
      ? window.selectedPatternSlotIndex
      : -1;

    let isPatternDirty = false;
    let computedColor = defaultColor;

    if (pIndex >= 0 && window.allPatternSlots) {
      const slot = window.allPatternSlots[pIndex] || null;
      const stored = slot ? slot.pattern : null;

      if (stored) {
        if (
          JSON.stringify(stripPatternEphemeral(window.pattern)) !==
          JSON.stringify(stripPatternEphemeral(stored))
        ) {
          isPatternDirty = true;
        }

        if (!isPatternDirty) {
          const assignedKitNum = stored ? stored.assignedKitNumber : -1;
          if (
            assignedKitNum >= 0 &&
            window.kitLibrary &&
            window.kitLibrary[assignedKitNum]
          ) {
            computedColor = getKitNameColor(window.kitLibrary[assignedKitNum].data);
          }
        }
      } else {
        // Empty slot baseline: only mark dirty if buffer has content.
        if (typeof window.isPatternEmpty === "function") {
          isPatternDirty = !window.isPatternEmpty(window.pattern);
        } else {
          isPatternDirty = !!window.pattern;
        }
      }
    }

    if (computedColor === defaultColor) {
      patternPanel.setAttribute("data-default", "true");
      patternPanel.style.backgroundColor = "";
    } else {
      patternPanel.removeAttribute("data-default");
      patternPanel.style.backgroundColor = computedColor;
    }

    setNavButtonAccent("pattern", computedColor === defaultColor ? "" : computedColor);

    // If no slot selected (pIndex < 0) this also clears any previous dirty marker.
    __emitSlotStripState("pattern", pIndex, isPatternDirty, "updatePanelHeaderColorsCore");
  }

  // --- Global Panel Header ---
  const globalPanel = document.querySelector('.panel[data-panel-id="global"] .panel-header');
  if (globalPanel) {
    const i = window.selectedGlobalSlotIndex;
    let computedColor = defaultColor;
    let isGlobalDirty = false;
    if (typeof i === "number" && i >= 0 && i < 8 && window.globalLibrary[i]) {
      computedColor = globalColorForIndex(i);
      if (window.globalData && !__globalsAreEqual(window.globalData, window.globalLibrary[i])) {
        isGlobalDirty = true;
        computedColor = defaultColor;
      }
    }
    if (computedColor === defaultColor) {
      globalPanel.setAttribute("data-default", "true");
      globalPanel.style.backgroundColor = "";
    } else {
      globalPanel.removeAttribute("data-default");
      globalPanel.style.backgroundColor = computedColor;
    }
    setNavButtonAccent("global", computedColor === defaultColor ? "" : computedColor);

    __emitSlotStripState("global", i, isGlobalDirty, "updatePanelHeaderColorsCore");
  }
  updateSongPanelHeader();
}

function globalColorForIndex(i) {
  const lightness = 30 + (i / 7) * 40;
  return `hsl(120, 70%, ${lightness}%)`;
}

function getSongGradientFromPatterns() {
  const colors = [];
  if (window.currentSong && Array.isArray(window.currentSong.rows)) {
    window.currentSong.rows.forEach(row => {
      const raw = row.data[0];
      if (raw === 0xff || raw === 0xfe) return;
      const patNum = raw >= 0x80 ? (raw & 0x7f) : raw;
      if (
        typeof patNum === "number" &&
        patNum < window.allPatternSlots.length
      ) {
        const patternSlot = window.allPatternSlots[patNum];
        if (patternSlot && patternSlot.pattern) {
          const assignedKit = patternSlot.pattern.assignedKitNumber;
          if (
            window.kitLibrary &&
            assignedKit >= 0 &&
            window.kitLibrary[assignedKit]
          ) {
            colors.push(getKitNameColor(window.kitLibrary[assignedKit].data));
          } else {
            colors.push("#eee");
          }
        }
      }
    });
  }
  return colors;
}

function populateMDPositionDropdowns() {
  const globSelect = document.getElementById("globReqNumber");
  if (globSelect) {
    globSelect.innerHTML = "";
    for (let i = 1; i <= 8; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      globSelect.appendChild(opt);
    }
  }
  const kitSelect = document.getElementById("kitReqNumber");
  if (kitSelect) {
    kitSelect.innerHTML = "";
    for (let i = 1; i <= 64; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      kitSelect.appendChild(opt);
    }
  }
  const songSelect = document.getElementById("songReqNumber");
  if (songSelect) {
    songSelect.innerHTML = "";
    for (let i = 1; i <= 32; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      songSelect.appendChild(opt);
    }
  }
}
window.addEventListener("load", populateMDPositionDropdowns);

function swapKitSlots(fromIndex, toIndex) {
  const temp = window.kitLibrary[fromIndex];
  window.kitLibrary[fromIndex] = window.kitLibrary[toIndex];
  window.kitLibrary[toIndex] = temp;

  [fromIndex, toIndex].forEach(idx => {
    const entry = window.kitLibrary && window.kitLibrary[idx];
    if (entry && entry.data) {
      try { entry.colorIndex = idx; } catch (_) {}
      try { entry.data.sysexPosition = idx; } catch (_) {}
    }
  });
  if (window.allPatternSlots) {
    window.allPatternSlots.forEach(slot => {
      if (slot && slot.pattern) {
        const assigned = slot.pattern.assignedKitNumber;
        if (assigned === fromIndex) {
          slot.pattern.assignedKitNumber = toIndex;
        } else if (assigned === toIndex) {
          slot.pattern.assignedKitNumber = fromIndex;
        }

        if (typeof slot.kitColorIndex !== "undefined") {
          if (slot.kitColorIndex === fromIndex) slot.kitColorIndex = toIndex;
          else if (slot.kitColorIndex === toIndex) slot.kitColorIndex = fromIndex;
        }
      }
    });
  }
}

function swapPatternSlots(fromIndex, toIndex) {
  const temp = window.allPatternSlots[fromIndex];
  window.allPatternSlots[fromIndex] = window.allPatternSlots[toIndex];
  window.allPatternSlots[toIndex] = temp;

  [fromIndex, toIndex].forEach(idx => {
    const slot = window.allPatternSlots && window.allPatternSlots[idx];
    if (slot && slot.pattern) {
      try { slot.pattern.origPos = idx; } catch (_) {}
      try { slot.pattern.patternNumber = idx; } catch (_) {}
      try { slot.kitColorIndex = slot.pattern.assignedKitNumber || 0; } catch (_) {}
    }
  });
  if (window.allSongSlots) {
    window.allSongSlots.forEach(song => {
      if (song && song.rows) {
        song.rows.forEach(row => {
          const raw = row.data[0];
          if (raw === 0xFF || raw === 0xFE) return;
          let flag = raw >= 0x80 ? 0x80 : 0;
          let patNum = raw >= 0x80 ? (raw & 0x7F) : raw;
          if (patNum === fromIndex) {
            row.data[0] = flag | toIndex;
          } else if (patNum === toIndex) {
            row.data[0] = flag | fromIndex;
          }
        });
      }
    });
  }
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getBulkDelay() {
  const baseDelay = 38;
  const val = parseInt(document.getElementById("bulkDelayInput").value, 10);
  const userDelay = isNaN(val) ? 0 : val;
  return baseDelay + userDelay;
}

document.querySelectorAll(
  'input[type="checkbox"][id$="G"], ' +
  'input[type="checkbox"][id$="K"], ' +
  'input[type="checkbox"][id$="P"], ' +
  'input[type="checkbox"][id$="S"]'
).forEach(checkbox => {
  checkbox.addEventListener("click", function(e) {
    if (e.shiftKey) {
      const groupPrefix = this.id.slice(0, -1);
      const newState = this.checked;
      document
        .querySelectorAll(`input[type="checkbox"][id^="${groupPrefix}"]`)
        .forEach(other => (other.checked = newState));
    }
  });
});

const posTitle = document.getElementById("positionTitle");
if (posTitle) {
  posTitle.addEventListener("click", function(e) {
    if (e.shiftKey) {
      resetPositionSliders();
    }
  });
}

function resetPositionSliders() {
  const globalsSlider = document.getElementById("slider-globals");
  const kitsSlider = document.getElementById("slider-kits");
  const patternsSlider = document.getElementById("slider-patterns");
  const songsSlider = document.getElementById("slider-songs");
  if (globalsSlider && globalsSlider.noUiSlider) {
    globalsSlider.noUiSlider.set([1, 8]);
  }
  if (kitsSlider && kitsSlider.noUiSlider) {
    kitsSlider.noUiSlider.set([1, 64]);
  }
  if (patternsSlider && patternsSlider.noUiSlider) {
    patternsSlider.noUiSlider.set([0, 127]);
  }
  if (songsSlider && songsSlider.noUiSlider) {
    songsSlider.noUiSlider.set([1, 32]);
  }
}

function animateSlotsIntro() {
  const totalDuration = 400;
  const normalSlots = document.querySelectorAll('.global-slot, .kit-slot, .song-slot');
  let slotsArray = shuffleArray(Array.from(normalSlots));
  const delayIncrement = slotsArray.length > 1 ? totalDuration / (slotsArray.length - 1) : 0;
  slotsArray.forEach((slot, index) => {
    slot.style.animationDelay = `${index * delayIncrement}ms`;
    slot.classList.add('fade-in');
  });
  const patternSlots = document.querySelectorAll('.pattern-slot');
  let patternArray = shuffleArray(Array.from(patternSlots));
  const patternDelayIncrement =
    patternArray.length > 1 ? totalDuration / (patternArray.length - 1) : 0;
  patternArray.forEach((slot, index) => {
    slot.style.animationDelay = `${index * patternDelayIncrement}ms`;
    slot.classList.add('fade-in-pattern');
  });
}

function onGlobalCopy() {
  if (window.activePanel === "kit") copyKitTrack();
  else if (window.activePanel === "pattern") copyPatternTrack();
  else if (window.activePanel === "song") copySongRow();
}

function onGlobalPaste() {
  if (!window.editorClipboard.type || !window.editorClipboard.data) return;
  if (window.activePanel === "kit" && editorClipboard.type === "kitTrack") {
    pasteKitTrack();
  } else if (window.activePanel === "pattern" && editorClipboard.type === "patternTrack") {
    pastePatternTrack();
  } else if (window.activePanel === "song" && editorClipboard.type === "songRow") {
    pasteSongRow();
  }
}

function onGlobalCut() {
  onGlobalCopy();
  if (window.activePanel === "kit" && editorClipboard.type === "kitTrack") {
    clearKitTrack(window.selectedKitTrackIndex);
  } else if (window.activePanel === "pattern" && editorClipboard.type === "patternTrack") {
    clearPatternTrack(window.selectedPatternTrackIndex);
  } else if (window.activePanel === "song" && editorClipboard.type === "songRow") {
    clearSongRow(window.selectedSongRowIndex);
  }
  if (window.activePanel === "kit") {
    if (window.buildKitNameUI) window.buildKitNameUI();
    if (window.buildTrackOverviewUI) window.buildTrackOverviewUI();
    updatePanelHeaderColors();
  } else if (window.activePanel === "pattern") {
    if (window.buildPatternGeneralUI) window.buildPatternGeneralUI();
    updatePanelHeaderColors();
  } else if (window.activePanel === "song") {
    if (typeof fillSongUI === "function") fillSongUI();
    updatePanelHeaderColors();
  }
}

function onGlobalUndo() {
  if (!lastUndoRecord.type) return;
  if (lastUndoRecord.type === "kitTrack") {
    applyKitTrackData(lastUndoRecord.trackOrRow, lastUndoRecord.oldData);
  } else if (lastUndoRecord.type === "patternTrack") {
    applyPatternTrackData(lastUndoRecord.trackOrRow, lastUndoRecord.oldData);
  } else if (lastUndoRecord.type === "songRow") {
    applySongRowData(lastUndoRecord.trackOrRow, lastUndoRecord.oldData);
  }
  lastUndoRecord = { type: null, trackOrRow: -1, oldData: null };
  if (window.activePanel === "kit") {
    if (window.buildKitNameUI) window.buildKitNameUI();
    if (window.buildTrackOverviewUI) window.buildTrackOverviewUI();
    updatePanelHeaderColors();
  } else if (window.activePanel === "pattern") {
    if (window.buildPatternGeneralUI) window.buildPatternGeneralUI();
    updatePanelHeaderColors();
  } else if (window.activePanel === "song") {
    if (typeof fillSongUI === "function") fillSongUI();
    updatePanelHeaderColors();
  }
}

function copyKitTrack() {
  const t = window.selectedKitTrackIndex;
  if (t < 0 || t > 15) return;
  const data = getKitTrackData(t);
  editorClipboard.type = "kitTrack";
  editorClipboard.data = data;
}

function pasteKitTrack() {
  const t = window.selectedKitTrackIndex;
  if (t < 0 || t > 15) return;
  lastUndoRecord = { type: "kitTrack", trackOrRow: t, oldData: getKitTrackData(t) };
  applyKitTrackData(t, editorClipboard.data);
  if (window.buildKitNameUI) window.buildKitNameUI();
  if (window.buildTrackOverviewUI) window.buildTrackOverviewUI();
  updatePanelHeaderColors();
}

function clearKitTrack(t) {
  window.kit.machineAssignments[t] = 0;
  window.kit.machineTonalFlags[t] = 0;
  window.kit.machineParams[t] = Array(8).fill(64);
  window.kit.trackFx[t] = Array(8).fill(0);
  window.kit.routing[t] = Array(8).fill(0);
  window.kit.trackLevels[t] = 100;
  window.kit.lfoBlocks[t] = Array(8).fill(0);
}

function copyPatternTrack() {
  const t = window.selectedPatternTrackIndex;
  if (t < 0 || t > 15) return;
  const data = getPatternTrackData(t);
  editorClipboard.type = "patternTrack";
  editorClipboard.data = data;
}

function pastePatternTrack() {
  const t = window.selectedPatternTrackIndex;
  if (t < 0 || t > 15) return;
  lastUndoRecord = { type: "patternTrack", trackOrRow: t, oldData: getPatternTrackData(t) };
  applyPatternTrackData(t, editorClipboard.data);
  if (window.buildPatternGeneralUI) window.buildPatternGeneralUI();
  updatePanelHeaderColors();
}

function clearPatternTrack(t) {
  window.pattern.trigBitsPerTrack[t].fill(0);
  window.pattern.accentBitsPerTrack[t].fill(0);
  window.pattern.swingBitsPerTrack[t].fill(0);
  window.pattern.slideBitsPerTrack[t].fill(0);
  window.pattern.locks = window.pattern.locks.filter(lk => lk.track !== t);
}

function copySongRow() {
  const r = window.selectedSongRowIndex;
  if (r < 0) return;
  const data = getSongRowData(r);
  editorClipboard.type = "songRow";
  editorClipboard.data = data;
}

function pasteSongRow() {
  const r = window.selectedSongRowIndex;
  if (r < 0) return;
  lastUndoRecord = { type: "songRow", trackOrRow: r, oldData: getSongRowData(r) };
  applySongRowData(r, editorClipboard.data);
  if (typeof fillSongUI === "function") fillSongUI();
  updatePanelHeaderColors();
}

function clearSongRow(r) {
}

function getKitTrackData(t) { return JSON.parse(JSON.stringify({
  machineAssignments: window.kit.machineAssignments[t],
  machineTonalFlags: window.kit.machineTonalFlags[t],
  machineParams: window.kit.machineParams[t],
  trackFx: window.kit.trackFx[t],
  routing: window.kit.routing[t],
  trackLevels: window.kit.trackLevels[t],
  lfoBlocks: window.kit.lfoBlocks[t]
})); }

function applyKitTrackData(t, data) {
  window.kit.machineAssignments[t] = data.machineAssignments;
  window.kit.machineTonalFlags[t] = data.machineTonalFlags;
  window.kit.machineParams[t] = data.machineParams;
  window.kit.trackFx[t] = data.trackFx;
  window.kit.routing[t] = data.routing;
  window.kit.trackLevels[t] = data.trackLevels;
  window.kit.lfoBlocks[t] = data.lfoBlocks;
}

function getPatternTrackData(t) {
  return JSON.parse(JSON.stringify({
    trigBits: [...window.pattern.trigBitsPerTrack[t]],
    accentBits: [...window.pattern.accentBitsPerTrack[t]],
    swingBits: [...window.pattern.swingBitsPerTrack[t]],
    slideBits: [...window.pattern.slideBitsPerTrack[t]],
    locks: window.pattern.locks.filter(lk => lk.track === t)
  }));
}

function applyPatternTrackData(t, data) {
  window.pattern.trigBitsPerTrack[t] = new Uint8Array(data.trigBits);
  window.pattern.accentBitsPerTrack[t] = new Uint8Array(data.accentBits);
  window.pattern.swingBitsPerTrack[t] = new Uint8Array(data.swingBits);
  window.pattern.slideBitsPerTrack[t] = new Uint8Array(data.slideBits);
  window.pattern.locks = window.pattern.locks.filter(lk => lk.track !== t);
  data.locks.forEach(lk => {
    window.pattern.locks.push(JSON.parse(JSON.stringify(lk)));
  });
}

function getSongRowData(r) {
  if (!window.currentSong || !window.currentSong.rows || !window.currentSong.rows[r]) {
    return null;
  }
  return JSON.parse(JSON.stringify(window.currentSong.rows[r]));
}

function applySongRowData(r, rowData) {
  if (!window.currentSong || !window.currentSong.rows || !window.currentSong.rows[r]) {
    return;
  }
  window.currentSong.rows[r] = JSON.parse(JSON.stringify(rowData));
}

function highlightKitTrack(t) {
  document.querySelectorAll(".kit-track-overview tr").forEach((row, i) => {
    row.classList.toggle("selected", i === t);
  });
}

function highlightPatternTrack(t) {
  document.querySelectorAll(".pattern-track-list tr").forEach((row, i) => {
    row.classList.toggle("selected", i === t);
  });
}

function highlightSongRow(r) {
  document.querySelectorAll("#songRowsBody tr").forEach((row, i) => {
    row.classList.toggle("selected", i === r);
  });
}

function onClickKitTrack(t) {
  window.selectedKitTrackIndex = t;
  window.activePanel = "kit";
  highlightKitTrack(t);
}

function onClickPatternTrack(t) {
  window.selectedPatternTrackIndex = t;
  window.activePanel = "pattern";
  highlightPatternTrack(t);
}

function onClickSongRow(r) {
  window.selectedSongRowIndex = r;
  window.activePanel = "song";
  highlightSongRow(r);
}

const __KIT_EPHEMERAL_KEYS = new Set([
  "rawKit",
  "raw",
  "sysexVersion",
  "sysexRevision",
  "sysexPosition",
  "slotIndex",
  "checksumHi",
  "checksumLo",
  "lengthHi",
  "lengthLo",
  "reportedDocLen",
  "labMeta",
  "isClean"
]);

function __kitIsTypedArray(v) {
  return v && typeof v === "object" && ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function __kitLooksLikeNumericKeyObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || __kitIsTypedArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.length) return false;
  return keys.every(k => /^\d+$/.test(k));
}

function __kitNumericObjectToArray(v) {
  const keys = Object.keys(v).filter(k => /^\d+$/.test(k)).map(k => parseInt(k, 10));
  if (!keys.length) return [];
  const max = Math.max.apply(null, keys);
  const out = new Array(max + 1);
  for (let i = 0; i <= max; i++) {
    const key = String(i);
    out[i] = Object.prototype.hasOwnProperty.call(v, key) ? v[key] : 0;
  }
  return out;
}

function __normalizeKitValue(v, depth = 0) {
  if (depth > 25) return v;
  if (v == null) return v;
  const t = typeof v;
  if (t !== "object") return v;

  // Typed arrays -> plain arrays
  if (__kitIsTypedArray(v)) return Array.from(v, x => (typeof x === "number" ? (x & 0xFF) : x));

  // Arrays -> normalize members
  if (Array.isArray(v)) return v.map(x => __normalizeKitValue(x, depth + 1));

  // JSON'd typed arrays -> numeric-key objects
  if (__kitLooksLikeNumericKeyObject(v)) {
    const arr = __kitNumericObjectToArray(v);
    return arr.map(x => __normalizeKitValue(x, depth + 1));
  }

  // Plain objects -> normalize values, stable key order, drop ephemeral keys
  const out = {};
  const keys = Object.keys(v).sort();
  for (const k of keys) {
    if (__KIT_EPHEMERAL_KEYS.has(k)) continue;

    if (k === "kitName") {
      const kn = v[k];
      out.kitName = Array.isArray(kn) ? kn.join("") : (kn == null ? "" : String(kn));
      continue;
    }

    out[k] = __normalizeKitValue(v[k], depth + 1);
  }
  return out;
}

function stripKitEphemeral(k) {
  return __normalizeKitValue(k);
}

function kitsAreEqual(a, b) {
  try {
    return JSON.stringify(stripKitEphemeral(a)) === JSON.stringify(stripKitEphemeral(b));
  } catch (_) {
    // Fallback: if something isn't serializable, fall back to reference equality.
    return a === b;
  }
}

function to7(v) { return (v == null ? 0 : (v & 0x7f)); }

// Coerce an 8-cell thing into a plain [8] array (Array, Uint8Array, or {"0":..})
function coerce8(x) {
  if (x instanceof Uint8Array) return Array.from(x, to7);
  if (Array.isArray(x)) {
    const out = new Array(8).fill(0);
    for (let i = 0; i < Math.min(8, x.length); i++) out[i] = to7(x[i]);
    return out;
  }
  if (x && typeof x === 'object') { // JSON’d typed array: { "0":.., "1":.. }
    const out = new Array(8).fill(0);
    for (let i = 0; i < 8; i++) out[i] = to7(x[i]);
    return out;
  }
  return new Array(8).fill(0);
}

function coerce16x8(m) {
  const out = new Array(16);
  const src = Array.isArray(m) ? m : [];
  for (let t = 0; t < 16; t++) out[t] = coerce8(src[t]);
  return out;
}

function stripPatternEphemeral(pattern) {
  // structuredClone keeps typed arrays; JSON clone does not.
  const p = (typeof structuredClone === 'function') ? structuredClone(pattern)
                                                    : JSON.parse(JSON.stringify(pattern));
  // 1) remove purely ephemeral
  delete p.rawPattern;
  delete p.origPos;
  delete p.sysexVersion;
  delete p.sysexRevision;
  delete p.patternNumber;
  delete p.labMeta;
  delete p.isClean;
  delete p.lockCount;
  delete p.lockMasks;
  delete p.lockMasks2;
  delete p.paramMatrixMain;
  delete p.paramMatrixExtra;

  // 2) canonicalise bitfields to plain arrays
  p.trigBitsPerTrack   = coerce16x8(p.trigBitsPerTrack);
  p.accentBitsPerTrack = coerce16x8(p.accentBitsPerTrack);
  p.swingBitsPerTrack  = coerce16x8(p.swingBitsPerTrack);
  p.slideBitsPerTrack  = coerce16x8(p.slideBitsPerTrack);
  p.accentBitsGlobal   = coerce8(p.accentBitsGlobal);
  p.swingBitsGlobal    = coerce8(p.swingBitsGlobal);
  p.slideBitsGlobal    = coerce8(p.slideBitsGlobal);

  // 3) locks: array
  p.locks = Array.isArray(p.locks) ? p.locks.slice() : [];
  p.locks.sort((a, b) =>
    (a.track - b.track) || (a.step - b.step) || (a.paramID - b.paramID)
  );

  return p;
}
function patternsAreEqual(a, b) {
  return JSON.stringify(stripPatternEphemeral(a)) === JSON.stringify(stripPatternEphemeral(b));
}

function stripSongEphemeral(song) {
  const clone = JSON.parse(JSON.stringify(song));
  delete clone.rawSong;
  delete clone.slotIndex;
  delete clone.checksumHi;
  delete clone.checksumLo;
  delete clone.version;
  delete clone.revision;
  delete clone.reportedDocLen;
  return clone;
}
function songsAreEqual(a, b) {
  if (!a || !b) return a === b;
  const strippedA = stripSongEphemeral(a);
  const strippedB = stripSongEphemeral(b);
  const rowsAString = JSON.stringify(strippedA.rows || []);
  const rowsBString = JSON.stringify(strippedB.rows || []);
  return strippedA.name === strippedB.name && rowsAString === rowsBString;
}
window.initLabPanel = function () {
  const labPanelContent = document.getElementById("labPanelContent");
  if (!labPanelContent) return;
  labPanelContent.innerHTML = "";
  const existing = document.getElementById("labContainer");
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const labUI = createLabUI();
  labPanelContent.appendChild(labUI);

  try {
    if (window.MDDT_LabHost && typeof window.MDDT_LabHost.onRegister === "function") {
      window.MDDT_LabHost.onRegister();
    }
  } catch (_) {}

(function() {
  const input = document.getElementById("machineIDs");
  if (!input) return;

  const label = document.querySelector('label[for="machineIDs"]');
  if (!label) return;

  let popup = null;
  function createMachineIDsPopup() {
    const entries = window.getValidMachineEntries(window.mdModel);
    const maxForModel = window.mdUWEnabled
      ? (window.mdModel === "MKI" ? 163 : 191)
      : 123;
    let validIDs = Object.keys(entries)
      .map(Number)
      .filter(id => id <= maxForModel && !/unused/i.test(entries[id]))
      .sort((a, b) => a - b);

      if (window.mdOSVersion === "1.63") {
  validIDs = validIDs.filter(id => !window.X_OS_ONLY_MACHINES.includes(id));
}

    // build overlay
    const overlay = document.createElement("div");
    overlay.id = "machineIDsPopup";
    Object.assign(overlay.style, {
      position: "fixed",
      top: 0, left: 0,
      width: "100vw", height: "100vh",
      background: "rgba(0,0,0,0.6)",
      color: "#fff",
      overflowY: "auto",
      zIndex: 9999,
      padding: "2em",
      boxSizing: "border-box"
    });

    const container = document.createElement("div");
    container.style.maxWidth = "600px";
    container.style.margin = "0 auto";
    container.style.background = "#222";
    container.style.padding = "1em";
    container.style.borderRadius = "4px";

    const title = document.createElement("h2");
    title.textContent = "Machine IDs";
    title.style.textAlign = "center";
    container.appendChild(title);

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    const cols = 3;
    const rows = Math.ceil(validIDs.length / cols);
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        td.style.padding = "4px";
        const idx = c * rows + r;
        if (idx < validIDs.length) {
          const id = validIDs[idx];
          td.textContent = id + ": " + entries[id];
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    container.appendChild(table);
    overlay.appendChild(container);
    return overlay;
  }

  label.style.cursor = "pointer";
  label.addEventListener("mousedown", e => {
    e.preventDefault();
    if (!popup) {
      popup = createMachineIDsPopup();
      document.body.appendChild(popup);

      const closeOnMouseUp = () => {
        if (popup) {
          popup.remove();
          popup = null;
        }
        document.removeEventListener("mouseup", closeOnMouseUp);
      };
      document.addEventListener("mouseup", closeOnMouseUp);
    }
  });
})();
};

window.initUI = function () {
  rememberPanelStates();
  initRangeSliders();
  buildGlobalSlotsUI();
  buildSongSlotsUI();
  buildKitSlotsUI();
  buildPatternSlotsUI();
  if (!window.hasAnimatedSlots) {
    window.addEventListener("load", () => {
      animateSlotsIntro();
      window.hasAnimatedSlots = true;
    });
  }
  window.buildKitNameUI && window.buildKitNameUI();
  window.buildTrackOverviewUI && window.buildTrackOverviewUI();
  window.buildMasterFxUI && window.buildMasterFxUI();
  if (typeof window.buildKnobGrid === "function") {
    window.buildKnobGrid("machineParamsUI", window.kit.machineParams, [
      "Param1","Param2","Param3","Param4",
      "Param5","Param6","Param7","Param8"
    ], true);
    window.buildKnobGrid("trackFxUI", window.kit.trackFx, [
      "AMdep","AMfrq","EQfrq","EQgain",
      "FltBase","FltWidth","FltQ","SRR"
    ], true);
    window.buildKnobGrid("routingUI", window.kit.routing, [
      "Dist","Vol","Pan","DelSnd",
      "RevSnd","LFOspd","LFOdep","LFOmix"
    ], true);
  }
  window.initGlobalUI && window.initGlobalUI();
  typeof fillSongUI === "function" && fillSongUI();
  populatePatternDropdown();
  buildPatternGeneralUI();
  window.buildLockAndBitfieldUI && window.buildLockAndBitfieldUI();
  buildTopPatternBanksUI();
  attachBankSlotClickHandlers();
  if (typeof colorizeSlots === "function") colorizeSlots();
  applyPanelStates();
  typeof initUwPanel === "function" && initUwPanel();
  if (typeof highlightKitTrack === "function") highlightKitTrack(window.selectedKitTrackIndex || 0);
  if (typeof highlightPatternTrack === "function") highlightPatternTrack(window.selectedPatternTrackIndex || 0);
  updatePanelHeaderColors();
  if (!window.labPanelInitialized) {
    if (typeof window.initLabPanel === "function") {
      window.initLabPanel();
      window.labPanelInitialized = true;
    }
  }
  if (typeof window.refreshSkewclidTrackSelectors === "function") {
    window.refreshSkewclidTrackSelectors();
  }
};

window.addEventListener("keydown", e => {
  if (["INPUT","TEXTAREA"].includes(e.target.tagName)) return;
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrlOrCmd && key === "c") {
    onGlobalCopy();
    e.preventDefault();
  } else if (ctrlOrCmd && key === "v") {
    onGlobalPaste();
    e.preventDefault();
  } else if (ctrlOrCmd && key === "x") {
    onGlobalCut();
    e.preventDefault();
  } else if (ctrlOrCmd && key === "z") {
    onGlobalUndo();
    e.preventDefault();
  }
});


if (posTitle) {
  posTitle.style.cursor = "pointer";
  posTitle.style.transition = "background-color 0.3s ease";

  posTitle.addEventListener("mouseover", function () {
    this.style.backgroundColor = "rgba(150,150,150,0.4)";
  });
  posTitle.addEventListener("mouseout", function () {
    this.style.backgroundColor = "";
  });

  posTitle.addEventListener("click", function (e) {
    if (e.shiftKey) {
      randomizePositionSliders();
    } else {
      resetPositionSliders();
    }
  });
}

function randomizePositionSliders() {
  const sliderIds = ["slider-globals", "slider-kits", "slider-patterns", "slider-songs"];
  sliderIds.forEach(id => {
    const sliderEl = document.getElementById(id);
    if (sliderEl && sliderEl.noUiSlider) {
      const range = sliderEl.noUiSlider.options.range;
      const step = sliderEl.noUiSlider.options.step || 1;
      const min = parseFloat(range.min);
      const max = parseFloat(range.max);
      let val1 = Math.floor(Math.random() * (max - min + 1)) + min;
      let val2 = Math.floor(Math.random() * (max - min + 1)) + min;
      if (val1 > val2) [val1, val2] = [val2, val1];
      val1 = Math.round(val1 / step) * step;
      val2 = Math.round(val2 / step) * step;
      sliderEl.noUiSlider.set([val1, val2]);
    }
  });
}

function getMachineDropdownOptions() {
  const out = [];
  for (let i = 0; i < 16; i++) {
    let machineId = 0;
    if (window.kit && Array.isArray(window.kit.machineAssignments)) {
      machineId = window.kit.machineAssignments[i];
    }
    const machineName = machineId
      ? (window.getMachineName ? window.getMachineName(machineId) : `ID#${machineId}`)
      : "EMPTY";
    out.push({
      trackIndex: i,
      machineId,
      label: (i+1) + " - " + machineName
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// Loading‑pulse helper functions
// ───────────────────────────────────────────────────────────────
window._loadingPulseInterval = null;

function startLoadingPulse() {
  const slots = Array.from(document.querySelectorAll(
    '.global-slot, .kit-slot, .song-slot, .pattern-slot'
  ));
  if (!slots.length) return;

  window._loadingPulseInterval = setInterval(() => {
    slots.forEach(el => el.classList.remove('loading-pulse'));
    const picks = Math.ceil(slots.length * 0.1);
    for (let i = 0; i < picks; i++) {
      const idx = Math.floor(Math.random() * slots.length);
      slots[idx].classList.add('loading-pulse');
    }
  }, 200);
}

function stopLoadingPulse() {
  clearInterval(window._loadingPulseInterval);
  window._loadingPulseInterval = null;
  document.querySelectorAll('.loading-pulse')
    .forEach(el => el.classList.remove('loading-pulse'));
  if (!window.hasAnimatedSlots) {
    animateSlotsIntro();
    window.hasAnimatedSlots = true;
  }
}

// kick off random pulses as soon as possible
document.addEventListener('DOMContentLoaded', startLoadingPulse);

// ───────────────────────────────────────────────────────────────
// Idle‑time pre‑initialization of all panels & widgets
// ───────────────────────────────────────────────────────────────
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => {
    document.querySelectorAll('.panel').forEach(panel => {
      if (!panel.dataset.initialized) {
        switch (panel.dataset.panelId) {
          case 'kit':
            buildKitSlotsUI();
            buildKitEditors();
            buildKitNameUI && buildKitNameUI();
            buildTrackOverviewUI && buildTrackOverviewUI();
            buildMasterFxUI && buildMasterFxUI();
            if (typeof buildKnobGrid === 'function') {
              buildKnobGrid("machineParamsUI", window.kit.machineParams, [
                "Param1","Param2","Param3","Param4","Param5","Param6","Param7","Param8"
              ], true);
              buildKnobGrid("trackFxUI", window.kit.trackFx, [
                "AMdep","AMfrq","EQfrq","EQgain","FltBase","FltWidth","FltQ","SRR"
              ], true);
              buildKnobGrid("routingUI", window.kit.routing, [
                "Dist","Vol","Pan","DelSnd","RevSnd","LFOspd","LFOdep","LFOmix"
              ], true);
            }
            break;

          case 'pattern':
            buildPatternSlotsUI();
            buildPatternEditors();
            buildPatternGeneralUI && buildPatternGeneralUI();
            buildLockAndBitfieldUI && buildLockAndBitfieldUI();
            buildTopPatternBanksUI && buildTopPatternBanksUI();
            attachBankSlotClickHandlers && attachBankSlotClickHandlers();
            break;

          case 'song':
            buildSongSlotsUI();
            fillSongUI && fillSongUI();
            break;

          case 'global':
            buildGlobalSlotsUI();
            initGlobalUI && initGlobalUI();
            break;

          case 'uw':
            initUwPanel && initUwPanel();
            break;

          case 'lab':
            initLabPanel && initLabPanel();
            break;

          case 'help':
            break;
        }
        panel.dataset.initialized = 'true';
      }
    });

    initRangeSliders && initRangeSliders();
    populatePatternDropdown && populatePatternDropdown();
    populateMDPositionDropdowns && populateMDPositionDropdowns();

    applyPanelStates && applyPanelStates();

    if (initUI) initUI();
    stopLoadingPulse();
     if (window.mdOSVersion && window.mdOSVersion !== "X") {
     onChangeOSVersion();
  }
  });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    if (initUI) initUI();
    stopLoadingPulse();
  });
}


document.addEventListener("DOMContentLoaded", () => {
  const osSelect = document.getElementById("osVersionSelect");
  let lastOS = window.mdOSVersion;

  osSelect.addEventListener("change", e => {
    const newOS = e.target.value;
    const msg = `Switch OS to ${newOS}? Any existing ${lastOS} MDDT data may be affected, have you exported?`;

    if (!confirm(msg)) {
      e.target.value = lastOS;
      return;
    }

    lastOS = newOS;
    window.onChangeOSVersion();
  });
});
