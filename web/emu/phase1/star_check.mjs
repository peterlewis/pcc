// star_check.mjs — the bright-star meridian-transit predictor, now loading its catalogue from the SD
// /STARS.BIN (generate-stars.py, HYG v4) via the firmware's OWN loadStars(), with a baked fallback.
//
// Covers: (a) the fallback — with no card, loadStars() falls back to the baked bright set; (b) the SD
// path — register the real stars.bin, loadStars() parses it, and the count/first-star/coords match the
// file; (c) the star_max_mag load-filter early-stops the mag-sorted file; (d) the transit maths — an
// independent double-precision oracle reading the LOADED catalogue (emu_star_ra/dec) + LST matches the
// $PMSTAR sentence (precession, sidereal->solar, altitude, soonest-8 selection, framing, render).
// Run: node star_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';
import { readFileSync } from 'node:fs';

const M = await factory();
const w = (n, r = 'number', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const setPos   = w('emu_set_pos',   'void', ['number', 'number']);
const lstF     = w('emu_lst',       'number', ['number', 'number']);
const starLine = w('emu_star_line', 'string');
const nStar    = w('emu_star_count','number');
const raF      = w('emu_star_ra',   'number', ['number']);
const decF     = w('emu_star_dec',  'number', ['number']);
const nameF    = w('emu_star_name', 'string', ['number']);
const loadStars= w('emu_load_stars','void');
const maxMag   = w('emu_star_max_mag','void', ['number']);
const regFile  = w('emu_register_file','void', ['number','number','number']);
const renderM  = w('emu_render_mode','void', ['number']);
const rowPtr   = w('emu_daterow',   'number');
const MODE_STAR = w('emu_MODE_STAR','number')();
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };

const J2000 = 946728000.0, SIDSEC = 3590.1704, D2R = Math.PI / 180;
const T = 1750000000, LAT = 20.0, LON = 0.0;

bootCold(T);
if (MODE_STAR < 0) { console.log('SKIP — firmware has no star-transit engine'); process.exit(0); }

// (a) fallback: no /STARS.BIN registered -> loadStars() uses the baked default bright set.
loadStars();
const nDefault = nStar();
check(`fallback: no card -> baked default loaded (${nDefault} stars)`, nDefault >= 20 && nDefault <= 40);
check(`fallback: first star has a name ("${nameF(0)}")`, /^[A-Z]/.test(nameF(0)));

// (b) SD path: register the REAL stars.bin and load it through the firmware's loadStars().
const bin = readFileSync(new URL('../firmware/qspi/output/stars.bin', import.meta.url));
const ptr = M._malloc(bin.length); M.HEAPU8.set(bin, ptr);
regFile(M.stringToNewUTF8 ? M.stringToNewUTF8('/STARS.BIN') : (() => { const s='/STARS.BIN'; const p=M._malloc(s.length+1); for(let i=0;i<s.length;i++)M.HEAPU8[p+i]=s.charCodeAt(i); M.HEAPU8[p+s.length]=0; return p; })(), ptr, bin.length);
const fileCount = (bin[4] | (bin[5] << 8));   // header count field
maxMag(6.0); loadStars();
check(`SD: loadStars() parsed stars.bin (${nStar()} == file's ${fileCount})`, nStar() === fileCount);
check(`SD: first star is the brightest, Sirius "${nameF(0)}"`, nameF(0) === 'SIRI');
check(`SD: Sirius coords ra~6.75h dec~-16.7 (ra=${raF(0).toFixed(3)} dec=${decF(0).toFixed(2)})`,
      Math.abs(raF(0) - 6.7526) < 0.01 && Math.abs(decF(0) + 16.72) < 0.05);

// (c) star_max_mag load-filter: only stars brighter than the cut load (file is mag-sorted -> early stop).
maxMag(0.5); loadStars();
const nBright = nStar();
check(`star_max_mag=0.5 trims the mag-sorted file (${nBright} bright stars < full ${fileCount})`, nBright > 0 && nBright < fileCount);
check(`star_max_mag: brightest is still Sirius`, nameF(0) === 'SIRI');
// review fix: an out-of-range star_max_mag must saturate to "load all", not wrap negative and collapse
// to the baked fallback (mag*100 would overflow int16 without the clamp).
maxMag(400.0); loadStars();
check(`star_max_mag=400 saturates -> loads all ${fileCount} (not a wrapped-negative fallback)`, nStar() === fileCount);
maxMag(6.0); loadStars();   // restore the full catalogue for the transit checks

// Oracle: independent double-precision recomputation reading the LOADED catalogue + LST.
function predict(t, lat, lon) {
  const lst = lstF(t, lon), yrs = (t - J2000) / 31557600.0, N = nStar(), out = [];
  for (let i = 0; i < N; i++) {
    const a = raF(i), d = decF(i), ar = a * 15 * D2R, dr = d * D2R;
    const dra = (3.07496 + 1.33621 * Math.sin(ar) * Math.tan(dr)) * yrs;
    const ddec = (20.0431 * Math.cos(ar) * yrs) / 3600;
    const aNow = a + dra / 3600, dNow = d + ddec;
    const alt = 90 - Math.abs(lat - dNow);
    if (alt <= 0) continue;
    let dt = (aNow - lst) % 24; if (dt < 0) dt += 24;
    out.push({ dt_s: Math.round(dt * SIDSEC), alt: Math.round(alt) });
  }
  out.sort((x, y) => x.dt_s - y.dt_s);
  return out.slice(0, 8);
}

setPos(LAT, LON);
const line = starLine().trim();
const mm = /^\$(PMSTAR,[^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
check(`serial: $PMSTAR framing`, !!mm);

if (mm) {
  const body = mm[1]; let cks = 0; for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
  check('serial: $PMSTAR checksum', cks === parseInt(mm[2], 16));
  const f = body.split(',');
  const n = parseInt(f[1], 10);
  const fw = [];
  for (let k = 0; k < n; k++) fw.push({ nm: f[2 + 3 * k], dt_s: parseInt(f[3 + 3 * k], 10), alt: parseInt(f[4 + 3 * k], 10) });

  const pred = predict(T, LAT, LON);
  check(`count: firmware ${n} == oracle ${pred.length}`, n === pred.length && f.length === 2 + 3 * n);

  let asc = true; for (let k = 1; k < fw.length; k++) if (fw[k].dt_s < fw[k - 1].dt_s) asc = false;
  check('order: firmware list ascending by time-to-transit', asc);
  // culmination altitudes are real: >0 clears the horizon (a near-horizon grazer rounds to 0), <=90.
  check('altitude: every entry 0..90 deg', fw.every(s => s.alt >= 0 && s.alt <= 90));

  let matchOk = fw.length === pred.length;
  for (let k = 0; k < fw.length && matchOk; k++) {
    const p = pred[k];
    if (!(Math.abs(fw[k].dt_s - p.dt_s) <= 2 && Math.abs(fw[k].alt - p.alt) <= 1)) matchOk = false;
  }
  check(`match: every firmware transit == oracle (dt<=2s, alt<=1deg)`, matchOk);

  // render: "<name> MM SS" (<1h) or "<name> HhMM" (>=1h); names are now up to 4 chars.
  renderM(MODE_STAR);
  const r = row();
  check(`display: soonest transit renders "${r}"`, /^[A-Za-z]{2,4}\s+\d{1,2}[h ]\d{2}$/.test(r) && r.length <= 10);
}

// no-fix fallback: invalid position -> empty list + "STAr ----"
setPos(-9999, -9999);
check(`serial: no fix -> "${starLine().trim()}" (n=0)`, /^\$PMSTAR,0\*/.test(starLine().trim()));
renderM(MODE_STAR);
const rr = row();
check(`display: no fix shows "${rr}"`, rr.startsWith('STAr') && rr.includes('----'));

done();
