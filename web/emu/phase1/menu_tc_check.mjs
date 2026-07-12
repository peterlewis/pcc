// menu_tc_check.mjs — the DIAG › TEMPCOMP on-device toggle. One menu switch arms the whole self-
// learning compensator: tc_learn (sample ppm-vs-die-temp while GPS-locked) AND tc_apply (steer SysTick
// from the model during holdover). Asserts the toggle drives both flags together, SAVE persists the
// choice across a reboot, CANCEL reverts, and — because the menu bundles what config.txt splits into
// tc_learn/tc_apply — the merge marks KID_TEMPCOMP so config precedence still works. The separate
// "TC VIEW" display mode (the diagnostic readout) is deliberately NOT this toggle. Run: node menu_tc_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr= w('emu_daterow', 'number');
const tcLearn = w('emu_tc_learn', 'number');
const tcApply = w('emu_tc_apply', 'number');
const setTc   = w('emu_set_tc', 'void', ['number','number']);
const eeReset = w('emu_ee_reset', 'void');
const eeLoad  = w('emu_ee_load', 'void');
const eeCommit= w('emu_ee_commit', 'number');
const eeApply = w('emu_ee_apply', 'void');
const ovrClear= w('emu_ovr_clear', 'void');
const ovrValid= w('emu_ovr_valid', 'number');
const setMtime= w('emu_set_mtime', 'void', ['number','number']);
const cfgDef  = w('emu_cfg_defined', 'void', ['number','number']);
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const L2 = 2, L3 = 3, SEC_DIAG = 3, KID_TEMPCOMP = 9;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

// Back out to the clock (L0) from wherever we are: S2 = CANCEL(L3)/BACK(L2)/EXIT(L1); stop at L0 so we
// never hit the L0 RESET chord.
function backToL0() { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } }

// From L0, walk the sectioned nav to DIAG › TEMPCOMP, leaving the cursor on it at L2.
function gotoTempcomp() {
  ev(EVT.S1); ev(EVT.REL);                                     // L0 -> L1 section ring
  for (let g = 0; secOf() !== SEC_DIAG && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                     // ENTER DIAG -> L2, lands on the first DIAG item
  for (let h = 0; !row().startsWith('TEMPCOM') && h < 12; h++) ev(EVT.BTN1);
}

bootCold(1783627200);
setTc(0, 0);                                                   // deterministic start: compensator disarmed

// (0) the item exists in DIAG and reads as a toggle (not the "TC VIEW" mode).
gotoTempcomp();
check(`DIAG has a TEMPCOMP toggle item ("${row()}")`, row().startsWith('TEMPCOM') && secOf() === SEC_DIAG);

// (1) one-press EDIT toggles TEMPCOMP in place (no editor) and arms BOTH tc_learn + tc_apply; a second
//     EDIT turns it back off.
ev(EVT.S1); ev(EVT.REL);                                       // EDIT toggles ON at L2
check(`stays at L2 (a toggle has no editor)`, layer() === L2);
check(`ON arms learn AND apply`, tcLearn() === 1 && tcApply() === 1);
ev(EVT.S1); ev(EVT.REL);                                       // EDIT again -> OFF
check(`toggle off disarms both (learn=${tcLearn()} apply=${tcApply()})`, tcLearn() === 0 && tcApply() === 0);
backToL0();

// (2) the one-press toggle persists across a reboot: it records immediately (no separate SAVE), and the
//     commit gate / eeCommit writes it to flash.
eeReset(); setMtime(0x5AA5, 0x1234);
gotoTempcomp();
ev(EVT.S1); ev(EVT.REL);                                       // EDIT -> ON, recorded in place
check(`toggle ON at L2 (learn=${tcLearn()})`, layer() === L2 && tcLearn() === 1);
check(`commit writes a record`, eeCommit() === 1);
backToL0();
setTc(0, 0);                                                   // scribble live flags off (as if power-lost)
ovrClear();                                                    // RAM override store lost on reboot
check(`after RAM wipe the store is empty`, ovrValid() === 0);
eeLoad();                                                      // re-scan flash
check(`reboot re-scan finds the record`, ovrValid() === 1);
cfgDef(0, 0); setMtime(0x9999, 0x9999);                        // config defines nothing -> override applies
eeApply();
check(`armed TEMPCOMP SURVIVES reboot (learn=${tcLearn()} apply=${tcApply()})`, tcLearn() === 1 && tcApply() === 1);

// (3) precedence: config.txt DEFINES the tc_learn/tc_apply pair (KID_TEMPCOMP) with a mtime that DOESN'T
//     match the override stamp -> config owns it, the stored override is skipped. Scribble off first;
//     with the override skipped the flags stay off (config path, not the menu store, decides).
setTc(0, 0);
cfgDef(1 << KID_TEMPCOMP, 0); setMtime(0x1111, 0x2222);        // defined, mtime != 0x5AA5/0x1234
eeApply();
check(`defined-in-config + mtime mismatch -> override skipped (flags stay off)`, tcLearn() === 0 && tcApply() === 0);

// (4) precedence: same config key but mtime MATCHES the stamp -> the on-device override wins again.
setTc(0, 0);
cfgDef(1 << KID_TEMPCOMP, 0); setMtime(0x5AA5, 0x1234);        // defined, mtime == stamp
eeApply();
check(`defined-in-config + mtime match -> override applies (learn=${tcLearn()} apply=${tcApply()})`, tcLearn() === 1 && tcApply() === 1);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
