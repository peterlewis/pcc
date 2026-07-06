// Independent ground truth for the golden-trace conformance test. Computed from first
// principles — JS Date (civil/calendar), the IAU-1982 GMST series (sidereal), the NOAA
// equation-of-time (solar), and the documented tolerance thresholds (precision ladder).
// NONE of this reads the firmware, so a match is a real conformance result, not a tautology.

const p2 = (n) => String(n).padStart(2,'0');
const hms = (secOfDay) => {                       // seconds-of-day -> [hh,mm,ss] digit array
  secOfDay = ((secOfDay % 86400) + 86400) % 86400;
  const s = Math.floor(secOfDay);
  const hh = Math.floor(s/3600), mm = Math.floor((s%3600)/60), ss = s%60;
  return [Math.floor(hh/10),hh%10, Math.floor(mm/10),mm%10, Math.floor(ss/10),ss%10];
};

// --- civil (exact, from JS Date UTC) ------------------------------------------------------
export function civil(epoch){
  const d = new Date(epoch*1000);
  const hh=d.getUTCHours(), mm=d.getUTCMinutes(), ss=d.getUTCSeconds();
  return {
    big: [Math.floor(hh/10),hh%10, Math.floor(mm/10),mm%10, Math.floor(ss/10),ss%10],
    dateRow: `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())}`,
  };
}
export const WEEKDAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export function weekdayName(epoch){ return WEEKDAY[new Date(epoch*1000).getUTCDay()]; }

// --- calendar date-row modes (payload on the 10-char date row; big digits stay civil) ------
// Firmware formats verified against main.c sendDate (all use %d — NO zero-padding).
const FULLDAY = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function unixRow(epoch){ return String(epoch>>>0).padStart(10,'0'); }   // "%010ld"
export function weekdayRow(epoch){ return FULLDAY[new Date(epoch*1000).getUTCDay()]; }
export function ordinalRow(epoch){                                              // "20YY-<doy>"
  const d = new Date(epoch*1000);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())
            - Date.UTC(d.getUTCFullYear(),0,1))/86400000) + 1;
  return `${d.getUTCFullYear()}-${doy}`;
}
export function isoWeekRow(epoch){                                              // "<isoYear>-W<w>-<d>"
  const d = new Date(epoch*1000);
  const day = (d.getUTCDay()+6)%7;                                             // Mon=0..Sun=6
  const th = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day+3)); // Thursday
  const isoYear = th.getUTCFullYear();
  // ISO week = (day-of-year of that Thursday, 0-based) / 7 + 1 — the ISO 8601 rule the firmware uses.
  const thDOY = Math.floor((Date.UTC(isoYear,th.getUTCMonth(),th.getUTCDate()) - Date.UTC(isoYear,0,1))/86400000);
  const week = Math.floor(thDOY/7) + 1;
  return `${isoYear}-W${week}-${day+1}`;                                       // day+1: Mon=1..Sun=7
}
// Julian Date / Modified Julian Date. Firmware: sprintf("%10f", (double)unix/86400 + K); the 10-char
// date row shows the first 10 chars. K = 2440587.5 (Unix epoch -> JD) / 40587 (Unix -> MJD). Across
// the 2000-2099 domain both have >=5 integer digits, so "%10f" never left-pads and the shown 10
// chars are: integer + '.' + the leading decimals. C "%f" prints 6 decimals; 6th-place rounding
// can't reach the shown decimals here (integer part is 5-7 digits), so toFixed(6) is faithful.
const f10 = (x) => x.toFixed(6).slice(0,10);
export function julianRow(epoch){ return f10(epoch/86400 + 2440587.5); }
export function mjdRow(epoch){    return f10(epoch/86400 + 40587); }

// --- Maidenhead grid locator (6-char) — deterministic from position, independent ----------
export function gridRow(lat, lon){
  let x = lon + 180, y = lat + 90;                       // 0..360, 0..180
  const A = 65, a = 97;
  const f1 = String.fromCharCode(A + Math.floor(x/20)),  f2 = String.fromCharCode(A + Math.floor(y/10));
  const s1 = Math.floor((x % 20)/2),                     s2 = Math.floor(y % 10);
  const u1 = String.fromCharCode(a + Math.floor((x % 2)*12)), u2 = String.fromCharCode(a + Math.floor((y % 1)*24));
  return `${f1}${f2}${s1}${s2}${u1}${u2}`;
}

// --- sidereal: IAU-1982 mean GMST (independent of the firmware's series) -------------------
export function gmstSeconds(epoch){
  const JD = epoch/86400 + 2440587.5;                 // Unix -> Julian Date (UT)
  const T  = (JD - 2451545.0) / 36525.0;              // Julian centuries from J2000.0
  let s = 67310.54841
        + (876600*3600 + 8640184.812866)*T
        + 0.093104*T*T
        - 6.2e-6*T*T*T;                                // GMST in seconds of time
  return ((s % 86400) + 86400) % 86400;
}
export function lstSeconds(epoch, lonDeg){             // local mean sidereal time
  return (gmstSeconds(epoch) + lonDeg*240) % 86400;    // 240 s of time per degree east
}
export function siderealBig(epoch, lonDeg){ return hms(lstSeconds(epoch, lonDeg)); }

// --- solar: mean solar (exact) + equation of time via the standard USNO sun algorithm -------
// EoT = (sun mean longitude) - (sun apparent right ascension), a low-precision-but-few-second
// method independent of the firmware's astro.c. Accurate to ~a few seconds over 1950-2050.
export function eotSeconds(epoch){
  const rad = Math.PI/180;
  const n = epoch/86400 + 2440587.5 - 2451545.0;          // days from J2000.0 (TT~UT here)
  const L = ((280.460 + 0.9856474*n) % 360 + 360) % 360;  // mean longitude of the Sun (deg)
  const g = (357.528 + 0.9856003*n) * rad;                // mean anomaly (deg->rad)
  const lambda = (L + 1.915*Math.sin(g) + 0.020*Math.sin(2*g)) * rad;  // ecliptic longitude
  const eps = (23.439 - 0.0000004*n) * rad;               // obliquity of the ecliptic
  let ra = Math.atan2(Math.cos(eps)*Math.sin(lambda), Math.cos(lambda)) / rad;  // right ascension (deg)
  ra = ((ra % 360) + 360) % 360;
  let eot = L - ra;                                        // degrees
  if (eot >  180) eot -= 360;
  if (eot < -180) eot += 360;
  return eot * 240;                                        // deg -> seconds of time (240 s/deg)
}
export function solarSeconds(epoch, lonDeg){
  const utcSecOfDay = ((epoch % 86400)+86400)%86400;
  return (utcSecOfDay + lonDeg*240 + eotSeconds(epoch)) % 86400;   // apparent solar
}
export function solarBig(epoch, lonDeg){ return hms(solarSeconds(epoch, lonDeg)); }

// --- precision ladder (documented thresholds; mirrors setPrecision COUNT_NORMAL EXACTLY) -----
// The ladder is ASYMMETRIC: P3/P2 gate on the PPS age (sincePps), but P1 gates on the RTC
// calibration age (calAge) — a distinct dependency. small = [tenths, hundredths, thousandths].
export function precision({hadPps, sincePps, calAge=sincePps, tol={t1:1000,t10:10000,t100:100000}}){
  if (!hadPps)              return { level:'P0', dpExpected:false, dashes:[true,true,true] };
  if (sincePps < tol.t1)    return { level:'P3', dpExpected:true,  dashes:[false,false,false] };
  if (sincePps < tol.t10)   return { level:'P2', dpExpected:true,  dashes:[false,false,true ] };
  if (calAge   < tol.t100)  return { level:'P1', dpExpected:true,  dashes:[false,true, true ] };
  return                           { level:'P0', dpExpected:false, dashes:[true,true,true] };
}

// --- anchors: refuse to be trusted unless these published values check out -----------------
export function selfTest(){
  const fails = [];
  // GMST at 2000-01-01 00:00:00 UT ~ 6h39m52.271s (USNO). Allow 1 s.
  const g = gmstSeconds(Date.UTC(2000,0,1,0,0,0)/1000);
  const want = 6*3600+39*60+52.271;
  if (Math.abs(g-want) > 1.0) fails.push(`GMST J2000 anchor: got ${g.toFixed(3)} want ${want.toFixed(3)}`);
  // GMST advances ~1.0027379 sidereal seconds per solar second: 1 solar day -> +236.555 s.
  const g2 = gmstSeconds(Date.UTC(2000,0,2,0,0,0)/1000);
  const adv = ((g2-g)%86400+86400)%86400;
  if (Math.abs(adv-236.555) > 1.0) fails.push(`GMST daily advance: got ${adv.toFixed(3)} want ~236.555`);
  // EoT sign: early Nov ~ +16 min, mid Feb ~ -14 min.
  const nov = eotSeconds(Date.UTC(2024,10,3,12,0,0)/1000)/60;
  const feb = eotSeconds(Date.UTC(2024,1,11,12,0,0)/1000)/60;
  if (!(nov > 12 && nov < 18)) fails.push(`EoT Nov: got ${nov.toFixed(2)} min want ~+16`);
  if (!(feb < -12 && feb > -16)) fails.push(`EoT Feb: got ${feb.toFixed(2)} min want ~-14`);
  // Julian Date anchors (published): JD of 2000-01-01 00:00 UTC = 2451544.5, MJD = 51544.0.
  if (julianRow(946684800) !== '2451544.50') fails.push(`JD J2000 anchor: got ${julianRow(946684800)} want 2451544.50`);
  if (mjdRow(946684800)    !== '51544.0000') fails.push(`MJD J2000 anchor: got ${mjdRow(946684800)} want 51544.0000`);
  return fails;
}
