// menu_check.mjs — the on-device 2-button menu receiving FSM, driven by injected date-board button
// bytes exactly as the USART2 ISR delivers them, asserting on the real DATE-row TX frame.
//
// Grammar under test: tap moves (0x91/0x92), chord stage crossings (0x94/95/96) render a self-label,
// chord release (0x93) fires the shown stage. Layers L0 clock / L1 setup-ring / L2 value-editor.
// Also: live-preview edits, CANCEL restore, 15 s idle auto-exit, the LASt empty-ring guard, and the
// backward-compatible dormancy (a stock date board only sends 0x91/0x92/0x93).
// Run: node menu_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev     = w('emu_menu_event', 'void', ['number']);
const tick   = w('emu_menu_tick',  'void', ['number']);
const layer  = w('emu_menu_layer', 'number');
const midx   = w('emu_menu_idx',   'number');
const modecount = w('emu_menu_modecount', 'number');
const rowPtr = w('emu_daterow', 'number');
const setMode = w('emu_set_mode', 'void', ['number']);   // may not exist; see fallback
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95, S3: 0x96 };
const L0 = 0, L1 = 1, L2 = 2;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

bootCold(1783627200);
// enable a broad set of modes so the ring is populated and the LASt guard has room (config-driven at
// boot; we just need >1 enabled). Use the menu itself later; for now trust the golden boot config.

// (1) Backward-compat / dormancy: at L0 a tap just cycles the display; the menu never engages and the
//     date row is NOT menu chrome. (Stock date board: only 0x91/0x92/0x93 ever arrive.)
ev(EVT.BTN1);
check(`L0 tap stays at clock layer (row "${row()}")`, layer() === L0);

// (2) Enter the setup ring: chord stage 1 renders "SETUP"; releasing there enters L1 on the first item.
ev(EVT.S1);
check(`chord S1 shows "${row()}"`, row() === 'SETUP');
ev(EVT.REL);
check(`release at L0/stage1 -> L1 ring, first item "${row()}"`, layer() === L1 && row().startsWith('BRIGHT'));

// (3) Ring scroll: forward to COLON, back to BRIGHT.
ev(EVT.BTN1);
check(`L1 tap advances -> "${row()}"`, row().startsWith('COLON') && midx() === 1);
ev(EVT.BTN2);
check(`L1 back -> "${row()}"`, row().startsWith('BRIGHT') && midx() === 0);

// (4) Empty-stage hint: an unlabeled chord stage shows "----" (BACK is stage 2 at L1, stage 3 empty).
ev(EVT.S3);
check(`L1 empty stage 3 shows "${row()}"`, row() === '----');
ev(EVT.S1);   // re-arm to stage 1 (EDIT) without releasing on the empty one
check(`L1 stage 1 shows "${row()}"`, row() === 'EDIT');

// (5) Enter the editor on BRIGHT, live-preview a step, confirm the shown value changes.
ev(EVT.REL);
check(`release at L1/stage1 -> L2 editor (value "${row()}")`, layer() === L2);
const before = row();
ev(EVT.BTN1);
const after = row();
check(`L2 step changes the live value ("${before}" -> "${after}")`, after !== before);

// (6) CANCEL restores the pre-edit value and returns to L1.
ev(EVT.S2);
check(`L2 stage 2 shows "${row()}"`, row() === 'CANCEL');
ev(EVT.REL);
check(`CANCEL -> back at L1 on BRIGHT, restored "${row()}"`, layer() === L1 && row().startsWith('BRIGHT') && row().includes(before.trim()));

// (7) 15 s idle auto-exits to the live clock (date row is no longer menu chrome).
tick(16000);
check(`idle 16 s -> back to L0 clock (row "${row()}")`, layer() === L0 && !['SETUP','EDIT','CANCEL','BACK','----'].includes(row()));

// (8) LASt empty-ring guard: disable mode rows down the ring until only one remains; the last refusal
//     must show "LASt" and keep count>=1 (never lets the display ring go empty -> no nextMode spin).
//     Re-enter the ring, then walk mode toggle rows turning them OFF.
ev(EVT.S1); ev(EVT.REL);                 // -> L1
let lastSeen = false, guarded = true, safety = 0;
// walk the whole ring; for each mode-toggle row that reads ON, enter edit, toggle OFF, save.
for (let pass = 0; pass < 40 && safety < 400; pass++) {
  safety++;
  const label = row();
  // mode rows show "<NAME> ON/OFF" or just "<NAME>"; enter edit to see/flip
  ev(EVT.S1); ev(EVT.REL);               // enter editor
  if (layer() === L2) {
    const v = row();
    if (v === 'ON') {
      ev(EVT.BTN1);                      // toggle -> OFF (or refused)
      if (row() === 'LASt') { lastSeen = true; if (modecount() < 1) guarded = false; ev(EVT.S2); ev(EVT.REL); }
      else { ev(EVT.S1); ev(EVT.REL); }  // SAVE the OFF
    } else {
      ev(EVT.S2); ev(EVT.REL);           // not an ON toggle -> CANCEL back to L1
    }
  }
  if (layer() === L1) ev(EVT.BTN1);      // advance to next row
  if (lastSeen) break;
}
check(`LASt guard fired and kept >=1 mode enabled (count=${modecount()})`, lastSeen && guarded && modecount() >= 1);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
