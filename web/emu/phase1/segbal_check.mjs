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
function verify(strength, label) {
  // mirrors segbal_duty(): linear blend to 100, power law (gamma = strength/100) above
  const sFor = (n) => {
    if (n === 0) return 0;
    if (strength <= 100) return 16 - Math.floor((strength * (16 - 2 * n)) / 100);
    return Math.max(1, Math.min(16, Math.floor(16 * Math.pow(n / 8, strength / 100) + 0.5)));
  };
  let colsWithSegs = 0, allCat = true, allCsel = true, allDuty = true, allClean = true;
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

let all = true;
for (const r of results) { if (!r.pass) all = false; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.x ? '  [' + r.x + ']' : ''}`); }
console.log(all ? '\nALL PASS' : '\nSOME FAILED');
process.exit(all ? 0 : 1);
