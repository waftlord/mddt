(function () {
  "use strict";

  // Lab panel styling is defined in styles.css


  /********************************
   * Stub for getValidMachineEntries
   ********************************/
  if (typeof window.getValidMachineEntries !== "function") {
    window.getValidMachineEntries = function (mdModel) {
      const valid = { 0: "GND-EMPTY" };
      for (let i = 1; i <= 123; i++) {
        valid[i] = "Machine " + i;
      }
      return valid;
    };
  }

  if (typeof window.getMachineName !== "function") {
    window.getMachineName = function (id) {
      return id === 0 ? "GND-EMPTY" : "Machine " + id;
    };
  } else {
    const originalGetMachineName = window.getMachineName;
    window.getMachineName = function (id) {
      const name = originalGetMachineName(id);
      return (id === 0 && (!name || name.trim() === "")) ? "GND-EMPTY" : name;
    };
  }

  /********************************
   * Helper formatting functions for lab sliders
   ********************************/
  function oneBased(value) {
    return parseInt(value, 10) + 1;
  }
  function formatTempoMult(value) {
    const mapping = { 0: "1X", 1: "2X", 2: "3/4X", 3: "3/2X" };
    return mapping[parseInt(value, 10)] || value;
  }
  function formatScale(value) {
    const md = window.mdModel || "MKII";
    if (md === "MKI") {
      const mapping = { 0: "16", 1: "32" };
      return mapping[parseInt(value, 10)] || value;
    } else {
      const mapping = { 0: "16", 1: "32", 2: "48", 3: "64" };
      return mapping[parseInt(value, 10)] || value;
    }
  }
  function formatLfoShape1(value) {
    const waveList1 = ["╱╲", "|╲|╲", "|‾‾|_|", "|╲_", "|◟", "%?", "_/‾", "_)‾", "∿️", "_|‾‾", "╱╲_"];
    return waveList1[parseInt(value, 10)] || value;
  }
  function formatLfoShape2(value) {
    const waveList2 = ["╲╱", "|╱|╱", "|_|‾‾|", "|/‾", "|◜", "%¿", "‾╲_", "‾(_", "∿️", "‾|__", "╲╱‾"];
    return waveList2[parseInt(value, 10)] || value;
  }

  /********************************
   * Utility: Generate a random color from a string
   ********************************/
  function getRandomColorFromString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = "#";
    for (let i = 0; i < 3; i++) {
      const value = (hash >> (i * 8)) & 0xff;
      color += ("00" + value.toString(16)).slice(-2);
    }
    return color;
  }

  /********************************
   * Utility: pickRandomMachineID
   ********************************/

function pickRandomMachineID(mdModel, userIDs, userRange) {
  let validIDs = [];
  if (typeof window.getValidMachinePool === "function") {
    const pool = window.getValidMachinePool();
    if (pool && pool.length > 0) validIDs = pool.slice();
  }
  if (!validIDs.length) {
    const validEntries = window.getValidMachineEntries(mdModel);
    validIDs = Object.keys(validEntries).map(k => parseInt(k, 10));
  }
  if (userIDs && userIDs.length) {
    validIDs = validIDs.filter(id => userIDs.includes(id));
  }
  if (userRange && userRange.min != null && userRange.max != null) {
    validIDs = validIDs.filter(id => id >= userRange.min && id <= userRange.max);
  }

  // ← your 1.63 filter goes here, in the lab file too
  if (window.mdOSVersion === "1.63" &&
      Array.isArray(window.X_OS_ONLY_MACHINES)) {
    validIDs = validIDs.filter(id => !window.X_OS_ONLY_MACHINES.includes(id));
  }

  if (validIDs.length > 0) {
    return validIDs[Math.floor(Math.random() * validIDs.length)];
  }

  // fallback: pick anything, but still avoid X-only if applicable
  const rmin = userRange?.min ?? 0;
  const rmax = userRange?.max ?? 127;
  let candidate;
  do {
    candidate = Math.floor(Math.random() * (rmax - rmin + 1)) + rmin;
  } while (
    window.mdOSVersion === "1.63" &&
    Array.isArray(window.X_OS_ONLY_MACHINES) &&
    window.X_OS_ONLY_MACHINES.includes(candidate)
  );
  return candidate;
}

  /********************************
   * Helper: Generate Fixed Bitfield
   ********************************/
  function generateFixedBitfield(length, count) {
    const arr = new Uint8Array(8);
    const effectiveBytes = Math.ceil(length / 8);
    const steps = Array.from({ length }, (_, i) => i);
    shuffle(steps);
    steps.slice(0, count).forEach(s => {
      const bIndex = Math.floor(s / 8);
      const bPos = s % 8;
      if (bIndex < effectiveBytes) {
        arr[bIndex] |= (1 << bPos);
      }
    });
    return arr;
  }


  // New helpers: build/inspect bitfields from explicit step lists
  function bitfieldFromSteps(length, steps) {
    const arr = new Uint8Array(8);
    const effectiveBytes = Math.ceil(length / 8);
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k];
      if (s < 0 || s >= length) continue;
      const bIndex = Math.floor(s / 8);
      const bPos = s % 8;
      if (bIndex < effectiveBytes) {
        arr[bIndex] |= (1 << bPos);
      }
    }
    return arr;
  }
  function stepsFromBitfield(bitArr, length) {
    const out = [];
    const effectiveBytes = Math.ceil(length / 8);
    for (let b = 0; b < effectiveBytes; b++) {
      const byte = (bitArr && bitArr[b]) ? (bitArr[b] & 0xFF) : 0;
      for (let bit = 0; bit < 8; bit++) {
        const step = b * 8 + bit;
        if (step >= length) break;
        if (byte & (1 << bit)) out.push(step);
      }
    }
    return out;
  }
/********************************
   * Helper: Sanitize Pattern
   ********************************/
  function sanitizePattern(pattern) {
    const clone = JSON.parse(JSON.stringify(pattern));
    delete clone.rawPattern;
    delete clone.labMeta;
    delete clone.sysexVersion;
    delete clone.sysexRevision;
    delete clone.origPos;
    delete clone.lockCount;
  delete clone.lockMasks;
  delete clone.lockMasks2;
  delete clone.paramMatrixMain;
  delete clone.paramMatrixExtra;
  delete clone.isClean;
    return clone;
  }

  window.sanitizePattern = sanitizePattern;

  /********************************
   * Display Formatting Helpers
   ********************************/
  function patternSlotLabel(index) {
    const bank = Math.floor(index / 16);
    const letter = String.fromCharCode(65 + bank); // A=0 => 'A'
    const number = (index % 16) + 1;
    return letter + (number < 10 ? "0" + number : number);
  }

  /********************************
   * Parse a pattern label
   ********************************/
  function parsePatternLabel(str) {
    const match = str.trim().match(/^([A-H])(\d{1,2})$/i);
    if (!match) return NaN;
    const letter = match[1].toUpperCase();
    const num = parseInt(match[2], 10);
    if (num < 1 || num > 16) return NaN;
    const bank = letter.charCodeAt(0) - 65;
    return bank * 16 + (num - 1);
  }

  /********************************
   * Parse a user’s list for patterns, BPM, or integers
   ********************************/
  function parseRangeList(inputStr, isPatternLabel) {
    if (!inputStr || !inputStr.trim()) return [];
    const results = [];
    const tokens = inputStr.split(",");
    tokens.forEach(token => {
      let trimmed = token.trim();
      if (trimmed === "-") {
        results.push("NO_BPM");
        return;
      }
      if (trimmed.includes("-")) {
        const [startStr, endStr] = trimmed.split("-").map(s => s.trim());
        if (!startStr || !endStr) return;
        let startVal, endVal;
        if (isPatternLabel) {
          startVal = parsePatternLabel(startStr);
          endVal   = parsePatternLabel(endStr);
        } else {
          startVal = parseInt(startStr, 10);
          endVal   = parseInt(endStr, 10);
        }
        if (isNaN(startVal) || isNaN(endVal)) return;
        let low = Math.min(startVal, endVal);
        let high = Math.max(startVal, endVal);
        for (let v = low; v <= high; v++) {
          results.push(v);
        }
      } else {
        if (isPatternLabel) {
          const v = parsePatternLabel(trimmed);
          if (!isNaN(v)) results.push(v);
        } else {
          const v = parseInt(trimmed, 10);
          if (!isNaN(v)) results.push(v);
        }
      }
    });
    return results;
  }

  const LS_PREFIX = 'labSlider:';

function loadSliderValue(id) {
  const key = LS_PREFIX + id;
  const sg = (typeof window.safeStorageGet === "function")
    ? window.safeStorageGet
    : (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const raw = sg(key);
  return raw ? raw.split(',').map(v => parseFloat(v)) : null;
}

function saveSliderValue(id, values) {
  const key = LS_PREFIX + id;
  const ss = (typeof window.safeStorageSet === "function")
    ? window.safeStorageSet
    : (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  ss(key, values.join(','));
}

  /********************************
   * SLIDER HELPER FUNCTIONS
   ********************************/
function createRangeSliderRow(labelText, id, startVal, endVal, min, max, step, formatFn) {
  const row = document.createElement("div");
  row.style.marginBottom = "12px";

  const label = document.createElement("label");
  // Center the range label above the noUiSlider.
  label.style.display = "block";
  label.style.textAlign = "center";
  row.appendChild(label);

  const sliderContainer = document.createElement("div");
  sliderContainer.id = id + "_slider";
  // Center the slider itself (max-width sliders otherwise look left-biased).
  sliderContainer.style.margin = "8px auto";
  sliderContainer.className = "lab-slider";
  row.appendChild(sliderContainer);

  const hiddenInput = document.createElement("input");
  hiddenInput.type = "hidden";
  hiddenInput.id = id;
  row.appendChild(hiddenInput);

  // 1) load stored or fallback to defaults
  const stored = loadSliderValue(id);
  const initial = stored || [startVal, endVal];
  hiddenInput.value = initial.join(',');
  hiddenInput.dataset.defaultValue = startVal + ',' + endVal;

  // update label to reflect initial state
  const disp0 = formatFn ? formatFn(initial[0]) : initial[0];
  const disp1 = formatFn ? formatFn(initial[1]) : initial[1];
  label.textContent = labelText + " " + disp0 + " - " + disp1;

  // 2) create the noUiSlider
  noUiSlider.create(sliderContainer, {
    start: initial,
    connect: true,
    step: step,
    range: { min: min, max: max }
  });

  // 3) when the user finishes dragging, save and update UI
 // redraw label & hidden input on every update (including programmatic .set calls)
sliderContainer.noUiSlider.on('update', function (values) {
  // NOTE: most lab sliders are integer ranges, but some (e.g. tonal chance)
  // use fractional steps. Preserve fractional precision when step < 1.
  const useFloat = (typeof step === 'number') && step > 0 && step < 1;
  const decimals = useFloat ? ((String(step).split('.')[1] || '').length) : 0;
  const factor = useFloat && decimals ? Math.pow(10, decimals) : 1;
  const nums = values.map(v => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return useFloat ? 0 : 0;
    if (!useFloat) return Math.round(n);
    return (Math.round(n * factor) / factor);
  });
  hiddenInput.value = nums.map(n => useFloat ? n.toFixed(decimals) : String(n)).join(',');
  const d0 = formatFn ? formatFn(nums[0]) : nums[0];
  const d1 = formatFn ? formatFn(nums[1]) : nums[1];
  label.textContent = labelText + ' ' + d0 + ' - ' + d1;
});

// save to localStorage once the handle is released or after .set()
sliderContainer.noUiSlider.on('set', function (values) {
  const useFloat = (typeof step === 'number') && step > 0 && step < 1;
  const decimals = useFloat ? ((String(step).split('.')[1] || '').length) : 0;
  const factor = useFloat && decimals ? Math.pow(10, decimals) : 1;
  const nums = values.map(v => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return useFloat ? 0 : 0;
    if (!useFloat) return Math.round(n);
    return (Math.round(n * factor) / factor);
  });
  saveSliderValue(id, nums);
});

  return row;
}

  function createInputRow(labelText, type, id, defaultValue, attributes) {
    const row = document.createElement("div");
    row.style.marginBottom = "8px";

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = labelText + " ";
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = type;
    input.id = id;
    input.value = defaultValue;
    input.dataset.defaultValue = defaultValue;
    if (attributes) {
      Object.keys(attributes).forEach(attr => {
        input.setAttribute(attr, attributes[attr]);
      });
    }
    row.appendChild(input);
    return row;
  }
  window.createInputRow = createInputRow;

  /********************************
   * Panel Reset/Randomize Helpers
   ********************************/
  window.skipLabSliderReset = true;

  function resetPanel(panel) {
    if (panel.dataset.panelId === "lab" && window.skipLabSliderReset) {
      return;
    }
    const inputs = panel.querySelectorAll("input[data-default-value]");
    inputs.forEach(input => {
      input.value = input.dataset.defaultValue;
      const sliderId = input.id + "_slider";
      const sliderContainer = panel.querySelector("#" + sliderId);
      if (sliderContainer && sliderContainer.noUiSlider) {
        if (input.value.indexOf(",") !== -1) {
          const parts = input.value.split(",").map(v => parseFloat(v));
          sliderContainer.noUiSlider.set(parts);
        } else {
          sliderContainer.noUiSlider.set(parseFloat(input.value));
        }
      }
    });
  }

  function randomizePanel(panel) {
    const sliders = panel.querySelectorAll("div[id$='_slider']");
    sliders.forEach(sliderContainer => {
      const slider = sliderContainer.noUiSlider;
      if (slider) {
        const options = slider.options;
        const min = options.range.min;
        const max = options.range.max;
        const step = options.step;
        const inputId = sliderContainer.id.replace("_slider", "");
        const hiddenInput = panel.querySelector("#" + inputId);
        if (hiddenInput.value.indexOf(",") !== -1) {
          let val1 = Math.random() * (max - min) + min;
          let val2 = Math.random() * (max - min) + min;
          if (val1 > val2) [val1, val2] = [val2, val1];
          val1 = Math.round(val1 / step) * step;
          val2 = Math.round(val2 / step) * step;
          slider.set([val1, val2]);
        } else {
          let val = Math.random() * (max - min) + min;
          val = Math.round(val / step) * step;
          slider.set(val);
        }
      }
    });
  }

  function getAdvancedRangeForParameter(group, index) {
    const input = document.getElementById("adv_" + group + "_" + index);
    if (input) {
      const parts = input.value.split(",");
      const min = parseInt(parts[0], 10);
      const max = parseInt(parts[1], 10);

      // Default "full range" depends on the parameter we're controlling.
      // (Master FX param #12 / index 11 is treated as 0–63 in the generator.)
      let defaultMax = 127;
      if (group === "masterFx" && index === 11) defaultMax = 63;

      if (!(min === 0 && max === defaultMax)) {
        return { min, max };
      }
    }
    return null;
  }

  /********************************
   * Build the Lab UI Controls
   ********************************/
  /********************************
   * Lab module wrappers (accordion rows)
   ********************************/
  function _labMiniButton(label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lab-mini-btn";
    btn.textContent = label;
    if (title) btn.title = title;
    btn.addEventListener("click", (e) => {
      // Buttons inside <summary> would otherwise toggle the accordion.
      e.preventDefault();
      e.stopPropagation();
      try { onClick && onClick(); } catch (err) { console.warn("[Lab] Action failed:", err); }
    });
    return btn;
  }

  function createLabModuleWrapper(opts) {
    // Modules used to be rendered as collapsible <details>. We keep the
    // structure for styling, but lock them open and hide the disclosure arrow.
    function ensureNoCollapseStyles() {
      if (document.getElementById("mddt-lab-nocollapse-style")) return;
      const st = document.createElement("style");
      st.id = "mddt-lab-nocollapse-style";
      st.textContent = `
        details.lab-module.lab-module-no-collapse > summary::before {
          display: none !important;
          content: '' !important;
        }
        details.lab-module.lab-module-no-collapse > summary {
          padding-left: 14px;
          cursor: default;
        }
      `;
      document.head.appendChild(st);
    }

    const details = document.createElement("details");
    details.className = "lab-module";
    if (opts && opts.id) details.id = opts.id;
    // Always expanded: users never need to collapse these.
    details.open = true;
    details.classList.add("lab-module-no-collapse");
    ensureNoCollapseStyles();

    const summary = document.createElement("summary");

    const left = document.createElement("span");
    left.className = "lab-module-summary-title";

    const title = document.createElement("span");
    title.className = "lab-module-title";
    title.textContent = (opts && opts.title) ? String(opts.title) : "Module";
    left.appendChild(title);

    if (opts && opts.subtitle) {
      const sub = document.createElement("span");
      sub.className = "lab-module-subtitle";
      sub.textContent = String(opts.subtitle);
      left.appendChild(sub);
    }

    summary.appendChild(left);

    const actions = document.createElement("span");
    actions.className = "lab-module-actions";

    if (opts && opts.actions) {
  // Optional custom buttons (for non-standard module headers).
  // Usage: actions: { buttons: [{ label, title, onClick }] }
  if (Array.isArray(opts.actions.buttons)) {
    opts.actions.buttons.forEach((b) => {
      if (!b) return;
      const label =
        (b.label != null) ? String(b.label)
        : (b.text != null) ? String(b.text)
        : "Action";
      const title = (b.title != null) ? String(b.title) : "";
      const onClick =
        (typeof b.onClick === "function") ? b.onClick
        : (typeof b.onclick === "function") ? b.onclick
        : (typeof b.action === "function") ? b.action
        : null;
      if (typeof onClick !== "function") return;
      actions.appendChild(_labMiniButton(label, title, onClick));
    });
  }

  if (typeof opts.actions.reset === "function") {
    actions.appendChild(_labMiniButton("Reset", "Reset module controls", opts.actions.reset));
  }
  if (typeof opts.actions.randomize === "function") {
    actions.appendChild(_labMiniButton("Random", "Randomize module controls", opts.actions.randomize));
  }
}

    summary.appendChild(actions);

    details.appendChild(summary);

    // Prevent collapsing via click or keyboard, and force-open if toggled.
    summary.addEventListener("click", (ev) => {
      // Mini action buttons stopPropagation, so this won't block them.
      ev.preventDefault();
    });
    summary.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
      }
    });
    details.addEventListener("toggle", () => {
      if (!details.open) details.open = true;
    });

    const body = document.createElement("div");
    body.className = "lab-module-body";
    if (opts && opts.contentEl) body.appendChild(opts.contentEl);
    details.appendChild(body);

    return details;
  }


/********************************
 * Sub-panels (for multi-column modules)
 ********************************/
function createLabSubpanel(opts) {
  const section = document.createElement("section");
  section.className = "lab-subpanel";
  if (opts && opts.id) section.id = opts.id;

  const header = document.createElement("div");
  header.className = "lab-subpanel-header";

  const titles = document.createElement("div");
  titles.className = "lab-subpanel-titles";

  const h = document.createElement("h3");
  h.className = "lab-subpanel-title";
  h.textContent = (opts && opts.title) ? String(opts.title) : "Section";
  titles.appendChild(h);

  if (opts && opts.subtitle) {
    const sub = document.createElement("div");
    sub.className = "lab-subpanel-subtitle";
    sub.textContent = String(opts.subtitle);
    titles.appendChild(sub);
  }

  header.appendChild(titles);

  const actions = document.createElement("div");
  actions.className = "lab-subpanel-actions";
  if (opts && opts.actions) {
    if (typeof opts.actions.reset === "function") {
      actions.appendChild(_labMiniButton("Reset", "Reset section controls", opts.actions.reset));
    }
    if (typeof opts.actions.randomize === "function") {
      actions.appendChild(_labMiniButton("Random", "Randomize section controls", opts.actions.randomize));
    }
  }
  header.appendChild(actions);

  const body = document.createElement("div");
  body.className = "lab-subpanel-body";
  if (opts && opts.contentEl) body.appendChild(opts.contentEl);

  section.appendChild(header);
  section.appendChild(body);

  return section;
}


/********************************
 * Import Module Panel (load external lab modules from a local .js file)
 ********************************/
function createLabImportModulePanel() {
  // Build the existing Import UI as "content", then wrap it in the standard
  // Lab module header (same style as the other modules).
  const content = document.createElement("section");
  content.className = "lab-module-inner";

  const blurb = document.createElement("div");
  blurb.className = "lab-help-text";
  blurb.innerHTML = `
    <div><strong></strong></div>
    <div class="lab-muted">Load a local .js file (or paste code) to add a new Lab tab.</div>
  `;
  content.appendChild(blurb);

  const row = document.createElement("div");
  row.className = "lab-import-row";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".js,.mjs,application/javascript,text/javascript";
  fileInput.className = "lab-file-input";
  row.appendChild(fileInput);

  const modeLabel = document.createElement("label");
  modeLabel.className = "lab-checkbox";
  const modeCb = document.createElement("input");
  modeCb.type = "checkbox";
  modeCb.checked = true;
  modeLabel.appendChild(modeCb);
  modeLabel.appendChild(document.createTextNode("ES module"));
  row.appendChild(modeLabel);

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "lab-mini-btn";
  loadBtn.textContent = "Load";
  row.appendChild(loadBtn);

  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "lab-mini-btn";
  reloadBtn.textContent = "Reload";
  reloadBtn.title = "Unloading modules is not supported; reload to reset.";
  reloadBtn.addEventListener("click", () => window.location.reload());
  row.appendChild(reloadBtn);

  content.appendChild(row);

  // Paste-in module (optional convenience)
  const pasteWrap = document.createElement("div");
  pasteWrap.className = "lab-import-paste";

  const pasteLabel = document.createElement("div");
  pasteLabel.className = "lab-muted";
  pasteLabel.textContent = "Paste module code:";
  pasteWrap.appendChild(pasteLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "lab-code-input";
  textarea.rows = 10;
  textarea.placeholder =
    "(() => {\n" +
    "  \"use strict\";\n" +
    "\n" +
    "  MDDT.registerLabModule({\n" +
    "    id: \"example-module\",\n" +
    "    title: \"Example Module\",\n" +
    "    mount: (el, host) => {\n" +
    "      el.innerHTML = \"\";\n" +
    "      const ui = host.ui.controls;\n" +
    "\n" +
    "      // Standard Lab subpanel (matches built-in modules)\n" +
    "      const panel = ui.subpanel({ title: \"Targets\", subtitle: \"Select destination slots\" });\n" +
    "      panel.actions.appendChild(ui.miniButton(\"Reset\", \"Reset controls\", () => ui.resetPanel(panel.section)));\n" +
    "      panel.actions.appendChild(ui.miniButton(\"Random\", \"Randomize controls\", () => ui.randomizePanel(panel.section)));\n" +
    "\n" +
    "      // Scoped noUiSlider ranges (avoid relying on other tabs)\n" +
    "      panel.body.appendChild(ui.slotRangeRow(\"kit\", { label: \"Kit slots:\" }).row);\n" +
    "      panel.body.appendChild(ui.trackRangeRow(\"kit\", { label: \"Tracks:\" }).row);\n" +
    "      el.appendChild(panel.section);\n" +
    "\n" +
    "      const run = ui.miniButton(\"Run\", \"Generate and write to slots\", () => {\n" +
    "        const slots  = host.ui.getSlotRange(\"kit\", { scope: el });\n" +
    "        const tracks = host.ui.getTrackRange(\"kit\", { scope: el });\n" +
    "        const bdIds  = host.machines.findIds(\"BD\");\n" +
    "        host.log({ slots, tracks, bdIds });\n" +
    "        // host.writeKitSlot(slot, kitObj, { silent:true })\n" +
    "      });\n" +
    "      el.appendChild(run);\n" +
    "    }\n" +
    "  });\n" +
    "})();";
  pasteWrap.appendChild(textarea);

  const pasteRow = document.createElement("div");
  pasteRow.className = "lab-import-row";

  const pasteBtn = document.createElement("button");
  pasteBtn.type = "button";
  pasteBtn.className = "lab-mini-btn";
  pasteBtn.textContent = "Load pasted code";
  pasteRow.appendChild(pasteBtn);

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "lab-mini-btn";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => { textarea.value = ""; });
  pasteRow.appendChild(clearBtn);

  pasteWrap.appendChild(pasteRow);
  content.appendChild(pasteWrap);

  const status = document.createElement("div");
  status.className = "lab-import-status";
  status.setAttribute("role", "status");
  status.textContent = "No module loaded yet.";
  content.appendChild(status);

  const listHeader = document.createElement("div");
  listHeader.className = "lab-import-list-header";
  listHeader.textContent = "Imported modules:";
  content.appendChild(listHeader);

  const list = document.createElement("div");
  list.className = "lab-import-list";
  content.appendChild(list);

  function renderList() {
    list.innerHTML = "";
    const all = (window.MDDT && Array.isArray(window.MDDT._labModules)) ? window.MDDT._labModules : [];
    const mods = all.filter((m) => m && (m.__labSource === "imported"));

    if (!mods.length) {
      const empty = document.createElement("div");
      empty.className = "lab-muted";
      empty.textContent = "None yet. Import a .js file (or paste code) to add a new Lab tab.";
      list.appendChild(empty);
      return;
    }

    mods.forEach((m) => {
      const item = document.createElement("div");
      item.className = "lab-import-item";

      const title = document.createElement("div");
      title.className = "lab-import-item-title";
      title.textContent = m.title || m.id || "Module";

      const meta = document.createElement("div");
      meta.className = "lab-import-item-meta";
      const from = m.__labImportedFrom ? ` • from: ${m.__labImportedFrom}` : "";
      meta.textContent = `id: ${m.id || "(missing id)"}${from}`;

      item.appendChild(title);
      item.appendChild(meta);
      list.appendChild(item);
    });
  }

  async function loadFromCode(code, name, asModule) {
    if (!code) return;

    // Mark modules registered during this import so the Import tab can list them.
    const importCtx = { fileName: name || "pasted-module.js", startedAt: Date.now(), until: Date.now() + 3000 };
    try {
      window.MDDT = window.MDDT || {};
      window.MDDT._labImportContext = importCtx;
    } catch (_) {}

    status.classList.remove("lab-error");
    status.textContent = `Loading: ${name || "pasted code"}…`;

    // Improve stack traces in DevTools.
    const safeName = String(name || "lab-module.js").replace(/\s+/g, "_");
    const sourceUrl = `\n//# sourceURL=${safeName}`;
    const blob = new Blob([String(code) + sourceUrl], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);

    try {
      if (asModule) {
        await import(url);
      } else {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = url;
          s.async = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Script load failed"));
          document.head.appendChild(s);
        });
      }

      status.textContent =
        `Loaded: ${name || "pasted code"}. If it registered via MDDT.registerLabModule(), it will appear as a new Lab tab.`;
    } catch (e) {
      console.error("[Lab Import] Failed:", e);
      status.classList.add("lab-error");
      status.textContent = `Import failed: ${e && e.message ? e.message : e}`;
    } finally {
      // Revoke after a short delay (keeps DevTools sourceURL navigable briefly).
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1500);

      // Clear import context after a short grace period (allows modules to register async).
      setTimeout(() => {
        try {
          if (window.MDDT && window.MDDT._labImportContext === importCtx) {
            delete window.MDDT._labImportContext;
          }
        } catch (_) {}
      }, 3100);

      renderList();
    }
  }

  async function loadFromFile(file, asModule) {
    if (!file) return;
    status.classList.remove("lab-error");
    status.textContent = `Loading: ${file.name}…`;

    let code = "";
    try {
      code = await file.text();
    } catch (e) {
      status.classList.add("lab-error");
      status.textContent = `Failed to read file: ${e && e.message ? e.message : e}`;
      return;
    }

    return loadFromCode(code, file.name, asModule);
  }

  loadBtn.addEventListener("click", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      status.classList.add("lab-error");
      status.textContent = "Pick a .js file first.";
      return;
    }
    loadFromFile(file, !!modeCb.checked);
  });

  // Convenience: loading immediately when a file is chosen.
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) loadFromFile(file, !!modeCb.checked);
  });

  pasteBtn.addEventListener("click", () => {
    const code = String(textarea.value || "");
    if (!code.trim()) {
      status.classList.add("lab-error");
      status.textContent = "Paste some module code first.";
      return;
    }
    loadFromCode(code, "pasted-module.js", !!modeCb.checked);
  });

  renderList();

  // Wrap in standard module header, with an "API Guide" action button.
  const openApiGuide = () => {
    try {
      window.open("LAB_MODULE_API.md", "_blank", "noopener,noreferrer");
    } catch (_) {
      try { window.location.href = "LAB_MODULE_API.md"; } catch (_) {}
    }
  };

  if (typeof createLabModuleWrapper === "function") {
    return createLabModuleWrapper({
      id: "labImportModule",
      title: "Import",
      subtitle: "Load external Lab modules",
      contentEl: content,
      actions: {
        buttons: [{
          label: "API Guide",
          title: "Open the Lab Module API guide",
          onClick: openApiGuide
        }]
      }
    });
  }

  return content;
}


// Expose wrapper so optional lab modules (advanced / external) can reuse it.
  window.createLabModuleWrapper = createLabModuleWrapper;

  // =========================================================
  // Tabbed Lab Host (MMDT-style)
  // =========================================================
  const __LAB_ORDER_HINTS = {
      generators: 10,
      "tonal-mask": 20,
      "seed-morph": 21,
      "machine-implanter": 22,
      normalise: 23,
      swingloom: 30,
      bpmlom: 30,
      import: 999
    };

  function _getLabRegistry() {
    return (window.MDDT && Array.isArray(window.MDDT._labModules)) ? window.MDDT._labModules : [];
  }

  function _getSortedLabModules() {
    // De-dupe by id (last registration wins)
    const byId = Object.create(null);
    _getLabRegistry().forEach((m) => {
      if (!m || !m.id || typeof m.mount !== "function") return;
      byId[String(m.id)] = m;
    });
    const mods = Object.values(byId);

    mods.sort((a, b) => {
      const oa = (typeof a.order === "number") ? a.order : (__LAB_ORDER_HINTS[String(a.id)] ?? 100);
      const ob = (typeof b.order === "number") ? b.order : (__LAB_ORDER_HINTS[String(b.id)] ?? 100);
      if (oa !== ob) return oa - ob;
      const ta = String(a.title || a.id || "");
      const tb = String(b.title || b.id || "");
      const cmp = ta.localeCompare(tb);
      if (cmp) return cmp;
      return String(a.id).localeCompare(String(b.id));
    });

    return mods;
  }

  function _ensureLabHostRefs(rootEl) {
    window.MDDT_LabHost = window.MDDT_LabHost || {};
    const host = window.MDDT_LabHost;

    if (host.root !== rootEl) {
      host.root = rootEl;
      host.tabs = rootEl.querySelector("#labTabBar");
      host.pagesRoot = rootEl.querySelector("#labPages");
      host.pages = Object.create(null);
      host.activeId = host.activeId || "generators";
    }

    host.getModules = _getSortedLabModules;

    host.renderTabs = function renderTabs() {
      if (!host.tabs) return;
      host.tabs.innerHTML = "";
      const mods = host.getModules();
      mods.forEach((mod) => {
        const id = String(mod.id);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "lab-tab" + (id === host.activeId ? " is-active" : "");
        btn.textContent = String(mod.title || mod.id || id);
        btn.addEventListener("click", () => host.activate(id));
        host.tabs.appendChild(btn);
      });
    };

    host.activate = function activate(id) {
      if (!host.pagesRoot) return;
      const mods = host.getModules();

      const want = String(id || "");
      const exists = mods.some((m) => String(m.id) === want);
      host.activeId = exists ? want : (mods[0] ? String(mods[0].id) : "");

      // Show/hide pages
      mods.forEach((mod) => {
        const mid = String(mod.id);
        let page = host.pages[mid];
        if (!page) {
          page = document.createElement("div");
          page.className = "lab-page";
          page.dataset.labModule = mid;
          page.style.display = "none";
          host.pages[mid] = page;
          host.pagesRoot.appendChild(page);
        }

        const active = mid === host.activeId;
        page.classList.toggle("is-active", active);
        page.style.display = active ? "" : "none";

        if (active && !page.dataset.mounted) {
          page.innerHTML = "";
          page.classList.add("lab-module-inner");

          try {
            const hostApi = (window.MDDT && window.MDDT.host) ? window.MDDT.host : null;
            mod.mount(page, hostApi);
          } catch (e) {
            console.error("[Lab] Module mount failed:", mid, e);
            const err = document.createElement("div");
            err.className = "lab-error";
            err.textContent = `Module "${mid}" failed to mount: ${e && e.message ? e.message : e}`;
            page.appendChild(err);
          }

          page.dataset.mounted = "1";
        }
      });

      host.renderTabs();
    };

    host.onRegister = function onRegister() {
      // New module registered at runtime (e.g., import). Refresh tabs.
      if (!host.tabs || !host.pagesRoot) return;
      host.renderTabs();
      host.activate(host.activeId);
    };

    return host;
  }

  function _registerBuiltinLabModulesOnce() {
    // Register built-ins via the public API so imported modules can rely on it.
    if (!window.MDDT || typeof window.MDDT.registerLabModule !== "function") return;

    const has = (id) => _getLabRegistry().some((m) => m && String(m.id) === String(id));

    if (!has("generators")) {
      window.MDDT.registerLabModule({
        id: "generators",
        title: "Generators",
        order: 10,
        __labSource: "bundled",
        mount: function (mountEl) {
          mountEl.innerHTML = "";
          mountEl.classList.add("lab-stack");

          const kitPanel = createKitPanel();
          const patternPanel = createPatternPanel();
          const songPanel = createSongPanel();

          const genGrid = document.createElement("div");
          genGrid.className = "lab-grid-3";

          genGrid.appendChild(
            createLabSubpanel({
              id: "labsub-kits",
              title: "Kits",
              subtitle: "Generate kits into slots",
              contentEl: kitPanel,
              actions: {
                reset: () => { try { updateLabSliderRanges(); } catch (_) {} resetPanel(kitPanel); syncLabOverrideSliders(); },
                randomize: () => { try { updateLabSliderRanges(); } catch (_) {} randomizePanel(kitPanel); syncLabOverrideSliders(); }
              }
            })
          );

          genGrid.appendChild(
            createLabSubpanel({
              id: "labsub-patterns",
              title: "Patterns",
              subtitle: "Generate patterns into slots",
              contentEl: patternPanel,
              actions: {
                reset: () => { try { updateLabSliderRanges(); } catch (_) {} resetPanel(patternPanel); syncLabOverrideSliders(); },
                randomize: () => { try { updateLabSliderRanges(); } catch (_) {} randomizePanel(patternPanel); syncLabOverrideSliders(); }
              }
            })
          );

          genGrid.appendChild(
            createLabSubpanel({
              id: "labsub-songs",
              title: "Songs",
              subtitle: "Generate songs into slots",
              contentEl: songPanel,
              actions: {
                reset: () => { try { updateLabSliderRanges(); } catch (_) {} resetPanel(songPanel); syncLabOverrideSliders(); },
                randomize: () => { try { updateLabSliderRanges(); } catch (_) {} randomizePanel(songPanel); syncLabOverrideSliders(); }
              }
            })
          );

          mountEl.appendChild(genGrid);
        }
      });
    }

    if (!has("import")) {
      window.MDDT.registerLabModule({
        id: "import",
        title: "Import",
        order: 999,
        __labSource: "bundled",
        mount: function (mountEl) {
          mountEl.innerHTML = "";
          mountEl.classList.add("lab-stack");
          mountEl.appendChild(createLabImportModulePanel());
        }
      });
    }
  }

  // Register built-ins immediately (safe even before Lab UI is opened).
  try { _registerBuiltinLabModulesOnce(); } catch (_) {}

  window.createLabUI = function () {
    let labContainer = document.getElementById("labContainer");
    if (labContainer) {
      labContainer.innerHTML = "";
    } else {
      labContainer = document.createElement("div");
      labContainer.id = "labContainer";
    }

    labContainer.classList.add("lab-root");
    labContainer.classList.add("lab-host");

    const tabBar = document.createElement("div");
    tabBar.id = "labTabBar";
    tabBar.className = "lab-tabbar";

    const pages = document.createElement("div");
    pages.id = "labPages";
    pages.className = "lab-pages";

    labContainer.appendChild(tabBar);
    labContainer.appendChild(pages);

    const host = _ensureLabHostRefs(labContainer);
    host.renderTabs();
    host.activate(host.activeId);

    return labContainer;
  };



function addHeaderClickListener(header) {
    header.addEventListener("click", function(e) {
      const panel = this.closest("section");
      if (panel.dataset.panelId === "lab") {
        window.skipLabSliderReset = false;
        this.style.userSelect = "none";
      }
      updateLabSliderRanges();
      if (e.shiftKey) {
        randomizePanel(panel);
      } else {
        resetPanel(panel);
      }
    });
  }

  function formatMuteTrig(value) {
    const intVal = parseInt(value, 10);
    return intVal === 16 ? "--" : String(intVal + 1);
  }

  // SONG PANEL
  function createSongPanel() {
    const section = document.createElement("section");
    section.classList.add("lab-module-inner");

    section.appendChild(createRangeSliderRow("Generation Length (rows):", "numRows", 1, 255, 1, 255, 1));

    const patternArrayRow = createInputRow("Patterns:", "text", "patternArray", "");
    const patternArrayInput = patternArrayRow.querySelector("input");
    if (patternArrayInput) {
      patternArrayInput.placeholder = "e.g. A01,B10-B15,H02 etc";
      patternArrayInput.style.textTransform = "uppercase";
      patternArrayInput.addEventListener("input", () => {
        const { selectionStart, selectionEnd, value } = patternArrayInput;
        const upper = value.replace(/[a-h]/g, m => m.toUpperCase());
        if (upper !== value) {
          patternArrayInput.value = upper;
          if (selectionStart != null && selectionEnd != null) {
            patternArrayInput.setSelectionRange(selectionStart, selectionEnd);
          }
        }
        setSliderDisabled("patternAssignmentRange", !!upper.trim());
      });
    }
    section.appendChild(patternArrayRow);
    section.appendChild(createRangeSliderRow("Pattern Assignment Range:", "patternAssignmentRange", 0, 127, 0, 127, 1, patternSlotLabel));
      section.appendChild(createRangeSliderRow("Loop Probability:", "loopProbabilityRange", 0, 100, 0, 100, 1, function(v){ return v + "%"; }));
      section.appendChild(createRangeSliderRow(
        "Loop Destination Offset Range:",
        "loopDestRange",
        1, 255,
        1, 255,
        1
      ));

      section.appendChild(createRangeSliderRow(
        "Loop Count Range:",
        "loopCountRange",
        0, 63,
        0, 63,
        1,
        function(v) { return parseInt(v, 10) === 0 ? "∞" : v; }
      ));
      section.appendChild(createRangeSliderRow(
  "Repeat Probability:",
  "repeatProbabilityRange",
  0,   // slider min
  100, // slider max
  0,   // default min
  100, // default max
  1,   // step
  v => v + "%"   // thumb label formatter
));
    section.appendChild(createRangeSliderRow("Repeats Range:", "repeatsRange", 1, 64, 1, 64, 1));
    let offsetMax = (window.mdModel === "MKI") ? 30 : 62;

// --- NEW: Offset Choices (discrete list/ranges; duplicates = heavy bias) ---
const offsetChoicesRow = createInputRow("Offset Choices:", "text", "offsetChoices", "");
const offsetChoicesInput = offsetChoicesRow.querySelector("input");
if (offsetChoicesInput) {
  offsetChoicesInput.placeholder = "e.g. 0,4,8,12-15,12,12";
  offsetChoicesInput.addEventListener("input", () => {
    setSliderDisabled("offsetRange", !!offsetChoicesInput.value.trim());
  });
}
section.appendChild(offsetChoicesRow);
    section.appendChild(createRangeSliderRow("Offset Range:", "offsetRange", 0, offsetMax, 0, offsetMax, 1));
    let lengthMax = (window.mdModel === "MKI") ? 32 : 64;

// --- NEW: Length Choices (discrete list/ranges; duplicates = heavy bias) ---
const lengthChoicesRow = createInputRow("Length Choices:", "text", "lengthChoices", "");
const lengthChoicesInput = lengthChoicesRow.querySelector("input");
if (lengthChoicesInput) {
  lengthChoicesInput.placeholder = "e.g. 16,16,32-64";
  lengthChoicesInput.addEventListener("input", () => {
    setSliderDisabled("lengthRange", !!lengthChoicesInput.value.trim());
  });
}
section.appendChild(lengthChoicesRow);
    section.appendChild(createRangeSliderRow("Length Range:", "lengthRange", 2, lengthMax, 2, lengthMax, 1));
    const bpmChoicesRow = createInputRow("BPM Choices:", "text", "BPMChoices", "");
const bpmChoicesInput = bpmChoicesRow.querySelector("input");
bpmChoicesInput.placeholder = "e.g. 60,90–120";

// disable the slider whenever the user types anything
bpmChoicesInput.addEventListener("input", () => {
  setSliderDisabled("bpmRange", !!bpmChoicesInput.value.trim());
});

section.appendChild(bpmChoicesRow);

    section.appendChild(createRangeSliderRow(
      "BPM Range:",
      "bpmRange",
      0, 300,
      0, 300,
      1,
      function(v){
        if (parseInt(v,10) === 0) return "–";
        return v;
      }
    ));

    section.appendChild(createRangeSliderRow("Mute Probability:", "mutePercentage", 0, 100, 0, 100, 1, function(v){ return v + "%"; }));

    const generateSongBtn = document.createElement("button");
    generateSongBtn.id = "generateSongBtn";
    generateSongBtn.textContent = "Generate Songs";
    section.appendChild(generateSongBtn);

        section.appendChild(createRangeSliderRow("Row Target Range:", "songRowRange", 1, 255, 1, 255, 1));

    section.appendChild(createRangeSliderRow("Slot Destination:", "songSlotRange", 0, 31, 0, 31, 1, oneBased));



    return section;
  }

  function setSliderDisabled(id, shouldDisable) {
  const el = document.getElementById(id + "_slider");
  if (!el) return;
  if (shouldDisable) el.setAttribute("disabled", "");
  else             el.removeAttribute("disabled");
}

  // KIT PANEL
  function createKitPanel() {
    const section = document.createElement("section");
    section.classList.add("lab-module-inner");

    const machineIDsContainer = createInputRow("Machine IDs:", "text", "machineIDs", "");
    const machineIDsInput = machineIDsContainer.querySelector("input");
    if (machineIDsInput) {
      machineIDsInput.placeholder = "e.g. 1,3-5,14-17,34";
      machineIDsInput.addEventListener("input", () => {
        setSliderDisabled("machineAssignmentRange", !!machineIDsInput.value.trim());
      });
    }
    section.appendChild(machineIDsContainer);
    let maxForModel;
    if (!window.mdUWEnabled) {
      maxForModel = 123;
    } else {
      maxForModel = (window.mdModel === "MKI") ? 163 : 191;
    }
    section.appendChild(createRangeSliderRow("Machine Assignment Range:", "machineAssignmentRange", 0, maxForModel, 0, maxForModel, 1));
    section.appendChild(createRangeSliderRow("Tonal Flag Chance:", "tonalFlagChance", 0, 1, 0, 1, 0.01, function(v) { return (v * 100).toFixed(0) + "%"; }));
    section.appendChild(createRangeSliderRow("Track Level Range:", "trackLevelRange", 0, 127, 0, 127, 1));
    section.appendChild(createRangeSliderRow("Synthesis Range:", "machineParamsRange", 0, 127, 0, 127, 1));
    section.appendChild(createRangeSliderRow("Effects Range:", "trackFxRange", 0, 127, 0, 127, 1));
    section.appendChild(createRangeSliderRow("Routing Range:", "routingRange", 0, 127, 0, 127, 1));
    const advRangesPanel = createAdvancedParameterRangesPanel();
    section.appendChild(advRangesPanel);
    section.appendChild(createRangeSliderRow("Mute Pos Range:", "mutePosRange", 0, 16, 0, 16, 1, formatMuteTrig));
    section.appendChild(createRangeSliderRow("Trig Pos Range:", "trigPosRange", 0, 16, 0, 16, 1, formatMuteTrig));
    section.appendChild(createRangeSliderRow("LFO Dest Range:", "lfoDestRange", 0, 15, 0, 15, 1, oneBased));
    section.appendChild(createRangeSliderRow("LFO Param Range:", "lfoParamRange", 0, 23, 0, 23, 1, oneBased));
const maxWave = window.MD_LFO_WAVE_COUNT - 1;

section.appendChild(
  createRangeSliderRow(
    "LFO Shape1 Range:",
    "lfoShape1Range",
    0,               // minValue
    maxWave,         // maxValue
    0,               // defaultMin
    maxWave,         // defaultMax
    1,               // step
    formatLfoShape1
  )
);

section.appendChild(
  createRangeSliderRow(
    "LFO Shape2 Range:",
    "lfoShape2Range",
    0,
    maxWave,
    0,
    maxWave,
    1,
    formatLfoShape2
  )
);
    function formatLfoMode(v) {
      const num = Math.round(parseFloat(v));
      if (num <= 33) {
        return "Free";
      } else if (num <= 66) {
        return "Trig";
      } else {
        return "Hold";
      }
    }
    section.appendChild(createRangeSliderRow("LFO Mode Range:", "lfoModeRange", 0, 100, 0, 100, 1, formatLfoMode));
    section.appendChild(createRangeSliderRow("Master FX Range:", "masterFxRange", 0, 127, 0, 127, 1));
    section.appendChild(createAdvancedMasterFxRangesPanel());
    const generateKitBtn = document.createElement("button");
    generateKitBtn.id = "generateKitBtn";
    generateKitBtn.textContent = "Generate Kits";
    section.appendChild(generateKitBtn);

    // Target Tracks slider (1–16 displayed; 0–15 internal)
    section.appendChild(
      createRangeSliderRow(
        "Target Tracks:",
        "kitTrackRange",
        0, 15,   // start range
        0, 15,   // min/max
        1,
        oneBased  // display as 1..16
      )
    );
section.appendChild(createRangeSliderRow("Slot Destination:", "kitSlotRange", 0, 63, 0, 63, 1, oneBased));
    return section;
  }

  // PATTERN PANEL
  function createPatternPanel() {
    const section = document.createElement("section");
    section.classList.add("lab-module-inner");

    let patLengthMax = (window.mdModel === "MKI") ? 32 : 64;
    section.appendChild(createRangeSliderRow("Length Range:", "patternLengthRange", 2, patLengthMax, 2, patLengthMax, 1));
    section.appendChild(createRangeSliderRow("Tempo Mult Range:", "tempoMultRange", 0, 3, 0, 3, 1, formatTempoMult));
    section.appendChild(createRangeSliderRow("Scale Range:", "scaleRange", 0, (window.mdModel === "MKI" ? 1 : 3), 0, (window.mdModel === "MKI" ? 1 : 3), 1, formatScale));
    // just above the createRangeSliderRow for "Assigned Kit # Range"
const kitChoicesRow = createInputRow("Kit Choices:", "text", "kitChoices", "");
const kitChoicesInput = kitChoicesRow.querySelector("input");
kitChoicesInput.placeholder = "e.g. 0,1-5,8";
kitChoicesInput.addEventListener("input", () => {
  setSliderDisabled("assignedKitNumberRange", !!kitChoicesInput.value.trim());
});
section.appendChild(kitChoicesRow);
    section.appendChild(createRangeSliderRow("Assigned Kit # Range:", "assignedKitNumberRange", 0, 63, 0, 63, 1, oneBased));
    section.appendChild(createRangeSliderRow("Accent Amount Range:", "accentAmountRange", 0, 15, 0, 15, 1));
    section.appendChild(createRangeSliderRow("Swing Amount Range:", "swingAmountRange", 0, 127, 0, 127, 1, function(v){ return (50 + (v/127)*30).toFixed(0) + "%"; }));
    section.appendChild(createRangeSliderRow("Approx Trig Probability:", "trigProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Prob Accent EditAll:", "accEditAllProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Accent Trig Probability:", "accProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Prob Swing EditAll:", "swEditAllProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Swing Trig Probability:", "swProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Prob Slide EditAll:", "slEditAllProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Slide Trig Probability:", "slProb", 0, 100, 0, 100, 1, v => v + "%"));
    section.appendChild(createRangeSliderRow("Lock Param Range:", "lockParamRange", 1, 24, 1, 24, 1));
    section.appendChild(createRangeSliderRow("Max Locks per Pattern:", "maxLocks", 1, 64, 1, 64, 1));
    const generatePatternBtn = document.createElement("button");
    generatePatternBtn.id = "generatePatternBtn";
    generatePatternBtn.textContent = "Generate Patterns";
    section.appendChild(generatePatternBtn);

    // Target Tracks slider (1–16 displayed; 0–15 internal)
    section.appendChild(
      createRangeSliderRow(
        "Target Tracks:",
        "patternTrackRange",
        0, 15,   // start range
        0, 15,   // min/max
        1,
        oneBased  // display as 1..16
      )
    );
section.appendChild(createRangeSliderRow("Slot Destination:", "patternSlotRange", 0, 127, 0, 127, 1, patternSlotLabel));
    return section;
  }

  function createAdvancedParameterRangesPanel() {
    const container = document.createElement("div");
    container.id = "advancedParamRangesContainer";
    container.style.border = "1px solid #ccc";
    container.style.marginTop = "10px";
    container.style.padding = "10px";

    const header = document.createElement("div");
    header.textContent = "Synthesis/Effects/Routing Params";
    header.style.cursor = "pointer";
    header.style.fontWeight = "bold";
    header.style.marginBottom = "8px";

    header.addEventListener("mouseover", function() {
      this.style.backgroundColor = "rgba(200,200,200,0.3)";
    });
    header.addEventListener("mouseout", function() {
      this.style.backgroundColor = "";
    });

    let isExpanded = false;
    const panel = document.createElement("div");
    panel.id = "advancedParamRangesPanel";
    panel.style.display = "none";

   header.addEventListener("click", function () {
  isExpanded = !isExpanded;
  panel.style.display = isExpanded ? "block" : "none";

  // grey-out the parent sliders when the advanced panel is open
  setSliderDisabled("machineParamsRange", isExpanded);
  setSliderDisabled("trackFxRange",      isExpanded);
  setSliderDisabled("routingRange",      isExpanded);
});

    for (let i = 0; i < 8; i++) {
      panel.appendChild(
        createRangeSliderRow(`Param ${i+1} Range:`, `adv_machineParams_${i}`, 0, 127, 0, 127, 1)
      );
    }
    const DEFAULT_TRACK_FX_LABELS = ["AMD", "AMF", "EQF", "EQG", "FLTF", "FLTW", "FLTQ", "SRR"];
    for (let i = 0; i < 8; i++) {
      panel.appendChild(
        createRangeSliderRow(`${DEFAULT_TRACK_FX_LABELS[i]} Range:`, `adv_trackFx_${i}`, 0, 127, 0, 127, 1)
      );
    }
    const DEFAULT_ROUTING_LABELS = ["DIST", "VOL", "PAN", "DELS", "REVS", "LFOS", "LFOD", "LFOM"];
    for (let i = 0; i < 8; i++) {
      panel.appendChild(
        createRangeSliderRow(`${DEFAULT_ROUTING_LABELS[i]} Range:`, `adv_routing_${i}`, 0, 127, 0, 127, 1)
      );
    }
    container.appendChild(header);
    container.appendChild(panel);
    return container;
  }


function createAdvancedMasterFxRangesPanel() {
  const container = document.createElement("div");
  container.id = "advancedMasterFxRangesContainer";
  container.style.border = "1px solid #ccc";
  container.style.marginTop = "10px";
  container.style.padding = "10px";

  const header = document.createElement("div");
  header.textContent = "Master FX Params";
  header.style.cursor = "pointer";
  header.style.fontWeight = "bold";
  header.style.marginBottom = "8px";

  header.addEventListener("mouseover", function() {
    this.style.backgroundColor = "rgba(200,200,200,0.3)";
  });
  header.addEventListener("mouseout", function() {
    this.style.backgroundColor = "";
  });

  let isExpanded = false;
  const panel = document.createElement("div");
  panel.id = "advancedMasterFxRangesPanel";
  panel.style.display = "none";

  header.addEventListener("click", function () {
    isExpanded = !isExpanded;
    panel.style.display = isExpanded ? "block" : "none";

    // grey-out the parent slider when the advanced panel is open
    setSliderDisabled("masterFxRange", isExpanded);
  });

  // Labels mirror the Kit UI's Master FX grid (32 params: 4 blocks × 8 params)
  const MASTER_FX_LABELS = [
    "DVOL","PRED","DEC","DAMP","HP","LP","GATE","LEV",
    "TIME","MOD","MFRQ","FB","FILTF","FILTW","MONO","LEV",
    "LF","LG","HF","HG","PF","PG","PQ","GAIN",
    "ATCK","REL","TRHD","RTIO","KNEE","HP","OUTG","MIX"
  ];

  const GROUPS = [
    { title: "Reverb",   start: 0 },
    { title: "Delay",    start: 8 },
    { title: "EQ",       start: 16 },
    { title: "Dynamix",  start: 24 }
  ];

  GROUPS.forEach(g => {
    const subHeader = document.createElement("div");
    subHeader.textContent = g.title;
    subHeader.style.fontWeight = "bold";
    subHeader.style.margin = "10px 0 6px";
    panel.appendChild(subHeader);

    for (let i = 0; i < 8; i++) {
      const idx = g.start + i;
      const label = MASTER_FX_LABELS[idx] || ("MFX" + (idx + 1));
      // NOTE: Master FX param #12 (index 11) is treated as 0–63 in the generator.
      const max = (idx === 11) ? 63 : 127;
      panel.appendChild(
        createRangeSliderRow(`${label} Range:`, `adv_masterFx_${idx}`, 0, max, 0, max, 1)
      );
    }
  });

  container.appendChild(header);
  container.appendChild(panel);
  return container;
}

/********************************
   * GLOBAL references / defaults
   ********************************/
  window.globalLibrary = window.globalLibrary || new Array(8).fill(null);
  window.kitLibrary = window.kitLibrary || new Array(64).fill(null);
  window.allPatternSlots = window.allPatternSlots || new Array(128).fill(null);
  window.allSongSlots = window.allSongSlots || new Array(32).fill(null);
  window.currentSong = window.currentSong || null;
  window.kit = window.kit || null;
  window.pattern = window.pattern || null;
  window.selectedSongSlotIndex = window.selectedSongSlotIndex || 0;
  window.selectedKitSlotIndex = window.selectedKitSlotIndex || 0;
  window.selectedPatternSlotIndex = window.selectedPatternSlotIndex || 0;
  window.globalData = window.globalData || {};

  if (typeof window.initUI !== "function") {
    window.initUI = function () {};
  }
  if (typeof window.fillSongUI !== "function") {
    window.fillSongUI = function () {};
  }
  if (typeof window.buildKitSlotsUI !== "function") {
    window.buildKitSlotsUI = function () {};
  }
  if (typeof window.buildPatternSlotsUI !== "function") {
    window.buildPatternSlotsUI = function () {};
  }
  if (typeof window.buildSongSlotsUI !== "function") {
    window.buildSongSlotsUI = function () {};
  }
  if (typeof window.buildTopPatternBanksUI !== "function") {
    window.buildTopPatternBanksUI = function () {};
  }
  if (typeof window.attachBankSlotClickHandlers !== "function") {
    window.attachBankSlotClickHandlers = function () {};
  }
  if (typeof window.colorizeSlots !== "function") {
    window.colorizeSlots = function () {};
  }
  if (typeof window.updatePanelHeaderColors !== "function") {
    window.updatePanelHeaderColors = function () {};
  }

   window.storePatternSlot = function (slot, srcPattern = window.pattern) {
    writePatternSlot(slot, srcPattern, { silent: true });
    window.selectedPatternSlotIndex = slot;
    if (typeof buildPatternSlotsUI === "function") buildPatternSlotsUI();
    if (typeof attachBankSlotClickHandlers === "function") attachBankSlotClickHandlers();
    if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
  };

function stampKitMetaFields(kitData, slot) {
  // mirror createKitDump’s logic for version/revision
  const is163 = parseFloat(window.mdOSVersion) === 1.63;
  kitData.sysexVersion   = is163 ? 4  : 64;
  kitData.sysexRevision  = 1;
  kitData.sysexPosition  = slot;

  // in OS 1.63 tonal flags aren’t round-tripped,
  // so force them all to zero here
  if (is163 && Array.isArray(kitData.machineTonalFlags)) {
    kitData.machineTonalFlags = kitData.machineTonalFlags.map(() => 0);
  }

  // clear out the raw buffer pointer
  kitData.rawKit = null;
}
  function stampPatternMetaFields(patData, slot) {
    patData.sysexVersion = 3;
    patData.sysexRevision = 1;
    patData.origPos = slot;
    patData.rawPattern = null;
  }
  function stampSongMetaFields(song, slot) {
    song.version = 2;
    song.revision = 2;
    song.slotIndex = slot;
  }

  window.mdDataRefs = window.mdDataRefs || {
    songs: { songSlotsArray: window.allSongSlots },
    kits: { kitLibraryArray: window.kitLibrary },
    patterns: { patternSlotsArray: window.allPatternSlots },
    helpers: {
      rebuildSongUI: window.fillSongUI,
      rebuildKitUI: window.initUI,
      rebuildPatternBitfields: null
    }
  };

  function parseNumberArray(str) {
    if (!str) return [];
    return str.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  }
  function parseRange(str) {
    if (!str) return null;
    const parts = str.split(",").map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { min: parts[0], max: parts[1] };
    }
    return null;
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  function clonePattern(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /****************************
   * 1) Small helper: read a slot range
   ****************************/
  function readSlotRange(id) {
    const raw = document.getElementById(id).value.split(",");
    const start = parseInt(raw[0], 10) || 0;
    const end   = parseInt(raw[1], 10) || 0;
    const slotStart = Math.max(0, start);
    const slotEnd   = Math.max(slotStart, end);
    return { slotStart, slotEnd };
  }

  /****************************
   * Track range helpers (0..15)
   ****************************/
  // Read a [min,max] track range (0..15) from a hidden input created by createRangeSliderRow
  function readTrackRange(id) {
    const el = document.getElementById(id);
    const r  = (el && el.value) ? el.value.split(",").map(v => parseInt(v, 10)) : [0,15];
    let tMin = Math.max(0, Math.min(15, isNaN(r[0]) ? 0  : r[0]));
    let tMax = Math.max(tMin, Math.min(15, isNaN(r[1]) ? 15 : r[1]));
    return { tMin, tMax };
  }
  function inTrackRange(t, r) { return t >= r.tMin && t <= r.tMax; }
  function isFullTrackRange(r) { return r.tMin === 0 && r.tMax === 15; }


  /****************************
   * 2) Build config for each randomizer
   ****************************/
  function buildSongRandomizerConfig() {
    const { slotStart, slotEnd } = readSlotRange("songSlotRange");
    const numRowsRange   = parseRange(document.getElementById("numRows").value) || { min: 1, max: 255 };
    const repeatProbabilityRange = parseRange(
  document.getElementById("repeatProbabilityRange").value
) || { min: 0, max: 100 };
    const repeatsRange   = parseRange(document.getElementById("repeatsRange").value) || { min: 2, max: 64 };
    const offsetRange    = parseRange(document.getElementById("offsetRange").value) || { min: 0, max: (window.mdModel === "MKI" ? 30 : 62) };
    const lengthRange    = parseRange(document.getElementById("lengthRange").value) || { min: 2, max: (window.mdModel === "MKI" ? 32 : 64) };

    const bpmRange = parseRange(document.getElementById("bpmRange").value) || { min: 30, max: 300 };
    const muteRange      = parseRange(document.getElementById("mutePercentage").value) || { min: 0, max: 100 };


    const rowTarget = (() => {
      const el = document.getElementById("songRowRange");
      if (!el || !el.value) return { startRow: 0, endRow: 254 };
      const parts = el.value.split(",").map(v => parseInt(v, 10));
      const start1 = Math.max(1, isNaN(parts[0]) ? 1 : parts[0]);
      const end1   = Math.max(start1, isNaN(parts[1]) ? 255 : parts[1]);
      return { startRow: start1 - 1, endRow: end1 - 1 };
    })();
    const patternArrayInput = document.getElementById("patternArray").value;
    const patternArray = parseRangeList(patternArrayInput, /*isPatternLabel=*/true);
    const BPMChoicesInput = document.getElementById("BPMChoices").value;
    const BPMChoicesArr = parseRangeList(BPMChoicesInput, /*isPatternLabel=*/false);

    const loopProbRange = parseRange(document.getElementById("loopProbabilityRange").value) || { min: 0, max: 0 };

// NEW: discrete choices for offset/length (duplicates allowed and meaningful)
const offsetChoicesInput = (document.getElementById("offsetChoices")?.value) || "";
const offsetChoicesArr   = parseRangeList(offsetChoicesInput, /*isPatternLabel=*/false);

const lengthChoicesInput = (document.getElementById("lengthChoices")?.value) || "";
const lengthChoicesArr   = parseRangeList(lengthChoicesInput, /*isPatternLabel=*/false);


    return {
      numRowsRange,
      repeatProbabilityRange,
      repeatsRange,
      offsetRange,
      lengthRange,
      bpmRange,
      muteRange,
      patternArray,
      BPMChoicesArr,
      loopProbRange,
      offsetChoicesArr,
      lengthChoicesArr,
      rowTarget,
      slotStart,
      slotEnd
    };
  }

  function buildKitRandomizerConfig() {
    const { slotStart, slotEnd } = readSlotRange("kitSlotRange");
    let machineAssignmentRange = parseRange(document.getElementById("machineAssignmentRange").value);
    const maxForModel = (!window.mdUWEnabled) ? 123 : ((window.mdModel === "MKI") ? 163 : 191);
    if (!machineAssignmentRange) {
      machineAssignmentRange = { min: 0, max: maxForModel };
    } else {
      machineAssignmentRange.max = Math.min(machineAssignmentRange.max, maxForModel);
    }

    const trackLevelRange        = parseRange(document.getElementById("trackLevelRange").value) || { min: 0, max: 127 };
    const machineParamsRange     = parseRange(document.getElementById("machineParamsRange").value) || { min: 0, max: 127 };
    const tonalFlagRange         = parseRange(document.getElementById("tonalFlagChance").value) || { min: 0, max: 1 };
    const trackFxRange           = parseRange(document.getElementById("trackFxRange").value) || { min: 0, max: 127 };
    const routingRange           = parseRange(document.getElementById("routingRange").value) || { min: 0, max: 127 };
    const mutePosRange           = parseRange(document.getElementById("mutePosRange").value) || { min: 0, max: 16 };
    const trigPosRange           = parseRange(document.getElementById("trigPosRange").value) || { min: 0, max: 16 };
    const lfoDestRange           = parseRange(document.getElementById("lfoDestRange").value) || { min: 0, max: 15 };
    const lfoParamRange          = parseRange(document.getElementById("lfoParamRange").value) || { min: 0, max: 23 };
    const lfoShape1Range         = parseRange(document.getElementById("lfoShape1Range").value) || { min: 0, max: 10 };
    const lfoShape2Range         = parseRange(document.getElementById("lfoShape2Range").value) || { min: 0, max: 10 };
    const masterFxRange          = parseRange(document.getElementById("masterFxRange").value) || { min: 0, max: 127 };

   const machineIDsStr = document.getElementById("machineIDs").value.trim();
let machineIDsArr = [];

if (machineIDsStr) {
  machineIDsArr = parseRangeList(machineIDsStr, false);
}

    const tonalFlagChance = Math.random() * (tonalFlagRange.max - tonalFlagRange.min) + tonalFlagRange.min;
    const trackRange = readTrackRange("kitTrackRange");


    return {
      trackRange,

      slotStart,
      slotEnd,
      machineIDs: machineIDsArr,
      machineAssignmentRange,
      trackLevelRange,
      machineParamsRange,
      tonalFlagChance,
      trackFxRange,
      routingRange,
      mutePosRange,
      trigPosRange,
      lfoDestRange,
      lfoParamRange,
      lfoShape1Range,
      lfoShape2Range,
      lfoModeRange: document.getElementById("lfoModeRange").value,
      masterFxRange
    };
  }

  function buildPatternRandomizerConfig() {
    const { slotStart, slotEnd } = readSlotRange("patternSlotRange");
    const lengthRange     = parseRange(document.getElementById("patternLengthRange").value) || { min: 2, max: (window.mdModel === "MKI" ? 32 : 64) };
    const tempoMultRange  = parseRange(document.getElementById("tempoMultRange").value) || { min: 0, max: 3 };
    const scaleRange      = parseRange(document.getElementById("scaleRange").value) || { min: 0, max: (window.mdModel === "MKI" ? 1 : 3) };
    const kitChoicesStr = document.getElementById("kitChoices").value.trim();
const kitChoicesArr = kitChoicesStr
  ? parseRangeList(kitChoicesStr, /*isPatternLabel=*/false)
  : [];
    const kitNumRange     = parseRange(document.getElementById("assignedKitNumberRange").value) || { min: 0, max: 63 };
    const accentAmtRange  = parseRange(document.getElementById("accentAmountRange").value) || { min: 0, max: 15 };
    const swingAmtRange   = parseRange(document.getElementById("swingAmountRange").value) || { min: 0, max: 127 };
    const lockParamRange   = parseRange(document.getElementById("lockParamRange").value) || { min: 1, max: 24 };
    const trackRange = readTrackRange("patternTrackRange");


    return {
      trackRange,

      slotStart,
      slotEnd,
      lengthRange,
      tempoMultRange,
      scaleRange,
      kitChoices: kitChoicesArr,
      assignedKitNumberRange: kitNumRange,
      accentAmountRange: accentAmtRange,
      swingAmountRange: swingAmtRange,
      lockParamRange
    };
  }

  /********************************
   * SONG GENERATOR
   ********************************/
// --- Targeted row write helpers ---
const MD_MAX_SONG_ROWS = 255;

// A silent "no-op" row: all 16 tracks muted, minimal length
function createSilentRow() {
  return { data: [ 0x00, 0, 0, 0, 0xFF, 0xFF, 0, 0, 0, 2 ] };
}

// Ensure song.rows is contiguous up to uptoIdx (filling gaps with silence)
function ensureRowCapacity(song, uptoIdx) {
  if (!Array.isArray(song.rows)) song.rows = [];
  for (let i = 0; i <= uptoIdx; i++) {
    const r = song.rows[i];
    if (!r || (r.data && r.data[0] === 0xFF)) {
      song.rows[i] = createSilentRow();
    }
  }
}

// Index of the last row that is NOT an End marker (counts silent rows as real)
function lastNonEndRowIndex(song) {
  let idx = -1;
  const rows = Array.isArray(song.rows) ? song.rows : [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r && r.data && r.data[0] !== 0xFF) idx = i;
  }
  return idx;
}

// Keep a single End row at (lastNonEnd+1), within caps
function normalizeEndMarker(song) {
  if (!song || !Array.isArray(song.rows)) song.rows = [];
  for (let i = 0; i < song.rows.length; i++) {
    const r = song.rows[i];
    if (r && r.data && r.data[0] === 0xFF) {
      song.rows[i] = null; // drop; will be rebuilt
    }
  }
  const last = lastNonEndRowIndex(song);
  const eosIdx = Math.min(last + 1, MD_MAX_SONG_ROWS);
  ensureRowCapacity(song, Math.max(eosIdx - 1, 0));
  song.rows[eosIdx] = { data: [0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
  song.rows.length = Math.min(song.rows.length, eosIdx + 1);
}

function generateRandomSong(config) {
  const {
    slotStart,
    slotEnd,
    numRowsRange,           // "Generation Length (rows)"
    repeatsRange,
    repeatProbabilityRange,
    offsetRange,
    lengthRange,
    bpmRange,
    muteRange,
    patternArray,
    BPMChoicesArr,
    loopProbRange,
    offsetChoicesArr,
    lengthChoicesArr,
    rowTarget               // { startRow, endRow } (0-based)
  } = config;

  // 1) Build the pool of pattern indices (fallback to slider range)
  let finalPatternArray = patternArray;
  if (!finalPatternArray || finalPatternArray.length === 0) {
    const paVals = document.getElementById("patternAssignmentRange").value.split(",");
    const paMin = paVals[0].trim() === "" ? 0   : parseInt(paVals[0], 10);
    const paMax = paVals[1].trim() === "" ? 127 : parseInt(paVals[1], 10);
    finalPatternArray = [];
    for (let i = paMin; i <= paMax; i++) finalPatternArray.push(i);
  }

  // 2) For each destination song slot …
  for (let slot = slotStart; slot <= slotEnd; slot++) {
    // Reuse or create the song container (DO NOT reset rows)
    let song = window.mdDataRefs.songs.songSlotsArray[slot];
    if (!song) {
      song = { name: "", rows: [] };
      stampSongMetaFields(song, slot);
      window.mdDataRefs.songs.songSlotsArray[slot] = song;
    }

    // Always replace the slot's displayed name when generating
    const base = (typeof window.generateSongName === "function") ? window.generateSongName() : "";
    const s = (typeof base === "string" ? base : String(base || "")).trim().toUpperCase();
    song.name = s || `SONG-${String(slot + 1).padStart(2, "0")}`;

    // 3) Determine write window
    const genLen = pickRandomValueInRange(numRowsRange);
    const start  = Math.max(0, Math.min(rowTarget.startRow ?? 0, MD_MAX_SONG_ROWS - 1));
    const hardEndOfRange = Math.max(0, Math.min(rowTarget.endRow ?? (MD_MAX_SONG_ROWS - 1), MD_MAX_SONG_ROWS - 1));
    const desiredEnd     = Math.min(start + genLen - 1, hardEndOfRange, MD_MAX_SONG_ROWS - 1);
    if (desiredEnd < start) continue;

    // Ensure contiguous array up to desiredEnd (fill gaps with silent rows)
    ensureRowCapacity(song, desiredEnd);

    // 4) Write rows ONLY in [start, desiredEnd]
    for (let i = start; i <= desiredEnd; i++) {
      // Loop logic (kept, but loop stays inside [start, i])
      if (i > start + 3) {
        const chance = loopProbRange.min + Math.random() * (loopProbRange.max - loopProbRange.min);
        if (Math.random() * 100 < chance) {
          const offsetRangeRaw = parseRange(document.getElementById("loopDestRange").value) || { min: 1, max: 10 };
          const effMin = offsetRangeRaw.min;
          const effMax = Math.min(offsetRangeRaw.max, i - start);
          const randomOffset = (effMin <= effMax)
              ? Math.floor(Math.random() * (effMax - effMin + 1)) + effMin
              : (i - start);
          const loopDestRow = i - randomOffset;

          const loopCountRangeRaw = parseRange(document.getElementById("loopCountRange").value) || { min: 0, max: 16 };
          const loopCount = Math.floor(Math.random() * (Math.min(loopCountRangeRaw.max, 63) - loopCountRangeRaw.min + 1)) + loopCountRangeRaw.min;

          song.rows[i] = { data: [ 0xFE, 0, loopCount, loopDestRow, 0, 0, 0, 0, 0, 0 ] };
          continue;
        }
      }

      // Repeat probability (unchanged)
      const probPct = pickRandomValueInRange(repeatProbabilityRange);
      let repeatsValue;
      if (Math.random() * 100 < probPct) {
        const randomRepeats = Math.floor(Math.random() * (repeatsRange.max - repeatsRange.min + 1)) + repeatsRange.min;
        repeatsValue = randomRepeats - 1;
      } else {
        repeatsValue = 0;
      }

      // Pattern selection
      const patIdx = finalPatternArray[Math.floor(Math.random() * finalPatternArray.length)];


// --- Offset & per-row length (safe caps + biased choices) ---
      let patMax = (window.mdModel === "MKI") ? 32 : 64;
      if (window.allPatternSlots && window.allPatternSlots[patIdx] &&
          window.allPatternSlots[patIdx].pattern && window.allPatternSlots[patIdx].pattern.length) {
        patMax = window.allPatternSlots[patIdx].pattern.length;
      }

      // Hardware/OS caps
      const offsetOSMax = (window.mdModel === "MKI") ? 30 : 62;
      const lengthOSMax = (window.mdModel === "MKI") ? 32 : 64;

      // ----- Offset
      let randomOffset = null;
      {
        const maxAllowedOffset = Math.min(offsetOSMax, Math.max(0, patMax - 2));
        if (Array.isArray(offsetChoicesArr) && offsetChoicesArr.length) {
          const chosen = pickFromChoicesBiased(offsetChoicesArr, 0, maxAllowedOffset);
          if (chosen != null) randomOffset = chosen;
        }
        if (randomOffset == null) {
          const minOffset = Math.max(0, offsetRange.min);
          const effOffsetMax = Math.min(offsetRange.max, maxAllowedOffset);
          randomOffset = pickRandomValueInRange({ min: minOffset, max: effOffsetMax });
        }
      }

      // ----- Length
      let randomLength = null;
      {
        const maxLenForRow = Math.min(lengthOSMax, Math.max(2, patMax - randomOffset));
        if (Array.isArray(lengthChoicesArr) && lengthChoicesArr.length) {
          const chosenLen = pickFromChoicesBiased(lengthChoicesArr, 2, maxLenForRow);
          if (chosenLen != null) randomLength = chosenLen;
        }
        if (randomLength == null) {
          const effLenMax = Math.min(lengthRange.max, maxLenForRow);
          randomLength = pickRandomValueInRange({ min: Math.max(2, lengthRange.min), max: effLenMax });
        }
        if (window.mdModel === "MKI" && randomLength > 32) randomLength = 32;
      }

      // BPM selection

      let chosenBPM = null;
      if (BPMChoicesArr.length > 0) {
        const pick = BPMChoicesArr[Math.floor(Math.random() * BPMChoicesArr.length)];
        chosenBPM = (pick === "NO_BPM") ? null : pick;
      } else {
        const minBPM = Math.floor(Math.min(bpmRange.min, bpmRange.max));
        const maxBPM = Math.floor(Math.max(bpmRange.min, bpmRange.max));
        if (minBPM === 0) {
          const rawPick = Math.floor(Math.random() * (maxBPM - 0 + 1));
          chosenBPM = (rawPick === 0) ? null : rawPick;
        } else {
          chosenBPM = Math.floor(Math.random() * (maxBPM - minBPM + 1)) + minBPM;
        }
      }
      let bpmHigh = 0, bpmLow = 0;
      if (chosenBPM != null && window.bpmToRaw) {
        const br = window.bpmToRaw(chosenBPM);
        bpmHigh = br.high; bpmLow = br.low;
      }

      // Assemble row data
      const rowData = [
        patIdx & 0x7F,
        0,
        repeatsValue,
        0,
        0, 0,      // mute mask may be set below
        bpmHigh,
        bpmLow,
        randomOffset,
        randomLength
      ];

      // Mute mask probability (unchanged)
      const mutePercent = Math.random() * (muteRange.max - muteRange.min) + muteRange.min;
      if (Math.random() * 100 < mutePercent) {
        const maxMutes = Math.round((mutePercent / 100) * 16);
        const numMutes = pickRandomValueInRange({ min: 0, max: maxMutes });
        const tracks = Array.from({ length: 16 }, (_, n) => n).sort(() => Math.random() - 0.5);
        let mask = 0;
        for (let m = 0; m < numMutes; m++) mask |= (1 << tracks[m]);
        rowData[4] = (mask & 0xFF);
        rowData[5] = ((mask >> 8) & 0xFF);
      }

      song.rows[i] = { data: rowData };
    }

    // 5) Normalize End-of-song once per slot (single EOS right after last row)
    normalizeEndMarker(song);

    // Stamp/refresh metadata & references
    stampSongMetaFields(song, slot);
    window.mdDataRefs.songs.songSlotsArray[slot] = song;
  }

  // One set of UI refresh calls
  if (typeof buildSongSlotsUI === "function") {
    buildSongSlotsUI();
  } else {
    window.mdDataRefs.helpers.rebuildSongUI();
  }
  if (typeof fillSongUI === "function") fillSongUI();
}
  function pickRandomValueInRange(rangeObj) {
    const mi = rangeObj && rangeObj.min != null ? rangeObj.min : 0;
    const ma = rangeObj && rangeObj.max != null ? rangeObj.max : 127;
    const low = Math.min(mi, ma);
    const high = Math.max(mi, ma);
    return Math.floor(Math.random() * (high - low + 1)) + low;
  }


function pickFromChoicesBiased(choices, min, max) {
  if (!Array.isArray(choices) || choices.length === 0) return null;

  // Build frequency map within [min,max] (integers only)
  const freq = new Map();
  for (let i = 0; i < choices.length; i++) {
    const v = parseInt(choices[i], 10);
    if (Number.isFinite(v) && v >= min && v <= max) {
      freq.set(v, (freq.get(v) || 0) + 1);
    }
  }
  if (freq.size === 0) return null;

  // Grave weighting: weight = count^2
  let total = 0;
  const entries = [];
  for (const [val, count] of freq.entries()) {
    const w = count * count;
    total += w;
    entries.push({ val, w });
  }

  let r = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    r -= entries[i].w;
    if (r <= 0) return entries[i].val;
  }
  return entries[entries.length - 1].val; // fallback
}
  /********************************
   * KIT RANDOMIZATION
   ********************************/
  function randomizeKitFull(kit, config) {
    const mdModel = window.mdModel || "MKII";
    const machineIDs = config.machineIDs || [];
    const machRange = config.machineAssignmentRange || { min: 0, max: 127 };


    const tr = config.trackRange || { tMin: 0, tMax: 15 };
    const full = isFullTrackRange(tr);
for (let t = 0; t < 16; t++) {
      if (!inTrackRange(t, tr)) continue;
      const mID = pickRandomMachineID(mdModel, machineIDs, machRange);
      kit.machineAssignments[t] = mID;
      if (window.MACHINES_THAT_SUPPORT_TONAL && window.MACHINES_THAT_SUPPORT_TONAL.has(mID)) {
        kit.machineTonalFlags[t] = Math.random() < config.tonalFlagChance ? 1 : 0;
      } else {
        kit.machineTonalFlags[t] = 0;
      }
      for (let mp = 0; mp < 8; mp++) {
        const advRange = getAdvancedRangeForParameter("machineParams", mp);
        const rangeToUse = advRange || config.machineParamsRange;
        kit.machineParams[t][mp] = pickRandomValueInRange(rangeToUse);
      }
      for (let fx = 0; fx < 8; fx++) {
        const advRange = getAdvancedRangeForParameter("trackFx", fx);
        const rangeToUse = advRange || config.trackFxRange;
        kit.trackFx[t][fx] = pickRandomValueInRange(rangeToUse);
      }
      for (let rt = 0; rt < 8; rt++) {
        const advRange = getAdvancedRangeForParameter("routing", rt);
        const rangeToUse = advRange || config.routingRange;
        kit.routing[t][rt] = pickRandomValueInRange(rangeToUse);
      }
      kit.trackLevels[t] = pickRandomValueInRange(config.trackLevelRange);

      const muteVal = pickRandomValueInRange(config.mutePosRange);
      const trigVal = pickRandomValueInRange(config.trigPosRange);
      kit.muteTrigRelations[t] = [
        (muteVal > 15 ? 128 : muteVal),
        (trigVal > 15 ? 128 : trigVal)
      ];

      if (!kit.lfoBlocks[t] || kit.lfoBlocks[t].length !== 36) {
        kit.lfoBlocks[t] = new Array(36).fill(0);
      }
      kit.lfoBlocks[t][0] = pickRandomValueInRange(config.lfoDestRange);
      kit.lfoBlocks[t][1] = pickRandomValueInRange(config.lfoParamRange);
      kit.lfoBlocks[t][2] = pickRandomValueInRange(config.lfoShape1Range);
      kit.lfoBlocks[t][3] = pickRandomValueInRange(config.lfoShape2Range);

      const modeRangeStr = config.lfoModeRange || "0,100";
const parts = modeRangeStr.split(",").map(v => parseFloat(v));
if (parts.length === 2 && parts[0] === parts[1]) {
  let fixedMode;
  if (parts[0] <= 33) fixedMode = 0;
  else if (parts[0] <= 66) fixedMode = 1;
  else fixedMode = 2;
  kit.lfoBlocks[t][4] = fixedMode;
} else {
  const modeProb = parts[1] / 100;
  kit.lfoBlocks[t][4] = (Math.random() < modeProb) ? Math.floor(Math.random() * 3) : 0;
}
    }
    if (full) { // gated: only randomize Master FX when all tracks are selected
      if (!kit.masterFx || kit.masterFx.length !== 32) { kit.masterFx = new Array(32).fill(0); }
      for (let i = 0; i < 32; i++) {
        const advRange = getAdvancedRangeForParameter("masterFx", i);
        let rangeToUse = advRange || config.masterFxRange;

        // Master FX param #12 (index 11) is treated as 0–63 (avoid clamping bias)
        if (i === 11 && rangeToUse) {
          rangeToUse = {
            min: Math.min(rangeToUse.min ?? 0, 63),
            max: Math.min(rangeToUse.max ?? 63, 63)
          };
        }

        kit.masterFx[i] = pickRandomValueInRange(rangeToUse);
      }
    }

  }

  function generateRandomKit(config) {
    const start = Math.max(0, config.slotStart);
    const end   = Math.max(start, config.slotEnd);

    for (let slot = start; slot <= end; slot++) {
      if (!window.kitLibrary[slot]) {
        window.kitLibrary[slot] = {
          data: clonePattern(window.DEFAULTS.kit),
          colorIndex: slot,
        };
      }
      window.kit = clonePattern(window.kitLibrary[slot].data);
      const generatedName = randomizeKitName();
      const kitColor = getRandomColorFromString(generatedName);
      window.kit.kitName = generatedName.split("");
      window.kit.color = kitColor;

      randomizeKitFull(window.kit, config);
      stampKitMetaFields(window.kit, slot);
      window.kitLibrary[slot].data = clonePattern(window.kit);
      window.mdDataRefs.kits.kitLibraryArray[slot] = window.kitLibrary[slot];
      if (typeof buildKitSlotsUI === "function") buildKitSlotsUI();
      if (typeof colorizeSlots === "function") colorizeSlots();
      if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
    }
  }

  async function writePatternSlot(slot, patternData, opts = {}) {
  // existing meta stamping
  patternData.sysexVersion  = 3;
  patternData.sysexRevision = 1;
  patternData.origPos       = slot;
  patternData.patternNumber = slot;
  patternData.rawPattern    = null;
  stampPatternMetaFields(patternData, slot);

  // keep this: matrices/masks derived
  updateLockMatricesFromLocks(patternData);

  // NEW: normalize to 16×8 and 8-byte globals BEFORE sanitize
  (function normalizeInPlace(p) {
    const isArrayLike = a => Array.isArray(a) || (a && ArrayBuffer.isView(a));

    const pad8 = (arr) => {
      const out = new Array(8).fill(0);
      if (isArrayLike(arr)) {
        for (let i = 0; i < 8 && i < arr.length; i++) out[i] = arr[i] & 0xFF; // keep all 8 bits
      }
      return out;
    };
    const pad16x8 = (name) => {
      const src = isArrayLike(p[name]) ? p[name] : [];
      const out = new Array(16);
      for (let t = 0; t < 16; t++) {
        const row = isArrayLike(src[t]) ? src[t] : [];
        out[t] = pad8(row);
      }
      p[name] = out;
    };
    pad16x8('trigBitsPerTrack');
    pad16x8('accentBitsPerTrack');
    pad16x8('swingBitsPerTrack');
    pad16x8('slideBitsPerTrack');
    p.accentBitsGlobal = pad8(p.accentBitsGlobal);
    p.swingBitsGlobal  = pad8(p.swingBitsGlobal);
    p.slideBitsGlobal  = pad8(p.slideBitsGlobal);
    // Stable lock order
    if (Array.isArray(p.locks)) {
      p.locks.sort((a,b) => (a.track-b.track)||(a.step-b.step)||(a.paramID-b.paramID));
    }
  })(patternData);

  // existing sanitize (removes derived/ephemeral)
  patternData = sanitizePattern(patternData); // keeps bitfields/locks intact [oai_citation:8‡machinedrum-ui.js](file-service://file-4cGVrne5wYePrXcBajcyCu)
  patternData.isClean = true;

  // store
  window.allPatternSlots[slot] = {
    kit: null,
    pattern: clonePattern(patternData),
    kitColorIndex: patternData.assignedKitNumber || 0,
  };

  if (!opts.silent) {
    // existing UI refresh
    window.selectedPatternSlotIndex = slot;
    if (typeof buildPatternSlotsUI === "function") buildPatternSlotsUI();
    if (typeof buildTopPatternBanksUI === "function") buildTopPatternBanksUI();
    if (typeof attachBankSlotClickHandlers === "function") attachBankSlotClickHandlers();
    if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
    if (typeof initUI === "function") initUI();
  }
}


  async function generateRandomPattern(config) {
    const startSlot = Math.max(0, config.slotStart);
    const endSlot   = Math.max(startSlot, config.slotEnd);

    for (let slot = startSlot; slot <= endSlot; slot++) {
      if (!window.allPatternSlots[slot]) {
        window.allPatternSlots[slot] = {
          pattern: clonePattern(window.DEFAULTS.pattern),
          kitColorIndex: 0
        };
      }
      let existingSlotPattern = window.allPatternSlots[slot].pattern || {};
      window.pattern = clonePattern(existingSlotPattern);

      // Selected track range
      const tr   = config.trackRange || { tMin: 0, tMax: 15 };
      const full = isFullTrackRange(tr);

      // --- LENGTH & GLOBALS ---
      let length = window.pattern.length || 16;
      if (config.kitChoices && config.kitChoices.length) {
    window.pattern.assignedKitNumber =
      config.kitChoices[Math.floor(Math.random() * config.kitChoices.length)];
  } else {
    window.pattern.assignedKitNumber =
      pickRandomValueInRange(config.assignedKitNumberRange);
  }
      if (full) {
        const lengthRange_ = config.lengthRange || { min: 2, max: (window.mdModel === "MKI" ? 32 : 64) };
        length = Math.floor(Math.random() * (lengthRange_.max - lengthRange_.min + 1)) + lengthRange_.min;
        if (window.mdModel === "MKI" && length > 32) { length = 32; }
        window.pattern.length = length;
        window.pattern.extendedFlag = (window.mdModel !== "MKI" && length > 32);

        const tempoMultRange_ = config.tempoMultRange || { min: 0, max: 3 };
        window.pattern.tempoMult = Math.floor(Math.random() * (tempoMultRange_.max - tempoMultRange_.min + 1)) + tempoMultRange_.min;

        const scaleRange_ = config.scaleRange || { min: 0, max: (window.mdModel === "MKI" ? 1 : 3) };
        window.pattern.scale = Math.floor(Math.random() * (scaleRange_.max - scaleRange_.min + 1)) + scaleRange_.min;

        window.pattern.accentAmount = pickRandomValueInRange(config.accentAmountRange);
        window.pattern.swingAmount  = pickRandomValueInRange(config.swingAmountRange);

        if (typeof onLengthSliderChange === "function") { onLengthSliderChange(length); }
      }

      // Probability sliders
      const trigProbRange = document.getElementById("trigProb").value.split(",");
      const trigProbMin = (parseFloat(trigProbRange[0]) || 0) / 100;
      const trigProbMax = (parseFloat(trigProbRange[1]) || 0) / 100;
      const trigProb = trigProbMin + Math.random() * (trigProbMax - trigProbMin);

      const accProbRange = document.getElementById("accProb").value.split(",");
      const accProbMin = (parseFloat(accProbRange[0]) || 0) / 100;
      const accProbMax = (parseFloat(accProbRange[1]) || 0) / 100;
      const accProb = accProbMin + Math.random() * (accProbMax - accProbMin);

      const swProbRange = document.getElementById("swProb").value.split(",");
      const swProbMin = (parseFloat(swProbRange[0]) || 0) / 100;
      const swProbMax = (parseFloat(swProbRange[1]) || 0) / 100;
      const swProb = swProbMin + Math.random() * (swProbMax - swProbMin);

      const slProbRange = document.getElementById("slProb").value.split(",");
      const slProbMin = (parseFloat(slProbRange[0]) || 0) / 100;
      const slProbMax = (parseFloat(slProbRange[1]) || 0) / 100;
      const slProb = slProbMin + Math.random() * (slProbMax - slProbMin);

      // Ensure 16×8 arrays exist; preserve out-of-range tracks
      const isArrayLike = a => Array.isArray(a) || (a && ArrayBuffer.isView(a));
const ensure16x8 = (name) => {
  const src = isArrayLike(window.pattern[name]) ? window.pattern[name] : [];
  const out = new Array(16);
  for (let t = 0; t < 16; t++) {
    const row = isArrayLike(src[t]) ? src[t] : [];
    const buf = new Array(8).fill(0);
    for (let i = 0; i < Math.min(8, row.length); i++) buf[i] = row[i] & 0xFF;
    out[t] = buf;
  }
  window.pattern[name] = out;
};
      ensure16x8('trigBitsPerTrack');
      ensure16x8('accentBitsPerTrack');
      ensure16x8('swingBitsPerTrack');
      ensure16x8('slideBitsPerTrack');

      // We'll collect lock positions per track to bias slide trigs later
      const lockedStepsByTrack = Array.from({ length: 16 }, () => new Set());

      // Rebuild bitfields only for selected tracks
      for (let t = 0; t < 16; t++) {
        if (!inTrackRange(t, tr)) continue;

        const thisTrigCount = Math.floor((trigProbMin + Math.random() * (trigProbMax - trigProbMin)) * length);
        window.pattern.trigBitsPerTrack[t] = Array.from(generateFixedBitfield(length, thisTrigCount));

        const thisAccCount = Math.floor((accProbMin + Math.random() * (accProbMax - accProbMin)) * length);
        window.pattern.accentBitsPerTrack[t] = Array.from(generateFixedBitfield(length, thisAccCount));

        const thisSwCount = Math.floor((swProbMin + Math.random() * (swProbMax - swProbMin)) * length);
        window.pattern.swingBitsPerTrack[t] = Array.from(generateFixedBitfield(length, thisSwCount));

        // Slide bitfield deferred; will be set after locks to prefer locked trig positions.
      }

      // Global accent/swing/slide bitfields & edit-all flags — only when full selection
      if (isFullTrackRange(tr)) { // gated: only when full track range is selected

        const accentCount = Math.floor(accProb * length);
        const swingCount  = Math.floor(swProb  * length);
        const slideCount  = Math.floor(slProb  * length);
        window.pattern.accentBitsGlobal = Array.from(generateFixedBitfield(length, accentCount));
        window.pattern.swingBitsGlobal  = Array.from(generateFixedBitfield(length, swingCount));
        window.pattern.slideBitsGlobal  = Array.from(generateFixedBitfield(length, slideCount));

        const accEditRange = document.getElementById("accEditAllProb").value.split(",");
        const accEditMin = (parseFloat(accEditRange[0]) || 0) / 100;
        const accEditMax = (parseFloat(accEditRange[1]) || 0) / 100;
        window.pattern.accentEditAll = (Math.random() < (accEditMin + Math.random() * (accEditMax - accEditMin))) ? 1 : 0;

        const swEditRange = document.getElementById("swEditAllProb").value.split(",");
        const swEditMin = (parseFloat(swEditRange[0]) || 0) / 100;
        const swEditMax = (parseFloat(swEditRange[1]) || 0) / 100;
        window.pattern.swingEditAll = (Math.random() < (swEditMin + Math.random() * (swEditMax - swEditMin))) ? 1 : 0;

        const slEditRange = document.getElementById("slEditAllProb").value.split(",");
        const slEditMin = (parseFloat(slEditRange[0]) || 0) / 100;
        const slEditMax = (parseFloat(slEditRange[1]) || 0) / 100;
        window.pattern.slideEditAll = (Math.random() < (slEditMin + Math.random() * (slEditMax - slEditMin))) ? 1 : 0;
      }

      // Locks: keep out-of-range; only add locks within selected range up to cap
      const existingLocks = Array.isArray(window.pattern.locks) ? window.pattern.locks : [];
      const keepLocks = existingLocks.filter(L => !inTrackRange(L.track, tr));
      window.pattern.locks = keepLocks.slice();

      const maxLocksStr = document.getElementById("maxLocks").value;
      const maxLocksParts = maxLocksStr.split(",");
      const hardLockCap = (maxLocksParts.length > 1 ? parseInt(maxLocksParts[1], 10) : parseInt(maxLocksParts[0], 10)) || 64;
      let lockBudget = Math.max(0, hardLockCap - window.pattern.locks.length);

      const locksToMake = lockBudget > 0 ? (1 + Math.floor(Math.random() * lockBudget)) : 0;

      // Param-lock selection: encourage wide-ranging coverage across the chosen range
      // (and avoid accidental "stuck" single-param generation).
      const lp = config.lockParamRange || { min: 1, max: 24 };
      let lpMin = Number(lp.min);
      let lpMax = Number(lp.max);
      if (!Number.isFinite(lpMin) || !Number.isFinite(lpMax)) { lpMin = 1; lpMax = 24; }

      // Normalize + clamp to valid MD param lock IDs (1..24)
      let lowP  = Math.max(1, Math.min(lpMin, lpMax));
      let highP = Math.min(24, Math.max(lpMin, lpMax));

      // If the range is accidentally collapsed at the very top end, widen it.
      // (Common symptom reported: only routing param #24 / "LFOM" gets locked.)
      if (lowP === highP && highP === 24) {
        lowP = 1;
        highP = 24;
      }

      const allowedParamIDs = [];
      for (let p = lowP; p <= highP; p++) allowedParamIDs.push(p);
      if (allowedParamIDs.length === 0) allowedParamIDs.push(24);
      shuffle(allowedParamIDs);
      let paramCursor = 0;
      function nextParamID() {
        if (paramCursor >= allowedParamIDs.length) {
          shuffle(allowedParamIDs);
          paramCursor = 0;
        }
        return allowedParamIDs[paramCursor++];
      }

      // Avoid duplicate locks (same track/step/param) which would otherwise overwrite in the lock matrix.
      const usedLockKeys = new Set();
      for (let k = 0; k < window.pattern.locks.length; k++) {
        const L = window.pattern.locks[k];
        if (!L) continue;
        usedLockKeys.add(`${L.track}|${L.step}|${L.paramID}`);
      }

      for (let i = 0; i < locksToMake; i++) {
        const track = Math.floor(Math.random() * (tr.tMax - tr.tMin + 1)) + tr.tMin;

        // Prefer an existing trig position for the lock step; fall back to any step (and set a trig there)
        const trigSteps = stepsFromBitfield(window.pattern.trigBitsPerTrack[track], length);
        let step;
        if (trigSteps.length > 0) {
          step = trigSteps[Math.floor(Math.random() * trigSteps.length)];
        } else {
          step = Math.floor(Math.random() * length);
        }
        const bIndex = Math.floor(step / 8);
        const bPos = step % 8;
        if (!(window.pattern.trigBitsPerTrack[track][bIndex] & (1 << bPos))) {
          window.pattern.trigBitsPerTrack[track][bIndex] |= (1 << bPos);
        }

        // Pick a paramID in a way that spreads across the range, while avoiding duplicates.
        let paramID = nextParamID();
        let tries = 0;
        while (tries < allowedParamIDs.length && usedLockKeys.has(`${track}|${step}|${paramID}`)) {
          paramID = nextParamID();
          tries++;
        }
        const key = `${track}|${step}|${paramID}`;
        if (usedLockKeys.has(key)) continue; // couldn't find a unique lock for this step

        usedLockKeys.add(key);
        const paramVal = Math.floor(Math.random() * 128);
        window.pattern.locks.push({ track, step, paramID, paramVal });
        if (lockedStepsByTrack[track]) lockedStepsByTrack[track].add(step);
      }


      // Rebuild per-track slide bitfields AFTER locks so slides prefer locked trig steps
      for (let t = 0; t < 16; t++) {
        if (!inTrackRange(t, tr)) continue;
        const desiredSlideCount = Math.floor((slProbMin + Math.random() * (slProbMax - slProbMin)) * length);
        const chosen = [];

        // 1) Use locked trig steps first
        const lockedArr = Array.from(lockedStepsByTrack[t] || []);
        shuffle(lockedArr);
        for (let k = 0; k < Math.min(desiredSlideCount, lockedArr.length); k++) {
          chosen.push(lockedArr[k]);
        }

        // 2) If we still need more, use other trig steps on the track
        if (chosen.length < desiredSlideCount) {
          const trigAll = stepsFromBitfield(window.pattern.trigBitsPerTrack[t], length);
          const remainingPool = trigAll.filter(s => !(lockedStepsByTrack[t] && lockedStepsByTrack[t].has(s)));
          shuffle(remainingPool);
          const need = desiredSlideCount - chosen.length;
          for (let k = 0; k < Math.min(need, remainingPool.length); k++) {
            chosen.push(remainingPool[k]);
          }
        }

        // 3) Build the final bitfield
        window.pattern.slideBitsPerTrack[t] = Array.from(bitfieldFromSteps(length, chosen));
      }

      writePatternSlot(slot, window.pattern, { silent: true });
    }

    if (typeof buildPatternSlotsUI === "function") buildPatternSlotsUI();
    if (typeof buildTopPatternBanksUI === "function") buildTopPatternBanksUI();
    if (typeof attachBankSlotClickHandlers === "function") attachBankSlotClickHandlers();

    resetPattern();
    window.pattern.patternNumber = -1;
    window.selectedPatternSlotIndex = -1;
    if (typeof updatePanelHeaderColors === "function") updatePanelHeaderColors();
    window.selectedPatternSlotIndex = -1;
  }


  /********************************
   * Hook up button clicks
   ********************************/
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "generateSongBtn") {
      if (!confirm("WARNING: This will overwrite song data. Continue?")) return;
      const config = buildSongRandomizerConfig();
      generateRandomSong(config);
    }
    if (e.target && e.target.id === "generateKitBtn") {
      if (!confirm("WARNING: This will overwrite kit data. Continue?")) return;
      const config = buildKitRandomizerConfig();
      generateRandomKit(config);
    }
    if (e.target && e.target.id === "generatePatternBtn") {
      if (!confirm("WARNING: This will overwrite pattern data. Continue?")) return;
      const config = buildPatternRandomizerConfig();
      generateRandomPattern(config);
    }
  });

  /********************************
   * Input listeners to disable/enable corresponding sliders
   ********************************/
  function syncLabOverrideSliders() {
    // Some text inputs act as overrides and should disable their paired sliders.
    // When we reset/randomise panels, values change programmatically, so we
    // dispatch an input event to keep the disabled states in sync.
    [
      "machineIDs",
      "patternArray",
      "BPMChoices",
      "offsetChoices",
      "lengthChoices",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (_) {
        // IE11 / very old browsers: fall back to a basic Event
        const evt = document.createEvent("Event");
        evt.initEvent("input", true, true);
        el.dispatchEvent(evt);
      }
    });
  }

  function attachInputOverridesSongPanel() {
    const patternArrInput = document.getElementById("patternArray");
    const patternRangeSlider = document.getElementById("patternAssignmentRange_slider");
    if (patternArrInput && patternRangeSlider) {
      patternArrInput.addEventListener("input", () => {
        if (patternArrInput.value.trim()) {
          patternRangeSlider.setAttribute("disabled", true);
        } else {
          patternRangeSlider.removeAttribute("disabled");
        }
      });
    }

    const bpmChoiceInput = document.getElementById("BPMChoices");
    const bpmRangeSlider = document.getElementById("bpmRange_slider");
    if (bpmChoiceInput && bpmRangeSlider) {
      bpmChoiceInput.addEventListener("input", () => {
        if (bpmChoiceInput.value.trim()) {
          bpmRangeSlider.setAttribute("disabled", true);
        } else {
          bpmRangeSlider.removeAttribute("disabled");
        }
      });
    }

// --- NEW: keep Offset slider disabled if choices text has content
const offsetChoicesInput2 = document.getElementById("offsetChoices");
const offsetRangeSlider = document.getElementById("offsetRange_slider");
if (offsetChoicesInput2 && offsetRangeSlider) {
  const syncOffset = () => {
    if (offsetChoicesInput2.value.trim()) offsetRangeSlider.setAttribute("disabled", true);
    else                                   offsetRangeSlider.removeAttribute("disabled");
  };
  offsetChoicesInput2.addEventListener("input", syncOffset);
  syncOffset(); // initialize
}

// --- NEW: keep Length slider disabled if choices text has content
const lengthChoicesInput2 = document.getElementById("lengthChoices");
const lengthRangeSlider = document.getElementById("lengthRange_slider");
if (lengthChoicesInput2 && lengthRangeSlider) {
  const syncLength = () => {
    if (lengthChoicesInput2.value.trim()) lengthRangeSlider.setAttribute("disabled", true);
    else                                   lengthRangeSlider.removeAttribute("disabled");
  };
  lengthChoicesInput2.addEventListener("input", syncLength);
  syncLength(); // initialize
}
  }
  function attachInputOverridesKitPanel() {
    const machIDsInput = document.getElementById("machineIDs");
    const machAssignSlider = document.getElementById("machineAssignmentRange_slider");
    if (!machIDsInput || !machAssignSlider) return;

    machIDsInput.addEventListener("input", () => {
      if (machIDsInput.value.trim()) {
        machAssignSlider.setAttribute("disabled", true);
      } else {
        machAssignSlider.removeAttribute("disabled");
      }
    });
  }

  /********************************
   * Update Lab Slider Ranges
   ********************************/
  function updateLabSliderRanges() {
    let offsetMax = (window.mdModel === "MKI") ? 30 : 62;
    const offsetSlider = document.getElementById("offsetRange_slider");
    if (offsetSlider && offsetSlider.noUiSlider) {
      offsetSlider.noUiSlider.updateOptions({ range: { min: 0, max: offsetMax } });
    }
    let lengthMax = (window.mdModel === "MKI") ? 32 : 64;
    const lengthSlider = document.getElementById("lengthRange_slider");
    if (lengthSlider && lengthSlider.noUiSlider) {
      lengthSlider.noUiSlider.updateOptions({ range: { min: 2, max: lengthMax } });
    }
    const patternLengthSlider = document.getElementById("patternLengthRange_slider");
    if (patternLengthSlider && patternLengthSlider.noUiSlider) {
      patternLengthSlider.noUiSlider.updateOptions({ range: { min: 2, max: lengthMax } });
    }
    let maxForModel;
    if (!window.mdUWEnabled) {
      maxForModel = 123;
    } else {
      maxForModel = (window.mdModel === "MKI") ? 163 : 191;
    }
    const machineAssignSlider = document.getElementById("machineAssignmentRange_slider");
    if (machineAssignSlider && machineAssignSlider.noUiSlider) {
      machineAssignSlider.noUiSlider.updateOptions({ range: { min: 0, max: maxForModel } });
    }
    let scaleMax = (window.mdModel === "MKI") ? 1 : 3;
    const scaleSlider = document.getElementById("scaleRange_slider");
    if (scaleSlider && scaleSlider.noUiSlider) {
      scaleSlider.noUiSlider.updateOptions({ range: { min: 0, max: scaleMax } });
    }
    const offsetInput = document.getElementById("offsetRange");
    if (offsetInput) {
      offsetInput.value = "0," + offsetMax;
      offsetInput.dataset.defaultValue = offsetInput.value;
    }
    const lengthInput = document.getElementById("lengthRange");
    if (lengthInput) {
      lengthInput.value = "2," + lengthMax;
      lengthInput.dataset.defaultValue = lengthInput.value;
    }
    const patternLengthInput = document.getElementById("patternLengthRange");
    if (patternLengthInput) {
      patternLengthInput.value = "2," + lengthMax;
      patternLengthInput.dataset.defaultValue = patternLengthInput.value;
    }
    const machineAssignInput = document.getElementById("machineAssignmentRange");
    if (machineAssignInput) {
      machineAssignInput.value = "0," + maxForModel;
      machineAssignInput.dataset.defaultValue = machineAssignInput.value;
    }
    const scaleInput = document.getElementById("scaleRange");
    if (scaleInput) {
      scaleInput.value = "0," + scaleMax;
      scaleInput.dataset.defaultValue = scaleInput.value;
    }
  }
  window.updateLabSliderRanges = updateLabSliderRanges;
  document.getElementById("mdModelSelect").addEventListener("change", updateLabSliderRanges);
  document.getElementById("uwToggleCheckbox").addEventListener("change", updateLabSliderRanges);

  window.addEventListener("load", function () {
    window.skipLabSliderReset = true;
   // const labUI = window.createLabUI();
    attachInputOverridesSongPanel();
    attachInputOverridesKitPanel();
    syncLabOverrideSliders();
  });



})();
