// settings_rdfault_check.mjs — regression for a QSPI read fault erasing the settings store.
// A failed store read returns zeros. Zeros are not a record and not a blank page — which is exactly
// the state that told ee_scan "freshly provisioned file, erase it" at boot, told ee_sentinel "the
// host scribbled the log, erase it" at commit, and told the skip-to-blank loop "this page is full,
// erase the other one". One transient HAL error cost every menu setting and the learned tempcomp
// model. The rule now: a failed read stops the store (RAM-only until the next power-on, which
// retries) and nothing is erased or programmed after it. With the old code every "untouched" case
// FAILS. Run: node settings_rdfault_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const eeReset = w('emu_ee_reset'), eeLoad = w('emu_ee_load'), eeCommit = w('emu_ee_commit', 'number');
const ovrClear = w('emu_ovr_clear'), ovrValid = w('emu_ovr_valid', 'number');
const recordMode = w('emu_record_mode', 'void', ['number', 'number']);
const eePeek = w('emu_ee_peek', 'number', ['number']);
const backing = w('emu_ee_backing', 'number'), sfState = w('emu_ee_sfile_state', 'number');
const rdfault = w('emu_settings_rdfault', 'void', ['number']);
const hostWr = w('emu_settings_host_write', 'void', ['number', 'number', 'number']);
const ee2Commit = w('emu_ee2_commit', 'number');
const tcPersist = w('emu_tc_persist_set', 'void', ['number']);
const setModel = w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']);
const MODE_UNIX = w('emu_MODE_UNIX', 'number')();

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const snapshot = () => { const a = new Uint8Array(16384); for (let i = 0; i < a.length; i++) a[i] = eePeek(i); return a; };
const same = (a, b) => a.every((v, i) => v === b[i]);
const blank = (a, from, to) => { for (let i = from; i < to; i++) if (a[i] !== 0xFF) return false; return true; };

// A provisioned file holding one menu record and one tempcomp record.
function provision() {
  rdfault(0);
  bootCold(1718971200);
  eeReset();
  recordMode(MODE_UNIX, 1);
  const menuOk = eeCommit() === 1;
  tcPersist(1); setModel(0.02, 0.001, 20, 40, 5000, 0.3);
  const tcOk = ee2Commit() === 1;
  return { menuOk, tcOk, file: snapshot() };
}

// 1. A read fault at boot must not erase either store.
{
  const p = provision();
  check('setup: a menu record and a tempcomp record are on the file', p.menuOk && p.tcOk && !blank(p.file, 0, 64) && !blank(p.file, 0x2000, 0x2040));
  ovrClear(); rdfault(1); eeLoad();                    // power-on with the QSPI failing every read
  const after = snapshot();
  check('boot with a read fault: the menu pages are untouched', same(p.file.subarray(0, 0x2000), after.subarray(0, 0x2000)));
  check('boot with a read fault: the tempcomp pages are untouched', same(p.file.subarray(0x2000), after.subarray(0x2000)));
  check(`boot with a read fault: the store runs RAM-only and says why (backing ${backing()}, state ${sfState()})`, backing() === 0 && sfState() === 3);
  check('boot with a read fault: nothing unreadable is applied as settings', ovrValid() === 0);
  recordMode(MODE_UNIX, 0);
  check('boot with a read fault: a commit is refused', eeCommit() === 0 && same(p.file, snapshot()));

  rdfault(0); ovrClear(); eeLoad();                    // the fault was transient: the next power-on retries
  check('next power-on, QSPI healthy: the store is back and the record loads', backing() === 1 && sfState() === 1 && ovrValid() === 1);
  check('next power-on: the file is still byte-identical', same(p.file, snapshot()));
}

// 2. A read fault at commit time must not erase or program.
{
  const p = provision();
  rdfault(1);
  recordMode(MODE_UNIX, 0);
  check('menu commit with a read fault: refused', eeCommit() === 0);
  check('menu commit with a read fault: the file is untouched', same(p.file, snapshot()));
  check('menu commit with a read fault: the store is RAM-only from here', backing() === 0 && sfState() === 3);
  rdfault(0);
  check('the store stays RAM-only until the next power-on, even once reads work', eeCommit() === 0 && same(p.file, snapshot()));
}
{
  const p = provision();
  rdfault(1);
  setModel(0.05, 0.002, 10, 50, 9000, 0.2);
  check('tempcomp commit with a read fault: refused', ee2Commit() === 0);
  check('tempcomp commit with a read fault: the file is untouched', same(p.file, snapshot()));
}

// 3. A read fault during the rescan that follows a host write must not erase or program.
{
  const p = provision();
  hostWr(0x3F00, 1, 0xFF);                             // a host write somewhere on the drive: mapping must be revalidated
  rdfault(1);
  recordMode(MODE_UNIX, 0);
  check('commit after a host write, with a read fault: refused and the file is untouched', eeCommit() === 0 && same(p.file, snapshot()));
}

// 4. The healthy path is unchanged: commits land and survive a power cycle.
{
  const p = provision();
  recordMode(MODE_UNIX, 0);
  check('healthy: a second commit lands in the next slot', eeCommit() === 1 && !blank(snapshot(), 64, 128));
  ovrClear(); eeLoad();
  check('healthy: the record loads after a power cycle', ovrValid() === 1 && backing() === 1);
  void p;
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
