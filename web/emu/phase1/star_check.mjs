// star_check.mjs — the on-MCU bright-star meridian-transit predictor, cross-checked against an
// independent JS recomputation of the SAME algorithm.
//
// The oracle reads the firmware's OWN catalogue (emu_star_ra/dec) and its OWN local_sidereal_time
// (emu_lst), then re-derives — in double precision — each star's precessed RA/Dec, transit altitude,
// seconds-to-transit and the soonest-8 sort. It asserts the firmware's $PMSTAR sentence matches:
// this validates the new code (precession, sidereal->solar conversion, altitude, selection, NMEA
// framing, date-row render) on top of the already-trusted LST. Catalogue *values* are the firmware's
// own — they still want a pass against an authoritative source, independent of this test.
// Run: node star_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'number', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']);
const setPos   = w('emu_set_pos',   'void', ['number', 'number']);
const lstF     = w('emu_lst',       'number', ['number', 'number']);
const starLine = w('emu_star_line', 'string');
const nStar    = w('emu_star_count','number');
const raF      = w('emu_star_ra',   'number', ['number']);
const decF     = w('emu_star_dec',  'number', ['number']);
const renderM  = w('emu_render_mode','void', ['number']);
const rowPtr   = w('emu_daterow',   'number');
const MODE_STAR = w('emu_MODE_STAR','number')();
const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s; };

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const done = () => { let f = 0; for (const r of results) { if (!r.pass) f++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); } console.log(f ? `\n${f} FAIL` : `\nALL PASS`); process.exit(f ? 1 : 0); };

const J2000 = 946728000.0, SIDSEC = 3590.1704, D2R = Math.PI / 180;
const T = 1750000000;            // 2025-06-15 (arbitrary, deterministic)
const LAT = 20.0, LON = 0.0;

bootCold(T);
if (MODE_STAR < 0 || nStar() === 0) { console.log('SKIP — firmware has no star-transit engine'); process.exit(0); }

// (0) LST advances at the sidereal rate (independent of the transit code): +1 solar hour of clock
//     should advance LST by 1.00273790935 sidereal hours (mod 24).
{
  const l0 = lstF(T, LON), l1 = lstF(T + 3600, LON);
  let d = (l1 - l0) % 24; if (d < 0) d += 24;
  check(`LST sidereal rate: +1h clock -> +${d.toFixed(5)} h LST (want 1.00274)`, Math.abs(d - 1.00273790935) < 1e-4);
}

// Oracle: independent double-precision recomputation reading the firmware's catalogue + LST.
function predict(t, lat, lon) {
  const lst = lstF(t, lon), yrs = (t - J2000) / 31557600.0, N = nStar(), out = [];
  for (let i = 0; i < N; i++) {
    const a = raF(i), d = decF(i), ar = a * 15 * D2R, dr = d * D2R;
    const dra = (3.07496 + 1.33621 * Math.sin(ar) * Math.tan(dr)) * yrs;   // sec of time
    const ddec = (20.0431 * Math.cos(ar) * yrs) / 3600;                     // deg
    const aNow = a + dra / 3600, dNow = d + ddec;
    const alt = 90 - Math.abs(lat - dNow);
    if (alt <= 0) continue;
    let dt = (aNow - lst) % 24; if (dt < 0) dt += 24;
    out.push({ nm: null, i, dt_s: Math.round(dt * SIDSEC), alt: Math.round(alt) });
  }
  out.sort((x, y) => x.dt_s - y.dt_s);
  return out.slice(0, 8);
}

setPos(LAT, LON);
const line = starLine().trim();                       // "$PMSTAR,<n>,nm,dt,alt,..*CC"
const mm = /^\$(PMSTAR,[^*]*)\*([0-9A-Fa-f]{2})$/.exec(line);
check(`serial: $PMSTAR framing — "${line}"`, !!mm);

if (mm) {
  const body = mm[1]; let cks = 0; for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
  check('serial: $PMSTAR checksum', cks === parseInt(mm[2], 16));
  const f = body.split(',');
  const n = parseInt(f[1], 10);
  const fw = [];
  for (let k = 0; k < n; k++) fw.push({ nm: f[2 + 3 * k], dt_s: parseInt(f[3 + 3 * k], 10), alt: parseInt(f[4 + 3 * k], 10) });

  const pred = predict(T, LAT, LON);
  check(`count: firmware ${n} == oracle ${pred.length}`, n === pred.length && f.length === 2 + 3 * n);

  // sorted ascending by seconds-to-transit
  let asc = true; for (let k = 1; k < fw.length; k++) if (fw[k].dt_s < fw[k - 1].dt_s) asc = false;
  check('order: firmware list ascending by time-to-transit', asc);

  // altitudes are real culminations in (0,90]
  check('altitude: every entry 1..90 deg', fw.every(s => s.alt >= 1 && s.alt <= 90));

  // set + per-star match vs oracle (names via catalogue index -> name from firmware output set)
  const predNames = pred.map(p => raF); // placeholder; match by dt+alt below
  let matchOk = fw.length === pred.length;
  for (let k = 0; k < fw.length && matchOk; k++) {
    // firmware[k] should equal oracle[k] (same sort); compare dt within rounding + alt exact
    const p = pred[k];
    if (!(Math.abs(fw[k].dt_s - p.dt_s) <= 2 && Math.abs(fw[k].alt - p.alt) <= 1)) matchOk = false;
  }
  check(`match: every firmware transit == oracle (dt<=2s, alt<=1deg)`, matchOk);

  // (render) §6: the soonest star renders on the date row as bare values, "<name> MM SS" when the
  // transit is under an hour away or "<name> HhMM" when an hour or more out; <=10 chars either way.
  renderM(MODE_STAR);
  const r = row();
  check(`display: soonest transit renders "${r}"`, /^[A-Za-z]{2,3}\s+\d{1,2}[h ]\d{2}$/.test(r) && r.length <= 10);
}

// no-fix fallback: invalid position -> empty list + "STAr ----"
setPos(-9999, -9999);
const nofix = starLine().trim();
check(`serial: no fix -> "${nofix}" (n=0)`, /^\$PMSTAR,0\*/.test(nofix));
renderM(MODE_STAR);
const rr = row();
check(`display: no fix shows "${rr}"`, rr.startsWith('STAr') && rr.includes('----'));

done();
