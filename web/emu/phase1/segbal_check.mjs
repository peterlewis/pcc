// segbal_check.mjs — verify the seg_balance per-segment brightness equalisation in the REAL
// firmware (compiled to WASM). Slots 0..4 are the live masters; segbal_poll must mirror them
// into slots 5..79 such that each digit is lit in s of its 16 cycles with
//   s = 16 - strength*(16 - 2*popcount(segments))/100   (full strength: s = 2N exactly),
// column-select bits present in EVERY slot, and per-segment duty s/N equal across all digits.
// Run: node segbal_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const E = {
  bootCold: w('emu_boot_cold', 'void', ['number']),
  tick: w('emu_tick'), poll: w('emu_poll'),
  pendsv: w('emu_pendsv'), pendsvPending: w('emu_pendsv_pending', 'number'),
  configLine: w('emu_config_line', 'void', ['string']),
  configDone: w('emu_config_done'),
  setPos: w('emu_set_pos', 'void', ['number', 'number']),
  setAdc: w('emu_set_adc', 'void', ['number']),
  setVbus: w('emu_set_vbus', 'void', ['number']),
  mode: w('emu_mode', 'number'),
  bufb: w('emu_bufb', 'number', ['number']),
  bufcLo: w('emu_bufc_low', 'number', ['number']),
  bufcHi: w('emu_bufc_high', 'number', ['number']),
  setDac: w('emu_set_dac', 'void', ['number']),
};

const BSEG = 0x01FC;                       // GPIOB segment bits (2..8); rest = cat select etc.
const pop = (v) => { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; };
const results = [];
const check = (n, c, x = '') => results.push({ n, pass: !!c, x });

function drive(ms) {
  for (let i = 0; i < ms; i++) { E.tick(); if (E.pendsvPending()) E.pendsv(); E.poll(); }
}

// Verify the whole 80-slot buffer against the masters for a given strength percentage.
// HARDWARE MODEL (the one the adversarial review corrected): buffer_c[].high is GPIOC's one-cold
// column select + enables — ADDRESSING, not LEDs — except bit 4 (cSegDP), the digit's decimal
// point. So the C digit's segment count is pop(.low) + DP, the DP duty-cycles WITH its digit,
// and the addressing bits must be byte-identical in every one of the 16 cycles.
const DP = 0x10;
// Nested + phase-decorrelated dither order. Master slot k=0 is always lit; mirror k >= 1 is lit
// iff ((REV16[k]-1 + phase) mod 15) + 1 < s, phase fixed per column x bank. Positions are part of
// the contract, both halves hardware-proven: reshuffling on s±1 ((k*s)%16<s) stepped the light
// once per second; a SHARED window (un-rotated nested) synchronized every digit onto the same
// cycles and blipped the whole row via the shared rail. DP rides its digit's phase.
const REV16 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
const PH_B = [0, 4, 8, 12, 1], PH_C = [5, 9, 13, 2, 6];
const litRank = (k, phase) => k === 0 ? 0 : ((REV16[k] - 1 + phase) % 15) + 1;
function verify(strength, label) {
  // mirrors segbal_duty(): linear blend to 100, power law (gamma = strength/100) above
  const sFor = (n) => {
    if (n === 0) return 0;
    if (strength <= 100) return 16 - Math.floor((strength * (16 - 2 * n)) / 100);
    return Math.max(1, Math.min(16, Math.floor(16 * Math.pow(n / 8, strength / 100) + 0.5)));
  };
  let colsWithSegs = 0, allCat = true, allCsel = true, allDuty = true, allClean = true, allNested = true;
  const detail = [];
  for (let col = 0; col < 5; col++) {
    const mb = E.bufb(col) & 0xFFFF, ml = E.bufcLo(col) & 0xFF, mh = E.bufcHi(col) & 0xFF;
    const cat = mb & ~BSEG & 0xFFFF;
    const csel = mh & ~DP;
    const nb = pop(mb & BSEG), nc = pop(ml) + ((mh >> 4) & 1);
    if (nb + nc > 0) colsWithSegs++;
    let litB = 0, litL = 0, litDP = 0;
    for (let k = 0; k < 16; k++) {
      const i = col + 5 * k;
      const b = E.bufb(i) & 0xFFFF, l = E.bufcLo(i) & 0xFF, h = E.bufcHi(i) & 0xFF;
      if ((b & ~BSEG & 0xFFFF) !== cat) allCat = false;      // GPIOB column select must survive
      if ((h & ~DP) !== csel) allCsel = false;               // GPIOC addressing must survive VERBATIM
      const bs = b & BSEG;
      if (bs === (mb & BSEG)) { if (mb & BSEG) litB++; }
      else if (bs !== 0) allClean = false;                   // must be master-or-dark
      if (l === ml) { if (ml) litL++; } else if (l !== 0) allClean = false;
      if (h & DP) { if (mh & DP) litDP++; else allClean = false; }
      // positional contract: lit slots are EXACTLY this digit's rotated nested-rank window
      if (mb & BSEG) { if ((bs === (mb & BSEG)) !== (litRank(k, PH_B[col]) < sFor(nb))) allNested = false; }
      if (ml)        { if ((l === ml && ml !== 0) !== (litRank(k, PH_C[col]) < sFor(nc))) allNested = false; }
    }
    if ((mb & BSEG) && litB !== sFor(nb)) allDuty = false;
    if (ml && litL !== sFor(nc)) allDuty = false;            // .low duty comes from the FULL digit N
    if ((mh & DP) && litDP !== sFor(nc)) allDuty = false;    // DP rides the same duty as its digit
    detail.push({ col, nb, nc, litB, litL, litDP, dp: !!(mh & DP) });
  }
  check(`${label}: some columns show segments`, colsWithSegs >= 3, `cols=${colsWithSegs}`);
  check(`${label}: GPIOB cat select present in all 16 cycles`, allCat);
  check(`${label}: GPIOC addressing byte verbatim in all 16 cycles`, allCsel);
  check(`${label}: every slot is master-or-dark (no corruption)`, allClean);
  check(`${label}: lit-cycle count == s for every digit (DP counted + synced)`, allDuty,
    detail.map(d => `c${d.col}[N ${d.nb}/${d.nc}${d.dp ? '+dp' : ''} lit ${d.litB}/${d.litL}${d.dp ? '/' + d.litDP : ''}]`).join(' '));
  check(`${label}: lit slots are the nested bit-reversed prefix (no reshuffle on duty steps)`, allNested);
  return detail;
}

// ---- boot the real firmware, enable full-strength balance -----------------------------------
E.bootCold(1783627200);
E.configLine('seg_balance = 100');
E.configDone();
E.setPos(51.4779, -0.0015);
E.setAdc(2600);
E.setVbus(1);
drive(1200);   // >1 s: seconds latch + ms cascade + many segbal_poll refills

// The feature lives on the seg-balance branch; against rollup/stock the key is ignored and the
// mirror slots stay empty. Skip (exit 0) rather than fail — this test targets the branch.
{
  let mirrored = false;
  for (let i = 5; i < 80 && !mirrored; i++) if (E.bufb(i) || E.bufcLo(i) || E.bufcHi(i)) mirrored = true;
  if (!mirrored) { console.log('SKIP — firmware has no seg_balance (not the seg-balance branch)'); process.exit(0); }
}

const d100 = verify(100, 'strength 100');
// per-segment equality: s/N must be identical (=2) for every lit digit
{
  const ratios = [];
  for (const d of d100) {
    if (d.nb) ratios.push(d.litB / d.nb);
    if (d.nc && d.litL) ratios.push(d.litL / d.nc);
  }
  const uniform = ratios.length && ratios.every(r => r === 2);
  check('strength 100: per-segment duty ratio uniform (=2/16 per segment)', uniform,
    `ratios=${[...new Set(ratios)].join(',')}`);
}

// ---- live strength change over serial (the config path PCC uses) ----------------------------
E.configLine('seg_balance = 50');
drive(20);
verify(50, 'strength 50');   // s = 8 + N exactly

// ---- overdrive: power law past 100 (gamma = strength/100) ------------------------------------
E.configLine('seg_balance = 200');
drive(20);
verify(200, 'strength 200 (gamma 2)');   // s = round(16*(N/8)^2), floor 1 for lit digits
E.configLine('seg_balance = 999');       // parse clamp → 300
drive(20);
verify(300, 'strength 999→clamped 300 (gamma 3)');

// ---- AUTO: seg_balance = on follows the baked exponential curve (piecewise linear in dac) ----
// Recalibrated 2026-07-11: a full eyeballed rail sweep landed the even point on K = 10*9^(dac/4096)
// (the LED knee), sampled to a 9-point LUT on power-of-two dac breakpoints. Must mirror the firmware
// SEGBAL_AUTO_DAC/K byte-for-byte, including C integer-division truncation in the interpolation.
const AUTO_DAC = [0, 512, 1024, 1536, 2048, 2560, 3072, 3584, 4096];
const AUTO_K   = [10,  13,   17,   23,   30,   39,   52,   68,   90];
const autoK = (d) => {
  if (d <= AUTO_DAC[0]) return AUTO_K[0];
  for (let i = 1; i < 9; i++) if (d <= AUTO_DAC[i]) {
    // C integer division truncates toward zero — mirror it exactly
    return AUTO_K[i-1] + Math.trunc(((AUTO_K[i] - AUTO_K[i-1]) * (d - AUTO_DAC[i-1])) / (AUTO_DAC[i] - AUTO_DAC[i-1]));
  }
  return AUTO_K[8];
};
E.configLine('seg_balance = on');
for (const d of [0, 512, 1000, 1536, 2048, 2560, 3072, 3584, 4095]) {
  E.setDac(d);
  drive(20);
  verify(autoK(d), `auto @ dac ${d} → eff ${autoK(d)}`);
}

// ---- live disable: firmware must fall back to the stock scan without corruption -------------
E.configLine('seg_balance = off');
drive(20);
{
  let mastersOk = true;
  for (let col = 0; col < 5; col++) {
    const mb = E.bufb(col) & 0xFFFF;
    if ((mb & ~BSEG & 0xFFFF) === 0 && (mb & BSEG) === 0 && E.bufcLo(col) === 0 && E.bufcHi(col) === 0) continue;
    if ((mb & ~BSEG & 0xFFFF) === 0) mastersOk = false;   // cat select vanished from a live master
  }
  check('disable: masters intact after fallback to 5-slot scan', mastersOk);
  check('disable: firmware still running (mode readable)', Number.isFinite(E.mode()));
}

// ---- re-enable: comes back cleanly ----------------------------------------------------------
E.configLine('seg_balance = 100');
drive(20);
verify(100, 're-enable');

// ---- gradual significance fade: digit_bright scales the sub-second columns' duty --------------
// The mirror must run for the fade EVEN with seg_balance off (identity duty), each C column's
// duty must track its digit's live fade level (c1/c2/c3 = ds/cs/ms), and the seconds column's
// DP (c0.high bit 4) must follow digit_bright[3]. Uses forceHoldover to sweep U(τ).
{
  const digitFade = w('emu_digit_fade', 'number', ['number']);
  const forceHold = w('emu_force_holdover', 'void', ['number']);
  E.configLine('seg_balance = off');
  E.configLine('significance_fade = on');
  drive(20);
  // find a holdover age where the fade is PARTIAL (some digit strictly between 0 and 16) —
  // the fade bands are narrow in age terms, so sweep densely (log steps)
  let partial = null;
  for (let age = 5; age < 500000 && !partial; age = Math.ceil(age * 1.08)) {
    forceHold(age); drive(3);
    const f = [0, 1, 2, 3].map(k => Math.round(digitFade(k) * 16 / 255));
    if (f.some(v => v > 0 && v < 16)) partial = { age, f };
  }
  check('fade: found a partial-fade holdover age', !!partial, partial ? `age=${partial.age} f=${partial.f}` : 'none');
  if (partial) {
    drive(20);
    const f = [0, 1, 2, 3].map(k => Math.round(digitFade(k) * 16 / 255));
    let ok = true, detail = [];
    for (let col = 1; col <= 3; col++) {
      const ml = E.bufcLo(col) & 0xFF;
      if (!ml) { detail.push(`c${col}:blank(f=${f[col-1]})`); if (f[col-1] > 0) ok = false; continue; }
      const nc = pop(ml) + ((E.bufcHi(col) >> 4) & 1);
      const base = 16;                                   // seg_balance off -> identity duty
      let exp = Math.floor((Math.floor((base * 16 + 8) / 16) * f[col-1] + 8) / 16);
      if (f[col-1] && ml && !exp) exp = 1;
      let lit = 0;
      for (let k = 0; k < 16; k++) if ((E.bufcLo(col + 5 * k) & 0xFF) === ml) lit++;
      detail.push(`c${col}: f=${f[col-1]} exp=${exp} lit=${lit}`);
      if (lit !== exp) ok = false;
    }
    // DP on the seconds column follows digit_bright[3]
    const mh0 = E.bufcHi(0) & 0xFF;
    if (mh0 & DP) {
      let expDp = Math.floor((16 * f[3] + 8) / 16); if (f[3] && !expDp) expDp = 1; if (!f[3]) expDp = 0;
      let litDp = 0;
      for (let k = 0; k < 16; k++) if (E.bufcHi(5 * k) & DP) litDp++;
      detail.push(`dp: f=${f[3]} exp=${expDp} lit=${litDp}`);
      if (litDp !== expDp) ok = false;
    }
    check('fade: sub-second duty tracks digit_bright (mirror active with seg_balance OFF)', ok, detail.join(' '));
  }
  // deep holdover: fully-faded digits go BLACK in the masters (blank, not dash glyph 0x40).
  // setPrecision applies the blanking at the next second boundary — drive a full second.
  forceHold(2000000); drive(1200);
  const deepF = [0, 1, 2].map(k => Math.round(digitFade(k) * 16 / 255));
  if (deepF.every(v => v === 0)) {
    const blank = [1, 2, 3].every(c => (E.bufcLo(c) & 0xFF) === 0);
    check('fade: zero-significance digits are BLANK (fade to black, not dash)', blank,
      `masters=${[1,2,3].map(c => (E.bufcLo(c) & 0xFF).toString(16)).join(',')}`);
  } else check('fade: deep holdover reached zero significance', false, `f=${deepF}`);
  // composition: fade + seg_balance auto together still verifies duty coherently
  E.configLine('seg_balance = on');
  forceHold(0); drive(1200);   // a full second: PendSV re-latches the sub-second digits
  verify(autoK(4095), 'fade off (relock) + auto balance resumes');
}

let all = true;
for (const r of results) { if (!r.pass) all = false; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.x ? '  [' + r.x + ']' : ''}`); }
console.log(all ? '\nALL PASS' : '\nSOME FAILED');
process.exit(all ? 0 : 1);
