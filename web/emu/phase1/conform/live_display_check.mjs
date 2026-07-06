// live_display_check.mjs — Tier 3d: LIVE-MODE DISPLAY advances (the freeze regression guard)
//
// hw_anchor.mjs proves the emulator's currentTime tracks the hardware second-for-second — but
// currentTime and the DISPLAYED 7-seg are SEPARATE. RMC sets currentTime absolutely; the displayed
// second is only STAGED when the sub-second counter climbs past .900 (SysTick), and LATCHED at the
// next PPS. So if PPS is pulsed more than once per second — which happens when the host pulses on
// every RMC and the Mk IV emits several RMC talkers per second ($GPRMC + $GNRMC + …) — the sub-second
// keeps resetting, never reaches .900, and the whole DISPLAY freezes while currentTime keeps ticking.
// A now-only check (hw_anchor) is blind to this. This tier drives the emulator with a realistic
// multi-talker burst and asserts the DECODED display advances; it also runs the bug scenario so the
// guard's sensitivity is documented.
//
//   node live_display_check.mjs

import { loadEmu, snapshot, tickN, pps } from './harness.mjs';

const cksum = (b) => { let c = 0; for (let i = 0; i < b.length; i++) c ^= b.charCodeAt(i); return c.toString(16).toUpperCase().padStart(2, '0'); };
const nmea = (b) => '$' + b + '*' + cksum(b);
const p2 = (n) => String(n).padStart(2, '0');
// A valid ('A') RMC per talker; date 050726 = 05 Jul 2026.
const rmc = (h, m, s, tk) => nmea(`${tk}RMC,${p2(h)}${p2(m)}${p2(s)}.00,A,5128.60,N,00007.00,W,0.0,0.0,050726,,,A`);
const gga = (h, m, s) => nmea(`GPGGA,${p2(h)}${p2(m)}${p2(s)}.00,5128.60,N,00007.00,W,1,09,0.8,45.0,M,47.0,M,,`);

const emu = await loadEmu();
const BASE_S = 9;   // start seconds

function warmup() {
  emu.bootCold(Date.UTC(2026, 6, 5, 8, 9, 0) / 1000 - 3);   // cold, a few seconds behind
  emu.setAdc(2600);                                          // non-zero brightness so the panel is lit
  for (let t = 0; t < 4; t++) { emu.feedNmea(gga(8, 9, BASE_S + t)); emu.feedNmea(rmc(8, 9, BASE_S + t, 'GP')); pps(emu); tickN(emu, 950); }
}

// Drive N seconds of a realistic burst (2 RMC talkers + GGA per second), pulsing PPS `ppsPerSec`
// times. ~960 raw sub-second ticks per second (crosses the .900 staging boundary). Returns the
// decoded main-row display (HHMMSS) sampled once per second.
function runLive(ppsPerSec, N) {
  const frames = [];
  for (let i = 0; i < N; i++) {
    const s = (BASE_S + 4 + i) % 60;
    emu.feedNmea(gga(8, 9, s));
    emu.feedNmea(rmc(8, 9, s, 'GP'));
    if (ppsPerSec >= 1) pps(emu);
    tickN(emu, 480);
    emu.feedNmea(rmc(8, 9, s, 'GN'));   // second talker, SAME GPS second
    if (ppsPerSec >= 2) pps(emu);       // the BUG: a second pulse resets the sub-second mid-second
    tickN(emu, 480);
    frames.push(snapshot(emu).bigStr);
  }
  return frames;
}

const N = 8;
warmup(); const good = runLive(1, N);   // correct host discipline: one PPS per GPS second
warmup(); const bug  = runLive(2, N);   // the freeze: two PPS per second

const goodUniq = new Set(good).size;
const bugUniq  = new Set(bug).size;
const pass = goodUniq >= N - 1;   // the display must advance essentially every second

console.log('Tier 3d — live-mode DISPLAY advances (freeze regression guard)');
console.log(`  one PPS / sec (correct discipline): ${goodUniq}/${N} distinct display frames — ${pass ? 'PASS' : 'FAIL'}`);
console.log(`     frames: ${good.join(' ')}`);
console.log(`  two PPS / sec (the freeze bug):     ${bugUniq}/${N} distinct — ${bugUniq <= 2 ? 'frozen, as expected (the guard is sensitive to it)' : 'NOT frozen — guard would miss a regression!'}`);
console.log(`     frames: ${bug.join(' ')}`);

if (!pass) { console.error('\nFAIL: the live-mode display did not advance under correct PPS discipline.'); process.exit(1); }
if (bugUniq > 2) { console.error('\nWARN: the two-PPS bug did not freeze the display — this guard may not catch the regression it was written for.'); process.exit(1); }
console.log('\nPASS — display tracks second-for-second with one PPS/sec; multi-pulse freezes it (guard verified).');
