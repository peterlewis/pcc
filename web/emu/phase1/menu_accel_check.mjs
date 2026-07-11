// menu_accel_check.mjs — §3c hold-acceleration + §3b large-value render, on the PAGE MS stepper.
// Drives the sectioned nav to the PAGE MS editor and asserts: a single fresh tap moves exactly one
// step; a held run (rapid same-direction taps) accelerates and reaches the floor in far fewer taps;
// accelerated values snap to the step grid; a reversal and a >350 ms pause both drop back to fine;
// and the ring shows the compact "5.5S" unit form (never a hidden value). Run: node menu_accel_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const tick  = w('emu_menu_tick',  'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr = w('emu_daterow', 'number');
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const L3 = 3, SEC_DISP = 2, STEP = 250, LO = 250;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const val = () => parseInt(row().replace(/[^\d-]/g, ''), 10);

bootCold(1783627200);

// navigate to the PAGE MS item (DISP section), stopping at L2 on the item.
function gotoPageMs() {
  ev(EVT.S1); ev(EVT.REL);                                   // L0 -> L1 section ring
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                   // ENTER DISP -> L2, lands on the first item (no banner)
  for (let h = 0; !row().startsWith('PAGE') && h < 12; h++) ev(EVT.BTN1);
}
gotoPageMs();

// §3b: the ring shows the compact unit form, not a hidden value.
check(`§3b ring shows compact "5.5S" ("${row()}")`, row().includes('5.5S'));

ev(EVT.S1); ev(EVT.REL);                                     // EDIT -> L3 editor (raw number)
check(`editor opens at effective 5500 ("${row()}")`, layer() === L3 && val() === 5500);

// (1) single fresh tap = exactly one step.
const v0 = val(); ev(EVT.BTN2); const v1 = val();
check(`single tap = one step (${v0} -> ${v1})`, v0 - v1 === STEP);

// (2) reversal returns to fine: a change of direction resets the run.
ev(EVT.BTN1); const v2 = val();
check(`reversal tap = fine step (+${v2 - v1})`, v2 - v1 === STEP);

// (3) held run accelerates: rapid same-direction taps (same uwTick) reach the floor far faster than
//     the ~21 unaccelerated steps 5500->250 would take.
let taps = 0; for (; taps < 12; taps++) ev(EVT.BTN2);
const vend = val();
check(`held run reaches the floor in <=12 taps (landed ${vend})`, vend === LO);
check(`accelerated value snaps to the step grid`, vend % STEP === 0);

// (4) a >350 ms pause drops back to fine (one tap = one step).
tick(400); ev(EVT.BTN1);
check(`after a pause, next tap is fine (+${val() - vend})`, val() - vend === STEP);

// (5) review fix: idle-timeout mid-edit ABANDONS the scrub like CANCEL — the pre-edit value (5500) is
// restored, not silently kept. (menu_to_L0 alone used to leave the scrubbed value live until reboot.)
const scrubbed = val();
tick(60000); ev(EVT.BTN1);                                   // exceed MENU_IDLE_MS -> menu_to_L0 via the idle check
check(`idle-out returns to the clock (was editing)`, layer() !== L3);
gotoPageMs(); ev(EVT.S1); ev(EVT.REL);                        // re-open the PAGE MS editor
check(`idle abandoned the edit -> value reverted to 5500 (scrubbed was ${scrubbed})`, layer() === L3 && val() === 5500);

// (6) MATRIX renders in clean kHz (K/Z have no 7-seg glyph, so no "KHZ" unit): item reads
// "MATRIX 20" (full label fits), editor reads "20" and steps by 1 kHz. Value stays Hz underneath.
for (let i = 0; i < 4 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); }   // back out to the clock
const SEC_SYS = 4;
ev(EVT.S1); ev(EVT.REL);
for (let g = 0; secOf() !== SEC_SYS && g < 8; g++) ev(EVT.BTN1);
ev(EVT.S1); ev(EVT.REL);                                     // ENTER SYS
for (let h = 0; !row().startsWith('MATRIX') && h < 12; h++) ev(EVT.BTN1);
check(`MATRIX item is clean kHz, no bad glyphs ("${row()}")`, row() === 'MATRIX 20');
ev(EVT.S1); ev(EVT.REL);                                     // EDIT
check(`MATRIX editor shows kHz ("${row()}")`, layer() === L3 && val() === 20);
ev(EVT.BTN1);                                                // +1 step
check(`MATRIX +1 step -> 21 kHz ("${row()}")`, val() === 21);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
