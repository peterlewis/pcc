// menu_gate_check.mjs — regression for the PPS-latch bug that stopped menu settings persisting on real
// hardware. The menu-commit gate lives in menu_poll and fires only when the display UART is idle AND no
// $PMTXTS emit is actually pending. pps_record_pending is set on EVERY PPS edge but cleared only by the
// emit path (which runs only when pps_ts_enabled), so on a GPS-locked clock with PPS-out off (the
// default) it latches high forever — and the old gate `!pps_record_pending` then never opened, so no
// menu edit was ever written to flash. The fix keys the gate off pps_emit_pending() (pps_ts_enabled &&
// pps_record_pending). This drives the REAL gate through menu_poll (not emu_ee_commit) — with the old
// code the "PPS-locked, PPS-out off" case FAILS; with the fix it passes. Run: node menu_gate_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold  = w('emu_boot_cold', 'void', ['number']);
const ev        = w('emu_menu_event', 'void', ['number']);
const eeReset   = w('emu_ee_reset', 'void');
const eeLoad    = w('emu_ee_load', 'void');
const ovrClear  = w('emu_ovr_clear', 'void');
const ovrValid  = w('emu_ovr_valid', 'number');
const setMtime  = w('emu_set_mtime', 'void', ['number', 'number']);
const setBright = w('emu_set_brightness', 'void', ['number']);
const dirty     = w('emu_menu_dirty', 'number');
const setUart   = w('emu_set_uart_ready', 'void', ['number']);
const setPps    = w('emu_set_pps', 'void', ['number', 'number']);
const menuTick  = w('emu_menu_tick', 'void', ['number']);   // re-runs menu_poll (the gate) with no button side effect
const secOf     = w('emu_menu_section', 'number');

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC_DISP = 2;   // BRIGHT lives in the DISP section (v2 sectioned nav)
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

// Edit BRIGHT and SAVE, then BACK to L0 — the BACK event's menu_poll runs the real commit gate.
// (No emu_ee_commit here: the whole point is to exercise the gate, not bypass it.)
function editSaveReturnToClock() {
  setBright(0);
  ev(EVT.S1); ev(EVT.REL);               // L0 -> L1 SECTION
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);   // -> DISP
  ev(EVT.S1); ev(EVT.REL);               // ENTER -> L2 (cursor at BRIGHT)
  ev(EVT.S1); ev(EVT.REL);               // EDIT -> L3
  ev(EVT.BTN1);                          // step (live), menu_dirty set on SAVE
  ev(EVT.S1); ev(EVT.REL);               // SAVE  -> L2
  ev(EVT.S2); ev(EVT.REL);               // BACK  -> L1
  ev(EVT.S2); ev(EVT.REL);               // EXIT  -> L0 : menu_poll runs the commit gate on this event
}

bootCold(1783627200);

// (1) THE BUG CONDITION — GPS-locked, PPS-out OFF: pps_record_pending latched, no real emit pending.
//     The gate MUST still open. (Old `!pps_record_pending` gate: never opens -> this fails.)
eeReset(); setMtime(0x5AA5, 0x1234);
setUart(1);            // display link idle (gate precondition)
setPps(0, 1);         // pps_ts_enabled=0 (default), pps_record_pending=1 (latched by PPS)
editSaveReturnToClock();
check(`PPS-locked + PPS-out off: gate opened, edit committed (dirty cleared)`, dirty() === 0);
ovrClear(); eeLoad();                       // simulate a power cycle
check(`PPS-locked + PPS-out off: menu edit SURVIVES reboot`, ovrValid() === 1);

// (2) NEGATIVE CONTROL — a real $PMTXTS emit IS pending (PPS-out on + capture pending): the gate must
//     correctly DEFER the ~20 ms erase so it can't delay the emit. dirty stays set until the emit clears.
eeReset(); setMtime(0x5AA5, 0x1234);
setUart(1);
setPps(1, 1);         // pps_ts_enabled=1 AND pps_record_pending=1 -> a genuine emit is pending
editSaveReturnToClock();
check(`real pending emit correctly DEFERS the commit (dirty stays 1)`, dirty() === 1);

// (3) emit drains -> pending clears -> the next menu_poll commits (idle event re-runs the gate).
setPps(1, 0);         // emit fired, pps_record_pending cleared
menuTick(1);                 // re-run menu_poll (the gate) with no button side effect
check(`after the emit drains, the deferred commit lands (dirty cleared)`, dirty() === 0);
ovrClear(); eeLoad();
check(`deferred edit SURVIVES reboot once the emit cleared`, ovrValid() === 1);

// (4) UART busy (display mid-transfer): gate must wait (unchanged behaviour, no PPS involved).
eeReset(); setMtime(0x5AA5, 0x1234);
setUart(0);           // huart2 busy -> gate closed regardless of PPS
setPps(0, 0);
editSaveReturnToClock();
check(`display link busy: gate waits (dirty stays 1)`, dirty() === 1);
setUart(1);
menuTick(1);                 // link idle now -> gate opens
check(`link idle again: commit lands (dirty cleared)`, dirty() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
