// mddt-hover-help-registry.js

(function () {
  "use strict";

  /**
   * @typedef {{keys:string, does:string}} HelpAction
   * @typedef {{title?:string, body?:string, actions?:HelpAction[], notes?:string[]}} HelpEntry
   */

  /** @type {Record<string, HelpEntry | ((ctx:any)=>HelpEntry)>} */
  const REGISTRY = {
    // ---------------------------------------------------------------------
    // App chrome
    // ---------------------------------------------------------------------
    "app:info": {
      title: "INFO panel",
      body: "Hover (or focus) any control to see what it does. This panel is your in-context user guide.",
      actions: [
        { keys: "Hover / Focus : ", does: "Show help for the UI element under your pointer / keyboard focus." },
        { keys: "Shift / Cmd / Ctrl : ", does: "If a control has modifier actions, they are listed here." },
        { keys: "Dev : ", does: "Run MDDTHoverHelp.audit() in the console to list missing help entries." }
      ]
    },

    "#systemMidiLauncher": {
      title: "System / MIDI",
      body: "Open System + MIDI settings (model/OS, MIDI in/out selection, bulk delay, import/export).",
      actions: [
        { keys: "Click : ", does: "Open the System / MIDI dialog." }
      ]
    },

    // ---------------------------------------------------------------------
    // Left nav + panel headers
    // ---------------------------------------------------------------------
    "nav:midi": { title: "Tools panel", body: "Bulk Receive/Send, slot clipboard actions, and position ranges." },
    "nav:kit": { title: "Kit panel", body: "Edit Kit tracks, synthesis params, FX, routing, and Master FX." },
    "nav:pattern": { title: "Pattern panel", body: "Edit pattern length/scale/swing/accent and per-track trig/locks." },
    "nav:song": { title: "Song panel", body: "Edit song rows (pattern, repeats, offsets, mutes) and row operations." },
    "nav:global": { title: "Global panel", body: "Edit Machinedrum Global settings and sync options." },
    "nav:uw": { title: "UW panel", body: "Manage UW sample slots, preview audio, and edit sample parameters." },
    "nav:lab": { title: "Lab panel", body: "Experimental utilities and tools." },
    "nav:skewclid": { title: "Skewclid", body: "Euclidean/step tools." },
    "nav:nodetrix": { title: "Nodetrix", body: "Graph-based / node tools (experimental)." },
    "nav:help": { title: "About", body: "License and other info" },

    // ---------------------------------------------------------------------
    // Slot strip (top)
    // ---------------------------------------------------------------------
    "slot:global": (ctx) => ({
      title: `Global slot ${ctx.slotLabel || ""}`.trim(),
      body: "Local Global library slot (1–8).",
      actions: [
        { keys: "Click", does: "Load this slot into the Global editor (or load DEFAULT if empty)." },
        { keys: "Shift+Click", does: "Save the current Global buffer into this slot (confirm before overwrite)." },
        { keys: "Drag", does: "Swap slots (reorder the local library)." }
      ]
    }),

    "slot:kit": (ctx) => ({
      title: `Kit slot ${ctx.slotLabel || ""}`.trim(),
      body: "Local Kit library slot (1–64).",
      actions: [
        { keys: "Click", does: "Load this slot into the Kit editor (or load DEFAULT if empty)." },
        { keys: "Shift+Click", does: "Save the current Kit buffer into this slot (confirm before overwrite)." },
        { keys: "Drag", does: "Swap slots (reorder the local library)." }
      ]
    }),

    "slot:pattern": (ctx) => ({
      title: `Pattern slot ${ctx.slotLabel || ""}`.trim(),
      body: "Local Pattern library slot (A01–H16).",
      actions: [
        { keys: "Click", does: "Load this pattern slot (or load DEFAULT if empty)." },
        { keys: "Shift+Click", does: "Save the current Pattern buffer into this slot (confirm before overwrite)." },
        { keys: "Drag", does: "Swap pattern slots (also updates Song references when needed)." }
      ]
    }),

    "slot:song": (ctx) => ({
      title: `Song slot ${ctx.slotLabel || ""}`.trim(),
      body: "Local Song library slot (1–32).",
      actions: [
        { keys: "Click", does: "Load this song slot (or load DEFAULT if empty)." },
        { keys: "Shift+Click", does: "Save the current Song buffer into this slot (confirm before overwrite)." },
        { keys: "Drag", does: "Swap song slots (reorder the local library)." }
      ]
    }),

    // ---------------------------------------------------------------------
    // Tools panel
    // ---------------------------------------------------------------------
    "tools:position:globals": {
      title: "Position range — Globals",
      body: "Select the Global slot range used by bulk operations (Receive ALL / Send ALL) and slot clipboard actions.",
      actions: [
        { keys: "Drag handles", does: "Set From/To range." }
      ]
    },
    "tools:position:kits": {
      title: "Position range — Kits",
      body: "Select the Kit slot range used by bulk operations (Receive ALL / Send ALL) and slot clipboard actions.",
      actions: [
        { keys: "Drag handles", does: "Set From/To range." }
      ]
    },
    "tools:position:patterns": {
      title: "Position range — Patterns",
      body: "Select the Pattern slot range used by bulk operations (Receive ALL / Send ALL) and slot clipboard actions.",
      actions: [
        { keys: "Drag handles", does: "Set From/To range (A01–H16)." }
      ]
    },
    "tools:position:songs": {
      title: "Position range — Songs",
      body: "Select the Song slot range used by bulk operations (Receive ALL / Send ALL) and slot clipboard actions.",
      actions: [
        { keys: "Drag handles", does: "Set From/To range." }
      ]
    },

    "tools:receive:all": {
      title: "Receive ALL",
      body: "Bulk receive from the Machinedrum into the local slot libraries, using the checked categories (G/K/P/S) and the Position ranges.",
      actions: [
        { keys: "Click", does: "Start bulk Receive for selected categories and ranges." },
        { keys: "Cancel", does: "Use the Cancel button that appears to stop the current bulk Receive." }
      ]
    },

    "tools:send:all": {
      title: "Send ALL",
      body: "Bulk send local slot libraries to the Machinedrum, using the checked categories (G/K/P/S) and the Position ranges.",
      actions: [
        { keys: "Click", does: "Start bulk Send for selected categories and ranges." },
        { keys: "Cancel", does: "Use the Cancel button that appears to stop the current bulk Send." }
      ]
    },

    "tools:receive:globals": {
      title: "Receive — Global",
      body: "Request a single Global dump from the Machinedrum. Uses the *From* value in the Globals Position range.",
      actions: [
        { keys: "Click", does: "Request one Global slot and store it in the local Global library." },
        { keys: "Tip", does: "To receive a *range*, use Receive ALL with only G checked." }
      ]
    },
    "tools:receive:kits": {
      title: "Receive — Kit",
      body: "Request a single Kit dump from the Machinedrum. Uses the *From* value in the Kits Position range.",
      actions: [
        { keys: "Click", does: "Request one Kit slot and store it in the local Kit library." },
        { keys: "Tip", does: "To receive a *range*, use Receive ALL with only K checked." }
      ]
    },
    "tools:receive:patterns": {
      title: "Receive — Pattern",
      body: "Request a single Pattern dump from the Machinedrum. Uses the *From* value in the Patterns Position range.",
      actions: [
        { keys: "Click", does: "Request one Pattern slot and store it in the local Pattern library." },
        { keys: "Tip", does: "To receive a *range*, use Receive ALL with only P checked." }
      ]
    },
    "tools:receive:songs": {
      title: "Receive — Song",
      body: "Request a single Song dump from the Machinedrum. Uses the *From* value in the Songs Position range.",
      actions: [
        { keys: "Click", does: "Request one Song slot and store it in the local Song library." },
        { keys: "Tip", does: "To receive a *range*, use Receive ALL with only S checked." }
      ]
    },

    "tools:send:globals": {
      title: "Send — Global",
      body: "Send the current Global buffer to the Machinedrum Global slot, then trigger a load of that slot.",
      actions: [
        { keys: "Click", does: "Write current Global buffer to MD (prompts before overwrite)." }
      ]
    },
    "tools:send:kits": {
      title: "Send — Kit",
      body: "Send the current Kit buffer to the Machinedrum Kit slot. Uses the *From* value in the Kits Position range.",
      actions: [
        { keys: "Click", does: "Write current Kit buffer to MD (prompts before overwrite)." },
        { keys: "Tip", does: "To send a *range*, use Send ALL with only K checked." }
      ]
    },
    "tools:send:patterns": {
      title: "Send — Pattern",
      body: "Send the current Pattern buffer to the Machinedrum pattern number selected in the Pattern panel.",
      actions: [
        { keys: "Click", does: "Write current Pattern buffer to MD (prompts before overwrite)." }
      ]
    },
    "tools:send:songs": {
      title: "Send — Song",
      body: "Send the current Song buffer to the Machinedrum Song slot. Uses the *From* value in the Songs Position range.",
      actions: [
        { keys: "Click", does: "Write current Song buffer to MD (prompts before overwrite)." },
        { keys: "Tip", does: "To send a *range*, use Send ALL with only S checked." }
      ]
    },

    "tools:send:firmware": {
      title: "Firmware",
      body: "Open the Firmware update tools.",
      actions: [
        { keys: "Click", does: "Open the Firmware modal." }
      ]
    },

    "tools:slotops:copy": {
      title: "Slots — Copy",
      body: "Copy the selected slot categories (G/K/P/S) and their Position ranges into the internal clipboard.",
      actions: [
        { keys: "Click", does: "Copy selected ranges into clipboard." }
      ]
    },
    "tools:slotops:paste": {
      title: "Slots — Paste",
      body: "Paste the internal clipboard into the selected destination ranges. Will prompt before overwriting filled slots.",
      actions: [
        { keys: "Click", does: "Paste clipboard into selected ranges (repeats if destination is larger)." }
      ]
    },
    "tools:slotops:clear": {
      title: "Slots — Clear",
      body: "Clear (delete) filled slots inside the selected categories + ranges. Clipboard is not changed.",
      actions: [
        { keys: "Click", does: "Clear filled slots in selected ranges (prompts if anything will be deleted)." }
      ]
    },

    "tools:gkps:checkbox": {
      title: "G / K / P / S checkboxes",
      body: "Choose which categories are included in a bulk operation or slot clipboard action.",
      actions: [
        { keys: "Click", does: "Toggle a category." },
        { keys: "Shift+Click", does: "Apply this checkbox state to the whole group (all G/K/P/S in this row)." }
      ]
    },

    // ---------------------------------------------------------------------
    // Kit editor
    // ---------------------------------------------------------------------
    "#kitNameInput": {
      title: "Kit name",
      body: "Name for the current Kit buffer (max 10 chars).",
      actions: [
        { keys: "Type", does: "Rename the Kit in the local buffer." }
      ]
    },

    "kit:tab:overview": { title: "Kit tab — Overview", body: "Track list + machine selection + LFO routing overview." },
    "kit:tab:synthesis": { title: "Kit tab — Synthesis", body: "Per-track synthesis (machine) parameters." },
    "kit:tab:effects": { title: "Kit tab — Effects", body: "Per-track FX parameters." },
    "kit:tab:routing": { title: "Kit tab — Routing", body: "Per-track routing / mix parameters." },
    "kit:tab:masterfx": { title: "Kit tab — Master FX", body: "Master FX blocks (Rhythm Echo, Gate Box, EQ, Dynamix)." },

    "kit:trackOverview:trackCell": {
      title: "Kit track row",
      body: "Select a track row. Drag to reorder tracks (swap track data).",
      actions: [
        { keys: "Click", does: "Select this track." },
        { keys: "Shift+Click", does: "Randomize this entire track (machine + params + routing)." },
        { keys: "Drag", does: "Swap track data with another track." },
        { keys: "Cmd/Ctrl+C", does: "Copy selected track (Kit panel)." },
        { keys: "Cmd/Ctrl+X", does: "Cut selected track (stores copy, clears track)." },
        { keys: "Cmd/Ctrl+V", does: "Paste into selected track." },
        { keys: "Cmd/Ctrl+Z", does: "Undo last cut/paste/move (Kit panel)." }
      ]
    },

    "kit:trackOverview:colHeader": (ctx) => ({
      title: `Kit Overview column — ${ctx.column || ""}`.trim(),
      body: "Column-wide actions in the Kit Overview table.",
      actions: [
        { keys: "Click", does: "Reset this column for all 16 tracks." },
        { keys: "Shift+Click", does: "Randomize this column for all 16 tracks." }
      ]
    }),

    "kit:trackOverview:control": (ctx) => {
      const col = (ctx.column || "").trim();
      const trackNum = Number.isFinite(ctx.track) ? (ctx.track + 1) : null;

      const title = col
        ? `${col}${trackNum ? ` (Track ${trackNum})` : ""}`
        : (trackNum ? `Track ${trackNum}` : "Kit Overview");

      let body = "Edit this value for the selected track.";
      /** @type {HelpAction[]} */
      let actions = [];

      switch (col) {
        case "Machine":
          body = "Select machine from dropdown.";
          actions = [{ keys: "Click", does: "Choose a machine for this track." }];
          break;
        case "Tonal":
          body = "Toggle tonal mode (if supported by the machine).";
          actions = [{ keys: "Click", does: "Enable/disable tonal mode." }];
          break;
        case "Level":
          body = "Set track level (0–127).";
          actions = [{ keys: "Drag", does: "Adjust level." }];
          break;
        case "MutePos":
          body = "Select Mute position (or “--” to disable).";
          actions = [{ keys: "Click", does: "Choose a position." }];
          break;
        case "TrigPos":
          body = "Select Trig position (or “--” to disable).";
          actions = [{ keys: "Click", does: "Choose a position." }];
          break;
        case "LFO Dest":
          body = "Select LFO destination track.";
          actions = [{ keys: "Click", does: "Choose destination track." }];
          break;
        case "LFO Param":
          body = "Select which parameter the LFO modulates.";
          actions = [{ keys: "Click", does: "Choose parameter." }];
          break;
        case "SHP1":
          body = "Select LFO shape 1.";
          actions = [{ keys: "Click", does: "Choose shape." }];
          break;
        case "SHP2":
          body = "Select LFO shape 2.";
          actions = [{ keys: "Click", does: "Choose shape." }];
          break;
        case "Mode":
          body = "Select LFO mode (FREE / TRIG / HOLD).";
          actions = [{ keys: "Click", does: "Choose mode." }];
          break;
        default:
          // keep defaults
          break;
      }

      return { title, body, actions };
    },

        "kit:knob": (ctx) => ({
      title: `${ctx.paramLabel ? ctx.paramLabel + " — " : ""}${ctx.block || "Param"} (Track ${Number.isFinite(ctx.track) ? (ctx.track + 1) : "?"})`,
      body: "Drag to change the value (0–127). Changes are reflected in the current Kit buffer; CC may be sent live depending on the parameter.",
      actions: [
        { keys: "Drag", does: "Adjust value." },
        { keys: "Hold Shift (Kit panel)", does: "Enable Shift-highlighter mode. Some sliders apply across all tracks for the highlighted parameter." },
        { keys: "Click column header", does: "Reset parameter for all tracks. Shift+Click randomizes." }
      ]
    }),

    "kit:masterfx:blockHeader": {
      title: "Master FX block",
      body: "Block-level actions for Master FX.",
      actions: [
        { keys: "Click", does: "Reset this Master FX block." },
        { keys: "Shift+Click", does: "Randomize this Master FX block." }
      ]
    },

    "kit:masterfx:slider": (ctx) => ({
      title: `${ctx.paramLabel || "Master FX"}`,
      body: "Drag to adjust Master FX parameter (0–127).",
      actions: [
        { keys: "Drag", does: "Adjust value." }
      ]
    }),

    // ---------------------------------------------------------------------
    // Pattern editor
    // ---------------------------------------------------------------------
    "#patNumber": { title: "Pattern number", body: "Current pattern label (A01–H16)." },
    "#assignedKitNumber": { title: "Assigned Kit #", body: "Kit slot assigned to this Pattern (1–64). Use ↑/↓ to step." },
    "#patLengthSlider": { title: "Pattern length", body: "Number of steps in the pattern (2–64; MKI limits to 32)." },
    "#patScaleSelect": { title: "Pattern scale", body: "Sets the scale/breakpoint grouping used by the Machinedrum for this pattern." },
    "#patTempoMult": { title: "Tempo multiplier", body: "Per-pattern tempo multiplier/divider." },
    "#patSwingSlider": { title: "Swing", body: "Swing amount for this pattern." },
    "#accentSlider": { title: "Accent amount", body: "Accent level for this pattern." },

    "pattern:globalToggle": {
      title: "Global Accent/Swing/Slide",
      body: "Toggle ‘edit all’ behavior. When enabled, some edits may affect all tracks for that attribute.",
      actions: [
        { keys: "Click", does: "Toggle this global edit mode." }
      ]
    },

    "pattern:trackLabel": (ctx) => ({
      title: `Pattern track ${Number.isFinite(ctx.track) ? (ctx.track + 1) : ""}`.trim(),
      body: "Select which track you are editing/highlighting.",
      actions: [
        { keys: "Click", does: "Select this track." }
      ]
    }),

    "pattern:stepHeader": {
      title: "Step# (per-track)",
      body: "Track-wide operations for this pattern track.",
      actions: [
        { keys: "Click", does: "Clear Trig/Acc/Swing/Slide for this track." },
        { keys: "Shift+Click", does: "Randomize Trig/Acc/Swing/Slide for this track." }
      ]
    },

    "pattern:rowHeader": (ctx) => ({
      title: `Row — ${ctx.field || ""}`.trim(),
      body: "Row-wide operations for the selected track.",
      actions: [
        { keys: "Click", does: "Clear this row for the track." },
        { keys: "Shift+Click", does: "Randomize this row for the track." }
      ]
    }),

    "pattern:stepCell": (ctx) => ({
      title: `${ctx.field || "Step"} — step ${Number.isFinite(ctx.step) ? (ctx.step + 1) : ""}`.trim(),
      body: "Toggle this bit (Trig / Accent / Swing / Slide) at the given step.",
      actions: [
        { keys: "Click", does: "Toggle on/off." },
        { keys: "Note", does: "If you turn a Trig off, any parameter-locks on that step are removed." }
      ]
    }),

    "pattern:stepNumber": {
      title: "Step number",
      body: "Step number row.",
      actions: [
        { keys: "Shift+Click", does: "Ensure Trig is ON and add a default parameter lock at this step (if none exists)." }
      ]
    },

    "pattern:lockCell": {
      title: "Parameter lock",
      body: "Edit a parameter lock: choose parameter ID + value for a specific step.",
      actions: [
        { keys: "Change dropdown", does: "Choose which parameter is locked." },
        { keys: "Drag slider", does: "Set lock value." },
        { keys: "X", does: "Delete this lock." }
      ]
    },

    "pattern:lockRowHeader": {
      title: "Parameter lock row",
      body: "All locks for a specific step.",
      actions: [
        { keys: "+Param", does: "Add another lock to this step." },
        { keys: "DelRow", does: "Remove all locks at this step." }
      ]
    },

    // ---------------------------------------------------------------------
    // Song editor
    // ---------------------------------------------------------------------
    "#songNameInput": { title: "Song name", body: "Name for the current song (max 16 chars)." },

    "song:header": {
      title: "Song column header",
      body: "Column-wide operations in the Song table.",
      actions: [
        { keys: "Click", does: "Reset this column for all rows." },
        { keys: "Shift+Click", does: "Randomize this column for all rows." }
      ]
    },

    "song:cell": (ctx) => {
      const col = (ctx.column || "").trim();
      const rowLabel = Number.isFinite(ctx.row) ? String(ctx.row).padStart(3, "0") : "";

      // Special case: mute buttons inside the Mutes column
      if (col === "Mutes" && ctx.el && ctx.el.tagName === "BUTTON") {
        const t = ((ctx.el.textContent || "").trim() || "?");
        return {
          title: `Mute T${t}${rowLabel ? ` (Row ${rowLabel})` : ""}`,
          body: "Toggle this track mute for this song row.",
          actions: [{ keys: "Click", does: "Toggle mute." }]
        };
      }

      // Pattern column sub-controls (LOOP/JUMP/HALT helpers)
      if (col === "Pattern" && ctx.el && ctx.el.closest && ctx.el.closest(".pattern-subbox")) {
        if (ctx.el.tagName === "SELECT") {
          return {
            title: `Target row${rowLabel ? ` (Row ${rowLabel})` : ""}`,
            body: "Select target row for LOOP/JUMP/HALT commands.",
            actions: [{ keys: "Click", does: "Choose a row." }]
          };
        }
        if (ctx.el.tagName === "INPUT") {
          return {
            title: `Loop times${rowLabel ? ` (Row ${rowLabel})` : ""}`,
            body: "Set LOOP times (0 = ∞).",
            actions: [{ keys: "Type", does: "Enter a number." }]
          };
        }
      }

      const title = col
        ? `${col}${rowLabel ? ` (Row ${rowLabel})` : ""}`
        : (rowLabel ? `Row ${rowLabel}` : "Song row");

      let body = "Edit this value for the song row.";
      /** @type {HelpAction[]} */
      let actions = [];

      switch (col) {
        case "Pattern":
          body = "Select pattern or command (END / LOOP / JUMP / HALT).";
          actions = [{ keys: "Click", does: "Choose a value." }];
          break;
        case "Repeats":
          body = "Set repeats (1–64). For LOOP rows: 0 = ∞.";
          actions = [{ keys: "Type", does: "Enter a number." }];
          break;
        case "Offset":
          body = "Set start offset (0–63 steps).";
          actions = [{ keys: "Type", does: "Enter a number." }];
          break;
        case "Length":
          body = "Set play length (2–64 steps).";
          actions = [{ keys: "Type", does: "Enter a number." }];
          break;
        case "BPM":
          body = "Override BPM for this row, or use “—” for global tempo.";
          actions = [{ keys: "Click", does: "Choose BPM." }];
          break;
        case "Mutes":
          body = "Toggle per-track mutes for this row.";
          actions = [{ keys: "Click", does: "Toggle mutes." }];
          break;
        default:
          // keep defaults
          actions = [{ keys: "Edit", does: "Change the value." }];
          break;
      }

      return { title, body, actions };
    },

        "song:rowIndex": (ctx) => ({
      title: `Song row ${Number.isFinite(ctx.row) ? String(ctx.row).padStart(3, "0") : ""}`.trim(),
      body: "Select rows and reorder the song.",
      actions: [
        { keys: "Click", does: "Select row." },
        { keys: "Shift+Click", does: "Select a contiguous range (multi-select)." },
        { keys: "Drag", does: "Reorder rows (drag & drop)." },
        { keys: "Cmd/Ctrl+C", does: "Copy selected row(s)." },
        { keys: "Cmd/Ctrl+X", does: "Cut selected row(s)." },
        { keys: "Cmd/Ctrl+V", does: "Paste row(s) from clipboard." },
        { keys: "Cmd/Ctrl+Z", does: "Undo (Shift+Cmd/Ctrl+Z = redo)." }
      ]
    }),

    // ---------------------------------------------------------------------
    // UW sample manager
    // ---------------------------------------------------------------------
    "uw:slotTile": (ctx) => ({
      title: `UW slot ${Number.isFinite(ctx.slotIndex) ? ctx.slotIndex : ""}`.trim(),
      body: "UW sample slot tile. Select, multi-select, preview, and drag/drop to swap or import audio.",
      actions: [
        { keys: "Click", does: "Select slot." },
        { keys: "Cmd/Ctrl+Click", does: "Toggle slot selection (multi-select)." },
        { keys: "Shift+Click", does: "Range select from the active slot." },
        { keys: "Double-click", does: "Preview (Play/Stop)." },
        { keys: "Drag", does: "Swap slots or drop audio files to import." }
      ]
    }),

    "uw:tilePlay": {
      title: "UW preview",
      body: "Play/Stop preview of the slot audio in your browser.",
      actions: [
        { keys: "Click", does: "Toggle Play/Stop." },
        { keys: "Tip", does: "Double-clicking the tile also toggles preview." }
      ]
    }
  };

  // Expose globally.
  window.MDDTHelpRegistry = REGISTRY;
})();
