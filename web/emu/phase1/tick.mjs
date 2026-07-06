import factory from './fwtick.mjs';
const M=await factory();
const boot=M.cwrap('emu_boot','void',['number']), tick=M.cwrap('emu_tick','void',[]), now=M.cwrap('emu_now','number',[]);
const rowPtr=M.cwrap('emu_daterow','number',[]);
const cLut=[63,6,91,79,102,109,125,7,127,111];
const segB=M.cwrap('emu_seg_b','number',['number']), segC=M.cwrap('emu_seg_c','number',[]);
const seg2d=p=>{const i=cLut.indexOf(p&0x7f);return i<0?'-':i;};
const timeRow=()=>{const d=[];for(let i=0;i<5;i++)d.push(seg2d((segB(i)>>2)&0x7f));d.push(seg2d(segC()&0x7f));return `${d[0]}${d[1]}:${d[2]}${d[3]}:${d[4]}${d[5]}`;};
const dateRow=()=>{const p=rowPtr();let s='';for(let i=1;i<=10;i++){const c=M.HEAPU8[p+i];s+=c>=32&&c<127?String.fromCharCode(c):' ';}return s.trim();};

boot(1718971200);  // 2024-06-21 12:00:00 UTC
console.log('=== LIVE TICKING: real firmware SysTick handler @ 1kHz ===');
console.log(`  booted: currentTime=${now()}  timeRow=${timeRow()}  dateRow="${dateRow()}"`);
for(let sec=1; sec<=3; sec++){
  for(let ms=0; ms<1000; ms++) tick();   // 1000 SysTick calls = 1 second
  console.log(`  after ${sec}s of ticks: currentTime=${now()}  timeRow=${timeRow()}  dateRow="${dateRow()}"`);
}
