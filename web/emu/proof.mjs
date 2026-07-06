import factory from './astro-core.mjs';
const M = await factory();
const lst = M.cwrap('local_sidereal_time','number',['number','number']);
const sol = M.cwrap('local_solar_time','number',['number','number']);
const eot = M.cwrap('equation_of_time','number',['number']);

// Same anchors as the firmware native test suite (test_astro.c)
const cases = [
  ['LST J2000 lon0',      lst(946728000, 0),    18.697375],
  ['LST Meeus 12.b lon0', lst(545080860, 0),     8.582525],
  ['LST J2000 lon -75',   lst(946728000, -75),  13.697375],
  ['LST J2000 lon +90wrap',lst(946728000, 90),   0.697375],
];
let ok=0;
console.log('=== WASM firmware astro.c running in Node (the REAL firmware math) ===');
for (const [n,got,exp] of cases){
  const d=Math.abs(got-exp), pass=d<1e-4;
  console.log(`  ${pass?'ok  ':'FAIL'} ${n.padEnd(22)} got=${got.toFixed(6)} exp=${exp} |d|=${d.toExponential(2)}`);
  if(pass)ok++;
}
console.log(`  ${ok}/${cases.length} anchors match`);
// EoT sample (proves the canonical firmware EoT — the one astro-fw.js diverges from)
console.log(`  firmware EoT @ 2024-06-21 12:00 = ${eot(1718971200).toFixed(4)} min  (astro-fw.js uses a DIFFERENT Spencer series)`);
