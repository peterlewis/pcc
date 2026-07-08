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

// CelesTrak rate-limits — and BLOCKS — IPs that re-download the same GP group too often; their stated
// policy is "cache it, don't re-fetch more than once every few hours". A fresh tracker was created on
// every page load and fetched unconditionally, so heavy reloading during dev got the IP blocked. GPS
// TLEs stay good for days (the two-body + J2 propagation above is well under a degree a full day past
// epoch), so we persist the raw set in localStorage and only touch the network when it's stale. This
// caps CelesTrak hits at ~2/day per browser no matter how often the app reloads.
const TLE_CACHE_KEY = 'pcc.tle.gps-ops';
const TLE_FAIL_KEY = 'pcc.tle.gps-ops.failedAt';
const TLE_BLOCK_KEY = 'pcc.tle.gps-ops.blockedAt';
const TLE_CACHE_TTL_MS = 12 * 3600 * 1000;     // 12 h — how long a good fetch is reused
const TLE_FAIL_BACKOFF_MS = 60 * 60 * 1000;    // 1 h  — transient failure (timeout/offline/5xx): brief backoff
// A 403/429 is a deliberate CelesTrak usage-policy block, NOT a transient blip. Per CelesTrak's own
// guidance (ts.kelso@celestrak.org, 2026-07-08): "check for any non-HTTP 200 responses, and if found,
// immediately stop querying and report the problem to a human for investigation." So on a policy block we
// stop hard — a long backoff so we never hammer a firewall — and report it loudly rather than silently
// re-polling. https://celestrak.org/usage-policy.php
const TLE_BLOCK_BACKOFF_MS = 24 * 3600 * 1000; // 24 h — policy block (403/429): hard stop, do not re-poke
const USAGE_POLICY_URL = 'https://celestrak.org/usage-policy.php';

function readTleCache() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const o = JSON.parse(localStorage.getItem(TLE_CACHE_KEY) || 'null');
    return (o && typeof o.txt === 'string' && Number.isFinite(o.t)) ? o : null;   // { t: epochMs, txt }
  } catch (e) { return null; }
}
function writeTleCache(txt) {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(TLE_CACHE_KEY, JSON.stringify({ t: Date.now(), txt }));
  } catch (e) { /* private mode / quota — cache is best-effort */ }
}
function readStampAt(key) {
  try { const v = typeof localStorage !== 'undefined' ? +localStorage.getItem(key) : 0; return Number.isFinite(v) ? v : 0; }
  catch (e) { return 0; }
}
function writeStampAt(key, ts) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (ts) localStorage.setItem(key, String(ts)); else localStorage.removeItem(key);
  } catch (e) { /* best-effort */ }
}
const readTleFailAt = () => readStampAt(TLE_FAIL_KEY);
const writeTleFailAt = (ts) => writeStampAt(TLE_FAIL_KEY, ts);
const readTleBlockedAt = () => readStampAt(TLE_BLOCK_KEY);
const writeTleBlockedAt = (ts) => writeStampAt(TLE_BLOCK_KEY, ts);

// The "report the problem to a human" hook CelesTrak asks for. In a browser app the honest human-facing
// channel is the console (a developer/operator sees it) plus a getter the UI can surface. Cleared on the
// next good fetch. Kept deliberately loud for a policy block so the cause is never a silent mystery.
let lastTleProblem = null;   // { status, message, at } | null
function reportTleProblem(status, message) {
  lastTleProblem = { status, message, at: Date.now() };
  const line = `[sat-tracker] TLE fetch problem${status ? ' (HTTP ' + status + ')' : ''}: ${message}`;
  try {
    if (typeof console !== 'undefined') {
      if (status === 403 || status === 429) console.error(`${line}\n  → Automatic updates paused. Review CelesTrak's usage policy: ${USAGE_POLICY_URL}`);
      else console.warn(line);
    }
  } catch (e) { /* no console — nothing else to do */ }
}

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
    // The most recent TLE-fetch problem (or null), so the app can surface a policy block to the human
    // rather than leaving it buried in the console. { status, message, at }.
    get lastProblem() { return lastTleProblem; },
    get blocked() { const b = readTleBlockedAt(); return !!(b && (Date.now() - b) < TLE_BLOCK_BACKOFF_MS); },
    async load(fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
      const cached = readTleCache();
      // 1. Fresh cache → serve it, NO network. This is the path that keeps us off CelesTrak's block
      //    list: a page reload within the TTL never hits the wire.
      if (cached && (Date.now() - cached.t) < TLE_CACHE_TTL_MS) {
        sats = parseTleText(cached.txt);
        loaded = sats.length > 0;
        if (loaded) return true;
      }
      // 2. Stale / absent cache → fetch once, bounded — UNLESS a recent fetch already failed. Re-poking
      //    CelesTrak on every reload while the IP is blocked only prolongs the block, so honour a 1 h
      //    backoff after any failure. CelesTrak can also accept the socket and never reply, so without a
      //    deadline the promise hangs for the browser's ~30 s connect timeout; abort at 8 s. A good
      //    fetch refreshes the cache (next reload is free) and clears the failure marker.
      const blocked = (() => { const b = readTleBlockedAt(); return b && (Date.now() - b) < TLE_BLOCK_BACKOFF_MS; })();
      const backedOff = (() => { const f = readTleFailAt(); return f && (Date.now() - f) < TLE_FAIL_BACKOFF_MS; })();
      if (fetchImpl && !blocked && !backedOff) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl && typeof setTimeout !== 'undefined' ? setTimeout(() => ctrl.abort(), 8000) : null;
        try {
          const r = await fetchImpl(TLE_URL, { mode: 'cors', signal: ctrl ? ctrl.signal : undefined });
          if (r.ok) {
            const txt = await r.text();
            const parsed = parseTleText(txt);
            if (parsed.length) {   // success → cache it and clear BOTH the fail and block markers
              sats = parsed; loaded = true; writeTleCache(txt);
              writeTleFailAt(0); writeTleBlockedAt(0); lastTleProblem = null;
              return true;
            }
            // HTTP 200 but no usable TLEs — CelesTrak can serve a 200 error/notice page. Treat as a failure
            // and report it; do not pretend it was data.
            reportTleProblem(200, 'reached CelesTrak but the body held no usable TLE data');
            writeTleFailAt(Date.now());
          } else if (r.status === 403 || r.status === 429) {
            // Deliberate usage-policy block. Stop querying (long backoff) and report to a human — exactly
            // what CelesTrak asks of well-behaved clients. Never re-poke a firewall on a short timer.
            reportTleProblem(r.status, 'CelesTrak usage-policy block — automatic GPS-TLE updates paused');
            writeTleBlockedAt(Date.now()); writeTleFailAt(Date.now());
          } else {
            reportTleProblem(r.status, 'unexpected non-200 response from CelesTrak');
            writeTleFailAt(Date.now());   // 5xx / other transient non-200 → brief backoff
          }
        } catch (e) {
          // offline / DNS / CORS / 8 s abort → transient; brief backoff, don't hammer. Not a policy block.
          reportTleProblem(0, `network error reaching CelesTrak (${e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'failed'})`);
          writeTleFailAt(Date.now());
        } finally { if (timer) clearTimeout(timer); }
      }
      // 3. Network unavailable or failed → a STALE cache (a day-old constellation) still beats none.
      //    Only if there's truly nothing do we give up and let the virtual GPS use its synthetic ramp.
      if (cached) { sats = parseTleText(cached.txt); loaded = sats.length > 0; return loaded; }
      return false;
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
