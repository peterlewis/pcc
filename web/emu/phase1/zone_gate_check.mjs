// zone_gate_check.mjs — when the main loop's timezone lookup runs.
// Stock looks the zone up again on every GPS fix: about 300 ms of the main loop, once a second. This
// firmware does the same unless asked otherwise. Three things are checked here, all through the
// firmware's own test of whether the lookup runs this pass (zone_lookup_due):
//   1. The default is the stock one: every fix, moved or not.
//   2. "zone_gate = on" waits for the fix to move about 0.5 km from the last one whose rules loaded.
//      A lookup that failed leaves no such fix, so the next fix tries again; so does a ZONE_OVERRIDE
//      that names no zone. (The first cut of the gate recorded the fix before the lookup had worked,
//      and a clock that had not moved then never tried again.)
//   3. The cuckoo holds the lookup clear of its quarter and hour pieces, which are scheduled and
//      stepped from the same main loop. The clock is run across a quarter with a fix arriving at .350
//      of every second and each lookup costing the main loop 300 ms, as on the hardware. Taken on
//      every fix regardless, that stall loses the nod; taken only when the firmware says so, the nod
//      plays and the lookups carry on either side of it.
// Run: node zone_gate_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const boot = w('emu_boot', 'void', ['number']), bootCold = w('emu_boot_cold', 'void', ['number']);
const tick = w('emu_tick'), poll = w('emu_poll'), cfg = w('emu_config_line', 'void', ['string']);
const due = w('emu_zone_lookup_due', 'number'), run = w('emu_zone_lookup_run', 'void', ['number']);
const fix = w('emu_new_fix', 'void', ['number', 'number']), overrideFail = w('emu_override_fail');
const holds = w('emu_cuckoo_holds_lookup', 'number'), peek = w('emu_cfg_peek', 'number', ['string']);
const subms = w('emu_subms', 'number'), ckActive = w('emu_cuckoo_active', 'number'), now = w('emu_now', 'number');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

if (due() === -1) { console.log('this firmware has no zone_lookup_due — skipped'); process.exit(0); }

const LAT = 51.5, LON = -0.12;
const start = () => { bootCold(1718971200); boot(1718971200); };

// ---- 1. the default: every fix ---------------------------------------------------------------
start();
check(`zone_gate is off unless asked for (${peek('zone_gate')})`, peek('zone_gate') === 0);
fix(LAT, LON);
check('a first fix: the lookup runs', due() === 1);
run(1);
check('once it has run, nothing is due until the next fix', due() === 0);
fix(LAT, LON);
check('the next fix, the clock not moved: the lookup runs again (stock)', due() === 1);
run(1);

// ---- 2. zone_gate = on ------------------------------------------------------------------------
cfg('zone_gate = on');
fix(LAT, LON);
check('zone_gate = on: a fix where the last lookup was does not run it', due() === 0);
fix(LAT + 0.004, LON);
check('... nor one 0.004 degrees away', due() === 0);
fix(LAT + 0.01, LON);
check('... one 0.01 degrees away does', due() === 1);
run(1);
fix(LAT + 0.01, LON);
check('... and not again from there', due() === 0);

fix(LAT + 0.03, LON); run(0);                       // the lookup was cut short, or its rules did not load
fix(LAT + 0.03, LON);
check('a lookup that failed is tried again at the next fix, the clock not moved', due() === 1);
run(1); fix(LAT + 0.03, LON);
check('... until one loads its rules', due() === 0);

overrideFail();
check(`a ZONE_OVERRIDE that names no zone goes back to the position (zone_lat ${peek('zone_lat')})`, peek('zone_lat') > 90 && due() === 1);
run(1);

cfg('zone_gate = off');
fix(LAT + 0.03, LON);
check('zone_gate = off again: every fix', due() === 1);
run(1);

// ---- 3. the cuckoo --------------------------------------------------------------------------
const NOD = 0xFE;
const T0 = 1783430000 - (1783430000 % 3600);
// Run the clock for `ms`, a main-loop pass every millisecond. A fix arrives at .350 of each second.
// When `take()` says the lookup runs, the main loop is gone for 300 ms (ticks, no passes).
function across(ms, take) {
  const seen = { nod: 0, lookups: [], stalledInPiece: 0 };
  let stall = 0;
  for (let i = 0; i < ms; i++) {
    tick();
    if (subms() === 350) fix(LAT, LON);
    if (stall > 0) {
      if (ckActive() !== -1) seen.stalledInPiece++;
      if (--stall === 0) run(1);
      continue;
    }
    poll();
    if (ckActive() === NOD) seen.nod = 1;
    if (take()) { stall = 300; seen.lookups.push(now() % 60); }
  }
  return seen;
}
const approach = (cuckoo) => {                     // :14:52, eight seconds before a quarter
  boot(T0 + 3600 + 14 * 60 + 52); cfg(`cuckoo = ${cuckoo}`); cfg('zone_gate = off');
  for (let i = 0; i < 1500; i++) { tick(); poll(); }
};

approach('trust');
const blind = across(14000, () => peek('new_position') === 1);
check(`a 300 ms lookup on every fix, the cuckoo not asked: the quarter's nod is lost (nod ${blind.nod})`, blind.nod === 0);

approach('trust');
const held = across(14000, () => due() === 1);
check(`the lookup taken when the firmware says so: the nod plays (nod ${held.nod})`, held.nod === 1);
check(`... no lookup runs while a piece plays (${held.stalledInPiece} ms)`, held.stalledInPiece === 0);
check(`... none starts in the :59 second (lookups in seconds ${held.lookups.join(' ')})`, !held.lookups.includes(59));
check('... and they run every second either side of it', [55, 56, 57, 58].every((s) => held.lookups.includes(s)) && [2, 3, 4].every((s) => held.lookups.includes(s)));
check(`... the held fix is looked up once the piece is over (new_position ${peek('new_position')})`, held.lookups.includes(0) || held.lookups.includes(1));

approach('off');
const off = across(14000, () => due() === 1);
check(`cuckoo = off: nothing is ever held, the :59 second included (lookups in seconds ${off.lookups.join(' ')})`, [55, 56, 57, 58, 59, 0, 1, 2, 3, 4].every((s) => off.lookups.includes(s)));
check('cuckoo = off: and the firmware is not holding', holds() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
