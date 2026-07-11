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

// ---- Display + serial: exercise the firmware's OWN sendDate()/adev_dump_step() formatting --------
const rowPtr  = w('emu_daterow',    'number');
const renderM = w('emu_render_mode','void', ['number']);
const adevLine= w('emu_adev_line',  'string');
const MODE_ADEV = w('emu_MODE_ADEV','number')();
// read [1..10], stopping at the CMD_RELOAD_TEXT (0x92) / '\n' sendDate appends, or any non-print byte
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };

// (3) filling fallback: no samples -> noct 0 -> "Adev ----"
A.reset(); A.reduce(); renderM(MODE_ADEV);
const rf = row();
check(`display: empty ring shows "${rf}"`, rf.startsWith('Adev') && rf.includes('----'));

// (4) live render: push a series, reduce, render. The row must be a well-formed compact scientific
// "<tau>s <mantissa>e<exp>" that fits the 10-char date row (whichever octave the current page shows).
{
  const raw = series('wfm', 300, 0x33);
  A.reset(); for (let i = 0; i < 300; i++) A.push(Math.round(raw[i] * 1000)); A.reduce();
  renderM(MODE_ADEV);
  const r = row();
  const wellFormed = /^\d{1,4}s ?\d(\.\d)?e[+-]?\d+$/.test(r) && r.length <= 10;
  check(`display: octave page renders "${r}" (<=10 ch, scientific)`, wellFormed);
}

// (5) $PMADEV serial dump: the firmware's own adev_dump_step() sentence. Verify the NMEA framing +
// checksum, the field count (2 + noct), and every sigma against the on-MCU sigma cache it dumps.
{
  const raw = series('wfm', 1024, 0x5c);
  A.reset(); for (let i = 0; i < 1024; i++) A.push(Math.round(raw[i] * 1000)); A.reduce();
  const line = adevLine().trim();                         // "$PMADEV,<valid>,<noct>,<s0>,..*CC"
  const mm = /^\$(PMADEV,[^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
  let ok = !!mm;
  if (ok) {
    const body = mm[1]; let cks = 0; for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
    const cksOk = cks === parseInt(mm[2], 16);
    const f = body.split(',');                            // [PMADEV, valid, noct, s0, s1, ...]
    const noct = parseInt(f[2], 10);
    const countOk = f.length === 3 + noct && noct === A.noct();
    let sigOk = noct > 0;
    for (let k = 0; k < noct; k++) {                      // each dumped sigma == the cache it read
      const got = parseFloat(f[3 + k]), want = A.sigma(1 << k);
      if (!(Math.abs(got / want - 1) < 5e-3)) sigOk = false;  // %.2e keeps 3 sig figs
    }
    ok = cksOk && countOk && sigOk;
  }
  check(`serial: $PMADEV framing+checksum+${mm ? mm[1].split(',').length - 3 : '?'} octaves match cache — "${line}"`, ok);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
