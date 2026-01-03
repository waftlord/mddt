(() => {
  "use strict";

  const listeners = new Map();

  function on(eventName, handler) {
    if (typeof handler !== "function") return () => {};
    const set = listeners.get(eventName) || new Set();
    set.add(handler);
    listeners.set(eventName, set);
    return () => off(eventName, handler);
  }

  function off(eventName, handler) {
    const set = listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (!set.size) listeners.delete(eventName);
  }

  function emit(eventName, payload) {
    const set = listeners.get(eventName);
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
        } catch (err) {
          console.warn(`[UIBus] listener error for ${eventName}`, err);
        }
      }
    }
    const wild = listeners.get("*");
    if (wild) {
      for (const fn of Array.from(wild)) {
        try {
          fn(eventName, payload);
        } catch (err) {
          console.warn(`[UIBus] wildcard listener error for ${eventName}`, err);
        }
      }
    }
  }

  window.UIBus = {
    on,
    off,
    emit,
    _listeners: listeners,
  };
})();
