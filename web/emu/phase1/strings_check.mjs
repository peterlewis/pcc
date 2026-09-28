// strings_check.mjs — every string the emulator hands back must decode in a browser, not only in node.
//
// Chromium's TextDecoder refuses a view onto a resizable ArrayBuffer; node's accepts one. emscripten
// 6.0.2 defaults GROWABLE_ARRAYBUFFERS to 1, which puts a growable heap on memory.toResizableBuffer(),
// but it still decodes any string over 16 bytes from a HEAPU8.subarray(). So the app's simulator threw
// on every $PMSTAR while every node suite passed, and build.sh now links with GROWABLE_ARRAYBUFFERS=0.
// This check installs a Chromium-strict TextDecoder before the module loads, then reads long strings
// back (the TextDecoder path) before and after the heap grows.
// Run: node strings_check.mjs   (from phase1/, after build.sh)
import { readFileSync } from 'node:fs';

const NodeDecoder = globalThis.TextDecoder;
globalThis.TextDecoder = class extends NodeDecoder {
  decode(input, options) {
    if (input?.buffer?.resizable || input?.resizable)
      throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBuffer value must not be resizable");
    return super.decode(input, options);
  }
};
const { default: factory } = await import('../clock-fw.mjs');

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold    = w('emu_boot_cold', 'void', ['number']);
const setPos      = w('emu_set_pos', 'void', ['number', 'number']);
const reg         = w('emu_register_file', 'void', ['string', 'number', 'number']);
const maxMag      = w('emu_star_max_mag', 'void', ['number']);
const loadStars   = w('emu_load_stars');
const starLine    = w('emu_star_line', 'string');
const pps         = w('emu_pps');
const pmtxtsLine  = w('emu_pmtxts_line', 'string');
const zoneFromPos = w('emu_zone_from_pos', 'string', ['number', 'number']);

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };
// the app's registerFile: copy the bytes into the wasm heap and hand the firmware's FATFS shim the pointer
const file = (name, rel) => { const b = readFileSync(new URL(rel, import.meta.url)); const p = M._malloc(b.length); M.HEAPU8.set(b, p); reg(name, p, b.length); };
const decodes = (label, fn, ok) => {
  let s, err = null;
  try { s = fn(); } catch (e) { err = e; }
  check(err ? `${label}: threw "${err.message}"` : `${label}: "${s.trim().slice(0, 60)}"`, !err && ok(s));
};

check(`the heap is not on a resizable buffer (resizable=${M.HEAPU8.buffer.resizable})`, M.HEAPU8.buffer.resizable !== true);

bootCold(1750000000);
file('/STARS.BIN', '../stars.bin'); maxMag(6.0); loadStars(); setPos(20, 0);
decodes('$PMSTAR, which the app reads every simulated second', starLine, (s) => /^\$PMSTAR,[1-9]/.test(s) && s.length > 16);
pps();
decodes('$PMTXTS after a PPS edge', pmtxtsLine, (s) => s.startsWith('$PMTXTS,') && s.length > 16);

// The zone files the app loads for a manually entered position (12 MB /TZMAP.BIN via malloc).
file('/TZRULES.BIN', '../tzrules.bin'); file('/TZMAP.BIN', '../tzmap.bin');
decodes('a long zone name from ZoneDetect (Buenos Aires)', () => zoneFromPos(-34.6037, -58.3816), (s) => s === 'America/Argentina/Buenos_Aires');

// Those all fit the initial heap, so force a growth: the views are rebuilt, and strings must still
// decode from them.
const before = M.HEAPU8.length;
const big = M._malloc(32 << 20);
check(`a 32 MB malloc grows the heap (${before} -> ${M.HEAPU8.length} bytes)`, big !== 0 && M.HEAPU8.length > before);
decodes('$PMSTAR after the growth', starLine, (s) => /^\$PMSTAR,[1-9]/.test(s));
decodes('the zone name after the growth', () => zoneFromPos(-34.6037, -58.3816), (s) => s === 'America/Argentina/Buenos_Aires');

done();
