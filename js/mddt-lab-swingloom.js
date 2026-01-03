/**
 * mddt-lab-swingloom.js — SwingLoom (BPMLom) lab module for MDDT.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root || globalThis);
  } else {
    const mod = factory(root || globalThis);
    const registrar =
      (root && root.MDDT && typeof root.MDDT.registerLabModule === 'function' && root.MDDT.registerLabModule) ||
      (root && root.registerLabModule);
    if (registrar) {
      registrar({
        id: 'swingloom',
        title: 'BPMLom',
        mount: (el) => mod.mount(el),
        api: mod.api
      });
    }
    root.SwingLoom = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────────
  // Adapter (host hooks) — commit + pattern length lookup
  // ────────────────────────────────────────────────────────────────────────────
  function detectAdapter() {
    const g = global || {};
    const adapter = {
      commitSongSlot: (slot, songObj) => {
        const commit =
          (g.MDDT && g.MDDT.commitSongSlot) ||
          g.commitSongSlot ||
          null;
        if (typeof commit === 'function') {
          try { commit(slot, songObj); return true; } catch (_) {}
        }
        try {
          if (g.allSongSlots) g.allSongSlots[slot] = structuredClone(songObj);
          if (g.currentSong && g.selectedSongSlotIndex === slot) {
            g.currentSong = structuredClone(songObj);
          }
          if (typeof g.fillSongUI === 'function') g.fillSongUI();
          if (typeof g.updatePanelHeaderColors === 'function') g.updatePanelHeaderColors();
          return true;
        } catch (_) {}
        return false;
      },
      getPatternLength: (pIndex) => {
        const mk = (global && global.mdModel) || 'MKII';
        const fallback = (mk === 'MKI') ? 32 : 64;
        try {
          const slot = global.allPatternSlots && global.allPatternSlots[pIndex];
          const L = slot && slot.pattern && slot.pattern.length;
          return (L && L >= 2 && L <= 64) ? L : fallback;
        } catch (_) { return fallback; }
      }
    };
    return adapter;
  }
  const adapter = detectAdapter();

  // ────────────────────────────────────────────────────────────────────────────
  // Utils
  // ────────────────────────────────────────────────────────────────────────────
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const randOf = (arr) => arr[(Math.random() * arr.length) | 0];
  const lenInc = (r) => (r.endRow|0) - (r.startRow|0) + 1;

  function patternLabelToIndex(label) {
    if (typeof label !== 'string') return 0;
    const m = label.trim().toUpperCase().match(/^([A-H])\s*0*([1-9]|1[0-6])$/);
    if (!m) return 0;
    const bank = m[1].charCodeAt(0) - 65;
    const num = parseInt(m[2], 10);
    return bank * 16 + (num - 1);
  }
  function patternIndexToLabel(index) {
    const b = clamp(Math.floor(index / 16), 0, 7);
    const n = clamp((index % 16) + 1, 1, 16);
    return String.fromCharCode(65 + b) + String(n).padStart(2, '0');
  }

function bpmToRaw24(bpm) {
    if (bpm == null || isNaN(bpm)) return { hi: 0xFF, lo: 0xFF };
    const ticks = Math.round((bpm - 30) * 24);
    const raw = 720 + ticks;
    const hi = (raw >> 8) & 0xFF, lo = raw & 0xFF;
    return { hi, lo };
  }

  function easeMap(t, type) {
    t = clamp(t, 0, 1);
    switch (type) {
      case 'ease-in':       return t * t;
      case 'ease-out':      return 1 - (1 - t) * (1 - t);
      case 'ease-in-out':   return (t < 0.5) ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;
      case 's-curve':       return 3*t*t - 2*t*t*t;
      case 'power2':        return Math.pow(t, 2);
      case 'power3':        return Math.pow(t, 3);
      case 'exp':           return (Math.exp(4*t) - 1) / (Math.exp(4) - 1);
      case 'log':           return Math.log(1 + 9*t) / Math.log(10);
      case 'triangle':      return t < 0.5 ? (t*2) : (2 - 2*t);
      default:              return t;
    }
  }
  function sineMap(t, cycles, phase = 0) {
    const y = 0.5 + 0.5 * Math.sin(2*Math.PI*(t*cycles + phase));
    return clamp(y, 0, 1);
  }
  function stairsMap(t, steps) {
    steps = Math.max(1, steps|0);
    const k = Math.floor(t * steps);
    return clamp(k / steps, 0, 1);
  }
  function fract(x) { return x - Math.floor(x); }
  function triWave(x) { return x < 0.5 ? (x*2) : (2 - 2*x); } // 0→1→0 over x∈[0,1]

  // Deterministic RNG (LCG)
  function lcg(seed) {
    let s = (seed >>> 0) || 0x12345678;
    return function next() {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  // 1D Perlin with deterministic seed
  function makePerlin1D(seed=12345) {
    const rng = lcg(seed|0);
    const perm = new Uint8Array(512);
    // init permutation
    for (let i=0;i<256;i++) perm[i] = i;
    for (let i=255;i>0;i--) { const j=(rng()* (i+1))|0; const t=perm[i]; perm[i]=perm[j]; perm[j]=t; }
    for (let i=0;i<256;i++) perm[256+i]=perm[i];
    const grad = (h,x)=> ((h&1)?-x:x);
    const fade = t=> t*t*t*(t*(t*6-15)+10);
    const lerp = (a,b,t)=> a + t*(b-a);
    return function perlin(x) {
      const X = Math.floor(x) & 255;
      const fx = x - Math.floor(x);
      const u = fade(fx);
      const a = perm[X], b = perm[X+1];
      const g0 = grad(perm[a], fx);
      const g1 = grad(perm[b], fx-1);
      return (lerp(g0, g1, u) + 1) * 0.5; // map to [0,1]
    };
  }

  // regions → per‑row BPM/OF/LEN and region reference
  function makeBpmFromRegions(regions, totalRows) {
    const list = (regions || []).slice().map(r => ({
      startRow: clamp(r.startRow|0, 1, totalRows),
      endRow:   clamp(r.endRow|0,   1, totalRows),
      startBpm: clamp(+r.startBpm || 120, 30, 300),
      endBpm:   clamp(+r.endBpm   || 120, 30, 300),
      curve:    r.curve || 'linear',
      steps:    r.steps|0,
      cycles:   r.cycles || 1,
      phase:    r.phase || 0,
      offset:   clamp(r.offset|0, 0, 63),
      length:   clamp(r.length|0, 2, 64),
      name:     r.name || '',
      patternIndex: clamp(r.patternIndex|0, 0, 127),
      drawBpm:  Array.isArray(r.drawBpm) ? r.drawBpm.slice() : null,
      __seed:   (r.seed != null ? r.seed|0 :
                 ((r.startRow|0)*73856093) ^ ((r.endRow|0)*19349663) ^ ((r.startBpm|0)*83492791) ^ ((r.endBpm|0)*2654435761))
    })).sort((a,b) => a.startRow - b.startRow);

    function jitterOffset(R, rowWithin, span) {
      const amp = clamp(Math.abs(R.phase || 0.1), 0.01, 1.0);
      const rate = Math.max(1, Math.round(R.cycles || 16)); // "roughness"
      const steps = rowWithin * rate;
      const rng = lcg(R.__seed);
      let off = 0;
      const stepMag = (amp / Math.max(1, span)) * 2.0;
      for (let i = 0; i < steps; i++) {
        const step = (rng() - 0.5) * 2 * stepMag;
        off += step;
        if (off > amp) off = amp;
        if (off < -amp) off = -amp;
      }
      return off;
    }

    const perlinCache = {};
    function getPerlin(seed) {
      if (!perlinCache[seed]) perlinCache[seed] = makePerlin1D(seed);
      return perlinCache[seed];
    }

    return function bpmAtRow(i) {
      const row1 = i + 1;
      let R = null;
      for (let k = 0; k < list.length; k++) {
        const r = list[k];
        if (row1 >= r.startRow && row1 <= r.endRow) R = r;
      }
      if (!R) return { bpm: null, of: null, len: null, region: null };
      const span = Math.max(1, (R.endRow - R.startRow));
      const t0 = (row1 - R.startRow) / span;
      const rowWithin = (row1 - R.startRow) | 0;

      // Drawn curve overrides everything; use absolute BPM directly
      if (R.curve === 'drawn' && Array.isArray(R.drawBpm)) {
        const idx = Math.min(Math.max(0, rowWithin), R.drawBpm.length - 1);
        const direct = R.drawBpm[idx];
        const bpmAbs = (direct == null) ? Math.round(R.startBpm + (R.endBpm - R.startBpm) * t0) : direct|0;
        return { bpm: clamp(bpmAbs, 30, 300), of: R.offset, len: R.length, region: R };
      }

      let y;
      switch (R.curve) {
        case 'linear':
        case 'ease-in':
        case 'ease-out':
        case 'ease-in-out':
        case 's-curve':
        case 'power2':
        case 'power3':
        case 'exp':
        case 'log':
        case 'triangle':
          y = easeMap(t0, R.curve); break;
        case 'stairs':
          y = stairsMap(t0, Math.max(1, R.steps||8)); break;
        case 'sine':
          y = sineMap(t0, R.cycles || 1, R.phase || 0); break;
        case 'alt': {
          const block = Math.max(1, (R.steps || 1)|0);
          const toggler = (Math.floor(rowWithin / block) % 2) ? 1 : 0;
          y = toggler;
          break;
        }
        case 'alt-fade': {
          const block = Math.max(1, (R.steps || 1)|0);
          const toggler = (Math.floor(rowWithin / block) % 2) ? 1 : 0;
          const gamma = Math.max(0.1, Math.abs(R.phase || 1));
          const base = ( (R.phase || 1) >= 0 ) ? (1 - t0) : t0;
          const amp  = Math.pow(base, gamma);
          y = toggler ? amp : 0;
          break;
        }
        case 'saw': {
          const cyc = Math.max(0.1, R.cycles || 1);
          y = fract(t0 * cyc);
          break;
        }
        case 'pingpong': {
          const cyc = Math.max(0.1, R.cycles || 1);
          y = triWave(fract(t0 * cyc));
          break;
        }
        case 'pulse': {
          const period = Math.max(1, (R.steps || 8)|0);
          const duty = clamp((R.phase == null ? 0.5 : R.phase), 0, 1);
          const pos = rowWithin % period;
          const on = pos < Math.max(1, Math.round(duty * period));
          y = on ? 1 : 0;
          break;
        }
        case 'jitter': {
          const base = t0;
          const off = jitterOffset(R, rowWithin, span);
          y = clamp(base + off, 0, 1);
          break;
        }
        case 'perlin': {
          const scale = Math.max(1, Math.min(5, (R.steps||16))); // cap at 5
          const seed = (R.__seed|0) ^ 0x9E3779B9 ^ ((R.phase*1e6)|0);
          const P = getPerlin(seed);
          y = P(rowWithin/scale);
          break;
        }
        case 'chaos': {
          const scale = Math.max(1, Math.min(5, (R.steps||16))); // cap at 5
          const octs  = Math.max(1, Math.min(5, (R.cycles||3)|0)); // cap at 5
          const ampRaw = (R.phase==null?0.4:R.phase);
          const amp    = clamp(Math.abs(ampRaw), 0.01, 1.0);
          const inv    = ampRaw < 0; // negative flips
          const seed  = (R.__seed|0) ^ 0x85EBCA77;
          const P = getPerlin(seed);
          let f=1, a=1, sum=0, norm=0;
          for (let o=0;o<octs;o++) {
            sum  += a * P((rowWithin)/(scale/f));
            norm += a;
            f *= 2; a *= 0.5;
          }
          const n = clamp(sum/(norm||1), 0, 1);
          const n2 = inv ? (1 - n) : n;
          const base = t0;
          y = clamp(base*(1-amp) + n2*amp, 0, 1);
          break;
        }
        default:
          y = easeMap(t0, 'linear');
      }
      const bpm = Math.round(R.startBpm + (R.endBpm - R.startBpm) * y);
      return { bpm, of: R.offset, len: R.length, region: R };
    };
  }

  function makeEmptyRow10() { return new Array(10).fill(0); }

  // Compose with per‑region Pattern + early END
  function composeSong(cfg, bpmProgram, loops, host = adapter) {
    const totalRows = clamp(cfg.totalRows|0, 1, 256);

    // Figure out last active row covered by regions
    let lastActive = -1;
    if (bpmProgram) {
      for (let i = 0; i < totalRows; i++) {
        const res = bpmProgram(i);
        if (res && res.region) lastActive = i;
      }
    }
    const rowsToEmit = Math.max(0, lastActive + 1);

    const song = {
      slotIndex: clamp(cfg.songSlot|0, 0, 31),
      version: 2, revision: 2,
      name: (cfg.name || `SWL-BPM-${String((cfg.songSlot|0)+1).padStart(2,'0')}`).slice(0,16),
      rows: []
    };

    for (let i = 0; i < rowsToEmit; i++) {
      const r = makeEmptyRow10();

      // region‑pattern per row; fallback to cfg.patternIndex if provided, else 0
      let patIndex = 0;
      let of = 0, len = 64;
      let bpm = null;

      if (bpmProgram) {
        const res = bpmProgram(i);
        if (res) {
          bpm = res.bpm;
          if (res.of != null) of = clamp(res.of, 0, 63);
          if (res.len != null) len = clamp(res.len, 2, 64);
          if (res.region && typeof res.region.patternIndex === 'number') {
            patIndex = clamp(res.region.patternIndex|0, 0, 127);
          } else if (typeof cfg.patternIndex === 'number') {
            patIndex = clamp(cfg.patternIndex|0, 0, 127);
          }
        }
      }

      const patLen = host.getPatternLength ? host.getPatternLength(patIndex) : 64;
      r[0] = patIndex & 0x7F;

      // repeats fixed to 1 (encode as 0)
      r[2] = 0;

      // OF/LEN clamped against selected pattern’s length
      r[8] = clamp(of, 0, Math.max(0, patLen - 2)) & 0x7F;
      r[9] = clamp(len, 2, patLen - r[8]) & 0x7F;

      if (bpm == null || isNaN(bpm)) { r[6] = 0xFF; r[7] = 0xFF; }
      else {
        const { hi, lo } = bpmToRaw24(bpm);
        r[6] = hi & 0xFF; r[7] = lo & 0xFF;
      }

      // mutes
      r[4] = 0; r[5] = 0;
      song.rows.push({ data: r });
    }

    // Insert loops (if any) respecting current song length
    const loopList = (loops||[]).slice().sort((a,b)=> (a.atRow|0) - (b.atRow|0));
    let inserted = 0;
    for (const L of loopList) {
      if (rowsToEmit <= 0) break;
      const at0  = clamp((L.atRow|0) - 1, 0, Math.max(0, song.rows.length - 1 + inserted));
      const tgt0 = clamp((L.targetRow|0) - 1, 0, Math.max(0, song.rows.length - 1 + inserted));
      const times = clamp(L.times == null ? 0 : (L.times|0), 0, 63);
      const row = makeEmptyRow10();
      row[0] = 0xFE;          // special
      row[2] = times & 0x7F;  // times
      row[3] = tgt0 & 0x7F;   // target
      row[6] = 0xFF; row[7] = 0xFF;
      const insIndex = Math.min(at0 + inserted + 1, song.rows.length);
      song.rows.splice(insIndex, 0, { data: row });
      inserted++;
    }

    // Always terminate with END (even if rowsToEmit === 0)
    const end = makeEmptyRow10(); end[0] = 0xFF; song.rows.push({ data: end });
    return song;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Importer: SongObj -> regions[] + loops[]
  // ────────────────────────────────────────────────────────────────────────────
  function raw24ToBpm(hi, lo) {
    if ((hi===0xFF && lo===0xFF) || (hi===0 && lo===0)) return null;
    const raw = (((hi & 0xFF) << 8) | (lo & 0xFF)) >>> 0;
    if (raw < 720 || raw > 7200) return null;
    return 30 + Math.round((raw - 720) / 24);
  }
  function songToRegionsAndLoops(song, totalRows, getPatLen) {
    const regs = [];
    const lps  = [];
    const rows = (song && song.rows) || [];
    const patLenOf = (pIdx) => {
      try { return getPatLen ? getPatLen(pIdx|0) : 64; } catch (_) { return 64; }
    };

    let run = null;
    function flushRun() {
      if (!run) return;
      const start = run.startRow, end = run.endRow;
      const first = run.bpm[0], last = run.bpm[run.bpm.length-1];
      const monoUp   = run.bpm.every((v,i,arr)=> i===0 || v>=arr[i-1]);
      const monoDown = run.bpm.every((v,i,arr)=> i===0 || v<=arr[i-1]);
      const constant = run.bpm.every(v=>v===first);
      const curve = constant ? 'linear' : ((monoUp||monoDown) ? 'linear' : 'stairs');
      const r = {
        name: `R${regs.length+1}`,
        startRow: start, endRow: end,
        startBpm: first, endBpm: last,
        curve,
        offset: run.of, length: run.len,
        steps: 8, cycles: 1, phase: 0,
        patternIndex: run.pat
      };
      regs.push(r);
      run = null;
    }

    for (let i = 0, rr=1; i < rows.length && rr<=totalRows; i++, rr++) {
      const d = rows[i].data || [];
      const patRaw = d[0] & 0xFF;
      if (patRaw === 0xFF) break;                 // END
      if (patRaw === 0xFE) {                      // SPECIAL
        const target = d[3] & 0xFF;
        const kind = (target < i) ? 'loop' : (target === i ? 'halt' : 'jump');
        lps.push({ kind, atRow: (i+1), targetRow: (target|0)+1, times: d[2] & 0x7F });
        continue;
      }
      const bpm = raw24ToBpm(d[6], d[7]);         // may be null
      if (bpm == null) { flushRun(); continue; }
      const of  = d[8] & 0x7F;
      const lenEnc = d[9] & 0x7F;
      const pIdx   = patRaw & 0x7F;
      const pMax   = patLenOf(pIdx);
      const len = Math.max(2, Math.min(pMax - of, lenEnc));

      if (!run) {
        run = { startRow: rr, endRow: rr, bpm:[bpm], of, len, pat: pIdx };
      } else {
        const contiguous = (of===run.of && len===run.len && pIdx===run.pat);
        if (!contiguous) { flushRun(); run = { startRow: rr, endRow: rr, bpm:[bpm], of, len, pat: pIdx }; }
        else { run.endRow = rr; run.bpm.push(bpm); }
      }
    }
    flushRun();
    return { regions: regs, loops: lps };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // UI
  // ────────────────────────────────────────────────────────────────────────────
  function createEl(tag, attrs={}, parent) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    });
    if (parent) parent.appendChild(el);
    return el;
  }

  function mount(container) {
    const host = adapter;
    const cont = container || document.body;
    // The Lab host expects modules to be self-contained. Clear mount node first.
    try { cont.innerHTML = ''; } catch (_) {}
    const wrap = createEl('div', { class: 'slbpm' });

    const css = createEl('style', {}, wrap);
    css.textContent = `
      /*
        SwingLoom UI styling
        - Use the app's CSS variables so this module matches the rest of MDDT.
        - Keep this CSS self-contained (module-scoped classnames).
      */
      .slbpm {
        display: grid;
        grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        font-size: 13px;
        line-height: 1.4;
      }

      .sl-card {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px;
        background: var(--panel-2);
        min-width: 0;
      }

      .sl-card h3 {
        margin: 0 0 10px;
        text-align: center;
        font-size: 14px;
        letter-spacing: 0.2px;
      }

      .sl-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin: 6px 0;
        min-width: 0;
      }

      .sl-row > label {
        width: 140px;
        font-weight: 650;
        color: var(--fg);
      }

      .sl-input { flex: 1; min-width: 0; }
      .sl-mini  { width: 92px; }

/* Basics card: compact vertical controls (gives Regions more width) */
.sl-basics .sl-row {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
.sl-basics .sl-row > label {
  width: auto;
  margin: 0;
}
.sl-basics input,
.sl-basics button {
  width: 100%;
}
.sl-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.sl-status {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  font-size: 11px;
  line-height: 1.35;
  color: var(--muted);
  min-height: 18px;
}

/* Horizontal scroll safety for wide tables (prevents right-edge overflow) */
.sl-table-wrap {
  overflow-x: auto;
  max-width: 100%;
}

      /* Table */
      .sl-table {
        width: 100%;
        border-collapse: collapse;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        line-height: 1.35;
      }

      .sl-table th, .sl-table td {
        border-bottom: 1px solid var(--border);
        padding: 4px 6px;
        text-align: left;
        vertical-align: middle;
      }

      .sl-table th {
        font-weight: 700;
        color: var(--muted);
        user-select: none;
      }

      .sl-table tr:hover td {
        background: rgba(255, 255, 255, 0.03);
      }

      /* Preview canvas */
      canvas.sl-prev {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--panel);
        touch-action: none;
        width: 100%;
        height: 240px;
        display: block;
      }

      .sl-chip {
        display: inline-block;
        padding: 2px 6px;
        border: 1px solid var(--border);
        border-radius: 999px;
        margin-left: 8px;
        cursor: default;
        background: var(--panel);
        font-size: 11px;
        color: var(--muted);
      }

      .dim { color: var(--muted); }

      .colbar {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .tb-sub { font-size: 11px; color: var(--muted); }

      .edge-hot { outline: 2px solid rgba(78, 163, 255, 0.45); }

      /* drag handle */
      .drag-handle {
        cursor: grab;
        width: 20px;
        text-align: center;
        opacity: 0.85;
        color: var(--muted);
      }
      .dragging { opacity: 0.6; }
      tr.drag-over { outline: 1px dashed var(--accent); }

      @media (max-width: 900px) {
        .slbpm { grid-template-columns: 1fr; }
        .sl-row > label { width: 120px; }
      }
    `;

    // LEFT — Basics
    const left = createEl('div', { class:'sl-card sl-basics' }, wrap);
    createEl('h3', { text:'Basics' }, left);

    const cfg = { songSlot: 0, totalRows: 128, name: 'SWL‑BPM' };

    const rowA = createEl('div', { class:'sl-row' }, left);
    createEl('label', { text:'Song slot (1–32)' }, rowA);
    const inSlot = createEl('input', { type:'number', value: (cfg.songSlot+1), min:1, max:32, class:'sl-mini', title:'Target slot for write (memory only)' }, rowA);
    inSlot.oninput = () => { cfg.songSlot = clamp((parseInt(inSlot.value,10)||1)-1, 0, 31); };

    const rowC = createEl('div', { class:'sl-row' }, left);
    createEl('label', { text:'# Rows (max span)' }, rowC);
    const inRows = createEl('input', { type:'number', value: cfg.totalRows, min:1, max:256, class:'sl-mini' }, rowC);
    inRows.oninput = () => { cfg.totalRows = clamp(parseInt(inRows.value,10)||1, 1, 256); drawPreview(); };

    const rowE = createEl('div', { class:'sl-row' }, left);
    createEl('label', { text:'Song name' }, rowE);
    const inName = createEl('input', { type:'text', value: cfg.name, class:'sl-input' }, rowE);
    inName.oninput = () => { cfg.name = (inName.value||'').slice(0,16); };

    const actions = createEl('div', { class:'sl-actions' }, left);
    const composeBtn = createEl('button', { class:'lab-mini-btn', text:'Write → Song Slot', title:'Commit composed song into the selected slot (memory only)' }, actions);

    const statusEl = createEl('div', { class:'sl-status', text:'' }, left);

    // RIGHT — Regions + Preview
    const right = createEl('div', { class:'sl-card' }, wrap);
    const header = createEl('h3', { text:'Regions' }, right);
    header.title = 'Shift+Click to randomize Start/End BPM + Curve per region (low-biased for alt-fade / perlin / chaos)';

    const regions = [];
    const loops = [];  // for special rows + compose

    const tblWrap = createEl('div', { class:'sl-table-wrap' }, right);
    const tbl = createEl('table', { class:'sl-table' }, tblWrap);
    const thead = createEl('thead', {}, tbl);
    const thr = createEl('tr', {}, thead);
    ['⇅','Region','Pattern','Start Row','End Row','Start BPM','End BPM','Curve','OFF','LEN','Curve Extra','']
      .forEach(h=> createEl('th',{text:h},thr));
    const tbody = createEl('tbody', {}, tbl);

    // Toolbar above preview
    const bar = createEl('div', { class:'colbar', style:'margin:8px 0' }, right);
    const addBtn = createEl('button', { class:'lab-mini-btn', text:'+ Add Region' }, bar);
    const addLoopBtn = createEl('button', { class:'lab-mini-btn', text:'+ Add Loop' }, bar);
    const drawToggle = createEl('button', { class:'lab-mini-btn', text:'✎ Draw BPM' }, bar);
    createEl('span', { class:'sl-chip dim', text:'Drag edges/body to ripple; drag ⇅ to reorder; or ✎ to paint' }, bar);

    let drawMode = false;
    drawToggle.onclick = () => {
      drawMode = !drawMode;
      drawToggle.textContent = drawMode ? '✎ Drawing… (click again to exit)' : '✎ Draw BPM';
      prev.style.cursor = drawMode ? 'crosshair' : 'default';
    };

    // ──────────────────────────────────────────────────────────────────────────
    // Ripple helpers + robust editing
    // ──────────────────────────────────────────────────────────────────────────
    function prevOf(idx) { return idx > 0 ? regions[idx-1] : null; }
    function lastEnd()   { return regions.length ? regions[regions.length-1].endRow|0 : 0; }

    function clampRippleDelta(idx, delta) {
      if (!regions.length) return 0;
      const r = regions[idx];
      const p = prevOf(idx);
      const minDelta = p ? ( (p.endRow|0) + 1 - (r.startRow|0) ) : (1 - (r.startRow|0));
      const maxDelta = (cfg.totalRows|0) - (lastEnd()|0);
      return clamp(delta|0, minDelta|0, maxDelta|0);
    }

    function rippleShiftFrom(idx, delta) {
      const d = clampRippleDelta(idx, delta|0);
      if (!d) return 0;
      for (let k = idx; k < regions.length; k++) {
        regions[k].startRow = (regions[k].startRow|0) + d;
        regions[k].endRow   = (regions[k].endRow|0) + d;
        onRegionLengthChange(k); // preserve drawings
      }
      return d;
    }

    function resizeEndRipple(idx, newEnd) {
      const r = regions[idx];
      let ne = clamp(newEnd|0, (r.startRow|0), cfg.totalRows|0);
      let deltaLen = (ne - (r.endRow|0))|0;
      if (!deltaLen) return 0;
      const allowed = clampRippleDelta(idx + 1, deltaLen);
      const applied = (deltaLen > 0) ? Math.min(deltaLen, allowed) : Math.max(deltaLen, allowed);
      r.endRow = (r.endRow|0) + applied;
      onRegionLengthChange(idx);
      if (applied) rippleShiftFrom(idx + 1, applied);
      return applied;
    }

    function resizeStartCoupled(idx, newStart) {
      const r = regions[idx];
      const p = prevOf(idx);
      if (!r) return 0;
      if (!p) {
        const ns = clamp(newStart|0, 1, r.endRow|0);
        const delta = (ns - (r.startRow|0))|0;
        r.startRow = ns;
        onRegionLengthChange(idx);
        return delta;
      }
      const ns = clamp(newStart|0, (p.startRow|0)+1, r.endRow|0);
      const delta = (ns - (r.startRow|0))|0;
      r.startRow = ns;
      p.endRow   = ns - 1;
      onRegionLengthChange(idx);
      return delta;
    }

    function rechainFromOrder(anchorStart = 1) {
      if (!regions.length) return;
      let s = clamp(anchorStart|0, 1, cfg.totalRows|0);
      for (let i = 0; i < regions.length; i++) {
        const L = Math.max(1, lenInc(regions[i]));
        regions[i].startRow = s;
        regions[i].endRow   = clamp(s + L - 1, s, cfg.totalRows|0);
        onRegionLengthChange(i);
        s = (regions[i].endRow|0) + 1;
        if (s > (cfg.totalRows|0)) break;
      }
    }

    function resampleDrawBpm(R, newLen) {
      if (!Array.isArray(R.drawBpm) || !R.drawBpm.length) { R.drawBpm = new Array(newLen).fill(null); return; }
      const src = R.drawBpm.slice(); const dst = new Array(newLen);
      for (let i=0;i<newLen;i++){
        const t = (src.length===1)?0 : (i/(newLen-1));
        const s = t*(src.length-1);
        const i0 = Math.floor(s), i1 = Math.min(src.length-1, i0+1);
        const a = src[i0]==null ? R.startBpm : src[i0];
        const b = src[i1]==null ? R.endBpm   : src[i1];
        dst[i] = Math.round(a + (b-a)*(s - i0));
      }
      R.drawBpm = dst;
    }
    function onRegionLengthChange(idx) {
      const R = regions[idx];
      const L = Math.max(1, lenInc(R));
      if (R.curve==='drawn') resampleDrawBpm(R, L);
    }

    function redrawTable() {
      tbody.innerHTML = '';
      regions.forEach((r, idx) => {
        const tr = createEl('tr', { 'data-idx': String(idx) }, tbody);

        // Drag handle
        const tdDrag = createEl('td', { class:'drag-handle', title:'Drag to reorder regions' }, tr);
        createEl('span', { text:'⋮⋮' }, tdDrag);
        tdDrag.draggable = true;
        tdDrag.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', String(idx));
          tr.classList.add('dragging');
        });
        tdDrag.addEventListener('dragend', () => tr.classList.remove('dragging'));
        tr.addEventListener('dragover', (ev) => { ev.preventDefault(); tr.classList.add('drag-over'); });
        tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
        tr.addEventListener('drop', (ev) => {
          ev.preventDefault();
          tr.classList.remove('drag-over');
          const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
          const to   = idx;
          if (isNaN(from) || from === to) return;
          const [itm] = regions.splice(from, 1);
          regions.splice(to, 0, itm);
          rechainFromOrder(1);
          redrawTable(); drawPreview();
        });

        // Region name
        const tdName = createEl('td', {}, tr);
        const inN = createEl('input', { type:'text', value:r.name||'', class:'sl-mini', placeholder:'Region' }, tdName);
        inN.oninput = () => { r.name = inN.value; };

        // Pattern (A01–H16)
        const tdPat = createEl('td', {}, tr);
        const inPat = createEl('input', { type:'text', value: patternIndexToLabel(r.patternIndex|0), class:'sl-mini', placeholder:'A01' }, tdPat);
        inPat.onchange = () => {
          r.patternIndex = patternLabelToIndex(inPat.value);
          inPat.value = patternIndexToLabel(r.patternIndex|0);
        };

        // Helpers for robust number commit
        function attachNumberEditing(field, commitFn) {
          field.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { commitFn(); field.blur(); }
            if (ev.key === 'Escape') {
              ev.preventDefault();
              field.value = field.getAttribute('data-prev') || field.value;
              field.blur();
            }
          });
          field.addEventListener('focus', () => field.setAttribute('data-prev', field.value));
          field.addEventListener('blur',  () => commitFn());
          field.addEventListener('wheel', (e) => e.preventDefault(), { passive:false });
        }

        // Start
        const tdS = createEl('td', {}, tr);
        const inS = createEl('input', { type:'number', value:r.startRow, min:1, max:cfg.totalRows, class:'sl-mini' }, tdS);
        function commitStartEdit() {
          let v = parseInt(inS.value, 10);
          if (!isFinite(v)) v = r.startRow|0;
          resizeStartCoupled(idx, v);
          redrawTable(); drawPreview();
        }
        attachNumberEditing(inS, commitStartEdit);

        // End
        const tdE = createEl('td', {}, tr);
        const inE = createEl('input', { type:'number', value:r.endRow, min:1, max:cfg.totalRows, class:'sl-mini' }, tdE);
        function commitEndEdit() {
          let v = parseInt(inE.value, 10);
          if (!isFinite(v)) v = r.endRow|0;
          v = clamp(v|0, r.startRow|0, cfg.totalRows|0);
          resizeEndRipple(idx, v);
          redrawTable(); drawPreview();
        }
        attachNumberEditing(inE, commitEndEdit);

        // Start BPM
        const tdSB = createEl('td', {}, tr);
        const inSB = createEl('input', { type:'number', value:r.startBpm, min:30, max:300, step:'1', class:'sl-mini' }, tdSB);
        inSB.oninput = () => { r.startBpm = clamp(Math.round(parseFloat(inSB.value)||120), 30, 300); drawPreview(); };

        // End BPM
        const tdEB = createEl('td', {}, tr);
        const inEB = createEl('input', { type:'number', value:r.endBpm, min:30, max:300, step:'1', class:'sl-mini' }, tdEB);
        inEB.oninput = () => { r.endBpm = clamp(Math.round(parseFloat(inEB.value)||120), 30, 300); drawPreview(); };

        // Curve
        const tdCurve = createEl('td', {}, tr);
        const selCurve = createEl('select', {}, tdCurve);
        ['linear','ease-in','ease-out','ease-in-out','s-curve','power2','power3','exp','log','triangle','stairs','sine','alt','alt-fade','saw','pingpong','pulse','jitter','perlin','chaos','drawn']
          .forEach(k => {
            const op = createEl('option', { value:k, text:k }, selCurve);
            if (k === r.curve) op.selected = true;
          });
        selCurve.onchange = () => { r.curve = selCurve.value; redrawTable(); drawPreview(); };

        // OF
        const tdOF = createEl('td', {}, tr);
        const inOF = createEl('input', { type:'number', value:r.offset, min:0, max:63, class:'sl-mini' }, tdOF);
        inOF.oninput = () => { r.offset = clamp(parseInt(inOF.value,10)||0, 0, 63); };

        // LEN
        const tdLEN = createEl('td', {}, tr);
        const inLEN = createEl('input', { type:'number', value:r.length, min:2, max:64, class:'sl-mini' }, tdLEN);
        inLEN.oninput = () => { r.length = clamp(parseInt(inLEN.value,10)||32, 2, 64); };

        // Extra
        const tdX = createEl('td', {}, tr);
        tdX.innerHTML = '';
        if (r.curve === 'stairs') {
          const steps = createEl('input', { type:'number', value:r.steps||8, min:1, max:64, class:'sl-mini' }, tdX);
          steps.title = 'steps (stairs)';
          steps.oninput = () => { r.steps = clamp(parseInt(steps.value,10)||8, 1, 64); drawPreview(); };
        } else if (r.curve === 'sine') {
          const cyc = createEl('input', { type:'number', value:r.cycles||1, min:0.1, max:64, step:'0.1', class:'sl-mini' }, tdX);
          cyc.title = 'cycles'; cyc.oninput = () => { r.cycles = Math.max(0.1, parseFloat(cyc.value)||1); drawPreview(); };
          const ph = createEl('input', { type:'number', value:r.phase||0, min:-1, max:1, step:'0.01', class:'sl-mini' }, tdX);
          ph.title = 'phase'; ph.oninput = () => { r.phase = clamp(parseFloat(ph.value)||0, -1, 1); drawPreview(); };
        } else if (r.curve === 'alt' || r.curve === 'alt-fade') {
          const block = createEl('input', { type:'number', value:r.steps||1, min:1, max:64, class:'sl-mini' }, tdX);
          block.title = 'rows per toggle (steps)';
          block.oninput = () => { r.steps = clamp(parseInt(block.value,10)||1, 1, 64); drawPreview(); };
          if (r.curve === 'alt-fade') {
            const exp = createEl('input', { type:'number', value:r.phase||1, min:-10, max:10, step:'0.1', class:'sl-mini' }, tdX);
            exp.title = 'fade exponent (phase, ±10 = flip)';
            exp.oninput = () => {
              let v = parseFloat(exp.value);
              if (!isFinite(v)) v = 1;
              v = clamp(v, -10, 10);
              // enforce |v| >= 0.1
              if (Math.abs(v) < 0.1) v = (v < 0 ? -0.1 : 0.1);
              r.phase = v;
              drawPreview();
            };
          }
        } else if (r.curve === 'saw' || r.curve === 'pingpong') {
          const cyc = createEl('input', { type:'number', value:r.cycles||2, min:0.1, max:64, step:'0.1', class:'sl-mini' }, tdX);
          cyc.title = 'cycles across region';
          cyc.oninput = () => { r.cycles = Math.max(0.1, parseFloat(cyc.value)||2); drawPreview(); };
        } else if (r.curve === 'pulse') {
          const per = createEl('input', { type:'number', value:r.steps||8, min:1, max:128, class:'sl-mini' }, tdX);
          per.title = 'rows per period (steps)';
          per.oninput = () => { r.steps = clamp(parseInt(per.value,10)||8, 1, 128); drawPreview(); };
          const duty = createEl('input', { type:'number', value:(r.phase==null?0.5:r.phase), min:0, max:1, step:'0.01', class:'sl-mini' }, tdX);
          duty.title = 'duty (0..1)';
          duty.oninput = () => { r.phase = clamp(parseFloat(duty.value)||0.5, 0, 1); drawPreview(); };
        } else if (r.curve === 'jitter') {
          const rough = createEl('input', { type:'number', value:r.cycles||16, min:1, max:128, class:'sl-mini' }, tdX);
          rough.title = 'roughness (cycles per region)';
          rough.oninput = () => { r.cycles = clamp(parseInt(rough.value,10)||16, 1, 128); drawPreview(); };
          const amp = createEl('input', { type:'number', value:(r.phase||0.1), min:0.01, max:1, step:'0.01', class:'sl-mini' }, tdX);
          amp.title = 'amplitude (0.01..1.0 of range)';
          amp.oninput = () => { r.phase = clamp(parseFloat(amp.value)||0.1, 0.01, 1.0); drawPreview(); };
        } else if (r.curve === 'perlin') {
          const scale = createEl('input', { type:'number', value:r.steps||3, min:1, max:5, class:'sl-mini' }, tdX);
          scale.title='scale (rows per wave, 1..5)';
          scale.oninput = ()=>{ r.steps = clamp(parseInt(scale.value,10)||3, 1, 5); drawPreview(); };
          const seed = createEl('input', { type:'number', value:r.phase||0, min:-9999, max:9999, step:'1', class:'sl-mini' }, tdX);
          seed.title='seed (phase ±9999)';
          seed.oninput = ()=>{ r.phase = clamp(parseInt(seed.value,10)||0, -9999, 9999); drawPreview(); };
        } else if (r.curve === 'chaos') {
          const scale = createEl('input', { type:'number', value:r.steps||3, min:1, max:5, class:'sl-mini' }, tdX);
          scale.title='scale (1..5)'; scale.oninput = ()=>{ r.steps = clamp(parseInt(scale.value,10)||3, 1, 5); drawPreview(); };
          const oct = createEl('input', { type:'number', value:r.cycles||3, min:1, max:5, class:'sl-mini' }, tdX);
          oct.title='octaves (1..5)'; oct.oninput = ()=>{ r.cycles = clamp(parseInt(oct.value,10)||3, 1, 5); drawPreview(); };
          const amp = createEl('input', { type:'number', value:(r.phase==null?0.4:r.phase), min:-1, max:1, step:'0.01', class:'sl-mini' }, tdX);
          amp.title='amplitude (−1..1; negative flips)';
          amp.oninput = ()=>{
            let v = parseFloat(amp.value); if (!isFinite(v)) v = 0.4;
            r.phase = clamp(v, -1, 1); drawPreview();
          };
        } else if (r.curve === 'drawn') {
          const smooth = createEl('button', { class:'lab-mini-btn', text:'Smooth' }, tdX);
          smooth.onclick = () => {
            if (!Array.isArray(r.drawBpm)) return;
            const out = r.drawBpm.slice();
            for (let i=1;i<out.length-1;i++) out[i] = Math.round((out[i-1] + out[i] + out[i+1])/3);
            r.drawBpm = out; r.startBpm = out[0]; r.endBpm = out[out.length-1]; drawPreview();
          };
          const clear = createEl('button', { class:'lab-mini-btn', text:'Clear' }, tdX);
          clear.onclick = () => { r.drawBpm = null; r.curve = 'linear'; drawPreview(); redrawTable(); };
        } else {
          tdX.textContent = '—';
        }

        // Delete
        const tdDel = createEl('td', {}, tr);
        const del = createEl('button', { class:'lab-mini-btn', text:'✕' }, tdDel);
        del.onclick = () => { regions.splice(idx, 1); redrawTable(); drawPreview(); };
      });
    }

    addBtn.onclick = () => {
      let start = 1, end = Math.min(cfg.totalRows, 32);
      let of = 0, L = 32, pat = 0;
      if (regions.length) {
        const last = regions.slice().sort((a,b)=>a.endRow-b.endRow)[regions.length-1];
        start = clamp((last.endRow|0) + 1, 1, cfg.totalRows);
        end   = clamp(start + 31, 1, cfg.totalRows);
        of = last.offset|0;
        L  = clamp(last.length|0, 2, 64);
        pat = last.patternIndex|0;
      }
      const def = {
        name: `R${regions.length+1}`,
        startRow: start, endRow: end,
        startBpm: (regions.length ? regions[regions.length-1].endBpm|0 : 120),
        endBpm:   (regions.length ? regions[regions.length-1].endBpm|0 : 120),
        curve: 'linear',
        offset: of, length: L,
        steps: 8, cycles: 1, phase: 0,
        patternIndex: pat
      };
      regions.push(def); redrawTable(); drawPreview();
    };

    // Loops table
    createEl('div', { class:'tb-sub', text:'Loops (optional): Execute from “At row” back to “Target row”, times (0=∞). Included at compose.' }, right);
    const loopTbl = createEl('table', { class:'sl-table' }, right);
    const lThead = createEl('thead', {}, loopTbl);
    const lThr = createEl('tr', {}, lThead);
    ['At row','Target row','Times',''].forEach(h=> createEl('th',{text:h}, lThr));
    const lBody = createEl('tbody', {}, loopTbl);

    function redrawLoops() {
      lBody.innerHTML = '';
      loops.forEach((L, idx) => {
        const tr = createEl('tr', {}, lBody);
        const tdAt = createEl('td', {}, tr);
        const inAt = createEl('input', { type:'number', value:L.atRow, min:1, max:cfg.totalRows, class:'sl-mini' }, tdAt);
        inAt.oninput = () => { L.atRow = clamp(parseInt(inAt.value,10)||1, 1, cfg.totalRows); };

        const tdT = createEl('td', {}, tr);
        const inT = createEl('input', { type:'number', value:L.targetRow, min:1, max:cfg.totalRows, class:'sl-mini' }, tdT);
        inT.oninput = () => { L.targetRow = clamp(parseInt(inT.value,10)||1, 1, cfg.totalRows); };

        const tdTimes = createEl('td', {}, tr);
        const inTimes = createEl('input', { type:'number', value:L.times, min:0, max:63, class:'sl-mini' }, tdTimes);
        inTimes.oninput = () => { L.times = clamp(parseInt(inTimes.value,10)||0, 0, 63); };

        const tdDel = createEl('td', {}, tr);
        const del = createEl('button', { class:'lab-mini-btn', text:'✕' }, tdDel);
        del.onclick = () => { loops.splice(idx,1); redrawLoops(); drawPreview(); };
      });
    }

    addLoopBtn.onclick = () => {
      let at = Math.min(cfg.totalRows, 32), tgt = 1;
      if (regions.length) {
        const last = regions.slice().sort((a,b)=>a.endRow-b.endRow)[regions.length-1];
        at = last.endRow;
        tgt = last.startRow;
      }
      loops.push({ atRow: at, targetRow: tgt, times: 2 });
      redrawLoops(); drawPreview();
    };

    // Preview
    const prev = createEl('canvas', { class:'sl-prev', width: 900, height: 240 }, right);

    let prevPad = 10;
    function resizePreviewCanvas(force = false) {
      const rect = prev.getBoundingClientRect();
      const cssW = rect && rect.width ? rect.width : 0;
      const cssH = rect && rect.height ? rect.height : 0;
      // When first mounted, the canvas may not be in layout yet.
      if (!cssW || cssW < 50 || !cssH || cssH < 50) return false;

      const dpr = Math.max(1, (window.devicePixelRatio || 1));
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssH * dpr);

      prevPad = Math.round(10 * dpr);

      if (!force && prev.width === w && prev.height === h) return false;
      prev.width = w;
      prev.height = h;
      return true;
    }

    function drawPreview() {
      resizePreviewCanvas();
      const ctx = prev.getContext('2d');
      ctx.clearRect(0,0,prev.width, prev.height);
      const pad = prevPad, W = prev.width - 2*pad, H = prev.height - 2*pad;

      ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.strokeRect(pad, pad, W, H);

      ctx.save();
      const prog = makeBpmFromRegions(regions, cfg.totalRows);
      const ys = [];
      for (let i = 0; i < cfg.totalRows; i++) {
        const { bpm } = prog(i);
        ys.push(bpm);
      }
      const finite = ys.filter(v => v!=null);
      const lo = finite.length ? Math.min(...finite) : 30;
      const hi = finite.length ? Math.max(...finite) : 300;

      ctx.globalAlpha = 0.08;
      regions.forEach((r) => {
        const x1 = pad + ((r.startRow-1)/(cfg.totalRows-1)) * W;
        const x2 = pad + ((r.endRow-1)/(cfg.totalRows-1)) * W;
        ctx.fillStyle = '#000';
        ctx.fillRect(Math.min(x1,x2), pad, Math.abs(x2-x1), H);
      });
      ctx.globalAlpha = 1;

      // BPM polyline
      ctx.beginPath();
      let moved = false;
      for (let i = 0; i < cfg.totalRows; i++) {
        const bpm = ys[i];
        const x = pad + (i/(cfg.totalRows-1)) * W;
        let y = pad + H/2;
        if (bpm != null) {
          const t = (clamp(bpm, lo, hi) - lo) / Math.max(1e-9, (hi - lo));
          y = pad + (1-t) * H;
        }
        if (!moved) { ctx.moveTo(x, y); moved = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Region labels
      ctx.fillStyle = '#333';
      ctx.font = '11px system-ui, sans-serif';
      regions.forEach((r) => {
        const x = pad + (((r.startRow + r.endRow)/2 -1) / (cfg.totalRows-1)) * W;
        const label = (r.name || '') + (typeof r.patternIndex==='number' ? ` [${patternIndexToLabel(r.patternIndex)}]` : '');
        ctx.fillText(label, x-12, pad + 12);
      });

      // Special rows overlay
      const colLoop = '#0a6', colJump = '#06c', colHalt = '#c30';
      ctx.font = '10px system-ui';
      loops.forEach(L => {
        const x = pad + ((L.atRow-1)/(cfg.totalRows-1)) * W;
        ctx.setLineDash([4,4]);
        ctx.strokeStyle = (L.kind==='loop' ? colLoop : L.kind==='jump' ? colJump : colHalt);
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, pad+H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        const label = (L.kind==='loop' ? 'LOOP' : L.kind==='jump' ? 'JUMP' : 'HALT');
        ctx.fillText(`${label}→${String(L.targetRow).padStart(3,'0')}`, x+4, pad+12);
        const xt = pad + ((L.targetRow-1)/(cfg.totalRows-1)) * W;
        ctx.globalAlpha = 0.4;
        ctx.beginPath(); ctx.moveTo(x, pad+H-10); ctx.lineTo(xt, pad+H-10); ctx.stroke();
        ctx.globalAlpha = 1;
      });

      ctx.restore();
    }

    // Initial draws
    redrawTable(); redrawLoops(); drawPreview();

    // === Write to song slot ===
    composeBtn.onclick = () => {
      const bpmProg = makeBpmFromRegions(regions, cfg.totalRows);
      const song = composeSong({ songSlot: cfg.songSlot, totalRows: cfg.totalRows, name: cfg.name }, bpmProg, loops, host);
      const ok = adapter.commitSongSlot(song.slotIndex, song);
      if (statusEl) {
        statusEl.textContent = ok
          ? `Wrote song to slot ${song.slotIndex + 1} (memory). Rows (incl. END): ${song.rows.length}.`
          : 'Could not write song in this host.';
      }
    };

    // Randomizer (Shift+click header) — low‑biased for alt‑fade/perlin/chaos and new caps
    header.addEventListener('click', (ev) => {
      if (!ev.shiftKey || !regions.length) return;

      const curves = [
        'linear','ease-in','ease-out','ease-in-out','s-curve','power2','power3','exp','log','triangle',
        'stairs','sine','alt','alt-fade','saw','pingpong','pulse','jitter','perlin','chaos'
      ];

      const ri = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
      const rf = (min, max, step = 0.01) => {
        const v = min + Math.random() * (max - min);
        const q = Math.round((v - min) / step) * step + min;
        return Math.max(min, Math.min(max, q));
      };
      // lower‑biased variants (k>1 favors lower values)
      const riLow = (min, max, k = 2) => Math.floor(min + Math.pow(Math.random(), k) * (max - min + 1));
      const rfLow = (min, max, step = 0.01, k = 2) => {
        const v = min + Math.pow(Math.random(), k) * (max - min);
        const q = Math.round((v - min) / step) * step + min;
        return Math.max(min, Math.min(max, q));
      };

      regions.forEach(r => {
        r.startBpm = ri(30, 300);
        r.endBpm   = ri(30, 300);
        r.curve    = randOf(curves);

        // Default sane fallbacks
        r.steps  = r.steps|0;
        r.cycles = (r.cycles == null ? 1 : r.cycles);
        r.phase  = (r.phase  == null ? 0 : r.phase);

        switch (r.curve) {
          case 'stairs':   r.steps  = ri(1, 64); break;

          case 'sine':     r.cycles = rf(0.1, 64, 0.1);
                           r.phase  = rf(-1, 1, 0.01);
                           break;

          case 'alt':      r.steps  = ri(1, 64);
                           r.phase  = 0;
                           break;

          case 'alt-fade': r.steps  = riLow(1, 16, 2);
                           { const sgn = (Math.random()<0.5?-1:1);
                             const mag = rfLow(0.1, 10, 0.1, 2);
                             r.phase  = sgn * mag; }   // exponent (±, |v|>=0.1, max 10)
                           break;

          case 'saw':      r.cycles = rf(0.1, 64, 0.1); break;
          case 'pingpong': r.cycles = rf(0.1, 64, 0.1); break;

          case 'pulse':    r.steps  = ri(1, 128);       // period
                           r.phase  = rf(0, 1, 0.01);   // duty
                           break;

          case 'jitter':   r.cycles = ri(1, 128);       // roughness
                           r.phase  = rf(0.01, 1.0, 0.01); // amplitude
                           break;

          case 'perlin':   r.steps  = riLow(1, 5, 2);   // scale (1..5)
                           r.phase  = ri(-9999, 9999);  // seed knob
                           break;

          case 'chaos':    r.steps  = riLow(1, 5, 2);   // scale (1..5)
                           r.cycles = riLow(1, 5, 2);   // octaves (1..5)
                           { const sgn = (Math.random()<0.5?-1:1);
                             const mag = rfLow(0.05, 0.4, 0.01, 2);
                             r.phase  = sgn * mag; }    // amplitude (neg flips)
                           break;
        }

        if (r.curve !== 'drawn') r.drawBpm = null; // optional hygiene
      });

      redrawTable(); drawPreview();
    });

    // === Canvas interactions ===
    let drag = null; // for region ripple
    let drawDrag = null; // for paint mode

    function rowFromX(clientX) {
      const rect = prev.getBoundingClientRect();
      const pad = prevPad, W = prev.width - pad*2;
      const x = (clientX - rect.left) * (prev.width / rect.width);
      const t = clamp((x - pad) / Math.max(1, W), 0, 1);
      return 1 + Math.round(t * (Math.max(1, cfg.totalRows-1)));
    }
    function xFromRow(row) {
      const pad = prevPad, W = prev.width - pad*2;
      return pad + ((row-1)/(Math.max(1, cfg.totalRows-1))) * W;
    }
    function nearestRegionEdge(row) {
      const px = xFromRow(row);
      let best = null;
      const tol = 6;
      regions.forEach((r, idx) => {
        const sx = xFromRow(r.startRow);
        const ex = xFromRow(r.endRow);
        const dS = Math.abs(px - sx);
        const dE = Math.abs(px - ex);
        if (dS <= tol && (!best || dS < best.distPx)) best = { idx, kind:'start', distPx:dS, x:sx };
        if (dE <= tol && (!best || dE < best.distPx)) best = { idx, kind:'end',   distPx:dE, x:ex };
        if (px > sx + tol && px < ex - tol && (!best || tol < best.distPx)) {
          best = { idx, kind:'move', distPx: tol+1 };
        }
      });
      return best;
    }
    function snapshot() { return regions.map(r => ({ startRow: r.startRow|0, endRow: r.endRow|0 })); }
    function restore(snap) { snap.forEach((s, i) => { if (regions[i]) { regions[i].startRow = s.startRow; regions[i].endRow = s.endRow; } }); }
    function repaintEdgeHot(edge) { prev.classList.toggle('edge-hot', !!edge && edge.kind !== 'move'); }
    function applyHoverCursor(edge) {
      if (!edge) { prev.style.cursor = drawMode ? 'crosshair':'default'; return; }
      if (edge.kind === 'move') { prev.style.cursor = drag ? 'grabbing' : 'grab'; return; }
      prev.style.cursor = (edge.kind === 'start') ? 'w-resize' : 'e-resize';
    }

    function previewYToBpm(y, lo, hi, pad, H) {
      const t = clamp((y - pad) / Math.max(1, H), 0, 1);
      return Math.round(lo + (1 - t) * (hi - lo));
    }
    function paintRowBpm(R, absRow, bpmVal) {
      const idx = (absRow - (R.startRow|0))|0;
      const L = Math.max(1, lenInc(R));
      if (!Array.isArray(R.drawBpm) || R.drawBpm.length!==L) R.drawBpm = new Array(L).fill(null);
      if (idx<0 || idx>=R.drawBpm.length) return;
      R.drawBpm[idx] = clamp(Math.round(bpmVal), 30, 300);
    }

    prev.addEventListener('pointerdown', (ev) => {
      prev.setPointerCapture(ev.pointerId);
      const row = rowFromX(ev.clientX);

      // Paint mode
      if (drawMode) {
        // compute preview bounds/scale
        const rect = prev.getBoundingClientRect();
        const pad = prevPad, W = prev.width - 2*pad, H = prev.height - 2*pad;
        const y = (ev.clientY - rect.top) *  (prev.height / rect.height);

        // find region covering this row
        let idx = -1;
        for (let k=0;k<regions.length;k++){
          if (row>=regions[k].startRow && row<=regions[k].endRow) { idx = k; break; }
        }
        if (idx<0) return;

        const prog = makeBpmFromRegions(regions, cfg.totalRows);
        const ys = []; for (let i=0;i<cfg.totalRows;i++){ const r=prog(i); if (r && r.bpm!=null) ys.push(r.bpm); }
        const finite = ys.filter(v=>v!=null);
        const lo = finite.length ? Math.min(...finite) : 30;
        const hi = finite.length ? Math.max(...finite) : 300;

        const R = regions[idx];
        const L = Math.max(1, lenInc(R));
        if (!Array.isArray(R.drawBpm) || R.drawBpm.length!==L) R.drawBpm = new Array(L).fill(null);
        if (R.curve !== 'drawn') R.curve = 'drawn';

        const bpm = previewYToBpm(y, lo, hi, pad, H);
        paintRowBpm(R, row, bpm);
        drawDrag = { regionIndex: idx, lo, hi, pad, H, lastRow: row, lastBpm: bpm };
        redrawTable(); drawPreview();
        return;
      }

      const hit = nearestRegionEdge(row);
      if (hit) { drag = { ...hit, snapshot: snapshot() }; repaintEdgeHot(hit); applyHoverCursor({kind:'move'}); }
    });

    prev.addEventListener('pointermove', (ev) => {
      if (drawMode) {
        if (!drawDrag) return;
        const rect = prev.getBoundingClientRect();
        const y = (ev.clientY - rect.top) *  (prev.height / rect.height);
        const row = rowFromX(ev.clientX);
        const bpm = previewYToBpm(y, drawDrag.lo, drawDrag.hi, drawDrag.pad, drawDrag.H);

        const idx = drawDrag.regionIndex;
        const R = regions[idx];
        const a = Math.max(Math.min(drawDrag.lastRow, row), R.startRow);
        const b = Math.min(Math.max(drawDrag.lastRow, row), R.endRow);
        for (let rr=a; rr<=b; rr++) {
          const t = (b===a)?1: (rr-a)/(b-a);
          const bb = Math.round(drawDrag.lastBpm + t * (bpm - drawDrag.lastBpm));
          paintRowBpm(R, rr, bb);
        }
        drawDrag.lastRow = row; drawDrag.lastBpm = bpm;
        const sIdx = 0, eIdx = (R.drawBpm.length-1);
        if (R.drawBpm[sIdx]!=null) R.startBpm = R.drawBpm[sIdx];
        if (R.drawBpm[eIdx]!=null) R.endBpm   = R.drawBpm[eIdx];
        redrawTable(); drawPreview();
        return;
      }

      if (!drag) {
        const row = rowFromX(ev.clientX);
        const edge = nearestRegionEdge(row);
        repaintEdgeHot(edge);
        applyHoverCursor(edge);
        return;
      }
      const row = rowFromX(ev.clientX);
      restore(drag.snapshot);
      if (drag.kind === 'start') {
        resizeStartCoupled(drag.idx, row|0);
      } else if (drag.kind === 'end') {
        resizeEndRipple(drag.idx, row|0);
      } else {
        const snapR = drag.snapshot[drag.idx];
        const span = (snapR.endRow|0) - (snapR.startRow|0);
        const targetStart = clamp((row|0) - Math.round(span/2), 1, (cfg.totalRows|0) - span);
        const desiredDelta = (targetStart - (snapR.startRow|0))|0;
        rippleShiftFrom(drag.idx, desiredDelta);
      }
      redrawTable(); drawPreview();
      applyHoverCursor({kind:'move'});
    });

    prev.addEventListener('pointerup', (ev) => {
      prev.releasePointerCapture(ev.pointerId);
      if (drawMode && drawDrag) { drawDrag = null; return; }
      drag = null; repaintEdgeHot(null); applyHoverCursor(null);
    });
    prev.addEventListener('pointerleave', () => { if (!drag) { repaintEdgeHot(null); applyHoverCursor(null); } });

    // ──────────────────────────────────────────────────────────────────────────

    // ──────────────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────────
    // Lab host wrapper (adds header + Reset/Random buttons like other modules)
    // ────────────────────────────────────────────────────────────────────────
    function _resetAll() {
      // Restore defaults
      cfg.songSlot = 0; cfg.totalRows = 128; cfg.name = 'SWL‑BPM';
      inSlot.value = String(cfg.songSlot + 1);
      inRows.value = String(cfg.totalRows);
      inName.value = cfg.name;

      regions.length = 0;
      loops.length = 0;
      drawMode = false;
      drawToggle.textContent = '✎ Draw BPM';
      prev.style.cursor = 'default';

      // Start with one sane region spanning 32 rows
      regions.push({
        name: 'R1',
        startRow: 1, endRow: Math.min(cfg.totalRows, 32),
        startBpm: 120, endBpm: 120,
        curve: 'linear',
        offset: 0, length: 32,
        steps: 8, cycles: 1, phase: 0,
        patternIndex: 0
      });
      redrawLoops();
      redrawTable();
      drawPreview();
      statusEl.textContent = '';
    }

    function _randomizeAll() {
      // Reuse the existing header Shift+Click behavior programmatically
      if (!regions.length) addBtn.onclick();
      try {
        header.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, shiftKey:true }));
      } catch (_) {
        // fallback: just randomize BPMS
        regions.forEach(r => { r.startBpm = (30 + (Math.random()*271)|0); r.endBpm = (30 + (Math.random()*271)|0); });
        redrawTable(); drawPreview();
      }
    }

    const wrapper = (global && typeof global.createLabModuleWrapper === 'function')
      ? global.createLabModuleWrapper({
          id: 'labmod-swingloom',
          title: 'BPMLom',
          subtitle: 'Tempo loom across song rows',
          contentEl: wrap,
          actions: { reset: _resetAll, randomize: _randomizeAll },
          open: true
        })
      : null;

    // Ensure preview canvas fits the available width once mounted
    const _kickLayout = () => {
      try { resizePreviewCanvas(true); } catch (_) {}
      try { drawPreview(); } catch (_) {}
    };
    try {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => _kickLayout());
        ro.observe(right);
      } else {
        window.addEventListener('resize', _kickLayout, { passive:true });
      }
    } catch (_) {}

    if (wrapper) {
      cont.appendChild(wrapper);
      requestAnimationFrame(_kickLayout);
      return wrapper;
    }

    cont.appendChild(wrap);
    requestAnimationFrame(_kickLayout);
    return wrap;

  }


  const api = {
    mount,
    compose: (cfg, regions, loops) => composeSong(cfg, makeBpmFromRegions(regions, cfg.totalRows), loops, adapter),
    addRegionListTo: (list, region) => { list.push(region); return list; },
    addLoopListTo: (list, loop) => { list.push(loop); return list; },
    clearRegions: (list) => { list.length = 0; return list; }
  };

  return { mount, api };
});
