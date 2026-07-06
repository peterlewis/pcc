// review.js — the REWIND / SCRUB renderer over the persisted telemetry log.
//
// Draws one canvas: a connectivity strip (when the clock was streaming vs a
// CLOCK DISCONNECTED gap) above a few decimated tracks — temperature, sats,
// clock skew — all sharing one time axis with a draggable playhead. This is
// where decimate() earns its keep: a multi-hour window is downsampled to ~1
// point per pixel before it ever touches the canvas.
//
// prepReview() turns raw log rows + session boundaries into a scrub model;
// drawReview() paints it; sampleAt()/tAtX()/xAtT() drive the interaction.

import { decimate } from './decimate.js?v=1';

const PAD_L = 8, PAD_R = 8, PAD_T = 6, PAD_B = 18;
const STRIP_H = 20;                       // connectivity strip height
const GAP_S = 3;                          // a run of missing seconds this long = a disconnected gap

// Build the scrub model from sessions + their samples. Segments mark connected
// spans (from actual sample runs) and the gaps between them.
export function prepReview(sessions, samples) {
  samples = (samples || []).slice().sort((a, b) => a.t - b.t);
  const segments = [];
  if (samples.length) {
    let start = samples[0].t, prev = samples[0].t;
    for (let i = 1; i < samples.length; i++) {
      const t = samples[i].t;
      if (t - prev > GAP_S) { segments.push({ t0: start, t1: prev, connected: true }); segments.push({ t0: prev, t1: t, connected: false }); start = t; }
      prev = t;
    }
    segments.push({ t0: start, t1: prev, connected: true });
  }
  // span: prefer the sessions' declared bounds, else the samples' extent
  let tMin = Infinity, tMax = -Infinity;
  for (const s of (sessions || [])) { if (s.connectedAt) tMin = Math.min(tMin, s.connectedAt / 1000); if (s.disconnectAt) tMax = Math.max(tMax, s.disconnectAt / 1000); }
  if (samples.length) { tMin = Math.min(tMin, samples[0].t); tMax = Math.max(tMax, samples[samples.length - 1].t); }
  if (!(tMin < tMax)) { tMin = samples.length ? samples[0].t : 0; tMax = tMin + 1; }
  return { samples, segments, tMin, tMax, playT: tMax, _plot: null };
}

// Nearest sample to time t (seconds). Returns null if none within `maxGap` s.
export function sampleAt(R, t, maxGap = 5) {
  const a = R.samples; if (!a.length) return null;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m].t < t) lo = m + 1; else hi = m; }
  const c = a[lo], p = a[Math.max(0, lo - 1)];
  const best = Math.abs(c.t - t) <= Math.abs(p.t - t) ? c : p;
  return Math.abs(best.t - t) <= maxGap ? best : null;
}

export function xAtT(R, t) { const p = R._plot; return p ? p.x0 + (t - R.tMin) / (R.tMax - R.tMin) * p.w : 0; }
export function tAtX(R, x) { const p = R._plot; if (!p) return R.tMin; return R.tMin + Math.max(0, Math.min(1, (x - p.x0) / p.w)) * (R.tMax - R.tMin); }

const TRACKS = [
  { key: 'temp', label: 'TEMPERATURE', unit: '°C', get: (r) => (r.pps ? r.pps.temp : null), color: 'var(--gal)' },
  { key: 'sats', label: 'SATELLITES', unit: '', get: (r) => (r.fix ? r.fix.sats : (r.sats ? r.sats.length : null)), color: 'var(--gps)' },
  { key: 'skew', label: 'CLOCK SKEW', unit: 'µs', get: (r) => (r.pps ? r.pps.phaseUs : null), color: 'var(--led)' },
];

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
  const nT = TRACKS.length;
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
  g.textAlign = 'left';
  for (let i = 0; i < nT; i++) {
    const tr = TRACKS[i], top = trackTop + i * (trackH + 6);
    // pull (t,v) pairs where the metric exists, then decimate to ~1 pt / pixel
    const pts = [];
    for (const r of R.samples) { const v = tr.get(r); if (v != null && Number.isFinite(v)) pts.push({ t: r.t, v }); }
    g.fillStyle = C('var(--txt3)'); g.font = '8px var(--mono, monospace)';
    g.fillText(tr.label, x0 + 2, top - 1);
    g.strokeStyle = C('var(--line)'); g.globalAlpha = 0.6; g.strokeRect(x0 + .5, top + .5, w, trackH); g.globalAlpha = 1;
    if (pts.length < 2) { g.fillStyle = C('var(--txt3)'); g.fillText('no data', x0 + w - 44, top + trackH / 2 + 3); continue; }
    let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
    const Y = (v) => top + trackH - 4 - (v - lo) / (hi - lo) * (trackH - 8);
    const dec = decimate(pts, Math.max(2, w | 0), { mode: 'lttb' });   // <= 1 pt/pixel — the scrub perf guarantee
    g.strokeStyle = C(tr.color); g.lineWidth = 1.25; g.beginPath();
    let started = false, prevT = null;
    for (const p of dec) {
      if (prevT != null && p.t - prevT > GAP_S) started = false;   // break the line across a disconnected gap
      const px = X(p.t), py = Y(p.v);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      prevT = p.t;
    }
    g.stroke();
    g.fillStyle = C('var(--txt3)'); g.textAlign = 'right';
    g.fillText(hi.toFixed(tr.key === 'sats' ? 0 : 1) + tr.unit, x0 + w - 2, top + 8);
    g.fillText(lo.toFixed(tr.key === 'sats' ? 0 : 1), x0 + w - 2, top + trackH - 2);
    g.textAlign = 'left';
  }

  // --- time-axis ticks ---
  g.fillStyle = C('var(--txt3)'); g.font = '8px var(--mono, monospace)'; g.textAlign = 'center';
  const span = R.tMax - R.tMin, ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = R.tMin + span * i / ticks, px = X(t);
    const d = new Date(t * 1000);
    const lbl = span > 86400 ? (d.getMonth() + 1) + '/' + d.getDate() : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    g.fillText(lbl, Math.max(x0 + 12, Math.min(x0 + w - 12, px)), cssH - 6);
  }

  // --- playhead ---
  const px = X(R.playT);
  g.strokeStyle = C('var(--led)'); g.lineWidth = 1; g.beginPath(); g.moveTo(px, PAD_T); g.lineTo(px, cssH - PAD_B); g.stroke();
  g.fillStyle = C('var(--led)'); g.beginPath(); g.moveTo(px, PAD_T); g.lineTo(px - 4, PAD_T - 0); g.lineTo(px + 4, PAD_T - 0); g.closePath();
  g.fillRect(px - 3, PAD_T - 4, 6, 4);
}
