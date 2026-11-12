// tc_temp_check.mjs — the holdover steering works from a filtered, sub-degree die temperature.
// tc_apply steers out the modelled change of the oscillator with temperature since GPS was lost. It
// read the temperature in whole degrees, so every 1 degree flip of the reading was a step in rate,
// the temperature "at loss" was frozen to the nearest degree, and the result was then rounded to
// whole ticks per second. Replayed on a production clock's recorded data, tc_apply cut the large
// holdover errors but doubled the typical one (7.6 -> 15.6 us at an hour); with the readings
// filtered it came back to about 9 us and the large errors improved again.
// This checks the firmware's own conversion and filter, and that a fraction of a degree now moves
// the steering. With the old code the fractional cases FAIL. Run: node tc_temp_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']), cfg = w('emu_config_line', 'void', ['string']);
const fhReset = w('emu_fh_reset'), second = w('emu_fh_second', 'number', ['number']), setTc = w('emu_set_tc', 'void', ['number', 'number']);
const setModel = w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']);
const tempInt = w('emu_fh_temp', 'void', ['number']), tempSet = w('emu_temp_set', 'void', ['number']), tempReset = w('emu_temp_reset');
const convert = w('emu_temp_convert', 'number', ['number', 'number', 'number']), feed = w('emu_temp_feed', 'void', ['number']), tempF = w('emu_temp_f', 'number');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const hold = (n) => { const r = []; for (let i = 0; i < n; i++) r.push(second(0)); return r; };
// tc_apply on, a model of 0.05 ppm/degC = 4 ticks/s per degree, locked, then GPS lost at temperature t0
const start = (t0, filtered = true) => {
  bootCold(1718971200); cfg('freq_hold = off'); cfg('tc_max_ppm = 100'); fhReset();
  setTc(0, 1); setModel(0.05, 0.0, -8, 70, 5000, 0.3);
  tempReset(); tempInt(Math.trunc(t0)); if (filtered) tempSet(t0);
  second(1); second(1); second(0); second(0); second(0);        // locked, then lost: steering engages
};

// 1. The conversion: the vendor's two-point formula without the truncation.
{
  const CAL1 = 1040, CAL2 = 1380;                              // typical factory counts at 30 and 110 degC, taken at 3.0 V
  const vendor = (raw) => Math.trunc((Math.trunc(raw * 3300 / 3000) - CAL1) * 80 / (CAL2 - CAL1)) + 30;
  const at30 = Math.round(CAL1 * 3000 / 3300);
  check(`the 30 degC calibration count reads ${convert(at30, CAL1, CAL2).toFixed(2)} degC`, near(convert(at30, CAL1, CAL2), 30, 0.2));
  const step = convert(at30 + 1, CAL1, CAL2) - convert(at30, CAL1, CAL2);
  check(`one raw count is ${step.toFixed(3)} degC`, near(step, 1.1 * 80 / (CAL2 - CAL1), 1e-3));
  let worst = 0, whole = new Set();
  for (let raw = at30 - 40; raw <= at30 + 200; raw++) { worst = Math.max(worst, Math.abs(convert(raw, CAL1, CAL2) - vendor(raw))); whole.add(vendor(raw)); }
  check(`it never differs from the vendor's whole-degree value by a degree or more (most: ${worst.toFixed(2)})`, worst < 1.3);
  check(`across those 241 counts the vendor formula gives only ${whole.size} different readings`, whole.size < 70);
  check('equal calibration counts (a blank part) give 0, not a division by zero', convert(1000, 1200, 1200) === 0);
}

// 2. The filter: the first reading is taken whole, then about two minutes of memory.
{
  tempReset();
  check('before any reading there is no filtered temperature', tempF() === -999);
  feed(25.3);
  check('the first reading is the estimate', near(tempF(), 25.3));
  for (let i = 0; i < 32; i++) feed(26.3);
  check(`a 1 degree step is ${((tempF() - 25.3) * 100).toFixed(0)}% followed after 32 readings (about 2 minutes)`, near(tempF() - 25.3, 1 - Math.pow(31 / 32, 32), 2e-3));
  for (let i = 0; i < 400; i++) feed(i % 2 ? 26.3 + 0.26 : 26.3);     // settle on a reading that flickers by one raw count
  let lo = 99, hi = -99;
  for (let i = 0; i < 200; i++) { feed(i % 2 ? 26.3 + 0.26 : 26.3); lo = Math.min(lo, tempF()); hi = Math.max(hi, tempF()); }
  check(`a reading flickering by one raw count (0.26 degC) moves it by ${((hi - lo) * 1000).toFixed(0)} thousandths of a degree, around the mean`, hi - lo < 0.01 && near((hi + lo) / 2, 26.43, 0.01));
  feed(NaN);
  check('a reading that is not a number is ignored', Number.isFinite(tempF()));
}

// 3. A fraction of a degree moves the steering.
{
  start(30.0);
  check('no change in temperature: nothing is steered', sum(hold(32)) === 0);
  tempSet(30.5);
  const r = hold(1 + 160).slice(1);
  check(`+0.5 degC: +2 ticks/s exactly (${sum(r)} ticks in 160 s)`, sum(r) === 320);
  start(30.0); tempSet(30.1);
  const s = hold(1 + 160).slice(1);
  check(`+0.1 degC: +0.4 ticks/s, applied to the nearest sixteenth (${sum(s)} ticks in 160 s)`, sum(s) === 60);
  start(30.0); tempSet(29.75);
  const u = hold(1 + 160).slice(1);
  check(`-0.25 degC: -1 tick/s exactly (${sum(u)} ticks in 160 s)`, sum(u) === -160);
}

// 4. The temperature at the moment of loss keeps its fraction.
{
  start(30.4);
  check('lost at 30.4 degC and staying there: nothing is steered', sum(hold(64)) === 0);
  tempSet(31.4);
  const r = hold(1 + 32).slice(1);
  check(`then +1.0 degC: +4 ticks/s (${sum(r)} in 32 s), not the 2.4 a whole-degree baseline of 30 would give`, sum(r) === 128);
}

// 5. A temperature sitting on a whole-degree boundary no longer chops the rate.
{
  start(30.9, false);                                          // before the fix: only whole degrees
  const old = []; for (let i = 0; i < 40; i++) { tempInt(i % 2 ? 31 : 30); old.push(second(0)); }
  check(`whole-degree readings flickering 30/31 at a steady 30.9 degC: the steering jumps between ${Math.min(...old)} and ${Math.max(...old)} ticks/s, ${sum(old)} ticks of false correction in 40 s`, Math.max(...old) - Math.min(...old) >= 4 && sum(old) >= 60);
  start(30.9);                                                 // with a filtered reading
  const now = []; for (let i = 0; i < 40; i++) { tempInt(i % 2 ? 31 : 30); tempSet(30.9 + (i % 2 ? 0.01 : -0.01)); now.push(second(0)); }
  check(`the same flicker with the filtered reading: ${sum(now)} ticks in 40 s`, Math.abs(sum(now)) <= 3);
}

// 6. Coverage still clamps, and config-frozen coefficients take fractions too.
{
  start(69.5); tempSet(75.0);                                  // the model was learned up to 70 degC
  const r = hold(1 + 32).slice(1);
  check(`past the learned range the model is not extrapolated: +0.5 degC of it, +2 ticks/s (${sum(r)} in 32 s)`, sum(r) === 64);
  bootCold(1718971200); cfg('freq_hold = off'); cfg('tc_max_ppm = 100'); fhReset(); setTc(0, 1);
  cfg('tc_hse_b = 0.05'); tempReset(); tempInt(30); tempSet(30.0);
  second(1); second(1); second(0); second(0); second(0);
  tempSet(30.25);
  const f = hold(1 + 32).slice(1);
  check(`coefficients frozen in config: +0.25 degC is +1 tick/s (${sum(f)} in 32 s)`, sum(f) === 32);
  cfg('tc_hse_b = nan');
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
