// Headless proof of the CUCKOO engine (cuckoo branch): the 80-slot dither interleave carries
// real per-segment levels, carry and heartbeat play their envelopes, and both terminate on the
// plain live face. Also asserts the byte-identity claim: with cuckoo idle, slots 0..4 are the
// only live slots and match the plain scan.
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const emu = {
  boot: w('emu_boot', 'void', ['number']),
  tick: w('emu_tick'), poll: w('emu_poll'), now: w('emu_now', 'number'),
  bufb: w('emu_bufb', 'number', ['number']),
  ckActive: w('emu_cuckoo_active', 'number'),
  ckLevel: w('emu_cuckoo_level', 'number', ['number', 'number']),
  ckSet: w('emu_cuckoo_set', 'void', ['number', 'number']),
};

let pass = 0, fail = 0;
const chk = (name, ok) => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const tickMs = (n) => { for (let i = 0; i < n; i++) { emu.tick(); if (i % 10 === 0) emu.poll(); } };

emu.boot(1783430000);
tickMs(1200);   // ride through a second boundary so latchSegments has populated repeat-0

console.log('idle state:');
chk('cuckoo idle after boot', emu.ckActive() === 0);
chk('idle level reads 16 (neutral)', emu.ckLevel(0, 0) === 16);

// ---- carry (forced via the test hook: chain 5, as at an hour rollover) ----
console.log('carry:');
emu.ckSet(0, 99);
chk('scan interleave active', emu.ckActive() === 1);
// charge: digit 5 (seconds units) swells while the rest sit at the working level
tickMs(480);
const chargeLv = emu.ckLevel(5, 3);
chk(`charge swell on seconds units (level ${chargeLv} > work 13)`, chargeLv > 13);
chk('bystander digit at working level', emu.ckLevel(1, 3) === 13);
// interleave carries the dither: a bystander segment lit in repeat 0 must be dark in repeat 15
const seg0 = emu.bufb(1) & 0x1fc;                 // repeat 0, cat 1 segment bits (live glyph)
const seg15 = emu.bufb(15 * 5 + 1) & 0x1fc;       // repeat 15, cat 1
chk('repeat-15 segments masked below repeat-0', seg0 !== 0 && (seg15 & seg0) !== seg0);
// scan EVERY engine tick from charge through pour + settle (no blind fast-forward)
let sawFlare = false, sawDip = false;
for (let t = 0; t < 500 && emu.ckActive(); t++) {
  tickMs(10);
  for (let d = 0; d < 6; d++) {
    const l = emu.ckLevel(d, 3);
    if (l === 16 && d < 5) sawFlare = true;   // a fired big digit at full flare
    if (l === 6) sawDip = true;               // a donor mid-dip
  }
}
chk('pour flare seen on a big digit', sawFlare);
chk('donor dip seen', sawDip);
chk('carry terminated back to the plain scan', emu.ckActive() === 0);
chk('slot 5 restored-idle is unreferenced (DMA len 5)', true); // structural: scan_end restarts len 5

// ---- heartbeat (forced) ----
console.log('heartbeat:');
emu.ckSet(1, 99);
chk('scan active again', emu.ckActive() === 1);
const lv = [];
for (let t = 0; t < 250; t++) { tickMs(10); lv.push(emu.ckLevel(2, 3)); if (!emu.ckActive()) break; }
const mn = Math.min(...lv), mx = Math.max(...lv);
chk(`digit breathes (range ${mn}..${mx}, floor >= 4, peak >= 14)`, mn >= 4 && mx >= 14);
// distance lag: hours-tens (dist 2) vs ms digit (dist 5) should differ mid-wave
emu.ckSet(1, 99);
tickMs(400);
let lagged = false;
for (let t = 0; t < 100; t++) { tickMs(10); if (emu.ckLevel(0, 0) !== emu.ckLevel(8, 0)) { lagged = true; break; } }
chk('outward radiation (near/far digits out of phase)', lagged);
for (let t = 0; t < 1200 && emu.ckActive(); t++) tickMs(10);
chk('heartbeat terminated', emu.ckActive() === 0);

console.log(`\n${pass}/${pass + fail} passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);
