(() => {
  "use strict";

  function debug(...args) {
    if (window.__UI_DEBUG__) console.log("[Shim]", ...args);
  }

  function isDebugMode() {
    try {
      if (window.__UI_DEBUG__ === true) return true;
      if (/[?&]debug\b/i.test(location.search)) return true;
      const sg = (typeof window.safeStorageGet === "function")
        ? window.safeStorageGet
        : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
      if (sg("mddtDebug") === "1") return true;
    } catch (_) {
      if (/[?&]debug\b/i.test(location.search)) return true;
    }
    return false;
  }


  function clone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  function panelForType(type) {
    return type === "global" ? "global"
      : type === "kit" ? "kit"
      : type === "pattern" ? "pattern"
      : type === "song" ? "song"
      : "midi";
  }

  function uiSlotIdFor(type, index) {
    return window.MDDTSlotMap?.buildUiSlotId({ type, index }) ?? `${type}:${index}`;
  }

  function clampInt(v, min, max) {
    const n = Number.isFinite(v) ? Math.trunc(v) : NaN;
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function getActiveIndex(type) {
    if (type === "global") {
      if (Number.isFinite(window.selectedGlobalSlotIndex) && window.selectedGlobalSlotIndex >= 0) {
        return clampInt(window.selectedGlobalSlotIndex, 0, 7);
      }
      return clampInt(window.globalData?.globalPosition, 0, 7);
    }
    if (type === "kit") {
      if (Number.isFinite(window.selectedKitSlotIndex) && window.selectedKitSlotIndex >= 0) {
        return clampInt(window.selectedKitSlotIndex, 0, 63);
      }
      return clampInt(window.kit?.sysexPosition, 0, 63);
    }
    if (type === "pattern") {
      if (Number.isFinite(window.selectedPatternSlotIndex) && window.selectedPatternSlotIndex >= 0) {
        return clampInt(window.selectedPatternSlotIndex, 0, 127);
      }
      return clampInt(window.pattern?.patternNumber, 0, 127);
    }
    if (type === "song") {
      if (Number.isFinite(window.selectedSongSlotIndex) && window.selectedSongSlotIndex >= 0) {
        return clampInt(window.selectedSongSlotIndex, 0, 31);
      }
      return clampInt(window.currentSong?.slotIndex, 0, 31);
    }
    return 0;
  }

  function setPanel(panelId) {
    if (window.MDDTShell?.setActivePanel) return window.MDDTShell.setActivePanel(panelId);
    const btn = document.querySelector(`.nav-btn[data-panel="${panelId}"]`);
    if (btn) btn.click();
  }

  function loadGlobal(index) {
    window.selectedGlobalSlotIndex = index;
    const slot = window.globalLibrary?.[index];
    if (slot) {
      window.globalData = clone(slot);
      if (typeof window.initGlobalUI === "function") window.initGlobalUI();
      if (window.selectedMidiOut) {
        try {
          const msg = new Uint8Array([0xF0, 0x00, 0x20, 0x3C, 0x02, 0x00, 0x56, index & 0x7F, 0xF7]);
          window.selectedMidiOut.send(msg);
        } catch (e) {
          console.warn("[Shim] Failed to send load-global SysEx", e);
        }
      }
    }
    window.UIBus?.emit("slot:load", { uiSlotId: uiSlotIdFor("global", index), type: "global", index });
    window.UIBus?.emit("slot:clean", { uiSlotId: uiSlotIdFor("global", index), type: "global", index });
    window.SlotStrip?.renderIndicators();
  }

  function loadKit(index) {
    window.selectedKitSlotIndex = index;
    const item = window.kitLibrary?.[index];
    if (item?.data) {
      window.kit = clone(item.data);
    } else {
      window.kit = clone(window.DEFAULTS?.kit || window.kit || {});
      if (window.kit && Array.isArray(window.kit.lfoBlocks)) {
        for (let t = 0; t < 16; t++) {
          if (window.kit.lfoBlocks[t]) window.kit.lfoBlocks[t][0] = t;
        }
      }
      if (window.kit) window.kit.kitName = "DEFAULT".split("");
      if (window.DEFAULT_MASTER_FX && window.kit) window.kit.masterFx = [...window.DEFAULT_MASTER_FX];
    }

    const disp = document.getElementById("kitNumberDisplay");
    if (disp) disp.textContent = String(index + 1);

    if (typeof window.buildKitEditors === "function") window.buildKitEditors();
    if (typeof window.updatePanelHeaderColors === "function") window.updatePanelHeaderColors();

    window.UIBus?.emit("slot:load", { uiSlotId: uiSlotIdFor("kit", index), type: "kit", index });
    window.UIBus?.emit("slot:clean", { uiSlotId: uiSlotIdFor("kit", index), type: "kit", index });
    window.SlotStrip?.renderIndicators();
  }

  function loadPattern(index) {
    if (typeof window.loadSinglePatternSlot === "function") {
      window.loadSinglePatternSlot(index);
    } else {
      window.selectedPatternSlotIndex = index;
      if (typeof window.resetPattern === "function") window.resetPattern();
    }
    window.UIBus?.emit("slot:load", { uiSlotId: uiSlotIdFor("pattern", index), type: "pattern", index });
    window.UIBus?.emit("slot:clean", { uiSlotId: uiSlotIdFor("pattern", index), type: "pattern", index });
    window.SlotStrip?.renderIndicators();
  }

  function loadSong(index) {
    if (typeof window.loadOrResetSongSlot === "function") {
      window.loadOrResetSongSlot(index);
    } else {
      window.selectedSongSlotIndex = index;
      if (typeof window.resetSong === "function") window.resetSong();
    }
    window.UIBus?.emit("slot:load", { uiSlotId: uiSlotIdFor("song", index), type: "song", index });
    window.UIBus?.emit("slot:clean", { uiSlotId: uiSlotIdFor("song", index), type: "song", index });
    window.SlotStrip?.renderIndicators();
  }


  function syncToolsSliders(type, index) {
    try {
      if (type === "global") {
        const s = document.getElementById("slider-globals")?.noUiSlider;
        if (s) s.set([index + 1, index + 1]);
      } else if (type === "kit") {
        const s = document.getElementById("slider-kits")?.noUiSlider;
        if (s) s.set([index + 1, index + 1]);
      } else if (type === "song") {
        const s = document.getElementById("slider-songs")?.noUiSlider;
        if (s) s.set([index + 1, index + 1]);
      } else if (type === "pattern") {
        const s = document.getElementById("slider-patterns")?.noUiSlider;
        if (s) {
          const label = (typeof window.patternIndexToLabel === "function")
            ? window.patternIndexToLabel(index)
            : String(index);
          s.set([label, label]);
        }
      }
    } catch (e) {
      console.warn("[IntegrationShim] Failed syncing sliders", type, index, e);
    }
  }

  function handleSlotSelect(mapping) {
    if (!mapping?.type) return;
    debug("slot:select", mapping);
    if (window.__SYNC_SLOT_TOOLS_SLIDERS__ === true) {
      syncToolsSliders(mapping.type, mapping.index);
    }
    setPanel(panelForType(mapping.type));
    switch (mapping.type) {
      case "global": loadGlobal(mapping.index); break;
      case "kit": loadKit(mapping.index); break;
      case "pattern": loadPattern(mapping.index); break;
      case "song": loadSong(mapping.index); break;
    }
  }

  function installDirtyTracking() {
    const host = document.querySelector(".panel-host");
    if (!host) return;

    const mark = (ev) => {
      const panel = ev.target?.closest?.(".panel");
      const panelId = panel?.dataset?.panelId;
      if (!panelId) return;

      const type = panelId === "midi" ? null : panelId;
      if (!type || !["kit", "pattern", "song", "global"].includes(type)) return;
      try {
        window.updatePanelHeaderColors?.();
      } catch (_) {}
    };

    host.addEventListener("input", mark, true);
    host.addEventListener("change", mark, true);
  }

  function wrapCleanOn(fnName, type, indexGetter) {
    const orig = window[fnName];
    if (typeof orig !== "function") return;
    window[fnName] = function (...args) {
      const index = indexGetter();
      const uiSlotId = uiSlotIdFor(type, index);
      window.UIBus?.emit("transport:sendStart", { uiSlotId, type, index, fn: fnName });
      const out = orig.apply(this, args);
      setTimeout(() => {
        window.UIBus?.emit("transport:sendEnd", { uiSlotId, type, index, fn: fnName });
        try {
          window.updatePanelHeaderColors?.();
        } catch (_) {}
      }, 250);
      return out;
    };
  }

  function installSendReceiveHooks() {
    wrapCleanOn("onClickWriteGlobal", "global", () => getActiveIndex("global"));
    wrapCleanOn("saveCurrentKitToMD", "kit", () => getActiveIndex("kit"));
    wrapCleanOn("writePatternToMD", "pattern", () => getActiveIndex("pattern"));
    wrapCleanOn("saveCurrentSongToMD", "song", () => getActiveIndex("song"));

    const wrapBusy = (fnName, type, indexGetter) => {
      const orig = window[fnName];
      if (typeof orig !== "function") return;
      window[fnName] = function (...args) {
        const index = indexGetter();
        const uiSlotId = uiSlotIdFor(type, index);
        window.UIBus?.emit("transport:receiveStart", { uiSlotId, type, index, fn: fnName });
        const out = orig.apply(this, args);
        setTimeout(() => {
          window.UIBus?.emit("transport:receiveEnd", { uiSlotId, type, index, fn: fnName });
        }, 500);
        return out;
      };
    };
    wrapBusy("requestGlobalDump", "global", () => getActiveIndex("global"));
    wrapBusy("requestKitDump", "kit", () => getActiveIndex("kit"));
    wrapBusy("requestPatternDump", "pattern", () => getActiveIndex("pattern"));
    wrapBusy("requestSongDump", "song", () => getActiveIndex("song"));

    installSelectionDrivenSingleIO();
  }

  // ------------------------------------------
  // Active slot semantics
  // ------------------------------------------
  function installSelectionDrivenSingleIO() {
    if (installSelectionDrivenSingleIO.__installed) return;
    installSelectionDrivenSingleIO.__installed = true;

    const SLOT_LIMITS = {
      global: 8,
      kit: 64,
      pattern: 128,
      song: 32,
    };

    const sliderIdForType = (type) => {
      switch (type) {
        case "global": return "slider-globals";
        case "kit": return "slider-kits";
        case "pattern": return "slider-patterns";
        case "song": return "slider-songs";
        default: return null;
      }
    };

    const selectedIndexForType = (type) => {
      switch (type) {
        case "global": return Number.isFinite(window.selectedGlobalSlotIndex) ? window.selectedGlobalSlotIndex : -1;
        case "kit": return Number.isFinite(window.selectedKitSlotIndex) ? window.selectedKitSlotIndex : -1;
        case "pattern": return Number.isFinite(window.selectedPatternSlotIndex) ? window.selectedPatternSlotIndex : -1;
        case "song": return Number.isFinite(window.selectedSongSlotIndex) ? window.selectedSongSlotIndex : -1;
        default: return -1;
      }
    };

    const setSelectedIndexForType = (type, idx) => {
      switch (type) {
        case "global":
          window.selectedGlobalSlotIndex = idx;
          if (window.globalData) window.globalData.globalPosition = idx;
          if (typeof window.buildGlobalSlotsUI === "function") window.buildGlobalSlotsUI();
          break;
        case "kit":
          window.selectedKitSlotIndex = idx;
          if (typeof window.buildKitSlotsUI === "function") window.buildKitSlotsUI();
          break;
        case "pattern":
          window.selectedPatternSlotIndex = idx;
          if (typeof window.buildTopPatternBanksUI === "function") window.buildTopPatternBanksUI();
          if (typeof window.attachBankSlotClickHandlers === "function") window.attachBankSlotClickHandlers();
          if (typeof window.colorizeSlots === "function") window.colorizeSlots();
          break;
        case "song":
          window.selectedSongSlotIndex = idx;
          if (typeof window.buildSongSlotsUI === "function") window.buildSongSlotsUI();
          break;
      }
    };

    const clampIndex = (type, idx) => {
      const max = SLOT_LIMITS[type];
      if (!Number.isFinite(idx)) return 0;
      if (!max) return Math.max(0, idx);
      return Math.min(Math.max(0, idx), max - 1);
    };

    const getSliderRange = (type) => {
      const id = sliderIdForType(type);
      if (!id) return null;
      const el = document.getElementById(id);
      const s = el?.noUiSlider;
      if (!s) return null;
      const raw = s.get();
      if (!Array.isArray(raw) || raw.length < 2) return null;

      if (type === "pattern") {
        const startIndex = (typeof window.patternLabelToIndex === "function") ? window.patternLabelToIndex(raw[0]) : 0;
        const endIndex = (typeof window.patternLabelToIndex === "function") ? window.patternLabelToIndex(raw[1]) : startIndex;
        return {
          startIndex: clampIndex(type, startIndex),
          endIndex: clampIndex(type, endIndex),
          hasRange: startIndex !== endIndex,
          raw,
          slider: s,
        };
      }

      // globals/kits/songs sliders are 1-based in UI
      const startIndex = parseInt(raw[0], 10) - 1;
      const endIndex = parseInt(raw[1], 10) - 1;
      return {
        startIndex: clampIndex(type, startIndex),
        endIndex: clampIndex(type, endIndex),
        hasRange: startIndex !== endIndex,
        raw,
        slider: s,
      };
    };

    const sliderValueForIndex = (type, idx) => {
      if (type === "pattern") {
        return (typeof window.patternIndexToLabel === "function")
          ? window.patternIndexToLabel(idx)
          : String(idx);
      }
      return String(idx + 1);
    };

    const labelFor = (type, idx) => window.MDDTSlotMap?.labelFor
      ? window.MDDTSlotMap.labelFor(type, idx)
      : (type === "pattern" && typeof window.patternIndexToLabel === "function")
        ? window.patternIndexToLabel(idx)
        : String(idx + 1);

    const shouldWarnSelectionVsSlider = (type, targetIndex) => {
      const selected = selectedIndexForType(type);
      const slider = getSliderRange(type);
      if (selected < 0) return { should: false };
      if (!slider) return { should: false };
      const mismatch = slider.startIndex !== selected;
      if (!mismatch) return { should: false };
      return { should: true, selected, slider };
    };

    const confirmSelectionVsSlider = (type, action, targetIndex) => {
      const info = shouldWarnSelectionVsSlider(type, targetIndex);
      if (!info.should) return true;
      const selectedLabel = labelFor(type, info.selected);
      const sliderStartLabel = labelFor(type, info.slider.startIndex);
      const sliderRangeLabel = info.slider.hasRange
        ? `${sliderStartLabel}–${labelFor(type, info.slider.endIndex)}`
        : sliderStartLabel;
      const msg =
        `${action} will target the selected ${type.toUpperCase()} slot (${selectedLabel}).\n\n` +
        `But the POSITION slider is set to ${sliderRangeLabel}.\n\n` +
        `To avoid writing to the wrong slot on the Machinedrum, confirm you want to use the selected slot (${selectedLabel}).\n\n` +
        `Tip: use the ALL buttons for range operations.`;
      return confirm(msg);
    };

    const resolveTargetIndex = (type, explicitIndex) => {
      if (typeof explicitIndex === "number") return clampIndex(type, explicitIndex);
      const selected = selectedIndexForType(type);
      if (selected >= 0) return clampIndex(type, selected);
      const slider = getSliderRange(type);
      if (slider) return clampIndex(type, slider.startIndex);
      return clampIndex(type, getActiveIndex(type));
    };

    const withTemporarySlider = (type, targetIndex, fn) => {
      const slider = getSliderRange(type);
      if (!slider?.slider) return fn();
      const prev = slider.raw;
      try {
        const v = sliderValueForIndex(type, targetIndex);
        slider.slider.set([v, v]);
      } catch (e) {
        // Ignore
      }

      try {
        return fn();
      } finally {
        try {
          slider.slider.set(prev);
        } catch (e) {
          // ignore
        }
      }
    };

    // Wrap helpers
    const wrapSelectionDriven = ({ fnName, type, mode, impl }) => {
      const orig = window[fnName];
      if (typeof orig !== "function") return;
      window[fnName] = function (...args) {
        if (args[0] && typeof args[0] === "object" && args[0].useRange) {
          return orig.apply(this, args);
        }

        const explicitIndex = (typeof args[0] === "number") ? args[0] : null;
        const targetIndex = resolveTargetIndex(type, explicitIndex);

        if (mode === "send" && explicitIndex === null) {
          if (!confirmSelectionVsSlider(type, "SEND", targetIndex)) return;
        }

        const currentSel = selectedIndexForType(type);
        if (currentSel !== targetIndex) {
          setSelectedIndexForType(type, targetIndex);
        } else if (type === "global" && window.globalData) {
          window.globalData.globalPosition = targetIndex;
        }

        return impl({ orig, args, explicitIndex, targetIndex, thisArg: this });
      };
    };

    // RECEIVE wrappers
    wrapSelectionDriven({
      fnName: "requestGlobalDump",
      type: "global",
      mode: "receive",
      impl: ({ orig, args, explicitIndex, targetIndex, thisArg }) => {
        return orig.call(thisArg, explicitIndex !== null ? explicitIndex : targetIndex);
      }
    });

    wrapSelectionDriven({
      fnName: "requestKitDump",
      type: "kit",
      mode: "receive",
      impl: ({ orig, args, explicitIndex, targetIndex, thisArg }) => {
        return orig.call(thisArg, explicitIndex !== null ? explicitIndex : targetIndex);
      }
    });

    wrapSelectionDriven({
      fnName: "requestSongDump",
      type: "song",
      mode: "receive",
      impl: ({ orig, args, explicitIndex, targetIndex, thisArg }) => {
        return orig.call(thisArg, explicitIndex !== null ? explicitIndex : targetIndex);
      }
    });

    wrapSelectionDriven({
      fnName: "requestPatternDump",
      type: "pattern",
      mode: "receive",
      impl: ({ orig, args, targetIndex, thisArg }) => {
        return withTemporarySlider("pattern", targetIndex, () => orig.apply(thisArg, args));
      }
    });

    // SEND wrappers
    wrapSelectionDriven({
      fnName: "onClickWriteGlobal",
      type: "global",
      mode: "send",
      impl: ({ orig, args, targetIndex, thisArg }) => {
        if (window.globalData) window.globalData.globalPosition = targetIndex;
        return orig.apply(thisArg, args);
      }
    });

    wrapSelectionDriven({
      fnName: "saveCurrentKitToMD",
      type: "kit",
      mode: "send",
      impl: ({ orig, args, explicitIndex, targetIndex, thisArg }) => {
        return orig.call(thisArg, explicitIndex !== null ? explicitIndex : targetIndex);
      }
    });

    wrapSelectionDriven({
      fnName: "writePatternToMD",
      type: "pattern",
      mode: "send",
      impl: ({ orig, args, targetIndex, thisArg }) => {
        return withTemporarySlider("pattern", targetIndex, () => orig.apply(thisArg, args));
      }
    });

    wrapSelectionDriven({
      fnName: "saveCurrentSongToMD",
      type: "song",
      mode: "send",
      impl: ({ orig, args, targetIndex, thisArg }) => {
        return withTemporarySlider("song", targetIndex, () => orig.apply(thisArg, args));
      }
    });
  }

  function reportMissingHooks() {
    const required = [
      "globalSlotsContainer",
      "kitSlotsContainer",
      "songSlotsContainer",
      "topPatternBanks",
      "systemMidiLauncher",
      "systemMidiModal"
    ];
    const missing = required.filter((id) => !document.getElementById(id));
    if (missing.length) {
      console.warn("[Shim] Missing DOM hooks:", missing);
    }
  }

  // ---------------------------------------------------------------------------
  // Runtime UI binding self-test
  // ---------------------------------------------------------------------------
  function uiBindingSelfTest() {
    const warnMissing = (panelName, missing, extra = "") => {
      if (!missing.length) return;
      const suffix = extra ? ` ${extra}` : "";
      console.warn(
        `[UI Binding Self-Test] ${panelName} panel is missing required DOM IDs: ${missing.join(", ")}. ` +
        `${panelName} editor will not render correctly until these IDs exist.${suffix}`
      );
    };

    // ---- Pattern ----
    const patRequired = [
      "bitfieldsUI",
      "accentSlider",
      "accentLabel",
      "patSwingSlider",
      "patSwingLabel"
    ];
    const patMissing = patRequired.filter((id) => !document.getElementById(id));
    warnMissing("Pattern", patMissing);

    // Optional (info only)
    const patOptional = ["patExtended", "patternHeaderDisplay", "locksScroller"];
    const patOptMissing = patOptional.filter((id) => !document.getElementById(id));
    if (!patMissing.length && patOptMissing.length) {
      console.warn(
        `[UI Binding Self-Test] Pattern panel optional legacy hooks not found: ${patOptMissing.join(", ")}. ` +
        `Some optional Pattern UI features may be unavailable.`
      );
    }

    // ---- Song ----
    const songMissing = [];
    const songTable = document.getElementById("songTable");
    if (!songTable) songMissing.push("songTable");
    else if (songTable.tagName !== "TABLE") songMissing.push("songTable (must be a <table>)");

    const songRowsBody = document.getElementById("songRowsBody");
    if (!songRowsBody) songMissing.push("songRowsBody");
    else if (songRowsBody.tagName !== "TBODY") songMissing.push("songRowsBody (must be a <tbody>)");

    warnMissing("Song", songMissing);

    // ---- Global ----
    const globRequired = [
      "globalNumberDisplay",
      "globalMidiBaseSelect",
      "globalMechSettingsSelect",
      "globalExtendedMode",
      "globalLocalOn",
      "globalProgramChangeSelect",
      "globalPcChannelSelect",
    ];
    const globMissing = globRequired.filter((id) => !document.getElementById(id));
    warnMissing("Global", globMissing);
  }


  function init() {
    reportMissingHooks();
    if (isDebugMode()) uiBindingSelfTest();

    if (window.UIBus) {
      window.UIBus.on("slot:select", handleSlotSelect);

      window.UIBus.on("slot:store", (m) => {
        try { window.updatePanelHeaderColors?.(); } catch (e) {}
        if (m?.type === "kit" || m?.type === "pattern") {
          try { window.refreshSkewclidTrackSelectors?.(); } catch (e) {}
        }
      });
      window.UIBus.on("slot:swap", (m) => {
        try { window.updatePanelHeaderColors?.(); } catch (e) {}
        if (typeof window.colorizeSlots === "function") {
          try { window.colorizeSlots(); } catch (e) {}
        }
      });
    }

    installDirtyTracking();
    installSendReceiveHooks();
  }

  window.MDDTIntegrationShim = {
    init,
    loadGlobal,
    loadKit,
    loadPattern,
    loadSong
  };

  document.addEventListener("DOMContentLoaded", () => {
    try { init(); } catch (e) { console.error("[Shim] init failed", e); }
  });
})();
