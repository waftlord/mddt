// nodetrix.js

(function(){


  // Prevent duplicate load
  if(window.__nodetrixInjected){
    console.warn("[Nodetrix] Script already loaded. Skipping re-load.");
    return;
  }
  window.__nodetrixInjected = true;

  // ─────────────────────────────────────────────────────────────
  // 1) Basic Setup, Globals
  // ─────────────────────────────────────────────────────────────
  let nodes = [];
  let pulses = [];
  // ─────────────────────────────────────────────────────────────
  // Machinedrum / Track constraints
  // ─────────────────────────────────────────────────────────────
  // Machinedrum has 16 tracks, so we cap pulses at 16 (one per track).
  const MAX_PULSES = 16;

  // 16 distinct pulse colors for quick differentiation (Track 1–16).
  const PULSE_COLORS = [
    "#FF595E", "#FFCA3A", "#8AC926", "#1982C4",
    "#6A4C93", "#F72585", "#B5179E", "#7209B7",
    "#3A0CA3", "#4361EE", "#4CC9F0", "#06D6A0",
    "#118AB2", "#073B4C", "#FFD6A5", "#C7F9CC"
  ];

  function getPulseColor(id){
    return PULSE_COLORS[(id|0) % PULSE_COLORS.length];
  }

  // ─────────────────────────────────────────────────────────────
  // Machinedrum MIDI mapping (old Nodetrix behaviour)
  // - Notes are hard-set per pulse/track from window.globalData.keymap
  // - Channel follows window.globalData.midiBase (0-based MIDI channel)
  // ─────────────────────────────────────────────────────────────
  const DEFAULT_TRACK_NOTES = [36,38,40,41,43,45,47,48,50,52,53,55,57,59,60,62];

  function getGlobalTrackNoteMap(){
    const rawMap = window.globalData && window.globalData.keymap;
    let keymap;

    // Host may expose keymap as:
    // - 128-length note->track map (values are trackIDs 0..15)
    // - 16-length track->note map
    if (rawMap && (Array.isArray(rawMap) || ArrayBuffer.isView(rawMap)) && rawMap.length >= 128) {
      keymap = DEFAULT_TRACK_NOTES.map((def, trackID) => {
        // In a real MD global dump, keymap is a 128-byte note->track table.
        const note = Array.prototype.findIndex.call(rawMap, (n) => ((n & 0x7F) === trackID));
        return (note >= 0 && note <= 127) ? note : def;
      });
    }
    else if (rawMap && (Array.isArray(rawMap) || ArrayBuffer.isView(rawMap)) && rawMap.length >= 16) {
      // Some hosts use a 16-length track->note map.
      keymap = Array.from({ length: 16 }, (_, i) => {
        const n = Number(rawMap[i]);
        return (!Number.isFinite(n) || n < 0 || n > 127) ? DEFAULT_TRACK_NOTES[i] : (n | 0);
      });
    }
    else {
      keymap = DEFAULT_TRACK_NOTES.slice();
    }

    // Safety: some hosts can report all zeros during init
    if (keymap.every(n => n === 0)) keymap = DEFAULT_TRACK_NOTES.slice();
    return keymap;
  }

  function getGlobalMidiBaseChannel(){
    const baseRaw = (window.globalData && typeof window.globalData.midiBase === "number")
      ? window.globalData.midiBase : 0;
    let base = (Number.isFinite(baseRaw) ? (baseRaw | 0) : 0);
    // MD encodes base as 0..12 (MIDI ch 1..13) and 13 = OFF
    if (base === 13) return null;
    if (base < 0) base = 0;
    if (base > 12) base = 12;
    return base;
  }

  function applyPulseMidiAssignments(){
    const keymap = getGlobalTrackNoteMap();
    const base = getGlobalMidiBaseChannel();

    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      if (!p) continue;

      const trackID = (p.id | 0);
      if (trackID >= 0 && trackID < keymap.length) {
        p.note = keymap[trackID];
      }
      p.channel = base;
    }
  }

  // Keep note/channel assignments in-sync when the host changes
  // the global slot (midiBase) or keymap while Nodetrix is open.
  const __pulseMidiSync = { base: null, keySig: null };

  function computeKeymapSignature(rawMap){
    if (!rawMap || !(Array.isArray(rawMap) || ArrayBuffer.isView(rawMap))) return "none";
    const len = rawMap.length | 0;
    let h = len;
    const max = Math.min(len, 128);
    for (let i = 0; i < max; i++) {
      const v = rawMap[i];
      const n = Number.isFinite(v) ? (v | 0) : 0;
      // small 32-bit rolling hash
      h = ((h << 5) - h + n) | 0;
    }
    return `${len}:${h}`;
  }

  function maybeSyncPulseMidiFromGlobal(){
    const rawMap = window.globalData && window.globalData.keymap;
    const base = getGlobalMidiBaseChannel();
    const keySig = computeKeymapSignature(rawMap);

    if (__pulseMidiSync.base === base && __pulseMidiSync.keySig === keySig) return;

    __pulseMidiSync.base = base;
    __pulseMidiSync.keySig = keySig;

    // Apply mapping but don't touch mute/solo states.
    applyPulseMidiAssignments();
    // Refresh labels if the UI is available.
    if (typeof updatePulseAssignmentsUI === "function") {
      updatePulseAssignmentsUI();
    }
  }
  function hexToRgb(hex){
    const h = (hex || "").replace("#","").trim();
    if(h.length===3){
      const r = parseInt(h[0]+h[0],16);
      const g = parseInt(h[1]+h[1],16);
      const b = parseInt(h[2]+h[2],16);
      return {r,g,b};
    }
    if(h.length===6){
      const r = parseInt(h.substring(0,2),16);
      const g = parseInt(h.substring(2,4),16);
      const b = parseInt(h.substring(4,6),16);
      return {r,g,b};
    }
    return {r:255,g:255,b:255};
  }
  function rgbaFromHex(hex, a){
    const {r,g,b} = hexToRgb(hex);
    const alpha = Math.max(0, Math.min(1, Number(a)));
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function smoothstep01(t){
    t = Math.max(0, Math.min(1, Number(t)));
    return t * t * (3 - 2 * t);
  }

  // Solo logic: if any pulse is soloed, only soloed pulses will sound.
  let __soloActive = false;
  function recomputeSoloActive(){
    __soloActive = false;
    for(const p of pulses){
      if(p && p.soloed){ __soloActive = true; break; }
    }
  }
  function pulseShouldSound(p){
    if(!p || !p.enabled) return false;
    if(p.muted) return false;
    if(__soloActive) return !!p.soloed;
    return true;
  }

  // Visual toggles
  // Default OFF (requested): pulse-to-target helper lines can be visually busy.
  let showPulseLinks = false;        // faint line from current→target per pulse
  let autoFitEnabled = true;         // camera auto-fit to keep all nodes on-screen (can be disabled for stability)
  let showNetworkConnections = true; // draw node output graph (Network mode only)


  // For CA / Life modes, we store internal states:
  let wolframState = [];
  let wolframNext = [];
  let wolframRule = 30;
  let wolframLastStepBucket = -1;

  // Wolfram options (requested): make Wolfram output *diverge per pulse*.
  // In the original implementation, deterministic CA lookup caused all pulses
  // starting at the same node to follow identical paths.
  let wolframPerPulse = true;     // When true, each pulse has its own CA state line.
  let wolframRuleSpread = 0;      // 0..255 offset applied per pulse: rule(p) = (base + p*spread) mod 256
  let wolframPulseStates = [];    // [pulseId] -> Array(ncount)
  let wolframPulseNext = [];      // [pulseId] -> Array(ncount)

  let lifeGrid = [];
  let lifeRows = 10;
  let lifeCols = 10;
  let lifeRule = "B3/S23";
  let lifeLastStepBucket = -1;

  // For chaos game
  let chaosPoints = [];
  let chaosIndex = 0;

  // Chaos Game controls
  // Defaults preserve the legacy behaviour:
  // - 4 corners (first 4 nodes)
  // - step fraction = 0.5 (halfway)
  // - 200 points
  let chaosCornerCount = 4;          // 3..8 (clamped to node count)
  let chaosCornerMode = "first";     // "first" (legacy) | "spread" (auto-spread)
  let chaosStepFraction = 0.5;       // 0.05..0.95
  let chaosPointCount = 200;         // 50..10000
  let chaosBurnIn = 0;              // discard first N iterations (0..2000)
  let chaosNoRepeatCorners = false; // avoid picking the same corner twice in a row

  // L-system
  // lsysString holds the *expanded* string used by the walker (rebuilt from inputs)
  let lsysString = "F";
  let lsysAxiom = "F";
  let lsysRuleF = "F+F-F-F+F";
  let lsysRules = { "F": lsysRuleF };
  let lsysIterations = 2;            // 0..8
  let lsysStep = 1;                  // node stride when moving (>= 1)
  let lsysTurnMode = false;          // when true, '+'/'-' set direction instead of random
  let lsysIndex = 0;

  // Hilbert / ordering paths
  let hilbertNodes = [];
  let hilbertIndex = 0;
  let hilbertMode = "diagonal";      // "diagonal" (legacy x+y sort) | "hilbert" | "zorder"
  let hilbertOrder = 6;              // 1..10 (grid resolution: 2^order)
  let hilbertStep = 1;               // stride through the ordered list
  let hilbertPingPong = false;       // bounce back and forth instead of wrapping
  let hilbertDir = 1;                // internal direction for ping-pong

  // Current transition mode:
  let currentTransitionMode = "uniform";
  // ─────────────────────────────────────────────────────────────
  // Transition mode parameters (exposed via UI)
  // ─────────────────────────────────────────────────────────────

  // Sequential
  let sequentialStep = 1;            // 1..(nodes-1)
  let sequentialDirection = 1;       // +1 forward | -1 backward
  let sequentialSkipRoot = false;    // avoid node 0 if possible

  // Weighted (distance-based)
  let weightedBias = "far";          // "far" | "near"
  let weightedExponent = 1.0;        // curve strength (>= 0.01)
  let weightedMinDistRatio = 0.0;    // 0..1 (filters out too-close nodes)
  let weightedExcludeSelf = true;    // avoid staying on the same node

  // Bounce to root
  let bounceReturnChance = 1.0;      // 0..1 chance to return to node 0 when away
  let bounceAwayMode = "random";     // "random" | "cycle" | "nearest" | "farthest" | "weighted"
  let bounceCycleStep = 1;           // used when bounceAwayMode === "cycle"
  let bounceCycleDir = 1;            // +1/-1
  let bounceAvoidSelf = true;

  // Nearest / Farthest neighbor
  let nearestK = 1;
  let nearestAvoidBacktrack = false;
  let nearestRandomChance = 0.0;

  let farthestK = 1;
  let farthestAvoidBacktrack = false;
  let farthestRandomChance = 0.0;

  // Network controls (network mode uses Node.outputs graph)
  let networkMinOutputs = 0;
  let networkMaxOutputs = 3;         // legacy was 0..3
  let networkPreferOutputs = 1.0;    // 0..1 probability of following outputs vs fallback
  let networkOutputBias = "uniform"; // "uniform" | "near" | "far"
  let networkFallbackMode = "uniform"; // "uniform" | "root" | "sequential" | "nearest" | "farthest"
  let networkAllowSelfLoops = false;

  // Seeded uniform controls
  let seededUniformPerPulse = false;
  let seededUniformPulseSeeds = [];  // derived from seededUniformSeedBase

  // Timing & motion:
  let bpmMode = true;
  let globalBPM = 120;
  let globalSpeed = 100; // px/s if speed mode
  let lastFrameTime = performance.now();
  let animationFrameId = null;

  // For BPM mode:
  let interval = 60000 / globalBPM; // ms per beat

  // Pulser triggers
  let scheduledPulse = false;
  let lastPulseTime = performance.now();

  // Flags
  let playState = "stopped";
  let showTrails = false;

  // UI tidy-up: Live Preview while stopped toggle removed (default OFF).
  // If you ever want it back, set this to true and re-add the toggle UI.
  let livePreviewEnabled = false;

  // Internal: suppress MIDI whenever transport isn't running (and during preview if enabled).
  let __midiSuppressed = true;

  // If you want dynamic velocity based on distance:
  let dynamicVelocityModeEnabled = true;

  // If you want CC changes from velocity, set these:
  let dynamicCCModeEnabled = false;
  let dynamicCCSettings = {};

  // Seeded random
  let seededUniformSeedBase = 1;
  let seededUniformSeed = seededUniformSeedBase;
  function seededRandom() {
    seededUniformSeed = (seededUniformSeed * 16807) % 2147483647;
    return (seededUniformSeed - 1)/2147483646;
  }


  // Seeded-uniform helpers
  function reseedSeededUniformPulseSeeds(){
    seededUniformPulseSeeds = [];
    const base = (seededUniformSeedBase | 0) || 1;
    for(let i=0;i<pulses.length;i++){
      // simple spacing; keep within valid range
      let s = (base + (i * 1013)) % 2147483647;
      if (s <= 0) s += 2147483646;
      seededUniformPulseSeeds[i] = s;
    }
  }

  function syncSeededUniformPulseSeeds(){
    if(!Array.isArray(seededUniformPulseSeeds)) seededUniformPulseSeeds = [];
    const base = (seededUniformSeedBase | 0) || 1;

    if(seededUniformPulseSeeds.length === 0){
      reseedSeededUniformPulseSeeds();
      return;
    }

    if(seededUniformPulseSeeds.length < pulses.length){
      for(let i=seededUniformPulseSeeds.length;i<pulses.length;i++){
        let s = (base + (i * 1013)) % 2147483647;
        if (s <= 0) s += 2147483646;
        seededUniformPulseSeeds[i] = s;
      }
    } else if(seededUniformPulseSeeds.length > pulses.length){
      seededUniformPulseSeeds.length = pulses.length;
    }
  }

  function restartSeededUniformSequence(){
    seededUniformSeed = seededUniformSeedBase;
    reseedSeededUniformPulseSeeds();
  }

  function seededRandomPulse(pulse){
    const pid = pulse ? (pulse.id | 0) : 0;
    syncSeededUniformPulseSeeds();

    let s = seededUniformPulseSeeds[pid];
    if (!Number.isFinite(s) || s <= 0) s = seededUniformSeedBase;
    s = (s * 16807) % 2147483647;
    seededUniformPulseSeeds[pid] = s;
    return (s - 1) / 2147483646;
  }


  // A random usage helper
  function getRandom() {
    // fallback to Math.random or something more stable
    return Math.random();
  }

  // ─────────────────────────────────────────────────────────────
  // 2) Morph/Space + LFO
  // ─────────────────────────────────────────────────────────────
  let currentMorphValue = 0;
  let currentSpaceValue = 0;

  // LFO states: (morph, space)
  let morphLFOEnabled = false;
  let morphLFOSpeed = 0.1;
  let morphLFODepth = 20;
  let morphLFOPhase = 0;

  let spaceLFOEnabled = false;
  let spaceLFOSpeed = 0.1;
  let spaceLFODepth = 20;
  let spaceLFOPhase = 0;

  function applyLFOs(delta) {
    // Morph
    if(morphLFOEnabled) {
      morphLFOPhase += delta * morphLFOSpeed * 2*Math.PI;
      // NOTE: bipolar LFO around the base slider value (more intuitive) so
      // it can travel down to 0 and reliably trigger the "morph reset" path
      // that clears morphTargetX/Y.
      const baseMorph = parseFloat(morphSlider.value);
      let m = baseMorph + (Math.sin(morphLFOPhase) * morphLFODepth);
      // Clamp and *snap* to exact endpoints so the reset logic triggers reliably
      // even if floating point never hits an exact 0.
      if(!Number.isFinite(m)) m = baseMorph || 0;
      if(m <= 0.01) m = 0;
      if(m >= 99.99) m = 100;
      currentMorphValue = Math.max(0, Math.min(100, m));
    }

    // Space
    if(spaceLFOEnabled) {
      spaceLFOPhase += delta * spaceLFOSpeed * 2*Math.PI;
      const baseSpace = parseFloat(spaceSlider.value);
      let s = baseSpace + (Math.sin(spaceLFOPhase) * spaceLFODepth);
      if(!Number.isFinite(s)) s = baseSpace || 0;
      if(s <= 0.01) s = 0;
      if(s >= 99.99) s = 100;
      currentSpaceValue = Math.max(0, Math.min(100, s));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3) Node & Pulse Objects
  // ─────────────────────────────────────────────────────────────
  class Node {
    constructor(id, x, y) {
      this.id = id;
      this.baseX = x;
      this.baseY = y;
      this.x = x;
      this.y = y;

      // For morph
      this.morphTargetX = null;
      this.morphTargetY = null;
      this.morphedX = x;
      this.morphedY = y;

      // For network mode connections
      this.outputs = [];

      // For drawing flash effect
      this.flashUntil = 0;
    }

    draw() {
      // Screen-consistent sizes (so zoom/auto-fit doesn't make nodes feel huge)
      const scale = (typeof __view !== "undefined" && __view && __view.scale) ? __view.scale : 1;

      let now = performance.now();
      let flash = (now < this.flashUntil);

      let baseRadius = 6 / scale;
      // node radius depends on connections (subtle)
      let connectionCount = this.outputs.length;
      let radius = baseRadius + (connectionCount * 0.25) / scale;

      ctx.beginPath();
      ctx.arc(this.x, this.y, radius, 0, 2*Math.PI);
      ctx.fillStyle = flash ? "yellow" : "#fff";
      ctx.fill();

      // label (keep readable regardless of zoom)
      ctx.fillStyle = "#000";
      const fontPx = Math.max(7, 10 / scale);
      ctx.font = `${fontPx}px Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.id, this.x, this.y);

      // connections: only meaningful in Network mode (outputs graph)
      const drawConnections = showNetworkConnections && (currentTransitionMode === "network") && (connectionCount > 0);
      if(drawConnections) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1 / scale;
        this.outputs.forEach(outId => {
          let outNode = nodes[outId];
          if(outNode) {
            ctx.beginPath();
            ctx.moveTo(this.x, this.y);
            ctx.lineTo(outNode.x, outNode.y);
            ctx.stroke();
          }
        });
      }
    }

    flash() {
      this.flashUntil = performance.now() + 100;
    }
  }

  class Pulse {
    constructor(id) {
      this.id = id;
      this.enabled = true;

      // Machinedrum track controls
      this.muted = false;
      this.soloed = false;
      this.color = getPulseColor(id);

      this.currentNode = nodes[0]; // start at node 0
      this.targetNode = nodes[0];
      this.x = this.currentNode.x;
      this.y = this.currentNode.y;

      // For movement:
      this.startTime = performance.now();
      this.timingRatio = 1;
      this.travelTime = interval; // ms
      this.progress = 0;

      // For speed mode:
      this.speed = globalSpeed;

      // A short trail buffer:
      this.trail = [];
      this.trailMax = 25;

      // MIDI note/channel for this pulse:
      this.note = 60;
      this.channel = 0;

      // If waiting for manual trigger
      this.pendingTrigger = false;

      // Strategy helpers
      // - prevNode: used by nearest/farthest controls (avoid backtracking)
      this.prevNode = null;
      // - lsysDir: per-pulse direction when L-system turn mode is enabled
      this.lsysDir = 1;
      // - bounceCycleIndex: per-pulse counter for Bounce→Cycle mode
      this.bounceCycleIndex = 0;
    }

    update(delta) {
      if(!this.enabled) return;

      let now = performance.now();

      // If in BPM mode:
      if(bpmMode) {
        // If we haven't triggered, skip
        if(this.pendingTrigger) return;

        let elapsed = now - this.startTime;
        this.progress = elapsed / this.travelTime;
        if(this.progress >= 1) {
          // snap to target
          this.prevNode = this.currentNode;
          this.currentNode = this.targetNode;
          this.x = this.currentNode.x;
          this.y = this.currentNode.y;
          // add to trail
          this.trail.push({ x: this.x, y: this.y });
          if(this.trail.length > this.trailMax) this.trail.shift();

          // check if node 0 => trigger MIDI (if not muted / passes solo)
          if(this.currentNode.id === 0) {
            if(pulseShouldSound(this)) {
              sendMidiNote(this);
              this.currentNode.flash();
            }
          }

          // choose new target
          this.targetNode = transitionSelector(this.currentNode, this);
          this.startTime = now;
          applyPulseSegmentTiming(this, this.currentNode, this.targetNode);
          this.progress = 0;
        } else {
          // interpolate from currentNode to targetNode
          let sx = this.currentNode.x;
          let sy = this.currentNode.y;
          let tx = this.targetNode.x;
          let ty = this.targetNode.y;
          const t = smoothstep01(this.progress);
          this.x = sx + (tx - sx)*t;
          this.y = sy + (ty - sy)*t;
        }
      } else {
        // Speed mode:
        // Move towards target at speed px/s
        let dx = this.targetNode.x - this.x;
        let dy = this.targetNode.y - this.y;
        let dist = Math.sqrt(dx*dx + dy*dy);
        if(dist < 1) {
          // arrived
          this.prevNode = this.currentNode;
          this.currentNode = this.targetNode;
          this.x = this.currentNode.x;
          this.y = this.currentNode.y;
          this.trail.push({x:this.x,y:this.y});
          if(this.trail.length>this.trailMax) this.trail.shift();

          if(this.currentNode.id === 0) {
            if(pulseShouldSound(this)) {
              sendMidiNote(this);
              this.currentNode.flash();
            }
          }

          this.targetNode = transitionSelector(this.currentNode, this);
          applyPulseSegmentTiming(this, this.currentNode, this.targetNode);
        } else {
          let step = this.speed * delta;
          if(step > dist) step = dist;
          this.x += (dx/dist)*step;
          this.y += (dy/dist)*step;
        }
      }
    }

    draw() {
      if(!this.enabled) return;

      // draw trail
      if(showTrails && this.trail.length>1) {
        ctx.strokeStyle = "rgba(0,255,255,0.3)";
        ctx.beginPath();
        for(let i=0; i<this.trail.length; i++){
          let pt = this.trail[i];
          if(i===0) ctx.moveTo(pt.x,pt.y);
          else ctx.lineTo(pt.x,pt.y);
        }
        ctx.stroke();
      }

      // draw pulse circle
      ctx.beginPath();
      ctx.arc(this.x, this.y, 6, 0, 2*Math.PI);
      ctx.fillStyle = "cyan";
      ctx.fill();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 4) Transition Strategies
  // ─────────────────────────────────────────────────────────────


  // Helpers used by multiple strategies
  function wrapIndex(i, len){
    if(len <= 0) return 0;
    let r = i % len;
    if(r < 0) r += len;
    return r;
  }

  function clampInt(v, min, max, fallback){
    const n = parseInt(v, 10);
    if(!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clampFloat(v, min, max, fallback){
    const n = parseFloat(v);
    if(!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function pickWeightedIndex(weights){
    let sum = 0;
    for(let i=0;i<weights.length;i++){
      const w = weights[i];
      if(Number.isFinite(w) && w > 0) sum += w;
    }
    if(!(sum > 0)) return -1;
    let r = getRandom() * sum;
    let acc = 0;
    for(let i=0;i<weights.length;i++){
      const w = weights[i];
      if(!(Number.isFinite(w) && w > 0)) continue;
      acc += w;
      if(acc >= r) return i;
    }
    return weights.length - 1;
  }

  function dist2(a, b){
    const dx = (b.x - a.x);
    const dy = (b.y - a.y);
    return dx*dx + dy*dy;
  }

  function dist(a, b){
    return Math.sqrt(dist2(a,b));
  }


  const transitionStrategies = {

    uniform: (cur, arr)=>{
      return arr[Math.floor(getRandom()*arr.length)];
    },

    sequential: (cur, arr)=>{
      if(!cur) return arr[0];
      const len = arr.length;
      if(len <= 1) return arr[0];

      let step = clampInt(sequentialStep, 1, 64, 1);
      let dir = (sequentialDirection === -1) ? -1 : 1;

      let nextId = wrapIndex(cur.id + (dir * step), len);

      if(sequentialSkipRoot && len > 1 && nextId === 0){
        nextId = wrapIndex(nextId + dir, len);
      }

      // Avoid returning the same node if possible
      if(nextId === cur.id && len > 1){
        nextId = wrapIndex(nextId + dir, len);
        if(sequentialSkipRoot && len > 1 && nextId === 0){
          nextId = wrapIndex(nextId + dir, len);
        }
      }

      return arr[nextId];
    },

    weighted: (cur, arr)=>{
      // Weighted by distance from current: further nodes more likely
      if(!cur) return arr[0];
      let distances = arr.map(n=>{
        let dx = n.x - cur.x;
        let dy = n.y - cur.y;
        let d = Math.sqrt(dx*dx + dy*dy);
        return d;
      });
      let sum = distances.reduce((a,b)=>a+b,0);
      let r = getRandom()*sum;
      let accum=0;
      for(let i=0;i<arr.length;i++){
        accum += distances[i];
        if(accum>=r) return arr[i];
      }
      return arr[arr.length-1];
    },

    network: (cur, arr, pulse)=>{
      if(!cur) return arr[0];
      const len = arr.length;
      if(len <= 1) return arr[0];

      const prefer = clampFloat(networkPreferOutputs, 0, 1, 1);
      const hasOutputs = cur.outputs && cur.outputs.length > 0;
      const followOutputs = hasOutputs && (getRandom() <= prefer);

      if(followOutputs){
        const outs = cur.outputs;
        const candidates = [];
        for(let i=0;i<outs.length;i++){
          const id = outs[i];
          const n = arr[id];
          if(n) candidates.push(n);
        }

        if(candidates.length > 0){
          if(networkOutputBias === "near" || networkOutputBias === "far"){
            const weights = candidates.map(n=>{
              const d = dist(cur, n) + 1e-6;
              return (networkOutputBias === "near") ? (1 / d) : d;
            });
            const wi = pickWeightedIndex(weights);
            if(wi >= 0) return candidates[wi];
          }
          return candidates[Math.floor(getRandom() * candidates.length)];
        }
      }

      // Fallback behaviour when no outputs (or skipping outputs)
      switch(networkFallbackMode){
        case "root": return arr[0];
        case "sequential": return transitionStrategies.sequential(cur, arr, pulse);
        case "nearest": return transitionStrategies.nearest(cur, arr, pulse);
        case "farthest": return transitionStrategies.farthest(cur, arr, pulse);
        default:
          return arr[Math.floor(getRandom() * len)];
      }
    },

    // Bounce to Root (Rhythmic):
    // - Legacy behaviour: always return to root when away (bounceReturnChance = 1)
    // - Extra controls: return chance + away selection mode
    bounceRoot: (cur, arr, pulse) => {
      const len = arr.length;
      if (len <= 0) return null;
      if (len < 2) return arr[0];

      const root = arr[0];

      const pickAway = (fromNode) => {
        // choose among non-root nodes
        if (len < 2) return root;

        const mode = bounceAwayMode || "random";

        if (mode === "cycle") {
          const nonRootCount = len - 1;
          if (nonRootCount <= 0) return root;

          const step = clampInt(bounceCycleStep, 1, 64, 1);
          const dir = (bounceCycleDir === -1) ? -1 : 1;

          let idx = wrapIndex((pulse ? (pulse.bounceCycleIndex | 0) : 0), nonRootCount);
          let picked = arr[1 + idx];

          // Avoid picking self when possible
          if (bounceAvoidSelf && fromNode && picked && picked.id === fromNode.id && nonRootCount > 1) {
            idx = wrapIndex(idx + dir, nonRootCount);
            picked = arr[1 + idx];
          }

          if (pulse) pulse.bounceCycleIndex = wrapIndex(idx + dir * step, nonRootCount);
          return picked || root;
        }

        if (mode === "nearest") {
          let best = null;
          let bestD = Infinity;
          for (let i = 1; i < len; i++) {
            const n = arr[i];
            if (!n) continue;
            if (bounceAvoidSelf && fromNode && n.id === fromNode.id) continue;
            const d = dist2(fromNode || root, n);
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
          return best || arr[1];
        }

        if (mode === "farthest") {
          let best = null;
          let bestD = -1;
          for (let i = 1; i < len; i++) {
            const n = arr[i];
            if (!n) continue;
            if (bounceAvoidSelf && fromNode && n.id === fromNode.id) continue;
            const d = dist2(fromNode || root, n);
            if (d > bestD) {
              bestD = d;
              best = n;
            }
          }
          return best || arr[len - 1];
        }

        if (mode === "weighted") {
          const base = fromNode || root;
          const bias = (weightedBias === "near") ? "near" : "far";
          const exponent = clampFloat(weightedExponent, 0.01, 20, 1.0);
          const minRatio = clampFloat(weightedMinDistRatio, 0, 1, 0.0);
          const eps = 1e-6;

          const candidates = [];
          const ds = [];
          let maxD = 0;

          for (let i = 1; i < len; i++) {
            const n = arr[i];
            if (!n) continue;
            if (bounceAvoidSelf && fromNode && n.id === fromNode.id) continue;
            const d = Math.sqrt(dist2(base, n));
            candidates.push(n);
            ds.push(d);
            if (d > maxD) maxD = d;
          }

          if (candidates.length === 0) return root;

          let indices = [];
          for (let i = 0; i < ds.length; i++) {
            if (minRatio > 0 && maxD > 0 && ds[i] < maxD * minRatio) continue;
            indices.push(i);
          }
          if (indices.length === 0) indices = ds.map((_, i) => i);

          const weights = indices.map(i => {
            const d = ds[i] + eps;
            const w0 = (bias === "near") ? (1 / d) : d;
            return Math.pow(w0, exponent);
          });

          const wi = pickWeightedIndex(weights);
          if (wi >= 0) return candidates[indices[wi]];
          return candidates[Math.floor(getRandom() * candidates.length)];
        }

        // random (default)
        if (len === 2) return arr[1];
        let pick = 1 + Math.floor(getRandom() * (len - 1));
        if (bounceAvoidSelf && fromNode && arr[pick] && arr[pick].id === fromNode.id && (len - 1) > 1) {
          pick = 1 + ((pick - 1 + 1) % (len - 1));
        }
        return arr[pick] || root;
      };

      if (!cur) return root;

      if (cur.id === 0) {
        return pickAway(root);
      }

      const chance = clampFloat(bounceReturnChance, 0, 1, 1.0);
      if (getRandom() <= chance) return root;

      return pickAway(cur);
    },

    // Nearest Neighbor (Smooth): k-nearest + optional backtrack avoidance
    nearest: (cur, arr, pulse) => {
      if(!cur) return arr[0];
      const len = arr.length;
      if(len <= 1) return arr[0];

      const randChance = clampFloat(nearestRandomChance, 0, 1, 0.0);
      if(getRandom() < randChance){
        return arr[Math.floor(getRandom() * len)];
      }

      const k = clampInt(nearestK, 1, 64, 1);
      const avoidBack = !!nearestAvoidBacktrack;
      const backId = (avoidBack && pulse && pulse.prevNode) ? pulse.prevNode.id : -1;

      const pairs = [];
      for (let i = 0; i < len; i++) {
        const n = arr[i];
        if (!n || n === cur) continue;
        if (avoidBack && backId >= 0 && n.id === backId) continue;
        pairs.push({ n, d: dist2(cur, n) });
      }

      // If everything got filtered, relax the backtrack rule
      if (pairs.length === 0) {
        for (let i = 0; i < len; i++) {
          const n = arr[i];
          if (!n || n === cur) continue;
          pairs.push({ n, d: dist2(cur, n) });
        }
      }

      pairs.sort((a, b) => a.d - b.d);
      const kk = Math.min(k, pairs.length);
      const pick = pairs[Math.floor(getRandom() * kk)];
      return pick ? pick.n : arr[0];
    },

    // Farthest Jump (Energetic): top-k farthest + optional backtrack avoidance
    farthest: (cur, arr, pulse) => {
      if(!cur) return arr[0];
      const len = arr.length;
      if(len <= 1) return arr[0];

      const randChance = clampFloat(farthestRandomChance, 0, 1, 0.0);
      if(getRandom() < randChance){
        return arr[Math.floor(getRandom() * len)];
      }

      const k = clampInt(farthestK, 1, 64, 1);
      const avoidBack = !!farthestAvoidBacktrack;
      const backId = (avoidBack && pulse && pulse.prevNode) ? pulse.prevNode.id : -1;

      const pairs = [];
      for (let i = 0; i < len; i++) {
        const n = arr[i];
        if (!n || n === cur) continue;
        if (avoidBack && backId >= 0 && n.id === backId) continue;
        pairs.push({ n, d: dist2(cur, n) });
      }

      if (pairs.length === 0) {
        for (let i = 0; i < len; i++) {
          const n = arr[i];
          if (!n || n === cur) continue;
          pairs.push({ n, d: dist2(cur, n) });
        }
      }

      pairs.sort((a, b) => b.d - a.d);
      const kk = Math.min(k, pairs.length);
      const pick = pairs[Math.floor(getRandom() * kk)];
      return pick ? pick.n : arr[0];
    },

    seededUniform: (cur, arr, pulse)=>{
      const len = arr.length;
      if(len <= 0) return null;
      const r = seededUniformPerPulse ? seededRandomPulse(pulse) : seededRandom();
      let idx = Math.floor(r * len);
      if(idx < 0) idx = 0;
      if(idx >= len) idx = len - 1;
      return arr[idx];
    },


    // 1) Wolfram CA
    wolfram: (cur, arr, pulse)=>{
      // each "step bucket" = one beat in bpm mode, or time bucket in speed mode
      let bucket = wolframLastStepBucket;
      let now = performance.now();
      let newBucket = bpmMode ? Math.floor(now/interval) : Math.floor(now/200);
      if(newBucket !== bucket){
        wolframLastStepBucket = newBucket;
        // Step CA once per bucket. In per-pulse mode we advance each pulse's
        // state line separately (optionally with per-pulse rule offsets).
        if (wolframPerPulse) {
          stepWolframPulses(arr.length);
        } else {
          stepWolfram(arr.length);
        }
      }
      // pick next node based on wolfram state
      if(!cur) return arr[0];
      let i = cur.id;
      // if state[i] == 1 => go forward, else backward
      let dir = 0;
      if (wolframPerPulse && pulse && wolframPulseStates && wolframPulseStates.length) {
        const pid = pulse.id | 0;
        const st = wolframPulseStates[pid];
        dir = (st && st.length) ? (st[i] || 0) : (wolframState[i] || 0);
      } else {
        dir = wolframState[i] || 0;
      }
      let nextId = (dir===1) ? (i+1)%arr.length : (i-1+arr.length)%arr.length;
      return arr[nextId];
    },

    // 2) Life-like
    life: (cur, arr)=>{
      let now = performance.now();
      let newBucket = bpmMode ? Math.floor(now/interval) : Math.floor(now/200);
      if(newBucket !== lifeLastStepBucket){
        lifeLastStepBucket = newBucket;
        stepLife();
      }
      // pick next node from alive cells in lifeGrid
      // flatten alive => node indices
      let alive = [];
      for(let r=0;r<lifeRows;r++){
        for(let c=0;c<lifeCols;c++){
          if(lifeGrid[r][c]===1){
            let idx = (r*lifeCols + c) % arr.length;
            alive.push(idx);
          }
        }
      }
      if(alive.length===0){
        return arr[Math.floor(getRandom()*arr.length)];
      }
      let pick = alive[Math.floor(getRandom()*alive.length)];
      return arr[pick];
    },

    // 3) chaos game
    chaos: (cur, arr)=>{
      // chaosPoints are precomputed
      if(chaosPoints.length===0) buildChaosPoints(arr);
      let pt = chaosPoints[chaosIndex % chaosPoints.length];
      chaosIndex++;
      // find nearest node to pt
      let best = arr[0];
      let bestD = Infinity;
      arr.forEach(n=>{
        let dx=n.x-pt.x, dy=n.y-pt.y;
        let dd=dx*dx+dy*dy;
        if(dd<bestD){bestD=dd;best=n;}
      });
      return best;
    },

    // 4) L-system
    lsys: (cur, arr, pulse)=>{
      const len = arr.length;
      if(len <= 0) return null;
      if(!cur) return arr[0];

      if(lsysString.length === 0) buildLsys();

      // interpret next char
      const ch = lsysString[lsysIndex % lsysString.length];
      lsysIndex++;

      const step = clampInt(lsysStep, 1, 64, 1);

      if(lsysTurnMode && pulse){
        if(ch === '+') pulse.lsysDir = 1;
        else if(ch === '-') pulse.lsysDir = -1;
      }

      // Move on 'F'. If turn-mode is enabled, also move on '+' / '-' (after updating direction).
      if(ch === 'F' || (lsysTurnMode && (ch === '+' || ch === '-'))){
        const dir = (pulse && pulse.lsysDir === -1) ? -1 : 1;
        const nextId = wrapIndex(cur.id + dir * step, len);
        return arr[nextId];
      }

      // Other symbols => random hop
      return arr[Math.floor(getRandom() * len)];
    },

    // 5) Hilbert
    hilbert: (cur, arr)=>{
      if(hilbertNodes.length!==arr.length) buildHilbert(arr);
      if(hilbertNodes.length===0) return arr[0];

      const step = clampInt(hilbertStep, 1, 64, 1);

      if(hilbertPingPong){
        const out = hilbertNodes[wrapIndex(hilbertIndex, hilbertNodes.length)];
        hilbertIndex += step * hilbertDir;

        // bounce at ends
        if(hilbertIndex >= hilbertNodes.length){
          hilbertDir = -1;
          hilbertIndex = hilbertNodes.length - 1;
        } else if(hilbertIndex < 0){
          hilbertDir = 1;
          hilbertIndex = 0;
        }
        return out;
      } else {
        const out = hilbertNodes[wrapIndex(hilbertIndex, hilbertNodes.length)];
        hilbertIndex = wrapIndex(hilbertIndex + step, hilbertNodes.length);
        return out;
      }
    }
  };

  function transitionSelector(curNode, pulse) {
    let strat = transitionStrategies[currentTransitionMode];
    if(!strat) strat = transitionStrategies.uniform;
    return strat(curNode, nodes, pulse);
  }

  // ── Rhythmic timing variation (no UI) ─────────────────────────
  // Adds musically-quantized per-segment timing, derived from the existing
  // transition maths (distance/step/etc). This yields more rhythmic variety
  // in both BPM and Speed modes without adding extra controls.
  const __RHYTHM_RATIOS = [1/3, 1/2, 2/3, 3/4, 1, 4/3, 3/2, 2];

  function __clamp01(x){
    return (x < 0) ? 0 : (x > 1 ? 1 : x);
  }

  function __nodeDist01(a, b){
    if(!a || !b) return 0.5;
    if(a === b || a.id === b.id) return 0;

    const bb = computeNodesBounds();
    const w = Math.max(1, bb.maxX - bb.minX);
    const h = Math.max(1, bb.maxY - bb.minY);
    const diag = Math.sqrt(w*w + h*h);
    if(!Number.isFinite(diag) || diag <= 0) return 0.5;

    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    return __clamp01(d / diag);
  }

  function __pickRhythmRatio(t01, pulse){
    const n = __RHYTHM_RATIOS.length;
    const pos = t01 * (n - 1);

    // gentle wobble so repeats aren't identical, biased per-pulse
    const pulseBias = pulse ? (((pulse.id|0) % 3) - 1) * 0.18 : 0;
    const jitter = (getRandom() - 0.5) * 0.9 + pulseBias;

    let idx = Math.round(pos + jitter);
    if(idx < 0) idx = 0;
    if(idx >= n) idx = n - 1;

    return __RHYTHM_RATIOS[idx];
  }

  function computeTimingRatioForSegment(fromNode, toNode, pulse){
    const mode = currentTransitionMode;

    // Keep baseline modes tight/predictable
    if(mode === "uniform" || mode === "seededUniform" || mode === "wolfram" || mode === "life"){
      return 1;
    }

    if(!fromNode || !toNode || fromNode === toNode || fromNode.id === toNode.id){
      return 1;
    }

    let t = __nodeDist01(fromNode, toNode);

    // Mode-specific shaping (still leverages existing mode parameters)
    if(mode === "nearest"){
      t = __clamp01(t * 0.6);
    } else if(mode === "farthest"){
      t = __clamp01(t * 1.15);
    } else if(mode === "bounceRoot"){
      // root snaps faster, away drifts slower
      if(toNode.id === 0){
        t = __clamp01(t * (0.6 + 0.25 * (1 - bounceReturnChance)));
      } else {
        t = __clamp01(t * (0.95 + 0.3 * bounceReturnChance));
      }
    } else if(mode === "weighted"){
      // higher exponent -> more extreme jumps -> slightly slower overall
      const ex = clampFloat(weightedExponent, 0.01, 20, 1);
      const exNorm = __clamp01((ex - 1) / 8);
      t = __clamp01(t + exNorm * 0.15);
    } else if(mode === "sequential"){
      // larger step -> slightly slower
      const s = clampInt(sequentialStep, 1, 64, 1);
      t = __clamp01(t + (s / 64) * 0.18);
    } else if(mode === "network"){
      // more output-following -> a touch snappier
      const p = clampFloat(networkPreferOutputs, 0, 1, 1);
      t = __clamp01(t * (0.9 - 0.2 * p) + 0.05);
    } else if(mode === "chaos"){
      // smaller step fraction tends more local moves -> faster
      const frac = clampFloat(chaosStepFraction, 0.05, 0.95, 0.5);
      t = __clamp01(t * (0.85 + (1 - frac) * 0.35));
    } else if(mode === "lsys"){
      const s = clampInt(lsysStep, 1, 64, 1);
      t = __clamp01(t + (s / 64) * 0.18);
    } else if(mode === "hilbert"){
      const s = clampInt(hilbertStep, 1, 64, 1);
      t = __clamp01(t + (s / 64) * 0.14);
    }

    const r = __pickRhythmRatio(t, pulse);
    return (Number.isFinite(r) && r > 0) ? r : 1;
  }

  function applyPulseSegmentTiming(pulse, fromNode, toNode){
    if(!pulse) return;

    const ratio = computeTimingRatioForSegment(fromNode, toNode, pulse);
    pulse.timingRatio = ratio;

    if(bpmMode){
      const tt = interval * ratio;
      const minT = Math.max(50, interval / 4);
      const maxT = interval * 4;
      pulse.travelTime = Math.max(minT, Math.min(maxT, tt));
    } else {
      const sp = globalSpeed / ratio;
      pulse.speed = Math.max(10, Math.min(8000, sp));
    }
  }

  // Wolfram step
  function stepWolfram(ncount){
    if(wolframState.length!==ncount) {
      // init
      wolframState = new Array(ncount).fill(0);
      wolframNext = new Array(ncount).fill(0);
      // random init
      wolframState[Math.floor(getRandom()*ncount)] = 1;
    }
    for(let i=0;i<ncount;i++){
      let left = wolframState[(i-1+ncount)%ncount];
      let center= wolframState[i];
      let right = wolframState[(i+1)%ncount];
      let pattern = (left<<2)|(center<<1)|right;
      let bit = (wolframRule >> pattern) & 1;
      wolframNext[i] = bit;
    }
    // swap
    let tmp = wolframState;
    wolframState = wolframNext;
    wolframNext = tmp;
  }

  // Wolfram per-pulse stepping (requested)
  // Each pulse gets its own 1D CA state line so pulses don't collapse into the
  // same deterministic path when they share a start node.
  function __gcd(a, b){
    a = Math.abs(a|0);
    b = Math.abs(b|0);
    while(b){
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  function __wolframCoprimeStep(n){
    // Prefer small odd numbers that are likely coprime to typical node counts.
    const candidates = [7,5,3,11,13,17,19,23,29,31];
    for(const c of candidates){
      if(c < n && __gcd(c, n) === 1) return c;
    }
    return 1;
  }

  function ensureWolframPulseStates(ncount){
    const pcount = pulses.length;
    if(ncount <= 0 || pcount <= 0) {
      wolframPulseStates = [];
      wolframPulseNext = [];
      return;
    }

    const needsInit =
      !Array.isArray(wolframPulseStates) ||
      !Array.isArray(wolframPulseNext) ||
      wolframPulseStates.length !== pcount ||
      wolframPulseNext.length !== pcount ||
      !wolframPulseStates[0] ||
      wolframPulseStates[0].length !== ncount;

    if(!needsInit) return;

    wolframPulseStates = [];
    wolframPulseNext = [];

    const step = __wolframCoprimeStep(ncount);
    const seedOffset = Math.floor(getRandom() * ncount);

    for(let p=0; p<pcount; p++){
      const st = new Array(ncount).fill(0);
      const nx = new Array(ncount).fill(0);

      // Deterministic-yet-diverse seeding:
      // one-hot bit distributed around the ring by a coprime step.
      const idx = (seedOffset + (p * step)) % ncount;
      st[idx] = 1;

      wolframPulseStates.push(st);
      wolframPulseNext.push(nx);
    }
  }

  function stepWolframPulses(ncount){
    ensureWolframPulseStates(ncount);
    if(!wolframPulseStates.length) return;

    for(let p=0; p<wolframPulseStates.length; p++){
      const state = wolframPulseStates[p];
      const next  = wolframPulseNext[p];
      const rule  = (wolframRule + (p * wolframRuleSpread)) & 255;

      for(let i=0; i<ncount; i++){
        const left   = state[(i-1+ncount)%ncount];
        const center = state[i];
        const right  = state[(i+1)%ncount];
        const pattern = (left<<2) | (center<<1) | right;
        next[i] = (rule >> pattern) & 1;
      }

      // swap buffers
      wolframPulseStates[p] = next;
      wolframPulseNext[p] = state;
    }
  }

  // Life step
  function parseLifeRule(str){
    // Example "B3/S23"
    let parts = str.split("/");
    let b = [], s=[];
    parts.forEach(p=>{
      if(p.startsWith("B")){
        b = p.substring(1).split("").map(x=>parseInt(x));
      } else if(p.startsWith("S")){
        s = p.substring(1).split("").map(x=>parseInt(x));
      }
    });
    return {birth:b, survive:s};
  }
  function initLifeGrid(){
    let total = lifeRows*lifeCols;
    lifeGrid = [];
    for(let r=0;r<lifeRows;r++){
      let row=[];
      for(let c=0;c<lifeCols;c++){
        // random alive
        row.push(getRandom()<0.3 ? 1 : 0);
      }
      lifeGrid.push(row);
    }
  }
  function stepLife(){
    let rule = parseLifeRule(lifeRule);
    let newGrid=[];
    for(let r=0;r<lifeRows;r++){
      let row=[];
      for(let c=0;c<lifeCols;c++){
        let alive = lifeGrid[r][c];
        let nb = countLifeNeighbors(r,c);
        if(alive){
          row.push(rule.survive.includes(nb)?1:0);
        } else {
          row.push(rule.birth.includes(nb)?1:0);
        }
      }
      newGrid.push(row);
    }
    lifeGrid=newGrid;
  }
  function countLifeNeighbors(r,c){
    let sum=0;
    for(let dr=-1;dr<=1;dr++){
      for(let dc=-1;dc<=1;dc++){
        if(dr===0 && dc===0) continue;
        let rr=(r+dr+lifeRows)%lifeRows;
        let cc=(c+dc+lifeCols)%lifeCols;
        sum+= lifeGrid[rr][cc];
      }
    }
    return sum;
  }

  // Chaos points
  function buildChaosPoints(arr){
    chaosPoints.length = 0;
    chaosIndex = 0;

    const count = arr.length;
    const desiredCorners = clampInt(chaosCornerCount, 3, 8, 4);
    const cornerCount = Math.min(Math.max(3, desiredCorners), count);
    if(cornerCount < 3) return;

    const fraction = clampFloat(chaosStepFraction, 0.05, 0.95, 0.5);
    const burnIn = clampInt(chaosBurnIn, 0, 2000, 0);
    const points = clampInt(chaosPointCount, 50, 10000, 200);

    // Corner selection
    let corners = [];
    if(chaosCornerMode === "spread"){
      // Farthest-point sampling to pick well-spaced corners
      const used = new Set();

      // pick first: min (x+y)
      let first = arr[0];
      let bestKey = Infinity;
      for(let i=0;i<count;i++){
        const n = arr[i];
        const key = (n.x + n.y);
        if(key < bestKey){
          bestKey = key;
          first = n;
        }
      }
      corners.push(first);
      used.add(first.id);

      while(corners.length < cornerCount){
        let best = null;
        let bestD = -1;
        for(let i=0;i<count;i++){
          const n = arr[i];
          if(!n || used.has(n.id)) continue;

          // distance to nearest already-chosen corner
          let nearest = Infinity;
          for(let j=0;j<corners.length;j++){
            const c = corners[j];
            const d = dist2(n, c);
            if(d < nearest) nearest = d;
          }
          if(nearest > bestD){
            bestD = nearest;
            best = n;
          }
        }
        if(!best) break;
        corners.push(best);
        used.add(best.id);
      }

      // If we couldn't fill for some reason, fall back
      if(corners.length < 3){
        corners = arr.slice(0, Math.min(4, count));
      }
    } else {
      corners = arr.slice(0, cornerCount);
    }

    if(corners.length < 3) return;

    // Start at corner 0
    let x = corners[0].x;
    let y = corners[0].y;
    let lastCorner = -1;

    const total = burnIn + points;
    for(let i=0;i<total;i++){
      let ci = Math.floor(getRandom() * corners.length);
      if(chaosNoRepeatCorners && corners.length > 1){
        let guard = 0;
        while(ci === lastCorner && guard < 12){
          ci = Math.floor(getRandom() * corners.length);
          guard++;
        }
      }
      lastCorner = ci;
      const c = corners[ci];

      x = x + (c.x - x) * fraction;
      y = y + (c.y - y) * fraction;

      if(i >= burnIn) chaosPoints.push({ x, y });
    }
    chaosIndex = 0;
  }

  // L-sys build

function buildLsys(){
    // Rebuild from UI parameters
    const ax = (typeof lsysAxiom === "string" && lsysAxiom.length) ? lsysAxiom : "F";
    const ruleF = (typeof lsysRuleF === "string") ? lsysRuleF : "F";

    lsysRules = { "F": ruleF };

    const iters = clampInt(lsysIterations, 0, 10, 2);

    let str = ax;
    for(let iter=0; iter<iters; iter++){
      let out = "";
      for(let i=0; i<str.length; i++){
        const ch = str[i];
        if(lsysRules[ch] !== undefined) out += lsysRules[ch];
        else out += ch;
      }
      str = out;

      // Safety cap (prevents runaway rules from freezing the page)
      if(str.length > 20000) break;
    }

    lsysString = str;
    lsysIndex = 0;
  }


  // Hilbert build
  function buildHilbert(arr){
    // Builds an ordered list of nodes using a chosen space-filling-ish order.
    // - diagonal: legacy (x+y)
    // - hilbert: map to a 2^order grid, then compute Hilbert distance
    // - zorder:  map to grid, then compute Morton (Z-order) code
    const len = arr.length;

    hilbertNodes = [];
    hilbertIndex = 0;
    hilbertDir = 1;

    if(len <= 0) return;

    const mode = hilbertMode || "diagonal";

    if(mode === "diagonal"){
      hilbertNodes = arr.slice().sort((a,b)=>{
        const da = (a.x + a.y);
        const db = (b.x + b.y);
        if(da !== db) return da - db;
        return (a.id|0) - (b.id|0);
      });
      return;
    }

    const order = clampInt(hilbertOrder, 1, 10, 6);
    const grid = 1 << order;

    // bounds
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for(let i=0;i<len;i++){
      const n = arr[i];
      if(!n) continue;
      if(n.x < minX) minX = n.x;
      if(n.x > maxX) maxX = n.x;
      if(n.y < minY) minY = n.y;
      if(n.y > maxY) maxY = n.y;
    }
    const dx = maxX - minX;
    const dy = maxY - minY;

    function toGridX(x){
      if(!(dx > 0)) return (grid >> 1);
      const t = (x - minX) / dx;
      return Math.max(0, Math.min(grid - 1, Math.floor(t * (grid - 1))));
    }
    function toGridY(y){
      if(!(dy > 0)) return (grid >> 1);
      const t = (y - minY) / dy;
      return Math.max(0, Math.min(grid - 1, Math.floor(t * (grid - 1))));
    }

    // Hilbert helpers (from classic xy→d algorithm)
    function rot(s, x, y, rx, ry){
      if(ry === 0){
        if(rx === 1){
          x = s - 1 - x;
          y = s - 1 - y;
        }
        // swap x/y
        const t = x;
        x = y;
        y = t;
      }
      return [x,y];
    }
    function xy2d(n, x, y){
      let d = 0;
      for(let s = n/2; s > 0; s = Math.floor(s/2)){
        const rx = (x & s) > 0 ? 1 : 0;
        const ry = (y & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        const r = rot(s, x, y, rx, ry);
        x = r[0];
        y = r[1];
      }
      return d;
    }

    // Morton (Z-order) helpers
    function splitBy1(x){
      x = x & 0xFFFF;
      x = (x | (x << 8)) & 0x00FF00FF;
      x = (x | (x << 4)) & 0x0F0F0F0F;
      x = (x | (x << 2)) & 0x33333333;
      x = (x | (x << 1)) & 0x55555555;
      return x >>> 0;
    }
    function morton2D(x, y){
      return (splitBy1(x) | (splitBy1(y) << 1)) >>> 0;
    }

    const decorated = arr.map(n=>{
      const gx = toGridX(n.x);
      const gy = toGridY(n.y);
      const key = (mode === "hilbert") ? xy2d(grid, gx, gy) : morton2D(gx, gy);
      return { n, key };
    });

    decorated.sort((a,b)=>{
      if(a.key !== b.key) return a.key - b.key;
      return (a.n.id|0) - (b.n.id|0);
    });

    hilbertNodes = decorated.map(o=>o.n);
  }


  // ─────────────────────────────────────────────────────────────
  // 5) Morph / Space transformations
  // ─────────────────────────────────────────────────────────────

  function updateMorphedPositions() {
    nodes.forEach(n=>{
      if(currentMorphValue>0){
        // if no target, pick random offset
        if(n.morphTargetX===null) {
          // random offset around base
          let off=300;
          n.morphTargetX = n.baseX + (getRandom()-0.5)*off;
          n.morphTargetY = n.baseY + (getRandom()-0.5)*off;
        }
        // lerp
        let t = currentMorphValue/100;
        n.morphedX = n.baseX + (n.morphTargetX-n.baseX)*t;
        n.morphedY = n.baseY + (n.morphTargetY-n.baseY)*t;
      } else {
        n.morphTargetX=null;
        n.morphTargetY=null;
        n.morphedX=n.baseX;
        n.morphedY=n.baseY;
      }
    });
  }

  function updateNodePositions() {
    updateMorphedPositions();

    // Space transforms: scale about center
    let cx = canvas.width/2;
    let cy = canvas.height/2;
    let scale = 1 + currentSpaceValue/100;
    nodes.forEach(n=>{
      let dx = n.morphedX - cx;
      let dy = n.morphedY - cy;
      n.x = cx + dx*scale;
      n.y = cy + dy*scale;
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 6) Randomize / Reset
  // ─────────────────────────────────────────────────────────────

  function assignRandomConnections() {
    const ncount = nodes.length | 0;
    if (ncount <= 0) return;

    // Clamp user controls
    const minOut = Math.max(0, Math.min((networkMinOutputs | 0), ncount));
    const maxOut = Math.max(minOut, Math.min((networkMaxOutputs | 0), ncount));

    nodes.forEach(n=>{
      n.outputs = [];

      const maxPossible = networkAllowSelfLoops ? ncount : Math.max(0, ncount - 1);
      const rawCount = minOut + Math.floor(getRandom() * (maxOut - minOut + 1));
      const outCount = Math.min(rawCount, maxPossible);

      // Fill with unique picks (guard against infinite loops)
      const triesLimit = Math.max(16, ncount * 6);
      let tries = 0;
      while (n.outputs.length < outCount && tries < triesLimit) {
        tries++;
        const pick = Math.floor(getRandom() * ncount);
        if (!networkAllowSelfLoops && pick === n.id) continue;
        if (n.outputs.includes(pick)) continue;
        n.outputs.push(pick);
      }
    });
  }

  function randomizeNodes() {
    nodes.forEach(n=>{
      n.baseX = getRandom()*canvas.width;
      n.baseY = getRandom()*canvas.height;
      n.morphTargetX=null;
      n.morphTargetY=null;
    });
    updateNodePositions();
    assignRandomConnections();
  }

  function resetNodes() {
    // Place them in circle or something
    let cx=canvas.width/2;
    let cy=canvas.height/2;
    let radius=200;
    nodes.forEach((n,i)=>{
      let angle = i*(2*Math.PI/nodes.length);
      n.baseX = cx + radius*Math.cos(angle);
      n.baseY = cy + radius*Math.sin(angle);
      n.morphTargetX=null;
      n.morphTargetY=null;
    });
    updateNodePositions();
    assignRandomConnections();
  }

  function randomizePulses() {
    // IMPORTANT: Randomize should only affect mutes.
    // Notes/channels are hard-set per pulse via applyPulseMidiAssignments().
    pulses.forEach(p=>{
      if(!p) return;
      p.muted = (getRandom() < 0.2);
    });
    updatePulseAssignments();
  }

  function resetPulses() {
    pulses.forEach(p=>{
      p.enabled=true;
      p.currentNode=nodes[0];
      p.targetNode=nodes[0];
      p.x=p.currentNode.x;
      p.y=p.currentNode.y;
      p.startTime=performance.now();
      p.timingRatio=1;
      p.travelTime=interval;
      p.speed=globalSpeed;
      p.progress=0;
      p.trail=[];
      p.pendingTrigger=false;
      p.prevNode=null;
      p.lsysDir=1;
      p.bounceCycleIndex=0;
    });
    updatePulseAssignments();
  }

  // Reset helper requested: "Reset" should unmute everything.
  // (We keep this separate from resetPulses() because resetPulses() is used
  // internally by Start/Stop and randomize-all to reset motion without wiping
  // creative mute states.)
  function unmuteAllPulses() {
    pulses.forEach(p=>{
      if(!p) return;
      p.muted = false;
      p.soloed = false;
    });
    recomputeSoloActive();
  }

  // ─────────────────────────────────────────────────────────────
  // 7) MIDI
  // ─────────────────────────────────────────────────────────────
  // Acquire MIDI
//  if(!window.selectedMidiOut){
//    console.warn("[Nodetrix] No global MIDI output selected. Using internal logic only.");
//  }

  function sendMidiNote(pulse) {
    if(!window.selectedMidiOut) return;
    // If the host base channel is OFF (13) we set pulse.channel=null.
    // Guard so we don't accidentally send on channel 1 and confuse users.
    if (!Number.isFinite(pulse.channel)) {
      if (!window.__warnedBaseOffNodetrix) {
        console.warn("[Nodetrix] MIDI Base Channel is OFF. Set it to 1–13 to use Nodetrix.");
        window.__warnedBaseOffNodetrix = true;
      }
      return;
    }
    if (!Number.isFinite(pulse.note)) return;
    // dynamic velocity?
    let vel = 80;
    if(dynamicVelocityModeEnabled) {
      // measure distance from currentNode to targetNode
      let dx = pulse.targetNode.x - pulse.currentNode.x;
      let dy = pulse.targetNode.y - pulse.currentNode.y;
      let dist = Math.sqrt(dx*dx+dy*dy);
      // map dist->velocity
      vel = Math.min(127, Math.floor(dist/5));
      if(vel<10) vel=10;
    }

    // send note on/off
    const ch = (pulse.channel | 0) & 0x0F;
    let noteOn = [0x90 | ch, pulse.note & 0x7F, vel & 0x7F];
    let noteOff= [0x80 | ch, pulse.note & 0x7F, 0];
    window.selectedMidiOut.send(noteOn);
    setTimeout(()=>{
      window.selectedMidiOut.send(noteOff);
    }, 100);

    // If dynamic CC:
    if(dynamicCCModeEnabled && window.MD_CC_MAP) {
      sendDynamicCC(pulse, vel);
    }
  }

  function sendDynamicCC(pulse, velocity) {
    if(!window.selectedMidiOut || !window.MD_CC_MAP) return;
    if (!Number.isFinite(velocity)) velocity = 80;

    // Pulse ids are 0..15 => MD track numbers are 1..16
    const trackNum = ((pulse.id | 0) + 1);
    const mapObj = window.MD_CC_MAP[trackNum];
    if(!mapObj) return;

    // CCs are sent on per-track-group channels (base + group)
    const baseChan = getGlobalMidiBaseChannel();
    if (baseChan == null) return;
    const group = Math.floor((trackNum - 1) / 4);
    const ccChannel = (baseChan + group) & 0x0F;

    const settings = dynamicCCSettings[trackNum];
    if (!settings) return;

    const sendOne = (ccNum, v) => {
      if (ccNum == null) return;
      let val = Math.min(127, Math.max(0, Math.floor(v)));
      window.selectedMidiOut.send([0xB0 | ccChannel, ccNum & 0x7F, val & 0x7F]);
    };

    // 1) Track level
    if (settings.level && (settings.level.enabled !== false) && mapObj.level != null) {
      const v = settings.level.base + velocity * settings.level.mod;
      sendOne(mapObj.level, v);
    }

    // 2) Machine/FX/Routing params (MD_CC_MAP[].param: 24 CC numbers)
    if (Array.isArray(settings.params) && Array.isArray(mapObj.param)) {
      const n = Math.min(settings.params.length, mapObj.param.length);
      for (let i = 0; i < n; i++) {
        const s = settings.params[i];
        if (!s || s.enabled === false) continue;
        const ccNum = mapObj.param[i];
        if (ccNum == null) continue;
        const v = s.base + velocity * s.mod;
        sendOne(ccNum, v);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 8) Main Animation Loop
  // ─────────────────────────────────────────────────────────────

  function animate(){
    if(playState !== "running") return;
    const now = performance.now();
    const delta = (now - lastFrameTime)/1000;
    lastFrameTime = now;

    applyLFOs(delta);

    // If dragging, keep the node pinned under the pointer even as morph/space/LFO change.
    if (__drag && __drag.node) {
      __midiSuppressed = false; // running transport, MIDI allowed (unless user toggled it off)
      applyDragConstraint();
    }

    updateNodePositions();

    // clear
    ctx.clearRect(0,0,canvas.width, canvas.height);

    // update pulses
    pulses.forEach(p=> p.update(delta));

    // draw nodes/pulses
    if(showTrails){
      pulses.forEach(p=> p.draw());
    } else {
      // just draw pulses
      pulses.forEach(p=>{
        if(!p.enabled) return;
        ctx.beginPath();
        ctx.arc(p.x,p.y,6,0,2*Math.PI);
        ctx.fillStyle="cyan";
        ctx.fill();
      });
    }

    nodes.forEach(n=>n.draw());

    // optionally add new pulse at each BPM interval
    if(bpmMode && scheduledPulse && (now - lastPulseTime >= interval)) {
      addPulseImmediate();
      scheduledPulse = false;
      lastPulseTime = now;
    }

    animationFrameId = requestAnimationFrame(animate);
  }

  // ─────────────────────────────────────────────────────────────
  // 9) Add/Remove nodes/pulses
  // ─────────────────────────────────────────────────────────────
  function addNode(){
    let id = nodes.length;
    let n = new Node(id, getRandom()*canvas.width, getRandom()*canvas.height);
    nodes.push(n);
    // update all outputs references? Usually just random
    assignRandomConnections();
  }
  function removeNode(){
    if(nodes.length<=1) return;
    nodes.pop();
    // fix node IDs
    nodes.forEach((n,i)=> n.id=i);
    // fix connections
    assignRandomConnections();

    // ensure pulses currentNode/targetNode are valid
    pulses.forEach(p=>{
      if(p.currentNode.id >= nodes.length) p.currentNode = nodes[0];
      if(p.targetNode.id >= nodes.length) p.targetNode = nodes[0];
    });
  }

  function addPulse(){
    // Machinedrum: cap at 16 tracks/pulses
    if(pulses.length >= MAX_PULSES) return;

    let id = pulses.length;
    let p = new Pulse(id);
    pulses.push(p);
    recomputeSoloActive();
    updatePulseAssignments();
  }
  function removePulse(){
    if(pulses.length<=1) return;
    pulses.pop();
    pulses.forEach((p,i)=> {
      p.id=i;
      p.color = getPulseColor(i);
    });
    recomputeSoloActive();
    updatePulseAssignments();
  }

  function addPulseImmediate(){
    addPulse();
    // optionally randomize it or something
  }

  // For manual trigger:
  function triggerPulse(pulse){
    pulse.pendingTrigger = false;
    // Start from node0
    pulse.prevNode = null;
    pulse.currentNode = nodes[0];
    pulse.lsysDir = 1;
    pulse.bounceCycleIndex = 0;
    pulse.targetNode = transitionSelector(pulse.currentNode, pulse);
    applyPulseSegmentTiming(pulse, pulse.currentNode, pulse.targetNode);
    pulse.startTime = performance.now();
    pulse.progress = 0;
    pulse.trail = [];
  }

  function updatePulseAssignments(){
    // Update label in UI
    // We'll do in the UI binding section
  }

  // ─────────────────────────────────────────────────────────────
  // 10) UI + Injection
  // ─────────────────────────────────────────────────────────────

  const css = `
    #secretSequencerOverlay {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background: rgba(0,0,0,0.8);
      /* Keep Nodetrix *below* app modals (settings, MIDI, etc.).
         App modals use z-index: 1000 in styles.css. */
      z-index: 900;
      display: none;
      font-family: sans-serif;
      color: #fff;
    }
    #secretSequencerOverlay .flex-wrap {
      display: flex;
      width: 100%;
      height: 100%;
    }
    #secretCanvasWrap {
      flex: 1;
      position: relative;
    }
    #secretControlPanel {
      width: 320px;
      background: rgba(20,20,20,0.95);
      padding: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      border-left: 1px solid rgba(255,255,255,0.1);
    }

    #secretControlTop {
      flex: 1;
      overflow-y: auto;
      padding-right: 6px;
    }
    #secretControlPanel h2 {
      margin: 0 0 8px 0;
      font-size: 15px;
      letter-spacing: 0.2px;
    }

    /* Base controls */
    #secretControlPanel button {
      margin: 0;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
    }
    #secretControlPanel input[type="range"] { width: 100%; }
    #secretControlPanel input[type="number"] { width: 64px; }
    #secretControlPanel select { width: 100%; margin-bottom: 6px; }
    #secretControlPanel label {
      font-size: 12px;
      display: block;
      margin-top: 6px;
      margin-bottom: 2px;
    }
    #secretExitBtn {
      background: #c33;
      color: #fff;
      border: none;
      margin-top: 6px;
      padding: 8px;
      cursor: pointer;
      border-radius: 6px;
    }

    .control-group {
      margin-bottom: 8px;
      padding: 8px;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 8px;
    }

    .section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin: 0 0 6px 0;
      font-size: 12px;
      opacity: 0.92;
    }
    .hint {
      font-size: 11px;
      opacity: 0.65;
    }

    /* Compact grids */
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .btn-grid button { width: 100%; }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      align-items: start;
    }

    /* Timing row: mode toggle + slider + value */
    .timing-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .timing-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      white-space: nowrap;
      font-weight: 600;
      font-size: 12px;
      user-select: none;
    }
    .timing-toggle input { margin: 0; }
    .timing-slider {
      flex: 1;
      min-width: 0;
    }
    .timing-row input[type="range"] { margin: 0; }
    .timing-value {
      min-width: 52px;
      text-align: right;
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }

    /* Mode extra controls */
    .sub-controls {
      border: 1px solid rgba(255,255,255,0.12);
      padding: 8px;
      margin-top: 8px;
      border-radius: 8px;
    }
    .mode-controls label { margin-top: 0; }
    .field-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .field-row label { margin: 0; font-size: 12px; opacity: 0.9; }
    .field-row input[type="number"] { width: 72px; }

    /* Track list */
    #pulseAssignments { margin-top: 8px; }
    .pulse-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 2px 0;
    }
    .pulse-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .pulse-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex: 0 0 auto;
    }
    .pulse-text {
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pulse-btns {
      display: flex;
      gap: 4px;
      flex: 0 0 auto;
    }
    .pulse-btns button {
      padding: 4px 0;
      width: 26px;
      font-size: 10px;
      line-height: 1;
      border-radius: 6px;
    }

    /* Checkbox grid */
    .check-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 10px;
      align-items: center;
    }
    .check-grid label {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: 12px;
    }

    /* LFO section */
    .lfo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      align-items: start;
    }
    #secretSequencerOverlay .lfo-grid input[type="range"] { margin: 2px 0 0 0; }

    /* Dark theme polish */
    #secretSequencerOverlay #secretControlPanel button,
    #secretSequencerOverlay #secretControlPanel select,
    #secretSequencerOverlay #secretControlPanel input[type="number"],
    #secretSequencerOverlay #secretControlPanel input[type="text"] {
      background: #111;
      color: #ddd;
      border: 1px solid #444;
      border-radius: 6px;
      outline: none;
    }
    #secretSequencerOverlay #secretControlPanel button {
      background: #333;
      border: 1px solid #555;
    }
    #secretSequencerOverlay #secretControlPanel button:hover { background: #3a3a3a; }
    #secretSequencerOverlay #secretControlPanel button:active { background: #2a2a2a; }
    #secretSequencerOverlay #secretControlPanel button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #secretSequencerOverlay #secretControlPanel input[type="checkbox"],
    #secretSequencerOverlay #secretControlPanel input[type="range"] {
      accent-color: #6fcf97;
    }

    /* Scrollbar (WebKit) */
    #secretSequencerOverlay #secretControlTop::-webkit-scrollbar { width: 8px; }
    #secretSequencerOverlay #secretControlTop::-webkit-scrollbar-thumb { background: #444; border-radius: 8px; }
    #secretSequencerOverlay #secretControlTop::-webkit-scrollbar-track { background: #222; }

    /* Canvas cursor feedback */
    #secretSequencerOverlay #sequencerCanvas { cursor: grab; }
    #secretSequencerOverlay #sequencerCanvas.dragging { cursor: grabbing; }
`;

  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const html = `
    <div id="secretSequencerOverlay">
      <div class="flex-wrap">
        <div id="secretCanvasWrap">
          <canvas id="sequencerCanvas"></canvas>
        </div>

        <div id="secretControlPanel">
          <div id="secretControlTop">
            <h2>Nodetrix</h2>

            <div class="control-group">
              <div class="btn-grid">
                <button id="secretStartBtn">Start</button>
                <button id="secretStopBtn">Stop</button>
              </div>
            </div>

            <!-- Timing: BPM/Speed toggle + slider on one row -->
            <div class="control-group">
              <div class="timing-row">
                <label class="timing-toggle" title="Toggle BPM / Speed">
                  <input type="checkbox" id="bpmModeCheckbox" checked />
                  <span id="timingModeText">BPM</span>
                </label>

                <div class="timing-slider">
                  <input type="range" id="bpmInput" min="20" max="300" step="1" value="120" />
                  <input type="range" id="speedInput" min="10" max="2000" step="1" value="100" style="display:none;" />
                </div>

                <span id="timingValue" class="timing-value">120</span>
              </div>
            </div>

            <div class="control-group">
              <label>Transition Mode</label>
              <select id="secretTransitionModeSelect">
                <option value="uniform" selected>Uniform (1/N Random)</option>
                <option value="sequential">Sequential</option>
                <option value="weighted">Weighted</option>

                <!-- RHYTHMIC / GEOMETRIC -->
                <option value="bounceRoot">Bounce to Root (Rhythmic)</option>
                <option value="nearest">Nearest Neighbor (Smooth)</option>
                <option value="farthest">Farthest Jump (Energetic)</option>

                <option value="network">Network</option>
                <option value="seededUniform">Seeded Uniform</option>

                <!-- GENERATIVE SYSTEMS -->
                <option value="wolfram">Wolfram CA</option>
                <option value="life">Game of Life</option>
                <option value="chaos">Chaos Game</option>
                <option value="lsys">L-System</option>
                <option value="hilbert">Hilbert Curve</option>
              </select>

              <div id="transitionExtraControls" class="sub-controls" style="display:none;">

                <div id="sequentialControls" class="mode-controls" style="display:none;">
                  <div class="two-col">
                    <div>
                      <label>Step</label>
                      <input type="number" id="sequentialStepInput" min="1" max="64" value="1" />
                    </div>
                    <div>
                      <label>Direction</label>
                      <select id="sequentialDirSelect">
                        <option value="1" selected>Forward</option>
                        <option value="-1">Backward</option>
                      </select>
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="sequentialSkipRootToggle" />
                    Skip Root (0)
                  </label>

                  <button id="randomizeSequentialBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="weightedControls" class="mode-controls" style="display:none;">
                  <div class="field-row">
                    <label>Bias</label>
                    <select id="weightedBiasSelect">
                      <option value="far" selected>Favor Far</option>
                      <option value="near">Favor Near</option>
                    </select>
                  </div>

                  <div class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Exponent</label>
                      <input type="number" id="weightedExponentInput" min="0.01" max="20" step="0.01" value="1" />
                    </div>
                    <div>
                      <label>Min dist (%)</label>
                      <input type="number" id="weightedMinDistInput" min="0" max="100" step="1" value="0" />
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="weightedExcludeSelfToggle" checked />
                    Exclude current node
                  </label>

                  <div class="hint" style="margin-top:6px;">
                    Exponent &gt; 1 = stronger bias. Min dist filters out the closest nodes (relative).
                  </div>

                  <button id="randomizeWeightedBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="bounceControls" class="mode-controls" style="display:none;">
                  <div class="field-row">
                    <label>Return chance</label>
                    <input type="range" id="bounceReturnChanceInput" min="0" max="1" step="0.01" value="1" />
                    <span class="hint" id="bounceReturnChanceLabel">1.00</span>
                  </div>

                  <div class="field-row" style="margin-top:6px;">
                    <label>Away mode</label>
                    <select id="bounceAwayModeSelect">
                      <option value="random" selected>Random</option>
                      <option value="cycle">Cycle</option>
                      <option value="nearest">Nearest</option>
                      <option value="farthest">Farthest</option>
                      <option value="weighted">Weighted (uses Weighted settings)</option>
                    </select>
                  </div>

                  <div id="bounceCycleRow" class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Cycle step</label>
                      <input type="number" id="bounceCycleStepInput" min="1" max="64" value="1" />
                    </div>
                    <div>
                      <label>Cycle dir</label>
                      <select id="bounceCycleDirSelect">
                        <option value="1" selected>Forward</option>
                        <option value="-1">Backward</option>
                      </select>
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="bounceAvoidSelfToggle" checked />
                    Avoid self when away
                  </label>

                  <button id="randomizeBounceBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="nearestControls" class="mode-controls" style="display:none;">
                  <div class="two-col">
                    <div>
                      <label>K nearest</label>
                      <input type="number" id="nearestKInput" min="1" max="64" value="1" />
                    </div>
                    <div>
                      <label>Random %</label>
                      <input type="number" id="nearestRandomInput" min="0" max="100" step="1" value="0" />
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="nearestAvoidBacktrackToggle" />
                    Avoid backtracking (prev node)
                  </label>

                  <button id="randomizeNearestBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="farthestControls" class="mode-controls" style="display:none;">
                  <div class="two-col">
                    <div>
                      <label>K farthest</label>
                      <input type="number" id="farthestKInput" min="1" max="64" value="1" />
                    </div>
                    <div>
                      <label>Random %</label>
                      <input type="number" id="farthestRandomInput" min="0" max="100" step="1" value="0" />
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="farthestAvoidBacktrackToggle" />
                    Avoid backtracking (prev node)
                  </label>

                  <button id="randomizeFarthestBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="networkControls" class="mode-controls" style="display:none;">
                  <label style="display:flex; align-items:center; gap:6px; margin-top:0;">
                    <input type="checkbox" id="showNetworkConnectionsToggle" checked />
                    Show connections
                  </label>

                  <div class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Min outputs</label>
                      <input type="number" id="networkMinOutputsInput" min="0" max="16" value="0" />
                    </div>
                    <div>
                      <label>Max outputs</label>
                      <input type="number" id="networkMaxOutputsInput" min="0" max="16" value="3" />
                    </div>
                  </div>

                  <div class="field-row" style="margin-top:6px;">
                    <label>Prefer outputs</label>
                    <input type="range" id="networkPreferOutputsInput" min="0" max="1" step="0.01" value="1" />
                    <span class="hint" id="networkPreferOutputsLabel">1.00</span>
                  </div>

                  <div class="field-row" style="margin-top:6px;">
                    <label>Output bias</label>
                    <select id="networkOutputBiasSelect">
                      <option value="uniform" selected>Uniform</option>
                      <option value="near">Prefer near</option>
                      <option value="far">Prefer far</option>
                    </select>
                  </div>

                  <div class="field-row" style="margin-top:6px;">
                    <label>Fallback</label>
                    <select id="networkFallbackSelect">
                      <option value="uniform" selected>Random (uniform)</option>
                      <option value="root">Root</option>
                      <option value="sequential">Sequential</option>
                      <option value="nearest">Nearest</option>
                      <option value="farthest">Farthest</option>
                    </select>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="networkAllowSelfLoopsToggle" />
                    Allow self-loops
                  </label>

                  <button id="randomizeNetworkBtn" style="margin-top:6px; width:100%;">Rand Mode</button>

                  <button id="rewireNetworkBtn" style="margin-top:6px; width:100%;">Rewire Network</button>

                  <div class="hint" style="margin-top:6px;">
                    Tip: Rewire uses the min/max outputs above. Randomize/Reset Nodes also rewires.
                  </div>
                </div>

                <div id="seededUniformControls" class="mode-controls" style="display:none;">
                  <div class="field-row">
                    <label>Seed</label>
                    <input type="number" id="seededUniformSeedInput" min="1" max="2147483646" value="1" />
                    <button id="randomSeededUniformBtn">Rand</button>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="seededUniformPerPulseToggle" />
                    Per-pulse seeds (diverge tracks)
                  </label>

                  <button id="randomizeSeededUniformModeBtn" style="margin-top:6px; width:100%;">Rand Mode</button>

                  <button id="restartSeededUniformBtn" style="margin-top:6px; width:100%;">Restart Seed Sequence</button>

                  <div class="hint" style="margin-top:6px;">
                    Tip: Changing Seed or Restart resets the deterministic sequence.
                  </div>
                </div>

                <div id="wolframControls" class="mode-controls" style="display:none;">
                  <div class="field-row">
                    <label>Rule</label>
                    <input type="number" id="wolframRuleInput" min="0" max="255" value="30" />
                    <button id="randomizeWolframBtn">Rand</button>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="wolframPerPulseToggle" checked />
                    Per-pulse CA (diverge tracks)
                  </label>

                  <div class="field-row" style="margin-top:6px;">
                    <label title="0..255. 0 = all pulses use the same rule.">Rule spread</label>
                    <input type="number" id="wolframRuleSpreadInput" min="0" max="255" value="0" />
                    <span class="hint">0 = same rule</span>
                  </div>

                  <button id="randomizeWolframModeBtn" style="margin-top:6px; width:100%;">Rand Mode</button>

                  <div class="hint" style="margin-top:6px;">
                    Tip: Per-pulse mode gives each pulse its own Wolfram line so they don't all mirror.
                  </div>
                </div>

                <div id="lifeControls" class="mode-controls" style="display:none;">
                  <label style="margin-top:0;">Life Rule</label>
                  <input type="text" id="lifeRuleInput" value="B3/S23" />
                  <div class="two-col">
                    <div>
                      <label>Rows</label>
                      <input type="number" id="lifeRowsInput" min="2" max="64" value="10" />
                    </div>
                    <div>
                      <label>Cols</label>
                      <input type="number" id="lifeColsInput" min="2" max="64" value="10" />
                    </div>
                  </div>
                  <button id="randomizeLifeBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="chaosControls" class="mode-controls" style="display:none;">
                  <div class="two-col">
                    <div>
                      <label>Corners</label>
                      <input type="number" id="chaosCornerCountInput" min="3" max="8" value="4" />
                    </div>
                    <div>
                      <label>Points</label>
                      <input type="number" id="chaosPointCountInput" min="50" max="10000" value="200" />
                    </div>
                  </div>

                  <div class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Step fraction</label>
                      <input type="number" id="chaosStepFractionInput" min="0.05" max="0.95" step="0.01" value="0.5" />
                    </div>
                    <div>
                      <label>Burn-in</label>
                      <input type="number" id="chaosBurnInInput" min="0" max="2000" value="0" />
                    </div>
                  </div>

                  <div class="field-row" style="margin-top:6px;">
                    <label>Corner select</label>
                    <select id="chaosCornerModeSelect">
                      <option value="first" selected>First N (legacy)</option>
                      <option value="spread">Spread (auto)</option>
                    </select>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="chaosNoRepeatToggle" />
                    Avoid repeat corners
                  </label>

                  <button id="rebuildChaosBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="lsysControls" class="mode-controls" style="display:none;">
                  <label style="margin-top:0;">Axiom</label>
                  <input type="text" id="lsysAxiomInput" value="F" />

                  <label style="margin-top:6px;">Rule (F → ...)</label>
                  <input type="text" id="lsysRuleFInput" value="F+F-F-F+F" />

                  <div class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Iterations</label>
                      <input type="number" id="lsysIterationsInput" min="0" max="10" value="2" />
                    </div>
                    <div>
                      <label>Step</label>
                      <input type="number" id="lsysStepInput" min="1" max="64" value="1" />
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="lsysTurnModeToggle" />
                    Turn mode (+/- set direction)
                  </label>

                  <button id="rebuildLsysBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

                <div id="hilbertControls" class="mode-controls" style="display:none;">
                  <div class="field-row">
                    <label>Mode</label>
                    <select id="hilbertModeSelect">
                      <option value="diagonal" selected>Diagonal (x+y)</option>
                      <option value="hilbert">Hilbert (grid)</option>
                      <option value="zorder">Z-order (Morton)</option>
                    </select>
                  </div>

                  <div class="two-col" style="margin-top:6px;">
                    <div>
                      <label>Order</label>
                      <input type="number" id="hilbertOrderInput" min="1" max="10" value="6" />
                    </div>
                    <div>
                      <label>Step</label>
                      <input type="number" id="hilbertStepInput" min="1" max="64" value="1" />
                    </div>
                  </div>

                  <label style="display:flex; align-items:center; gap:6px; margin-top:6px;">
                    <input type="checkbox" id="hilbertPingPongToggle" />
                    Ping-pong
                  </label>

                  <button id="rebuildHilbertBtn" style="margin-top:6px; width:100%;">Rand Mode</button>
                </div>

              </div>
            </div>

            <div class="control-group">
              <div class="section-title">
                <span>Nodes</span>
                <span class="hint">drag on canvas</span>
              </div>
              <div class="btn-grid">
                <button id="addNodeBtn">+ Add</button>
                <button id="removeNodeBtn">− Remove</button>
                <button id="randNodesBtn">Randomize</button>
                <button id="resetNodesBtn">Reset</button>
              </div>
            </div>

            <div class="control-group">
              <div class="section-title">
                <span>Tracks / Pulses</span>
                <span class="hint">max 16</span>
              </div>
              <div class="btn-grid">
                <button id="addPulseBtn">+ Add</button>
                <button id="removePulseBtn">− Remove</button>
                <button id="randPulsesBtn">Randomize</button>
                <button id="resetPulsesBtn">Reset</button>
              </div>
              <div id="pulseAssignments"></div>
            </div>

            <div class="control-group">
              <div class="two-col">
                <div>
                  <label style="margin-top:0;">Morph</label>
                  <input type="range" id="morphSlider" min="0" max="100" value="0" />
                </div>
                <div>
                  <label style="margin-top:0;">Space</label>
                  <input type="range" id="spaceSlider" min="0" max="100" value="0" />
                </div>
              </div>
            </div>

            <div class="control-group">
              <label style="margin-top:0;">LFO</label>
              <div class="lfo-grid">
                <div>
                  <label style="margin-top:0;"><input type="checkbox" id="morphLFOEnable" /> Morph</label>
                  <label>Speed</label>
                  <input type="range" id="morphLFOSpeed" min="0" max="2" step="0.01" value="0.1" />
                  <label>Depth</label>
                  <input type="range" id="morphLFODepth" min="0" max="100" value="20" />
                </div>
                <div>
                  <label style="margin-top:0;"><input type="checkbox" id="spaceLFOEnable" /> Space</label>
                  <label>Speed</label>
                  <input type="range" id="spaceLFOSpeed" min="0" max="2" step="0.01" value="0.1" />
                  <label>Depth</label>
                  <input type="range" id="spaceLFODepth" min="0" max="100" value="20" />
                </div>
              </div>
            </div>

            <div class="control-group">
              <div class="check-grid">
                <label><input type="checkbox" id="dynamicVelocityToggle" checked /> Dyn Vel</label>
                <label><input type="checkbox" id="toggleTrails" /> Trails</label>
                <label><input type="checkbox" id="togglePulseLinks" /> Pulse Links</label>
                <label><input type="checkbox" id="autoFitToggle" checked /> Auto-fit</label>
              </div>
            </div>

            <div class="control-group">
              <div class="btn-grid">
                <button id="randAllBtn">Randomize All</button>
                <button id="resetAllBtn">Reset All</button>
              </div>
            </div>
          </div>

          <button id="secretExitBtn">Exit</button>
        </div>
      </div>
    </div>
  `;

  // Insert HTML into document
  const mountEl = document.getElementById("nodetrixMount") || document.body;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  mountEl.appendChild(wrapper);

  // Grab references
  const overlay = document.getElementById('secretSequencerOverlay');

  // Overlay visibility detection:
  // Use computed style so rendering works even if the host shows/hides the overlay via CSS (not inline styles).
  const __overlayVisCache = { t: 0, v: false };
  function isOverlayVisible() {
    if (!overlay) return false;
    const now = performance.now();
    // Cache for a short window to avoid repeated getComputedStyle calls
    if (now - __overlayVisCache.t < 100) return __overlayVisCache.v;
    __overlayVisCache.t = now;

    const cs = window.getComputedStyle(overlay);
    const display = cs ? cs.display : "none";
    const visibility = cs ? cs.visibility : "hidden";
    const opacity = cs ? parseFloat(cs.opacity || "1") : 0;

    const r = overlay.getBoundingClientRect();
    const hasSize = (r && r.width > 0 && r.height > 0);

    __overlayVisCache.v = (display !== "none" && visibility !== "hidden" && opacity > 0 && hasSize);
    return __overlayVisCache.v;
  }

  const canvas = document.getElementById('sequencerCanvas');
  const ctx = canvas.getContext('2d');

  const controlPanel = document.getElementById('secretControlPanel');
  const startBtn = document.getElementById('secretStartBtn');
  const stopBtn = document.getElementById('secretStopBtn');
  const exitBtn = document.getElementById('secretExitBtn');

  const bpmModeCheckbox = document.getElementById('bpmModeCheckbox');
  const bpmInput = document.getElementById('bpmInput');
  const speedInput = document.getElementById('speedInput');
  const timingModeTextEl = document.getElementById('timingModeText');
  const timingValueEl = document.getElementById('timingValue');

  const transitionModeSelect = document.getElementById('secretTransitionModeSelect');

  // Extra controls:
  const sequentialStepInput = document.getElementById('sequentialStepInput');
  const sequentialDirSelect = document.getElementById('sequentialDirSelect');
  const sequentialSkipRootToggle = document.getElementById('sequentialSkipRootToggle');
  const randomizeSequentialBtn = document.getElementById('randomizeSequentialBtn');

  const weightedBiasSelect = document.getElementById('weightedBiasSelect');
  const weightedExponentInput = document.getElementById('weightedExponentInput');
  const weightedMinDistInput = document.getElementById('weightedMinDistInput');
  const weightedExcludeSelfToggle = document.getElementById('weightedExcludeSelfToggle');
  const randomizeWeightedBtn = document.getElementById('randomizeWeightedBtn');

  const bounceReturnChanceInput = document.getElementById('bounceReturnChanceInput');
  const bounceReturnChanceLabel = document.getElementById('bounceReturnChanceLabel');
  const bounceAwayModeSelect = document.getElementById('bounceAwayModeSelect');
  const bounceCycleRow = document.getElementById('bounceCycleRow');
  const bounceCycleStepInput = document.getElementById('bounceCycleStepInput');
  const bounceCycleDirSelect = document.getElementById('bounceCycleDirSelect');
  const bounceAvoidSelfToggle = document.getElementById('bounceAvoidSelfToggle');
  const randomizeBounceBtn = document.getElementById('randomizeBounceBtn');

  const nearestKInput = document.getElementById('nearestKInput');
  const nearestRandomInput = document.getElementById('nearestRandomInput');
  const nearestAvoidBacktrackToggle = document.getElementById('nearestAvoidBacktrackToggle');
  const randomizeNearestBtn = document.getElementById('randomizeNearestBtn');

  const farthestKInput = document.getElementById('farthestKInput');
  const farthestRandomInput = document.getElementById('farthestRandomInput');
  const farthestAvoidBacktrackToggle = document.getElementById('farthestAvoidBacktrackToggle');
  const randomizeFarthestBtn = document.getElementById('randomizeFarthestBtn');

  const networkMinOutputsInput = document.getElementById('networkMinOutputsInput');
  const networkMaxOutputsInput = document.getElementById('networkMaxOutputsInput');
  const networkPreferOutputsInput = document.getElementById('networkPreferOutputsInput');
  const networkPreferOutputsLabel = document.getElementById('networkPreferOutputsLabel');
  const networkOutputBiasSelect = document.getElementById('networkOutputBiasSelect');
  const networkFallbackSelect = document.getElementById('networkFallbackSelect');
  const networkAllowSelfLoopsToggle = document.getElementById('networkAllowSelfLoopsToggle');
  const randomizeNetworkBtn = document.getElementById('randomizeNetworkBtn');
  const rewireNetworkBtn = document.getElementById('rewireNetworkBtn');

  const seededUniformSeedInput = document.getElementById('seededUniformSeedInput');
  const randomSeededUniformBtn = document.getElementById('randomSeededUniformBtn');
  const seededUniformPerPulseToggle = document.getElementById('seededUniformPerPulseToggle');
  const randomizeSeededUniformModeBtn = document.getElementById('randomizeSeededUniformModeBtn');
  const restartSeededUniformBtn = document.getElementById('restartSeededUniformBtn');

  const chaosCornerCountInput = document.getElementById('chaosCornerCountInput');
  const chaosPointCountInput = document.getElementById('chaosPointCountInput');
  const chaosStepFractionInput = document.getElementById('chaosStepFractionInput');
  const chaosBurnInInput = document.getElementById('chaosBurnInInput');
  const chaosCornerModeSelect = document.getElementById('chaosCornerModeSelect');
  const chaosNoRepeatToggle = document.getElementById('chaosNoRepeatToggle');

  const lsysAxiomInput = document.getElementById('lsysAxiomInput');
  const lsysRuleFInput = document.getElementById('lsysRuleFInput');
  const lsysIterationsInput = document.getElementById('lsysIterationsInput');
  const lsysStepInput = document.getElementById('lsysStepInput');
  const lsysTurnModeToggle = document.getElementById('lsysTurnModeToggle');

  const hilbertModeSelect = document.getElementById('hilbertModeSelect');
  const hilbertOrderInput = document.getElementById('hilbertOrderInput');
  const hilbertStepInput = document.getElementById('hilbertStepInput');
  const hilbertPingPongToggle = document.getElementById('hilbertPingPongToggle');

  const wolframControls = document.getElementById('wolframControls');
  const wolframRuleInput= document.getElementById('wolframRuleInput');
  const randomizeWolframBtn= document.getElementById('randomizeWolframBtn');
  const wolframPerPulseToggle = document.getElementById('wolframPerPulseToggle');
  const wolframRuleSpreadInput = document.getElementById('wolframRuleSpreadInput');
  const randomizeWolframModeBtn = document.getElementById('randomizeWolframModeBtn');

  const lifeControls = document.getElementById('lifeControls');
  const lifeRuleInput= document.getElementById('lifeRuleInput');
  const lifeRowsInput= document.getElementById('lifeRowsInput');
  const lifeColsInput= document.getElementById('lifeColsInput');
  const randomizeLifeBtn= document.getElementById('randomizeLifeBtn');

  const chaosControls = document.getElementById('chaosControls');
  const rebuildChaosBtn= document.getElementById('rebuildChaosBtn');

  const lsysControls = document.getElementById('lsysControls');
  const rebuildLsysBtn= document.getElementById('rebuildLsysBtn');

  const hilbertControls = document.getElementById('hilbertControls');
  const rebuildHilbertBtn= document.getElementById('rebuildHilbertBtn');

  const addNodeBtn = document.getElementById('addNodeBtn');
  const removeNodeBtn = document.getElementById('removeNodeBtn');
  const randNodesBtn = document.getElementById('randNodesBtn');
  const resetNodesBtn= document.getElementById('resetNodesBtn');

  const addPulseBtn = document.getElementById('addPulseBtn');
  const removePulseBtn= document.getElementById('removePulseBtn');
  const randPulsesBtn= document.getElementById('randPulsesBtn');
  const resetPulsesBtn= document.getElementById('resetPulsesBtn');
  const pulseAssignmentsDiv = document.getElementById('pulseAssignments');

  const morphSlider = document.getElementById('morphSlider');
  const spaceSlider = document.getElementById('spaceSlider');

  const morphLFOEnable = document.getElementById('morphLFOEnable');
  const morphLFOSpeedEl= document.getElementById('morphLFOSpeed');
  const morphLFODepthEl= document.getElementById('morphLFODepth');

  const spaceLFOEnable = document.getElementById('spaceLFOEnable');
  const spaceLFOSpeedEl= document.getElementById('spaceLFOSpeed');
  const spaceLFODepthEl= document.getElementById('spaceLFODepth');

  const dynamicVelocityToggle = document.getElementById('dynamicVelocityToggle');
  const toggleTrailsCheckbox = document.getElementById('toggleTrails');
  const togglePulseLinksCheckbox = document.getElementById('togglePulseLinks');
  const autoFitToggle = document.getElementById('autoFitToggle');
  const showNetworkConnectionsToggle = document.getElementById('showNetworkConnectionsToggle');
  const randAllBtn = document.getElementById('randAllBtn');
  const resetAllBtn= document.getElementById('resetAllBtn');

  // If embedding, hide exit
  const embedded = !!document.getElementById("nodetrixMount");
  if(embedded) {
    exitBtn.style.display = "none";
    overlay.style.position = "absolute";
    overlay.style.width = "100%";
    overlay.style.height= "100%";
  }

  // Update canvas sizing
  function updateCanvasSize(){
    const wrap = document.getElementById('secretCanvasWrap');
    if(!wrap) return;

    const rect = wrap.getBoundingClientRect();

    // When Nodetrix is hidden (e.g. panel display:none), rect is 0×0.
    // DO NOT resize the canvas to 0 here, because initNodes() uses canvas.width/height
    // and that collapses all nodes into a single point until the user hits Randomize.
    if(!rect || rect.width < 2 || rect.height < 2) return;

    canvas.width = rect.width;
    canvas.height = rect.height;
    updateNodePositions();
  }
  window.addEventListener("resize", ()=> {
    updateCanvasSize();
    if(playState !== "running"){
      drawOneFrame();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 11) Initialize nodes/pulses
  // ─────────────────────────────────────────────────────────────
  // create a default set of nodes
  function initNodes(n=8){
    nodes=[];
    for(let i=0;i<n;i++){
      let x = getRandom()*canvas.width;
      let y = getRandom()*canvas.height;
      nodes.push(new Node(i,x,y));
    }
    assignRandomConnections();
  }

  function initPulses(n=MAX_PULSES){
    const count = Math.max(1, Math.min(MAX_PULSES, (n|0) || MAX_PULSES));
    pulses=[];
    for(let i=0;i<count;i++){
      pulses.push(new Pulse(i));
    }
    recomputeSoloActive();
  }


  // ─────────────────────────────────────────────────────────────
  // 12) UI Binding & Setup
  // ─────────────────────────────────────────────────────────────


  function randomSubset(arr) {
    return arr.filter(() => Math.random() < 0.5).sort((a,b)=>a-b);
  }
  const lifeDigits = [...Array(9).keys()];

  function updatePulseAssignmentsUI(){
    pulseAssignmentsDiv.innerHTML = "";

    // Ensure solo state is current (used for dimming + MIDI gating)
    recomputeSoloActive();

    pulses.forEach(p=>{
      // Ensure each pulse has a stable color
      if(!p.color) p.color = getPulseColor(p.id);

      const sounding = pulseShouldSound(p);
      const labelOpacity = sounding ? "1" : "0.55";
      const chDisplay = (Number.isFinite(p.channel) ? (p.channel|0) : 0) + 1;

      const row = document.createElement("div");
      row.className = "pulse-row";
      row.innerHTML = `
        <div class="pulse-left">
          <span class="pulse-swatch" style="background:${p.color};"></span>
          <span class="pulse-text" style="opacity:${labelOpacity};">
            T${p.id+1} &nbsp; ch${chDisplay} &nbsp; n${p.note}
          </span>
        </div>

        <div class="pulse-btns">
          <button data-action="mute" data-pulse="${p.id}" title="Mute" style="${p.muted ? "background:#c33;color:#fff;border-color:#a22;" : ""}">
            M
          </button>

          <button data-action="solo" data-pulse="${p.id}" title="Solo" style="${p.soloed ? "background:#6fcf97;color:#000;border-color:#6fcf97;" : ""}">
            S
          </button>

          <button data-action="trig" data-pulse="${p.id}" title="Trigger">▶</button>
        </div>
      `;
      pulseAssignmentsDiv.appendChild(row);
    });

    // Button wiring (mute / solo / trig)
    pulseAssignmentsDiv.querySelectorAll("button").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const pid = parseInt(btn.getAttribute("data-pulse"));
        const action = btn.getAttribute("data-action") || "trig";
        const pulse = pulses[pid];
        if(!pulse) return;

        if(action === "mute"){
          pulse.muted = !pulse.muted;
        } else if(action === "solo"){
          pulse.soloed = !pulse.soloed;
        } else {
          pulse.pendingTrigger = false;
          triggerPulse(pulse);
        }

        recomputeSoloActive();
        updatePulseAssignmentsUI();

        if(playState !== "running") requestStaticRedraw();
      });
    });

    // Enforce Machinedrum cap in UI
    if(addPulseBtn) addPulseBtn.disabled = (pulses.length >= MAX_PULSES);
    if(removePulseBtn) removePulseBtn.disabled = (pulses.length <= 1);
  }

  // Update pulse assignments (old-version behaviour):
  // - applyPulseMidiAssignments() hard-sets note/channel per pulse from globalData
  // - then refresh the pulse UI
  updatePulseAssignments = function(){
    applyPulseMidiAssignments();
    updatePulseAssignmentsUI();
  }

  function updateTimingUI(){
    const isBpm = !!bpmMode;
    if (timingModeTextEl) timingModeTextEl.textContent = isBpm ? "BPM" : "SPD";
    if (bpmInput) bpmInput.style.display = isBpm ? "block" : "none";
    if (speedInput) speedInput.style.display = isBpm ? "none" : "block";
    if (timingValueEl) timingValueEl.textContent = isBpm ? String(globalBPM) : String(Math.floor(globalSpeed));
  }

  // Init timing UI state
  updateTimingUI();

  bpmModeCheckbox.addEventListener("change", e=>{
    bpmMode = !!e.target.checked;

    // Keep core timing vars in-sync when toggling modes
    if (bpmMode) {
      interval = 60000 / Math.max(1, globalBPM);
    } else {
      pulses.forEach(p=> {
        const r = (p && Number.isFinite(p.timingRatio) && p.timingRatio>0) ? p.timingRatio : 1;
        p.speed = Math.max(10, Math.min(8000, globalSpeed / r));
      });
    }

    updateTimingUI();
  });
  // BPM / Speed sliders are wired (input + change) further down in this file.

  function updateTransitionExtraControls(){
    const extraWrap = document.getElementById("transitionExtraControls");
    if(!extraWrap) return;

    // Hide all known extra-control blocks
    [
      "sequentialControls",
      "weightedControls",
      "bounceControls",
      "nearestControls",
      "farthestControls",
      "networkControls",
      "seededUniformControls",
      "wolframControls","lifeControls","chaosControls",
      "lsysControls","hilbertControls"
    ].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.style.display = "none";
    });

    let showWrap = false;
    const show = (id)=>{
      const el = document.getElementById(id);
      if(el){ el.style.display = "block"; showWrap = true; }
    };

    // Show only modes that actually have extra controls
    switch(currentTransitionMode){
      case "sequential": show("sequentialControls"); break;
      case "weighted": show("weightedControls"); break;
      case "bounceRoot": show("bounceControls"); break;
      case "nearest": show("nearestControls"); break;
      case "farthest": show("farthestControls"); break;
      case "network": show("networkControls"); break;
      case "seededUniform": show("seededUniformControls"); break;
      case "wolfram": show("wolframControls"); break;
      case "life": show("lifeControls"); break;
      case "chaos": show("chaosControls"); break;
      case "lsys": show("lsysControls"); break;
      case "hilbert": show("hilbertControls"); break;
      default: break;
    }

    // Collapse the container if nothing is relevant for the current mode
    extraWrap.style.display = showWrap ? "block" : "none";

    // Mode-specific tweaks
    if(showWrap){
      updateBounceControlsVisibility();
      updateNetworkControlsLabels();
    }
  }

  transitionModeSelect.addEventListener("change", e=>{
    currentTransitionMode = e.target.value;
    updateTransitionExtraControls();
  });

  // ── Wolfram controls: keep UI + internal state in sync ───────
  function resetWolframCaches(){
    wolframLastStepBucket = -1;
    // Force re-init on next step
    wolframState = [];
    wolframNext = [];
    wolframPulseStates = [];
    wolframPulseNext = [];
  }

  if (wolframPerPulseToggle) {
    wolframPerPulse = !!wolframPerPulseToggle.checked;
    wolframPerPulseToggle.addEventListener("change", (e)=>{
      wolframPerPulse = !!e.target.checked;
      resetWolframCaches();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  if (wolframRuleSpreadInput) {
    wolframRuleSpread = Math.max(0, Math.min(255, parseInt(wolframRuleSpreadInput.value, 10) || 0));
    wolframRuleSpreadInput.addEventListener("change", ()=>{
      wolframRuleSpread = Math.max(0, Math.min(255, parseInt(wolframRuleSpreadInput.value, 10) || 0));
      resetWolframCaches();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  randomizeWolframBtn.addEventListener("click", ()=>{
    wolframRule = Math.floor(getRandom()*256);
    wolframRuleInput.value = wolframRule;
    resetWolframCaches();
    if(playState !== "running") requestStaticRedraw();
  });
  wolframRuleInput.addEventListener("change", ()=>{
    wolframRule = parseInt(wolframRuleInput.value) || 30;
    wolframRule = Math.max(0, Math.min(255, wolframRule));
    wolframRuleInput.value = wolframRule;
    resetWolframCaches();
    if(playState !== "running") requestStaticRedraw();
  });

  if(randomizeWolframModeBtn){
    randomizeWolframModeBtn.addEventListener("click", ()=>{
      randomizeWolframMode();
    });
  }

  randomizeLifeBtn.addEventListener("click", ()=>{
    // random life rule
    let b = randomSubset(lifeDigits);
    let s = randomSubset(lifeDigits);
    lifeRule = `B${b.join("")}/S${s.join("")}`;
    lifeRuleInput.value = lifeRule;

    // random grid size (within UI min/max)
    const rMin = (lifeRowsInput && Number.isFinite(parseInt(lifeRowsInput.min, 10))) ? parseInt(lifeRowsInput.min, 10) : 2;
    const rMax = (lifeRowsInput && Number.isFinite(parseInt(lifeRowsInput.max, 10))) ? parseInt(lifeRowsInput.max, 10) : 64;
    const cMin = (lifeColsInput && Number.isFinite(parseInt(lifeColsInput.min, 10))) ? parseInt(lifeColsInput.min, 10) : 2;
    const cMax = (lifeColsInput && Number.isFinite(parseInt(lifeColsInput.max, 10))) ? parseInt(lifeColsInput.max, 10) : 64;

    // Bias towards smaller grids for performance
    const rPickMax = Math.min(rMax, 32);
    const cPickMax = Math.min(cMax, 32);

    lifeRows = randInt(rMin, Math.max(rMin, rPickMax));
    lifeCols = randInt(cMin, Math.max(cMin, cPickMax));

    if(lifeRowsInput) lifeRowsInput.value = lifeRows;
    if(lifeColsInput) lifeColsInput.value = lifeCols;

    initLifeGrid();
  });
  lifeRuleInput.addEventListener("change", ()=>{
    lifeRule = lifeRuleInput.value.trim()||"B3/S23";
  });
  lifeRowsInput.addEventListener("change", ()=>{
    lifeRows = parseInt(lifeRowsInput.value)||10;
    initLifeGrid();
  });
  lifeColsInput.addEventListener("change", ()=>{
    lifeCols = parseInt(lifeColsInput.value)||10;
    initLifeGrid();
  });

  // ── Extra transition-mode controls ────────────────────────────

  function updateNetworkControlsLabels(){
    if(networkPreferOutputsLabel && networkPreferOutputsInput){
      const v = parseFloat(networkPreferOutputsInput.value);
      networkPreferOutputsLabel.textContent = (Number.isFinite(v) ? v : 0).toFixed(2);
    }
  }

  function updateBounceControlsVisibility(){
    if(bounceReturnChanceLabel && bounceReturnChanceInput){
      const v = parseFloat(bounceReturnChanceInput.value);
      bounceReturnChanceLabel.textContent = (Number.isFinite(v) ? v : 0).toFixed(2);
    }
    if(bounceCycleRow && bounceAwayModeSelect){
      bounceCycleRow.style.display = (bounceAwayModeSelect.value === "cycle") ? "grid" : "none";
    }
  }

  function rebuildChaosNow(){
    buildChaosPoints(nodes);
    if(playState !== "running") requestStaticRedraw();
  }

  function rebuildLsysNow(){
    buildLsys();
    // Reset per-pulse direction state (helps make turn-mode predictable)
    pulses.forEach(p=>{ if(p) p.lsysDir = 1; });
    if(playState !== "running") requestStaticRedraw();
  }

  function rebuildHilbertNow(){
    buildHilbert(nodes);
    if(playState !== "running") requestStaticRedraw();
  }

  // ── Per-mode randomizers (Rand Mode buttons) ───────────────────
  function randInt(min, max){
    min = Math.floor(min);
    max = Math.floor(max);
    if(!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if(max < min){ const t = max; max = min; min = t; }
    return min + Math.floor(getRandom() * (max - min + 1));
  }
  function randFloat(min, max){
    if(!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if(max < min){ const t = max; max = min; min = t; }
    return min + getRandom() * (max - min);
  }
  function randChoice(list){
    if(!Array.isArray(list) || list.length === 0) return null;
    return list[Math.floor(getRandom() * list.length)];
  }

  function randomizeSequentialMode(){
    const maxStep = Math.min(64, Math.max(1, nodes.length - 1));
    sequentialStep = randInt(1, maxStep);
    sequentialDirection = (getRandom() < 0.5) ? -1 : 1;
    sequentialSkipRoot = (getRandom() < 0.5);

    if(sequentialStepInput) sequentialStepInput.value = sequentialStep;
    if(sequentialDirSelect) sequentialDirSelect.value = String(sequentialDirection);
    if(sequentialSkipRootToggle) sequentialSkipRootToggle.checked = sequentialSkipRoot;
  }

  function randomizeWeightedMode(){
    weightedBias = (getRandom() < 0.5) ? "far" : "near";

    // Exponent: bias around 0.75..6 for useful results, but keep within limits.
    weightedExponent = clampFloat(randFloat(0.01, 1) < 0.2 ? randFloat(6, 14) : randFloat(0.5, 6), 0.01, 20, 1.0);
    weightedExponent = Math.round(weightedExponent * 100) / 100;

    // Min dist: bias to smaller values (0..40%)
    const minPct = Math.floor(Math.pow(getRandom(), 1.8) * 40);
    weightedMinDistRatio = clampFloat(minPct / 100, 0, 1, 0);

    weightedExcludeSelf = (getRandom() < 0.85);

    if(weightedBiasSelect) weightedBiasSelect.value = weightedBias;
    if(weightedExponentInput) weightedExponentInput.value = weightedExponent;
    if(weightedMinDistInput) weightedMinDistInput.value = Math.round(weightedMinDistRatio * 100);
    if(weightedExcludeSelfToggle) weightedExcludeSelfToggle.checked = weightedExcludeSelf;
  }

  function randomizeBounceMode(){
    // Return chance: skew towards rhythmic bouncing (0.4..1.0)
    bounceReturnChance = clampFloat(randFloat(0, 1) < 0.2 ? randFloat(0, 0.4) : randFloat(0.4, 1.0), 0, 1, 1.0);
    bounceReturnChance = Math.round(bounceReturnChance * 100) / 100;

    bounceAwayMode = randChoice(["random","cycle","nearest","farthest","weighted"]) || "random";

    bounceCycleStep = randInt(1, Math.min(64, Math.max(1, nodes.length - 1)));
    bounceCycleDir = (getRandom() < 0.5) ? -1 : 1;
    bounceAvoidSelf = (getRandom() < 0.85);

    if(bounceReturnChanceInput) bounceReturnChanceInput.value = bounceReturnChance;
    if(bounceAwayModeSelect) bounceAwayModeSelect.value = bounceAwayMode;
    if(bounceCycleStepInput) bounceCycleStepInput.value = bounceCycleStep;
    if(bounceCycleDirSelect) bounceCycleDirSelect.value = String(bounceCycleDir);
    if(bounceAvoidSelfToggle) bounceAvoidSelfToggle.checked = bounceAvoidSelf;

    pulses.forEach(p=>{ if(p) p.bounceCycleIndex = 0; });
    updateBounceControlsVisibility();
  }

  function randomizeNearestMode(){
    const maxK = Math.min(64, Math.max(1, nodes.length - 1));
    nearestK = randInt(1, Math.min(8, maxK));
    nearestRandomChance = clampFloat(Math.pow(getRandom(), 1.6) * 0.35, 0, 1, 0);
    nearestAvoidBacktrack = (getRandom() < 0.5);

    if(nearestKInput) nearestKInput.value = nearestK;
    if(nearestRandomInput) nearestRandomInput.value = Math.round(nearestRandomChance * 100);
    if(nearestAvoidBacktrackToggle) nearestAvoidBacktrackToggle.checked = nearestAvoidBacktrack;
  }

  function randomizeFarthestMode(){
    const maxK = Math.min(64, Math.max(1, nodes.length - 1));
    farthestK = randInt(1, Math.min(8, maxK));
    farthestRandomChance = clampFloat(Math.pow(getRandom(), 1.6) * 0.35, 0, 1, 0);
    farthestAvoidBacktrack = (getRandom() < 0.5);

    if(farthestKInput) farthestKInput.value = farthestK;
    if(farthestRandomInput) farthestRandomInput.value = Math.round(farthestRandomChance * 100);
    if(farthestAvoidBacktrackToggle) farthestAvoidBacktrackToggle.checked = farthestAvoidBacktrack;
  }

  function randomizeNetworkMode(){
    // Keep networks relatively sparse by default
    networkMinOutputs = randInt(0, 4);
    networkMaxOutputs = randInt(networkMinOutputs, Math.max(networkMinOutputs, 8));
    networkPreferOutputs = clampFloat(randFloat(0.2, 1.0), 0, 1, 1.0);
    networkPreferOutputs = Math.round(networkPreferOutputs * 100) / 100;
    networkOutputBias = randChoice(["uniform","near","far"]) || "uniform";
    networkFallbackMode = randChoice(["uniform","root","sequential","nearest","farthest"]) || "uniform";
    networkAllowSelfLoops = (getRandom() < 0.2);

    if(networkMinOutputsInput) networkMinOutputsInput.value = networkMinOutputs;
    if(networkMaxOutputsInput) networkMaxOutputsInput.value = networkMaxOutputs;
    if(networkPreferOutputsInput) networkPreferOutputsInput.value = networkPreferOutputs;
    if(networkOutputBiasSelect) networkOutputBiasSelect.value = networkOutputBias;
    if(networkFallbackSelect) networkFallbackSelect.value = networkFallbackMode;
    if(networkAllowSelfLoopsToggle) networkAllowSelfLoopsToggle.checked = networkAllowSelfLoops;

    updateNetworkControlsLabels();

    // Apply immediately
    assignRandomConnections();
    if(playState !== "running") requestStaticRedraw();
  }

  function randomizeSeededUniformMode(){
    const sMin = (seededUniformSeedInput && Number.isFinite(parseInt(seededUniformSeedInput.min,10))) ? parseInt(seededUniformSeedInput.min,10) : 1;
    const sMax = (seededUniformSeedInput && Number.isFinite(parseInt(seededUniformSeedInput.max,10))) ? parseInt(seededUniformSeedInput.max,10) : 999999;
    const rnd = randInt(sMin, sMax);
    setSeededUniformSeed(rnd);
    if(seededUniformSeedInput) seededUniformSeedInput.value = seededUniformSeedBase;

    seededUniformPerPulse = (getRandom() < 0.5);
    if(seededUniformPerPulseToggle) seededUniformPerPulseToggle.checked = seededUniformPerPulse;
    syncSeededUniformPulseSeeds();

    restartSeededUniformSequence();
  }

  function randomizeWolframMode(){
    wolframRule = Math.floor(getRandom()*256);
    wolframRuleInput.value = wolframRule;

    wolframPerPulse = (getRandom() < 0.7);
    if(wolframPerPulseToggle) wolframPerPulseToggle.checked = wolframPerPulse;

    wolframRuleSpread = Math.floor(getRandom()*256);
    if(wolframRuleSpreadInput) wolframRuleSpreadInput.value = wolframRuleSpread;

    resetWolframCaches();
    if(playState !== "running") requestStaticRedraw();
  }

  function randomizeChaosMode(){
    const cornerMax = Math.min(8, Math.max(3, nodes.length));
    chaosCornerCount = randInt(3, cornerMax);
    chaosPointCount = clampInt(Math.floor(50 + Math.pow(getRandom(), 1.8) * 9950), 50, 10000, 200);
    chaosStepFraction = clampFloat(randFloat(0.05, 0.95), 0.05, 0.95, 0.5);
    chaosStepFraction = Math.round(chaosStepFraction * 100) / 100;
    chaosBurnIn = clampInt(Math.floor(Math.pow(getRandom(), 1.8) * 1200), 0, 2000, 0);
    chaosCornerMode = (getRandom() < 0.5) ? "first" : "spread";
    chaosNoRepeatCorners = (getRandom() < 0.5);

    if(chaosCornerCountInput) chaosCornerCountInput.value = chaosCornerCount;
    if(chaosPointCountInput) chaosPointCountInput.value = chaosPointCount;
    if(chaosStepFractionInput) chaosStepFractionInput.value = chaosStepFraction;
    if(chaosBurnInInput) chaosBurnInInput.value = chaosBurnIn;
    if(chaosCornerModeSelect) chaosCornerModeSelect.value = chaosCornerMode;
    if(chaosNoRepeatToggle) chaosNoRepeatToggle.checked = chaosNoRepeatCorners;

    // Rebuild immediately
    rebuildChaosNow();
  }

  function randomizeLsysMode(){
    // Curated presets (robust: only F,+,-)
    const presets = [
      { axiom: "F", rule: "F+F-F-F+F" },               // square-ish Koch
      { axiom: "F", rule: "F+F--F+F" },                // classic Koch variant
      { axiom: "F", rule: "F-F+F+FF-F-F+F" },          // busier
      { axiom: "F", rule: "FF-[-F+F+F]+[+F-F-F]" },    // includes brackets → adds random hops (nice chaos)
      { axiom: "F", rule: "F+FF-FF-F-F+F+FF-F-F+F" }   // dense
    ];
    const p = randChoice(presets) || presets[0];

    lsysAxiom = String(p.axiom || "F");
    lsysRuleF = String(p.rule || "F+F-F-F+F");

    // Keep iterations moderate for performance
    lsysIterations = randInt(0, 6);
    lsysStep = randInt(1, Math.min(8, Math.max(1, nodes.length - 1)));
    lsysTurnMode = (getRandom() < 0.5);

    if(lsysAxiomInput) lsysAxiomInput.value = lsysAxiom;
    if(lsysRuleFInput) lsysRuleFInput.value = lsysRuleF;
    if(lsysIterationsInput) lsysIterationsInput.value = lsysIterations;
    if(lsysStepInput) lsysStepInput.value = lsysStep;
    if(lsysTurnModeToggle) lsysTurnModeToggle.checked = lsysTurnMode;

    rebuildLsysNow();
  }

  function randomizeHilbertMode(){
    hilbertMode = randChoice(["diagonal","hilbert","zorder"]) || "diagonal";
    hilbertOrder = randInt(2, 9);
    hilbertStep = randInt(1, Math.min(12, Math.max(1, nodes.length - 1)));
    hilbertPingPong = (getRandom() < 0.5);

    if(hilbertModeSelect) hilbertModeSelect.value = hilbertMode;
    if(hilbertOrderInput) hilbertOrderInput.value = hilbertOrder;
    if(hilbertStepInput) hilbertStepInput.value = hilbertStep;
    if(hilbertPingPongToggle) hilbertPingPongToggle.checked = hilbertPingPong;

    hilbertIndex = 0;
    hilbertDir = 1;
    rebuildHilbertNow();
  }

  // Sequential
  if(sequentialStepInput){
    sequentialStepInput.addEventListener("change", ()=>{
      sequentialStep = clampInt(sequentialStepInput.value, 1, 64, 1);
      sequentialStepInput.value = sequentialStep;
    });
  }
  if(sequentialDirSelect){
    sequentialDirSelect.addEventListener("change", ()=>{
      sequentialDirection = (parseInt(sequentialDirSelect.value, 10) === -1) ? -1 : 1;
    });
  }
  if(sequentialSkipRootToggle){
    sequentialSkipRootToggle.addEventListener("change", ()=>{
      sequentialSkipRoot = !!sequentialSkipRootToggle.checked;
    });
  }
  if(randomizeSequentialBtn){
    randomizeSequentialBtn.addEventListener("click", ()=>{
      randomizeSequentialMode();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  // Weighted
  if(weightedBiasSelect){
    weightedBiasSelect.addEventListener("change", ()=>{
      weightedBias = (weightedBiasSelect.value === "near") ? "near" : "far";
    });
  }
  if(weightedExponentInput){
    weightedExponentInput.addEventListener("change", ()=>{
      weightedExponent = clampFloat(weightedExponentInput.value, 0.01, 20, 1.0);
      weightedExponentInput.value = weightedExponent;
    });
  }
  if(weightedMinDistInput){
    weightedMinDistInput.addEventListener("change", ()=>{
      const pct = clampFloat(weightedMinDistInput.value, 0, 100, 0);
      weightedMinDistInput.value = pct;
      weightedMinDistRatio = pct / 100;
    });
  }
  if(weightedExcludeSelfToggle){
    weightedExcludeSelfToggle.addEventListener("change", ()=>{
      weightedExcludeSelf = !!weightedExcludeSelfToggle.checked;
    });
  }
  if(randomizeWeightedBtn){
    randomizeWeightedBtn.addEventListener("click", ()=>{
      randomizeWeightedMode();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  // Bounce to root
  if(bounceReturnChanceInput){
    bounceReturnChanceInput.addEventListener("input", ()=>{
      bounceReturnChance = clampFloat(bounceReturnChanceInput.value, 0, 1, 1.0);
      updateBounceControlsVisibility();
    });
    bounceReturnChanceInput.addEventListener("change", ()=>{
      bounceReturnChance = clampFloat(bounceReturnChanceInput.value, 0, 1, 1.0);
      updateBounceControlsVisibility();
    });
  }
  if(bounceAwayModeSelect){
    bounceAwayModeSelect.addEventListener("change", ()=>{
      bounceAwayMode = bounceAwayModeSelect.value || "random";
      updateBounceControlsVisibility();
      pulses.forEach(p=>{ if(p) p.bounceCycleIndex = 0; });
    });
  }
  if(bounceCycleStepInput){
    bounceCycleStepInput.addEventListener("change", ()=>{
      bounceCycleStep = clampInt(bounceCycleStepInput.value, 1, 64, 1);
      bounceCycleStepInput.value = bounceCycleStep;
      pulses.forEach(p=>{ if(p) p.bounceCycleIndex = 0; });
    });
  }
  if(bounceCycleDirSelect){
    bounceCycleDirSelect.addEventListener("change", ()=>{
      bounceCycleDir = (parseInt(bounceCycleDirSelect.value, 10) === -1) ? -1 : 1;
      pulses.forEach(p=>{ if(p) p.bounceCycleIndex = 0; });
    });
  }
  if(bounceAvoidSelfToggle){
    bounceAvoidSelfToggle.addEventListener("change", ()=>{
      bounceAvoidSelf = !!bounceAvoidSelfToggle.checked;
    });
  }
  if(randomizeBounceBtn){
    randomizeBounceBtn.addEventListener("click", ()=>{
      randomizeBounceMode();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  // Nearest
  if(nearestKInput){
    nearestKInput.addEventListener("change", ()=>{
      nearestK = clampInt(nearestKInput.value, 1, 64, 1);
      nearestKInput.value = nearestK;
    });
  }
  if(nearestRandomInput){
    nearestRandomInput.addEventListener("change", ()=>{
      const pct = clampFloat(nearestRandomInput.value, 0, 100, 0);
      nearestRandomInput.value = pct;
      nearestRandomChance = pct / 100;
    });
  }
  if(nearestAvoidBacktrackToggle){
    nearestAvoidBacktrackToggle.addEventListener("change", ()=>{
      nearestAvoidBacktrack = !!nearestAvoidBacktrackToggle.checked;
    });
  }
  if(randomizeNearestBtn){
    randomizeNearestBtn.addEventListener("click", ()=>{
      randomizeNearestMode();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  // Farthest
  if(farthestKInput){
    farthestKInput.addEventListener("change", ()=>{
      farthestK = clampInt(farthestKInput.value, 1, 64, 1);
      farthestKInput.value = farthestK;
    });
  }
  if(farthestRandomInput){
    farthestRandomInput.addEventListener("change", ()=>{
      const pct = clampFloat(farthestRandomInput.value, 0, 100, 0);
      farthestRandomInput.value = pct;
      farthestRandomChance = pct / 100;
    });
  }
  if(farthestAvoidBacktrackToggle){
    farthestAvoidBacktrackToggle.addEventListener("change", ()=>{
      farthestAvoidBacktrack = !!farthestAvoidBacktrackToggle.checked;
    });
  }
  if(randomizeFarthestBtn){
    randomizeFarthestBtn.addEventListener("click", ()=>{
      randomizeFarthestMode();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  // Network
  function applyNetworkMinMax(){
    if(!networkMinOutputsInput || !networkMaxOutputsInput) return;

    networkMinOutputs = clampInt(networkMinOutputsInput.value, 0, 16, 0);
    networkMaxOutputs = clampInt(networkMaxOutputsInput.value, 0, 16, 3);

    if(networkMaxOutputs < networkMinOutputs){
      networkMaxOutputs = networkMinOutputs;
      networkMaxOutputsInput.value = networkMaxOutputs;
    }

    // Apply immediately by rewiring
    assignRandomConnections();
    if(playState !== "running") requestStaticRedraw();
  }

  if(networkMinOutputsInput) networkMinOutputsInput.addEventListener("change", applyNetworkMinMax);
  if(networkMaxOutputsInput) networkMaxOutputsInput.addEventListener("change", applyNetworkMinMax);

  if(networkPreferOutputsInput){
    networkPreferOutputsInput.addEventListener("input", ()=>{
      networkPreferOutputs = clampFloat(networkPreferOutputsInput.value, 0, 1, 1.0);
      updateNetworkControlsLabels();
    });
    networkPreferOutputsInput.addEventListener("change", ()=>{
      networkPreferOutputs = clampFloat(networkPreferOutputsInput.value, 0, 1, 1.0);
      updateNetworkControlsLabels();
    });
  }

  if(networkOutputBiasSelect){
    networkOutputBiasSelect.addEventListener("change", ()=>{
      networkOutputBias = networkOutputBiasSelect.value || "uniform";
    });
  }

  if(networkFallbackSelect){
    networkFallbackSelect.addEventListener("change", ()=>{
      networkFallbackMode = networkFallbackSelect.value || "uniform";
    });
  }

  if(networkAllowSelfLoopsToggle){
    networkAllowSelfLoopsToggle.addEventListener("change", ()=>{
      networkAllowSelfLoops = !!networkAllowSelfLoopsToggle.checked;
      assignRandomConnections();
      if(playState !== "running") requestStaticRedraw();
    });
  }

  if(rewireNetworkBtn){
    rewireNetworkBtn.addEventListener("click", ()=>{
      assignRandomConnections();
      if(playState !== "running") requestStaticRedraw();
    });
  }
  if(randomizeNetworkBtn){
    randomizeNetworkBtn.addEventListener("click", ()=>{
      randomizeNetworkMode();
    });
  }

  // Seeded uniform
  if(seededUniformSeedInput){
    seededUniformSeedInput.addEventListener("change", ()=>{
      setSeededUniformSeed(seededUniformSeedInput.value);
      // Keep UI consistent
      seededUniformSeedInput.value = seededUniformSeedBase;
    });
  }
  if(randomSeededUniformBtn){
    randomSeededUniformBtn.addEventListener("click", ()=>{
      const rnd = 1 + Math.floor(getRandom() * 999999);
      setSeededUniformSeed(rnd);
      if(seededUniformSeedInput) seededUniformSeedInput.value = seededUniformSeedBase;
    });
  }
  if(seededUniformPerPulseToggle){
    seededUniformPerPulseToggle.addEventListener("change", ()=>{
      seededUniformPerPulse = !!seededUniformPerPulseToggle.checked;
      syncSeededUniformPulseSeeds();
    });
  }
  if(restartSeededUniformBtn){
    restartSeededUniformBtn.addEventListener("click", ()=>{
      restartSeededUniformSequence();
    });
  }
  if(randomizeSeededUniformModeBtn){
    randomizeSeededUniformModeBtn.addEventListener("click", ()=>{
      randomizeSeededUniformMode();
    });
  }

  // Chaos game
  function applyChaosSettings(){
    if(chaosCornerCountInput){
      chaosCornerCount = clampInt(chaosCornerCountInput.value, 3, 8, 4);
      chaosCornerCountInput.value = chaosCornerCount;
    }
    if(chaosPointCountInput){
      chaosPointCount = clampInt(chaosPointCountInput.value, 50, 10000, 200);
      chaosPointCountInput.value = chaosPointCount;
    }
    if(chaosStepFractionInput){
      chaosStepFraction = clampFloat(chaosStepFractionInput.value, 0.05, 0.95, 0.5);
      chaosStepFractionInput.value = chaosStepFraction;
    }
    if(chaosBurnInInput){
      chaosBurnIn = clampInt(chaosBurnInInput.value, 0, 2000, 0);
      chaosBurnInInput.value = chaosBurnIn;
    }
    if(chaosCornerModeSelect){
      chaosCornerMode = chaosCornerModeSelect.value || "first";
    }
    if(chaosNoRepeatToggle){
      chaosNoRepeatCorners = !!chaosNoRepeatToggle.checked;
    }

    rebuildChaosNow();
  }

  if(chaosCornerCountInput) chaosCornerCountInput.addEventListener("change", applyChaosSettings);
  if(chaosPointCountInput) chaosPointCountInput.addEventListener("change", applyChaosSettings);
  if(chaosStepFractionInput) chaosStepFractionInput.addEventListener("change", applyChaosSettings);
  if(chaosBurnInInput) chaosBurnInInput.addEventListener("change", applyChaosSettings);
  if(chaosCornerModeSelect) chaosCornerModeSelect.addEventListener("change", applyChaosSettings);
  if(chaosNoRepeatToggle) chaosNoRepeatToggle.addEventListener("change", applyChaosSettings);

  rebuildChaosBtn.addEventListener("click", ()=>{
    randomizeChaosMode();
  });

  // L-system
  function applyLsysSettings(){
    if(lsysAxiomInput) lsysAxiom = String(lsysAxiomInput.value || "F");
    if(lsysRuleFInput) lsysRuleF = String(lsysRuleFInput.value || "F");
    if(lsysIterationsInput){
      lsysIterations = clampInt(lsysIterationsInput.value, 0, 10, 2);
      lsysIterationsInput.value = lsysIterations;
    }
    if(lsysStepInput){
      lsysStep = clampInt(lsysStepInput.value, 1, 64, 1);
      lsysStepInput.value = lsysStep;
    }
    if(lsysTurnModeToggle) lsysTurnMode = !!lsysTurnModeToggle.checked;

    rebuildLsysNow();
  }

  if(lsysAxiomInput) lsysAxiomInput.addEventListener("change", applyLsysSettings);
  if(lsysRuleFInput) lsysRuleFInput.addEventListener("change", applyLsysSettings);
  if(lsysIterationsInput) lsysIterationsInput.addEventListener("change", applyLsysSettings);
  if(lsysStepInput) lsysStepInput.addEventListener("change", applyLsysSettings);
  if(lsysTurnModeToggle) lsysTurnModeToggle.addEventListener("change", applyLsysSettings);

  rebuildLsysBtn.addEventListener("click", ()=>{
    randomizeLsysMode();
  });

  // Hilbert / ordering
  function applyHilbertSettings(){
    if(hilbertModeSelect) hilbertMode = hilbertModeSelect.value || "diagonal";
    if(hilbertOrderInput){
      hilbertOrder = clampInt(hilbertOrderInput.value, 1, 10, 6);
      hilbertOrderInput.value = hilbertOrder;
    }
    if(hilbertStepInput){
      hilbertStep = clampInt(hilbertStepInput.value, 1, 64, 1);
      hilbertStepInput.value = hilbertStep;
    }
    if(hilbertPingPongToggle) hilbertPingPong = !!hilbertPingPongToggle.checked;

    hilbertIndex = 0;
    hilbertDir = 1;

    rebuildHilbertNow();
  }

  if(hilbertModeSelect) hilbertModeSelect.addEventListener("change", applyHilbertSettings);
  if(hilbertOrderInput) hilbertOrderInput.addEventListener("change", applyHilbertSettings);
  if(hilbertStepInput) hilbertStepInput.addEventListener("change", applyHilbertSettings);
  if(hilbertPingPongToggle) hilbertPingPongToggle.addEventListener("change", applyHilbertSettings);

  rebuildHilbertBtn.addEventListener("click", ()=>{
    randomizeHilbertMode();
  });

  // Init labels / visibility
  updateBounceControlsVisibility();
  updateNetworkControlsLabels();

  addNodeBtn.addEventListener("click", ()=>{
    addNode();
  });
  removeNodeBtn.addEventListener("click", ()=>{
    removeNode();
  });
  randNodesBtn.addEventListener("click", ()=>{
    randomizeNodes();
  });
  resetNodesBtn.addEventListener("click", ()=>{
    resetNodes();
  });

  addPulseBtn.addEventListener("click", ()=>{
    addPulse();
  });
  removePulseBtn.addEventListener("click", ()=>{
    removePulse();
  });
  randPulsesBtn.addEventListener("click", ()=>{
    randomizePulses();
  });
  resetPulsesBtn.addEventListener("click", ()=>{
    // User-requested behaviour: Reset should unmute everything.
    unmuteAllPulses();
    resetPulses();
  });

  morphSlider.addEventListener("input", e=>{
    currentMorphValue = parseFloat(e.target.value);
    updateNodePositions();
  });
  spaceSlider.addEventListener("input", e=>{
    currentSpaceValue = parseFloat(e.target.value);
    updateNodePositions();
  });

  morphLFOEnable.addEventListener("change", e=>{
    morphLFOEnabled = e.target.checked;
  });
  morphLFOSpeedEl.addEventListener("input", e=>{
    morphLFOSpeed = parseFloat(e.target.value);
  });
  morphLFODepthEl.addEventListener("input", e=>{
    morphLFODepth = parseFloat(e.target.value);
  });

  spaceLFOEnable.addEventListener("change", e=>{
    spaceLFOEnabled = e.target.checked;
  });
  spaceLFOSpeedEl.addEventListener("input", e=>{
    spaceLFOSpeed = parseFloat(e.target.value);
  });
  spaceLFODepthEl.addEventListener("input", e=>{
    spaceLFODepth = parseFloat(e.target.value);
  });

  dynamicVelocityToggle.addEventListener("change", e=>{
    dynamicVelocityModeEnabled = e.target.checked;
  });
  toggleTrailsCheckbox.addEventListener('change', e => { showTrails = e.target.checked; });

  // Visual helpers
  if (togglePulseLinksCheckbox) {
    showPulseLinks = !!togglePulseLinksCheckbox.checked;
    togglePulseLinksCheckbox.addEventListener('change', (e) => {
      showPulseLinks = !!e.target.checked;
      if (playState !== "running") requestStaticRedraw();
    });
  }
  if (autoFitToggle) {
    autoFitEnabled = !!autoFitToggle.checked;
    autoFitToggle.addEventListener('change', (e) => {
      autoFitEnabled = !!e.target.checked;
      if (playState !== "running") requestStaticRedraw();
    });
  }
  if (showNetworkConnectionsToggle) {
    showNetworkConnections = !!showNetworkConnectionsToggle.checked;
    showNetworkConnectionsToggle.addEventListener('change', (e) => {
      showNetworkConnections = !!e.target.checked;
      if (playState !== "running") requestStaticRedraw();
    });
  }

    randAllBtn.addEventListener("click", ()=>{
    randomizeSequencer();
    randomizeDynamicCCSettings();
  });
  resetAllBtn.addEventListener("click", ()=>{
    resetSequencer();
  });

  // Start/Stop
  startBtn.addEventListener("click", ()=>{
    if (overlay.style.display !== "block") {
      overlay.style.display = "block";
      updateCanvasSize();
    }
    if(playState === "stopped") {
      stopPreviewLoop();
      resetPulses();
      drawOneFrame();
      playState = "running";
      startBtn.textContent = "Pause";
      lastFrameTime = performance.now();
      animate();
    } else if(playState === "running") {
      playState = "paused";
      __midiSuppressed = true;
      startBtn.textContent = "Resume";
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    } else if(playState === "paused") {
      playState = "running";
      stopPreviewLoop();
      startBtn.textContent = "Pause";
      lastFrameTime = performance.now();
      animate();
    }
  });

  stopBtn.addEventListener("click", ()=>{
    playState = "stopped";
    __midiSuppressed = true;
    if(animationFrameId) cancelAnimationFrame(animationFrameId);
    resetPulses();
    startBtn.textContent = "Start";
    requestStaticRedraw();
    maybeStartPreview();
  });

  function exitSequencer(){
    playState = "stopped";
    __midiSuppressed = true;
    stopPreviewLoop();
    if(animationFrameId) cancelAnimationFrame(animationFrameId);
    resetPulses();
    startBtn.textContent = "Start";
    if(!embedded){
      overlay.style.display = "none";
    }
  }

  exitBtn.addEventListener("click", ()=>{
    exitSequencer();
  });

  // ESC to close
  document.addEventListener("keydown", e=>{
    if(e.key==="Escape" && overlay && isOverlayVisible()) {
      exitSequencer();
    }
  });

  // Hidden shift-click to open
  document.body.addEventListener("click", e=>{
    if(e.shiftKey){
      // open
      overlay.style.display = "block";
      updateCanvasSize();
      drawOneFrame();
    }
  }, true);

  // ─────────────────────────────────────────────────────────────
  // Randomize/Reset full sequencer
  // ─────────────────────────────────────────────────────────────
  function randomizeSequencer(){
    // random transition mode
    const modes = [
        "uniform","sequential","weighted","bounceRoot","nearest","farthest","network","seededUniform",
        "wolfram","life","chaos","lsys","hilbert"
      ];
    let randomMode = modes[Math.floor(getRandom()*modes.length)];
    currentTransitionMode = randomMode;
    transitionModeSelect.value = randomMode;
    updateTransitionExtraControls();

    // random BPM or speed
    bpmMode = (getRandom()<0.7);
    bpmModeCheckbox.checked = bpmMode;

    if(bpmMode){
      globalBPM = 60+ Math.floor(getRandom()*120);
      bpmInput.value = globalBPM;
      interval = 60000/globalBPM;
    } else {
      globalSpeed = 50 + getRandom()*300;
      speedInput.value = Math.floor(globalSpeed);
      pulses.forEach(p=> {
        const r = (p && Number.isFinite(p.timingRatio) && p.timingRatio>0) ? p.timingRatio : 1;
        p.speed = Math.max(10, Math.min(8000, globalSpeed / r));
      });
    }
    updateTimingUI();

    // random node count
    let ncount = 4 + Math.floor(getRandom()*20);
    initNodes(ncount);

    // Machinedrum: 16-track device → keep pulses capped at 16
    let pcount = MAX_PULSES;
    initPulses(pcount);

    // random morph/space
    let m = Math.floor(getRandom()*100);
    let s = Math.floor(getRandom()*100);
    morphSlider.value = m;
    spaceSlider.value = s;
    currentMorphValue = m;
    currentSpaceValue = s;
    updateNodePositions();

    // random specialized stuff
    if(randomMode==="seededUniform"){
      seededUniformSeed = 1 + Math.floor(getRandom()*9999);
    }
    if(randomMode==="wolfram"){
      wolframRule = Math.floor(getRandom()*256);
      wolframRuleInput.value = wolframRule;
    }
    if(randomMode==="life"){
      lifeRows = 5+Math.floor(getRandom()*10);
      lifeCols = 5+Math.floor(getRandom()*10);
      lifeRowsInput.value = lifeRows;
      lifeColsInput.value = lifeCols;
      // random rule
      let b = randomSubset(lifeDigits);
      let s2= randomSubset(lifeDigits);
      lifeRule = `B${b.join("")}/S${s2.join("")}`;
      lifeRuleInput.value = lifeRule;
      initLifeGrid();
    }
    if(randomMode==="chaos"){
      buildChaosPoints(nodes);
    }
    if(randomMode==="lsys"){
      buildLsys();
    }
    if(randomMode==="hilbert"){
      buildHilbert(nodes);
    }

    // random pulses data
    randomizePulses();
    resetPulses();

    // LFO random
    morphLFOEnabled = (getRandom()<0.3);
    morphLFOEnable.checked = morphLFOEnabled;
    morphLFOSpeed = getRandom()*2;
    morphLFODepth = getRandom()*100;
    morphLFOSpeedEl.value = morphLFOSpeed.toFixed(2);
    morphLFODepthEl.value = Math.floor(morphLFODepth);

    spaceLFOEnabled = (getRandom()<0.3);
    spaceLFOEnable.checked = spaceLFOEnabled;
    spaceLFOSpeed = getRandom()*2;
    spaceLFODepth = getRandom()*100;
    spaceLFOSpeedEl.value = spaceLFOSpeed.toFixed(2);
    spaceLFODepthEl.value = Math.floor(spaceLFODepth);

    dynamicVelocityModeEnabled = (getRandom()<0.7);
    dynamicVelocityToggle.checked = dynamicVelocityModeEnabled;

    // trails
    showTrails = (getRandom()<0.5);
    toggleTrailsCheckbox.checked = showTrails;

    // redraw
    if(playState !== "running") drawOneFrame();
  }

  function resetSequencer(){
    // default
    currentTransitionMode="uniform";
    transitionModeSelect.value="uniform";

    // Reset transition-mode parameters (UI + state)
    sequentialStep = 1;
    sequentialDirection = 1;
    sequentialSkipRoot = false;
    if(sequentialStepInput) sequentialStepInput.value = 1;
    if(sequentialDirSelect) sequentialDirSelect.value = "1";
    if(sequentialSkipRootToggle) sequentialSkipRootToggle.checked = false;

    weightedBias = "far";
    weightedExponent = 1.0;
    weightedMinDistRatio = 0.0;
    weightedExcludeSelf = true;
    if(weightedBiasSelect) weightedBiasSelect.value = "far";
    if(weightedExponentInput) weightedExponentInput.value = 1;
    if(weightedMinDistInput) weightedMinDistInput.value = 0;
    if(weightedExcludeSelfToggle) weightedExcludeSelfToggle.checked = true;

    bounceReturnChance = 1.0;
    bounceAwayMode = "random";
    bounceCycleStep = 1;
    bounceCycleDir = 1;
    bounceAvoidSelf = true;
    if(bounceReturnChanceInput) bounceReturnChanceInput.value = 1;
    if(bounceAwayModeSelect) bounceAwayModeSelect.value = "random";
    if(bounceCycleStepInput) bounceCycleStepInput.value = 1;
    if(bounceCycleDirSelect) bounceCycleDirSelect.value = "1";
    if(bounceAvoidSelfToggle) bounceAvoidSelfToggle.checked = true;

    nearestK = 1;
    nearestAvoidBacktrack = false;
    nearestRandomChance = 0.0;
    if(nearestKInput) nearestKInput.value = 1;
    if(nearestRandomInput) nearestRandomInput.value = 0;
    if(nearestAvoidBacktrackToggle) nearestAvoidBacktrackToggle.checked = false;

    farthestK = 1;
    farthestAvoidBacktrack = false;
    farthestRandomChance = 0.0;
    if(farthestKInput) farthestKInput.value = 1;
    if(farthestRandomInput) farthestRandomInput.value = 0;
    if(farthestAvoidBacktrackToggle) farthestAvoidBacktrackToggle.checked = false;

    networkMinOutputs = 0;
    networkMaxOutputs = 3;
    networkPreferOutputs = 1.0;
    networkOutputBias = "uniform";
    networkFallbackMode = "uniform";
    networkAllowSelfLoops = false;
    if(networkMinOutputsInput) networkMinOutputsInput.value = 0;
    if(networkMaxOutputsInput) networkMaxOutputsInput.value = 3;
    if(networkPreferOutputsInput) networkPreferOutputsInput.value = 1;
    if(networkOutputBiasSelect) networkOutputBiasSelect.value = "uniform";
    if(networkFallbackSelect) networkFallbackSelect.value = "uniform";
    if(networkAllowSelfLoopsToggle) networkAllowSelfLoopsToggle.checked = false;

    seededUniformPerPulse = false;
    if(seededUniformPerPulseToggle) seededUniformPerPulseToggle.checked = false;
    setSeededUniformSeed(1);
    if(seededUniformSeedInput) seededUniformSeedInput.value = seededUniformSeedBase;

    // Chaos defaults
    chaosCornerCount = 4;
    chaosCornerMode = "first";
    chaosStepFraction = 0.5;
    chaosPointCount = 200;
    chaosBurnIn = 0;
    chaosNoRepeatCorners = false;
    if(chaosCornerCountInput) chaosCornerCountInput.value = 4;
    if(chaosPointCountInput) chaosPointCountInput.value = 200;
    if(chaosStepFractionInput) chaosStepFractionInput.value = 0.5;
    if(chaosBurnInInput) chaosBurnInInput.value = 0;
    if(chaosCornerModeSelect) chaosCornerModeSelect.value = "first";
    if(chaosNoRepeatToggle) chaosNoRepeatToggle.checked = false;

    // L-system defaults
    lsysAxiom = "F";
    lsysRuleF = "F+F-F-F+F";
    lsysIterations = 2;
    lsysStep = 1;
    lsysTurnMode = false;
    if(lsysAxiomInput) lsysAxiomInput.value = lsysAxiom;
    if(lsysRuleFInput) lsysRuleFInput.value = lsysRuleF;
    if(lsysIterationsInput) lsysIterationsInput.value = lsysIterations;
    if(lsysStepInput) lsysStepInput.value = lsysStep;
    if(lsysTurnModeToggle) lsysTurnModeToggle.checked = false;
    buildLsys();

    // Hilbert defaults
    hilbertMode = "diagonal";
    hilbertOrder = 6;
    hilbertStep = 1;
    hilbertPingPong = false;
    hilbertIndex = 0;
    hilbertDir = 1;
    if(hilbertModeSelect) hilbertModeSelect.value = "diagonal";
    if(hilbertOrderInput) hilbertOrderInput.value = 6;
    if(hilbertStepInput) hilbertStepInput.value = 1;
    if(hilbertPingPongToggle) hilbertPingPongToggle.checked = false;

    updateBounceControlsVisibility();
    updateNetworkControlsLabels();

    updateTransitionExtraControls();

    bpmMode=true;
    bpmModeCheckbox.checked=true;
    globalBPM=120;
    bpmInput.value=120;
    interval=60000/120;

    // Also reset Speed so toggling to Speed mode after Reset is predictable
    globalSpeed=100;
    speedInput.value=100;
    pulses.forEach(p=> {
      const r = (p && Number.isFinite(p.timingRatio) && p.timingRatio>0) ? p.timingRatio : 1;
      p.speed = Math.max(10, Math.min(8000, globalSpeed / r));
    });

    updateTimingUI();

    initNodes(8);
    initPulses(MAX_PULSES);

    morphSlider.value=0;
    spaceSlider.value=0;
    currentMorphValue=0;
    currentSpaceValue=0;
    updateNodePositions();

    morphLFOEnabled=false;
    spaceLFOEnabled=false;
    morphLFOEnable.checked=false;
    spaceLFOEnable.checked=false;
    morphLFOSpeed=0.1;
    morphLFODepth=20;
    spaceLFOSpeed=0.1;
    spaceLFODepth=20;
    morphLFOSpeedEl.value="0.1";
    morphLFODepthEl.value="20";
    spaceLFOSpeedEl.value="0.1";
    spaceLFODepthEl.value="20";

    dynamicVelocityModeEnabled=true;
    dynamicVelocityToggle.checked=true;

    showTrails=false;
    toggleTrailsCheckbox.checked=false;

    // Default OFF (requested)
    showPulseLinks = false;
    if (togglePulseLinksCheckbox) togglePulseLinksCheckbox.checked = false;

    resetPulses();

    if(playState !== "running") drawOneFrame();
  }

  // ─────────────────────────────────────────────────────────────
  // Dynamic CC mode UI (optional)
  // ─────────────────────────────────────────────────────────────
  // We'll add toggles or randomize base+mod settings:
  function initDynamicCCSettings() {
    // Per-track (1..16) settings.
    // Structure matches sendDynamicCC():
    //   dynamicCCSettings[trackNum] = { level: {enabled,base,mod}, params: [{...} x24] }
    dynamicCCSettings = {};
    pulses.forEach(p=>{
      const trackNum = ((p.id | 0) + 1);
      dynamicCCSettings[trackNum] = {
        level: { enabled: false, base: 64, mod: 0 },
        // MD_CC_MAP[].param contains 24 CC numbers (8 machine params + 8 FX + 8 routing)
        params: Array.from({ length: 24 }, () => ({ enabled: false, base: 64, mod: 0 }))
      };
    });
  }

  function randomizeDynamicCCSettings() {
    if(!window.MD_CC_MAP) return;
    initDynamicCCSettings();
    // Randomize base/mod with a light touch to avoid spamming 24 CCs on every hit.
    Object.keys(dynamicCCSettings).forEach(trackNumStr=>{
      const t = parseInt(trackNumStr, 10);
      const entry = dynamicCCSettings[t];
      if (!entry) return;

      // Level: 50% chance enabled
      entry.level.enabled = (getRandom() < 0.5);
      entry.level.base = Math.floor(getRandom() * 128);
      entry.level.mod = (getRandom() - 0.5) * 0.5; // -0.25..+0.25

      // Params: 15% chance enabled per CC (≈ 3-4 enabled on average)
      let anyMachineEnabled = false;
      for (let i = 0; i < entry.params.length; i++) {
        const s = entry.params[i];
        const enable = (getRandom() < 0.15);
        s.enabled = enable;
        s.base = Math.floor(getRandom() * 128);
        s.mod = (getRandom() - 0.5) * 0.5; // -0.25..+0.25
        if (enable && i < 8) anyMachineEnabled = true;
      }

      // Ensure at least one machine param is active so the mode feels "alive"
      if (!anyMachineEnabled) {
        const idx = Math.floor(getRandom() * 8);
        entry.params[idx].enabled = true;
      }
    });
  }

  // Add a UI toggle if we want:
  const dynamicCCDiv = document.createElement("div");
  dynamicCCDiv.className="control-group";
  dynamicCCDiv.innerHTML=`
    <label><input type="checkbox" id="dynamicCCToggle"/> Dynamic CC (MD_CC_MAP)</label>
    <button id="randCCBtn">Randomize CC Settings</button>
  `;
  // Insert it after trails
  toggleTrailsCheckbox.closest(".control-group").after(dynamicCCDiv);

  const dynamicCCToggle = document.getElementById("dynamicCCToggle");
  const randCCBtn = document.getElementById("randCCBtn");
  dynamicCCToggle.addEventListener("change", e=>{
    dynamicCCModeEnabled = e.target.checked;
    if (dynamicCCModeEnabled && (!dynamicCCSettings || Object.keys(dynamicCCSettings).length === 0)) {
      initDynamicCCSettings();
    }
  });
  randCCBtn.addEventListener("click", ()=>{
    randomizeDynamicCCSettings();
    console.log("[Nodetrix] dynamic CC settings:", dynamicCCSettings);
  });

  // ─────────────────────────────────────────────────────────────
  // Setup initial
  // ─────────────────────────────────────────────────────────────
  if(!document.body){
    console.warn("[Nodetrix] document.body not ready. Load this script after DOM is ready.");
    return;
  }

  // Actually init
  updateCanvasSize();
  initNodes(8);
  initPulses(MAX_PULSES);
  initLifeGrid();
  updatePulseAssignments();
  resetPulses();
  updateTransitionExtraControls();

  // ─────────────────────────────────────────────────────────────
  // single-frame draw
  // ─────────────────────────────────────────────────────────────
  function drawOneFrame(){
    // Visual-only single-frame redraw (used for stopped/paused editing)
    updateNodePositions();

    __nodetrixRenderEnabled = isOverlayVisible();
    if (!__nodetrixRenderEnabled) return;

    beginViewRender();
    pulses.forEach(p => p.draw());
    nodes.forEach(n => n.draw());
    endViewRender();
  }

  // ─────────────────────────────────────────────────────────────
  // 13a) Live Preview (stopped) + Auto Redraw (stopped/paused)
  // ─────────────────────────────────────────────────────────────

  let __staticRedrawRaf = 0;
  function requestStaticRedraw() {
    if (__staticRedrawRaf) return;
    __staticRedrawRaf = requestAnimationFrame(() => {
      __staticRedrawRaf = 0;
      if (playState === "running") return;
      drawOneFrame();
    });
  }

  let __previewRaf = 0;
  let __previewLastTime = performance.now();

  function stopPreviewLoop() {
    if (__previewRaf) cancelAnimationFrame(__previewRaf);
    __previewRaf = 0;
  }

  function previewTick() {
    if (!livePreviewEnabled || playState !== "stopped" || !isOverlayVisible()) {
      stopPreviewLoop();
      return;
    }

    const now = performance.now();
    const delta = (now - __previewLastTime) / 1000;
    __previewLastTime = now;

    // Visual-only: never send MIDI during preview
    __midiSuppressed = true;

    applyLFOs(delta);
    if (__drag && __drag.node) {
      // Keep the node pinned under the pointer even if morph/space/LFOs change.
      applyDragConstraint();
    }
    updateNodePositions();

    __nodetrixRenderEnabled = true;

    // Move pulses for immediate feedback, but MIDI is suppressed.
    pulses.forEach(p => p.update(delta));

    beginViewRender();
    pulses.forEach(p => p.draw());
    nodes.forEach(n => n.draw());
    endViewRender();

    __previewRaf = requestAnimationFrame(previewTick);
  }

  function maybeStartPreview() {
    if (!livePreviewEnabled) return;
    if (playState !== "stopped") return;
    if (!isOverlayVisible()) return;
    if (__previewRaf) return;
    __previewLastTime = performance.now();
    __previewRaf = requestAnimationFrame(previewTick);
  }

  // Auto-redraw whenever controls change while stopped/paused
  const controlPanelEl = document.getElementById("secretControlPanel");
  if (controlPanelEl) {
    const onUiChange = () => {
      if (playState !== "running") requestStaticRedraw();
    };
    controlPanelEl.addEventListener("input", onUiChange);
    controlPanelEl.addEventListener("change", onUiChange);
    controlPanelEl.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.tagName === "BUTTON") onUiChange();
    });
  }

  // Visibility heartbeat: if a host shows the overlay via CSS, start preview/draw automatically.
  let __lastOverlayVisible = false;
  setInterval(() => {
    const vis = isOverlayVisible();

    // Only force a redraw on the transition hidden → visible
    if (vis && !__lastOverlayVisible) {
      requestStaticRedraw();
    }

    // If visible and preview is enabled, ensure the preview loop is running
    if (vis) {
      maybeStartPreview();
    }

    // If the host changes keymap or midiBase (global slot), keep our
    // per-pulse note/channel assignments hard-synced.
    if (vis || playState === "running") {
      maybeSyncPulseMidiFromGlobal();
    }

    __lastOverlayVisible = vis;
  }, 300);


  // ─────────────────────────────────────────────────────────────
  // 12a) Startup layout fix: animate nodes out of the pile on first open
  //
  // Why: Nodetrix can be initialised while its panel is hidden (wrap is 0×0),
  // which used to collapse all nodes into a single point. Audio still works
  // (transitions are index-based), but visuals look broken until Randomize.
  //
  // Behaviour: first time the overlay becomes visible we scatter nodes to a
  // random layout *with a tween* so users don't have to hit Randomize.
  // ─────────────────────────────────────────────────────────────

  let __startupScatterDone = false;
  let __startupScatterRaf = 0;

  function __randInCanvas(margin){
    const m = (Number.isFinite(margin) ? margin : 0) || 0;
    const w = Math.max(1, canvas.width - m*2);
    const h = Math.max(1, canvas.height - m*2);
    return {
      x: m + getRandom() * w,
      y: m + getRandom() * h
    };
  }

  function animateStartupScatter(durationMs = 900){
    if(__startupScatterRaf) cancelAnimationFrame(__startupScatterRaf);

    // Only do this when we actually have a drawable canvas
    if(canvas.width < 2 || canvas.height < 2) return false;

    const margin = 24;
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.5;

    // Start all nodes at the centre (the "pile"), then tween out
    const from = nodes.map(_ => ({ x: cx, y: cy }));
    const to = nodes.map(_ => __randInCanvas(margin));

    // Collapse immediately so the first rendered frame matches the animation
    for(let i=0;i<nodes.length;i++){
      const n = nodes[i];
      if(!n) continue;
      n.morphTargetX = null;
      n.morphTargetY = null;
      n.baseX = from[i].x;
      n.baseY = from[i].y;
    }

    // Keep pulses visually attached while stopped
    if(playState === "stopped"){
      resetPulses();
    }

    const t0 = performance.now();

    function tick(now){
      const t = Math.min(1, (now - t0) / Math.max(1, durationMs));
      const e = t * t * (3 - 2*t); // smoothstep

      for(let i=0;i<nodes.length;i++){
        const n = nodes[i];
        if(!n) continue;
        n.baseX = from[i].x + (to[i].x - from[i].x) * e;
        n.baseY = from[i].y + (to[i].y - from[i].y) * e;
      }

      // Update derived coords
      updateNodePositions();

      // Pin pulses to their current nodes while stopped (so they don't "lag")
      if(playState === "stopped"){
        for(const p of pulses){
          if(!p || !p.currentNode) continue;
          p.x = p.currentNode.x;
          p.y = p.currentNode.y;
        }
      }

      // Render (only if visible)
      if(isOverlayVisible()) {
        beginViewRender();
        pulses.forEach(p => p.draw());
        nodes.forEach(n => n.draw());
        endViewRender();
      }

      if(t < 1){
        __startupScatterRaf = requestAnimationFrame(tick);
      } else {
        __startupScatterRaf = 0;
        __startupScatterDone = true;
        // Node geometry affects these caches
        try { invalidateStrategyCaches(); } catch (_) {}
      }
    }

    __startupScatterRaf = requestAnimationFrame(tick);
    return true;
  }

  function maybeRunStartupScatter(){
    if(__startupScatterDone) return false;
    if(playState === "running") return false;
    if(!isOverlayVisible()) return false;
    const started = animateStartupScatter(900);
    if(started) __startupScatterDone = true; // prevent duplicates
    return started;
  }


  // Make open function available
  window.openSecretSequencer = function(){
    updatePulseAssignments();
    overlay.style.display = "block";
    overlay.offsetHeight;
    updateCanvasSize();

    // If nodes were initialised while hidden (0×0 canvas), animate them out.
    const didScatter = maybeRunStartupScatter();

    if(playState !== "running") {
      // If we're scattering, the tween loop is already rendering frames.
      if(!didScatter) drawOneFrame();
      maybeStartPreview();
    }
  };


  // ═════════════════════════════════════════════════════════════
  // Stability + performance improvements
  // ═════════════════════════════════════════════════════════════

  // Helper: safe numeric parsing + clamping
  function toFiniteNumber(v, fallback){
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function clampNum(x, min, max){
    return Math.max(min, Math.min(max, x));
  }

  // Recompute interval anytime BPM changes; guard against 0/NaN
  const _origBpmChangeHandler = bpmInput.onchange;
  bpmInput.onchange = null;

  const handleBpmInput = (e)=>{
    globalBPM = clampNum(toFiniteNumber(e.target.value, 120), 20, 300);
    bpmInput.value = globalBPM;
    interval = 60000 / globalBPM;

    // Keep the single timing readout in-sync
    if (bpmMode) updateTimingUI();
  };
  bpmInput.addEventListener("input", handleBpmInput);
  bpmInput.addEventListener("change", handleBpmInput);

  // Ensure speed always positive
  const _origSpeedChangeHandler = speedInput.onchange;
  speedInput.onchange = null;

  const handleSpeedInput = (e)=>{
    globalSpeed = clampNum(toFiniteNumber(e.target.value, 100), 10, 2000);
    speedInput.value = Math.floor(globalSpeed);
    pulses.forEach(p=> {
      const r = (p && Number.isFinite(p.timingRatio) && p.timingRatio>0) ? p.timingRatio : 1;
      p.speed = Math.max(10, Math.min(8000, globalSpeed / r));
    });

    // Keep the single timing readout in-sync
    if (!bpmMode) updateTimingUI();
  };
  speedInput.addEventListener("input", handleSpeedInput);
  speedInput.addEventListener("change", handleSpeedInput);

  // Sync timing display on load
  updateTimingUI();

  // Safer morph/space values
  morphSlider.addEventListener("input", ()=>{
    currentMorphValue = clampNum(toFiniteNumber(morphSlider.value, 0), 0, 100);
  });
  spaceSlider.addEventListener("input", ()=>{
    currentSpaceValue = clampNum(toFiniteNumber(spaceSlider.value, 0), 0, 100);
  });

  // ── View transform to keep all nodes on-screen ─────────────────
  // Avoid relying on raw canvas size changes; auto-fit to node bounds each render.
  const __view = { scale: 1, tx: 0, ty: 0 };

  function computeNodesBounds(){
    if(nodes.length===0) return {minX:0,maxX:1,minY:0,maxY:1};
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for(const n of nodes){
      if(n.x<minX) minX=n.x;
      if(n.y<minY) minY=n.y;
      if(n.x>maxX) maxX=n.x;
      if(n.y>maxY) maxY=n.y;
    }
    return {minX,maxX,minY,maxY};
  }

  function updateViewTransform(){
    if (!autoFitEnabled) return;

    const pad = 40;
    const b = computeNodesBounds();
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxY - b.minY);
    const sx = (canvas.width - pad*2) / w;
    const sy = (canvas.height - pad*2) / h;
    const s = Math.min(sx, sy);

    // Clamp zoom so the camera doesn't "breathe" too aggressively.
    const targetScale = clampNum(s, 0.05, 2.5);

    // center bounds in canvas
    const cx = (b.minX + b.maxX)/2;
    const cy = (b.minY + b.maxY)/2;
    const targetTx = canvas.width/2 - cx*targetScale;
    const targetTy = canvas.height/2 - cy*targetScale;

    // Smooth camera motion (reduces jitter when nodes morph/space/LFO)
    const SMOOTH = 0.12;
    __view.scale = __view.scale + (targetScale - __view.scale) * SMOOTH;
    __view.tx = __view.tx + (targetTx - __view.tx) * SMOOTH;
    __view.ty = __view.ty + (targetTy - __view.ty) * SMOOTH;
  }

  // Wrap rendering with view transform
  function beginViewRender(){
    // clear in screen space
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    updateViewTransform();
    ctx.setTransform(__view.scale, 0, 0, __view.scale, __view.tx, __view.ty);
  }
  function endViewRender() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── Node dragging (pointer events) ────────────────────────────
  // Robust against:
  // - Auto-fit view transform (we freeze it while dragging)
  // - Morph/Space transforms + LFO (we solve inverse transform into base positions)
  const __drag = {
    node: null,
    pointerId: null,
    worldX: 0,
    worldY: 0,
    viewFrozen: false
  };

  function canvasToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
    const sy = (clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
    const wx = (sx - __view.tx) / __view.scale;
    const wy = (sy - __view.ty) / __view.scale;
    return { x: wx, y: wy };
  }

  function nodeHitRadius(n) {
    const baseRadius = 8;
    const connectionCount = (n.outputs && n.outputs.length) ? n.outputs.length : 0;
    // +6px pick padding for easier dragging
    return baseRadius + connectionCount * 0.5 + 6;
  }

  function pickNode(worldX, worldY) {
    // Prefer later nodes if overlapping (top-most-ish)
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = nodeHitRadius(n);
      const dx = worldX - n.x;
      const dy = worldY - n.y;
      if ((dx * dx + dy * dy) <= (r * r)) return n;
    }
    return null;
  }

  function ensureMorphTarget(n) {
    if (n.morphTargetX === null || n.morphTargetY === null) {
      const off = 300;
      n.morphTargetX = n.baseX + (getRandom() - 0.5) * off;
      n.morphTargetY = n.baseY + (getRandom() - 0.5) * off;
    }
  }

  function setNodeDesiredWorldPosition(n, desiredX, desiredY) {
    // Invert space transform first
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const s = 1 + (toFiniteNumber(currentSpaceValue, 0) / 100);
    const invS = (s !== 0) ? (1 / s) : 1;

    const morphedX = cx + (desiredX - cx) * invS;
    const morphedY = cy + (desiredY - cy) * invS;

    // Invert morph transform into baseX/baseY
    const m = clampNum((toFiniteNumber(currentMorphValue, 0) / 100), 0, 1);

    if (m <= 0) {
      n.baseX = morphedX;
      n.baseY = morphedY;
      n.morphTargetX = null;
      n.morphTargetY = null;
      return;
    }

    ensureMorphTarget(n);

    if (m >= 0.999) {
      // Full morph: position is effectively morphTarget; move both target + base by the same delta
      const dx = morphedX - n.morphTargetX;
      const dy = morphedY - n.morphTargetY;
      n.baseX += dx;
      n.baseY += dy;
      n.morphTargetX = morphedX;
      n.morphTargetY = morphedY;
      return;
    }

    const denom = 1 - m;
    n.baseX = (morphedX - n.morphTargetX * m) / denom;
    n.baseY = (morphedY - n.morphTargetY * m) / denom;
  }

  function applyDragConstraint() {
    const n = __drag.node;
    if (!n) return;
    setNodeDesiredWorldPosition(n, __drag.worldX, __drag.worldY);
  }

  // Freeze auto-fit view while dragging (prevents jitter)
  let __viewFrozen = false;
  const _origUpdateViewTransform = updateViewTransform;
  updateViewTransform = function() {
    if (__viewFrozen) return;
    _origUpdateViewTransform();
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!isOverlayVisible()) return;

    // Ensure view/node positions are up-to-date for accurate picking
    updateNodePositions();
    _origUpdateViewTransform();

    const p = canvasToWorld(e.clientX, e.clientY);
    const hit = pickNode(p.x, p.y);
    if (!hit) return;

    __drag.node = hit;
    __drag.pointerId = e.pointerId;
    __drag.worldX = p.x;
    __drag.worldY = p.y;

    __viewFrozen = true;
    canvas.classList.add("dragging");
    try { canvas.setPointerCapture(e.pointerId); } catch(_){}

    // Ensure morph targets exist so inversion is stable while morph>0
    if (currentMorphValue > 0) ensureMorphTarget(hit);

    // Immediate apply so it feels responsive even if not running
    applyDragConstraint();
    updateNodePositions();
    if (playState !== "running") requestStaticRedraw();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!__drag.node) return;
    if (__drag.pointerId !== null && e.pointerId !== __drag.pointerId) return;

    const p = canvasToWorld(e.clientX, e.clientY);
    __drag.worldX = p.x;
    __drag.worldY = p.y;

    applyDragConstraint();
    updateNodePositions();

    if (playState !== "running") requestStaticRedraw();
  });

  function endDrag(e) {
    if (!__drag.node) return;
    if (e && __drag.pointerId !== null && e.pointerId !== __drag.pointerId) return;

    __drag.node = null;
    __drag.pointerId = null;

    __viewFrozen = false;
    canvas.classList.remove("dragging");

    // Strategy caches may depend on geometry (hilbert, etc.)
    invalidateStrategyCaches();

    if (playState !== "running") requestStaticRedraw();
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", (e) => {
    // If pointer is captured, we'll still get move/up; otherwise end it gracefully.
    const pid = __drag.pointerId;
    const canCheck = (typeof canvas.hasPointerCapture === "function");
    const hasCap = (canCheck && pid != null) ? canvas.hasPointerCapture(pid) : false;
    if (!hasCap) endDrag(e);
  });

  function invalidateStrategyCaches() {
    // Spatial / path caches
    hilbertNodes = [];
    hilbertIndex = 0;

    // Chaos points depend on node positions
    chaosPoints.length = 0;
    chaosIndex = 0;

    // Wolfram depends on node count
    wolframState.length = 0;
    wolframNext.length = 0;
    wolframLastStepBucket = -1;

    // Per-pulse Wolfram caches
    wolframPulseStates = [];
    wolframPulseNext = [];
  }

  // ── Canvas resize: clamp + debounce + cache invalidation ──────

  const _origUpdateCanvasSize = updateCanvasSize;
  updateCanvasSize = function(){
    _origUpdateCanvasSize();
    // After resize, keep nodes inside bounds (in base coords), then invalidate caches.
    clampNodesToCanvas();
    invalidateStrategyCaches();
    // Also ensure pulse positions are valid
    repairPulses();
  };

  function clampNodesToCanvas(){
    const margin = 20;
    for(const n of nodes){
      // clamp base coords to canvas bounds
      n.baseX = clampNum(n.baseX, margin, canvas.width - margin);
      n.baseY = clampNum(n.baseY, margin, canvas.height - margin);
      // reset any morphTarget that may be off-screen
      if(n.morphTargetX !== null){
        n.morphTargetX = clampNum(n.morphTargetX, margin, canvas.width - margin);
        n.morphTargetY = clampNum(n.morphTargetY, margin, canvas.height - margin);
      }
    }
    updateNodePositions();
  }

  function repairPulses(){
    const safeNode0 = nodes[0] || null;
    for(const p of pulses){
      if(!p.currentNode || !nodes[p.currentNode.id]) p.currentNode = safeNode0;
      if(!p.targetNode || !nodes[p.targetNode.id]) p.targetNode = safeNode0;
      if(p.currentNode){
        p.x = p.currentNode.x;
        p.y = p.currentNode.y;
      }
    }
  }

  // Ensure node add/remove randomize resets caches + repairs pulses
  const _origAddNode = addNode;
  addNode = function(){
    _origAddNode();
    invalidateStrategyCaches();
    repairPulses();
  };
  const _origRemoveNode = removeNode;
  removeNode = function(){
    _origRemoveNode();
    invalidateStrategyCaches();
    repairPulses();
  };

  // Ensure randomize/reset nodes invalidates caches
  const _origRandomizeNodes = randomizeNodes;
  randomizeNodes = function(){
    _origRandomizeNodes();
    invalidateStrategyCaches();
  };
  const _origResetNodes = resetNodes;
  resetNodes = function(){
    _origResetNodes();
    invalidateStrategyCaches();
  };

  // ── Wolfram: prevent reinit loops; init once per node count ────
  const _origStepWolfram = stepWolfram;
  stepWolfram = function(ncount){
    // if state length mismatch, init once
    if(wolframState.length !== ncount){
      wolframState = new Array(ncount).fill(0);
      wolframNext = new Array(ncount).fill(0);
      // random init
      wolframState[Math.floor(getRandom()*ncount)] = 1;
    }
    // proceed with original bit update
    for(let i=0;i<ncount;i++){
      let left = wolframState[(i-1+ncount)%ncount];
      let center= wolframState[i];
      let right = wolframState[(i+1)%ncount];
      let pattern = (left<<2)|(center<<1)|right;
      let bit = (wolframRule >> pattern) & 1;
      wolframNext[i] = bit;
    }
    // swap
    let tmp = wolframState;
    wolframState = wolframNext;
    wolframNext = tmp;
  };

  // ── Life: clamp rows/cols; avoid huge grids ────────────────────
  const _origInitLifeGrid = initLifeGrid;
  initLifeGrid = function(){
    lifeRows = clampNum(lifeRows, 2, 64);
    lifeCols = clampNum(lifeCols, 2, 64);
    _origInitLifeGrid();
  };

  // ── Seeded uniform: stable seed parsing ────────────────────────
  function setSeededUniformSeed(v){
    const n = Math.floor(toFiniteNumber(v, 1));
    seededUniformSeedBase = clampNum(n, 1, 2147483646);
    restartSeededUniformSequence();
  }

  // When randomize selects seededUniform, keep the seed UI in sync
  const _origRandomizeSequencer = randomizeSequencer;
  randomizeSequencer = function(){
    _origRandomizeSequencer();
    if(currentTransitionMode === "seededUniform"){
      if(typeof seededUniformSeedInput !== "undefined" && seededUniformSeedInput){
        seededUniformSeedInput.value = seededUniformSeedBase;
      }
    }
  };

  // ── Transition strategy guards: never return undefined ─────────
  function withGuards(fn){
    return function(cur, arr, pulse){
      if(!arr || arr.length===0) return null;
      let out = fn(cur, arr, pulse);
      if(!out) out = arr[0];
      return out;
    };
  }
  // Wrap all strategies
  Object.keys(transitionStrategies).forEach(key=>{
    transitionStrategies[key] = withGuards(transitionStrategies[key]);
  });

  // ── Improve weighted strategy to avoid zero-sum issues ─────────
  transitionStrategies.weighted = withGuards((cur, arr, pulse)=>{
    if(!cur) return arr[0];
    const len = arr.length;
    if(len <= 1) return arr[0];

    const bias = (weightedBias === "near") ? "near" : "far";
    const exponent = clampFloat(weightedExponent, 0.01, 20, 1.0);
    const minRatio = clampFloat(weightedMinDistRatio, 0, 1, 0.0);
    const excludeSelf = !!weightedExcludeSelf;

    const eps = 1e-6;
    let maxD = 0;
    const ds = new Array(len);

    for(let i=0;i<len;i++){
      const n = arr[i];
      if(!n){ ds[i] = 0; continue; }
      const dx = n.x - cur.x;
      const dy = n.y - cur.y;
      const d = Math.sqrt(dx*dx + dy*dy);
      ds[i] = d;
      if(d > maxD) maxD = d;
    }

    let indices = [];
    for(let i=0;i<len;i++){
      if(excludeSelf && arr[i] === cur) continue;
      if(minRatio > 0 && maxD > 0 && ds[i] < maxD * minRatio) continue;
      indices.push(i);
    }

    // If filters eliminate everything, relax the distance filter
    if(indices.length === 0){
      for(let i=0;i<len;i++){
        if(excludeSelf && arr[i] === cur) continue;
        indices.push(i);
      }
    }
    if(indices.length === 0) return arr[0];

    const weights = indices.map(i=>{
      const d = ds[i] + eps;
      const base = (bias === "near") ? (1 / d) : d;
      return Math.pow(base, exponent);
    });

    const wi = pickWeightedIndex(weights);
    if(wi >= 0) return arr[indices[wi]];
    return arr[indices[Math.floor(getRandom() * indices.length)]];
  });

  // ── Improve sequential strategy to skip self loops if possible ─
  transitionStrategies.sequential = withGuards((cur, arr)=>{
    if(!cur) return arr[0];
    const len = arr.length;
    if(len <= 1) return arr[0];

    const step = clampInt(sequentialStep, 1, 64, 1);
    const dir = (sequentialDirection === -1) ? -1 : 1;

    let nextId = wrapIndex(cur.id + dir * step, len);

    if(sequentialSkipRoot && len > 1 && nextId === 0){
      nextId = wrapIndex(nextId + dir, len);
    }

    if(arr.length > 1 && nextId === cur.id){
      nextId = wrapIndex(nextId + dir, len);
      if(sequentialSkipRoot && nextId === 0){
        nextId = wrapIndex(nextId + dir, len);
      }
    }

    return arr[nextId];
  });

  // ── Life rule parsing: handle invalid text gracefully ──────────
  const _origParseLifeRule = parseLifeRule;
  parseLifeRule = function(str){
    try{
      let rule = _origParseLifeRule(str);
      // ensure arrays are numeric
      rule.birth = (rule.birth||[]).filter(Number.isFinite);
      rule.survive = (rule.survive||[]).filter(Number.isFinite);
      return rule;
    } catch(e){
      return {birth:[3], survive:[2,3]};
    }
  };

  // ── Chaos: rebuild points if node count changes ────────────────
  const _origBuildChaosPoints = buildChaosPoints;
  buildChaosPoints = function(arr){
    chaosPoints.length = 0;
    chaosIndex = 0;
    _origBuildChaosPoints(arr);
  };

  // ── Hilbert: rebuild if geometry changes ───────────────────────
  const _origBuildHilbert = buildHilbert;
  buildHilbert = function(arr){
    _origBuildHilbert(arr);
  };

  // ── Add a master "render enabled" flag (skip draw if hidden) ───
  // If host toggles overlay via CSS, we use computed style.
  let __nodetrixRenderEnabled = true;

  // ── MIDI safety: add master toggle via existing UI insertion ───
  // Here we just gate sendMidiNote; dynamic CC is already gated.
  const _origSendMidiNote = sendMidiNote;
  sendMidiNote = function(pulse) {
    if (!window.selectedMidiOut) return;
    if (__midiSuppressed) return;
    if (!pulseShouldSound(pulse)) return;
    _origSendMidiNote(pulse);
  };

  // ── Animate: use view transform & skip draw when hidden ─────────
  const _origAnimate = animate;
  animate = function() {
    if (playState !== "running") return;

    // Transport running: allow MIDI (still gated by the master MIDI toggle)
    __midiSuppressed = false;

    const now = performance.now();
    const delta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    applyLFOs(delta);

    // If dragging, keep the node pinned under the pointer even as morph/space/LFO change.
    if (__drag && __drag.node) {
      applyDragConstraint();
    }

    updateNodePositions();

    __nodetrixRenderEnabled = isOverlayVisible();

    pulses.forEach(p => p.update(delta));

    if (__nodetrixRenderEnabled) {
      beginViewRender();
      pulses.forEach(p => p.draw());
      nodes.forEach(n => n.draw());
      endViewRender();
    }

    if (bpmMode && scheduledPulse && (now - lastPulseTime >= interval)) {
      addPulseImmediate();
      scheduledPulse = false;
      lastPulseTime = now;
    }
    animationFrameId = requestAnimationFrame(animate);
  };

  // ── Pulse trail perf: avoid filter allocations ────────────────

  const _origPulseUpdate = Pulse.prototype.update;
  Pulse.prototype.update = function(delta) {
    if (!this.enabled) return;

    // Preserve any existing trail; the original implementation clears trails when showTrails=false.
    const prevTrail = this.trail;
    const prevTrailHead = this.trailHead || 0;

    // Temporarily force showTrails on during update so we can manage our own.
    const prevShow = showTrails;
    showTrails = true;
    _origPulseUpdate.call(this, delta);
    showTrails = prevShow;

    // Restore trail if original tried to reset it
    if (!prevShow) {
      this.trail = prevTrail;
      this.trailHead = prevTrailHead;
    }

    // Cap trail without shift cost: ring buffer style
    if (!this.trailHead) this.trailHead = 0;
    if (this.trail.length > this.trailMax) {
      const excess = this.trail.length - this.trailMax;
      this.trailHead = (this.trailHead + excess) % this.trail.length;
    }
  };

  const _origPulseDraw = Pulse.prototype.draw;
  Pulse.prototype.draw = function() {
    if (!this.enabled) return;

    const scale = (typeof __view !== "undefined" && __view && __view.scale) ? __view.scale : 1;

    // Visual dimming follows mute/solo rules (MIDI is separately gated)
    const sounding = pulseShouldSound(this);
    const alpha = sounding ? 1 : 0.25;

    // Draw a faint line for the *current hop* (helps show "what's connected" in motion)
    if (showPulseLinks && this.currentNode && this.targetNode && (this.currentNode !== this.targetNode)) {
      ctx.strokeStyle = rgbaFromHex(this.color || "cyan", sounding ? 0.18 : 0.07);
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      ctx.moveTo(this.currentNode.x, this.currentNode.y);
      ctx.lineTo(this.targetNode.x, this.targetNode.y);
      ctx.stroke();
    }

    // Trail: draw with ring-buffer awareness
    if (showTrails && this.trail && this.trail.length > 1) {
      ctx.strokeStyle = rgbaFromHex(this.color || "cyan", sounding ? 0.35 : 0.12);
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      const len = this.trail.length;
      const head = this.trailHead || 0;
      // iterate in logical order
      for (let i=0; i<len; i++){
        const idx = (head + i) % len;
        const pt = this.trail[idx];
        if (i===0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }

    // Pulse circle (screen-consistent size)
    const r = 6 / scale;
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, 2*Math.PI);
    ctx.fillStyle = rgbaFromHex(this.color || "cyan", alpha);
    ctx.fill();

    // Solo highlight / muted outline
    if (this.soloed) {
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
    } else if (this.muted) {
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.stroke();
    }
  };

  // ── Fix: randomSubset should be seeded-ish for consistency ─────
  // Use getRandom instead of Math.random
  randomSubset = function(arr){
    return arr.filter(() => getRandom() < 0.5).sort((a,b)=>a-b);
  };

  // ── Ensure chaos rebuild on node randomize/reset ───────────────
  const _origRandNodesBtn = randNodesBtn.onclick;
  randNodesBtn.onclick = null;
  randNodesBtn.addEventListener("click", ()=>{
    randomizeNodes();
    if(currentTransitionMode === "chaos"){
      chaosPoints.length = 0;
      buildChaosPoints(nodes);
    }
    if(playState !== "running") drawOneFrame();
  });
  const _origResetNodesBtn = resetNodesBtn.onclick;
  resetNodesBtn.onclick = null;
  resetNodesBtn.addEventListener("click", ()=>{
    resetNodes();
    if(currentTransitionMode === "chaos"){
      chaosPoints.length = 0;
      buildChaosPoints(nodes);
    }
    if(playState !== "running") drawOneFrame();
  });

  // ── Ensure Hilbert rebuild when selected and nodes changed ─────
  function maybeRebuildHilbert(){
    if(currentTransitionMode === "hilbert"){
      buildHilbert(nodes);
    }
  }

  // Hook node mutation buttons
  addNodeBtn.addEventListener("click", maybeRebuildHilbert);
  removeNodeBtn.addEventListener("click", maybeRebuildHilbert);

  // ── Guard against missing ctx/canvas
  if(!canvas || !ctx){
    console.error("[Nodetrix] Canvas context not available.");
  }

  // ═════════════════════════════════════════════════════════════
  // End stability/performance section
  // ═════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────
  // Optional: auto-show in embedded mode
  // ─────────────────────────────────────────────────────────────
  if(embedded){
    overlay.style.display = "block";
    updateCanvasSize();
    drawOneFrame();
  }

  // If any user wants to show special overlay for Euclid or something,
  // we can keep hooking into window events:
  // window.addEventListener("someEvent", ()=>{...});

  // (Example: re-check some global state, if needed)
  window.addEventListener("message", (evt)=>{
    // do something on message
    if(evt && evt.data) {
      // example
      if(evt.data === "openNodetrix"){
        window.openSecretSequencer();
      }
      if(evt.data === "closeNodetrix"){
        exitSequencer();
      }
      // if there's a special "euclid" overlay:
      if(evt.data === "showEuclid") {
        if(typeof showEuclidOverlay === "function"){
          showEuclidOverlay();
        }
      }
    }
  });

})();
