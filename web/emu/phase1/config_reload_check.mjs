// config_reload_check.mjs — config.txt is the source of truth on every load, not only the first.
// readConfigFile runs at boot and again whenever the host changes config.txt. It used to reset seven
// keys and parse the file, so every other key kept its last value when its line was deleted: take
// "cuckoo = trust" out, save, eject, and the cuckoo kept performing until the power was cycled.
// The rule now: a key the file set on the previous load and does not set on this one goes back to
// its power-on default; a value set since by the menu or over serial, for a key the file does not
// mention, survives.
// This runs the firmware's REAL loader against an in-memory /CONFIG.TXT, in a fresh emulator per
// scenario, and compares "the line was removed" with "the line was never there". It also reads the
// firmware source and requires every key the parser knows to be accounted for, so a key added
// later cannot be left out the way these were. With the old code the removal cases FAIL.
// Run: node config_reload_check.mjs
process.env.TZ = 'UTC';   // the emulator's mktime follows the host zone; the clock's is UTC (countdown_to)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const { default: factory } = await import('../clock-fw.mjs');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-6;

let stamp = 100;
async function clock() {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const reg = w('emu_register_file', 'void', ['string', 'number', 'number']);
  const mtime = w('emu_file_mtime', 'void', ['number', 'number']), readConfig = w('emu_read_config');
  w('emu_boot_cold', 'void', ['number'])(1718971200);
  const c = {
    M, w,
    peek: w('emu_cfg_peek', 'number', ['string']),
    serial: w('emu_config_line', 'void', ['string']),
    removeFile: () => { w('emu_file_remove', 'void', ['string'])('/CONFIG.TXT'); readConfig(); },
    load(text, at) {                                    // a host save: new contents, a new modification time
      const bytes = new TextEncoder().encode(text.join('\r\n') + '\r\n');
      const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
      reg('/CONFIG.TXT', ptr, bytes.length);
      const t = at ?? ++stamp; mtime(t, t); readConfig();
    },
  };
  return c;
}

const MINIMAL = ['# a config.txt that sets one thing', 'MODE_ISO8601_STD = enabled'];
// One line for every kind of key. [the line, the name emu_cfg_peek reads it back by]
const LINES = [
  ['MODE_UNIX = enabled', 'MODE:MODE_UNIX'], ['MODE_MOON = enabled', 'MODE:MODE_MOON'], ['MODE_ZONE2 = enabled', 'MODE:MODE_ZONE2'],
  ['MODE_FIRMWARE_CRC = enabled', 'MODE:MODE_FIRMWARE_CRC_T'],
  ['cuckoo = trust', 'cuckoo'], ['seg_balance = on', 'seg_balance'], ['colon_balance = on', 'colon_balance'],
  ['colon_full_at = 1500', 'colon_full_at'], ['colon_floor = 40', 'colon_floor'], ['page_ms = 2000', 'page_ms'],
  ['pps = on', 'pps'], ['nmea = rmc', 'nmea'], ['significance_fade = on', 'significance_fade'],
  ['tc_learn = on', 'tc_learn'], ['tc_apply = on', 'tc_apply'], ['tc_rtc = on', 'tc_rtc'], ['tc_persist = on', 'tc_persist'],
  ['freq_hold = on', 'freq_hold'], ['tc_t0 = 33', 'tc_t0'], ['tc_engage_s = 5', 'tc_engage_s'], ['tc_max_ppm = 50', 'tc_max_ppm'],
  ['tc_hse_b = 0.002', 'tc_hse_b'], ['tc_lse_a = 15.3', 'tc_lse_a'], ['tc_seed_lo = 26', 'tc_seed_lo'],
  ['star_max_mag = 2.5', 'star_max_mag'], ['loop_diag = on', 'loop_diag'], ['brightness_report = on', 'brightness_report'],
  ['watchdog = on', 'watchdog'], ['text = HELLO', 'text_len'], ['fake_longitude = -2.36', 'fake_longitude'],
  ['fake_latitude = 51.38', 'fake_latitude'], ['countdown_to = 2030-01-01T00:00:00Z', 'countdown_to'],
  ['zone2 = +05:30', 'zone2_set'], ['BS2 = 200,500', 'BS2_in'],
  // the seven that were always reset on a load: they must keep working
  ['brightness = 2000', 'brightness'], ['Tolerance_time_1ms = 500', 'tolerance_1ms'], ['colon_mode = heartbeat', 'colon_mode'],
];
const FULL = [...MINIMAL, ...LINES.map((l) => l[0])];
const NAMES = LINES.map((l) => l[1]);

// 0. Every key the parser knows is accounted for.
{
  // main.c and its sections (main_parts/*.h): the parser lives in one of them
  const dir = new URL('../firmware/mk4-time/Core/Src/', import.meta.url);
  const partsDir = new URL('main_parts/', dir);
  const src = [readFileSync(new URL('main.c', dir), 'utf8'),
    ...(existsSync(partsDir) ? readdirSync(partsDir).filter((f) => f.endsWith('.h')).sort().map((f) => readFileSync(new URL(f, partsDir), 'utf8')) : [])].join('\n');
  const body = src.slice(src.indexOf('void parseConfigString(char *key'), src.indexOf('void postConfigCleanup(void)'));
  const parser = [...body.matchAll(/strcasecmp\(key, "([^"]+)"\)/g)].map((m) => m[1]);
  const c = await clock();
  const rows = []; const n = c.w('emu_cfg_rows', 'number')(); const key = c.w('emu_cfg_row_key', 'string', ['number']);
  for (let i = 0; i < n; i++) rows.push(key(i));
  const SERIAL_ONLY = ['cuckoo_preview', 'tc_forget', 'tc_dump', 'adev_dump', 'hdev_dump', 'star_dump', 'wdt_dump', 'menu_dump', 'factory_reset', 'tc_reset'];
  const RESET_EVERY_LOAD = ['brightness', 'colon_mode', 'colon_alt_mode', 'Tolerance_time_1ms', 'Tolerance_time_10ms', 'Tolerance_time_100ms'];
  const NEXT_POWER_ON = ['MATRIX_FREQUENCY'];            // two boards, two defaults: see cfg_defaults
  const COMPILED_OUT = ['MODE_DDMMYYYY'];                // only with NONCOMPLIANT_DATE_MODES
  const known = new Set([...rows, ...SERIAL_ONLY, ...RESET_EVERY_LOAD, ...NEXT_POWER_ON, ...COMPILED_OUT]);
  const missing = parser.filter((k) => !known.has(k));
  const stray = rows.filter((k) => !parser.includes(k) && !/^BS[1-5]$/.test(k));
  const twice = rows.filter((k) => [...SERIAL_ONLY, ...RESET_EVERY_LOAD, ...NEXT_POWER_ON].includes(k));
  check(`the parser knows ${parser.length} keys and the defaults table has ${rows.length} rows`, parser.length > 80 && rows.length > 60);
  check(`every parser key is re-derived or listed as an exception${missing.length ? ` (unaccounted: ${missing.join(', ')})` : ''}`, missing.length === 0);
  check(`every table row is a key the parser knows${stray.length ? ` (stray: ${stray.join(', ')})` : ''}`, stray.length === 0);
  check(`no key is in two categories${twice.length ? ` (${twice.join(', ')})` : ''}`, twice.length === 0);
}

// 1. A removed line reads the same as a line that was never there.
{
  const never = await clock(); never.load(MINIMAL);
  const c = await clock(); c.load(FULL);
  const inert = NAMES.filter((n) => same(c.peek(n), never.peek(n)));
  check(`setup: all ${NAMES.length} lines took effect${inert.length ? ` (no effect: ${inert.join(', ')})` : ''}`, inert.length === 0);
  c.load(MINIMAL);                                       // the host saves a file without those lines
  const stuck = NAMES.filter((n) => !same(c.peek(n), never.peek(n)));
  check(`remove ${NAMES.length} lines: every one is back to its default${stuck.length ? ` (still set: ${stuck.join(', ')})` : ''}`, stuck.length === 0);
  c.load(FULL); c.load(FULL);
  const lost = NAMES.filter((n) => same(c.peek(n), never.peek(n)));
  check('put them back, and save twice: all set again', lost.length === 0);

  // one at a time: removing a line touches nothing else
  let bad = [];
  for (let i = 0; i < LINES.length; i++) {
    const one = await clock(); one.load(FULL);
    one.load(FULL.filter((l) => l !== LINES[i][0]));
    for (let j = 0; j < LINES.length; j++) {
      const want = j === i ? never.peek(NAMES[j]) : c.peek(NAMES[j]);
      if (!same(one.peek(NAMES[j]), want)) bad.push(`remove "${LINES[i][0]}": ${NAMES[j]}`);
    }
  }
  check(`remove each line on its own: only that key changes${bad.length ? ` (${bad.slice(0, 4).join('; ')})` : ''}`, bad.length === 0);
}

// 2. No file at all: everything a previous file set goes back.
{
  const never = await clock(); never.removeFile();       // boot with no config.txt
  const c = await clock(); c.load(FULL); c.removeFile();
  const stuck = NAMES.filter((n) => !same(c.peek(n), never.peek(n)));
  check(`delete config.txt: the clock is as if it never had one${stuck.length ? ` (still set: ${stuck.join(', ')})` : ''}`, stuck.length === 0);
}

// 3. What was set over serial, for a key the file does not mention, survives a reload.
{
  const c = await clock(); c.load(MINIMAL);
  c.serial('brightness_report = on'); c.serial('seg_balance = 150'); c.serial('pps = on');
  c.load([...MINIMAL, 'page_ms = 3000']);                // the host saves an unrelated change
  check('serial-set keys survive a reload that does not mention them', c.peek('brightness_report') === 1 && c.peek('seg_balance') === 150 && c.peek('pps') === 1);
}

// 4. A key the host sets over serial stops being the file's to take back; the file wins when it says so.
{
  const c = await clock(); c.load([...MINIMAL, 'seg_balance = on']);
  c.serial('seg_balance = 150');
  c.load(MINIMAL);
  check('file sets it, serial changes it, file drops the line: the serial value stays', c.peek('seg_balance') === 150);
  c.load([...MINIMAL, 'seg_balance = on']);
  check('the file sets it again: the file wins', c.peek('seg_balance') === 1);
  c.load(MINIMAL);
  check('... and now dropping the line reverts it', c.peek('seg_balance') === 0);
}

// 5. A menu setting survives the file dropping the same key.
{
  const c = await clock(); const MOON = c.w('emu_mode_id', 'number', ['string'])('MODE_MOON');
  c.load([...MINIMAL, 'MODE_MOON = enabled']);
  c.w('emu_record_mode', 'void', ['number', 'number'])(MOON, 1);   // the user also switched it on in the menu
  c.load(MINIMAL);
  check('set in the menu and in the file, file drops it: the menu setting holds', c.peek('MODE:MODE_MOON') === 1);
  const d = await clock(); d.load([...MINIMAL, 'MODE_MOON = enabled']); d.load(MINIMAL);
  check('set only in the file, file drops it: off', d.peek('MODE:MODE_MOON') === 0);
}

// 6. zone_override: dropping it (or blanking it) sends the clock back to the position lookup.
{
  const looked = (c) => c.w('emu_zone_looked_up', 'void', ['number', 'number'])(51.38, -2.36);
  const c = await clock(); c.load([...MINIMAL, 'zone_override = Europe/London']); looked(c);
  c.load([...MINIMAL, 'zone_override = Europe/London', 'page_ms = 3000']);
  check('zone_override still there: no new lookup is forced', c.peek('zone_lat') === 51.38 && c.peek('new_position') === 0);
  c.load([...MINIMAL, 'zone_override =']);               // blank means automatic
  check('zone_override blanked: the next pass looks the zone up from the position', c.peek('zone_lat') === 999 && c.peek('new_position') === 1);
  const d = await clock(); d.load([...MINIMAL, 'zone_override =']); looked(d); d.load([...MINIMAL, 'zone_override =', 'page_ms = 3000']);
  check('zone_override blank throughout: nothing is forced', d.peek('zone_lat') === 51.38 && d.peek('new_position') === 0);
}

// 7. An unchanged modification time means no load at all.
{
  const c = await clock(); c.load([...MINIMAL, 'page_ms = 2000'], 7000);
  c.load([...MINIMAL, 'page_ms = 9000'], 7000);
  check('same modification time: the file is not read again', c.peek('page_ms') === 2000);
}

// 8. The documented exception: MATRIX_FREQUENCY keeps its value until the next power-on.
{
  const c = await clock(); c.load([...MINIMAL, 'MATRIX_FREQUENCY = 30000']); c.load(MINIMAL);
  check('MATRIX_FREQUENCY removed: unchanged until power-on, as documented', c.peek('matrix') === 30000);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
