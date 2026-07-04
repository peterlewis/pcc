// clockface.js — pixel-faithful Precision Clock Mk IV display emulator.
//
// All glyph fonts, colon waveforms and physical dimensions are taken verbatim from the
// device firmware/CAD. Sources of record (see EMULATOR_SPEC.md):
//   clock4/mk4-date/Core/Src/main.c   — date board font (lut_7seg / lut_7seg_inv)
//   clock4/mk4-time/Core/Src/main.c   — time board, colon animation table, display modes
//   clock4/mk4-time/Core/Inc/main.h   — segment #defines, colon-mode enum
//   clock4/cad/colons.scad            — physical cell / colon geometry (RevD)
//
// Renders with no hardware attached (standalone precision-clock emulator) and mirrors a
// live device via applyDeviceFrame().

// ----------------------------------------------------------------------------------------
// 1. FONTS  (generated directly from firmware; both boards decode as a..g = bit0..bit6)
// ----------------------------------------------------------------------------------------

// DATE board, lut_7seg — ASCII-32 indexed (index 0 = ' ' = 0x20), 95 entries (0x20..0x7E).
// 64 (0b01000000, seg g only) = firmware "unsupported char" sentinel; renders as '-'.
export const LUT_DATE = [
  0, 64, 34, 64, 64, 64, 64, 2, 57, 15, 64, 64, 64, 64, 64, 82,
  63, 6, 91, 79, 102, 109, 125, 7, 127, 111, 64, 64, 64, 64, 64, 64,
  64, 119, 124, 57, 94, 121, 113, 61, 116, 6, 30, 117, 56, 21, 84, 63,
  115, 103, 80, 109, 120, 62, 98, 42, 118, 110, 91, 57, 100, 15, 35, 8,
  32, 119, 124, 88, 94, 121, 113, 61, 116, 4, 30, 117, 56, 85, 84, 92,
  115, 103, 80, 109, 120, 28, 98, 106, 118, 110, 91, 57, 64, 15, 64,
];

// DATE board rotated half (board mounted upside-down): lut_7seg_inv. Same indexing.
export const LUT_DATE_INV = [
  0, 64, 20, 64, 64, 64, 64, 16, 15, 57, 64, 64, 64, 64, 64, 82,
  63, 48, 91, 121, 116, 109, 111, 56, 127, 125, 64, 64, 64, 64, 64, 64,
  64, 126, 103, 15, 115, 79, 78, 47, 102, 48, 51, 110, 7, 42, 98, 63,
  94, 124, 66, 109, 71, 55, 84, 21, 118, 117, 91, 15, 100, 57, 28, 1,
  4, 126, 103, 67, 115, 79, 78, 47, 102, 32, 51, 110, 7, 106, 98, 99,
  94, 124, 66, 109, 71, 35, 84, 85, 118, 117, 91, 15, 64, 57, 64,
];

// TIME board, cLut (= cSegDecode0..9) — digit-indexed 0..9. Byte-identical to date digits.
export const LUT_TIME = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];

const DASH = 64; // seg g only — precision-blank / unsupported glyph

const SEG = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6 };
const segOn = (byte, seg) => (byte >> seg) & 1;
const dateGlyph = (ch, inv) => {
  const i = ch.charCodeAt(0) - 32;
  return i < 0 || i > 94 ? 0 : (inv ? LUT_DATE_INV : LUT_DATE)[i];
};

// ----------------------------------------------------------------------------------------
// 2. GEOMETRY  (normalised to digit-cell-height H = 1.0 = 34.2 mm, RevD; from colons.scad)
// ----------------------------------------------------------------------------------------
const GEO = {
  cellH: 1.0, // 34.2 mm  (the unit)
  cellW: 0.7018, // 24.0 mm  digit cell — confirmed by the board layout (see below)
  pitch: 0.7018, // 24.0 mm  cell centre-to-centre (cells abut; the glyph sits inside)
  gap: 0.0, //  0 mm  the 24 mm cell already carries the spacing
  colonDotDia: 0.0921, //  3.15 mm
  colonTopY: 0.6652, // 22.75 mm from cell top
  colonBotY: 0.3348, // 11.45 mm from cell top  (Δ = 11.3 mm)
};

// Within-digit 7-seg geometry from the LED part DATASHEET (KYX-1106AS/BS, 1"):
//   package 24.0 × 34.0 mm · digit 14.0 W × 25.4 H mm · segment 2.5 mm · italic lean 10°.
// The unit H = 34.2 mm (the 34 mm package ≈ the 34.2 mm cover); everything below is ×H.
const GLYPH = {
  w: 0.4094, // 14.0 mm  glyph width  (aspect 14.0/25.4 = 0.551)
  h: 0.7427, // 25.4 mm  glyph height (the 1" digit inside the 34 mm package)
  thick: 0.0731, //  2.5 mm  segment thickness
  miter: 0.0149, // corner miter offset = 0.020 × GH
  midGap: 0.0305, // vertical clearance about g at the segment cuts = 0.041 × GH
  gTip: 0.0446, // g tip inset from the glyph sides = 0.060 × GH
  slant: 0.1763, // tan(10°) — the datasheet italic lean
};
const SMALL_SCALE = 1; // sub-second fraction digits — SAME LED part as the seconds (equal seven segments)
const ROW_GAP = 0.34; // gap between date row and time row (×H)
const DP_DIA = 0.0824; // decimal-point dot diameter (×H) = 0.111 × GH
const DP_OFF_X = 0.0579; // DP centre beyond the glyph's right edge (×H)
const DP_OFF_Y = 0.0363; // DP centre above the glyph's bottom edge (×H)
const COLON_W = 0.3509; // 12.0 mm  colon cell — half a digit cell (board layout)

const DEFAULT_TOKENS = {
  led: '#ff3b2e',
  ledDim: '#4d1813',
  ledGlow: 'rgba(255,59,46,0.55)',
  inset: '#040506',
};

// ----------------------------------------------------------------------------------------
// 3. SEGMENT GEOMETRY — measured construction: trapezoid horizontals, double-cut verticals
//    nesting a pointed g, uniform miter air gaps, sheared by the italic lean.
// ----------------------------------------------------------------------------------------
function buildSegPolys() {
  const W = GLYPH.w, H = GLYPH.h, t = GLYPH.thick, m = GLYPH.miter, cg = GLYPH.midGap, gt = GLYPH.gTip;
  const mid = H / 2;
  const mx = (p) => p.map(([x, y]) => [W - x, y]); // mirror about the vertical axis
  const my = (p) => p.map(([x, y]) => [x, H - y]); // mirror about mid-height
  // f (top-left vertical): 45° miter at the top; bottom ends in two cuts — one parallel to
  // the f→e corner diagonal, one parallel to g's tip edge — meeting at a downward apex.
  const apexX = (-cg / 2 + t / 2 + gt) / 2;
  const f = [
    [0, m], [t, m + t],
    [t, mid - cg - (t - gt)],
    [apexX, mid - cg / 2 - t / 2 + apexX],
    [0, mid - cg / 2 - t / 2],
  ];
  const a = [[m, 0], [W - m, 0], [W - m - t, t], [m + t, t]];
  const g7 = [
    [gt, mid], [gt + t / 2, mid - t / 2], [W - gt - t / 2, mid - t / 2],
    [W - gt, mid], [W - gt - t / 2, mid + t / 2], [gt + t / 2, mid + t / 2],
  ];
  const polys = [];
  polys[SEG.a] = a;
  polys[SEG.d] = my(a);
  polys[SEG.g] = g7;
  polys[SEG.f] = f;
  polys[SEG.b] = mx(f);
  polys[SEG.e] = my(f);
  polys[SEG.c] = mx(my(f));
  // italic shear about mid-height — the real LED part leans right (top toward +x)
  const s = GLYPH.slant || 0;
  return polys.map((p) => p.map(([x, y]) => [x + (H / 2 - y) * s, y]));
}
const SEG_POLYS = buildSegPolys();

// ----------------------------------------------------------------------------------------
// 4. COLON ANIMATION  — verbatim from loadColonAnimation(); 200-entry tables, 10 ms/step
// ----------------------------------------------------------------------------------------
const COLON_MODES = ['slowfade', 'heartbeat', 'sawtooth', 'alt_sawtooth', 'toggle', 'solid'];

function buildColonTables(mode) {
  const L = new Array(200).fill(0), R = new Array(200).fill(0);
  switch (mode) {
    case 'slowfade':
      for (let k = 0; k < 100; k++) { L[k] = R[k] = k * 2; L[k + 100] = R[k + 100] = 198 - k * 2; }
      break;
    case 'heartbeat':
      for (let k = 0; k < 50; k++) L[k] = k * 4;
      for (let k = 0; k < 100; k++) L[k + 50] = 200 - k * 2;
      for (let k = 0; k < 50; k++) L[k + 150] = 0;
      for (let k = 0; k < 200; k++) R[k] = L[(k + 175) % 200];
      break;
    case 'sawtooth':
      for (let k = 0; k < 100; k++) { L[k] = R[k] = 196 - Math.floor((k * k) / 50); L[k + 100] = R[k + 100] = 196 - Math.floor((k * k) / 50); }
      break;
    case 'alt_sawtooth':
      for (let k = 0; k < 100; k++) { R[k] = 0; L[k + 100] = 0; L[k] = 196 - Math.floor((k * k) / 50); R[k + 100] = 196 - Math.floor((k * k) / 50); }
      break;
    case 'toggle':
      for (let k = 0; k < 100; k++) { L[k] = R[k] = 200; L[k + 100] = R[k + 100] = 0; }
      break;
    case 'solid':
    default:
      for (let k = 0; k < 200; k++) L[k] = R[k] = 200;
      break;
  }
  // normalise 0..200 -> 0..1
  return { L: L.map((v) => Math.max(0, v) / 200), R: R.map((v) => Math.max(0, v) / 200) };
}

// ----------------------------------------------------------------------------------------
// 5. DISPLAY MODES  — formatter(fields, ctx) -> { dateRow, time? }
//    dateRow: string (≤10 glyph cells; '.' lights the previous cell's DP, consumes no cell)
//    time:    omitted = standard HH:MM:SS.mmm; {mode:'off'} = blank; {mode:'cells',...} = override
// ----------------------------------------------------------------------------------------
const pad = (n, w) => String(n).padStart(w, '0');
const WDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoWeek(Y, Mo, D) {
  const dt = new Date(Date.UTC(Y, Mo - 1, D));
  const dn = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() - dn + 3); // nearest Thursday
  const isoYear = dt.getUTCFullYear();
  const ft = new Date(Date.UTC(isoYear, 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((dt - ft) / (7 * 86400000));
  return { isoYear, week, isoWday: dn + 1 };
}

const MODES = {
  iso8601: (f) => ({ dateRow: `${pad(f.Y, 4)}-${pad(f.Mo, 2)}-${pad(f.D, 2)}` }),
  ordinal: (f) => ({ dateRow: `${pad(f.Y, 4)}-${pad(f.yday, 3)}` }),
  isoweek: (f) => { const w = isoWeek(f.Y, f.Mo, f.D); return { dateRow: `${pad(w.isoYear, 4)}-W${pad(w.week, 2)}-${w.isoWday}` }; },
  unix: (f) => ({ dateRow: pad(f.epoch, 10) }),
  julian: (f) => ({ dateRow: (f.epoch / 86400 + 2440587.5).toFixed(3) }),
  mjd: (f) => ({ dateRow: (f.epoch / 86400 + 40587).toFixed(4) }),
  weekday: (f) => ({ dateRow: WDAY[f.wday].slice(0, 10) }),
  wdy_mm_dd: (f) => ({ dateRow: `${WDAY[f.wday].slice(0, 4)} ${pad(f.Mo, 2)}-${pad(f.D, 2)}` }),
  weekda_dd: (f) => ({ dateRow: `${WDAY[f.wday].slice(0, 7).padEnd(7, ' ')} ${pad(f.D, 2)}` }),
  text: (f, c) => ({ dateRow: (c.text || '-').slice(0, 12) }),
  vbat: (f, c) => ({ dateRow: `bat ${(c.vbat ?? 0).toFixed(4)}` }),
  satview: (f, c) => ({ dateRow: `GPS ${c.gps ?? '-'}` }),
  // Astro date-row modes — mirror firmware sendDate() byte-for-byte (main.c:549-586). Date row
  // shows the astro readout; the time row keeps the running clock (like satview). The controller
  // supplies the computed ctx (havePos, sun/moon values, grid, lat/lon) + a paging tick + dwell.
  sun: (f, c) => {
    const page = Math.floor((c.tick || 0) / (c.dwell || 5500)) % 3;
    if (!c.havePos || (!c.sunUpToday && page !== 2)) return { dateRow: '----' };
    const lbl = page === 0 ? 'RISE' : page === 1 ? 'SET ' : 'SOL ';
    const min = page === 0 ? c.riseMin : page === 1 ? c.setMin : c.noonMin;
    return { dateRow: `${lbl} ${pad(Math.floor(min / 60), 2)}.${pad(min % 60, 2)}` };
  },
  sun_azel: (f, c) => {
    if (!c.havePos) return { dateRow: '----' };
    const els = c.el < 0 ? `-${pad(Math.abs(c.el), 2)}` : pad(c.el, 2);
    return { dateRow: `AZ${pad(c.az, 3)}EL${els}` };
  },
  moon: (f, c) => ({ dateRow: `MOON ${c.moonIdx ?? 0} ${String(c.moonPct ?? 0).padStart(3, ' ')}` }),
  grid: (f, c) => ({ dateRow: c.grid || '----' }),
  latlon: (f, c) => {
    if (!c.havePos) return { dateRow: '----' };
    const page = Math.floor((c.tick || 0) / (c.dwell || 5500)) % 2;
    const lbl = page === 0 ? 'LAT' : 'LON';
    const v = page === 0 ? c.lat : c.lon, a = Math.abs(v);
    return { dateRow: `${lbl} ${v < 0 ? '-' : ''}${Math.floor(a)}.${pad(Math.floor((a - Math.floor(a)) * 100), 2)}` };
  },
  standby: () => ({ dateRow: '', time: { mode: 'off' } }),
  displaytest: (f) => {
    const n = f.s % 10;
    return { dateRow: String(n).repeat(10), time: { mode: 'cells', big: [n, n, n, n, n, n], small: [n, n, n], dp: true, colonsOn: true } };
  },
  offset: (f, c) => {
    const min = c.offsetMin ?? -new Date().getTimezoneOffset();
    const a = Math.abs(min), oh = Math.floor(a / 60), om = a % 60;
    return {
      dateRow: 'utc offset',
      time: { mode: 'cells', big: [min < 0 ? 'DASH' : 'BLANK', Math.floor(oh / 10), oh % 10, Math.floor(om / 10), om % 10, 'BLANK'], small: ['BLANK', 'BLANK', 'BLANK'], dp: false, colonsOn: false },
    };
  },
  countdown: (f, c) => {
    const target = c.countdownTo ?? f.epoch * 1000;
    let rem = Math.max(0, Math.floor((target - f.epoch * 1000 - f.ms) / 1000));
    const days = Math.floor(rem / 86400); rem %= 86400;
    const h = Math.floor(rem / 3600); rem %= 3600;
    const m = Math.floor(rem / 60), s = rem % 60;
    const frac = 999 - f.ms; // counts the fraction down
    return {
      dateRow: `t-${String(days).padStart(7, ' ')}d`,
      time: { mode: 'cells', big: [Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10], small: [Math.floor(frac / 100), Math.floor(frac / 10) % 10, frac % 10], dp: true, colonsOn: true },
    };
  },
};

function getFields(ms, utc) {
  const d = new Date(ms);
  const f = utc
    ? { Y: d.getUTCFullYear(), Mo: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), wday: d.getUTCDay() }
    : { Y: d.getFullYear(), Mo: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds(), wday: d.getDay() };
  f.yday = Math.floor((Date.UTC(f.Y, f.Mo - 1, f.D) - Date.UTC(f.Y, 0, 1)) / 86400000) + 1;
  f.epoch = Math.floor(ms / 1000);
  return f;
}

// ----------------------------------------------------------------------------------------
// 6. LAYOUT  (normalised; depends only on geometry + which rows are shown)
// ----------------------------------------------------------------------------------------
// Fixed time-row slots, left→right (HH : MM : SS . mmm).
const TIME_SLOTS = [
  { kind: 'digit', role: 'big', src: 0 }, { kind: 'digit', role: 'big', src: 1 },
  { kind: 'colon', which: 'L' },
  { kind: 'digit', role: 'big', src: 2 }, { kind: 'digit', role: 'big', src: 3 },
  { kind: 'colon', which: 'R' },
  { kind: 'digit', role: 'big', src: 4 }, { kind: 'digit', role: 'big', src: 5, dp: true },
  { kind: 'digit', role: 'small', src: 0 }, { kind: 'digit', role: 'small', src: 1 }, { kind: 'digit', role: 'small', src: 2 },
];

function buildLayout(rows) {
  const built = rows.map((type) => {
    const cells = [];
    let x = 0;
    if (type === 'date') {
      for (let i = 0; i < 10; i++) {
        const w = GEO.cellW;
        cells.push({ kind: 'digit', role: 'date', idx: i, cx: x + w / 2, scale: 1 });
        x += w + GEO.gap;
      }
    } else {
      for (const slot of TIME_SLOTS) {
        const scale = slot.role === 'small' ? SMALL_SCALE : 1;
        const w = slot.kind === 'colon' ? COLON_W : GEO.cellW * scale;
        cells.push({ ...slot, cx: x + w / 2, scale });
        x += w + GEO.gap;
      }
    }
    return { type, width: x - GEO.gap, cells };
  });
  const W = Math.max(...built.map((r) => r.width));
  let top = 0;
  for (const r of built) { r.top = top; r.offX = (W - r.width) / 2; top += GEO.cellH + ROW_GAP; }
  return { W, H: top - ROW_GAP, rows: built };
}

// ----------------------------------------------------------------------------------------
// 6b. PHYSICAL CHROME — CAD-derived board features in board-frame H-units (see CLOCK_RENDER_SPEC.md).
//   The board (BOARD.W x BOARD.H) is wider than the 7.018 digit layout; the layout sits inset
//   by BOARD.padL on the left (hinge bezel). Chrome coords are the board frame; the digit render
//   keeps its own frame (layout x=0 == board x=padL).
// ----------------------------------------------------------------------------------------
const BOARD = { W: 7.7592, H: 1.0105, padL: 0.351, vOff: 0.00525, holeR: 0.0439 };
// Bezel columns (board frame): LC near board-left, RC near board-right.
const LC = 0.19, RC = BOARD.W - 0.19;
// Hinge/inner edge of each board: 3 clustered hinge screws + 2 acrylic corner screws.
const HINGE5 = [0.12, 0.32, 0.50, 0.68, 0.88];
const CHROME = {
  // Hinge-column fasteners only (plain circles). Buttons, sensor and acrylic mounts omitted for now.
  time: { holes: HINGE5.map((cy) => [LC, cy]) }, // hinge on the inner/left edge (toward centre)
  date: { holes: HINGE5.map((cy) => [RC, cy]) }, // hinge on the inner/right edge (viewer frame)
};

// ----------------------------------------------------------------------------------------
// 7. FACTORY
// ----------------------------------------------------------------------------------------
export function createClockFace(canvas, opts = {}) {
  const ctx2d = canvas.getContext('2d');
  const state = {
    rows: opts.rows || ['date', 'time'],
    mode: opts.mode || 'iso8601',
    modeCtx: opts.modeCtx || {},
    colonMode: opts.colonMode || 'heartbeat',
    brightness: opts.brightness ?? 1,
    precision: opts.precision ?? 3,
    inverted: !!opts.inverted,
    utc: !!opts.utc,
    deviceFrame: null,
  };
  let layout = buildLayout(state.rows);
  let colonTbl = buildColonTables(state.colonMode);
  let tokens = resolveTokens(opts.tokens);
  let dpr = 1, cssW = 0, cssH = 0, S = 0, originX = 0, originY = 0;
  // clockOffsetMs shifts the face onto DEVICE time when mirroring a real Mk IV (the
  // host clock isn't GPS-disciplined). 0 = host time. Set via setClockOffset().
  let clockOffsetMs = 0;
  let raf = 0, timeSource = () => new Date(Date.now() + clockOffsetMs), destroyed = false;

  function resolveTokens(override) {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null;
    const v = (name, fb) => {
      const x = cs && cs.getPropertyValue(name).trim();
      return x || fb;
    };
    return {
      // Face reads the always-bright --face-* tokens (not chrome --led, darkened in light mode).
      led: v('--face-led', DEFAULT_TOKENS.led),
      ledDim: v('--face-dim', DEFAULT_TOKENS.ledDim),
      ledGlow: v('--face-glow', DEFAULT_TOKENS.ledGlow),
      inset: v('--inset', DEFAULT_TOKENS.inset),
      ...(override || {}),
    };
  }

  function resize(w, h) {
    cssW = w || canvas.clientWidth || canvas.width;
    cssH = h || canvas.clientHeight || canvas.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const padX = cssW * 0.04, padY = cssH * 0.008;
    S = Math.min((cssW - 2 * padX) / layout.W, (cssH - 2 * padY) / layout.H);
    originX = (cssW - layout.W * S) / 2;
    originY = (cssH - layout.H * S) / 2;
  }

  // board-frame H-coord -> canvas px
  function bpx(bx, by) { return [originX + (bx - BOARD.padL) * S, originY + (by - BOARD.vOff) * S]; }

  // draw the hinge-column fasteners as plain, unembellished circles. Buttons, the optical
  // sensor and the acrylic-mount screws are intentionally omitted for now.
  function drawChrome(type) {
    const c = CHROME[type]; if (!c || !c.holes) return;
    ctx2d.shadowBlur = 0; ctx2d.globalAlpha = 1;
    const inv = state.inverted;
    const fx = (x) => inv ? BOARD.W - x : x;
    const fy = (y) => inv ? BOARD.H - y : y;
    ctx2d.fillStyle = '#12151a';
    for (const h of c.holes) {
      const [hx, hy] = bpx(fx(h[0]), fy(h[1])); const r = BOARD.holeR * S;
      ctx2d.beginPath(); ctx2d.arc(hx, hy, r, 0, 6.2832); ctx2d.fill();
    }
  }

  // LIVE badge — pulsing red dot + word, only while mirroring a real connected device
  function drawLive(ms) {
    if (!state.deviceFrame) return;
    const [rx, ry] = bpx(BOARD.W, 0); const r = 0.05 * S;
    const x = rx - r * 1.6, y = ry - r * 1.2;
    const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(ms / 1000 * Math.PI * 2));
    ctx2d.save();
    ctx2d.globalAlpha = pulse;
    ctx2d.shadowColor = 'rgba(255,45,32,.7)'; ctx2d.shadowBlur = r * 2.6;
    ctx2d.fillStyle = '#ff2d20'; ctx2d.beginPath(); ctx2d.arc(x, y, r, 0, 6.2832); ctx2d.fill();
    ctx2d.shadowBlur = 0; ctx2d.globalAlpha = 1;
    ctx2d.fillStyle = '#ff2d20'; ctx2d.textBaseline = 'middle'; ctx2d.textAlign = 'left';
    ctx2d.font = '700 ' + Math.round(0.13 * S) + 'px ui-monospace, Menlo, monospace';
    ctx2d.fillText('LIVE', x + r * 1.7, y + r * 0.15);
    ctx2d.restore();
  }

  // --- low-level drawing -------------------------------------------------------------
  function fillPoly(poly, ox, oy, sf) {
    ctx2d.beginPath();
    ctx2d.moveTo(ox + poly[0][0] * sf, oy + poly[0][1] * sf);
    for (let i = 1; i < poly.length; i++) ctx2d.lineTo(ox + poly[i][0] * sf, oy + poly[i][1] * sf);
    ctx2d.closePath();
    ctx2d.fill();
  }

  // draw one 7-seg glyph; byte<0 means a fully blank cell (skip lit pass entirely)
  function drawGlyph(byte, leftPx, topPx, sf) {
    // ghost pass — every segment faintly lit (unlit LED is subtly visible)
    ctx2d.shadowBlur = 0;
    ctx2d.fillStyle = tokens.ledDim;
    ctx2d.globalAlpha = 1;
    for (let s = 0; s < 7; s++) fillPoly(SEG_POLYS[s], leftPx, topPx, sf);
    if (byte < 0) return;
    // lit pass — on segments with glow, scaled by master brightness
    ctx2d.fillStyle = tokens.led;
    ctx2d.shadowColor = tokens.ledGlow;
    ctx2d.shadowBlur = GLYPH.thick * S * 0.9;
    ctx2d.globalAlpha = state.brightness;
    for (let s = 0; s < 7; s++) if (segOn(byte, s)) fillPoly(SEG_POLYS[s], leftPx, topPx, sf);
    ctx2d.shadowBlur = 0;
    ctx2d.globalAlpha = 1;
  }

  function drawDot(cxPx, cyPx, rPx, intensity) {
    ctx2d.shadowBlur = 0;
    ctx2d.fillStyle = tokens.ledDim;
    ctx2d.globalAlpha = 1;
    ctx2d.beginPath(); ctx2d.arc(cxPx, cyPx, rPx, 0, Math.PI * 2); ctx2d.fill();
    if (intensity <= 0.01) return;
    ctx2d.fillStyle = tokens.led;
    ctx2d.shadowColor = tokens.ledGlow;
    ctx2d.shadowBlur = rPx * 2.2 * intensity;
    ctx2d.globalAlpha = state.brightness * intensity;
    ctx2d.beginPath(); ctx2d.arc(cxPx, cyPx, rPx, 0, Math.PI * 2); ctx2d.fill();
    ctx2d.shadowBlur = 0;
    ctx2d.globalAlpha = 1;
  }

  // place a glyph cell: returns the glyph box in px so callers can hang a DP off it
  function glyphBox(row, cell) {
    const sf = cell.scale * S;
    const gwPx = GLYPH.w * sf, ghPx = GLYPH.h * sf;
    const cxPx = originX + (row.offX + cell.cx) * S;
    const baseline = row.top + (GEO.cellH + GLYPH.h) / 2; // common baseline (norm)
    const topPx = originY + baseline * S - ghPx;
    const leftPx = cxPx - gwPx / 2;
    return { leftPx, topPx, gwPx, ghPx, sf };
  }

  // --- frame -------------------------------------------------------------------------
  function render(when) {
    const ms = typeof when === 'number' ? when : (when || timeSource()).getTime();
    const f = getFields(ms, state.utc);

    let model;
    if (state.deviceFrame) {
      model = state.deviceFrame; // {dateRow, time}
    } else {
      const fmt = (MODES[state.mode] || MODES.iso8601)(f, state.modeCtx);
      model = { dateRow: fmt.dateRow || '', time: fmt.time };
    }

    // standard time values (used unless the mode overrides the time row)
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

    // colon animation phase: the firmware DMA index (10 ms/step, 200-entry table = 2 s cycle).
    // 200*10ms divides 2000ms evenly, so step==0 lands exactly on the even UTC second — the
    // firmware's resync point — with no float drift.
    const step = Math.floor(ms / 10) % 200;

    // ---- paint ----
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssW, cssH);
    ctx2d.fillStyle = tokens.inset;
    ctx2d.fillRect(0, 0, cssW, cssH);
    ctx2d.lineJoin = 'round';

    for (const row of layout.rows) {
      if (row.type === 'date') drawDateRow(row, model.dateRow);
      else drawTimeRow(row, timeModel, step);
    }
  }

  function drawDateRow(row, str) {
    // map the string onto 10 cells; '.' lights the previous cell's DP, consumes no cell
    const cellByte = new Array(10).fill(0);
    const cellDP = new Array(10).fill(false);
    let ci = 0;
    for (const ch of str) {
      if (ch === '.') { if (ci > 0) cellDP[ci - 1] = true; continue; }
      if (ci >= 10) break;
      cellByte[ci] = dateGlyph(ch, state.inverted);
      ci++;
    }
    for (let i = 0; i < 10; i++) {
      const logical = state.inverted ? 9 - i : i;
      const cell = row.cells[logical];
      const box = glyphBox(row, cell);
      drawGlyph(cellByte[i], box.leftPx, box.topPx, box.sf);
      if (cellDP[i]) {
        // DP sits bottom-right of the digit; on a 180°-rotated board it point-reflects to top-left
        const ox = DP_OFF_X * box.sf, oy = DP_OFF_Y * box.sf;
        const dpX = state.inverted ? box.leftPx - ox : box.leftPx + box.gwPx + ox;
        const dpY = state.inverted ? box.topPx + oy : box.topPx + box.ghPx - oy;
        drawDot(dpX, dpY, (DP_DIA / 2) * box.sf, 1);
      }
    }
  }

  function drawTimeRow(row, tm, step) {
    if (tm.mode === 'off') return; // standby: blank panel
    const litColon = tm.colonsOn !== false;
    for (const cell of row.cells) {
      if (cell.kind === 'colon') {
        const b = litColon ? colonTbl[cell.which][step] : 0;
        const r = (GEO.colonDotDia / 2) * S;
        const cxPx = originX + (row.offX + cell.cx) * S;
        drawDot(cxPx, originY + (row.top + GEO.colonTopY) * S, r, b);
        drawDot(cxPx, originY + (row.top + GEO.colonBotY) * S, r, b);
        continue;
      }
      const val = cell.role === 'small' ? tm.small[cell.src] : tm.big[cell.src];
      let byte;
      if (val === 'BLANK') byte = -1;
      else if (val === 'DASH') byte = DASH;
      else byte = LUT_TIME[val] ?? -1;
      const box = glyphBox(row, cell);
      drawGlyph(byte, box.leftPx, box.topPx, box.sf);
      if (cell.dp && tm.dp) drawDot(box.leftPx + box.gwPx + DP_OFF_X * box.sf, box.topPx + box.ghPx - DP_OFF_Y * box.sf, (DP_DIA / 2) * box.sf, 1);
    }
  }

  // --- public API --------------------------------------------------------------------
  function loop() {
    render(timeSource());
    raf = requestAnimationFrame(loop);
  }

  resize(opts.width, opts.height);

  return {
    setMode(name, modeCtx) { state.mode = name; if (modeCtx) state.modeCtx = modeCtx; state.deviceFrame = null; render(); },
    setModeCtx(modeCtx) { state.modeCtx = { ...state.modeCtx, ...modeCtx }; render(); },
    setColonMode(name) { if (COLON_MODES.includes(name)) { state.colonMode = name; colonTbl = buildColonTables(name); } render(); },
    setBrightness(b) { state.brightness = Math.max(0, Math.min(1, b)); render(); },
    setPrecision(p) { state.precision = Math.max(0, Math.min(3, p | 0)); render(); },
    setInverted(flag) { state.inverted = !!flag; render(); },
    setUTC(flag) { state.utc = !!flag; render(); },
    setRows(rows) { state.rows = rows; layout = buildLayout(rows); resize(); render(); },
    setTokens(t) { tokens = resolveTokens(t); render(); },
    refreshTokens() { tokens = resolveTokens(); render(); },
    applyDeviceFrame(frame) { state.deviceFrame = frame; render(); },
    clearDeviceFrame() { state.deviceFrame = null; render(); },
    setClockOffset(ms) { clockOffsetMs = Number.isFinite(ms) ? ms : 0; },
    render,
    start(src) { if (raf || destroyed) return; if (src) timeSource = src; loop(); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    resize,
    destroy() { cancelAnimationFrame(raf); raf = 0; destroyed = true; },
    get state() { return { ...state }; },
    COLON_MODES, MODES: Object.keys(MODES),
  };
}

// ----------------------------------------------------------------------------------------
// Shared geometry + pure logic, exposed for an alternative renderer (the SVG face). These
// are the firmware-derived source-of-record values — the SVG renderer must reuse them, not
// re-measure, so the two renderers stay byte-identical.
// ----------------------------------------------------------------------------------------
export const CLOCKFACE_CORE = {
  SEG_POLYS, GLYPH, GEO, SEG, segOn,
  DP_DIA, DP_OFF_X, DP_OFF_Y, COLON_W, SMALL_SCALE, ROW_GAP, DASH,
  dateGlyph, LUT_TIME, MODES, getFields, buildLayout, buildColonTables, COLON_MODES,
  TIME_SLOTS, BOARD, CHROME, DEFAULT_TOKENS,
};
