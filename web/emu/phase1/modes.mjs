import factory from './fwapi.mjs';
const M = await factory();
const setTime=M.cwrap('emu_set_time','void',['number']), setMode=M.cwrap('emu_set_mode','void',['number']);
const prep=M.cwrap('emu_prep','void',[]), sendD=M.cwrap('emu_send_date','void',[]), rowPtr=M.cwrap('emu_daterow','number',[]);
const row=()=>{const p=rowPtr();let s='';for(let i=1;i<=10;i++){const c=M.HEAPU8[p+i];s+=c>=32&&c<127?String.fromCharCode(c):'·';}return s.trimEnd();};
const t=1718971200; // 2024-06-21 12:00
for(const [m,name] of [[0,'ISO8601'],[3,'UNIX'],[1,'ISO_ORDINAL'],[8,'WEEKDAY']]){
  setTime(t); setMode(m); prep(); sendD();
  console.log(`  mode ${String(m).padStart(2)} ${name.padEnd(12)} -> "${row()}"`);
}
