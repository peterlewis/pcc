// pmext parser conformance: fixed sentences (checksums computed here, so every case is
// framing-exact) through parsePMSTAR / parsePMADEV. No hardware, no randomness.
// Run: `node web/js/pmext.test.mjs`.
import { parsePMSTAR, parsePMADEV } from './pmext.mjs?v=1';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const j = JSON.stringify;

// Frame a body with its real XOR checksum (uppercase two-hex, per the firmware).
const frame = (body) => {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return '$' + body + '*' + c.toString(16).toUpperCase().padStart(2, '0');
};

// 1. $PMSTAR — a valid two-entry sentence (second name space-padded like the firmware pads).
const STAR2 = frame('PMSTAR,2,VEGA,754,63,S,M31 ,3541,12,N');
const s = parsePMSTAR(STAR2);
ok('PMSTAR parses', !!s, STAR2);
ok('PMSTAR entry 0', s && j(s.stars[0]) === j({ name: 'VEGA', secToTransit: 754, altDeg: 63, dir: 'S' }), j(s && s.stars[0]));
ok('PMSTAR entry 1 (padding trimmed)', s && j(s.stars[1]) === j({ name: 'M31', secToTransit: 3541, altDeg: 12, dir: 'N' }), j(s && s.stars[1]));

// 2. $PMSTAR rejections — corrupt checksum, field-count lies, out-of-contract values.
ok('PMSTAR corrupt checksum → null', parsePMSTAR(STAR2.slice(0, -2) + '00') === null);
ok('PMSTAR n=2 but one entry → null', parsePMSTAR(frame('PMSTAR,2,VEGA,754,63,S')) === null);
ok('PMSTAR bad src → null', parsePMSTAR(frame('PMSTAR,1,X,VEGA,754,63,S')) === null);
ok('PMSTAR alt 91 → null', parsePMSTAR(frame('PMSTAR,1,VEGA,754,91,S')) === null);
ok('PMSTAR dir E → null', parsePMSTAR(frame('PMSTAR,1,VEGA,754,63,E')) === null);
ok('PMSTAR 5-char name → null', parsePMSTAR(frame('PMSTAR,1,ALGOL,754,63,S')) === null);
ok('PMSTAR n=9 → null', parsePMSTAR(frame('PMSTAR,9,B' + ',AAAA,1,1,S'.repeat(9))) === null);
ok('PMSTAR not-my-sentence → null', parsePMSTAR(frame('PMTXTS,1,2,3')) === null);
const s0 = parsePMSTAR(frame('PMSTAR,0'));

// 3. $PMADEV — taus must expand to tau0·2^k.
const ADEV = frame('PMADEV,1767225600,1,512,4,3.2e-11,2.1e-11,1.5e-11,9.8e-12');
const a = parsePMADEV(ADEV);
ok('PMADEV parses', !!a, ADEV);
ok('PMADEV kind/epoch/tau0/valid/noct', a && a.kind === 'adev' && a.epoch === 1767225600 && a.tau0 === 1 && a.valid === 512 && a.noct === 4, j(a));
ok('PMADEV taus expand [1,2,4,8]', a && j(a.taus) === j([1, 2, 4, 8]), j(a && a.taus));
ok('PMADEV sigmas', a && j(a.sigmas) === j([3.2e-11, 2.1e-11, 1.5e-11, 9.8e-12]), j(a && a.sigmas));
const a2 = parsePMADEV(frame('PMADEV,1767225600,2,64,3,1e-10,2e-10,3e-10'));
ok('PMADEV tau0=2 → taus [2,4,8]', a2 && j(a2.taus) === j([2, 4, 8]), j(a2 && a2.taus));

// 4. $PMHDEV — same parser, tagged kind:'hdev'.
const h = parsePMADEV(frame('PMHDEV,1767225600,1,512,2,3.0e-11,2.0e-11'));
ok('PMHDEV parses as kind hdev', h && h.kind === 'hdev' && j(h.taus) === j([1, 2]), j(h));

// 5. $PMADEV rejections.
ok('PMADEV corrupt checksum → null', parsePMADEV(ADEV.slice(0, -2) + '00') === null);
ok('PMADEV noct=4 but 3 sigmas → null', parsePMADEV(frame('PMADEV,1767225600,1,512,4,1e-10,2e-10,3e-10')) === null);
ok('PMADEV non-numeric sigma → null', parsePMADEV(frame('PMADEV,1767225600,1,512,1,zap')) === null);
ok('PMADEV tau0=0 → null', parsePMADEV(frame('PMADEV,1767225600,0,512,1,1e-10')) === null);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
