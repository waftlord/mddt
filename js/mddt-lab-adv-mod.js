(function(){
  "use strict";

  /**************************************
   * HELPER: RANGE SLIDER ROW CREATION
   **************************************/
  function createRangeSliderRow(labelText, id, startVal, endVal, min, max, step, formatFn) {
    const row = document.createElement("div");
    row.style.marginBottom = "12px";

    const label = document.createElement("label");
    // Center the label above the slider for better visual alignment.
    label.style.display = "block";
    label.style.textAlign = "center";
    const displayStart = formatFn ? formatFn(startVal) : startVal;
    const displayEnd = formatFn ? formatFn(endVal) : endVal;
    label.textContent = labelText + " " + displayStart + " - " + displayEnd;
    row.appendChild(label);

    const sliderContainer = document.createElement("div");
    sliderContainer.id = id + "_slider";
    // Center the slider itself (max-width is capped via CSS).
    sliderContainer.style.margin = "8px auto";
    sliderContainer.className = "lab-slider";
    row.appendChild(sliderContainer);

    const hiddenInput = document.createElement("input");
    hiddenInput.type = "hidden";
    hiddenInput.id = id;
    hiddenInput.value = startVal + "," + endVal;
    hiddenInput.dataset.defaultValue = hiddenInput.value;
    row.appendChild(hiddenInput);

    noUiSlider.create(sliderContainer, {
      start: [startVal, endVal],
      connect: true,
      step: step,
      range: { min: min, max: max }
    });
    sliderContainer.noUiSlider.on('update', function (values) {
      hiddenInput.value = values.join(",");
      const disp0 = formatFn ? formatFn(parseFloat(values[0])) : values[0];
      const disp1 = formatFn ? formatFn(parseFloat(values[1])) : values[1];
      label.textContent = labelText + " " + disp0 + " - " + disp1;
    });
    return row;
  }

  /**************************************
   * ADVANCED LAB MODULES – TONAL TUNING & SEED VARIATION
   **************************************/

  function patternSlotLabel(index) {
    let row = Math.floor(index / 16);
    let col = (index % 16) + 1;
    let letter = String.fromCharCode(65 + row); // 65 = "A"
    return letter + (col < 10 ? "0" + col : col);
  }
  function kitSlotLabel(index) {
    return "Kit " + (index < 10 ? "0" + index : index);
  }

  window.advancedLabState = window.advancedLabState || {
    tonalTuning: {
      machineIDs: [],
      scaleType: "12TET",
      customScaleArray: "",
      rootNote: "C",
      octave: 2,
      applyToKits: true,
      applyToPatterns: true,
      octaveSpread: 0,
      scaleArray: [0,4,8,10,14,18,22]
    },
    seedVariation: {
      kitSeedSlot: 0,
      patternSeedSlot: 0,
      songSeedSlot: 0,
      variationAmount: 50,
      distribution: "uniform",
      gaussianSigmaFactor: 3,
      seedValue: null
    },
    machineImplanter: {
      kitRange:         [1, 64],
      trackMachineIDs:  Array(16).fill(null),
      trackTriggers:    Array(16).fill().map(() => ({ self: false, near: false, far: false }))
    }
  };


  // Ensure defaults exist even when advancedLabState was created by an older build / saved state.
  (function ensureAdvancedLabDefaults() {
    const st = window.advancedLabState = window.advancedLabState || {};

    const tt = st.tonalTuning = st.tonalTuning || {};
    if (!Array.isArray(tt.machineIDs)) tt.machineIDs = [];
    if (typeof tt.scaleType !== "string") tt.scaleType = "12TET";
    if (typeof tt.customScaleArray !== "string") tt.customScaleArray = "";
    if (typeof tt.rootNote !== "string") tt.rootNote = "C";
    if (!Number.isFinite(tt.octave)) tt.octave = 2;
    if (typeof tt.applyToKits !== "boolean") tt.applyToKits = true;
    if (typeof tt.applyToPatterns !== "boolean") tt.applyToPatterns = true;
    if (!Number.isFinite(tt.octaveSpread)) tt.octaveSpread = 0;

    if (!Array.isArray(tt.scaleArray) || !tt.scaleArray.length) tt.scaleArray = [0,4,8,10,14,18,22];

    // Upgrade legacy semitone scales to quarter-tone offsets (heuristic).
    // (Older builds stored 12TET scales as semitone offsets like 0,2,4,5,7,9,11)
    try {
      const nums = tt.scaleArray
        .map(v => parseInt(v, 10))
        .filter(n => Number.isFinite(n));
      const max = nums.length ? Math.max.apply(null, nums) : NaN;
      if (Number.isFinite(max) && max <= 12) {
        tt.scaleArray = nums.map(v => (v | 0) * 2);
      } else {
        tt.scaleArray = nums.length ? nums : tt.scaleArray;
      }
    } catch (_) {}

    const sv = st.seedVariation = st.seedVariation || {};
    if (!Number.isFinite(sv.kitSeedSlot)) sv.kitSeedSlot = 0;
    if (!Number.isFinite(sv.patternSeedSlot)) sv.patternSeedSlot = 0;
    if (!Number.isFinite(sv.songSeedSlot)) sv.songSeedSlot = 0;
    if (!Number.isFinite(sv.variationAmount)) sv.variationAmount = 50;
    if (typeof sv.distribution !== "string") sv.distribution = "uniform";
    if (!Number.isFinite(sv.gaussianSigmaFactor)) sv.gaussianSigmaFactor = 3;
    if (sv.seedValue == null) sv.seedValue = null;
})();

/*********************
   * 1) TONAL TUNING
   *********************/

  const KEY_MAPPING_24 = {
    "C": 0,    "C+": 1,   "C#": 2,  "Db": 2,
    "D-": 3,   "D": 4,    "D+": 5,  "D#": 6,  "Eb": 6,
    "E-": 7,   "E": 8,    "E+": 9,
    "F": 10,   "F+": 11,  "F#": 12, "Gb": 12,
    "G-": 13,  "G": 14,   "G+": 15, "G#": 16, "Ab": 16,
    "A-": 17,  "A": 18,   "A+": 19, "A#": 20, "Bb": 20,
    "B-": 21,  "B": 22,   "B+": 23
  };

  function generateTETScale(scaleType) {
    if (scaleType === "12TET") {
      let arr = [];
      for (let i = 0; i <= 12; i++) {
        arr.push(i * 2);
      }
      return arr;
    }
    if (scaleType === "24TET") {
      let arr = [];
      for (let i = 0; i <= 24; i++) {
        arr.push(i);
      }
      return arr;
    }
    return [];
  }

  function buildFullScaleArray(baseRoot, scaleFrag) {
    let final = [];
    for (let oct = -4; oct <= 4; oct++) {
      const octOffset = oct * 24;
      for (let s of scaleFrag) {
        let pitch = baseRoot + octOffset + s;
        if (pitch >= 0 && pitch <= 127) final.push(pitch);
      }
    }
    final.sort((a, b) => a - b);
    return final.filter((v, i, arr) => i === 0 || arr[i - 1] !== v);
  }

  function getRootQuarterToneOffset(note, octave) {
    let offset = KEY_MAPPING_24[note] !== undefined ? KEY_MAPPING_24[note] : 18;
    offset += (octave * 24);
    return Math.max(0, Math.min(127, offset));
  }

  function findClosestInArray(val, arr) {
    let best = arr[0], bestDist = Math.abs(val - arr[0]);
    for (let i = 1; i < arr.length; i++) {
      let d = Math.abs(val - arr[i]);
      if (d < bestDist) { bestDist = d; best = arr[i]; }
    }
    return best;
  }

  function snapToScale(value, targetScale) {
    return findClosestInArray(value, targetScale);
  }

  // -----------------------------
  // TONAL MASK / TUNING HELPERS
  // -----------------------------

  function _csvToIntArray(str) {
    if (!str || typeof str !== "string") return [];
    return str
      .split(",")
      .map(s => parseInt(String(s).trim(), 10))
      .filter(n => Number.isFinite(n));
  }

  function _normalizeIntArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return [];
    return arr
      .map(v => parseInt(v, 10))
      .filter(n => Number.isFinite(n));
  }

  function _getTonalScaleFragment(tonalState) {
    const st = tonalState || {};
    // Custom scale overrides any predefined scale selection
    const custom = _csvToIntArray(st.customScaleArray);
    if (custom.length) return custom;

    if (Array.isArray(st.scaleArray) && st.scaleArray.length) return _normalizeIntArray(st.scaleArray);

    // Fallback to chromatic
    return generateTETScale(st.scaleType || "12TET");
  }

  function _getTonalFullScale(tonalState) {
    const st = tonalState || {};
    const scaleFrag = _getTonalScaleFragment(st);
    const baseOffset = getRootQuarterToneOffset(
      st.rootNote || "C",
      Number.isFinite(st.octave) ? st.octave : 2
    );
    return buildFullScaleArray(baseOffset, scaleFrag);
  }

  // Track eligibility:
  // - If machineIDs filter is provided, use it (even if Tonal flag is off).
  // - Otherwise, default to Kit's Tonal flags.
  function _shouldApplyTonalToKitTrack(kitObj, trackIndex, machineIDs) {
    if (!kitObj) return false;
    const t = trackIndex | 0;
    const ids = Array.isArray(machineIDs) ? machineIDs : [];
    if (ids.length > 0) {
      const mID = (kitObj.machineAssignments && kitObj.machineAssignments[t] != null)
        ? (kitObj.machineAssignments[t] | 0)
        : null;
      return (mID != null) && ids.includes(mID);
    }
    return !!(kitObj.machineTonalFlags && kitObj.machineTonalFlags[t]);
  }

  function _getKitDataForPattern(patternObj) {
    const kIdx = (patternObj && Number.isFinite(patternObj.assignedKitNumber))
      ? (patternObj.assignedKitNumber | 0)
      : null;
    if (kIdx == null || kIdx < 0 || kIdx > 63) return null;
    const wrap = (window.kitLibrary && window.kitLibrary[kIdx]) ? window.kitLibrary[kIdx] : null;
    return (wrap && wrap.data) ? wrap.data : null;
  }

    function applyTonalTuningToKit(kitObj, userScale, userMachineIDs) {
    if (!kitObj || !kitObj.machineParams) return 0;

    const tonalState = (window.advancedLabState && window.advancedLabState.tonalTuning)
      ? window.advancedLabState.tonalTuning
      : {};

    const machineIDs = _normalizeIntArray(
      (Array.isArray(userMachineIDs) && userMachineIDs.length)
        ? userMachineIDs
        : (Array.isArray(tonalState.machineIDs) ? tonalState.machineIDs : [])
    );

    const fullScale = _getTonalFullScale(tonalState);

    let changed = 0;
    for (let t = 0; t < 16; t++) {
      if (!_shouldApplyTonalToKitTrack(kitObj, t, machineIDs)) continue;

      const params = kitObj.machineParams[t];
      if (!params || params.length < 1) continue;

      const cur = params[0] & 0x7F;
      const next = snapToScale(cur, fullScale) & 0x7F;
      if (next !== cur) changed++;
      params[0] = next;
    }
    return changed;
  }

    function applyTonalTuningToPattern(patternObj, userScale, userMachineIDs) {
    if (!patternObj || !Array.isArray(patternObj.locks) || !patternObj.locks.length) return 0;

    const tonalState = (window.advancedLabState && window.advancedLabState.tonalTuning)
      ? window.advancedLabState.tonalTuning
      : {};

    const machineIDs = _normalizeIntArray(
      (Array.isArray(userMachineIDs) && userMachineIDs.length)
        ? userMachineIDs
        : (Array.isArray(tonalState.machineIDs) ? tonalState.machineIDs : [])
    );

    const fullScale = _getTonalFullScale(tonalState);

    // Try to resolve the pattern's assigned kit so we can respect Tonal flags / machine filters.
    const kitObj = _getKitDataForPattern(patternObj);

    let changed = 0;
    for (let i = 0; i < patternObj.locks.length; i++) {
      const lk = patternObj.locks[i];
      if (!lk || lk.paramID !== 1) continue; // paramID 1 = first machine param (usually PTCH)

      const tr = (lk.track != null) ? (lk.track | 0) : -1;

      // If we have kit context, apply the same track eligibility as kits.
      // If we don't, fall back to "best effort" behaviour:
      //   - with no machine filter: snap all paramID=1 locks
      //   - with a machine filter: skip (we can't know which track uses which machine)
      if (kitObj) {
        if (!_shouldApplyTonalToKitTrack(kitObj, tr, machineIDs)) continue;
      } else if (machineIDs.length > 0) {
        continue;
      }

      const cur = lk.paramVal & 0x7F;
      const next = snapToScale(cur, fullScale) & 0x7F;
      if (next !== cur) changed++;
      lk.paramVal = next;
    }
    return changed;
  }

  /*********************
   * 2) SEED VARIATION
   *********************/

  function initSeededRandom(seedValue) {
    function mulberry32(a) {
      return function() {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    window._seededRandom = mulberry32(seedValue);
  }

  function randomGaussian(rand) {
    rand = rand || Math.random;
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function getSeedVariationParams() {
    const st = window.advancedLabState.seedVariation || {};
    return {
      distribution: st.distribution || "uniform",
      gaussianSigmaFactor: st.gaussianSigmaFactor || 3
    };
  }

    function morphValueFromSeed(seedVal, variationAmount) {
    const { distribution, gaussianSigmaFactor } = getSeedVariationParams();
    const rand = (typeof window._seededRandom === "function") ? window._seededRandom : Math.random;

    const base = Number(seedVal);
    const vAmt = Math.max(0, Math.min(100, Number(variationAmount)));

    // If the source value is missing / invalid, treat it as 0 (safe 7-bit default).
    const seed = Number.isFinite(base) ? base : 0;

    const factor = vAmt / 100;
    const maxOffset = 64 * factor;

    const sigma = (Number.isFinite(gaussianSigmaFactor) && gaussianSigmaFactor > 0)
      ? gaussianSigmaFactor
      : 3;

    const offset = (distribution === "gaussian")
      ? randomGaussian(rand) * (maxOffset / sigma)
      : (rand() * 2 - 1) * maxOffset;

    const newVal = Math.round(seed + offset);
    return Math.max(0, Math.min(127, newVal));
  }

    function generateKitFromSeed(seedKit, slotIndex, variationAmt) {
    if (!seedKit) return null;

    let newKit;
    try {
      newKit = (typeof structuredClone === "function")
        ? structuredClone(seedKit)
        : JSON.parse(JSON.stringify(seedKit));
    } catch (_) {
      newKit = JSON.parse(JSON.stringify(seedKit));
    }

    for (let t = 0; t < 16; t++) {
      for (let p = 0; p < 8; p++) {
        if (newKit.machineParams && newKit.machineParams[t]) {
          newKit.machineParams[t][p] = morphValueFromSeed(seedKit.machineParams?.[t]?.[p], variationAmt);
        }
        if (newKit.trackFx && newKit.trackFx[t]) {
          newKit.trackFx[t][p] = morphValueFromSeed(seedKit.trackFx?.[t]?.[p], variationAmt);
        }
        if (newKit.routing && newKit.routing[t]) {
          newKit.routing[t][p] = morphValueFromSeed(seedKit.routing?.[t]?.[p], variationAmt);
        }
      }

      if (newKit.trackLevels) {
        newKit.trackLevels[t] = morphValueFromSeed(seedKit.trackLevels?.[t], variationAmt);
      }
    }

    // LFO blocks (36 bytes per track)
    // NOTE: Some bytes are categorical / small-range fields (dest track, dest param, mode, wave shapes).
    // If these exceed the Machinedrum's valid ranges, the unit can become unstable.
    // The main app UI always clamps these; Seed Morph must do the same.
    if (!newKit.lfoBlocks) {
      newKit.lfoBlocks = Array.from({ length: 16 }, () => new Uint8Array(36));
    }
    for (let t = 0; t < 16; t++) {
      const seedBlock = padOrSlice(seedKit.lfoBlocks?.[t] || [], 36);

      // Ensure a 36-byte container
      const outBlock = newKit.lfoBlocks[t];
      if (!(outBlock instanceof Uint8Array) || outBlock.length !== 36) {
        newKit.lfoBlocks[t] = new Uint8Array(36);
      }

      const waveMax = (window.MD_LFO_WAVE_COUNT ? (window.MD_LFO_WAVE_COUNT - 1) : 10);
      for (let i = 0; i < 36; i++) {
        let v = morphValueFromSeed(seedBlock?.[i], variationAmt) & 0x7F;

        // --- categorical clamps ---
        if (i === 0) v = Math.max(0, Math.min(15, v));          // LFO Dest Track
        else if (i === 1) v = Math.max(0, Math.min(23, v));     // LFO Dest Param (0..23)
        else if (i === 2 || i === 3) v = Math.max(0, Math.min(waveMax, v)); // Wave shapes
        else if (i === 4) v = Math.max(0, Math.min(2, v));      // Mode (FREE/TRIG/HOLD)

        newKit.lfoBlocks[t][i] = v & 0x7F;
      }
    }

    // Master FX: 32 params
    if (newKit.masterFx) {
      for (let i = 0; i < 32; i++) {
        newKit.masterFx[i] = morphValueFromSeed(seedKit.masterFx?.[i], variationAmt);
      }
    }

    // Stamp name/position; commit via the app's slot system so metadata stays consistent.
    newKit.sysexPosition = slotIndex;
    newKit.kitName = ("SEEDKIT" + (slotIndex + 1)).split("");

    if (typeof window.writeKitSlot === "function") {
      window.writeKitSlot(slotIndex, newKit, { sendToMD: false, silent: true });
    } else {
      window.kitLibrary[slotIndex] = { data: newKit, colorIndex: slotIndex };
    }

    return newKit;
  }

    function generatePatternFromSeed(seedPattern, slotIndex, variationAmt) {
    if (!seedPattern) return null;

    let newPat;
    try {
      newPat = (typeof structuredClone === "function")
        ? structuredClone(seedPattern)
        : JSON.parse(JSON.stringify(seedPattern));
    } catch (_) {
      newPat = JSON.parse(JSON.stringify(seedPattern));
    }

    // Modify existing locks
    if (Array.isArray(newPat.locks)) {
      for (let i = 0; i < newPat.locks.length; i++) {
        const lk = newPat.locks[i];
        if (!lk) continue;
        lk.paramVal = morphValueFromSeed(lk.paramVal, variationAmt);
      }
    }

    // Possibly flip some trig bits, accent bits, etc
    const rand = (typeof window._seededRandom === "function") ? window._seededRandom : Math.random;
    const factor = variationAmt / 100;
    const baseFlipProb = (variationAmt < 75) ? factor * 0.1 : factor * 0.3;
    const length = newPat.length || 16;

    for (let t = 0; t < 16; t++) {
      const trigArr = newPat.trigBitsPerTrack?.[t] || [];
      const accentArr = newPat.accentBitsPerTrack?.[t] || [];
      const swingArr = newPat.swingBitsPerTrack?.[t] || [];
      const slideArr = newPat.slideBitsPerTrack?.[t] || [];

      for (let step = 0; step < length; step++) {
        if (rand() < baseFlipProb) {
          const byteIndex = Math.floor(step / 8);
          const bitMask = 1 << (step % 8);
          trigArr[byteIndex] = (trigArr[byteIndex] ^ bitMask) & 0xFF;
        }
        if (rand() < baseFlipProb * 0.5) {
          const byteIndex = Math.floor(step / 8);
          const bitMask = 1 << (step % 8);
          accentArr[byteIndex] = (accentArr[byteIndex] ^ bitMask) & 0xFF;
        }
        if (rand() < baseFlipProb * 0.5) {
          const byteIndex = Math.floor(step / 8);
          const bitMask = 1 << (step % 8);
          swingArr[byteIndex] = (swingArr[byteIndex] ^ bitMask) & 0xFF;
        }
        if (rand() < baseFlipProb * 0.5) {
          const byteIndex = Math.floor(step / 8);
          const bitMask = 1 << (step % 8);
          slideArr[byteIndex] = (slideArr[byteIndex] ^ bitMask) & 0xFF;
        }
      }

      if (newPat.trigBitsPerTrack) newPat.trigBitsPerTrack[t] = trigArr;
      if (newPat.accentBitsPerTrack) newPat.accentBitsPerTrack[t] = accentArr;
      if (newPat.swingBitsPerTrack) newPat.swingBitsPerTrack[t] = swingArr;
      if (newPat.slideBitsPerTrack) newPat.slideBitsPerTrack[t] = slideArr;
    }

    // Morph pattern-level settings
    newPat.accentAmount = morphValueFromSeed(newPat.accentAmount, variationAmt);
    newPat.swingAmount = morphValueFromSeed(newPat.swingAmount, variationAmt);
    newPat.slideAmount = morphValueFromSeed(newPat.slideAmount, variationAmt);

    // More drastic changes for large variation
    if (variationAmt >= 75) {
      // Possibly shift pattern length, etc
      const oldLen = newPat.length || 16;
      const newLen = clampPatternLength(oldLen + (Math.floor(rand() * 9) - 4));
      newPat.length = newLen;
    }

    // Ensure length is legal for the connected MD model (MKI = 32 max)
    newPat.length = clampPatternLength(newPat.length || 16);

    // Tag pattern
    newPat.isClean = true;
    newPat.origPos = slotIndex;
    newPat.patternNumber = slotIndex;

    // Store it
    if (window.writePatternSlot) {
      window.writePatternSlot(slotIndex, newPat, { sendToMD: false, silent: true });
    } else {
      window.allPatternSlots[slotIndex] = {
        pattern: newPat,
        kit: null,
        kitColorIndex: newPat.assignedKitNumber || 0
      };
    }

    return newPat;
  }

  function clampPatternLength(newLen) {
    return window.mdModel === "MKI"
      ? Math.min(Math.max(2, newLen), 32)
      : Math.min(Math.max(2, newLen), 64);
  }

    function generateSongFromSeed(seedSong, slotIndex, variationAmt) {
    if (!seedSong) return null;

    let newSong;
    try {
      newSong = (typeof structuredClone === "function")
        ? structuredClone(seedSong)
        : JSON.parse(JSON.stringify(seedSong));
    } catch (_) {
      newSong = JSON.parse(JSON.stringify(seedSong));
    }

    // possibly morph BPM if desired
    const doBPM = window.advancedLabState.seedVariation.morphBPM;
    if (doBPM) {
      newSong.bpm = morphValueFromSeed(seedSong.bpm, variationAmt);
    }

    // adjust row repeats, maybe random pattern changes
    const rand = (typeof window._seededRandom === "function") ? window._seededRandom : Math.random;
    const factor = variationAmt / 100;
    for (let r = 0; r < newSong.rows.length; r++) {
      const rowData = newSong.rows[r];
      if (!rowData) continue;

      // Morph repeats
      if (rowData[1] != null) {
        rowData[1] = Math.max(1, Math.min(64, morphValueFromSeed(rowData[1], variationAmt)));
      }

      // Possibly change pattern
      if (rand() < factor * 0.1) {
        rowData[0] = Math.floor(rand() * 128) & 0x7F;
      }
    }

    // store
    newSong.songName = ("SEEDSONG" + (slotIndex + 1)).split("");
    window.allSongSlots[slotIndex] = newSong;

    return newSong;
  }

  function clampSongRepeats(val)  { return Math.max(0, Math.min(99, val)); }
  function clampSongOffset(val)   {
    let max = window.mdModel === "MKI" ? 30 : 62;
    return Math.max(0, Math.min(max, val));
  }
  function clampSongLength(val) {
    let max = window.mdModel === "MKI" ? 32 : 64;
    return Math.max(2, Math.min(max, val));
  }
  function clampSongMuteTrig(val) {
    return val < 0 ? 0 : val > 16 ? 16 : val;
  }

  /*********************
   * BUILD UI PANELS – ADVANCED MODULES (ONLY TONAL & SEED)
   *********************/

  function createInputRow(labelText, inputType, inputId, defaultValue, extraAttrs) {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "flex-start";
    wrapper.style.marginBottom = "8px";

    const lbl = document.createElement("label");
    lbl.textContent = labelText;
    lbl.style.fontSize = "0.8em";
    lbl.style.marginBottom = "4px";
    wrapper.appendChild(lbl);

    const inp = document.createElement("input");
    inp.type = inputType;
    inp.id = inputId;
    inp.value = defaultValue;
    if (extraAttrs && typeof extraAttrs === "object") {
      for (let [k, v] of Object.entries(extraAttrs)) {
        inp.setAttribute(k, v);
      }
    }
    wrapper.appendChild(inp);
    return wrapper;
  }

  // =========================================================
// ADVANCED MODULES → TOP-LEVEL LAB TABS (MMDT-STYLE)
// =========================================================
// These used to be contained inside the single "Advanced" tab.
// We now register each as its own Lab tab for faster access.

function createAdvancedGridContainer() {
  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(4, 1fr)";
  grid.style.gap = "10px";
  grid.style.width = "100%";
  return grid;
}

function buildTonalMaskModuleEl() {

  const st = window.advancedLabState.tonalTuning;

  // -------------------------------
  // UI helpers
  // -------------------------------
  function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if ((a[i] | 0) !== (b[i] | 0)) return false;
    }
    return true;
  }

  function resetRangeSlider(hiddenId) {
    const hidden = document.getElementById(hiddenId);
    const slider = document.getElementById(hiddenId + "_slider");
    if (!hidden || !slider || !slider.noUiSlider) return;
    const def = hidden.dataset.defaultValue || hidden.value;
    if (!def) return;
    slider.noUiSlider.set(def.split(",").map(v => parseInt(v, 10)));
  }

  // -------------------------------
  // Container
  // -------------------------------
  const content = document.createElement("div");
  content.classList.add("lab-module-inner");

  const tonalGrid = createAdvancedGridContainer();

  // -------------------------------
  // Predefined scales
  // -------------------------------
  const predefinedScales = {
    "Major (12TET)":        [0, 2, 4, 5, 7, 9, 11].map(x => x * 2),
    "Minor (12TET)":        [0, 2, 3, 5, 7, 8, 10].map(x => x * 2),
    "Dorian (12TET)":       [0, 2, 3, 5, 7, 9, 10].map(x => x * 2),
    "Mixolydian (12TET)":   [0, 2, 4, 5, 7, 9, 10].map(x => x * 2),
    "Phrygian (12TET)":     [0, 1, 3, 5, 7, 8, 10].map(x => x * 2),
    "Lydian (12TET)":       [0, 2, 4, 6, 7, 9, 11].map(x => x * 2),
    "Locrian (12TET)":      [0, 1, 3, 5, 6, 8, 10].map(x => x * 2),
    "Harmonic Minor (12TET)": [0,2,3,5,7,8,11].map(x => x * 2),
    "Melodic Minor (12TET)":  [0,2,3,5,7,9,11].map(x => x * 2),

    "Major Pent (12TET)":   [0, 2, 4, 7, 9].map(x => x * 2),
    "Minor Pent (12TET)":   [0, 3, 5, 7, 10].map(x => x * 2),
    "Blues (12TET)":        [0, 3, 5, 6, 7, 10].map(x => x * 2),
    "Whole Tone (12TET)":   [0, 2, 4, 6, 8, 10].map(x => x * 2),

    "Chromatic (12TET)":    generateTETScale("12TET"),
    "Chromatic (24TET)":    generateTETScale("24TET"),

    // Example microtonal-ish scales
    "Quarter Major (24TET)": [0,4,8,10,14,18,22],
    "Quarter Minor (24TET)": [0,4,6,10,14,16,20]
  };

  const scaleNames = Object.keys(predefinedScales);

  // -------------------------------
  // Machine IDs filter (optional)
  // -------------------------------
  const midInput = document.createElement("input");
  midInput.type = "text";
  midInput.placeholder = "e.g. 1,4,5 (leave blank = use Tonal flags)";
  midInput.value = (Array.isArray(st.machineIDs) && st.machineIDs.length) ? st.machineIDs.join(",") : "";
  midInput.addEventListener("input", () => {
    const arr = midInput.value
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    st.machineIDs = arr;
  });
  addControlToGrid(tonalGrid, "Machine IDs", midInput);

  // -------------------------------
  // Root note (24TET list)
  // -------------------------------
  const rootNotes24TET = [
    "C","C+","C#","D-","D","D+","D#","E-","E","E+",
    "F","F+","F#","G-","G","G+","G#","A-","A","A+",
    "A#","B-","B","B+"
  ];
  const rootSelect = document.createElement("select");
  rootNotes24TET.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    rootSelect.appendChild(opt);
  });
  rootSelect.value = rootNotes24TET.includes(st.rootNote) ? st.rootNote : "C";
  rootSelect.onchange = () => {
    st.rootNote = rootSelect.value;
  };
  addControlToGrid(tonalGrid, "Root Note", rootSelect);

  // -------------------------------
  // Scale select (preset)
  // -------------------------------
  const scaleSelect = document.createElement("select");
  scaleNames.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    scaleSelect.appendChild(opt);
  });

  // Try to restore last selection (or infer from current scaleArray)
  let initialScaleName = (typeof st.scaleName === "string" && predefinedScales[st.scaleName])
    ? st.scaleName
    : null;
  if (!initialScaleName) {
    const cur = Array.isArray(st.scaleArray) ? st.scaleArray.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n)) : [];
    initialScaleName = scaleNames.find(nm => arraysEqual(predefinedScales[nm], cur)) || "Major (12TET)";
  }
  scaleSelect.value = initialScaleName;
  st.scaleName = initialScaleName;
  st.scaleArray = predefinedScales[initialScaleName];

  scaleSelect.onchange = () => {
    const choice = scaleSelect.value;
    st.scaleName = choice;
    st.scaleArray = predefinedScales[choice];

    // Choosing a preset should take effect immediately, so clear any custom override.
    st.customScaleArray = "";
    customScaleInput.value = "";
  };
  addControlToGrid(tonalGrid, "Scale", scaleSelect);

  // -------------------------------
  // Octave
  // -------------------------------
  const octInp = document.createElement("input");
  octInp.type = "number";
  octInp.min = "0";
  octInp.max = "5";
  octInp.value = String(Number.isFinite(st.octave) ? st.octave : 2);
  octInp.onchange = () => {
    st.octave = parseInt(octInp.value, 10) || 0;
  };
  addControlToGrid(tonalGrid, "Octave", octInp);

  // -------------------------------
  // Apply to kits / patterns
  // -------------------------------
  const applyToKitsCb = document.createElement("input");
  applyToKitsCb.type = "checkbox";
  applyToKitsCb.checked = !!st.applyToKits;
  applyToKitsCb.onchange = () => st.applyToKits = applyToKitsCb.checked;
  addControlToGrid(tonalGrid, "Apply to Kits", applyToKitsCb);

  const applyToPatternsCb = document.createElement("input");
  applyToPatternsCb.type = "checkbox";
  applyToPatternsCb.checked = !!st.applyToPatterns;
  applyToPatternsCb.onchange = () => st.applyToPatterns = applyToPatternsCb.checked;
  addControlToGrid(tonalGrid, "Apply to Patterns", applyToPatternsCb);

  // -------------------------------
  // Custom scale (overrides preset)
  // -------------------------------
  const customScaleInput = document.createElement("input");
  customScaleInput.type = "text";
  customScaleInput.placeholder = "Comma-separated quarter-tones, e.g. 0,4,8,10,14,18,22";
  customScaleInput.value = (typeof st.customScaleArray === "string") ? st.customScaleArray : "";
  customScaleInput.addEventListener("input", () => {
    st.customScaleArray = customScaleInput.value;
  });
  addControlToGrid(tonalGrid, "Custom Scale (optional)", customScaleInput);

  // -------------------------------
  // Custom scale presets
  // -------------------------------
  const savedPresets = JSON.parse(localStorage.getItem("tonalScalePresets") || "{}");
  const presetsContainer = document.createElement("div");
  presetsContainer.style.display = "flex";
  presetsContainer.style.flexWrap = "wrap";
  presetsContainer.style.gap = "6px";
  presetsContainer.style.alignItems = "center";

  const presetSelect = document.createElement("select");
  const presetOptDefault = document.createElement("option");
  presetOptDefault.value = "";
  presetOptDefault.textContent = "-- Custom Presets --";
  presetSelect.appendChild(presetOptDefault);

  Object.keys(savedPresets).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  });

  presetSelect.onchange = () => {
    const name = presetSelect.value;
    if (!name) return;
    st.customScaleArray = savedPresets[name] || "";
    customScaleInput.value = st.customScaleArray;
  };

  const presetNameInput = document.createElement("input");
  presetNameInput.type = "text";
  presetNameInput.placeholder = "Preset name";

  const savePresetBtn = document.createElement("button");
  savePresetBtn.textContent = "Save Custom";
  savePresetBtn.onclick = () => {
    const name = presetNameInput.value.trim();
    if (!name) {
      alert("Enter a preset name.");
      return;
    }
    const data = st.customScaleArray || "";
    if (!data.trim()) {
      alert("Custom scale is empty.");
      return;
    }
    savedPresets[name] = data;
    localStorage.setItem("tonalScalePresets", JSON.stringify(savedPresets));
    // refresh select list
    presetSelect.innerHTML = "";
    presetSelect.appendChild(presetOptDefault);
    Object.keys(savedPresets).forEach(nm => {
      const opt = document.createElement("option");
      opt.value = nm;
      opt.textContent = nm;
      presetSelect.appendChild(opt);
    });
    presetNameInput.value = "";
    alert("Saved custom scale preset: " + name);
  };

  const deletePresetBtn = document.createElement("button");
  deletePresetBtn.textContent = "Delete Preset";
  deletePresetBtn.onclick = () => {
    const name = presetSelect.value;
    if (!name) {
      alert("Pick a preset first.");
      return;
    }
    if (!confirm("Delete preset: " + name + "?")) return;
    delete savedPresets[name];
    localStorage.setItem("tonalScalePresets", JSON.stringify(savedPresets));
    presetSelect.remove(presetSelect.selectedIndex);
    presetSelect.value = "";
    alert("Deleted preset: " + name);
  };

  presetsContainer.appendChild(presetSelect);
  presetsContainer.appendChild(presetNameInput);
  presetsContainer.appendChild(savePresetBtn);
  presetsContainer.appendChild(deletePresetBtn);

  addControlToGrid(tonalGrid, "Presets", presetsContainer);

  // -------------------------------
  // Ranges
  // -------------------------------
  if (!Array.isArray(st.kitRange) || st.kitRange.length !== 2) st.kitRange = [1, 64];
  if (!Array.isArray(st.patternRange) || st.patternRange.length !== 2) st.patternRange = [0, 127];

  const kitRangeRow = createRangeSliderRow("Kit Range", "tonalKitRange",
    st.kitRange[0], st.kitRange[1], 1, 64, 1, kitSlotLabel);
  const patRangeRow = createRangeSliderRow("Pattern Range", "tonalPatternRange",
    st.patternRange[0] + 1, st.patternRange[1] + 1, 1, 128, 1, (v) => patternSlotLabel((v | 0) - 1));

  content.appendChild(tonalGrid);
  content.appendChild(kitRangeRow);
  content.appendChild(patRangeRow);

  // -------------------------------
  // APPLY button
  // -------------------------------
  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply Tonal Mask";
  applyBtn.style.marginTop = "0";

  applyBtn.onclick = () => {
    const machineIDs = _normalizeIntArray(st.machineIDs);

    // read ranges (hidden inputs store 1-based for kits/patterns)
    const kVal = (document.getElementById("tonalKitRange")?.value || "1,64")
      .split(",").map(v => parseInt(v, 10));
    const pVal = (document.getElementById("tonalPatternRange")?.value || "1,128")
      .split(",").map(v => parseInt(v, 10));

    let kStart = Math.max(0, Math.min(63, (kVal[0] || 1) - 1));
    let kEnd   = Math.max(0, Math.min(63, (kVal[1] || 64) - 1));
    if (kEnd < kStart) [kStart, kEnd] = [kEnd, kStart];

    let pStart = Math.max(0, Math.min(127, (pVal[0] || 1) - 1));
    let pEnd   = Math.max(0, Math.min(127, (pVal[1] || 128) - 1));
    if (pEnd < pStart) [pStart, pEnd] = [pEnd, pStart];

    // persist ranges in state
    st.kitRange = [kStart + 1, kEnd + 1];
    st.patternRange = [pStart, pEnd];

    let kitsTouched = 0;
    let kitTrackChanges = 0;
    let patternsTouched = 0;
    let lockChanges = 0;
    let patternsSkippedForFilter = 0;

    if (st.applyToKits && Array.isArray(window.kitLibrary)) {
      for (let k = kStart; k <= kEnd; k++) {
        const wrap = window.kitLibrary[k];
        if (!wrap || !wrap.data) continue;
        kitsTouched++;
        kitTrackChanges += applyTonalTuningToKit(wrap.data, null, machineIDs);
      }
    }

    if (st.applyToPatterns && Array.isArray(window.allPatternSlots)) {
      for (let p = pStart; p <= pEnd; p++) {
        const wrap = window.allPatternSlots[p];
        if (!wrap || !wrap.pattern) continue;

        // If the user is filtering by machine IDs but we don't have the assigned kit,
        // we'll skip to avoid unintended tracks.
        if (machineIDs.length > 0) {
          const kitObj = _getKitDataForPattern(wrap.pattern);
          if (!kitObj) {
            // only count as "skipped" if it actually has pitch locks
            const hasPitchLocks = Array.isArray(wrap.pattern.locks) && wrap.pattern.locks.some(lk => lk && lk.paramID === 1);
            if (hasPitchLocks) patternsSkippedForFilter++;
            continue;
          }
        }

        patternsTouched++;
        const changed = applyTonalTuningToPattern(wrap.pattern, null, machineIDs);
        lockChanges += changed;

        // Keep derived matrices in sync if available
        try { window.updateLockMatricesFromLocks?.(wrap.pattern); } catch (_) {}
      }
    }

    // Refresh UI
    try { window.buildKitSlotsUI?.(); } catch (_) {}
    try { window.buildPatternSlotsUI?.(); } catch (_) {}
    try { window.buildTopPatternBanksUI?.(); } catch (_) {}
    try { window.attachKitSlotClickHandlers?.(); } catch (_) {}
    try { window.attachBankSlotClickHandlers?.(); } catch (_) {}
    try { window.updatePanelHeaderColors?.(); } catch (_) {}

    let msg = "Tonal Mask applied.\n\n";
    if (st.applyToKits) {
      msg += "Kits scanned: " + kitsTouched + " (range " + (kStart+1) + "–" + (kEnd+1) + ")\n";
      msg += "Kit pitch snaps: " + kitTrackChanges + "\n\n";
    }
    if (st.applyToPatterns) {
      msg += "Patterns scanned: " + patternsTouched + " (range " + patternSlotLabel(pStart) + "–" + patternSlotLabel(pEnd) + ")\n";
      msg += "Lock snaps: " + lockChanges + "\n";
      if (patternsSkippedForFilter > 0) {
        msg += "\nSkipped " + patternsSkippedForFilter + " pattern(s) because machine-ID filtering requires the assigned kit in memory.";
      }
    }
    alert(msg);
  };

  // Center the primary action under the range sliders
  const applyRow = document.createElement("div");
  applyRow.className = "lab-action-row lab-action-row-center";
  applyRow.style.marginTop = "4px";
  applyRow.appendChild(applyBtn);
  content.appendChild(applyRow);

  // -------------------------------
  // Reset & Randomize
  // -------------------------------
  function resetTonalUI() {
    st.machineIDs = [];
    midInput.value = "";
    st.rootNote = "C";
    rootSelect.value = "C";
    st.octave = 2;
    octInp.value = "2";
    st.applyToKits = true;
    applyToKitsCb.checked = true;
    st.applyToPatterns = true;
    applyToPatternsCb.checked = true;

    st.scaleName = "Major (12TET)";
    scaleSelect.value = "Major (12TET)";
    st.scaleArray = predefinedScales["Major (12TET)"];

    st.customScaleArray = "";
    customScaleInput.value = "";

    // reset ranges
    st.kitRange = [1, 64];
    st.patternRange = [0, 127];
    resetRangeSlider("tonalKitRange");
    resetRangeSlider("tonalPatternRange");
  }

  function randomizeTonalUI() {
    // Random key + preset scale, clear custom override.
    const randomRoot = rootNotes24TET[Math.floor(Math.random() * rootNotes24TET.length)];
    rootSelect.value = randomRoot;
    st.rootNote = randomRoot;

    const choices = scaleNames.filter(nm => nm !== "Chromatic (24TET)" && nm !== "Chromatic (12TET)");
    const randomScale = choices[Math.floor(Math.random() * choices.length)];
    scaleSelect.value = randomScale;
    st.scaleName = randomScale;
    st.scaleArray = predefinedScales[randomScale];

    st.customScaleArray = "";
    customScaleInput.value = "";

    const randomOct = 1 + Math.floor(Math.random() * 4);
    octInp.value = String(randomOct);
    st.octave = randomOct;
  }

  const wrapper = window.createLabModuleWrapper({
    id: "tonalMaskModule",
    title: "Tonal Mask",
    subtitle: "Snap tonal pitch values & locks to a scale",
    contentEl: content,
    actions: { reset: resetTonalUI, randomize: randomizeTonalUI }
  });

  return wrapper;
}

function buildSeedMorphModuleEl() {

  const st = window.advancedLabState.seedVariation;

  // -------------------------------
  // Deterministic seeding helpers
  // -------------------------------
  function randomU32() {
    // Prefer crypto if available, else Math.random.
    try {
      if (window.crypto && crypto.getRandomValues) {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] >>> 0;
      }
    } catch (_) {}
    return (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0);
  }

  // Simple FNV-1a style mix, stable across browsers.
  function mixSeed(baseSeed, kind, seedSlot, destSlot) {
    let h = 2166136261 >>> 0;
    const mix = (n) => {
      h ^= (n >>> 0);
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(baseSeed);
    mix(kind);
    mix(seedSlot);
    mix(destSlot);
    if (h === 0) h = 1;
    return h >>> 0;
  }

  function parseSeedInputValue(v) {
    if (v == null) return null;
    const n = parseInt(String(v).trim(), 10);
    if (!Number.isFinite(n)) return null;
    // force unsigned 32-bit
    return (n >>> 0);
  }

  // Ensure we have a default seed value (so the module is truly "seeded" by default)
  if (st.seedValue == null || !Number.isFinite(parseInt(st.seedValue, 10))) {
    st.seedValue = randomU32();
  }

  // -------------------------------
  // Container
  // -------------------------------
  const seedPanel = document.createElement("div");
  seedPanel.classList.add("lab-module-inner");

  const seedGrid = createAdvancedGridContainer();

  // -------------------------------
  // Seed slot selectors
  // -------------------------------
  // Kit
  const kitSeedSel = document.createElement("select");
  for (let i = 0; i < 64; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = kitSlotLabel(i);
    kitSeedSel.appendChild(opt);
  }
  kitSeedSel.value = String(Math.max(0, Math.min(63, st.kitSeedSlot | 0)));
  kitSeedSel.onchange = () => st.kitSeedSlot = parseInt(kitSeedSel.value, 10) || 0;
  addControlToGrid(seedGrid, "Kit Seed Slot", kitSeedSel);

  // Pattern
  const patSeedSel = document.createElement("select");
  for (let i = 0; i < 128; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = patternSlotLabel(i);
    patSeedSel.appendChild(opt);
  }
  patSeedSel.value = String(Math.max(0, Math.min(127, st.patternSeedSlot | 0)));
  patSeedSel.onchange = () => st.patternSeedSlot = parseInt(patSeedSel.value, 10) || 0;
  addControlToGrid(seedGrid, "Pattern Seed Slot", patSeedSel);

  // Song
  const songSeedSel = document.createElement("select");
  for (let i = 0; i < 32; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = "Song " + (i < 10 ? "0" + i : i);
    songSeedSel.appendChild(opt);
  }
  songSeedSel.value = String(Math.max(0, Math.min(31, st.songSeedSlot | 0)));
  songSeedSel.onchange = () => st.songSeedSlot = parseInt(songSeedSel.value, 10) || 0;
  addControlToGrid(seedGrid, "Song Seed Slot", songSeedSel);

  // -------------------------------
  // Distribution + gaussian sigma
  // -------------------------------
  const distSel = document.createElement("select");
  ["uniform", "gaussian"].forEach(d => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    distSel.appendChild(opt);
  });
  distSel.value = (st.distribution === "gaussian") ? "gaussian" : "uniform";
  distSel.onchange = () => st.distribution = distSel.value;
  addControlToGrid(seedGrid, "Distribution", distSel);

  const sigmaInp = document.createElement("input");
  sigmaInp.type = "number";
  sigmaInp.min = "1";
  sigmaInp.max = "10";
  sigmaInp.step = "1";
  sigmaInp.value = String(Number.isFinite(st.gaussianSigmaFactor) ? st.gaussianSigmaFactor : 3);
  sigmaInp.onchange = () => st.gaussianSigmaFactor = parseInt(sigmaInp.value, 10) || 3;
  addControlToGrid(seedGrid, "Gaussian Sigma", sigmaInp);

  // -------------------------------
  // Variation Amount
  // -------------------------------
  const varRow = document.createElement("div");
  varRow.style.display = "flex";
  varRow.style.alignItems = "center";
  varRow.style.gap = "10px";

  const varSlider = document.createElement("input");
  varSlider.type = "range";
  varSlider.min = "0";
  varSlider.max = "100";
  varSlider.value = String(Number.isFinite(st.variationAmount) ? st.variationAmount : 50);

  const varLabel = document.createElement("span");
  varLabel.textContent = varSlider.value + "%";

  varSlider.oninput = () => {
    st.variationAmount = parseInt(varSlider.value, 10) || 0;
    varLabel.textContent = varSlider.value + "%";
  };

  varRow.appendChild(varSlider);
  varRow.appendChild(varLabel);
  addControlToGrid(seedGrid, "Variation", varRow);

  // -------------------------------
  // Seed value (deterministic)
  // -------------------------------
  const seedInp = document.createElement("input");
  seedInp.type = "number";
  seedInp.step = "1";
  seedInp.min = "0";
  seedInp.placeholder = "Random seed";
  seedInp.value = String(parseSeedInputValue(st.seedValue) ?? randomU32());
  seedInp.dataset.defaultValue = seedInp.value;

  seedInp.onchange = () => {
    const parsed = parseSeedInputValue(seedInp.value);
    if (parsed == null) {
      // If cleared, create a fresh seed so results are still deterministic until changed.
      const r = randomU32();
      seedInp.value = String(r);
      st.seedValue = r;
    } else {
      st.seedValue = parsed;
    }
  };

  // Neat quick-random button next to seed input
  const seedRow = document.createElement("div");
  seedRow.style.display = "flex";
  seedRow.style.alignItems = "center";
  seedRow.style.gap = "8px";

  const seedRandBtn = document.createElement("button");
  seedRandBtn.type = "button";
  seedRandBtn.className = "lab-mini-btn";
  seedRandBtn.textContent = "🎲";
  seedRandBtn.title = "Random seed";
  seedRandBtn.setAttribute("aria-label", "Random seed");
  seedRandBtn.onclick = () => {
    const r = randomU32();
    seedInp.value = String(r);
    st.seedValue = r;
  };

  seedRow.appendChild(seedInp);
  seedRow.appendChild(seedRandBtn);

  addControlToGrid(seedGrid, "Seed", seedRow);
  seedPanel.appendChild(seedGrid);

  // -------------------------------
  // Destination ranges
  // -------------------------------
  const kitDestRow = createRangeSliderRow("Kit Dest Range", "seedKitDestRange", 1, 64, 1, 64, 1, kitSlotLabel);
  const patDestRow = createRangeSliderRow("Pattern Dest Range", "seedPatDestRange", 1, 128, 1, 128, 1, (v) => patternSlotLabel((v | 0) - 1));
  const songDestRow = createRangeSliderRow("Song Dest Range", "seedSongDestRange", 1, 32, 1, 32, 1, (i) => "Song " + i);

  seedPanel.appendChild(kitDestRow);
  seedPanel.appendChild(patDestRow);
  seedPanel.appendChild(songDestRow);

  // -------------------------------
  // Buttons
  // -------------------------------
  function withSeededRng(seedValue, fn) {
    const prev = window._seededRandom;
    try {
      initSeededRandom(seedValue >>> 0);
      return fn();
    } finally {
      if (typeof prev === "function") window._seededRandom = prev;
      else delete window._seededRandom;
    }
  }

  function getBaseSeed() {
    const parsed = parseSeedInputValue(seedInp.value);
    if (parsed == null) return randomU32();
    return parsed;
  }

  function parseRange(hiddenId, min0, max0) {
    const raw = (document.getElementById(hiddenId)?.value || "");
    const parts = raw.split(",").map(v => parseInt(v, 10));
    let a = parts[0] || (min0 + 1);
    let b = parts[1] || (max0 + 1);
    a = Math.max(min0 + 1, Math.min(max0 + 1, a));
    b = Math.max(min0 + 1, Math.min(max0 + 1, b));
    a--; b--;
    if (b < a) [a, b] = [b, a];
    return [a, b];
  }

  // Generate Kits
  const btnKits = document.createElement("button");
  btnKits.textContent = "Gen Kits from Seed";
  btnKits.onclick = () => {
    const seedIdx = st.kitSeedSlot | 0;
    const seedWrap = window.kitLibrary && window.kitLibrary[seedIdx];
    if (!seedWrap || !seedWrap.data) {
      alert("No kit data in slot " + kitSlotLabel(seedIdx) + " to use as seed.");
      return;
    }

    const baseSeed = getBaseSeed();
    const [minK, maxK] = parseRange("seedKitDestRange", 0, 63);

    let made = 0;
    for (let k = minK; k <= maxK; k++) {
      const derived = mixSeed(baseSeed, 1, seedIdx, k);
      withSeededRng(derived, () => {
        generateKitFromSeed(seedWrap.data, k, st.variationAmount);
      });
      made++;
    }

    try { window.buildKitSlotsUI?.(); } catch (_) {}
    try { window.updatePanelHeaderColors?.(); } catch (_) {}

    alert("Generated " + made + " kit(s) from seed " + kitSlotLabel(seedIdx) +
      "\nBase seed: " + baseSeed);
  };

  // Generate Patterns
  const btnPats = document.createElement("button");
  btnPats.textContent = "Gen Patterns from Seed";
  btnPats.onclick = () => {
    const seedIdx = st.patternSeedSlot | 0;
    const seedWrap = window.allPatternSlots && window.allPatternSlots[seedIdx];
    if (!seedWrap || !seedWrap.pattern) {
      alert("No pattern data in slot " + patternSlotLabel(seedIdx) + " to use as seed.");
      return;
    }

    const baseSeed = getBaseSeed();
    const [minP, maxP] = parseRange("seedPatDestRange", 0, 127);

    let made = 0;
    for (let p = minP; p <= maxP; p++) {
      const derived = mixSeed(baseSeed, 2, seedIdx, p);
      withSeededRng(derived, () => {
        generatePatternFromSeed(seedWrap.pattern, p, st.variationAmount);
      });
      made++;
    }

    try { window.buildPatternSlotsUI?.(); } catch (_) {}
    try { window.buildTopPatternBanksUI?.(); } catch (_) {}
    try { window.attachBankSlotClickHandlers?.(); } catch (_) {}
    try { window.updatePanelHeaderColors?.(); } catch (_) {}

    alert("Generated " + made + " pattern(s) from seed " + patternSlotLabel(seedIdx) +
      "\nBase seed: " + baseSeed);
  };

  // Generate Songs
  const btnSongs = document.createElement("button");
  btnSongs.textContent = "Gen Songs from Seed";
  btnSongs.onclick = () => {
    const seedIdx = st.songSeedSlot | 0;
    const seedSong = window.allSongSlots && window.allSongSlots[seedIdx];
    if (!seedSong) {
      alert("No song data in slot " + (seedIdx + 1) + " to use as seed.");
      return;
    }

    const baseSeed = getBaseSeed();
    const [minS, maxS] = parseRange("seedSongDestRange", 0, 31);

    let made = 0;
    for (let s = minS; s <= maxS; s++) {
      const derived = mixSeed(baseSeed, 3, seedIdx, s);
      withSeededRng(derived, () => {
        generateSongFromSeed(seedSong, s, st.variationAmount);
      });
      made++;
    }

    try { window.buildSongSlotsUI?.(); } catch (_) {}
    try { window.updatePanelHeaderColors?.(); } catch (_) {}

    alert("Generated " + made + " song(s) from seed slot " + (seedIdx + 1) +
      "\nBase seed: " + baseSeed);
  };
  // Button row (centered)
  const btnRow = document.createElement("div");
  btnRow.className = "lab-action-row lab-action-row-center";
  btnRow.style.marginTop = "12px";
  btnRow.appendChild(btnKits);
  btnRow.appendChild(btnPats);
  btnRow.appendChild(btnSongs);

  seedPanel.appendChild(btnRow);

  // -------------------------------
  // Reset & Randomize
  // -------------------------------
  function resetSeedUI() {
    st.kitSeedSlot = 0;
    kitSeedSel.value = "0";
    st.patternSeedSlot = 0;
    patSeedSel.value = "0";
    st.songSeedSlot = 0;
    songSeedSel.value = "0";

    st.distribution = "uniform";
    distSel.value = "uniform";
    st.gaussianSigmaFactor = 3;
    sigmaInp.value = "3";

    st.variationAmount = 50;
    varSlider.value = "50";
    varLabel.textContent = "50%";// reset to initial seed for this session
    const def = seedInp.dataset.defaultValue || String(randomU32());
    seedInp.value = def;
    st.seedValue = parseSeedInputValue(def) ?? randomU32();
  }

  function randomizeSeedUI() {
    // distribution
    if (Math.random() < 0.5) {
      st.distribution = "uniform";
      distSel.value = "uniform";
    } else {
      st.distribution = "gaussian";
      distSel.value = "gaussian";
    }

    // sigma
    const sg = 1 + Math.floor(Math.random() * 8);
    st.gaussianSigmaFactor = sg;
    sigmaInp.value = String(sg);

    // variation
    const vv = Math.floor(Math.random() * 101);
    st.variationAmount = vv;
    varSlider.value = String(vv);
    varLabel.textContent = String(vv) + "%";

    // seed
    const r = randomU32();
    seedInp.value = String(r);
    st.seedValue = r;
  }

  const wrapper = window.createLabModuleWrapper({
    id: "seedMorphModule",
    title: "Seed Morph",
    subtitle: "Generate deterministic variations from existing kits/patterns/songs",
    contentEl: seedPanel,
    actions: { reset: resetSeedUI, randomize: randomizeSeedUI }
  });

  return wrapper;
}

function buildMachineImplanterModuleEl() {
  const machineImplanterPanel = createMachineImplanterPanel();
  const is163 =
    (String(window.mdOSVersion) === "1.63") ||
    (parseFloat(window.mdOSVersion) === 1.63) ||
    (String(window.mdOSVersion).toLowerCase() === "original");
  const machineImplanterModule = (typeof window.createLabModuleWrapper === "function")
    ? window.createLabModuleWrapper({
        id: "labmod-machine-implanter",
        title: "Machine Implanter",
        subtitle: "Inject machines + NFX presets into kit tracks",
        contentEl: machineImplanterPanel,
        actions: {
          reset: () => resetMachineImplanter(machineImplanterPanel),
          randomize: is163 ? null : () => randomizeMachineImplanter(machineImplanterPanel)
        }
      })
    : machineImplanterPanel;

  return machineImplanterModule;
}

function buildNormaliseModuleEl() {
  if (typeof window.createNormaliseModule === "function") {
    return window.createNormaliseModule();
  }
  const msg = document.createElement("div");
  msg.className = "lab-muted";
  msg.textContent = "Normalise module not available.";
  return msg;
}

// Legacy helper (optional): mount all advanced modules into one container.
// Note: We no longer auto-call this on page load.
window.createAdvancedModulesUI = function(mountRoot) {
  const root = mountRoot || document.getElementById("labContainer");
  if (!root) return;

  const advancedModulesContainer = document.createElement("div");
  advancedModulesContainer.id = "advancedModulesContainer";
  advancedModulesContainer.className = "lab-stack";

  advancedModulesContainer.appendChild(buildTonalMaskModuleEl());
  advancedModulesContainer.appendChild(buildSeedMorphModuleEl());
  advancedModulesContainer.appendChild(buildMachineImplanterModuleEl());

  const norm = buildNormaliseModuleEl();
  if (norm) advancedModulesContainer.appendChild(norm);

  const existing = document.getElementById("advancedModulesContainer");
  if (existing) existing.remove();
  root.appendChild(advancedModulesContainer);
};

function registerAdvancedModulesAsTabs() {
  if (!window.MDDT || typeof window.MDDT.registerLabModule !== "function") return;

  const registry = Array.isArray(window.MDDT._labModules) ? window.MDDT._labModules : [];
  const has = (id) => registry.some((m) => m && String(m.id) === String(id));
  const reg = window.MDDT.registerLabModule;

  if (!has("tonal-mask")) {
    reg({
      id: "tonal-mask",
      title: "Tonal Mask",
      order: 20,
      __labSource: "bundled",
      mount: function (mountEl) {
        mountEl.innerHTML = "";
        mountEl.classList.add("lab-stack");
        mountEl.appendChild(buildTonalMaskModuleEl());
      }
    });
  }

  if (!has("seed-morph")) {
    reg({
      id: "seed-morph",
      title: "Seed Morph",
      order: 21,
      __labSource: "bundled",
      mount: function (mountEl) {
        mountEl.innerHTML = "";
        mountEl.classList.add("lab-stack");
        mountEl.appendChild(buildSeedMorphModuleEl());
      }
    });
  }

  if (!has("machine-implanter")) {
    reg({
      id: "machine-implanter",
      title: "Machine Implanter",
      order: 22,
      __labSource: "bundled",
      mount: function (mountEl) {
        mountEl.innerHTML = "";
        mountEl.classList.add("lab-stack");
        mountEl.appendChild(buildMachineImplanterModuleEl());
      }
    });
  }

  if (!has("normalise")) {
    reg({
      id: "normalise",
      title: "Normalise EQ/COMP",
      order: 23,
      __labSource: "bundled",
      mount: function (mountEl) {
        mountEl.innerHTML = "";
        mountEl.classList.add("lab-stack");
        mountEl.appendChild(buildNormaliseModuleEl());
      }
    });
  }
}

// Register immediately (bundled) so the tabs appear without user action.
try { registerAdvancedModulesAsTabs(); } catch (_) {}

  function addControlToGrid(gridContainer, labelText, element) {
    const container = document.createElement("div");
    container.style.boxSizing = "border-box";
    container.style.padding = "4px";
    container.style.minWidth = "100px";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.display = "block";
    label.style.fontSize = "0.9em";
    label.style.marginBottom = "2px";
    container.appendChild(label);

    if (!(element instanceof Node)) {
      container.appendChild(document.createTextNode(element));
    } else {
      container.appendChild(element);
    }
    gridContainer.appendChild(container);
  }

  function padOrSlice(arr, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = arr && i < arr.length ? (arr[i] | 0) & 0x7F : 0;
  return out;
}

(function () {
  // LocalStorage key for presets
  const PRESET_KEY = "mddt.normalise.presets.v1";

  function clamp7(v) { v = v|0; return v < 0 ? 0 : v > 127 ? 127 : v; }

  function readPresets() {
    try {
      const sg = (typeof window.safeStorageGet === "function")
        ? window.safeStorageGet
        : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
      const raw = sg(PRESET_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function writePresets(list) {
    const ss = (typeof window.safeStorageSet === "function")
      ? window.safeStorageSet
      : (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
    try { ss(PRESET_KEY, JSON.stringify(list)); } catch {}
  }

  function getSelectedKitSlot() {
    // Prefer a canonical selection index if your app sets one
    // Fallback to 0 (slot 1) if absent
    return (window.selectedKitSlotIndex ?? 0) | 0;
  }

  function ensureMasterFx32(kitData) {
    if (!kitData.masterFx || kitData.masterFx.length !== 32) {
      kitData.masterFx = padOrSlice(kitData.masterFx || [], 32);
    }
    return kitData.masterFx;
  }

  function createNormalisePanel() {
    // Inject scoped styling once (keeps the module consistent with other Lab panels without global bleed).
    (function ensureNormaliseStyle() {
      if (document.getElementById("mddt-normalise-style")) return;
      const style = document.createElement("style");
      style.id = "mddt-normalise-style";
      style.textContent = `
        /* Normalise EQ/COMP (scoped) */
        #normalisePanelBody .norm-grid{
          display:grid;
          grid-template-columns:repeat(8, minmax(0, 1fr));
          gap:10px;
          width:100%;
        }
        #normalisePanelBody .norm-cell{
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:4px;
        }
        #normalisePanelBody .norm-cell label{
          font-size:0.8em;
        }
        #normalisePanelBody .norm-cell .norm-val{
          font-size:0.85em;
          opacity:0.9;
          min-width:2.2em;
          text-align:center;
        }
        #normalisePanelBody .norm-actions{
          display:flex;
          flex-wrap:wrap;
          align-items:center;
          gap:8px;
        }
        #normalisePanelBody .norm-actions input[type="number"]{
          width:64px;
        }
        #normalisePanelBody .norm-bottom{
          display:grid;
          grid-template-columns: 1fr auto 1fr;
          align-items:center;
          column-gap:8px;
          margin-top:8px;
          width:100%;
        }
        #normalisePanelBody .norm-bottom .norm-primary{
          justify-self:center;
        }
      `;
      document.head.appendChild(style);
    })();

    const panel = document.createElement("section");
    panel.classList.add("lab-module-inner");
    panel.id = "normalisePanelBody";

    // ─────────────────────────────────────────────────────────────
    // Sliders (16): 8-band EQ + 8 compressor controls
    const sliderLabels = [
      "LF", "LG", "HF", "HG", "PF", "PG", "PQ", "GAIN",
      "ATCK", "REL", "TRHD", "RTIO", "KNEE", "HP", "OUTG", "MIX"
    ];
    const defaults = [
      64, 64, 64, 64, 64, 64, 64, 127,
      0,  0,  127, 127, 127, 127, 0,  0
    ];

    const normaliseSliders = {};
    const slidersContainer = document.createElement("div");
    slidersContainer.className = "norm-grid";

    function setSliderValues(vals16) {
      for (let i = 0; i < 16; i++) {
        const v = clamp7(vals16[i] ?? 0);
        const slider = normaliseSliders[i];
        if (slider) {
          slider.value = String(v);
          const disp = slider._normDisp;
          if (disp) disp.textContent = String(v);
        }
      }
    }
    function getSliderValues() {
      const out = new Array(16);
      for (let i = 0; i < 16; i++) {
        out[i] = clamp7(parseInt(normaliseSliders[i].value, 10) || 0);
      }
      return out;
    }

    for (let i = 0; i < 16; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "norm-cell";

      const lbl = document.createElement("label");
      lbl.textContent = sliderLabels[i];
      wrapper.appendChild(lbl);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "127";
      slider.value = String(defaults[i]);
      wrapper.appendChild(slider);

      const disp = document.createElement("span");
      disp.className = "norm-val";
      disp.textContent = String(defaults[i]);
      slider.oninput = function () { disp.textContent = this.value; };
      wrapper.appendChild(disp);

      // Keep a direct reference (more robust than DOM sibling assumptions)
      slider._normDisp = disp;

      normaliseSliders[i] = slider;
      slidersContainer.appendChild(wrapper);
    }
    panel.appendChild(slidersContainer);

    // ─────────────────────────────────────────────────────────────
    // Extract row: pull EQ/COMP (masterFx[16..31]) from a kit slot into sliders
    const extractRow = document.createElement("div");
    extractRow.className = "norm-actions";
    extractRow.style.marginTop = "0";

    const srcLbl = document.createElement("label");
    srcLbl.textContent = "Extract from kit slot:";
    extractRow.appendChild(srcLbl);

    const srcInput = document.createElement("input");
    srcInput.type = "number";
    srcInput.min = "1";
    srcInput.max = "64";
    srcInput.value = String(getSelectedKitSlot() + 1);
    extractRow.appendChild(srcInput);

    function tryExtract(slot0) {
      const s = Math.max(0, Math.min(63, slot0 | 0));
      const wrap = window.kitLibrary && window.kitLibrary[s];
      const kit = wrap && wrap.data;
      if (!kit) {
        alert("No kit in slot " + (typeof kitSlotLabel === "function" ? kitSlotLabel(s + 1) : (s + 1)));
        return;
      }
      const fx = ensureMasterFx32(kit);
      const vals = fx.slice(16, 32).map(clamp7);
      setSliderValues(vals);
    }

    const extractBtn = document.createElement("button");
    extractBtn.type = "button";
    extractBtn.className = "lab-mini-btn";
    extractBtn.textContent = "Extract";
    extractBtn.onclick = () => tryExtract((parseInt(srcInput.value, 10) || 1) - 1);
    extractRow.appendChild(extractBtn);

    const fromSelBtn = document.createElement("button");
    fromSelBtn.type = "button";
    fromSelBtn.className = "lab-mini-btn";
    fromSelBtn.textContent = "From Selected";
    fromSelBtn.onclick = () => {
      const sel = getSelectedKitSlot();
      srcInput.value = String(sel + 1);
      tryExtract(sel);
    };
    extractRow.appendChild(fromSelBtn);

    // ─────────────────────────────────────────────────────────────
    // Destination range
    const normaliseDestSlider = createRangeSliderRow(
      "Range:", "normaliseDest", 1, 64, 1, 64, 1, kitSlotLabel
    );
    const destSliderTrack = normaliseDestSlider.querySelector("#normaliseDest_slider");
    if (destSliderTrack) destSliderTrack.style.width = "200px";
    panel.appendChild(normaliseDestSlider);

    // ─────────────────────────────────────────────────────────────
    // Presets: Save / Select / Load / Delete (localStorage)
    const presetsBar = document.createElement("div");
    presetsBar.className = "norm-actions";
    presetsBar.style.marginTop = "8px";

    const presetName = document.createElement("input");
    presetName.type = "text";
    presetName.placeholder = "Preset name…";
    presetName.style.minWidth = "140px";
    presetsBar.appendChild(presetName);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "lab-mini-btn";
    saveBtn.textContent = "Save Preset";
    presetsBar.appendChild(saveBtn);

    const presetSelect = document.createElement("select");
    presetSelect.style.minWidth = "200px";
    presetsBar.appendChild(presetSelect);

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "lab-mini-btn";
    loadBtn.textContent = "Load";
    presetsBar.appendChild(loadBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "lab-mini-btn";
    delBtn.textContent = "Delete";
    presetsBar.appendChild(delBtn);

    function refreshPresetSelect(selectId) {
      const list = readPresets();
      presetSelect.innerHTML = "";
      const neutral = document.createElement("option");
      neutral.value = "__neutral__";
      neutral.textContent = "Neutral (defaults)";
      presetSelect.appendChild(neutral);
      for (const p of list) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        presetSelect.appendChild(opt);
      }
      presetSelect.value = selectId || "__neutral__";
    }
    refreshPresetSelect(null);

    saveBtn.onclick = () => {
      const name = (presetName.value || "").trim() || ("Preset " + (Date.now() % 100000));
      const entry = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        name,
        values: getSliderValues()
      };
      const list = readPresets();
      list.push(entry);
      writePresets(list);
      refreshPresetSelect(entry.id);
    };

    loadBtn.onclick = () => {
      const id = presetSelect.value;
      if (id === "__neutral__") {
        setSliderValues(defaults);
        return;
      }
      const list = readPresets();
      const p = list.find(x => x.id === id);
      if (p && Array.isArray(p.values) && p.values.length === 16) {
        setSliderValues(p.values);
      }
    };

    delBtn.onclick = () => {
      const id = presetSelect.value;
      if (id === "__neutral__") return;
      const list = readPresets();
      const idx = list.findIndex(x => x.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        writePresets(list);
        refreshPresetSelect(null);
      }
    };

    panel.appendChild(presetsBar);

    // ─────────────────────────────────────────────────────────────
    // Bottom bar: Extract controls (left) + action button (center)
    const bottomBar = document.createElement("div");
    bottomBar.className = "norm-bottom";

    extractRow.style.gridColumn = "1 / 2";
    bottomBar.appendChild(extractRow);

    const normBtn = document.createElement("button");
    normBtn.type = "button";
    normBtn.className = "norm-primary";
    normBtn.textContent = "Normalise Kits";
    normBtn.onclick = function () {
      if (!confirm("Normalise EQ/Dynamix?")) return;

      const mask = getSliderValues();
      const destRange = (document.getElementById("normaliseDest").value || "1,64").split(",");
      const startSlot = Math.max(0, (parseInt(destRange[0], 10) || 1) - 1);
      const endSlot = Math.min(63, (parseInt(destRange[1], 10) || 64) - 1);

      for (let slot = startSlot; slot <= endSlot; slot++) {
        const wrap = window.kitLibrary && window.kitLibrary[slot];
        if (!wrap || !wrap.data) continue;

        const kitData = wrap.data;
        const fx = ensureMasterFx32(kitData);
        for (let j = 0; j < 16; j++) fx[16 + j] = clamp7(mask[j]);

        // keep any external refs in sync if your app mirrors structures
        if (window.mdDataRefs?.kits?.kitLibraryArray) {
          window.mdDataRefs.kits.kitLibraryArray[slot] = wrap;
        }
      }

      if (typeof window.buildMasterFxUI === "function") window.buildMasterFxUI();
      if (typeof window.buildKitSlotsUI === "function") window.buildKitSlotsUI();
      if (typeof window.buildKitEditors === "function") window.buildKitEditors();
      if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();

      alert(
        "Normalise applied to kits in slots " +
        (typeof kitSlotLabel === "function" ? kitSlotLabel(startSlot + 1) : (startSlot + 1)) +
        " to " +
        (typeof kitSlotLabel === "function" ? kitSlotLabel(endSlot + 1) : (endSlot + 1)) +
        "."
      );
    };
    bottomBar.appendChild(normBtn);

    panel.appendChild(bottomBar);

    // Accordion wrapper (collapsed by default)
    function resetNormaliseUI() { setSliderValues(defaults); }
    function randomizeNormaliseUI() {
      const r = new Array(16);
      for (let i = 0; i < 16; i++) r[i] = (Math.random() * 128) | 0;
      setSliderValues(r);
    }

    const moduleEl = (typeof window.createLabModuleWrapper === "function")
      ? window.createLabModuleWrapper({
          id: "labmod-normalise",
          title: "Normalise EQ/COMP",
          subtitle: "Stamp EQ/Dynamix across kits",
          contentEl: panel,
          actions: { reset: resetNormaliseUI, randomize: randomizeNormaliseUI }
        })
      : panel;

    return moduleEl;
  }

  // Public hook (unchanged)
  window.createNormaliseModule = createNormalisePanel;
})();


  // ===================================================================
  //  MACHINE IMPLANTER PANEL (embedded preset kits)
  // ===================================================================
  //
  // This section was updated to:
  //  - Embed preset kits decoded from presetkitsimplanter.syx (full per-track data, incl. trig/mute + LFO + routing + FX).
  //  - Present all 16 tracks at once (2×8 grid) with an info line per track.
  //  - Apply neighbor trigger logic without wiping unrelated kit data.
  //
  // Note: Preset track trigger checkboxes are shown read-only (derived from the preset kit's trig group data).

  const MACHINE_IMPLANTER_PRESET_KITS_RAW = [{"name":"COBASIC","tag":"CO","spanStart":14,"spanLen":2,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[10,76,8,14,64,64,63,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":8,"tonal":0,"machineParams":[21,27,18,104,64,64,28,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"HVYSIDE","tag":"CO","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[59,86,0,0,0,0,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[13,5,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":1,"tonal":0,"machineParams":[33,127,0,0,0,0,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":8,"tonal":0,"machineParams":[0,40,0,127,127,0,0,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"PUMPSC","tag":"CO","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[10,74,0,0,64,0,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[13,5,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":1,"tonal":0,"machineParams":[17,127,0,0,63,0,0,17],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":8,"tonal":0,"machineParams":[45,36,0,127,33,0,26,13],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,3,6,0],"trackLevel":127,"lfo":[15,7,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"FASTGATE","tag":"EV","spanStart":14,"spanLen":2,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[40,127,0,0,64,64,0,5],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":7,"tonal":0,"machineParams":[0,25,31,12,3,44,0,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"SLOWATT","tag":"EV","spanStart":14,"spanLen":2,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[47,127,0,0,68,76,59,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":7,"tonal":0,"machineParams":[0,127,64,64,0,64,0,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"TIGHTPNCH","tag":"EV","spanStart":14,"spanLen":2,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[12,127,0,0,64,64,0,5],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":7,"tonal":0,"machineParams":[0,9,31,12,3,51,0,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"DEEPRING","tag":"EV+CO","spanStart":12,"spanLen":4,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[8,127,0,0,63,0,64,22],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[12,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":1,"tonal":0,"machineParams":[26,127,0,0,63,64,0,40],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[13,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":7,"tonal":0,"machineParams":[0,62,127,127,127,127,127,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":8,"tonal":0,"machineParams":[94,26,36,82,127,127,31,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,12]}]},{"name":"SINERING","tag":"EV+CO","spanStart":12,"spanLen":4,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":1,"tonal":0,"machineParams":[42,127,0,0,63,0,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[12,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]},{"machineId":1,"tonal":0,"machineParams":[35,127,0,0,0,0,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[13,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":7,"tonal":0,"machineParams":[0,62,127,127,127,127,127,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,64,0,0],"trackLevel":127,"lfo":[14,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":8,"tonal":0,"machineParams":[94,26,36,82,127,127,31,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,64,0,0,64,0,0],"trackLevel":127,"lfo":[15,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,12]}]},{"name":"CHORUS","tag":"UC","spanStart":14,"spanLen":2,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,96,0,0,77,69,127,19],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,112,11,61],"trackLevel":127,"lfo":[15,21,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[100,40,0,0,127,77,43,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,81,64,0,0,0,20,0],"trackLevel":127,"lfo":[15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"CHORUSSTR","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,122,0,0,73,73,46,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,0,24,0],"trackLevel":127,"lfo":[14,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[46,87,0,0,0,76,43,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,112,5,61],"trackLevel":127,"lfo":[15,21,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,127,77,43,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,0,20,0],"trackLevel":127,"lfo":[15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"FLANGESTR","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,122,0,0,73,73,82,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,7,0,0],"trackLevel":127,"lfo":[14,21,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[88,87,0,0,0,19,2,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,48,30,0],"trackLevel":127,"lfo":[14,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,114,116,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,44,20,0],"trackLevel":127,"lfo":[15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"KARPLUS","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,45,0,0,73,73,82,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,7,0,0],"trackLevel":127,"lfo":[13,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[88,87,0,0,92,1,2,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,102,55,0],"trackLevel":127,"lfo":[14,0,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,109,122,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,102,59,0],"trackLevel":127,"lfo":[15,0,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"PHASERSTR","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,122,0,0,73,73,82,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,0,24,0],"trackLevel":127,"lfo":[14,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[46,87,0,0,0,118,43,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,112,5,61],"trackLevel":127,"lfo":[15,21,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,127,107,43,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,0,20,0],"trackLevel":127,"lfo":[15,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"SLANGER","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,122,0,0,73,73,82,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,7,0,0],"trackLevel":127,"lfo":[14,21,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[88,87,0,0,0,13,2,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,2,31,127],"trackLevel":127,"lfo":[14,0,4,4,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,114,103,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,2,31,127],"trackLevel":127,"lfo":[15,0,4,4,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]},{"name":"STRIMAGE","tag":"UC","spanStart":13,"spanLen":3,"masterFx":[0,0,64,0,0,127,127,96,32,0,32,0,0,127,0,96,64,64,64,64,64,64,64,127,127,127,127,127,127,127,0,0],"tracks":[{"machineId":4,"tonal":0,"machineParams":[40,122,0,0,73,73,82,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,0,64,0,0,7,0,0],"trackLevel":127,"lfo":[13,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,14]},{"machineId":9,"tonal":0,"machineParams":[88,87,0,0,92,61,2,127],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,0,0,0,102,55,0],"trackLevel":127,"lfo":[14,0,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,15]},{"machineId":9,"tonal":0,"machineParams":[86,41,0,0,28,68,0,0],"trackFx":[0,0,64,64,0,127,0,0],"routing":[0,127,127,0,0,102,59,0],"trackLevel":127,"lfo":[15,0,0,4,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,26,0,0,0,0],"muteTrig":[128,128]}]}];


  // 2) Normalise names + group/sort by machine type
  const MACHINE_IMPLANTER_PRESET_KITS = (() => {
    const groupOrder = ["CO", "UC", "EV"];
    const orderIndex = (g) => {
      const i = groupOrder.indexOf(g);
      return i === -1 ? 999 : i;
    };

    const primaryGroupFromTag = (tag) => {
      // tag can be "EV", "CO", "UC", or combos like "EV+CO"
      const t = String(tag || "").toUpperCase();
      const primary = t.split("+")[0].trim();
      // only allow the three requested prefixes
      if (primary === "CO" || primary === "UC" || primary === "EV") return primary;
      return "CO"; // safe default (won’t break UI); change if you prefer "EV" default
    };

    const withPrefix = (name, group) => {
      const base = String(name || "").trim();
      const prefix = `${group}-`;
      // avoid double-prefixing if already present
      if (base.toUpperCase().startsWith(prefix)) return base;
      return prefix + base;
    };

    // clone objects so we don't mutate RAW
    const normalized = MACHINE_IMPLANTER_PRESET_KITS_RAW.map((p) => {
      const group = primaryGroupFromTag(p.tag);
      return {
        ...p,
        // keep your existing p.tag exactly (EV+CO etc), just adjust display name
        name: withPrefix(p.name, group),
        __group: group
      };
    });

    normalized.sort((a, b) => {
      const ga = orderIndex(a.__group);
      const gb = orderIndex(b.__group);
      if (ga !== gb) return ga - gb;
      return String(a.name).localeCompare(String(b.name));
    });

    // strip helper field
    return normalized.map(({ __group, ...rest }) => rest);
  })();

  function __miDeepClone(obj) {
    try {
      if (typeof structuredClone === "function") return structuredClone(obj);
    } catch (_) {}
    return JSON.parse(JSON.stringify(obj));
  }

  function __miClampInt(v, lo, hi) {
    v = Number(v);
    if (!Number.isFinite(v)) v = lo;
    v = v | 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  // Positive modulo for MD track indices.
  // e.g. __miMod16(-1) => 15, __miMod16(16) => 0
  function __miMod16(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return 0;
    return ((n % 16) + 16) % 16;
  }

  function __miEnsureArray(arr, len, fill=0) {
    const out = new Array(len);
    for (let i=0; i<len; i++) {
      const v = (arr && arr[i] != null) ? (arr[i] | 0) : (fill | 0);
      out[i] = v;
    }
    return out;
  }

  function __miEnsureMatrix(mat, rows, cols, fill=0) {
    const out = new Array(rows);
    for (let r=0; r<rows; r++) {
      out[r] = __miEnsureArray(mat && mat[r], cols, fill);
    }
    return out;
  }

  function __miNormalizeKitForEditing(kitObj) {
    const kit = kitObj || {};

    // Track-level arrays
    kit.machineAssignments = Array.isArray(kit.machineAssignments) ? __miEnsureArray(kit.machineAssignments, 16, 0) : new Array(16).fill(0);
    kit.machineTonalFlags  = Array.isArray(kit.machineTonalFlags)  ? __miEnsureArray(kit.machineTonalFlags,  16, 0) : new Array(16).fill(0);

    kit.machineParams = __miEnsureMatrix(kit.machineParams, 16, 8, 0);
    kit.trackFx       = __miEnsureMatrix(kit.trackFx,       16, 8, 0);
    kit.routing       = __miEnsureMatrix(kit.routing,       16, 8, 0);
    kit.trackLevels   = __miEnsureArray(kit.trackLevels, 16, 100);

    kit.lfoBlocks = __miEnsureMatrix(kit.lfoBlocks, 16, 36, 0);

    // muteTrigRelations: [mutePos, trigPos] per track
    if (!Array.isArray(kit.muteTrigRelations) || kit.muteTrigRelations.length !== 16) {
      kit.muteTrigRelations = Array.from({ length: 16 }, () => [128, 128]);
    } else {
      kit.muteTrigRelations = kit.muteTrigRelations.map(pair => {
        const a = Array.isArray(pair) ? pair : [128, 128];
        return [ (a[0] == null ? 128 : (a[0] | 0)), (a[1] == null ? 128 : (a[1] | 0)) ];
      });
      while (kit.muteTrigRelations.length < 16) kit.muteTrigRelations.push([128,128]);
      if (kit.muteTrigRelations.length > 16) kit.muteTrigRelations.length = 16;
    }

    // Master FX
    kit.masterFx = __miEnsureArray(kit.masterFx, 32, 0);

    return kit;
  }

  function __miIsNfxMachineName(name) {
    return typeof name === "string" && name.startsWith("NFX-");
  }

  function __miGetMachineName(mID) {
    const machines = (typeof window.getValidMachineEntries === "function")
      ? window.getValidMachineEntries(window.mdModel)
      : null;
    if (!machines) return "";
    return machines[mID] || "";
  }

  function __miSupportsTonal(machineId) {
    try {
      return !!(window.MACHINES_THAT_SUPPORT_TONAL && window.MACHINES_THAT_SUPPORT_TONAL.has(machineId|0));
    } catch (_) {
      return false;
    }
  }

  function __miShiftIfInSpan(v, spanStart, spanEnd, delta) {
    const n = v | 0;
    if (n >= spanStart && n <= spanEnd) return (n + delta) | 0;
    return n;
  }

  function __miComputeNearFarFromPresetState(trackIndex, state) {
    // Support wrap-around neighbour sourcing (e.g. track 2 "Far" can come from track 16).
    const nearSrc = __miMod16(trackIndex - 1);
    const farSrc  = __miMod16(trackIndex - 2);

    const near = state.trackPresetData[nearSrc] && Array.isArray(state.trackPresetData[nearSrc].muteTrig) && ((state.trackPresetData[nearSrc].muteTrig[1] | 0) === (trackIndex | 0));
    const far  = state.trackPresetData[farSrc]  && Array.isArray(state.trackPresetData[farSrc].muteTrig)  && ((state.trackPresetData[farSrc].muteTrig[1]  | 0) === (trackIndex | 0));
    return { near: !!near, far: !!far };
  }

  // Ensure machine implanter state shape exists (backwards compatible)
  (function __miEnsureStateDefaults() {
    window.advancedLabState = window.advancedLabState || {};
    const st = window.advancedLabState.machineImplanter = window.advancedLabState.machineImplanter || {};

    if (!Array.isArray(st.kitRange) || st.kitRange.length < 2) st.kitRange = [1, 64];

    if (!Array.isArray(st.trackMachineIDs) || st.trackMachineIDs.length !== 16) st.trackMachineIDs = new Array(16).fill(null);

    if (!Array.isArray(st.trackPresetData) || st.trackPresetData.length !== 16) st.trackPresetData = new Array(16).fill(null);

    if (!Array.isArray(st.trackTriggers) || st.trackTriggers.length !== 16) {
      st.trackTriggers = Array.from({ length: 16 }, () => ({ near: false, far: false }));
    } else {
      st.trackTriggers = st.trackTriggers.map(tr => ({ near: !!tr?.near, far: !!tr?.far }));
      while (st.trackTriggers.length < 16) st.trackTriggers.push({ near: false, far: false });
      if (st.trackTriggers.length > 16) st.trackTriggers.length = 16;
    }

    if (!Number.isFinite(st.selectedTrack)) st.selectedTrack = 15;
    // Options are intentionally fixed OFF (toggles removed from UI)
    st.includeMasterFx = false;
    st.overwriteKitName = false;
    st.sendToMD = false;

    if (st.activePresetName == null) st.activePresetName = "";
    if (!Number.isFinite(st.activePresetStartTrack)) st.activePresetStartTrack = 0;
    if (st.activePresetGroupId == null) st.activePresetGroupId = "";

    // Keep a direct pointer for apply (not persisted)
    st.__activePresetObj = st.__activePresetObj || null;
  })();

  function createDefaultNfxPresets() {
    const out = {};
    for (const p of MACHINE_IMPLANTER_PRESET_KITS) {
      if (p && typeof p.name === "string") out[p.name] = p;
    }
    return out;
  }

  // ---------------- Machine Implanter: linked-track grouping + block swap ----------------
  // This powers the "drag to swap" UX while keeping linked tracks together.
  function __miConsecutiveIndices(start, len) {
    const out = [];
    const s = __miMod16(start);
    const L = Math.max(0, len | 0);
    for (let i = 0; i < L; i++) out.push(__miMod16(s + i));
    return out;
  }

  function __miBuildTrackLinkAdjacency(state) {
    const adj = Array.from({ length: 16 }, () => new Set());
    const addEdge = (a, b) => {
      a = a | 0; b = b | 0;
      if (a < 0 || a > 15 || b < 0 || b > 15 || a === b) return;
      adj[a].add(b);
      adj[b].add(a);
    };

    for (let t = 0; t < 16; t++) {
      const pd = state?.trackPresetData?.[t];
      if (pd) {
        // Trig link: muteTrig[1] stores the destination track index (0..15) or 128.
        if (Array.isArray(pd.muteTrig) && pd.muteTrig.length > 1) {
          const trg = pd.muteTrig[1] | 0;
          if (trg >= 0 && trg < 16) addEdge(t, trg);
        }
        // LFO destination is a track reference in byte 0 (0..15).
        if (Array.isArray(pd.lfo) && pd.lfo.length > 0) {
          const d = pd.lfo[0] | 0;
          if (d >= 0 && d < 16) addEdge(t, d);
        }
      }

      const trig = state?.trackTriggers?.[t];
      if (trig) {
        if (trig.near) addEdge(t, __miMod16(t - 1));
        if (trig.far)  addEdge(t, __miMod16(t - 2));
      }
    }


    // Keep preset spans together even if the preset kit has no explicit trig/LFO links.
    // (Some bundled 3-track presets intentionally have no muteTrig links, but users still expect
    // the span to move as one block.)
    try {
      const byPreset = new Map();
      for (let t = 0; t < 16; t++) {
        const pd = state?.trackPresetData?.[t];
        const gid = pd && pd.__miPresetGroupId;
        if (!gid) continue;
        const pos = Number.isFinite(pd.__miPresetPos) ? (pd.__miPresetPos | 0) : 0;
        if (!byPreset.has(gid)) byPreset.set(gid, []);
        byPreset.get(gid).push({ t, pos });
      }
      for (const arr of byPreset.values()) {
        arr.sort((a, b) => (a.pos | 0) - (b.pos | 0));
        for (let i = 0; i < arr.length - 1; i++) addEdge(arr[i].t, arr[i + 1].t);
      }
    } catch (_) {}
    return adj;
  }

  function __miOrderGroupTracks(memberTracks, state) {
    const uniq = Array.from(new Set((memberTracks || []).map(n => n | 0))).filter(n => n >= 0 && n < 16);
    if (uniq.length <= 1) return { start: (uniq[0] ?? 0), indices: uniq.length ? [uniq[0]] : [] };

    // If this entire component is a single loaded preset block, keep its original order
    // (the order it was loaded from the preset kit) no matter how many times it is moved.
    try {
      const pdArr = state && state.trackPresetData;
      if (pdArr && uniq.length > 1) {
        const firstPd = pdArr[uniq[0]];
        const gid = firstPd && firstPd.__miPresetGroupId;
        if (gid && uniq.every(t => {
          const pd = pdArr[t];
          return pd && pd.__miPresetGroupId === gid && Number.isFinite(pd.__miPresetPos);
        })) {
          const ordered = uniq.slice().sort((a, b) => ((pdArr[a].__miPresetPos | 0) - (pdArr[b].__miPresetPos | 0)));
          return { start: (ordered[0] ?? 0), indices: ordered };
        }
      }
    } catch (_) {}

    const sorted = uniq.slice().sort((a, b) => a - b);
    let maxGap = -1;
    let maxGapIdx = 0;
    for (let i = 0; i < sorted.length; i++) {
      const cur  = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      // number of empty slots between cur and next when walking forward on the 0..15 ring
      const gap = ((next - cur - 1 + 16) % 16);
      if (gap > maxGap) {
        maxGap = gap;
        maxGapIdx = i;
      }
    }

    const start = sorted[(maxGapIdx + 1) % sorted.length];
    const blockLen = 16 - maxGap;

    // If the component isn't contiguous on the ring, avoid dragging unrelated tracks.
    if (blockLen > sorted.length) {
      const ordered = sorted.slice().sort((a, b) => ((a - start + 16) % 16) - ((b - start + 16) % 16));
      return { start, indices: ordered };
    }

    const indices = [];
    for (let k = 0; k < blockLen; k++) indices.push(__miMod16(start + k));
    return { start, indices };
  }

  function __miComputeTrackGroups(state) {
    const adj = __miBuildTrackLinkAdjacency(state);
    const groupIdByTrack = new Array(16).fill(-1);
    const groups = [];
    let gid = 0;

    for (let t = 0; t < 16; t++) {
      if (groupIdByTrack[t] !== -1) continue;
      const stack = [t];
      groupIdByTrack[t] = gid;
      const members = [];

      while (stack.length) {
        const u = stack.pop();
        members.push(u);
        for (const v of adj[u]) {
          if (groupIdByTrack[v] === -1) {
            groupIdByTrack[v] = gid;
            stack.push(v);
          }
        }
      }

      const ordered = __miOrderGroupTracks(members, state);
      const memberSet = new Set(members);
      groups.push({
        id: gid,
        start: ordered.start,
        ordered: ordered.indices,
        members: Array.from(memberSet).sort((a, b) => a - b),
        set: memberSet
      });
      gid++;
    }

    return { groups, groupIdByTrack };
  }

  function __miRemapPresetDataTrackRefs(presetData, mapOldToNew) {
    if (!presetData) return null;
    const out = __miDeepClone(presetData);

    // muteTrig: [mutePos, trigPos]
    if (Array.isArray(out.muteTrig)) {
      const a = (out.muteTrig[0] == null) ? 128 : (out.muteTrig[0] | 0);
      const b = (out.muteTrig.length > 1 && out.muteTrig[1] != null) ? (out.muteTrig[1] | 0) : 128;
      out.muteTrig = [
        mapOldToNew.has(a) ? (mapOldToNew.get(a) | 0) : a,
        mapOldToNew.has(b) ? (mapOldToNew.get(b) | 0) : b
      ];
    }

    // LFO destination track is byte 0
    if (Array.isArray(out.lfo) && out.lfo.length > 0) {
      const d = (out.lfo[0] == null) ? 0 : (out.lfo[0] | 0);
      if (mapOldToNew.has(d)) out.lfo[0] = (mapOldToNew.get(d) | 0);
    }

    return out;
  }

  function __miSwapTrackSegments(state, srcIndices, dstIndices) {
    if (!state || !Array.isArray(srcIndices) || !Array.isArray(dstIndices)) return;
    if (srcIndices.length !== dstIndices.length) return;
    const len = srcIndices.length;
    if (!len) return;

    const oldMachineIDs = Array.isArray(state.trackMachineIDs) ? state.trackMachineIDs.slice() : new Array(16).fill(null);
    const oldPresetData = Array.isArray(state.trackPresetData) ? state.trackPresetData.slice() : new Array(16).fill(null);
    const oldTriggers = Array.isArray(state.trackTriggers)
      ? state.trackTriggers.map(tr => ({ near: !!tr?.near, far: !!tr?.far }))
      : Array.from({ length: 16 }, () => ({ near: false, far: false }));

    const mapSrcToDst = new Map();
    const mapDstToSrc = new Map();
    for (let i = 0; i < len; i++) {
      mapSrcToDst.set(srcIndices[i] | 0, dstIndices[i] | 0);
      mapDstToSrc.set(dstIndices[i] | 0, srcIndices[i] | 0);
    }

    const newMachineIDs = oldMachineIDs.slice();
    const newPresetData = oldPresetData.slice();
    const newTriggers   = oldTriggers.slice();

    for (let i = 0; i < len; i++) {
      const s = srcIndices[i] | 0;
      const d = dstIndices[i] | 0;

      const sPd = oldPresetData[s];
      const dPd = oldPresetData[d];

      const pdAtD = sPd ? __miRemapPresetDataTrackRefs(sPd, mapSrcToDst) : null;
      const pdAtS = dPd ? __miRemapPresetDataTrackRefs(dPd, mapDstToSrc) : null;

      newPresetData[d] = pdAtD;
      newPresetData[s] = pdAtS;

      newMachineIDs[d] = pdAtD ? (pdAtD.machineId | 0) : oldMachineIDs[s];
      newMachineIDs[s] = pdAtS ? (pdAtS.machineId | 0) : oldMachineIDs[d];

      newTriggers[d] = { ...oldTriggers[s] };
      newTriggers[s] = { ...oldTriggers[d] };
    }

    // Ensure machine IDs follow preset track data (the source-of-truth)
    // and that empty slots are cleared cleanly (avoid accidental 0s).
    for (let t = 0; t < 16; t++) {
      const pd = newPresetData[t];
      if (pd && pd.machineId != null) {
        newMachineIDs[t] = (pd.machineId | 0);
        continue;
      }

      const v = newMachineIDs[t];
      if (v == null) {
        newMachineIDs[t] = null;
        continue;
      }

      const n = (typeof v === "number") ? v : parseInt(String(v), 10);
      newMachineIDs[t] = Number.isFinite(n) ? (n | 0) : null;
    }

    state.trackMachineIDs = newMachineIDs;
    state.trackPresetData = newPresetData;
    state.trackTriggers   = newTriggers;
  }

  // Load a preset kit into the UI state (shifts track references when placed elsewhere)
  function applyPresetToDropdowns(panelElem, startTrack, presetKit) {
    if (!presetKit || !Array.isArray(presetKit.tracks) || !Number.isFinite(presetKit.spanLen)) return;

    const state = window.advancedLabState.machineImplanter;

    // Reset state
    state.trackPresetData = new Array(16).fill(null);
    state.trackMachineIDs = new Array(16).fill(null);
    state.trackTriggers   = Array.from({ length: 16 }, () => ({ near: false, far: false }));

    // Unique group id for this preset load instance.
    // This keeps the preset span moving together as a block even when the preset kit has
    // no explicit trig/LFO links between its tracks.
    const __miPresetGroupId = "miPreset_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    state.activePresetGroupId = __miPresetGroupId;

    const spanStart = (presetKit.spanStart | 0);
    const spanLen   = (presetKit.spanLen   | 0);
    const spanEnd   = spanStart + spanLen - 1;

    // Clamp placement start so span fits in 0..15
    const maxStart = 15 - (spanLen - 1);
    let start = startTrack | 0;
    if (start > maxStart) start = maxStart;
    if (start < 0) start = 0;

    const delta = (start - spanStart) | 0;

    // Place the preset span
    for (let i = 0; i < spanLen; i++) {
      const destTrack = start + i;
      const srcTrackIndex = i;

      const tr = presetKit.tracks[srcTrackIndex];
      if (!tr) continue;

      const srcMute = (tr.muteTrig && tr.muteTrig.length > 0) ? (tr.muteTrig[0] | 0) : 128;
      const srcTrig = (tr.muteTrig && tr.muteTrig.length > 1) ? (tr.muteTrig[1] | 0) : 128;

      const mutePos = __miShiftIfInSpan(srcMute, spanStart, spanEnd, delta);
      const trigPos = __miShiftIfInSpan(srcTrig, spanStart, spanEnd, delta);

      const lfo = Array.isArray(tr.lfo) ? tr.lfo.slice(0, 36).map(v => v | 0) : new Array(36).fill(0);
      // LFO destination track is byte 0; shift if it points inside the original span
      lfo[0] = __miShiftIfInSpan((lfo[0] == null ? destTrack : (lfo[0] | 0)), spanStart, spanEnd, delta);

      state.trackPresetData[destTrack] = {
        machineId: (tr.machineId | 0),
        tonal: (tr.tonal | 0),
        machineParams: __miEnsureArray(tr.machineParams, 8, 0),
        trackFx:       __miEnsureArray(tr.trackFx,       8, 0),
        routing:       __miEnsureArray(tr.routing,       8, 0),
        trackLevel:    __miClampInt(tr.trackLevel, 0, 127),
        lfo:           __miEnsureArray(lfo, 36, 0),
        muteTrig:      [mutePos, trigPos],
        presetName:    presetKit.name || "",
        __miPresetGroupId,
        __miPresetPos:  i,
        __miPresetLen:  spanLen
      };

      // Keep selects in sync
      state.trackMachineIDs[destTrack] = (tr.machineId | 0);
    }

    state.activePresetName = presetKit.name || "";
    state.activePresetStartTrack = start;
    state.__activePresetObj = presetKit;

    // Push into the UI
    const ui = panelElem && panelElem.__machineImplanterUI;
    if (ui && Array.isArray(ui.trackUIs) && typeof ui.updateAll === "function") {
      for (let t = 0; t < 16; t++) {
        const mId = state.trackMachineIDs[t];
        ui.trackUIs[t].sel.value = (mId == null) ? "" : String(mId);
      }
      ui.updateAll();
    } else {
      // Fallback: set selects only
      for (let t = 0; t < 16; t++) {
        const sel = panelElem?.querySelector?.(`#imp_track${t}`);
        if (sel) sel.value = (state.trackMachineIDs[t] == null) ? "" : String(state.trackMachineIDs[t]);
      }
    }
  }

  function applyMachineImplanter() {
    const state = window.advancedLabState.machineImplanter;
    if (!window.kitLibrary || !window.kitLibrary.length) {
      alert("No kits loaded.");
      return;
    }

    // Kit range
    const rangeEl = document.getElementById("imp_kitRange");
    const parts = (rangeEl?.value || "1,64").split(",");
    let minK = (parseInt(parts[0], 10) || 1) - 1;
    let maxK = (parseInt(parts[1], 10) || 64) - 1;
    minK = __miClampInt(minK, 0, 63);
    maxK = __miClampInt(maxK, 0, 63);

    // Collect manual NFX tracks upfront (preset tracks are copied verbatim)
    const manualNfxTracks = [];
    for (let t = 0; t < 16; t++) {
      if (state.trackPresetData[t]) continue;
      const id = state.trackMachineIDs[t];
      if (id == null) continue;
      const name = __miGetMachineName(id|0);
      if (__miIsNfxMachineName(name)) manualNfxTracks.push(t);
    }

    const slotLabel = (typeof window.kitSlotLabel === "function")
      ? (i) => window.kitSlotLabel(i)
      : (i) => `Kit ${String(i).padStart(2, "0")}`;

    const ok = confirm(
      `Implant machines into kits ${slotLabel(minK+1)} to ${slotLabel(maxK+1)}?\n` +
      `Preset tracks: ${state.trackPresetData.filter(Boolean).length} • Manual tracks: ${state.trackMachineIDs.filter(v => v != null).length}`
    );
    if (!ok) return;

    let touched = 0;

    for (let k = minK; k <= maxK; k++) {
      const wrap = window.kitLibrary[k];
      if (!wrap || !wrap.data) continue;

      const kit = __miNormalizeKitForEditing(__miDeepClone(wrap.data));

      // 1) Apply preset track data (full per-track copy)
      for (let t = 0; t < 16; t++) {
        const tr = state.trackPresetData[t];
        if (!tr) continue;

        const machineId = tr.machineId | 0;
        kit.machineAssignments[t] = machineId;
        kit.machineTonalFlags[t]  = __miSupportsTonal(machineId) ? 1 : 0;

        kit.machineParams[t] = __miEnsureArray(tr.machineParams, 8, 0);
        kit.trackFx[t]       = __miEnsureArray(tr.trackFx,       8, 0);
        kit.routing[t]       = __miEnsureArray(tr.routing,       8, 0);
        kit.trackLevels[t]   = __miClampInt(tr.trackLevel, 0, 127);

        kit.lfoBlocks[t] = __miEnsureArray(tr.lfo, 36, 0);

        if (Array.isArray(tr.muteTrig) && tr.muteTrig.length >= 2) {
          kit.muteTrigRelations[t] = [ (tr.muteTrig[0] | 0), (tr.muteTrig[1] | 0) ];
        }
      }

      // 2) Apply manual machine assignments (machine only)
      for (let t = 0; t < 16; t++) {
        if (state.trackPresetData[t]) continue;
        const id = state.trackMachineIDs[t];
        if (id == null) continue;

        const machineId = id | 0;
        kit.machineAssignments[t] = machineId;
        kit.machineTonalFlags[t]  = __miSupportsTonal(machineId) ? 1 : 0;
      }

      // 3) Apply manual neighbor triggers for manual NFX tracks
      for (const t of manualNfxTracks) {
        const trig = state.trackTriggers[t] || { near: false, far: false };
        const nearIdx = __miMod16(t - 1);
        const farIdx  = __miMod16(t - 2);

        // Near (source = t-1), with wrap-around support (e.g. track 1 uses source track 16)
        if (trig.near) {
          kit.muteTrigRelations[nearIdx][1] = t;
          // Like the shipped presets: set source VOL=0 so it only acts as trig source
          kit.routing[nearIdx][1] = 0;
        } else {
          if ((kit.muteTrigRelations[nearIdx][1] | 0) === (t | 0)) kit.muteTrigRelations[nearIdx][1] = 128;
        }

        // Far (source = t-2), with wrap-around support (e.g. track 2 uses source track 16)
        if (trig.far) {
          kit.muteTrigRelations[farIdx][1] = t;
          kit.routing[farIdx][1] = 0;
        } else {
          if ((kit.muteTrigRelations[farIdx][1] | 0) === (t | 0)) kit.muteTrigRelations[farIdx][1] = 128;
        }
      }

      // 4) Optional: Master FX + kit name from active preset
      const activePreset = state.__activePresetObj;
      if (activePreset) {
        if (state.includeMasterFx && Array.isArray(activePreset.masterFx)) {
          kit.masterFx = __miEnsureArray(activePreset.masterFx, 32, 0);
        }
        if (state.overwriteKitName && typeof activePreset.name === "string") {
          kit.kitName = activePreset.name.slice(0, 16);
        }
      }

      // Commit/write
      try {
        if (state.sendToMD && typeof window.writeKitSlot === "function") {
          window.writeKitSlot(k, kit, { sendToMD: true, silent: true });
        } else if (typeof window.commitKitSlot === "function") {
          window.commitKitSlot(k, kit, { silent: true });
        } else {
          // Fallback: direct write
          window.kitLibrary[k] = { data: kit, colorIndex: k };
          if (window.mdDataRefs?.kits?.kitLibraryArray) {
            window.mdDataRefs.kits.kitLibraryArray[k] = window.kitLibrary[k];
          }
        }
        touched++;
      } catch (e) {
        console.warn("[Machine Implanter] Failed to write kit slot", k, e);
      }
    }

    // Refresh UI once
    try { window.buildKitSlotsUI?.(); } catch (_) {}
    try { window.buildKitEditors?.(); } catch (_) {}
    try { window.updatePanelHeaderColors?.(); } catch (_) {}

    alert(`Machine Implanter: updated ${touched} kit(s).`);
  }

  // Resets UI state + clears selections
  function resetMachineImplanter(panel) {
    const state = window.advancedLabState.machineImplanter;

    state.trackMachineIDs = new Array(16).fill(null);
    state.trackPresetData = new Array(16).fill(null);
    state.trackTriggers   = Array.from({ length: 16 }, () => ({ near: false, far: false }));
    state.activePresetName = "";
    state.__activePresetObj = null;
    state.activePresetGroupId = "";

    // Reset kit range slider to defaults (1..64)
    try {
      const hid = panel.querySelector("#imp_kitRange");
      const def = (hid?.dataset?.defaultValue || "1,64").split(",").map(n => parseInt(n, 10) || 1);
      const slider = panel.querySelector("#imp_kitRange_slider")?.noUiSlider;
      if (slider && def.length >= 2) slider.set(def);
      if (hid) hid.value = (def[0] || 1) + "," + (def[1] || 64);
    } catch (_) {}

    // Options are fixed OFF (UI toggles removed)
    state.includeMasterFx = false;
    state.overwriteKitName = false;
    state.sendToMD = false;

    const ui = panel && panel.__machineImplanterUI;
    if (ui && typeof ui.updateAll === "function") {
      for (let t = 0; t < 16; t++) {
        ui.trackUIs[t].sel.value = "";
      }
      ui.updateAll();
    } else {
      for (let t = 0; t < 16; t++) {
        const sel = panel.querySelector(`#imp_track${t}`);
        if (sel) sel.value = "";
      }
    }
  }

  // Randomise: choose 1–4 random NFX machines + random Near/Far flags (manual mode only)
  function randomizeMachineImplanter(panel) {
    const state = window.advancedLabState.machineImplanter;

    const is163 =
      (String(window.mdOSVersion) === "1.63") ||
      (parseFloat(window.mdOSVersion) === 1.63) ||
      (String(window.mdOSVersion).toLowerCase() === "original");
    if (is163) {
      console.warn("[Machine Implanter] Randomise disabled on OS 1.63 / Original (no NFX).");
      return;
    }

    const allMachines = (typeof window.getValidMachineEntries === "function")
      ? window.getValidMachineEntries(window.mdModel)
      : null;
    if (!allMachines) {
      console.warn("[Machine Implanter] No machine entries found for randomise.");
      return;
    }

    const nfxIDs = Object.entries(allMachines)
      .filter(([_, name]) => typeof name === "string" && name.startsWith("NFX-"))
      .map(([id]) => Number(id));

    if (!nfxIDs.length) {
      console.warn("[Machine Implanter] No NFX machines available to randomise.");
      return;
    }

    const count = Math.floor(Math.random() * 4) + 1;
    const tracks = Array.from({ length: 16 }, (_, i) => i)
      .sort(() => Math.random() - 0.5)
      .slice(0, count);

    state.trackPresetData = new Array(16).fill(null);
    state.trackMachineIDs = new Array(16).fill(null);
    state.trackTriggers   = Array.from({ length: 16 }, () => ({ near: false, far: false }));
    state.activePresetName = "";
    state.__activePresetObj = null;

    for (const t of tracks) {
      state.trackMachineIDs[t] = nfxIDs[Math.floor(Math.random() * nfxIDs.length)] | 0;
      state.trackTriggers[t] = {
        // Wrap-around is supported (e.g. track 2 "Far" can be track 16)
        near: (Math.random() < 0.5),
        far:  (Math.random() < 0.5)
      };
    }

    const ui = panel && panel.__machineImplanterUI;
    if (ui && typeof ui.updateAll === "function") {
      for (let t = 0; t < 16; t++) {
        ui.trackUIs[t].sel.value = (state.trackMachineIDs[t] == null) ? "" : String(state.trackMachineIDs[t]);
      }
      ui.updateAll();
    }
  }

  // ===================================================================
  //  MACHINE IMPLANTER PANEL UI
  // ===================================================================
  function createMachineImplanterPanel() {
    const state = window.advancedLabState.machineImplanter;

    const sec = document.createElement("div");
    sec.dataset.panelId = "machineImplanter";

    // Inject minimal styles for track selection + drag/swap highlights (once)
    (function ensureMiDnDStyles() {
      const styleId = "mddt-mi-dnd-styles";
      if (document.getElementById(styleId)) return;
      const st = document.createElement("style");
      st.id = styleId;
      st.textContent = `
        .mi-track-cell.mi-selected {
          outline: 2px solid rgba(255,255,255,0.45);
          outline-offset: 2px;
        }
        .mi-track-cell.mi-dnd-src {
          outline: 2px solid rgba(0,188,212,0.9);
          outline-offset: 2px;
          background: rgba(0,188,212,0.08);
        }
        .mi-track-cell.mi-dnd-drop-start-ok {
          box-shadow: inset 0 0 0 2px rgba(76,175,80,0.55);
        }
        .mi-track-cell.mi-dnd-hover-ok {
          outline: 2px dashed rgba(76,175,80,0.9);
          outline-offset: 2px;
          background: rgba(76,175,80,0.12);
        }
        .mi-track-cell.mi-dnd-hover-bad {
          outline: 2px dashed rgba(244,67,54,0.9);
          outline-offset: 2px;
          background: rgba(244,67,54,0.12);
        }
        .mi-dnd-handle {
          user-select: none;
        }
      `;
      document.head.appendChild(st);
    })();

    // (1) PRESET ROW
    const presets = createDefaultNfxPresets();
    const presetRow = document.createElement("div");
    presetRow.style.display = "flex";
    presetRow.style.flexWrap = "wrap";
    presetRow.style.alignItems = "center";
    presetRow.style.gap = "8px";
    presetRow.style.marginBottom = "10px";

    const presetLabel = document.createElement("label");
    presetLabel.textContent = "Preset:";
    presetRow.appendChild(presetLabel);

    const presetDropdown = document.createElement("select");
    presetDropdown.style.minWidth = "220px";
    presetDropdown.appendChild(new Option("Select preset…", ""));
    Object.keys(presets).sort().forEach(key => {
      presetDropdown.appendChild(new Option(key, key));
    });
    presetRow.appendChild(presetDropdown);

    const applyPresetBtn = document.createElement("button");
    applyPresetBtn.textContent = "Load Preset → Track";
    applyPresetBtn.onclick = () => {
      const chosen = presetDropdown.value;
      if (!chosen) return;
      const startT = (state.selectedTrack == null) ? 15 : (state.selectedTrack | 0);
      applyPresetToDropdowns(sec, startT, presets[chosen]);
    };
    presetRow.appendChild(applyPresetBtn);

    // Hide presets on OS 1.63 / Original (no NFX)
    const __miIs163 =
      (String(window.mdOSVersion) === "1.63") ||
      (parseFloat(window.mdOSVersion) === 1.63) ||
      (String(window.mdOSVersion).toLowerCase() === "original");
    if (__miIs163) {
      presetRow.style.display = "none";
    }

    sec.appendChild(presetRow);

    // (3) TRACK GRID (2×8)
    const tracksContainer = document.createElement("div");
    tracksContainer.style.display = "grid";
    tracksContainer.style.gridTemplateColumns = "repeat(8, minmax(0, 1fr))";
    tracksContainer.style.gap = "10px";
    tracksContainer.style.margin = "10px 0 12px 0";
    tracksContainer.style.alignItems = "start";

    // Build machine list (sorted by name)
    function getImplanterMachineList() {
      let machines = (typeof window.getValidMachineEntries === "function")
        ? window.getValidMachineEntries(window.mdModel)
        : {};
      if (!machines) machines = {};

      // Filter out unsupported machines (support both Set and Array definitions)
      const __miHas = (collection, id) => {
        if (!collection) return false;
        // Set / Map
        if (typeof collection.has === "function") return collection.has(id) || collection.has(String(id));
        // Array
        if (Array.isArray(collection)) return collection.includes(id) || collection.includes(String(id));
        // Plain object map (e.g. { "7": true })
        if (typeof collection === "object") {
          return Object.prototype.hasOwnProperty.call(collection, id) ||
                 Object.prototype.hasOwnProperty.call(collection, String(id)) ||
                 !!collection[id] || !!collection[String(id)];
        }
        return false;
      };

      const is163 =
        (String(window.mdOSVersion) === "1.63") ||
        (parseFloat(window.mdOSVersion) === 1.63) ||
        (String(window.mdOSVersion).toLowerCase() === "original");

      // X-OS-only machines are not available on OS 1.63 / Original
      if (is163 && window.X_OS_ONLY_MACHINES) {
        machines = Object.fromEntries(
          Object.entries(machines).filter(([id]) => !__miHas(window.X_OS_ONLY_MACHINES, +id))
        );
      }

      // Optional: filter extended machines if present (treat as Set/Array/Object)
      if (window.EXTENDED_MACHINES) {
        machines = Object.fromEntries(
          Object.entries(machines).filter(([id]) => !__miHas(window.EXTENDED_MACHINES, +id))
        );
      }

      return Object.entries(machines)
        .map(([id, name]) => ({ id: +id, name: String(name || "") }))
        .filter(m => m.name && !/^\(unused\b/i.test(m.name))   // hide "(unused #..)" placeholders
        .sort((a,b) => a.name.localeCompare(b.name));
    }

    const machineList = getImplanterMachineList();

    const trackUIs = new Array(16);

    function updateTrackUI(t) {
      const ui = trackUIs[t];
      if (!ui) return;

      const presetData = state.trackPresetData[t];
      let machineId = state.trackMachineIDs[t];

      // Keep the dropdown + internal state in sync after drag/swaps.
      // For preset tracks the machineId inside presetData is the source-of-truth.
      if (presetData && presetData.machineId != null) {
        machineId = (presetData.machineId | 0);
        const cur = state.trackMachineIDs[t];
        if (cur == null || ((cur | 0) !== machineId)) state.trackMachineIDs[t] = machineId;
      } else if (machineId != null) {
        machineId = (machineId | 0);
      }

      const desiredSel = (machineId == null) ? "" : String(machineId);
      if (ui.sel && ui.sel.value !== desiredSel) ui.sel.value = desiredSel;

      const machineName = (machineId == null) ? "" : __miGetMachineName(machineId|0);
      const isNfx = __miIsNfxMachineName(machineName);

      // Wrap-around neighbour sourcing:
      // - Near  source for T01 is T16
      // - Far   source for T02 is T16
      const nearSrc = __miMod16(t - 1);
      const farSrc  = __miMod16(t - 2);
      ui.nearText.textContent = `Near: T${String(nearSrc+1).padStart(2,"0")} → T${String(t+1).padStart(2,"0")}`;
      ui.farText.textContent  = `Far: T${String(farSrc+1).padStart(2,"0")} → T${String(t+1).padStart(2,"0")}`;

      // Selected track highlight (used by preset-load + drag&swap UX)
      if (ui.cell) {
        if ((state.selectedTrack | 0) === (t | 0)) ui.cell.classList.add("mi-selected");
        else ui.cell.classList.remove("mi-selected");
      }

      ui.triggersRow.style.display = isNfx ? "flex" : "none";

      // Preset tracks: show relationships read-only
      if (presetData) {
        const nf = __miComputeNearFarFromPresetState(t, state);
        ui.nearCb.checked = nf.near;
        ui.farCb.checked  = nf.far;
        ui.nearCb.disabled = true;
        ui.farCb.disabled  = true;

        const trigSrc = (presetData.muteTrig && presetData.muteTrig.length > 1) ? (presetData.muteTrig[1] | 0) : 128;
        const trigSrcLabel = (trigSrc === 128) ? "—" : `T${String(trigSrc+1).padStart(2,"0")}`;
        const vol = (presetData.routing && presetData.routing.length > 1) ? (presetData.routing[1] | 0) : 0;
        ui.info.textContent = `Preset • TrigSrc:${trigSrcLabel} • VOL:${vol}`;
        ui.badge.textContent = "P";
        ui.badge.title = "Preset track data (full copy)";
      } else if (machineId != null) {
        ui.nearCb.disabled = !isNfx;
        ui.farCb.disabled  = !isNfx;

        const trig = state.trackTriggers[t] || { near:false, far:false };
        ui.nearCb.checked = !!trig.near && !ui.nearCb.disabled;
        ui.farCb.checked  = !!trig.far  && !ui.farCb.disabled;

        ui.info.textContent = isNfx ? "Manual • NFX (Near/Far applied on Generate)" : "Manual • (machine only)";
        ui.badge.textContent = "M";
        ui.badge.title = "Manual machine assignment";
      } else {
        ui.nearCb.checked = false;
        ui.farCb.checked  = false;
        ui.nearCb.disabled = true;
        ui.farCb.disabled  = true;
        ui.info.textContent = "";
        ui.badge.textContent = "";
        ui.badge.title = "";
      }
    }

    function updateAll() {
      for (let t=0; t<16; t++) updateTrackUI(t);
    }

    // --- Drag & swap (block-aware) ---
    // The goal: dragging any track swaps its entire linked block (2/3/4+ tracks)
    // without breaking internal trig/LFO track references.
    let __miDnd = null;

    const __miDndClassList = [
      "mi-dnd-src",
      "mi-dnd-drop-start-ok",
      "mi-dnd-hover-ok",
      "mi-dnd-hover-bad"
    ];

    function __miDndClearAllClasses() {
      for (let i = 0; i < 16; i++) {
        const c = trackUIs[i]?.cell;
        if (!c) continue;
        for (const cls of __miDndClassList) c.classList.remove(cls);
      }
    }

    function __miDndComputeValidStarts(srcIndices, len, groups, groupIdByTrack) {
      const srcSet = new Set(srcIndices.map(n => n | 0));
      const valid = new Set();

      for (let start = 0; start < 16; start++) {
        const dstIndices = __miConsecutiveIndices(start, len);
        const dstSet = new Set(dstIndices);

        // 1) no overlap with the source block
        let overlap = false;
        for (const idx of dstSet) {
          if (srcSet.has(idx)) { overlap = true; break; }
        }
        if (overlap) continue;

        // 2) do not split any other linked group
        let ok = true;
        const seenGids = new Set();
        for (const idx of dstSet) {
          const gid = groupIdByTrack[idx] | 0;
          if (seenGids.has(gid)) continue;
          seenGids.add(gid);

          const grp = groups[gid];
          if (!grp || !grp.set) continue;
          for (const m of grp.set) {
            if (!dstSet.has(m)) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) continue;

        valid.add(start);
      }
      return valid;
    }

    function __miDndStart(e, dragTrack) {
      // (Only start if the panel is visible and we have cells.)
      if (!trackUIs[dragTrack]?.cell) return;

      const grpInfo = __miComputeTrackGroups(state);
      const gid = grpInfo.groupIdByTrack[dragTrack] | 0;
      const grp = grpInfo.groups[gid] || { ordered: [dragTrack], set: new Set([dragTrack]) };
      const srcIndices = (grp.ordered && grp.ordered.length) ? grp.ordered.slice() : [dragTrack];
      const len = srcIndices.length;
      const relOffset = Math.max(0, srcIndices.indexOf(dragTrack));

      const validStarts = __miDndComputeValidStarts(srcIndices, len, grpInfo.groups, grpInfo.groupIdByTrack);

      __miDnd = {
        dragTrack: dragTrack | 0,
        relOffset,
        srcIndices,
        len,
        groups: grpInfo.groups,
        groupIdByTrack: grpInfo.groupIdByTrack,
        validStarts
      };

      // Visuals
      __miDndClearAllClasses();
      for (const idx of srcIndices) trackUIs[idx]?.cell?.classList.add("mi-dnd-src");
      for (const s of validStarts) trackUIs[s]?.cell?.classList.add("mi-dnd-drop-start-ok");

      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragTrack));
      } catch (_) {}
    }

    function __miDndOver(e, overTrack) {
      if (!__miDnd) return;
      e.preventDefault();
      const start = overTrack | 0;

      // Clear previous hover feedback (keep src + start-ok markers)
      for (let i = 0; i < 16; i++) {
        trackUIs[i]?.cell?.classList.remove("mi-dnd-hover-ok", "mi-dnd-hover-bad");
      }

      const dstIndices = __miConsecutiveIndices(start, __miDnd.len);
      const ok = __miDnd.validStarts.has(start);
      for (const idx of dstIndices) {
        const c = trackUIs[idx]?.cell;
        if (!c) continue;
        c.classList.add(ok ? "mi-dnd-hover-ok" : "mi-dnd-hover-bad");
      }
      try { e.dataTransfer.dropEffect = ok ? "move" : "none"; } catch (_) {}
    }

    function __miDndDrop(e, dropTrack) {
      if (!__miDnd) return;
      e.preventDefault();

      const start = dropTrack | 0;
      if (!__miDnd.validStarts.has(start)) return;

      const dstIndices = __miConsecutiveIndices(start, __miDnd.len);

      // Perform swap + remap internal track references
      __miSwapTrackSegments(state, __miDnd.srcIndices, dstIndices);

      // Keep "selected track" feeling intuitive: the track you grabbed stays under your cursor
      state.selectedTrack = (dstIndices[__miDnd.relOffset] == null) ? start : (dstIndices[__miDnd.relOffset] | 0);

      __miDndClearAllClasses();
      __miDnd = null;
      updateAll();
    }

    function __miDndEnd() {
      if (!__miDnd) return;
      __miDndClearAllClasses();
      __miDnd = null;
    }

    for (let t = 0; t < 16; t++) {
      const cell = document.createElement("div");
      cell.classList.add("mi-track-cell");
      cell.dataset.trackIndex = String(t);
      cell.style.border = "1px solid rgba(255,255,255,0.12)";
      cell.style.borderRadius = "6px";
      cell.style.padding = "8px";
      cell.style.minWidth = "0";

      const head = document.createElement("div");
      head.style.display = "flex";
      head.style.alignItems = "center";
      head.style.justifyContent = "space-between";
      head.style.marginBottom = "6px";
      head.classList.add("mi-dnd-handle");
      head.title = "Drag to swap linked tracks";
      head.style.cursor = "grab";
      head.draggable = true;
      // Selection highlight follows the last interacted track
      head.addEventListener("click", (ev) => {
        // avoid selecting when user is dragging
        if (__miDnd) return;
        state.selectedTrack = t;
        updateAll();
      });
      // Drag events (start/end on handle)
      head.addEventListener("dragstart", (e) => __miDndStart(e, t));
      head.addEventListener("dragend", () => __miDndEnd());

      // Drop events (over the entire cell)
      cell.addEventListener("dragover", (e) => __miDndOver(e, t));
      cell.addEventListener("dragenter", (e) => __miDndOver(e, t));
      cell.addEventListener("drop", (e) => __miDndDrop(e, t));

      const lbl = document.createElement("div");
      lbl.style.fontWeight = "600";
      lbl.textContent = `T${String(t+1).padStart(2,"0")}`;
      head.appendChild(lbl);

      const badge = document.createElement("div");
      badge.style.fontSize = "0.75em";
      badge.style.opacity = "0.9";
      badge.style.padding = "1px 6px";
      badge.style.borderRadius = "10px";
      badge.style.border = "1px solid rgba(255,255,255,0.15)";
      badge.textContent = "";
      head.appendChild(badge);

      cell.appendChild(head);

      const sel = document.createElement("select");
      sel.id = `imp_track${t}`;
      sel.style.width = "100%";
      sel.appendChild(new Option("—", ""));
      for (const m of machineList) {
        sel.appendChild(new Option(m.name, String(m.id)));
      }
      // Initial value
      sel.value = (state.trackMachineIDs[t] == null) ? "" : String(state.trackMachineIDs[t]);

      sel.addEventListener("change", () => {
        const v = sel.value === "" ? null : (+sel.value | 0);
        state.trackMachineIDs[t] = v;
        // Manual change clears preset data for this track
        state.trackPresetData[t] = null;
        state.selectedTrack = t;
        updateAll();
      });
      cell.appendChild(sel);

      const triggersRow = document.createElement("div");
      triggersRow.style.display = "none";
      triggersRow.style.flexDirection = "column";
      triggersRow.style.gap = "4px";
      triggersRow.style.marginTop = "8px";

      const nearWrap = document.createElement("label");
      nearWrap.style.display = "flex";
      nearWrap.style.alignItems = "center";
      nearWrap.style.gap = "6px";
      const nearCb = document.createElement("input");
      nearCb.type = "checkbox";
      const nearText = document.createElement("span");
      nearText.textContent = "Near";
      nearWrap.appendChild(nearCb);
      nearWrap.appendChild(nearText);

      const farWrap = document.createElement("label");
      farWrap.style.display = "flex";
      farWrap.style.alignItems = "center";
      farWrap.style.gap = "6px";
      const farCb = document.createElement("input");
      farCb.type = "checkbox";
      const farText = document.createElement("span");
      farText.textContent = "Far";
      farWrap.appendChild(farCb);
      farWrap.appendChild(farText);

      nearCb.addEventListener("change", () => {
        state.trackTriggers[t] = state.trackTriggers[t] || { near:false, far:false };
        state.trackTriggers[t].near = !!nearCb.checked;
        state.selectedTrack = t;
        updateAll();
      });
      farCb.addEventListener("change", () => {
        state.trackTriggers[t] = state.trackTriggers[t] || { near:false, far:false };
        state.trackTriggers[t].far = !!farCb.checked;
        state.selectedTrack = t;
        updateAll();
      });

      triggersRow.appendChild(nearWrap);
      triggersRow.appendChild(farWrap);

      cell.appendChild(triggersRow);

      const info = document.createElement("div");
      info.style.marginTop = "6px";
      info.style.fontSize = "0.78em";
      info.style.opacity = "0.85";
      info.textContent = "";
      cell.appendChild(info);

      trackUIs[t] = {
        cell,
        sel,
        triggersRow,
        nearCb,
        farCb,
        nearText,
        farText,
        info,
        badge
      };

      tracksContainer.appendChild(cell);

      // Initial state render for this track
      updateTrackUI(t);
    }

    sec.appendChild(tracksContainer);

    // Store UI refs for reset/preset loader
    sec.__machineImplanterUI = {
      trackUIs,
      updateTrackUI,
      updateAll
    };

    // (4) KIT RANGE
    const rangeWrapper = document.createElement("div");
    rangeWrapper.style.marginTop = "10px";
    rangeWrapper.appendChild(
      createRangeSliderRow(
        "Range:",
        "imp_kitRange",
        1,
        64,
        1,
        64,
        1,
        i => `Kit ${String(i).padStart(2, "0")}`
      )
    );
    sec.appendChild(rangeWrapper);
    // (5) APPLY BUTTON (centered)
    const genBtn = document.createElement("button");
    genBtn.textContent = "Generate to Kits";
    genBtn.onclick = applyMachineImplanter;

    const genRow = document.createElement("div");
    genRow.className = "lab-action-row lab-action-row-center";
    genRow.style.marginTop = "2px";
    genRow.appendChild(genBtn);
    sec.appendChild(genRow);

    return sec;
  }

})();
