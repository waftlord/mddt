/* machinedrum-kit-sysex.js */

window.hexDump = (arr, bytesPerLine = 16) =>
  Array.from({ length: Math.ceil(arr.length / bytesPerLine) }, (_, i) => {
    const slice = arr.slice(i * bytesPerLine, i * bytesPerLine + bytesPerLine);
    return i.toString(16).padStart(4, "0") + " : " +
      slice.map(b => b.toString(16).padStart(2, "0")).join(" ");
  }).join("\n");

function encode7Bit(rawBytes) {
  const out = [];
  for (let i = 0; i < rawBytes.length; i += 7) {
    const block = rawBytes.slice(i, i + 7);
    let header = 0;
    for (let j = 0; j < block.length; j++) {
      if (block[j] & 0x80) {
        header |= (1 << (6 - j));
      }
    }
    out.push(header & 0x7F);
    for (let j = 0; j < block.length; j++) {
      out.push(block[j] & 0x7F);
    }
  }
  return new Uint8Array(out);
}

window.padOrSlice = (arr, wantLen) => {
  if (arr.length === wantLen) return arr;
  if (arr.length > wantLen) return arr.slice(0, wantLen);
  return new Uint8Array([...arr, ...new Uint8Array(wantLen - arr.length)]);
};

window.decode7BitDynamic = (arr, startIndex, neededRawBytes) => {
  const out = [];
  let i = startIndex;
  while (out.length < neededRawBytes && i < arr.length) {
    const header = arr[i++] & 0x7F;
    for (let bit = 0; bit < 7 && out.length < neededRawBytes && i < arr.length; bit++) {
      const low = arr[i++] & 0x7F;
      const restored = ((header >> (6 - bit)) & 1 ? 0x80 : 0) | (low & 0x7F);
      out.push(restored);
    }
  }
  return { result: out, consumed: i - startIndex };
};

window.shiftKeyIsDown = false;
window.kit = window.kit || {};

if (!kit.muteTrigRelations) {
  kit.muteTrigRelations = Array.from({ length: 16 }, () => [128, 128]);
}
if (!kit.machineParams) {
  kit.machineParams = Array.from({ length: 16 }, () => new Array(8).fill(64));
}
if (!kit.trackFx) {
  kit.trackFx = Array.from({ length: 16 }, () => new Array(8).fill(0));
}
if (!kit.routing) {
  kit.routing = Array.from({ length: 16 }, () => new Array(8).fill(0));
}
if (!kit.trackLevels) {
  kit.trackLevels = new Array(16).fill(100);
}

window.lastParsedKit = null;

const MD_SYSEX_HEADER   = [0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00];
const MD_KIT_MESSAGE_ID = 0x52;
const MD_KIT_REQUEST_ID = 0x53;
const TOTAL_LENGTH      = 0x4D1; // 1233 bytes

const OFF = {
  SYSEX_VERSION: 0x07,
  KITNAME: 0x0A,       LEN_KITNAME: 16,
  TRACK_PARAMS: 0x1A,  LEN_TRACK_PARAMS: 384,
  TRACK_LEVELS: 0x19A, LEN_TRACK_LEVELS: 16,
  MODEL7: 0x1AA,       LEN_MODEL7_RAW: 64,  LEN_MODEL7_ENCODED: 74,
  LFO7: 0x1F4,         LEN_LFO7_RAW: 576,   LEN_LFO7_ENCODED: 659,
  REVERB: 0x487,       LEN_REVERB: 8,
  DELAY: 0x48F,        LEN_DELAY: 8,
  EQ: 0x497,           LEN_EQ: 8,
  DYNAMICS: 0x49F,     LEN_DYNAMICS: 8,
  TRIG7: 0x4A7,        LEN_TRIG7_RAW: 32,   LEN_TRIG7_ENCODED: 37,
  CHECKSUM_HI: 0x4CC,
  CHECKSUM_LO: 0x4CD,
  LENGTH_HI: 0x4CE,
  LENGTH_LO: 0x4CF,
  SYSEX_END: 0x4D0
};

const LFO_TRACK = 0;
const LFO_PARAM = 1;
const LFO_WAVE_SHAPE = 2;

window.isCCLinkEnabled = () => {
  const el = document.getElementById("ccLinkCheckbox");
  return el && el.checked;
};

// MD base channel: 0..12 = MIDI ch 1..13, 13 = OFF
function getEffectiveBaseChannel() {
  let base = 0;
  if (typeof window.currentBaseChannel === "number") base = window.currentBaseChannel;
  else if (window.globalData && typeof window.globalData.midiBase === "number") base = window.globalData.midiBase;

  base = base | 0;
  if (base === 13) return null;
  if (base < 0) base = 0;
  if (base > 12) base = 12;
  return base;
}

window.sendKitCC = (trackNum, category, paramIndex, value) => {
  if (!window.selectedMidiOut || !window.isCCLinkEnabled()) return;
  const baseChan = getEffectiveBaseChannel();
  // Guard against base=OFF (13). Without this, channel math wraps & sends on wrong chans.
  if (baseChan == null) {
    if (!window.__warnedBaseOffCCLink) {
      console.warn("[CC Link] MIDI Base Channel is OFF. Enable a base channel (1–13) to use CC Link.");
      window.__warnedBaseOffCCLink = true;
    }
    return;
  }
  const group = Math.floor((trackNum - 1) / 4);
  const channel = baseChan + group; // safe: base <= 12 so channel <= 15
  const status = 0xB0 | (channel & 0x0F);
  const mapObj = window.MD_CC_MAP[trackNum];
  if (!mapObj) return;
  let ccNum = null;
  if (category === "level") ccNum = mapObj.level;
  else if (["machineParams", "trackFx", "routing"].includes(category)) {
    const offset = category === "trackFx" ? 8 : category === "routing" ? 16 : 0;
    ccNum = mapObj.param[offset + paramIndex];
  }
  if (ccNum == null) return;
  window.selectedMidiOut.send([status, ccNum & 0x7F, value & 0x7F]);
};

window.requestKitSysex = (kNum) => {
  return new Uint8Array([...MD_SYSEX_HEADER, MD_KIT_REQUEST_ID, (kNum & 0x3F), 0xF7]);
};

window.receiveKitDump = (fullKitMsg) => {
  if (window.blockSlotWrites) return;
  if (!fullKitMsg || fullKitMsg.length < 5) return;

  // Some code paths (e.g. promise-based MIDI receive, certain importers)
  // may provide a Uint8Array instead of a plain Array. Several parts of the
  // legacy KIT parser rely on Array semantics (notably mapping bytes to
  // characters for kitName, and JSON deep-clone in bulk receive).
  // Normalize to a plain Array of numbers.
  if (!Array.isArray(fullKitMsg)) {
    fullKitMsg = Array.from(fullKitMsg);
  }
  let idx = 0;

  // Header
  kit.sysexVersion  = fullKitMsg[idx++] & 0x7F;
  kit.sysexRevision = fullKitMsg[idx++] & 0x7F;
  kit.sysexPosition = fullKitMsg[idx++] & 0x7F;

  // Kit Name
  // Kit Name (trim padding at first zero)
  const rawNameBytes = fullKitMsg
    .slice(idx, idx + OFF.LEN_KITNAME)
    .map(c => c & 0x7F);
  idx += OFF.LEN_KITNAME;

  // don’t include any trailing 0x00 bytes
  const end = rawNameBytes.indexOf(0);
  const nameBytes = end >= 0
    ? rawNameBytes.slice(0, end)
    : rawNameBytes;

  kit.kitName = nameBytes.map(b => String.fromCharCode(b));

  // Track Parameters
  kit.machineParams = [];
  kit.trackFx = [];
  kit.routing = [];
  for (let t = 0; t < 16; t++) {
    const slice24 = fullKitMsg.slice(idx, idx + 24);
    kit.machineParams[t] = slice24.slice(0, 8).map(v => Math.min(v, 127));
    kit.trackFx[t]       = slice24.slice(8, 16).map(v => Math.min(v, 127));
    kit.routing[t]       = slice24.slice(16, 24).map(v => Math.min(v, 127));
    idx += 24;
  }

  // Track Levels
  kit.trackLevels = Array.from(fullKitMsg.slice(idx, idx + OFF.LEN_TRACK_LEVELS)).map(v => Math.min(v, 127));
  idx += OFF.LEN_TRACK_LEVELS;

  // MODEL7 (Machine Models)
  let dec = decode7BitDynamic(fullKitMsg, idx, OFF.LEN_MODEL7_RAW);
  const rawModel = dec.result;
  idx += dec.consumed;
  
  kit.machineAssignments = kit.machineAssignments || [];
  kit.machineTonalFlags  = kit.machineTonalFlags || [];
  for (let t = 0; t < 16; t++) {
    const base = t * 4;
    const rawVal =
      (rawModel[base + 0] << 24) |
      (rawModel[base + 1] << 16) |
      (rawModel[base + 2] << 8) |
      (rawModel[base + 3]);
    
    let tonalFlag = 0, machineID = 0;
    if (kit.sysexVersion < 64) {
      machineID = rawVal & 0xFFFF;
      tonalFlag = 0;
    } else {
      tonalFlag = (rawVal >>> 17) & 0x1;
      machineID = rawVal & 0xFFFF;
    }
    kit.machineAssignments[t] = machineID;
    kit.machineTonalFlags[t]  = tonalFlag;
  }

  // LFO7
  dec = decode7BitDynamic(fullKitMsg, idx, OFF.LEN_LFO7_RAW);
  const rawLFO = dec.result;
  idx += dec.consumed;

  // Partition the raw LFO data into 16 blocks of 36 bytes each
kit.lfoBlocks = [];
let p = 0;
for (let t = 0; t < 16; t++) {
  kit.lfoBlocks[t] = rawLFO.slice(p, p + 36).map(v => v & 0x7F);
  p += 36;
}

  // Master FX
  kit.masterFx = Array.from(fullKitMsg.slice(idx, idx + 32)).map(v => Math.min(v, 127));
  idx += 32;

  // TRIG7 (Trigger/Mute Groups)
  const trigEncoded = fullKitMsg.slice(idx, idx + OFF.LEN_TRIG7_ENCODED);
  dec = decode7BitDynamic(fullKitMsg, idx, OFF.LEN_TRIG7_RAW);
  const rawTrig = dec.result;
  idx += dec.consumed;
  
  kit.muteTrigRelations = kit.muteTrigRelations || [];
  for (let t = 0; t < 16; t++) {
    let trig = rawTrig[t];
    let mute = rawTrig[16 + t];
    if (trig === 255) { trig = 128; }
    if (mute === 255) { mute = 128; }
    kit.muteTrigRelations[t] = [mute, trig];
  }

  // Skip bytes until checksum
  idx = OFF.CHECKSUM_HI;

  // Re-encode Dump to Verify
  const reEncoded = createKitDump(kit);
};

function normalizeKit(kitObj) {
  // Only normalize to version 64 when not running under OS 1.63
  if (kitObj.sysexVersion !== 64 && window.mdOSVersion !== "1.63") {
    kitObj.sysexVersion = 64;
    kitObj.sysexRevision = 1;

    // Track-level clamp: 127 → 100
    for (let t = 0; t < 16; t++) {
      if (kitObj.trackLevels[t] === 127) {
        kitObj.trackLevels[t] = 100;
      }
    }

    // Legacy machine-ID mapping & tonal-flag normalization
    const legacyMachineMapping = { 61: 64 };
    for (let t = 0; t < 16; t++) {
      let m = kitObj.machineAssignments[t];
      if (legacyMachineMapping.hasOwnProperty(m)) {
        kitObj.machineAssignments[t] = legacyMachineMapping[m];
      }
      kitObj.machineTonalFlags[t] = kitObj.machineTonalFlags[t] ? 1 : 0;
    }

    // LFO-block rescaling
    for (let t = 0; t < 16; t++) {
      const block = kitObj.lfoBlocks[t];
      if (block && block.length >= 5) {
        // Wave‐shape primary: scale 0–5 to 0–10
        block[LFO_WAVE_SHAPE] = Math.round((block[LFO_WAVE_SHAPE] / 5) * 10);
        // Wave‐shape alternate (index 3): same scaling
        block[3] = Math.round((block[3] / 5) * 10);
        // Phase‐offset clamp to 0–2
        block[4] = Math.max(0, Math.min(2, block[4]));
      }
    }
  }

  return kitObj;
}

function createKitDump(kitData) {
  const dataObj = kitData && kitData.data ? kitData.data : (kitData || window.kit);
  const dump = new Uint8Array(TOTAL_LENGTH).fill(0);
  
  // Header
  dump.set(MD_SYSEX_HEADER, 0);
  dump[6] = MD_KIT_MESSAGE_ID;
  let ver   = dataObj.sysexVersion  || 64;
let rev   = dataObj.sysexRevision || 1;
if (window.mdOSVersion === "1.63") {
  ver = 4;
  rev = 1;
}
dump[7] = ver & 0x7F;
dump[8] = rev & 0x7F;
  dump[9] = (dataObj.sysexPosition || 0) & 0x7F;
  
  // Kit Name
  const nameStr = Array.isArray(dataObj.kitName)
                    ? dataObj.kitName.join("")
                    : (dataObj.kitName || "DEFAULT");
  for (let i = 0; i < OFF.LEN_KITNAME; i++) {
    const c = (i < nameStr.length ? nameStr.charCodeAt(i) : 0);
    dump[OFF.KITNAME + i] = Math.min(c, 127);
  }
  
  // Track Parameters
  for (let t = 0; t < 16; t++) {
    const base = OFF.TRACK_PARAMS + t * 24;
    const mp = (dataObj.machineParams && dataObj.machineParams[t]) || [];
    const fx = (dataObj.trackFx       && dataObj.trackFx[t])       || [];
    const rt = (dataObj.routing       && dataObj.routing[t])       || [];
    for (let i = 0; i < 8; i++) {
      dump[base + i]      = Math.min((mp[i] || 0), 127);
      dump[base + 8 + i]  = Math.min((fx[i] || 0), 127);
      dump[base + 16 + i] = Math.min((rt[i] || 0), 127);
    }
  }
  
  // Track Levels
  for (let t = 0; t < 16; t++) {
    const lvl = (dataObj.trackLevels && dataObj.trackLevels[t] !== undefined)
                  ? dataObj.trackLevels[t]
                  : 0;
    dump[OFF.TRACK_LEVELS + t] = Math.min(lvl, 127);
  }
  
  // MODEL7 (Machine Models)
  const modelRaw = new Uint8Array(64);
  for (let t = 0; t < 16; t++) {
    let modelID = dataObj.machineAssignments[t] || 0;
    let tonal   = dataObj.machineTonalFlags[t] ? 1 : 0;
    let rawVal;
    
    if ((ver || 0) < 64) {
      rawVal = modelID & 0xFFFF;
    } else {
      rawVal = ((tonal & 1) << 17) | (modelID & 0xFFFF);
    }
    
    const base = t * 4;
    modelRaw[base + 0] = (rawVal >>> 24) & 0xFF;
    modelRaw[base + 1] = (rawVal >>> 16) & 0xFF;
    modelRaw[base + 2] = (rawVal >>>  8) & 0xFF;
    modelRaw[base + 3] = (rawVal       ) & 0xFF;
  }
  const packedModel = encode7Bit(modelRaw);
  dump.set(padOrSlice(packedModel, OFF.LEN_MODEL7_ENCODED), OFF.MODEL7);
  
  // LFO7
  const lfoRaw = new Uint8Array(576);
  let p = 0;
  for (let t = 0; t < 16; t++) {
    const lfo = (dataObj.lfoBlocks && dataObj.lfoBlocks[t]) ? dataObj.lfoBlocks[t] : [];
    for (let i = 0; i < 36; i++) {
      const val = (lfo[i] !== undefined ? lfo[i] : 0);
      lfoRaw[p++] = Math.min(val, 127);
    }
  }
  const packedLFO = encode7Bit(lfoRaw);
  dump.set(padOrSlice(packedLFO, OFF.LFO7_ENCODED), OFF.LFO7);
  
  // Master FX
  for (let i = 0; i < 32; i++) {
    const fxVal = (dataObj.masterFx && dataObj.masterFx[i] !== undefined)
                  ? dataObj.masterFx[i]
                  : 0;
    dump[OFF.REVERB + i] = Math.min(fxVal, 127);
  }
  
  // TRIG7 (Trigger/Mute Groups)
  const trigRaw = new Uint8Array(32);
  for (let t = 0; t < 16; t++) {
    const trigVal = (dataObj.muteTrigRelations && dataObj.muteTrigRelations[t])
                      ? dataObj.muteTrigRelations[t][1]
                      : 0;
    const muteVal = (dataObj.muteTrigRelations && dataObj.muteTrigRelations[t])
                      ? dataObj.muteTrigRelations[t][0]
                      : 0;
    
    let tv, mv;
    if (trigVal === 128) {
      tv = 255;
    } else {
      tv = (trigVal < 0) ? 0 : ((trigVal > 15) ? 15 : trigVal);
    }
    
    if (muteVal === 128) {
      mv = 255;
    } else {
      mv = (muteVal < 0) ? 0 : ((muteVal > 15) ? 15 : muteVal);
    }
    
    trigRaw[t] = tv;
    trigRaw[16 + t] = mv;
  }
  const packedTrig = encode7Bit(trigRaw);
  dump.set(padOrSlice(packedTrig, OFF.LEN_TRIG7_ENCODED), OFF.TRIG7);
  
  // Checksum and Length
  for (let i = OFF.TRIG7 + OFF.LEN_TRIG7_ENCODED; i < OFF.CHECKSUM_HI; i++) {
    dump[i] = 0;
  }
  let sum = 0;
  for (let i = 9; i < OFF.CHECKSUM_HI; i++) {
    sum += dump[i];
  }
  sum &= 0x3FFF;
  dump[OFF.CHECKSUM_HI] = (sum >> 7) & 0x7F;
  dump[OFF.CHECKSUM_LO] = sum & 0x7F;
  
  const docLen = TOTAL_LENGTH - 10;
  dump[OFF.LENGTH_HI] = (docLen >> 7) & 0x7F;
  dump[OFF.LENGTH_LO] = docLen & 0x7F;
  dump[OFF.SYSEX_END] = 0xF7;
  
  return dump;
}

const MD_CUSTOM24 = [
  "NOTE","N2","N3","LEN","VEL","PB","MW","AT",
  "CC1D","CC1V","CC2D","CC2V","CC3D","CC3V","CC4D","CC4V",
  "CC5D","CC5V","CC6D","CC6V","PCHG","LFOS","LFOD","LFOM"
];
const CTR_8P_24 = [
  "P1","P2","P3","P4","P5","P6","P7","P8",
  "P1T","P1P","P2T","P2P","P3T","P3P","P4T","P4P",
  "P5T","P5P","P6T","P6P","P7T","P7P","P8T","P8P"
];

function getSpecialTrackFxLabel(machineID, paramIndex) {
  if (machineID >= 96 && machineID <= 111) return MD_CUSTOM24[paramIndex + 8] || "";
  if (machineID === 113) return CTR_8P_24[paramIndex + 8] || "";
  return "";
}
function getSpecialRoutingLabel(machineID, paramIndex) {
  if (machineID >= 96 && machineID <= 111) return MD_CUSTOM24[paramIndex + 16] || "";
  if (machineID === 113) return CTR_8P_24[paramIndex + 16] || "";
  return "";
}

window.resetMasterFxBlock = (blockIndex) => {
  const start = blockIndex * 8;
  const defaultSlice = DEFAULT_MASTER_FX.slice(start, start + 8);
  for (let i = 0; i < 8; i++) {
    kit.masterFx[start + i] = defaultSlice[i];
  }
};

window.randomizeMasterFxBlock = (blockIndex) => {
  const start = blockIndex * 8;
  for (let i = 0; i < 8; i++) {
    kit.masterFx[start + i] = partialRandom(kit.masterFx[start + i], (i === 3 ? "FB" : ""));
  }
};

function renderKitTrackRow(t) {
  const tr = document.createElement("tr");
  tr.classList.add("kit-track-row");
  if (t === (window.selectedKitTrackIndex || 0)) {
    tr.classList.add("selected");
  }
  tr.dataset.trackIndex = String(t);

  const tdTrack = document.createElement("td");
  tdTrack.textContent = String(t + 1);
  tdTrack.classList.add("shiftHover");
  tdTrack.style.userSelect = "none";
  tdTrack.draggable = true;
  tdTrack.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", String(t));
    tdTrack.classList.add("track-dragging");
  });
  tdTrack.addEventListener("dragenter", e => {
    tr.classList.add("drop-target");
  });
  tdTrack.addEventListener("dragleave", e => {
    tr.classList.remove("drop-target");
  });
  tdTrack.addEventListener("dragover", e => e.preventDefault());
  tdTrack.addEventListener("drop", e => {
    e.preventDefault();
    tr.classList.remove("drop-target");
    const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (fromIndex === t) return;
    swapKitTrackData(fromIndex, t);
    updateKitTrackRow(fromIndex);
    updateKitTrackRow(t);
  });
  tdTrack.addEventListener("dragend", e => {
    tdTrack.classList.remove("track-dragging");
  });
  tdTrack.onclick = e => {
    e.stopPropagation();
    if (e.shiftKey) {
      window.randomizeOneKitTrack(t);
      updateKitTrackRow(t);
      updateKnobRow(
        t, 
        "machineParamsUI", 
        kit.machineParams, 
        ["Param1", "Param2", "Param3", "Param4", "Param5", "Param6", "Param7", "Param8"],
        "machineParams"
      );
      updateKnobRow(
        t, 
        "trackFxUI", 
        kit.trackFx, 
        ["AMdep", "AMfrq", "EQfrq", "EQgain", "FltBase", "FltWidth", "FltQ", "SRR"],
        "trackFx"
      );
      updateKnobRow(
        t, 
        "routingUI", 
        kit.routing, 
        ["Dist", "Vol", "Pan", "DelSnd", "RevSnd", "LFOspd", "LFOdep", "LFOmix"],
        "routing"
      );
    } else {
      window.onClickKitTrack(t);
    }
  };
  tr.appendChild(tdTrack);

  let td = document.createElement("td");
  const machineSelect = document.createElement("select");
  let validPool = window.getValidMachinePool?.() || [];
  if (window.mdOSVersion === "1.63" && Array.isArray(window.X_OS_ONLY_MACHINES)) {
  validPool = validPool.filter(id => !window.X_OS_ONLY_MACHINES.includes(id));
}
  validPool.forEach(machineID => {
    const opt = document.createElement("option");
    opt.value = String(machineID);
    opt.textContent = window.getMachineName ? window.getMachineName(machineID) : `ID#${machineID}`;
    machineSelect.appendChild(opt);
  });
  const curID = kit.machineAssignments[t] || 0;
  machineSelect.value = String(curID);
  machineSelect.onchange = function () {
    const newVal = parseInt(this.value, 10) || 0;
    kit.machineAssignments[t] = newVal;
    if (window.MACHINES_THAT_SUPPORT_TONAL && !window.MACHINES_THAT_SUPPORT_TONAL.has(newVal)) {
      kit.machineTonalFlags[t] = 0;
    }
    if (typeof window.initUI === "function") {
      window.initUI();
    } else {
      buildTrackOverviewUI();
      buildKnobGrid("machineParamsUI", kit.machineParams, 
                     ["Param1", "Param2", "Param3", "Param4", "Param5", "Param6", "Param7", "Param8"], true);
      buildKnobGrid("trackFxUI", kit.trackFx, 
                     ["AMdep", "AMfrq", "EQfrq", "EQgain", "FltBase", "FltWidth", "FltQ", "SRR"], true);
      buildKnobGrid("routingUI", kit.routing, 
                     ["Dist", "Vol", "Pan", "DelSnd", "RevSnd", "LFOspd", "LFOdep", "LFOmix"], true);
    }
  };
  td.appendChild(machineSelect);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "0");
  const tonalCb = document.createElement("input");
  tonalCb.type = "checkbox";
 if (window.mdOSVersion === "1.63") {
  tonalCb.disabled = true;
  tonalCb.checked  = false;
}
else if (window.MACHINES_THAT_SUPPORT_TONAL && !window.MACHINES_THAT_SUPPORT_TONAL.has(curID)) {
  tonalCb.disabled = true;
    tonalCb.checked = false;
  } else {
    tonalCb.disabled = false;
    tonalCb.checked = !!kit.machineTonalFlags[t];
  }
  tonalCb.onchange = function () {
    kit.machineTonalFlags[t] = this.checked ? 1 : 0;
    updatePanelHeaderColors?.();
    updateKitTrackRow(t);
  };
  td.appendChild(tonalCb);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "1");
  
  const levSlider = document.createElement("input");
  levSlider.type = "range";
  levSlider.min = "0";
  levSlider.max = "127";
  levSlider.value = kit.trackLevels[t] || 0;
  
  let levelSliderUpdateTimer;
  levSlider.addEventListener("input", function () {
    const newVal = parseInt(this.value, 10);
  
    kit.trackLevels[t] = newVal;
    window.sendKitCC?.(t + 1, "level", null, newVal);
  
    if (window.shiftKeyIsDown) {
      for (let tt = 0; tt < 16; tt++) {
        kit.trackLevels[tt] = newVal;
        const row = document.querySelector(
          `#trackOverviewUI table tbody tr[data-track-index="${tt}"]`
        );
        const otherSlider = row?.querySelector(
          'td[data-block="trackOverview"][data-param-index="1"] input[type="range"]'
        );
        if (otherSlider) otherSlider.value = newVal;
      }
    }
    updatePanelHeaderColors?.();
  });
  
  levSlider.addEventListener("change", () => {
    updateKitTrackRow(t);
    updatePanelHeaderColors?.();
  });
  
  levSlider.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });
  td.appendChild(levSlider);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "2");
  const muteSel = document.createElement("select");
  addMuteTrigOptions(muteSel);
  let curMute = (kit.muteTrigRelations[t] && kit.muteTrigRelations[t][0] !== undefined)
                ? kit.muteTrigRelations[t][0]
                : 128;
  muteSel.value = String(curMute);
  muteSel.onchange = function () {
    kit.muteTrigRelations[t][0] = parseInt(this.value, 10);
    updatePanelHeaderColors?.();
    updateKitTrackRow(t);
  };
  td.appendChild(muteSel);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "3");
  const trigSel = document.createElement("select");
  addMuteTrigOptions(trigSel);
  let curTrig = (kit.muteTrigRelations[t] && kit.muteTrigRelations[t][1] !== undefined)
                ? kit.muteTrigRelations[t][1]
                : 128;
  trigSel.value = String(curTrig);
  trigSel.onchange = function () {
    kit.muteTrigRelations[t][1] = parseInt(this.value, 10);
    updatePanelHeaderColors?.();
    updateKitTrackRow(t);
  };
  td.appendChild(trigSel);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "4");
  const lfoSelTrk = document.createElement("select");
  for (let i = 0; i < 16; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i + 1);
    lfoSelTrk.appendChild(opt);
  }
  let lfoTrack = (kit.lfoBlocks[t] && kit.lfoBlocks[t][LFO_TRACK] !== undefined)
                 ? kit.lfoBlocks[t][LFO_TRACK]
                 : t;
  lfoSelTrk.value = String(Math.max(0, Math.min(15, lfoTrack)));
  lfoSelTrk.onchange = function () {
    kit.lfoBlocks[t][LFO_TRACK] = parseInt(this.value, 10);
    updatePanelHeaderColors?.();
    updateLfoParamDropdownForTrack(t, lfoParamSelect);
    updateKitTrackRow(t);
  };
  td.appendChild(lfoSelTrk);
  tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "5");
  const lfoParamSelect = document.createElement("select");
  function updateLfoParamDropdownForTrack(track, dropdown) {
    dropdown.innerHTML = "";
    const destTrack = (kit.lfoBlocks[track] && kit.lfoBlocks[track][LFO_TRACK] !== undefined)
                      ? kit.lfoBlocks[track][LFO_TRACK]
                      : track;
    const machineID = (kit.machineAssignments && typeof kit.machineAssignments[destTrack] !== "undefined")
                      ? kit.machineAssignments[destTrack]
                      : 1;
    for (let paramId = 0; paramId < 24; paramId++) {

      const opt = document.createElement("option");
      let category, index;
      if (paramId < 8) {
        category = "machineParams";
        index = paramId;
      } else if (paramId < 16) {
        category = "trackFx";
        index = paramId - 8;
      } else {
        category = "routing";
        index = paramId - 16;
      }
      let label = "";
      if ((machineID >= 96 && machineID <= 111) || machineID === 113) {
        if (category === "trackFx") {
          label = getSpecialTrackFxLabel(machineID, index);
        } else if (category === "routing") {
          label = getSpecialRoutingLabel(machineID, index);
        }
      }
      if (!label) {
        label = window.getParamLabel?.(machineID, index, category) || `(${paramId + 1})`;
      }
      opt.textContent = label;
      opt.value = String(paramId + 1);
      dropdown.appendChild(opt);
    }
    let currentParam = (kit.lfoBlocks[track] && kit.lfoBlocks[track][LFO_PARAM] !== undefined)
                       ? kit.lfoBlocks[track][LFO_PARAM] + 1
                       : 1;
    dropdown.value = String(currentParam);
  }
  updateLfoParamDropdownForTrack(t, lfoParamSelect);
  lfoParamSelect.onchange = function () {
    kit.lfoBlocks[t][LFO_PARAM] = parseInt(this.value, 10) - 1;
    updateKitTrackRow(t);
    updatePanelHeaderColors?.();
  };
  td.appendChild(lfoParamSelect);
  tr.appendChild(td);

// Wave1 cell
td = document.createElement("td");
td.setAttribute("data-block", "trackOverview");
td.setAttribute("data-param-index", "6");
const selWave1 = document.createElement("select");

// full master list
const fullWaveList1 = ["╱╲", "|╲|╲", "|‾‾|_|", "|╲_", "|◟", "%?", "_/‾", "_)‾", "∿️", "_|‾‾", "╱╲_"];
// only use as many as allowed by current OS version
const waveList1 = fullWaveList1.slice(0, window.MD_LFO_WAVE_COUNT);

waveList1.forEach((label, i) => {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = label;
  selWave1.appendChild(opt);
});

let wave1 = (kit.lfoBlocks[t] && kit.lfoBlocks[t][LFO_WAVE_SHAPE] !== undefined)
            ? kit.lfoBlocks[t][LFO_WAVE_SHAPE]
            : 0;
// clamp into [0 .. waveList1.length-1]
selWave1.value = String(Math.min(Math.max(0, wave1), waveList1.length - 1));

selWave1.onchange = function () {
  kit.lfoBlocks[t][LFO_WAVE_SHAPE] = parseInt(this.value, 10);
  updatePanelHeaderColors?.();
  updateKitTrackRow(t);
};
td.appendChild(selWave1);
tr.appendChild(td);

// Wave2 cell
td = document.createElement("td");
td.setAttribute("data-block", "trackOverview");
td.setAttribute("data-param-index", "7");
const selWave2 = document.createElement("select");

const fullWaveList2 = ["╲╱", "|╱|╱", "|_|‾‾|", "|/‾", "|◜", "%¿", "‾╲_", "‾(_", "∿️", "‾|__", "╲╱‾"];
const waveList2 = fullWaveList2.slice(0, window.MD_LFO_WAVE_COUNT);

waveList2.forEach((label, i) => {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = label;
  selWave2.appendChild(opt);
});

let wave2 = (kit.lfoBlocks[t] && kit.lfoBlocks[t][3] !== undefined)
            ? kit.lfoBlocks[t][3]
            : 0;
selWave2.value = String(Math.min(Math.max(0, wave2), waveList2.length - 1));

selWave2.onchange = function () {
  kit.lfoBlocks[t][3] = parseInt(this.value, 10);
  updatePanelHeaderColors?.();
  updateKitTrackRow(t);
};
td.appendChild(selWave2);
tr.appendChild(td);

  td = document.createElement("td");
  td.setAttribute("data-block", "trackOverview");
  td.setAttribute("data-param-index", "8");
  const selMode = document.createElement("select");
  ["FREE", "TRIG", "HOLD"].forEach((md, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = md;
    selMode.appendChild(opt);
  });
  let modeVal = (kit.lfoBlocks[t] && kit.lfoBlocks[t][4] !== undefined)
                ? kit.lfoBlocks[t][4]
                : 0;
  selMode.value = String(Math.max(0, Math.min(2, modeVal)));
  selMode.onchange = function () {
    kit.lfoBlocks[t][4] = parseInt(this.value, 10);
    updatePanelHeaderColors?.();
    updateKitTrackRow(t);
  };
  td.appendChild(selMode);
  tr.appendChild(td);

  return tr;
}

function updateKitTrackRow(t) {
  const tbody = document.querySelector("#trackOverviewUI table tbody");
  if (!tbody) return;
  const oldRow = tbody.querySelector(`tr[data-track-index="${t}"]`);
  const newRow = renderKitTrackRow(t);
  if (oldRow) {
    tbody.replaceChild(newRow, oldRow);
  }
}

function addMuteTrigOptions(sel) {
  const offOption = document.createElement("option");
  offOption.value = "128";
  offOption.textContent = "--";
  sel.appendChild(offOption);
  for (let i = 0; i < 16; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i + 1);
    sel.appendChild(opt);
  }
}

window.buildTrackOverviewUI = () => {
  const container = document.getElementById("trackOverviewUI");
  if (!container) return;
  container.innerHTML = "";
  const table = document.createElement("table");
  table.className = "track-overview-table";

  const headers = [
    "Track", "Machine", "Tonal", "Level", "MutePos",
    "TrigPos", "LFO Dest", "LFO Param", "SHP1", "SHP2", "Mode"
  ];

  const thead = document.createElement("thead");
  const thr = document.createElement("tr");
  headers.forEach((h, colIndex) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.userSelect = "none";
    th.classList.add("shiftHover");

    if (colIndex === 0) {
      th.onclick = ev => {
        ev.stopPropagation();
        const isShift = ev.shiftKey;
        const tbody = document.querySelector("#trackOverviewUI table tbody");
        // hide during update to batch layout
        tbody.parentElement.style.visibility = "hidden";
    
        // apply change + row updates
        for (let t = 0; t < 16; t++) {
          isShift
            ? window.randomizeTracksBlock(t)
            : window.resetTracksBlock(t);
          updateKitTrackRow(t);
        }
    
        // rebuild all three grids in one go
        buildKnobGrid(
          "machineParamsUI",
          kit.machineParams,
          ["Param1","Param2","Param3","Param4","Param5","Param6","Param7","Param8"],
          true
        );
        buildKnobGrid(
          "trackFxUI",
          kit.trackFx,
          ["AMdep","AMfrq","EQfrq","EQgain","FltBase","FltWidth","FltQ","SRR"],
          true
        );
        buildKnobGrid(
          "routingUI",
          kit.routing,
          ["Dist","Vol","Pan","DelSnd","RevSnd","LFOspd","LFOdep","LFOmix"],
          true
        );
    
        updatePanelHeaderColors?.();
        // restore visibility
        tbody.parentElement.style.visibility = "";
      };
    } else {
      th.onclick = ev => {
        ev.stopPropagation();
        const isShift = ev.shiftKey;
        for (let t = 0; t < 16; t++) {
          switch (colIndex) {
            case 1:
              if (!isShift) {
                kit.machineAssignments[t] = 0;
                kit.machineTonalFlags[t] = 0;
              } else {
                const pool = window.getValidMachinePool?.() || [];
                if (pool.length) {
                  let newID = pool[Math.floor(Math.random() * pool.length)];
                  const machineName = window.getMachineName?.(newID) || "";
                  if (machineName.toLowerCase().includes("unused")) newID = 0;
                  kit.machineAssignments[t] = newID;
                  kit.machineTonalFlags[t] = (window.MACHINES_THAT_SUPPORT_TONAL?.has(newID) && Math.random() < 0.5) ? 1 : 0;
                } else {
                  kit.machineAssignments[t] = 0;
                  kit.machineTonalFlags[t] = 0;
                }
              }
              break;
            case 2:
              kit.machineTonalFlags[t] = isShift ? (Math.random() < 0.5 ? 1 : 0) : 0;
              if (!window.MACHINES_THAT_SUPPORT_TONAL?.has(kit.machineAssignments[t])) {
                kit.machineTonalFlags[t] = 0;
              }
              break;
            case 3:
              kit.trackLevels[t] = isShift ? Math.floor(Math.random() * 128) : 100;
              window.sendKitCC?.(t + 1, "level", null, kit.trackLevels[t]);
              break;
            case 4:
              kit.muteTrigRelations[t][0] = isShift ? window.randomInt(16) : 128;
              break;
            case 5:
              kit.muteTrigRelations[t][1] = isShift ? window.randomInt(16) : 128;
              break;
            case 6:
              kit.lfoBlocks[t][LFO_TRACK] = isShift ? window.randomInt(16) : t;
              break;
            case 7:
              kit.lfoBlocks[t][LFO_PARAM] = isShift ? window.randomInt(24) : 0;
              break;
            case 8: {
              const waveMax1 = window.mdOSVersion === "1.63" ? 5 : 10;
              kit.lfoBlocks[t][LFO_WAVE_SHAPE] = isShift ? window.randomInt(waveMax1 + 1) : 0;
              break;
            }
            case 9: {
              const waveMax2 = window.mdOSVersion === "1.63" ? 5 : 10;
              kit.lfoBlocks[t][3] = isShift ? window.randomInt(waveMax2 + 1) : 0;
              break;
            }
            case 10:
              kit.lfoBlocks[t][4] = isShift ? window.randomInt(3) : 0;
              break;
          }
          updateKitTrackRow(t);
        }
      
        // ── Replace 16× updateKnobRow calls with a single rebuild: ──
        buildKnobGrid("machineParamsUI", kit.machineParams,
                      ["Param1","Param2","Param3","Param4","Param5","Param6","Param7","Param8"], true);
        buildKnobGrid("trackFxUI",       kit.trackFx,
                      ["AMdep","AMfrq","EQfrq","EQgain","FltBase","FltWidth","FltQ","SRR"], true);
        buildKnobGrid("routingUI",       kit.routing,
                      ["Dist","Vol","Pan","DelSnd","RevSnd","LFOspd","LFOdep","LFOmix"], true);
      
        updatePanelHeaderColors?.();
      };
    }
    thr.appendChild(th);
  });
  thead.appendChild(thr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let t = 0; t < 16; t++) {
    tbody.appendChild(renderKitTrackRow(t));
  }
  table.appendChild(tbody);
  container.appendChild(table);
  applyShiftHighlight();
  updatePanelHeaderColors?.();
};

window.onClickKitTrack = t => {
  window.selectedKitTrackIndex = t;
  window.activePanel = "kit";
  highlightKitTrack(t);
};

window.highlightKitTrack = trackIndex => {
  document.querySelectorAll(".kit-track-row").forEach(r => r.classList.remove("selected"));
  document.querySelectorAll(`.kit-track-row[data-track-index="${trackIndex}"]`)
          .forEach(r => r.classList.add("selected"));
};

window.randomizeOneBlockTrack = (t, category) => {
  for (let p = 0; p < 8; p++) {
    if (category === "machineParams") kit.machineParams[t][p] = partialRandom(kit.machineParams[t][p]);
    else if (category === "trackFx") kit.trackFx[t][p] = partialRandom(kit.trackFx[t][p]);
    else if (category === "routing") kit.routing[t][p] = partialRandom(kit.routing[t][p]);
  }
};

window.buildMasterFxUI = () => {
  const tbl = document.getElementById("masterFxTable");
  if (!tbl) return;
  if (!kit.masterFx) {
    kit.masterFx = new Array(32).fill(0);
  }
  tbl.innerHTML = "";
  const masterFxNames = [
    "DVOL","PRED","DEC","DAMP","HP","LP","GATE","LEV",
    "TIME","MOD","MFRQ","FB","FILTF","FILTW","MONO","LEV",
    "LF","LG","HF","HG","PF","PG","PQ","GAIN",
    "ATCK","REL","TRHD","RTIO","KNEE","HP","OUTG","MIX"
  ];
  const rowMap = [1, 0, 2, 3];
  const rowTitles = ["Rhythm Echo", "Gate Box", "EQ", "Dynamix"];
  const blockSize = 8;
  
  rowMap.forEach((actualBlock, uiRow) => {
    const headerRow = document.createElement("tr");
    const headerTh = document.createElement("th");
    headerTh.colSpan = blockSize;
    headerTh.style.textAlign = "center";
    headerTh.textContent = rowTitles[uiRow];
    headerTh.style.userSelect = "none";
    headerTh.classList.add("shiftHover");
    headerTh.style.cursor = "pointer";
    headerTh.onclick = e => {
      const blockIndex = rowMap[uiRow];
      e.shiftKey ? window.randomizeMasterFxBlock(blockIndex)
                 : window.resetMasterFxBlock(blockIndex);
      buildMasterFxUI();
    };
    headerRow.appendChild(headerTh);
    tbl.appendChild(headerRow);
    
    const paramTr = document.createElement("tr");
    for (let c = 0; c < blockSize; c++) {
      const paramIdx = actualBlock * blockSize + c;
      const td = document.createElement("td");
      td.classList.add("mfx-cell");

      // Slider
      const knob = document.createElement("input");
      knob.type = "range";
      knob.min = "0";
      knob.max = "127";
      knob.value = kit.masterFx[paramIdx];
      knob.classList.add("mfx-slider");

      // Prevent the table from hijacking your drag
      knob.addEventListener("mousedown", e => e.stopPropagation());

      // Live value label (fixed width via CSS to avoid layout jitter)
      const valSpan = document.createElement("span");
      valSpan.classList.add("mfx-value");
      valSpan.textContent = knob.value;

      // Smooth, in-place update — no re-render
      knob.addEventListener("input", () => {
        const v = parseInt(knob.value, 10);
        kit.masterFx[paramIdx] = v;
        valSpan.textContent = String(v);
        window.sendParamChange?.("masterFx", 0, paramIdx, v);
        updatePanelHeaderColors?.();
      });

      // Control row (slider + value)
      const controlRow = document.createElement("div");
      controlRow.className = "mfx-control-row";
      controlRow.appendChild(knob);
      controlRow.appendChild(valSpan);

      // Parameter label
      const desc = document.createElement("div");
      desc.className = "mfx-label";
      const label = masterFxNames[paramIdx] || ("MFX" + paramIdx);
      desc.textContent = label;
      desc.title = label;

      // Assemble
      td.appendChild(controlRow);
      td.appendChild(desc);
      paramTr.appendChild(td);
    }
    tbl.appendChild(paramTr);
  });
}

window.buildKnobGrid = (containerId, arr, colLabels, shiftEnabled = false) => {
  const cont = document.getElementById(containerId);
  if (!cont) return;
  cont.innerHTML = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const thr = document.createElement("tr");
  const th = document.createElement("th");
  th.textContent = "Track";
  th.classList.add("shiftHover");
  th.style.userSelect = "none";

  let category;
  if (containerId === "machineParamsUI") category = "machineParams";
  else if (containerId === "trackFxUI") category = "trackFx";
  else if (containerId === "routingUI") category = "routing";
  else if (containerId === "tracksUI") category = "track";

  th.onclick = ev => {
    ev.stopPropagation();
    const isShift = ev.shiftKey;

    for (let t = 0; t < 16; t++) {
      if (isShift) {
        // randomize this entire column for each track
        category === "track"
          ? window.randomizeTracksBlock(t)
          : window.randomizeOneBlockTrack(t, category);
      } else {
        // same reset‑to‑defaults you already have:
        if (category === "machineParams") {
          kit.machineParams[t] = [64, 64, 0, 0, 0, 0, 0, 0];
        } else if (category === "trackFx") {
          kit.trackFx[t] = [0, 64, 64, 64, 0, 127, 0, 0];
        } else if (category === "routing") {
          kit.routing[t] = [0, 127, 64, 0, 0, 64, 0, 0];
        } else if (category === "track") {
          window.resetTracksBlock(t);
        }
      }

      // **only update this one grid** row-by-row
      updateKnobRow(t, containerId, arr, colLabels, category);
    }

    // finally, refresh any header coloring
    updatePanelHeaderColors?.();
  };
  thr.appendChild(th);

  colLabels.forEach(label => {
    const cth = document.createElement("th");
    cth.textContent = label;
    cth.classList.add("shiftHover");
    cth.style.userSelect = "none";
  
    cth.onclick = ev => {
      ev.stopPropagation();
      const colIndex = colLabels.indexOf(label);
      const table = document.querySelector(`#${containerId} table`);
      const tbody = table.tBodies[0];
      const rows = tbody.rows;
  
      // batch updates
      for (let t = 0; t < rows.length; t++) {
        if (ev.shiftKey) {
          window.randomizeOneKitParam(t, category, colIndex);
        } else {
          resetOneKitParam(t, category, colIndex);
        }
  
        // direct cell access: cell[0] is track number, so +1
        const cell = rows[t].cells[colIndex + 1];
        const knob = cell.querySelector("input[type='range']");
        const valSpan = cell.querySelector(".knob-value");
  
        const newVal = kit[category][t][colIndex];
        if (knob) knob.value = newVal;
        if (valSpan) valSpan.textContent = newVal;
      }
  
      updatePanelHeaderColors?.();
    };
  
    thr.appendChild(cth);
  });
  thead.appendChild(thr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let t = 0; t < 16; t++) {
    const tr = document.createElement("tr");
    tr.classList.add("kit-track-row");
    tr.dataset.trackIndex = String(t);
    const tdTrack = document.createElement("td");
    tdTrack.textContent = String(t + 1);
    tdTrack.classList.add("shiftHover");
    tdTrack.style.userSelect = "none";
      tdTrack.onclick = e => {
    e.stopPropagation();

    if (e.shiftKey) {
      window.randomizeOneBlockTrack(t, category);
      updateKnobRow(
        t,
        containerId,    
        arr,          
        colLabels,      
        category      
      );

      updatePanelHeaderColors?.();
    } else {
      onClickKitTrack(t);
    }
  };
    tr.appendChild(tdTrack);

 const machineID = kit.machineAssignments ? kit.machineAssignments[t] || 0 : 0;
  // determine how many machine-params knobs to show
  let paramCount = 8;
  if (
    category === "machineParams" &&
    window.MACHINE_PARAM_LABELS &&
    window.MACHINE_PARAM_LABELS[machineID]
  ) {
    // base count is up to 8 labels
    paramCount = Math.min(8, window.MACHINE_PARAM_LABELS[machineID].length);
  }

    for (let i = 0; i < colLabels.length; i++) {
      const td = document.createElement("td");
      td.setAttribute("data-block", category);
      td.setAttribute("data-param-index", String(i));

      if (category === "machineParams" && i >= paramCount) {
        const labelDiv = document.createElement("div");
        labelDiv.className = "param-label";
        labelDiv.innerHTML = "&nbsp;";

        const knob = document.createElement("input");
        knob.type = "range";
        knob.min = "0";
        knob.max = "127";
        knob.value = "64";
        knob.disabled = true;
        knob.classList.add("knob-range");
        knob.style.visibility = "hidden";

        const valSpan = document.createElement("span");
        valSpan.classList.add("knob-value");
        valSpan.style.visibility = "hidden";
        valSpan.textContent = "64";

        // Keep cell structure consistent with active params (label + control row)
        const controlRow = document.createElement("div");
        controlRow.className = "knob-control-row";
        controlRow.appendChild(knob);
        controlRow.appendChild(valSpan);

        td.appendChild(labelDiv);
        td.appendChild(controlRow);
        td.classList.add("empty-kit-panel");
        tr.appendChild(td);
        continue;
      }

      const knob = document.createElement("input");
      knob.type = "range";
      knob.min = "0";
      knob.max = "127";
      knob.value = arr[t][i];
      knob.classList.add("knob-range");

      const valSpan = document.createElement("span");
      valSpan.classList.add("knob-value");
      valSpan.textContent = String(arr[t][i]);

      const labelDiv = document.createElement("div");
      labelDiv.className = "param-label";

      if (category === "machineParams") {
        let labelText = "";

        // Prefer existing helper if available.
        try {
          if (typeof getParamLabels === "function") {
            const maybeNames = getParamLabels(machineID);
            if (Array.isArray(maybeNames)) labelText = (maybeNames[i] || "");
          }
        } catch (e) {
          // ignore
        }

        // Fallback: common global used elsewhere in the app.
        if (!labelText && window.MACHINE_PARAM_LABELS && window.MACHINE_PARAM_LABELS[machineID]) {
          labelText = window.MACHINE_PARAM_LABELS[machineID][i] || "";
        }

        // Fallback: per-param resolver (used by the LFO destination picker)
        if (!labelText && typeof window.getParamLabel === "function") {
          labelText = window.getParamLabel(machineID, i, "machineParams") || "";
        }

        // Final fallback: generic column label
        labelText = (labelText || "").trim() || colLabels[i] || `P${i + 1}`;
        labelDiv.textContent = labelText;
        labelDiv.title = labelText;
      } else if (category === "trackFx") {
        labelDiv.textContent = getSpecialTrackFxLabel(machineID, i) || "";
      } else if (category === "routing") {
        labelDiv.textContent = getSpecialRoutingLabel(machineID, i) || "";
      }

      // FX/Routing: rows are much denser when we can fully collapse empty labels.
      // We still want to show per-track overrides for some machines.
      if (!labelDiv.textContent) {
        if (category === "trackFx" || category === "routing") {
          labelDiv.textContent = "";
          labelDiv.classList.add("is-empty");
        } else {
          labelDiv.innerHTML = "&nbsp;";
        }
      }

      // For Synthesis: put slider + value on one line (CSS targets .knob-control-row)
      const controlRow = (category === "machineParams") ? document.createElement("div") : null;
      if (controlRow) {
        controlRow.className = "knob-control-row";
        controlRow.appendChild(knob);
        controlRow.appendChild(valSpan);
      }

      knob.addEventListener("input", () => {
        const val = parseInt(knob.value, 10);
        arr[t][i] = val;
        valSpan.textContent = String(val);
        window.sendKitCC(t + 1, category, i, val);
        updatePanelHeaderColors?.();
        if (shiftEnabled && window.shiftKeyIsDown) {
          for (let otherT = 0; otherT < 16; otherT++) {
            if (category === "machineParams") {
              const otherM = kit.machineAssignments ? kit.machineAssignments[otherT] || 0 : 0;
              const otherLabels = window.MACHINE_PARAM_LABELS && window.MACHINE_PARAM_LABELS[otherM] || [];
              if (i >= Math.min(8, otherLabels.length)) continue;
            }
            arr[otherT][i] = val;
            const rowEls = tbody.querySelectorAll("tr");
            if (rowEls[otherT]) {
              const cell = rowEls[otherT].querySelectorAll("td")[i + 1];
              if (cell) {
                const theKnob = cell.querySelector("input.knob-range");
                const theValSpan = cell.querySelector(".knob-value");
                if (theKnob) theKnob.value = String(val);
                if (theValSpan) theValSpan.textContent = String(val);
              }
            }
          }
        }
      });
      td.appendChild(labelDiv);
      if (category === "machineParams" && controlRow) {
        td.appendChild(controlRow);
      } else {
        td.appendChild(knob);
        td.appendChild(valSpan);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  cont.appendChild(table);
  applyShiftHighlight();
};


function resetOneKitParam(trackIndex, category, paramIndex) {
  if (category === "machineParams") {
    kit.machineParams[trackIndex][paramIndex] = 64;
  } else if (category === "trackFx") {
    const defaults = [0, 64, 64, 64, 0, 127, 0, 0];
    kit.trackFx[trackIndex][paramIndex] = defaults[paramIndex];
  } else if (category === "routing") {
    const defaults = [0, 127, 64, 0, 0, 64, 0, 0];
    kit.routing[trackIndex][paramIndex] = defaults[paramIndex];
  }
}

function requestKitDump(indexOrOpts) {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!window.isBulkInProgress && !confirm("Overwrite Kit data?")) {
    return;
  }
  
  let useRange = false;
  let explicitIndex = null;
  if (typeof indexOrOpts === "number") {
    explicitIndex = indexOrOpts;
  } else if (typeof indexOrOpts === "object" && indexOrOpts.useRange) {
    useRange = true;
  }

  if (useRange) {
    const kitSliderVals = document.getElementById("slider-kits").noUiSlider.get();
    let start = parseInt(kitSliderVals[0], 10) || 1;
    let end   = parseInt(kitSliderVals[1], 10) || 1;
    if (start > end) [start, end] = [end, start];
    start = Math.max(1, Math.min(64, start));
    end   = Math.max(1, Math.min(64, end));
    for (let kNum = start; kNum <= end; kNum++) {
      const kitIndex = kNum - 1;
      const syx = [...MD_SYSEX_HEADER, MD_KIT_REQUEST_ID, (kitIndex & 0x3F), 0xF7];
      window.selectedMidiOut.send(syx);
    }
    return;
  }

  let index;
  if (explicitIndex !== null) {
    index = Math.max(0, Math.min(63, explicitIndex));
  } else {
    const kitSliderVals = document.getElementById("slider-kits").noUiSlider.get();
    let leftValue = parseInt(kitSliderVals[0], 10) || 1;
    leftValue = Math.max(1, Math.min(64, leftValue));
    index = leftValue - 1;
  }

  const syx = [...MD_SYSEX_HEADER, MD_KIT_REQUEST_ID, (index & 0x3F), 0xF7];
  // Mark as a single kit request so mddt-midi.js stores the received dump into kitLibrary.
  window.requestingKits = true;
  window.selectedMidiOut.send(syx);
}

function logKitState() {
  for (let i = 0; i < 16; i++) {
    const mID = kit.machineAssignments[i];
    const mName = window.getMachineName ? window.getMachineName(mID) : "Unknown";
  }
}

function saveCurrentKitToMD(indexOrOpts) {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  if (!confirm("WARNING: This will overwrite Machinedrum kit data. Continue?")) {
    return;
  }
  
  let useRange = false;
  let explicitIndex = null;
  if (typeof indexOrOpts === "number") {
    explicitIndex = indexOrOpts;
  } else if (typeof indexOrOpts === "object" && indexOrOpts.useRange) {
    useRange = true;
  }

  if (useRange) {
    const [startStr, endStr] = document.getElementById("slider-kits").noUiSlider.get();
    let start = parseInt(startStr, 10) || 1;
    let end   = parseInt(endStr,   10) || 1;
    if (start > end) [start, end] = [end, start];
    start = Math.max(1, Math.min(64, start));
    end   = Math.max(1, Math.min(64, end));
    for (let kNum = start; kNum <= end; kNum++) {
      kit.sysexPosition = (kNum - 1);
      const kitDump = createKitDump(kit);
      window.selectedMidiOut.send(kitDump);
      const loadMsg = new Uint8Array([0xF0,0x00,0x20,0x3C,0x02,0x00,0x58,(kNum-1),0xF7]);
      window.selectedMidiOut.send(loadMsg);
    }
    return;
  }

  let kNum;
  if (explicitIndex !== null) {
    kNum = explicitIndex + 1;
  } else {
    const [startVal] = document.getElementById("slider-kits").noUiSlider.get();
    kNum = parseInt(startVal, 10) || 1;
  }
  kNum = Math.max(1, Math.min(64, kNum));

  kit.sysexPosition = kNum - 1;
  const kitDump = createKitDump(kit);
  window.selectedMidiOut.send(kitDump);
  const loadMsg = new Uint8Array([0xF0,0x00,0x20,0x3C,0x02,0x00,0x58,(kNum-1),0xF7]);
  window.selectedMidiOut.send(loadMsg);
}

window.loadKitToMD = () => {
  if (!window.selectedMidiOut) {
    alert("No MIDI Out selected!");
    return;
  }
  let kitNum = parseInt(document.getElementById("kitReqNumber").value, 10) || 0;
  const msg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00,0x58, (kitNum & 0x3F), 0xF7]);
  window.selectedMidiOut.send(msg);
};

window.getKitTrackData = t => {
  if (!kit) return null;
  return {
    machineAssignment: kit.machineAssignments[t],
    machineTonalFlag:  kit.machineTonalFlags[t],
    machineParams:     kit.machineParams[t].slice(),
    trackFx:           kit.trackFx[t].slice(),
    routing:           kit.routing[t].slice(),
    trackLevel:        kit.trackLevels[t],
    lfoBlock:          kit.lfoBlocks[t].slice(),
    muteTrig:          kit.muteTrigRelations[t].slice()
  };
};

window.applyKitTrackData = (t, trackData) => {
  if (!kit || !trackData) return;
  kit.machineAssignments[t] = trackData.machineAssignment;
  kit.machineTonalFlags[t]  = trackData.machineTonalFlag;
  kit.machineParams[t]      = trackData.machineParams.slice();
  kit.trackFx[t]            = trackData.trackFx.slice();
  kit.routing[t]            = trackData.routing.slice();
  kit.trackLevels[t]        = trackData.trackLevel;
  kit.lfoBlocks[t]          = trackData.lfoBlock.slice();
  kit.muteTrigRelations[t]  = trackData.muteTrig.slice();
  window.initUI?.();
  updatePanelHeaderColors?.();
};

window.clearKitTrack = t => {
  kit.machineAssignments[t] = 0;
  kit.machineTonalFlags[t] = 0;
  kit.machineParams[t] = new Array(8).fill(64);
  kit.trackFx[t] = new Array(8).fill(0);
  kit.routing[t] = new Array(8).fill(0);
  kit.trackLevels[t] = 100;
  kit.lfoBlocks[t] = (kit.lfoBlocks[t].length === 36)
                      ? new Array(36).fill(0)
                      : new Array(8).fill(0);
  kit.muteTrigRelations[t] = [128, 128];
  window.initUI?.();
  updatePanelHeaderColors?.();
};

function swapKitTrackData(a, b) {
  [
    "machineAssignments",
    "machineTonalFlags",
    "machineParams",
    "trackFx",
    "routing",
    "trackLevels",
    "lfoBlocks",
    "muteTrigRelations"
  ].forEach(key => {
    let temp = kit[key][a];
    kit[key][a] = kit[key][b];
    kit[key][b] = temp;
  });
  window.initUI?.();
}

// -------------------------------------------------
// Kit editor tabs ↔ Shift-highlighter integration
// -------------------------------------------------
// The kit editor UI can be split across tabs (Overview/Synthesis/Effects/Routing).
// The Shift-highlighter should always be visible on the currently-open tab,
// and (when navigating across blocks) the UI should follow the highlight.
function getActiveKitTabId() {
  // Prefer state from ui-shell.js, but fall back to DOM inspection.
  if (typeof window.activeKitTab === "string" && window.activeKitTab) return window.activeKitTab;
  const btn = document.querySelector('.panel[data-panel-id="kit"] [data-kit-tabs] .kit-tab.is-active');
  return btn?.dataset?.kitTab || "overview";
}

function kitTabToShiftBlock(tabId) {
  switch (tabId) {
    case "overview":  return "trackOverview";
    case "synthesis": return "machineParams";
    case "effects":   return "trackFx";
    case "routing":   return "routing";
    default:           return null; // e.g. masterfx
  }
}

function shiftBlockToKitTab(block) {
  switch (block) {
    case "trackOverview": return "overview";
    case "machineParams": return "synthesis";
    case "trackFx":       return "effects";
    case "routing":       return "routing";
    default:               return null;
  }
}

function shiftBlockSize(block) {
  switch (block) {
    case "trackOverview": return 9;
    case "machineParams":
    case "trackFx":
    case "routing":
      return 8;
    default:
      return 0;
  }
}

function clampShiftIndex(block, idx) {
  const size = shiftBlockSize(block);
  if (!size) return 0;
  let i = Number.isFinite(idx) ? idx : 0;
  if (i < 0) i = 0;
  if (i >= size) i = size - 1;
  return i;
}

function syncShiftBlockToVisibleKitTab(force = false) {
  const activeTab = getActiveKitTabId();
  const desiredBlock = kitTabToShiftBlock(activeTab);
  if (!desiredBlock) return; // No shift-highlighter mapping for this tab.

  const prevBlock = window.shiftParamBlock;
  if (force || prevBlock !== desiredBlock) {
    window.shiftParamBlock = desiredBlock;
    // When switching blocks due to tab context, start at the first param.
    window.shiftParamIndex = (prevBlock !== desiredBlock) ? 0 : clampShiftIndex(desiredBlock, window.shiftParamIndex);
  } else {
    window.shiftParamIndex = clampShiftIndex(desiredBlock, window.shiftParamIndex);
  }
}

function ensureVisibleKitTabForShiftBlock(block) {
  const desiredTab = shiftBlockToKitTab(block);
  if (!desiredTab) return;

  const currentTab = getActiveKitTabId();

  // Don't auto-switch away from Master FX. Shift-highlighter is for track params.
  if (currentTab === "masterfx") return;
  if (currentTab === desiredTab) return;

  try {
    if (window.MDDTShell && typeof window.MDDTShell.setKitTab === "function") {
      window.MDDTShell.setKitTab(desiredTab);
      return;
    }
  } catch (e) {
    // fall back below
  }

  // Fallback: simulate a tab click.
  const btn = document.querySelector(`.panel[data-panel-id="kit"] .kit-tab[data-kit-tab="${desiredTab}"]`);
  btn?.click?.();
}

window.addEventListener("keydown", function(e) {
  if (window.activePanel !== "kit") return;
  if (e.key === "Shift") {
    window.shiftKeyIsDown = true;
    // When Shift is first pressed, snap the highlighter to whatever Kit tab is visible.
    // This prevents the highlight from "staying" in a hidden tab.
    syncShiftBlockToVisibleKitTab(true);
  } else if (e.shiftKey) {
    // Shift is already held (it may have been pressed before the Kit panel/tab was focused).
    syncShiftBlockToVisibleKitTab(true);
  }
  applyShiftHighlight();
  if (window.activePanel !== "kit") return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") && e.key !== "Shift") return;

  const trackCount = 16;
  const t = window.selectedKitTrackIndex || 0;

  if (!e.shiftKey) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      window.selectedKitTrackIndex = (t + trackCount - 1) % trackCount;
      highlightKitTrack(window.selectedKitTrackIndex);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      window.selectedKitTrackIndex = (t + 1) % trackCount;
      highlightKitTrack(window.selectedKitTrackIndex);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      let currentID = kit.machineAssignments[t];
      let newID = getNextValidMachineID(currentID, +1);
      kit.machineAssignments[t] = newID;
      updateKitTrackRow(t);
      updateKnobRow(t, "machineParamsUI", kit.machineParams, ["Param1", "Param2", "Param3", "Param4", "Param5", "Param6", "Param7", "Param8"], "machineParams");
      updateKnobRow(t, "trackFxUI", kit.trackFx, ["AMdep", "AMfrq", "EQfrq", "EQgain", "FltBase", "FltWidth", "FltQ", "SRR"], "trackFx");
      updateKnobRow(t, "routingUI", kit.routing, ["Dist", "Vol", "Pan", "DelSnd", "RevSnd", "LFOspd", "LFOdep", "LFOmix"], "routing");
      updatePanelHeaderColors?.();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      let currentID = kit.machineAssignments[t];
      let newID = getNextValidMachineID(currentID, -1);
      kit.machineAssignments[t] = newID;
      updateKitTrackRow(t);
      updateKnobRow(t, "machineParamsUI", kit.machineParams, ["Param1", "Param2", "Param3", "Param4", "Param5", "Param6", "Param7", "Param8"], "machineParams");
      updateKnobRow(t, "trackFxUI", kit.trackFx, ["AMdep", "AMfrq", "EQfrq", "EQgain", "FltBase", "FltWidth", "FltQ", "SRR"], "trackFx");
      updateKnobRow(t, "routingUI", kit.routing, ["Dist", "Vol", "Pan", "DelSnd", "RevSnd", "LFOspd", "LFOdep", "LFOmix"], "routing");
      updatePanelHeaderColors?.();
    }
  } else {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveShiftHighlight(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveShiftHighlight(+1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      changeShiftHighlightedParam(+1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      changeShiftHighlightedParam(-1);
    }
  }
});

window.addEventListener("keyup", function(e) {
  if (e.key === "Shift") {
    window.shiftKeyIsDown = false;
    document.querySelectorAll(".shift-param-highlight").forEach(cell => {
      cell.classList.remove("shift-param-highlight");
    });
  }
});

function moveShiftHighlight(step) {
  let blockOrder = ["trackOverview", "machineParams", "trackFx", "routing"];
  let blockSizes = [9, 8, 8, 8];
  let blockIndex = blockOrder.indexOf(window.shiftParamBlock);
  if (blockIndex < 0) blockIndex = 0;
  let linearIndex = window.shiftParamIndex + blockSizes.slice(0, blockIndex).reduce((a,b)=>a+b,0);
  linearIndex += step;
  const totalParams = blockSizes.reduce((acc, val) => acc + val, 0);
  if (linearIndex < 0) linearIndex = totalParams - 1;
  if (linearIndex >= totalParams) linearIndex = 0;
  let tmp = linearIndex;
  let newBlockIndex = 0;
  for (let i = 0; i < blockSizes.length; i++) {
    if (tmp < blockSizes[i]) {
      newBlockIndex = i;
      break;
    } else {
      tmp -= blockSizes[i];
    }
  }
  window.shiftParamBlock = blockOrder[newBlockIndex];
  window.shiftParamIndex = tmp;
  applyShiftHighlight();
}

function changeShiftHighlightedParam(delta) {
  const t = window.selectedKitTrackIndex || 0;
  const block = window.shiftParamBlock;
  const i = window.shiftParamIndex || 0;

  if (block === "trackOverview") {
    switch (i) {
      case 0:
        kit.machineTonalFlags[t] = kit.machineTonalFlags[t] ? 0 : 1;
        break;
      case 1: {
        let oldVal = kit.trackLevels[t];
        kit.trackLevels[t] = Math.max(0, Math.min(127, oldVal + delta));
        break;
      }
      case 2: {
        const validVals = [128, ...Array.from({ length: 16 }, (_, idx) => idx)];
        let oldMute = kit.muteTrigRelations[t][0];
        let idxFound = validVals.indexOf(oldMute);
        if (idxFound < 0) idxFound = 0;
        idxFound = (idxFound + delta + validVals.length) % validVals.length;
        kit.muteTrigRelations[t][0] = validVals[idxFound];
        break;
      }
      case 3: {
        const validVals = [128, ...Array.from({ length: 16 }, (_, idx) => idx)];
        let oldTrig = kit.muteTrigRelations[t][1];
        let idxFound = validVals.indexOf(oldTrig);
        if (idxFound < 0) idxFound = 0;
        idxFound = (idxFound + delta + validVals.length) % validVals.length;
        kit.muteTrigRelations[t][1] = validVals[idxFound];
        break;
      }
      case 4: {
        let oldVal = kit.lfoBlocks[t][LFO_TRACK];
        let newVal = Math.max(0, Math.min(15, oldVal + delta));
        kit.lfoBlocks[t][LFO_TRACK] = newVal;
        break;
      }
      case 5: {
        let oldVal = kit.lfoBlocks[t][LFO_PARAM];
        let newVal = Math.max(0, Math.min(23, oldVal + delta));
        kit.lfoBlocks[t][LFO_PARAM] = newVal;
        break;
      }
      case 6: {
        let oldVal = kit.lfoBlocks[t][LFO_WAVE_SHAPE];
        let newVal = Math.max(0, Math.min(10, oldVal + delta));
        kit.lfoBlocks[t][LFO_WAVE_SHAPE] = newVal;
        break;
      }
      case 7: {
        let oldVal = kit.lfoBlocks[t][3];
        let newVal = Math.max(0, Math.min(10, oldVal + delta));
        kit.lfoBlocks[t][3] = newVal;
        break;
      }
      case 8: {
        let oldVal = kit.lfoBlocks[t][4];
        let newMode = oldVal + delta;
        if (newMode < 0) newMode = 2;
        if (newMode > 2) newMode = 0;
        kit.lfoBlocks[t][4] = newMode;
        break;
      }
    }
    updateKitTrackRow(t);
    applyShiftHighlight();
    window.updatePanelHeaderColors?.(); 
    return;
  }
  if (!kit[block] || !kit[block][t]) return;
  let val = kit[block][t][i];
  val = Math.max(0, Math.min(127, val + delta));
  kit[block][t][i] = val;
  window.sendKitCC(t + 1, block, i, val);

  const containerId = 
    block === "machineParams" ? "machineParamsUI" :
    block === "trackFx"       ? "trackFxUI"       :
                                "routingUI";

  const colLabels = 
    block === "machineParams"
      ? ["Param1", "Param2", "Param3", "Param4", "Param5", "Param6", "Param7", "Param8"]
    : block === "trackFx"
      ? ["AMdep", "AMfrq", "EQfrq", "EQgain", "FltBase", "FltWidth", "FltQ", "SRR"]
      : ["Dist", "Vol", "Pan", "DelSnd", "RevSnd", "LFOspd", "LFOdep", "LFOmix"];

  updateKnobRow(t, containerId, kit[block], colLabels, block);
  applyShiftHighlight();
  window.updatePanelHeaderColors?.();
}

function getNextValidMachineID(currentID, direction) {
  const validPool = window.getValidMachinePool?.();
  if (!validPool || !validPool.length) return 0;
  let idx = validPool.indexOf(currentID);
  if (idx < 0) {
    let closest = 0, minDist = 9999;
    for (let i = 0; i < validPool.length; i++) {
      let d = Math.abs(validPool[i] - currentID);
      if (d < minDist) { minDist = d; closest = i; }
    }
    idx = closest;
  }
  idx += direction;
  if (idx < 0) idx = validPool.length - 1;
  if (idx >= validPool.length) idx = 0;
  return validPool[idx];
}

function applyShiftHighlight() {
  if (!window.shiftKeyIsDown) return;
  document.querySelectorAll(".shift-param-highlight").forEach(cell => {
    cell.classList.remove("shift-param-highlight");
  });
  if (!window.shiftParamBlock) return;
  const trackIndex = window.selectedKitTrackIndex || 0;
  const block = window.shiftParamBlock;
  const paramIndex = clampShiftIndex(block, window.shiftParamIndex || 0);
  window.shiftParamIndex = paramIndex;

  // If the highlight moves into another block, keep the tab in sync so the user
  // always sees the highlighted parameter.
  ensureVisibleKitTabForShiftBlock(block);
  let tableId;
  if (block === "trackOverview") {
    tableId = "trackOverviewUI";
  } else if (block === "machineParams") {
    tableId = "machineParamsUI";
  } else if (block === "trackFx") {
    tableId = "trackFxUI";
  } else if (block === "routing") {
    tableId = "routingUI";
  } else {
    return;
  }
  const row = document.querySelector(`#${tableId} table tbody tr[data-track-index="${trackIndex}"]`);
  if (!row) return;
  const cell = row.querySelector(`td[data-block="${block}"][data-param-index="${paramIndex}"]`);
  if (cell) {
    cell.classList.add("shift-param-highlight");
    try {
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (e) {
      // ignore
    }
  }
}

// Called by ui-shell.js when the Kit tab changes.
// Ensures the Shift-highlighter immediately appears on the newly-visible tab.
window.onKitTabChanged = function(tabId) {
  try {
    if (!window.shiftKeyIsDown) return;
    if (window.activePanel !== "kit") return;

    const desiredBlock = kitTabToShiftBlock(tabId);
    if (!desiredBlock) {
      // e.g. Master FX tab - clear any lingering highlight.
      document.querySelectorAll(".shift-param-highlight").forEach(cell => {
        cell.classList.remove("shift-param-highlight");
      });
      return;
    }

    if (window.shiftParamBlock !== desiredBlock) {
      window.shiftParamBlock = desiredBlock;
      window.shiftParamIndex = 0;
    } else {
      window.shiftParamIndex = clampShiftIndex(desiredBlock, window.shiftParamIndex || 0);
    }

    applyShiftHighlight();
  } catch (e) {
    // do not throw in global hook
  }
};

window.buildKitNameUI = function () {
  const el = document.getElementById("kitNameInput");
  if (!el) return;
  if (!window.kit || !window.kit.kitName) {
    window.kit = window.kit || {};
    window.kit.kitName = "DEFAULT".split("");
  }
  el.value = window.kit.kitName.join("").substr(0, 10);
  el.oninput = function () {
    this.value = this.value.toUpperCase().substr(0, 10);
    window.kit.kitName = el.value.substr(0, 10).split("");
    updatePanelHeaderColors?.();
  };
  const kitNumDisplay = document.getElementById("kitNumberDisplay");
  if (kitNumDisplay) {
    kitNumDisplay.textContent = (window.selectedKitSlotIndex + 1);
  }
};

function renderKnobRow(t, arr, colLabels, category) {
  const tr = document.createElement("tr");
  tr.classList.add("kit-track-row");
  if (t === (window.selectedKitTrackIndex || 0)) {
    tr.classList.add("selected");
  }
  tr.dataset.trackIndex = String(t);

  const tdTrack = document.createElement("td");
  tdTrack.textContent = String(t + 1);
  tdTrack.classList.add("shiftHover");
  tdTrack.style.userSelect = "none";
  tdTrack.onclick = e => {
    e.stopPropagation();
    onClickKitTrack(t);
  };
  tr.appendChild(tdTrack);

  const machineID = kit.machineAssignments ? kit.machineAssignments[t] || 0 : 0;
  for (let i = 0; i < colLabels.length; i++) {
    const td = document.createElement("td");
    td.setAttribute("data-block", category);
    td.setAttribute("data-param-index", String(i));

    if (category === "machineParams" && window.MACHINE_PARAM_LABELS &&
        i >= Math.min(8, (window.MACHINE_PARAM_LABELS[machineID] || []).length)) {
      const labelDiv = document.createElement("div");
      labelDiv.className = "param-label";
      labelDiv.innerHTML = "&nbsp;";
      const knob = document.createElement("input");
      knob.type = "range";
      knob.min = "0";
      knob.max = "127";
      knob.value = "64";
      knob.disabled = true;
      knob.style.visibility = "hidden";
      const valSpan = document.createElement("span");
      valSpan.classList.add("knob-value");
      valSpan.style.visibility = "hidden";
      valSpan.textContent = "64";
      td.appendChild(labelDiv);
      td.appendChild(knob);
      td.appendChild(valSpan);
      td.classList.add("empty-kit-panel");
      tr.appendChild(td);
      continue;
    }

    const knob = document.createElement("input");
    knob.type = "range";
    knob.min = "0";
    knob.max = "127";
    knob.value = arr[t][i];
    knob.classList.add("knob-range");

    const valSpan = document.createElement("span");
    valSpan.classList.add("knob-value");
    valSpan.textContent = String(arr[t][i]);

    const labelDiv = document.createElement("div");
    labelDiv.className = "param-label";
    if (category === "machineParams") {
      const maybeNames = getParamLabels(machineID);
      labelDiv.textContent = maybeNames?.[i] || "";
    } else if (category === "trackFx") {
      labelDiv.textContent = getSpecialTrackFxLabel(machineID, i) || "";
    } else if (category === "routing") {
      labelDiv.textContent = getSpecialRoutingLabel(machineID, i) || "";
    }
    if (!labelDiv.textContent) {
      if (category === "trackFx" || category === "routing") {
        labelDiv.textContent = "";
        labelDiv.classList.add("is-empty");
      } else {
        labelDiv.innerHTML = "&nbsp;";
      }
    }

    knob.addEventListener("input", () => {
      const val = parseInt(knob.value, 10);
      arr[t][i] = val;
      valSpan.textContent = String(val);
      window.sendKitCC(t + 1, category, i, val);
      updatePanelHeaderColors?.();
    });
    knob.addEventListener("mousedown", e => {
      e.stopPropagation();
    });

    td.appendChild(labelDiv);
    td.appendChild(knob);
    td.appendChild(valSpan);
    tr.appendChild(td);
  }
  return tr;
}

function updateKnobRow(t, containerId, arr, colLabels, category) {
  buildKnobGrid(containerId, arr, colLabels, /* shiftEnabled= */ true);
}
function testTrigEncoding() {
  window.kit = window.kit || {};
  window.kit.muteTrigRelations = Array.from({ length: 16 }, () => [128, 128]);

  const trigRaw = new Uint8Array(32);
  
  for (let t = 0; t < 16; t++) {
    const internalTrig = window.kit.muteTrigRelations[t][1];
    let tv = (internalTrig === 128) ? 255 : internalTrig;
    if (tv < 0) {
      tv = 0;
    } else if (tv > 16) {
      tv = 16;
    }
    trigRaw[t] = tv;

    const internalMute = window.kit.muteTrigRelations[t][0];
    let mv = (internalMute === 128) ? 255 : internalMute;
    if (mv < 0) {
      mv = 0;
    } else if (mv > 16) {
      mv = 16;
    }
    trigRaw[16 + t] = mv;
  }

  const packedTrig = encode7Bit(Array.from(trigRaw));
  const decoded = window.decode7BitDynamic(packedTrig, 0, 32).result;
}

window.testTrigEncoding = testTrigEncoding;


window.kitClipboard = null;  
window.kitUndo      = null;  

function refreshTrackRow(trackIndex) {
  updateKitTrackRow(trackIndex);
}

(function(){
  const origSwap = window.swapKitTrackData;
  window.swapKitTrackData = function(a, b) {
    window.kitUndo = { type: "move", from: a, to: b };
    origSwap(a, b);
    refreshTrackRow(a);
    refreshTrackRow(b);
  };
})();

document.addEventListener("keydown", function(e) {
  if (window.activePanel !== "kit") return;
  if (!e.metaKey) return;
  const t = window.selectedKitTrackIndex;
  if (typeof t !== "number") return;

  switch (e.code) {
    case "KeyC":  
      e.preventDefault();
      window.kitClipboard = window.getKitTrackData(t);
      break;

    case "KeyX":  
      e.preventDefault();
      const beforeCut = window.getKitTrackData(t);
      window.kitClipboard = beforeCut;
      window.kitUndo = { type: "cut", track: t, data: beforeCut };
      window.clearKitTrack(t);
      refreshTrackRow(t);
      updatePanelHeaderColors?.();
      break;

    case "KeyV":  
      e.preventDefault();
      if (!window.kitClipboard) return;
      const beforePaste = window.getKitTrackData(t);
      window.kitUndo = { type: "paste", track: t, data: beforePaste };
      window.applyKitTrackData(t, window.kitClipboard);
      refreshTrackRow(t);
      updatePanelHeaderColors?.();
      break;

    case "KeyZ":  
      e.preventDefault();
      const act = window.kitUndo;
      if (!act) return;

      if (act.type === "cut" || act.type === "paste") {
        window.applyKitTrackData(act.track, act.data);
        refreshTrackRow(act.track);
        updatePanelHeaderColors?.();

      } else if (act.type === "move") {
        swapKitTrackData(act.to, act.from);
        updatePanelHeaderColors?.();

      }
      window.kitUndo = null;
      break;
  }
});