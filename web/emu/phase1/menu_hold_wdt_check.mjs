// menu_hold_wdt_check.mjs — the two settings that had no menu row: DIAG > F HOLD (freq_hold) and
// SYS > WATCHDOG (watchdog). Both were config.txt only, so neither could be changed at the clock.
// For each: the row is in its section and shows the live state, a tap in the editor switches the
// setting at once, leaving the editor saves it, the choice survives a reboot, and config.txt keeps
// its precedence (a line for the setting that is new or has changed beats the menu's choice, and
// deletes it; menu_perkey_check.mjs covers that rule in full). The watchdog has one more rule: ON arms it on the next main-loop pass, and nothing the menu
// does afterwards can stop it before the next reset.
// Run: node menu_hold_wdt_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const cfg   = w('emu_config_line', 'void', ['string']);
const ev    = w('emu_menu_event', 'void', ['number']);
const layer = w('emu_menu_layer', 'number');
const secOf = w('emu_menu_section', 'number');
const rowPtr= w('emu_daterow', 'number');
const eeReset = w('emu_ee_reset', 'void'), eeLoad = w('emu_ee_load', 'void'), eeCommit = w('emu_ee_commit', 'number'), eeApply = w('emu_ee_apply', 'void');
const ovrClear = w('emu_ovr_clear', 'void'), ovrValid = w('emu_ovr_valid', 'number');
const setMtime = w('emu_set_mtime', 'void', ['number', 'number']);
const cfgDef  = w('emu_cfg_defined', 'void', ['number', 'number']);
const freqHold = w('emu_freq_hold', 'number');
const wdtGet = w('emu_wdt_get', 'number', ['number']), wdtPoll = w('emu_wdt_poll'), wdtPowerOn = w('emu_wdt_power_on');
const reg = w('emu_register_file', 'void', ['string', 'number', 'number']), fileMtime = w('emu_file_mtime', 'void', ['number', 'number']), readConfig = w('emu_read_config');
// A host save of config.txt, through the firmware's real loader: new contents, a new modification time.
function hostSaves(lines, at) {
  const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
  const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
  reg('/CONFIG.TXT', ptr, bytes.length); fileMtime(at, at); readConfig();
}
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const L2 = 2, L3 = 3, SEC_DIAG = 3, SEC_SYS = 4;
const WDT_STARTS = 5, WDT_SETTING = 7;
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const ITEMS = [
  { name: 'F HOLD',   sec: SEC_DIAG, kid: 14, on: 'F HOLD ON',  off: 'F HOLD OFF', key: 'freq_hold', get: () => freqHold() },
  { name: 'WATCHDOG', sec: SEC_SYS,  kid: 15, on: 'WATCHDO ON', off: 'WATCHD OFF', key: 'watchdog',  get: () => wdtGet(WDT_SETTING) },
];

function backToL0() { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } }
function goto(it) {
  backToL0();
  ev(EVT.S1); ev(EVT.REL);                                     // L0 -> the section ring
  for (let g = 0; secOf() !== it.sec && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);                                     // ENTER -> the section's first row
  for (let h = 0; row() !== it.on && row() !== it.off && h < 20; h++) ev(EVT.BTN1);
}
const toggleAndSave = () => { ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); };   // EDIT, tap, DONE

for (const it of ITEMS) {
  const n = it.name;
  bootCold(1783627200); wdtPowerOn(); eeReset(); ovrClear();
  cfg(`${it.key} = off`);

  goto(it);
  check(`${n}: the row is in its section and reads "${it.off}" (got "${row()}")`, row() === it.off && secOf() === it.sec);

  ev(EVT.S1); ev(EVT.REL);
  check(`${n}: EDIT opens the editor`, layer() === L3);
  ev(EVT.BTN1);
  check(`${n}: a tap switches the setting on at once`, it.get() === 1);
  ev(EVT.S1); ev(EVT.REL);
  check(`${n}: leaving the editor returns to the row, now "${it.on}" (got "${row()}")`, layer() === L2 && row() === it.on);
  toggleAndSave();
  check(`${n}: the same again switches it off`, it.get() === 0 && row() === it.off);

  // An edit that is abandoned (the deep CANCEL stage) puts the setting back.
  ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1);
  const during = it.get();
  ev(0x96); ev(EVT.REL);                                       // stage 3 = CANCEL
  check(`${n}: CANCEL puts the setting back (during ${during}, after ${it.get()})`, during === 1 && it.get() === 0);

  // Saved across a reboot.
  eeReset(); setMtime(0x5AA5, 0x1234);
  goto(it); toggleAndSave();
  check(`${n}: switched on and saved`, it.get() === 1 && eeCommit() === 1);
  backToL0();
  cfg(`${it.key} = off`); ovrClear();                          // power lost: the live setting and the RAM copy go
  check(`${n}: after the power cut the RAM copy is empty`, ovrValid() === 0 && it.get() === 0);
  eeLoad(); cfgDef(0, 0); setMtime(0x9999, 0x9999); eeApply();  // config.txt does not mention the key
  check(`${n}: the saved choice comes back at boot`, ovrValid() === 1 && it.get() === 1);

  // config.txt keeps its precedence.
  cfg(`${it.key} = off`);
  cfgDef(1 << it.kid, 0); setMtime(0x1111, 0x2222); eeApply();
  check(`${n}: a config.txt that gains a line for the key wins`, it.get() === 0);
  cfgDef(1 << it.kid, 0); setMtime(0x5AA5, 0x1234); eeApply();
  check(`${n}: and the menu's choice is deleted, not kept`, it.get() === 0);

  // A record written before these rows existed has zeros where they now live: it must not switch
  // anything on, and must not claim to hold a choice.
  cfg(`${it.key} = off`); eeReset(); ovrClear(); setMtime(0x5AA5, 0x1234);
  backToL0(); ev(EVT.S1); ev(EVT.REL); ev(EVT.S1); ev(EVT.REL);  // some other row: DISP > BRIGHT
  ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);  // edit it, APPLY
  eeCommit(); backToL0();
  cfg(`${it.key} = on`); ovrClear(); eeLoad(); cfgDef(0, 0); eeApply();
  check(`${n}: a stored record that never touched this row leaves the setting alone`, it.get() === 1);

  // The same precedence through the real loader, so the parser's own marking of the key is covered.
  // Both keys are on by default, so the menu's choice here is OFF, to be told apart from the default.
  bootCold(1783627200); wdtPowerOn(); eeReset(); ovrClear();
  hostSaves(['MODE_ISO8601_STD = enabled'], 10);
  check(`${n}: real config.txt without the key: the setting starts on, its default`, it.get() === 1);
  goto(it); toggleAndSave(); eeCommit(); backToL0();
  check(`${n}: real config.txt without the key: the menu switches it off`, it.get() === 0);
  hostSaves(['MODE_ISO8601_STD = enabled', `${it.key} = on`], 11);
  check(`${n}: the host then saves "${it.key} = on": the file wins`, it.get() === 1);
  hostSaves(['MODE_ISO8601_STD = enabled'], 12);
  check(`${n}: the host removes the line again: back to on, the menu's off does not come back`, it.get() === 1);
}

// The watchdog's own rule.
bootCold(1783627200); wdtPowerOn(); eeReset(); ovrClear(); cfg('watchdog = off');
wdtPoll();
check('WATCHDOG: off, the main loop does not start it', wdtGet(WDT_STARTS) === 0);
goto(ITEMS[1]); ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1);         // in the editor, tapped ON
wdtPoll();
check('WATCHDOG: switched on in the menu, the next main-loop pass starts it', wdtGet(WDT_STARTS) === 1);
ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);                         // tapped back OFF, saved
wdtPoll(); wdtPoll();
check('WATCHDOG: switched off again, it stays armed and is not started twice', wdtGet(WDT_SETTING) === 0 && wdtGet(WDT_STARTS) === 1);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
