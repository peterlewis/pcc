// Headless proof of the Phase-2 virtual-GPS path: cold boot -> acquiring -> fix+PPS -> locked.
import factory from '../clock-fw.mjs';
import { VirtualGPS } from '../sim-gps.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const emu = {
  bootCold: w('emu_boot_cold', 'void', ['number']),
  tick: w('emu_tick'), now: w('emu_now', 'number'),
  feedNmea: w('emu_feed_nmea', 'void', ['string']),
  pps: w('emu_pps'), pendsv: w('emu_pendsv'),
  pendsvPending: w('emu_pendsv_pending', 'number'),
  flags: w('emu_flags', 'number'), hadPps: w('emu_had_pps', 'number'),
  sincePps: w('emu_since_pps', 'number'), satcount: w('emu_satcount', 'number'),
  enable: w('emu_enable_mode', 'void', ['number']),
  bufb: w('emu_bufb', 'number', ['number']), bufcLo: w('emu_bufc_low', 'number', ['number']),
  bufcHi: w('emu_bufc_high', 'number', ['number']),
};

// decode the big time row the way the clockface does
const LUT = [0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f];
const dig = (b) => { const p = b & 0x7f; if (p===0) return ' '; if (p===0b1000000) return '-';
  const d = LUT.indexOf(p); return d<0?'-':d; };
function bigtime() {
  const h = `${dig(emu.bufb(0)>>2)}${dig(emu.bufb(1)>>2)}`;
  const m = `${dig(emu.bufb(2)>>2)}${dig(emu.bufb(3)>>2)}`;
  const s = `${dig(emu.bufb(4)>>2)}${dig(emu.bufcLo(0))}`;
  const sub = `${dig(emu.bufcLo(1))}${dig(emu.bufcLo(2))}${dig(emu.bufcLo(3))}`;
  const dp = (emu.bufcHi(0) & 0x10) ? '.' : ' ';
  return `${h}:${m}:${s}${dp}${sub}`;
}

const base = Math.floor(Date.parse('2026-07-05T13:20:00Z') / 1000);
emu.bootCold(base);
emu.enable(0);
const gps = new VirtualGPS(emu, { acquireSec: 6 });

// run 12 simulated seconds at 1 kHz, advancing the sim in 1 ms steps
const step = 0.001;                          // 1 ms
for (let ms = 0; ms < 12000; ms++) {
  emu.tick();
  if (gps.pendsvPending?.()) {}              // (drained inside advance)
  const wall = new Date((base + gps.elapsed) * 1000);
  gps.advance(step, wall);
  if (ms % 1000 === 0 || ms === 6300) {
    const fl = emu.flags();
    console.log(
      `t=${(ms/1000).toFixed(2)}s  state=${gps.state.padEnd(9)} sats=${emu.satcount()}` +
      `  flags[v${fl&1} p${(fl>>1)&1} r${(fl>>2)&1}]  sincePPS=${emu.hadPps()?emu.sincePps():'--'}` +
      `  disp=${bigtime()}  now=${emu.now()}`);
  }
}
