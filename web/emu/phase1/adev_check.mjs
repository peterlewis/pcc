// adev_check.mjs — the on-MCU Allan-deviation engine, verified against the double-precision oracle.
//
// Boots the real firmware WASM, injects a synthetic phase series through emu_adev_push (bypassing the
// DWT delta), and checks the firmware's int64-kernel overlapping ADEV two ways:
//   1. slope signature — white FM -> tau^-1/2, random-walk FM -> tau^+1/2 (proves it distinguishes noise);
//   2. per-tau cross-check vs adev_ref.oadev() on the SAME integer series (proves the MCU math == oracle).
// Run: node adev_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';
import { oadev, series } from './adev_ref.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const A = {
  bootCold: w('emu_boot_cold', 'void', ['number']),
  reset:  w('emu_adev_reset'),
  push:   w('emu_adev_push', 'void', ['number']),
  reduce: w('emu_adev_reduce'),
  sigma:  w('emu_adev_sigma', 'number', ['number']),
  noct:   w('emu_adev_noctave', 'number'),
};
const FCPU = 80000000;                 // firmware ADEV_FCPU — ticks/s; sigma is ticks-second-diff / (FCPU*m)
const N = 4096;
const OCT = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const results = [];
const check = (n, pass, x = '') => results.push({ n, pass: !!pass, x });

A.bootCold(1783627200);

// SKIP if this firmware branch has no ADEV engine (the #else stubs return noct 0).
A.reset(); for (let i = 0; i < 200; i++) A.push(i); A.reduce();
if (A.noct() === 0) { console.log('SKIP — firmware has no ADEV engine (not the sof-timestamp/adev branch)'); process.exit(0); }

function run(kind, scale, expSlope) {
  const raw = series(kind, N, 0xA5 + kind.length);
  const xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = Math.round(raw[i] * scale);   // integer ticks — identical both sides

  A.reset();
  for (let i = 0; i < N; i++) A.push(xs[i]);
  A.reduce();

  // (1) log-log slope of the firmware's own sigma vs m
  const pts = OCT.filter(m => 2 * m + 1 <= N)
    .map(m => [Math.log10(m), Math.log10(A.sigma(m))]).filter(p => isFinite(p[1]) && p[1] > -40);
  const n = pts.length,
    sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0),
    sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  check(`${kind}: firmware ADEV slope ${slope.toFixed(3)} (expect ${expSlope.toFixed(1)})`, Math.abs(slope - expSlope) < 0.12);

  // (2) per-tau cross-check vs the double-precision reference on the SAME ints
  let maxrel = 0, worst = 0;
  for (const m of OCT) {
    if (2 * m + 1 > N) break;
    const ref = oadev(xs, 1, m) / FCPU;   // oracle sigma_y (ticks -> fractional frequency)
    const got = A.sigma(m);
    if (ref > 0) { const rel = Math.abs(got / ref - 1); if (rel > maxrel) { maxrel = rel; worst = m; } }
  }
  check(`${kind}: firmware == reference across all tau (max rel err ${(maxrel * 100).toExponential(2)}% @ tau=${worst})`, maxrel < 1e-3);
}

run('wfm', 1000, -0.5);   // white FM  -> tau^-1/2
run('rwfm', 30, +0.5);    // random-walk FM -> tau^+1/2

// buffer-not-full behaviour: with 5 samples, only tau=1,2 are computable (need 2m+1). Use a
// non-linear series so the second differences are non-zero (a linear ramp is constant frequency ->
// ADEV 0 by construction, which the firmware also gets right — see the drift check in adev_ref).
A.reset(); for (const v of [0, 10, 15, 12, 20]) A.push(v); A.reduce();
check(`short buffer: tau=1,2 computable, tau=4 not (noct=${A.noct()})`, A.noct() === 2 && A.sigma(1) > 0 && A.sigma(4) === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
