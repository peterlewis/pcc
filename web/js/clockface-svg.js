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

// ---- physical board furniture (buttons / edge screws / light sensor) --------------------------
// The digit cells put physical x=18 mm at viewBox 0, and 34.2 mm = 1 viewBox unit, so any feature
// from precision-clock.scad maps straight in. Features live in the letterbox gaps the board panel
// already leaves either side of the digits — no board resize. y is a fraction of the 34.56 mm pane.
const HW_VBX = (mm) => (mm - 18) / 34.2;      // board-frame mm → viewBox x
const HW_VBR = (mm) => mm / 34.2;             // mm radius → viewBox
const HW_SCREW_R = HW_VBR(3.0);               // 6 mm across — Torx heads, one size everywhere
// SYMMETRIC board: each half draws a 12 mm nubbin + 240 mm of digits (x 18→258) + 12 mm nubbin,
// i.e. x=6→270 (264 mm). Digits are already centred (30…246 = 24 mm from each board edge), so both
// end nubbins are a clean 12 mm — no "extra bit". The two 12 mm inner nubbins meet at the centre as a
// 24 mm strip that the 24 mm hinge link-plate covers exactly, so the seam still reads tight (no gap).
const HW_BOARD_L = HW_VBX(6), HW_BOARD_R = HW_VBX(270);
const HW_BOARD_ASPECT = 264 / 34.56;          // = M.W / M.H of the rendered 264 mm board (no letterbox)
// Data-driven furniture — a flat, editable list (x in board mm, y as 0..1 of the 34.56 mm pane).
// The calibration overlay drags these and reports mm back so the positions can be dialled in.
const DEFAULT_HW = [
  { id: 'd-btn-1', row: 'date', kind: 'button', x: 268, y: 0.4, r: 1.5 },
  { id: 'd-btn-2', row: 'date', kind: 'button', x: 268, y: 0.6, r: 1.5 },
  { id: 'd-scr-1', row: 'date', kind: 'screw', x: 268, y: 0.189 },
  { id: 'd-scr-2', row: 'date', kind: 'screw', x: 268, y: 0.812 },
  { id: 'd-hng-0', row: 'date', kind: 'screw', x: 8, y: 0.812 },  // hinge mounting bolts (beneath the pins)
  { id: 'd-hng-1', row: 'date', kind: 'screw', x: 8, y: 0.174 },
  { id: 'd-hng-2', row: 'date', kind: 'screw', x: 8, y: 0.5 },
  { id: 't-sensor', row: 'time', kind: 'sensor', x: 268, y: 0.5, r: 2 },
  { id: 't-scr-1', row: 'time', kind: 'screw', x: 268, y: 0.189 },
  { id: 't-scr-2', row: 'time', kind: 'screw', x: 268, y: 0.812 },
  { id: 't-hng-0', row: 'date', kind: 'screw', x: 9, y: 0.812 },
  { id: 't-hng-1', row: 'time', kind: 'screw', x: 9, y: 0.5 },
  { id: 't-hng-2', row: 'time', kind: 'screw', x: 9, y: 0.826 },
  // GPS SMA jack + USB port — the two signature right-edge fittings the face was missing. Positions
  // are PLACEHOLDERS (drag-to-calibrate via the overlay); they fold into a saved config as new items.
  { id: 't-ant', row: 'time', kind: 'antenna', x: 268, y: 0.33, r: 2.6 },
  { id: 't-usb', row: 'time', kind: 'usb', x: 268, y: 0.67, r: 2.4 },
];
// (Removed HW_SPEC — a never-read structured constant that disagreed with DEFAULT_HW on button
// positions and screw radii, so editing it changed nothing on screen. DEFAULT_HW, consumed by
// buildHardware, is the single source of truth for board-furniture geometry.)
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
    hardware: !!opts.hardware,   // render the physical board furniture (buttons / screws / light sensor)
    onButton: opts.onButton || null,
    hwSpec: opts.hwSpec || null,        // flat list [{id,row,kind,x(mm),y(0..1 of pane),r?}] — data-driven
    hwCalibrate: !!opts.hwCalibrate,    // calibration overlay: mm grid + draggable handles + readout
    onHwMove: opts.onHwMove || null,    // (id, {x_mm, y_frac}) as a feature is dragged
  };
  let vbParams = null;   // last viewBox {x,y,w,h} — for pointer→mm mapping while calibrating
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

    let vbX = -PAD, vbW = layout.W + 2 * PAD, vbY = -PAD, vbH = layout.H + 2 * PAD;
    // Hardware faces render the symmetric board (x 6..270 = 12mm nubbin + digits + 12mm nubbin) at
    // exactly the half-div aspect, so the SVG fills the div with no letterbox and the digits stay where
    // they physically sit — the furniture lands in the 12mm end nubbins, single width, no doubling.
    if (state.hardware) {
      vbX = HW_BOARD_L; vbW = HW_BOARD_R - HW_BOARD_L;
      vbH = vbW / HW_BOARD_ASPECT;
      const rowMidY = (layout.rows[0] ? layout.rows[0].top : 0) + GEO.cellH / 2;
      vbY = rowMidY - vbH / 2;
    }
    vbParams = { x: vbX, y: vbY, w: vbW, h: vbH };
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
    // In the hardware-calibration overlay, fade the lit digits back to 50% so the furniture
    // handles and mm grid read clearly against them (build() re-runs on toggle, so no reset needed).
    if (state.hwCalibrate) { glowGroup.style.opacity = '0.5'; crispGroup.style.opacity = '0.5'; }

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

    if (state.hardware) buildHardware();

    container.appendChild(svg);
    // refs are wired; caller renders next.
    refs.bg = bg;
  }

  const refs = { bg: null };

  // Physical board furniture, drawn into the letterbox gaps (no glow — it isn't an LED).
  function buildHardware() {
    const g = el('g', { class: 'cf-hw' });
    const uw = 0.014;   // viewBox stroke width (~0.5 mm)
    // Bauhaus / Jony-Ive furniture: flat, matte, monochrome. Pure geometric circles, a single hairline
    // outline, no bevels, gloss or catch-lights — the parts read as precise dark forms, not shiny props.
    const HW_MATTE = '#17191d';   // screw / sensor body — a flat step above the near-black board
    const HW_CAP   = '#202329';   // button cap — a hair lighter so it reads as pressable
    const HW_LINE  = '#2b2f38';   // single hairline outline (matches the clock bezel)
    const HW_EYE   = '#0b0c0f';   // recessed sensor aperture (darker than the board)
    const screw = (x, y, r) => {
      g.appendChild(el('circle', { cx: x, cy: y, r, fill: HW_MATTE, stroke: HW_LINE, 'stroke-width': uw }));
      g.appendChild(el('circle', { cx: x, cy: y, r: r * 0.5, fill: 'none', stroke: HW_LINE, 'stroke-width': uw * 0.85 }));  // one concentric fastener ring
    };
    const sensor = (x, y, r) => {
      g.appendChild(el('circle', { cx: x, cy: y, r, fill: HW_MATTE, stroke: HW_LINE, 'stroke-width': uw }));   // flat holder
      g.appendChild(el('circle', { cx: x, cy: y, r: r * 0.42, fill: HW_EYE }));                                 // flat aperture — no lens dome
    };
    // Gold SMA jack — the GPS antenna connector, the clock's most functionally-signature edge
    // fitting: a warm hex nut ring around a bright centre pin, distinct from the grey furniture.
    const HW_GOLD = '#b9975a';
    const antenna = (x, y, r) => {
      const pts = [];
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 6; pts.push(`${(x + r * Math.cos(a)).toFixed(2)},${(y + r * Math.sin(a)).toFixed(2)}`); }
      g.appendChild(el('polygon', { points: pts.join(' '), fill: HW_MATTE, stroke: HW_GOLD, 'stroke-width': uw }));  // hex nut
      g.appendChild(el('circle', { cx: x, cy: y, r: r * 0.34, fill: HW_GOLD }));                                     // centre pin
    };
    // USB port — a small rounded rectangle (the Type-C receptacle mouth).
    const usb = (x, y, r) => {
      const wdt = r * 2.0, hgt = r * 0.95;
      g.appendChild(el('rect', { x: x - wdt / 2, y: y - hgt / 2, width: wdt, height: hgt, rx: hgt * 0.5, fill: HW_EYE, stroke: HW_LINE, 'stroke-width': uw }));
    };
    const button = (x, y, r, idx) => {
      const ring = el('circle', { cx: x, cy: y, r: r * 1.15, fill: 'none', stroke: HW_LINE, 'stroke-width': uw });  // recess outline
      const cap = el('circle', { cx: x, cy: y, r, fill: HW_CAP, stroke: HW_LINE, 'stroke-width': uw });              // flat tactile cap
      g.appendChild(ring); g.appendChild(cap);
      if (state.onButton || state.onButtonDown) {
        const hit = el('circle', { cx: x, cy: y, r: r * 1.5, fill: 'transparent' });   // generous tap target
        hit.style.cursor = 'pointer';
        // Chord-aware wiring: press/release drive the date-board chord protocol (hold BOTH to enter
        // the menu). When the controller supplies onButtonDown/Up we use those and DON'T also fire
        // the click (the release IS the tap); a bare onButton falls back to the old click behaviour.
        if (state.onButtonDown) {
          hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); cap.setAttribute('fill', HW_MATTE); state.onButtonDown(idx); });
          const up = (e) => { cap.setAttribute('fill', HW_CAP); if (state.onButtonUp) state.onButtonUp(idx); };
          hit.addEventListener('pointerup', up); hit.addEventListener('pointerleave', up); hit.addEventListener('pointercancel', up);
        } else {
          hit.addEventListener('click', (e) => { e.stopPropagation(); state.onButton(idx); });
          hit.addEventListener('pointerdown', () => cap.setAttribute('fill', HW_MATTE));
          const up = () => cap.setAttribute('fill', HW_CAP);
          hit.addEventListener('pointerup', up); hit.addEventListener('pointerleave', up);
        }
        g.appendChild(hit);
      }
    };
    const rowType = layout.rows[0] && layout.rows[0].type;
    const rowTop = layout.rows[0] ? layout.rows[0].top : 0;
    const cy = (frac) => rowTop + frac * GEO.cellH;
    if (state.hwCalibrate) drawCalibGrid(g, uw, rowTop);
    const items = (state.hwSpec && state.hwSpec.length) ? state.hwSpec : DEFAULT_HW;
    for (const it of items) {
      if (it.row !== rowType) continue;
      const x = HW_VBX(it.x), y = cy(it.y);
      if (it.kind === 'screw') screw(x, y, HW_VBR(it.r || 2.5));   // r in mm (radius); 2.5 = 5 mm heads
      else if (it.kind === 'sensor') sensor(x, y, HW_VBR(it.r || 2.5));
      else if (it.kind === 'button') button(x, y, HW_VBR(it.r || 2.7), it.id);
      else if (it.kind === 'antenna') antenna(x, y, HW_VBR(it.r || 2.6));   // gold SMA jack
      else if (it.kind === 'usb') usb(x, y, HW_VBR(it.r || 2.4));           // USB receptacle
      if (state.hwCalibrate) addHandle(g, x, y, it, rowTop);
    }
    svg.appendChild(g);
  }

  // pointer → board coords (mm x, 0..1 pane-frac y), undoing the date board's 180° container flip.
  function pointerToBoard(clientX, clientY, rowTop) {
    const rect = svg.getBoundingClientRect();
    let fx = (clientX - rect.left) / rect.width, fy = (clientY - rect.top) / rect.height;
    if (state.inverted) { fx = 1 - fx; fy = 1 - fy; }
    const vx = vbParams.x + fx * vbParams.w, vy = vbParams.y + fy * vbParams.h;
    return { x: Math.round((vx * 34.2 + 18) * 10) / 10, y: Math.round(((vy - rowTop) / GEO.cellH) * 1000) / 1000, vx, vy };
  }
  // Calibration mm grid: faint lines every 6 mm, board edges + hinge + digit-cell markers.
  function drawCalibGrid(g, uw, rowTop) {
    const gc = 'var(--beta,#f5b53d)';
    // Faint, uniform measurement grid (6 mm ticks) — no digit-cell 'centre line' emphasis. The
    // reference lines that matter are the per-component separators drawn in addHandle(), so the
    // furniture aligns to the actual parts (and the hinge), not to cell centres.
    for (let mm = 6; mm <= 271; mm += 6) {
      const x = HW_VBX(mm);
      g.appendChild(el('line', { x1: x, y1: rowTop - 0.02, x2: x, y2: rowTop + GEO.cellH + 0.02, stroke: gc, 'stroke-width': uw * 0.35, opacity: 0.14 }));
    }
    for (let f = 0; f <= 1.0001; f += 0.1) g.appendChild(el('line', { x1: HW_VBX(6), y1: rowTop + f * GEO.cellH, x2: HW_VBX(270), y2: rowTop + f * GEO.cellH, stroke: gc, 'stroke-width': uw * 0.35, opacity: 0.12 }));
    // hinge line — the one physical reference kept (seam of the unfolded clock, x = 12 mm)
    g.appendChild(el('line', { x1: HW_VBX(12), y1: rowTop, x2: HW_VBX(12), y2: rowTop + GEO.cellH, stroke: gc, 'stroke-width': uw * 1.0, opacity: 0.55 }));
  }
  // A draggable handle + live mm label on a feature (calibration only).
  function addHandle(g, x, y, it, rowTop) {
    const gc = 'var(--beta,#f5b53d)';
    // Per-component separator: a full-height reference line through THIS part's centre, so every
    // piece is aligned to the real components (and the hinge), not to abstract cell centres.
    const refLine = el('line', { x1: x, y1: rowTop - 0.02, x2: x, y2: rowTop + GEO.cellH + 0.02, stroke: gc, 'stroke-width': 0.01, opacity: 0.55, 'stroke-dasharray': '0.055 0.045' });
    const ring = el('circle', { cx: x, cy: y, r: HW_VBR(4.6), fill: 'rgba(245,181,61,.10)', stroke: gc, 'stroke-width': 0.02 });
    ring.style.cursor = 'move';
    const label = el('text', { x, y: y - HW_VBR(6.2), fill: gc, 'font-size': '0.085', 'text-anchor': 'middle', 'font-family': 'monospace', 'paint-order': 'stroke', stroke: '#000', 'stroke-width': 0.01 });
    const setLabel = (mx, my) => { label.textContent = it.id + '  ' + mx.toFixed(0) + ',' + Math.round(my * 34.56); };
    setLabel(it.x, it.y);
    let dragging = false;
    ring.addEventListener('pointerdown', (e) => { dragging = true; e.stopPropagation(); try { ring.setPointerCapture(e.pointerId); } catch (x2) {} });
    ring.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const b = pointerToBoard(e.clientX, e.clientY, rowTop);
      ring.setAttribute('cx', b.vx); ring.setAttribute('cy', b.vy);
      refLine.setAttribute('x1', b.vx); refLine.setAttribute('x2', b.vx);
      label.setAttribute('x', b.vx); label.setAttribute('y', b.vy - HW_VBR(6.2)); setLabel(b.x, b.y);
      if (state.onHwMove) state.onHwMove(it.id, { x: b.x, y: b.y, final: false });
    });
    const end = (e) => { if (!dragging) return; dragging = false; const b = pointerToBoard(e.clientX, e.clientY, rowTop); if (state.onHwMove) state.onHwMove(it.id, { x: b.x, y: b.y, final: true }); };
    ring.addEventListener('pointerup', end); ring.addEventListener('pointercancel', end);
    g.appendChild(refLine); g.appendChild(ring); g.appendChild(label);
  }

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

  // One colon cell → two dots (top + bottom), each with a crisp + glow circle. The dots ride the
  // same 10° italic lean as the digits: shear each dot's x by its height about the cell centre
  // (matches the canvas face's colon shear).
  function buildColon(row, cell) {
    const cxBase = row.offX + cell.cx;
    const r = GEO.colonDotDia / 2;
    const shear = (cy) => cxBase + (GEO.cellH / 2 - cy) * (GLYPH.slant || 0);
    const mk = (cx, cy) => {
      const glow = el('circle', { cx, cy, r, fill: tokens.led, opacity: '0' });
      const crisp = el('circle', { cx, cy, r, fill: tokens.ledDim, opacity: '1' });
      glowGroup.appendChild(glow);
      crispGroup.appendChild(crisp);
      return { glow, crisp, cx, cy };   // cx/cy retained for segGeometry()
    };
    return {
      kind: 'colon', which: cell.which,
      top: mk(shear(GEO.colonTopY), row.top + GEO.colonTopY),
      bot: mk(shear(GEO.colonBotY), row.top + GEO.colonBotY),
    };
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

    // Colon phase: firmware DMA index (10 ms/step, 200-entry table = 2 s cycle). When the source
    // provides the firmware's REAL phase (emulator/device deviceFrame), lock to it so the colon
    // animates with the PPS-disciplined second, not free-running host ms.
    const step = (timeModel && timeModel.colonStep != null) ? (timeModel.colonStep % 200) : (Math.floor(ms / 10) % 200);

    // keep the inset in sync if tokens changed via CSS
    if (refs.bg) refs.bg.setAttribute('fill', tokens.inset);

    // SHOWCASE override: an explicit per-element intensity field (set via setSegField) paints
    // instead of the model. The model above was still computed — callers can keep pushing device
    // frames while the field drives the pixels, so dropping the field lands on live time instantly.
    if (state.segField) { renderField(state.segField); return; }

    for (let ri = 0; ri < layout.rows.length; ri++) {
      const row = layout.rows[ri];
      if (row.type === 'date') renderDateRow(ri, row, model.dateRow);
      else renderTimeRow(ri, row, timeModel, step);
    }
  }

  // ----------------------------------------------------------------------------------------
  // Per-element intensity field (the SHOWCASE surface). A field is an array aligned with this
  // face's cells: digits {segs:[7 x 0..1], dp:0..1}, colons {a:0..1, b:0..1}. Values are linear
  // light; the ghost floor rule matches setColon (an element never dims below the unlit ghost).
  // ----------------------------------------------------------------------------------------
  // Field painting is CONTINUOUS: unlike setColon's on/off rule (where anything at or below the
  // ghost must rest ON the ghost), a 16-level dither surface needs its bottom half. v <= 0.02 is
  // "off" (the unlit ghost); anything above paints lit red from a faint floor upward, so a 2/16
  // x-ray level is visibly a faint red digit, not indistinguishable from unlit.
  const FIELD_FLOOR = 0.10;
  function paintSegLevel(desc, s, v) {
    const litOp = v > 0.02 ? Math.max(FIELD_FLOOR, state.brightness * v) : 0;
    const key = litOp > 0 ? Math.round(litOp * 200) : -1;
    const cp = desc.crispSegs[s], gp = desc.glowSegs[s];
    if (cp._fk === key) return;
    cp._fk = key;
    if (key >= 0) {
      cp.setAttribute('fill', tokens.led); cp.setAttribute('opacity', String(litOp));
      if (GLOW) { gp.setAttribute('fill', tokens.led); gp.setAttribute('opacity', String(litOp)); }
    } else {
      cp.setAttribute('fill', tokens.ledDim); cp.setAttribute('opacity', String(DIM_ALPHA));
      if (GLOW) gp.setAttribute('opacity', '0');
    }
  }
  function paintDotLevel(dot, v) {
    const litOp = v > 0.02 ? Math.max(FIELD_FLOOR, state.brightness * v) : 0;
    const key = litOp > 0 ? Math.round(litOp * 200) : -1;
    if (dot._fk === key) return;
    dot._fk = key;
    if (key >= 0) {
      dot.crisp.setAttribute('fill', tokens.led); dot.crisp.setAttribute('opacity', String(litOp));
      if (GLOW) dot.glow.setAttribute('opacity', String(litOp));
    } else {
      dot.crisp.setAttribute('fill', tokens.ledDim); dot.crisp.setAttribute('opacity', String(DIM_ALPHA));
      if (GLOW) dot.glow.setAttribute('opacity', '0');
    }
  }
  function renderField(field) {
    const rowCells = cellEls[0];
    if (!rowCells) return;
    for (let i = 0; i < rowCells.length; i++) {
      const desc = rowCells[i], fv = field[i];
      if (!desc || !fv) continue;
      if (desc.kind === 'colon') { paintDotLevel(desc.top, fv.a || 0); paintDotLevel(desc.bot, fv.b || 0); continue; }
      desc._sig = null;   // field writes bypass paintGlyph's diff — invalidate so normal render repaints
      for (let s = 0; s < 7; s++) paintSegLevel(desc, s, (fv.segs && fv.segs[s]) || 0);
      const dpv = fv.dp || 0;
      // reuse paintDP's positioning, but with continuous intensity
      paintDP(desc, dpv > 0.02, Math.max(dpv, 0));
    }
  }

  // The intensity field the NORMAL renderer would paint for a given device frame — the live
  // "glyph mask" (0/1 per segment × fades × the real colon table value). Pure; no DOM.
  function computeField(model, when) {
    const ms = typeof when === 'number' ? when : Date.now();
    const tm = model.time || { mode: 'off' };
    const step = (tm.colonStep != null) ? (tm.colonStep % 200) : (Math.floor(ms / 10) % 200);
    const out = [];
    const row = layout.rows[0];
    if (!row) return out;
    if (row.type === 'date') {
      const str = model.dateRow || '';
      const cellByte = new Array(10).fill(0), cellDP = new Array(10).fill(false);
      let ci = 0;
      for (const ch of str) {
        if (ch === '.') { if (ci > 0) cellDP[ci - 1] = true; continue; }
        if (ci >= 10) break;
        cellByte[ci] = dateGlyph(ch, state.inverted); ci++;
      }
      for (let i = 0; i < 10; i++) {
        const logical = state.inverted ? 9 - i : i;
        const segs = new Array(7).fill(0);
        for (let s = 0; s < 7; s++) if (cellByte[i] >= 0 && segOn(cellByte[i], s)) segs[s] = 1;
        out[logical] = { segs, dp: cellDP[i] ? 1 : 0 };
      }
      return out;
    }
    for (let k = 0; k < row.cells.length; k++) {
      const cell = row.cells[k];
      if (cell.kind === 'colon') {
        const b = (tm.mode !== 'off' && tm.colonsOn !== false) ? colonTbl[cell.which][step] : 0;
        out[k] = { a: b, b };
        continue;
      }
      if (tm.mode === 'off') { out[k] = { segs: new Array(7).fill(0), dp: 0 }; continue; }
      const val = cell.role === 'small' ? tm.small[cell.src] : tm.big[cell.src];
      let byte;
      if (val === 'BLANK') byte = -1;
      else if (val === 'DASH') byte = DASH;
      else byte = LUT_TIME[val] ?? -1;
      const fade = (cell.role === 'small' && tm.smallFade) ? (tm.smallFade[cell.src] ?? 1) : 1;
      const segs = new Array(7).fill(0);
      for (let s = 0; s < 7; s++) if (byte >= 0 && segOn(byte, s)) segs[s] = fade;
      const dpOn = !!(cell.dp && tm.dp);
      out[k] = { segs, dp: dpOn ? (tm.dpFade != null ? tm.dpFade : 1) : 0 };
    }
    return out;
  }

  // Element geometry for choreography: per cell, the centroid of each segment / dot / DP in
  // viewBox units, plus the viewBox itself and the inversion flag (the date board is rotated
  // 180° by its container — callers flip to get visual coordinates).
  function computeGeometry() {
    const els = [];
    const rowCells = cellEls[0] || [];
    for (let i = 0; i < rowCells.length; i++) {
      const desc = rowCells[i];
      if (desc.kind === 'colon') {
        els.push({ cell: i, kind: 'colon', which: desc.which,
          a: { x: desc.top.cx, y: desc.top.cy }, b: { x: desc.bot.cx, y: desc.bot.cy } });
        continue;
      }
      const box = desc.box;
      const segs = SEG_POLYS.map((poly) => {
        let sx = 0, sy = 0;
        for (const p of poly) { sx += p[0]; sy += p[1]; }
        return { x: box.left + (sx / poly.length) * box.sc, y: box.top + (sy / poly.length) * box.sc };
      });
      const inv = state.inverted;
      const dp = { x: inv ? box.left - DP_OFF_X : box.left + box.gw + DP_OFF_X,
                   y: inv ? box.top + DP_OFF_Y : box.top + box.gh - DP_OFF_Y };
      els.push({ cell: i, kind: 'digit', role: desc.cell.role || 'date', src: desc.cell.src, segs, dp });
    }
    return { els, vb: { ...vbParams }, inverted: !!state.inverted };
  }

  // Light a single digit cell's 7 segments + optional DP from a byte (byte<0 = fully blank).
  // fade (0..1): holdover-significance multiplier — dims this digit toward black as it loses
  // significance. dpFade: the same for the decimal point. Both default to 1 (fully lit).
  function paintGlyph(desc, byte, dpOn, fade, dpFade) {
    if (fade == null) fade = 1;
    if (dpFade == null) dpFade = 1;
    const b = state.brightness * fade;   // lit-segment opacity
    const gh = DIM_ALPHA * fade;         // off-segment ghost fades with the digit (→ true black at 0)
    // Diff: most cells are unchanged most frames (only the ms digits move). Skip the DOM writes
    // when byte/dp/brightness/fade/colours all match — this is what keeps SVG cheap.
    const sig = byte + '|' + (dpOn ? 1 : 0) + '|' + state.brightness + '|' + fade + '|' + dpFade + '|' + (state.inverted ? 1 : 0) + '|' + tokens.led + '|' + tokens.ledDim;
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
        desc.crispSegs[s].setAttribute('opacity', String(gh));
        if (GLOW) desc.glowSegs[s].setAttribute('opacity', '0');
      }
    }
    paintDP(desc, dpOn, dpFade);
  }

  // Position + light the DP dot for a digit cell. Point-reflected when the board is inverted,
  // exactly as the canvas drawDateRow / drawTimeRow do.
  function paintDP(desc, on, fade) {
    if (fade == null) fade = 1;
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
      desc.dpCrisp.setAttribute('opacity', String(state.brightness * fade));
      if (GLOW) { desc.dpGlow.setAttribute('fill', tokens.led); desc.dpGlow.setAttribute('opacity', String(state.brightness * fade)); }
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
      // Holdover-significance fade (emulator/device frames only): the sub-second digits dim toward
      // black per digit_bright[], the DP by dpFade. Absent (standby / no fade) → 1, i.e. no change.
      const fade = (cell.role === 'small' && tm.smallFade) ? (tm.smallFade[cell.src] ?? 1) : 1;
      const dpFade = tm.dpFade != null ? tm.dpFade : 1;
      paintGlyph(desc, byte, dpOn, fade, dpFade);
    }
  }

  // Set a colon's two dots to animation intensity b (0..1). The dot tracks brightness exactly like
  // a lit digit segment (paintGlyph uses state.brightness*fade as its opacity), so the colon
  // animates at EVERY brightness and through the boot-reveal ramp — the old fixed 0.5 floor gated
  // 'lit' on brightness*b, which clamped the whole animation to a grey ghost below ~59% brightness
  // (and froze it entirely during boot). The 'lit vs ghost' decision is now driven by b itself (the
  // animation phase), not by brightness, so only the animation's dark point (b≈0) rests on the same
  // ghost as an unlit segment.
  function setColon(desc, b) {
    const litOp = state.brightness * b;
    const lit = b > 0.02;
    const key = lit ? Math.round(litOp * 200) : -1; // diff bucket (-1 == resting on the ghost)
    for (const dot of [desc.top, desc.bot]) {
      if (dot._k === key) continue; // intensity unchanged — skip DOM write
      dot._k = key;
      if (lit) {
        dot.crisp.setAttribute('fill', tokens.led);
        dot.crisp.setAttribute('opacity', String(litOp));
        if (GLOW) dot.glow.setAttribute('opacity', String(litOp));
      } else {
        dot.crisp.setAttribute('fill', tokens.ledDim);
        dot.crisp.setAttribute('opacity', String(DIM_ALPHA)); // same ghost as an unlit segment
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
    // SHOWCASE surface: explicit per-element intensity field (null → back to the live model),
    // the live glyph-mask the model WOULD paint, and element geometry for choreography.
    setSegField(field) { state.segField = field; render(); },
    computeField,
    segGeometry() { if (!svg) build(); return computeGeometry(); },
    setHwSpec(list) { state.hwSpec = list; if (state.hardware) { build(); render(); } },
    setHwCalibrate(on) { state.hwCalibrate = !!on; if (state.hardware) { build(); render(); } },
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
