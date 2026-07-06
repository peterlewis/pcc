// sat-tracker.js — REAL GPS constellation, propagated to now, for the emulator's virtual GPS.
// Fetches live GPS TLEs from CelesTrak and computes which satellites are actually above the
// observer right now (topocentric az/el), so the emulator's $GxGSV reflects reality for your
// location instead of a plausible fiction. Compact SGP4-lite: two-body Kepler from the TLE mean
// elements plus the J2 secular precession of RAAN / arg-of-perigee. GPS TLEs are refreshed daily,
// so over the hours since epoch this is accurate to well under a degree of az/el — ample for
// "which birds are up and roughly where". No dependency; degrades gracefully offline.

const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI;
const MU = 398600.4418;          // Earth GM, km^3/s^2
const RE = 6378.137;             // Earth equatorial radius, km
const J2 = 0.00108262998905;
const XKE = 0.0743669161331734;  // sqrt(MU) in Earth-radii^1.5 / min  (SGP4 units)

// CelesTrak sends Access-Control-Allow-Origin:* so a browser fetch works over https.
const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle';

// ---- TLE parsing -------------------------------------------------------------------------
function parseTle(name, l1, l2) {
  const num = (s) => parseFloat(s);
  // epoch: yyddd.ffff
  const epy = parseInt(l1.slice(18, 20), 10);
  const year = epy < 57 ? 2000 + epy : 1900 + epy;
  const doy = num(l1.slice(20, 32));
  const epoch = Date.UTC(year, 0, 1) + (doy - 1) * 86400000;
  return {
    name: name.trim(),
    prn: (name.match(/PRN\s*(\d+)/i) || [])[1] || null,
    inclo: num(l2.slice(8, 16)) * DEG,          // inclination
    nodeo: num(l2.slice(17, 25)) * DEG,         // RAAN
    ecco: num('0.' + l2.slice(26, 33).trim()),  // eccentricity
    argpo: num(l2.slice(34, 42)) * DEG,         // arg perigee
    mo: num(l2.slice(43, 51)) * DEG,            // mean anomaly
    no: num(l2.slice(52, 63)) * TWO_PI / 1440,  // mean motion, rad/min
    epoch,
  };
}

export function parseTleText(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.length);
  const sats = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    if (lines[i + 1] && lines[i + 1][0] === '1' && lines[i + 2] && lines[i + 2][0] === '2')
      sats.push(parseTle(lines[i], lines[i + 1], lines[i + 2]));
  }
  return sats;
}

// ---- propagation (two-body + J2 secular precession) --------------------------------------
function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 8; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

// ECI position (km, TEME-ish) at `date` for one TLE.
function propagate(s, date) {
  const tmin = (date - s.epoch) / 60000;             // minutes since epoch
  const a = Math.cbrt(MU / (s.no / 60) ** 2);        // semi-major axis, km (no in rad/s)
  const n = s.no;                                    // rad/min
  // J2 secular rates (rad/min)
  const p = a * (1 - s.ecco * s.ecco);
  const cosi = Math.cos(s.inclo);
  const factor = 1.5 * J2 * (RE / p) ** 2 * n;
  const nodeDot = -factor * cosi;
  const argpDot = factor * (2 - 2.5 * Math.sin(s.inclo) ** 2);
  const node = s.nodeo + nodeDot * tmin;
  const argp = s.argpo + argpDot * tmin;
  const M = s.mo + n * tmin;
  const E = solveKepler(((M % TWO_PI) + TWO_PI) % TWO_PI, s.ecco);
  // perifocal
  const xv = a * (Math.cos(E) - s.ecco);
  const yv = a * Math.sqrt(1 - s.ecco * s.ecco) * Math.sin(E);
  // rotate perifocal -> ECI
  const cosO = Math.cos(node), sinO = Math.sin(node);
  const cosw = Math.cos(argp), sinw = Math.sin(argp);
  const ci = Math.cos(s.inclo), si = Math.sin(s.inclo);
  const R11 = cosO * cosw - sinO * sinw * ci, R12 = -cosO * sinw - sinO * cosw * ci;
  const R21 = sinO * cosw + cosO * sinw * ci, R22 = -sinO * sinw + cosO * cosw * ci;
  const R31 = sinw * si, R32 = cosw * si;
  return { x: R11 * xv + R12 * yv, y: R21 * xv + R22 * yv, z: R31 * xv + R32 * yv };
}

// Greenwich mean sidereal time (rad) — rotates ECI into an Earth-fixed frame.
function gmst(date) {
  const jd = date / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T;
  g = ((g % 360) + 360) % 360;
  return g * DEG;
}

// Topocentric az/el (deg) of an ECI point from a geodetic observer.
function azel(eci, latDeg, lonDeg, date) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const th = gmst(date) + lon;                        // local sidereal angle
  // observer ECI (spherical Earth is fine at this scale)
  const ox = RE * Math.cos(lat) * Math.cos(th), oy = RE * Math.cos(lat) * Math.sin(th), oz = RE * Math.sin(lat);
  // rotate sat ECI by -gmst into the same (x=Greenwich) frame the observer is in
  const g = gmst(date);
  const sx = eci.x * Math.cos(g) + eci.y * Math.sin(g);
  const sy = -eci.x * Math.sin(g) + eci.y * Math.cos(g);
  const sz = eci.z;
  // ...then express observer in the same rotated frame
  const px = RE * Math.cos(lat) * Math.cos(lon), py = RE * Math.cos(lat) * Math.sin(lon), pz = RE * Math.sin(lat);
  const dx = sx - px, dy = sy - py, dz = sz - pz;
  // ENU
  const e = -Math.sin(lon) * dx + Math.cos(lon) * dy;
  const nn = -Math.sin(lat) * Math.cos(lon) * dx - Math.sin(lat) * Math.sin(lon) * dy + Math.cos(lat) * dz;
  const u = Math.cos(lat) * Math.cos(lon) * dx + Math.cos(lat) * Math.sin(lon) * dy + Math.sin(lat) * dz;
  const rng = Math.hypot(dx, dy, dz);
  return { az: ((Math.atan2(e, nn) / DEG) + 360) % 360, el: Math.asin(u / rng) / DEG };
}

export function createSatTracker() {
  let sats = [];       // parsed TLEs
  let loaded = false;
  return {
    get loaded() { return loaded; },
    get count() { return sats.length; },
    async load(fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
      if (!fetchImpl) return false;
      try {
        const r = await fetchImpl(TLE_URL, { mode: 'cors' });
        if (!r.ok) return false;
        sats = parseTleText(await r.text());
        loaded = sats.length > 0;
        return loaded;
      } catch (e) { return false; }
    },
    loadText(txt) { sats = parseTleText(txt); loaded = sats.length > 0; return loaded; },
    // Satellites currently above `maskDeg` for the observer, brightest (highest) first. Records
    // mirror the app's session sat shape (constId 'G'/GPS) so Sky/Globe/Map plot them directly.
    visible(latDeg, lonDeg, date = new Date(), maskDeg = 5) {
      const out = [];
      const t = +date, g = gmst(t);
      for (let i = 0; i < sats.length; i++) {
        const eci = propagate(sats[i], t);
        const { az, el } = azel(eci, latDeg, lonDeg, t);
        if (el < maskDeg) continue;
        // sub-satellite point (ECI -> ECEF -> geodetic-ish lat/lon) for the globe/map
        const xe = eci.x * Math.cos(g) + eci.y * Math.sin(g);
        const ye = -eci.x * Math.sin(g) + eci.y * Math.cos(g);
        const sublat = Math.atan2(eci.z, Math.hypot(xe, ye)) / DEG;
        const sublon = ((Math.atan2(ye, xe) / DEG + 540) % 360) - 180;
        const cn0 = Math.round(32 + (el / 90) * 16);   // plausible C/N0 from elevation
        const prn = sats[i].prn || String(i + 1);
        out.push({
          key: 'G' + String(prn).padStart(2, '0'), prn, constId: 'G', tok: 'gps', talker: 'GP', sysId: 1,
          az: Math.round(az), el: Math.round(el), cn0,
          geo: { lat: sublat, lon: sublon }, used: el > 6 && cn0 > 29, visible: el > 0,
        });
      }
      out.sort((a, b) => b.el - a.el);
      return out;
    },
  };
}
