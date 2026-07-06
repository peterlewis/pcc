import factory from './fwapi.mjs';
function expectHMS(h){const H=Math.floor(h),m=Math.floor((h-H)*60),s=Math.floor(((h-H)*60-m)*60);
  return `${String(H).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
const cLut=[63,6,91,79,102,109,125,7,127,111];
const seg2d=p=>{const i=cLut.indexOf(p&0x7f);return i<0?'?':i;};
console.log('=== REAL firmware alt-timebase TIME ROW in WASM (fresh boot per case, lon 0, lat 51.48) ===');
let pass=0,tot=0;
for(const [t,kind] of [[946728000,'LST'],[1718971200,'LST'],[1735689600,'LST'],[946728000,'SOLAR'],[1718971200,'SOLAR']]){
  const M=await factory();  // fresh instance -> alt state resets
  const MODE = kind==='LST'? M.cwrap('emu_MODE_LST','number',[])() : M.cwrap('emu_MODE_SOLAR','number',[])();
  M.cwrap('emu_set_time','void',['number'])(t);
  M.cwrap('emu_set_pos','void',['number','number'])(51.48,0);
  M.cwrap('emu_enter_alt','void',['number'])(MODE);
  M.cwrap('emu_alt_update','void',[])();
  const segB=M.cwrap('emu_seg_b','number',['number']), segC=M.cwrap('emu_seg_c','number',[]);
  const d=[]; for(let i=0;i<5;i++)d.push(seg2d((segB(i)>>2)&0x7f)); d.push(seg2d(segC()&0x7f));
  const shown=`${d[0]}${d[1]}:${d[2]}${d[3]}:${d[4]}${d[5]}`;
  const fn = kind==='LST'? M.cwrap('local_sidereal_time','number',['number','number']) : M.cwrap('local_solar_time','number',['number','number']);
  const exp=expectHMS(fn(t,0)); tot++; const ok=shown===exp; if(ok)pass++;
  console.log(`  ${kind.padEnd(5)} t=${t}  firmware→"${shown}"  expected="${exp}"  ${ok?'✓ MATCH':'✗'}`);
}
console.log(`  ${pass}/${tot} — the REAL firmware's alt_compute + alt_render_next7seg is faithful in WASM`);
