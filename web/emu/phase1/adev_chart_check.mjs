// adev_chart_check.mjs — the TIMING room's ADEV-chart data pipeline, end to end in Node:
// sim.createSession generates $PMTXTS (the openly-synthetic oscillator) → ppsts.parsePMTXTS →
// emu_adev_push (the app's simulation hook, µs·80 ticks) → the FIRMWARE's own overlapping-ADEV
// reduction → emu_adev_line ($PMADEV, byte-faithful) → pmext.parsePMADEV → the ladder drawAdev plots.
// Run: node adev_chart_check.mjs   (from phase1/)
import factory from '../clock-fw.mjs';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'adevc-'));
const shadow = async (rel, name) => { copyFileSync(join(here, rel), join(tmp, name)); return import(pathToFileURL(join(tmp, name)).href); };
const SIM = await shadow('../../js/sim.js', 'sim.mjs');
const PT = await shadow('../../js/ppsts.js', 'ppsts.mjs');
const PM = await shadow('../../js/pmext.mjs', 'pmext.mjs');

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const adevPush = w('emu_adev_push', 'void', ['number']);
const adevLine = w('emu_adev_line', 'string');

const results = [];
const check = (n, pass) => { results.push({ n, pass: !!pass }); if (!pass) console.error('FAIL:', n); };

bootCold(1783627200);

// 1. The sim generates $PMTXTS sentences with realistic phase jitter (gated on connect()).
const session = SIM.createSession({ preroll: 0 });
session.connect();
const t0 = Date.now();
const lines = [];
for (let k = 0; k < 140; k++) {
  session.tick(t0 + k * 1000);
  for (const e of session.S.nmeaLog) {
    if (e && typeof e.text === 'string' && e.text.startsWith('$PMTXTS,') && !e._seen) { e._seen = 1; lines.push(e.text); }
  }
}
check(`sim emitted $PMTXTS (${lines.length})`, lines.length >= 100);

// 2. The app's simulation hook: parse each sentence, push centred µs·80 ticks into the firmware ring.
let pushed = 0;
for (const t of lines) {
  const r = PT.parsePMTXTS(t);
  if (r && Number.isFinite(r.phaseMs)) {
    const us = (r.phaseMs > 500 ? r.phaseMs - 1000 : r.phaseMs) * 1000;
    adevPush(us * 80);
    pushed++;
  }
}
check(`all sentences parsed + pushed (${pushed})`, pushed === lines.length);

// 3. The firmware's own reduction publishes a σ_y(τ) ladder, and the chart parser accepts it.
const raw = (adevLine() || '').trim();
const parsed = PM.parsePMADEV(raw);
check('firmware emits a parseable $PMADEV', !!parsed);
const pts = parsed ? parsed.taus.map((t, i) => ({ t, s: parsed.sigmas[i] })).filter((q) => q.s > 0) : [];
check(`ladder has published octaves (${pts.length} of noct=${parsed && parsed.noct})`, pts.length >= 4);
// 140 samples → 4m gate publishes τ=1(4),2(8),4(16),8(32),16(64),32(128) = 6 octaves
check('maturity gate honoured (τ up to 32 s at 140 samples)', pts.length === 6 && pts[pts.length - 1].t === 32);
check('sigmas are sane magnitudes (σ_y ~1e-7..1e-4 for ~µs jitter)', pts.every((q) => q.s > 1e-9 && q.s < 1e-2));
// white-FM-ish source → σ should broadly FALL with τ (τ^-1/2); allow slack for the random draw
check('ladder slopes downward overall', pts[pts.length - 1].s < pts[0].s);

console.log('ladder:', pts.map((q) => `τ${q.t}=${q.s.toExponential(1)}`).join(' '));
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES ABOVE'}`);
process.exit(pass === results.length ? 0 : 1);
