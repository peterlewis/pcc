// fade_persist_check.mjs — the fade bound's learned wander survives a power cycle.
// The significance fade's bound rests on a wander level the clock learns over 2.3 hours of lock.
// Until then it uses a default. After every power cycle it was back on that default - which is not
// only looser than a settled clock needs, but may be too TIGHT for a clock that had learned it
// wanders more than most. With tc_persist on, the level is now kept in the tempcomp store's record,
// in bytes every earlier record left zero.
// This checks what is written and when, that a wander-only write never disturbs a stored model, the
// restore at boot, old and corrupt records, and tc_reset / tc_forget.
// Run: node fade_persist_check.mjs
import factory from '../clock-fw.mjs';

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const A_FLOOR = 0.1475, A_DEFAULT = 0.59, MIN30 = 30 * 60 * 1000 + 1000;

async function clock() {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  w('emu_boot_cold', 'void', ['number'])(1718971200);
  w('emu_ee_reset')(); w('emu_ee2_reset')();                 // a freshly provisioned SETTINGS.BIN
  w('emu_set_uart_ready', 'void', ['number'])(1);
  const c = {
    w, cfg: w('emu_config_line', 'void', ['string']),
    fwSet: w('emu_fw_set', 'void', ['number', 'number']), step: w('emu_tc_persist_step'),
    uptime: w('emu_uptime', 'void', ['number']), powerCycle: w('emu_fw_power_cycle'),
    count: w('emu_fw_count', 'number'), variance: w('emu_fw_var', 'number'), used: w('emu_fw_used', 'number'),
    storedCount: w('emu_fw_stored_count', 'number'), storedVar: w('emu_fw_stored_var', 'number'),
    dirty: w('emu_fw_dirty', 'number'), gen: w('emu_ee2_gen', 'number'),
    peek: w('emu_ee2_peek', 'number', ['number']), poke: w('emu_ee2_poke', 'void', ['number', 'number']),
    setModel: w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']),
    clearModel: w('emu_tc_clear_model'), ee2Commit: w('emu_ee2_commit', 'number'), probe2: w('emu_tc2_probe', 'number', ['number']),
    housekeeping: w('emu_tc_housekeeping'),
    learn(v, n) { c.fwSet(v, n); c.uptime(MIN30); c.step(); },   // a new level, 30 minutes later, the persist step runs
    bytes(slot) { const a = []; for (let i = 0; i < 64; i++) a.push(c.peek(slot * 64 + i)); return a; },
  };
  return c;
}

// 1. tc_persist = off (it is on by default): nothing is written, nothing is restored.
{
  const c = await clock(); c.cfg('tc_persist = off');
  c.learn(0.4, 20);
  check('tc_persist off: a learned wander is not written', c.gen() === 0 && c.storedCount() === 0);
  c.powerCycle();
  check('tc_persist off: after a power cycle the bound is on its default', c.count() === 0 && near(c.used(), A_DEFAULT));
}

// 2. With tc_persist: written once learned, restored at boot.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.fwSet(0.4, 5); c.uptime(MIN30); c.step();
  check('before 8 windows there is nothing to save', c.gen() === 0);
  c.fwSet(0.4, 20); c.step();
  check(`once learned it is written (record ${c.gen()}): 0.4 over 20 windows`, c.gen() === 1 && c.storedCount() === 20 && near(c.storedVar(), 0.4) && c.dirty() === 0);
  c.fwSet(0.9, 21); c.uptime(10 * 60 * 1000); c.step();
  check('a big change 10 minutes after a write waits for the 30-minute spacing', c.gen() === 1 && c.dirty() === 1);
  c.uptime(21 * 60 * 1000); c.step();
  check('... and is written once 30 minutes have passed', c.gen() === 2 && near(c.storedVar(), 0.9) && c.dirty() === 0);
  c.fwSet(0.4, 20); c.uptime(MIN30); c.step();
  c.powerCycle();
  check(`power cycle: the learner starts from the stored level (${c.used().toFixed(3)}, ${c.count()} windows), not the default`, c.gen() === 3 && c.count() === 20 && near(c.variance(), 0.4) && near(c.used(), 0.4));
}

// 3. It is rewritten only when the level the bound USES moves by a quarter.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.learn(0.4, 20);
  c.learn(0.45, 21);
  check('0.40 -> 0.45 (12% up): not worth a write', c.gen() === 1);
  c.learn(0.52, 22);
  check('0.40 -> 0.52 (30% up): written', c.gen() === 2 && near(c.storedVar(), 0.52));
  c.learn(0.40, 23);
  check('0.52 -> 0.40 (23% down, past the 0.8 line): written', c.gen() === 3 && near(c.storedVar(), 0.40));
  const d = await clock(); d.cfg('tc_persist = on');
  d.learn(0.01, 20);
  check('a quiet clock (learned 0.01, under the floor) is written once', d.gen() === 1 && near(d.used(), A_FLOOR));
  d.learn(0.03, 21); d.learn(0.10, 22); d.learn(0.002, 23);
  check('... and not again while its level stays under the floor, whatever it does there', d.gen() === 1);
  d.learn(0.25, 24);
  check('... until it rises 25% above the floor', d.gen() === 2);
}

// 4. A write made only for the wander never disturbs the stored temperature model.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.setModel(0.02, 0.001, 20, 40, 5000, 0.3);
  check('a temperature model is stored', c.ee2Commit() === 1 && c.gen() === 1);
  const model = c.bytes(0).slice(8, 54);
  c.clearModel(); c.cfg('tc_persist = on');                  // the next boot has no live model (learning restarted)
  c.learn(0.4, 20);
  check('the wander is then saved in a new record', c.gen() === 2 && c.storedCount() === 20);
  check('... whose model fields are the stored ones, byte for byte', JSON.stringify(c.bytes(1).slice(8, 54)) === JSON.stringify(model));
  // and a live model too weak to persist does not ride along with a wander write
  const d = await clock(); d.cfg('tc_persist = on');
  d.setModel(0.02, 0.001, 20, 40, 5000, 0.3); d.ee2Commit();
  const kept = d.bytes(0).slice(8, 54);
  d.setModel(0.09, 0.004, 20, 22, 50, 0.3);                   // 50 samples over 2 degC: not well supported
  d.learn(0.4, 20);
  check('a live model too weak to persist is not written with it; the stored one is kept', d.gen() === 2 && JSON.stringify(d.bytes(1).slice(8, 54)) === JSON.stringify(kept));
}

// 5. A model write carries the wander with it.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.fwSet(0.4, 20); c.setModel(0.02, 0.001, 20, 40, 5000, 0.3);
  check('a model record written while a wander is learned holds both', c.ee2Commit() === 1 && c.storedCount() === 20 && near(c.storedVar(), 0.4));
}

// 6. Old and damaged records.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.setModel(0.02, 0.001, 20, 40, 5000, 0.3); c.ee2Commit();  // no wander learned: bytes 54..61 are zero, as in every older record
  check('a record from older firmware (wander bytes zero) loads with no wander', c.bytes(0).slice(54, 62).every((b) => b === 0) && c.storedCount() === 0);
  c.powerCycle();
  check('... and the bound starts on its default', c.count() === 0 && near(c.used(), A_DEFAULT));
  check('... while the stored model is still there', c.probe2(0) === 1);
  const d = await clock(); d.cfg('tc_persist = on');
  d.learn(0.4, 20);
  d.poke(55, d.peek(55) ^ 0x10);                              // one bit of the stored variance flips
  d.powerCycle();
  check('a record with a flipped bit fails its CRC: nothing is restored from it', d.count() === 0 && near(d.used(), A_DEFAULT));
}

// 7. tc_reset forgets the learned wander, live and stored.
{
  const c = await clock(); c.cfg('tc_persist = on');
  c.learn(0.4, 20);
  c.cfg('tc_reset = on'); c.housekeeping();
  check('tc_reset: the live wander is gone, the bound is back on its default', c.count() === 0 && near(c.used(), A_DEFAULT));
  check('tc_reset: the stored copy is erased with the model store', c.storedCount() === 0 && c.peek(0) === 0xFF);
  c.powerCycle();
  check('... and stays gone after a power cycle', c.count() === 0);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
