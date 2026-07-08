// Numerical proof of the per-segment brightness compensation (DESIGN.md).
// Models the Mk IV's shared-current multiplex: one column lit per slot, its N lit segments split a
// fixed budget I_col, per-segment brightness = (I_col/N) * (slots_for_column / total_slots).
// Shows: (1) uncompensated bloom, (2) duty compensation equalises per-segment, (3) the interleave
// gives every column exactly s_c slots with small refresh gaps (no flicker), (4) the temporal residual.

// 7-seg lit-segment counts (from cSegDecode0..9 popcounts) + dash.
const SEG = { '0':6, '1':2, '2':5, '3':5, '4':4, '5':5, '6':6, '7':3, '8':7, '9':6, '-':1, ' ':0 };
const I_COL = 1.0;          // arbitrary current-budget unit
const M = 80;               // total scan slots (buffer_b/buffer_c are [80])
const SLOT_US = 3.2;        // TIM1 Period 256 @ 80 MHz

// Even interleave: assign M slots among columns so column c gets ~s_c slots, spread out.
// Standard "most-owed wins" apportionment (a multi-channel Bresenham).
function interleave(sc) {
  const C = sc.length, emitted = sc.map(() => 0), seq = [];
  for (let t = 0; t < M; t++) {
    let best = -1, bestOwed = -Infinity;
    for (let c = 0; c < C; c++) {
      if (sc[c] === 0) continue;
      const owed = (t + 1) * sc[c] / M - emitted[c];
      if (owed > bestOwed) { bestOwed = owed; best = c; }
    }
    seq.push(best); emitted[best]++;
  }
  return { seq, emitted };
}

// per-column slot allocation ∝ N_c, normalised to sum M, with a remainder fix-up so ΣS = M exactly.
function allocate(N) {
  const SN = N.reduce((a, b) => a + b, 0);
  if (SN === 0) return N.map(() => 0);
  const raw = N.map((n) => M * n / SN);
  const s = raw.map(Math.floor);
  let deficit = M - s.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < deficit; k++) s[order[k % order.length][1]]++;
  return s;
}

// max gap (in slots) between successive appearances of a column in the cyclic sequence → refresh rate.
function maxGap(seq, col) {
  const idx = []; for (let i = 0; i < seq.length; i++) if (seq[i] === col) idx.push(i);
  if (idx.length < 2) return seq.length;
  let g = idx[0] + (seq.length - idx[idx.length - 1]); // wrap
  for (let i = 1; i < idx.length; i++) g = Math.max(g, idx[i] - idx[i - 1]);
  return g;
}

function analyse(label, digits) {
  const N = digits.map((d) => SEG[d]);
  const SN = N.reduce((a, b) => a + b, 0);
  // uncompensated: 1 slot per column, cycle length = #columns
  const uncomp = N.map((n) => n ? (I_COL / n) * (1 / N.length) : 0);
  // compensated: s_c ∝ N_c over M slots
  const s = allocate(N);
  const comp = N.map((n, c) => n ? (I_COL / n) * (s[c] / M) : 0);
  const { seq, emitted } = interleave(s);
  const gaps = N.map((_, c) => (s[c] ? maxGap(seq, c) : 0));
  return { label, digits, N, SN, uncomp, comp, s, emitted, gaps };
}

const spread = (arr) => {
  const v = arr.filter((x) => x > 0);
  return { min: Math.min(...v), max: Math.max(...v), ratio: Math.max(...v) / Math.min(...v) };
};

console.log('=== Per-segment brightness: uncompensated vs duty-compensated ===\n');
// A time value across the 5 B-columns (tenHours,hours,tenMins,mins,tenSecs) — pick a segment-diverse one.
for (const [label, digits] of [
  ['17:48  (1,7,4,8 mix)', ['1', '7', '4', '8']],
  ['11:11  (all sparse)',  ['1', '1', '1', '1']],
  ['88:88  (all dense)',   ['8', '8', '8', '8']],
  ['-1:7-  (extremes)',    ['-', '1', '7', '-']],
]) {
  const r = analyse(label, digits);
  const su = spread(r.uncomp), sc = spread(r.comp);
  console.log(`${label}`);
  console.log(`  digits ${digits.join(' ')}  segs ${r.N.join(' ')}  ΣN=${r.SN}`);
  console.log(`  slot alloc s_c   : ${r.s.join(' ')}  (Σ=${r.s.reduce((a,b)=>a+b,0)}, emitted ${r.emitted.join(' ')})`);
  console.log(`  refresh gap slots: ${r.gaps.join(' ')}  → worst ${Math.max(...r.gaps)} slots = ${(Math.max(...r.gaps)*SLOT_US).toFixed(0)} µs (${(1e6/(Math.max(...r.gaps)*SLOT_US)).toFixed(0)} Hz)`);
  console.log(`  per-seg UNCOMP   : ${r.uncomp.map((x)=>x.toFixed(4)).join(' ')}  spread ${su.ratio.toFixed(2)}×`);
  console.log(`  per-seg COMP     : ${r.comp.map((x)=>x.toFixed(4)).join(' ')}  spread ${sc.ratio.toFixed(3)}×`);
  console.log('');
}

console.log('=== Temporal residual: same digit "8", different neighbours (compensated) ===');
for (const digits of [['8','1','1','1'], ['8','8','1','1'], ['8','8','8','8']]) {
  const r = analyse('', digits);
  console.log(`  ${digits.join('')}  ΣN=${String(r.SN).padStart(2)}  →  a "8" segment = ${r.comp[0].toFixed(4)}  (= I/ΣN)`);
}
console.log('  (uncompensated, an "8" segment is always (1/7)*(1/4)=0.0357 regardless of neighbours)');

// Assertions
let ok = true;
const a = analyse('t', ['1','7','4','8']);
if (a.s.reduce((x,y)=>x+y,0) !== M) { ok = false; console.log('\nFAIL: slots do not sum to M'); }
if (spread(a.comp).ratio > 1.05) { ok = false; console.log('\nFAIL: compensated spread > 1.05x'); }
if (Math.max(...a.gaps) > M/2) { ok = false; console.log('\nFAIL: a column refresh gap too large (flicker)'); }
console.log(ok ? '\nALL CHECKS PASS — duty compensation equalises per-segment brightness; interleave keeps refresh high.' : '\nCHECKS FAILED');
process.exit(ok ? 0 : 1);
