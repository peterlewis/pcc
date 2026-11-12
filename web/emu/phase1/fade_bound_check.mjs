// fade_bound_check.mjs — the significance fade's bound, rebuilt from recorded data.
// The fade dims a sub-second digit as the bound U(t) on the display's time error approaches half that
// digit's place value. The first bound was a guess (0.02 ppm * sqrt(calibration age), three-sigma).
// Against 24 days of 1 Hz records from a production Mk IV it was 6 to 350 times too large: the ms
// digit went dark about 6 minutes into a holdover when it was really good for about 50 minutes.
// The bound is now: (the measured oscillator offset, if it is being left in) * t, plus a wander term
// K * a * t^1.5 whose level a the clock learns from its own 1024 s frequency changes, never below a
// floor. This checks the arithmetic against the same formula written here, the learner, what each
// steering mode charges, how long each digit now stays lit, and - on real recorded data - that the
// true error stays inside the bound. Run: node fade_bound_check.mjs
import { readFileSync } from 'node:fs';
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']), cfg = w('emu_config_line', 'void', ['string']);
const fhReset = w('emu_fh_reset'), edge = w('emu_fh_edge', 'void', ['number', 'number']), missed = w('emu_fh_missed_edge');
const second = w('emu_fh_second', 'number', ['number']), setTc = w('emu_set_tc', 'void', ['number', 'number']);
const hold2 = w('emu_force_holdover2', 'void', ['number', 'number']), uUs = w('emu_holdover_u_us', 'number');
const fade = w('emu_digit_fade', 'number', ['number']);          // 0 ds, 1 cs, 2 ms; 0..255
const fwCount = w('emu_fw_count', 'number'), fwVar = w('emu_fw_var', 'number'), fwUsed = w('emu_fw_used', 'number');
const dumpStart = w('emu_tc_dump_start'), dumpNext = w('emu_tc_dump_next', 'string');

const K = 6.5, C0 = 1.0, SE = 0.25, A_FLOOR = 0.1475, A_DEFAULT = 0.59, B_UNKNOWN = 10 * 80, TPP = 80, ENGAGE = 2;
const WARM = 11, WINDOW = 1024;
// The firmware's bound, written out again: us at t seconds, given what is left in (ticks/s) and the wander variance.
const bound = (t, leftIn, aVar, steeredOffset = 0) => C0 + steeredOffset / TPP * Math.min(t, ENGAGE) + (leftIn + K * Math.sqrt(SE * SE + aVar / WINDOW * t)) / TPP * t;

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const lock = (ds) => { for (const d of ds) { edge(d, 1); second(1); } };
const rep = (d, n) => Array(n).fill(d);
const U = (t) => { hold2(t, t); return uUs(); };
const fresh = (freqHold) => { bootCold(1718971200); cfg('significance_fade = on'); cfg(`freq_hold = ${freqHold ? 'on' : 'off'}`); cfg('tc_max_ppm = 100'); setTc(0, 0); fhReset(); second(1); lock([10]); };
const engage = () => { second(0); second(0); second(0); };       // lose GPS: the governor engages at 2 s
const dumpLine = () => { dumpStart(); let hit = ''; for (let i = 0; i < 16; i++) { const l = dumpNext(); if (l.startsWith('# fade')) hit = l.trim(); } return hit; };

// 1. An oscillator never measured against GPS is charged a datasheet-scale offset: dark within a minute.
fresh(false); engage();
check(`never measured: U(60 s) = ${U(60).toFixed(0)} us, as computed (10 ppm left in)`, near(U(60), bound(60, B_UNKNOWN, A_DEFAULT)));
check('never measured: the ms digit is dark at 60 s', (U(60), fade(2)) === 0);

// 2. Measured, not steered: the offset is charged in full, plus the default wander.
fresh(false); lock(rep(10, WARM + 80)); engage();
for (const t of [60, 600, 3600, 21600])
  check(`measured +10 ticks/s, unsteered: U(${t} s) = ${U(t).toFixed(1)} us, as computed`, near(U(t), bound(t, 10, A_DEFAULT)));

// 3. freq_hold steering it out: the offset is not charged, only the 2 s before steering engaged.
fresh(true); lock(rep(10, WARM + 80)); engage();
for (const t of [60, 600, 3600, 21600])
  check(`same clock with freq_hold: U(${t} s) = ${U(t).toFixed(1)} us, as computed`, near(U(t), bound(t, 0, A_DEFAULT, 10)));
check(`an hour in: ${bound(3600, 10, A_DEFAULT).toFixed(0)} us unsteered against ${U(3600).toFixed(0)} us held`, U(3600) < 0.55 * bound(3600, 10, A_DEFAULT));

// 4. The bound only grows, in both modes, and no digit ever relights.
for (const fh of [false, true]) {
  fresh(fh); lock(rep(10, WARM + 80)); engage();
  let grows = true, relit = false, prev = -1, pf = [255, 255, 255];
  for (let t = 3; t < 200000; t = Math.ceil(t * 1.07)) {
    const u = U(t); if (u < prev) grows = false; prev = u;
    for (let k = 0; k < 3; k++) { const f = fade(k); if (f > pf[k]) relit = true; pf[k] = f; }
  }
  check(`${fh ? 'freq_hold' : 'unsteered'}: U(t) only grows from 3 s to 55 h, and no digit relights`, grows && !relit);
}

// 5. The wander learner. A steady oscillator learns a level below the floor: the floor holds.
fresh(true); lock(rep(10, WARM));
lock(rep(10, 7 * WINDOW));
check(`7 windows: ${fwCount()} pairs learned, still the default (${fwUsed().toFixed(3)})`, fwCount() === 6 && fwUsed() === Math.fround(A_DEFAULT));
lock(rep(10, 2 * WINDOW));
check(`9 windows of a steady oscillator: learned variance ${fwVar().toExponential(1)}, the floor is used (${fwUsed().toFixed(4)})`, fwCount() === 8 && fwVar() < 1e-6 && near(fwUsed(), A_FLOOR, 1e-4));
engage();
check(`at the floor with freq_hold: U(1 h) = ${U(3600).toFixed(1)} us, as computed`, near(U(3600), bound(3600, 0, A_FLOOR, 10)));
check(`tc_dump reports it ("${dumpLine()}")`, /^# fade: wander 150 e-12\/rt-s \(floor, 8 windows\), \+-223 us at 1 h/.test(dumpLine()));

// 6. How long each digit now stays lit on a settled clock with freq_hold (the first bound: ms dark by 6 min).
{
  const lit = (t, k) => { U(t); return fade(k); };
  check('ms digit: full at 1 h', lit(3600, 2) === 255);
  check(`ms digit: fading at 1.5 h (${lit(5400, 2)}/255)`, lit(5400, 2) > 0 && lit(5400, 2) < 255);
  check('ms digit: dark at 2 h', lit(7200, 2) === 0);
  check('cs digit: full at 4 h, dark at 12 h', lit(14400, 1) === 255 && lit(43200, 1) === 0);
  check('ds digit: full at 24 h', lit(86400, 0) === 255);
}

// 7. A wandering oscillator learns a level above the floor, and the bound widens with it.
fresh(true); lock(rep(10, WARM));
for (let k = 0; k < 10; k++) lock(rep(k % 2 ? 12 : 10, WINDOW));   // window means alternate 10, 12 ticks/s: half the squared change is 2
check(`means alternating by 2 ticks/s: learned variance ${fwVar().toFixed(3)} (expected 2), used as is`, near(fwVar(), 2, 0.01) && near(fwUsed(), 2, 0.01));
engage();
check(`... and U(1 h) = ${U(3600).toFixed(0)} us, as computed, wider than at the floor`, near(U(3600), bound(3600, 0, 2, 11)) && U(3600) > 3 * bound(3600, 0, A_FLOOR));

// 8. A break in the edges breaks the window: no pair is learned across it.
fresh(true); lock(rep(10, WARM)); lock(rep(10, 3 * WINDOW));
const before = fwCount();
lock(rep(10, 500)); missed(); lock(rep(10, WARM + 2 * WINDOW - 1));
check(`a missed edge mid-window: no pair counted until two whole windows follow (${before} -> ${fwCount()})`, before === 2 && fwCount() === 2);
lock(rep(10, 16));
check('... then learning resumes', fwCount() === 3);

// 9. Real data: 2.5 h of per-second errors recorded from a production Mk IV. Lock on a stretch, lose
//    GPS, and compare the bound with what the oscillator really did over the following hour.
{
  const fx = JSON.parse(readFileSync(new URL('./conform/fixtures/hse_dwt_2026-11-11.json', import.meta.url)));
  const d = fx.ticks, TICK_US = 12.5e-3;
  let inside = true, worst = 0, rows = [], lit1h = true;
  for (const fh of [true, false]) for (const t0 of [1800, 3600, 5400]) {
    fresh(fh); lock(d.slice(t0 - 900, t0)); engage();
    let trueTicks = d[t0] + d[t0 + 1] + d[t0 + 2], applied = 0, maxRatio = 0;
    for (let i = 3; i < 3600; i++) {
      const a = second(0); applied += a; trueTicks += d[t0 + i];
      if ((i + 1) % 300 === 0) {
        const err = Math.abs(trueTicks - applied) * TICK_US, u = U(i + 1);
        if (err > u) inside = false;
        maxRatio = Math.max(maxRatio, err / u);
        if (i + 1 === 3600) { rows.push(`${fh ? 'freq_hold' : 'unsteered'}, loss at ${t0} s: real error after 1 h ${err.toFixed(1)} us, bound ${u.toFixed(0)} us, ms digit ${fade(2)}/255`); if (fh && fade(2) === 0) lit1h = false; }
        hold2(i + 1, i + 1);
      }
    }
    worst = Math.max(worst, maxRatio);
  }
  for (const r of rows) console.log('      ' + r);
  check(`real data: the true error is inside the bound at every 5 minutes of every replay (closest: ${(100 * worst).toFixed(0)}% of it)`, inside);
  check('real data: with freq_hold the ms digit is still lit after an hour', lit1h);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
