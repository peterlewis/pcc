// dark_check.mjs — MODE_DARK, the observing-session twilight ladder: civil/nautical/astronomical dusk
// times + a live countdown to astronomical darkness. Wires up sun_times()'s twilight tiers (previously
// dead, passed NULL) and adds the -18 deg astronomical tier + dawn-by-symmetry.
//
// Covers: (a) MODE_DARK is ordinal 27 — it moved down into the astro block when the mode was reflowed
// into the astro-pack tier, so it no longer needs the u64 mask; (b) the physical ordering sunset < civil <
// nautical < astronomical dusk (the sun sinks deeper, each tier later in the evening); (c) astronomical
// dawn is the mirror of dusk about solar noon; (d) the render pages + honest dashes; (e) high-latitude
// white nights that never reach -18 report NO DARK and dash the astronomical pages; (f) no fix -> dashes;
// (g) the countdown headline flips DARK (to dusk) <-> DAWN (to end of dark) with the dark window.
// Run: node dark_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const setPos   = w('emu_set_pos', 'void', ['number', 'number']);
const setTz    = w('emu_set_tz_offset', 'void', ['number']);
const cfg      = w('emu_config_line', 'void', ['string']);
const renderM  = w('emu_render_mode', 'void', ['number']);
const poll     = w('emu_poll', 'void');
const tick     = w('emu_tick', 'void');
const modeId   = w('emu_mode_id', 'number', ['string']);
const rowPtr   = w('emu_daterow', 'number');
const setMin   = w('emu_astro_set', 'number');
const noonMin  = w('emu_astro_noon', 'number');
const civMin   = w('emu_dark_civ', 'number');
const nauMin   = w('emu_dark_nau', 'number');
const astDusk  = w('emu_dark_ast_dusk', 'number');
const astDawn  = w('emu_dark_ast_dawn', 'number');
const darkFlags= w('emu_dark_flags', 'number');

const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };
const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };

const MODE_DARK = modeId('MODE_DARK');
const setup = (t, lat, lon) => { bootCold(t); setTz(0); setPos(lat, lon); cfg('page_ms = 250'); renderM(MODE_DARK); poll(); };
const pages = () => { const seen = new Set(); for (let k = 0; k < 1600; k++) { tick(); if (k % 60 === 0) { renderM(MODE_DARK); seen.add(row()); } } return [...seen]; };

check('MODE_DARK exists and is ordinal 27', MODE_DARK === 27);
if (MODE_DARK < 0) done();

// (b)+(c) Winter, London (51.5 N, 0 E), an evening in late December -> deep, unambiguous night.
setup(Date.UTC(2025, 11, 21, 20, 0, 0) / 1000, 51.5, 0.0);
const [set_, civ, nau, ad, aw, noon, flags] = [setMin(), civMin(), nauMin(), astDusk(), astDawn(), noonMin(), darkFlags()];
check(`winter London has a fix (set=${set_})`, set_ >= 0 && ad >= 0);
check(`ordering sunset<civil<nautical<astro dusk (${set_}<${civ}<${nau}<${ad})`, set_ < civ && civ < nau && nau < ad);
check('astronomical dark occurs (dark_tonight flag)', (flags & 1) === 1 && (flags & 2) === 0);
// dawn is the mirror of dusk about solar noon: dusk + dawn == 2*noon (mod 1440), within rounding.
const sym = ((ad + aw) - 2 * noon) % 1440;
check(`astro dawn mirrors dusk about noon (dusk ${ad} + dawn ${aw} ~= 2*noon ${2 * noon})`, Math.abs(sym) <= 2 || Math.abs(sym) >= 1438);

// (d) render pages carry the ladder with HH.MM, MODE_SUN-style: 4-wide label + " HH.MM".
const P = pages();
const lbl = (s) => (s + '    ').slice(0, 4);                       // firmware's %-4.4s
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}.${String(m % 60).padStart(2, '0')}`;
const page = (s, m) => `${lbl(s)} ${fmt(m)}`;                       // e.g. "AST  23.57", "End  05.59"
check(`AST page shows the astronomical dusk time ("${page('AST', ad)}")`, P.includes(page('AST', ad)));
check(`End page shows the astronomical dawn time ("${page('End', aw)}")`, P.includes(page('End', aw)));
check(`CIV + NAU ladder pages present`, P.some(r => r.startsWith('CIV ')) && P.some(r => r.startsWith('NAU ')));

// (d2) THE ALIGNMENT REQUIREMENT: on every page carrying a HH.MM (headline countdown + ladder times),
// the digits start in the SAME column and the decimal point lines up — no hyphen shifting the countdown.
const timed = P.filter(r => /^[A-Za-z]{2,4} +\d\d\.\d\d$/.test(r));
const dotCols = [...new Set(timed.map(r => r.indexOf('.')))];
const numCols = [...new Set(timed.map(r => r.search(/\d\d\.\d\d$/)))];
check(`>=3 timed pages to compare (${timed.length}: ${timed.join(' | ')})`, timed.length >= 3);
check(`all HH.MM digits start in one column (col ${numCols})`, numCols.length === 1);
check(`all decimal points align (col ${dotCols})`, dotCols.length === 1);
check(`no hyphen anywhere in the paged output`, !P.some(r => r.includes('-')));

// (g) countdown headline direction (label carries it now — no hyphen). In darkness -> "DAWN HH.MM".
check(`in-dark headline counts to DAWN ("${P.find(r => /^DAWN \d/.test(r))}")`, P.some(r => /^DAWN \d\d\.\d\d$/.test(r)));
// midday -> before dusk -> counting to DARK: "DARK HH.MM".
const Pd = (setup(Date.UTC(2025, 11, 21, 12, 0, 0) / 1000, 51.5, 0.0), pages());
check(`daytime headline counts to DARK ("${Pd.find(r => /^DARK \d/.test(r))}")`, Pd.some(r => /^DARK \d\d\.\d\d$/.test(r)));

// (e) Arctic summer (68 N), around the June solstice -> the sun never reaches -18 -> NO astronomical dark.
setup(Date.UTC(2026, 5, 21, 12, 0, 0) / 1000, 68.0, 20.0);
check(`arctic summer: no astronomical dark (flags=${darkFlags()})`, (darkFlags() & 1) === 0);
check('arctic summer: astronomical pages dashed', astDusk() < 0 && astDawn() < 0);
const PA = pages();
check(`arctic summer headline says NO DARK ("${PA.find(r => r.includes('DARK'))}")`, PA.includes('NO DARK'));
check('arctic summer AST/End pages dashed', PA.includes('AST  ----') && PA.includes('End  ----'));

// (f) no fix -> dashes, never a fabricated time.
setup(Date.UTC(2025, 11, 21, 20, 0, 0) / 1000, -9999, -9999);
renderM(MODE_DARK);
check(`no fix -> "DARK  ----" ("${row()}")`, row().includes('----'));

done();
