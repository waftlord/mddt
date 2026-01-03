(() => {
  "use strict";

  const dirty = new Set();
  const busySend = new Set();
  const busyRecv = new Set();

  function getElByUiSlotId(uiSlotId) {
    const mapping = window.MDDTSlotMap?.parseUiSlotId(uiSlotId);
    if (!mapping) return null;
    return window.MDDTSlotMap?.getSlotEl(mapping) || null;
  }

  function applyClasses(uiSlotId) {
    const el = getElByUiSlotId(uiSlotId);
    if (!el) return;

    const isDirty = dirty.has(uiSlotId);
    const isSend = busySend.has(uiSlotId);
    const isRecv = busyRecv.has(uiSlotId);
    const isBusy = isSend || isRecv;

    el.classList.toggle("is-dirty", isDirty);
    el.classList.toggle("is-busy", isBusy);
    el.classList.toggle("is-busy-send", isSend);
    el.classList.toggle("is-busy-recv", isRecv);
  }

  function renderIndicators() {
    for (const id of dirty) applyClasses(id);
    for (const id of busySend) applyClasses(id);
    for (const id of busyRecv) applyClasses(id);
  }

  function setDirty(uiSlotId, value) {
    if (!uiSlotId) return;
    if (value) dirty.add(uiSlotId); else dirty.delete(uiSlotId);
    applyClasses(uiSlotId);
  }

  function setBusy(uiSlotId, direction, value) {
    if (!uiSlotId) return;
    const set = direction === "send" ? busySend : busyRecv;
    if (value) set.add(uiSlotId); else set.delete(uiSlotId);
    applyClasses(uiSlotId);
  }

  function clearAll() {
    for (const id of dirty) {
      dirty.delete(id);
      const el = getElByUiSlotId(id);
      if (el) el.classList.remove("is-dirty");
    }
    for (const id of busySend) {
      busySend.delete(id);
      const el = getElByUiSlotId(id);
      if (el) el.classList.remove("is-busy", "is-busy-send");
    }
    for (const id of busyRecv) {
      busyRecv.delete(id);
      const el = getElByUiSlotId(id);
      if (el) el.classList.remove("is-busy", "is-busy-recv");
    }
  }

  function installBusListeners() {
    if (!window.UIBus) return;

    window.UIBus.on("slot:dirty", (m) => {
      setDirty(m?.uiSlotId, true);
    });
    window.UIBus.on("slot:clean", (m) => {
      setDirty(m?.uiSlotId, false);
    });
    window.UIBus.on("transport:sendStart", (m) => {
      setBusy(m?.uiSlotId, "send", true);
    });
    window.UIBus.on("transport:sendEnd", (m) => {
      setBusy(m?.uiSlotId, "send", false);
    });
    window.UIBus.on("transport:receiveStart", (m) => {
      setBusy(m?.uiSlotId, "receive", true);
    });
    window.UIBus.on("transport:receiveEnd", (m) => {
      setBusy(m?.uiSlotId, "receive", false);
    });
  }

  function installDomObserver() {
    const root = document.querySelector(".top-slots")
      || document.getElementById("slotStrip")
      || document.body;
    if (!root || typeof MutationObserver === "undefined") return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderIndicators();
      });
    };

    const obs = new MutationObserver(schedule);
    obs.observe(root, { childList: true, subtree: true });
    const uwList = document.getElementById("uwSlotsList");
    if (uwList) {
      const obsUw = new MutationObserver(schedule);
      obsUw.observe(uwList, { childList: true, subtree: true });
    }
  }

  window.SlotStrip = {
    renderIndicators,
    setDirty,
    setBusy,
    clearAll,
    _state: { dirty, busySend, busyRecv },
  };

  document.addEventListener("DOMContentLoaded", () => {
    try {
      installBusListeners();
      installDomObserver();
      renderIndicators();
    } catch (e) {
      console.error("[SlotStrip] init failed", e);
    }
  });
})();
