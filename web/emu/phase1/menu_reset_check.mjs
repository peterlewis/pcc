// menu_reset_check.mjs — SYS › RESET, the on-device factory-reset ACTION item (MIT_ACTION). Unlike a
// toggle it is NOT one-press: EDIT opens a "SURE?" confirm, and only the SAVE chord fires it (CANCEL
// aborts). Firing sets menu_reset_pending, which the main loop's menu_reset_step services — erasing the
// stored overrides and re-reading config.txt (back to defaults, no reboot). Reboot is a separate thing
// (the L0 REBOOT chord). Asserts: the item exists, the confirm gate, CANCEL is safe, SAVE wipes.
// Run: node menu_reset_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr= w('emu_daterow', 'number');
const eeReset= w('emu_ee_reset', 'void');
const eeCommit=w('emu_ee_commit', 'number');
const ovrValid=w('emu_ovr_valid', 'number');
const setMtime=w('emu_set_mtime', 'void', ['number','number']);
const setBal = w('emu_set_balance', 'void', ['number','number']);
const resetPending = w('emu_menu_reset_pending', 'number');
const resetStep    = w('emu_menu_reset_step', 'void');
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const L2 = 2, L3 = 3, SEC_DISP = 2, SEC_SYS = 4;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
function backToL0() { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } }
function gotoSection(sec, prefix) {
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                      // ENTER -> first item
  for (let h = 0; !row().startsWith(prefix) && h < 14; h++) ev(EVT.BTN1);
}

bootCold(1783627200);

// stash a real override in flash so we can watch RESET wipe it: toggle DISP BALANCE ON (one-press
// records it), then force a commit.
eeReset(); setMtime(0x5AA5, 0x1234); setBal(0, 0);
gotoSection(SEC_DISP, 'BALANCE');
ev(EVT.S1); ev(EVT.REL);                                        // EDIT toggles BALANCE ON (recorded)
check(`set up a stored override (commit ${eeCommit()})`, ovrValid() === 1);
backToL0();

// (1) SYS has a RESET action item; EDIT opens the "SURE?" confirm (NOT a one-press toggle).
gotoSection(SEC_SYS, 'RESET');
check(`SYS has a RESET item ("${row()}")`, row() === 'RESET' && secOf() === SEC_SYS);
ev(EVT.S1); ev(EVT.REL);                                        // EDIT -> confirm
check(`EDIT opens the confirm at L3 ("${row()}")`, layer() === L3 && row() === 'SURE?');

// (2) CANCEL is safe: no reset armed, back to the item.
ev(EVT.S2); ev(EVT.REL);
check(`CANCEL aborts (nothing armed, back at L2)`, layer() === L2 && resetPending() === 0 && ovrValid() === 1);

// (3) SAVE from the confirm arms the factory reset; servicing it wipes the stored overrides.
ev(EVT.S1); ev(EVT.REL);                                        // EDIT -> SURE?
check(`re-open confirm`, layer() === L3 && row() === 'SURE?');
ev(EVT.S1); ev(EVT.REL);                                        // SAVE -> fire
check(`SAVE arms the factory reset (pending=${resetPending()})`, resetPending() === 1);
resetStep();                                                    // the main loop services it
check(`factory reset wiped the stored overrides`, ovrValid() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
