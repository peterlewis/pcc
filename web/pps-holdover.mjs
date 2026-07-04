#!/usr/bin/env node
// Running-holdover (HSE) characteriser + A/B logger for the Precision Clock Mk IV.
//
//   cat /dev/cu.usbmodemXXXX | node web/pps-holdover.mjs        (needs `pps = on`, GPS-locked)
//
// While the clock is RUNNING and loses GPS, time free-runs on the HSE/SysTick — and this is the
// drift that temperature affects. This tool shows it two ways from the $PMTXTS stream:
//   1. PHASE vs TEMPERATURE — the per-PPS phase moves with the HSE's temperature coefficient. The
//      absolute offset is fixed ISR latency (ignore it); the SLOPE (µs/s per °C ≈ ppm/°C) is the
//      HSE tempco — the running-holdover drift driver. Sweep temperature while locked to reveal it.
//   2. HOLDOVER EPISODES — unplug the antenna for a bit, plug back in. Each GPS gap is logged with
//      its duration, temperature, and the phase jump on re-acquisition = the actual accumulated
//      sub-second drift (so ppm ≈ driftµs / duration). This is the direct A/B metric.

import { PpsMonitor, fitHseTempco } from './js/ppsts.js';
import readline from 'node:readline';

const mon = new PpsMonitor({ capacity: 100000 });
const episodes = [];
let prev = null, dirty = false;
const unwrapUs = (u) => (u > 5e5 ? u - 1e6 : u < -5e5 ? u + 1e6 : u);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.includes('$PMTXTS')) return;
  const r = mon.ingestLine(line.trim());
  if (!r || !r.checksumOK) return;
  dirty = true;
  // holdover episode = a >1 s gap in the PPS-stamped epoch (PPS stopped, then resumed)
  if (prev && r.epoch - prev.epoch > 1) {
    const dur = r.epoch - prev.epoch;                          // s without PPS (+1)
    const driftUs = unwrapUs((r.phaseMs - prev.phaseMs) * 1000);
    // |drift| near 1 ms means the phase tipped over the millisecond boundary — ambiguous, not real.
    episodes.push({ dur, driftUs, ppm: driftUs / dur, temp: r.temp, ambiguous: Math.abs(driftUs) > 500 });
    if (episodes.length > 10) episodes.shift();
    mon.reset();   // start a clean segment so the gap's phase-jump can't pollute the tempco/jitter
  }
  prev = r;
});

const f = (v, d = 2) => (v == null || Number.isNaN(v)) ? '—' : v.toFixed(d);

function render() {
  if (!dirty) return; dirty = false;
  const s = mon.stats(); if (!s) return;
  const locked = mon.records.filter((r) => r.valid && r.hadPps).map((r) => ({ temp: r.temp, systick: r.systick, load: r.load }));
  const tc = fitHseTempco(locked);

  const lines = [
    '\x1b[H\x1b[2J',
    '  Mk IV — running-holdover (HSE) characterisation',
    `  samples ${s.count}   temp ${s.temp ?? '—'} °C   jitter ${tc.ok ? f(tc.jitterNs, 1) + ' ns' : '—'}`,
    '',
    '  HSE TEMPERATURE COEFFICIENT  (from the per-PPS SysTick count)',
    tc.ok
      ? `    ${f(tc.ppmPerC, 3)} ppm/°C   over ${tc.tlo}…${tc.thi} °C   R²=${f(tc.r2, 2)}`
      : `    collecting…  ${tc.reason}  ← sweep the temperature while locked`,
    '',
    '  HOLDOVER EPISODES  (unplug antenna → replug; each gap = a running-holdover test)',
    episodes.length ? '    dur(s)   drift(µs)    ppm     temp(°C)' : '    none yet — pull the antenna for ~30–60 s, then reconnect',
    ...episodes.slice().reverse().map((e) =>
      `    ${String(e.dur).padStart(5)}   ${f(e.driftUs, 1).padStart(9)}   ${f(e.ppm, 2).padStart(6)}   ${String(e.temp).padStart(5)}` + (e.ambiguous ? '   ⚠ crossed ms boundary — unreliable' : '')),
    '',
    '  ctrl-c to quit',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

setInterval(render, 300);
process.stdin.on('end', () => { render(); process.exit(0); });
process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
