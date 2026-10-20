// review.js — the REWIND / SCRUB timeline over the recorder.
//
// Draws one canvas: a connectivity strip (when the clock was streaming vs a CLOCK DISCONNECTED gap)
// above a few decimated overview tracks (temperature, satellites, oscillator drift), all on one time
// axis with a draggable playhead. The tracks come from the summary tier (pccd's /history rows, or
// the browser's 1-minute rollups); the frame at the playhead comes from replaying the stream
// (streamreplay.js), so the timeline only has to say where to look. decimate() keeps a multi-day
// span at about one point per pixel.
//
// prepReview() turns runs + track points into a scrub model; drawReview() paints it; tAtX()/xAtT()
// drive the interaction.

import { decimate } from './decimate.js?v=1';

const PAD_L = 8, PAD_R = 8, PAD_T = 6, PAD_B = 18;
const STRIP_H = 20;                       // connectivity strip height

export const TRACK_DEFS = [
  { key: 'temp', label: 'TEMPERATURE', unit: '°C', color: 'var(--gal)' },
  { key: 'sats', label: 'SATELLITES', unit: '', color: 'var(--gps)' },
  { key: 'ppm', label: 'DRIFT', unit: ' ppm', color: 'var(--led)' },
];

// The scrub model. runs: [{ t0, t1 }] (s) when the clock was streaming, oldest first; points:
// { temp: [{t,v}], sats: [...], ppm: [...] }; the span [tMin, tMax] (s). Segments are the runs and
// the gaps between (and before / after them inside the span).
export function prepReview({ tMin, tMax, runs = [], points = {}, source = '' }) {
  if (!(tMin < tMax)) tMax = tMin + 1;
  const segments = [];
  let at = tMin;
  for (const r of runs) {
    const a = Math.max(tMin, r.t0), b = Math.min(tMax, r.t1);
    if (!(b > a)) continue;
    if (a > at) segments.push({ t0: at, t1: a, connected: false });
    segments.push({ t0: a, t1: b, connected: true });
    at = b;
  }
  if (at < tMax) segments.push({ t0: at, t1: tMax, connected: false });
  const tracks = TRACK_DEFS.map((tr) => ({ ...tr, pts: (points[tr.key] || []).filter((p) => p.v != null && Number.isFinite(p.v)).sort((a, b) => a.t - b.t) }));
  return { source, runs, segments, tracks, tMin, tMax, playT: tMax, _plot: null };
}

export function xAtT(R, t) { const p = R._plot; return p ? p.x0 + (t - R.tMin) / (R.tMax - R.tMin) * p.w : 0; }
export function tAtX(R, x) { const p = R._plot; if (!p) return R.tMin; return R.tMin + Math.max(0, Math.min(1, (x - p.x0) / p.w)) * (R.tMax - R.tMin); }

export function drawReview(canvas, R, opts = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 640, cssH = canvas.clientHeight || 220;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) { canvas.width = cssW * dpr; canvas.height = cssH * dpr; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  const C = (v) => { const m = /var\((--[\w-]+)\)/.exec(v); return m ? css.getPropertyValue(m[1]).trim() || v : v; };

  const x0 = PAD_L, w = cssW - PAD_L - PAD_R;
  R._plot = { x0, w };
  const nT = R.tracks.length;
  const trackTop = PAD_T + STRIP_H + 6;
  const trackH = Math.max(24, (cssH - trackTop - PAD_B) / nT - 6);
  const X = (t) => x0 + (t - R.tMin) / (R.tMax - R.tMin) * w;

  // --- connectivity strip: connected filled, gaps hatched + labelled ---
  g.fillStyle = C('var(--well)'); g.fillRect(x0, PAD_T, w, STRIP_H);
  for (const s of R.segments) {
    const sx = X(s.t0), sw = Math.max(1, X(s.t1) - X(s.t0));
    if (s.connected) { g.fillStyle = C('var(--lock)'); g.globalAlpha = 0.55; g.fillRect(sx, PAD_T, sw, STRIP_H); g.globalAlpha = 1; }
    else {
      g.save(); g.beginPath(); g.rect(sx, PAD_T, sw, STRIP_H); g.clip();
      g.fillStyle = C('var(--strip)'); g.fillRect(sx, PAD_T, sw, STRIP_H);
      g.strokeStyle = C('var(--line2)'); g.lineWidth = 1; g.globalAlpha = 0.7;   // diagonal hatch = "no data"
      for (let hx = sx - STRIP_H; hx < sx + sw; hx += 7) { g.beginPath(); g.moveTo(hx, PAD_T + STRIP_H); g.lineTo(hx + STRIP_H, PAD_T); g.stroke(); }
      g.globalAlpha = 1; g.restore();
      if (sw > 92) { g.fillStyle = C('var(--txt3)'); g.font = '8px var(--mono, monospace)'; g.textAlign = 'center'; g.fillText('CLOCK DISCONNECTED', sx + sw / 2, PAD_T + STRIP_H / 2 + 3); }
    }
  }
  g.strokeStyle = C('var(--line)'); g.lineWidth = 1; g.strokeRect(x0 + .5, PAD_T + .5, w, STRIP_H);

  // --- decimated tracks ---
  // Lift the pen only where a recorded gap lies between two points. Comparing the step to GAP_S
  // instead broke every segment once decimation spaced points wider than GAP_S (any span over ~10 min).
  const gaps = R.segments.filter((s) => !s.connected);
  g.textAlign = 'left';
  for (let i = 0; i < nT; i++) {
    const tr = R.tracks[i], top = trackTop + i * (trackH + 6), pts = tr.pts;   // decimated to ~1 pt / pixel below
    g.fillStyle = C('var(--txt3)'); g.font = '8px var(--mono, monospace)';
    g.fillText(tr.label, x0 + 2, top - 1);
    g.strokeStyle = C('var(--line)'); g.globalAlpha = 0.6; g.strokeRect(x0 + .5, top + .5, w, trackH); g.globalAlpha = 1;
    if (pts.length < 2) { g.fillStyle = C('var(--txt3)'); g.fillText('no data', x0 + w - 44, top + trackH / 2 + 3); continue; }
    let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
    const Y = (v) => top + trackH - 4 - (v - lo) / (hi - lo) * (trackH - 8);
    const dec = decimate(pts, Math.max(2, w | 0), { mode: 'lttb' });   // <= 1 pt/pixel — the scrub perf guarantee
    g.strokeStyle = C(tr.color); g.lineWidth = 1.25; g.beginPath();
    let started = false, prevT = null, gi = 0;
    for (const p of dec) {
      if (prevT != null) {                                          // break the line across a disconnected gap
        while (gi < gaps.length && gaps[gi].t1 <= prevT) gi++;
        if (gi < gaps.length && gaps[gi].t0 < p.t) started = false;
      }
      const px = X(p.t), py = Y(p.v);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      prevT = p.t;
    }
    g.stroke();
    g.fillStyle = C('var(--txt3)'); g.textAlign = 'right';
    const dp = tr.key === 'sats' ? 0 : tr.key === 'ppm' ? 2 : 1;
    g.fillText(hi.toFixed(dp) + tr.unit, x0 + w - 2, top + 8);
    g.fillText(lo.toFixed(dp), x0 + w - 2, top + trackH - 2);
    g.textAlign = 'left';
  }

  // --- time-axis ticks ---
  g.fillStyle = C('var(--txt3)'); g.font = '8px var(--mono, monospace)'; g.textAlign = 'center';
  // UTC, like the readout: hours under three days (the date where it changes), dates above.
  const span = R.tMax - R.tMin, ticks = 5;
  let lastDay = null;
  for (let i = 0; i <= ticks; i++) {
    const t = R.tMin + span * i / ticks, px = X(t);
    const iso = new Date(t * 1000).toISOString(), day = iso.slice(5, 10).replace('-', '/'), hm = iso.slice(11, span < 600 ? 19 : 16);
    const lbl = span > 3 * 86400 ? day : (day !== lastDay && i > 0 ? day + ' ' : '') + hm;
    lastDay = day;
    g.fillText(lbl, Math.max(x0 + 22, Math.min(x0 + w - 22, px)), cssH - 6);
  }

  // --- playhead ---
  const px = X(R.playT);
  g.strokeStyle = C('var(--led)'); g.lineWidth = 1; g.beginPath(); g.moveTo(px, PAD_T); g.lineTo(px, cssH - PAD_B); g.stroke();
  g.fillStyle = C('var(--led)'); g.beginPath(); g.moveTo(px, PAD_T); g.lineTo(px - 4, PAD_T - 0); g.lineTo(px + 4, PAD_T - 0); g.closePath();
  g.fillRect(px - 3, PAD_T - 4, 6, 4);
}
