// Phase 3B — real-hardware anchor. Replays NMEA captured from the PHYSICAL Precision Clock Mk IV
// into the WASM emulator and proves the emulator computes the SAME currentTime the hardware
// reported in its own $PMTXTS timing sentences. Grounds the emulator against real silicon + a
// real GPS, on data the shim/register-redirect never sees in synthetic tests.
import { loadEmu, snapshot, tickN, pps } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Capture source: argv[2] > $HW_CAPTURE > the committed fixture next to this file.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CAP = process.argv[2] || process.env.HW_CAPTURE || (HERE + 'fixtures/hw_capture.jsonl');

const rows = readFileSync(CAP,'utf8').trim().split('\n').map(l=>JSON.parse(l));

// --- parse the capture into per-second groups keyed by the hardware's own currentTime ---------
function rmcEpoch(s){                    // $G?RMC,hhmmss.ss,A,...,ddmmyy,...
  const f = s.split(',');
  const t = f[1], d = f[9];
  if (!t || !d || d.length<6) return null;
  const hh=+t.slice(0,2), mm=+t.slice(2,4), ss=+t.slice(4,6);
  const day=+d.slice(0,2), mon=+d.slice(2,4), yr=2000+ +d.slice(4,6);
  return { epoch: Math.floor(Date.UTC(yr,mon-1,day,hh,mm,ss)/1000), valid: f[2]==='A' };
}
function pmtxtsTime(s){ const f=s.split(','); return f.length>2 ? (parseInt(f[2],10)>>>0) : null; }

// Build an ordered list of GPS seconds: each has the sentences to feed + the hardware's currentTime.
const seconds = [];
let cur = null;
for (const {line} of rows){
  if (line.startsWith('$PMTXTS')){
    const ct = pmtxtsTime(line);
    if (ct!=null){ cur = { hwTime: ct, sentences: [] }; seconds.push(cur); }
  } else if (/^\$G.(RMC|GSV|GGA|GSA|GLL|VTG)/.test(line)){
    if (cur) cur.sentences.push(line + '\r\n');
  }
}
// keep only seconds that carried an RMC (so the firmware has a fix to decode)
const usable = seconds.filter(s => s.sentences.some(x=>/^\$G.RMC/.test(x)) && s.hwTime>0);

// --- Anchor 1: the HARDWARE's own timekeeping matches real UTC (from its RMC) ------------------
let hwSelfOk = 0, hwSelfBad = 0;
for (const s of usable){
  const rmc = s.sentences.map(x=>x.trim()).find(x=>/^\$G.RMC/.test(x));
  const e = rmcEpoch(rmc);
  if (e && e.valid){ (e.epoch===s.hwTime ? hwSelfOk++ : hwSelfBad++); }
}

// --- Anchor 2: replay the captured NMEA into the EMULATOR; its currentTime must track the HW ----
const emu = await loadEmu();
emu.bootCold(usable[0].hwTime - 3);        // cold, a few seconds behind: must acquire + converge
emu.enable(0);
let matched=0, mism=0, locked=0; const mismDetail=[];
for (let i=0;i<usable.length;i++){
  const s = usable[i];
  // Mirror the hardware second: NMEA burst (RMC sets currentTime = its GPS UTC absolutely, at a
  // low sub-second phase so no .900 auto-increment competes), then the PPS edge disciplines it.
  for (const nm of s.sentences) emu.feedNmea(nm);      // real decodeRMC/decodeGSV run
  pps(emu);                                            // real PPS ISR: had_pps, last_pps_time, RTC
  const now = snapshot(emu).now;                       // sample at the PPS edge, like $PMTXTS
  const hadPps = emu.hadPps();
  tickN(emu, 500);                                     // keep the clock alive (stay < .900, no ++)
  if (i>=3){                                           // allow a few seconds to acquire+lock
    if (hadPps) locked++;
    if (now===s.hwTime) matched++;
    else { mism++; if (mismDetail.length<8) mismDetail.push({i, emu:now, hw:s.hwTime, d:now-s.hwTime}); }
  }
}

// --- report -----------------------------------------------------------------------------------
console.log(`\nREAL-HARDWARE ANCHOR  —  ${rows.length} captured lines, ${usable.length} GPS seconds with a fix\n`);
console.log(`Anchor 1 — hardware self-consistency (its $PMTXTS currentTime == its own RMC UTC):`);
console.log(`  ${hwSelfOk}/${hwSelfOk+hwSelfBad} seconds ${hwSelfBad? '✗':'✓'}`);
console.log(`\nAnchor 2 — emulator replay of the captured NMEA tracks the hardware's currentTime:`);
console.log(`  ${matched}/${matched+mism} seconds match exactly ${mism? '✗':'✓'}   (locked ${locked} of ${matched+mism})`);
if (mismDetail.length){ console.log('  mismatches:'); for (const m of mismDetail) console.log('   ', JSON.stringify(m)); }
const sampleT = usable[0].hwTime;
console.log(`\n  e.g. hardware currentTime ${sampleT} = ${new Date(sampleT*1000).toUTCString()}`);
process.exit((hwSelfBad===0 && mism===0) ? 0 : 1);
