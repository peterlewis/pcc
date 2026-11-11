// tzrules_trunc_check.mjs — regression for a truncated TZRULES.BIN crashing the zone loader.
// TZRULES.BIN is host-writable (an interrupted copy leaves it short). f_getzcmp looped until it read
// a NUL and never checked the read count: at end-of-file the read leaves its buffer untouched, so the
// loop never ended and walked the compare pointer off the end of memory — a trap here, a HardFault on
// the clock, and on every boot (the zone reloads from the RTC backup registers). loadRules also read
// its header fields unchecked into uninitialised locals.
// This cuts the real file at every length through the header and index, and on a stride through the
// rest, and requires each load to RETURN: either an error that leaves the loaded zone untouched, or
// success with exactly the full file's rules. With the old code the first cut traps.
// Run: node tzrules_trunc_check.mjs
import { readFileSync } from 'node:fs';
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const boot = w('emu_boot', 'void', ['number']);
const reg = w('emu_register_file', 'void', ['string', 'number', 'number']);
const load = w('emu_load_zone', 'number', ['string']);
const offsetAt = w('emu_offset_at', 'number', ['number']);

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const full = readFileSync(new URL('../tzrules.bin', import.meta.url));
const ptr = M._malloc(full.length);
M.HEAPU8.set(full, ptr);
const useCut = (n) => reg('/TZRULES.BIN', ptr, n);    // the same bytes, a shorter file
const tJul = Date.UTC(2026, 6, 20, 12) / 1000, tJan = Date.UTC(2026, 0, 20, 12) / 1000;

boot(1718971200);
useCut(full.length);
check('whole file: Europe/London loads', load('Europe/London') === 0 && offsetAt(tJul) === 3600 && offsetAt(tJan) === 0);
check('whole file: Europe/Madrid loads', load('Europe/Madrid') === 0 && offsetAt(tJul) === 7200 && offsetAt(tJan) === 3600);
check('whole file: an unknown zone is refused', load('Europe/Nowhere') !== 0);

const cuts = [];
for (let n = 0; n <= 4096 && n < full.length; n++) cuts.push(n);
for (let n = 4097; n < full.length; n += 97) cuts.push(n);
cuts.push(full.length - 1);

let trapped = null, wrongOk = null, clobbered = null, okCount = 0, errCount = 0;
for (const n of cuts) {
  useCut(full.length);
  if (load('Europe/London') !== 0) { trapped = `could not reload London before cut ${n}`; break; }
  useCut(n);
  let rc;
  try { rc = load('Europe/Madrid'); } catch (e) { trapped = `cut at ${n} bytes: ${e.message}`; break; }
  const jul = offsetAt(tJul), jan = offsetAt(tJan);
  if (rc === 0) { okCount++; if (jul !== 7200 || jan !== 3600) wrongOk ??= `cut ${n}: OK but offsets ${jul}/${jan}`; }
  else          { errCount++; if (jul !== 3600 || jan !== 0)   clobbered ??= `cut ${n}: error ${rc} but London's rules read ${jul}/${jan}`; }
}
check(`every one of ${cuts.length} truncated files returns${trapped ? ` (${trapped})` : ''}`, !trapped);
check(`a cut that still loads gives the full file's rules${wrongOk ? ` (${wrongOk})` : ''}`, !trapped && !wrongOk);
check(`a cut that fails leaves the loaded zone untouched${clobbered ? ` (${clobbered})` : ''}`, !trapped && !clobbered);
check(`both outcomes were exercised (${okCount} loaded, ${errCount} refused)`, !trapped && okCount > 0 && errCount > 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
