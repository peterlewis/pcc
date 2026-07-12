// menu_check.mjs — the v2 SECTIONED on-device menu FSM, driven by injected date-board button bytes
// exactly as the USART2 ISR delivers them, asserting on the real DATE-row TX frame.
//
// Four layers: L0 clock -> L1 SECTION ring -> L2 ITEM ring (within a section) -> L3 value EDITor.
// Grammar: tap scrolls the current ring / steps a value; chord stage crossings (0x94/95/96) render a
// self-label (SETUP/ENTER/EXIT/EDIT/BACK/SAVE/CANCEL); release (0x93) fires the shown stage. Also:
// ENTER lands directly on the section's first item (no banner), live-preview, CANCEL restore, section
// resume across exit, 15 s idle, the LASt empty-ring guard, and stock-board dormancy.
// Run: node menu_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold  = w('emu_boot_cold', 'void', ['number']);
const ev        = w('emu_menu_event', 'void', ['number']);
const tick      = w('emu_menu_tick',  'void', ['number']);
const layer     = w('emu_menu_layer', 'number');
const midx      = w('emu_menu_idx',   'number');
const section   = w('emu_menu_section', 'number');
const modecount = w('emu_menu_modecount', 'number');
const rowPtr    = w('emu_daterow', 'number');
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95, S3: 0x96 };
const L0 = 0, L1 = 1, L2 = 2, L3 = 3;                        // CLOCK / SECTION / ITEM / EDIT
const SEC = { CAL: 0, ASTRO: 1, DISP: 2, DIAG: 3, SYS: 4 };
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

bootCold(1783627200);   // golden config enables a few CAL modes; astro/diag start disabled

// (1) dormancy: at L0 a tap just cycles the display; the menu never engages.
ev(EVT.BTN1);
check(`L0 tap stays at clock (row "${row()}")`, layer() === L0);

// (2) SETUP -> L1 SECTION ring; the section name IS the breadcrumb (first section = CAL).
ev(EVT.S1);
check(`chord S1 shows "${row()}"`, row() === 'SETUP');
ev(EVT.REL);
check(`release -> L1 section ring "${row()}"`, layer() === L1 && row() === 'CAL' && section() === SEC.CAL);

// (3) section scroll wraps through the five sections.
ev(EVT.BTN1);
check(`section fwd -> "${row()}"`, row() === 'ASTRO' && section() === SEC.ASTRO);
ev(EVT.BTN1);
check(`section fwd -> "${row()}"`, row() === 'DISP' && section() === SEC.DISP);
ev(EVT.BTN2);
check(`section back -> "${row()}"`, row() === 'ASTRO' && section() === SEC.ASTRO);
ev(EVT.BTN1);   // -> DISP

// (4) chord labels at L1: stage1 ENTER, stage2 EXIT, stage3 empty -> "----".
ev(EVT.S3);
check(`L1 empty stage 3 shows "${row()}"`, row() === '----');
ev(EVT.S2);
check(`L1 stage 2 shows "${row()}"`, row() === 'EXIT');
ev(EVT.S1);
check(`L1 stage 1 shows "${row()}"`, row() === 'ENTER');

// (5) ENTER DISP -> L2 item ring, landing directly on the first item (no section banner).
ev(EVT.REL);
check(`ENTER -> L2 on the first item "${row()}"`, layer() === L2 && row().startsWith('BRIGHT') && midx() === 0);

// (6) item scroll stays WITHIN the section (BRIGHT -> BALANCE -> COLON -> COLONALT, then back).
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('BALANCE'));
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('COLON') && !row().startsWith('COLONA'));
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('COLONALT'));
ev(EVT.BTN2); ev(EVT.BTN2); ev(EVT.BTN2);
check(`item back -> "${row()}"`, row().startsWith('BRIGHT') && midx() === 0);

// (7) EDIT BRIGHT -> L3, live-preview a step.
ev(EVT.S1);
check(`L2 stage 1 shows "${row()}"`, row() === 'EDIT');
ev(EVT.REL);
check(`EDIT -> L3 editor (value "${row()}")`, layer() === L3);
const before = row();
ev(EVT.BTN1);
const after = row();
check(`L3 step changes the live value ("${before}" -> "${after}")`, after !== before);

// (8) CANCEL restores + returns to L2 on BRIGHT.
ev(EVT.S2);
check(`L3 stage 2 shows "${row()}"`, row() === 'CANCEL');
ev(EVT.REL);
check(`CANCEL -> L2 on BRIGHT, restored "${row()}"`, layer() === L2 && row().startsWith('BRIGHT') && row().includes(before.trim()));

// (9) BACK -> L1 section ring (still DISP).
ev(EVT.S2);
check(`L2 stage 2 shows "${row()}"`, row() === 'BACK');
ev(EVT.REL);
check(`BACK -> L1 section ring "${row()}"`, layer() === L1 && row() === 'DISP');

// (10) EXIT -> L0 clock.
ev(EVT.S2); ev(EVT.REL);
check(`EXIT -> L0 clock (row "${row()}")`, layer() === L0);

// (11) resume: re-entry lands on the last section (DISP preserved across exit).
ev(EVT.S1); ev(EVT.REL);
check(`re-entry resumes last section "${row()}"`, layer() === L1 && row() === 'DISP' && section() === SEC.DISP);

// (12) 15 s idle from inside the menu auto-exits to the clock.
ev(EVT.S1); ev(EVT.REL);   // ENTER -> L2
tick(16000);
check(`idle 16 s -> L0 clock (row "${row()}")`, layer() === L0);

// (13) LASt empty-ring guard: walk the mode sections turning modes OFF; the last non-standby one is refused.
function toSectionRing() {                       // get to L1 from anywhere (bounded)
  for (let i = 0; i < 4 && layer() !== L1; i++) {
    if (layer() === L0) { ev(EVT.S1); ev(EVT.REL); }         // SETUP -> L1
    else { ev(EVT.S2); ev(EVT.REL); }                        // CANCEL/BACK climbs one level
  }
}
let lastSeen = false, guarded = true, safety = 0;
for (let s = 0; s < 5 && !lastSeen; s++) {
  toSectionRing();
  let g = 0; while (section() !== s && g++ < 8) ev(EVT.BTN1);  // scroll to section s
  ev(EVT.S1); ev(EVT.REL);                                     // ENTER -> L2, lands on the first item (no banner)
  if (layer() !== L2) continue;
  for (let pass = 0; pass < 15 && safety < 500 && !lastSeen; pass++) {
    safety++;
    if (row().trim().split(/\s+/).pop() === 'ON') {            // an enabled toggle (renders "LABEL ON")
      ev(EVT.S1); ev(EVT.REL);                                 // one-press EDIT toggles it OFF in place...
      if (row().includes('LASt')) { lastSeen = true; if (modecount() < 1) guarded = false; }  // ...unless it's the last mode -> LASt guard refuses it
    }                                                          // non-toggles (numbers/enums) are left alone (EDIT would open their editor)
    if (layer() === L2) ev(EVT.BTN1);                          // next item in this section
  }
}
check(`LASt guard fired and kept >=1 mode (count=${modecount()})`, lastSeen && guarded && modecount() >= 1);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
