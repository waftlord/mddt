# MDDT Lab Module API Guide

**Audience:** humans and LLMs generating Lab modules.  
**API:** Host API v3 (`host.apiVersion === 3`)

This is the single, up-to-date contract for writing Lab modules for MDDT. It intentionally documents **only the current supported API** (no fallbacks).

---

## 0) Non-negotiable rules

These rules exist because of how the Lab host loads modules.

1) `mount()` is **synchronous**
- The host does **not** `await mount()`.
- Do **not** declare `async mount()`.
- Do async work only inside event handlers (e.g., a Start button), with `try/catch`.

2) There is **no unmount**
- Once your tab is opened and mounted, your module stays alive until page reload.
- You must provide **Start / Stop** (or equivalent) and clean up everything you start.

3) Slot libraries are **live**
- `host.getRefs()` returns live internal objects.
- Never mutate them directly. Always `host.clone()` → edit → `commit*Slot()` / `write*Slot()`.

4) MIDI + audio must be **opt-in**
- Don’t send MIDI or start audio automatically on mount.
- Only start Tone/audio from a user gesture.

---

## 1) Quick start module (copy/paste)

```js
(() => {
  "use strict";

  MDDT.registerLabModule({
    id: "example-minimal",
    title: "Example Minimal",

    mount(el, host) {
      el.innerHTML = "";
      el.classList.add("lab-module-inner");

      const h = document.createElement("h3");
      h.textContent = "Example Minimal";
      el.appendChild(h);

      const p = document.createElement("p");
      p.textContent = `Host API v${host.apiVersion}`;
      el.appendChild(p);
    }
  });
})();
```

---

## 2) Registering a module

### `MDDT.registerLabModule(def)`

```ts
type LabModuleDef = {
  id: string;                   // required, unique, stable
  title?: string;               // tab label (defaults to id)
  order?: number;               // optional sort key (lower = earlier)
  mount: (el: HTMLElement, host: HostAPI) => void; // required, synchronous
};
```

**Notes**
- `id` must be unique across all modules (bundled + imported).
- The host calls `mount(el, host)` once, the first time the user opens your tab.

---

## 3) Host API reference

The host object is passed as `mount(el, host)` and is also available at `window.MDDT.host`.

### 3.1 Type overview

```ts
type CommitOpts = { silent?: boolean };
type WriteOpts = { silent?: boolean; sendToMD?: boolean };

type HostAPI = {
  apiVersion: 3;

  // cloning + logging
  clone<T>(obj: T): T;
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;

  // environment + selection
  getEnv(): Env;
  getSelected(): Selected;

  // live data refs (do not mutate)
  getRefs(): Refs;

  // local-only commits (UI update, no SysEx)
  commitKitSlot(i: number, kit: KitObj | null, opts?: CommitOpts): KitObj | null;
  commitPatternSlot(i: number, pat: PatternObj | null, opts?: CommitOpts): PatternObj | null;
  commitSongSlot(i: number, song: SongObj | null, opts?: CommitOpts): SongObj | null;
  commitGlobalSlot(i: number, glb: GlobalObj | null, opts?: CommitOpts): GlobalObj | null;

  // commit + optional SysEx send (defaults to local-only)
  writeKitSlot(i: number, kit: KitObj | null, opts?: WriteOpts): void;
  writePatternSlot(i: number, pat: PatternObj | null, opts?: WriteOpts): void;
  writeSongSlot(i: number, song: SongObj | null, opts?: WriteOpts): void;
  writeGlobalSlot(i: number, glb: GlobalObj | null, opts?: WriteOpts): void;

  // label helpers (may be null in minimal builds)
  labels: {
    patternIndexToLabel: ((i: number) => string) | null;
    patternLabelToIndex: ((s: string) => number) | null;
  };

  machines: MachineHelpers;
  params: ParamHelpers;
  ui: UIHelpers;
  pattern: PatternHelpers;

  // tooling snapshot
  getKnowledge(opts?: { scopeEl?: HTMLElement | Document }): any;

  // MIDI + audio
  midi: MidiAPI;
  audio: AudioAPI;
};
```

---

## 4) Reading data safely

### 4.1 `host.getRefs()`

Returns live internal slot libraries:

```ts
type Refs = {
  globals: (GlobalObj | null)[]; // length 8

  // kits are wrapped
  kits: ({ data: KitObj; colorIndex: number } | null)[]; // length 64

  // patterns are wrapped
  patterns: ({ kit: any; pattern: PatternObj; kitColorIndex: number } | null)[]; // length 128

  songs: (SongObj | null)[]; // length 32
};
```

**Hard rule:** never mutate the objects you get from these arrays.

✅ Correct:

```js
const refs = host.getRefs();
const wrap = refs.kits[0];
if (!wrap) return;

const kit = host.clone(wrap.data);
kit.kitName = "My Kit";
host.commitKitSlot(0, kit);
```

❌ Incorrect (mutates live state):

```js
host.getRefs().kits[0].data.kitName = "Oops";
```

### 4.2 `host.clone(obj)`

Use `host.clone()` before editing:
- preserves typed arrays / ArrayBuffers when needed
- avoids accidental shared mutations

---

## 5) Writing data (commit vs write)

### 5.1 Commit: local library + UI only

- `host.commitKitSlot(i, kitOrNull, opts?)`
- `host.commitPatternSlot(i, patOrNull, opts?)`
- `host.commitSongSlot(i, songOrNull, opts?)`
- `host.commitGlobalSlot(i, glbOrNull, opts?)`

Clearing a slot:

```js
host.commitPatternSlot(10, null); // clear pattern slot 10
```

### 5.2 Write: commit + optional SysEx send

All `host.write*` methods default to **local-only** (`sendToMD:false`).  
They only send SysEx when you explicitly pass `{ sendToMD: true } confirming that MIDI Out is selected.

```js
host.writeKitSlot(12, kit, { sendToMD: true });
```

### 5.3 `silent` + refresh once

When doing lots of writes:

```js
for (let i = 0; i < 64; i++) {
  host.commitKitSlot(i, kit, { silent: true });
}
host.ui.refreshSlots({ kits: true, patterns: false, songs: false, globals: false });
```

---

## 6) Data model reference

This section documents the shapes you’ll see inside `host.getRefs()`. It is not every byte of SysEx, but it’s enough to build correct generators/editors.

### 6.1 Kit slot wrapper (`refs.kits[i]`)

```ts
type KitSlotWrap = {
  data: KitObj;        // the actual kit
  colorIndex: number;  // UI-only
};
```

### 6.2 Kit object (`KitObj`)

Kits are primarily arrays of 7-bit values (0..127). Common fields:

- `kitName: string`
- `sysexVersion: number`
- `sysexPosition: number`

Per-track arrays (length 16):

- `machineAssignments: number[16]` (machine IDs)
- `machineTonalFlags: number[16]` (0|1)
- `trackLevels: number[16]` (0..127)
- `muteTrigRelations: number[16][2]` (0..16, where 0 = "--")
- `lfoBlocks: number[16][36]`
- `controllers: number[16][24]` (P1..P24)
- `trackFx: number[16][16]`
- `routing: number[16][8]`

Global arrays:

- `masterFx: number[32]`
- `uWBlock: number[12]` (UW bytes; present even if UW disabled, but may be ignored)

Optional diagnostics:

- `rawKit: any | null`

**Good practice:** keep values in range 0..127 unless a field is explicitly documented otherwise.

### 6.3 Pattern slot wrapper (`refs.patterns[i]`)

```ts
type PatternSlotWrap = {
  kit: any;                // often null (not required by most modules)
  kitColorIndex: number;   // UI-only
  pattern: PatternObj;     // the actual pattern
};
```

### 6.4 Pattern object (`PatternObj`)

Important fields:

- Identity / linkage:
  - `patternNumber: number` (0..127)
  - `origPos: number` (0..127)
  - `assignedKitNumber: number` (0..63)

- Timing:
  - `length: number` (2..32 on MKI, 2..64 on MKII)
  - `tempoMult: number`
  - `scale: number`
  - `swingAmount: number`
  - `accentAmount: number`

- Bitfields (step presence). Typically `Uint8Array(8)`:
  - `trigBitsPerTrack: (Uint8Array(8) | number[8])[16]`
  - `accentBitsPerTrack: ...`
  - `swingBitsPerTrack: ...`
  - `slideBitsPerTrack: ...`
  - Global variants: `accentBitsGlobal`, `swingBitsGlobal`, `slideBitsGlobal`

- Parameter locks (preferred edit surface):
  - `locks: { track:number; step:number; paramID:number; paramVal:number }[]`

Lock notes:
- `paramID` is `1..48`
  - `1..24` = main params (P1..P24)
  - `25..48` = extra params
- `locks[]` is the easiest thing to edit; the encoder rebuilds matrices from locks.

Optional matrices (advanced; usually don’t edit directly):
- `lockMasks`, `lockMasks2`
- `paramMatrixMain`, `paramMatrixExtra`

### 6.5 Editing locks example

```js
const refs = host.getRefs();
const wrap = refs.patterns[0];
if (!wrap) return;

const p = host.clone(wrap.pattern);
p.locks = Array.isArray(p.locks) ? p.locks.slice() : [];
p.locks.push({ track: 0, step: 0, paramID: 1, paramVal: 80 }); // P1 on step 1
host.commitPatternSlot(0, p);
```

### 6.6 Song object (`SongObj`)

Song slots (`refs.songs[i]`) contain:

- `slotIndex: number`
- `name: string`
- `version: number`
- `revision: number`
- `rows: { index:number; data: number[10] }[]`

Each row has 10 bytes:

0. patternOrCommand (0..127, `0xFE` = command, `0xFF` = END)  
1. reserved (preserve)  
2. repeats (0..63 => 1..64) OR LOOP times (0 = ∞)  
3. targetRow (for LOOP/JUMP/HALT)  
4–5. mute mask (low/high bytes)  
6–7. BPM hi/lo (`0xFF` = inherit)  
8. offset (0..63 steps)  
9. endStep (offset + length)

Commands:
- END: byte0 = `0xFF`
- LOOP/JUMP/HALT: byte0 = `0xFE`; byte3 = target row; byte2 = LOOP times (only for LOOP)

### 6.7 Global object (`GlobalObj`)

Globals are stored in `refs.globals[0..7]`. The exact schema is broader; treat it as an opaque object unless you know exactly what you’re changing. Prefer editing kits/patterns/songs for most creative modules.

---

## 7) Environment + selection

### 7.1 `host.getEnv()`

```ts
type Env = {
  mdModel: string;          // "MKI" or "MKII" in typical builds
  mdUWEnabled: boolean;
  mdOSVersion: string;
  maxPatternLength: number; // 32 on MKI, 64 on MKII
  romSlotCount: number;
  ramRecordPlayCount: number;
  slots: { globals: 8; kits: 64; patterns: 128; songs: 32 };
};
```

### 7.2 `host.getSelected()`

```ts
type Selected = {
  kitSlot: number;
  patternSlot: number;
  songSlot: number;
  globalSlot: number;
  activePanel: string;
};
```

---

## 8) Labels, machines, and params

### 8.1 Pattern labels (`host.labels`)

```js
host.labels.patternIndexToLabel?.(0);    // "A01"
host.labels.patternLabelToIndex?.("B16"); // 31
```

### 8.2 Machine helpers (`host.machines`)

```js
host.machines.getValid();        // [{ id, name, tags }, ...]
host.machines.getValidMap();     // { [id]: name, ... }

host.machines.resolve("TRX-BD"); // id or null
host.machines.search("BD");      // list
host.machines.findIds("BD");     // [id...]
host.machines.getName(id);       // name
host.machines.getParamLabels(id);// ["P1 label", ...]
host.machines.supportsTonal(id); // boolean
```

### 8.3 Parameter labels (`host.params`)

```js
host.params.getLabel(machineID, 0, "machineParams"); // label for P1
host.params.getLabel(machineID, 5, "machineParams"); // label for P6
```

Categories: `"machineParams" | "trackFx" | "routing"`.

---

## 9) UI API (`host.ui`)

### 9.1 Slot/track targeting ranges

Use these with sliders you render inside your module UI. Always scope to your module root element to avoid collisions.

```js
const sr = host.ui.getSlotRange("pattern", { scope: el }); // {start,end,source}
const tr = host.ui.getTrackRange("kit", { scope: el });    // {start,end,source}
```

Return:

```ts
{ start:number; end:number; source:"scope"|"lab"|"tools"|"selected"|"fallback" }
```

### 9.2 Range + slider reading helpers

```js
host.ui.getSliderValues(idOrEl);       // array | null
host.ui.getRangeValues(id);            // [a,b] | null
host.ui.getRangeValuesIn(scopeEl, id); // [a,b] | null
```

### 9.3 Refresh after silent commits

```js
host.ui.refreshSlots({ kits:true, patterns:true, songs:false, globals:false });
```

---

## 10) UI control factory (`host.ui.controls`)

These helpers create **Lab-styled UI** that matches the built-in panels.

The most important thing to know (and the source of many LLM-generated bugs):

- **Some helpers return DOM elements** (e.g. `miniButton()`).
- **Some helpers return *objects containing DOM elements*** (e.g. `subpanel()`, `inputRow()`, `rangeRow()`).
  - If you treat those return objects like DOM nodes (calling `.querySelector`, `.appendChild`, etc.), you will get runtime errors like:  
    `TypeError: x.querySelector is not a function`.

### Available helpers

#### `controls.uniqueId(prefix?) -> string`
Returns a reasonably-unique DOM id.

```js
const id = host.ui.controls.uniqueId("myMod");
```

#### `controls.miniButton(label, title, onClick) -> HTMLButtonElement`

```js
const btn = host.ui.controls.miniButton("Start", "Start thing", () => host.log("go"));
el.appendChild(btn);
```

#### `controls.subpanel({ title, subtitle?, id?, actions?, contentEl? }) -> { section, body, header, actions, titles, titleEl }`

Creates a standard Lab “card” section.

Return shape (exact keys):

```ts
{
  section: HTMLElement; // <section class="lab-subpanel">
  body: HTMLElement;    // <div class="lab-subpanel-body">
  header: HTMLElement;  // <div class="lab-subpanel-header">
  actions: HTMLElement; // <div class="lab-subpanel-actions">
  titles: HTMLElement;  // <div class="lab-subpanel-titles">
  titleEl: HTMLElement; // <h3 class="lab-subpanel-title">
}
```

**Important**
- Append **`panel.section`**, not `panel.el`.

```js
const controls = host.ui.controls;

const panel = controls.subpanel({
  id: "my-panel",
  title: "Track 1",
  subtitle: "Offline"
});

panel.body.appendChild(document.createTextNode("Hello"));
el.appendChild(panel.section);
```

**Updating the subtitle later**
- `subpanel()` does *not* return a direct `subtitleEl`.
- If you need to update it, query it from `panel.titles`:

```js
const subtitleEl = panel.titles.querySelector(".lab-subpanel-subtitle");
if (subtitleEl) subtitleEl.textContent = "Connected";
```

#### `controls.inputRow(labelText, type, id, defaultValue, attributes?) -> { row, input }`

Creates a label + **`<input>`** or **`<textarea>`** row.

- `type` is for inputs: `"text"`, `"number"`, `"checkbox"`, etc.
- Special case: if `type === "textarea"` it creates a `<textarea>`.
- **There is no `"select"` support** (it will create `<input type="select">`, which is not a real dropdown).

Return shape:

```ts
{
  row: HTMLElement;   // wrapper <div>
  input: HTMLElement; // <input> or <textarea>
}
```

Correct usage:

```js
const { row, input } = controls.inputRow("Name", "text", "myName", "Init");
input.onchange = () => host.log("new name", input.value);
panel.body.appendChild(row);
```

Incorrect usage (will throw):

```js
const r = controls.inputRow("Name", "text", "myName", "Init");
r.querySelector("input"); // ❌ r is an object, not a DOM element
```

#### Dropdown / `<select>` recipe (no built-in helper)

If you want a dropdown, build it manually:

```js
function selectRow(labelText, id, options, initialValue) {
  const row = document.createElement("div");
  row.style.marginBottom = "8px";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = labelText + " ";
  row.appendChild(label);

  const sel = document.createElement("select");
  sel.id = id;

  options.forEach((optVal) => {
    const opt = document.createElement("option");
    opt.value = opt.textContent = String(optVal);
    sel.appendChild(opt);
  });

  if (initialValue != null) sel.value = String(initialValue);
  row.appendChild(sel);

  return { row, select: sel };
}

const rate = selectRow("Rate", "rate-1", ["4n","8n","16n","32n"], "16n");
rate.select.onchange = () => host.log("rate", rate.select.value);
panel.body.appendChild(rate.row);
```

#### `controls.rangeRow(...) -> { row, id, inputEl, sliderEl, get(), set() }`

Creates a noUiSlider-backed (when available) 2-handle range slider with a hidden input storing `"start,end"`.

You almost never need to touch `inputEl` directly; use `get()` / `set()`.

#### `controls.slotRangeRow(kind, opts?)` and `controls.trackRangeRow(kind, opts?)`

Convenience wrappers that create “slot range” and “track range” sliders with the standard Lab look.

#### `controls.resetPanel(panelEl)` / `controls.randomizePanel(panelEl)`

Utilities that reset/randomize inputs and sliders inside a given panel element.

### Avoid mixing internal helpers

The main app’s built-in Lab panels use internal functions like `createInputRow(...)`.  
Those are **not** part of the exported Host API, and imported modules should not rely on them.

Use only `host.ui.controls.*` plus normal DOM APIs.


## 11) Pattern helpers (`host.pattern`)

MDDT uses 64-step bitfields stored in 8 bytes. These helpers prevent off-by-one and masking mistakes.

```js
const bits = host.pattern.bitfieldFromSteps(64, [0, 4, 8, 12]);
const steps = host.pattern.stepsFromBitfield(bits, 64);
host.pattern.trimToLength(patternObj, 16);
```

---

## 12) MIDI API (`host.midi`)

Stable wrapper around the currently selected MIDI ports.

### Properties
- `host.midi.in`  → selected `MIDIInput` or `null`
- `host.midi.out` → selected `MIDIOutput` or `null`

### `host.midi.send(data, timestampMs?) -> boolean`

```js
host.midi.send([0x90|0, 60, 100]); // Note On ch0, C4
host.midi.send([0x80|0, 60, 0]);   // Note Off
host.midi.send([0xB0|0, 1, 64]);   // CC1
```

With scheduling:

```js
host.midi.send([0x90|0, 60, 100], performance.now() + 10);
```

### `host.midi.onMessage(handler) -> unsubscribe`

```js
const unsub = host.midi.onMessage((ev) => {
  host.log("MIDI IN", Array.from(ev.data));
});
unsub();
```

### Missing ports
If no output is selected, `host.midi.out` is `null`. Don’t throw; show a warning in your UI.

---

## 13) Audio / Tone.js API (`host.audio`)

Tone is loaded lazily (only when requested).

### `host.audio.ensureToneLoaded() -> Promise<Tone>`
Loads Tone.js on demand (pinned CDN + fallbacks).

### `host.audio.ensureToneStarted() -> Promise<Tone>`
Starts or resumes audio context. **Must be called from a user gesture**.

### `host.audio.toneTimeToMidiMs(timeSeconds) -> number`

Convert Tone callback seconds → WebMIDI milliseconds:

```js
const tMs = host.audio.toneTimeToMidiMs(time);
host.midi.send([0x90|0, 60, 100], tMs);
```

---

## 14) Canonical lifecycle patterns (Start/Stop + cleanup)

Because modules persist for the whole session, use a cleanup stack.

```js
function makeCleanup(host) {
  const fns = [];
  return {
    add(fn) { if (typeof fn === "function") fns.push(fn); },
    run() {
      while (fns.length) {
        const fn = fns.pop();
        try { fn(); } catch (e) { host?.warn?.("cleanup failed", e); }
      }
    }
  };
}
```

**Start/Stop skeleton**

```js
let running = false;
const cleanup = makeCleanup(host);

function stop() {
  if (!running) return;
  running = false;
  cleanup.run();
}

async function start() {
  if (running) return;
  running = true;

  try {
    // start loops/listeners here
  } catch (e) {
    host.error("Start failed:", e);
    stop();
  }
}
```

---

## 15) Recipes (Tone clock → MIDI)

These are proven templates for LLM-generated modules.

### 15.1 Step sequencer

```js
async function startStepSeq({ midi, audio, noteOn, noteOff, cleanup, opts }) {
  const Tone = await audio.ensureToneStarted();

  const bpm = opts.bpm ?? 120;
  const ch = opts.ch ?? 0;
  const gateMs = opts.gateMs ?? 90;

  try { Tone.Transport.bpm.value = bpm; } catch (_) {}

  const pattern = opts.pattern ?? [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0];
  const notes   = opts.notes   ?? [60];
  let step = 0;

  const transportWasRunning = (Tone.Transport.state === "started");

  const loop = new Tone.Loop((time) => {
    const tMs = audio.toneTimeToMidiMs(time);

    if (pattern[step % pattern.length]) {
      const note = notes[step % notes.length] ?? 60;
      noteOn(ch, note, 100, tMs);
      noteOff(ch, note, tMs + gateMs);
    }
    step++;
  }, "16n").start(0);

  cleanup.add(() => { try { loop.stop(); loop.dispose(); } catch (_) {} });

  if (!transportWasRunning) {
    Tone.Transport.start();
    cleanup.add(() => { try { Tone.Transport.stop(); } catch (_) {} });
  }
}
```

### 15.2 Arpeggiator (MIDI In → MIDI Out)

```js
async function startArp({ midi, audio, noteOn, noteOff, cleanup, opts }) {
  const Tone = await audio.ensureToneStarted();

  const ch = opts.ch ?? 0;
  const rate = opts.rate ?? "16n";
  const gateMs = opts.gateMs ?? 80;

  const held = new Set();

  const unsub = midi.onMessage((ev) => {
    const d = ev.data;
    const st = d[0] & 0xF0;
    const note = d[1] ?? 0;
    const vel  = d[2] ?? 0;

    if (st === 0x90 && vel > 0) held.add(note & 0x7F);
    if (st === 0x80 || (st === 0x90 && vel === 0)) held.delete(note & 0x7F);
  });

  cleanup.add(unsub);

  let idx = 0;
  const transportWasRunning = (Tone.Transport.state === "started");

  const loop = new Tone.Loop((time) => {
    const notes = Array.from(held).sort((a,b) => a-b);
    if (!notes.length) return;

    const n = notes[idx % notes.length];
    idx++;

    const tMs = audio.toneTimeToMidiMs(time);
    noteOn(ch, n, 100, tMs);
    noteOff(ch, n, tMs + gateMs);
  }, rate).start(0);

  cleanup.add(() => { try { loop.stop(); loop.dispose(); } catch (_) {} });

  if (!transportWasRunning) {
    Tone.Transport.start();
    cleanup.add(() => { try { Tone.Transport.stop(); } catch (_) {} });
  }
}
```

### 15.3 CC modulator (LFO → MIDI CC)

```js
function startCcLfo({ midi, cleanup, opts }) {
  const ch = opts.ch ?? 0;
  const cc = opts.cc ?? 1;
  const depth = opts.depth ?? 63;
  const center = opts.center ?? 64;
  const hz = opts.hz ?? 0.25;
  const intervalMs = opts.intervalMs ?? 20;

  const t0 = performance.now();
  const id = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const s = Math.sin(t * Math.PI * 2 * hz);
    let v = Math.round(center + s * depth);
    if (v < 0) v = 0;
    if (v > 127) v = 127;
    midi.send([0xB0 | (ch & 0x0F), cc & 0x7F, v]);
  }, intervalMs);

  cleanup.add(() => clearInterval(id));
}
```

---

## 16) Common pitfalls (especially for LLM-generated modules)

- Keep `mount()` synchronous; never `async mount()`.
- Don’t start anything automatically. Always require Start click.
- Own what you create: intervals, listeners, Tone objects, MIDI subscriptions.
- Don’t globally wipe Tone schedules; avoid `Tone.Transport.cancel()`.
- Timing units: Tone callback `time` is **seconds**, WebMIDI timestamps are **ms**.
- When editing patterns, prefer `pattern.locks[]` and bitfield helpers.

---

## 17) LLM prompt template (recommended)

Include this verbatim when prompting an LLM to generate a Lab module:

```txt
You are writing a single-file MDDT Lab module for Host API v3.

ABSOLUTE RULES
- Register using: MDDT.registerLabModule({ id, title, mount(el, host) { ... } })
- `mount()` MUST BE SYNCHRONOUS. Do NOT declare `async mount()`.
- Output one self-contained JS file suitable for Lab → Import → Paste module code.

START/STOP + CLEANUP
- Nothing starts automatically on mount. Provide Start and Stop buttons.
- Starting twice must NOT create duplicate loops/listeners.
- On Stop: clear intervals/timeouts/RAF, remove event listeners, unsubscribe MIDI handlers, dispose Tone objects, and send Note Off for any active notes.

HOST API
- Use host.getRefs() for reading, and host.clone() before editing.
- Kits are refs.kits[i].data, patterns are refs.patterns[i].pattern (pattern slots are wrappers).
- Use host.commit*Slot / host.write*Slot. host.write*Slot defaults to sendToMD:false; only set sendToMD:true if asked.

MIDI
- Use host.midi.in / host.midi.out / host.midi.send() / host.midi.onMessage().
- If host.midi.out is null, show a visible warning and do not throw.

TONE (if used)
- Use host.audio.ensureToneStarted() ONLY from a user click (Start button).
- Never call Tone.Transport.cancel().
- Keep handles to Tone objects you create and stop/dispose them on Stop.
- Tone callback `time` is seconds; WebMIDI timestamps are ms; convert with host.audio.toneTimeToMidiMs(time).

IMPORTS
- No relative imports (blob: URLs).
- No bare-module imports unless bundled.
- Prefer plain DOM + host.ui.controls.

DELIVERABLE
- Implement the requested behavior with clear UI and safe defaults.
```

---

## Appendix: `host.getKnowledge()` (tooling snapshot)

`host.getKnowledge()` returns a JSON-friendly snapshot of environment + schema + machine list.

```js
const k = host.getKnowledge();
console.log(k.env, k.schema);
```

Use it for introspection/tooling; for live UI ranges prefer `host.ui.getSlotRange()` / `host.ui.getTrackRange()` directly.
