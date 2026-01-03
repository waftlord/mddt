(() => {
  "use strict";

  function buildUiSlotId({ type, index }) {
    return `${String(type)}:${Number(index)}`;
  }

  function parseUiSlotId(id) {
    if (typeof id !== "string") return null;
    const parts = id.split(":");
    if (parts.length !== 2) return null;
    const type = parts[0];
    const index = parseInt(parts[1], 10);
    if (!Number.isFinite(index)) return null;
    return { type, index };
  }

  function selectorFor(type, index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return null;
    switch (type) {
      case "global":
        return `.global-slot[data-idx="${i}"]`;
      case "kit":
        return `.kit-slot[data-idx="${i}"]`;
      case "pattern":
        // Patterns are rendered under #topPatternBanks
        return `#topPatternBanks .pattern-slot[data-idx="${i}"]`;
      case "song":
        return `.song-slot[data-idx="${i}"]`;
      case "uw":
        return `.uw-slot-item[data-slot-index="${i}"]`;
      default:
        return null;
    }
  }

  function getSlotEl({ type, index }) {
    const sel = selectorFor(type, index);
    if (!sel) return null;
    return document.querySelector(sel);
  }

  function labelFor(type, index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return String(index);
    if (type === "pattern") {
      return (typeof window.patternIndexToLabel === "function")
        ? window.patternIndexToLabel(i)
        : `#${i}`;
    }
    // Globals / Kits / Songs are shown 1-based in the UI.
    if (type === "global" || type === "kit" || type === "song") {
      return String(i + 1);
    }
    return String(i);
  }

  window.MDDTSlotMap = {
    buildUiSlotId,
    parseUiSlotId,
    getSlotEl,
    selectorFor,
    labelFor,
  };
})();
