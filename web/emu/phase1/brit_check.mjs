// brit_check.mjs — verify the $PMBRIT brightness sentence (brightness_report) in the REAL firmware
// (compiled to WASM). The operating point is driven through the firmware's own dimmer loop —
// generateDACbuffer(), the DAC half-buffer callback: sensor -> BS curve -> 0.5/0.5 smoothed rail —
// and the sentence is paced by the firmware's own main-loop poll, then read back through the app's
// own parser. Covers: off by default and after a reboot; framing + checksum; AUTO on the baked
// VTT9812FH curve and its settling; manual override; standby; the balance values that follow the
// rail; 1 Hz pacing; the retry on a BUSY endpoint; the silent drop with no USB host; and the
// SYS > BRT MSG menu row — beside PPS MSG, stored like it, with config.txt keeping precedence.
// Run: node brit_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';
import { parsePMBRIT } from '../../js/pmext.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const E = {
  bootCold: w('emu_boot_cold', 'void', ['number']),
  tick: w('emu_tick'), poll: w('emu_poll'),
  pendsv: w('emu_pendsv'), pendsvPending: w('emu_pendsv_pending', 'number'),
  configLine: w('emu_config_line', 'void', ['string']),
  configDone: w('emu_config_done'),
  setPos: w('emu_set_pos', 'void', ['number', 'number']),
  setAdc: w('emu_set_adc', 'void', ['number']),
  setVbus: w('emu_set_vbus', 'void', ['number']),
  setDac: w('emu_set_dac', 'void', ['number']),
  mode: w('emu_mode', 'number'),
  modeId: w('emu_mode_id', 'number', ['string']),
  renderMode: w('emu_render_mode', 'void', ['number']),
  britLine: w('emu_pmbrit_line', 'string'),
  cdcTake: w('emu_cdc_take', 'string'),
  cdcBusyNext: w('emu_cdc_busy_next', 'void', ['number']),
  usbHost: w('emu_usb_host', 'void', ['number']),
  dacStep: w('emu_dac_step'),
  dacTarget: w('emu_dac_target', 'number'),
  setColonScale: w('emu_set_colon_scale', 'void', ['number']),
  britReport: w('emu_brit_report', 'number'),
  menuEvent: w('emu_menu_event', 'void', ['number']),
  menuLayer: w('emu_menu_layer', 'number'), menuSection: w('emu_menu_section', 'number'),
  daterow: w('emu_daterow', 'number'),
  eeReset: w('emu_ee_reset'), eeCommit: w('emu_ee_commit', 'number'), eeLoad: w('emu_ee_load'),
  eeApply: w('emu_ee_apply'), ovrClear: w('emu_ovr_clear'),
  setMtime: w('emu_set_mtime', 'void', ['number', 'number']),
  cfgDefined: w('emu_cfg_defined', 'void', ['number', 'number']),
};

const results = [];
const check = (n, c, x = '') => results.push({ n, pass: !!c, x });

// The baked VTT9812FH curve, as the five "BSn = in,out" stops (out on the human scale: 0 dark,
// 4095 full). Evaluated here independently — the firmware stores out inverted and interpolates
// in that domain, searching segments exactly like this, extrapolating off the last one, and
// clamping to the rail — so the check asserts the loop LANDS on the documented curve.
const BS = [[0, 0], [131, 365], [1076, 1422], [2774, 2665], [3849, 4095]];
function railFor(adc) {                       // dac_target the loop converges to (0 = brightest)
  let i = 1;
  for (; i < BS.length - 1; i++) if (BS[i][0] > adc) break;
  const f = (adc - BS[i - 1][0]) / (BS[i][0] - BS[i - 1][0]);
  const out = (4095 - BS[i - 1][1]) * (1 - f) + (4095 - BS[i][1]) * f;
  return Math.min(4095, Math.max(0, out));
}
const human = (rail) => Math.trunc(4095 - rail + 0.5);   // the sentence's dac field

// seg_balance AUTO strength vs the stored rail: segbal_strength()'s 9-point LUT, integer maths.
const AUTO_DAC = [0, 512, 1024, 1536, 2048, 2560, 3072, 3584, 4095];
const AUTO_K = [10, 13, 17, 23, 30, 39, 52, 68, 90];
function autoK(rail) {
  const d = Math.trunc(rail);
  if (d <= AUTO_DAC[0]) return AUTO_K[0];
  for (let i = 1; i < 9; i++) if (d <= AUTO_DAC[i])
    return AUTO_K[i - 1] + Math.trunc(((AUTO_K[i] - AUTO_K[i - 1]) * (d - AUTO_DAC[i - 1])) / (AUTO_DAC[i] - AUTO_DAC[i - 1]));
  return AUTO_K[8];
}

const cks = (body) => { let c = 0; for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i); return c; };
const FRAME = /^\$(PMBRIT,\d+,\d+,[AMS],\d+,\d+)\*([0-9A-F]{2})\r\n$/;

// Run the firmware 1 ms at a time (SysTick, PendSV, main loop) and collect every $PMBRIT the
// main loop submits, stamped with the ms it went out on.
let now = 0;
function drive(ms) {
  const got = [];
  for (let i = 0; i < ms; i++) {
    E.tick(); now++;
    if (E.pendsvPending()) E.pendsv();
    E.poll();
    const s = E.cdcTake();
    if (s.startsWith('$PMBRIT')) got.push({ t: now, s });
  }
  return got;
}
const settle = (passes = 40) => { for (let i = 0; i < passes; i++) E.dacStep(); };   // ~4 s of 9.9 Hz passes
// An on-demand emit, then clear the capture, so the next drive() counts only what the poll paced.
const line = () => { const s = E.britLine(); E.cdcTake(); return s; };
const read = () => parsePMBRIT(line());

function boot() {
  E.bootCold(1783627200);
  E.configDone();
  E.setPos(51.4779, -0.0015);
  E.setVbus(1);
  E.usbHost(1);
  drive(1200);
}
boot();
if (!line().startsWith('$PMBRIT')) {
  console.log('SKIP — firmware has no $PMBRIT (brightness_report arrives with the segment-balance tier)');
  process.exit(0);
}

// 1. Off by default: a configured host, 3 s of main loop, nothing on the wire. And the dimmer boots
//    in AUTO, as readConfigFile leaves it when config.txt has no brightness line.
check('off by default: no $PMBRIT in 3 s', drive(3000).length === 0);
check('boot: the dimmer is in AUTO (src A)', read().src === 'A', JSON.stringify(read()));

// 2. Framing: the exact bytes, NMEA checksum, CRLF, and the app's parser takes it.
E.setAdc(400); settle();
{
  const s = line(), m = s.match(FRAME);
  check('framing: $PMBRIT,<adc>,<dac>,<src>,<segk>,<colon>*CC CRLF', !!m, JSON.stringify(s));
  check('checksum: XOR of the body', m && parseInt(m[2], 16) === cks(m[1]), m && `${m[2]} vs ${cks(m[1]).toString(16)}`);
  const want = `PMBRIT,400,${human(railFor(400))},A,0,256`;
  check(`exact line at ADC 400, stock balance: $${want}`, m && m[1] === want, m && m[1]);
  check('app parser (pmext parsePMBRIT) accepts it', !!parsePMBRIT(s));
}

// 3. AUTO through the firmware's own loop: settled output lands on the BS curve.
for (const adc of [0, 131, 400, 1076, 2000, 3800, 3849, 4095]) {
  E.setAdc(adc); settle();
  const b = read(), want = human(railFor(adc));
  check(`auto @ ADC ${adc} → dac ${want} (src A, adc echoed)`, b && b.src === 'A' && b.adc === adc && b.dac === want, JSON.stringify(b));
}
check('auto: ADC 400 → 666 and ADC 3800 → 4030 (the spot values the docs quote)',
  (E.setAdc(400), settle(), read().dac === 666) && (E.setAdc(3800), settle(), read().dac === 4030));

// 4. Settling: each pass halves the error (the 0.5/0.5 IIR). The DAC half-buffer callback runs at
//    9.9 Hz (TIM6 at 80 MHz / 8001 / 101, 10 samples a half), so even a dark-to-bright step of
//    ~3400 lands within 1 in 12 passes, ~1.2 s.
{
  E.setAdc(400); settle();
  const from = E.dacTarget(), target = railFor(3800);
  E.setAdc(3800); E.dacStep();
  const one = E.dacTarget();
  check('settling: one pass moves the rail exactly halfway', Math.abs(one - (from + target) / 2) < 0.01, `${from.toFixed(2)} → ${one.toFixed(2)} (target ${target.toFixed(2)})`);
  for (let i = 1; i < 12; i++) E.dacStep();
  const b = read();
  check('settling: a dark-to-bright step is within 1 of the curve after 12 passes (~1.2 s)', Math.abs(b.dac - human(target)) <= 1, `dac ${b.dac} vs ${human(target)}`);
}

// 5. Manual override (the brightness key): src M, the override's value, the sensor still reported.
{
  E.setAdc(1234);
  E.configLine('brightness = 0.5'); E.dacStep();
  const b = read();
  check('manual: brightness = 0.5 → src M, dac 2048', b && b.src === 'M' && b.dac === 2048, JSON.stringify(b));
  check('manual: the sensor is still reported (adc 1234)', b && b.adc === 1234, JSON.stringify(b));
  E.configLine('brightness = 4095'); E.dacStep();
  check('manual: brightness = 4095 → dac 4095 (full)', read().dac === 4095, JSON.stringify(read()));
  E.configLine('brightness = '); settle();
  const a = read();
  check('manual cleared: brightness = (empty) → back to src A on the curve', a.src === 'A' && a.dac === human(railFor(1234)), JSON.stringify(a));
}

// 6. The balance values that follow the rail.
{
  E.setAdc(400); settle();
  E.configLine('seg_balance = on');
  let b = read();
  check(`segk: seg_balance = on → the AUTO strength for this rail (${autoK(E.dacTarget())})`, b.segk === autoK(E.dacTarget()) && b.segk > 0, JSON.stringify(b));
  E.setAdc(3800); settle();
  b = read();
  check(`segk: follows the rail — bright room → ${autoK(E.dacTarget())}`, b.segk === autoK(E.dacTarget()), JSON.stringify(b));
  E.configLine('seg_balance = 150');
  check('segk: a manual seg_balance = 150 reads 150', read().segk === 150);
  E.configLine('seg_balance = off');
  check('segk: seg_balance = off reads 0', read().segk === 0);
  check('colon: stock (colon_balance off) reads 256', read().colon === 256);
  E.setColonScale(83);
  check('colon: reports the APPLIED scale (83 of 256)', read().colon === 83);
  E.setColonScale(256);
}

// 7. 1 Hz pacing through the real main-loop poll.
E.setAdc(400); settle();
E.configLine('brightness_report = on');
let got = drive(1000);
check('enable: first line within 1 s', got.length === 1, `${got.length}`);
{
  const t0 = got[0].t;
  got = drive(6000);
  const soon = got.filter((g) => g.t - t0 <= 4999);
  check('pacing: exactly 4 more in the 4999 ms after the first', soon.length === 4, `${soon.length}`);
  check('pacing: 1000 ms apart', got.every((g, i) => g.t - (i ? got[i - 1].t : t0) === 1000), got.map((g) => g.t - t0).join(','));
  check('pacing: every paced line parses', got.every((g) => !!parsePMBRIT(g.s)));
}

// 8. A BUSY endpoint is retried the next ms without restarting the window; anything else drops.
{
  const last = drive(1000).at(-1).t;
  E.cdcBusyNext(3);
  const g = drive(2000);
  check('BUSY: the due line lands after 3 BUSY retries (1003 ms)', g.length === 2 && g[0].t - last === 1003, g.map((x) => x.t - last).join(','));
  check('BUSY: the next line is paced from the one that went out', g.length === 2 && g[1].t - g[0].t === 1000, g.map((x) => x.t - last).join(','));
}

// 9. No USB host: nothing is submitted; reconnecting resumes within a second.
E.usbHost(0);
check('no host: nothing submitted in 3 s', drive(3000).length === 0);
E.usbHost(1);
got = drive(1000);
check('host back: resumes within 1 s', got.length === 1, `${got.length}`);

// 10. Standby: src S, the rail ramps to off, and the balance values read 0.
{
  E.configLine('seg_balance = on');
  E.renderMode(E.modeId('MODE_STANDBY'));
  E.dacStep();
  const ramp = read();
  check('standby: src S while the rail ramps down', ramp.src === 'S' && ramp.dac > 0 && ramp.dac < human(railFor(400)), JSON.stringify(ramp));
  for (let i = 0; i < 10; i++) E.dacStep();
  const s = read();
  check('standby: display off → dac 0, segk 0, colon 0', s.src === 'S' && s.dac === 0 && s.segk === 0 && s.colon === 0, JSON.stringify(s));
  check('standby: the sensor is still reported', s.adc === 400, JSON.stringify(s));
  const d = drive(1000);
  check('standby: still paced at 1 Hz', d.length === 1 && d[0].s === line(), JSON.stringify(d.map((x) => x.s)));
  E.renderMode(E.modeId('MODE_ISO8601_STD'));
  E.configLine('seg_balance = off');
}

// 11. Off again, and a reboot restores the power-on default.
E.configLine('brightness_report = off');
check('brightness_report = off: silent', drive(3000).length === 0);
E.configLine('brightness_report = 1');
check('brightness_report = 1 is truthy', drive(1000).length === 1);
boot();
check('reboot: back off (the switch is power-on state, not persisted)', drive(3000).length === 0);

// 12. SYS > BRT MSG: the on-device row for the same switch. It sits right after PPS MSG, renders its
//     state whole (the label trims, as PPS MSG's does), is recorded in the menu store as KID 13, is
//     restored at boot, and yields to a config.txt that sets brightness_report — the usual rule.
{
  const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
  const SEC_SYS = 4, KID_BRIT = 13;
  const row = () => { const p = E.daterow(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };
  const ev = (e) => E.menuEvent(e);
  const toL0 = () => { for (let i = 0; i < 6 && E.menuLayer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } };
  const toSys = () => { ev(EVT.S1); ev(EVT.REL); for (let g = 0; E.menuSection() !== SEC_SYS && g < 8; g++) ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); };
  const seek = (prefix) => { for (let h = 0; !row().startsWith(prefix) && h < 14; h++) ev(EVT.BTN1); return row().startsWith(prefix); };
  boot();
  toSys();
  if (!seek('BRT')) {
    console.log('SKIP  SYS > BRT MSG — this firmware has no BRT MSG row (it arrives with the menu tier)');
  } else {
    const off = row();
    ev(EVT.BTN2);
    const before = row();
    ev(EVT.BTN1);
    check('menu: BRT MSG is the SYS row right after PPS MSG', before.startsWith('PPS MS') && row() === off, `${before} -> ${off}`);
    check('menu: the row reads "BRT MS OFF" (label trims so the state stays whole, like PPS MSG)', off === 'BRT MS OFF', off);
    E.eeReset(); E.setMtime(0x5AA5, 0x1234); E.cfgDefined(0, 0);
    ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);   // EDIT, toggle ON, DONE (recorded)
    check('menu: toggled on, the row reads "BRT MSG ON"', row() === 'BRT MSG ON', row());
    check('menu: BRT MSG drives the same switch as brightness_report', E.britReport() === 1);
    toL0();
    const g = drive(1500);
    check('menu: the switch it set paces $PMBRIT at 1 Hz', g.length === 1 || g.length === 2, `${g.length}`);
    check('menu: the edit is committed to the store', E.eeCommit() === 1);
    boot();   // power-on: the switch is .data again, off
    check('menu: power-on starts with the switch off', E.britReport() === 0);
    E.eeLoad(); E.eeApply();
    check('menu: the stored BRT MSG is restored at boot', E.britReport() === 1);
    boot(); E.eeLoad();
    E.cfgDefined(1 << KID_BRIT, 0); E.setMtime(0x1111, 0x2222); E.eeApply();
    check('menu: a config.txt that sets brightness_report, saved after the edit, wins', E.britReport() === 0);
    boot(); E.eeLoad();
    E.cfgDefined(1 << KID_BRIT, 0); E.setMtime(0x5AA5, 0x1234); E.eeApply();
    check('menu: the same config.txt, unchanged since the edit, lets the menu win', E.britReport() === 1);
    E.cfgDefined(0, 0); E.eeReset();
  }
}

let all = true;
for (const r of results) { if (!r.pass) all = false; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.x ? '  [' + r.x + ']' : ''}`); }
console.log(all ? '\nALL PASS' : '\nSOME FAILED');
process.exit(all ? 0 : 1);
