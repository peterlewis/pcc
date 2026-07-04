// timingmath.js
//
// Dependency-free ES module of frequency-stability estimators for a
// GPS-disciplined clock analyzer.
//
// All estimators operate on a PHASE (time-error) series x_i in seconds,
// uniformly sampled every tau0 seconds, i = 0 .. N-1. Fractional frequency
// is y_i = (x_{i+1} - x_i) / tau0. Averaging time is tau = m * tau0 where m
// (the "averaging factor") is a positive integer.
//
// References:
//   IEEE Std 1139-2008, "IEEE Standard Definitions of Physical Quantities for
//     Fundamental Frequency and Time Metrology — Random Instabilities".
//   W.J. Riley, "Handbook of Frequency Stability Analysis", NIST Special
//     Publication 1065 (2008).
//
// Expected log-log ADEV(tau) slopes (mu, with sigma_y ~ tau^(mu/2)):
//   white PM     : tau^-1     (ADEV & MDEV differ; MDEV steeper)
//   flicker PM   : ~tau^-1
//   white FM     : tau^-1/2
//   flicker FM   : tau^0      (flat)
//   random-walk  : tau^+1/2
// TDEV of white PM ~ tau^-1/2.

'use strict';

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

/** @returns {boolean} true iff v is a finite real number. */
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Sanitize a numeric input array into a plain Float64-ish JS array, dropping
 * a trailing/leading structure but keeping length. Non-finite entries are
 * left in place here; per-estimator loops skip any window that touches a
 * non-finite sample.
 * @param {ArrayLike<number>} x
 * @returns {number[]}
 */
function toArray(x) {
  const n = x == null ? 0 : x.length | 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = +x[i];
  return out;
}

// ---------------------------------------------------------------------------
// Phase <-> fractional frequency conversion
// ---------------------------------------------------------------------------

/**
 * Convert a phase (time-error) series to fractional frequency.
 *   y_i = (x_{i+1} - x_i) / tau0,   i = 0 .. N-2
 * Ref: IEEE 1139-2008 §; NIST SP1065 eq. (3).
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0           sample interval [s]
 * @returns {number[]} fractional frequency series (length N-1)
 */
export function phaseToFreq(x, tau0) {
  const a = toArray(x);
  const N = a.length;
  if (!(tau0 > 0) || N < 2) return [];
  const y = new Array(N - 1);
  for (let i = 0; i < N - 1; i++) y[i] = (a[i + 1] - a[i]) / tau0;
  return y;
}

/**
 * Convert a fractional-frequency series to phase by cumulative integration.
 *   x_0 = x0;  x_{i+1} = x_i + y_i * tau0
 * Ref: NIST SP1065 §5.2.
 * @param {ArrayLike<number>} y   fractional frequency series
 * @param {number} tau0           sample interval [s]
 * @param {number} [x0=0]         initial phase [s]
 * @returns {number[]} phase series (length M+1 for input length M)
 */
export function freqToPhase(y, tau0, x0 = 0) {
  const a = toArray(y);
  const M = a.length;
  if (!(tau0 > 0)) return M ? [] : [x0];
  const x = new Array(M + 1);
  x[0] = x0;
  for (let i = 0; i < M; i++) x[i + 1] = x[i] + a[i] * tau0;
  return x;
}

// ---------------------------------------------------------------------------
// Tau (averaging-factor) selection
// ---------------------------------------------------------------------------

/**
 * Generate a list of averaging times tau = m*tau0 with valid averaging
 * factors m for a phase series of length N.
 *
 * The largest usable m is bounded so that every requested estimator retains
 * at least one term. The tightest common constraint (overlapping Hadamard)
 * needs N - 3m >= 1, i.e. m <= (N-1)/3. We use that as the default cap so a
 * single tau list works for all estimators; each estimator additionally
 * self-guards. `maxRatio` (default 1) scales the cap: m_max = floor((N-1)/3 * maxRatio),
 * still clamped to keep Allan valid.
 *
 * modes:
 *   'octave' : m = 1, 2, 4, 8, ...      (powers of two)
 *   'decade' : m = 1,2,...,9, 10,20,...,90, 100,...  (1-2-5-ish decade fill)
 *   'all'    : m = 1, 2, 3, ... m_max   (all-tau)
 *
 * Ref: NIST SP1065 §5.4 (all-tau / octave averaging).
 * @param {number} N            number of phase samples
 * @param {number} tau0         sample interval [s]
 * @param {{mode?:string, maxRatio?:number}} [opts]
 * @returns {number[]} tau values [s]
 */
export function autoTaus(N, tau0, opts = {}) {
  const mode = opts.mode || 'octave';
  const maxRatio = isFiniteNum(opts.maxRatio) && opts.maxRatio > 0 ? opts.maxRatio : 1;
  if (!(tau0 > 0) || !(N >= 4)) return [];

  // Cap keeping the most-demanding estimator (Hadamard, N-3m>=1) valid,
  // and never exceeding Allan's own limit (N-2m>=1).
  const hadCap = Math.floor((N - 1) / 3);
  const allanCap = Math.floor((N - 1) / 2);
  let mMax = Math.floor(hadCap * maxRatio);
  if (mMax > allanCap) mMax = allanCap;
  if (mMax < 1) return [];

  const ms = [];
  if (mode === 'all') {
    for (let m = 1; m <= mMax; m++) ms.push(m);
  } else if (mode === 'decade') {
    // 1-2-5 decade fill: within each decade emit 1,2,5 * 10^k plus 3,4,...
    // Keep it simple and dense enough: 1..9, 10,20,..90, 100,200,... etc.
    let step = 1;
    let base = 0;
    for (;;) {
      let emitted = false;
      for (let d = 1; d <= 9; d++) {
        const m = base + d * step;
        if (m > mMax) { emitted = false; break; }
        if (m >= 1) { ms.push(m); emitted = true; }
      }
      // Advance to next decade.
      const next = step * 10;
      if (next > mMax) {
        // still emit remaining multiples of current step up to mMax
        break;
      }
      base = 0;
      step = next;
      if (!emitted && step > mMax) break;
    }
    // Deduplicate & sort (decade fill can overlap boundaries).
    ms.sort((a, b) => a - b);
    for (let i = ms.length - 1; i > 0; i--) if (ms[i] === ms[i - 1]) ms.splice(i, 1);
  } else {
    // octave
    for (let m = 1; m <= mMax; m *= 2) ms.push(m);
  }

  const taus = new Array(ms.length);
  for (let i = 0; i < ms.length; i++) taus[i] = ms[i] * tau0;
  return taus;
}

/**
 * Map a requested tau list to integer averaging factors m, dropping any tau
 * that does not correspond (within rounding) to a positive integer multiple
 * of tau0.
 * @param {ArrayLike<number>} taus
 * @param {number} tau0
 * @returns {{tau:number, m:number}[]}
 */
function tausToM(taus, tau0) {
  const out = [];
  const t = toArray(taus);
  for (let i = 0; i < t.length; i++) {
    if (!isFiniteNum(t[i]) || t[i] <= 0) continue;
    const m = Math.round(t[i] / tau0);
    if (m >= 1 && Math.abs(m * tau0 - t[i]) <= 1e-9 * Math.max(tau0, t[i])) {
      out.push({ tau: m * tau0, m });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlapping Allan deviation
// ---------------------------------------------------------------------------

/**
 * Overlapping Allan deviation (OADEV) from a phase series.
 *
 *   sigma_y^2(tau) = 1 / (2 m^2 tau0^2 (N-2m))
 *                    * SUM_{i=0}^{N-2m-1} (x_{i+2m} - 2 x_{i+m} + x_i)^2
 *   OADEV(tau) = sqrt(sigma_y^2(tau))
 *
 * Requires N - 2m >= 1. Windows containing a non-finite sample are skipped;
 * the term count n reflects only the terms actually summed.
 * Ref: IEEE 1139-2008; NIST SP1065 eq. (10).
 *
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0          sample interval [s]
 * @param {ArrayLike<number>} taus requested tau values [s]
 * @returns {{tau:number, m:number, dev:number, n:number}[]}
 */
export function oadev(x, tau0, taus) {
  const a = toArray(x);
  const N = a.length;
  const results = [];
  if (!(tau0 > 0) || N < 3) return results;
  const pairs = tausToM(taus, tau0);
  for (const { tau, m } of pairs) {
    if (N - 2 * m < 1) continue;
    let sum = 0;
    let n = 0;
    const last = N - 2 * m - 1;
    for (let i = 0; i <= last; i++) {
      const d = a[i + 2 * m] - 2 * a[i + m] + a[i];
      if (!Number.isFinite(d)) continue;
      sum += d * d;
      n++;
    }
    if (n < 1) continue;
    const variance = sum / (2 * m * m * tau0 * tau0 * n);
    if (!Number.isFinite(variance) || variance < 0) continue;
    results.push({ tau, m, dev: Math.sqrt(variance), n });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Modified Allan deviation
// ---------------------------------------------------------------------------

/**
 * Modified Allan deviation (MDEV) from a phase series.
 *
 *   mod sigma_y^2(tau) = 1 / (2 m^4 tau0^2 (N-3m+1))     [ = 1/(2 m^2 tau^2 (N-3m+1)), tau = m*tau0 ]
 *      * SUM_{j=0}^{N-3m} ( SUM_{i=j}^{j+m-1} (x_{i+2m} - 2 x_{i+m} + x_i) )^2
 *   MDEV(tau) = sqrt(...)
 *
 * Requires N - 3m + 1 >= 1, i.e. N >= 3m. The inner sum is maintained
 * incrementally across j (sliding window of the second differences) so the
 * cost is O(N) per tau rather than O(N*m).
 * Ref: IEEE 1139-2008; NIST SP1065 eq. (12).
 *
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0          sample interval [s]
 * @param {ArrayLike<number>} taus requested tau values [s]
 * @returns {{tau:number, m:number, dev:number, n:number}[]}
 */
export function mdev(x, tau0, taus) {
  const a = toArray(x);
  const N = a.length;
  const results = [];
  if (!(tau0 > 0) || N < 3) return results;
  const pairs = tausToM(taus, tau0);

  for (const { tau, m } of pairs) {
    const nWindows = N - 3 * m + 1; // number of j values
    if (nWindows < 1) continue;

    // Second-difference at index i: D_i = x_{i+2m} - 2 x_{i+m} + x_i,
    // defined for i in [0, N-2m-1]. The MDEV inner sum over j is
    // S_j = sum_{i=j}^{j+m-1} D_i. We slide S_j across j.
    //
    // Precompute D lazily via sliding sum. Guard non-finite by skipping any
    // window whose inner sum touches a non-finite D.
    const D = new Array(N - 2 * m);
    let anyBad = false;
    for (let i = 0; i < N - 2 * m; i++) {
      const d = a[i + 2 * m] - 2 * a[i + m] + a[i];
      D[i] = d;
      if (!Number.isFinite(d)) anyBad = true;
    }

    let sumSq = 0;
    let n = 0;

    // Initialize inner sum S for j = 0.
    let S = 0;
    let sBad = false;
    for (let i = 0; i < m; i++) {
      const d = D[i];
      if (!Number.isFinite(d)) sBad = true;
      S += d;
    }
    if (!sBad && Number.isFinite(S)) { sumSq += S * S; n++; }

    // Slide j from 1 to nWindows-1: S_j = S_{j-1} - D_{j-1} + D_{j-1+m}.
    for (let j = 1; j < nWindows; j++) {
      const outIdx = j - 1;
      const inIdx = j - 1 + m;
      S += D[inIdx] - D[outIdx];
      if (anyBad) {
        // Recompute window validity cheaply: if either the added or removed
        // term is non-finite, or S went non-finite, revalidate the window.
        if (!Number.isFinite(S)) {
          // Recompute S directly to recover from a departed NaN.
          S = 0;
          let bad = false;
          for (let i = j; i < j + m; i++) {
            const d = D[i];
            if (!Number.isFinite(d)) bad = true;
            S += d;
          }
          if (bad || !Number.isFinite(S)) continue;
          sumSq += S * S; n++;
          continue;
        }
        // S finite but a NaN may still lurk within window; verify.
        let bad = false;
        for (let i = j; i < j + m; i++) if (!Number.isFinite(D[i])) { bad = true; break; }
        if (bad) continue;
      }
      if (Number.isFinite(S)) { sumSq += S * S; n++; }
    }

    if (n < 1) continue;
    // mod sigma^2 = 1/(2 m^2 tau^2 (N-3m+1)) * SUM_j S_j^2, with tau = m*tau0,
    // so the tau0-form denominator is 2 m^4 tau0^2 (N-3m+1). We substitute n =
    // the actual count of valid windows for (N-3m+1). (m^4, not m^3.)
    const variance = sumSq / (2 * m * m * m * m * tau0 * tau0 * n);
    if (!Number.isFinite(variance) || variance < 0) continue;
    results.push({ tau, m, dev: Math.sqrt(variance), n });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Time deviation
// ---------------------------------------------------------------------------

/**
 * Time deviation (TDEV) from a phase series.
 *
 *   TDEV(tau) = tau / sqrt(3) * MDEV(tau)
 *
 * Ref: IEEE 1139-2008; NIST SP1065 eq. (18).
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0          sample interval [s]
 * @param {ArrayLike<number>} taus requested tau values [s]
 * @returns {{tau:number, m:number, dev:number, n:number}[]}
 */
export function tdev(x, tau0, taus) {
  const md = mdev(x, tau0, taus);
  const out = new Array(md.length);
  for (let i = 0; i < md.length; i++) {
    const r = md[i];
    out[i] = { tau: r.tau, m: r.m, dev: (r.tau / Math.sqrt(3)) * r.dev, n: r.n };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlapping Hadamard deviation
// ---------------------------------------------------------------------------

/**
 * Overlapping Hadamard deviation (OHDEV) from a phase series (3rd difference).
 *
 *   H sigma_y^2(tau) = 1 / (6 m^2 tau0^2 (N-3m))
 *      * SUM_{i=0}^{N-3m-1} (x_{i+3m} - 3 x_{i+2m} + 3 x_{i+m} - x_i)^2
 *   OHDEV(tau) = sqrt(...)
 *
 * Requires N - 3m >= 1. Hadamard is insensitive to linear frequency drift,
 * making it the estimator of choice for GPSDO/rubidium data with drift.
 * Ref: IEEE 1139-2008; NIST SP1065 eq. (16).
 *
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0          sample interval [s]
 * @param {ArrayLike<number>} taus requested tau values [s]
 * @returns {{tau:number, m:number, dev:number, n:number}[]}
 */
export function ohdev(x, tau0, taus) {
  const a = toArray(x);
  const N = a.length;
  const results = [];
  if (!(tau0 > 0) || N < 4) return results;
  const pairs = tausToM(taus, tau0);
  for (const { tau, m } of pairs) {
    if (N - 3 * m < 1) continue;
    let sum = 0;
    let n = 0;
    const last = N - 3 * m - 1;
    for (let i = 0; i <= last; i++) {
      const d = a[i + 3 * m] - 3 * a[i + 2 * m] + 3 * a[i + m] - a[i];
      if (!Number.isFinite(d)) continue;
      sum += d * d;
      n++;
    }
    if (n < 1) continue;
    const variance = sum / (6 * m * m * tau0 * tau0 * n);
    if (!Number.isFinite(variance) || variance < 0) continue;
    results.push({ tau, m, dev: Math.sqrt(variance), n });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Maximum Time Interval Error (MTIE)
// ---------------------------------------------------------------------------

/**
 * Maximum Time Interval Error (MTIE) from a phase series.
 *
 *   MTIE(tau) = max over all windows of (m+1) consecutive samples of
 *               ( max(x_k .. x_{k+m}) - min(x_k .. x_{k+m}) )
 *
 * Implemented with monotonic-deque sliding max/min so each tau is O(N)
 * regardless of window length m (no O(N*m) rescan).
 * Ref: ITU-T G.810; NIST SP1065 §5.9.
 *
 * @param {ArrayLike<number>} x   phase samples [s]
 * @param {number} tau0          sample interval [s]
 * @param {ArrayLike<number>} taus requested tau values [s]
 * @returns {{tau:number, m:number, val:number, n:number}[]}
 */
export function mtie(x, tau0, taus) {
  const a = toArray(x);
  const N = a.length;
  const results = [];
  if (!(tau0 > 0) || N < 2) return results;
  const pairs = tausToM(taus, tau0);

  for (const { tau, m } of pairs) {
    const win = m + 1; // window length in samples
    if (win > N) continue;

    // Sliding window max/min via monotonic deques over indices; only FINITE
    // samples enter the deques. A separate counter tracks how many non-finite
    // samples currently sit inside the window, so a NaN ANYWHERE in the window
    // (not just at the current extremes) disqualifies it.
    const maxDq = []; // indices, values decreasing
    const minDq = []; // indices, values increasing
    let best = -Infinity;
    let n = 0;
    let nanInWin = 0;

    for (let i = 0; i < N; i++) {
      const v = a[i];
      if (Number.isFinite(v)) {
        while (maxDq.length && a[maxDq[maxDq.length - 1]] <= v) maxDq.pop();
        maxDq.push(i);
        while (minDq.length && a[minDq[minDq.length - 1]] >= v) minDq.pop();
        minDq.push(i);
      } else {
        nanInWin++;
      }

      // Evict indices (and account for a departing non-finite sample) outside
      // the window [i-win+1, i].
      const lo = i - win + 1;
      while (maxDq.length && maxDq[0] < lo) maxDq.shift();
      while (minDq.length && minDq[0] < lo) minDq.shift();
      const left = i - win; // index that just fell out of the window
      if (left >= 0 && !Number.isFinite(a[left])) nanInWin--;

      // Measure only a full window whose every sample is finite: then the
      // deques hold all window samples and their heads are the true extrema.
      if (i >= win - 1 && nanInWin === 0) {
        const spread = a[maxDq[0]] - a[minDq[0]];
        if (spread > best) best = spread;
        n++;
      }
    }

    if (n < 1 || !Number.isFinite(best)) continue;
    results.push({ tau, m, val: best, n });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 + Box-Muller) — deterministic, no Math.random
// ---------------------------------------------------------------------------

/**
 * mulberry32 PRNG. Returns a function producing uniform floats in [0,1).
 * @param {number} seed  32-bit integer seed
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard-normal generator (Box-Muller) driven by a seeded uniform source.
 * @param {() => number} rng
 * @returns {() => number}
 */
function gaussian(rng) {
  let spare = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0, s = 0;
    do {
      u = 2 * rng() - 1;
      v = 2 * rng() - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

/**
 * Least-squares slope of log10(y) vs log10(x) over the provided points.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number} slope
 */
function logLogSlope(xs, ys) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!(xs[i] > 0) || !(ys[i] > 0)) continue;
    const lx = Math.log10(xs[i]);
    const ly = Math.log10(ys[i]);
    sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; k++;
  }
  if (k < 2) return NaN;
  return (k * sxy - sx * sy) / (k * sxx - sx * sx);
}

/**
 * Run self-consistency and known-slope checks with a seeded PRNG (never
 * Math.random). Returns { pass, checks:[{name, ok, detail}] }.
 *
 * Checks:
 *  (a) white FM  -> OADEV log-log slope near -0.5 (+/-0.15)
 *  (b) random-walk FM -> OADEV slope near +0.5 (+/-0.15)
 *  (c) pure frequency offset (linear phase ramp) -> OADEV much smaller than
 *      the white-FM noise case (Allan rejects a constant frequency offset)
 *  (d) TDEV(tau) == tau/sqrt(3) * MDEV(tau) exactly for our own outputs
 *
 * @param {number} [seed=12345]
 * @returns {{pass:boolean, checks:{name:string, ok:boolean, detail:string}[]}}
 */
export function selfTest(seed = 12345) {
  const checks = [];
  const tau0 = 1;
  const N = 20000;

  // Fit slope over an interior decade of octave taus to avoid end effects.
  function slopeOverDecade(devs) {
    const taus = [], vals = [];
    for (const d of devs) { taus.push(d.tau); vals.push(d.dev); }
    // Use taus roughly in [4, 512] (interior, well-averaged region).
    const xs = [], ys = [];
    for (let i = 0; i < taus.length; i++) {
      if (taus[i] >= 4 && taus[i] <= 512) { xs.push(taus[i]); ys.push(vals[i]); }
    }
    return logLogSlope(xs, ys);
  }

  // (a) White FM: integrate white frequency noise -> phase.
  // y_i = white gaussian; x = cumulative integral.
  {
    const rng = gaussian(mulberry32(seed));
    const y = new Array(N - 1);
    for (let i = 0; i < N - 1; i++) y[i] = rng();
    const x = freqToPhase(y, tau0, 0);
    const taus = autoTaus(x.length, tau0, { mode: 'octave' });
    const dev = oadev(x, tau0, taus);
    const slope = slopeOverDecade(dev);
    const ok = Number.isFinite(slope) && Math.abs(slope - (-0.5)) <= 0.15;
    checks.push({
      name: 'white-FM OADEV slope ~ -0.5',
      ok,
      detail: `slope=${slope.toFixed(3)} (target -0.5 +/-0.15)`,
    });
    // Stash the white-FM level near tau~8 for check (c).
    selfTest._whiteFMdev = dev.find((d) => d.tau === 8)?.dev ?? dev[3]?.dev ?? NaN;
  }

  // (b) Random-walk FM: integrate white FREQUENCY twice.
  // y follows a random walk (cumulative sum of white); phase = integral of y.
  {
    const rng = gaussian(mulberry32(seed ^ 0x9e3779b9));
    const y = new Array(N - 1);
    let acc = 0;
    for (let i = 0; i < N - 1; i++) { acc += rng(); y[i] = acc; }
    const x = freqToPhase(y, tau0, 0);
    const taus = autoTaus(x.length, tau0, { mode: 'octave' });
    const dev = oadev(x, tau0, taus);
    const slope = slopeOverDecade(dev);
    const ok = Number.isFinite(slope) && Math.abs(slope - 0.5) <= 0.15;
    checks.push({
      name: 'random-walk-FM OADEV slope ~ +0.5',
      ok,
      detail: `slope=${slope.toFixed(3)} (target +0.5 +/-0.15)`,
    });
  }

  // (c) Pure frequency offset: constant fractional frequency d.
  // Phase ramp x_i = d * i * tau0. The second difference is identically zero,
  // so OADEV should be ~0 (bounded by floating-point rounding), and in
  // particular << the white-FM noise level.
  {
    const d = 1e-9; // 1 ppb frequency offset
    const x = new Array(N);
    for (let i = 0; i < N; i++) x[i] = d * i * tau0;
    const taus = autoTaus(N, tau0, { mode: 'octave' });
    const dev = oadev(x, tau0, taus);
    const rampLevel = dev.find((r) => r.tau === 8)?.dev ?? (dev[3]?.dev ?? Infinity);
    const noiseLevel = selfTest._whiteFMdev;
    const ok =
      Number.isFinite(rampLevel) &&
      Number.isFinite(noiseLevel) &&
      rampLevel < noiseLevel * 1e-3;
    checks.push({
      name: 'frequency offset -> OADEV ~ 0 (<< noise)',
      ok,
      detail: `ramp OADEV=${rampLevel.toExponential(2)} vs whiteFM=${Number(noiseLevel).toExponential(2)} (ratio ${(rampLevel / noiseLevel).toExponential(2)})`,
    });
  }

  // (d) TDEV == tau/sqrt(3) * MDEV exactly for our own outputs.
  {
    const rng = gaussian(mulberry32(seed ^ 0x51ed270b));
    const y = new Array(N - 1);
    for (let i = 0; i < N - 1; i++) y[i] = rng();
    const x = freqToPhase(y, tau0, 0);
    const taus = autoTaus(x.length, tau0, { mode: 'octave' });
    const md = mdev(x, tau0, taus);
    const td = tdev(x, tau0, taus);
    let maxRelErr = 0;
    let compared = 0;
    for (let i = 0; i < md.length && i < td.length; i++) {
      if (md[i].tau !== td[i].tau) continue;
      const expected = (md[i].tau / Math.sqrt(3)) * md[i].dev;
      const got = td[i].dev;
      const rel = expected === 0 ? Math.abs(got) : Math.abs(got - expected) / Math.abs(expected);
      if (rel > maxRelErr) maxRelErr = rel;
      compared++;
    }
    const ok = compared > 0 && maxRelErr <= 1e-12;
    checks.push({
      name: 'TDEV = tau/sqrt(3) * MDEV (exact)',
      ok,
      detail: `max rel err=${maxRelErr.toExponential(2)} over ${compared} taus`,
    });
  }

  // (e) White PM: x_i = white gaussian PHASE directly. This pins MDEV's m^4
  // normalization: MDEV(white PM) ~ tau^-3/2 (slope -1.5); a wrong m^3 gives
  // ~ -1.0. Also assert the exact identity MDEV(m=1) == OADEV(m=1).
  {
    const rng = gaussian(mulberry32(seed ^ 0x2545f491));
    const x = new Array(N);
    for (let i = 0; i < N; i++) x[i] = rng();
    const taus = autoTaus(N, tau0, { mode: 'octave' });
    const md = mdev(x, tau0, taus);
    const slope = slopeOverDecade(md);
    const okSlope = Number.isFinite(slope) && Math.abs(slope - (-1.5)) <= 0.2;
    const oa = oadev(x, tau0, taus);
    const md1 = md.find((r) => r.m === 1)?.dev;
    const oa1 = oa.find((r) => r.m === 1)?.dev;
    const scale = Math.max(Math.abs(md1) || 0, Math.abs(oa1) || 0, 1e-300);
    const okId = Number.isFinite(md1) && Number.isFinite(oa1) && Math.abs(md1 - oa1) <= 1e-9 * scale;
    checks.push({
      name: 'white-PM MDEV slope ~ -1.5 & MDEV(m=1)==OADEV(m=1)',
      ok: okSlope && okId,
      detail: `slope=${Number(slope).toFixed(3)} (target -1.5 +/-0.2); md1=${Number(md1).toExponential(3)} oa1=${Number(oa1).toExponential(3)}`,
    });
  }

  const pass = checks.every((c) => c.ok);
  return { pass, checks };
}
