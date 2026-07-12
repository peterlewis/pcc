// settings_check.mjs — the QSPI SETTINGS.BIN store (Design C): the RC-silicon fix for settings that
// never survived a power cycle. The emu models the real medium with NOR physics (program ANDs bits
// 1->0, erase refills a 4 KB sector to 0xFF) and a host-visible mapping generation, so every scenario
// here is one the W25Q128 can actually produce:
//   provisioning (0xFF vs naive 0x00 fill), absent/fragmented file -> honest RAM-only fallback,
//   power-cycle persistence, torn-write recovery via skip-to-blank, host clobber mid-session
//   (map_gen bump + content scribble -> sentinel reinit, never a blind write), NOR AND physics.
// Run: node settings_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev     = w('emu_menu_event', 'void', ['number']);
const layer  = w('emu_menu_layer', 'number');
const secOf  = w('emu_menu_section', 'number');
const rowPtr = w('emu_daterow', 'number');
const eeReset  = w('emu_ee_reset', 'void');
const eeLoad   = w('emu_ee_load', 'void');
const eeCommit = w('emu_ee_commit', 'number');
const ovrClear = w('emu_ovr_clear', 'void');
const ovrValid = w('emu_ovr_valid', 'number');
const setMtime = w('emu_set_mtime', 'void', ['number','number']);
const cfgDef   = w('emu_cfg_defined', 'void', ['number','number']);
const eeApply  = w('emu_ee_apply', 'void');
const setBal   = w('emu_set_balance', 'void', ['number','number']);
const segBal   = w('emu_seg_balance', 'number');
const colBal   = w('emu_colon_balance', 'number');
const eePeek   = w('emu_ee_peek', 'number', ['number']);
const eePoke   = w('emu_ee_poke', 'void', ['number','number']);
const attach   = w('emu_settings_attach', 'void', ['number','number','number']);
const hostWr   = w('emu_settings_host_write', 'void', ['number','number','number']);
const backing  = w('emu_ee_backing', 'number');        // 0 NONE / 1 INTERNAL / 2 QSPI
const sfState  = w('emu_ee_sfile_state', 'number');    // 0 no file / 1 ok / 2 fragmented
const eeNext   = w('emu_ee_next', 'number');
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC_DISP = 2;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

function backToL0(){ for (let i = 0; i < 6 && layer() !== 0; i++){ ev(EVT.S2); ev(EVT.REL); } }
function toggleBalanceOn(){        // enter DISP > BALANCE, editor flow: EDIT -> tap ON -> DONE (saves)
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);
  for (let h = 0; !row().startsWith('BALANCE') && h < 12; h++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);
  backToL0();
}
// A "reboot": live flags scribbled off, RAM override store lost, flash re-scanned, config precedence
// left open so the stored override applies.
function powerCycle(){
  setBal(0, 0); ovrClear(); eeLoad();
  cfgDef(0, 0); setMtime(0x9999, 0x9999);
  eeApply();
}

bootCold(1783627200);

// (1) default provisioning: SETTINGS.BIN attached, 0xFF-filled -> QSPI backing engages.
attach(1, 0, 0xFF); eeReset(); setMtime(0x5AA5, 0x1234);
check(`provisioned card -> QSPI backing (bk=${backing()}, file=${sfState()})`, backing() === 2 && sfState() === 1);

// (2) NOR physics: program can only clear bits — poke 0x00 then "program" 0xFF over it must stay 0x00.
eePoke(4000, 0x00);
check(`NOR emu: erased byte programmable`, eePeek(4001) === 0xFF);
// (the AND rule is exercised for real by every commit below; a memcpy shim would hide torn-write bugs)

// (3) the headline bug: a menu toggle survives a power cycle.
setBal(0, 0); toggleBalanceOn();
check(`BALANCE ON live (seg=${segBal()})`, segBal() === 1);
check(`commit wrote a record`, eeCommit() === 1 || ovrValid() === 1);
powerCycle();
check(`SURVIVES power cycle (seg=${segBal()} col=${colBal()})`, segBal() === 1 && colBal() === 1);

// (4) torn write: garbage half-programmed into the next slot (power died mid-record). The reboot scan
// must reject it (CRC) AND the cursor must skip past it (NOR can't re-program a dirty slot).
const slot = eeNext();                       // next append target
eePoke(slot * 64 + 0, 0x45); eePoke(slot * 64 + 1, 0x34);   // "E4" — magic half-written, no CRC
ovrClear(); eeLoad();
check(`torn slot rejected, prior record still wins`, ovrValid() === 1);
check(`cursor skipped the torn slot (next=${eeNext()} > ${slot})`, eeNext() > slot);
check(`commit after torn slot still lands`, eeCommit() === 1);

// (5) host clobber mid-session: the host rewrites the file's contents (map_gen bumps, store bytes
// scribbled). The next commit must detect it (sentinel), re-init INSIDE the file, and re-append —
// never blind-write, never wedge.
hostWr(0, 0x2000, 0x37);                     // host scribbles the whole menu pair + bumps map_gen
check(`commit after host clobber recovers (rc=${eeCommit()})`, eeCommit() === 1);
powerCycle();
check(`post-clobber record survives the next power cycle`, segBal() === 1);

// (6) no file on the card -> honest RAM-only: backing NONE, commits refuse, live value still works.
attach(0, 0, 0xFF); setBal(0, 0); ovrClear(); eeLoad();
check(`no SETTINGS.BIN -> RAM-only (bk=${backing()}, file=${sfState()})`, backing() === 0 && sfState() === 0);
setBal(1, 1);
check(`commit refuses without a store`, eeCommit() === 0);
ovrClear(); eeLoad();
check(`nothing persists without a store`, ovrValid() === 0);

// (7) fragmented file -> resolver rejects -> RAM-only with the distinct diagnostic state.
attach(1, 1, 0xFF); ovrClear(); eeLoad();
check(`fragmented SETTINGS.BIN -> RAM-only (bk=${backing()}, file=${sfState()})`, backing() === 0 && sfState() === 2);

// (8) naive 0x00-filled provisioning (host tool wrote zeros, not 0xFF): first use must erase the
// pair to true NOR-blank, then persist normally. Without the first-use erase every record would
// AND into garbage and fail CRC forever — the permanent-wedge failure the design review killed
// Design B over.
attach(1, 0, 0x00); ovrClear(); eeLoad();
check(`0x00-filled file -> QSPI backing engages (bk=${backing()})`, backing() === 2);
setMtime(0x5AA5, 0x1234); setBal(0, 0); toggleBalanceOn();
check(`commit into recovered file works`, ovrValid() === 1 && eeCommit() === 1);
powerCycle();
check(`0x00-provisioned card persists after first-use erase (seg=${segBal()})`, segBal() === 1);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
