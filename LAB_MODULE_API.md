# MDDT Lab Module API Guide (Host API v3)

This guide is intended to be **self-contained**: a module author (human or LLM) should be able to create Lab modules.

> **Runtime**: Modules run in the browser, in the same page as MDDT.  
> **Primary API**: `window.MDDT.registerLabModule(manifest, factoryFn)` and `window.MDDT.host`.

---

## 1) Quick start

```js
// my-module.js
(function () {
  "use strict";

  const manifest = {
    id: "my.module.id",
    name: "My Module",
    version: "0.1.0",
    author: "You",
    description: "Example module showing the Lab API.",
    category: "Utility"
  };

  window.MDDT.registerLabModule(manifest, function factory(host) {
    // Called once when user opens the module panel.
    // Return { mount, unmount }.

    let root;

    function mount(containerEl) {
      root = document.createElement("div");
      root.className = "lab-root";

      // Example: range selector (kits)
      const range = host.ui.controls.slotRangeRow({
        id: host.ui.controls.uniqueId("kitRange"),
        label: "Kit slots",
        type: "kit",
        defaultStart: 0,
        defaultEnd: 63
      });

      // Example: action button
      const btn = host.ui.controls.button({
        label: "Randomize kit names (local)",
        onClick: () => {
          const refs = host.getRefs();
          const startEnd = host.ui.getSlotRange(root, "kit") || { start: 0, end: 63 };

          for (let i = startEnd.start; i <= startEnd.end; i++) {
            const kit = refs.kits[i];
            if (!kit) continue;
            const k = host.clone(kit);
            k.kitName = `Kit ${String(i + 1).padStart(2, "0")}`;
            host.commitKitSlot(i, k, { silent: true });
          }

          host.ui.refreshSlots({ kits: true });
          host.ui.pulse(btn);
        }
      });

      root.appendChild(range);
      root.appendChild(btn);

      containerEl.appendChild(root);
    }

    function unmount() {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  });
})();
```

Place your JS file so it loads in the page (for development, add a `<script>` tag; for production, follow your existing build/loader approach).

---

## 2) Core concepts

### Slots and libraries

MDDT maintains in-memory “libraries” (arrays) for each data type:

- **Globals**: 8 slots (`globals[0..7]`)
- **Kits**: 64 slots (`kits[0..63]`)
- **Patterns**: 128 slots (`patternSlots[0..127]`)
- **Songs**: 32 slots (`songs[0..31]`)

Everything in the Lab API uses **0-based indices**.

### Local-first

All `write*` / hardware-send actions default to **local only**:

- `sendToMD` defaults to `false` on the host.
- Use `sendToMD: true` only when you are sure you want to transmit SysEx to the connected Machinedrum.
- “Unsafe” writers are also exposed (see below).

---

## 3) Registration API

### `window.MDDT.registerLabModule(manifest, factoryFn)`

- `manifest` describes the module (id/name/version/category).
- `factoryFn(host)` is called when the module is opened.
- `factoryFn` must return:

```ts
type LabModuleInstance = {
  mount(containerEl: HTMLElement): void;
  unmount(): void;
};
```

### Manifest fields

```ts
type LabModuleManifest = {
  id: string;           // unique; namespace-like recommended
  name: string;         // shown in UI
  version?: string;
  author?: string;
  description?: string;
  category?: string;    // used for grouping/filtering
};
```

---

## 4) Host API overview

The host object is passed to your factory function:

```js
window.MDDT.registerLabModule(manifest, (host) => { ... });
```

At runtime, it is also available as `window.MDDT.host`.

### Versioning

- `host.apiVersion` → `3` (this guide documents v3)

Always gate features if you plan to support multiple versions:

```js
if ((host.apiVersion|0) < 3) {
  host.warn("This module requires Host API v3+");
  return { mount(){}, unmount(){} };
}
```

---

## 5) Data access

### `host.getRefs()`

Returns **live references** to internal libraries. **Do not mutate these directly**.

```ts
host.getRefs(): {
  globals: GlobalData[];
  kits: Kit[];
  patternSlots: (PatternSlot|null)[];
  songs: Song[];
  // also: mdModel, osVersion, etc may be present on host.getEnv()
}
```

### `host.getSelected()`

Returns current selections from the UI:

```ts
host.getSelected(): {
  kitSlot: number;
  patternSlot: number;
  songSlot: number;
  globalSlot: number;
  kitTrack: number;
  patternTrack: number;
};
```

### `host.clone(obj)`

Safe deep clone helper.

- Uses `structuredClone` when available (preserves typed arrays).
- Falls back to `window.MDDT.util.deepClonePreserveTypedArrays` when available.
- Last fallback: JSON clone (typed arrays will not survive).

Use it any time you’re going to edit a referenced object:

```js
const refs = host.getRefs();
const kit = host.clone(refs.kits[0]);
kit.kitName = "Hello";
host.commitKitSlot(0, kit);
```

---

## 6) Writing and committing slots

### Important: local commit vs hardware send

- **Commit**: update MDDT’s local in-memory library and refresh UI (optionally silent).
- **Write**: optionally transmit SysEx to the Machinedrum.

All writers accept options:

```ts
type WriteOpts = {
  sendToMD?: boolean;   // default false on host writers
  silent?: boolean;     // default true recommended for batch ops
};
```

### Kits

```js
host.commitKitSlot(slotIndex, kitObj, { silent: true });
host.writeKitSlot(slotIndex, kitObj, { sendToMD: false, silent: true });

// Unsafe direct writer (sends by default in some internal flows)
host._unsafeWriteKitSlot(slotIndex, kitObj, { sendToMD: true });
```

### Patterns

Patterns are stored inside a PatternSlot wrapper:

```js
// patternSlots[i] is either null OR { pattern, kitColorIndex, kit? }
const slot = host.clone(refs.patternSlots[i]) || { pattern: host.clone(refPattern), kitColorIndex: 0 };

host.commitPatternSlot(i, slot, { silent: true });
host.writePatternSlot(i, slot, { sendToMD: false, silent: true });

host._unsafeWritePatternSlot(i, slot, { sendToMD: true });
```

### Songs

```js
host.commitSongSlot(slotIndex, songObj, { silent: true });
host.writeSongSlot(slotIndex, songObj, { sendToMD: false, silent: true });

host._unsafeWriteSongSlot(slotIndex, songObj, { sendToMD: true });
```

### Globals

```js
host.commitGlobalSlot(slotIndex, globalObj, { silent: true });
host.writeGlobalSlot(slotIndex, globalObj, { sendToMD: false, silent: true });

host._unsafeWriteGlobalSlot(slotIndex, globalObj, { sendToMD: true });
```

---

## 7) Environment & logging

### `host.getEnv()`

Returns a stable snapshot describing the connected device and feature flags:

```ts
{
  mdModel: "SPS-1" | "SPS-1UW" | "SPS-1 MKII" | "SPS-1UW MKII" | string;
  osVersion: string;        // e.g. "1.63", "1.63UW", "1.73", etc
  uwEnabled: boolean;       // inferred
  midi: {
    outSelected: boolean;
    inSelected: boolean;
  };
  slots: {
    globals: 8;
    kits: 64;
    patterns: 128;
    songs: 32;
    uwSamples: 48;
  };
}
```

### Logging

- `host.log(...args)`
- `host.warn(...args)`
- `host.error(...args)`

Use these instead of `console.*` when possible (they may be routed to UI in the future).

---

## 8) Machine and parameter metadata

### Machine catalog

```js
host.machines.getValid()      // list of machines for current MD model
host.machines.search(query)   // fuzzy search by name/type
host.machines.getMachineName(machineId)
host.machines.getMachineParams(machineId) // main+extra param labels + param IDs
```

Machine entries include:

```ts
{
  id: number;
  name: string;
  type: "GND" | "TRX" | "EFM" | "E12" | "P-I" | "P-II" | "DYN" | "INP" | "MID" | "CTR-AL" | ...;
  uw?: boolean;
}
```

### Parameter name helpers (Kit UI naming)

```js
host.params.getMasterFxName(index0to31)
host.params.getRoutingName(index0to7)
host.params.getTrackFxName(index0to15)
```

These return short strings suitable for UI labels/tooltips.

---

## 9) UI helpers

### Refresh helpers

```js
host.ui.refreshSlots({ kits: true, patterns: true, songs: true, globals: true });
host.ui.refreshTrackUI();      // re-render track panels after data edits
host.ui.pulse(el);             // quick visual feedback
```

### Range helpers

Used with the range controls described below.

```js
host.ui.getSlotRange(scopeEl, type)
// → { start:number, end:number } or null
// type is typically: "global" | "kit" | "pattern" | "song"

host.ui.getTrackRange(scopeEl)
// → { start:number, end:number } or null

host.ui.getRangeValues(scopeEl, ["myInputId", "myOtherId"])
// → { myInputId: number, myOtherId: number }
```

**Note:** `scopeEl` is usually your module root element. The functions search within that subtree.

---

## 10) UI control factory (`host.ui.controls`)

These helpers generate consistent Lab UI without needing custom HTML/CSS.

### `controls.uniqueId(prefix?)`

Returns a unique string id.

### `controls.subpanel({ title, description?, children? })`

Creates a small framed panel with a title and optional description.

### `controls.inputRow({ label, help?, inputEl })`

Wraps an input element with label + help text.

### `controls.rangeRow({ id, label, min, max, step?, value?, help? })`

Creates a numeric `<input type="range">` row.
- Adds `id` so you can read via `host.ui.getRangeValues`.

### `controls.slotRangeRow({ id, label, type, defaultStart, defaultEnd })`

Creates a 2-number range input for slot selection:
- `type` is one of `"global" | "kit" | "pattern" | "song"`. (Use the same string when reading with `host.ui.getSlotRange`.)

### `controls.trackRangeRow({ id, label, defaultStart, defaultEnd })`

Creates a 2-number range input for track selection (0..15).

### `controls.select({ id?, label?, options, value?, onChange? })`

Creates a `<select>` element.
- `options` can be `[{ value, label }]` or strings.

### `controls.button({ label, onClick, kind? })`

Creates a `<button>`.
- `kind` may be used for styling (`"primary"`, `"danger"`, etc) depending on theme.

### `controls.resetPanel({ onReset })` and `controls.randomizePanel({ onRandomize })`

Convenience panels that generate consistent “Reset” / “Randomize” UI.

---

## 11) Pattern helpers

### Step bitfields

MDDT represents steps as **64-step bitfields** stored in 8 bytes (`Uint8Array(8)`).

Helpers:

```js
host.pattern.bitfieldFromSteps([0, 4, 8, 12]) // → Uint8Array(8)
host.pattern.stepsFromBitfield(bitfield)      // → [0, 4, 8, 12]
host.pattern.trimToLength(bitfield, len)      // clears bits >= len
```

This is the easiest way to author/edit trigs, accents, swings, slides, and masks.

---

## 12) Data schemas (complete field lists)

### 12.1 Kit

A Kit is stored in `host.getRefs().kits[slotIndex]`.

```ts
type Kit = {
  kitName: string;

  // SysEx metadata
  sysexVersion: number;     // usually 3
  sysexPosition: number;    // 0..63

  // Per-track configuration
  machineAssignments: number[16];   // machine ID per track
  machineTonalFlags: number[16];    // 0|1 per track
  trackLevels: number[16];          // 0..127 per track

  // Track overview “MutePos / TrigPos”
  muteTrigRelations: number[16][2]; // [mutePos, trigPos], 0='--'

  // LFO block: 36 bytes per track (most are raw/reserved, preserve if unsure)
  lfoBlocks: number[16][36];

  // Machine parameter values
  controllers: number[16][24];      // P1..P24 (0..127)

  // Track FX (raw 0..127)
  trackFx: number[16][16];

  // Routing (raw 0..127)
  routing: number[16][8];

  // Master FX (4 blocks × 8 params = 32 values)
  masterFx: number[32];

  // UW-only bytes (safe to keep as zeros on non-UW)
  uWBlock: number[12];

  // Optional raw payload (round-tripping / diagnostics)
  rawKit?: any;
};
```

**Editing guidance**
- For machine parameters: use `host.machines.getMachineParams(machineId)` to learn which params exist and their labels.
- Preserve unknown parts of `lfoBlocks[t]` if you only edit the UI-exposed fields.

### 12.2 PatternSlot + Pattern

Patterns live in `host.getRefs().patternSlots[slotIndex]`.

```ts
type PatternSlot = null | {
  kit?: any;               // often null in current app; reserved
  kitColorIndex: number;   // UI only
  pattern: Pattern;
};

type Pattern = {
  // identity
  patternNumber: number;    // 0..127
  origPos: number;          // where to write (often same as patternNumber)
  assignedKitNumber: number;// 0..63 (kit slot for the MD)

  version: number;
  revision: number;

  extendedFlag: boolean;

  length: number;           // 2..64 (MKI may clamp to 32)
  tempoMult: number;        // raw enum (MD tempo multiplier)
  scale: number;            // raw enum (depends on MD model)
  swingAmount: number;      // 0..127
  accentAmount: number;     // 0..15-ish (raw nibble used by encoder)

  accentEditAll: boolean;
  swingEditAll: boolean;
  slideEditAll: boolean;

  // per-track 64-step bitfields (8 bytes each)
  trigBitsPerTrack: Uint8Array[16];      // each: Uint8Array(8)
  accentBitsPerTrack: Uint8Array[16];
  swingBitsPerTrack: Uint8Array[16];
  slideBitsPerTrack: Uint8Array[16];

  // global 64-step bitfields
  accentBitsGlobal: Uint8Array;          // Uint8Array(8)
  swingBitsGlobal: Uint8Array;           // Uint8Array(8)
  slideBitsGlobal: Uint8Array;           // Uint8Array(8)

  // per-track edit masks (also 64-step bitfields)
  trackAccentMasks: Uint8Array[16];
  trackSwingMasks: Uint8Array[16];
  trackSlideMasks: Uint8Array[16];

  // Parameter locks: recommended edit surface
  locks: Array<{ track:number; step:number; paramID:number; paramVal:number }>;

  // Internal matrices (encoder rebuilds from locks; preserve if unsure)
  lockMasks: Uint8Array[16];
  lockMasks2: Uint8Array[16];
  paramMatrixMain: Uint8Array[16];   // each: Uint8Array(24)
  paramMatrixExtra: Uint8Array[16];  // each: Uint8Array(24)

  rawPattern?: any;
};
```

**Lock param IDs**
- `paramID` is **1-based**.
- `1..24` → “Main” params (P1..P24)
- `25..48` → “Extra” params (P1..P24, extra bank)

### 12.3 Song + SongRow

Songs live in `host.getRefs().songs[slotIndex]`.

```ts
type Song = {
  slotIndex: number;      // 0..31
  name: string;
  version: number;
  revision: number;
  rows: SongRow[];        // usually 256 entries
};

type SongRow = {
  index: number;          // 0..255
  data: Uint8Array;       // length 10
};
```

**Row `data[10]` byte map (used by MDDT UI and encoder)**

| Byte | Meaning |
|------|---------|
| 0 | Pattern or command (`0..127` pattern, `0xFE` special command, `0xFF` END) |
| 1 | Reserved (preserve) |
| 2 | Repeats (`0..63` = 1..64) OR LOOP times (`0 = ∞`) |
| 3 | Target row for commands (LOOP/JUMP/HALT) |
| 4 | Mute bitmask low byte |
| 5 | Mute bitmask high byte |
| 6 | BPM high byte (`0xFF` = inherit) |
| 7 | BPM low byte (`0xFF` = inherit) |
| 8 | Offset (`0..63` steps) |
| 9 | End step = offset + length |

**Commands**
- END: `data[0] = 0xFF`
- LOOP/JUMP/HALT: `data[0] = 0xFE`, and:
  - `data[3]` = target row
  - LOOP uses `data[2]` as “times” (`0 = ∞`)

---

## 13) “LLM-complete” module authoring checklist

1. **Target domain(s)**: kits / patterns / songs / globals (which libraries will be edited?)
2. **Scope controls**: slot range, track range, and whether to operate on “selected slot only” or ranges.
3. **Safety**: should the module ever send SysEx? (default should be **local only**)
4. **Edits**: which fields are touched and the constraints (e.g., don’t change machine assignments, only trig bits).
5. **UI**: what controls should appear (sliders, dropdowns, buttons, presets).
6. **Undo strategy**: (optional) store a snapshot to restore on demand.

A prompt can be expressed as a structured spec:

```txt
Module name:
What it edits (kits/patterns/songs/globals):
User controls (range pickers, sliders, presets):
Behavior rules / constraints:
Local-only or hardware-write:
Edge cases (empty slots, MKI 32-step patterns, UW missing):
```

---

## 14) Creation

Using **only this guide**, an LLM (or human) can implement modules:

- The full host API surface (registration, refs, clone, commit/write, UI controls)
- Complete field lists for Kits, Patterns, Songs
- Bitfield helpers for pattern step authoring
- Song row byte mapping (previously a common missing piece)
- Machine/parameter metadata APIs to build UI based on MD capabilities

If a module needs something not listed here, the best way to make it “LLM-complete” is to add:
- A formal JSON Schema export (generated from runtime) and/or
- Higher-level helpers (e.g., `host.song.decodeRow(row)` / `encodeRow(spec)`), which reduce the need to edit raw bytes.

---

## 15) Practical tips & gotchas

- **Always clone** objects from `host.getRefs()` before editing.
- Prefer **commit + refresh once**:
  - Do many `commit*Slot(..., {silent:true})`
  - Then one `host.ui.refreshSlots({ kits:true, patterns:true, songs:true, globals:true })` (or only the libraries you touched).
- **MKI vs MKII**: Pattern length may clamp (MKI <= 32). Always clamp/trim bitfields with `host.pattern.trimToLength`.
- **Typed arrays**: Use `host.clone` and `host.pattern.*` helpers to avoid subtle encoding bugs.
- **Don’t assume UW**: check `host.getEnv().uwEnabled`.

---

## Appendix: `host.getKnowledge()`

You can call:

```js
const knowledge = host.getKnowledge({ scopeEl: yourModuleRoot });
```

It returns a compact snapshot containing:
- `env`
- `schema` (kit/pattern/song field shapes)
- `machines` summary list
- `params` label lists
- UI `ranges` if your module includes range controls

This is useful for debugging or to help an LLM reason about what’s available at runtime.
