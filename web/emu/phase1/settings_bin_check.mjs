// settings_bin_check.mjs — validate web/js/settings-bin.js against SETTINGS.BIN bytes written by the
// REAL firmware (WASM, ee shim): the parser must pick the same winning record ee_scan would, decode
// every field the firmware packed, reject torn records the same way, and reproduce the
// menu_apply_overrides precedence verdicts. Run: node settings_bin_check.mjs   (from phase1/)
import factory from '../clock-fw.mjs';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// web/package.json is "type":"commonjs", so Node refuses ../../js/settings-bin.js as ESM (the
// browser doesn't care — it loads it via <script type=module> chains). Shadow-copy it to .mjs.
const _here = fileURLToPath(new URL('.', import.meta.url));
const _tmp = mkdtempSync(join(tmpdir(), 'sbin-'));
copyFileSync(join(_here, '../../js/settings-bin.js'), join(_tmp, 'settings-bin.mjs'));
const { parseSettingsBin, winningOverrides, fatStamp, crc16ccitt, EE_MAGIC, MODE_NAMES, menuToConfigLines } =
  await import(pathToFileURL(join(_tmp, 'settings-bin.mjs')).href);

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const ev = w('emu_menu_event', 'void', ['number']);
const eeReset = w('emu_ee_reset', 'void');
const eeCommit = w('emu_ee_commit', 'number');
const setMtime = w('emu_set_mtime', 'void', ['number', 'number']);
const setBright = w('emu_set_brightness', 'void', ['number']);
const eePeek = w('emu_ee_peek', 'number', ['number']);
const eePoke = w('emu_ee_poke', 'void', ['number', 'number']);
const modeId = w('emu_mode_id', 'number', ['string']);
const configLine = w('emu_config_line', 'void', ['string']);
const bright = w('emu_brightness', 'number');
const britReport = w('emu_brit_report', 'number');
const cuckooSetting = w('emu_cuckoo_setting', 'number');
const modeEnabled = w('emu_mode_enabled', 'number', ['number']);
const layer = w('emu_menu_layer', 'number');
const rowPtr = w('emu_daterow', 'number');

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC_DISP = 2;
const secOf = w('emu_menu_section', 'number');

const results = [];
const check = (n, pass) => { results.push({ n, pass: !!pass }); if (!pass) console.error('FAIL:', n); };

// Read the shim's whole 16 KiB SETTINGS.BIN image out through emu_ee_peek.
function snapshot() {
  const buf = new Uint8Array(16384);
  for (let i = 0; i < buf.length; i++) buf[i] = eePeek(i) & 0xff;
  return buf;
}

// Drive the menu FSM to bump BRIGHT by one step (+256) and SAVE — a real, firmware-recorded edit
// (same choreography as menu_persist_check.mjs).
function editBrightViaMenu() {
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);   // enter DISP → L2 (first item = BRIGHT)
  ev(EVT.S1); ev(EVT.REL);   // edit → L3
  ev(EVT.BTN1);              // +256
  ev(EVT.S1); ev(EVT.REL);   // save → L2
  ev(EVT.S2 ?? 0x95); // (unused fallthrough guard)
}

bootCold(1783627200);

// ---- (1) firmware writes a record; the JS parser decodes it byte-for-byte -----------------------
eeReset();
setMtime(0x5aa5, 0x1234);
setBright(0);
ev(EVT.S1); ev(EVT.REL);
for (let g = 0; secOf() !== SEC_DISP && g < 8; g++) ev(EVT.BTN1);
ev(EVT.S1); ev(EVT.REL); ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);
check('firmware commit succeeds', eeCommit() === 1);
let p = parseSettingsBin(snapshot());
check('parser finds the record', p.found === true);
check('generation = 1', p.gen === 1);
check('stamp fdate/ftime round-trip', p.stamp.fdate === 0x5aa5 && p.stamp.ftime === 0x1234);
check('BRIGHTNESS bit set in simple_mask', (p.simpleMask & (1 << 1)) !== 0);
check('brightness value = 256', p.fields.brightness === 256);
check('exactly 1 valid record', p.validRecords === 1);

// ---- (2) a second edit wins by generation ------------------------------------------------------
ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL);   // edit again: 256 → 512, save
check('second commit succeeds', eeCommit() === 1);
p = parseSettingsBin(snapshot());
check('two valid records now', p.validRecords === 2);
check('highest generation wins', p.gen === 2 && p.fields.brightness === 512);

// ---- (3) torn write → CRC reject → previous generation wins (ee_scan parity) --------------------
const img = snapshot();
// find the gen-2 record and corrupt one payload byte WITHOUT fixing the CRC (a torn write)
let tornOff = -1;
const dv = new DataView(img.buffer);
for (const base of [0x0000, 0x1000]) for (let s = 0; s < 64; s++) {
  const off = base + s * 64;
  if (dv.getUint32(off, true) === EE_MAGIC && dv.getUint32(off + 4, true) === 2) tornOff = off;
}
check('found the gen-2 record to tear', tornOff >= 0);
eePoke(tornOff + 24, img[tornOff + 24] & 0xfe & 0xff ^ 0x01);  // flip a brightness bit in the shim
p = parseSettingsBin(snapshot());
check('torn record rejected → gen-1 wins', p.found && p.gen === 1 && p.fields.brightness === 256);
eePoke(tornOff + 24, img[tornOff + 24]);                        // restore

// ---- (4) precedence verdicts mirror menu_apply_overrides ----------------------------------------
p = parseSettingsBin(snapshot());
const nameFor = (m) => MODE_NAMES.find((n) => modeId(n) === m) || null;
// (a) config.txt does NOT define brightness → override wins regardless of stamp
let v = winningOverrides(p, 'colon_mode = heartbeat\n', Date.now(), nameFor);
let e = v.entries.find((x) => x.id === 'brightness');
check('undefined-in-config → override wins', e && e.wins === true && v.stampOk === false);
// (b) config DOES define brightness + stamp mismatch (config re-saved) → config wins
v = winningOverrides(p, 'brightness = 0.85\n', Date.now(), nameFor);
e = v.entries.find((x) => x.id === 'brightness');
check('config-defined + stale stamp → config wins', e && e.wins === false);
// (c) config defines it AND mtime matches the stamp exactly → override still wins.
//     Build an ms-epoch whose LOCAL FAT encoding equals the stored stamp (0x5aa5/0x1234).
const fd = 0x5aa5, ft = 0x1234;
const when = new Date(1980 + ((fd >> 9) & 0x7f), ((fd >> 5) & 0xf) - 1, fd & 0x1f,
  (ft >> 11) & 0x1f, (ft >> 5) & 0x3f, (ft & 0x1f) * 2).getTime();
const st = fatStamp(when);
check('fatStamp round-trips the dirent encoding', st.fdate === fd && st.ftime === ft);
v = winningOverrides(p, 'brightness = 0.85\n', when, nameFor);
e = v.entries.find((x) => x.id === 'brightness');
check('config-defined + matching stamp → override wins', v.stampOk === true && e && e.wins === true);

// ---- (5) CRC self-test against a firmware-written record ----------------------------------------
const rec = snapshot().subarray(0, 64);
check('JS CRC16 matches the firmware CRC in record 0',
  crc16ccitt(rec, 62) === (rec[62] | (rec[63] << 8)));

// ---- (6) the rest of the store: CUCKOO (KID 12, byte 39), BRT MSG (KID 13, byte 48) and a mode
//      above ordinal 31 (ZONE2, whose bit lives in the u64 masks' high words at 40/44) --------------
const row = () => { const q = rowPtr(); let t = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[q + i]; if (c < 32 || c > 126) break; t += String.fromCharCode(c); } return t.trimEnd(); };
const toL0 = () => { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } };
const SEC = { CAL: 0, DISP: 2, SYS: 4 };
function setViaMenu(sec, prefix) {   // enter the section, find the row, EDIT, one step, DONE (recorded)
  toL0();
  ev(EVT.S1); ev(EVT.REL);
  for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
  ev(EVT.S1); ev(EVT.REL);
  for (let h = 0; !row().startsWith(prefix) && h < 16; h++) ev(EVT.BTN1);
  const found = row().startsWith(prefix);
  if (found) { ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); }
  toL0();
  return found;
}
eeReset();
setMtime(0x5aa5, 0x1234);
setBright(0);
configLine('MODE_ZONE2 = off');
toL0(); editBrightViaMenu(); toL0();                           // BRIGHT 0 -> 256 (the rail: bright)
check('menu has DISP > CUCKOO', setViaMenu(SEC.DISP, 'CUCKOO'));  // OFF -> TRUST
check('menu has SYS > BRT MSG', setViaMenu(SEC.SYS, 'BRT'));      // off -> on
check('menu has CAL > ZONE 2', setViaMenu(SEC.CAL, 'ZONE'));      // off -> on
check('commit succeeds', eeCommit() === 1);
p = parseSettingsBin(snapshot());
const zone2 = modeId('MODE_ZONE2');
check('CUCKOO: bit 12 set, byte 39 = TRUST', (p.simpleMask & (1 << 12)) !== 0 && p.fields.cuckoo === 1);
check('BRT MSG: bit 13 set, byte 48 = on', (p.simpleMask & (1 << 13)) !== 0 && p.fields.brit === 1);
check(`ZONE2 (ordinal ${zone2}) read from the high mask words`, zone2 >= 32 && ((p.modesMask >> BigInt(zone2)) & 1n) === 1n && ((p.modesVal >> BigInt(zone2)) & 1n) === 1n);
v = winningOverrides(p, 'brightness_report = off\n', Date.now(), nameFor);
const eb = v.entries.find((x) => x.id === 'brit'), ec = v.entries.find((x) => x.id === 'cuckoo');
check('verdict rows: DIMMER REPORT = ON, CUCKOO = TRUST', eb && eb.label === 'DIMMER REPORT' && /^ON/.test(eb.value) && ec && ec.value === 'TRUST');
check('config.txt that sets brightness_report, re-saved since → config wins', eb && eb.cfgHasIt === true && eb.wins === false);
const mz = v.modes.find((x) => x.ordinal === zone2);
check('ZONE2 verdict row names the mode', mz && mz.name === 'MODE_ZONE2' && mz.on === true);

// ---- (7) MERGE INTO config.txt round-trips through the firmware's own parser ---------------------
// Every transposed line, applied to a fresh boot with config.txt's parser, must leave the firmware
// exactly where the menu left it. BRIGHT is the sharp case: stored as the rail (256 = bright), while
// `brightness = N` is read inverted — so the line must carry 3839, not 256.
const kv = menuToConfigLines(p, winningOverrides(p, '', Date.now(), nameFor));
const kvb = kv.find(([k]) => k === 'brightness');
check('brightness transposes as 4095 - rail (3839)', kvb && kvb[1] === '3839');
bootCold(1783627200);
configLine('brightness = '); configLine('brightness_report = off'); configLine('cuckoo = off'); configLine('MODE_ZONE2 = off');
for (const [k, val] of kv) if (val != null) configLine(`${k} = ${val}`);
check('round trip: BRIGHT lands on the stored rail (256)', bright() === 256);
check('round trip: brightness_report on', britReport() === 1);
check('round trip: cuckoo = trust', cuckooSetting() === 1);
check('round trip: MODE_ZONE2 enabled', modeEnabled(zone2) === 1);

// ---- (8) a stored bit past the last mode ----------------------------------------------------------
// A build that numbered the modes differently can leave one (MODE_DARK sat at 34 on the July bench
// build). The firmware skips it (menu_apply_overrides loops m < NUM_DISPLAY_MODES), so the verdict must
// say so and MERGE must never write it as a config.txt line. Planted in the firmware's own record,
// stored as ENABLED (the stronger case), with a fresh CRC.
{
  const eeLoad = w('emu_ee_load'), eeApply = w('emu_ee_apply');
  const past = zone2 + 1;                                   // first ordinal past the last mode
  const buf = snapshot();
  let o = -1, g = -1;
  for (const base of [0, 0x1000]) for (let s = 0; s < 64; s++) {
    const d = new DataView(buf.buffer, base + s * 64, 64);
    if (d.getUint32(0, true) === EE_MAGIC && d.getUint32(4, true) > g) { g = d.getUint32(4, true); o = base + s * 64; }
  }
  const d = new DataView(buf.buffer, o, 64), hb = 1 << (past - 32);
  d.setUint32(40, d.getUint32(40, true) | hb, true); d.setUint32(44, d.getUint32(44, true) | hb, true);
  d.setUint16(62, crc16ccitt(buf.subarray(o, o + 62), 62), true);
  const p8 = parseSettingsBin(buf), v8 = winningOverrides(p8, '', Date.now(), nameFor);
  const r8 = v8.modes.find((x) => x.ordinal === past);
  check(`bit ${past} (past the last mode) decodes as unknown and never wins`, r8 && r8.known === false && r8.wins === false && r8.name === `MODE #${past}`);
  const kv8 = menuToConfigLines(p8, v8);
  check('MERGE leaves it out: every mode line is a real MODE_ key', kv8.length > 0 && kv8.every(([k]) => !/^mode/i.test(k) || k.startsWith('MODE_')));
  // ...and IGNORED is literally true: the firmware enables the same modes with and without the bit.
  const modesNow = () => { eeApply(); return Array.from({ length: past }, (_, m) => modeEnabled(m)).join(''); };
  eeLoad(); const without = modesNow();
  for (let i = 0; i < buf.length; i++) eePoke(i, buf[i]);
  eeLoad(); const withBit = modesNow();
  check('the firmware enables the same modes with the stray bit stored', withBit === without);
}

const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE'}`);
process.exit(pass === results.length ? 0 : 1);
