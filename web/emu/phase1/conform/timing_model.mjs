// Step-7 metrology: characterise the REAL clock's disciplined timing from a bench $PMTXTS capture,
// then build + VERIFY a phase-noise model the emulator can use so its precision/uncertainty claims
// are grounded in measurement rather than a flat assumption.
//
// $PMTXTS phase: the PPS edge is captured as SysTick->VAL (down-counter, 80 MHz, LOAD=79999) plus
// subms. The sub-second time error of the disciplined clock at each PPS is
//     x = subms*1e-3 + (LOAD - systick)/(LOAD+1) * 1e-3   seconds       (modelled ms position)
// We use the PPS-to-tick residual as the phase error series x_i and compute the OVERLAPPING Allan
// deviation sigma_y(tau) — the standard oscillator-stability estimator — plus the LSE ppm (calerr).
//
// LIMITATION: this capture is GPS-LOCKED throughout, so it characterises the DISCIPLINED phase
// noise (GPS PPS jitter + capture quantisation) and the LSE frequency error — NOT free-running
// holdover drift, which needs a GPS-unplugged capture (physical, not scriptable here).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRATCH = '/private/tmp/claude-501/-Users-peter-Developer-ML-Claude-pcc/704177bc-1d90-4ec5-a1b9-e0f5bc36ccdd/scratchpad/';
const CAP = process.argv[2] ||
  (existsSync(SCRATCH + 'clock-long.nmea') ? SCRATCH + 'clock-long.nmea' : SCRATCH + 'clock-golden-1783292680.nmea');

const CAL_PERIOD = 63, LSE_HZ = 32768, CORE_HZ = 80e6, LOAD = 79999;

// --- parse the capture -------------------------------------------------------------------------
const rows = readFileSync(CAP, 'utf8').split('\n').filter(l => l.startsWith('$PMTXTS'))
  .map(l => l.trim().split(','))
  .filter(f => f.length >= 9)
  .map(f => ({ seq: +f[1] >>> 0, epoch: +f[2] >>> 0, subms: +f[3], systick: +f[4], load: +f[5], calerr: +f[6], temp: +f[8] }));

// keep the longest contiguous (seq+1, epoch+1) run so Allan tau = k*1s is honest (no gaps)
let best = [], cur = [];
for (const r of rows) {
  if (cur.length && !(r.seq === cur[cur.length - 1].seq + 1 && r.epoch === cur[cur.length - 1].epoch + 1)) { if (cur.length > best.length) best = cur; cur = []; }
  cur.push(r);
}
if (cur.length > best.length) best = cur;
const N = best.length;

// phase error series x_i (seconds): modelled sub-second position of the PPS edge
const x = best.map(r => r.subms * 1e-3 + (r.load - r.systick) / (r.load + 1) * 1e-3);
const mean = x.reduce((a, b) => a + b, 0) / N;
const xz = x.map(v => v - mean);                                   // de-meaned (constant offset isn't instability)
const rmsNs = Math.sqrt(xz.reduce((a, b) => a + b * b, 0) / N) * 1e9;
const ppm = best.map(r => r.calerr * 1e6 / (LSE_HZ * CAL_PERIOD));
const ppmMean = ppm.reduce((a, b) => a + b, 0) / N;

// --- overlapping Allan deviation ---------------------------------------------------------------
function adev(xs, tau0 = 1) {
  const n = xs.length, out = [];
  for (let m = 1; m <= Math.floor((n - 1) / 2); m *= 2) {
    let s = 0, c = 0;
    for (let i = 0; i + 2 * m < n; i++) { const d = xs[i + 2 * m] - 2 * xs[i + m] + xs[i]; s += d * d; c++; }
    if (c > 0) out.push({ tau: m * tau0, sigma: Math.sqrt(s / (2 * c)) / (m * tau0) });
  }
  return out;
}
const measured = adev(xz);

// noise-type ID from the log-log slope of the first few points (white PM/flicker PM ~ -1; white FM ~ -0.5)
function slope(a) {
  const pts = a.slice(0, Math.min(4, a.length));
  const lx = pts.map(p => Math.log(p.tau)), ly = pts.map(p => Math.log(p.sigma));
  const mx = lx.reduce((s, v) => s + v, 0) / lx.length, my = ly.reduce((s, v) => s + v, 0) / ly.length;
  let num = 0, den = 0; for (let i = 0; i < lx.length; i++) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  return num / den;
}
const measSlope = slope(measured);

// --- MODEL: seeded generator whose phase noise reproduces the measured statistics ---------------
// slope ~ -1 => white phase modulation: x_i i.i.d. about the mean with the measured RMS. (If the
// data showed flicker/random-walk we'd add a coloured term; the disciplined GPS clock is PM-white.)
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const sigmaX = Math.sqrt(xz.reduce((a, b) => a + b * b, 0) / N);   // seconds
const rng = mulberry32(0x9e3779b9);
const model = [];
for (let i = 0; i < N; i++) model.push(gauss(rng) * sigmaX);
const modelAdev = adev(model);

// --- verify the model overlays the measured band -----------------------------------------------
let worstRatio = 1;
for (let i = 0; i < Math.min(measured.length, modelAdev.length); i++) {
  const r = modelAdev[i].sigma / measured[i].sigma;
  worstRatio = Math.max(worstRatio, r, 1 / r);
}
const OK = worstRatio <= 1.5;   // model within 1.5x of measurement at every tau

console.log(`\nDISCIPLINED TIMING METROLOGY  —  ${CAP.split('/').pop()}`);
console.log(`  contiguous locked samples : ${N} s`);
console.log(`  phase jitter (RMS)        : ${rmsNs.toFixed(1)} ns   (mean sub-ms offset ${(mean * 1e6).toFixed(2)} µs)`);
console.log(`  LSE frequency error       : ${ppmMean.toFixed(2)} ppm  (calerr ${best[0].calerr}, temp ${best[0].temp} °C)`);
console.log(`  Allan-dev noise slope     : ${measSlope.toFixed(2)}  (${measSlope < -0.75 ? 'white/flicker PM — disciplined' : 'FM — check'})`);
console.log(`\n  tau(s)   measured σy      model σy       ratio`);
for (let i = 0; i < Math.min(measured.length, modelAdev.length); i++) {
  const me = measured[i], mo = modelAdev[i], ratio = mo.sigma / me.sigma;
  console.log(`  ${String(me.tau).padStart(5)}   ${me.sigma.toExponential(2)}    ${mo.sigma.toExponential(2)}    ${ratio.toFixed(2)}${Math.abs(Math.log(ratio)) > Math.log(1.5) ? ' ✗' : ''}`);
}
console.log(`\n  model overlays measurement within ${worstRatio.toFixed(2)}x at every tau  ${OK ? '✓' : '✗'}`);
console.log(`  => emulator holdover uncertainty can be grounded on ${ppmMean.toFixed(1)} ppm LSE + ${rmsNs.toFixed(0)} ns disciplined jitter,`);
console.log(`     NOT a flat sigma. (Free-running holdover Allan-dev needs a GPS-unplugged capture — physical.)`);
process.exit(OK ? 0 : 1);
