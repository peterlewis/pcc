// sim.js — simulated GNSS/PPS session engine for the PCC Web design prototype.
// Business logic only: orbits, astronomy, NMEA, $PMTXTS, session state. No DOM.
// Numbers are plausible-realistic; sources of truth for formats: EMULATOR_SPEC.md, PPS_TIMESTAMP.md.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- astronomy (approx, design-grade)
function daysJ2000(ms) { return ms / 86400000 - 10957.5; }

export function sunPos(ms, lat, lon) {
  const d = daysJ2000(ms);
  const g = ((357.529 + 0.98560028 * d) % 360) * D2R;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstH = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  let subLon = (RA * R2D - gmstH * 15);
  subLon = ((subLon + 540) % 360) - 180;
  const subLat = decl * R2D;
  return { subLat, subLon, ...azelFromSub(lat, lon, subLat, subLon) };
}

function azelFromSub(lat, lon, sLat, sLon) {
  const H = (lon - sLon) * D2R, la = lat * D2R, de = sLat * D2R;
  const el = Math.asin(Math.sin(la) * Math.sin(de) + Math.cos(la) * Math.cos(de) * Math.cos(H)) * R2D;
  let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(de) * Math.cos(la)) * R2D + 180;
  az = ((az % 360) + 360) % 360;
  return { az, el };
}

export function moonPos(ms, lat, lon) {
  const d = daysJ2000(ms);
  const L = (218.316 + 13.176396 * d) * D2R;
  const M = (134.963 + 13.064993 * d) * D2R;
  const F = (93.272 + 13.229350 * d) * D2R;
  const l = L + 6.289 * D2R * Math.sin(M);
  const b = 5.128 * D2R * Math.sin(F);
  const e = 23.439 * D2R;
  const RA = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const gmstH = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  let subLon = (RA * R2D - gmstH * 15);
  subLon = ((subLon + 540) % 360) - 180;
  const jd = ms / 86400000 + 2440587.5;
  const age = (((jd - 2451550.26) % 29.53059) + 29.53059) % 29.53059;
  const illum = (1 - Math.cos(2 * Math.PI * age / 29.53059)) / 2;
  const names = ['NEW', 'WAXING CRESCENT', 'FIRST QUARTER', 'WAXING GIBBOUS', 'FULL', 'WANING GIBBOUS', 'LAST QUARTER', 'WANING CRESCENT'];
  const phaseName = names[Math.floor(((age / 29.53059) * 8 + 0.5)) % 8];
  return { subLat: dec * R2D, subLon, age, illum, phaseName, ...azelFromSub(lat, lon, dec * R2D, subLon) };
}

export function sunTimes(ms, lat, lon) {
  const dt = new Date(ms);
  const doy = Math.floor((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(), 0, 0)) / 86400000);
  const gam = 2 * Math.PI / 365 * (doy - 1 + 0.5);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(gam) - 0.032077 * Math.sin(gam) - 0.014615 * Math.cos(2 * gam) - 0.040849 * Math.sin(2 * gam));
  const decl = 0.006918 - 0.399912 * Math.cos(gam) + 0.070257 * Math.sin(gam) - 0.006758 * Math.cos(2 * gam) + 0.000907 * Math.sin(2 * gam) - 0.002697 * Math.cos(3 * gam) + 0.00148 * Math.sin(3 * gam);
  const cosH = (Math.cos(90.833 * D2R) / (Math.cos(lat * D2R) * Math.cos(decl))) - Math.tan(lat * D2R) * Math.tan(decl);
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) * R2D;
  const noonMin = 720 - 4 * lon - eq;
  const day0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  return { rise: new Date(day0 + (noonMin - 4 * H) * 60000), set: new Date(day0 + (noonMin + 4 * H) * 60000) };
}

export function maidenhead(lat, lon) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  const lo = lon + 180, la = lat + 90;
  return A[Math.floor(lo / 20)] + A[Math.floor(la / 10)] +
    Math.floor((lo % 20) / 2) + Math.floor(la % 10) +
    A.toLowerCase()[Math.floor(((lo % 2) / 2) * 24)] + A.toLowerCase()[Math.floor((la % 1) * 24)];
}

// ---------------------------------------------------------------- orbits
const CONSTS = [
  { id: 'G', name: 'GPS', tok: 'gps', talker: 'GP', incl: 55.0, period: 43082, alt: 20200, n: 10, sysId: 1 },
  { id: 'R', name: 'GLO', tok: 'glo', talker: 'GL', incl: 64.8, period: 40544, alt: 19100, n: 8, sysId: 2 },
  { id: 'E', name: 'GAL', tok: 'gal', talker: 'GA', incl: 56.0, period: 50688, alt: 23222, n: 8, sysId: 3 },
  { id: 'C', name: 'BDS', tok: 'bds', talker: 'GB', incl: 55.0, period: 46390, alt: 21500, n: 7, sysId: 4 },
];
export const CONST_META = CONSTS;

function makeSats(rng) {
  const sats = [];
  for (const c of CONSTS) {
    for (let i = 0; i < c.n; i++) {
      const prn = (c.id === 'R' ? 65 : c.id === 'E' ? 1 : c.id === 'C' ? 6 : 2) + i * (c.id === 'G' ? 3 : 2) + Math.floor(rng() * 2);
      sats.push({
        key: c.id + String(prn).padStart(2, '0'), constId: c.id, tok: c.tok, talker: c.talker, sysId: c.sysId,
        prn, incl: c.incl, period: c.period, alt: c.alt,
        raan: (360 / c.n) * i + rng() * 24 - 12,
        phase0: rng() * 360,
        cn0Bias: rng() * 6 - 3, wf: 40 + rng() * 80, wp: rng() * Math.PI * 2,
      });
    }
  }
  return sats;
}

const RE = 6371;
function satGeo(sat, tSec) {
  const th = (sat.phase0 + 360 * tSec / sat.period) * D2R;
  const i = sat.incl * D2R;
  const lat = Math.asin(Math.sin(i) * Math.sin(th)) * R2D;
  let lon = sat.raan + Math.atan2(Math.cos(i) * Math.sin(th), Math.cos(th)) * R2D - (360 * tSec / 86164);
  lon = ((lon % 360) + 540) % 360 - 180;
  return { lat, lon };
}

function azel(obsLat, obsLon, s) {
  const la = obsLat * D2R, lo = obsLon * D2R;
  const sla = s.lat * D2R, slo = s.lon * D2R, r = RE + s.alt;
  const ox = RE * Math.cos(la) * Math.cos(lo), oy = RE * Math.cos(la) * Math.sin(lo), oz = RE * Math.sin(la);
  const sx = r * Math.cos(sla) * Math.cos(slo), sy = r * Math.cos(sla) * Math.sin(slo), sz = r * Math.sin(sla);
  const dx = sx - ox, dy = sy - oy, dz = sz - oz;
  const e = -Math.sin(lo) * dx + Math.cos(lo) * dy;
  const n = -Math.sin(la) * Math.cos(lo) * dx - Math.sin(la) * Math.sin(lo) * dy + Math.cos(la) * dz;
  const u = Math.cos(la) * Math.cos(lo) * dx + Math.cos(la) * Math.sin(lo) * dy + Math.sin(la) * dz;
  const rng = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { az: ((Math.atan2(e, n) * R2D) + 360) % 360, el: Math.asin(u / rng) * R2D, range: rng };
}

// ---------------------------------------------------------------- NMEA
export function cksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}
export function wrap(body) { return '$' + body + '*' + cksum(body); }

function ddmm(v, latMode) {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return String(d).padStart(latMode ? 2 : 3, '0') + m.toFixed(5).padStart(8, '0');
}
function hms(dt) {
  return String(dt.getUTCHours()).padStart(2, '0') + String(dt.getUTCMinutes()).padStart(2, '0') +
    String(dt.getUTCSeconds()).padStart(2, '0') + '.' + String(Math.floor(dt.getUTCMilliseconds() / 10)).padStart(2, '0');
}

export const nmea = {
  gga(dt, fix) {
    const ok = fix.valid;
    const b = ['GNGGA', hms(dt),
      ok ? ddmm(fix.lat, true) : '', ok ? (fix.lat >= 0 ? 'N' : 'S') : '',
      ok ? ddmm(fix.lon, false) : '', ok ? (fix.lon >= 0 ? 'E' : 'W') : '',
      ok ? '1' : '0', String(ok ? fix.sats : 0).padStart(2, '0'),
      ok ? fix.hdop.toFixed(2) : '99.99', ok ? fix.alt.toFixed(1) : '', 'M', ok ? '45.3' : '', 'M', '', ''].join(',');
    return wrap(b);
  },
  rmc(dt, fix) {
    const ok = fix.valid;
    const d = String(dt.getUTCDate()).padStart(2, '0') + String(dt.getUTCMonth() + 1).padStart(2, '0') + String(dt.getUTCFullYear() % 100).padStart(2, '0');
    const b = ['GNRMC', hms(dt), ok ? 'A' : 'V',
      ok ? ddmm(fix.lat, true) : '', ok ? 'N' : '', ok ? ddmm(fix.lon, false) : '', ok ? 'E' : '',
      ok ? (0.02 + Math.random() * 0.05).toFixed(2) : '', '', d, '', '', ok ? 'A' : 'N'].join(',');
    return wrap(b);
  },
  gsa(fix, used) {
    const ids = used.slice(0, 12).map((s) => String(s.prn).padStart(2, '0'));
    while (ids.length < 12) ids.push('');
    const b = ['GNGSA', 'A', fix.valid ? '3' : '1', ...ids,
      fix.pdop.toFixed(2), fix.hdop.toFixed(2), fix.vdop.toFixed(2)].join(',');
    return wrap(b);
  },
  gsv(talker, sats) {
    const total = Math.ceil(sats.length / 4) || 1;
    const out = [];
    for (let p = 0; p < total; p++) {
      const chunk = sats.slice(p * 4, p * 4 + 4);
      const f = [talker + 'GSV', total, p + 1, String(sats.length).padStart(2, '0')];
      for (const s of chunk) {
        f.push(String(s.prn).padStart(2, '0'), String(Math.round(s.el)).padStart(2, '0'),
          String(Math.round(s.az)).padStart(3, '0'), String(Math.round(s.cn0)).padStart(2, '0'));
      }
      out.push(wrap(f.join(',')));
    }
    return out;
  },
  zda(dt) {
    const b = ['GPZDA', hms(dt), String(dt.getUTCDate()).padStart(2, '0'),
      String(dt.getUTCMonth() + 1).padStart(2, '0'), dt.getUTCFullYear(), '00', '00'].join(',');
    return wrap(b);
  },
  pmtxts(p) {
    const b = ['PMTXTS', p.seq, p.epoch, p.subms, p.systick, p.load, p.calerr, p.sincecal, p.temp, p.flags.toString(16)].join(',');
    return wrap(b);
  },
};

// ---------------------------------------------------------------- quadratic fit (temp comp), centred at 25 °C
export function fitQuad(samples) {
  if (samples.length < 8) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
  let tMin = 999, tMax = -999;
  for (const p of samples) {
    const x = p.temp - 25, y = p.ppm;
    tMin = Math.min(tMin, p.temp); tMax = Math.max(tMax, p.temp);
    s0 += 1; s1 += x; s2 += x * x; s3 += x * x * x; s4 += x * x * x * x;
    b0 += y; b1 += x * y; b2 += x * x * y;
  }
  const spread = tMax - tMin;
  let k0, k1, k2;
  if (spread < 15) {
    const den = s0 * s2 - s1 * s1;
    k1 = (s0 * b1 - s1 * b0) / den; k0 = (b0 - k1 * s1) / s0; k2 = 0;
  } else {
    const M = [[s0, s1, s2, b0], [s1, s2, s3, b1], [s2, s3, s4, b2]];
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
    }
    k0 = M[0][3] / M[0][0]; k1 = M[1][3] / M[1][1]; k2 = M[2][3] / M[2][2];
  }
  let rss = 0;
  for (const p of samples) {
    const x = p.temp - 25, e = p.ppm - (k0 + k1 * x + k2 * x * x);
    rss += e * e;
  }
  return {
    k0, k1, k2, spread, n: samples.length, tMin, tMax,
    rms: Math.sqrt(rss / samples.length),
    ready: samples.length >= 30 && spread >= 8,
    lineOnly: spread < 15,
  };
}

// ---------------------------------------------------------------- session
const LSE_HZ = 32768, CAL_PERIOD = 63, LOAD = 79999;
const TRUE_K = { k0: 0.124, k1: -0.31, k2: -0.034 };
const truePpm = (T) => TRUE_K.k0 + TRUE_K.k1 * (T - 25) + TRUE_K.k2 * (T - 25) * (T - 25);

export function createSession(opts = {}) {
  const rng = mulberry32(opts.seed || 1977);
  const gauss = () => (rng() + rng() + rng() + rng() - 2) / 2 * 1.42;
  const sats = makeSats(rng);
  const obs = { lat: 51.4779, lon: -0.0015, alt: 46.0 };   // Royal Observatory Greenwich (WGS84 prime meridian) — one default across the app
  const preroll = opts.preroll ?? 1560;
  const t0 = Math.floor(Date.now() / 1000) - preroll;

  const S = {
    obs, sats: [], t0, scenario: 'locked', connected: false,
    fix: { valid: false, lat: obs.lat, lon: obs.lon, alt: obs.alt, hdop: 1.0, pdop: 1.7, vdop: 1.4, sats: 0, type: 0 },
    posHist: [], dopHist: [], fixHist: [], cn0Hist: new Map(), trails: new Map(), gtrails: new Map(),
    pps: { list: [], samples: [], seq: 4211, dropped: 0, calerr: 0, ppm: 0, sincecal: 0, temp: 31.2, lastEdge: 0, flags: 7 },
    nmeaLog: [], nmeaRate: 0, ttff: 26.8, passes: 0, obsCount: 0, peakEl: 0,
    bins: new Set(), stats: {},
    weather: { temp: 18.6, app: 17.4, rh: 64, mslp: 1013.4, wind: 4.2, gust: 7.1, dir: 238, precip: 0.0, cloud: 83, code: 'OVERCAST', offline: false, asOf: 0 },
    rebooting: false,
  };

  let wanderSeed = rng() * 1000;
  const risenPrev = new Set();

  function satSnapshot(tAbs) {
    const t = tAbs; // seconds epoch
    const out = [];
    for (const s of sats) {
      const geo = satGeo(s, t);
      const ae = azel(obs.lat, obs.lon, { ...geo, alt: s.alt });
      if (ae.el < -8) continue;
      let cn0 = 31.5 + 15 * Math.pow(Math.max(0, ae.el) / 90, 0.62) + s.cn0Bias
        + 1.7 * Math.sin(t / s.wf + s.wp) + gauss() * 0.7;
      if (ae.el < 18 && ae.el > 0) cn0 -= (18 - ae.el) * 0.38 * (1 + 0.5 * Math.sin(t / 41 + s.wp));
      cn0 = Math.max(9, Math.min(52, cn0));
      const scen = S.scenario;
      if (scen === 'acquiring') cn0 = Math.max(9, cn0 - 9 - 4 * Math.sin(t / 7 + s.wp));
      const used = S.connected && scen === 'locked' && ae.el > 6 && cn0 > 29;
      out.push({ ...s, az: ae.az, el: ae.el, geo, cn0, used, visible: ae.el > 0 });
    }
    return out;
  }

  function ppsSample(tAbs, light) {
    const P = S.pps;
    // temperature: warm-up ramp + room drift
    const dt = tAbs - t0;
    P.temp = 27.2 + 6.4 * (1 - Math.exp(-dt / 620)) + 1.5 * Math.sin(dt / 2100) + 0.7 * Math.sin(dt / 460) + gauss() * 0.04;
    const locked = S.connected && S.scenario === 'locked';
    const acquiring = S.connected && S.scenario === 'acquiring';
    if (!S.connected) return;
    if (locked || (acquiring && rng() < 0.35)) {
      P.seq += 1;
      if (rng() < 0.002) { P.seq += 1; P.dropped += 1; }
      P.sincecal = (tAbs - t0) % CAL_PERIOD;
      if (Math.floor((tAbs - t0) / CAL_PERIOD) !== Math.floor((tAbs - 1 - t0) / CAL_PERIOD)) {
        const counts = Math.round(truePpm(P.temp) * LSE_HZ * CAL_PERIOD / 1e6 + gauss() * 0.35);
        P.calerr = counts;
        P.ppm = counts * 1e6 / (LSE_HZ * CAL_PERIOD);
        P.samples.push({ t: tAbs, temp: P.temp, ppm: P.ppm });
        if (P.samples.length > 200) P.samples.shift();
      }
      let phaseUs = gauss() * 26 + 8 * Math.sin(dt / 210);
      if (rng() < 0.02) phaseUs += (rng() < 0.5 ? -1 : 1) * (70 + rng() * 40);
      P.lastEdge = tAbs;
      P.flags = 7;
      const phaseMs = phaseUs / 1000;
      const raw = phaseMs < 0 ? 1000 + phaseMs : phaseMs;
      const subms = Math.floor(raw) % 1000;
      const frac = raw - Math.floor(raw);
      const systick = LOAD - Math.round(frac * (LOAD + 1));
      P.list.push({ t: tAbs, us: phaseUs });
      if (P.list.length > 1800) P.list.shift();
      if (!light) {
        return { seq: P.seq, epoch: tAbs, subms, systick, load: LOAD, calerr: P.calerr, sincecal: Math.floor(P.sincecal), temp: Math.round(P.temp), flags: P.flags };
      }
    } else {
      P.flags = 5; // data_valid + rtc_good, no pps — holdover
      P.sincecal = tAbs - (P.lastEdge || t0);
    }
    return null;
  }

  function log(dir, text, err) {
    S.nmeaLog.push({ t: Date.now(), dir, text, err: !!err });
    if (S.nmeaLog.length > 420) S.nmeaLog.splice(0, S.nmeaLog.length - 420);
  }

  let gsvCycle = 0;

  function tick(nowMs, light) {
    const tAbs = Math.floor(nowMs / 1000);
    if (!S.connected) {
      // Data synth OFF (no device attached): no telemetry at all. The clock
      // runs on host time independently; keep sat/fix state cleared so every
      // GNSS room shows its honest absent state.
      if (S.sats.length) S.sats = [];
      S.fix.valid = false; S.fix.type = 0; S.fix.sats = 0;
      return;
    }
    const dt = new Date(nowMs);
    const snap = satSnapshot(tAbs);
    S.sats = snap;
    const vis = snap.filter((s) => s.visible);
    const used = snap.filter((s) => s.used);

    // rise events → passes
    for (const s of vis) {
      if (!risenPrev.has(s.key)) { risenPrev.add(s.key); S.passes += 1; }
      S.peakEl = Math.max(S.peakEl, s.el);
      S.bins.add(Math.floor(s.az / 10) + ':' + Math.floor(Math.max(0, s.el) / 10));
    }
    for (const k of [...risenPrev]) if (!vis.find((s) => s.key === k)) risenPrev.delete(k);
    S.obsCount += vis.length;

    // fix + dop
    const locked = S.connected && S.scenario === 'locked' && !S.rebooting;
    const acq = S.connected && S.scenario === 'acquiring' && !S.rebooting;
    const w = tAbs - t0 + wanderSeed;
    const hdop = Math.max(0.65, 0.92 + 0.22 * Math.sin(w / 700) + 0.1 * Math.sin(w / 171) + gauss() * 0.025);
    const pdop = hdop * 1.68 + 0.12 * Math.sin(w / 300);
    const vdop = Math.sqrt(Math.max(0.1, pdop * pdop - hdop * hdop));
    S.fix.valid = locked;
    S.fix.type = locked ? 3 : acq ? 1 : 0;
    S.fix.sats = used.length;
    S.fix.hdop = hdop; S.fix.pdop = pdop; S.fix.vdop = vdop;

    if (locked) {
      const e = 0.62 * Math.sin(w / 540) + 0.45 * Math.sin(w / 97) + gauss() * 0.85 * hdop;
      const n = 0.58 * Math.sin(w / 470 + 2) + 0.4 * Math.sin(w / 130) + gauss() * 0.85 * hdop;
      S.fix.lat = obs.lat + n / 111320;
      S.fix.lon = obs.lon + e / (111320 * Math.cos(obs.lat * D2R));
      S.fix.alt = obs.alt + gauss() * 1.9 + 1.2 * Math.sin(w / 380);
      S.posHist.push({ t: tAbs, e, n, lat: S.fix.lat, lon: S.fix.lon, alt: S.fix.alt });
      if (S.posHist.length > 3600) S.posHist.shift();
      S.fixAgeT = nowMs;
    }
    S.dopHist.push({ t: tAbs, h: hdop, p: pdop, v: vdop });
    if (S.dopHist.length > 3600) S.dopHist.shift();
    S.fixHist.push({ t: tAbs, type: S.fix.type, sats: used.length });
    if (S.fixHist.length > 3600) S.fixHist.shift();

    // cn0 + trails
    for (const s of vis) {
      let h = S.cn0Hist.get(s.key);
      if (!h) { h = []; S.cn0Hist.set(s.key, h); }
      h.push({ t: tAbs, v: s.cn0 });
      if (h.length > 1800) h.shift();
      if (tAbs % 30 === 0) {
        let tr = S.trails.get(s.key);
        if (!tr) { tr = []; S.trails.set(s.key, tr); }
        tr.push({ t: tAbs, az: s.az, el: s.el });
        if (tr.length > 180) tr.shift();
      }
      if (tAbs % 45 === 0) {
        let gt = S.gtrails.get(s.key);
        if (!gt) { gt = []; S.gtrails.set(s.key, gt); }
        gt.push({ lat: s.geo.lat, lon: s.geo.lon });
        if (gt.length > 40) gt.shift();
      }
    }

    // pps
    const pkt = ppsSample(tAbs, light);

    // nmea
    if (S.connected && !S.rebooting && !light) {
      const lines = [nmea.gga(dt, S.fix), nmea.gsa(S.fix, used), nmea.rmc(dt, S.fix)];
      const cs = CONSTS[gsvCycle % CONSTS.length]; gsvCycle += 1;
      const csSats = vis.filter((s) => s.constId === cs.id).slice(0, 8);
      if (csSats.length) lines.push(...nmea.gsv(cs.talker, csSats).slice(0, 2));
      if (tAbs % 10 === 0) lines.push(nmea.zda(dt));
      if (pkt) lines.push(nmea.pmtxts(pkt));
      S.nmeaRate = lines.length;
      for (const l of lines) log('rx', l);
    } else S.nmeaRate = 0;

    // weather drift
    if (tAbs % 60 === 0) {
      const W = S.weather;
      W.temp += gauss() * 0.06; W.rh = Math.max(30, Math.min(97, W.rh + gauss() * 0.4));
      W.mslp += gauss() * 0.05; W.wind = Math.max(0.3, W.wind + gauss() * 0.2);
      W.gust = W.wind + 2.4 + rng() * 1.5; W.dir = (W.dir + gauss() * 2 + 360) % 360;
      W.app = W.temp - 1.1 - W.wind * 0.05; W.asOf = nowMs;
    }
  }

  // ---- preroll: generate the last `preroll` seconds of history so a freshly
  // connected (simulated) device shows populated charts at once. Data synth is
  // OFF by default, so this runs on connect() — NOT at startup. A fresh load
  // shows the honest absent state (host-time clock only, no fake telemetry).
  let prerolled = false;
  function doPreroll() {
    if (prerolled) return;
    prerolled = true;
    const nowSec = Math.floor(Date.now() / 1000);
    for (let t = nowSec - preroll; t < nowSec; t += 1) tick(t * 1000, t < nowSec - 40);
    S.weather.asOf = Date.now();
  }

  return {
    S, obs,
    tick(nowMs) { tick(nowMs, false); },
    setScenario(s) { S.scenario = s; },
    connect() { S.connected = true; doPreroll(); },
    disconnect() {
      S.connected = false; S.fix.valid = false; S.fix.type = 0; S.fix.sats = 0; S.sats = [];
      // Clear every history buffer the sim populated, so LEAVING a simulation doesn't leave ghost
      // sat trails in the SKY/globe rooms or stale scalars in the TIMING room (mirrors realdev.disconnect).
      if (S.gtrails && S.gtrails.clear) S.gtrails.clear();
      if (S.trails && S.trails.clear) S.trails.clear();
      if (S.cn0Hist && S.cn0Hist.clear) S.cn0Hist.clear();
      if (Array.isArray(S.posHist)) S.posHist.length = 0;
      if (Array.isArray(S.dopHist)) S.dopHist.length = 0;
      if (Array.isArray(S.fixHist)) S.fixHist.length = 0;
      if (S.pps && Array.isArray(S.pps.list)) S.pps.list.length = 0;   // → TIMING KPIs go honest (no stale stream)
    },
    reboot() {
      S.rebooting = true;
      log('tx', wrap('PMTX,REBOOT'));
      setTimeout(() => { log('rx', wrap('PMTX,REBOOTING')); }, 220);
      setTimeout(() => { S.rebooting = false; log('rx', wrap('PMTX,BOOT,MK4,CRC,9E41')); }, 2600);
    },
    send(cmd) {
      const body = cmd.replace(/^\$/, '').replace(/\*[0-9A-Fa-f]{2}$/, '');
      log('tx', wrap(body));
      if (!S.connected) { setTimeout(() => log('rx', 'ERR: port closed — command not delivered', true), 160); return; }
      setTimeout(() => log('rx', wrap('PMTX,ACK,' + body.split(',')[0])), 240 + rng() * 200);
    },
    log,
    fit() { return fitQuad(S.pps.samples); },
    // ---- exports ----
    toCSV() {
      const rows = ['t_iso,lat,lon,alt_m,east_m,north_m,hdop,pdop,vdop,sats,fix'];
      const d = S.dopHist, f = S.fixHist;
      S.posHist.forEach((p, i) => {
        const dd = d[d.length - S.posHist.length + i] || {}, ff = f[f.length - S.posHist.length + i] || {};
        rows.push([new Date(p.t * 1000).toISOString(), p.lat.toFixed(7), p.lon.toFixed(7), p.alt.toFixed(1),
        p.e.toFixed(3), p.n.toFixed(3), (dd.h || 0).toFixed(2), (dd.p || 0).toFixed(2), (dd.v || 0).toFixed(2), ff.sats || 0, ff.type || 0].join(','));
      });
      return rows.join('\n');
    },
    toGPX() {
      const pts = S.posHist.filter((_, i) => i % 5 === 0).map((p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.alt.toFixed(1)}</ele><time>${new Date(p.t * 1000).toISOString()}</time></trkpt>`).join('\n');
      return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PCC Web"><trk><name>PCC session</name><trkseg>\n${pts}\n</trkseg></trk></gpx>`;
    },
    toJSON() {
      return JSON.stringify({
        session: { started: new Date(t0 * 1000).toISOString(), observer: obs, grid: maidenhead(obs.lat, obs.lon) },
        stats: { passes: S.passes, observations: S.obsCount, peakEl: +S.peakEl.toFixed(1), fixes: S.posHist.length },
        pps: { samples: S.pps.samples.length, jitterSeries: S.pps.list.length, fit: fitQuad(S.pps.samples) },
        satellites: S.sats.filter((s) => s.visible).map((s) => ({ id: s.key, az: +s.az.toFixed(1), el: +s.el.toFixed(1), cn0: +s.cn0.toFixed(1), used: s.used })),
      }, null, 2);
    },
    toNMEA() { return S.nmeaLog.filter((l) => l.dir === 'rx').map((l) => l.text).join('\n'); },
    // Satellite history CSV — the sky views' own buffers exported: trails (az/el @ 30 s/pt) joined
    // with the C/N0 sample nearest each point (cn0Hist @ 1 s/pt; blank if none within 15 s — the
    // two histories have different retention, so either can outlive the other). Rows grouped by
    // satellite, chronological within each. 'used' exists only in the live snapshot, not in the
    // per-point history, so it is omitted rather than back-filled from the present.
    toSatCSV() {
      const rows = ['t_iso,sat,az_deg,el_deg,cn0_dbhz'];
      for (const key of [...S.trails.keys()].sort()) {
        const cn0 = S.cn0Hist.get(key) || [];
        let j = 0;
        for (const p of S.trails.get(key)) {
          while (j < cn0.length - 1 && Math.abs(cn0[j + 1].t - p.t) <= Math.abs(cn0[j].t - p.t)) j++;
          const c = cn0.length && Math.abs(cn0[j].t - p.t) <= 15 ? cn0[j].v.toFixed(1) : '';
          rows.push([new Date(p.t * 1000).toISOString(), key, p.az.toFixed(1), p.el.toFixed(1), c].join(','));
        }
      }
      return rows.join('\n');
    },
  };
}
