// menu_colon_preview_check.mjs — §3.5 colon context-preview. Editing the COLONALT item selects the
// colon animation used by the sidereal/solar faces — but you're editing it from a civil face, so
// without a preview the choice is invisible (applyColonForMode renders the civil colon). §3.5 forces
// the value under the cursor onto the real colons while the editor is live, tracks it as you step, and
// restores the context colon on SAVE / CANCEL / idle-exit. Asserts the active colon animation
// (colonMode) follows the edited value and reverts cleanly. Run: node menu_colon_preview_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev    = w('emu_menu_event', 'void', ['number']);
const tick  = w('emu_menu_tick',  'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr= w('emu_daterow', 'number');
const colMode = w('emu_colon_mode', 'number');
const colPrev = w('emu_colon_preview', 'number');
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95, S3: 0x96 };
const L2 = 2, L3 = 3, SEC_DISP = 2, NOPREV = 0xFF;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

function backToL0() { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(layer() === 3 ? EVT.S3 : EVT.S2); ev(EVT.REL); } }
function gotoItem(prefix) {
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                     // ENTER DISP -> L2, lands on the first item
  for (let h = 0; !row().startsWith(prefix) && h < 12; h++) ev(EVT.BTN1);
}

bootCold(1783627200);

// A civil face is showing: no preview active, colonMode is the civil context colon.
const civilMode = colMode();
check(`boot: no colon preview active`, colPrev() === NOPREV);

// --- COLONALT: the value being edited must appear on the real colons even from a civil face ---
gotoItem('ACOLON');
check(`landed on ACOLON ("${row()}")`, row().startsWith('ACOLON'));
ev(EVT.S1); ev(EVT.REL);                                       // EDIT -> L3
check(`edit opens L3`, layer() === L3);
check(`preview armed on entry (prev=${colPrev()})`, colPrev() !== NOPREV);
check(`the ALT colon is previewed, not the civil one`, colMode() === colPrev() && colMode() !== civilMode);
const alt0 = colMode();
ev(EVT.BTN1);                                                  // step the enum
check(`stepping tracks the preview live`, colMode() === colPrev() && colMode() !== alt0);
ev(EVT.S3); ev(EVT.REL);                                       // CANCEL (deep stage)
check(`CANCEL clears the preview`, colPrev() === NOPREV);
check(`CANCEL restores the civil context colon`, colMode() === civilMode);
check(`CANCEL returns to L2`, layer() === L2);
backToL0();

// --- COLON (civil): editing previews the civil choice; COMMIT keeps the new value ---
gotoItem('COLON ');                                            // trailing space excludes "COLONALT"
check(`landed on COLON ("${row()}")`, row().startsWith('COLON') && !row().startsWith('COLONA') && !row().startsWith('ALT'));
ev(EVT.S1); ev(EVT.REL);                                       // EDIT
check(`preview armed for COLON`, colPrev() !== NOPREV);
ev(EVT.BTN1);                                                  // step to a new civil animation
const picked = colMode();
check(`COLON edit previews the picked value`, colMode() === colPrev());
ev(EVT.S1); ev(EVT.REL);                                       // SAVE
check(`COMMIT clears the preview`, colPrev() === NOPREV);
check(`COMMIT keeps the picked colon as the civil context colon`, colMode() === picked);
backToL0();

// --- idle-exit mid-edit must not leave a preview stuck ---
gotoItem('ACOLON');
ev(EVT.S1); ev(EVT.REL);                                       // EDIT (preview armed)
check(`preview armed before idle`, colPrev() !== NOPREV);
tick(60000);                                                  // exceed MENU_IDLE_MS -> menu_to_L0
ev(EVT.BTN1);                                                 // any poll runs the idle check
check(`idle-exit cleared the preview`, colPrev() === NOPREV);
check(`idle-exit back to the clock`, layer() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
