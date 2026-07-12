// demo7.js — SHOWCASE: a minute-locked choreography played entirely on the clock's own
// ~132 light elements (segments, decimal points, colon dots). Nothing is added to the panel;
// the magic is brightness, timing and the fact that every element sits at a known position.
//
// SHOWCASE II is a TWO-MINUTE composition — theme and variations. Every act keeps the live
// time recoverable (effects MULTIPLY or DECORATE the real glyph mask, never replace it), and
// both minutes resolve identically: the pendulum collapses into unison at :55, the calm
// correct clock, THE CARRY at :59. The displayed minute's parity picks the half:
//
// EVEN minutes — the PHYSICS half (what a 7-segment display is):
//   :00–:06  ALIVE      change-detection blooms — digits pour instead of switching.
//   :06–:20  MORPH      time in slow motion: at each second boundary the leaving segments
//                       drain while the arriving ones fill, ~0.85 s of liquid crossfade,
//                       staggered right-to-left so a :59→:00 carry becomes a visible cascade
//                       rolling from the seconds toward the hours. The fast digits are exempt
//                       — their honest counting IS their spectacle.
//   :20–:34  THE SCAN   variable refresh made visible: the fused face melts into the writing
//                       beam a multiplexed display really is — a comet sweeping the board at
//                       60 column-steps/s while the date row counts the rate live ("SCAn 60"),
//                       then the rate climbs exponentially to the stock 20000 and the beams
//                       fuse back into solid light. Persistence of vision, demonstrated on
//                       the instrument that depends on it.
//   :34–:50  DEVELOP    darkroom: the face dissolves into red grain, then the LIVE, still-
//                       ticking time condenses out of the noise like a print in developer —
//                       patchy, then filling, then fixed sharp. Date row: "dEUELOPInG".
//
// ODD minutes — the INSTRUMENT half (what this particular clock knows):
//   :06–:26  HEARTBEAT  the six big digits become a phosphor oscilloscope sweeping the
//            SCOPE      firmware's verbatim 200-entry colon DMA table, phase-locked to the
//                       live colonStep — the REAL colon dots pulse at the exact instant the
//                       beam crosses them. Date row reads "HEArtbEAt".
//   :26–:46  SATELLITE  real tracked satellites fall down their true azimuth columns
//            RAIN       (brightness = C/N0) into a pool that ripples every displayed second.
//                       No fix → PPS droplets only (honesty).
//
// BOTH minutes:
//   :50–:55  PENDULUM   digit columns oscillate at stepped frequencies — chaos mathematically
//                       guaranteed to collapse into unison exactly at :55.
//   :55–:60  LANDING    the plain, calm, correct clock. At :59→:00 THE CARRY: the dying
//                       seconds pour a bolus of light leftward across the colon into the
//                       minutes digit, which drinks it and increments.
//
// All simulation time derives from the wall clock and the DISPLAYED time (never frame counts),
// so 60 vs 120 Hz and dropped frames cannot desync the minute-locked structure.

// The firmware heartbeat table, verbatim (main.c loadColonAnimation COLON_MODE_HEARTBEAT).
function heartbeatTable() {
  const L = new Array(200).fill(0);
  for (let k = 0; k < 50; k++) L[k] = k * 4;
  for (let k = 0; k < 100; k++) L[k + 50] = 200 - k * 2;
  return L.map((v) => v / 200);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const g = (d, s) => Math.exp(-(d * d) / (2 * s * s));   // gaussian falloff
// smooth act crossfades: weight 1 inside [a,b], eased over `e` seconds either side
function actW(t, a, b, e = 0.9) {
  const rise = clamp01((t - a) / e), fall = clamp01((b - t) / e);
  return Math.min(rise, fall);
}

// program: 'loop'  — the full minute-locked cycle, repeating until stop() (the SHOWCASE button)
//          'hour'  — one full cycle, auto-exits right after THE CARRY lands (the hourly cuckoo)
//          'chime' — a short flourish: blooms + one heartbeat-scope burst, ~13 s (quarter cuckoo)
export function createShowcase({ dateFace, timeFace, program = 'loop' }) {
  const HEART = heartbeatTable();

  // ---- unified element space -------------------------------------------------------------
  // Visual coordinates: x 0..1 across the board, y 0..1 down the whole clock
  // (date row band 0..0.42, time row band 0.58..1). The date board is rotated 180° by its
  // container, so its raw coords flip to visual space here.
  const els = [];        // {face:'date'|'time', cell, type:'seg'|'dp'|'dotA'|'dotB', s, x, y}
  const fieldShape = {}; // per face: cell descriptors to rebuild output fields cheaply
  for (const [fk, face, band] of [['date', dateFace, [0.02, 0.40]], ['time', timeFace, [0.60, 0.98]]]) {
    const geo = face.segGeometry();
    const nx = (x) => { let v = (x - geo.vb.x) / geo.vb.w; return geo.inverted ? 1 - v : v; };
    const ny = (y) => { let v = (y - geo.vb.y) / geo.vb.h; if (geo.inverted) v = 1 - v; return band[0] + v * (band[1] - band[0]); };
    fieldShape[fk] = geo.els.map((e) => e.kind);
    for (const e of geo.els) {
      if (e.kind === 'colon') {
        els.push({ face: fk, cell: e.cell, type: 'dotA', x: nx(e.a.x), y: ny(e.a.y) });
        els.push({ face: fk, cell: e.cell, type: 'dotB', x: nx(e.b.x), y: ny(e.b.y) });
      } else {
        for (let s = 0; s < 7; s++) els.push({ face: fk, cell: e.cell, type: 'seg', s, role: e.role, x: nx(e.segs[s].x), y: ny(e.segs[s].y) });
        els.push({ face: fk, cell: e.cell, type: 'dp', role: e.role, x: nx(e.dp.x), y: ny(e.dp.y) });
      }
    }
  }
  const N = els.length;
  // column x-centres of the 16 digit cells (for the pendulum), and the big-digit x extent
  const colX = [];
  {
    const seen = new Map();
    for (const e of els) if (e.type === 'seg') {
      const k = e.face + ':' + e.cell;
      if (!seen.has(k)) seen.set(k, { sum: 0, n: 0 });
      const a = seen.get(k); a.sum += e.x; a.n++;
    }
    for (const a of seen.values()) colX.push(a.sum / a.n);
    colX.sort((p, q) => p - q);
  }
  const bigXs = els.filter((e) => e.face === 'time' && e.type === 'seg' && e.role === 'big').map((e) => e.x);
  const bigMinX = Math.min(...bigXs), bigMaxX = Math.max(...bigXs);
  const colonXs = els.filter((e) => e.face === 'time' && e.type === 'dotA').map((e) => e.x).sort((a, b) => a - b);

  // per-element runtime state
  const V = new Float32Array(N);      // rendered value (for decay tails)
  const BLOOM = new Float32Array(N);  // change-detection impulses
  const PHOS = new Float32Array(N);   // scope/scan phosphor (the two acts never share a minute)
  const PREV = new Uint8Array(N);     // previous lit-state of the live mask
  const LFRAME = new Float32Array(N); // last frame's live values (snapshotted into MPREV at ticks)
  const MPREV = new Float32Array(N);  // pre-tick mask — the MORPH act crossfades MPREV → live
  // per-element randoms for DEVELOP (grain timing + development order), seeded from the index so
  // every run of the act develops differently-but-deterministically within a frame
  const RND_R = new Float32Array(N);  // development order threshold 0..1
  const RND_TAU = new Float32Array(N); // grain flicker interval (ms)
  const RND_PH = new Float32Array(N);  // grain phase
  for (let i = 0; i < N; i++) {
    const h1 = Math.abs(Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
    const h2 = Math.abs(Math.sin(i * 269.5 + 183.3) * 43758.5453) % 1;
    RND_R[i] = h1; RND_TAU[i] = 70 + h2 * 60; RND_PH[i] = h1 * 7;
  }
  // film grain: a hash that re-rolls every tau ms per element — time-quantized shimmer, not video noise
  const grain = (i, t) => {
    const k = Math.floor(t / RND_TAU[i] + RND_PH[i]);
    const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return h - Math.floor(h);
  };
  let morphT = 0;                     // wall ms of the last displayed-second boundary (MORPH clock)
  let scanPhi = 0;                    // scan beam phase (whole sweeps)

  // baseline pool: 1-D damped wave across 24 nodes
  const PN = 24;
  const pool = new Float32Array(PN), poolV = new Float32Array(PN);
  const nodeAt = (x) => Math.max(0, Math.min(PN - 1, Math.round(x * (PN - 1))));

  let lastMs = 0, lastSec = -1, lastMin = -1;
  let carryT = -1;                    // wall ms the carry bolus started
  const satPh = new Map();            // per-sat drop-phase memory for splash detection
  let exitT = -1;                     // wall ms exit ramp started (stop() requested)
  let done = false;
  let startMs = 0;                    // first frame wall ms ('chime' timeline is start-relative)
  let carried = false;                // 'hour': the carry has played — exit after it lands

  function liveOf(fields, e) {
    const f = fields[e.face][e.cell];
    if (!f) return 0;
    if (e.type === 'dotA') return f.a || 0;
    if (e.type === 'dotB') return f.b || 0;
    if (e.type === 'dp') return f.dp || 0;
    return f.segs[e.s] || 0;
  }

  return {
    stop() { if (exitT < 0) exitT = performance.now(); },
    isDone() { return done; },
    // model = the emulator device frame ({dateRow, time:{big,small,dp,smallFade,colonStep,...}});
    // ctx = { sats: [{az,el,cn0,prn}] } — real birds only (empty in standby per the data policy).
    frame(nowMs, model, ctx) {
      if (done) return null;
      if (!startMs) startMs = nowMs;
      const dt = Math.min(0.1, lastMs ? (nowMs - lastMs) / 1000 : 0.016);
      lastMs = nowMs;

      // live glyph mask for both faces (what the honest renderer would paint right now)
      const fields = {
        date: dateFace.computeField({ dateRow: model.dateRow }, nowMs),
        time: timeFace.computeField({ time: model.time }, nowMs),
      };
      const tm = model.time || {};
      const big = tm.big || [0, 0, 0, 0, 0, 0];
      const sec = (typeof big[4] === 'number' && typeof big[5] === 'number') ? big[4] * 10 + big[5] : Math.floor(nowMs / 1000) % 60;
      const subs = (nowMs % 1000) / 1000;
      const secf = sec + subs;
      const minKey = String(big[2]) + String(big[3]);

      // ---- events -----------------------------------------------------------------------
      if (sec !== lastSec) {                                   // displayed second boundary
        const i = nodeAt(colonXs[0] != null ? colonXs[0] : 0.5);
        poolV[i] -= 2.4;                                       // PPS droplet into the pool
        MPREV.set(LFRAME);                                     // freeze the pre-tick mask —
        morphT = nowMs;                                        // MORPH crossfades it → live
        lastSec = sec;
      }
      if (lastMin !== -1 && minKey !== lastMin) { carryT = nowMs; carried = true; } // minute rolled → THE CARRY
      lastMin = minKey;

      // pool wave step (damped, wall-clock)
      for (let i = 0; i < PN; i++) {
        const l = pool[Math.max(0, i - 1)], r = pool[Math.min(PN - 1, i + 1)];
        poolV[i] += (l + r - 2 * pool[i]) * 90 * dt;
        poolV[i] *= Math.exp(-1.6 * dt);
      }
      for (let i = 0; i < PN; i++) pool[i] += poolV[i] * dt;

      // act weights (smooth crossfades; ALIVE covers the landing + wrap). The full programs run
      // the minute-locked timeline; 'chime' is start-relative: blooms, one scope burst, out.
      // The displayed minute's parity picks the half: EVEN = physics (MORPH/SCAN/DEVELOP),
      // ODD = instrument (SCOPE/RAIN). Both halves share the pendulum finale + landing.
      let wScope = 0, wRain = 0, wPend = 0, wMorph = 0, wScan = 0, wDev = 0;
      if (program === 'chime') {
        const rel = (nowMs - startMs) / 1000;
        wScope = actW(rel, 3, 13, 0.8);
        if (rel > 13.5 && exitT < 0) exitT = nowMs;
      } else {
        const mm = (typeof big[2] === 'number' && typeof big[3] === 'number') ? big[2] * 10 + big[3] : 0;
        if (mm % 2 === 0) {           // PHYSICS half
          wMorph = actW(secf, 6, 20);
          wScan = actW(secf, 20, 34);
          wDev = actW(secf, 34, 50);
        } else {                      // INSTRUMENT half
          wScope = actW(secf, 6, 26);
          wRain = actW(secf, 26, 46);
        }
        wPend = actW(secf, 50, 55, 0.6);
        // hourly cuckoo: one full cycle — bow out just after THE CARRY lands
        if (program === 'hour' && carried && carryT < 0 && exitT < 0) exitT = nowMs;
      }
      const wAlive = clamp01(1 - wScope - wRain - wPend - wMorph - wScan - wDev);

      // scope beam (phase-locked to the firmware colon DMA index)
      const stepP = ((tm.colonStep != null ? tm.colonStep : Math.floor(nowMs / 10)) % 200) / 200;
      const beamX = bigMinX + stepP * (bigMaxX - bigMinX);
      const traceY = 0.96 - HEART[Math.floor(stepP * 200) % 200] * 0.34;  // within the time band

      // date row overlay for the scope act ("HEArtbEAt" in the real 7-seg alphabet)
      const heartField = wScope > 0 ? dateFace.computeField({ dateRow: 'HEArtbEAt ' }, nowMs) : null;

      // THE SCAN — variable-refresh physics. The rate R is column-steps/second, the number a
      // multimeter would read on the cathode drive: cruise at a visible 60, then climb
      // exponentially to the stock MATRIX_FREQUENCY (20000) and fuse. One sweep of the writing
      // beam = 5 column steps, exactly like the hardware's 5-slot scan.
      let beamSX = -1, fuseK = 1, scanField = null, scanRateStr = '';
      if (wScan > 0) {
        const u = clamp01((secf - 20) / 14);                   // act-local 0..1
        const wob = 1 + 0.12 * Math.sin(nowMs / 260);          // organic cruise wobble
        const R = u < 0.42 ? 60 * wob
          : u < 0.86 ? 60 * Math.exp(Math.log(20000 / 60) * (u - 0.42) / 0.44)
          : 20000;
        const meltIn = clamp01(1 - u / 0.08);                  // start fused, melt into the beam
        fuseK = Math.max(meltIn, clamp01((R - 2000) / 10000)); // re-fuse as the rate climbs
        scanPhi += (R / 5) * dt;                               // sweeps advance at R/5 per second
        beamSX = scanPhi % 1;
        scanRateStr = ('SCAn' + String(Math.round(R)).padStart(6, ' ')).slice(0, 10);
        scanField = dateFace.computeField({ dateRow: scanRateStr }, nowMs);
      }

      // DEVELOP — darkroom envelope. dis = dissolve-in, dev = development progress (elements
      // develop in RND_R order, like grains in developer), fix = final sharpen; grainAmp dies to 0.
      let devDis = 0, devP = 0, devGrain = 0, devField = null;
      if (wDev > 0) {
        const u = clamp01((secf - 34) / 16);                   // act-local 0..1
        devDis = clamp01(u / 0.14);                            // image → grain
        devP = clamp01((u - 0.16) / 0.62);                     // grain → image, per-element order
        devGrain = devDis * (1 - clamp01((u - 0.78) / 0.16)) * (0.55 - 0.35 * devP);
        devField = dateFace.computeField({ dateRow: 'dEUELOPInG' }, nowMs);
      }

      // satellite rain setup (top 14 birds, honest: none when no real/sim constellation)
      const sats = (ctx.sats || []).filter((s) => s.el > 0).slice(0, 14);
      const drops = sats.map((s) => {
        const period = 2400 + (s.prn % 5) * 340;
        const ph = ((nowMs + s.prn * 977) % period) / period;
        const prev = satPh.get(s.prn);
        if (wRain > 0.3 && prev != null && prev < 0.88 && ph >= 0.88) poolV[nodeAt(s.az / 360)] -= 1.6 * clamp01((s.cn0 - 20) / 28); // splash
        satPh.set(s.prn, ph);
        return { x: s.az / 360, y: 0.05 + ph * 0.85, w: 0.25 + 0.75 * clamp01((s.cn0 - 20) / 28) };
      });

      // carry bolus (runs on top of whatever act is live; ~0.7 s, seconds → minutes)
      let carryP = -1;
      if (carryT > 0) {
        const cp = (nowMs - carryT) / 700;
        if (cp >= 1) carryT = -1; else carryP = cp;
      }
      // sec-pair and min-pair x centres from the big digit columns (time face)
      const xSec = (colX[colX.length - 1] + colX[colX.length - 2]) / 2;
      const xMin = colX.length >= 16 ? (colX[8] + colX[9]) / 2 : 0.5;

      // ---- per-element composition --------------------------------------------------------
      for (let i = 0; i < N; i++) {
        const e = els[i];
        const L = liveOf(fields, e);
        // Shape mask, immune to the holdover significance-fade: the fade is the FIRMWARE's own
        // honesty dimming and must not stack with (or trigger) choreography — a fade sweep firing
        // change-blooms read as flicker. Blooms key on shape; the honest fade still rides through
        // the ALIVE / PENDULUM acts where the real face is the material.
        const m = L > 0.03 ? 1 : 0;
        // FAST elements — the sub-second digits (+ their DPs) and the colon dots — change many
        // times per second BY DESIGN. Blooming them never decays (every segment is always freshly
        // flipped), which saturated all three into solid "8"s and made them ignore the dimming
        // acts. They get no blooms and near-instant tails: their spectacle IS the honest counting.
        const fast = e.role === 'small' || e.type === 'dotA' || e.type === 'dotB';
        if (m !== PREV[i]) { if (!fast) BLOOM[i] = 1; PREV[i] = m; }
        BLOOM[i] *= Math.exp(-dt / 0.35);
        // Phosphor release: the scope wants long CRT tails; the scan's comet needs a short one
        // (~55 ms) so the beam reads as a beam at cruise and only fuses as the rate climbs.
        PHOS[i] *= Math.exp(-dt / (wScan > 0 ? 0.055 : 0.45));

        let t = 0;
        if (wAlive > 0) t += wAlive * L;
        if (wMorph > 0) {
          // Time in slow motion: crossfade the pre-tick mask → live, staggered right-to-left from
          // the seconds pair so a carry cascades visibly toward the hours. Fast elements are
          // exempt (their honest counting is the spectacle) — they ride the live mask.
          let mv;
          if (fast) mv = L;
          else {
            const span = Math.max(1e-6, xSec - xMin);
            const lag = e.face === 'time' ? 0.35 * clamp01((xSec - e.x) / span) : 0;
            const p = morphT ? clamp01((nowMs - morphT) / 850) : 1;
            const q0 = clamp01((p - lag) / 0.65);
            const q = q0 * q0 * (3 - 2 * q0);                  // smoothstep — liquid, not linear
            const d = L - MPREV[i];
            mv = MPREV[i] + d * q;
            if (Math.abs(d) > 0.5) mv += 0.35 * Math.abs(d) * Math.sin(Math.PI * q);  // front shimmer
          }
          t += wMorph * clamp01(mv);
        }
        if (wScan > 0) {
          // The writing beam: light lives only where the beam is passing (short phosphor tail),
          // fusing back into the plain mask as the rate climbs — persistence of vision, live.
          let dx = Math.abs(e.x - beamSX); if (dx > 0.5) dx = 1 - dx;   // seamless wrap
          const imp = g(dx, 0.018);
          if (imp > PHOS[i]) PHOS[i] = imp;
          const mask = e.face === 'date' ? (liveOf({ date: scanField, time: fields.time }, e) > 0.03 ? 1 : 0) : m;
          const lv = e.face === 'date' ? 0.62 : (e.role === 'small' ? 0.5 : 1);
          t += wScan * lv * mask * Math.max(PHOS[i] * (1 - fuseK), fuseK * (e.face === 'date' ? 1 : L));
        }
        if (wDev > 0) {
          // Darkroom: the live mask dissolves into time-quantized grain, then develops back in
          // RND_R order (patchy → filling → fixed), the grain fog dying as the print fixes.
          const mask = e.face === 'date' ? (liveOf({ date: devField, time: fields.time }, e) > 0.03 ? 1 : 0) : m;
          const q0 = clamp01((devP - RND_R[i] * 0.72) / 0.28);
          const q = q0 * q0 * (3 - 2 * q0);                    // per-element development
          const sig = (1 - devDis) + devDis * q;               // signal survives dissolve via development
          const gn = grain(i, nowMs) * devGrain * (mask ? 1 : 0.4);
          const base = e.face === 'date' ? 0.62 : (fast ? 0.6 : 1);
          t += wDev * clamp01(base * sig * (mask ? (e.face === 'date' ? 1 : L) : 0) + gn);
        }
        if (wScope > 0) {
          let sv;
          if (e.face === 'date') sv = 0.55 * liveOf({ date: heartField, time: fields.time }, e);
          else if (e.type === 'dotA' || e.type === 'dotB') sv = L;                    // the real pulse
          else if (e.role === 'small') sv = 0.35 * m;                                 // live ms anchor (shape)
          else {                                                                       // the trace
            const imp = g(e.x - beamX, 0.016) * g(e.y - traceY, 0.055);
            if (imp > PHOS[i]) PHOS[i] = imp;
            sv = PHOS[i];
          }
          t += wScope * sv;
        }
        if (wRain > 0) {
          // the sub-second digits stay a readable anchor through the rain — the pulse never stops
          let rv = (e.role === 'small' ? 0.30 : 0.16) * m;
          for (const d of drops) rv += d.w * g(e.x - d.x, 0.03) * g(e.y - d.y, 0.05);
          if (e.y > 0.9) rv += clamp01(Math.abs(pool[nodeAt(e.x)]) * 1.4);
          t += wRain * clamp01(rv);
        }
        if (wPend > 0) {
          // nearest digit column; stepped frequencies re-phase exactly at :55
          let ci = 0, best = 1e9;
          for (let c = 0; c < colX.length; c++) { const d = Math.abs(colX[c] - e.x); if (d < best) { best = d; ci = c; } }
          const f = (8 + ci) / 8;
          const ph = Math.PI * f * (secf - 55);
          t += wPend * L * (0.18 + 0.82 * Math.cos(ph) * Math.cos(ph));
        }
        if (carryP >= 0 && e.face === 'time') {
          const pos = xSec + (xMin - xSec) * carryP;             // right → left across the colon
          t += 0.95 * g(e.x - pos, 0.05) * Math.sin(Math.PI * carryP);
        }
        // Blooms fight the new acts (a flash on top of a slow morph / a scanned dark gap / half-
        // developed grain reads as glitch) — suppress them in proportion to those act weights.
        t = clamp01(t + BLOOM[i] * 0.8 * clamp01(1 - wMorph - wScan - wDev));

        // decay tails: instant attack, exponential release — flips melt instead of snapping.
        // Fast elements get an almost-instant release so consecutive ms glyphs never smear.
        // THE SCAN provides its own persistence model (the phosphor tail) — the smoothing tail
        // would smear the beam's dark gaps shut, so it collapses to near-instant there.
        const rel = fast ? 0.03 : (wScan > 0.5 ? 0.02 : 0.16);
        V[i] = t >= V[i] ? t : t + (V[i] - t) * Math.exp(-dt / rel);
        LFRAME[i] = L;                                           // pre-tick snapshot source (MORPH)
      }

      // exit ramp: blend back to the live mask over 0.5 s, then report done
      let k = 1;
      if (exitT >= 0) {
        k = 1 - clamp01((nowMs - exitT) / 500);
        if (k <= 0) { done = true; return null; }
      }

      // ---- assemble output fields ---------------------------------------------------------
      const out = { date: [], time: [] };
      for (let i = 0; i < N; i++) {
        const e = els[i];
        const L = liveOf(fields, e);
        const v = k * V[i] + (1 - k) * L;
        const arr = out[e.face];
        let f = arr[e.cell];
        if (!f) f = arr[e.cell] = (e.type === 'dotA' || e.type === 'dotB') ? { a: 0, b: 0 } : { segs: new Array(7).fill(0), dp: 0 };
        if (e.type === 'dotA') f.a = v;
        else if (e.type === 'dotB') f.b = v;
        else if (e.type === 'dp') f.dp = v;
        else f.segs[e.s] = v;
      }
      return out;
    },
  };
}
