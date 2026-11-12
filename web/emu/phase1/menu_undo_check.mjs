// menu_undo_check.mjs — regression for a staggered both-button press leaving the wrong clock running.
// Reaching for the menu, one button can land first: the date board sends a single tap (nextMode
// fires) and then the SETUP chord. menu_fire_stage undoes the leaked tap — but it used to do it with
// a bare `displayMode = <previous mode>`, which left the leaked mode's machinery installed
// (countMode, the SysTick/PPS handlers, the colon). A leak into LST kept SIDEREAL time ticking on a
// civil ISO face, in the menu and after leaving it, until the next mode change. The undo now goes
// through nextMode. With the old code every "back to civil" case FAILS.
// Run: node menu_undo_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const boot = w('emu_boot', 'void', ['number']), tick = w('emu_tick'), poll = w('emu_poll'), pps = w('emu_pps'), pendsv = w('emu_pendsv');
const now = w('emu_now', 'number');
const en = w('emu_enable_mode', 'void', ['number']), setPos = w('emu_set_pos', 'void', ['number', 'number']);
const mode = w('emu_mode', 'number'), countMode = w('emu_count_mode', 'number');
const colon = w('emu_colon_mode', 'number'), colonCivil = w('emu_colon_civil', 'number');
const ev = w('emu_menu_event', 'void', ['number']), menuTick = w('emu_menu_tick', 'void', ['number']), layer = w('emu_menu_layer', 'number');
const bufb = w('emu_bufb', 'number', ['number']), bufcLo = w('emu_bufc_low', 'number', ['number']);
const MODE = { ISO: 0, LST: w('emu_MODE_LST', 'number')(), SOLAR: w('emu_MODE_SOLAR', 'number')() };
const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const COUNT_NORMAL = 0, COUNT_ALT = 3;

const LUT = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
const dec = (b) => { const p = b & 0x7f; if (p === 0) return '_'; if (p === 64) return '-'; const d = LUT.indexOf(p); return d < 0 ? '?' : d; };
const row = () => [0, 1, 2, 3, 4].map((i) => dec(bufb(i) >> 2)).join('') + dec(bufcLo(0));
const hms = (t) => new Date(t * 1000).toISOString().slice(11, 19).replace(/:/g, '');
// One real second: 1000 SysTicks with the main loop polling, then the PPS edge and the PendSV prep.
const sec = (n = 1) => { for (let s = 0; s < n; s++) { for (let i = 0; i < 1000; i++) { tick(); if (i % 50 === 0) poll(); } pps(); pendsv(); poll(); } };
// The row shows the second that began at the last PPS edge; emu_now() is already pre-incremented at .900.
const civilNow = () => row() === hms(now()) || row() === hms(now() - 1);

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

function scenario(name, leakMode, tapEvt) {
  boot(1718971200); setPos(51.48, 0); en(MODE.LST); en(MODE.SOLAR); sec(2);
  check(`${name}: starts on the civil ISO face (row ${row()})`, mode() === MODE.ISO && countMode() === COUNT_NORMAL && civilNow());

  ev(tapEvt); poll();                                  // one button lands first: a single tap leaks
  check(`${name}: the leaked tap entered the alternate mode`, mode() === leakMode && countMode() === COUNT_ALT);

  menuTick(300); ev(EVT.S1); ev(EVT.REL);              // then the chord: SETUP shown, released on it
  check(`${name}: the menu opened`, layer() === 1);
  check(`${name}: mode is back to ISO`, mode() === MODE.ISO);
  check(`${name}: time row machinery is back to civil (countMode ${countMode()})`, countMode() === COUNT_NORMAL);
  check(`${name}: the row shows civil time at once (row ${row()})`, civilNow());
  check(`${name}: the civil colon is back`, colon() === colonCivil());

  sec(3);
  check(`${name}: still civil 3 s later, inside the menu (row ${row()})`, countMode() === COUNT_NORMAL && civilNow());
  ev(EVT.S2); ev(EVT.REL); sec(3);                     // EXIT the menu
  check(`${name}: still civil after leaving the menu (row ${row()})`, layer() === 0 && mode() === MODE.ISO && countMode() === COUNT_NORMAL && civilNow());
}
scenario('leak forward into LST', MODE.LST, EVT.BTN1);
scenario('leak backward into SOLAR', MODE.SOLAR, EVT.BTN2);

// A tap that was NOT part of a chord must stand: after the 2.5 s window the SETUP chord keeps the mode.
boot(1718971200); setPos(51.48, 0); en(MODE.LST); sec(2);
ev(EVT.BTN1); poll(); menuTick(3000); ev(EVT.S1); ev(EVT.REL);
check(`a deliberate tap 3 s before the chord is kept (mode ${mode()})`, layer() === 1 && mode() === MODE.LST && countMode() === COUNT_ALT);

// The same leak into STANDBY. Standby turns the display off from the DAC callback once the rail has
// ramped down (about 0.6 s), and only nextMode's exit path turns it back on. The old bare-write undo
// put the mode back to ISO and left the display dark: a clock that is "showing" time on nothing.
{
  const dacStep = w('emu_dac_step'), displayOn = w('emu_display_on', 'number');
  const STANDBY = w('emu_mode_id', 'number', ['string'])('MODE_STANDBY');
  for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); }   // the case above ends inside the menu: leave it
  boot(1718971200); en(STANDBY); sec(2);
  check('standby leak: starts lit on the ISO face', mode() === MODE.ISO && displayOn() === 1);
  ev(EVT.BTN1); poll();                                // the leaked tap: ISO -> STANDBY
  for (let i = 0; i < 10; i++) dacStep();              // 1 s of 10 Hz DAC callbacks: the rail ramps down, displayOff() runs
  check('standby leak: the leaked tap put the clock in standby and the display went off', mode() === STANDBY && displayOn() === 0);
  menuTick(300); ev(EVT.S1); ev(EVT.REL);              // the chord lands: SETUP, released on it
  check('standby leak: the menu opened and the mode is back to ISO', layer() === 1 && mode() === MODE.ISO);
  check('standby leak: the display is back on', displayOn() === 1);
  for (let i = 0; i < 10; i++) dacStep();
  sec(2);
  check(`standby leak: still lit and civil 2 s later (row ${row()})`, displayOn() === 1 && countMode() === COUNT_NORMAL && civilNow());
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
