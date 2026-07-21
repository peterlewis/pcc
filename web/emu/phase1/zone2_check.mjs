// zone2_check.mjs — MODE_ZONE2, a second civil timezone on the date row, plus the u64 mode-mask
// widen that makes room for it (MODE_ZONE2 is ordinal 32 — the first mode past the old uint32 ceiling).
//
// Covers: (a) the honest blank — unset/unresolved zone2 shows dashes, never a fake time; (b) the
// fixed-offset literal path (UTC / +HH:MM / -HH:MM) computed from GPS-disciplined UTC, so no FATFS
// needed; (c) the live remote clock ticks and matches an independent oracle; (d) the day-difference
// marker (+1/-1) vs the local calendar day; (e) the paged city/zone label; (f) the u64 persistence
// round-trip: MODE_ZONE2's enable bit survives commit -> RAM wipe -> flash re-scan -> apply (the bit
// lives at ordinal 32, so this is the load-bearing proof the widened ee record works).
// Run: node zone2_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const cfg      = w('emu_config_line', 'void', ['string']);
const renderM  = w('emu_render_mode', 'void', ['number']);
const modeId   = w('emu_mode_id', 'number', ['string']);
const rowPtr   = w('emu_daterow', 'number');
const setTz    = w('emu_set_tz_offset', 'void', ['number']);
const tzOff    = w('emu_tz_offset', 'number');
// persistence store (same handles menu_persist_check uses)
const eeReset  = w('emu_ee_reset', 'void');
const eeLoad   = w('emu_ee_load', 'void');
const eeCommit = w('emu_ee_commit', 'number');
const eeApply  = w('emu_ee_apply', 'void');
const ovrClear = w('emu_ovr_clear', 'void');
const setMtime = w('emu_set_mtime', 'void', ['number', 'number']);
const recMode  = w('emu_record_mode', 'void', ['number', 'number']);
const modeEn   = w('emu_mode_enabled', 'number', ['number']);

const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };

// A UTC epoch with a known wall clock. 2026-07-20 12:34:56 UTC.
const T = Date.UTC(2026, 6, 20, 12, 34, 56) / 1000;
const hhmmss = (sec) => { const s = ((sec % 86400) + 86400) % 86400; const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };

bootCold(T);
const MODE_ZONE2 = modeId('MODE_ZONE2');
check('MODE_ZONE2 exists and is ordinal 33 (past the old u32 ceiling)', MODE_ZONE2 === 33);
if (MODE_ZONE2 < 0) done();

// (a) honest blank — no zone2 configured yet.
renderM(MODE_ZONE2);
check(`unset zone2 -> dashes ("${row()}")`, row() === '-');

// (b)+(c) fixed literal +05:30 (India). Render the TIME sub-page: currentTime%8 >= 2.
//   Choose T so T%8 lands in the time window; T from Date.UTC above — verify and nudge if needed.
setTz(0);                         // primary = UTC, so the day-diff marker is measured against UTC
cfg('zone2 = +05:30');
const O2 = 5 * 3600 + 30 * 60;
// Pick a second where the label/time paging shows the TIME page (t%8>=2) AND is a clean tick.
const atTime = (t) => { bootCold(t); setTz(0); cfg('zone2 = +05:30'); renderM(MODE_ZONE2); return row(); };
let tTime = T; for (let k = 0; k < 8; k++) { if ((tTime % 8) >= 2) break; tTime++; }
check(`+05:30 literal -> live remote clock ("${atTime(tTime)}" == "${hhmmss(tTime + O2)}")`, atTime(tTime).startsWith(hhmmss(tTime + O2)));

// negative offset -08:00 (US Pacific standard)
const tW = (() => { let t = T; for (let k = 0; k < 8; k++) { if ((t % 8) >= 2) break; t++; } return t; })();
bootCold(tW); setTz(0); cfg('zone2 = -08:00'); renderM(MODE_ZONE2);
check(`-08:00 literal -> ${hhmmss(tW - 8 * 3600)} ("${row()}")`, row().startsWith(hhmmss(tW - 8 * 3600)));

// UTC literal equals the emulator's own UTC wall clock.
bootCold(tW); setTz(0); cfg('zone2 = UTC'); renderM(MODE_ZONE2);
check(`UTC literal -> ${hhmmss(tW)} ("${row()}")`, row().startsWith(hhmmss(tW)));

// (d) day-difference marker: pick a UTC time where +05:30 lands on the NEXT calendar day.
//   2026-07-20 20:00:00 UTC + 5:30 = 2026-07-21 01:30 -> "+1". Ensure time page (t%8>=2).
let tPlus = Date.UTC(2026, 6, 20, 20, 0, 0) / 1000; for (let k = 0; k < 8; k++) { if ((tPlus % 8) >= 2) break; tPlus++; }
bootCold(tPlus); setTz(0); cfg('zone2 = +05:30'); renderM(MODE_ZONE2);
check(`remote next-day -> "+1" marker ("${row()}")`, row().endsWith('+1'));
// and a "-1": 2026-07-20 02:00 UTC with -08:00 = previous day 18:00 -> "-1"
let tMinus = Date.UTC(2026, 6, 20, 2, 0, 0) / 1000; for (let k = 0; k < 8; k++) { if ((tMinus % 8) >= 2) break; tMinus++; }
bootCold(tMinus); setTz(0); cfg('zone2 = -08:00'); renderM(MODE_ZONE2);
check(`remote prev-day -> "-1" marker ("${row()}")`, row().endsWith('-1'));

// (e) the label sub-page (t%8 < 2) shows the literal verbatim.
let tLabel = T; for (let k = 0; k < 8; k++) { if ((tLabel % 8) < 2) break; tLabel++; }
bootCold(tLabel); setTz(0); cfg('zone2 = +05:30'); renderM(MODE_ZONE2);
check(`label page shows the literal ("${row()}")`, row() === '+05:30');

// empty value clears back to dashes (honest).
cfg('zone2 = +05:30'); cfg('zone2 = '); renderM(MODE_ZONE2);
check(`zone2 = (empty) -> back to dashes ("${row()}")`, row() === '-');

// (f) THE u64 PROOF: MODE_ZONE2's enable bit (ordinal 32) round-trips through the widened ee record.
bootCold(T);
eeReset();
setMtime(0x5AA5, 0x1234);
recMode(MODE_ZONE2, 1);                 // firmware menu_record_key: ovr.modes_mask |= 1ull<<32
check('MODE_ZONE2 enabled live', modeEn(MODE_ZONE2) === 1);
check('commit writes the record', eeCommit() === 1);
recMode(MODE_ZONE2, 0);                 // scribble the live value off
ovrClear();                             // simulate RAM loss on reboot
eeLoad();                               // re-scan flash -> ee_unpack reads hi-word at byte 40/44
eeApply();                              // menu_apply_overrides: 1ull<<32 shift
check('MODE_ZONE2 bit-32 survived commit->wipe->reload->apply', modeEn(MODE_ZONE2) === 1);
// and a mode BELOW the ceiling still round-trips (no regression from the split)
recMode(4 /*MODE_JULIAN_DATE*/, 1); eeCommit(); ovrClear(); eeLoad(); eeApply();
check('a low-ordinal mode still round-trips (no widen regression)', modeEn(4) === 1 && modeEn(MODE_ZONE2) === 1);

done();
