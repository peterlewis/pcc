#!/usr/bin/env node
// Characterise the Mk IV crystal's temperature curve from live $PMTXTS, for holdover compensation.
//
//   1. enable `pps = on` in config.txt, GPS-locked.
//   2. run:  cat /dev/cu.usbmodemXXXX | node web/pps-fit.mjs
//   3. vary the clock's temperature WHILE LOCKED (let it warm from cold, move it warmer/cooler)
//      over as wide a range as you can. Watch the fit converge.
//   4. when it says READY, copy the `temp_comp = …` line into config.txt on the clock and eject.
//
// Uses the same js/ppsts.js fit the app would use.

import { PpsMonitor, fitTempCompensation } from './js/ppsts.js';
import readline from 'node:readline';

const mon = new PpsMonitor({ capacity: 1e9 });
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let dirty = false;
rl.on('line', (l) => { if (l.includes('$PMTXTS')) { if (mon.ingestLine(l.trim())) dirty = true; } });

// Only points captured while GPS-locked carry a trustworthy ppm measurement.
const lockedPoints = () => mon.records.filter((r) => r.valid && r.hadPps).map((r) => ({ temp: r.temp, ppm: r.ppm }));

function render() {
  if (!dirty) return; dirty = false;
  const pts = lockedPoints();
  let lo = Infinity, hi = -Infinity;                 // no argument-spread (long captures)
  for (const p of pts) { if (p.temp < lo) lo = p.temp; if (p.temp > hi) hi = p.temp; }
  const range = pts.length ? `${lo} … ${hi} °C  (${hi - lo} °C span)` : '—';
  const fit = fitTempCompensation(pts);
  const body = fit.ok
    ? [
        `  READY (${fit.mode})   ppm(T) = ${fit.k0.toFixed(3)} + ${fit.k1.toFixed(4)}·(T−25) + ${fit.k2.toFixed(6)}·(T−25)²`,
        `         fit RMS ${fit.rms.toFixed(2)} ppm  (calerr noise floor ≈ ${fit.quantum.toFixed(2)} ppm)`
          + (fit.mode === 'linear' ? '   — sweep wider to capture curvature' : ''),
        '',
        `  → add to config.txt:   ${fit.configLine}`,
      ]
    : [`  collecting…   ${fit.reason}`];
  process.stdout.write([
    '\x1b[H\x1b[2J',
    '  Mk IV crystal characterisation — holdover temperature compensation',
    `  locked samples ${pts.length}   temperature range ${range}`,
    '',
    ...body,
    '',
    '  vary the temperature WHILE LOCKED; wider range = better fit. ctrl-c when satisfied',
    '',
  ].join('\n'));
}

setInterval(render, 300);
process.stdin.on('end', () => { render(); process.exit(0); });
process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
