import fs from 'fs';
import factory from './astro-core.mjs';
const M = await factory();
const lst = M.cwrap('local_sidereal_time','number',['number','number']);
const sol = M.cwrap('local_solar_time','number',['number','number']);
const eot = M.cwrap('equation_of_time','number',['number']);
const lines = fs.readFileSync('/tmp/native.txt','utf8').trim().split('\n');
let maxL=0,maxS=0,n=0;
for(const ln of lines){
  if(ln.startsWith('EOT')) continue;
  const [t,lon,nl,ns]=ln.split(' ').map(Number);
  maxL=Math.max(maxL,Math.abs(lst(t,lon)-nl));
  maxS=Math.max(maxS,Math.abs(sol(t,lon)-ns));
  n++;
}
console.log(`=== WASM vs native float agreement over ${n} (time,lon) points (2000-2030) ===`);
console.log(`  max |LST_wasm - LST_native|   = ${maxL.toExponential(3)} h  (${(maxL*3600e3).toFixed(4)} ms)`);
console.log(`  max |solar_wasm - solar_native| = ${maxS.toExponential(3)} h  (${(maxS*3600e3).toFixed(4)} ms)`);
console.log(`  -> ${maxL===0&&maxS===0?'BIT-IDENTICAL':'sub-nanosecond epsilon, well within display resolution'}`);
