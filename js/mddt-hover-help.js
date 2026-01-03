// mddt-hover-help.js

(function () {
  "use strict";

  const PANEL_BODY_ID = "hoverInfo";
  const INFO_PANEL_ID = "infoPanel";

  /** @type {HTMLElement|null} */
  const infoBody = document.getElementById(PANEL_BODY_ID);
  if (!infoBody) return;

  /** @type {Record<string, any>} */
  const registry = (window.MDDTHelpRegistry && typeof window.MDDTHelpRegistry === "object")
    ? window.MDDTHelpRegistry
    : {};

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  const escapeHtml = (s) => String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const isInModal = (el) => !!(el && el.closest && el.closest(".modal"));
  const isInInfoPanel = (el) => !!(el && el.closest && el.closest(`#${INFO_PANEL_ID}`));

  /**
   * @param {Element} el
   */
  function getReadableLabel(el) {
    if (!el) return "";

    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();

    if (el.tagName === "LABEL") {
      return (el.textContent || "").trim();
    }

    const id = el.getAttribute("id");
    if (id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl && lbl.textContent) return lbl.textContent.trim();
      } catch (_) {
        // CSS.escape isn't available in some older browsers; ignore.
      }
    }

    // Special-case <select>: avoid returning concatenated <option> text.
    if (el.tagName === "SELECT") {
      // Try associated label[for=id] (handled above) then wrapped <label>.
      try {
        const wrap = el.closest("label");
        if (wrap) {
          const clone = wrap.cloneNode(true);
          clone.querySelectorAll("select, option, input, textarea, button").forEach((n) => n.remove());
          const txt = (clone.textContent || "").replace(/\s+/g, " ").trim();
          if (txt) return txt;
        }
      } catch (_) {}

      const nm = el.getAttribute("name");
      if (nm) return nm.replace(/[\-_]+/g, " ").trim();
      if (id) return id.replace(/[\-_]+/g, " ").trim();
      return "Dropdown";
    }


    if (el.tagName === "BUTTON") {
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt) return txt;
    }

    const title = el.getAttribute("title");
    if (title) return title.trim();

    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // Help matching
  // ---------------------------------------------------------------------------

  const HELPABLE_SELECTOR = [
    "[data-help]",
    "[data-help-key]",
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    ".nav-btn",
    ".tool-button",
    ".pos-slider",
    ".pos-label",
    ".panel-header",
    ".slot-group-title",
    "h2",
    "h3",
    "h4",
    ".global-slot",
    ".kit-slot",
    ".pattern-slot",
    ".song-slot",
    ".kit-tab",
    ".kit-track-row td.shiftHover",
    "#trackOverviewUI th.shiftHover",
    "#trackOverviewUI td",
    "#masterFxTable th.shiftHover",
    "#masterFxTable .mfx-slider",
    ".knob-range",
    ".pattern-global-btn",
    ".pattern-track-label",
    ".pattern-step-cell",
    ".pattern-step-num",
    ".plock-row-header",
    ".plock-row button",
    ".plock-row select",
    ".plock-row input[type=\"range\"]",
    ".song-row-index",
    "#songTable th.shiftHover",
    ".uw-slot-item",
    ".uw-tile-play"
  ].join(",");

  /**
   * @param {EventTarget|null} target
   * @returns {Element|null}
   */
  function findHelpAnchor(target) {
    if (!(target instanceof Element)) return null;
    if (isInInfoPanel(target)) return null;
    if (isInModal(target)) return null;

    const sliderHandle = target.closest?.(".noUi-handle");
    if (sliderHandle) {
      const slider = sliderHandle.closest?.(".pos-slider");
      if (slider) return slider;
    }

    const anchor = target.closest?.(HELPABLE_SELECTOR) || null;
    if (!anchor) return null;
    if (isInModal(anchor)) return null;
    if (isInInfoPanel(anchor)) return null;
    return anchor;
  }

  /**
   * Compute a registry key + context for a given anchor element.
   * @param {Element} el
   */
  function computeKeyAndCtx(el) {
    /** @type {any} */
    const ctx = { el };

    if (el.closest && el.closest(".slot-group-info")) {
      return { key: "app:info", ctx };
    }

    // Explicit override
    const explicitKey = el.getAttribute("data-help-key") || el.getAttribute("data-helpKey");
    if (explicitKey) {
      return { key: String(explicitKey), ctx };
    }

    // Slots (top strip)
    if (el.classList.contains("global-slot")) {
      const idx = parseInt(el.getAttribute("data-idx") || "", 10);
      ctx.slotType = "global";
      ctx.slotIndex = Number.isFinite(idx) ? idx : undefined;
      ctx.slotLabel = (el.textContent || "").trim();
      ctx.isFilled = el.classList.contains("filled");
      return { key: "slot:global", ctx };
    }
    if (el.classList.contains("kit-slot")) {
      const idx = parseInt(el.getAttribute("data-idx") || "", 10);
      ctx.slotType = "kit";
      ctx.slotIndex = Number.isFinite(idx) ? idx : undefined;
      ctx.slotLabel = (el.textContent || "").trim();
      ctx.isFilled = el.classList.contains("filled");
      return { key: "slot:kit", ctx };
    }
    if (el.classList.contains("pattern-slot")) {
      const idx = parseInt(el.getAttribute("data-idx") || "", 10);
      ctx.slotType = "pattern";
      ctx.slotIndex = Number.isFinite(idx) ? idx : undefined;
      ctx.slotLabel = (el.textContent || "").trim();
      ctx.isFilled = el.classList.contains("filled");
      return { key: "slot:pattern", ctx };
    }
    if (el.classList.contains("song-slot")) {
      const idx = parseInt(el.getAttribute("data-idx") || "", 10);
      ctx.slotType = "song";
      ctx.slotIndex = Number.isFinite(idx) ? idx : undefined;
      ctx.slotLabel = (el.textContent || "").trim();
      ctx.isFilled = el.classList.contains("filled");
      return { key: "slot:song", ctx };
    }

    // Nav
    if (el.classList.contains("nav-btn") && el.getAttribute("data-panel")) {
      ctx.panel = el.getAttribute("data-panel");
      return { key: `nav:${ctx.panel}`, ctx };
    }

    // Panel headers: map to the same help as the corresponding nav item.
    if (el.classList.contains("panel-header")) {
      const panelSection = el.closest?.("section[data-panel-id]");
      const panelId = panelSection?.getAttribute?.("data-panel-id") || "";
      if (panelId) return { key: `nav:${panelId}`, ctx };
    }

    // Tools: buttons (Receive/Send/SlotOps)
    if (el.classList.contains("tool-button")) {
      const scope = el.getAttribute("data-pulse-scope") ||
        (el.closest(".tools-col-receive") ? "receive" : el.closest(".tools-col-send") ? "send" : el.closest(".tools-col-reset") ? "slotops" : "");
      const target = el.getAttribute("data-pulse-target") || (el.textContent || "").trim().toLowerCase();
      if (scope && target) return { key: `tools:${scope}:${target}`, ctx };
    }

    // Tools: GKPS checkbox labels / inputs
    if (el.tagName === "INPUT" && el.getAttribute("type") === "checkbox") {
      const id = el.getAttribute("id") || "";
      if (/^(recvCheck|sendCheck|resetCheck)[GKPS]$/.test(id)) {
        return { key: "tools:gkps:checkbox", ctx };
      }
    }
    if (el.tagName === "LABEL") {
      const cb = el.querySelector('input[type="checkbox"]');
      if (cb) {
        const id = cb.getAttribute("id") || "";
        if (/^(recvCheck|sendCheck|resetCheck)[GKPS]$/.test(id)) {
          return { key: "tools:gkps:checkbox", ctx };
        }
      }
    }

    // Tools: position sliders
    if (el.classList.contains("pos-slider") && el.id) {
      const suffix = el.id.replace(/^slider-/, "");
      return { key: `tools:position:${suffix}`, ctx };
    }

    // Kit tabs
    if (el.classList.contains("kit-tab") && el.getAttribute("data-kit-tab")) {
      const tab = el.getAttribute("data-kit-tab");
      return { key: `kit:tab:${tab}`, ctx };
    }

    // Kit overview track cell (first column)
    if (el.closest("#trackOverviewUI") && el.tagName === "TD" && el.classList.contains("shiftHover")) {
      const tr = el.closest("tr.kit-track-row");
      const t = tr ? parseInt(tr.getAttribute("data-track-index") || tr.dataset.trackIndex || "", 10) : NaN;
      ctx.track = Number.isFinite(t) ? t : undefined;
      return { key: "kit:trackOverview:trackCell", ctx };
    }

    // Kit overview column headers
    if (el.closest("#trackOverviewUI") && el.tagName === "TH" && el.classList.contains("shiftHover")) {
      ctx.column = (el.textContent || "").trim();
      return { key: "kit:trackOverview:colHeader", ctx };
    }

    // Kit overview controls (Machine dropdown, Level slider, etc.)
    if (el.closest("#trackOverviewUI") && (el.tagName === "SELECT" || el.tagName === "INPUT" || el.tagName === "BUTTON")) {
      const td = el.closest("td");
      const tr = el.closest("tr.kit-track-row");
      const table = el.closest("table");
      if (td && tr && table && !td.classList.contains("shiftHover")) {
        const colIndex = td.cellIndex;
        const th = table.querySelector(`thead th:nth-child(${colIndex + 1})`);
        ctx.column = (th?.textContent || "").trim();
        const t = parseInt(tr.getAttribute("data-track-index") || tr.dataset.trackIndex || "", 10);
        ctx.track = Number.isFinite(t) ? t : undefined;
        ctx.colIndex = colIndex;
        return { key: "kit:trackOverview:control", ctx };
      }
    }


    // Master FX block headers
    if (el.closest("#masterFxTable") && el.tagName === "TH" && el.classList.contains("shiftHover")) {
      return { key: "kit:masterfx:blockHeader", ctx };
    }

    // Master FX sliders
    if (el.classList.contains("mfx-slider") || (el.closest("#masterFxTable") && el.tagName === "INPUT" && el.getAttribute("type") === "range")) {
      const td = el.closest("td");
      const lbl = td?.querySelector?.(".mfx-label")?.textContent;
      ctx.paramLabel = (lbl || "").trim() || undefined;
      return { key: "kit:masterfx:slider", ctx };
    }

    // Kit knobs in the three knob grids
    if (el.classList.contains("knob-range") || (el.tagName === "INPUT" && el.getAttribute("type") === "range" && el.closest("#machineParamsUI, #trackFxUI, #routingUI"))) {
      const td = el.closest("td");
      const tr = el.closest("tr.kit-track-row");
      const block = td?.getAttribute("data-block") || undefined;
      const pIdx = td ? parseInt(td.getAttribute("data-param-index") || "", 10) : NaN;
      const track = tr ? parseInt(tr.getAttribute("data-track-index") || tr.dataset.trackIndex || "", 10) : NaN;
      const label = td?.querySelector?.(".param-label")?.textContent || "";

      ctx.block = block;
      ctx.paramIndex = Number.isFinite(pIdx) ? pIdx : undefined;
      ctx.track = Number.isFinite(track) ? track : undefined;
      ctx.paramLabel = label.trim() || undefined;
      return { key: "kit:knob", ctx };
    }

    // Pattern: global toggle buttons
    if (el.classList.contains("pattern-global-btn")) {
      return { key: "pattern:globalToggle", ctx };
    }

    // Pattern: track label
    if (el.classList.contains("pattern-track-label")) {
      const trackDiv = el.closest(".pattern-track-row");
      const t = trackDiv ? parseInt(trackDiv.getAttribute("data-track-index") || "", 10) : NaN;
      ctx.track = Number.isFinite(t) ? t : undefined;
      return { key: "pattern:trackLabel", ctx };
    }

    // Pattern: step number row
    if (el.classList.contains("pattern-step-num")) {
      const stepTitle = el.getAttribute("title") || "";
      const match = stepTitle.match(/Step\s+(\d+)/i);
      if (match) ctx.step = parseInt(match[1], 10) - 1;
      return { key: "pattern:stepNumber", ctx };
    }

    // Pattern: step cells
    if (el.classList.contains("pattern-step-cell")) {
      const stepTitle = el.getAttribute("title") || "";
      const match = stepTitle.match(/step\s+(\d+)/i);
      if (match) ctx.step = parseInt(match[1], 10) - 1;

      const row = el.closest("tr");
      const hdr = row?.querySelector?.("td")?.textContent || "";
      ctx.field = hdr.trim() || undefined;

      return { key: "pattern:stepCell", ctx };
    }

    // Pattern: row header (Trig/Acc/Swng/Sld) and Step#
    if (el.closest("#bitfieldsUI") && el.tagName === "TD") {
      const txt = (el.textContent || "").trim();
      if (txt === "Step#") return { key: "pattern:stepHeader", ctx };
      if (txt === "Trig" || txt === "Acc" || txt === "Swng" || txt === "Sld") {
        ctx.field = txt;
        return { key: "pattern:rowHeader", ctx };
      }
    }

    // Pattern: locks scroller
    if (el.classList.contains("plock-row-header")) {
      return { key: "pattern:lockRowHeader", ctx };
    }
    if (el.closest(".plock-row")) {
      if (el.tagName === "SELECT" || (el.tagName === "INPUT" && el.getAttribute("type") === "range") || (el.tagName === "BUTTON" && (el.textContent || "").trim() === "X")) {
        return { key: "pattern:lockCell", ctx };
      }
      if (el.tagName === "BUTTON" && (((el.textContent || "").trim() === "+Param") || ((el.textContent || "").trim() === "DelRow"))) {
        return { key: "pattern:lockRowHeader", ctx };
      }
    }

    // Song: row index cell
    if (el.classList.contains("song-row-index")) {
      const idx = parseInt(el.getAttribute("data-index") || "", 10);
      ctx.row = Number.isFinite(idx) ? idx : undefined;
      return { key: "song:rowIndex", ctx };
    }

    // Song: header cells
    if (el.closest("#songTable") && el.tagName === "TH" && el.classList.contains("shiftHover")) {
      ctx.column = (el.textContent || "").trim();
      return { key: "song:header", ctx };
    }

    // Song: controls inside table body cells (Pattern/Reps/Offset/Length/BPM/Mutes)
    if (el.closest("#songTable") && el.closest("tbody")) {
      const td = el.closest("td");
      const tr = el.closest("tr");
      const table = el.closest("table");
      if (td && tr && table && !td.classList.contains("song-row-index")) {
        const colIndex = td.cellIndex;
        const th = table.querySelector(`thead th:nth-child(${colIndex + 1})`);
        ctx.column = (th?.textContent || "").trim();
        const r = parseInt(tr.dataset.rowIndex || tr.getAttribute("data-row-index") || "", 10);
        ctx.row = Number.isFinite(r) ? r : undefined;
        ctx.colIndex = colIndex;
        return { key: "song:cell", ctx };
      }
    }


    // UW: tile
    if (el.classList.contains("uw-slot-item")) {
      const idx = parseInt(el.getAttribute("data-slot-index") || "", 10);
      ctx.slotIndex = Number.isFinite(idx) ? idx : undefined;
      return { key: "uw:slotTile", ctx };
    }
    if (el.classList.contains("uw-tile-play")) {
      return { key: "uw:tilePlay", ctx };
    }

    // Fall back to element id.
    const id = el.getAttribute("id");
    if (id) {
      ctx.id = id;
      return { key: `#${id}`, ctx };
    }

    return { key: "", ctx };
  }

  /**
   * @param {any} entry
   * @param {any} ctx
   */
  function materializeEntry(entry, ctx) {
    if (!entry) return null;
    if (typeof entry === "function") {
      try {
        return entry(ctx);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Help entry error", e);
        return {
          title: "Help error",
          body: "This help entry threw an exception. See console for details.",
          actions: []
        };
      }
    }
    if (typeof entry === "string") {
      return { body: entry };
    }
    if (typeof entry === "object") {
      return entry;
    }
    return null;
  }

  /**
   * Honest fallback help when no registry entry exists.
   * @param {Element} el
   */
  function autoEntry(el) {
    const label = getReadableLabel(el);
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute && el.getAttribute("type")) ? String(el.getAttribute("type")) : "";

    let title = label || (tag ? tag.toUpperCase() : "Control");
    if (type) title = `${title} (${type})`;

    let body = "";
    if (tag === "input" && type === "range") body = "Drag to change the value.";
    else if (tag === "select") body = "Choose a value from the dropdown.";
    else if (tag === "input" && (type === "checkbox" || type === "radio")) body = "Toggle this option.";
    else if (tag === "input") body = "Type a value.";
    else if (tag === "button") body = "Click to activate.";

    return { title, body };
  }

  /**
   * Render help into the INFO panel.
   * @param {{title?:string, body?:string, actions?:Array<{keys:string, does:string}>, notes?:string[]}} entry
   */
  function render(entry) {
    if (!entry) return;

    const title = entry.title ? `<div class="mddt-help-title">${escapeHtml(entry.title)}</div>` : "";
    const body = entry.body ? `<div class="mddt-help-body">${escapeHtml(entry.body)}</div>` : "";

    let actions = "";
    if (Array.isArray(entry.actions) && entry.actions.length) {
      const items = entry.actions
        .map(a => {
          const kRaw = (a && a.keys != null) ? String(a.keys) : "";
          const dRaw = (a && a.does != null) ? String(a.does) : "";
          let k = kRaw;
          // Ensure a visible separator between the "keys" and "does" spans.
          // If the registry author already included trailing whitespace (or a colon+space),
          // keep it. Otherwise, append " : " (or ": " if a colon is already present).
          if (k && !/\s$/.test(k)) {
            k += (/[：:]$/.test(k) ? " " : " : ");
          }
          return `<li><span class="mddt-help-keys">${escapeHtml(k)}</span><span class="mddt-help-does">${escapeHtml(dRaw)}</span></li>`;
        })
        .join("");
      actions = `<ul class="mddt-help-actions">${items}</ul>`;
    }

    let notes = "";
    if (Array.isArray(entry.notes) && entry.notes.length) {
      const items = entry.notes.map(n => `<li>${escapeHtml(n)}</li>`).join("");
      notes = `<ul class="mddt-help-notes">${items}</ul>`;
    }

    infoBody.innerHTML = `${title}${body}${actions}${notes}`;
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  let currentAnchor = null;
  let currentKey = "";

  function updateFromElement(el) {
    const anchor = findHelpAnchor(el);
    if (!anchor) return;
    if (anchor === currentAnchor) return;
    currentAnchor = anchor;

    const { key, ctx } = computeKeyAndCtx(anchor);
    currentKey = key;

    // Inline data-help overrides everything.
    const inline = anchor.getAttribute("data-help");
    if (inline) {
      render({ title: getReadableLabel(anchor) || undefined, body: String(inline) });
      return;
    }

    const entryRaw = key ? registry[key] : null;
    const entry = materializeEntry(entryRaw, ctx) || autoEntry(anchor);
    render(entry);
  }

  // Pointer hover
  document.addEventListener("pointerover", (ev) => updateFromElement(ev.target), { capture: true });

  // Keyboard focus
  document.addEventListener("focusin", (ev) => updateFromElement(ev.target), { capture: true });

  // Small dev API (authoring help text)
  window.MDDTHoverHelp = {
    showKey(key) {
      const raw = registry[key];
      const entry = materializeEntry(raw, { el: document.body }) || null;
      if (entry) render(entry);
    },
    audit() {
      const els = Array.from(document.querySelectorAll(HELPABLE_SELECTOR))
        .filter(el => !isInModal(el) && !isInInfoPanel(el));

      /** @type {Array<{key:string,label:string,tag:string,id?:string}>} */
      const missing = [];

      els.forEach(el => {
        const { key } = computeKeyAndCtx(el);
        if (!key) return;
        if (registry[key]) return;
        missing.push({
          key,
          label: getReadableLabel(el),
          tag: el.tagName.toLowerCase(),
          id: el.getAttribute("id") || undefined
        });
      });

      // eslint-disable-next-line no-console
      console.table(missing);
      return missing;
    },
    get currentKey() { return currentKey; }
  };

  // Initial default content
  if (registry["app:info"]) {
    render(materializeEntry(registry["app:info"], { el: document.body }));
  }
})();
