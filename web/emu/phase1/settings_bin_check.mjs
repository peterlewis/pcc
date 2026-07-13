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
const { parseSettingsBin, winningOverrides, fatStamp, crc16ccitt, EE_MAGIC } =
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

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94 };
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
const nameFor = (m) => {
  for (const n of ['MODE_ISO8601_STD','MODE_ISO_ORDINAL','MODE_ISO_WEEK','MODE_UNIX','MODE_JULIAN_DATE','MODE_MODIFIED_JD','MODE_SHOW_OFFSET','MODE_SHOW_TZ_NAME','MODE_WEEKDAY','MODE_WEEKDA_DD','MODE_WDY_MM_DD','MODE_STANDBY','MODE_COUNTDOWN','MODE_SATVIEW','MODE_TEXT','MODE_VBAT','MODE_DISPLAYTEST','MODE_TTFF','MODE_SUN','MODE_SUN_AZEL','MODE_MOON','MODE_GRID','MODE_LATLON','MODE_TEMPCOMP','MODE_LST','MODE_SOLAR','MODE_ADEV','MODE_STAR'])
    if (modeId(n) === m) return n;
  return null;
};
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

const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE'}`);
process.exit(pass === results.length ? 0 : 1);
