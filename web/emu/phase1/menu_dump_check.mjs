// menu_dump_check.mjs — regression for the store diagnostic vanishing when it is needed.
// "menu_dump = on" over serial prints one line saying whether settings persist and, if not, why. The
// line was built in a 128-byte buffer, but the two RAM-ONLY explanations run to about 160 bytes; the
// overflow check then dropped the line without a word. So the dump worked on a healthy clock and
// printed NOTHING for a fragmented SETTINGS.BIN — the case it exists to explain.
// Every state must produce a line, and the line must fit the 192-byte CDC transmit buffer.
// With the old code the "fragmented" case FAILS. Run: node menu_dump_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const eeLoad = w('emu_ee_load'), attach = w('emu_settings_attach', 'void', ['number', 'number', 'number']);
const rdfault = w('emu_settings_rdfault', 'void', ['number']);
const sfState = w('emu_ee_sfile_state', 'number');
const dump = w('emu_menu_dump_line', 'string');
const CDC_TXBUF = 192;

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

function state(name, setup, expectState, mustSay) {
  bootCold(1718971200); rdfault(0);
  setup(); eeLoad();
  const line = dump();
  const ok = sfState() === expectState;
  check(`${name}: the scenario is the one intended (state ${sfState()})`, ok);
  check(`${name}: a line is printed (${line.length} bytes)`, line.length > 0 && line.endsWith('\r\n'));
  check(`${name}: it fits the ${CDC_TXBUF}-byte transmit buffer`, line.length > 0 && line.length <= CDC_TXBUF);
  check(`${name}: it says "${mustSay}"`, line.includes(mustSay));
}
state('healthy file',     () => attach(1, 0, 0xFF), 1, 'settings persist');
state('no file',          () => attach(0, 0, 0xFF), 0, 'no SETTINGS.BIN');
state('fragmented file',  () => attach(1, 1, 0xFF), 2, 'fragmented');
state('QSPI read fault',  () => { attach(1, 0, 0xFF); rdfault(1); }, 3, 'read fault');
rdfault(0); attach(1, 0, 0xFF); eeLoad();              // leave the module as a healthy clock

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
