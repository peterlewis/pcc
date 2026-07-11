// adev_ref.mjs — trusted reference for the overlapping Allan deviation, and a golden slope test.
//
// The firmware's on-MCU ADEV must match THIS. Overlapping ADEV from phase (time-error) samples x_i
// at spacing tau0, averaging factor m (tau = m*tau0):
//
//   sigma_y^2(tau) = 1 / (2*(N-2m)*tau^2) * sum_{i=0}^{N-2m-1} (x_{i+2m} - 2*x_{i+m} + x_i)^2
//
// Validation: each canonical noise type has a signature ADEV slope on log-log. If our computation is
// right, synthetic series must reproduce them:
//   white PM   x_i ~ N(0,1)                       ADEV ~ tau^-1
//   white FM   x = integrate(N(0,1))              ADEV ~ tau^-1/2
//   rand-walk FM x = integrate(integrate(N(0,1))) ADEV ~ tau^+1/2

export function oadev(x, tau0, m) {
  const N = x.length;
  if (N < 2 * m + 1) return NaN;
  let s = 0, cnt = 0;
  for (let i = 0; i + 2 * m < N; i++) {
    const d = x[i + 2 * m] - 2 * x[i + m] + x[i];
    s += d * d; cnt++;
  }
  const tau = m * tau0;
  return Math.sqrt(s / (2 * cnt * tau * tau));
}

// deterministic PRNG (mulberry32) + Box-Muller, so golden values are stable across runs
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function series(kind, N, seed) {
  const rng = mulberry32(seed);
  const x = new Float64Array(N);
  if (kind === 'wpm') { for (let i = 0; i < N; i++) x[i] = gauss(rng); }
  else if (kind === 'wfm') { let p = 0; for (let i = 0; i < N; i++) { p += gauss(rng); x[i] = p; } }
  else if (kind === 'rwfm') { let f = 0, p = 0; for (let i = 0; i < N; i++) { f += gauss(rng); p += f; x[i] = p; } }
  return x;
}

// least-squares slope of log10(adev) vs log10(tau) over the octave points
export function slope(x, taus) {
  const pts = taus.map(m => [Math.log10(m), Math.log10(oadev(x, 1, m))]).filter(p => isFinite(p[1]));
  const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const N = 16384, taus = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  const expect = { wpm: -1.0, wfm: -0.5, rwfm: +0.5 };
  let fail = 0;
  console.log(`overlapping ADEV slope check (N=${N}, tau=1..512):`);
  for (const [kind, exp] of Object.entries(expect)) {
    const x = series(kind, N, 0x1234 + kind.length);
    const sl = slope(x, taus);
    const ok = Math.abs(sl - exp) < 0.08;   // finite-length ADEV scatter; 0.08 is comfortable
    if (!ok) fail++;
    console.log(`  ${kind.padEnd(5)} slope ${sl.toFixed(3)}  expect ${exp.toFixed(1)}  ${ok ? 'PASS' : 'FAIL'}`);
  }
  // sanity: a pure frequency drift (x = 0.5*d*t^2) gives ADEV = d*tau/sqrt(2), slope +1 exactly
  const d = 1e-9, drift = Float64Array.from({ length: N }, (_, i) => 0.5 * d * i * i);
  const dslope = slope(drift, taus);
  const dok = Math.abs(dslope - 1.0) < 0.02;
  if (!dok) fail++;
  console.log(`  drift slope ${dslope.toFixed(3)}  expect 1.0  ${dok ? 'PASS' : 'FAIL'}`);
  // and its absolute value: ADEV(tau)=d*tau/sqrt2 -> at tau=64, = 1e-9*64/1.414
  const a64 = oadev(drift, 1, 64), want = d * 64 / Math.SQRT2;
  const aok = Math.abs(a64 / want - 1) < 0.02;
  if (!aok) fail++;
  console.log(`  drift ADEV@64 ${a64.toExponential(3)}  want ${want.toExponential(3)}  ${aok ? 'PASS' : 'FAIL'}`);
  console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
  process.exit(fail ? 1 : 0);
}
