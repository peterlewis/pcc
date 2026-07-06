// Step-5 check: prove the emulator runs the firmware's OWN emitPPSTimestamp() and produces a
// well-formed $PMTXTS whose epoch tracks the real hardware. Replays the bench NMEA capture; for
// each second, after the PPS edge, reads the firmware-formatted sentence back via emu_pmtxts_line.
// The timing/temp fields (systick/subms/calerr/temp) are NOT expected to byte-match hardware — the
// emulator has no real oscillator/ADC — but the FORMAT, NMEA checksum, and epoch are the firmware's
// own byte-faithful output. So we verify: valid checksum, 9 fields, epoch == hardware epoch.
import { loadEmu, snapshot, pps, tickN } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CAP = process.argv[2] || (HERE + 'fixtures/hw_capture.jsonl');
const rows = readFileSync(CAP, 'utf8').trim().split('\n').map(l => JSON.parse(l));

// group NMEA under each $PMTXTS (its timestamp = the following RMC second), like hw_anchor.mjs
const seconds = []; let cur = null;
for (const { line } of rows) {
  if (line.startsWith('$PMTXTS')) { const ct = parseInt(line.split(',')[2], 10) >>> 0; cur = { hwTime: ct, hwLine: line, sentences: [] }; seconds.push(cur); }
  else if (/^\$G.(RMC|GSV|GGA|GSA|GLL|VTG)/.test(line) && cur) cur.sentences.push(line + '\r\n');
}
const usable = seconds.filter(s => s.sentences.some(x => /^\$G.RMC/.test(x)) && s.hwTime > 0);

// NMEA XOR checksum over the chars between '$' and '*'
function nmeaOk(sentence) {
  const m = /^\$(.*)\*([0-9A-Fa-f]{2})/.exec(sentence.trim());
  if (!m) return false;
  let c = 0; for (const ch of m[1]) c ^= ch.charCodeAt(0);
  return c === parseInt(m[2], 16);
}

const emu = await loadEmu();
emu.bootCold(usable[0].hwTime - 3);
emu.enable(0);

let wellFormed = 0, checksumOk = 0, epochMatch = 0, tested = 0, seqMono = 0, lastSeq = null;
const samples = [];
for (let i = 0; i < usable.length; i++) {
  const s = usable[i];
  for (const nm of s.sentences) emu.feedNmea(nm);
  pps(emu);
  const line = emu.pmtxtsLine();               // the firmware's own $PMTXTS for this edge
  tickN(emu, 500);
  if (i < 3) continue;                         // let it acquire+lock
  tested++;
  const f = line.trim().split(',');
  const okForm = /^\$PMTXTS,/.test(line) && f.length === 10;   // $PMTXTS + 9 values
  const okCks  = nmeaOk(line);
  const emuEpoch = (/^\$PMTXTS,/.test(line) && f.length >= 3) ? (parseInt(f[2], 10) >>> 0) : null;
  const okEpoch = emuEpoch === s.hwTime;
  const seq = okForm ? (parseInt(f[1], 10) >>> 0) : null;
  const okSeq = lastSeq === null || (seq === ((lastSeq + 1) >>> 0)); lastSeq = seq;
  if (okForm) wellFormed++;
  if (okCks) checksumOk++;
  if (okEpoch) epochMatch++;
  if (okSeq) seqMono++;
  if (samples.length < 3) samples.push({ emu: line.trim(), hw: s.hwLine });
}

console.log(`\n$PMTXTS EMIT CHECK  —  ${tested} locked seconds replayed from the bench capture\n`);
console.log(`  well-formed ($PMTXTS + 9 fields) : ${wellFormed}/${tested} ${wellFormed===tested?'✓':'✗'}`);
console.log(`  valid NMEA checksum (firmware's) : ${checksumOk}/${tested} ${checksumOk===tested?'✓':'✗'}`);
console.log(`  epoch field == hardware epoch    : ${epochMatch}/${tested} ${epochMatch===tested?'✓':'✗'}`);
console.log(`  seq strictly increments          : ${seqMono}/${tested} ${seqMono===tested?'✓':'✗'}`);
console.log(`\n  emulator vs hardware $PMTXTS (timing/temp fields differ by design — no real oscillator/ADC):`);
for (const s of samples) { console.log(`    emu: ${s.emu}`); console.log(`    hw : ${s.hw}\n`); }
process.exit((wellFormed===tested && checksumOk===tested && epochMatch===tested && seqMono===tested) ? 0 : 1);
