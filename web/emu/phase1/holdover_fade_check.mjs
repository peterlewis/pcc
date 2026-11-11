// holdover_fade_check.mjs — regression for the significance fade going dark, then relighting.
// computeHoldoverFade used the raw LSE offset (debug_rtc_val, ~19 ppm on a typical crystal) as its
// frequency uncertainty while the last RTC calibration was under 63 s old and an LSE model was valid.
// That offset is a known bias of the 32 kHz oscillator; the displayed time runs on the HSE-driven
// SysTick. Result on a learning clock: the ms digit went dark ~9 s into a holdover, relit when the
// branch expired (within 64 s), and faded again minutes later. The uncertainty bound U(t) must only
// grow through a holdover, and must not depend on the LSE at all.
// With the old code the "never relights" and "same with or without an LSE model" cases FAIL.
// Run: node holdover_fade_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const cfg      = w('emu_config_line', 'void', ['string']);
const setModel = w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']);
const setLse   = w('emu_set_lse_cal', 'void', ['number', 'number']);
const hold2    = w('emu_force_holdover2', 'void', ['number', 'number']);
const uUs      = w('emu_holdover_u_us', 'number');
const fade     = w('emu_digit_fade', 'number', ['number']);   // 0 ds, 1 cs, 2 ms; 0..255

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

// A holdover that starts `calAtLoss` seconds after the last RTC calibration: at holdover age a the
// PPS is a seconds old and the calibration is calAtLoss + a seconds old.
function trace(lseValid, calAtLoss, ages) {
  bootCold(1718971200);
  cfg('significance_fade = on');
  setModel(0.02, 0.0, -8, 70, 5000, 0.3);   // a well-supported HSE model, 0.3 ppm residual
  setLse(lseValid, 39);                     // 39 counts over 63 s = 18.9 ppm, a typical LSE
  return ages.map((a) => { hold2(a, calAtLoss + a); return { a, u: uUs(), ms: fade(2), cs: fade(1), ds: fade(0) }; });
}
const ages = [];
for (let a = 1; a <= 900; a++) ages.push(a);

for (const calAtLoss of [0, 10, 40, 62]) {
  const withLse = trace(1, calAtLoss, ages);
  const noLse   = trace(0, calAtLoss, ages);
  const tag = `cal ${calAtLoss} s old at loss`;

  let grows = true, relit = null;
  for (let i = 1; i < withLse.length; i++) {
    if (withLse[i].u < withLse[i - 1].u) grows = false;
    for (const k of ['ms', 'cs', 'ds']) if (withLse[i][k] > withLse[i - 1][k] && !relit) relit = `${k} ${withLse[i - 1][k]}->${withLse[i][k]} at ${withLse[i].a} s`;
  }
  check(`${tag}: U(t) only grows through the holdover`, grows);
  check(`${tag}: no digit relights once it has dimmed${relit ? ` (${relit})` : ''}`, !relit);

  const same = withLse.every((p, i) => p.u === noLse[i].u && p.ms === noLse[i].ms && p.cs === noLse[i].cs);
  check(`${tag}: the bound is the same with or without an LSE model`, same);

  const at = (a) => withLse[a - 1];
  check(`${tag}: ms digit is full at 9 s (U=${at(9).u.toFixed(0)} us)`, at(9).ms === 255);
  check(`${tag}: ms digit has faded out by 900 s (U=${at(900).u.toFixed(0)} us)`, at(900).ms === 0);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
