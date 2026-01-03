// helpers.js

(function () {
  function getValidMachineEntries(mdModel) {
    const result = {};
    for (let i = 0; i <= 123; i++) {
      if (window.FULL_MACHINE_NAMES[i]) {
        result[i] = window.FULL_MACHINE_NAMES[i];
      }
    }
    const { romSlotCount, ramRecordPlayCount } = window.MD_MODEL_CONSTS[mdModel];
    for (let i = 0; i < Math.min(romSlotCount, 32); i++) {
      const romId = 128 + i;
      if (window.FULL_MACHINE_NAMES[romId]) {
        result[romId] = window.FULL_MACHINE_NAMES[romId];
      }
    }
    if (romSlotCount > 32) {
      for (let i = 32; i < romSlotCount; i++) {
        const romId = 176 + (i - 32);
        if (window.FULL_MACHINE_NAMES[romId]) {
          result[romId] = window.FULL_MACHINE_NAMES[romId];
        }
      }
    }
    [160,161,162,163,165,166,167,168]
      .slice(0, ramRecordPlayCount * 2)
      .forEach((id) => {
        if (window.FULL_MACHINE_NAMES[id]) {
          result[id] = window.FULL_MACHINE_NAMES[id];
        }
      });
    return result;
  }

  function getMachineNameByID(id, osVersion) {
    let name = window.FULL_MACHINE_NAMES[id] || `(unknown #${id})`;
    if (id === 1 && osVersion === "1.63") {
      name = "GND-SN";
    }
    return name;
  }

  window.getMachineName = (machineID) =>
    getMachineNameByID(machineID, window.mdOSVersion || "X");

  window.getValidMachineEntries = getValidMachineEntries;
  window._originalGetMachineName = window.getMachineName.bind(window);
})();

// GENERAL HELPERS
(function () {
  window.patternIndexToLabel = function (index) {
    const bankLabels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const bank = Math.floor(index / 16);
    const number = (index % 16) + 1;
    return bankLabels[bank] + String(number).padStart(2, "0");
  };

  window.patternLabelToIndex = function (label) {
    const bankLabels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    label = label.trim().toUpperCase();
    if (label.length < 2) return 0;
    const bank = bankLabels.indexOf(label.charAt(0));
    const number = parseInt(label.slice(1), 10);
    if (bank < 0 || isNaN(number) || number < 1 || number > 16) return 0;
    return bank * 16 + (number - 1);
  };

  window.createOption = function (value, text) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    return opt;
  };

  // Simple hex dump for debugging
  window.hexDump = function (arr, bytesPerLine = 16) {
    const lines = [];
    for (let offset = 0; offset < arr.length; offset += bytesPerLine) {
      const slice = arr.slice(offset, offset + bytesPerLine);
      const hexBytes = slice.map((b) => b.toString(16).padStart(2, "0")).join(" ");
      lines.push(offset.toString(16).padStart(4, "0") + " : " + hexBytes);
    }
    return lines.join("\n");
  };

  window.refreshScaleDropdownForMDModel = function() {
    console.log("refreshScaleDropdownForMDModel called (stub).");
  };

  window.kitColorForIndex = function (i) {
    if (i < 32) {
      const hue = (i * (360 / 32)) % 360;
      return `hsl(${Math.round(hue)}, 100%, 70%)`;
    } else {
      const hue = (((i - 32) * (360 / 32)) + 180) % 360;
      return `hsl(${Math.round(hue)}, 100%, 50%)`;
    }
  };

  window.getKitColor = function (kitNumber) {
    if (
      window.kitLibrary &&
      window.kitLibrary[kitNumber] &&
      typeof window.kitLibrary[kitNumber].colorIndex === "number"
    ) {
      return window.kitColorForIndex(window.kitLibrary[kitNumber].colorIndex);
    }
    return window.kitColorForIndex(kitNumber);
  };

function getParamLabel(machineID, paramIndex, category = "machineParams") {
  if (category === "machineParams") {
    const labels = window.MACHINE_PARAM_LABELS[machineID] || [];
    if (window.mdOSVersion === "1.63" && machineID === 1) {
      if (paramIndex < 4) {
        return labels[paramIndex] || `Param${paramIndex + 1}`;
      }
      return `Param${paramIndex + 1}`;
    }

    if (paramIndex < labels.length && labels[paramIndex]) {
      return labels[paramIndex];
    }
    return `Param${paramIndex + 1}`;
  }

  if (category === "trackFx") {
    if (machineID === 113) {
      const ctr8pLabels = ["C8P1","C8P2","C8P3","C8P4","C8P5","C8P6","C8P7","C8P8"];
      return ctr8pLabels[paramIndex] || `FX${paramIndex + 1}`;
    }
    return window.DEFAULT_TRACK_FX_LABELS[paramIndex] || `FX${paramIndex + 1}`;
  }

  if (category === "routing") {
    return window.DEFAULT_ROUTING_LABELS[paramIndex] || `Route${paramIndex + 1}`;
  }

  return "N/A";
}

  window.getParamLabel = getParamLabel;

  window.globalRandomDepth = 1.0;
})();