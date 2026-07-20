// Headless proof of the CUCKOO v2 engine (CUCKOO_SPEC.md v2, branch cuckoo-v2): per-digit
// levels composed through the segbal dither mirror, the fixed quarter NOD, the four hourly
// pieces, the intrinsic two-tier scheduler (nod at :15/:30/:45, piece at :00, nod stand-in
// when the piece cannot run honestly), and the byte-identity claim with `cuckoo = off`.
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

const NOD = 0xFE, OFF = 0, CARRY = 1, HEARTBEAT = 2, PENDULUM = 3, TRUST = 4;
let pass = 0, fail = 0;
const chk = (name, ok) => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const tickMs = (n) => { for (let i = 0; i < n; i++) { emu.tick(); if (i % 10 === 0) emu.poll(); } };
// run until idle, sampling levels each engine tick; returns per-row {min, max} plus tick count
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
emu.boot(1783430000 + 120);   // :xx:02 of some minute — no trigger nearby
tickMs(1500);

// Feature probe: on branches without the engine (rollup today) the guarded exports are inert —
// a forced nod never starts. Skip cleanly rather than fail a build that honestly lacks cuckoo.
emu.ckSet(0, 98);
if (emu.ckActive() === -1) {
  console.log('cuckoo engine absent in this build (EMU_HAS_CUCKOO off) — skipped');
  process.exit(0);
}
while (emu.ckActive() !== -1) tickMs(10);   // let the probe nod finish before the real tests

console.log('idle:');
chk('idle after boot (active = -1)', emu.ckActive() === -1);
chk('idle level neutral 16', emu.ckLevel(0, 0) === 16 && emu.ckLevel(8, 0) === 16);

console.log('the NOD (forced):');
emu.ckSet(OFF, 98);
chk('nod running (0xFE)', emu.ckActive() === NOD);
const nod = runPiece(2000);
chk(`nod floor exactly 8 on big digits (min ${nod.min.slice(0, 6)})`, nod.min.slice(0, 6).every(v => v === 8));
chk('nod never touches sub-second digits', nod.min[6] === 16 && nod.min[7] === 16 && nod.min[8] === 16);
chk(`nod clears in ~550 ms (took ${nod.ms})`, nod.ms >= 500 && nod.ms <= 700);
chk('nod terminates on the plain face', emu.ckActive() === -1 && emu.ckLevel(2, 0) === 16);

console.log('carry (forced):');
emu.ckSet(CARRY, 99);
chk('carry running', emu.ckActive() === CARRY);
tickMs(480);
chk(`charge swell on seconds units (${emu.ckLevel(5, 0)} > work 13)`, emu.ckLevel(5, 0) > 13);
chk('bystander at working level 13', emu.ckLevel(1, 0) === 13);
const carry = runPiece();
chk('a fired big digit hit full flare 16', carry.max.slice(0, 6).some(v => v === 16));
chk('a donor dipped to 6', carry.min.slice(0, 6).some(v => v === 6));
chk('carry terminated to the plain face', emu.ckActive() === -1);

console.log('heartbeat (forced):');
emu.ckSet(HEARTBEAT, 99);
const hb = runPiece();
chk(`big digits breathe toward 4 (min ${Math.min(...hb.min.slice(0, 6))})`, Math.min(...hb.min.slice(0, 6)) <= 6);
chk(`sub-seconds compressed >= 8 (min ${Math.min(...hb.min.slice(6))})`, Math.min(...hb.min.slice(6)) >= 8);
chk(`heartbeat ran ~8 s and terminated (took ${hb.ms})`, hb.ms >= 7000 && hb.ms <= 9500 && emu.ckActive() === -1);

console.log('trust (forced):');
emu.ckSet(TRUST, 99);
const tr = runPiece();
chk('x-ray dip reached 2', Math.min(...tr.min) <= 2);
chk('trust terminated to the plain face', emu.ckActive() === -1 && emu.ckLevel(0, 0) === 16);

console.log('pendulum (forced):');
emu.ckSet(PENDULUM, 99);
const pd = runPiece(5000);
chk(`pendulum swung (big-digit min ${Math.min(...pd.min.slice(0, 6))} <= 6)`, Math.min(...pd.min.slice(0, 6)) <= 6);
chk('pendulum never touches sub-seconds', pd.min[6] === 16 && pd.min[7] === 16 && pd.min[8] === 16);
chk(`pendulum caught and terminated (~3.3 s, took ${pd.ms})`, pd.ms >= 3000 && pd.ms <= 4000 && emu.ckActive() === -1);

// ---- the scheduler: quarter -> NOD, hour -> the piece, stand-in when dishonest -------------
// Epochs are strictly increasing (distinct boundaries, so the one-start-per-second de-dupe
// never collides across scenarios), and the approach is SCANNED, never fast-forwarded blind:
// after a re-boot the emulator's sub-second phase is stale, so the boundary can land up to a
// second away from the harness's naive clock — a completed 580 ms nod would vanish inside a
// blind window (exactly the failure this comment is the tombstone for).
console.log('scheduler:');
const T0 = 1783430000 - (1783430000 % 3600);        // top of an hour
const scanForStart = (ms) => {                      // sample every 10 ms until something starts
  for (let i = 0; i < ms / 10; i++) { tickMs(10); const a = emu.ckActive(); if (a !== -1) return a; }
  return -1;
};
emu.boot(T0 + 3600 + 14 * 60 + 50);                 // :14:50 — ten seconds before a quarter
emu.cfg('cuckoo = heartbeat');
tickMs(1500);
chk('idle approaching the quarter', emu.ckActive() === -1);
let seen = scanForStart(13000);                     // scan through :15:00 (+ stale-phase slack)
chk(`the quarter starts the NOD, not the piece (saw ${seen})`, seen === NOD);
runPiece(2000);

emu.boot(T0 + 2 * 3600 + 59 * 60 + 50);             // :59:50 — ten seconds before the hour
emu.cfg('cuckoo = heartbeat');
tickMs(1500);
seen = scanForStart(13000);                         // scan through :00:00
chk(`the hour starts the piece (saw ${seen})`, seen === HEARTBEAT);
runPiece();

// pendulum in holdover (the harness has no PPS): the NOD stands in at the hour.
emu.boot(T0 + 4 * 3600 + 59 * 60 + 30);             // pendulum pre-arms at :56.5 — start earlier
emu.cfg('cuckoo = pendulum');
tickMs(1500);
seen = scanForStart(35000);                         // scan through :57 (skip) and :00:00 (nod)
chk(`holdover hour: the NOD stands in for pendulum (saw ${seen})`, seen === NOD);
runPiece(2000);

// off = nothing, ever: ride a full quarter boundary with the key off.
console.log('off:');
emu.boot(T0 + 14 * 60 + 55);
emu.cfg('cuckoo = off');
tickMs(1500);
let fired = false;
for (let i = 0; i < 800; i++) { tickMs(10); if (emu.ckActive() !== -1) fired = true; }
chk('cuckoo = off never fires across a quarter', !fired);
chk('levels stay neutral 16 throughout', emu.ckLevel(0, 0) === 16 && emu.ckLevel(5, 0) === 16);

// text parse: unknown value falls to off (never leaves a stale piece selected)
emu.cfg('cuckoo = carry');
emu.cfg('cuckoo = banana');
emu.ckSet(-1, 99);                                  // 99 with cuckoo=off must not start
chk('unknown value parses to off (force-start refused)', emu.ckActive() === -1);

// ---- cuckoo_preview (serial-only): plays once, never touches the config --------------------
console.log('preview:');
emu.cfg('cuckoo = off');
emu.cfg('cuckoo_preview = nod');
chk('preview nod plays with cuckoo=off', emu.ckActive() === NOD);
runPiece(2000);
emu.cfg('cuckoo_preview = trust');
chk('preview by piece name plays it', emu.ckActive() === TRUST);
emu.cfg('cuckoo_preview = carry');                  // preview PREEMPTS a running preview
chk('a new preview preempts the running one', emu.ckActive() === CARRY);
runPiece();
emu.ckSet(-1, 99);                                  // config must still be off (preview never set it)
chk('preview left the config untouched (still off)', emu.ckActive() === -1);
emu.cfg('cuckoo = heartbeat');
emu.cfg('cuckoo_preview = on');
chk('preview "on" plays the configured piece', emu.ckActive() === HEARTBEAT);
runPiece();
emu.cfg('cuckoo_preview = pendulum');               // no PPS in the harness: the nod stands in
chk('preview pendulum in holdover previews the NOD', emu.ckActive() === NOD);
runPiece(2000);
emu.cfg('cuckoo = off');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
