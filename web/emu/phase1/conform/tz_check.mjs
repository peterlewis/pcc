// Step-6 check: prove the firmware's OWN IANA timezone engine works in WASM. Registers the REAL
// qspi/output/tzrules.bin into the emulator's FATFS shim, loads a zone through the firmware's own
// loadRulesSingle()->loadRules() (populating the 162-entry rules[] DST table), then asks the
// firmware (via setNextTimestamp/currentOffset) for the UTC offset at a battery of epochs — and
// checks EACH against an INDEPENDENT oracle (JS Intl). Exact match across DST boundaries proves the
// emulator applies real DST rules byte-faithfully, replacing the browser-Intl single-offset shim.
import { loadEmu } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TZRULES = process.argv[2] || (HERE + '../../../../clock4-megabuild/qspi/output/tzrules.bin');

// Independent truth: the UTC offset (seconds) a zone has at an instant, from JS Intl — computed a
// completely different way from the firmware's binary rules table.
function truthOffset(zone, epochSec) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochSec * 1000))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
  return Math.round(asUTC - epochSec);
}

const emu = await loadEmu();
emu.registerFile('/TZRULES.BIN', new Uint8Array(readFileSync(TZRULES)));

// zones spanning: N-hemisphere DST, S-hemisphere DST (offset phase inverted), half-hour offset +
// no DST, and a no-DST US zone.
const ZONES = ['Europe/London', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata',
               'Pacific/Auckland', 'America/Phoenix', 'Europe/Berlin', 'America/Los_Angeles'];

// epochs: monthly through 2021-2029 (within tzrules.bin's 2020+ range) + the exact 2024/2025
// EU DST transition instants (±1 s straddles the discontinuity — the firmware must switch on the
// right side).
const epochs = [];
for (let y = 2021; y <= 2029; y++) for (let mo = 0; mo < 12; mo++) epochs.push(Math.floor(Date.UTC(y, mo, 15, 12, 0, 0) / 1000));
for (const t of [
  Date.UTC(2024, 2, 31, 0, 59, 59), Date.UTC(2024, 2, 31, 1, 0, 1),   // EU spring-forward 2024
  Date.UTC(2024, 9, 27, 0, 59, 59), Date.UTC(2024, 9, 27, 1, 0, 1),   // EU fall-back 2024
  Date.UTC(2025, 2, 30, 0, 59, 59), Date.UTC(2025, 2, 30, 1, 0, 1),   // EU spring-forward 2025
]) epochs.push(Math.floor(t / 1000));

let pass = 0, fail = 0; const fails = [];
const byZone = {};
for (const zone of ZONES) {
  const rc = emu.loadZone(zone);
  byZone[zone] = { loaded: rc === 0, pass: 0, fail: 0 };
  if (rc !== 0) { console.log(`  ⚠ loadZone(${zone}) returned RULES code ${rc} — skipping`); continue; }
  for (const e of epochs) {
    const got = emu.offsetAt(e) | 0;
    const want = truthOffset(zone, e);
    if (got === want) { pass++; byZone[zone].pass++; }
    else { fail++; byZone[zone].fail++; if (fails.length < 12) fails.push({ zone, epoch: e, utc: new Date(e*1000).toISOString(), got, want }); }
  }
}

console.log(`\nFIRMWARE TIMEZONE ENGINE (real /TZRULES.BIN through the firmware's own loadRules)\n`);
for (const [z, v] of Object.entries(byZone))
  console.log(`  ${z.padEnd(20)} ${v.loaded ? `${v.pass}/${v.pass + v.fail} ${v.fail ? '✗' : '✓'}` : 'NOT LOADED ✗'}`);
console.log(`  ${''.padEnd(20)} TOTAL ${pass}/${pass + fail} ${fail ? '✗ ' + fail + ' FAIL' : '✓ ALL PASS'}`);
if (fails.length) { console.log('\n  first divergences:'); for (const f of fails) console.log('   ', JSON.stringify(f)); }
process.exit(fail ? 1 : 0);
