/* mddt-main.js — unified JSON + SysEx import (full file) */
(() => {

  // Legacy JSON import/export (exportAppStateJSON/doImportJSON) removed —
  // the modal import/export flow in this app is the single source of truth.
  window.cloneData = (obj) => JSON.parse(JSON.stringify(obj));

  window.arrayBufferToBase64 = function (buffer) {
    let binary = "";
    let bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  window.base64ToArrayBuffer = function (base64) {
    let binary = atob(base64);
    let bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  };

  window.mdModel = "MKII";
  window.mdUWEnabled = true;
  window.mdOSVersion = "X";

  window.pattern = {
    patternNumber: 0,
    extendedFlag: false,
    length: 16,
    tempoMult: 0,
    swingAmount: 0,
    assignedKitNumber: 0,
    accentAmount: 0,
    scale: 0,
    trigBitsPerTrack: Array.from({ length: 16 }, () => new Uint8Array(8)),
    accentBitsGlobal: new Uint8Array(8),
    accentBitsPerTrack: Array.from({ length: 16 }, () => new Uint8Array(8)),
    swingBitsGlobal: new Uint8Array(8),
    swingBitsPerTrack: Array.from({ length: 16 }, () => new Uint8Array(8)),
    slideBitsGlobal: new Uint8Array(8),
    slideBitsPerTrack: Array.from({ length: 16 }, () => new Uint8Array(8)),
    accentEditAll: true,
    swingEditAll: true,
    slideEditAll: true,
    trackAccentMasks: Array(16).fill(0),
    trackSlideMasks: Array(16).fill(0),
    trackSwingMasks: Array(16).fill(0),
    locks: [],
    rawPattern: null,
    paramMatrixMain: Array.from({ length: 64 }, () => new Uint8Array(32)),
    paramMatrixExtra: Array.from({ length: 64 }, () => new Uint8Array(32))
  };

  window.currentSong = { rows: [], name: "UNTITLED", slotIndex: 0 };
  window.globalLibrary = [];
  window.allSongSlots = [];
  window.kitLibrary = [];
  window.allPatternSlots = Array(128).fill(null);
  window.patternLibrary = Array(128).fill(null);

  window.FLAG_BITS = {
    clockIn: 0,
    transportIn: 4,
    clockOut: 5,
    transportOut: 6
  };
})();

function buildExportSlotCheckboxes(containerId, libArray, type, slotCount) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (let i = 0; i < slotCount; i++) {
    let slotData = libArray[i];
    if (!slotData) continue;
    if (type === "song" && isSongEmpty(slotData)) continue;

    const label = document.createElement("label");
    label.style.marginRight = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = i.toString();
    cb.checked = true;

    if (type === "global") {
      cb.className = "globalSlotCb";
    } else if (type === "song") {
      cb.className = "songSlotCb";
    } else if (type === "kit") {
      cb.className = "kitSlotCb";
    } else if (type === "pattern") {
      cb.className = "patternSlotCb";
    }

    label.appendChild(cb);

    let slotName = "";
    switch (type) {
      case "global":
      case "song":
      case "kit":
        slotName = `#${i + 1}`;
        break;
      case "pattern":
        slotName =
          typeof window.patternIndexToLabel === "function"
            ? window.patternIndexToLabel(i)
            : `Pattern #${i + 1}`;
        break;
      default:
        slotName = `${type} #${i + 1}`;
    }
    label.appendChild(document.createTextNode(" " + slotName));
    container.appendChild(label);
  }
}

function buildImportSamplesSlotCheckboxes(uwData) {
  const container = document.getElementById("importSamplesSlotCheckboxes");
  if (!container) return;
  container.innerHTML = "";
  const maxSlots = uwData.maxSlots || 48;
  for (let i = 0; i < maxSlots; i++) {
    const slotData = uwData.slots[i];
    if (!slotData) continue;

    const label = document.createElement("label");
    label.style.marginRight = "8px";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = i.toString();
    cb.checked = true;

    label.appendChild(cb);
    const slotName = slotData.name || "----";
    label.appendChild(document.createTextNode(` #${i + 1} (${slotName})`));
    container.appendChild(label);
  }
}

function showExportModal() {
  buildExportSlotCheckboxes("exportGlobalsSlots", window.globalLibrary, "global", 8);
  buildExportSlotCheckboxes("exportSongsSlots", window.allSongSlots, "song", 32);
  buildExportSlotCheckboxes("exportKitsSlots", window.kitLibrary, "kit", 64);
  buildExportSlotCheckboxes("exportPatternsSlots", window.allPatternSlots, "pattern", 128);
  buildExportSampleSlotCheckboxes();
  document.getElementById("exportModal").style.display = "block";
}

function hideExportModal() {
  document.getElementById("exportModal").style.display = "none";
}

function downloadJSON(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function exportCategory(catCheckboxId, selector, library, length, outputKey, obj) {
  if (document.getElementById(catCheckboxId).checked) {
    const cbs = document.querySelectorAll(selector + ":checked");
    const indices = Array.from(cbs).map((cb) => parseInt(cb.value, 10));
    const arr = new Array(length).fill(null);

    indices.forEach((i) => {
      const item = library[i];
      if (!item) return;
      if (library === window.allSongSlots && isSongEmpty(item)) return;
      arr[i] = cloneData(item);
    });

    if (arr.some((x) => x)) {
      obj[outputKey] = arr;
    }
  }
}

function onExportOk() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:]/g, '-');
  const defaultFileName = `MDDT_${timestamp}.mddt`;
  const fileName =
    document.getElementById("exportFilenameInput").value.trim() || defaultFileName;
  const exportObj = {};

  // Export metadata (format/version + context)
  exportObj._format = "MDDT";
  exportObj._version = 1;
  exportObj.mdModel = window.mdModel || null;
  exportObj.mdOSVersion = window.mdOSVersion || null;
  exportObj.mdUWEnabled = (typeof window.mdUWEnabled === "boolean") ? window.mdUWEnabled : null;
  exportObj.createdAt = new Date().toISOString();


  exportCategory(
    "expGlobalsCat",
    "#exportGlobalsSlots .globalSlotCb",
    window.globalLibrary,
    8,
    "globalLibrary",
    exportObj
  );
  exportCategory(
    "expSongsCat",
    "#exportSongsSlots .songSlotCb",
    window.allSongSlots,
    32,
    "allSongSlots",
    exportObj
  );
  exportCategory(
    "expKitsCat",
    "#exportKitsSlots .kitSlotCb",
    window.kitLibrary,
    64,
    "kitLibrary",
    exportObj
  );
  exportCategory(
    "expPatternsCat",
    "#exportPatternsSlots .patternSlotCb",
    window.allPatternSlots,
    128,
    "allPatternSlots",
    exportObj
  );

  const samplesCatCB = document.getElementById("expSamplesCat");
  if (samplesCatCB && samplesCatCB.checked && window.uwSamples?.slots) {
    const cbs = document.querySelectorAll("#exportSamplesSlots .sampleSlotCb:checked");
    if (cbs.length > 0) {
      const maxSlots = window.uwSamples.maxSlots || 48;
      const sampleArray = new Array(maxSlots).fill(null);
      cbs.forEach((cb) => {
        const i = parseInt(cb.value, 10);
        const slotData = window.uwSamples.slots[i];
        if (slotData) {
          const slotClone = cloneData(slotData);

          // If we have raw PCM bytes but no base64 yet, derive it from the *original*
          // slotData, because cloneData(JSON) cannot preserve ArrayBuffers / TypedArrays.
          if (!slotClone.rawPCMBase64) {
            let rawBuf = null;
            const rp = slotData.rawPCM;
            if (rp instanceof ArrayBuffer) {
              rawBuf = rp;
            } else if (ArrayBuffer.isView && ArrayBuffer.isView(rp) && rp.buffer) {
              // Slice to the view's bounds to avoid exporting unrelated bytes.
              rawBuf = rp.buffer.slice(rp.byteOffset, rp.byteOffset + rp.byteLength);
            } else if (Array.isArray(rp)) {
              // Defensive: allow legacy/plain arrays of byte values.
              rawBuf = new Uint8Array(rp).buffer;
            }

            if (rawBuf && rawBuf.byteLength > 0) {
              const b64 = arrayBufferToBase64(rawBuf);
              if (b64 && b64.length) slotClone.rawPCMBase64 = b64;
            }
          }

          // Never export rawPCM (JSON cannot represent it, and it may become {}).
          delete slotClone.rawPCM;

          sampleArray[i] = slotClone;
        }
      });
      if (sampleArray.some((x) => x)) {
        exportObj.uwSamples = {
          model: window.uwSamples.model || "MKII",
          maxSlots: maxSlots,
          slots: sampleArray
        };
      }
    }
  }

  downloadJSON(exportObj, fileName);
  onExportCancel();
}

function onExportCancel() {
  hideExportModal();
  document.getElementById("exportFilenameInput").value = "MachinedrumExport.mddt";
}

function buildExportSampleSlotCheckboxes() {
  const container = document.getElementById("exportSamplesSlots");
  if (!container) return;
  container.innerHTML = "";
  if (!window.uwSamples || !window.uwSamples.slots) return;
  const maxSlots = window.uwSamples.maxSlots || 48;
  for (let i = 0; i < maxSlots; i++) {
    const slotData = window.uwSamples.slots[i];
    if (!slotData) continue;
    const label = document.createElement("label");
    label.style.marginRight = "8px";
    label.style.display = "inline-block";
    label.style.marginBottom = "4px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sampleSlotCb";
    cb.value = i.toString();
    cb.checked = true;
    label.appendChild(cb);
    const slotName = slotData.name || "----";
    label.appendChild(
      document.createTextNode(" Sample #" + (i + 1) + " (" + slotName + ")")
    );
    container.appendChild(label);
  }
}

let pendingFile = null;
let pendingImport = null;

function showImportModal() {
  pendingImport = null;
  pendingFile = null;

  // Ensure the input accepts JSON and SysEx (no need to edit index.html)
  const input = document.getElementById("importFileInput");
  if (input) input.setAttribute("accept", ".json,.mddt,.syx");

  document.getElementById("importFileInput").value = "";
  document.getElementById("importDetails").textContent = "";
  ["importGlobalsSection", "importSongsSection", "importKitsSection", "importPatternsSection", "importSamplesSection"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  ["impGlobals", "impSongs", "impKits", "impPatterns", "impSamples"].forEach((id) => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = false;
  });
  document.getElementById("importModal").style.display = "block";
}

function hideImportModal() {
  document.getElementById("importModal").style.display = "none";
  pendingImport = null;
  pendingFile = null;
}

function onImportCancel() {
  hideImportModal();
  pendingImport = null;
  pendingFile = null;
}

// Unified: JSON or SysEx
function onImportFileChosen(file) {
  if (!file) return;
  pendingFile = file;
  const detailsEl = document.getElementById("importDetails");
  if (detailsEl) detailsEl.textContent = "Selected file: " + file.name;

  // Clear previous checkboxes/sections
  ["importGlobalsSlotCheckboxes", "importSongsSlotCheckboxes", "importKitsSlotCheckboxes", "importPatternsSlotCheckboxes", "importSamplesSlotCheckboxes"].forEach((id) => {
    const c = document.getElementById(id);
    if (c) c.innerHTML = "";
  });
  ["importGlobalsSection", "importSongsSection", "importKitsSection", "importPatternsSection", "importSamplesSection"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  ["impGlobals", "impSongs", "impKits", "impPatterns", "impSamples"].forEach((id) => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = false;
  });

  // Detect SysEx vs JSON using helper from mddt-import-sysex.js
  window.isLikelySysexFile(file).then(async (isSyx) => {
    if (!isSyx) {
      // JSON / MDDT path (original behavior)
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          pendingImport = JSON.parse(e.target.result);

          // Basic format/version sanity (forward-compatible)
          if (pendingImport && pendingImport._format && pendingImport._format !== "MDDT") {
            const ok = confirm(`This file has _format=${pendingImport._format} (expected "MDDT"). Import anyway?`);
            if (!ok) { pendingImport = null; detailsEl.textContent = ""; return; }
          }
          if (pendingImport && typeof pendingImport._version === "number" && pendingImport._version > 1) {
            const ok = confirm(`This file has _version=${pendingImport._version} which is newer than this app expects. Import anyway (best effort)?`);
            if (!ok) { pendingImport = null; detailsEl.textContent = ""; return; }
          }


          if (Array.isArray(pendingImport.globalLibrary)) {
            document.getElementById("importGlobalsSection").style.display = "block";
            document.getElementById("impGlobals").checked = true;
            buildImportSlotCheckboxes("importGlobalsSlotCheckboxes", pendingImport.globalLibrary, "global");
          }
          if (Array.isArray(pendingImport.allSongSlots)) {
            document.getElementById("importSongsSection").style.display = "block";
            document.getElementById("impSongs").checked = true;
            buildImportSlotCheckboxes("importSongsSlotCheckboxes", pendingImport.allSongSlots, "song");
          }
          if (Array.isArray(pendingImport.kitLibrary)) {
            document.getElementById("importKitsSection").style.display = "block";
            document.getElementById("impKits").checked = true;
            buildImportSlotCheckboxes("importKitsSlotCheckboxes", pendingImport.kitLibrary, "kit");
          }
          if (Array.isArray(pendingImport.allPatternSlots)) {
            document.getElementById("importPatternsSection").style.display = "block";
            document.getElementById("impPatterns").checked = true;
            buildImportSlotCheckboxes("importPatternsSlotCheckboxes", pendingImport.allPatternSlots, "pattern");
          }
          if (pendingImport.uwSamples && Array.isArray(pendingImport.uwSamples.slots)) {
            document.getElementById("importSamplesSection").style.display = "block";
            document.getElementById("impSamples").checked = true;
            buildImportSamplesSlotCheckboxes(pendingImport.uwSamples);
          }

          const parts = [];
          if (pendingImport.globalLibrary) parts.push(`${countPopulated(pendingImport.globalLibrary)} Global(s)`);
          if (pendingImport.kitLibrary) parts.push(`${countPopulated(pendingImport.kitLibrary)} Kit(s)`);
          if (pendingImport.allPatternSlots) parts.push(`${countPopulated(pendingImport.allPatternSlots)} Pattern(s)`);
          if (pendingImport.allSongSlots) parts.push(`${countPopulated(pendingImport.allSongSlots)} Song(s)`);
          if (pendingImport.uwSamples?.slots) parts.push(`${countPopulated(pendingImport.uwSamples.slots)} Sample(s)`);
          detailsEl.textContent = parts.length ? "File contains: " + parts.join(", ") : "No recognized data in file.";
        } catch (err) {
          alert("Not valid JSON: " + err);
          pendingImport = null;
          detailsEl.textContent = "";
        }
      };
      reader.readAsText(file);
      return;
    }

    // SysEx path: scan & present the same checkbox UI
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const scan = window.scanSysexBytes(bytes);

    // Create placeholder arrays so we can reuse buildImportSlotCheckboxes
    const globalsArr  = new Array(8).fill(null);
    const kitsArr     = new Array(64).fill(null);
    const patternsArr = new Array(128).fill(null);
    const songsArr    = new Array(32).fill(null);

    scan.globals.forEach(i => { globalsArr[i] = { fromSyx: true }; });
    scan.kits.forEach(i => { kitsArr[i] = { fromSyx: true }; });
    scan.patterns.forEach(i => { patternsArr[i] = { fromSyx: true }; });
    scan.songs.forEach(i => { songsArr[i] = { fromSyx: true }; });

    // Mark that pendingImport comes from syx
    pendingImport = { __source: "syx", scan };

    if (scan.globals.length) {
      document.getElementById("importGlobalsSection").style.display = "block";
      document.getElementById("impGlobals").checked = true;
      buildImportSlotCheckboxes("importGlobalsSlotCheckboxes", globalsArr, "global");
    }
    if (scan.kits.length) {
      document.getElementById("importKitsSection").style.display = "block";
      document.getElementById("impKits").checked = true;
      buildImportSlotCheckboxes("importKitsSlotCheckboxes", kitsArr, "kit");
    }
    if (scan.patterns.length) {
      document.getElementById("importPatternsSection").style.display = "block";
      document.getElementById("impPatterns").checked = true;
      buildImportSlotCheckboxes("importPatternsSlotCheckboxes", patternsArr, "pattern");
    }
    if (scan.songs.length) {
      document.getElementById("importSongsSection").style.display = "block";
      document.getElementById("impSongs").checked = true;
      buildImportSlotCheckboxes("importSongsSlotCheckboxes", songsArr, "song");
    }

    const info = [];
    if (scan.globals.length)  info.push(`${scan.globals.length} Global(s)`);
    if (scan.kits.length)     info.push(`${scan.kits.length} Kit(s)`);
    if (scan.patterns.length) info.push(`${scan.patterns.length} Pattern(s)`);
    if (scan.songs.length)    info.push(`${scan.songs.length} Song(s)`);
    detailsEl.textContent = info.length ? "File contains: " + info.join(", ") : "No recognized SysEx messages in file.";
  }).catch(err => {
    console.error("Import detection failed:", err);
    alert("Could not read file.");
    pendingImport = null;
  });
}

function buildImportSlotCheckboxes(containerId, libArray, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  libArray.forEach((slotData, i) => {
    if (!slotData) return;
    const label = document.createElement("label");
    label.style.marginRight = "8px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = i.toString();
    cb.checked = true;
    label.appendChild(cb);
    let slotName = "";
    switch (type) {
      case "global":
      case "song":
      case "kit":
        slotName = `#${i + 1}`;
        break;
      case "pattern":
        slotName =
          typeof window.patternIndexToLabel === "function"
            ? window.patternIndexToLabel(i)
            : `Pattern #${i + 1}`;
        break;
      default:
        slotName = `${type} #${i + 1}`;
    }
    label.appendChild(document.createTextNode(" " + slotName));
    container.appendChild(label);
  });
}

function buildImportSamplesSlotCheckboxes(uwData) {
  const container = document.getElementById("importSamplesSlotCheckboxes");
  if (!container) return;
  container.innerHTML = "";
  container.style.display = "flex";
  container.style.flexWrap = "wrap";
  const maxSlots = uwData.maxSlots || 48;
  for (let i = 0; i < maxSlots; i++) {
    const slotData = uwData.slots[i];
    if (!slotData) continue;
    const label = document.createElement("label");
    label.style.marginRight = "8px";
    label.style.display = "inline-block";
    label.style.marginBottom = "4px";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = i.toString();
    cb.checked = true;
    label.appendChild(cb);
    const shortName = slotData.name || "----";
    label.appendChild(document.createTextNode(` #${i + 1} (${shortName})`));
    container.appendChild(label);
  }
}

function selectAllSlotsWithin(containerSelector, checked) {
  document
    .querySelectorAll(containerSelector + " input[type='checkbox']")
    .forEach((cb) => {
      cb.checked = checked;
    });
}

function countPopulated(arr) {
  return Array.isArray(arr) ? arr.filter((x) => x).length : 0;
}

function importCategory(importCheckboxId, containerSelector, sourceArray, targetArray) {
  if (document.getElementById(importCheckboxId).checked && Array.isArray(sourceArray)) {
    document
      .querySelectorAll(containerSelector + " input[type='checkbox']:checked")
      .forEach((cb) => {
        const idx = parseInt(cb.value, 10);
        if (sourceArray[idx]) {
          // Global slots carry typed arrays (keymap). Use the dedicated commit helper
          // to normalise + avoid false dirty indicators after import.
          if (targetArray === window.globalLibrary && typeof window.commitGlobalSlot === "function") {
            window.commitGlobalSlot(idx, sourceArray[idx], { silent: true });
          } else {
            targetArray[idx] = cloneData(sourceArray[idx]);
            try {
              if (targetArray === window.globalLibrary && window.MDDT?.util?.normalizeGlobalObject) {
                window.MDDT.util.normalizeGlobalObject(targetArray[idx], idx);
              }
            } catch (_) {}
          }
        }
      });
  }
}

// Unified OK handler: JSON (existing) + SysEx (new)
function onImportOk() {
  if (!pendingImport) {
    alert("No file data available to import. Please choose a file first.");
    return;
  }

  // ───── SysEx branch ────────────────────────────────────────────────────────
  if (pendingImport.__source === "syx" && pendingFile) {
    const selected = (sel) =>
      Array.from(document.querySelectorAll(sel + " input[type='checkbox']:checked"))
        .map(cb => parseInt(cb.value, 10));

    const onlyGlobals  = document.getElementById("impGlobals").checked  ? selected("#importGlobalsSlotCheckboxes")  : [];
    const onlyKits     = document.getElementById("impKits").checked     ? selected("#importKitsSlotCheckboxes")     : [];
    const onlyPatterns = document.getElementById("impPatterns").checked ? selected("#importPatternsSlotCheckboxes") : [];
    const onlySongs    = document.getElementById("impSongs").checked    ? selected("#importSongsSlotCheckboxes")    : [];

    // Snapshot current editor buffers so file import does NOT "load" the last decoded
    // kit/pattern/global/song into the editors. Import should only populate slot storage.
    const deepClone = (val) => {
      try {
        if (window.MDDT?.util?.deepClonePreserveTypedArrays) return window.MDDT.util.deepClonePreserveTypedArrays(val);
        if (typeof structuredClone === "function") return structuredClone(val);
        return JSON.parse(JSON.stringify(val));
      } catch (_) {
        return val;
      }
    };

    const preImportState = {
      kit: deepClone(window.kit),
      pattern: deepClone(window.pattern),
      globalData: deepClone(window.globalData),
      currentSong: deepClone(window.currentSong),
      currentBaseChannel: window.currentBaseChannel,
    };

    window.importSysexFile(pendingFile, {
      overwriteGlobals: true,
      overwriteKits: true,
      overwritePatterns: true,
      overwriteSongs: true,
      onlyGlobals,
      onlyKits,
      onlyPatterns,
      onlySongs,
      // Prevent the importer from triggering UI refreshes or auto-selecting slots.
      silentUI: true,
    }).then((summary) => {
      // Restore editor buffers + clear slot selections.
      try { window.kit = preImportState.kit; } catch (_) {}
      try { window.pattern = preImportState.pattern; } catch (_) {}
      try { window.globalData = preImportState.globalData; } catch (_) {}
      try { window.currentSong = preImportState.currentSong; } catch (_) {}
      try { window.currentBaseChannel = preImportState.currentBaseChannel; } catch (_) {}

      window.selectedPatternSlotIndex = -1;
      window.selectedSongSlotIndex = -1;
      window.selectedKitSlotIndex = -1;
      window.selectedGlobalSlotIndex = -1;

      hideImportModal();
      if (typeof window.initUI === "function") window.initUI();

      // Clear any slot number displays so nothing appears "loaded" until the user clicks a slot.
      ["kitNumberDisplay", "songNumberDisplay", "globalNumberDisplay"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "";
      });

      console.log("SysEx import complete:", summary);
      document.querySelectorAll('.panel').forEach(panel => { delete panel.dataset.initialized; });
    }).catch((err) => {
      console.error("SysEx import failed:", err);
      alert("SysEx import failed");
    }).finally(() => {
      pendingImport = null;
      pendingFile = null;
    });
    return; // do not run JSON path
  }
  // ───── End SysEx branch ────────────────────────────────────────────────────

  // JSON path (existing behavior)
  importCategory(
    "impGlobals",
    "#importGlobalsSlotCheckboxes",
    pendingImport.globalLibrary,
    window.globalLibrary
  );
  importCategory(
    "impSongs",
    "#importSongsSlotCheckboxes",
    pendingImport.allSongSlots,
    window.allSongSlots
  );
  importCategory(
    "impKits",
    "#importKitsSlotCheckboxes",
    pendingImport.kitLibrary,
    window.kitLibrary
  );
  importCategory(
    "impPatterns",
    "#importPatternsSlotCheckboxes",
    pendingImport.allPatternSlots,
    window.allPatternSlots
  );

  const impSamplesCheckbox = document.getElementById("impSamples");
  if (
    impSamplesCheckbox &&
    impSamplesCheckbox.checked &&
    pendingImport.uwSamples &&
    Array.isArray(pendingImport.uwSamples.slots)
  ) {
    const cbs = document.querySelectorAll(
      "#importSamplesSlotCheckboxes input[type='checkbox']:checked"
    );
    const maxSlots = pendingImport.uwSamples.maxSlots || 48;
    if (!window.uwSamples) {
      window.uwSamples = {
        model: "MKII",
        maxSlots: maxSlots,
        slots: Array(maxSlots).fill(null)
      };
    } else if (maxSlots > window.uwSamples.maxSlots) {
      window.uwSamples.slots.length = maxSlots;
      window.uwSamples.maxSlots = maxSlots;
    }
    window.uwSamples.model = pendingImport.uwSamples.model || "MKII";
    cbs.forEach((cb) => {
      const i = parseInt(cb.value, 10);
      const slotData = pendingImport.uwSamples.slots[i];
      if (slotData) {
        let rawData = null;
        if (slotData.rawPCMBase64) {
          rawData = base64ToArrayBuffer(slotData.rawPCMBase64);
          if (!slotData.numSamples || slotData.numSamples <= 0) {
            slotData.numSamples = new Int16Array(rawData).length;
          }
        }
        let cloned = cloneData(slotData);
        cloned.rawPCM = rawData;
        window.uwSamples.slots[i] = cloned;
      }
    });
  }

  window.selectedPatternSlotIndex = -1;
  window.selectedSongSlotIndex = -1;
  window.selectedKitSlotIndex = -1;
  window.selectedGlobalSlotIndex = -1;

  hideImportModal();
  if (typeof window.initUI === "function") window.initUI();

  console.log("Import complete.");
  pendingImport = null;
  pendingFile = null;

  document.querySelectorAll('.panel').forEach(panel => {
    delete panel.dataset.initialized;
  });
}

(() => {
  function saveSystemSettings() {
    const ss = (typeof window.safeStorageSet === "function")
      ? window.safeStorageSet
      : (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

    ss(
      "mdModel",
      document.getElementById("mdModelSelect").value
    );
    ss(
      "uwEnabled",
      document.getElementById("uwToggleCheckbox").checked ? "true" : "false"
    );
  }
  function loadSystemSettings() {
    const sg = (typeof window.safeStorageGet === "function")
      ? window.safeStorageGet
      : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

    const model = sg("mdModel");
    if (model) {
      document.getElementById("mdModelSelect").value = model;
      window.mdModel = model;
    }
    const uwEnabled = sg("uwEnabled");
    if (uwEnabled !== null) {
      document.getElementById("uwToggleCheckbox").checked = uwEnabled === "true";
      window.mdUWEnabled = uwEnabled === "true";
    }
    const saved = sg("mdOSVersion");
    if (saved) {
      window.mdOSVersion = saved;
      document.getElementById("osVersionSelect").value = saved;
    }
  }
  document
    .getElementById("mdModelSelect")
    .addEventListener("change", saveSystemSettings);
  document
    .getElementById("uwToggleCheckbox")
    .addEventListener("change", saveSystemSettings);
  loadSystemSettings();
  document.addEventListener("DOMContentLoaded", onChangeOSVersion);
})();


function onClickResetMDDT() {
  if (!confirm("Reset all MDDT data? This cannot be undone.")) {
    return;
  }

  // Clear persisted settings + presets. Use safe wrappers so we don't
  // crash in privacy-restricted contexts.
  const rm = (typeof window.safeStorageRemove === "function")
    ? window.safeStorageRemove
    : (k) => { try { localStorage.removeItem(k); } catch (_) {} };
  const keys = (typeof window.safeStorageKeys === "function")
    ? window.safeStorageKeys()
    : (() => { try { return Object.keys(localStorage); } catch (_) { return []; } })();

  // Known single keys
  [
    "midiInId",
    "midiOutId",
    "mddt:lastMidiPorts:v1",
    "turboPreferred",
    "mdModel",
    "uwEnabled",
    "mdOSVersion",
    "darkMode",
    "customScalePresets",
    "mddt.normalise.presets.v1",
    "skewclidUiScale",
    "euclidPresetsV2",
    "toneLatest",
    "mddtDebug",
    "ccLinkEnabled"
  ].forEach(rm);

  // Prefix keys (lab sliders, etc.)
  keys.forEach((k) => {
    if (typeof k !== "string") return;
    if (k.startsWith("labSlider:")) rm(k);
  });

  // Reset ephemeral in-memory libraries too (purely defensive; we reload anyway).
  try {
    window.kitLibrary = new Array(64).fill(null);
    window.patternLibrary = new Array(128).fill(null);
    window.globalLibrary = new Array(8).fill(null);
    window.allSongSlots = new Array(32).fill(null);
    window.allPatternSlots = new Array(128).fill(null);
  } catch (_) {}

  location.reload();
}
