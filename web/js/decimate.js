// decimate.js — downsample a time-series to ~1 point per pixel for chart render.
//
// The thing that tanks a long-log chart is feeding hundreds of thousands of
// points into canvas lineTo, or re-decimating every animation frame. This
// utility exists for the FUTURE scrub view over a long persisted log; on the
// LIVE path it is a NO-OP: the live RAM buffers are already <= ~1800–3600
// points and every chart's target is its pixel width (~560–960), so the fast
// path returns the input array unchanged and live rendering is byte-identical.
//
// Two modes, chosen per chart type (see the design synthesis):
//   'lttb'   — Largest-Triangle-Three-Buckets. Preserves visual SHAPE, peaks
//              and outliers of dense line series (cn0-over-time, phase strip).
//   'minmax' — per-bucket min+max. Preserves the ENVELOPE and single-sample
//              spikes / dropouts of step/threshold series (DOP, continuity) —
//              LTTB would smooth exactly the evidence a diagnostic scrub needs.
//
// Same-shape in, same-shape out: callers pass accessors so the returned objects
// are the very objects the chart already consumes.

const ID = (p) => p;

// Downsample `points` toward `target` output points. Returns `points` unchanged
// when it's already small enough (the live fast path). `x`/`y` extract numeric
// coords; the ORIGINAL point objects are returned (never rebuilt).
export function decimate(points, target, opts = {}) {
  const n = points ? points.length : 0;
  const t = Math.max(2, target | 0);
  // Fast path: nothing to gain below ~1.5× target — this is the live path.
  if (n <= t * 1.5) return points || [];
  const mode = opts.mode || 'lttb';
  const x = opts.x || ((p) => p.t);
  const y = opts.y || ((p) => p.v);
  return mode === 'minmax' ? minmax(points, t, x, y) : lttb(points, t, x, y);
}

// Largest-Triangle-Three-Buckets (Sveinn Steinarsson, 2013). O(n), keeps first
// and last, picks the point in each bucket forming the largest triangle with
// the previous kept point and the next bucket's average — preserving peaks.
function lttb(data, threshold, x, y) {
  const n = data.length;
  if (threshold >= n || threshold < 3) return data;
  const sampled = [data[0]];                       // always keep the first
  const every = (n - 2) / (threshold - 2);
  let a = 0;                                        // index of the last kept point
  for (let i = 0; i < threshold - 2; i++) {
    // average of the NEXT bucket (the third point of each triangle)
    let avgX = 0, avgY = 0, avgN = 0;
    const rStart = Math.floor((i + 1) * every) + 1;
    let rEnd = Math.floor((i + 2) * every) + 1;
    if (rEnd > n) rEnd = n;
    for (let j = rStart; j < rEnd; j++) { avgX += +x(data[j]); avgY += +y(data[j]); avgN++; }
    avgX /= avgN || 1; avgY /= avgN || 1;
    // scan THIS bucket for the point making the largest triangle with a + avg
    const rangeOffs = Math.floor(i * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;
    const ax = +x(data[a]), ay = +y(data[a]);
    let maxArea = -1, maxIdx = rangeOffs;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area = Math.abs((ax - avgX) * (+y(data[j]) - ay) - (ax - +x(data[j])) * (avgY - ay)) * 0.5;
      if (area > maxArea) { maxArea = area; maxIdx = j; }
    }
    sampled.push(data[maxIdx]);
    a = maxIdx;
  }
  sampled.push(data[n - 1]);                        // always keep the last
  return sampled;
}

// Per-bucket min+max on y — two points per bucket, in x order, preserving the
// envelope and any single-sample spike/dropout. ~2× `buckets` output points.
function minmax(data, buckets, x, y) {
  const n = data.length;
  const b = Math.max(1, Math.min(buckets, n));
  const size = n / b;
  const out = [];
  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * size);
    const end = Math.min(n, Math.floor((i + 1) * size));
    if (end <= start) continue;
    let lo = start, hi = start;
    for (let j = start + 1; j < end; j++) {
      const v = +y(data[j]);
      if (v < +y(data[lo])) lo = j;
      if (v > +y(data[hi])) hi = j;
    }
    // emit the two extrema in the order they occur, so the line doesn't zigzag
    if (lo <= hi) { out.push(data[lo]); if (hi !== lo) out.push(data[hi]); }
    else { out.push(data[hi]); out.push(data[lo]); }
  }
  return out;
}
