(() => {
  "use strict";

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  // ----------------------------
  // Panel switching
  // ----------------------------
  let activePanelId = "midi";

  function panelWantsFlex(panelEl, panelId) {
    if (!panelEl) return false;
    if (panelEl.dataset && panelEl.dataset.panelFlex === "true") return true;
    if (panelEl.classList.contains("panel--flex")) return true;
    if (panelId === "topic") return true;
    return false;
  }

  function syncEmbeddedTools(prevPanelId, nextPanelId) {
    // Skewclid
    try {
      if (prevPanelId === "skewclid" && nextPanelId !== "skewclid") {
        if (typeof window.hideEuclidOverlay === "function") window.hideEuclidOverlay();
        else {
          const el = document.getElementById("euclidOverlay");
          if (el) el.style.display = "none";
        }
      }
      if (nextPanelId === "skewclid") {
        if (typeof window.showEuclidOverlay === "function") window.showEuclidOverlay();
        else {
          const el = document.getElementById("euclidOverlay");
          if (el) el.style.display = "block";
        }
        try { window.preloadToneForSkewclid?.(); } catch (_) {}
      }
    } catch (e) {
      console.warn("[MDDTShell] Skewclid embed sync failed", e);
    }

    // Nodetrix
    try {
      if (prevPanelId === "nodetrix" && nextPanelId !== "nodetrix") {
        if (typeof window.closeSecretSequencer === "function") window.closeSecretSequencer();
        else if (typeof window.hideNodetrix === "function") window.hideNodetrix();
        else {
          const el = document.getElementById("secretSequencerOverlay");
          if (el) el.style.display = "none";
        }
      }
      if (nextPanelId === "nodetrix") {
        if (typeof window.openSecretSequencer === "function") window.openSecretSequencer();
        else {
          const el = document.getElementById("secretSequencerOverlay");
          if (el) el.style.display = "block";
        }
      }
    } catch (e) {
      console.warn("[MDDTShell] Nodetrix embed sync failed", e);
    }
  }

  function setActivePanel(panelId) {
    if (!panelId) return;
    const prevPanelId = activePanelId;
    activePanelId = panelId;
    window.activePanel = panelId;
    try {
      if (typeof window.uwPanelActive !== "undefined") {
        window.uwPanelActive = (panelId === "uw");
      }
    } catch (_) {}

    const buttons = qsa(".nav-btn[data-panel]");
    const panels = qsa(".panel[data-panel-id]");

    for (const btn of buttons) {
      const isActive = btn.dataset.panel === panelId;
      btn.classList.toggle("is-active", isActive);
      if (isActive) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }

    for (const panel of panels) {
      const isActive = panel.dataset.panelId === panelId;
      panel.classList.toggle("is-active", isActive);
      panel.style.display = isActive
        ? (panelWantsFlex(panel, panelId) ? "flex" : "block")
        : "none";
    }
    try {
      if (panelId === "lab") {
        const labMount = document.getElementById("labPanelContent");
        const hasLabUI = labMount && labMount.querySelector("#labContainer");
        if (!hasLabUI && typeof window.initLabPanel === "function") window.initLabPanel();
      }
      if (panelId === "uw") {
        const uwMount = document.getElementById("uwPanelContent");
        const hasUwUI = uwMount && uwMount.children && uwMount.children.length > 0;
        if (!hasUwUI && typeof window.initUwPanel === "function") window.initUwPanel();
      }
    } catch (e) {
      console.warn("Panel init error:", e);
    }
    syncEmbeddedTools(prevPanelId, panelId);

    window.SlotStrip?.renderIndicators?.();
  }

  function getActivePanel() {
    return activePanelId;
  }

  // ---------------------------------
  // System / MIDI modal
  // ---------------------------------
  function isModalOpen(modalEl) {
    return modalEl && modalEl.getAttribute("aria-hidden") === "false";
  }

  function openModal(modalEl) {
    if (!modalEl) return;
    modalEl.setAttribute("aria-hidden", "false");
    modalEl.classList.add("is-open");
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.setAttribute("aria-hidden", "true");
    modalEl.classList.remove("is-open");
  }

  function initSystemMidiModal() {
    const launcher = document.getElementById("systemMidiLauncher");
    const modal = document.getElementById("systemMidiModal");
    const closeX =
      document.getElementById("systemMidiCloseBtnX") ||
      document.getElementById("systemMidiCloseBtn2") ||
      document.getElementById("systemMidiCloseBtn");

    if (!modal) return;
    if (!modal.hasAttribute("aria-hidden")) modal.setAttribute("aria-hidden", "true");

    launcher?.addEventListener("click", () => openModal(modal));
    closeX?.addEventListener("click", () => closeModal(modal));

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal(modal);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isModalOpen(modal)) closeModal(modal);
    });
  }

  
// ---------------------------------
// System modal: Import/Export/Reset rollover hint
// ---------------------------------
function initSystemMidiImportExportHint() {
  const modal = document.getElementById("systemMidiModal");
  if (!modal) return;

  const systemCard = modal.querySelector(".system-card");
  if (!systemCard) return;

  const hintEl = systemCard.querySelector("p.hint");
  if (!hintEl) return;

  const defaultText = "Hover Import, Export, or Reset to see details.";
  const importText =
    "Import: Load data from JSON (.mddt/.json) or SysEx (.syx). " +
    "Import can include Globals, Kits, Patterns, Songs, and Samples.";
  const exportText =
    "Export: Save your data as JSON (.mddt/.json). " +
    "Export can include Globals, Kits, Patterns, Songs, and Samples.";
  const resetText =
    "Reset: Clears all loaded data (Globals, Kits, Patterns, Songs, Samples).";

  const setHint = (txt) => { hintEl.textContent = String(txt || ""); };

  setHint(defaultText);

  const bind = (btn, txt) => {
    if (!btn) return;
    const on = () => setHint(txt);
    const off = () => setHint(defaultText);
    btn.addEventListener("mouseenter", on);
    btn.addEventListener("focus", on);
    btn.addEventListener("mouseleave", off);
    btn.addEventListener("blur", off);
  };

  const importBtn =
    systemCard.querySelector("#importModalBtn") ||
    systemCard.querySelector('[onclick="showImportModal()"]');

  const exportBtn =
    systemCard.querySelector("#exportModalBtn") ||
    systemCard.querySelector('[onclick="showExportModal()"]');

  const resetBtn =
    systemCard.querySelector('[onclick="onClickResetMDDT()"]') ||
    Array.from(systemCard.querySelectorAll("button")).find((b) => (b.textContent || "").trim().toLowerCase() === "reset");

  bind(importBtn, importText);
  bind(exportBtn, exportText);
  bind(resetBtn, resetText);
}

// ---------------------------------
// Small UI ordering/styling tweaks
// ---------------------------------
function reorderSlotMetaFields() {
  // Kit: number first, then name
  const kitMeta = document.querySelector('.panel[data-panel-id="kit"] .kit-toolbar .kit-meta');
  if (kitMeta) {
    const kitNumber = kitMeta.querySelector(".kit-number");
    const kitName = kitMeta.querySelector(".kit-name");
    if (kitNumber && kitName) {
      kitMeta.insertBefore(kitNumber, kitName);
    }
  }

  // Song: number first, then name
  const songToolbar = document.querySelector('.panel[data-panel-id="song"] .song-toolbar');
  if (songToolbar) {
    const songNumber = songToolbar.querySelector(".song-number");
    const songName = songToolbar.querySelector(".song-name");
    if (songNumber && songName) {
      songToolbar.insertBefore(songNumber, songName);
    }
  }
}

function applyGlobalNumberBoxStyle() {
  const styleId = "mddt-global-number-display-box-style";
  if (document.getElementById(styleId)) return;

  const st = document.createElement("style");
  st.id = styleId;
  st.textContent = `
    .global-panel .global-number-display {
      display: inline-block;
      font-weight: 800;
      font-size: 16px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel-2);
      min-width: 3.6em;
      text-align: center;
      letter-spacing: normal;
    }
  `;
  document.head.appendChild(st);
}

// ---------------------------------
  // Import/Export
  // ---------------------------------
  
  window.disableImportExportButtons = function disableImportExportButtons(disable) {
    const exportBtn = document.getElementById("exportModalBtn") || qs('[onclick="showExportModal()"]');
    const importBtn = document.getElementById("importModalBtn") || qs('[onclick="showImportModal()"]');
    if (exportBtn) exportBtn.disabled = !!disable;
    if (importBtn) importBtn.disabled = !!disable;
  };

  function initNav() {
    const buttons = qsa(".nav-btn[data-panel]");
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const panelId = btn.dataset.panel;
        setActivePanel(panelId);
      });
    });
    const activeBtn = qs(".nav-btn.is-active[data-panel]") || buttons[0];
    if (activeBtn?.dataset?.panel) setActivePanel(activeBtn.dataset.panel);
  }


  // ----------------------------
  // Kit editor
  // ----------------------------

  function initKitEditor() {
    const kitEditor = qs('.panel[data-panel-id="kit"] .kit-editor[data-kit-editor]');
    if (!kitEditor) return;

    const tabbar = qs("[data-kit-tabs]", kitEditor);
    if (!tabbar) return;

    const tabs = qsa(".kit-tab[data-kit-tab]", tabbar);
    const panels = qsa(".kit-tabpanel[data-kit-tabpanel]", kitEditor);

    let activeKitTab = "overview";

    function setKitTab(tabId) {
      if (!tabId) return;

      activeKitTab = tabId;
      window.activeKitTab = tabId;

      for (const btn of tabs) {
        const isActive = btn.dataset.kitTab === tabId;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      }

      for (const panel of panels) {
        const isActive = panel.dataset.kitTabpanel === tabId;
        panel.classList.toggle("is-active", isActive);
      }

      if (typeof window.onKitTabChanged === "function") {
        try { window.onKitTabChanged(tabId); } catch (e) { /* ignore */ }
      }
    }

    tabs.forEach((btn) => {
      btn.addEventListener("click", () => setKitTab(btn.dataset.kitTab));
    });

    const initial =
      (tabs.find((t) => t.classList.contains("is-active")) || tabs[0])?.dataset?.kitTab;
    setKitTab(initial || "overview");

    window.MDDTShell = window.MDDTShell || {};
    window.MDDTShell.setKitTab = setKitTab;
    window.MDDTShell.getKitTab = () => activeKitTab;
  }

  window.MDDTShell = window.MDDTShell || {};
  window.MDDTShell.setActivePanel = setActivePanel;
  window.MDDTShell.getActivePanel = getActivePanel;

  document.addEventListener("DOMContentLoaded", () => {
    try {
      initNav();
      initSystemMidiModal();
      initSystemMidiImportExportHint();
      initKitEditor();
      reorderSlotMetaFields();
      applyGlobalNumberBoxStyle();
    } catch (e) {
      console.error("[MDDTShell] init failed", e);
    }
  });
})();
