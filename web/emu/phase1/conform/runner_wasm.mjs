// WASM twin of runner_native.c: drives the emcc-built emulator (clock-fw.mjs) with the IDENTICAL
// line-oriented stdin event-script and emits byte-identical SNAP lines. A `diff native.snap
// wasm.snap` of the two traces is the Tier-3b conformance proof: the emcc WASM port produces
// bit-for-bit the same firmware state as a native clang build of the same shimmed main_wrap.c.
//
// Every formatting detail here mirrors runner_native.c snap() EXACTLY (printf %04x/%02x/%d/%u,
// the fixed 10-char date row with non-printable -> '.'), and the verb parser mirrors its main().
import { loadEmu } from './harness.mjs';

const emu = await loadEmu();
const M = emu.M;

const hex = (v, w) => (v >>> 0).toString(16).padStart(w, '0');   // %0<w>x, lowercase, unsigned

// Byte-identical to runner_native.c snap(): SNAP <label>, 5x bufb %04x, 4x bufc_low %02x,
// 4x bufc_high %02x, then m%d f%u t%u "<10 printable date chars>".
function snap(label) {
  const p = emu.daterow();
  let date = '';
  for (let i = 0; i < 10; i++) { const c = M.HEAPU8[p + 1 + i]; date += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.'; }
  let out = 'SNAP ' + label;
  for (let i = 0; i < 5; i++) out += ' ' + hex(emu.bufb(i) & 0xffff, 4);
  for (let i = 0; i < 4; i++) out += ' ' + hex(emu.bufcLo(i) & 0xff, 2);
  for (let i = 0; i < 4; i++) out += ' ' + hex(emu.bufcHi(i) & 0xff, 2);
  out += ' m' + (emu.mode() | 0) + ' f' + (emu.flags() >>> 0) + ' t' + (emu.now() >>> 0) + ' "' + date + '"';
  process.stdout.write(out + '\n');
}

// one SysTick tick + drain the PendSV the firmware may have requested (as the frame loop does)
const tickdrain = () => { emu.tick(); if (emu.pendsvPending()) emu.pendsv(); };

// slurp all of stdin, then process line by line (matches runner_native.c fgets loop)
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString('utf8');

for (const raw of text.split('\n')) {
  const line = raw.replace(/[\r\n]+$/, '');
  if (line.length === 0 || line[0] === '#') continue;      // blank / comment
  const sp = line.indexOf(' ');
  const verb = sp < 0 ? line : line.slice(0, sp);
  const arg  = sp < 0 ? '' : line.slice(sp + 1);           // everything after the FIRST space
  switch (verb) {
    case 'bootcold': emu.bootCold(parseInt(arg, 10) >>> 0); break;
    case 'boot':     emu.boot(parseInt(arg, 10) >>> 0); break;
    case 'enable':   emu.enable(parseInt(arg, 10) | 0); break;
    case 'setadc':   emu.setAdc(parseInt(arg, 10) >>> 0); break;
    case 'setpos':   { const [la, lo] = arg.trim().split(/\s+/).map(Number); emu.setPos(la, lo); break; }
    case 'tick':     { let n = parseInt(arg, 10); while (n-- > 0) tickdrain(); break; }
    case 'pps':      { emu.pps(); if (emu.pendsvPending()) emu.pendsv(); break; }
    case 'pendsv':   emu.pendsv(); break;
    case 'poll':     emu.poll(); break;
    case 'nmea':     emu.feedNmea(arg); break;
    case 'b1':       { emu.button1(); if (emu.pendsvPending()) emu.pendsv(); break; }
    case 'b2':       { emu.button2(); if (emu.pendsvPending()) emu.pendsv(); break; }
    case 'snap':     snap(arg); break;
    default:         process.stderr.write('unknown: ' + verb + '\n');
  }
}
