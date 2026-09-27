// pmext parser conformance: fixed sentences (checksums computed here, so every case is
// framing-exact) through parsePMSTAR / parsePMADEV / parsePMBRIT. No hardware, no randomness.
// Run: `node web/js/pmext.test.mjs`.
import { parsePMSTAR, parsePMADEV, parsePMBRIT } from './pmext.mjs?v=2';

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

// 6. $PMBRIT — the three sources, and the bounds each field carries.
const BRIT = frame('PMBRIT,400,666,A,21,256');
const b = parsePMBRIT(BRIT);
ok('PMBRIT parses', b && j(b) === j({ adc: 400, dac: 666, src: 'A', segk: 21, colon: 256 }), j(b));
ok('PMBRIT manual', j(parsePMBRIT(frame('PMBRIT,3800,2048,M,0,256'))) === j({ adc: 3800, dac: 2048, src: 'M', segk: 0, colon: 256 }));
ok('PMBRIT standby', j(parsePMBRIT(frame('PMBRIT,12,0,S,0,0'))) === j({ adc: 12, dac: 0, src: 'S', segk: 0, colon: 0 }));
ok('PMBRIT extremes accepted', !!parsePMBRIT(frame('PMBRIT,4095,4095,A,300,256')) && !!parsePMBRIT(frame('PMBRIT,0,0,A,0,0')));
ok('PMBRIT trailing CRLF tolerated', !!parsePMBRIT(BRIT + '\r\n'));

// 7. $PMBRIT rejections.
ok('PMBRIT corrupt checksum → null', parsePMBRIT(BRIT.slice(0, -2) + '00') === null);
ok('PMBRIT adc 4096 → null', parsePMBRIT(frame('PMBRIT,4096,666,A,21,256')) === null);
ok('PMBRIT dac 4096 → null', parsePMBRIT(frame('PMBRIT,400,4096,A,21,256')) === null);
ok('PMBRIT segk 301 → null', parsePMBRIT(frame('PMBRIT,400,666,A,301,256')) === null);
ok('PMBRIT colon 257 → null', parsePMBRIT(frame('PMBRIT,400,666,A,21,257')) === null);
ok('PMBRIT src X → null', parsePMBRIT(frame('PMBRIT,400,666,X,21,256')) === null);
ok('PMBRIT negative → null', parsePMBRIT(frame('PMBRIT,400,-1,A,21,256')) === null);
ok('PMBRIT field missing → null', parsePMBRIT(frame('PMBRIT,400,666,A,21')) === null);
ok('PMBRIT extra field → null', parsePMBRIT(frame('PMBRIT,400,666,A,21,256,9')) === null);
ok('PMBRIT not-my-sentence → null', parsePMBRIT(ADEV) === null);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
