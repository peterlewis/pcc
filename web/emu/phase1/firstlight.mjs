import factory from './fwapi.mjs';
const M = await factory();
const setTime = M.cwrap('emu_set_time','void',['number']);
const setMode = M.cwrap('emu_set_mode','void',['number']);
const prep    = M.cwrap('emu_prep','void',[]);
const sendD   = M.cwrap('emu_send_date','void',[]);
const rowPtr  = M.cwrap('emu_daterow','number',[]);

function dateRow(){ // read 11 bytes at [0..10]; [1..10] is the ASCII row
  const p = rowPtr(); let s='';
  for(let i=1;i<=10;i++){ const c=M.HEAPU8[p+i]; s += c>=32&&c<127? String.fromCharCode(c):'·'; }
  return s;
}
// MODE_ISO8601_STD = 0.  J2000 = 2000-01-01 12:00:00 UTC.
const cases = [
  [946728000, 0, 'ISO8601 @ J2000'],
  [1718971200, 0, 'ISO8601 @ 2024-06-21'],
  [0, 0, 'ISO8601 @ epoch'],
];
console.log('=== REAL firmware sendDate() running in WASM ===');
for(const [t,mode,label] of cases){
  setTime(t); setMode(mode); prep(); sendD();
  console.log(`  ${label.padEnd(24)} -> date row: "${dateRow()}"`);
}
