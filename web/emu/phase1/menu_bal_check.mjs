// menu_bal_check.mjs — the DISP › BALANCE toggle (per-segment + colon brightness uniformity) and the
// 2-anchor AUTO colon curve it drives. One menu switch arms both seg_balance and colon_balance at
// their baked AUTO curves; config.txt keeps the finer seg_balance/colon_balance keys (incl. manual
// strengths). The colon curve is a straight line clamp(256*(4095-dac)/(4095-colon_full_at), floor,256)
// with per-hardware anchors colon_full_at (2048) / colon_floor (20) baked in and config-overridable —
// asserted against the production Mk IV eyeball sweep (2026-07-11). Run: node menu_bal_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr= w('emu_daterow', 'number');
const segBal = w('emu_seg_balance', 'number');
const colBal = w('emu_colon_balance', 'number');
const setBal = w('emu_set_balance', 'void', ['number','number']);
const colScale = w('emu_colon_scale', 'number', ['number']);
const setAnchors = w('emu_set_colon_anchors', 'void', ['number','number']);
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
const L2 = 2, L3 = 3, SEC_DISP = 2, KID_BALANCE = 10;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function backToL0() { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } }
function gotoBalance() {
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                     // ENTER DISP -> L2 banner
  ev(EVT.BTN1);                                                // dismiss banner
  for (let h = 0; !row().startsWith('BALANCE') && h < 12; h++) ev(EVT.BTN1);
}

bootCold(1783627200);
setBal(0, 0);

// --- the 2-anchor colon curve, at the baked defaults (colon_full_at=2048, colon_floor=20) ---
// dac_target 0 = brightest .. 4095 = dimmest. Full at/below mid rail, tapering to the floor at dark.
setAnchors(2048, 20);
check(`colon full-scale at the bright half (dac 0 -> 256)`, colScale(0) === 256);
check(`colon full-scale at the anchor (dac 2048 -> 256)`, near(colScale(2048), 256, 1));
check(`colon floor at the dimmest rail (dac 4095 -> 20)`, colScale(4095) === 20);
// production Mk IV eyeball sweep: dac 3276 -> ~100, dac 2867 -> ~155 (line through the measured points).
check(`measured point dac 3276 -> ~102 (got ${colScale(3276)})`, near(colScale(3276), 102, 6));
check(`measured point dac 2867 -> ~153 (got ${colScale(2867)})`, near(colScale(2867), 153, 8));
check(`monotone: brighter rail never dimmer colons`, colScale(3000) >= colScale(3500) && colScale(3500) >= colScale(4095));

// per-hardware override: a different floor/anchor shifts the whole line (config-overridable like BS).
setAnchors(1024, 60);
check(`override floor honoured (dac 4095 -> 60)`, colScale(4095) === 60);
check(`override anchor honoured (dac 1024 -> 256)`, near(colScale(1024), 256, 1));
setAnchors(2048, 20);                                          // restore defaults for the rest

// --- the BALANCE menu toggle drives both systems + persists ---
gotoBalance();
check(`DISP has a BALANCE toggle ("${row()}")`, row().startsWith('BALANCE') && secOf() === SEC_DISP);
ev(EVT.S1); ev(EVT.REL);                                       // EDIT -> L3
check(`editor opens at L3`, layer() === L3);
ev(EVT.BTN1);                                                  // ON (live)
check(`ON arms seg AND colon AUTO`, segBal() === 1 && colBal() === 1);
ev(EVT.S2); ev(EVT.REL);                                       // CANCEL -> revert to off
check(`CANCEL reverts both (seg=${segBal()} col=${colBal()})`, segBal() === 0 && colBal() === 0);
backToL0();

// SAVE + reboot: the choice survives.
eeReset(); setMtime(0x5AA5, 0x1234);
gotoBalance();
ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1);                         // EDIT, ON
ev(EVT.S1); ev(EVT.REL);                                       // SAVE -> L2
check(`SAVE returns to L2`, layer() === L2);
check(`commit writes a record`, eeCommit() === 1);
backToL0();
setBal(0, 0);                                                  // scribble off (as if power-lost)
ovrClear(); eeLoad();
check(`reboot re-scan finds the record`, ovrValid() === 1);
cfgDef(0, 0); setMtime(0x9999, 0x9999);
eeApply();
check(`armed BALANCE SURVIVES reboot (seg=${segBal()} col=${colBal()})`, segBal() === 1 && colBal() === 1);

// precedence: config defines seg/colon_balance (KID_BALANCE) with a MISMATCHED mtime -> config wins,
// override skipped; scribble off first, and it stays off.
setBal(0, 0);
cfgDef(1 << KID_BALANCE, 0); setMtime(0x1111, 0x2222);
eeApply();
check(`defined-in-config + mtime mismatch -> override skipped`, segBal() === 0 && colBal() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
