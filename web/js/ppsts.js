// ppsts.js — parse the Precision Clock Mk IV "$PMTXTS" PPS-timing sentence and compute
// timing-stability metrics (phase jitter, oscillator drift, lock/holdover) that the plain
// NMEA stream cannot convey.
//
// Sentence (emitted once per PPS edge when the firmware config has `pps = on`):
//   $PMTXTS,<seq>,<epoch>,<subms>,<systick>,<load>,<calerr>,<sincecal>,<temp>,<flags>*CC
// See web/PPS_TIMESTAMP.md for the full contract. Must stay in sync with the firmware
// (mk4-time/Core/Src/main.c: capturePPS() / emitPPSTimestamp()).

export const LSE_HZ = 32768;       // RTC low-speed crystal (firmware)
export const CAL_PERIOD = 63;      // s, firmware CAL_PERIOD — divisor for the calerr→ppm conversion
export const TC_TREF = 25;         // °C, temperature-centring reference for temp-comp (MUST match firmware TC_TREF)

// min/max without argument-spread — `Math.max(...arr)` overflows the call stack on very long arrays.
function minmax(arr) { let lo = Infinity, hi = -Infinity; for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; }

// Parse one line. Returns a record object, or null if it isn't a (well-formed) $PMTXTS line.
// `checksumOK` is reported rather than thrown so callers can surface link errors.
export function parsePMTXTS(line) {
  if (typeof line !== 'string') return null;
  line = line.trim();
  if (!line.startsWith('$PMTXTS,')) return null;
  const star = line.lastIndexOf('*');
  if (star < 8) return null;
  const body = line.slice(1, star);              // chars between '$' and '*'
  const csTxt = line.slice(star + 1, star + 3);  // two hex digits

  let cks = 0;
  for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
  const checksumOK = /^[0-9a-fA-F]{2}$/.test(csTxt) && parseInt(csTxt, 16) === cks;

  const f = body.split(',');
  if (f[0] !== 'PMTXTS' || f.length < 10) return null;

  const seq = +f[1], epoch = +f[2], subms = +f[3], systick = +f[4],
        load = +f[5], calerr = parseInt(f[6], 10), sincecal = +f[7],
        temp = parseInt(f[8], 10), flags = parseInt(f[9], 16);

  if ([seq, epoch, subms, systick, load, sincecal].some(Number.isNaN) ||
      Number.isNaN(calerr) || Number.isNaN(temp) || Number.isNaN(flags) || load <= 0) return null;

  // Modelled sub-second position of the firmware clock at the true PPS edge, in ms.
  // SysTick is a down-counter (load→0, one ms tick at 0), so elapsed-into-this-ms = (load-val)/(load+1).
  const phaseMs = subms + (load - systick) / (load + 1);
  // Oscillator frequency error for the last calibration window, in ppm.
  const ppm = calerr * 1e6 / (LSE_HZ * CAL_PERIOD);

  return {
    raw: line, checksumOK,
    seq, epoch, subms, systick, load, calerr, sincecal, temp,
    phaseMs, ppm,
    valid: !!(flags & 0x1), hadPps: !!(flags & 0x2), rtcGood: !!(flags & 0x4),
  };
}

// Centre a sub-second phase (0..1000 ms) about zero, so values that straddle the second
// boundary (e.g. 999.8 and 0.3) don't inflate the statistics. Result in (-500, +500] ms.
export function centrePhase(phaseMs) {
  return phaseMs > 500 ? phaseMs - 1000 : phaseMs;
}

// Rolling monitor: feed it lines (or parsed records) and read derived stats for the charts.
export class PpsMonitor {
  constructor({ capacity = 900 } = {}) {   // ~15 min at 1 Hz
    this.capacity = capacity;
    this.records = [];
    this.lastSeq = null;
    this.gaps = 0;          // missed PPS edges (seq discontinuities)
    this.badChecksums = 0;
  }

  ingestLine(line) {
    const r = parsePMTXTS(line);
    if (!r) return null;
    if (!r.checksumOK) { this.badChecksums++; return r; }
    this.ingest(r);
    return r;
  }

  ingest(r) {
    if (this.lastSeq !== null) {
      const d = r.seq - this.lastSeq;   // firmware seq is 32-bit; no wrap in practice
      // Count only plausible small forward jumps as missed edges. A reboot (seq→0), reorder,
      // or duplicate (d ≤ 0) just resyncs without fabricating a huge gap.
      if (d > 1 && d < 256) this.gaps += d - 1;
    }
    this.lastSeq = r.seq;
    this.records.push(r);
    if (this.records.length > this.capacity) this.records.shift();
  }

  reset() { this.records = []; this.lastSeq = null; this.gaps = 0; this.badChecksums = 0; }

  // Phase-error series in microseconds, centred about the mean (the metric is *jitter*, not
  // absolute offset — absolute offset to GPS isn't observable through USB framing).
  phaseSeriesUs() {
    if (!this.records.length) return [];
    const centred = this.records.map((r) => centrePhase(r.phaseMs));
    const mean = centred.reduce((a, b) => a + b, 0) / centred.length;
    return centred.map((v) => (v - mean) * 1000);   // ms→µs
  }

  ppmSeries() { return this.records.map((r) => r.ppm); }
  tempSeries() { return this.records.map((r) => r.temp); }
  // Paired oscillator-error vs temperature samples — scatter this to see the crystal's curve.
  ppmVsTemp() { return this.records.map((r) => ({ temp: r.temp, ppm: r.ppm })); }

  stats() {
    const n = this.records.length;
    if (!n) return null;
    const last = this.records[n - 1];

    const us = this.phaseSeriesUs();
    const mean = us.reduce((a, b) => a + b, 0) / n;
    const variance = us.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const rms = Math.sqrt(variance);
    const [uMin, uMax] = minmax(us);

    const ppms = this.ppmSeries();
    const [ppmMin, ppmMax] = minmax(ppms);
    return {
      count: n,
      rmsJitterUs: rms,                 // 1σ phase jitter
      pkpkJitterUs: uMax - uMin,        // peak-to-peak phase jitter
      ppm: last.ppm,                    // latest oscillator error
      ppmMin,
      ppmMax,
      temp: last.temp,                  // latest die temperature (°C)
      sincecal: last.sincecal,          // holdover age (s since last calibration)
      valid: last.valid,
      hadPps: last.hadPps,
      rtcGood: last.rtcGood,
      gaps: this.gaps,
      badChecksums: this.badChecksums,
      // lock quality: a coarse readout for a status pill
      lock: !last.hadPps ? 'no-pps' : !last.valid ? 'acquiring' : rms < 50 ? 'locked' : 'unstable',
    };
  }
}

// ---- HSE / running-holdover characterisation ------------------------------------------------
// The captured SysTick `systick` count at each PPS is the clean per-second HSE phase residual
// (~1 ppm per 80 counts). It wraps 0↔load as the phase crosses a millisecond boundary, so we
// unwrap it modulo the SysTick period (load+1 counts) around its median, NOT at the second. The
// slope d(systick)/dT is the HSE temperature coefficient; the residual RMS is the true jitter
// (the absolute count is fixed ISR latency / systematic offset, irrelevant). Feed locked points
// {temp, systick, load}. (`systick` decreasing ⇒ the modelled clock ran faster ⇒ +ppm.)
export function fitHseTempco(points, { minPoints = 60, minSpanC = 6 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.temp) && Number.isFinite(p.systick) && p.load > 0);
  if (pts.length < minPoints) return { ok: false, reason: `need ≥${minPoints} samples (have ${pts.length})`, n: pts.length };
  const [tlo, thi] = minmax(pts.map((p) => p.temp));
  const span = thi - tlo;
  if (span < minSpanC) return { ok: false, reason: `need ≥${minSpanC} °C spread (have ${span} °C)`, n: pts.length, span };

  const period = pts[0].load + 1;                          // SysTick counts per ms (≈80000)
  const cPerPpm = period / 1000;                           // counts per ppm (≈80)
  const sorted = pts.map((p) => p.systick).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const unwrap = (s) => { let d = s - med; while (d > period / 2) d -= period; while (d < -period / 2) d += period; return med + d; };

  let n = 0, ST = 0, SS = 0, STT = 0, STS = 0;
  for (const { temp: T, systick } of pts) { const s = unwrap(systick); n++; ST += T; SS += s; STT += T * T; STS += T * s; }
  const d = n * STT - ST * ST;
  if (Math.abs(d) < 1e-9) return { ok: false, reason: 'degenerate (no temperature variation)', n, span };
  const slope = (n * STS - ST * SS) / d;                   // counts/°C
  const icept = (SS - slope * ST) / n;
  let ssRes = 0, ssTot = 0; const smean = SS / n;
  for (const { temp: T, systick } of pts) { const s = unwrap(systick); ssRes += (s - (slope * T + icept)) ** 2; ssTot += (s - smean) ** 2; }
  return {
    ok: true, n, span, tlo, thi,
    ppmPerC: -slope / cPerPpm,                             // counts→ppm; systick↓ ⇒ faster ⇒ +ppm
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    jitterNs: Math.sqrt(ssRes / n) * 1e9 / (period * 1000),// residual RMS in ns (1 count = 1/(period·1kHz) s)
  };
}

// ---- holdover temperature compensation: fit the crystal's ppm(T) curve ----------------------
// Solve a 3×3 linear system (Cramer's rule).
function det3(m) {
  return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
       - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
       + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
}
function solve3(M, V) {
  const d = det3(M);
  if (Math.abs(d) < 1e-12) return null;
  const col = (i) => M.map((row, ri) => row.map((c, ci) => (ci === i ? V[ri] : c)));
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

// Fit the crystal's error curve from {temp, ppm} samples (collected while GPS-locked) for holdover
// compensation. Model: ppm(T) = k0 + k1·(T−TC_TREF) + k2·(T−TC_TREF)²  — a TEMPERATURE-CENTRED
// quadratic, NOT a vertex form: a 32 kHz tuning fork over a modest sweep is nearly linear, and the
// vertex of that parabola lands thousands of °C away, where fixed-precision serialisation loses all
// accuracy. Centring on TC_TREF keeps the coefficients well-scaled and round-trip-safe. When the
// sweep is too narrow to trust curvature, it degrades to a line (k2 = 0) rather than extrapolating a
// poorly-constrained parabola. Emits the exact `temp_comp = k0,k1,k2` line the firmware parses.
//
// Returns { ok:false, reason } until usable, else { ok:true, mode, k0, k1, k2, n, span, rms,
//   quantum, turnover, configLine }. `quantum` is the ppm noise floor from calerr's integer step.
export function fitTempCompensation(points, { minPoints = 30, minSpanC = 8, curvatureSpanC = 15 } = {}) {
  const pts = points.filter((p) => Number.isFinite(p.temp) && Number.isFinite(p.ppm));
  if (pts.length < minPoints) return { ok: false, reason: `need ≥${minPoints} samples (have ${pts.length})`, n: pts.length };
  const [tlo, thi] = minmax(pts.map((p) => p.temp));
  const span = thi - tlo;
  if (span < minSpanC) return { ok: false, reason: `need ≥${minSpanC} °C temperature spread (have ${span} °C)`, n: pts.length, span };

  let n = pts.length, Su = 0, Su2 = 0, Su3 = 0, Su4 = 0, Sy = 0, Suy = 0, Su2y = 0;
  for (const { temp: T, ppm: y } of pts) {
    const u = T - TC_TREF, u2 = u * u;
    Su += u; Su2 += u2; Su3 += u2 * u; Su4 += u2 * u2;
    Sy += y; Suy += y * u; Su2y += y * u2;
  }

  let k0, k1, k2, mode;
  if (span >= curvatureSpanC) {                 // wide enough to trust curvature → full parabola
    const sol = solve3([[Su4, Su3, Su2], [Su3, Su2, Su], [Su2, Su, n]], [Su2y, Suy, Sy]);
    if (sol) { [k2, k1, k0] = sol; mode = 'parabola'; }
  }
  if (mode !== 'parabola') {                     // narrow sweep → fit a line, leave curvature at 0
    const d = n * Su2 - Su * Su;
    if (Math.abs(d) < 1e-9) return { ok: false, reason: 'degenerate fit — collect more temperature variation', n, span };
    k1 = (n * Suy - Su * Sy) / d; k0 = (Sy - k1 * Su) / n; k2 = 0; mode = 'linear';
  }

  let ss = 0;
  for (const { temp: T, ppm: y } of pts) { const u = T - TC_TREF; const f = k0 + k1 * u + k2 * u * u; ss += (y - f) ** 2; }
  const rms = Math.sqrt(ss / n);

  // Serialise as the FIRMWARE's seed vocabulary (tcSeedBlock), then PROVE the block round-trips:
  // re-parse the coefficient lines and check the curve across the operating window (data range
  // ± 10 °C margin) deviates < 0.5 ppm from the full-precision fit.
  const seed = tcSeedBlock({ k0, k1, k2, tlo, thi, n, rms });
  const rp = {};
  for (const line of seed.configBlock.split('\n')) {
    const m = line.match(/^tc_lse_([abc]) = (-?[\d.]+)$/);
    if (m) rp[m[1]] = parseFloat(m[2]);
  }
  let maxErr = 0;
  for (const T of [tlo - 10, (tlo + thi) / 2, thi + 10]) {
    const u = T - TC_TREF, x = T - seed.t0;
    maxErr = Math.max(maxErr, Math.abs((k0 + k1 * u + k2 * u * u) - (rp.a + rp.b * x + rp.c * x * x)));
  }
  if (maxErr > 0.5) return { ok: false, reason: 'serialisation precision too low (please report)', n, span };

  const quantum = 1e6 / (LSE_HZ * CAL_PERIOD);   // ≈0.484 ppm per calerr step — the real noise floor
  return {
    ok: true, mode, k0, k1, k2, n, span, tlo, thi, rms, quantum,
    turnover: k2 ? TC_TREF - k1 / (2 * k2) : null,   // implied parabola vertex (°C), for insight only
    ...seed,
  };
}

// Map a TC_TREF-centred host fit onto the FIRMWARE's seed vocabulary. $PMTXTS ppm is the RTC
// calibration error, i.e. the LSE curve, so the fit maps to tc_lse_a/b/c — re-centred onto a
// tc_t0 at the middle of the observed span (the block includes its own tc_t0 line, so it is
// self-consistent; note a paste re-centres any existing tc_hse_* seed too). Precisions match
// tc_dump. Line order matters: the firmware arms the warm-start when "tc_seed = on" parses, so
// it goes LAST. tc_dump on the clock stays canonical; this block is the host's independent
// estimate of the same curve. There are no tc_hse_* lines because the host cannot see the HSE
// separately over $PMTXTS — the firmware learns that on-die.
export function tcSeedBlock({ k0, k1, k2, tlo, thi, n, rms }) {
  const t0 = Math.min(80, Math.max(-30, Math.round((tlo + thi) / 2)));
  const d = t0 - TC_TREF;                        // shift: ppm(x+d) with x = T - t0
  const lseA = k0 + k1 * d + k2 * d * d;
  const lseB = k1 + 2 * k2 * d;
  const lseC = k2;
  const configBlock = [
    `# host LSE fit (PCC TIMING) — n=${n}, ${tlo.toFixed(0)}..${thi.toFixed(0)} C, rms ${rms.toFixed(2)} ppm`,
    `tc_t0 = ${t0}`,
    `tc_lse_a = ${lseA.toFixed(4)}`,
    `tc_lse_b = ${lseB.toFixed(5)}`,
    `tc_lse_c = ${lseC.toFixed(6)}`,
    `tc_seed_lo = ${Math.floor(tlo)}`,
    `tc_seed_hi = ${Math.ceil(thi)}`,
    `tc_seed = on`,
  ].join('\n');
  return { t0, lseA, lseB, lseC, configBlock };
}
