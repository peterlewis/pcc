import factory from '../clock-fw.mjs';
const M=await factory(); const w=(n,r='void',a=[])=>M.cwrap(n,r,a);
const boot=w('emu_boot','void',['number']),tick=w('emu_tick'),poll=w('emu_poll'),now=w('emu_now','number');
const b1=w('emu_button1'),en=w('emu_enable_mode','void',['number']),setpos=w('emu_set_pos','void',['number','number']);
const mode=w('emu_mode','number'),LST=w('emu_MODE_LST','number')(),SOL=w('emu_MODE_SOLAR','number')();
const bufb=w('emu_bufb','number',['number']),bufcLo=w('emu_bufc_low','number',['number']);
const LUT=[63,6,91,79,102,109,125,7,127,111],dec=b=>{const p=b&0x7f;if(p===0)return'_';if(p===64)return'-';const d=LUT.indexOf(p);return d<0?'?':d;};
const row=()=>[dec(bufb(0)>>2),dec(bufb(1)>>2),dec(bufb(2)>>2),dec(bufb(3)>>2),dec(bufb(4)>>2),dec(bufcLo(0))].join('');
boot(1718971200); setpos(51.48,0); en(0); en(LST); en(SOL);
console.log('civil  mode='+mode()+' row='+row());
b1(); poll(); for(let i=0;i<1000;i++)tick(); poll();       // cycle to next enabled mode (LST)
console.log('after b1: mode='+mode()+' (LST='+LST+') row='+row());
b1(); poll(); for(let i=0;i<1000;i++)tick(); poll();       // cycle to SOLAR
console.log('after b1: mode='+mode()+' (SOLAR='+SOL+') row='+row());
