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
check(`L1 stage 3 shows "${row()}"`, row() === 'CLOCK');   // deep hold = bail to clock
ev(EVT.S2);
check(`L1 stage 2 shows "${row()}"`, row() === 'EXIT');
ev(EVT.S1);
check(`L1 stage 1 shows "${row()}"`, row() === 'ENTER');

// (5) ENTER DISP -> L2 item ring, landing directly on the first item (no section banner).
ev(EVT.REL);
check(`ENTER -> L2 on the first item "${row()}"`, layer() === L2 && row().startsWith('BRIGHT') && midx() === 0);

// (6) item scroll stays WITHIN the section (BRIGHT -> BALANCE -> COLON -> COLONALT, then back).
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('BALANC'));   // full OFF trims 7-char labels by one
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('COLON') && !row().startsWith('COLONA'));
ev(EVT.BTN1);
check(`item fwd -> "${row()}"`, row().startsWith('ACOLON'));   // renamed so the value fits at L2
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

// (8) CANCEL restores + returns to L2 on BRIGHT. CANCEL is the DEEP stage now, buffered one past
// APPLY so an overshot commit can't silently discard the edit; stage 2 is the harmless "----".
ev(EVT.S2);
check(`L3 stage 2 is the "----" buffer ("${row()}")`, row() === '----');
ev(EVT.S3);
check(`L3 stage 3 shows "${row()}"`, row() === 'CANCEL');
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
      ev(EVT.S1); ev(EVT.REL);                                 // EDIT -> editor
      ev(EVT.BTN1);                                            // tap toggles it OFF...
      if (row().includes('LASt')) { lastSeen = true; if (modecount() < 1) guarded = false; }  // ...unless it's the last mode -> LASt guard refuses it
      ev(EVT.S1); ev(EVT.REL);                                 // DONE -> L2 (saved)
    }                                                          // non-toggles (numbers/enums) are left alone
    if (layer() === L2) ev(EVT.BTN1);                          // next item in this section
  }
}
check(`LASt guard fired and kept >=1 mode (count=${modecount()})`, lastSeen && guarded && modecount() >= 1);

// ---- review-fix regressions (2026-07 Fable review) ----
const mode  = w('emu_mode', 'number');
const dirty = w('emu_menu_dirty', 'number');
function toL0() { for (let i = 0; i < 6 && layer() !== L0; i++) { ev(layer() === L3 ? EVT.S3 : EVT.S2); ev(EVT.REL); } }
toL0();

// (14) releasing an L0 chord on an unlabeled stage restores the clock row (was: stuck on "----").
ev(EVT.S1); ev(EVT.S2);
check(`L0 stage 2 is unlabeled ("${row()}")`, row() === '----');
ev(EVT.REL);
check(`release on "----" restores the clock (layer ${layer()}, row "${row()}")`, layer() === L0 && row() !== '----');

// (15) REBOOT arms only on the SECOND stage cycle: first-cycle stage 3 is unlabeled and safe.
ev(EVT.S1); ev(EVT.S2); ev(EVT.S3);
check(`L0 first-cycle stage 3 does NOT offer REBOOT ("${row()}")`, row() === '----');
ev(EVT.REL);
check(`first-cycle deep release is safe -> clock`, layer() === L0);
ev(EVT.S1); ev(EVT.S2); ev(EVT.S3); ev(EVT.S1); ev(EVT.S2); ev(EVT.S3);   // hold through a full cycle
check(`second-cycle stage 3 arms REBOOT ("${row()}")`, row() === 'REBOOT');
ev(EVT.S1); ev(EVT.REL);                                                   // roll on to SETUP and take it (never release on REBOOT in a test)
check(`rolling past REBOOT back to SETUP still enters the menu`, layer() === L1);
toL0();

// (16) a staggered both-press that leaked a single tap (mode changed) is undone when SETUP fires.
// (the LASt walker above left only ONE mode enabled — enable a second so nextMode has somewhere to go)
ev(EVT.S1); ev(EVT.REL);
for (let g = 0; section() !== SEC.CAL && g < 8; g++) ev(EVT.BTN1);
ev(EVT.S1); ev(EVT.REL);
for (let h = 0; !row().endsWith('OFF') && h < 14; h++) ev(EVT.BTN1);   // first disabled CAL mode
ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);       // EDIT, tap ON, DONE
toL0();
const m0 = mode();
ev(EVT.BTN1);                                   // the leaked half of the chord: nextMode fires
check(`leaked single tap changed the mode`, mode() !== m0);
ev(EVT.S1); ev(EVT.REL);                        // ...then the chord completes as SETUP
check(`SETUP undoes the leaked mode change (mode ${mode()} == ${m0})`, layer() === L1 && mode() === m0);
toL0();

// (17) toggle editor: deep stage 3 = CANCEL (the shallow stages say DONE and save; CANCEL must not).
ev(EVT.S1); ev(EVT.REL);                         // SETUP
for (let g = 0; section() !== SEC.DISP && g < 8; g++) ev(EVT.BTN1);
ev(EVT.S1); ev(EVT.REL);                         // ENTER DISP
for (let h = 0; !row().startsWith('SIG FA') && h < 12; h++) ev(EVT.BTN1);
const sigRow0 = row();
ev(EVT.S1); ev(EVT.REL);                         // EDIT
ev(EVT.BTN1);                                    // tap: toggled live
ev(EVT.S3);
check(`toggle stage 3 is labeled CANCEL ("${row()}")`, row() === 'CANCEL');
ev(EVT.REL);
check(`toggle CANCEL reverts (row "${row()}")`, layer() === L2 && row() === sigRow0);

// (18) a no-op editor visit (enter, no change, DONE) records nothing — no spurious flash override.
const dirty0 = dirty();
ev(EVT.S1); ev(EVT.REL); ev(EVT.S1); ev(EVT.REL);   // EDIT then immediately DONE, value untouched
check(`no-op toggle visit leaves nothing to commit (dirty ${dirty()})`, layer() === L2 && dirty() === dirty0);
toL0();

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
