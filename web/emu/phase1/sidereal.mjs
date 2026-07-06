import factory from './fwapi.mjs';
const M = await factory();
const setTime=M.cwrap('emu_set_time','void',['number']);
const setPos=M.cwrap('emu_set_pos','void',['number','number']);
const enterAlt=M.cwrap('emu_enter_alt','void',['number']);
const altUpd=M.cwrap('emu_alt_update','void',[]);
const segB=M.cwrap('emu_seg_b','number',['number']);
const segC=M.cwrap('emu_seg_c','number',[]);
const MODE_LST=M.cwrap('emu_MODE_LST','number',[])();
const MODE_SOLAR=M.cwrap('emu_MODE_SOLAR','number',[])();
const lst=M.cwrap('local_sidereal_time','number',['number','number']);
const sol=M.cwrap('local_solar_time','number',['number','number']);

// cLut 7-seg patterns for digits 0-9 (firmware cSegDecode0..9 == clockface LUT_TIME)
const cLut=[63,6,91,79,102,109,125,7,127,111];
const seg2digit=p=>{const i=cLut.indexOf(p&0x7f); return i<0?'?':i;};
// decode next7seg time row: b[0..4] are tenHours,hours,tenMins,mins,tenSecs; .c = seconds units
function decodeTimeRow(){
  const d=[];
  for(let i=0;i<5;i++){ d.push(seg2digit((segB(i)>>2)&0x7f)); }
  d.push(seg2digit(segC()&0x7f));
  // order per setNextTimestamp: b[0]=tenHours b[1]=hours b[2]=tenMin b[3]=min b[4]=tenSec c=sec
  return `${d[0]}${d[1]}:${d[2]}${d[3]}:${d[4]}${d[5]}`;
}
function expectHMS(hours){ let h=Math.floor(hours),m=Math.floor((hours-h)*60),s=Math.floor(((hours-h)*60-m)*60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }

console.log('=== REAL firmware sidereal/solar TIME ROW in WASM (Greenwich, lon 0) ===');
const lon=0, lat=51.48;
for(const t of [946728000, 1718971200, 1735689600]){
  setTime(t); setPos(lat,lon); enterAlt(MODE_LST); altUpd();
  const shown=decodeTimeRow(), exp=expectHMS(lst(t,lon));
  console.log(`  LST   t=${t}  firmware row="${shown}"  expected="${exp}"  ${shown===exp?'MATCH':'diff'}`);
  setTime(t); enterAlt(MODE_SOLAR); altUpd();
  const shownS=decodeTimeRow(), expS=expectHMS(sol(t,lon));
  console.log(`  SOLAR t=${t}  firmware row="${shownS}"  expected="${expS}"  ${shownS===expS?'MATCH':'diff'}`);
}
