// Step-6 (deferred part) — ZoneDetect auto-timezone from GPS position. Registers the REAL 12 MB
// tzmap.bin + tzrules.bin, then for a battery of city coordinates runs the firmware's OWN ZoneDetect
// (emu_zone_from_pos: open /TZMAP.BIN -> ZDHelperSimpleLookupString(lat,lon) -> IANA zone name ->
// loadRulesSingle). Checks the resolved zone against known ground truth, and the resulting offset
// against JS Intl. ZoneDetect streams the 12 MB map through the firmware's 512-byte mapCache — it is
// never loaded whole into RAM.
import { loadEmu } from './harness.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const QSPI = HERE + '../../../../clock4-megabuild/qspi/output/';
const TZMAP = process.argv[2] || (QSPI + 'tzmap.bin');
const TZRULES = process.argv[3] || (QSPI + 'tzrules.bin');

function truthOffset(zone, epochSec) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(epochSec * 1000))) p[part.type] = part.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - epochSec * 1000) / 1000);
}

const emu = await loadEmu();
emu.registerFile('/TZMAP.BIN', new Uint8Array(readFileSync(TZMAP)));      // 12 MB (heap grows)
emu.registerFile('/TZRULES.BIN', new Uint8Array(readFileSync(TZRULES)));

// (lat, lon) -> known IANA zone (independent ground truth)
const CITIES = [
  ['London', 51.5074, -0.1278, 'Europe/London'],
  ['New York', 40.7128, -74.0060, 'America/New_York'],
  ['Los Angeles', 34.0522, -118.2437, 'America/Los_Angeles'],
  ['Tokyo', 35.6762, 139.6503, 'Asia/Tokyo'],
  ['Sydney', -33.8688, 151.2093, 'Australia/Sydney'],
  ['Paris', 48.8566, 2.3522, 'Europe/Paris'],
  ['Kolkata', 22.5726, 88.3639, 'Asia/Kolkata'],
  ['Sao Paulo', -23.5505, -46.6333, 'America/Sao_Paulo'],
  ['Moscow', 55.7558, 37.6173, 'Europe/Moscow'],
  ['Denver', 39.7392, -104.9903, 'America/Denver'],
  ['Honolulu', 21.3069, -157.8583, 'Pacific/Honolulu'],
  ['Cairo', 30.0444, 31.2357, 'Africa/Cairo'],
];

const nowSec = 1783296000;   // fixed instant (2026-07 — deterministic, no Date.now())
let zoneOk = 0, offOk = 0; const fails = [];
console.log(`\nZONEDETECT AUTO-TIMEZONE (real 12 MB tzmap.bin through the firmware's own ZoneDetect)\n`);
console.log(`  city            lat,lon                resolved zone            offset  truth`);
for (const [name, lat, lon, want] of CITIES) {
  const zone = emu.zoneFromPos(lat, lon);
  const zoneMatch = zone === want;
  const off = emu.offsetAt(nowSec) | 0;
  const wantOff = truthOffset(want, nowSec);
  const offMatch = off === wantOff;
  if (zoneMatch) zoneOk++;
  if (offMatch) offOk++;
  if (!zoneMatch || !offMatch) fails.push({ name, resolved: zone, want, off, wantOff });
  console.log(`  ${name.padEnd(14)} ${(lat.toFixed(2) + ',' + lon.toFixed(2)).padEnd(18)} ${zone.padEnd(24)} ${String(off).padStart(6)}  ${zoneMatch && offMatch ? '✓' : '✗'}`);
}
console.log(`\n  zone resolved correctly : ${zoneOk}/${CITIES.length} ${zoneOk === CITIES.length ? '✓' : '✗'}`);
console.log(`  offset == Intl          : ${offOk}/${CITIES.length} ${offOk === CITIES.length ? '✓' : '✗'}`);
if (fails.length) { console.log('\n  divergences:'); for (const f of fails) console.log('   ', JSON.stringify(f)); }
process.exit((zoneOk === CITIES.length && offOk === CITIES.length) ? 0 : 1);
