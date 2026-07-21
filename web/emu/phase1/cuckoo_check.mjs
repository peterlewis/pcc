// Headless proof of the CUCKOO engine (CUCKOO_SPEC.md v2, shipped catalogue: off | trust):
// per-digit intent levels composed through the segbal dither mirror, the fixed quarter NOD,
// trust as the hourly piece, the intrinsic two-tier scheduler, the preview surfaces, and the
// byte-identity claim with `cuckoo = off`. carry/heartbeat/pendulum are PARKED (absent from
// the firmware; bodies in git at 59fc649) — their names must parse to off/no-op.
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const emu = {
  boot: w('emu_boot', 'void', ['number']),
  tick: w('emu_tick'), poll: w('emu_poll'),
  cfg: w('emu_config_line', 'void', ['string']),
  ckActive: w('emu_cuckoo_active', 'number'),
  ckLevel: w('emu_cuckoo_level', 'number', ['number', 'number']),
  ckSet: w('emu_cuckoo_set', 'void', ['number', 'number']),
};

const NOD = 0xFE, OFF = 0, TRUST = 1;
let pass = 0, fail = 0;
const chk = (name, ok) => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const tickMs = (n) => { for (let i = 0; i < n; i++) { emu.tick(); if (i % 10 === 0) emu.poll(); } };
const runPiece = (maxMs = 12000) => {
  const min = Array(9).fill(16), max = Array(9).fill(0);
  let ms = 0;
  while (emu.ckActive() !== -1 && ms < maxMs) {
    tickMs(10); ms += 10;
    for (let d = 0; d < 9; d++) {
      const l = emu.ckLevel(d, 0);
      if (l < min[d]) min[d] = l;
      if (l > max[d]) max[d] = l;
    }
  }
  return { min, max, ms };
};

// Boot mid-hour, far from any boundary, and settle.
emu.boot(1783430000 + 120);
tickMs(1500);

// Feature probe: skip cleanly on builds without the engine (rollup before this branch).
emu.ckSet(0, 98);
if (emu.ckActive() === -1) {
  console.log('cuckoo engine absent in this build (EMU_HAS_CUCKOO off) — skipped');
  process.exit(0);
}
while (emu.ckActive() !== -1) tickMs(10);

console.log('idle:');
chk('idle after the probe (active = -1)', emu.ckActive() === -1);
chk('idle level neutral 16', emu.ckLevel(0, 0) === 16 && emu.ckLevel(8, 0) === 16);

console.log('the NOD (forced):');
emu.ckSet(OFF, 98);
chk('nod running (0xFE)', emu.ckActive() === NOD);
const nod = runPiece(2000);
chk(`nod floor exactly 8 on big digits (min ${nod.min.slice(0, 6)})`, nod.min.slice(0, 6).every(v => v === 8));
chk('nod never touches sub-second digits', nod.min[6] === 16 && nod.min[7] === 16 && nod.min[8] === 16);
chk(`nod clears in ~550 ms (took ${nod.ms})`, nod.ms >= 500 && nod.ms <= 700);
chk('nod terminates on the plain face', emu.ckActive() === -1 && emu.ckLevel(2, 0) === 16);

console.log('trust (forced):');
emu.ckSet(TRUST, 99);
chk('trust running', emu.ckActive() === TRUST);
const tr = runPiece();
chk('x-ray dip reached 2', Math.min(...tr.min) <= 2);
chk('trust terminated to the plain face', emu.ckActive() === -1 && emu.ckLevel(0, 0) === 16);

console.log('parked pieces are absent:');
emu.cfg('cuckoo = carry');
emu.ckSet(-1, 99);
chk('cuckoo = carry parses to off (nothing plays)', emu.ckActive() === -1);
emu.cfg('cuckoo = pendulum');
emu.ckSet(-1, 99);
chk('cuckoo = pendulum parses to off', emu.ckActive() === -1);
emu.cfg('cuckoo_preview = heartbeat');
chk('preview of a parked name is a no-op', emu.ckActive() === -1);

// ---- the scheduler: quarter -> NOD, hour -> trust ------------------------------------------
// Epochs strictly increasing; the approach is SCANNED, never fast-forwarded blind (after a
// re-boot the emulator's sub-second phase is stale and a completed 580 ms nod would vanish
// inside a blind window).
console.log('scheduler:');
const T0 = 1783430000 - (1783430000 % 3600);
const scanForStart = (ms) => {
  for (let i = 0; i < ms / 10; i++) { tickMs(10); const a = emu.ckActive(); if (a !== -1) return a; }
  return -1;
};
emu.boot(T0 + 3600 + 14 * 60 + 50);                 // :14:50 — ten seconds before a quarter
emu.cfg('cuckoo = trust');
tickMs(1500);
chk('idle approaching the quarter', emu.ckActive() === -1);
let seen = scanForStart(13000);
chk(`the quarter starts the NOD, not the piece (saw ${seen})`, seen === NOD);
runPiece(2000);

emu.boot(T0 + 2 * 3600 + 59 * 60 + 50);             // :59:50 — ten seconds before the hour
emu.cfg('cuckoo = trust');
tickMs(1500);
seen = scanForStart(13000);
chk(`the hour starts trust (saw ${seen})`, seen === TRUST);
runPiece();

// off = nothing, ever.
console.log('off:');
emu.boot(T0 + 3 * 3600 + 14 * 60 + 55);
emu.cfg('cuckoo = off');
tickMs(1500);
let fired = false;
for (let i = 0; i < 800; i++) { tickMs(10); if (emu.ckActive() !== -1) fired = true; }
chk('cuckoo = off never fires across a quarter', !fired);
chk('levels stay neutral 16 throughout', emu.ckLevel(0, 0) === 16 && emu.ckLevel(5, 0) === 16);

// ---- cuckoo_preview (serial-only): plays once, never touches the config --------------------
console.log('preview:');
emu.cfg('cuckoo = off');
emu.cfg('cuckoo_preview = nod');
chk('preview nod plays with cuckoo=off', emu.ckActive() === NOD);
runPiece(2000);
emu.cfg('cuckoo_preview = trust');
chk('preview by name plays trust', emu.ckActive() === TRUST);
emu.cfg('cuckoo_preview = nod');                    // preview PREEMPTS a running preview
chk('a new preview preempts the running one', emu.ckActive() === NOD);
runPiece(2000);
emu.ckSet(-1, 99);                                  // config must still be off
chk('preview left the config untouched (still off)', emu.ckActive() === -1);
emu.cfg('cuckoo = trust');
emu.cfg('cuckoo_preview = on');
chk('preview "on" plays the configured piece', emu.ckActive() === TRUST);
runPiece();
emu.cfg('cuckoo = off');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
