// midi.js

(() => {
  // Expose key references
  window.selectedMidiIn = null;
  window.selectedMidiOut = null;

  // One-shot persistence suppression (used when we fall back because saved ports are missing)
  window.__mddtSuppressStoreOnceIn = false;
  window.__mddtSuppressStoreOnceOut = false;

  // -------------------------------------------------------------------------
  // Persist last-used MIDI ports (robust)
  // -------------------------------------------------------------------------
  // WebMIDI port.id is not guaranteed stable across browser restarts.
  // Store both id + human readable identifiers and fall back to name matching.
  const MIDI_PORT_PREFS_KEY = "mddt:lastMidiPorts:v1";

  function __safeJSONParse(str){
    try { return JSON.parse(str); } catch(_) { return null; }
  }

  function loadMidiPortPrefs(){
    try{
      const sg = (typeof window.safeStorageGet === "function")
        ? window.safeStorageGet
        : (k) => { try { return localStorage.getItem(k); } catch(_) { return null; } };
      const raw = sg(MIDI_PORT_PREFS_KEY);
      return raw ? (__safeJSONParse(raw) || null) : null;
    }catch(_){ return null; }
  }

  function saveMidiPortPrefs(midiIn, midiOut){
    try{
      const ss = (typeof window.safeStorageSet === "function")
        ? window.safeStorageSet
        : (k, v) => { try { localStorage.setItem(k, v); } catch(_) {} };

      // Merge with previous prefs so we don't accidentally wipe one side
      // (e.g. if an input temporarily disconnects).
      const prev = loadMidiPortPrefs() || {};

      const prefs = {
        in:  prev.in || null,
        out: prev.out || null,
        savedAt: Date.now()
      };

      if (midiIn) {
        prefs.in = {
          id: midiIn.id || null,
          name: midiIn.name || null,
          manufacturer: midiIn.manufacturer || null
        };
      }

      if (midiOut) {
        prefs.out = {
          id: midiOut.id || null,
          name: midiOut.name || null,
          manufacturer: midiOut.manufacturer || null
        };
      }

      ss(MIDI_PORT_PREFS_KEY, JSON.stringify(prefs));
    }catch(_){}
  }

  function matchPortByPrefs(portsArray, pref){
    if (!pref || !portsArray || !portsArray.length) return null;

    // 1) Try id first (best when available)
    if (pref.id){
      const hit = portsArray.find(p => p && p.id === pref.id);
      if (hit) return hit;
    }

    // 2) Try exact name + manufacturer match
    const wantName = String(pref.name || "").trim().toLowerCase();
    const wantManu = String(pref.manufacturer || "").trim().toLowerCase();
    if (wantName){
      let hit = portsArray.find(p => {
        const n = String(p?.name || "").trim().toLowerCase();
        const m = String(p?.manufacturer || "").trim().toLowerCase();
        return n === wantName && (!!wantManu ? (m === wantManu) : true);
      });
      if (hit) return hit;

      // 3) Fallback: name-only match
      hit = portsArray.find(p => String(p?.name || "").trim().toLowerCase() === wantName);
      if (hit) return hit;
    }

    return null;
  }


  function updateMidiStatusUI(state = {}) {
    const el = document.getElementById("midiStatusText");
    if (!el) return;

    const inName = window.selectedMidiIn?.name || "None";
    const outName = window.selectedMidiOut?.name || "None";
    const ready = !!(window.selectedMidiIn && window.selectedMidiOut);

    // Allow callers to force an error / warning message
    if (state.error) {
      el.textContent = state.error;
      el.classList.remove("ok");
      el.classList.add("err");
      el.classList.remove("warn");
      el.title = state.error;
      return;
    }

    // Explicit warning takes priority (used when saved prefs are missing and we fall back).
    if (state.warning) {
      el.textContent = state.warning;
      el.classList.remove("ok");
      el.classList.remove("err");
      el.classList.add("warn");
      el.title = ready ? `In: ${inName} · Out: ${outName}` : state.warning;
      return;
    }

    // If a message is provided, show it as a non-blocking warning/info state.
    if (state.message) {
      el.textContent = state.message;
      el.classList.remove("ok");
      el.classList.remove("err");
      el.classList.add("warn");
      el.title = ready ? `In: ${inName} · Out: ${outName}` : state.message;
      return;
    }

    if (!ready) {
      el.textContent = "Select MIDI In/Out";
      el.classList.remove("ok");
      el.classList.remove("err");
      el.classList.add("warn");
      el.title = "Select your Machinedrum (or MIDI interface) and click Init / Refresh MIDI.";
      return;
    }

    el.textContent = "Ready";
    el.classList.remove("warn");
    el.classList.remove("err");
    el.classList.add("ok");
    el.title = `In: ${inName} · Out: ${outName}`;
  }

  window.selectedKitSlotIndex = -1;
  window.selectedPatternSlotIndex = -1;
  window.selectedSongSlotIndex = -1;
  window.selectedGlobalSlotIndex = -1;

  window.midiOperationState = {
    inboundMode: "idle",
    outboundMode: "idle",
    ignoreAllIncoming: false
  };

  // Bulk & Send-All state
  let bulkGlobalIndex = 0,
      bulkSongIndex = 0,
      bulkKitIndex = 0,
      bulkPatternIndex = 0,
      isBulkInProgress = false,
      requestingGlobals = false,
      requestingSongs = false,
      requestingKits = false,
      requestingPatterns = false,
      isSendAllInProgress = false;

  // Track if turbo is active in our UI (optional status)
  window.turboActive = false;
  window.turboSpeedFactor = "x1.00";

  // Utility to ensure we have arrays for all MD data
  window.initSlots = function () {
    if (!window.globalLibrary) window.globalLibrary = new Array(8).fill(null);
    if (!window.allSongSlots) window.allSongSlots = new Array(32).fill(null);
    if (!window.kitLibrary) window.kitLibrary = new Array(64).fill(null);
    if (!window.allPatternSlots) window.allPatternSlots = new Array(128).fill(null);
  };

  // ---------------------------------------------
  //  1) Initialize Web MIDI
  // ---------------------------------------------
  // machinedrum-midi.js

// Initialize WebMIDI
let __midiInitPromise = null;
let __midiInitSilent = true;

window.initWebMIDI = (opts = {}) => {
  const silent = !!opts.silent;

  if (!navigator.requestMIDIAccess) {
    const msg = "WebMIDI not supported in this browser.";
    updateMidiStatusUI({ error: msg });
    if (!silent) alert(msg);
    else console.warn(msg);
    return Promise.resolve(null);
  }

  // Prevent parallel init calls (avoids double permission prompts).
  if (__midiInitPromise) {
    // If any caller is non-silent, treat the whole attempt as non-silent.
    __midiInitSilent = __midiInitSilent && silent;
    return __midiInitPromise;
  }

  __midiInitSilent = silent;
  updateMidiStatusUI({ message: "Initializing…" });

  __midiInitPromise = navigator.requestMIDIAccess({ sysex: true })
    .then((midiAccess) => {
      onMIDISuccess(midiAccess);
      return midiAccess;
    })
    .catch((err) => {
      onMIDIFailure(err, { silent: __midiInitSilent });
      throw err;
    })
    .finally(() => {
      __midiInitPromise = null;
      __midiInitSilent = true;
    });

  return __midiInitPromise;
};

// Auto-init on load (silent: true)
try {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      try { window.initWebMIDI({ silent: true }); } catch (_) {}
    }, { once: true });
  } else {
    setTimeout(() => { try { window.initWebMIDI({ silent: true }); } catch (_) {} }, 0);
  }
} catch(_) {}

// Called when MIDI is ready
function onMIDISuccess(midiAccess) {
  window.midiAccess = midiAccess;
  const inSel  = document.getElementById("midiInSelect"),
        outSel = document.getElementById("midiOutSelect");

  // Robustness: if the MIDI modal/UI isn't mounted yet (or IDs changed),
  // don't throw and break the whole app.
  if (!inSel || !outSel) {
    console.warn("[MIDI] Missing #midiInSelect / #midiOutSelect in DOM");
    updateMidiStatusUI({ error: "MIDI UI missing" });
    return;
  }


  // Keep TurboMIDI manager in sync with the currently selected MIDI ports.
  // Sample transfers + bulk dumps rely on accurate turbo pacing and (when Turbo is on)
  // an Active Sensing keepalive to avoid silent speed fallback.
  function maybeInitTurboPacer() {
    try {
      if (typeof window.setTurboPorts === "function") {
        window.setTurboPorts(window.selectedMidiIn || null, window.selectedMidiOut || null);
      }
    } catch (e) {
      console.warn("[MIDI] Turbo port init failed", e);
    }
  }

  // Clear old options
  inSel.innerHTML  = "";
  outSel.innerHTML = "";

  const inputs  = Array.from(midiAccess.inputs.values());
  const outputs = Array.from(midiAccess.outputs.values());

  // Populate MIDI Input dropdown
  inputs.forEach(input => {
    inSel.appendChild(window.createOption(input.id, input.name || input.id));
  });

  // Populate MIDI Output dropdown
  outputs.forEach(output => {
    outSel.appendChild(window.createOption(output.id, output.name || output.id));
  });

  // When user changes In device, store it and hook messages
  inSel.onchange = () => {
    const id = inSel.value;
    const nextIn = midiAccess.inputs.get(id) || null;

    // Unhook previous input so we don't accidentally process messages from
    // multiple devices after switching the dropdown.
    if (window.selectedMidiIn && window.selectedMidiIn !== nextIn) {
      try { window.selectedMidiIn.onmidimessage = null; } catch (_) {}
    }

    window.selectedMidiIn = nextIn;
    if (window.selectedMidiIn) window.selectedMidiIn.onmidimessage = handleMIDIMessage;

    // Persist selection (robust prefs + legacy IDs)
    try {
      const suppressIn  = !!window.__mddtSuppressStoreOnceIn;
      const suppressOut = !!window.__mddtSuppressStoreOnceOut;

      if (!suppressIn && nextIn) {
        if (typeof window.safeStorageSet === "function") window.safeStorageSet("midiInId", id);
        else { try { localStorage.setItem("midiInId", id); } catch (_) {} }
      }

      if (!suppressIn && (window.selectedMidiIn || window.selectedMidiOut)) {
        const inToSave  = window.selectedMidiIn;
        const outToSave = suppressOut ? null : window.selectedMidiOut;
        saveMidiPortPrefs(inToSave, outToSave);
      }
    } catch (_) {}

    updateMidiStatusUI();
    maybeInitTurboPacer();
  };

  // When user changes Out device, store it
  outSel.onchange = () => {
    const id = outSel.value;
    const nextOut = midiAccess.outputs.get(id) || null;

    window.selectedMidiOut = nextOut;

    // Persist selection (robust prefs + legacy IDs)
    try {
      const suppressIn  = !!window.__mddtSuppressStoreOnceIn;
      const suppressOut = !!window.__mddtSuppressStoreOnceOut;

      if (!suppressOut && nextOut) {
        if (typeof window.safeStorageSet === "function") window.safeStorageSet("midiOutId", id);
        else { try { localStorage.setItem("midiOutId", id); } catch (_) {} }
      }

      if (!suppressOut && (window.selectedMidiIn || window.selectedMidiOut)) {
        const inToSave  = suppressIn ? null : window.selectedMidiIn;
        const outToSave = window.selectedMidiOut;
        saveMidiPortPrefs(inToSave, outToSave);
      }
    } catch (_) {}

    updateMidiStatusUI();
    maybeInitTurboPacer();
  };

  // Restore saved selection or default to first (robust prefs + legacy)
  const sg = (typeof window.safeStorageGet === "function")
    ? window.safeStorageGet
    : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

  const prefs = loadMidiPortPrefs();
  const savedIn  = sg("midiInId");
  const savedOut = sg("midiOutId");

  const hasOpt = (sel, id) => !!(id && [...sel.options].some(o => o.value === id));

  // Prefer saved prefs first (so hot-plug returns to the user's real preferred device),
  // then keep the current selection, then fall back to the first available port.
  const prefInHit   = (prefs && prefs.in)  ? matchPortByPrefs(inputs,  prefs.in)  : null;
  const legacyInHit = (!prefInHit && savedIn)  ? (midiAccess.inputs.get(savedIn)  || null) : null;
  const savedInHit  = prefInHit || legacyInHit;

  const prefOutHit   = (prefs && prefs.out) ? matchPortByPrefs(outputs, prefs.out) : null;
  const legacyOutHit = (!prefOutHit && savedOut) ? (midiAccess.outputs.get(savedOut) || null) : null;
  const savedOutHit  = prefOutHit || legacyOutHit;

  const hadSavedInPref  = !!(savedIn  || (prefs && prefs.in  && (prefs.in.id  || prefs.in.name)));
  const hadSavedOutPref = !!(savedOut || (prefs && prefs.out && (prefs.out.id || prefs.out.name)));

  const currentInHit = (!savedInHit && window.selectedMidiIn && hasOpt(inSel, window.selectedMidiIn.id))
    ? window.selectedMidiIn
    : null;
  const currentOutHit = (!savedOutHit && window.selectedMidiOut && hasOpt(outSel, window.selectedMidiOut.id))
    ? window.selectedMidiOut
    : null;

  const firstIn  = (!savedInHit  && !currentInHit  && inputs.length)  ? inputs[0]  : null;
  const firstOut = (!savedOutHit && !currentOutHit && outputs.length) ? outputs[0] : null;

  const useIn  = savedInHit  || currentInHit  || firstIn  || null;
  const useOut = savedOutHit || currentOutHit || firstOut || null;

  const fellBackIn  = hadSavedInPref  && !savedInHit  && !!useIn;
  const fellBackOut = hadSavedOutPref && !savedOutHit && !!useOut;

  // When a saved preferred device is missing, we may fall back to another port, but we must
  // NOT overwrite the stored preference (so it can be restored when the device returns).
  window.__mddtSuppressStoreOnceIn  = !!fellBackIn;
  window.__mddtSuppressStoreOnceOut = !!fellBackOut;

  if (useIn) inSel.value = useIn.id;
  if (inSel.options.length) inSel.onchange();

  if (useOut) outSel.value = useOut.id;
  if (outSel.options.length) outSel.onchange();

  const warnFallback = (fellBackIn || fellBackOut);
  if (warnFallback) {
    updateMidiStatusUI({ warning: "Saved MIDI input/output port not found — using fallback…" });
  } else {
    updateMidiStatusUI();
  }

  // Clear suppression flags once initial selection is applied.
  window.__mddtSuppressStoreOnceIn = false;
  window.__mddtSuppressStoreOnceOut = false;

  try { window.maybeSyncTurbo && window.maybeSyncTurbo(); } catch(_) {}

  // Auto-refresh dropdowns when devices connect/disconnect.
  // (Keeps localStorage-backed selection where possible.)
  try {
    midiAccess.onstatechange = () => {
      try { onMIDISuccess(midiAccess); } catch (e) {
        console.warn("[MIDI] Failed to refresh device lists", e);
      }
    };
  } catch (_) {}
}

  function onMIDIFailure(err, { silent = false } = {}) {
    const msg = "Could not access MIDI: " + err;
    updateMidiStatusUI({ error: "MIDI unavailable" });
    if (!silent) alert(msg);
    else console.warn(msg);
  }

  // ---------------------------------------------
  //  2) Main MIDI Message Handler
  // ---------------------------------------------
  function handleMIDIMessage(ev) {
    // If a bulk operation was canceled, ignore
    if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
      console.log("handleMIDIMessage: Abort detected at entry.");
      return;
    }

    // PERF/ROBUSTNESS (Turbo/SDS):
    // Avoid copying every inbound MIDI message into a plain Array.
    // At higher Turbo factors, allocating many arrays can create GC jitter,
    // which in turn can delay SDS ACKs and increase truncation risk.
    // Most of the MDDT pipeline works fine with Uint8Array; downstream code
    // that truly needs a plain Array already normalizes internally.
    const arr = (ev && ev.data)
      ? (ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data))
      : new Uint8Array();

    // IMPORTANT (Turbo/SDS robustness):
    // MIDI real-time messages (Clock 0xF8, Active Sense 0xFE, etc.) are allowed
    // to occur "anywhere" on the wire, including interleaved with SysEx byte
    // streams. At Turbo speeds, some OS/browser stacks may deliver these bytes
    // coalesced with adjacent SysEx fragments.
    //
    // Do NOT drop an entire incoming chunk just because it begins with a
    // real-time byte, or we can lose SysEx bytes and corrupt SDS transfers.
    // Only ignore pure single-byte real-time messages.
    if (arr.length === 1 && (arr[0] === 0xF8 || arr[0] === 0xFE)) return;

    // If ignoring inbound (during Send All), allow inbound CC but ignore dumps
    if (window.midiOperationState.ignoreAllIncoming) {
      // Accept inbound CC even in ignore mode
      if (arr.length === 3 && (arr[0] & 0xF0) === 0xB0) {
        handleInboundCC(arr);
      }
      return;
    }

    // Check for inbound CC
    if (arr.length === 3 && (arr[0] & 0xF0) === 0xB0) {
      handleInboundCC(arr);
      return;
    }

    // Pass to UW sample manager if present.
    // Provide a high-resolution receive timestamp when available so the UW
    // SDS engine can instrument ACK turnaround (helps diagnose Turbo pacing).
    if (typeof onMidiMessageUW === "function") {
      const rxTime = (typeof ev?.receivedTime === "number")
        ? ev.receivedTime
        : (typeof ev?.timeStamp === "number")
          ? ev.timeStamp
          : (typeof performance !== "undefined" && typeof performance.now === "function")
            ? performance.now()
            : Date.now();
      onMidiMessageUW(arr, rxTime);
    }

    // Universal SysEx (0x7E...) is used by SDS (UW sample transfer).
    // Never treat these packets as Machinedrum dumps.
    if (arr[0] === 0xF0 && arr.length >= 2 && arr[1] === 0x7E) {
      return;
    }

    // If UW has exclusive SysEx control, ignore other handlers
    if (window.ignoreNonSampleManagerSysex && arr[0] === 0xF0) {
      return;
    }

    // Check for Machinedrum SysEx (must match Elektron/Machinedrum header)
    if (arr[0] === 0xF0 && arr[arr.length - 1] === 0xF7) {
      const mdHeader = window.MD_SYSEX_HEADER || [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];
      let isMd = true;
      if (arr.length < mdHeader.length + 1) {
        isMd = false;
      } else {
        for (let i = 0; i < mdHeader.length; i++) {
          if (arr[i] !== mdHeader[i]) { isMd = false; break; }
        }
      }
      if (!isMd) {
        return;
      }

      // If slot writes are blocked (UW ops), ignore Machinedrum dumps here.
      // (UW's own handler has already seen the packet above.)
      if (window.blockSlotWrites) {
        return;
      }

      const messageId = arr[6];

      if (messageId === window.MD_GLOBAL_MESSAGE_ID) {
        // Global dump
        if (window.blockSlotWrites) return;
        window.receiveGlobalDump(arr.slice(7, -1));

        if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
          console.log("Aborted after global dump received.");
          requestingGlobals = false;
          isBulkInProgress = false;
          return;
        }
        if (isBulkInProgress && requestingGlobals) {
                    if (typeof window.commitGlobalSlot === "function") {
            window.commitGlobalSlot(bulkGlobalIndex, window.globalData, { silent: true });
          } else {
            window.globalLibrary[bulkGlobalIndex] = JSON.parse(JSON.stringify(window.globalData));
          }
          if (window.buildGlobalSlotsUI) window.buildGlobalSlotsUI();
          bulkGlobalIndex++;
          if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
            console.log("Aborted before scheduling next global request.");
            return;
          }
          if (bulkGlobalIndex < 8) {
            requestOneGlobal(bulkGlobalIndex);
          } else {
            requestingGlobals = false;
            requestingSongs = true;
            bulkSongIndex = 0;
            if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
              console.log("Aborted before scheduling first song request.");
              return;
            }
            requestOneSong(bulkSongIndex);
          }
        } else {
          // Single global dump
          const singleSlot = (window.globalData && typeof window.globalData.globalPosition === "number")
            ? window.globalData.globalPosition
            : 0;
                    if (typeof window.commitGlobalSlot === "function") {
            window.commitGlobalSlot(singleSlot, window.globalData, { silent: true });
          } else {
            window.globalLibrary[singleSlot] = JSON.parse(JSON.stringify(window.globalData));
          }
          if (window.buildGlobalSlotsUI) window.buildGlobalSlotsUI();
        }
      }
      else if (messageId === window.MD_SONG_MESSAGE_ID) {
        // Song dump
        if (window.blockSlotWrites) return;
        window.currentSong.rawSong = new Uint8Array(arr);
        window.receiveSongDump(arr.slice(6), window.currentSong);
        const pos = arr[9] & 0x1F;
        if (window.pendingSongDump && window.pendingSongDump.slot === pos) {
          window.pendingSongDump.resolve();
          window.pendingSongDump = null;
        }
        if (window.waitingForSingleSongDump) {
          window.waitingForSingleSongDump = false;
          if (typeof fillSongUI === "function") fillSongUI();
        }
      }
      else if (messageId === window.MD_KIT_MESSAGE_ID) {
        // Kit dump
        if (window.blockSlotWrites) return;
        window.kit.rawKit = new Uint8Array(arr);
        window.receiveKitDump(arr.slice(7, -1));

        if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
          requestingKits = false;
          isBulkInProgress = false;
          return;
        }
        if (isBulkInProgress && requestingKits) {
          window.kitLibrary[bulkKitIndex] = isKitEmpty(window.kit)
            ? null
            : { data: JSON.parse(JSON.stringify(window.kit)), colorIndex: bulkKitIndex };
          if (window.buildKitSlotsUI) window.buildKitSlotsUI();
          bulkKitIndex++;
        } else if (window.singleKitReceiveMode) {
          if (window.initUI) window.initUI();
          window.singleKitReceiveMode = false;
        } else {
          // Possibly a single kit request
          if (window.requestingKits) {
            const kPos = (window.kit.sysexPosition != null) ? window.kit.sysexPosition : 0;
            window.kitLibrary[kPos] = !isKitEmpty(window.kit)
              ? { data: JSON.parse(JSON.stringify(window.kit)), colorIndex: kPos }
              : null;
            if (window.buildKitSlotsUI) window.buildKitSlotsUI();
          }
          if (window.initUI) window.initUI();
        }
      }
      else if (messageId === window.MD_PATTERN_MESSAGE_ID) {
        // Pattern dump
        if (window.blockSlotWrites) return;
        window.pattern.rawPattern = new Uint8Array(arr);
        window.receivePatternDump(arr.slice(0, -1), window.pattern);
        const kitInput = document.getElementById("assignedKitNumber");
        if (kitInput) kitInput.value = String(window.pattern.assignedKitNumber + 1);

        if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
          console.log("Aborted after pattern dump received.");
          requestingPatterns = false;
          isBulkInProgress = false;
          return;
        }
        if (isBulkInProgress && requestingPatterns) {
          window.pattern.origPos = bulkPatternIndex;
          window.pattern.patternNumber = bulkPatternIndex;
          window.allPatternSlots[bulkPatternIndex] = isPatternEmpty(window.pattern)
            ? null
            : {
                kit: null,
                pattern: JSON.parse(JSON.stringify(window.pattern)),
                kitColorIndex: Math.max(0, Math.min(63, window.pattern.assignedKitNumber || 0))
              };
          if (window.buildTopPatternBanksUI && window.attachBankSlotClickHandlers) {
            window.buildTopPatternBanksUI();
            window.attachBankSlotClickHandlers();
          }
          if (window.colorizeSlots) window.colorizeSlots();
          bulkPatternIndex++;
          if (window.bulkAbortController && window.bulkAbortController.signal.aborted) {
            console.log("Aborted before scheduling next pattern request.");
            return;
          }
          if (bulkPatternIndex <= window.bulkPatternEnd) {
            requestOnePattern(bulkPatternIndex);
          } else {
            requestingPatterns = false;
            disableImportExportButtons(false);
          }
        } else if (window.waitingForSinglePatternDump) {
          window.waitingForSinglePatternDump = false;

          // When requesting a single patterne dump (via slider-patterns), store it
          // into allPatternSlots so the top slot strip updates immediately.
          try {
            const patIdx = (window.pattern && typeof window.pattern.origPos === "number")
              ? (window.pattern.origPos & 0x7F)
              : (typeof window.pattern.patternNumber === "number" ? window.pattern.patternNumber : 0);

            window.pattern.patternNumber = patIdx;
            window.selectedPatternSlotIndex = patIdx;

            window.allPatternSlots[patIdx] = isPatternEmpty(window.pattern)
              ? null
              : {
                  kit: null,
                  pattern: JSON.parse(JSON.stringify(window.pattern)),
                  kitColorIndex: Math.max(0, Math.min(63, window.pattern.assignedKitNumber || 0))
                };

            if (window.buildTopPatternBanksUI && window.attachBankSlotClickHandlers) {
              window.buildTopPatternBanksUI();
              window.attachBankSlotClickHandlers();
            }
            if (window.colorizeSlots) window.colorizeSlots();
          } catch (e) {
            console.warn("[MIDI] Failed to store single pattern dump into slot", e);
          }

          if (window.initUI) window.initUI();
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
// midi.js
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Send a SysEx request and await a matching Machinedrum reply.
 *
 * Note: WebMIDI can deliver large SysEx dumps in multiple `midimessage` events.
 * These helpers assemble chunks until the terminating 0xF7, then validate:
 *   - Elektron MD header bytes
 *   - expected message ID (byte 6)
 *   - expected slot/position (byte 9) when provided
 *
 * Includes a simple timeout + retry loop so bulk receives don't hang forever
 * on a dropped packet (user can still Cancel at any time).
 */
function _mdHeaderMatches(msg) {
  // NOTE: We intentionally do *not* require an exact match for the 6th header
  // byte (Elektron device ID). Some Machinedrum setups reply with a different
  // device ID than the one we send requests with. The old "working" version
  // only validated message-id/slot and therefore tolerated this.
  //
  // We still validate vendor + product bytes so we don't accidentally match
  // unrelated SysEx streams.
  const hdr = window.MD_SYSEX_HEADER || [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];
  if (!msg || msg.length < 6) return false;
  // Match: F0 00 20 3C 02 (ignore device-id at byte 5)
  for (let i = 0; i <= 4; i++) {
    if ((msg[i] & 0xFF) !== (hdr[i] & 0xFF)) return false;
  }
  return true;
}

function _awaitMachinedrumSysexResponse(options, abortSignal) {
  const opts = options || {};

  const midiIn = window.selectedMidiIn;
  const midiOut = window.selectedMidiOut;
  if (!midiIn || !midiOut) {
    return Promise.reject(new Error("No MIDI In/Out selected"));
  }

  const requestBytes = opts.requestBytes;
  if (!requestBytes || !requestBytes.length) {
    return Promise.reject(new Error("Missing requestBytes"));
  }

  const expectedMsgId = (opts.expectedMsgId != null) ? (opts.expectedMsgId & 0x7F) : null;
  if (expectedMsgId == null) {
    return Promise.reject(new Error("Missing expectedMsgId"));
  }

  // Optional slot/position check (byte 9 in Elektron dumps)
  const expectedSlot = (opts.expectedSlot != null) ? (opts.expectedSlot & 0x7F) : null;
  const slotMask = (opts.slotMask != null) ? (opts.slotMask & 0x7F) : 0x7F;

  // Validation knobs
  const minLength = (opts.minLength != null) ? (opts.minLength | 0) : 0;
  const expectedLengths = Array.isArray(opts.expectedLengths)
    ? opts.expectedLengths.map(n => n | 0).filter(n => n > 0)
    : null;

  const validate = (typeof opts.validate === "function") ? opts.validate : null;

  // Retry / watchdog behavior
  const timeoutMs = (opts.timeoutMs != null) ? (opts.timeoutMs | 0) : 8000;   // idle watchdog
  const retryDelayMs = (opts.retryDelayMs != null) ? (opts.retryDelayMs | 0) : 50;

  // maxAttempts: 0/undefined => unlimited (bulk wants rock-solid)
  const maxAttemptsRaw = (opts.maxAttempts != null) ? (opts.maxAttempts | 0) : 0;
  const maxAttempts = (maxAttemptsRaw > 0) ? maxAttemptsRaw : Infinity;

  // Old working version behavior:
  // - Re-request quickly (50ms) whenever we get *any* Elektron SysEx end that isn't the dump we asked for,
  //   instead of waiting for a multi-second timeout.
  // - Keep the same listener active across retries (no detach/reattach gaps).
  const retryOnWrongId = (opts.retryOnWrongId != null) ? !!opts.retryOnWrongId : true;
  const retryOnTimeout = (opts.retryOnTimeout != null) ? !!opts.retryOnTimeout : true;

  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) return reject(new Error("Aborted"));

    let buffer = [];
    let attempts = 0;
    let lastErr = null;

    let idleTimer = null;
    let resendTimer = null;
    let active = true;

    function cleanup() {
      if (!active) return;
      active = false;

      try { midiIn.removeEventListener("midimessage", onMessage); } catch (_) {}
      try { abortSignal?.removeEventListener("abort", onAbort); } catch (_) {}

      if (idleTimer) clearTimeout(idleTimer);
      if (resendTimer) clearTimeout(resendTimer);
      idleTimer = null;
      resendTimer = null;

      buffer = [];
    }

    function onAbort() {
      cleanup();
      reject(new Error("Aborted"));
    }

    function armIdleWatchdog() {
      if (!retryOnTimeout || !timeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!active) return;
        lastErr = new Error("Timeout");
        scheduleResend("Timeout");
      }, timeoutMs);
    }

    function scheduleResend(reason) {
      if (!active) return;
      if (abortSignal?.aborted) return onAbort();
      if (resendTimer) return; // already scheduled

      // Stop the idle timer while we wait to resend; it'll be re-armed on send
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }

      if (attempts >= maxAttempts) {
        cleanup();
        reject(lastErr || new Error(reason || "Timeout"));
        return;
      }

      // Drop any partial buffer and try again shortly (matches old version)
      buffer = [];

      resendTimer = setTimeout(() => {
        resendTimer = null;
        sendRequest();
      }, retryDelayMs);
    }

    function sendRequest() {
      if (!active) return;
      if (abortSignal?.aborted) return onAbort();

      attempts++;
      if (attempts > maxAttempts) {
        cleanup();
        reject(lastErr || new Error("Timeout"));
        return;
      }

      try {
        midiOut.send(requestBytes);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      // Watchdog is "idle since last activity", not "time since request"
      armIdleWatchdog();
    }

    function isElektronVendorSysex(full) {
      return full.length >= 3 &&
        (full[0] === 0xF0) &&
        (full[1] === 0x00) &&
        (full[2] === 0x20);
    }

    function isExpectedDump(full) {
      // Must look like a Machinedrum sysex frame (tolerant of device-id)
      if (!_mdHeaderMatches(full)) return false;

      const msgId = (full.length > 6) ? (full[6] & 0x7F) : null;
      if (msgId !== expectedMsgId) return false;

      // Optional slot/position enforcement
      if (expectedSlot != null) {
        if (full.length <= 9) return false;
        const pos = full[9] & slotMask;
        if (pos !== expectedSlot) return false;
      }

      // Length validation
      if (expectedLengths && expectedLengths.length) {
        if (!expectedLengths.includes(full.length)) return false;
      } else if (minLength && full.length < minLength) {
        return false;
      }

      if (validate) {
        const res = validate(full);
        if (res) return false;
      }

      return true;
    }

    function onMessage(ev) {
      if (!active) return;
      if (abortSignal?.aborted) return onAbort();

      const chunk = Array.from(ev.data || [], b => b & 0xFF);
      if (!chunk.length) return;

      const first = chunk[0];

      // Ignore realtime and channel/common messages (keeps the SysEx buffer clean)
      if (first >= 0xF8) return;
      if (first >= 0x80 && first < 0xF0) return;
      if (first >= 0xF1 && first <= 0xF6) return;

      // Any inbound traffic means we're not idle → reset watchdog
      armIdleWatchdog();

      if (first === 0xF0) {
        buffer = chunk.slice();
      } else if (buffer.length) {
        buffer.push(...chunk);
      } else {
        // Stray continuation without a start; ignore
        return;
      }

      // Not finished yet
      if (chunk[chunk.length - 1] !== 0xF7) return;

      // Full SysEx assembled
      const full = buffer.slice();
      buffer = [];

      // If it's the dump we asked for → resolve
      if (isExpectedDump(full)) {
        cleanup();
        // IMPORTANT: resolve with a plain Array (not a Uint8Array).
        // Several existing dump parsers (notably KIT) rely on Array semantics:
        // - Array.prototype.map can return non-numbers (e.g. String.fromCharCode)
        // - JSON deep-clone via JSON.stringify/parse preserves Arrays but not TypedArrays
        // Returning a Uint8Array here silently breaks kit name parsing and can corrupt
        // bulk-received library entries.
        resolve(full);
        return;
      }

      // Old version: any Elektron SysEx end that isn't the expected dump triggers a fast re-request.
      if (retryOnWrongId && isElektronVendorSysex(full)) {
        lastErr = new Error("WrongID");
        scheduleResend("WrongID");
      }
    }

    midiIn.addEventListener("midimessage", onMessage);
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    // Kick it off
    sendRequest();
  });
}

// Backwards compatible wrapper (new awaiter is already self-retrying)
async function _requestWithRetry(options, abortSignal) {
  return _awaitMachinedrumSysexResponse(options, abortSignal);
}

function requestGlobalDumpAsync(slot, abortSignal) {
  const syxReq = [
    ...window.MD_SYSEX_HEADER,
    window.MD_GLOBAL_REQUEST_ID,
    slot & 0x07,
    0xF7
  ];

  return _requestWithRetry(
    {
      requestBytes: syxReq,
      expectedMsgId: window.MD_GLOBAL_MESSAGE_ID,
      // global dumps are small; keep this snappy
      minLength: 0xC5,
      timeoutMs: 4000
    },
    abortSignal
  ).then(fullMsg => fullMsg.slice(7, -1));
}
window.requestGlobalDumpAsync = requestGlobalDumpAsync;

/** KIT dump: returns body without MD header or trailing 0xF7 */
function requestKitDumpAsync(slot, abortSignal) {
  const syxReq = [
    ...window.MD_SYSEX_HEADER,
    window.MD_KIT_REQUEST_ID,
    slot & 0x3F,
    0xF7
  ];

  const EXPECTED_KIT_SIZE = 0x4D1; // 1233 bytes including header+F7

  return _requestWithRetry(
    {
      requestBytes: syxReq,
      expectedMsgId: window.MD_KIT_MESSAGE_ID,
      // kits are fixed-size; reject truncated responses
      minLength: EXPECTED_KIT_SIZE,
      timeoutMs: 8000
    },
    abortSignal
  ).then(fullMsg => fullMsg.slice(7, -1));
}
window.requestKitDumpAsync = requestKitDumpAsync;

/** PATTERN dump: returns full message (MD header + body) without trailing 0xF7 */
/**
 * PATTERN dump: returns full message without trailing 0xF7
 * (receiver searches for 0x67 and slices from there)
 */
function requestPatternDumpAsync(slot, abortSignal) {
  const syxReq = [
    ...window.MD_SYSEX_HEADER,
    window.MD_PATTERN_REQUEST_ID,
    slot & 0x7F,
    0xF7
  ];

  // Pattern dumps are large. Accept either known full size (32-step or 64-step dump).
  return _requestWithRetry(
    {
      requestBytes: syxReq,
      expectedMsgId: window.MD_PATTERN_MESSAGE_ID,
      expectedLengths: [2763, 5278],
      timeoutMs: 12000
    },
    abortSignal
  ).then(fullMsg => fullMsg.slice(0, -1));
}
window.requestPatternDumpAsync = requestPatternDumpAsync;

/** SONG dump: returns sysex body starting at message ID (includes trailing 0xF7) */
function requestSongDumpAsync(slot, abortSignal) {
  const syxReq = [
    ...window.MD_SYSEX_HEADER,
    window.MD_SONG_REQUEST_ID,
    slot & 0x1F,
    0xF7
  ];

  return _requestWithRetry(
    {
      requestBytes: syxReq,
      expectedMsgId: window.MD_SONG_MESSAGE_ID,
      // songs are variable-length; validate using the embedded doc-length bytes
      minLength: 32,
      timeoutMs: 8000,
      validate: (full) => {
        const len = full.length | 0;
        if (len < 15) return "Truncated";
        // trailing: [csumHi, csumLo, docLenHi, docLenLo, 0xF7]
        const docHi = full[len - 3] & 0x7F;
        const docLo = full[len - 2] & 0x7F;
        const docLen = (docHi << 7) | docLo;
        return (docLen === (len - 10)) ? null : "Truncated";
      }
    },
    abortSignal
  ).then(fullMsg => fullMsg.slice(6)); // includes message ID + trailing 0xF7
}
window.requestSongDumpAsync = requestSongDumpAsync;

// ---------------------------------------------
  //  3) Inbound CC Handler
  // ---------------------------------------------
  function handleInboundCC([statusByte, ccNum, ccValue]) {
    // CC link is optional. Guard hard so inbound CC never crashes the app.
    if (!window.isCCLinkEnabled || !window.isCCLinkEnabled()) return;
    if (!window.MD_CC_MAP || !window.kit) return;

    const channel = statusByte & 0x0f;
    // MD base channel encoding: 0..12 => MIDI ch 1..13, 13 => OFF
    let baseChan = 0;
    if (typeof window.currentBaseChannel === "number") baseChan = window.currentBaseChannel;
    else if (window.globalData && typeof window.globalData.midiBase === "number") baseChan = window.globalData.midiBase;
    baseChan = baseChan | 0;
    if (baseChan === 13) return; // OFF: do not wrap CC across channels
    if (baseChan < 0) baseChan = 0;
    if (baseChan > 12) baseChan = 12;

    const group = channel - baseChan;
    if (group < 0 || group > 3) return;

    const startTrack = group * 4 + 1;
    const endTrack = startTrack + 3;
    let foundTrack = -1;
    let foundCategory = null;
    let foundParamIndex = -1;

    for (let tr = startTrack; tr <= endTrack; tr++) {
      const mapObj = window.MD_CC_MAP[tr];
      if (!mapObj || !mapObj.param) continue;

      if (mapObj.level === ccNum) {
        foundTrack = tr;
        foundCategory = "level";
        break;
      }
      const idx = mapObj.param.indexOf(ccNum);
      if (idx >= 0) {
        foundTrack = tr;
        foundCategory = "param";
        foundParamIndex = idx;
        break;
      }
    }

    if (foundTrack < 0) return;
    const trackIdx = foundTrack - 1;

    // Update local kit data
    if (foundCategory === "level") {
      window.kit.trackLevels[trackIdx] = ccValue;
      syncKitSliderUI(trackIdx, "level", null, ccValue);
    } else if (foundCategory === "param") {
      if (foundParamIndex < 8) {
        window.kit.machineParams[trackIdx][foundParamIndex] = ccValue;
        syncKitSliderUI(trackIdx, "machineParams", foundParamIndex, ccValue);
      } else if (foundParamIndex < 16) {
        const fxIndex = foundParamIndex - 8;
        window.kit.trackFx[trackIdx][fxIndex] = ccValue;
        syncKitSliderUI(trackIdx, "trackFx", fxIndex, ccValue);
      } else {
        const rtIndex = foundParamIndex - 16;
        window.kit.routing[trackIdx][rtIndex] = ccValue;
        syncKitSliderUI(trackIdx, "routing", rtIndex, ccValue);
      }
    }
  }

  // Helper to reflect changes in the UI
  window.syncKitSliderUI = function (trackIndex, category, paramIndex, newVal) {
    if (category === "level") {
      const row = document.querySelector(
        `.track-overview-table tr.kit-track-row[data-track-index="${trackIndex}"]`
      );
      if (!row) return;
      const slider = row.querySelectorAll("td")[3]?.querySelector("input[type='range']");
      if (slider) slider.value = newVal;
    } else {
      const tableId =
        category === "machineParams" ? "machineParamsUI"
          : category === "trackFx"  ? "trackFxUI"
          :                           "routingUI";
      const table = document.getElementById(tableId);
      if (!table) return;
      const tr = table.querySelector(`tr.kit-track-row[data-track-index="${trackIndex}"]`);
      if (!tr) return;
      const cell = tr.querySelectorAll("td")[paramIndex + 1];
      const knob = cell?.querySelector("input[type='range']");
      if (knob) knob.value = newVal;
      const valSpan = cell?.querySelector(".knob-value");
      if (valSpan) valSpan.textContent = String(newVal);
    }
  };

  // ---------------------------------------------
  //  4) Send ALL to MD
  // ---------------------------------------------
  window.sendAllToMD = function () {
    if (isBulkInProgress) {
      alert("Cannot Send ALL while a bulk retrieval is in progress.");
      return;
    }
    if (isSendAllInProgress) {
      alert("Send ALL is already in progress.");
      return;
    }
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }

    window.midiOperationState.outboundMode = "sendingBulk";
    window.midiOperationState.ignoreAllIncoming = true;
    isSendAllInProgress = true;

    // Send all Globals
    for (let i = 0; i < 8; i++) {
      const gData = window.globalLibrary[i];
      if (!gData) continue;
      gData.globalPosition = i;
      window.selectedMidiOut.send(window.createGlobalDump(gData));
    }
    // Send all Songs
    for (let s = 0; s < 32; s++) {
      const songObj = window.allSongSlots[s];
      if (!songObj) continue;
      songObj.slotIndex = s;
      window.selectedMidiOut.send(window.createSongDump(songObj));
    }
    // Send all Kits
    for (let k = 0; k < 64; k++) {
      const kitItem = window.kitLibrary[k];
      if (!kitItem || !kitItem.data) continue;
      kitItem.data.sysexPosition = k;
      const dump = window.createKitDump(kitItem.data);
      window.selectedMidiOut.send(dump);
    }
    // Send all Patterns
    for (let p = 0; p < 128; p++) {
      const slot = window.allPatternSlots[p];
      if (!slot || !slot.pattern) continue;
      slot.pattern.patternNumber = p;
      window.selectedMidiOut.send(window.storePatternSysex(p, slot.pattern));
    }

    isSendAllInProgress = false;
    window.midiOperationState.outboundMode = "idle";
    window.midiOperationState.ignoreAllIncoming = false;
  };

  // ---------------------------------------------
  //  5) Bulk “Receive All” from MD
  // ---------------------------------------------
  window.requestAllFromMD = () => {
    if (isSendAllInProgress) {
      alert("Cannot receive ALL while a Send ALL is in progress.");
      return;
    }
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (isBulkInProgress) return;

    disableImportExportButtons(true);

    window.midiOperationState.inboundMode = "receivingBulk";
    isBulkInProgress = true;
    requestingGlobals = true;
    requestingSongs = requestingKits = requestingPatterns = false;
    bulkGlobalIndex = 0;
    requestOneGlobal(bulkGlobalIndex);
  };

  // Helper for enabling/disabling import/export
  function disableImportExportButtons(disable) {
    const exportBtn = document.getElementById("exportModalBtn");
    const importBtn = document.getElementById("importModalBtn");
    if (exportBtn) exportBtn.disabled = disable;
    if (importBtn) importBtn.disabled = disable;
  }

  // Single “Request One” calls
  function requestOneGlobal(i) {
    const syx = [...window.MD_SYSEX_HEADER, window.MD_GLOBAL_REQUEST_ID, (i & 0x07), 0xF7];
    if (window.selectedMidiOut) window.selectedMidiOut.send(syx);
  }
  function requestOneSong(i) {
    const syx = [...window.MD_SYSEX_HEADER, window.MD_SONG_REQUEST_ID, (i & 0x1F), 0xF7];
    if (window.selectedMidiOut) window.selectedMidiOut.send(syx);
  }
  function requestOneKit(n) {
    const syx = [...window.MD_SYSEX_HEADER, window.MD_KIT_REQUEST_ID, (n & 0x3F), 0xF7];
    if (window.selectedMidiOut) window.selectedMidiOut.send(syx);
  }
  function requestOnePattern(n) {
    const syx = [...window.MD_SYSEX_HEADER, window.MD_PATTERN_REQUEST_ID, (n & 0x7F), 0xF7];
    if (window.selectedMidiOut) window.selectedMidiOut.send(syx);
  }

  // ---------------------------------------------
  //  6) Misc helpers
  // ---------------------------------------------
  window.isKitEmpty = function (kObj) {
    return (
      !kObj ||
      !kObj.machineAssignments ||
      kObj.machineAssignments.every((m) => m === 0)
    );
  };
  window.isPatternEmpty = function (pObj) {
    if (!pObj || !pObj.trigBitsPerTrack) return true;
    for (let t = 0; t < 16; t++) {
      if (pObj.trigBitsPerTrack[t].some((byte) => byte !== 0)) return false;
    }
    return !(pObj.locks && pObj.locks.length > 0);
  };

  // Simple test note out
  window.testSendToMD = () => {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected.");
      return;
    }
    // Note on, channel 1, middle C
    window.selectedMidiOut.send([0x90, 60, 100]);
  };

  // Decide if we allow CC → param bridging
  window.isCCLinkEnabled = function () {
    const el = document.getElementById("ccLinkCheckbox");
    return el && el.checked;
  };

  // Send single CC param to MD
  window.sendKitCC = function (trackNum, category, paramIndex, value) {
    if (!window.selectedMidiOut || !window.isCCLinkEnabled()) return;
    const baseChan = window.currentBaseChannel || 0;
    const group = Math.floor((trackNum - 1) / 4);
    const channel = baseChan + group;
    const status = 0xb0 + (channel & 0x0f);
    const mapObj = window.MD_CC_MAP[trackNum];
    if (!mapObj) return;

    let ccNum = null;
    if (category === "level") {
      ccNum = mapObj.level;
    } else if (["machineParams", "trackFx", "routing"].includes(category)) {
      const offset = category === "trackFx" ? 8 : category === "routing" ? 16 : 0;
      ccNum = mapObj.param[offset + paramIndex];
    }
    if (ccNum == null) return;

    window.selectedMidiOut.send([status, ccNum & 0x7f, value & 0x7f]);
  };

  // Example "verification message" (unused in normal usage)
  window.verifySlotData = function (slotIndex) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    window.verificationMode = true;
    const lsb = slotIndex & 0x7F;
    const msb = (slotIndex >> 7) & 0x7F;
    window.selectedMidiOut.send([0xF0, 0x7E, 0x00, 0x03, lsb, msb, 0xF7]);
  };

// ---------------------------------------------

/* ==========================================================================
   TurboMIDI (consolidated)
   - TM‑1 vendor speed query/set (C6-style)
   - Generic Elektron Turbo negotiation fallback (0x10/0x11/0x12/0x13)
   - Single active-sensing keepalive service (ref-counted)
   - Single UI pathway (button + optional slider)
   - Exposes: window.onClickTurbo, window.maybeSyncTurbo, window.setTurboSpeedVal,
              window.setTurboFactor, window.getTurboPacketWait, window.setTurboPorts
   ========================================================================== */
(function(){
  'use strict';

  const TM1_PRODUCT_ID = 0x04; // Elektron TM‑1
  const TM1_CH = 0x00;

  // TM‑1 "speed index" → speed factor mapping (C6-style)
  // 1=1x, 2=2x, 3≈3.33x, 4=4x, 5=5x, 6≈6.66x, 7=8x, 8=10x, 9≈13.33x, 10=16x, 11=20x
  const TM1_SPEEDS = [null, 1, 2, 3.33, 4, 5, 6.66, 8, 10, 13.33, 16, 20];

  const STORAGE = {
    preferredSpeedVal: "turboPreferredSpeedVal",
    preferredEnabled:  "turboPreferredEnabled"
  };

  function ssGet(key, fallback=null){
    try {
      if (typeof window.safeStorageGet === "function") {
        const v = window.safeStorageGet(key);
        return (v == null || v === "") ? fallback : v;
      }
    } catch(_) {}
    try {
      const v = window.localStorage.getItem(key);
      return (v == null || v === "") ? fallback : v;
    } catch(_) {}
    return fallback;
  }

  function ssSet(key, value){
    try {
      if (typeof window.safeStorageSet === "function") return window.safeStorageSet(key, value);
    } catch(_) {}
    try {
      window.localStorage.setItem(key, String(value));
      return true;
    } catch(_) {}
    return false;
  }

  function clampInt(v, lo, hi){
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  function factorFromSpeedVal(speedVal){
    const idx = clampInt(speedVal, 1, TM1_SPEEDS.length-1);
    return TM1_SPEEDS[idx] || 1;
  }

  function getModelMaxSpeedVal(){
    try {
      const sel = document.getElementById("mdModelSelect");
      const v = sel ? String(sel.value || "").toUpperCase() : "";
      // MKI is typically stable up to ~10x (idx 8). MKII supports higher.
      return (v === "MKI") ? 8 : 11;
    } catch(_) {}
    return 11;
  }

  function getPreferredSpeedVal(){
    const maxV = getModelMaxSpeedVal();
    const raw = ssGet(STORAGE.preferredSpeedVal, "8");
    return clampInt(raw, 1, maxV);
  }

  function setPreferredSpeedVal(v){
    const maxV = getModelMaxSpeedVal();
    const clamped = clampInt(v, 1, maxV);
    ssSet(STORAGE.preferredSpeedVal, clamped);
    return clamped;
  }

  function getPreferredEnabled(){
    const raw = ssGet(STORAGE.preferredEnabled, "0");
    return raw === "1" || raw === "true";
  }

  function setPreferredEnabled(on){
    ssSet(STORAGE.preferredEnabled, on ? "1" : "0");
  }

  const state = {
    input: null,
    output: null,

    // Keepalive
    kaTimer: null,
    kaPeriodMs: 150,
    kaRefs: 0,

    // Used to cancel waiters on port swap
    portGen: 0,
  };

  // --- public: set ports (called when user changes MIDI I/O) ----------------
  function setTurboPorts(input, output){
    state.input = input || null;
    state.output = output || null;
    state.portGen++;
    updateKeepAlive();
  }
  window.setTurboPorts = setTurboPorts;

  // --- Active Sensing keepalive (ref-counted) -------------------------------
  function shouldKeepAlive(){
    if (!state.output) return false;
    if (state.kaRefs > 0) return true;
    return !!(window.turboActive && (window.currentTurboFactor > 1.0001));
  }

  function stopKeepAlive(){
    if (state.kaTimer){
      clearTimeout(state.kaTimer);
      state.kaTimer = null;
    }
  }

  function startKeepAlive(){
    stopKeepAlive();
    if (!shouldKeepAlive()) return;

    const period = Math.max(50, Number(state.kaPeriodMs) || 150);

    const tick = () => {
      if (!shouldKeepAlive()) { stopKeepAlive(); return; }
      try { state.output && state.output.send([0xFE]); } catch(_) {}
      state.kaTimer = setTimeout(tick, period);
    };
    state.kaTimer = setTimeout(tick, period);
  }

  function updateKeepAlive(){
    if (shouldKeepAlive()) startKeepAlive();
    else stopKeepAlive();
  }

  // Public keepalive API (used by UW transfers)
  window.turboKeepAlive = window.turboKeepAlive || {};
  window.turboKeepAlive.start = function(periodMs=150){
    state.kaRefs++;
    if (Number.isFinite(Number(periodMs))) state.kaPeriodMs = Math.max(50, Number(periodMs));
    updateKeepAlive();
  };
  window.turboKeepAlive.stop = function(){
    state.kaRefs = Math.max(0, state.kaRefs - 1);
    updateKeepAlive();
  };
  window.turboKeepAlive.acquire = function(periodMs=150){
    window.turboKeepAlive.start(periodMs);
    let done = false;
    return function release(){
      if (done) return;
      done = true;
      window.turboKeepAlive.stop();
    };
  };
  window.turboKeepAlive.release = function(){
    window.turboKeepAlive.stop();
  };
  window.turboKeepAlive.isRunning = function(){ return !!state.kaTimer; };

  // --- helpers: await sysex on current input --------------------------------
  function waitForSysex(predicate, timeoutMs){
    return new Promise((resolve, reject) => {
      const input = state.input;
      const gen = state.portGen;
      if (!input){
        reject(new Error("No MIDI input"));
        return;
      }
      let done = false;
      const to = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout"));
      }, Math.max(10, timeoutMs|0));

      function cleanup(){
        if (done) return;
        done = true;
        clearTimeout(to);
        try { input.removeEventListener("midimessage", onMsg); } catch(_) {}
      }

      function onMsg(ev){
        if (gen !== state.portGen){
          cleanup();
          reject(new Error("Port changed"));
          return;
        }
        const d = Array.from(ev.data || []);
        if (d[0] !== 0xF0) return;
        try {
          if (predicate(d)){
            cleanup();
            resolve(d);
          }
        } catch(_) {}
      }

      try { input.addEventListener("midimessage", onMsg); } catch(e){
        cleanup();
        reject(e);
      }
    });
  }

  // --- TM-1 vendor protocol (query/set speed index) -------------------------
  function isTm1Sysex(d, msgId){
    // F0 00 20 3C 04 00 <msgId> ... F7
    return d &&
      d.length >= 8 &&
      d[0] === 0xF0 &&
      d[1] === 0x00 &&
      d[2] === 0x20 &&
      d[3] === 0x3C &&
      d[4] === TM1_PRODUCT_ID &&
      d[5] === TM1_CH &&
      d[6] === (msgId & 0x7F) &&
      d[d.length - 1] === 0xF7;
  }

  async function queryTm1Speed({ timeoutMs = 500 } = {}){
    if (!state.output || !state.input) throw new Error("No ports");
    const q = [0xF0,0x00,0x20,0x3C,TM1_PRODUCT_ID,TM1_CH,0x01,0xF7];
    state.output.send(q);
    const rep = await waitForSysex((d)=>isTm1Sysex(d,0x02), timeoutMs);
    const idx = clampInt(rep[7] & 0x7F, 1, TM1_SPEEDS.length-1);
    window.detectedTurboIndex = idx;
    window.detectedTurboFactor = factorFromSpeedVal(idx);
    return idx;
  }

  async function setTm1Speed(speedVal, { timeoutMs = 700 } = {}){
    if (!state.output) throw new Error("No output");
    const maxV = getModelMaxSpeedVal();
    const idx = clampInt(speedVal, 1, Math.min(maxV, TM1_SPEEDS.length-1));
    const msg = [0xF0,0x00,0x20,0x3C,TM1_PRODUCT_ID,TM1_CH,0x03,(idx & 0x7F),0xF7];
    state.output.send(msg);

    // Give the interface a moment, then query again if possible.
    await new Promise(r => setTimeout(r, 40));
    try {
      const cur = await queryTm1Speed({ timeoutMs });
      return cur;
    } catch(_) {
      window.detectedTurboIndex = idx;
      window.detectedTurboFactor = factorFromSpeedVal(idx);
      return idx;
    }
  }

  // --- Generic Elektron Turbo negotiation fallback --------------------------
  function isElektronTurboSysex(d, msgId){
    // F0 00 20 3C 00 00 <msgId> ... F7
    return d &&
      d.length >= 8 &&
      d[0] === 0xF0 &&
      d[1] === 0x00 &&
      d[2] === 0x20 &&
      d[3] === 0x3C &&
      d[4] === 0x00 &&
      d[5] === 0x00 &&
      d[6] === (msgId & 0x7F) &&
      d[d.length - 1] === 0xF7;
  }

  function chooseTurboSpeedFromBits(bitsLo, bitsHi, certLo, certHi, maxSpeedVal){
    const supported = (bitsLo & 0x7F) | ((bitsHi & 0x7F) << 7);
    const certified = (certLo & 0x7F) | ((certHi & 0x7F) << 7);
    const maxV = clampInt(maxSpeedVal, 1, 14);

    // Prefer a certified speed <= maxV, else any supported speed <= maxV.
    for (let v = maxV; v >= 2; v--){
      if (certified & (1 << v)) return v;
    }
    for (let v = maxV; v >= 2; v--){
      if (supported & (1 << v)) return v;
    }
    return 1;
  }

  async function negotiateTurboOnce({ maxSpeedVal = 8, timeoutMs = 800 } = {}){
    if (!state.output || !state.input) throw new Error("No ports");

    const req = [0xF0,0x00,0x20,0x3C,0x00,0x00,0x10,0xF7];
    state.output.send(req);

    const ans = await waitForSysex((d)=>isElektronTurboSysex(d,0x11), timeoutMs);
    const chosen = chooseTurboSpeedFromBits(ans[7], ans[8], ans[9], ans[10], maxSpeedVal);
    if (chosen <= 1) return 1;

    // Negotiate speed. Encode in low nibble (per Elektron docs).
    const nego = [0xF0,0x00,0x20,0x3C,0x00,0x00,0x12,(chosen & 0x0F),(chosen & 0x0F),0xF7];
    state.output.send(nego);

    // ACK is always sent at 1x; only after that we treat turbo as live.
    await waitForSysex((d)=>isElektronTurboSysex(d,0x13), timeoutMs);

    // Practical "breathing room" (WebMIDI can't send raw 0x00 bytes).
    await new Promise(r => setTimeout(r, 10));

    return chosen;
  }

  // Legacy export (other code may call it)
  window.negotiateTurboOnce = negotiateTurboOnce;

  // --- Canonical turbo state updater ---------------------------------------
  function applyDelayPreset(factor){
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 1.0001){
      window.turboDelayPerSlot = 150;
      return;
    }
    if (f >= 16)      window.turboDelayPerSlot = 4;
    else if (f >= 13) window.turboDelayPerSlot = 5;
    else if (f >= 10) window.turboDelayPerSlot = 6;
    else if (f >= 8)  window.turboDelayPerSlot = 8;
    else if (f >= 6)  window.turboDelayPerSlot = 9;
    else if (f >= 5)  window.turboDelayPerSlot = 10;
    else if (f >= 4)  window.turboDelayPerSlot = 12;
    else if (f >= 3)  window.turboDelayPerSlot = 15;
    else              window.turboDelayPerSlot = 20;
  }

  window._applyTurboDelayPreset = function(labelOrFactor){
    const n = Number(labelOrFactor);
    if (Number.isFinite(n)) applyDelayPreset(n);
    else {
      const m = String(labelOrFactor || "").match(/x\s*([\d.]+)/i);
      applyDelayPreset(m ? parseFloat(m[1]) : 1);
    }
  };

  function updateTurboUI(){
    try {
      ensureTurboControls();
      const btn = document.getElementById("turboButton");
      const lbl = document.getElementById("turboSpeedLabel");
      const slider = document.getElementById("turboSpeedSlider");

      const maxV = getModelMaxSpeedVal();
      if (slider) {
        slider.max = String(maxV);
        // Keep slider synced to stored preference
        const pref = getPreferredSpeedVal();
        slider.value = String(clampInt(pref, 1, maxV));

        // Keep tick marks in sync with model max
        try {
          const dl = document.getElementById("turboSpeedTicks");
          if (dl) {
            const want = maxV;
            const have = dl.querySelectorAll('option').length;
            if (have != want) {
              dl.innerHTML = '';
              for (let i = 1; i <= want; i++) {
                const o = document.createElement('option');
                o.value = String(i);
                dl.appendChild(o);
              }
            }
          }
        } catch(_) {}
      }

      const speedText = window.turboSpeedFactor || "x1.00";
      if (lbl) lbl.textContent = speedText;

      if (btn){
        btn.classList.toggle("active", !!window.turboActive);
        btn.textContent = window.turboActive ? "Disable" : "Enable";
      }
    } catch(_) {}
  }

  function setTurboFactor(factor, { source="manual" } = {}){
    const f = Number(factor);
    const next = (Number.isFinite(f) && f > 1.0001) ? f : 1;
    window.currentTurboFactor = next;
    window.turboActive = next > 1.0001;
    window.turboSpeedFactor = `x${next.toFixed(2)}`;
    window.turboFactorSource = source || window.turboFactorSource || "manual";

    applyDelayPreset(next);

    // Keep wire-clock in sync (used by global kit/pattern/song transfers)
    try {
      if (window.MidiWireClock && typeof window.MidiWireClock.setTurboFactor === "function") {
        window.MidiWireClock.setTurboFactor(next);
      }
    } catch(_) {}

    updateKeepAlive();
    updateTurboUI();
  }
  window.setTurboFactor = setTurboFactor;

  // Conservative SDS pacing hint (UW sample manager clamps to >=6ms in turbo paths)
  window.getTurboPacketWait = () => (window.turboActive ? 4 : 20);

  // --- UI wiring ------------------------------------------------------------
  function ensureTurboControls(){
    try {
      const btn = document.getElementById("turboButton");
      const lbl = document.getElementById("turboSpeedLabel");
      if (!btn || !lbl) return;

      const row = btn.parentElement || lbl.parentElement;
      if (!row) return;

      // Add slider only once
      let s = document.getElementById("turboSpeedSlider");
      if (!s){
        s = document.createElement("input");
        s.type = "range";
        s.id = "turboSpeedSlider";
        s.min = "1";
        s.max = String(getModelMaxSpeedVal());
        s.step = "1";
        s.value = String(getPreferredSpeedVal());

        // Use datalist ticks for a notched look (MMDT parity)
        s.setAttribute('list', 'turboSpeedTicks');

        // Inline layout: Button | Slider | Numeric readout
        s.style.flex = '1 1 160px';
        s.style.minWidth = '140px';

        // Insert between the button and the numeric label
        row.insertBefore(s, lbl);

        // Build ticks
        let dl = document.getElementById('turboSpeedTicks');
        if (!dl){
          dl = document.createElement('datalist');
          dl.id = 'turboSpeedTicks';
          row.appendChild(dl);
        }
        dl.innerHTML = '';
        const maxV = getModelMaxSpeedVal();
        for (let i = 1; i <= maxV; i++) {
          const o = document.createElement('option');
          o.value = String(i);
          dl.appendChild(o);
        }

        s.addEventListener("input", () => {
          const maxV2 = getModelMaxSpeedVal();
          const val = clampInt(s.value, 1, maxV2);
          s.value = String(val);
          setPreferredSpeedVal(val);
        });

        // Ensure the slider stays in sync when model changes
        try {
          const modelSel = document.getElementById('mdModelSelect');
          if (modelSel && !modelSel.__mddtTurboBound){
            modelSel.__mddtTurboBound = true;
            modelSel.addEventListener('change', () => {
              try { updateTurboUI(); } catch(_) {}
            });
          }
        } catch(_) {}
      }

    } catch(_) {}
  }

  window.updateTurboUI = updateTurboUI;

  // --- Core action: set speed value (tries TM‑1 first, then generic) ----------
  async function setTurboSpeedVal(speedVal){
    const maxV = getModelMaxSpeedVal();
    const target = clampInt(speedVal, 1, maxV);

    // Try TM‑1 vendor protocol first.
    try {
      const idx = await queryTm1Speed({ timeoutMs: 250 });
      if (idx >= 1){
        const newIdx = await setTm1Speed(target, { timeoutMs: 350 });
        const f = factorFromSpeedVal(newIdx);
        setTurboFactor(f, { source: "TM-1" });
        // Cache the active Turbo speed value so other modules (e.g. UW sample
        // manager) can make per-feature safety decisions.
        window.currentTurboSpeedVal = newIdx;
        window.detectedTurboIndex = newIdx;
        window.detectedTurboFactor = f;
        return f;
      }
    } catch(_) {}

    // No TM‑1: attempt generic Elektron Turbo negotiation (best effort)
    if (target <= 1){
      setTurboFactor(1, { source: "manual" });
      window.currentTurboSpeedVal = 1;
      return 1;
    }
    try {
      const chosen = await negotiateTurboOnce({ maxSpeedVal: target });
      const f = factorFromSpeedVal(chosen);
      setTurboFactor(f, { source: "Elektron" });
      window.currentTurboSpeedVal = chosen;
      return f;
    } catch(_) {
      setTurboFactor(1, { source: "manual" });
      window.currentTurboSpeedVal = 1;
      return 1;
    }
  }
  window.setTurboSpeedVal = setTurboSpeedVal;

  // --- Toggle button action -------------------------------------------------
  window.onClickTurbo = async function(){
    const preferred = getPreferredSpeedVal();
    const nextEnabled = !window.turboActive;
    setPreferredEnabled(nextEnabled);

    if (nextEnabled){
      await setTurboSpeedVal(preferred);
    } else {
      await setTurboSpeedVal(1);
    }
  };

  // --- Sync on port/model changes -------------------------------------------
  window.maybeSyncTurbo = async function(){
    const maxV = getModelMaxSpeedVal();

    // If TM‑1 exists, read its current speed and clamp to model max.
    try {
      const idx = await queryTm1Speed({ timeoutMs: 350 });
      const clamped = Math.min(idx, maxV);

      if (idx !== clamped){
        try { await setTm1Speed(clamped, { timeoutMs: 350 }); } catch(_) {}
      }

      const f = factorFromSpeedVal(clamped);
      setTurboFactor(f, { source: "TM-1" });
      window.currentTurboSpeedVal = clamped;

      // Keep slider in sync with preference bounds
      try {
        const slider = document.getElementById("turboSpeedSlider");
        if (slider){
          slider.max = String(maxV);
          const pref = getPreferredSpeedVal();
          slider.value = String(pref);
        }
      } catch(_) {}

      return;
    } catch(_) {}

    // No TM‑1 detected. If the user previously enabled turbo, best-effort re-negotiate.
    if (getPreferredEnabled()){
      try {
        await setTurboSpeedVal(clampInt(getPreferredSpeedVal(), 1, maxV));
        return;
      } catch(_) {}
    }

    setTurboFactor(1, { source: "none" });
  };

  // --- default state on boot ------------------------------------------------
  if (!Number.isFinite(Number(window.currentTurboFactor))) window.currentTurboFactor = 1;
  if (typeof window.turboActive !== "boolean") window.turboActive = (window.currentTurboFactor > 1.0001);
  if (typeof window.turboSpeedFactor !== "string") window.turboSpeedFactor = `x${Number(window.currentTurboFactor).toFixed(2)}`;

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { try { updateTurboUI(); } catch(_) {} }, { once: true });
    } else {
      setTimeout(() => { try { updateTurboUI(); } catch(_) {} }, 0);
    }
  } catch(_) {}

})();

})();
