// config_template_check.mjs — one config.txt template, in three places, and it is true.
// The firmware ships a sample config.txt (firmware/qspi/config.txt, and a copy beside the release
// files in qspi/output). PCC has a template its Export writes and its defaults come from
// (js/default-config.js). They used to be two different texts. They are now one, and this fails if:
//   - the three copies differ by a byte;
//   - the firmware's parser knows a key the template has no line for, or the template has a line for
//     a key the parser does not know, or a key has two lines;
//   - loading the template sets anything a clock with no config.txt would not have, beyond the
//     choices a sample has to make (one mode on, the colon, the matrix rate, the page time);
//   - a switched-off line that states a default states the wrong one;
//   - PCC's Export of its own defaults is not the template (but for the text line it switches on);
//   - retemplate(), which lays any config.txt onto the template, loses or changes a setting.
// Run: node config_template_check.mjs
process.env.TZ = 'UTC';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { default: factory } = await import('../clock-fw.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'cfgtmpl-'));
writeFileSync(join(tmp, 'default-config.mjs'), readFileSync(new URL('../../js/default-config.js', import.meta.url)));
const { DEFAULT_CONFIG, configToState, stateToConfig, retemplate } = await import(pathToFileURL(join(tmp, 'default-config.mjs')).href);

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const sample = readFileSync(new URL('../firmware/qspi/config.txt', import.meta.url), 'utf8');
const shipped = readFileSync(new URL('../firmware/qspi/output/config.txt', import.meta.url), 'utf8');
check('the firmware\'s sample and the copy beside the release files are the same file', sample === shipped);
check('PCC\'s template is that file, byte for byte', DEFAULT_CONFIG === sample);
check('it is plain ASCII with LF line endings and ends with one newline', /^[\x0a\x20-\x7e]*$/.test(sample) && sample.endsWith('\n') && !sample.endsWith('\n\n'));

// ---- the keys ------------------------------------------------------------------------------------
const src = readFileSync(new URL('../firmware/mk4-time/Core/Src/main_parts/config.h', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('void parseConfigString'), src.indexOf('void postConfigCleanup'));
const parserKeys = [...body.matchAll(/strcasecmp\(key, *"([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
const SERIAL_ONLY = ['cuckoo_preview', 'tc_forget', 'tc_dump', 'adev_dump', 'hdev_dump', 'star_dump', 'wdt_dump', 'menu_dump', 'menu_export', 'factory_reset', 'tc_reset'];
const NOT_BUILT = ['MODE_DDMMYYYY'];                     // behind NONCOMPLIANT_DATE_MODES, which is not defined
const fileKeys = parserKeys.filter((k) => !SERIAL_ONLY.includes(k) && !NOT_BUILT.includes(k)).concat(['BS1', 'BS2', 'BS3', 'BS4', 'BS5']);
const lines = sample.split('\n');
const keyLines = lines.map((l) => /^(#?)\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => ({ off: m[1] === '#', key: m[2], value: m[3] }));
const lc = (a) => a.map((k) => k.toLowerCase());
const missing = fileKeys.filter((k) => !lc(keyLines.map((x) => x.key)).includes(k.toLowerCase()));
const stray = keyLines.filter((x) => !lc(fileKeys).includes(x.key.toLowerCase())).map((x) => x.key);
const twice = keyLines.map((x) => x.key.toLowerCase()).filter((k, i, a) => a.indexOf(k) !== i);
check(`the parser knows ${parserKeys.length} keys; every one a file can set has a line (${missing.join(', ') || 'none missing'})`, parserKeys.length > 80 && missing.length === 0);
check(`every line that looks like a setting is one (${stray.join(', ') || 'none stray'})`, stray.length === 0);
check(`no key has two lines (${twice.join(', ') || 'none'})`, twice.length === 0);
check('no serial-only command is in the file', !keyLines.some((x) => SERIAL_ONLY.includes(x.key.toLowerCase())));
check('modes are spelled enabled or disabled, switches on or off', keyLines.filter((x) => /^MODE_/i.test(x.key)).every((x) => /^(enabled|disabled)$/.test(x.value)) &&
  ['significance_fade', 'freq_hold', 'tc_learn', 'tc_apply', 'tc_rtc', 'tc_persist', 'seg_balance', 'colon_balance', 'pps', 'watchdog', 'config_write'].every((k) => /^(on|off)$/.test(keyLines.find((x) => x.key === k)?.value || '')));

// ---- through the firmware's own loader -------------------------------------------------------------
const PEEKS = ['pps', 'nmea', 'page_ms', 'text_len', 'fake_longitude', 'fake_latitude', 'countdown_to', 'brightness', 'tolerance_1ms', 'colon_mode', 'zone2_set', 'matrix',
  'BS2_in', 'BS2_out', 'seg_balance', 'colon_balance', 'colon_full_at', 'colon_floor', 'cuckoo', 'tc_learn', 'tc_apply', 'tc_rtc', 'significance_fade', 'tc_t0', 'tc_engage_s',
  'tc_max_ppm', 'tc_hse_b', 'tc_lse_a', 'tc_seed', 'tc_seed_lo', 'tc_persist', 'star_max_mag', 'brightness_report', 'watchdog', 'freq_hold', 'loop_diag', 'config_write']
  .concat(keyLines.filter((x) => /^MODE_/i.test(x.key)).map((x) => 'MODE:' + (x.key === 'MODE_FIRMWARE_CRC' ? 'MODE_FIRMWARE_CRC_T' : x.key)));
let stamp = 100;
async function load(text) {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  w('emu_boot_cold', 'void', ['number'])(1794473100);
  const bytes = new TextEncoder().encode(text);
  const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
  w('emu_register_file', 'void', ['string', 'number', 'number'])('/CONFIG.TXT', ptr, bytes.length);
  w('emu_file_mtime', 'void', ['number', 'number'])(++stamp, stamp); w('emu_read_config')();
  const peek = w('emu_cfg_peek', 'number', ['string']);
  return Object.fromEntries(PEEKS.map((k) => [k, peek(k)]));
}
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
const differ = (a, b) => PEEKS.filter((k) => !same(a[k], b[k])).map((k) => `${k} ${b[k]}->${a[k]}`);

const fromSample = await load(sample);
// (page_ms is stored as 0 until a file sets it, and 0 means the built-in 5500: the sample says 5500.)
const bare = await load('MATRIX_FREQUENCY = 20000\nMODE_ISO8601_STD = enabled\ncolon_mode = heartbeat\npage_ms = 5500\n');
let d = differ(fromSample, bare);
check(`loading the sample sets nothing beyond one mode, the colon, the matrix rate and the page time at its built-in value (${d.join(', ') || 'nothing'})`, d.length === 0 && fromSample['MODE:MODE_ISO8601_STD'] === 1);
const DEFAULTS_SHOWN = ['star_max_mag', 'tc_t0', 'tc_engage_s', 'tc_max_ppm', 'colon_full_at', 'colon_floor'];
const on = sample.split('\n').map((l) => { const m = /^#\s*([A-Za-z0-9_]+)(\s*=.*)$/.exec(l); return m && DEFAULTS_SHOWN.includes(m[1]) ? m[1] + m[2] : l; }).join('\n');
d = differ(await load(on), fromSample);
check(`the switched-off lines that state a default state the firmware's (${DEFAULTS_SHOWN.join(', ')}): switching them on changes nothing (${d.join(', ') || 'nothing'})`, on !== sample && d.length === 0);

// ---- PCC ----------------------------------------------------------------------------------------
const exported = stateToConfig(configToState(DEFAULT_CONFIG), DEFAULT_CONFIG).split('\n');
const changed = exported.map((l, i) => (l === lines[i] ? null : `${JSON.stringify(lines[i])} -> ${JSON.stringify(l)}`)).filter(Boolean);
check(`PCC's Export of its own defaults is the template, but for the text line it switches on (${changed.join('; ')})`, exported.length === lines.length && changed.length === 1 && /^"#text = HELLO" -> "text = HELLO"$/.test(changed[0]));
const self = retemplate(sample);
check('laying the template onto itself gives the template', self.text === sample && self.unknown.length === 0);

// A config.txt in the old style: capitals, 0 and 1 for modes, old key names, its own comments.
const old = ['; my clock', 'MATRIX_FREQUENCY = 20000', 'MODE_ISO8601_STD=Enabled', 'MODE_UNIX = Enabled', 'mode_tempcomp = 1', 'mode_satview = 0', 'MODE_SUNDIAL = enabled',
  'alt_colon_mode = toggle', 'colon_mode=heartbeat', '# cuckoo = off', 'cuckoo = trust', 'significance_fade = on', 'tc_learn = on', 'tc_apply = on', 'tc_persist = on',
  'tc_t0 = 40', 'tc_hse_b = 0.00669', 'tc_hse_c = -0.000235', 'tc_lse_a = 16.1638', 'tc_lse_b = -0.61215', 'tc_lse_c = -0.030912', 'tc_seed_lo = 24', 'tc_seed_hi = 32', 'tc_seed = on',
  'seg_balance = on', 'colon_balance = on', 'watchdog = on', 'pps = on', 'page_ms = 4000', 'zone2 = Etc/GMT+5', 'frobnicate = 7', ''].join('\n');
const laid = retemplate(old);
const L = laid.text.split('\n');
check('an old-style file: its settings land on the template\'s lines, switched on, modes respelled', L.includes('MODE_UNIX        = enabled') && L.includes('MODE_TEMPCOMP = enabled') && L.includes('tc_hse_b = 0.00669') && L.includes('zone2 = Etc/GMT+5') && L.includes('cuckoo = trust') && L.includes('page_ms = 4000'));
check('old key names land on the current keys', L.includes('MODE_SOLAR = enabled') && L.includes('colon_alt_mode = toggle') && !/MODE_SUNDIAL|alt_colon_mode/.test(laid.text));
check(`a key the template has no line for is kept at the end and reported (${laid.unknown.join(', ')})`, laid.unknown.join() === 'frobnicate' && L.includes('frobnicate = 7'));
check('everything the file did not set is the template\'s line, untouched', L.includes('MODE_MOON     = disabled') && L.includes('#brightness = 0.5') && L.includes('config_write = off'));
// The proof that nothing was lost or changed: the firmware, loading each, ends in the same state.
// (The old names are spelled the current way in the original first: this firmware does not read them.)
d = differ(await load(laid.text), await load(old.replace('MODE_SUNDIAL', 'MODE_SOLAR').replace('alt_colon_mode', 'colon_alt_mode')));
check(`the firmware reads the old file and the laid-out one to the same settings (${d.join(', ') || 'no difference'})`, d.length === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
