// demo7.js — SHOWCASE: a minute-locked choreography played entirely on the clock's own
// ~132 light elements (segments, decimal points, colon dots). Nothing is added to the panel;
// the magic is brightness, timing and the fact that every element sits at a known position.
//
// The composition (synthesised from a 4-concept / 3-judge design panel; every act keeps the
// live time recoverable — effects MULTIPLY or DECORATE the real glyph mask, never replace it):
//   :00–:14  ALIVE      the live face, but every segment flip BLOOMS and melts (change-detection
//                       impulses + decay tails) — digits pour instead of switch.
//   :14–:34  HEARTBEAT  the six big digits become a phosphor oscilloscope sweeping the firmware's
//            SCOPE      verbatim 200-entry colon DMA table, phase-locked to the live colonStep —
//                       so the REAL colon dots pulse at the exact instant the beam crosses them.
//                       The instrument draws its own pulse. Date row reads "HEArtbEAt".
//   :34–:50  SATELLITE  the face dims to a readable ghost; the real tracked satellites fall down
//            RAIN       their true azimuth columns (brightness = C/N0) into a baseline pool that
//                       ripples on every displayed second. No fix → PPS droplets only (honesty).
//   :50–:55  PENDULUM   sixteen digit columns oscillate at stepped frequencies — chaos that is
//                       mathematically guaranteed to collapse into unison exactly at :55.
//   :55–:60  LANDING    the plain, calm, correct clock. At :59→:00 THE CARRY: the dying seconds
//                       pour a bolus of light leftward across the colon into the minutes digit,
//                       which drinks it and increments. Then the loop breathes again.
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
  const PHOS = new Float32Array(N);   // scope phosphor
  const PREV = new Uint8Array(N);     // previous lit-state of the live mask

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
      let wScope, wRain, wPend;
      if (program === 'chime') {
        const rel = (nowMs - startMs) / 1000;
        wScope = actW(rel, 3, 13, 0.8); wRain = 0; wPend = 0;
        if (rel > 13.5 && exitT < 0) exitT = nowMs;
      } else {
        wScope = actW(secf, 14, 34);
        wRain = actW(secf, 34, 50);
        wPend = actW(secf, 50, 55, 0.6);
        // hourly cuckoo: one full cycle — bow out just after THE CARRY lands
        if (program === 'hour' && carried && carryT < 0 && exitT < 0) exitT = nowMs;
      }
      const wAlive = clamp01(1 - wScope - wRain - wPend);

      // scope beam (phase-locked to the firmware colon DMA index)
      const stepP = ((tm.colonStep != null ? tm.colonStep : Math.floor(nowMs / 10)) % 200) / 200;
      const beamX = bigMinX + stepP * (bigMaxX - bigMinX);
      const traceY = 0.96 - HEART[Math.floor(stepP * 200) % 200] * 0.34;  // within the time band

      // date row overlay for the scope act ("HEArtbEAt" in the real 7-seg alphabet)
      const heartField = wScope > 0 ? dateFace.computeField({ dateRow: 'HEArtbEAt ' }, nowMs) : null;

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
        PHOS[i] *= Math.exp(-dt / 0.45);

        let t = 0;
        if (wAlive > 0) t += wAlive * L;
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
        t = clamp01(t + BLOOM[i] * 0.8);

        // decay tails: instant attack, exponential release — flips melt instead of snapping.
        // Fast elements get an almost-instant release so consecutive ms glyphs never smear.
        V[i] = t >= V[i] ? t : t + (V[i] - t) * Math.exp(-dt / (fast ? 0.03 : 0.16));
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
