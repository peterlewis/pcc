// freq_hold_check.mjs — frequency hold (freq_hold = on): steer out the oscillator's own offset in holdover.
// In holdover the display runs on the SysTick at its nominal reload, so it drifts at the oscillator's
// offset from nominal. The firmware measures that offset every locked second (DWT ticks between PPS
// edges, minus 80,000,000) and, with freq_hold on, applies it once GPS is lost.
// This drives the firmware's own learner and governor: the estimate (median of 16 s blocks, the block
// in progress never used), its gates, the 1/16-tick steering, how it adds to the temperature steering,
// and a replay of REAL data recorded from a production Mk IV (conform/fixtures/hse_dwt_*.json).
// Run: node freq_hold_check.mjs
import { readFileSync } from 'node:fs';
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']), cfg = w('emu_config_line', 'void', ['string']);
const fhReset = w('emu_fh_reset'), edge = w('emu_fh_edge', 'void', ['number', 'number']), missed = w('emu_fh_missed_edge');
const estimate = w('emu_fh_estimate', 'number'), blocks = w('emu_fh_blocks', 'number'), setTemp = w('emu_fh_temp', 'void', ['number']);
const second = w('emu_fh_second', 'number', ['number']), steering = w('emu_fh_steering', 'number'), dispPpm = w('emu_fh_disp_ppm', 'number');
const setTc = w('emu_set_tc', 'void', ['number', 'number']);
const setModel = w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']);
const dumpStart = w('emu_tc_dump_start'), dumpNext = w('emu_tc_dump_next', 'string');
const NONE = -2000000000, WARM = 11;      // 1 edge to anchor + 10 to settle before a sample counts

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const lock = (ds) => { for (const d of ds) { edge(d, 1); second(1); } };          // locked seconds
const rep = (d, n) => Array(n).fill(d);
const hold = (n) => { const r = []; for (let i = 0; i < n; i++) r.push(second(0)); return r; };   // holdover seconds
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fresh = (on) => { bootCold(1718971200); cfg(`freq_hold = ${on ? 'on' : 'off'}`); cfg('tc_max_ppm = 100'); setTc(0, 0); fhReset(); setTemp(30); second(1); };
const dumpLine = () => { dumpStart(); let hit = ''; for (let i = 0; i < 14; i++) { const l = dumpNext(); if (l.startsWith('# freq_hold')) hit = l.trim(); } return hit; };

// 1. Off: nothing is learned, nothing is steered. The significance fade's bound learns the same
//    offset, so "nothing is learned" holds only with that off too (both are on by default).
fresh(false); cfg('significance_fade = off');
lock(rep(10, WARM + 80));
check('off (and significance_fade off): no estimate is kept', estimate() === NONE && blocks() === 0);
check('off: holdover is not steered', sum(hold(30).map(Math.abs)) === 0 && steering() === 0);
check(`off: tc_dump says so ("${dumpLine()}")`, dumpLine() === '# freq_hold: off');

// 2. The estimate needs three completed 16 s blocks, and is their median in 1/16 tick per second.
fresh(true);
lock([10]);                                           // switched on while running: the first edge only establishes that edges are consecutive
lock(rep(10, WARM + 32));
check('two blocks: no estimate yet', blocks() === 2 && estimate() === NONE);
check(`... and tc_dump says what it needs ("${dumpLine()}")`, /needs 48 s/.test(dumpLine()));
lock(rep(10, 16));
check('three blocks of +10 ticks/s: estimate is 160 sixteenths', blocks() === 3 && estimate() === 160);
check(`locked: the HSE row shows the measured offset (${dispPpm().toFixed(4)} ppm)`, Math.abs(dispPpm() - 0.125) < 1e-6);
check('locked: nothing is steered', steering() === 0);

// 3. Holdover: unsteered until tc_engage_s (2 s), then the measured rate, a step in rate only.
{
  const r = hold(12);
  check(`holdover: first second unsteered, then +10 ticks/s (${r.slice(0, 5).join(',')}...)`, r[0] === 0 && r.slice(1).every((v) => v === 10) && steering() === 1);
  check('re-lock: steering stops at once', second(1) === 0 && steering() === 0);
}

// 4. Sixteenths: a mean of 9.8125 ticks/s is applied exactly, as 9s and 10s.
fresh(true);
lock(rep(10, WARM)); for (let b = 0; b < 5; b++) lock([...rep(10, 13), ...rep(9, 3)]);    // each block sums to 157
check('five blocks summing to 157: estimate 157', estimate() === 157);
{
  const r = hold(1 + 1600).slice(1);
  check(`1600 s of holdover apply exactly 15,700 ticks (got ${sum(r)}), each second 9 or 10`, sum(r) === 15700 && r.every((v) => v === 9 || v === 10));
  check(`tc_dump reports it ("${dumpLine()}")`, dumpLine() === '# freq_hold: +0.1227 ppm over 80 s of lock');
}

// 5. A slow oscillator: negative rates floor and carry correctly.
fresh(true);
lock(rep(-7, WARM)); for (let b = 0; b < 5; b++) lock([...rep(-7, 12), ...rep(-8, 4)]);  // each block sums to -116
{
  const r = hold(1 + 1600).slice(1);
  check(`negative: estimate -116, 1600 s apply exactly -11,600 ticks (got ${sum(r)}), each -7 or -8`, estimate() === -116 && sum(r) === -11600 && r.every((v) => v === -7 || v === -8));
}

// 6. The median ignores one bad block; the block in progress is never used.
fresh(true);
lock(rep(10, WARM)); lock(rep(10, 32)); lock(rep(50, 16)); lock(rep(10, 16));
check('four blocks, one of them +50 ticks/s: the median is still 160', blocks() === 4 && estimate() === 160);
lock(rep(10, 16));
check('five blocks, one bad: still 160', blocks() === 5 && estimate() === 160);
lock(rep(1000, 15));                                  // GPS degrading: 15 s of a bent PPS, block not complete
check('15 s of a bent PPS just before the loss do not move the estimate', estimate() === 160);
check('... and holdover steers at the good rate', hold(4)[3] === 10);

// 7. Gates: an edge with no fix, a missed edge, and a >100 ppm step each restart the block in progress.
fresh(true);
lock(rep(10, WARM + 16));
check('gates setup: one block', blocks() === 1);
lock(rep(10, 8)); edge(10, 0); second(1);             // no valid fix at this edge
lock(rep(10, WARM + 15));
check('an edge without a fix: the half block is dropped and the receiver re-settles', blocks() === 1);
lock(rep(10, 1));
check('... the next full block counts', blocks() === 2);
lock(rep(10, 8)); missed(); lock(rep(10, WARM + 15));
check('a missed edge: likewise', blocks() === 2);
lock(rep(10, 1)); lock(rep(10, 8)); lock([9000]); lock(rep(10, 15));
check('a 112 ppm step: the half block is dropped', blocks() === 3);
lock(rep(10, 1));
check('... and the estimate was never bent', blocks() === 4 && estimate() === 160);

// 8. With tempcomp: the two corrections add; temperature moves are slewed at 0.25 ppm/s.
fresh(true);
setTc(0, 1); setModel(0.05, 0.0, -8, 70, 5000, 0.3);  // 0.05 ppm/degC = 4 ticks/s per degree
lock(rep(10, WARM + 80));
{
  const r = hold(6);
  check('with tempcomp, no temperature change: just the measured +10', r[5] === 10);
  setTemp(34);                                        // +4 degC since the loss: +16 ticks/s
  check(`+4 degC: +10 measured and +16 modelled = +26 (got ${second(0)})`, second(0) === 26);
  setTemp(60);                                        // +30 degC: +120 ticks/s wanted
  const a = second(0), b = second(0);
  check(`a big temperature step is slewed at 20 ticks/s per second (${a}, ${b})`, a === 46 && b === 66);
}

// 9. tc_max_ppm clamps the total.
fresh(true); cfg('tc_max_ppm = 1');                   // 1 ppm = 80 ticks/s
lock(rep(100, WARM + 80));
{ const r = hold(4); check(`clamp: a +100 ticks/s offset is applied as +80 (got ${r[3]})`, r[3] === 80); }
cfg('tc_max_ppm = 100');

// 10. Real data. 2.5 h of per-second DWT errors recorded from a production Mk IV, mean +0.10 ppm.
//     Lock on a stretch of it, lose GPS, and let the firmware hold over the next hour of the SAME
//     recording: the true drift is the recorded error minus what the firmware applied.
{
  const fx = JSON.parse(readFileSync(new URL('./conform/fixtures/hse_dwt_2026-11-11.json', import.meta.url)));
  const d = fx.ticks, US = 12.5e-3;                   // one tick is 12.5 ns
  let worstOn = 0, bestOff = Infinity; const rows = [];
  for (const t0 of [1800, 2700, 3600, 4500, 5400]) {
    fresh(true);
    lock(d.slice(t0 - 600, t0));
    const est = estimate();
    let on = 0, off = 0;
    for (let i = 0; i < 3600; i++) { const applied = second(0); on += d[t0 + i] - applied; off += d[t0 + i]; }
    rows.push(`loss at ${t0} s: estimate ${(est / 16).toFixed(2)} ticks/s, after 1 h unsteered ${(off * US).toFixed(0)} us, steered ${(on * US).toFixed(1)} us`);
    worstOn = Math.max(worstOn, Math.abs(on * US)); bestOff = Math.min(bestOff, Math.abs(off * US));
  }
  for (const r of rows) console.log('      ' + r);
  check(`real data: unsteered, an hour of holdover drifts at least 250 us every time (least ${bestOff.toFixed(0)} us)`, bestOff > 250);
  check(`real data: with freq_hold it stays within 100 us every time (worst ${worstOn.toFixed(1)} us)`, worstOn < 100);
  check(`real data: at least ${(bestOff / worstOn).toFixed(0)}x better in the worst case`, bestOff / worstOn >= 4);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
