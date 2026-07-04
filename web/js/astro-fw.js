// astro-fw.js — byte-faithful JS port of the clock4 firmware `astro.c`.
//
// Used ONLY for the date-row astro modes (SUN / SUN_AZEL / MOON / GRID / LATLON) so the web
// emulator matches the physical clock's readout exactly. Deliberately NOT reused from
// astronomy.js, which differs from firmware in two ways the survey flagged: its moonPhase uses
// the old 6.26 epoch offset (firmware/macOS use 5.26 → ~3.4% off on index/illumination) and its
// equation-of-time uses a Spencer day-of-year series rather than the firmware's canonical
// L−α form (~6 min/yr drift). Every intermediate is double, mirroring the C.

const J2000_UNIX = 946728000.0; // 2000-01-01 12:00:00 UTC
const DEG = Math.PI / 180.0, RAD = 180.0 / Math.PI;

// C fmod keeps the sign of the dividend; JS % does too, so `%` is a faithful fmod here.
const fmod = (a, b) => a % b;
const daysSinceJ2000 = (unixS) => (unixS - J2000_UNIX) / 86400.0;

// Shared low-precision solar block → apparent RA α (deg) and dec δ (rad), plus L (deg).
function sunEcliptic(n) {
  const L = fmod(280.460 + 0.9856474 * n, 360.0);
  const g = fmod(357.528 + 0.9856003 * n, 360.0);
  const lam = L + 1.915 * Math.sin(g * DEG) + 0.020 * Math.sin(2.0 * g * DEG);
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lam * DEG), Math.cos(lam * DEG)) * RAD;
  const delta = Math.asin(Math.sin(eps) * Math.sin(lam * DEG));
  return { L, g, lam, eps, alpha, delta };
}

// Apparent alt/az of the sun. az ∈ [0,360) from N clockwise, el ∈ [−90,90].
export function sunAzEl(lat, lon, unixS) {
  const n = daysSinceJ2000(unixS);
  const { alpha, delta } = sunEcliptic(n);
  const gmst = fmod(18.697374558 + 24.06570982441908 * n, 24.0);
  const lst = gmst * 15.0 + lon;
  const ha = (lst - alpha) * DEG;
  const el = Math.asin(Math.sin(lat * DEG) * Math.sin(delta) + Math.cos(lat * DEG) * Math.cos(delta) * Math.cos(ha)) * RAD;
  let az = Math.atan2(-Math.sin(ha), Math.tan(delta) * Math.cos(lat * DEG) - Math.sin(lat * DEG) * Math.cos(ha)) * RAD;
  if (az < 0.0) az += 360.0;
  return { az, el };
}

export function equationOfTime(unixS) {
  const n = daysSinceJ2000(unixS);
  const { L, alpha } = sunEcliptic(n);
  let diff = fmod(L - alpha, 360.0);
  if (diff > 180.0) diff -= 360.0;
  else if (diff <= -180.0) diff += 360.0;
  return 4.0 * diff; // minutes
}

// Sunrise / sunset / solar-noon as decimal UTC hours (may be <0 or >24 — the caller wraps to
// local, NOT clamps). polar:true on polar day/night, leaving only solarNoon valid.
export function sunTimes(lat, lon, unixS) {
  const noonUnix = Math.trunc(unixS / 86400.0) * 86400.0 + 43200.0;
  const n = daysSinceJ2000(noonUnix);
  const { delta } = sunEcliptic(n);
  const eot = equationOfTime(noonUnix); // minutes
  const noon = 12.0 - eot / 60.0 - lon / 15.0;
  const cosO = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * Math.sin(delta)) / (Math.cos(lat * DEG) * Math.cos(delta));
  if (cosO < -1.0 || cosO > 1.0) return { polar: true, sunrise: NaN, sunset: NaN, solarNoon: noon };
  const omega = Math.acos(cosO) * RAD;
  return { polar: false, sunrise: noon - omega / 15.0, sunset: noon + omega / 15.0, solarNoon: noon };
}

export function moonPhase(unixS) {
  const n = daysSinceJ2000(unixS);
  let phase = fmod((n - 5.26) / 29.53059, 1.0);
  if (phase < 0.0) phase += 1.0;
  return phase;
}
export function moonIlluminatedFraction(phase) { return (1.0 - Math.cos(2.0 * Math.PI * phase)) / 2.0; }
export function moonPhaseIndex(phase) { return ((phase * 8.0 + 0.5) | 0) & 7; } // (int)(…) truncation; value ≥0

// 6-char Maidenhead grid, or '----' on a non-finite fix. Ports astro.c maidenhead() exactly.
export function maidenhead(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '----';
  lat = Math.min(89.99999999, Math.max(-90.0, lat));
  lon = Math.min(179.99999999, Math.max(-180.0, lon));
  const LON = lon + 180.0, LAT = lat + 90.0;
  let f0 = (LON / 20.0) | 0; f0 = Math.max(0, Math.min(17, f0));
  let f1 = (LAT / 10.0) | 0; f1 = Math.max(0, Math.min(17, f1));
  let s2 = (fmod(LON, 20.0) / 2.0) | 0; s2 = Math.max(0, Math.min(9, s2));
  let s3 = fmod(LAT, 10.0) | 0; s3 = Math.max(0, Math.min(9, s3));
  let u4 = (fmod(LON, 2.0) * 12.0) | 0; u4 = Math.max(0, Math.min(23, u4));
  let u5 = (fmod(LAT, 1.0) * 24.0) | 0; u5 = Math.max(0, Math.min(23, u5));
  return String.fromCharCode(65 + f0) + String.fromCharCode(65 + f1)
    + String(s2) + String(s3)
    + String.fromCharCode(97 + u4) + String.fromCharCode(97 + u5);
}

// UTC decimal hours → local minutes-of-day [0,1440), matching firmware astro_local_minutes()
// (adds the tz offset in hours, wraps 24h). offsetHours = local − UTC (e.g. BST = +1).
export function toLocalMinutes(utcHours, offsetHours) {
  let h = fmod(utcHours + offsetHours, 24.0);
  if (h < 0) h += 24.0;
  let m = Math.round(h * 60.0);
  m = ((m % 1440) + 1440) % 1440;
  return m;
}
