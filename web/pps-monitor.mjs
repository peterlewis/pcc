#!/usr/bin/env node
// Live PPS timing-stability monitor for the Precision Clock Mk IV.
//
//   1. enable the feature: add `pps = on` to config.txt on the clock's USB drive, eject.
//   2. find the port:  ls /dev/cu.usbmodem*
//   3. run:            cat /dev/cu.usbmodemXXXX | node web/pps-monitor.mjs
//
// Reads $PMTXTS lines from stdin (no serial library needed — `cat` does the reading) and shows
// live phase jitter, oscillator drift, temperature, lock and holdover, using the same
// js/ppsts.js parser the web app uses.

import { PpsMonitor } from './js/ppsts.js';
import readline from 'node:readline';

const mon = new PpsMonitor({ capacity: 3600 });   // up to 1 h of history
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let dirty = false, last = null;
rl.on('line', (line) => {
  if (!line.includes('$PMTXTS')) return;
  const r = mon.ingestLine(line.trim());
  if (r) { last = r; dirty = true; }
});

const f = (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : v.toFixed(d);

function render() {
  if (!dirty) return; dirty = false;
  const s = mon.stats(); if (!s) return;
  const out = [
    '\x1b[H\x1b[2J',
    '  PRECISION CLOCK Mk IV — live timing stability',
    `  records ${s.count}   gaps ${s.gaps}   bad-cksum ${s.badChecksums}`,
    '',
    `  lock          ${s.lock.toUpperCase()}`,
    `  phase jitter  ${f(s.rmsJitterUs)} µs RMS     ${f(s.pkpkJitterUs)} µs pk-pk`,
    `  drift         ${f(s.ppm)} ppm     (${f(s.ppmMin, 2)} … ${f(s.ppmMax, 2)})`,
    `  temperature   ${s.temp ?? '—'} °C`,
    `  holdover      ${s.sincecal} s since calibration`,
    '',
    last ? `  last: ${last.raw}` : '',
    '',
    '  ctrl-c to quit',
    '',
  ];
  process.stdout.write(out.join('\n'));
}

setInterval(render, 250);
process.stdin.on('end', () => { render(); process.exit(0); });
process.on('SIGINT', () => { process.stdout.write('\n'); process.exit(0); });
