// defaults_check.mjs — everything this firmware adds is off until asked for.
// A clock with no config.txt, or with one that does not mention a key, behaves as stock for that key.
// For each switch: off at power-on with no config.txt and with a config.txt that does not mention
// it; `key = on` switches it on; and removing that line puts it back off. The new display modes stay
// off too. Runs the firmware's REAL loader against an in-memory /CONFIG.TXT, in a fresh emulator per
// key. Run: node defaults_check.mjs
process.env.TZ = 'UTC';
const { default: factory } = await import('../clock-fw.mjs');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

let stamp = 100;
async function clock() {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const reg = w('emu_register_file', 'void', ['string', 'number', 'number']);
  const mtime = w('emu_file_mtime', 'void', ['number', 'number']), readConfig = w('emu_read_config');
  w('emu_boot_cold', 'void', ['number'])(1718971200);
  return {
    peek: w('emu_cfg_peek', 'number', ['string']),
    load(lines) {                                       // a host save: new contents, a new modification time
      const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
      const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
      reg('/CONFIG.TXT', ptr, bytes.length);
      mtime(++stamp, stamp); readConfig();
    },
  };
}

const BASE = ['# a config.txt that does not mention the key', 'MODE_ISO8601_STD = enabled'];
const SWITCHES = ['significance_fade', 'freq_hold', 'tc_learn', 'tc_apply', 'tc_persist', 'tc_rtc', 'seg_balance', 'colon_balance', 'pps',
  'watchdog', 'config_write', 'zone_gate', 'ms_align', 'brightness_report', 'loop_diag'];
const OFF = [...SWITCHES, 'cuckoo'];

for (const key of SWITCHES) {
  const c = await clock();
  check(`${key}: off at power-on, before any config.txt`, c.peek(key) === 0);
  c.load(BASE);
  check(`${key}: off with a config.txt that does not mention it`, c.peek(key) === 0);
  c.load([...BASE, `${key} = on`]);
  check(`${key}: "${key} = on" switches it on`, c.peek(key) === 1);
  c.load(BASE);
  check(`${key}: removing that line puts it back off`, c.peek(key) === 0);
}

{
  const c = await clock();
  c.load(BASE);
  const on = OFF.filter((k) => c.peek(k) !== 0);
  check(`all off together: ${OFF.join(', ')}${on.length ? ` (on: ${on.join(', ')})` : ''}`, on.length === 0);
  const modes = ['MODE_SUN', 'MODE_MOON', 'MODE_LST', 'MODE_SOLAR', 'MODE_ZONE2', 'MODE_STAR', 'MODE_ADEV', 'MODE_TEMPCOMP', 'MODE_DARK'];
  const lit = modes.filter((m) => c.peek(`MODE:${m}`) !== 0);
  check(`the new display modes stay off${lit.length ? ` (on: ${lit.join(', ')})` : ''}`, lit.length === 0);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
