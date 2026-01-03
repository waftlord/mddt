// state.js

(function () {
  // ------------------------------------------------------------
  // Safe localStorage wrappers
  // ------------------------------------------------------------
  // Some environments (Safari private mode, strict privacy settings,
  // embedded WebViews) can throw on localStorage get/set and crash
  // the whole app. These wrappers keep the UI functional by falling
  // back to an in-memory Map.

  (function initSafeStorage(){
    // Avoid clobbering if another bundle already provided it.
    if (window.safeStorageGet && window.safeStorageSet && window.safeStorageRemove) return;

    const mem = new Map();
    let _lsOk = null;

    function storageAvailable(){
      if (_lsOk !== null) return _lsOk;
      try {
        // Some browsers throw even on accessing localStorage.
        const ls = window.localStorage;
        const k = "__mddt_ls_test__";
        ls.setItem(k, "1");
        ls.removeItem(k);
        _lsOk = true;
      } catch (_) {
        _lsOk = false;
      }
      return _lsOk;
    }

    window.safeStorageGet = function(key){
      try {
        if (storageAvailable()) return window.localStorage.getItem(String(key));
      } catch (_) {}
      return mem.has(String(key)) ? mem.get(String(key)) : null;
    };

    window.safeStorageSet = function(key, value){
      const k = String(key);
      const v = (value == null) ? "" : String(value);
      try {
        if (storageAvailable()) {
          window.localStorage.setItem(k, v);
          return true;
        }
      } catch (_) {}
      mem.set(k, v);
      return false;
    };

    window.safeStorageRemove = function(key){
      const k = String(key);
      try {
        if (storageAvailable()) {
          window.localStorage.removeItem(k);
          return true;
        }
      } catch (_) {}
      mem.delete(k);
      return false;
    };

    window.safeStorageKeys = function(){
      try {
        if (storageAvailable()) return Object.keys(window.localStorage);
      } catch (_) {}
      return Array.from(mem.keys());
    };

    window.safeStorageClear = function(){
      try {
        if (storageAvailable()) {
          window.localStorage.clear();
          return true;
        }
      } catch (_) {}
      mem.clear();
      return false;
    };
  })();

  window.cloneData = obj => JSON.parse(JSON.stringify(obj));

  const DEFAULT_MASTER_FX = [
    0, 0, 64, 0, 0, 127, 0, 64,
    64, 0, 0, 32, 0, 127, 0, 64,
    64, 64, 64, 64, 64, 64, 64, 127,
    0, 0, 127, 127, 127, 127, 0, 0
  ];
  

  window.mdOSVersion = "X";

  function initKit() {
    const kit = {
      sysexVersion: 64,
      sysexRevision: 1,
      sysexPosition: 0,
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
    };
    for (let t = 0; t < 16; t++) {
      kit.lfoBlocks[t][0] = t;
    }
    return kit;
  }

  function initPattern() {
    const numTracks = 16,
      numBytes = 8;
    return {
      patternNumber: 0,
      extendedFlag: false,
      length: 16,
      tempoMult: 0,
      swingAmount: 0,
      assignedKitNumber: 0,
      accentAmount: 0,
      scale: 0,
      trigBitsPerTrack: Array.from({ length: numTracks }, () => new Uint8Array(numBytes)),
      accentBitsGlobal: new Uint8Array(numBytes),
      accentBitsPerTrack: Array.from({ length: numTracks }, () => new Uint8Array(numBytes)),
      swingBitsGlobal: new Uint8Array(numBytes),
      swingBitsPerTrack: Array.from({ length: numTracks }, () => new Uint8Array(numBytes)),
      slideBitsGlobal: new Uint8Array(numBytes),
      slideBitsPerTrack: Array.from({ length: numTracks }, () => new Uint8Array(numBytes)),
      accentEditAll: true,
      swingEditAll: true,
      slideEditAll: true,
      trackAccentMasks: Array(numTracks).fill(0),
      trackSlideMasks: Array(numTracks).fill(0),
      trackSwingMasks: Array(numTracks).fill(0),
      locks: [],
      rawPattern: null,
      paramMatrixMain: Array.from({ length: 64 }, () => new Uint8Array(32)),
      paramMatrixExtra: Array.from({ length: 64 }, () => new Uint8Array(32))
    };
  }

  function initGlobalData(slotIndex = 0) {
  const gpIn = Number.isFinite(slotIndex) ? (slotIndex | 0) : 0;
  const gp = Math.max(0, Math.min(7, gpIn));
  const km = new Uint8Array(128).fill(0x7F);

  const defaultMapping = [36,38,40,41,43,45,47,48,50,52,53,55,57,59,60,62];
  defaultMapping.forEach((noteNumber, trackID) => {
    km[noteNumber] = trackID & 0x7F;
  });

  return {
    sysexVersion:        6,   
    sysexRevision:       1,
    globalPosition:      gp,  
    tempo:             120.0, 
    midiBase:            0,   
    mechanicalSettings:  0,   
    extendedMode:        1,   
    flags:               0,  
    localOn:             1,   
    drumRouting:     Array(16).fill(6), 
    keymap:               km,         
    programChangeMode:    0,  
    programChangeChannel: 0,
    trigMode:             1,  
    drumLeft:            16,  
    drumRight:           16,
    gateLeft:            0,  
    gateRight:           0,
    senseLeft:          0,   
    senseRight:          0,
    minLevelLeft:         0,
    maxLevelLeft:       127,
    minLevelRight:        0,
    maxLevelRight:      127
    };
  }

  // Export for UI/Import flows that need a default Global object for a given slot
  // without coupling to this module's internals.
  window.initGlobalData = initGlobalData;

  function initSong() {
    return {
      rows: [],
      name: "",
      slotIndex: 0
    };
  }

  window.DEFAULTS = {
    kit: {
      machineAssignments: Array(16).fill(0),
      machineTonalFlags: Array(16).fill(0),
      machineParams: Array.from({ length: 16 }, () => Array(8).fill(64)),
      trackFx: Array.from({ length: 16 }, () => Array(8).fill(0)),
      routing: Array.from({ length: 16 }, () => Array(8).fill(0)),
      muteTrigRelations: Array.from({ length: 16 }, () => [128, 128]),
      lfoBlocks: Array.from({ length: 16 }, () => Array(36).fill(0)),
      masterFx: Array(32).fill(0),
      trackLevels: Array(16).fill(100),
      kitName: "".split(""),
      rawKit: null
    },
    pattern: {
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
    },
    song: {
      rows: [],
      name: "SONG",
      slotIndex: 0
    },
    globalData: {
      sysexVersion:          6,
    tempo:                120.0,
    midiBase:               0,
    mechanicalSettings:     0,
    extendedMode:           0,
    flags:                  0,
    localOn:                0,
    drumRouting:       Array(16).fill(6),
    keymap:         new Uint8Array(128).fill(0x7F),
    trigMode:              0,
    programChangeMode:     0,
    programChangeChannel:  0,
    gateLeft:              0,
    gateRight:           0,
    minLevelLeft:          0,
    maxLevelLeft:        127,
    minLevelRight:         0,
    maxLevelRight:       127
    }
  };

  window.kit = initKit();
  window.pattern = initPattern();
  window.globalData = initGlobalData();
  window.currentSong = initSong();

  window.allSongSlots = window.allSongSlots || new Array(32).fill(null);
  window.allPatternSlots = window.allPatternSlots || new Array(128).fill(null);
  window.kitLibrary = window.kitLibrary || [];
  window.patternLibrary = window.patternLibrary || new Array(128).fill(null);
  window.globalLibrary = window.globalLibrary || new Array(8).fill(null);

  window.isBulkInProgress =
    window.isReceiveAllInProgress =
    window.isSendAllInProgress = false;
  window.requestingGlobals =
    window.requestingSongs =
    window.requestingKits =
    window.requestingPatterns = false;

  const getEl = id => document.getElementById(id);

  window.onChangeUWCheckbox = () => {
    window.mdUWEnabled = !!getEl("uwToggleCheckbox").checked;
    if (typeof initUI === "function") initUI();
  };
  
  window.onChangeMdModel = () => {
    window.mdModel = getEl("mdModelSelect").value;
    if (typeof initUI === "function") initUI();
  };

window.onChangeOSVersion = () => {
  const val = document.getElementById("osVersionSelect").value;
  window.mdOSVersion = val;
  
  // New override: machine 1 → “GND-SN” under 1.63
  window.getMachineName = id => {
    if (window.mdOSVersion === "1.63" && id === 1) {
      return "GND-SN";
    }
    return window._originalGetMachineName(id);
  };

    // Dynamically adjust count: 6 shapes in 1.63, else 11
  window.MD_LFO_WAVE_COUNT = (val === "1.63" ? 6 : 11);



  // Clamp any loaded kit’s LFO shapes to the new max
  if (window.kit && Array.isArray(window.kit.lfoBlocks)) {
    const max = window.MD_LFO_WAVE_COUNT - 1;
    window.kit.lfoBlocks.forEach(block => {
      if (Array.isArray(block)) {
        block[2] = Math.min(block[2] || 0, max);
        block[3] = Math.min(block[3] || 0, max);
      }
    });
  }
    window.labPanelInitialized = false;
  // Persist OS version preference (safe in privacy-restricted contexts)
  if (typeof window.safeStorageSet === "function") {
    window.safeStorageSet("mdOSVersion", val);
  } else {
    try { localStorage.setItem("mdOSVersion", val); } catch (_) {}
  }
  if (typeof initUI === "function") initUI();
};

  window.mdModel = "MKII";
  window.mdUWEnabled = true;
  window.mdOSVersion = "X";
  window.labPanelInitialized = false;

  window.initSlots = function () {
    window.globalLibrary = window.globalLibrary || new Array(8).fill(null);
    window.allSongSlots = window.allSongSlots || new Array(32).fill(null);
    window.kitLibrary = window.kitLibrary || new Array(64).fill(null);
  };
})();