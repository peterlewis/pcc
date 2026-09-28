// zone2_check.mjs — MODE_ZONE2, a second civil timezone as a live clock on the TIME row (the
// alternate-timebase family, beside MODE_LST / MODE_SOLAR), plus the u64 mode-mask widen that makes
// room for it (MODE_ZONE2 is ordinal 33 — past the old uint32 ceiling).
//
// Covers: (a) the honest blank — unset/unresolved zone2 dashes the time row, never a fake time;
// (b) the fixed-offset literal path (UTC / +HH:MM / -HH:MM), computed from GPS-disciplined UTC, so no
// FATFS needed; (c) the time row ticks with civil seconds; (d) the date row keeps the LOCAL civil date,
// even when the second zone is on another day, and the colons take colon_alt_mode so it never reads as
// local time; (e) leaving the mode restores the civil clock; (f) the u64 persistence round-trip:
// MODE_ZONE2's enable bit survives commit -> RAM wipe -> flash re-scan -> apply; (g) an IANA name
// resolved from the real /TZRULES.BIN by the next emu_poll, as the main loop's deferred loader does.
// Run: node zone2_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';
import { readFileSync } from 'node:fs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const cfg      = w('emu_config_line', 'void', ['string']);
const modeId   = w('emu_mode_id', 'number', ['string']);
const mode     = w('emu_mode', 'number');
const button1  = w('emu_button1');
const tick     = w('emu_tick');
const pendsv   = w('emu_pendsv');
const pendsvPending = w('emu_pendsv_pending', 'number');
const poll     = w('emu_poll');
const rowPtr   = w('emu_daterow', 'number');
const bufb     = w('emu_bufb', 'number', ['number']);
const bufcLo   = w('emu_bufc_low', 'number', ['number']);
const colon    = w('emu_colon_mode', 'number');
const colonAlt = w('emu_colon_alt', 'number');
const colonCiv = w('emu_colon_civil', 'number');
const setTz    = w('emu_set_tz_offset', 'void', ['number']);
// persistence store (same handles menu_persist_check uses)
const eeReset  = w('emu_ee_reset', 'void');
const eeLoad   = w('emu_ee_load', 'void');
const eeCommit = w('emu_ee_commit', 'number');
const eeApply  = w('emu_ee_apply', 'void');
const ovrClear = w('emu_ovr_clear', 'void');
const setMtime = w('emu_set_mtime', 'void', ['number', 'number']);
const recMode  = w('emu_record_mode', 'void', ['number', 'number']);
const modeEn   = w('emu_mode_enabled', 'number', ['number']);

const dateRow = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };
// The latched time row: buffer_b[0..4] = tens of hours .. tens of seconds (segments on bits 2..8),
// buffer_c[0].low = units of seconds (latchSegments). A dash is segment g alone.
const LUT = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
const digit = (v) => { const i = LUT.indexOf(v & 0x7f); return i >= 0 ? String(i) : ((v & 0x7f) === 64 ? '-' : '?'); };
const timeRow = () => { const d = [0, 1, 2, 3, 4].map((i) => digit(bufb(i) >> 2)); d.push(digit(bufcLo(0))); return `${d[0]}${d[1]}:${d[2]}${d[3]}:${d[4]}${d[5]}`; };
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };
const run = (ms) => { for (let i = 0; i < ms; i++) { tick(); if (pendsvPending()) pendsv(); poll(); } };   // SysTick, PendSV, main loop

const hhmmss = (sec) => { const s = ((sec % 86400) + 86400) % 86400; const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };
const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
// Boot at t with the local zone at UTC+tz, name the second zone, and switch to MODE_ZONE2 the way the
// clock does (enabling a mode in config requests it -> nextMode's transition seeds the alternate row).
const show = (t, zone, tz = 0) => { bootCold(t); setTz(tz); cfg(`zone2 = ${zone}`); cfg('MODE_ZONE2 = on'); poll(); };

const T = Date.UTC(2026, 6, 20, 12, 34, 56) / 1000;   // 2026-07-20 12:34:56 UTC
bootCold(T);
const MODE_ZONE2 = modeId('MODE_ZONE2');
check('MODE_ZONE2 exists and is ordinal 33 (past the old u32 ceiling)', MODE_ZONE2 === 33);
if (MODE_ZONE2 < 0) done();

// (a) honest blank — no zone2 configured: the time row dashes, the date row keeps the civil date.
show(T, '');
check(`entering the mode shows it (mode ${mode()})`, mode() === MODE_ZONE2);
check(`unset zone2 -> time row dashes ("${timeRow()}")`, timeRow() === '--:--:--');
check(`the date row keeps the civil date ("${dateRow()}")`, dateRow() === isoDate(T));

// (b) fixed literal +05:30 (India), local zone UTC.
const O2 = 5 * 3600 + 30 * 60;
show(T, '+05:30');
check(`+05:30 literal -> time row ${hhmmss(T + O2)} ("${timeRow()}")`, timeRow() === hhmmss(T + O2));
check(`colons take colon_alt_mode (colon ${colon()}, alt ${colonAlt()})`, colon() === colonAlt() && colonAlt() !== colonCiv());
// (c) it ticks with civil seconds
run(2000);
check(`ticks: 2 s later -> ${hhmmss(T + O2 + 2)} ("${timeRow()}")`, timeRow() === hhmmss(T + O2 + 2));

// negative offset -08:00 (US Pacific standard) and the UTC literal
show(T, '-08:00');
check(`-08:00 literal -> ${hhmmss(T - 8 * 3600)} ("${timeRow()}")`, timeRow() === hhmmss(T - 8 * 3600));
show(T, 'UTC', 3600);
check(`UTC literal with local UTC+1 -> ${hhmmss(T)} ("${timeRow()}")`, timeRow() === hhmmss(T));

// (d) the second zone is on the NEXT calendar day: 20:00 UTC + 5:30 = 01:30 on the 21st — the time row
//     shows the zone's clock, the date row stays the local (UTC) date.
const tPlus = Date.UTC(2026, 6, 20, 20, 0, 0) / 1000;
show(tPlus, '+05:30');
check(`next-day zone -> time row ${hhmmss(tPlus + O2)} ("${timeRow()}")`, timeRow() === hhmmss(tPlus + O2));
check(`... while the date row keeps the local date ${isoDate(tPlus)} ("${dateRow()}")`, dateRow() === isoDate(tPlus));

// empty value clears back to dashes within a second (honest), still in the mode
show(T, '+05:30'); cfg('zone2 = '); run(1100);
check(`zone2 = (empty) -> time row dashes again ("${timeRow()}")`, timeRow() === '--:--:--');

// (e) leaving the mode restores the civil clock and colons
cfg('MODE_ISO8601_STD = on'); show(T, '+05:30');
for (let k = 0; k < 40 && mode() !== 0; k++) button1();
run(1100);
check(`back on the civil clock -> ${hhmmss(T + 1)} ("${timeRow()}")`, timeRow() === hhmmss(T + 1) || timeRow() === hhmmss(T + 2));
check(`civil colons back (colon ${colon()}, civil ${colonCiv()})`, colon() === colonCiv());

// (f) THE u64 PROOF: MODE_ZONE2's enable bit (ordinal 33) round-trips through the widened ee record.
bootCold(T);
eeReset();
setMtime(0x5AA5, 0x1234);
recMode(MODE_ZONE2, 1);                 // firmware menu_record_key: ovr.modes_mask |= 1ull<<33
check('MODE_ZONE2 enabled live', modeEn(MODE_ZONE2) === 1);
check('commit writes the record', eeCommit() === 1);
recMode(MODE_ZONE2, 0);                 // scribble the live value off
ovrClear();                             // simulate RAM loss on reboot
eeLoad();                               // re-scan flash -> ee_unpack reads hi-word at byte 40/44
eeApply();                              // menu_apply_overrides: 1ull<<33 shift
check('MODE_ZONE2 bit-33 survived commit->wipe->reload->apply', modeEn(MODE_ZONE2) === 1);
// and a mode BELOW the ceiling still round-trips (no regression from the split)
recMode(4 /*MODE_JULIAN_DATE*/, 1); eeCommit(); ovrClear(); eeLoad(); eeApply();
check('a low-ordinal mode still round-trips (no widen regression)', modeEn(4) === 1 && modeEn(MODE_ZONE2) === 1);

// (g) an IANA name, the way config.txt's "zone2 = Europe/Madrid" reaches it on the clock: the parse
// defers it (dashes), and the next main-loop pass resolves it with the zone's own DST rules from the
// real /TZRULES.BIN (the file the CLOCK drive carries) — CEST (UTC+2) in July, CET (UTC+1) in January.
// That pass is plain emu_poll, the loop the app's driver runs, so the app's simulator shows it too.
{
  const reg = w('emu_register_file', 'void', ['string', 'number', 'number']);
  const checkDelayed = w('emu_check_delayed_rules');
  const tzOffset = w('emu_tz_offset', 'number');
  const rules = readFileSync(new URL('../tzrules.bin', import.meta.url));
  const ptr = M._malloc(rules.length); M.HEAPU8.set(rules, ptr); reg('/TZRULES.BIN', ptr, rules.length);
  const parse = (t, ...extra) => { bootCold(t); setTz(3600); for (const l of extra) cfg(l); cfg('zone2 = Europe/Madrid'); cfg('MODE_ZONE2 = on'); };
  const madrid = (t) => { parse(t); const pending = timeRow(); poll(); return [pending, timeRow(), dateRow()]; };
  const tSum = Date.UTC(2026, 6, 20, 12, 34, 56) / 1000, tWin = Date.UTC(2026, 0, 20, 12, 34, 56) / 1000;
  const [pending, summer, sumDate] = madrid(tSum);
  check(`Europe/Madrid: dashes while the name waits for the main loop ("${pending}")`, pending === '--:--:--');
  check(`... the next emu_poll resolves it: July -> CEST, UTC+2 ("${summer}" == "${hhmmss(tSum + 7200)}")`, summer === hhmmss(tSum + 7200));
  check(`... with the local date below ("${sumDate}")`, sumDate === isoDate(tSum + 3600));
  run(1000);
  check(`... and it ticks ("${timeRow()}" == "${hhmmss(tSum + 7201)}")`, timeRow() === hhmmss(tSum + 7201));
  const [, winter] = madrid(tWin);
  check(`Europe/Madrid in January -> CET, UTC+1 ("${winter}" == "${hhmmss(tWin + 3600)}")`, winter === hhmmss(tWin + 3600));

  // The main zone is the app's (emu_load_zone / emu_set_tz_offset): emu_poll holds a pending
  // ZONE_OVERRIDE back while zone2 resolves. The hold keeps it for the whole loader, and a cold boot
  // drops it, as power-on does.
  parse(tSum, 'ZONE_OVERRIDE = America/New_York'); run(1000);
  check(`a pending ZONE_OVERRIDE leaves the main zone alone (offset ${tzOffset()}) while zone2 resolves ("${timeRow()}")`, tzOffset() === 3600 && timeRow() === hhmmss(tSum + 7201));
  checkDelayed(); run(1000);
  check(`... held, not dropped: the whole loader still applies it (offset ${tzOffset()} == -14400)`, tzOffset() === -14400);
  parse(tSum, 'ZONE_OVERRIDE = America/New_York'); bootCold(tSum); setTz(3600); checkDelayed(); run(1000);
  check(`... and a cold boot drops a held override (offset ${tzOffset()} == 3600)`, tzOffset() === 3600);
}

done();
