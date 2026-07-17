// prefilter.mjs — a faithful JS port of the pccd sample prefilter (host/pccd/pccd.c pf_push),
// plus a seeded, physically-grounded model stream to demonstrate it. The SIGNAL PATH explainer in
// the TIMING room runs REAL prefilter math on a clearly-labelled MODEL stream: the knob lessons are
// true even though the raw pre-gate samples are synthetic (they do not survive in the flight-recorder
// archive, which stores only the post-filter output). Everything here is pure and unit-testable.

// Recommended values — mirror host/pccd/pccd.c (#define PF_WIN/PF_AGG, the 3.0*sig gate, 5us floor)
// and host/pccd/chrony.conf.example (corrtimeratio, poll, filter). The UI marks these on each control.
export const REC = { window: 64, group: 8, k: 3.0, floorUs: 5, corrRatio: 10, poll: 4, filter: 8 };
export const RANGE = {
  window: [16, 128], group: [4, 16], k: [2.0, 5.0], floorUs: [1, 20], corrRatio: [1, 40],
};

// Deterministic PRNG so dragging a FILTER knob re-runs the filter on the SAME data (you see the
// filter's effect, not fresh noise). Only the MODEL knobs (or an explicit reseed) change the stream.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  // Box-Muller; one draw per call is fine for our volume.
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A modelled raw offset stream (microseconds), shaped like a real USB-PPS feed: a slow thermal
// wander, a Gaussian jitter core, and rare large outliers (USB retries / IRQ preemption). Times are
// whole seconds. coreSigmaUs defaults toward a legible cloud; the UI calibrates it to the archive's
// measured jitter when one exists.
export function modelStream({ n = 480, coreSigmaUs = 10, outlierRate = 0.03, outlierMagUs = 120, driftUs = 6, seed = 0x9e37 } = {}) {
  const rng = mulberry32(seed);
  const orng = mulberry32(seed ^ 0x5bd1e995);   // independent stream for the outlier process
  const out = [];
  for (let i = 0; i < n; i++) {
    // slow thermal wander: a couple of low-frequency sinusoids, amplitude driftUs
    const drift = driftUs * (0.6 * Math.sin(i / 90) + 0.4 * Math.sin(i / 233 + 1.1));
    let x = drift + coreSigmaUs * gauss(rng);
    if (orng() < outlierRate) {
      const sign = orng() < 0.5 ? -1 : 1;
      x += sign * outlierMagUs * (0.4 + 1.4 * orng());   // 0.4x..1.8x the nominal spike
    }
    out.push({ t: i, raw: x });
  }
  return out;
}

function median(sorted) {
  const n = sorted.length;
  return n & 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}
function rms(vals) {
  if (!vals.length) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length);
}

// Run the EXACT pccd prefilter over a raw stream. Emits, per raw sample, the running median + gate
// band + accept/reject, and per group the trimmed-mean output — everything any chart needs.
//   samples : [{t, raw}]  (raw in microseconds)
//   opts    : { window, group, k, floorUs }  (defaults = recommended)
export function runPrefilter(samples, opts = {}) {
  const W = Math.round(opts.window ?? REC.window);
  const G = Math.round(opts.group ?? REC.group);
  const K = opts.k ?? REC.k;
  const FLOOR = opts.floorUs ?? REC.floorUs;
  const trim = Math.floor(G / 4);                 // drop this many from each end (pccd: PF_AGG/4)

  const ring = [];                                // last W RAW offsets (rejected ones included, as in pccd)
  const perSample = [];
  const groups = [];
  let groupOff = [], groupT = [];

  for (const s of samples) {
    let med = null, sigma = null, lo = null, hi = null, rejected = false, gated = false;
    if (ring.length >= 16) {                       // pccd: gate engages once >=16 samples seen
      gated = true;
      const srt = ring.slice().sort((a, b) => a - b);
      med = median(srt);
      const dev = ring.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
      sigma = 1.4826 * median(dev);
      if (sigma < FLOOR) sigma = FLOOR;            // floor: never gate tighter than FLOOR us
      lo = med - K * sigma; hi = med + K * sigma;
      if (Math.abs(s.raw - med) > K * sigma) rejected = true;
    }
    // the raw sample enters the ring whether or not it was rejected (matches pccd)
    ring.push(s.raw);
    if (ring.length > W) ring.shift();

    perSample.push({ t: s.t, raw: s.raw, med, sigma, lo, hi, rejected, gated });

    if (rejected) continue;
    groupOff.push(s.raw); groupT.push(s.t);
    if (groupOff.length >= G) {
      const srt = groupOff.slice().sort((a, b) => a - b);
      let sum = 0, cnt = 0;
      for (let i = trim; i < G - trim; i++) { sum += srt[i]; cnt++; }
      const clean = sum / cnt;
      const tc = groupT.reduce((a, b) => a + b, 0) / groupT.length;
      groups.push({ t: tc, clean, members: groupOff.slice() });
      groupOff = []; groupT = [];
    }
  }

  const rawVals = samples.map((s) => s.raw);
  const keptVals = perSample.filter((p) => !p.rejected).map((p) => p.raw);
  const cleanVals = groups.map((g) => g.clean);
  return {
    perSample, groups,
    stats: {
      total: samples.length,
      rejected: perSample.filter((p) => p.rejected).length,
      kept: keptVals.length,
      groupsOut: groups.length,
      rawRms: rms(rawVals),
      cleanRms: rms(cleanVals),
      // reduction factor the aggregate buys (guard the empty-clean case)
      reduction: cleanVals.length ? rms(rawVals) / Math.max(rms(cleanVals), 1e-9) : 0,
    },
  };
}
