// globals.js

(() => {
  "use strict";
  if (!window.encode7Bit) {
    window.encode7Bit = function (raw) {
      const out = [];
      for (let i = 0; i < raw.length; i += 7) {
        const block = raw.slice(i, i + 7);
        // build the MSB header byte
        let header = 0;
        for (let j = 0; j < block.length; j++) {
          if (block[j] & 0x80) header |= 1 << (6 - j);
        }
        out.push(header & 0x7F);
        // then the low‑7 bits of each byte (pad zeros to 7)
        for (let j = 0; j < 7; j++) {
          out.push(j < block.length ? (block[j] & 0x7F) : 0);
        }
      }
      return new Uint8Array(out);
    };
  }

  if (!window.FLAG_BITS) {
    window.FLAG_BITS = {
      clockIn: 0,
      transportIn: 1,
      clockOut: 2,
      transportOut: 3
    };
  }

  if (!window.decode7BitDynamic) {
    window.decode7BitDynamic = function (arr, startIndex, neededRawBytes) {
      const out = [];
      let i = startIndex;
      while (out.length < neededRawBytes && i < arr.length) {
        const header = arr[i++] & 0x7F;
        for (let bit = 0; bit < 7; bit++) {
          if (i >= arr.length) break;
          const low = arr[i++] & 0x7F;
          // extract MSB from header bit (6→first byte, 0→seventh)
          const msb = (header & (1 << (6 - bit))) ? 0x80 : 0;
          out.push(msb | low);
          if (out.length === neededRawBytes) break;
        }
      }
      return { result: out, consumed: i - startIndex };
    };
  }

  if (!window.padOrSlice) {
    window.padOrSlice = function (arr, wantLen) {
      if (arr.length === wantLen) return arr;
      if (arr.length > wantLen) return arr.slice(0, wantLen);
      let pad = new Uint8Array(wantLen - arr.length);
      return new Uint8Array([...arr, ...pad]);
    };
  }

  if (!window.globalData) {
    window.globalData = {};
  }

  const MD_GLOBAL_MESSAGE_ID = 0x50;
  const MD_GLOBAL_REQUEST_ID = 0x51;
  const TOTAL_LENGTH_GLOBAL  = 0xC5;
  const DOCUMENTED_LENGTH_GLOBAL = 187;
  const OFF_GLOBAL_ROUTING     = 0x0A;
  const LEN_GLOBAL_ROUTING     = 16;
  const OFF_KEYMAP_ENC         = 0x1A;
  const LEN_KEYMAP_RAW         = 128;
  const LEN_KEYMAP_ENCODED     = 147;
  const OFF_MIDI_BASE          = 0xAD;
  const OFF_MECH               = 0xAE;
  const OFF_TEMPO_HIGH         = 0xAF;
  const OFF_TEMPO_LOW          = 0xB0;
  const OFF_EXTENDED_MODE      = 0xB1;
  const OFF_FLAGS              = 0xB2;
  const OFF_LOCAL_ON           = 0xB3;
  const OFF_DRUM_LEFT          = 0xB4;
  const OFF_DRUM_RIGHT         = 0xB5;
  const OFF_GATE_LEFT          = 0xB6;
  const OFF_GATE_RIGHT         = 0xB7;
  const OFF_SENSE_LEFT         = 0xB8;
  const OFF_SENSE_RIGHT        = 0xB9;
  const OFF_MIN_LEVEL_LEFT     = 0xBA;
  const OFF_MIN_LEVEL_RIGHT    = 0xBB;
  const OFF_MAX_LEVEL_LEFT     = 0xBC;
  const OFF_MAX_LEVEL_RIGHT    = 0xBD;
  const OFF_PROGRAM_CHANGE     = 0xBE;
  const OFF_TRIG_MODE          = 0xBF;
  const OFF_CHECKSUM_HI_GLOBAL = 0xC0;
  const OFF_CHECKSUM_LO_GLOBAL = 0xC1;
  const OFF_LENGTH_HI_GLOBAL   = 0xC2;
  const OFF_LENGTH_LO_GLOBAL   = 0xC3;
  const OFF_SYSEX_END_GLOBAL   = 0xC4;
  if (typeof window.selectedGlobalSlotIndex === "undefined") {
    window.selectedGlobalSlotIndex = -1;
  }

  window.requestGlobalSysex = function (globalSlot) {
    return new Uint8Array([
      ...window.MD_SYSEX_HEADER,
      MD_GLOBAL_REQUEST_ID,
      (globalSlot & 0x07),
      0xF7
    ]);
  };

  window.handleIncomingGlobalSysEx = function (fullData) {
    if (!(fullData instanceof Uint8Array)) {
      fullData = new Uint8Array(fullData);
    }
    if (fullData[fullData.length - 1] !== 0xF7) {
      console.warn("Global SysEx missing final 0xF7? Possibly truncated?");
    }
    const minusHeader = fullData.slice(0, -1);
    if (minusHeader.length < 20) {
      console.warn("Incoming global SysEx is too short; ignoring.");
      return;
    }
    window.receiveGlobalDump(minusHeader);
  };

  window.receiveGlobalDump = function (fullGlobalMsgMinusHeader) {
    if (window.blockSlotWrites) {
      console.warn("Blocked global data update during sample import.");
      return;
    }
    if (!fullGlobalMsgMinusHeader || fullGlobalMsgMinusHeader.length < 20) {
      console.warn("receiveGlobalDump => not enough data!");
      return;
    }

    // Normalise to a plain Array so downstream code behaves consistently.
    // Some callers may pass a Uint8Array.
    if (!Array.isArray(fullGlobalMsgMinusHeader)) {
      fullGlobalMsgMinusHeader = Array.from(fullGlobalMsgMinusHeader);
    }

    // Most code paths pass the GLOBAL body without the final 0xF7 terminator
    // (e.g. slice(7, -1)). If an 0xF7 is present, strip it so indexes line up.
    if (fullGlobalMsgMinusHeader.length && fullGlobalMsgMinusHeader[fullGlobalMsgMinusHeader.length - 1] === 0xF7) {
      fullGlobalMsgMinusHeader = fullGlobalMsgMinusHeader.slice(0, -1);
    }
    let idx = 0;
    window.globalData.sysexVersion   = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.sysexRevision  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.globalPosition = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.drumRouting = Array.from(
      fullGlobalMsgMinusHeader.slice(idx, idx + LEN_GLOBAL_ROUTING),
      (v) => v & 0x7F
    );
    idx += LEN_GLOBAL_ROUTING;
    const keymapBlock = fullGlobalMsgMinusHeader.slice(idx, idx + LEN_KEYMAP_ENCODED);
    idx += LEN_KEYMAP_ENCODED;
    const dec = window.decode7BitDynamic(keymapBlock, 0, LEN_KEYMAP_RAW);
    // Normalise to a predictable, dense array type.
    window.globalData.keymap = new Uint8Array(dec.result);
    window.globalData.midiBase           = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.mechanicalSettings = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.tempoHigh = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.tempoLow  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    let rawTempo = ((window.globalData.tempoHigh << 7) | window.globalData.tempoLow) & 0x3FFF;
    window.globalData.tempo = rawTempo / 24;
    window.globalData.extendedMode = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.flags        = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.localOn      = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.drumLeft   = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.drumRight  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.gateLeft   = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.gateRight  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.senseLeft  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.senseRight = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.minLevelLeft  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.minLevelRight = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.maxLevelLeft  = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.maxLevelRight = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    let pcByte = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    window.globalData.programChangeMode    = pcByte & 0x03;
    window.globalData.programChangeChannel = Math.floor(pcByte / 4);
    window.globalData.trigMode = fullGlobalMsgMinusHeader[idx++] & 0x7F;
    if (window.globalData.trigMode > 2) {
      window.globalData.trigMode = 0;
    }
    window.globalData.checksum = {
      hi: fullGlobalMsgMinusHeader[idx++] & 0x7F,
      lo: fullGlobalMsgMinusHeader[idx++] & 0x7F
    };
    window.globalData.messageLength = {
      hi: fullGlobalMsgMinusHeader[idx++] & 0x7F,
      lo: fullGlobalMsgMinusHeader[idx++] & 0x7F
    };
    // The incoming body is expected to *omit* the final 0xF7. Keep a stable
    // sysexEnd value for completeness, and perform a more meaningful truncation
    // check based on expected body length instead of the terminator byte.
    window.globalData.sysexEnd = 0xF7;

    const EXPECTED_GLOBAL_BODY_LEN = TOTAL_LENGTH_GLOBAL - 8; // (total - header(6) - msgId(1) - F7(1))
    if (fullGlobalMsgMinusHeader.length < EXPECTED_GLOBAL_BODY_LEN) {
      console.warn(
        `Global dump appears truncated: expected ${EXPECTED_GLOBAL_BODY_LEN} bytes (without 0xF7), got ${fullGlobalMsgMinusHeader.length}`
      );
    }
    if (window.globalData.mechanicalSettings > 1) {
      window.globalData.mechanicalSettings = 0;
    }
    window.currentBaseChannel = window.globalData.midiBase;

    // When a GLOBAL dump is received from the Machinedrum we treat it as the
    // currently loaded buffer and keep slot selection in sync.
    //
    // During *file import* we suppress auto-selection and UI refresh so the
    // user doesn't see slots blink / editors populate just because data was
    // stored into the library.
    if (!window.__mddtImporting) {
      const gp = Number.isFinite(window.globalData?.globalPosition) ? (window.globalData.globalPosition | 0) : -1;
      if (gp >= 0) window.selectedGlobalSlotIndex = Math.max(0, Math.min(7, gp));
      if (typeof window.initGlobalUI === "function") {
        window.initGlobalUI();
      }
    }
  };

  // Build a GLOBAL dump SysEx message.
  //
  // NOTE: Bulk send calls this as createGlobalDump(slotObj).
  // The legacy single-slot flow calls createGlobalDump() which uses window.globalData.
  function createGlobalDump(sourceData) {
    const gd = sourceData || window.globalData || {};
    let dump = new Uint8Array(TOTAL_LENGTH_GLOBAL);
    dump.fill(0);
    dump.set(window.MD_SYSEX_HEADER, 0);
    dump[6] = MD_GLOBAL_MESSAGE_ID;
    dump[7] = (gd.sysexVersion != null ? gd.sysexVersion : 6) & 0x7F;
    dump[8] = (gd.sysexRevision != null ? gd.sysexRevision : 1) & 0x7F;
    {
    const gp = Number.isFinite(gd.globalPosition) ? (gd.globalPosition | 0) : 0;
    dump[9] = Math.max(0, Math.min(7, gp)) & 0x7F;
  }
    for (let i = 0; i < LEN_GLOBAL_ROUTING; i++) {
      dump[OFF_GLOBAL_ROUTING + i] =
        gd.drumRouting?.[i] != null
          ? gd.drumRouting[i] & 0x7F
          : 0;
    }
    // Keymap: default to "unassigned" (0x7F) rather than 0x00.
    let keymapRaw = new Uint8Array(LEN_KEYMAP_RAW);
    keymapRaw.fill(0x7F);
    for (let i = 0; i < LEN_KEYMAP_RAW; i++) {
      keymapRaw[i] = gd.keymap?.[i] != null
        ? gd.keymap[i] & 0xFF
        : 0x7F;
    }
    let encodedK = window.encode7Bit(keymapRaw);
    encodedK = window.padOrSlice(encodedK, LEN_KEYMAP_ENCODED);
    dump.set(encodedK, OFF_KEYMAP_ENC);
    let bpm;
    if (typeof gd.tempo === "number" && !isNaN(gd.tempo)) {
      bpm = gd.tempo;
    } else {
      const hi = Number.isFinite(gd.tempoHigh) ? gd.tempoHigh : 0;
      const lo = Number.isFinite(gd.tempoLow) ? gd.tempoLow : 0;
      const derived = (((hi & 0x7F) << 7) | (lo & 0x7F)) / 24;
      bpm = derived > 0 ? derived : 120.0;
    }
    let rawTempo = Math.round(bpm * 24);
    rawTempo = Math.min(16383, Math.max(0, rawTempo));
    gd.tempoHigh = (rawTempo >> 7) & 0x7F;
    gd.tempoLow  = rawTempo & 0x7F;
    if (gd.mechanicalSettings > 1) {
      gd.mechanicalSettings = 0;
    }
    if (gd.programChangeMode > 3) {
      gd.programChangeMode = 0;
    }
    if (gd.trigMode > 2) {
      gd.trigMode = 0;
    }
    dump[OFF_MIDI_BASE]     = (gd.midiBase || 0) & 0x7F;
    dump[OFF_MECH]          = (gd.mechanicalSettings || 0) & 0x7F;
    dump[OFF_TEMPO_HIGH]    = gd.tempoHigh & 0x7F;
    dump[OFF_TEMPO_LOW]     = gd.tempoLow & 0x7F;
    dump[OFF_EXTENDED_MODE] = (gd.extendedMode || 0) & 0x7F;
    dump[OFF_FLAGS]         = (gd.flags || 0) & 0x7F;
    dump[OFF_LOCAL_ON]      = (gd.localOn || 0) & 0x7F;
    dump[OFF_DRUM_LEFT]     = (gd.drumLeft || 0) & 0x7F;
    dump[OFF_DRUM_RIGHT]    = (gd.drumRight || 0) & 0x7F;
    dump[OFF_GATE_LEFT]     = (gd.gateLeft || 0) & 0x7F;
    dump[OFF_GATE_RIGHT]    = (gd.gateRight || 0) & 0x7F;
    dump[OFF_SENSE_LEFT]    = (gd.senseLeft || 0) & 0x7F;
    dump[OFF_SENSE_RIGHT]   = (gd.senseRight || 0) & 0x7F;
    dump[OFF_MIN_LEVEL_LEFT]  = (gd.minLevelLeft || 0) & 0x7F;
    dump[OFF_MIN_LEVEL_RIGHT] = (gd.minLevelRight || 0) & 0x7F;
    dump[OFF_MAX_LEVEL_LEFT]  = ((gd.maxLevelLeft != null ? gd.maxLevelLeft : 127) & 0x7F);
    dump[OFF_MAX_LEVEL_RIGHT] = ((gd.maxLevelRight != null ? gd.maxLevelRight : 127) & 0x7F);
    let channel = gd.programChangeChannel;
    if (typeof channel !== "number" || isNaN(channel)) channel = 0;
    channel = Math.max(0, Math.min(16, channel));
    let mode = gd.programChangeMode;
    if (typeof mode !== "number" || isNaN(mode)) mode = 0;
    mode = Math.max(0, Math.min(3, mode));
    gd.programChange = channel * 4 + mode;
    dump[OFF_PROGRAM_CHANGE] = gd.programChange & 0x7F;
    dump[OFF_TRIG_MODE] = (gd.trigMode || 0) & 0x7F;
    let sum = 0;
    for (let i = 9; i < OFF_CHECKSUM_HI_GLOBAL; i++) {
      sum += dump[i];
    }
    sum &= 0x3FFF;
    dump[OFF_CHECKSUM_HI_GLOBAL] = (sum >> 7) & 0x7F;
    dump[OFF_CHECKSUM_LO_GLOBAL] = sum & 0x7F;
    dump[OFF_LENGTH_HI_GLOBAL] = (DOCUMENTED_LENGTH_GLOBAL >> 7) & 0x7F;
    dump[OFF_LENGTH_LO_GLOBAL] = DOCUMENTED_LENGTH_GLOBAL & 0x7F;
    dump[OFF_SYSEX_END_GLOBAL] = 0xF7;
    return dump;
  }
  window.createGlobalDump = createGlobalDump;
})();

(() => {
  "use strict";
  window.globalLibrary = window.globalLibrary || Array(8).fill(null);
  // NOTE:
  // mddt-ui.js also defines a richer buildGlobalSlotsUI (drag/drop, unified styling).
  // This file used to overwrite it and hard-code light slot colours (#ddd / green hues),
  // which is why the GLOBAL slots appeared much lighter than Kits/Patterns/Songs.
  //
  // To keep a single source of truth and consistent styling, only provide the legacy
  // implementation if nothing else has defined buildGlobalSlotsUI.
  if (typeof window.buildGlobalSlotsUI === "function") return;

  window.buildGlobalSlotsUI = function () {
    const container = document.getElementById("globalSlotsContainer");
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < 8; i++) {
      const slotDiv = document.createElement("div");
      slotDiv.classList.add("global-slot");
      slotDiv.dataset.idx = String(i);
      slotDiv.textContent = String(i + 1);
      if (window.globalLibrary[i]) {
        slotDiv.classList.add("filled");
        const lightness = 30 + (i / 7) * 40;
        slotDiv.style.backgroundColor = `hsl(120, 70%, ${lightness}%)`;
      } else {
        slotDiv.classList.add("empty-slot");
        slotDiv.style.backgroundColor = "#ddd";
      }
      if (i === window.selectedGlobalSlotIndex) {
        slotDiv.classList.add("blink-selected");
      }
      slotDiv.onclick = (ev) => {
        if (ev.shiftKey) {
          if (window.globalLibrary[i] && !confirm("Overwrite Global Data?")) return;
          if (typeof window.saveGlobalSettings === "function") {
            window.saveGlobalSettings();
          }
          if (window.globalData) {
            window.globalLibrary[i] = JSON.parse(JSON.stringify(window.globalData));
            console.log(`Stored current globalData into library slot #${i}`);
          }
        } else {
          window.selectedGlobalSlotIndex = i;
          if (window.globalLibrary[i]) {
            window.globalData = JSON.parse(JSON.stringify(window.globalLibrary[i]));
            if (typeof window.initGlobalUI === "function") {
              window.initGlobalUI();
            }
            const disp = document.getElementById("globalNumberDisplay");
            if (disp) disp.textContent = i + 1;
            if (window.selectedMidiOut) {
              const loadMsg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x56, i, 0xF7]);
              window.selectedMidiOut.send(loadMsg);
            } else {
              console.warn("MIDI Out is not selected; cannot send load message.");
            }
          } else {
            console.log("Global slot empty. (No data to load.)");
          }
        }
        if (typeof updatePanelHeaderColors === "function") {
          updatePanelHeaderColors();
        }
        window.buildGlobalSlotsUI();
      };
      container.appendChild(slotDiv);
    }
  };
})();

(() => {
  "use strict";
  function requestGlobalDump(indexOrOpts) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (!window.isBulkInProgress && !confirm("Overwrite Global data?")) {
      return;
    }
    if (window.blockSlotWrites) {
      return;
    }
    let useRange = false;
    let explicitIndex = null;
    if (typeof indexOrOpts === "number") {
      explicitIndex = indexOrOpts;
    } else if (typeof indexOrOpts === "object" && indexOrOpts.useRange === true) {
      useRange = true;
    }
    if (useRange) {
      const [startStr, endStr] = document.getElementById("slider-globals").noUiSlider.get();
      let start = parseInt(startStr, 10) || 1;
      let end   = parseInt(endStr, 10) || 1;
      if (start > end) [start, end] = [end, start];
      start = Math.max(1, Math.min(8, start));
      end   = Math.max(1, Math.min(8, end));
      for (let g = start; g <= end; g++) {
        const slotIndex = g - 1;
        const syx = window.requestGlobalSysex(slotIndex);
        window.selectedMidiOut.send(syx);
        console.log("Requested Global dump slot #", slotIndex);
      }
      return;
    }
    let slotIndex;
    if (explicitIndex !== null) {
      slotIndex = Math.max(0, Math.min(7, explicitIndex));
    } else {
      const [startVal] = document.getElementById("slider-globals").noUiSlider.get();
      let gNum = parseInt(startVal, 10) || 1;
      gNum = Math.max(1, Math.min(8, gNum));
      slotIndex = gNum - 1;
    }
    const syx = window.requestGlobalSysex(slotIndex);
    window.selectedMidiOut.send(syx);
    console.log("Requested single Global dump for slot #", slotIndex);
  }
  window.requestGlobalDump = requestGlobalDump;

  function sendGlobalToMD(opts) {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (checkIfBulkActive()) return;
    let useRange = (opts && opts.useRange);
    if (useRange) {
      const [startStr, endStr] = document.getElementById("slider-globals").noUiSlider.get();
      let start = parseInt(startStr, 10) || 1;
      let end   = parseInt(endStr,   10) || 1;
      if (start > end) [start, end] = [end, start];
      start = Math.max(1, Math.min(8, start));
      end   = Math.max(1, Math.min(8, end));
      for (let g = start; g <= end; g++) {
        const slotIndex = g - 1;
        window.globalData.globalPosition = slotIndex;
        const syx = window.createGlobalDump();
        window.selectedMidiOut.send(syx);
        console.log("Sent Global data to slot #", slotIndex);
      }
      return;
    }
    const [startVal] = document.getElementById("slider-globals").noUiSlider.get();
    let gNum = parseInt(startVal, 10) || 1;
    gNum = Math.max(1, Math.min(8, gNum));
    const slotIndex = gNum - 1;
    window.globalData.globalPosition = slotIndex;
    const syxSingle = window.createGlobalDump();
    if (window.sendWireCounted) window.sendWireCounted(syxSingle);
    else window.selectedMidiOut.send(syxSingle);
    console.log("Sent single global data to slot #", slotIndex);
  }

  window.onClickWriteGlobal = function () {
    if (!window.selectedMidiOut) {
      alert("No MIDI Out selected!");
      return;
    }
    if (checkIfBulkActive()) return;
    if (!confirm("WARNING: This will overwrite Machinedrum Global data. Continue?")) {
      return;
    }
    if (typeof window.saveGlobalSettings === "function") {
      window.saveGlobalSettings();
    }

    // Ensure the dump is written to the currently selected global slot.
    // (Without this, an undefined globalPosition could silently default to slot 1.)
    const targetIndex = Number.isFinite(window.selectedGlobalSlotIndex)
      ? Math.max(0, Math.min(7, window.selectedGlobalSlotIndex))
      : (Number.isFinite(window.globalData?.globalPosition)
          ? Math.max(0, Math.min(7, window.globalData.globalPosition))
          : 0);
    window.globalData.globalPosition = targetIndex;

    const outDump = window.createGlobalDump();
    window.selectedMidiOut.send(outDump);
    // After-write: load the slot we just wrote (keeps the MD active Global in sync).
    const loadIndex = targetIndex;
    const loadCmd = [
      0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00,
      0x56,
      (loadIndex & 0x07),
      0xF7
    ];
    window.selectedMidiOut.send(new Uint8Array(loadCmd));
    console.log(
      "Wrote current globalData to MD slot #",
      targetIndex,
      "and triggered load for slot #",
      loadIndex
    );
  };

  window.checkIfBulkActive = function() {
    if (window.isBulkInProgress) {
      alert("A bulk operation is currently in progress.  Please wait for it to finish first.");
      return true;
    }
    return false;
  };

  window.initGlobalUI = function () {
    // Slot selection (blinking) is an explicit user action.
    // Do NOT auto-select slot 1 on first load just because the default
    // globalData happens to have globalPosition = 0.
    const sel = Number.isFinite(window.selectedGlobalSlotIndex) ? (window.selectedGlobalSlotIndex | 0) : -1;
    const pos = (sel >= 0) ? Math.max(0, Math.min(7, sel)) : -1;

    if (pos >= 0) window.selectedGlobalSlotIndex = pos;

    if (pos >= 0 && window.globalData && typeof window.globalData === 'object') {
      window.globalData.globalPosition = pos;
    }

    const disp = document.getElementById("globalNumberDisplay");
    if (disp) disp.textContent = (pos >= 0 ? String(pos + 1) : "");

    if (typeof window.buildGlobalSlotsUI === "function") {
      window.buildGlobalSlotsUI();
    }

    const routingDiv = document.getElementById("globalDrumRoutingUI");
    if (routingDiv) {
      routingDiv.innerHTML = "";
      const routingLabels = ["A", "B", "C", "D", "E", "F", "Main"];
      if (!Array.isArray(window.globalData.drumRouting) || window.globalData.drumRouting.length < 16) {
        window.globalData.drumRouting = new Array(16).fill(0);
      }

      for (let i = 0; i < 16; i++) {
        const item = document.createElement("div");
        item.className = "global-routing-item";

        const lbl = document.createElement("span");
        const num = String(i + 1).padStart(2, "0");
        lbl.textContent = `T${num}`;
        item.appendChild(lbl);

        const sel = document.createElement("select");
        sel.setAttribute("aria-label", `Routing for Track ${i + 1}`);
        for (let val = 0; val < routingLabels.length; val++) {
          const opt = document.createElement("option");
          opt.value = String(val);
          opt.textContent = routingLabels[val];
          sel.appendChild(opt);
        }
        let currentVal = window.globalData.drumRouting?.[i] ?? 0;
        if (currentVal < 0 || currentVal > 6) currentVal = 0;
        sel.value = String(currentVal);
        sel.onchange = function () {
          window.globalData.drumRouting[i] = parseInt(this.value, 10) || 0;
        };
        item.appendChild(sel);
        routingDiv.appendChild(item);
      }
    }
    const midiBaseSel = document.getElementById("globalMidiBaseSelect");
    if (midiBaseSel) {
      let mbVal = window.globalData.midiBase || 0;
      if (mbVal < 0 || mbVal > 13) mbVal = 0;
      midiBaseSel.value = mbVal.toString();
      // Keep runtime mirror in sync on init.
      window.currentBaseChannel = mbVal;

      // Live bind: keep runtime base channel in sync with UI selection.
      // This drives CC Link + helpers (Skewclid/Nodetrix) without requiring a
      // round-trip dump.
      const onBaseChange = () => {
        let v = parseInt(midiBaseSel.value, 10);
        if (isNaN(v)) v = 0;
        if (v < 0 || v > 13) v = 0;
        window.globalData.midiBase = v;
        window.currentBaseChannel = v;
      };
      // Avoid stacking duplicate listeners when initGlobalUI is called repeatedly.
      midiBaseSel.onchange = onBaseChange;
      midiBaseSel.oninput = onBaseChange;
    }
    const mechSel = document.getElementById("globalMechSettingsSelect");
    if (mechSel) {
      mechSel.value = String(window.globalData.mechanicalSettings || 0);
    }
    const tempoInput = document.getElementById("globalTempo");
    if (tempoInput) {
      const bpm = (typeof window.globalData.tempo === "number" && !isNaN(window.globalData.tempo))
        ? window.globalData.tempo
        : 120.0;
      tempoInput.value = bpm.toFixed(1);
      // Avoid stacking duplicate listeners when initGlobalUI is called repeatedly.
      tempoInput.onblur = () => {
        const v = parseFloat(tempoInput.value);
        if (!isNaN(v)) tempoInput.value = v.toFixed(1);
      };
    }
    const extModeChk = document.getElementById("globalExtendedMode");
    if (extModeChk) {
      extModeChk.checked = !!window.globalData.extendedMode;
    }
    if (typeof window.globalData.flags === "number") {
      const flags = window.globalData.flags;
      const clockInChk = document.getElementById("globalClockIn");
      const transportInChk = document.getElementById("globalTransportIn");
      const clockOutChk = document.getElementById("globalClockOut");
      const transportOutChk = document.getElementById("globalTransportOut");
      if (clockInChk) {
        clockInChk.checked = !!(flags & (1 << window.FLAG_BITS.clockIn));
      }
      if (transportInChk) {
        transportInChk.checked = !(flags & (1 << window.FLAG_BITS.transportIn));
      }
      if (clockOutChk) {
        clockOutChk.checked = !!(flags & (1 << window.FLAG_BITS.clockOut));
      }
      if (transportOutChk) {
        transportOutChk.checked = !!(flags & (1 << window.FLAG_BITS.transportOut));
      }
    }
    const localChk = document.getElementById("globalLocalOn");
    if (localChk) {
      localChk.checked = !!window.globalData.localOn;
    }
    function clampRange(value, minVal, maxVal) {
      if (isNaN(value)) return minVal;
      return Math.max(minVal, Math.min(value, maxVal));
    }

    function setRangeWithLabel(inputId, value, displayId, minVal, maxVal) {
      const el = document.getElementById(inputId);
      if (!el) return;
      const v = clampRange(Number(value), minVal, maxVal);
      el.value = String(v);
      const out = document.getElementById(displayId);
      if (out) out.textContent = String(v);
    }

    function bindSelectToGlobal(selectId, key, minVal, maxVal) {
      const el = document.getElementById(selectId);
      if (!el) return;
      el.onchange = () => {
        const raw = parseInt(el.value, 10);
        const v = clampRange(Number.isFinite(raw) ? raw : minVal, minVal, maxVal);
        el.value = String(v);
        if (!window.globalData) window.globalData = {};
        window.globalData[key] = v;
      };
    }

    function bindRangeToGlobal(inputId, displayId, key, minVal, maxVal) {
      const el = document.getElementById(inputId);
      if (!el) return;
      const out = document.getElementById(displayId);
      const handler = () => {
        const raw = parseInt(el.value, 10);
        const v = clampRange(Number.isFinite(raw) ? raw : minVal, minVal, maxVal);
        el.value = String(v);
        if (out) out.textContent = String(v);
        if (!window.globalData) window.globalData = {};
        window.globalData[key] = v;
      };
      // Use property assignment to avoid stacking listeners across initGlobalUI calls.
      el.oninput = handler;
      el.onchange = handler;
    }
    const drumLeftSel = document.getElementById("globalDrumLeft");
    if (drumLeftSel) {
      const val = clampRange(window.globalData.drumLeft ?? 0, 0, 16);
      window.globalData.drumLeft = val;
      drumLeftSel.value = String(val);
      bindSelectToGlobal("globalDrumLeft", "drumLeft", 0, 16);
    }
    const gateLeft = document.getElementById("globalGateLeft");
    if (gateLeft) {
      setRangeWithLabel("globalGateLeft", window.globalData.gateLeft ?? 0, "globalGateLeftValue", 0, 127);
      bindRangeToGlobal("globalGateLeft", "globalGateLeftValue", "gateLeft", 0, 127);
    }
    const senseLeft = document.getElementById("globalSenseLeft");
    if (senseLeft) {
      setRangeWithLabel("globalSenseLeft", window.globalData.senseLeft ?? 0, "globalSenseLeftValue", 0, 127);
      bindRangeToGlobal("globalSenseLeft", "globalSenseLeftValue", "senseLeft", 0, 127);
    }
    const minLeft = document.getElementById("globalMinLevelLeft");
    if (minLeft) {
      setRangeWithLabel("globalMinLevelLeft", window.globalData.minLevelLeft ?? 0, "globalMinLevelLeftValue", 0, 127);
      bindRangeToGlobal("globalMinLevelLeft", "globalMinLevelLeftValue", "minLevelLeft", 0, 127);
    }
    const maxLeft = document.getElementById("globalMaxLevelLeft");
    if (maxLeft) {
      setRangeWithLabel("globalMaxLevelLeft", window.globalData.maxLevelLeft ?? 127, "globalMaxLevelLeftValue", 0, 127);
      bindRangeToGlobal("globalMaxLevelLeft", "globalMaxLevelLeftValue", "maxLevelLeft", 0, 127);
    }
    const drumRightSel = document.getElementById("globalDrumRight");
    if (drumRightSel) {
      const valR = clampRange(window.globalData.drumRight ?? 0, 0, 16);
      window.globalData.drumRight = valR;
      drumRightSel.value = String(valR);
      bindSelectToGlobal("globalDrumRight", "drumRight", 0, 16);
    }
    const gateRight = document.getElementById("globalGateRight");
    if (gateRight) {
      setRangeWithLabel("globalGateRight", window.globalData.gateRight ?? 0, "globalGateRightValue", 0, 127);
      bindRangeToGlobal("globalGateRight", "globalGateRightValue", "gateRight", 0, 127);
    }
    const senseRight = document.getElementById("globalSenseRight");
    if (senseRight) {
      setRangeWithLabel("globalSenseRight", window.globalData.senseRight ?? 0, "globalSenseRightValue", 0, 127);
      bindRangeToGlobal("globalSenseRight", "globalSenseRightValue", "senseRight", 0, 127);
    }
    const minRight = document.getElementById("globalMinLevelRight");
    if (minRight) {
      setRangeWithLabel("globalMinLevelRight", window.globalData.minLevelRight ?? 0, "globalMinLevelRightValue", 0, 127);
      bindRangeToGlobal("globalMinLevelRight", "globalMinLevelRightValue", "minLevelRight", 0, 127);
    }
    const maxRight = document.getElementById("globalMaxLevelRight");
    if (maxRight) {
      setRangeWithLabel("globalMaxLevelRight", window.globalData.maxLevelRight ?? 127, "globalMaxLevelRightValue", 0, 127);
      bindRangeToGlobal("globalMaxLevelRight", "globalMaxLevelRightValue", "maxLevelRight", 0, 127);
    }

    // Program Change controls: reflect *loaded* data (do not overwrite it).
    const pcSel = document.getElementById("globalProgramChangeSelect");
    if (pcSel) {
      let mode = window.globalData.programChangeMode;
      if (typeof mode !== "number" || isNaN(mode)) mode = 0;
      mode = Math.max(0, Math.min(3, mode));
      pcSel.value = String(mode);
    }
    const pcChanSel = document.getElementById("globalPcChannelSelect");
    if (pcChanSel) {
      let ch = window.globalData.programChangeChannel;
      if (typeof ch !== "number" || isNaN(ch)) ch = 0;
      ch = Math.max(0, Math.min(16, ch));
      pcChanSel.value = String(ch);
    }
    const trigSel = document.getElementById("globalTrigModeSelect");
    if (trigSel) {
      let tm = window.globalData.trigMode;
      if (typeof tm !== "number" || isNaN(tm)) tm = 0;
      tm = Math.max(0, Math.min(2, tm));
      trigSel.value = String(tm);
    }
    const clockInChk = document.getElementById("globalClockIn");
    const transportInChk = document.getElementById("globalTransportIn");
    const clockOutChk = document.getElementById("globalClockOut");
    const transportOutChk = document.getElementById("globalTransportOut");
    if (clockInChk)      clockInChk.onchange      = window.updateGlobalFlags;
    if (transportInChk)  transportInChk.onchange  = window.updateGlobalFlags;
    if (clockOutChk)     clockOutChk.onchange     = window.updateGlobalFlags;
    if (transportOutChk) transportOutChk.onchange = window.updateGlobalFlags;
    if (typeof window.globalData.flags === "number") {
      const flags = window.globalData.flags;
      if (clockInChk) {
        clockInChk.checked = !!(flags & (1 << window.FLAG_BITS.clockIn));
      }
      if (transportInChk) {
        transportInChk.checked = !(flags & (1 << window.FLAG_BITS.transportIn));
      }
      if (clockOutChk) {
        clockOutChk.checked = !!(flags & (1 << window.FLAG_BITS.clockOut));
      }
      if (transportOutChk) {
        transportOutChk.checked = !!(flags & (1 << window.FLAG_BITS.transportOut));
      }
    }

    // Keymap table is heavy; only populate when the Keymap details is open.
    const kmDetails = document.getElementById("globalKeymapDetails");
    if (kmDetails && kmDetails.open && typeof window.populateKeymapTable === "function") {
      window.populateKeymapTable();
    }
  };

  window.updateGlobalFlags = function () {
    let flags = 0;
    const clockInChk = document.getElementById("globalClockIn");
    const transportInChk = document.getElementById("globalTransportIn");
    const clockOutChk = document.getElementById("globalClockOut");
    const transportOutChk = document.getElementById("globalTransportOut");
    if (clockInChk?.checked) {
      flags |= 1 << window.FLAG_BITS.clockIn;
    }
    if (clockOutChk?.checked) {
      flags |= 1 << window.FLAG_BITS.clockOut;
    }
    if (transportOutChk?.checked) {
      flags |= 1 << window.FLAG_BITS.transportOut;
    }
    if (transportInChk && !transportInChk.checked) {
      flags |= 1 << window.FLAG_BITS.transportIn;
    }
    window.globalData.flags = flags;
  };

  window.saveGlobalSettings = function () {
    if (!window.globalData) {
      window.globalData = {};
    }
    const tempoEl = document.getElementById("globalTempo");
    let userBPM = 120;
    if (tempoEl) {
      const fVal = parseFloat(tempoEl.value);
      if (!isNaN(fVal)) userBPM = fVal;
    }
    window.globalData.tempo = userBPM;
    const mbSel = document.getElementById("globalMidiBaseSelect");
    if (mbSel) {
      let mbVal = parseInt(mbSel.value, 10) || 0;
      if (mbVal < 0) mbVal = 0;
      if (mbVal > 13) mbVal = 13;
      window.globalData.midiBase = mbVal;
    }
    const mechSel = document.getElementById("globalMechSettingsSelect");
    if (mechSel) {
      window.globalData.mechanicalSettings = parseInt(mechSel.value, 10) || 0;
    }
    const extChk = document.getElementById("globalExtendedMode");
    window.globalData.extendedMode = extChk?.checked ? 1 : 0;
    window.updateGlobalFlags();
    const locChk = document.getElementById("globalLocalOn");
    window.globalData.localOn = locChk?.checked ? 1 : 0;
    function clampVal(elId, min, max) {
      const el = document.getElementById(elId);
      if (!el) return 0;
      let v = parseInt(el.value, 10);
      if (isNaN(v)) v = 0;
      return Math.max(min, Math.min(v, max));
    }
    window.globalData.drumLeft       = clampVal("globalDrumLeft", 0, 16);
    window.globalData.gateLeft       = clampVal("globalGateLeft", 0, 127);
    window.globalData.senseLeft      = clampVal("globalSenseLeft", 0, 127);
    window.globalData.minLevelLeft   = clampVal("globalMinLevelLeft", 0, 127);
    window.globalData.maxLevelLeft   = clampVal("globalMaxLevelLeft", 0, 127);
    window.globalData.drumRight      = clampVal("globalDrumRight", 0, 16);
    window.globalData.gateRight      = clampVal("globalGateRight", 0, 127);
    window.globalData.senseRight     = clampVal("globalSenseRight", 0, 127);
    window.globalData.minLevelRight  = clampVal("globalMinLevelRight", 0, 127);
    window.globalData.maxLevelRight  = clampVal("globalMaxLevelRight", 0, 127);
    const pcSel = document.getElementById("globalProgramChangeSelect");
    if (pcSel) {
      window.globalData.programChangeMode = parseInt(pcSel.value, 10) || 0;
    }
    const pcChanSel = document.getElementById("globalPcChannelSelect");
    if (pcChanSel) {
      let uiVal = parseInt(pcChanSel.value, 10);
      if (isNaN(uiVal)) uiVal = 0;
      window.globalData.programChangeChannel = uiVal;
    }
    const trigSel = document.getElementById("globalTrigModeSelect");
    if (trigSel) {
      window.globalData.trigMode = parseInt(trigSel.value, 10) || 0;
    }
  };
})();

(() => {
  "use strict";
  window.MD_KEYMAP_FUNCTIONS = (() => {
    const arr = [];
    for (let val = 0x00; val <= 0x8F; val++) {
      arr.push(val);
    }
    arr.push(0x90, 0x91);
    return arr;
  })();
  window.drumStartIndex = 36;
  window.drumStep = 2;
  function midiNoteName(noteNum) {
    const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const note = noteNum % 12;
    const octave = Math.floor(noteNum / 12) - 1;
    return `${noteNames[note]}${octave}`;
  }
  window.mappingLabel = function (code) {
    if (code >= 0x00 && code <= 0x0F) {
      return `Track ${code + 1}`;
    } else if (code >= 0x10 && code <= 0x1F) {
      return `A${String(code - 0x10 + 1).padStart(2, "0")}`;
    } else if (code >= 0x20 && code <= 0x2F) {
      return `B${String(code - 0x20 + 1).padStart(2, "0")}`;
    } else if (code >= 0x30 && code <= 0x3F) {
      return `C${String(code - 0x30 + 1).padStart(2, "0")}`;
    } else if (code >= 0x40 && code <= 0x4F) {
      return `D${String(code - 0x40 + 1).padStart(2, "0")}`;
    } else if (code >= 0x50 && code <= 0x5F) {
      return `E${String(code - 0x50 + 1).padStart(2, "0")}`;
    } else if (code >= 0x60 && code <= 0x6F) {
      return `F${String(code - 0x60 + 1).padStart(2, "0")}`;
    } else if (code >= 0x70 && code <= 0x7F) {
      return `G${String(code - 0x70 + 1).padStart(2, "0")}`;
    } else if (code >= 0x80 && code <= 0x8F) {
      return `H${String(code - 0x80 + 1).padStart(2, "0")}`;
    } else if (code === 0x90) {
      return "TrigStart";
    } else if (code === 0x91) {
      return "TrigStop";
    }
    return `(?? ${code})`;
  };
  window.findNoteForMapping = function (mappingCode) {
    if (!window.globalData?.keymap) return -1;
    const km = window.globalData.keymap;
    for (let note = 0; note < 128; note++) {
      const val = km[note];
      if (val === mappingCode || val === (mappingCode | 0x80)) {
        return note;
      }
    }
    return -1;
  };
  window.populateKeymapTable = function () {
    const keymapTable = document.getElementById("globalKeymapTable");
    if (!keymapTable) return;
    const tbody = keymapTable.querySelector("tbody");
    tbody.innerHTML = "";

    // Ensure we always have a dense 128-byte keymap.
    const existing = window.globalData?.keymap;
    let km;
    if (!existing || typeof existing.length !== "number" || existing.length < 128) {
      km = new Uint8Array(128);
      km.fill(0x7F);
      if (existing && typeof existing === "object") {
        for (let i = 0; i < 128; i++) {
          const v = existing[i];
          if (v != null && !isNaN(v)) km[i] = v & 0xFF;
        }
      }
      window.globalData.keymap = km;
    } else if (!(existing instanceof Uint8Array)) {
      km = new Uint8Array(128);
      km.fill(0x7F);
      for (let i = 0; i < 128; i++) {
        const v = existing[i];
        if (v != null && !isNaN(v)) km[i] = v & 0xFF;
      }
      window.globalData.keymap = km;
    } else {
      km = existing;
    }
    window.MD_KEYMAP_FUNCTIONS.forEach((mappingCode) => {
      const row = document.createElement("tr");
      const tdMapping = document.createElement("td");
      tdMapping.textContent = window.mappingLabel(mappingCode);
      row.appendChild(tdMapping);
      const tdSelect = document.createElement("td");
      const sel = document.createElement("select");
      {
        const opt = document.createElement("option");
        opt.value = "-1";
        opt.textContent = "—";
        sel.appendChild(opt);
      }
      for (let note = 0; note < 128; note++) {
        const opt = document.createElement("option");
        opt.value = String(note);
        opt.textContent = `${note} (${midiNoteName(note)})`;
        sel.appendChild(opt);
      }
      const currentNote = window.findNoteForMapping(mappingCode);
      sel.value = currentNote >= 0 ? String(currentNote) : "-1";
      sel.onchange = function () {
        const newVal = parseInt(sel.value, 10);
        const oldNote = window.findNoteForMapping(mappingCode);
        if (oldNote >= 0) {
          km[oldNote] = 0x7F;
        }
        if (newVal < 0 || newVal > 127) return;
        const oldMapping = km[newVal];
        if (oldMapping !== 0x7F && oldMapping !== mappingCode) {
          km[newVal] = 0x7F;
        }
        km[newVal] = mappingCode;
      };
      tdSelect.appendChild(sel);
      row.appendChild(tdSelect);
      tbody.appendChild(row);
    });

    // Re-apply any active filter after rebuilding.
    if (typeof window.applyGlobalKeymapFilter === "function") {
      window.applyGlobalKeymapFilter();
    }
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  // Lazy-build the keymap table when the collapsible panel is opened.
  const kmDetails = document.getElementById("globalKeymapDetails");
  if (kmDetails) {
    kmDetails.addEventListener("toggle", () => {
      if (kmDetails.open && typeof window.populateKeymapTable === "function") {
        window.populateKeymapTable();
      }
    });
  }

  // Keymap filter (quality-of-life for long lists).
  const filterInput = document.getElementById("globalKeymapFilter");
  const clearBtn = document.getElementById("globalKeymapClearFilter");

  window.applyGlobalKeymapFilter = () => {
    const table = document.getElementById("globalKeymapTable");
    if (!table) return;
    const q = (filterInput?.value || "").trim().toLowerCase();
    const rows = table.querySelectorAll("tbody tr");
    rows.forEach((row) => {
      const label = row?.cells?.[0]?.textContent?.toLowerCase?.() || "";
      row.style.display = !q || label.includes(q) ? "" : "none";
    });
  };

  if (filterInput) {
    filterInput.addEventListener("input", () => {
      window.applyGlobalKeymapFilter();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (filterInput) {
        filterInput.value = "";
        filterInput.focus();
      }
      window.applyGlobalKeymapFilter();
    });
  }
});
