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

// buffer-not-full behaviour + the maturity gate: with 5 samples tau=2 is mathematically COMPUTABLE
// (needs 2m+1 = 5; sigma(2) > 0 via the direct call) but NOT published (adev_reduce requires
// valid >= 4m = 8 — a bare-minimum octave is a single second-difference with ~100% error bars, and
// the display must not show it at full authority). Non-linear series so second differences != 0.
A.reset(); for (const v of [0, 10, 15, 12, 20]) A.push(v); A.reduce();
check(`maturity gate: tau=2 computable but unpublished (noct=${A.noct()})`, A.noct() === 1 && A.sigma(1) > 0 && A.sigma(2) > 0 && A.sigma(4) === 0);
for (const v of [25, 21, 30]) A.push(v); A.reduce();       // valid=8 -> tau=2 crosses 4m
check(`tau=2 publishes at valid=8 (noct=${A.noct()})`, A.noct() === 2);

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
  const wellFormed = /^\d{1,4} \d(\.\d)?e[+-]?\d+$/.test(r) && r.length <= 10;   // no unit-s ('s' == the '5' glyph), always a separator
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
    const f = body.split(',');                            // [PMADEV, epoch, tau0, valid, noct, s0, ...]
    const epochOk = /^\d+$/.test(f[1]) && f[2] === '1';    // self-describing: unix epoch + tau0
    const noct = parseInt(f[4], 10);
    const countOk = epochOk && f.length === 5 + noct && noct === A.noct();
    let sigOk = noct > 0;
    for (let k = 0; k < noct; k++) {                      // each dumped sigma == the cache it read
      const got = parseFloat(f[5 + k]), want = A.sigma(1 << k);
      if (!(Math.abs(got / want - 1) < 5e-3)) sigOk = false;  // %.2e keeps 3 sig figs
    }
    ok = cksOk && countOk && sigOk;
  }
  check(`serial: $PMADEV framing+checksum+${mm ? mm[1].split(',').length - 3 : '?'} octaves match cache — "${line}"`, ok);
}

// ---- $PMHDEV: the Hadamard twin. Pure LINEAR FREQUENCY DRIFT (quadratic phase) is exactly what
// plain ADEV retains (sigma rising with tau) and the third-difference kernel annihilates: HDEV == 0.
{
  const hdevLine = w('emu_hdev_line', 'string');
  A.reset();
  for (let i = 0; i < 256; i++) A.push(3 * i * i);   // x_i = 3*i^2, integer-EXACT quadratic -> pure drift (rounding would leak into the 3rd difference)
  A.reduce();
  check(`drift series: ADEV sees the ramp (sigma1=${A.sigma(1)})`, A.sigma(1) > 0);
  const hl = hdevLine().trim();
  const hm = /^\$(PMHDEV,[^*]*)\*([0-9A-Fa-f]{2})$/.exec(hl);
  let hOk = !!hm;
  if (hOk) {
    const body = hm[1]; let cks = 0; for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
    const f = body.split(',');
    const noct = parseInt(f[4], 10);
    hOk = cks === parseInt(hm[2], 16) && /^\d+$/.test(f[1]) && f[2] === '1' && f.length === 5 + noct
          && noct > 0 && f.slice(5).every(v => parseFloat(v) === 0);   // third difference of quadratic phase = exactly 0
  }
  check(`$PMHDEV: framed, self-describing, and drift-immune (HDEV==0 on a pure ramp) — "${hl.slice(0, 40)}..."`, hOk);
}

// ---- the REAL capture path (adev_push_dwt): wrap exactness, missed-second tolerance, gap honesty ----
{
  const pushDwt = w('emu_adev_push_dwt', 'void', ['number', 'number']);
  const valid   = w('emu_adev_valid', 'number');
  const FCPU = 80000000;
  // (6) DWT wrap: a constant +80-tick/s frequency offset stepping ACROSS the 2^32 counter wrap is a
  // linear phase ramp -> every second difference is exactly 0 -> ADEV 0. Any wrap mishandling shows
  // up as a huge spike.
  A.reset();
  let dwt = 0xFFFF0000; // wraps within the first second
  for (let e = 0; e < 12; e++) { pushDwt(dwt >>> 0, 1000 + e); dwt = (dwt + FCPU + 80) % 4294967296; }
  A.reduce();
  check(`DWT 2^32 wrap: linear ramp stays exactly ADEV 0 across the wrap (sigma1=${A.sigma(1)})`, valid() === 12 && A.sigma(1) === 0   /* 1 restart + 11 contiguous */);

  // (7) ONE missed PPS second is tolerated (midpoint interpolation), not a record wipe.
  A.reset();
  dwt = 1000;
  for (let e = 0; e < 6; e++) { pushDwt(dwt >>> 0, 2000 + e); dwt = (dwt + FCPU + 80) % 4294967296; }
  const vBefore = valid();
  dwt = (dwt + FCPU + 80) % 4294967296;                       // the missed second elapses...
  pushDwt(dwt >>> 0, 2000 + 7);                               // ...next edge arrives at epoch delta 2
  check(`single missed PPS: record continues (+2 samples: ${vBefore} -> ${valid()})`, valid() === vBefore + 2);
  A.reduce();
  check(`interpolated midpoint keeps the ramp clean (sigma1=${A.sigma(1)})`, A.sigma(1) === 0);

  // (8) a real gap (>2 s) restarts AND zeroes noct IMMEDIATELY — the display must not keep painting
  // the stale pre-gap curve until the next page flip.
  check(`pre-gap noct > 0`, A.noct() > 0);
  pushDwt(dwt >>> 0, 2000 + 60);                              // 53 s hole
  check(`gap zeroes noct in the ISR path (noct=${A.noct()}, valid=${valid()})`, A.noct() === 0 && valid() === 1);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
