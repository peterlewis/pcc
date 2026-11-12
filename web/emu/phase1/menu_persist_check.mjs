// menu_persist_check.mjs — the menu's flash-EEPROM persistence + config.txt precedence, exercised
// against the firmware's OWN ee_load/ee_commit/menu_apply_overrides (flash shimmed to a RAM buffer).
//
// Covers: commit a menu edit -> "reboot" (clear RAM ovr, re-scan) -> value survives; the precedence
// merge (a stored choice applies unless config.txt's line for that setting is new or has changed since
// the previous load; at boot the store's mtime stamp says whether the file is the one it was last
// merged with, and a ZERO mtime never matches); and power-loss recovery (a torn last record fails CRC -> falls back to the
// prior generation). Run: node menu_persist_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const eeReset = w('emu_ee_reset', 'void');
const eeLoad  = w('emu_ee_load', 'void');
const eeCommit= w('emu_ee_commit', 'number');
const eeApply = w('emu_ee_apply', 'void');
const ovrClear= w('emu_ovr_clear', 'void');
const ovrValid= w('emu_ovr_valid', 'number');
const setMtime= w('emu_set_mtime', 'void', ['number','number']);
const cfgDef  = w('emu_cfg_defined', 'void', ['number','number']);
const bright  = w('emu_brightness', 'number');
const setBright = w('emu_set_brightness', 'void', ['number']);
const eePeek  = w('emu_ee_peek', 'number', ['number']);
const eePoke  = w('emu_ee_poke', 'void', ['number','number']);
const dirty   = w('emu_menu_dirty', 'number');
const factoryReset = w('emu_factory_reset', 'void');
const secOf   = w('emu_menu_section', 'number');

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC_DISP = 2;   // BRIGHT lives in the DISP section (v2 sectioned nav)
const KID_BRIGHTNESS = 1;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

// Drive the menu to set BRIGHT (row 0) to +256 and SAVE, then exit to L0. Stamps ovr with the
// current config.txt mtime. (BRIGHT boots at AUTO; pinned to 0 first, one +256 step -> 256.)
function setBrightViaMenu() {
  setBright(0);                          // deterministic start so one +256 step always lands on 256
  ev(EVT.S1); ev(EVT.REL);               // L0 -> L1 SECTION ring
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);   // scroll to DISP (section preserved across calls)
  ev(EVT.S1); ev(EVT.REL);               // ENTER DISP -> L2 (cursor at first DISP item = BRIGHT)
  ev(EVT.S1); ev(EVT.REL);               // EDIT -> L3 editor
  ev(EVT.BTN1);                          // step 0 -> 256 (live)
  ev(EVT.S1); ev(EVT.REL);               // SAVE (records override, menu_dirty=1) -> L2
  ev(EVT.S2); ev(EVT.REL);               // BACK -> L1 SECTION
  ev(EVT.S2); ev(EVT.REL);               // EXIT -> L0
}

bootCold(1783627200);

// (1) commit + reboot: the edit survives a RAM wipe + flash re-scan.
eeReset();
setMtime(0x5AA5, 0x1234);           // pretend config.txt mtime at edit time
setBrightViaMenu();
check(`edit marks store dirty`, dirty() === 1);
check(`commit writes a record`, eeCommit() === 1 && dirty() === 0);
setBright(-9);                       // scribble the live value
ovrClear();                          // simulate RAM loss on reboot
check(`after RAM wipe the store is empty`, ovrValid() === 0);
eeLoad();                            // re-scan flash
check(`reboot re-scan finds the record`, ovrValid() === 1);

// (2) boot — config.txt does not mention brightness -> the stored choice applies.
setBright(-9); cfgDef(0, 0); setMtime(0x9999, 0x9999);
eeApply();
check(`undefined-in-config -> override applies (${bright()})`, bright() === 256);

// (3) a reload — config.txt has gained a brightness line -> the file wins.
setBright(-9); cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x1111, 0x2222);
eeApply();
check(`a new brightness line -> config wins (${bright()})`, bright() === -9);

// (4) and the menu's choice was deleted, not kept: nothing brings it back, not even the file it was
//     made against.
setBright(-9); cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x5AA5, 0x1234);
eeApply();
check(`the beaten choice is gone for good (${bright()})`, bright() === -9);
setBright(-9); cfgDef(0, 0); setMtime(0x3333, 0x4444);
eeApply();
check(`removing the line does not bring it back either (${bright()})`, bright() === -9);

// (4b) a choice made while config.txt already had a brightness line. At boot, a file that still
//      carries the store's stamp is the file the store was last merged with: the choice applies.
eeReset(); cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x5AA5, 0x1234); eeApply();
setBrightViaMenu(); eeCommit();
setBright(-9); ovrClear(); eeLoad();
cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x5AA5, 0x1234); eeApply();
check(`boot, same file as the last merge -> the stored choice applies (${bright()})`, bright() === 256);
//      A file with another stamp, but the same brightness line: the store kept what the file said
//      (its file record, in the slot after the menu record), so the choice still applies.
setBright(-9); ovrClear(); eeLoad();
cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x7777, 0x8888); eeApply();
check(`boot, another stamp but the same line -> the stored choice applies (${bright()})`, bright() === 256);
//      Without a file record (an older build's store, or a write cut short) the stamp decides: a
//      file with another stamp wins every setting it mentions.
eeReset(); cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x5AA5, 0x1234); eeApply();
setBrightViaMenu(); eeCommit();
eePoke(64 + 62, eePeek(64 + 62) ^ 0xFF);     // slot 1 is the file record: spoil its CRC
setBright(-9); ovrClear(); eeLoad();
cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0x7777, 0x8888); eeApply();
check(`boot, no file record and another stamp -> config wins (${bright()})`, bright() === -9);

// (5) zero mtime never matches (a host that writes no timestamps): at boot the file wins what it
//     mentions. Stamp a zero-mtime choice, then boot with a defined key and mtime 0/0.
eeReset(); cfgDef(1 << KID_BRIGHTNESS, 0);
setMtime(0, 0);                      // zero mtime at edit time -> stamp 0/0
setBrightViaMenu();
eeCommit();
setBright(-9); ovrClear(); eeLoad();
cfgDef(1 << KID_BRIGHTNESS, 0); setMtime(0, 0);   // "matches" numerically, but zero
eeApply();
check(`zero mtime never matches -> config wins (${bright()})`, bright() === -9);

// (6) power-loss: two generations, corrupt the newer record's CRC -> reload falls back to the older.
eeReset();
setMtime(0x5AA5, 0x1234);
setBrightViaMenu(); eeCommit();      // gen1: brightness 256 (slot 0)
// second edit -> 512, commit as gen2 (slot 1). Sectioned nav: enter DISP, edit BRIGHT (+256), save, exit.
ev(EVT.S1); ev(EVT.REL);
for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
ev(EVT.S1); ev(EVT.REL); ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); ev(EVT.S2); ev(EVT.REL); ev(EVT.S2); ev(EVT.REL);
eeCommit();
// corrupt slot-1's CRC16 (record 64 B; crc at byte offset 62) -> flip a bit
eePoke(64 + 62, eePeek(64 + 62) ^ 0xFF);
ovrClear(); eeLoad();
setBright(-9); cfgDef(0, 0); setMtime(0x9999, 0x9999); eeApply();
check(`torn gen2 rejected -> falls back to gen1 (${bright()})`, bright() === 256);

// (7) factory reset ("factory_reset = on"): a committed override is wiped from flash + the RAM store,
//     and a subsequent reboot re-scan finds nothing (back to config.txt-only).
eeReset();
setMtime(0x5AA5, 0x1234);
setBrightViaMenu(); eeCommit();
check(`pre-reset: an override is stored`, ovrValid() === 1);
factoryReset();                              // factory_reset = on
check(`factory reset clears the RAM store`, ovrValid() === 0);
ovrClear(); eeLoad();                        // "reboot": re-scan flash
check(`factory reset erased flash (reboot finds nothing)`, ovrValid() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
