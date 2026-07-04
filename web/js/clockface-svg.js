// clockface-svg.js — resolution-independent SVG face for the Precision Clock Mk IV.
//
// A drop-in alternative to the canvas renderer in clockface.js: same factory API, same
// firmware-derived geometry and pure logic (reused verbatim from CLOCKFACE_CORE — never
// re-measured), just vector output instead of raster. Because the <svg> viewBox is expressed
// in the firmware's own H-units, the browser rasterizes at native resolution: always crisp,
// no dpr / backing-store bookkeeping.

import { CLOCKFACE_CORE } from './clockface.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

// Unique glow-filter id per instance (multiple faces coexist on one page).
let uid = 0;

// viewBox parameters (H-units): a hair of uniform pad, and the glow blur radius.
const PAD = 0.03;
const GLOW_R = 0.04;
// Off-segment opacity. The unlit "ghost 8" is a FAINT dark-red, not a solid one — kept low so
// unlit digits recede. (Previously 1.0, which — combined with a crisp-layer drop-shadow that
// follows alpha, not colour — made every off-segment cast a full red halo: the "unlit digits
// glow too strong" bug.)
const DIM_ALPHA = 0.5;
// Lit-only glow layer. The bloom is a GPU-composited CSS drop-shadow on the GLOW group (whose
// polys are shown only where a segment is lit), NOT an feGaussianBlur (which re-rasterises
// every frame and tanks paint) and NOT on the crisp layer (which would halo off-segments too).
const GLOW = true;

export function createClockFaceSVG(container, opts = {}) {
  const {
    SEG_POLYS, GLYPH, GEO, segOn,
    DP_DIA, DP_OFF_X, DP_OFF_Y, DASH,
    dateGlyph, LUT_TIME, MODES, getFields, buildLayout, buildColonTables, COLON_MODES,
    DEFAULT_TOKENS,
  } = CLOCKFACE_CORE;

  const state = {
    rows: opts.rows || ['date', 'time'],
    mode: opts.mode || 'iso8601',
    modeCtx: opts.modeCtx || {},
    colonMode: opts.colonMode || 'heartbeat',
    brightness: opts.brightness ?? 0.85,
    precision: opts.precision ?? 3,
    inverted: !!opts.inverted,
    utc: !!opts.utc,
    deviceFrame: null,
  };
  let layout = buildLayout(state.rows);
  let colonTbl = buildColonTables(state.colonMode);
  let tokens = resolveTokens(opts.tokens);

  const id = ++uid;
  let clockOffsetMs = 0;
  let raf = 0, timeSource = () => new Date(Date.now() + clockOffsetMs), destroyed = false;

  // SVG scaffolding + built element refs (created once, mutated per frame).
  let svg, glowGroup, crispGroup;
  let cellEls = []; // per row: array of cell descriptors with element handles

  function resolveTokens(override) {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
    const v = (name, fb) => {
      const x = cs && cs.getPropertyValue(name).trim();
      return x || fb;
    };
    return {
      // The LED FACE is always a bright screen on dark inset, even in light mode — so it
      // reads the dedicated --face-* tokens (bright in both themes), NOT the chrome --led
      // (which is darkened in light mode for contrast on light surfaces). --inset stays dark.
      led: v('--face-led', DEFAULT_TOKENS.led),
      ledDim: v('--face-dim', DEFAULT_TOKENS.ledDim),
      ledGlow: v('--face-glow', DEFAULT_TOKENS.ledGlow),
      inset: v('--inset', DEFAULT_TOKENS.inset),
      ...(override || {}),
    };
  }

  // Glyph box in LAYOUT units (mirror of the canvas glyphBox(), sans the px scale S).
  //   cell centre cx = row.offX + cell.cx; glyph left = cx - GLYPH.w/2 * scale;
  //   baseline    = row.top + (cellH + GLYPH.h)/2; glyph top = baseline - GLYPH.h*scale.
  function glyphBox(row, cell) {
    const sc = cell.scale;
    const gw = GLYPH.w * sc, gh = GLYPH.h * sc;
    const cx = row.offX + cell.cx;
    const baseline = row.top + (GEO.cellH + GLYPH.h) / 2;
    const top = baseline - gh;
    const left = cx - gw / 2;
    return { left, top, gw, gh, sc };
  }

  const polyPoints = (poly) => poly.map(([x, y]) => `${x},${y}`).join(' ');

  // ----------------------------------------------------------------------------------------
  // Build the SVG DOM once. Structure (per instance):
  //   <svg viewBox=... preserveAspectRatio="xMidYMid meet" style="width/height:100%;display:block">
  //     <defs><filter id="cf-glow-N"><feGaussianBlur stdDeviation=R/></filter></defs>
  //     <rect class="cf-bg"/>                                  ← inset panel background
  //     <g class="cf-glow" filter="url(#cf-glow-N)">           ← blurred halo (lit only)
  //        …lit copies of every segment / dot (opacity toggled per frame)…
  //     </g>
  //     <g class="cf-crisp">                                   ← sharp face on top
  //        …every segment (dim/lit via fill) + colon + DP dots…
  //     </g>
  //   </svg>
  // Each digit cell is a <g transform="translate(left top)"> with a nested scale for small
  // digits, so the SEG_POLYS stay in glyph units. Colons/DP dots are positioned absolutely.
  // ----------------------------------------------------------------------------------------
  function build() {
    container.innerHTML = '';
    cellEls = [];

    const vbX = -PAD, vbY = -PAD, vbW = layout.W + 2 * PAD, vbH = layout.H + 2 * PAD;
    svg = el('svg', {
      viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    const defs = el('defs');
    const filter = el('filter', {
      id: `cf-glow-${id}`,
      x: '-50%', y: '-50%', width: '200%', height: '200%',
      filterUnits: 'objectBoundingBox',
    });
    filter.appendChild(el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: GLOW_R }));
    defs.appendChild(filter);
    svg.appendChild(defs);

    // Inset background panel (covers the padded viewBox).
    const bg = el('rect', { x: vbX, y: vbY, width: vbW, height: vbH, class: 'cf-bg', fill: tokens.inset });
    svg.appendChild(bg);

    // Glow layer (behind the crisp layer): lit-only copies of every segment/dot, opacity
    // toggled per frame so ONLY lit segments are visible here. A GPU-composited CSS
    // drop-shadow on this group is the LED bloom — because off-segment copies are invisible,
    // unlit digits cast no halo (the crisp layer carries no filter at all). Radius is dialled
    // in resize(); this seed keeps the first paint bloomed before the first resize lands.
    glowGroup = el('g', { class: 'cf-glow' });
    glowGroup.style.filter = 'drop-shadow(0 0 0.3px var(--face-glow, rgba(255,59,46,0.55)))';
    crispGroup = el('g', { class: 'cf-crisp' });
    svg.appendChild(glowGroup);
    svg.appendChild(crispGroup);

    for (const row of layout.rows) {
      const rowCells = [];
      for (const cell of row.cells) {
        if (cell.kind === 'colon') {
          rowCells.push(buildColon(row, cell));
        } else {
          rowCells.push(buildDigit(row, cell));
        }
      }
      cellEls.push(rowCells);
    }

    container.appendChild(svg);
    // refs are wired; caller renders next.
    refs.bg = bg;
  }

  const refs = { bg: null };

  // One digit cell → 7 crisp polys + 7 glow polys (behind) + a DP dot (crisp + glow).
  function buildDigit(row, cell) {
    const box = glyphBox(row, cell);
    // Nested transform: translate to glyph top-left, then scale so SEG_POLYS stay in glyph units.
    const tf = `translate(${box.left} ${box.top}) scale(${box.sc})`;
    const gGlow = el('g', { transform: tf });
    const gCrisp = el('g', { transform: tf });

    const glowSegs = [], crispSegs = [];
    for (let s = 0; s < 7; s++) {
      const pts = polyPoints(SEG_POLYS[s]);
      const gp = el('polygon', { points: pts, fill: tokens.led, opacity: '0' });
      const cp = el('polygon', { points: pts, fill: tokens.ledDim });
      gGlow.appendChild(gp);
      gCrisp.appendChild(cp);
      glowSegs.push(gp);
      crispSegs.push(cp);
    }
    glowGroup.appendChild(gGlow);
    crispGroup.appendChild(gCrisp);

    // DP dot lives in the ROW frame (not glyph-scaled), positioned like the canvas.
    const r = (DP_DIA / 2);
    const dpGlow = el('circle', { r, fill: tokens.led, opacity: '0' });
    const dpCrisp = el('circle', { r, fill: tokens.ledDim, opacity: '0' });
    glowGroup.appendChild(dpGlow);
    crispGroup.appendChild(dpCrisp);

    return { kind: 'digit', row, cell, box, glowSegs, crispSegs, dpGlow, dpCrisp };
  }

  // One colon cell → two dots (top + bottom), each with a crisp + glow circle.
  function buildColon(row, cell) {
    const cx = row.offX + cell.cx;
    const r = GEO.colonDotDia / 2;
    const yTop = row.top + GEO.colonTopY;
    const yBot = row.top + GEO.colonBotY;
    const mk = (cy) => {
      const glow = el('circle', { cx, cy, r, fill: tokens.led, opacity: '0' });
      const crisp = el('circle', { cx, cy, r, fill: tokens.ledDim, opacity: '1' });
      glowGroup.appendChild(glow);
      crispGroup.appendChild(crisp);
      return { glow, crisp };
    };
    return { kind: 'colon', which: cell.which, top: mk(yTop), bot: mk(yBot) };
  }

  // ----------------------------------------------------------------------------------------
  // Per-frame update: recompute the lit model (reusing the canvas logic verbatim) and toggle
  // fills / opacities on the pre-built elements — no DOM churn.
  // ----------------------------------------------------------------------------------------
  function render(when) {
    if (!svg) build();
    const ms = typeof when === 'number' ? when : (when || timeSource()).getTime();
    const f = getFields(ms, state.utc);

    let model;
    if (state.deviceFrame) {
      model = state.deviceFrame; // {dateRow, time}
    } else {
      const fmt = (MODES[state.mode] || MODES.iso8601)(f, state.modeCtx);
      model = { dateRow: fmt.dateRow || '', time: fmt.time };
    }

    // Standard time values (used unless the mode overrides the time row).
    const std = {
      big: [Math.floor(f.h / 10), f.h % 10, Math.floor(f.m / 10), f.m % 10, Math.floor(f.s / 10), f.s % 10],
      small: [Math.floor(f.ms / 100), Math.floor(f.ms / 10) % 10, f.ms % 10],
      dp: state.precision > 0,
      colonsOn: true,
    };
    // precision blanking: P3 all, P2 -ms, P1 -ms-cs, P0 all blank + DP off
    const keep = state.precision; // 0..3
    for (let i = 0; i < 3; i++) if (i >= keep) std.small[i] = 'DASH';

    const timeModel = !model.time ? { mode: 'cells', ...std } : model.time;

    // Colon phase: firmware DMA index (10 ms/step, 200-entry table = 2 s cycle).
    const step = Math.floor(ms / 10) % 200;

    // keep the inset in sync if tokens changed via CSS
    if (refs.bg) refs.bg.setAttribute('fill', tokens.inset);

    for (let ri = 0; ri < layout.rows.length; ri++) {
      const row = layout.rows[ri];
      if (row.type === 'date') renderDateRow(ri, row, model.dateRow);
      else renderTimeRow(ri, row, timeModel, step);
    }
  }

  // Light a single digit cell's 7 segments + optional DP from a byte (byte<0 = fully blank).
  function paintGlyph(desc, byte, dpOn) {
    const b = state.brightness;
    // Diff: most cells are unchanged most frames (only the ms digits move). Skip the DOM
    // writes when byte/dp/brightness/colours all match — this is what keeps SVG cheap.
    const sig = byte + '|' + (dpOn ? 1 : 0) + '|' + b + '|' + tokens.led + '|' + tokens.ledDim;
    if (desc._sig === sig) return;
    desc._sig = sig;
    for (let s = 0; s < 7; s++) {
      const lit = byte >= 0 && segOn(byte, s);
      if (lit) {
        desc.crispSegs[s].setAttribute('fill', tokens.led);
        desc.crispSegs[s].setAttribute('opacity', String(b));
        if (GLOW) { desc.glowSegs[s].setAttribute('fill', tokens.led); desc.glowSegs[s].setAttribute('opacity', String(b)); }
      } else {
        desc.crispSegs[s].setAttribute('fill', tokens.ledDim);
        desc.crispSegs[s].setAttribute('opacity', String(DIM_ALPHA));
        if (GLOW) desc.glowSegs[s].setAttribute('opacity', '0');
      }
    }
    paintDP(desc, dpOn);
  }

  // Position + light the DP dot for a digit cell. Point-reflected when the board is inverted,
  // exactly as the canvas drawDateRow / drawTimeRow do.
  function paintDP(desc, on) {
    const box = desc.box;
    const inv = state.inverted;
    const ox = DP_OFF_X, oy = DP_OFF_Y; // row-frame units (DP dot is not glyph-scaled)
    // canvas uses box.gwPx / box.ghPx (already scaled); here box.gw/box.gh are scaled too.
    const dpX = inv ? box.left - ox : box.left + box.gw + ox;
    const dpY = inv ? box.top + oy : box.top + box.gh - oy;
    desc.dpCrisp.setAttribute('cx', dpX);
    desc.dpCrisp.setAttribute('cy', dpY);
    if (GLOW) { desc.dpGlow.setAttribute('cx', dpX); desc.dpGlow.setAttribute('cy', dpY); }
    if (on) {
      desc.dpCrisp.setAttribute('fill', tokens.led);
      desc.dpCrisp.setAttribute('opacity', String(state.brightness));
      if (GLOW) { desc.dpGlow.setAttribute('fill', tokens.led); desc.dpGlow.setAttribute('opacity', String(state.brightness)); }
    } else {
      // DP fully hidden when off (the canvas draws no dim ghost for DPs).
      desc.dpCrisp.setAttribute('opacity', '0');
      if (GLOW) desc.dpGlow.setAttribute('opacity', '0');
    }
  }

  function renderDateRow(ri, row, str) {
    // Map the string onto 10 cells; '.' lights the previous cell's DP, consumes no cell.
    const cellByte = new Array(10).fill(0);
    const cellDP = new Array(10).fill(false);
    let ci = 0;
    for (const ch of str) {
      if (ch === '.') { if (ci > 0) cellDP[ci - 1] = true; continue; }
      if (ci >= 10) break;
      cellByte[ci] = dateGlyph(ch, state.inverted);
      ci++;
    }
    const rowCells = cellEls[ri];
    for (let i = 0; i < 10; i++) {
      const logical = state.inverted ? 9 - i : i;
      const desc = rowCells[logical];
      paintGlyph(desc, cellByte[i], cellDP[i]);
    }
  }

  function renderTimeRow(ri, row, tm, step) {
    const rowCells = cellEls[ri];
    if (tm.mode === 'off') {
      // standby: blank panel — everything dim/hidden.
      for (const desc of rowCells) {
        if (desc.kind === 'colon') { setColon(desc, 0); continue; }
        paintGlyph(desc, -1, false);
      }
      return;
    }
    const litColon = tm.colonsOn !== false;
    for (let k = 0; k < row.cells.length; k++) {
      const cell = row.cells[k];
      const desc = rowCells[k];
      if (cell.kind === 'colon') {
        const b = litColon ? colonTbl[desc.which][step] : 0;
        setColon(desc, b);
        continue;
      }
      const val = cell.role === 'small' ? tm.small[cell.src] : tm.big[cell.src];
      let byte;
      if (val === 'BLANK') byte = -1;
      else if (val === 'DASH') byte = DASH;
      else byte = LUT_TIME[val] ?? -1;
      const dpOn = !!(cell.dp && tm.dp);
      paintGlyph(desc, byte, dpOn);
    }
  }

  // Set a colon's two dots to intensity b (0..1); mirrors the canvas drawDot: dim ghost
  // always shown, lit copy + glow scaled by brightness*intensity.
  function setColon(desc, b) {
    const on = b > 0.01;
    const key = on ? Math.round(state.brightness * b * 200) : -1; // diff bucket
    for (const dot of [desc.top, desc.bot]) {
      if (dot._k === key) continue; // intensity unchanged — skip DOM write
      dot._k = key;
      if (on) {
        dot.crisp.setAttribute('fill', tokens.led);
        dot.crisp.setAttribute('opacity', String(state.brightness * b));
        if (GLOW) dot.glow.setAttribute('opacity', String(state.brightness * b));
      } else {
        dot.crisp.setAttribute('fill', tokens.ledDim);
        dot.crisp.setAttribute('opacity', '1');
        if (GLOW) dot.glow.setAttribute('opacity', '0');
      }
    }
  }

  // --- loop / lifecycle ----------------------------------------------------------------
  function loop() {
    render(timeSource());
    raf = requestAnimationFrame(loop);
  }

  build();
  render();

  return {
    setMode(name, modeCtx) { state.mode = name; if (modeCtx) state.modeCtx = modeCtx; state.deviceFrame = null; render(); },
    setModeCtx(modeCtx) { state.modeCtx = { ...state.modeCtx, ...modeCtx }; render(); },
    setColonMode(name) { if (COLON_MODES.includes(name)) { state.colonMode = name; colonTbl = buildColonTables(name); } render(); },
    setBrightness(b) { state.brightness = Math.max(0, Math.min(1, b)); render(); },
    setPrecision(p) { state.precision = Math.max(0, Math.min(3, p | 0)); render(); },
    setInverted(flag) { state.inverted = !!flag; render(); },
    setUTC(flag) { state.utc = !!flag; render(); },
    setRows(rows) { state.rows = rows; layout = buildLayout(rows); build(); render(); },
    setTokens(t) { tokens = resolveTokens(t); render(); },
    refreshTokens() { tokens = resolveTokens(); render(); },
    applyDeviceFrame(frame) { state.deviceFrame = frame; render(); },
    clearDeviceFrame() { state.deviceFrame = null; render(); },
    setClockOffset(ms) { clockOffsetMs = Number.isFinite(ms) ? ms : 0; },
    // Graceful standby: fade the lit digits to dark over ~0.8s (like the firmware's DAC
    // ramp) instead of a hard blank. The board bg stays; the digits keep updating under
    // the fade, so waking shows the current time. CSS opacity transition = GPU-cheap.
    setStandby(on) { crispGroup.style.transition = 'opacity .8s ease'; crispGroup.style.opacity = on ? '0' : '1'; },
    render,
    start(src) { if (raf || destroyed) return; if (src) timeSource = src; loop(); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    // SVG auto-scales via the viewBox, so a resize is just a re-render — EXCEPT the LED bloom.
    // The drop-shadow radius on this <g> is in the SVG's user units, so it magnifies with the
    // viewBox→viewport scale; a value that flatters the big docked face would smear the tiny
    // menu-bar clock's dense fraction digits. Scale it DOWN with rendered height so the halo
    // stays a tight, even glow at every size. Applied to the lit-only glow layer (see above).
    resize(w, h) {
      if (h && glowGroup) {
        const blur = Math.max(0.18, h / 900).toFixed(3);
        glowGroup.style.filter = `drop-shadow(0 0 ${blur}px var(--face-glow, rgba(255,59,46,0.55)))`;
      }
      render();
    },
    destroy() { cancelAnimationFrame(raf); raf = 0; destroyed = true; if (svg && svg.parentNode) svg.parentNode.removeChild(svg); },
    get state() { return { ...state }; },
    // Sanity check: layout built, elements created, colon tables sized.
    selfTest() {
      const digitCount = cellEls.flat().filter((d) => d.kind === 'digit').length;
      return {
        ok: layout.W > 0 && layout.H > 0 && digitCount > 0 && colonTbl.L.length === 200,
        W: layout.W, H: layout.H, digitCount,
        colonCount: cellEls.flat().filter((d) => d.kind === 'colon').length,
      };
    },
    COLON_MODES, MODES: Object.keys(MODES),
  };
}
