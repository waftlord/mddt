/* machinedrum-random.js */

(function(){

  // --- Randomization Utilities ---
  const RandomUtils = {
    randomInt(max) {
      return Math.floor(Math.random() * max);
    },
    partialRandom(oldVal, paramName = "") {
      let r = RandomUtils.randomInt(128);
      let val = Math.round(oldVal + (r - oldVal) * window.globalRandomDepth);
      val = Math.max(0, Math.min(val, 127));
      if (paramName === "FB") val = Math.min(val, 63);
      return val;
    },
    shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        let j = RandomUtils.randomInt(i + 1);
        [array[i], array[j]] = [array[j], array[i]];
      }
    }
  };
  window.randomInt = RandomUtils.randomInt;
  window.partialRandom = RandomUtils.partialRandom;
  window.shuffle = RandomUtils.shuffle;

  (function(){
    window.getValidMachinePool = function(){
      const d = window.getValidMachineEntries(window.mdModel);
      return Object.keys(d)
        .map(k => parseInt(k, 10))
        .filter(id => {
          const name = d[id] || "";
          if (name.startsWith("(unused #")) return false;
          if (window.mdOSVersion === "1.63" && window.X_OS_ONLY_MACHINES.includes(id)) return false;
          if (!window.mdUWEnabled && id >= 124) return false;
          return true;
        })
        .sort((a, b) => a - b);
    };
  })();

  (function(){
    window.randomizeMachineAssignments = function(){
      const pool = window.getValidMachinePool();
      if (!pool || !pool.length) {
        console.error("No valid machine pool available!");
        return;
      }
      const filt = pool.filter(id => {
        let n = window.getMachineName(id);
        return n && !n.toLowerCase().includes("unused");
      });
      const finalPool = filt.length ? filt : pool;
      for (let t = 0; t < 16; t++) {
        let newID = finalPool[RandomUtils.randomInt(finalPool.length)];
        window.kit.machineAssignments[t] = newID;
        window.kit.machineTonalFlags[t] =
          window.mdOSVersion === "1.63"
            ? 0
            : (window.MACHINES_THAT_SUPPORT_TONAL.has(newID)
              ? (Math.random() < 0.5 ? 1 : 0)
              : 0);
      }
      if (typeof buildTrackOverviewUI === "function") buildTrackOverviewUI();
    };
    function generateNameFromPattern(opts = {}) {
      const vowels     = opts.vowels     || "AEIOUY";
      const consonants = opts.consonants || "BCDFGHJKLMNPQRSTVWXZ";
      const extras     = opts.extras     || "";
      const patterns   = (Array.isArray(opts.patterns) && opts.patterns.length)
                          ? opts.patterns
                          : ["CVCVCV","CVCCVC","VCVCVC","CVCV","CVCCV","CVCE","CVE"];
      const pat = patterns[RandomUtils.randomInt(patterns.length)];
      const pick = (set, last) => {
        if (!set) return "";
        let cand = set.charAt(RandomUtils.randomInt(set.length)), tries = 0;
        while (set.length > 1 && cand === last && tries++ < 8) {
          cand = set.charAt(RandomUtils.randomInt(set.length));
        }
        return cand;
      };
      let name = "";
      for (let i = 0; i < pat.length; i++) {
        const ch = pat.charAt(i);
        const last = name.length ? name.charAt(name.length - 1) : "";
        if (ch === "C")      name += pick(consonants, last);
        else if (ch === "V") name += pick(vowels, last);
        else if (ch === "E") name += pick(extras, last);
        else                 name += ch;
      }
      return name;
    }



    window.randomizeKitName = function (){
      const name = generateNameFromPattern({
        patterns: [
          "CVCVCV","CVCCVC","VCVCVC","CVCV","CVVCV","CVCVC","CVCCV","CVCVCC",
          "CVECVC","CVEVC","CEVCCV","VCVCCV","CCVVCV","CVCVVC","CVVCCV","CVVCVC",
          "CVCVEC","VCVECV","CVEVCC","CVCVVCV","CVC CVC","VCV CVC","CVC CVC E",
          "CVC CVC VC","CVC VCVC","CVCC VC","CVC VC E","CVCV CVC","CVC VCVCV",
          "CV CVCV","VC VCVC","CVVC VC","CVCV EVC","CVEC VC","VCVC VC","CV CVC E",
          "VCV CVEC","CVCC VEC","CVCV CVEC","VCV CVCVC"
        ],
        extras: "0123456789!@#$%^&*"
      }).substring(0, 10);
      window.kit.kitName = name.split("");
      if (typeof buildKitNameUI === "function") buildKitNameUI();
      return name;
    };

    window.generateSongName = function(patterns){
      const name = generateNameFromPattern({
        patterns: (Array.isArray(patterns) && patterns.length)
          ? patterns
          : [
              "CVCVC","CVCCV","CVCV","CVVCV","VCVCV","CVCVCV",
              "CVCE","CVE","CVCVEC","CVCVVC","CVCV CVC","CVCV CVE"
            ],
        extras: "0123456789"
      }).slice(0, 12);
      return name;
    };



    window.randomizeOneBlockTrack = function(t, cat){
      for (let p = 0; p < 8; p++){
        if (cat === "machineParams")
          window.kit.machineParams[t][p] = RandomUtils.partialRandom(window.kit.machineParams[t][p]);
        else if (cat === "trackFx")
          window.kit.trackFx[t][p] = RandomUtils.partialRandom(window.kit.trackFx[t][p]);
        else if (cat === "routing")
          window.kit.routing[t][p] = RandomUtils.partialRandom(window.kit.routing[t][p]);
      }
    };

    window.randomizeOneKitTrack = function(t){
      const pool = window.getValidMachinePool();
      if (pool && pool.length) {
        const filt = pool.filter(id => {
          let n = window.getMachineName(id) || "";
          return n && !n.toLowerCase().includes("unused");
        });
        const valid = filt.length ? filt : pool;
        let newID = valid[RandomUtils.randomInt(valid.length)];
        window.kit.machineAssignments[t] = newID;
        window.kit.machineTonalFlags[t] =
          window.mdOSVersion !== "1.63" &&
          window.MACHINES_THAT_SUPPORT_TONAL.has(newID)
            ? (Math.random() < 0.5 ? 1 : 0)
            : 0;
      }
      window.kit.trackLevels[t] = RandomUtils.randomInt(128);
      window.kit.muteTrigRelations[t] = [RandomUtils.randomInt(16), RandomUtils.randomInt(16)];
      const waveMax = window.mdOSVersion === "1.63" ? 5 : 10;
      window.kit.lfoBlocks[t][0] = RandomUtils.randomInt(16);
      window.kit.lfoBlocks[t][1] = RandomUtils.randomInt(24);
      window.kit.lfoBlocks[t][2] = RandomUtils.randomInt(waveMax + 1);
      window.kit.lfoBlocks[t][3] = RandomUtils.randomInt(waveMax + 1);
      window.kit.lfoBlocks[t][4] = RandomUtils.randomInt(3);
      for (let p = 0; p < 8; p++){
        window.kit.machineParams[t][p] = RandomUtils.partialRandom(window.kit.machineParams[t][p]);
        window.kit.trackFx[t][p] = RandomUtils.partialRandom(window.kit.trackFx[t][p]);
        window.kit.routing[t][p] = RandomUtils.partialRandom(window.kit.routing[t][p]);
      }
    };

    window.randomizeOneKitParam = function(t, cat, pi){
      if (cat === "machineParams")
        window.kit.machineParams[t][pi] = RandomUtils.partialRandom(window.kit.machineParams[t][pi]);
      else if (cat === "trackFx")
        window.kit.trackFx[t][pi] = RandomUtils.partialRandom(window.kit.trackFx[t][pi]);
      else if (cat === "routing")
        window.kit.routing[t][pi] = RandomUtils.partialRandom(window.kit.routing[t][pi]);
    };
  })();

  // --- Pattern Randomization ---
  (function patternRandomization(){
    function initBitfield(arr, n){
      if (!arr || typeof arr.fill !== "function")
        return new Array(n).fill(0);
      arr.fill(0);
      return arr;
    }
    function setRandomBits(bitfield, steps, count){
      steps.slice(0, count).forEach(s => {
        const bi = s >> 3, bp = s & 7;
        bitfield[bi] |= 1 << bp;
      });
    }
    window.randomizeAllBitfieldsForTrack = function(t){
      const len = window.pattern.length;
      const trig = window.pattern.trigBitsPerTrack[t],
            accent = window.pattern.accentBitsPerTrack[t],
            swing = window.pattern.swingBitsPerTrack[t],
            slide = window.pattern.slideBitsPerTrack[t];
      trig.fill(0); accent.fill(0); swing.fill(0); slide.fill(0);
      let steps = [...Array(len).keys()];
      RandomUtils.shuffle(steps);
      setRandomBits(trig, steps, Math.floor(len / 2));
      steps = [...Array(len).keys()];
      RandomUtils.shuffle(steps);
      setRandomBits(accent, steps, Math.floor(len / 4));
      steps = [...Array(len).keys()];
      RandomUtils.shuffle(steps);
      setRandomBits(swing, steps, Math.floor(len / 4));
      steps = [...Array(len).keys()];
      RandomUtils.shuffle(steps);
      setRandomBits(slide, steps, Math.floor(len / 8));
      removeLocksForClearedTrigs();
    };
  })();

  // --- Additional Reset and Track Randomization Functions ---

  function resetGlobal() {
    if (!window.globalData) window.globalData = {};
    if (window.DEFAULTS && window.DEFAULTS.globalData) {
      window.globalData = JSON.parse(JSON.stringify(window.DEFAULTS.globalData));
    } else {
      window.globalData.tempo = 120;
    }
    if (typeof initGlobalUI === "function") {
      initGlobalUI();
    }
    updatePanelHeaderColors();
  }
  window.resetGlobal = resetGlobal;

  (function resetAndTrackRandomization(){
    function resetMasterFxAll(){
      window.kit.masterFx = [...window.DEFAULT_MASTER_FX];
      if (window.initUI) window.initUI();
    }
    window.resetKit = function(){
      for (let t = 0; t < 16; t++){
        window.kit.machineAssignments[t] = 0;
        window.kit.machineTonalFlags[t] = 0;
        for (let p = 0; p < 8; p++){
          window.kit.machineParams[t][p] = 64;
          window.kit.trackFx[t][p] = 0;
          window.kit.routing[t][p] = 0;
        }
        window.kit.trackLevels[t] = 100;
        window.kit.muteTrigRelations[t] = [128, 128];
        if (!window.kit.lfoBlocks[t]) window.kit.lfoBlocks[t] = new Array(8).fill(0);
        window.kit.lfoBlocks[t][0] = t;
        window.kit.lfoBlocks[t][1] = 0;
        window.kit.lfoBlocks[t][2] = 0;
        window.kit.lfoBlocks[t][3] = 0;
        window.kit.lfoBlocks[t][4] = 0;
      }
      resetMasterFxAll();
      window.kit.kitName = "DEFAULT".split("");
      if (window.mdOSVersion === "1.63") {
        window.kit.sysexVersion = 4;
        window.kit.sysexRevision = 1;
      } else {
        window.kit.sysexVersion = 64;
        window.kit.sysexRevision = 1;
      }
      window.selectedKitSlotIndex = -1;
      window.kit.sysexPosition = 0;
      if (window.initUI) window.initUI();
      updatePanelHeaderColors();
    };

    window.randomizeMasterFxBlock = function(bi){
      const start = bi * 8;
      for (let i = 0; i < 8; i++){
        const paramName = (bi === 1 && i === 3) ? "FB" : "";
        window.kit.masterFx[start + i] = RandomUtils.partialRandom(window.kit.masterFx[start + i], paramName);
      }
      if (typeof buildMasterFxUI === "function") buildMasterFxUI();
    };

    window.DEFAULT_MASTER_FX = [
      0, 0, 64, 0, 0, 127, 0, 64,
      64, 0, 0, 32, 0, 127, 0, 64,
      64, 64, 64, 64, 64, 64, 64, 127,
      0, 0, 127, 127, 127, 127, 0, 0
    ];

    window.resetTracksBlock = function(t){
      window.kit.machineTonalFlags[t] = 0;
      window.kit.trackLevels[t] = 100;
      window.kit.muteTrigRelations[t] = [128, 128];
      if (!window.kit.lfoBlocks[t]) window.kit.lfoBlocks[t] = new Array(8).fill(0);
      window.kit.lfoBlocks[t][0] = t;
      window.kit.lfoBlocks[t][1] = 0;
      window.kit.lfoBlocks[t][2] = 0;
      window.kit.lfoBlocks[t][3] = 0;
      window.kit.lfoBlocks[t][4] = 0;
    };


    window.randomizeTracksBlock = function(t){
      const pool = window.getValidMachinePool();
      if (pool && pool.length) {
        const filt = pool.filter(id => {
          let n = window.getMachineName(id) || "";
          return n && !n.toLowerCase().includes("unused");
        });
        const valid = filt.length > 0 ? filt : pool;
        let newID = valid[RandomUtils.randomInt(valid.length)];
        window.kit.machineAssignments[t] = newID;
        window.kit.machineTonalFlags[t] =
          window.MACHINES_THAT_SUPPORT_TONAL &&
          window.MACHINES_THAT_SUPPORT_TONAL.has(newID)
            ? (Math.random() < 0.5 ? 1 : 0)
            : 0;
      }
      window.kit.trackLevels[t] = RandomUtils.randomInt(128);
      window.kit.muteTrigRelations[t] = [RandomUtils.randomInt(16), RandomUtils.randomInt(16)];
      if (window.kit.lfoBlocks[t]) {
        window.kit.lfoBlocks[t][0] = RandomUtils.randomInt(16);
        window.kit.lfoBlocks[t][1] = RandomUtils.randomInt(24);
        const waveMax = window.mdOSVersion === "1.63" ? 5 : 10;
        window.kit.lfoBlocks[t][2] = RandomUtils.randomInt(waveMax + 1);
        window.kit.lfoBlocks[t][3] = RandomUtils.randomInt(waveMax + 1);
        window.kit.lfoBlocks[t][4] = RandomUtils.randomInt(3);
      }
    };
  })();

})();
