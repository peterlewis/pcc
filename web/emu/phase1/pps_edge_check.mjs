// pps_edge_check.mjs — regression for the millisecond count running one ahead of GPS.
// The PPS handler restarts the SysTick counter a few microseconds after each edge, so the counter's
// 1000th wrap lands a few microseconds after the next edge: inside the PPS handler, which runs at
// SysTick's own priority. The wrap stayed pending, ran when the handler returned, and counted as the
// first millisecond of the new second. The count then read 1 ms ahead for that whole second: the ms
// digit one high, the seconds rolling over 1 ms early, and $PMTXTS reporting subms 0 with the counter
// nearly expired (the "+999 us" samples the app has been folding away). 30 hours of recordings from a
// locked clock: 103,196 seconds ahead, 1,298 not (the restart won the race by a few ticks).
//
// The emulator's handlers are atomic, so each edge is set up as the handler finds it: the counter
// value at the capture and whether a wrap is pending. After the handler returns the test does what
// the CPU does: a SysTick that is still pending runs.
// With the old code every "not ahead" case after the first second FAILS.
// Run: node pps_edge_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootWarm = w('emu_boot', 'void', ['number']), bootCold = w('emu_boot_cold', 'void', ['number']), tick = w('emu_tick'), pps = w('emu_pps'), pendsv = w('emu_pendsv');
const pendsvPending = w('emu_pendsv_pending', 'number');
const setVal = w('emu_set_systick', 'void', ['number']);
const pend = w('emu_systick_pend', 'void', ['number']), pending = w('emu_systick_pending', 'number');
const subms = w('emu_subms', 'number'), capSubms = w('emu_pps_subms', 'number'), uw = w('emu_uwtick', 'number');
const cfg = w('emu_config_line', 'void', ['string']), usb = w('emu_usb_host', 'void', ['number']);
const pmtxts = w('emu_pmtxts_line', 'string');
const bufcLow = w('emu_bufc_low', 'number', ['number']);

// A locked, running clock. The cold boot installs the PPS handler (PPS_Init's job on the clock); the
// warm boot on top of it gives a valid time and full precision, so the ms digits are live.
const boot = (t) => { bootCold(t); bootWarm(t); };

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const LOAD = 79999;
// How an edge can meet the 1000th wrap of the old second.
const EDGE = {
  wrapInHandler: { val: 240, pend: 1, ranFirst: 0 },   // the usual case: the wrap lands inside the handler
  restartFirst:  { val: 240, pend: 0, ranFirst: 0 },   // the restart clears the counter before it wraps
  wrapUnserved:  { val: LOAD - 9, pend: 1, ranFirst: 0 },  // the wrap came before the capture and has not run
  tickRanFirst:  { val: LOAD - 99, pend: 0, ranFirst: 1 }, // a fast oscillator: the 1000th tick ran before the edge
};
const ticks = (n) => { for (let i = 0; i < n; i++) { tick(); if (pendsvPending()) pendsv(); } };
// One edge. Returns what the capture recorded.
function edge(kind) {
  const e = EDGE[kind];
  if (e.ranFirst) ticks(1);
  setVal(e.val); pend(e.pend);
  pps();
  const cap = capSubms();
  if (pending()) { pend(0); ticks(1); }                // the CPU runs a SysTick that is still pending
  if (pendsvPending()) pendsv();
  return cap;
}
// A full second after an edge: 999 wraps, then the next edge of the given kind.
function second(kind) {
  const t0 = uw();
  ticks(500);
  const mid = subms(), digit = bufcLow(3);
  ticks(499);
  const end = subms();
  const cap = edge(kind);
  return { mid, digit, end, cap, after: subms(), uw: (uw() - t0) >>> 0 };
}

function run(name, kinds) {
  boot(1718971200);
  edge('restartFirst');                                // a clean first edge: the count starts at 0
  const zeroDigit = (() => { const d = bufcLow(3); return d; })();
  const rows = kinds.map((k) => ({ k, ...second(k) }));
  const bad = (f) => rows.map((r, i) => (f(r) ? null : `${i + 1}:${r.k}`)).filter(Boolean).join(' ');
  let b;
  b = bad((r) => r.mid === 500);
  check(`${name}: 500 ms after every edge the count reads 500${b ? ` (wrong in second ${b})` : ''}`, !b);
  b = bad((r) => r.digit === zeroDigit);
  check(`${name}: and the ms digit shows 0 there${b ? ` (wrong in second ${b})` : ''}`, !b);
  b = bad((r) => r.end === 999);
  check(`${name}: the count reaches 999, not the next second, before the edge${b ? ` (wrong in second ${b})` : ''}`, !b);
  b = bad((r) => r.after === 0);
  check(`${name}: every second starts at 0${b ? ` (wrong in second ${b})` : ''}`, !b);
  b = bad((r) => r.uw === 1000);
  check(`${name}: uwTick advances 1000 in every second${b ? ` (wrong in second ${b})` : ''}`, !b);
  return rows;
}

// The usual case, ten seconds running: the wrap lands inside the handler every time.
const steady = run('steady lock', Array(10).fill('wrapInHandler'));
check(`steady lock: every capture reports 999 (got ${[...new Set(steady.map((r) => r.cap))].join(',')})`, steady.every((r) => r.cap === 999));

run('restart first', Array(5).fill('restartFirst'));
run('tick ran first', Array(5).fill('tickRanFirst'));

// A wrap that came before the capture and has not run: the counter has started the next millisecond
// and the count has not. The capture must read them as one value: 0, not 999.
const unserved = run('wrap not yet served', Array(5).fill('wrapUnserved'));
check(`wrap not yet served: the capture reports 0, the second already over (got ${[...new Set(unserved.map((r) => r.cap))].join(',')})`, unserved.every((r) => r.cap === 0));

// The kinds mixed, as a real clock mixes them.
run('mixed', ['wrapInHandler', 'wrapInHandler', 'restartFirst', 'wrapInHandler', 'wrapUnserved', 'tickRanFirst', 'wrapInHandler', 'restartFirst', 'wrapInHandler']);

// The handler leaves no SysTick pending, whatever it found.
boot(1718971200);
for (const k of Object.keys(EDGE)) {
  const e = EDGE[k]; ticks(999); if (e.ranFirst) ticks(1);
  setVal(e.val); pend(e.pend); pps();
  check(`${k}: no SysTick is left pending when the handler returns`, pending() === 0);
  if (pendsvPending()) pendsv();
}

// $PMTXTS carries the same number: subms 999 with the counter nearly expired, second after second.
boot(1718971200); cfg('pps = on'); usb(1);
edge('restartFirst');
const sent = [];
for (let i = 0; i < 5; i++) { ticks(999); edge('wrapInHandler'); const f = String(pmtxts()).split(','); sent.push(`${f[3]}/${f[4]}`); }
check(`$PMTXTS reports subms 999, systick 240 in a locked second (got ${[...new Set(sent)].join(' ')})`, sent.every((s) => s === '999/240'));

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
