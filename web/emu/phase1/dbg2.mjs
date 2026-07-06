import factory from './fwdbg.mjs';
const M=await factory();
M.cwrap('emu_set_time','void',['number'])(946728000);
M.cwrap('emu_set_pos','void',['number','number'])(51.48,0);
M.cwrap('emu_enter_alt','void',['number'])(M.cwrap('emu_MODE_LST','number',[])());
M.cwrap('emu_alt_update','void',[])();   // let it throw with full stack
