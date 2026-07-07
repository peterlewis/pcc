// charts.js — flat instrument-grade canvas charts for PCC Web.
// Discipline: hairline graticules, square markers, mono labels, no gradients, no glow.

const TAU = Math.PI * 2;

export function c2d(canvas) {
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 150;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const F9 = '9px "B612 Mono", monospace';
const F10 = '10px "B612 Mono", monospace';

function clear(ctx, w, h, tok) { ctx.clearRect(0, 0, w, h); ctx.fillStyle = tok.inset; ctx.fillRect(0, 0, w, h); }

function sq(ctx, x, y, s) { ctx.fillRect(x - s / 2, y - s / 2, s, s); }

// ---------------------------------------------------------------- sky plot
export function drawSky(canvas, tok, data, opts) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 22;
  const pt = (az, el) => {
    const r = (90 - Math.max(-4, el)) / 90 * R;
    return [cx + r * Math.sin(az * Math.PI / 180), cy - r * Math.cos(az * Math.PI / 180)];
  };

  // signal-density field — per-sat soft radial blobs, C/N0 ramped red(weak)→green(strong),
  // accumulated additively into a continuous KDE-style field (current sats + decimated trails)
  if (opts.heatmap) {
    // inset is a dark screen in both shipping themes; stay robust if it ever goes light
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(tok.inset || '') ||
      /(\d+)\D+(\d+)\D+(\d+)/.exec(tok.inset || '');
    const nb = m ? (m[0][0] === '#' || /[a-f]/i.test(m[1]) ? 16 : 10) : 10;
    const lum = m ? (parseInt(m[1], nb) * 0.299 + parseInt(m[2], nb) * 0.587 + parseInt(m[3], nb) * 0.114) : 0;
    const onLight = lum > 140, k = onLight ? 2.2 : 1;   // lift a touch if bg is bright
    const blob = (x, y, cn0, rad, a) => {
      const q = cn0 == null ? 0 : Math.max(0, Math.min(1, (cn0 - 20) / 28));
      const c = Math.round(255 * (1 - q)) + ',' + Math.round(200 * q) + ',80,';
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(' + c + Math.min(0.5, a * k).toFixed(3) + ')');   // cap keeps multiply from over-darkening
      g.addColorStop(1, 'rgba(' + c + '0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    };
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();     // keep blobs inside the sky disc
    ctx.globalCompositeOperation = onLight ? 'multiply' : 'lighter';
    // trail history — newest-first, ≥10 px apart, ≤32 samples per sat: a soft base field of travelled sky
    for (const tr of data.trails.values()) {
      let lx = -1e9, ly = -1e9, n = 0;
      for (let i = tr.length - 1; i >= 0 && n < 32; i--) {
        const p = tr[i];
        if (p.el < 0 || p.cn0 == null) continue;
        const [x, y] = pt(p.az, p.el);
        if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < 100) continue;
        blob(x, y, p.cn0, 26, 0.05); lx = x; ly = y; n++;
      }
    }
    // current sats — the design blob: radius 30, centre alpha .16 (bright foreground)
    for (const s of data.sats) {
      if (s.el < 0) continue;
      const [x, y] = pt(s.az, s.el);
      blob(x, y, s.cn0, 30, 0.16);
    }
    ctx.restore();   // resets clip, globalCompositeOperation, fillStyle; globalAlpha never touched
  }

  // horizon obstruction mask (fixed plausible profile)
  if (opts.horizon) {
    ctx.beginPath();
    for (let az = 0; az <= 360; az += 5) {
      const m = 4 + 10 * Math.exp(-Math.pow((az - 210) / 40, 2)) + 7 * Math.exp(-Math.pow((az - 75) / 28, 2));
      const [x, y] = pt(az, m);
      az === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let az = 360; az >= 0; az -= 10) { const [x, y] = pt(az, 0); ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = tok.line2; ctx.globalAlpha = 0.28; ctx.fill(); ctx.globalAlpha = 1;
  }

  // graticule
  ctx.strokeStyle = tok.line; ctx.lineWidth = 1;
  for (const el of [0, 30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, (90 - el) / 90 * R, 0, TAU); ctx.stroke(); }
  ctx.beginPath();
  for (let a = 0; a < 360; a += 30) {
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(a * Math.PI / 180), cy - R * Math.cos(a * Math.PI / 180));
  }
  ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.strokeStyle = tok.line2; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  ctx.fillStyle = tok.txt3; ctx.font = F10; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 11); ctx.fillText('S', cx, cy + R + 11);
  ctx.fillText('E', cx + R + 11, cy); ctx.fillText('W', cx - R - 11, cy);
  ctx.font = F9; ctx.textAlign = 'left';
  ctx.fillText('30°', cx + 3, cy - (60 / 90) * R - 5);
  ctx.fillText('60°', cx + 3, cy - (30 / 90) * R - 5);

  // trails (age-faded). The fade normalises over the TRAIL length control (default = the full
  // 90 min buffer), so a shorter trail fades to nothing over its own span — same visual
  // language as the long one, just a shorter ribbon.
  if (opts.trails) {
    const now = data.now;
    const span = opts.trailAge || 5400;
    for (const [key, tr] of data.trails) {
      const sat = data.sats.find((s) => s.key === key);
      const col = tok[sat ? sat.tok : 'gps'] || tok.txt3;
      for (let i = 1; i < tr.length; i++) {
        if (tr[i].el < -2 || tr[i - 1].el < -2) continue;
        const age = (now - tr[i].t) / span;
        if (age > 1) continue;
        ctx.strokeStyle = col; ctx.globalAlpha = 0.55 * (1 - age) + 0.04;
        ctx.beginPath();
        const [x0, y0] = pt(tr[i - 1].az, tr[i - 1].el);
        const [x1, y1] = pt(tr[i].az, tr[i].el);
        if (Math.hypot(x1 - x0, y1 - y0) < R) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1;
  }

  // sun & moon
  if (data.sun && data.sun.el > -6) {
    const [x, y] = pt(data.sun.az, data.sun.el);
    ctx.strokeStyle = tok.acq; ctx.fillStyle = tok.acq;
    ctx.globalAlpha = data.sun.el > 0 ? 1 : 0.4;
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
    ctx.font = F9; ctx.fillText('SUN', x + 8, y + 3); ctx.globalAlpha = 1;
  }
  if (data.moon && data.moon.el > -6) {
    const [x, y] = pt(data.moon.az, data.moon.el);
    ctx.strokeStyle = tok.txt2; ctx.fillStyle = tok.txt2;
    ctx.globalAlpha = data.moon.el > 0 ? 1 : 0.4;
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 4.5, -Math.PI / 2, Math.PI / 2, data.moon.illum < 0.5); ctx.fill();
    ctx.font = F9; ctx.fillText('MOON', x + 8, y + 3); ctx.globalAlpha = 1;
  }

  // satellites
  ctx.font = F9; ctx.textAlign = 'left';
  for (const s of data.sats) {
    if (s.el < 0) continue;
    const [x, y] = pt(s.az, s.el);
    const col = tok[s.tok];
    const size = 3.5 + Math.max(0, (s.cn0 - 24)) / 28 * 5;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    if (s.used) sq(ctx, x, y, size);
    else { ctx.globalAlpha = 0.75; ctx.strokeRect(x - size / 2, y - size / 2, size, size); ctx.globalAlpha = 1; }
    if (opts.labels) { ctx.fillStyle = tok.txt3; ctx.fillText(s.key, x + size / 2 + 3, y + 3); }
  }
}

// ---------------------------------------------------------------- generic XY frame
function frame(ctx, w, h, tok, o) {
  const m = { l: o.ml ?? 40, r: o.mr ?? 10, t: o.mt ?? 8, b: o.mb ?? 18 };
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  ctx.strokeStyle = tok.lineSoft || tok.line; ctx.lineWidth = 1;   // chart well: 1px --line-soft (hairline economy)
  ctx.strokeRect(m.l + 0.5, m.t + 0.5, iw - 1, ih - 1);
  return { m, iw, ih, X: (f) => m.l + f * iw, Y: (f) => m.t + (1 - f) * ih };
}

function yTicks(ctx, tok, fr, vals, fmt) {
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = tok.lineSoft || tok.line;   // gridlines --line-soft (Comp B)
  for (const v of vals) {
    const y = fr.Y(v.f);
    ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(fr.m.l + 1, y); ctx.lineTo(fr.m.l + fr.iw - 1, y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(fmt(v.v), fr.m.l - 5, y);
  }
}

function xTimeTicks(ctx, tok, fr, h, spanSec) {
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const n = 4;
  for (let i = 0; i <= n; i++) {
    const f = i / n, x = fr.X(f);
    const ago = spanSec * (1 - f);
    const lab = ago === 0 ? 'now' : (ago >= 3600 ? '−' + (ago / 3600).toFixed(0) + 'h' : '−' + Math.round(ago / 60) + '′');
    ctx.fillText(lab, x, fr.m.t + fr.ih + 4);
  }
}

// ---------------------------------------------------------------- C/N0 vs elevation
export function drawCn0Elev(canvas, tok, sats, showMedian) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 34 });
  const X = (el) => fr.X(el / 90), Y = (c) => fr.Y((c - 15) / 40);
  yTicks(ctx, tok, fr, [20, 30, 40, 50].map((v) => ({ v, f: (v - 15) / 40 })), (v) => v);
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const e of [0, 30, 60, 90]) ctx.fillText(e + '°', X(e), fr.m.t + fr.ih + 4);
  ctx.textAlign = 'left';
  ctx.fillText('dB-Hz', fr.m.l + 4, fr.m.t + 3);
  for (const s of sats) {
    if (s.el < 0) continue;
    ctx.fillStyle = tok[s.tok]; ctx.globalAlpha = s.used ? 1 : 0.45;
    sq(ctx, X(s.el), Y(s.cn0), 4);
  }
  ctx.globalAlpha = 1;
  if (showMedian) {
    const bins = [];
    for (let b = 0; b < 9; b++) {
      const arr = sats.filter((s) => s.el >= b * 10 && s.el < b * 10 + 10).map((s) => s.cn0).sort((a, c) => a - c);
      if (arr.length) bins.push({ el: b * 10 + 5, v: arr[Math.floor(arr.length / 2)] });
    }
    // The binned-median is the ONLY white line in the room (Comp B): --txt-hi @ 85%, ~1.1px.
    ctx.globalAlpha = 0.85; ctx.strokeStyle = tok.txtHi || tok.txt; ctx.lineWidth = 1.1; ctx.beginPath();
    bins.forEach((b, i) => { const x = X(b.el), y = Y(b.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = tok.txtHi || tok.txt;
    for (const b of bins) sq(ctx, X(b.el), Y(b.v), 3);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- C/N0 over time (multi-trace)
export function drawCn0Time(canvas, tok, series, spanSec, now) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 34 });
  yTicks(ctx, tok, fr, [20, 30, 40, 50].map((v) => ({ v, f: (v - 15) / 40 })), (v) => v);
  xTimeTicks(ctx, tok, fr, h, spanSec);
  ctx.save();
  ctx.beginPath(); ctx.rect(fr.m.l, fr.m.t, fr.iw, fr.ih); ctx.clip();
  for (const tr of series) {
    ctx.strokeStyle = tok[tr.tok]; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (const p of tr.pts) {
      const f = 1 - (now - p.t) / spanSec;
      if (f < 0) continue;
      const x = fr.X(f), y = fr.Y((p.v - 15) / 40);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- position scatter + CEP/2DRMS
export function drawPosScatter(canvas, tok, pts, stats, now) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const cx = w / 2, cy = h / 2;
  const maxR = Math.max(stats.drms * 1.35, 2.2);
  const scale = (Math.min(w, h) / 2 - 26) / maxR;
  // grid: 1 m rings
  ctx.strokeStyle = tok.line; ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'left';
  const stepM = maxR > 6 ? 2 : 1;
  for (let r = stepM; r * scale < Math.min(w, h) / 2 - 8; r += stepM) {
    ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(cx, cy, r * scale, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(r + 'm', cx + r * scale + 3, cy - 3);
  }
  ctx.strokeStyle = tok.line;
  ctx.beginPath(); ctx.moveTo(cx, 10); ctx.lineTo(cx, h - 10); ctx.moveTo(10, cy); ctx.lineTo(w - 10, cy); ctx.stroke();
  ctx.fillStyle = tok.txt3; ctx.textAlign = 'center';
  ctx.fillText('N', cx, 8); ctx.fillText('E', w - 8, cy + 10);
  // points, age-faded
  for (const p of pts) {
    const age = (now - p.t) / (pts.length ? now - pts[0].t + 1 : 1);
    ctx.fillStyle = tok.led;
    ctx.globalAlpha = 0.06 + 0.55 * (1 - age);
    sq(ctx, cx + (p.e - stats.me) * scale, cy - (p.n - stats.mn) * scale, 2.4);
  }
  ctx.globalAlpha = 1;
  // rings
  ctx.strokeStyle = tok.lock; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, stats.cep * scale, 0, TAU); ctx.stroke();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = tok.acq;
  ctx.beginPath(); ctx.arc(cx, cy, stats.drms * scale, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = F9;
  ctx.fillStyle = tok.lock; ctx.textAlign = 'left';
  ctx.fillText('CEP ' + stats.cep.toFixed(2) + 'm', cx + stats.cep * scale * 0.71 + 4, cy - stats.cep * scale * 0.71 - 4);
  ctx.fillStyle = tok.acq;
  ctx.fillText('2DRMS ' + stats.drms.toFixed(2) + 'm', cx - stats.drms * scale * 0.71 - 4, cy + stats.drms * scale * 0.71 + 10);
  ctx.textAlign = 'center';
  // mean marker — red center dot + cross (design's fix marker)
  ctx.strokeStyle = tok.led; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5); ctx.stroke();
  ctx.fillStyle = tok.led; ctx.beginPath(); ctx.arc(cx, cy, 2.1, 0, TAU); ctx.fill();
}

// ---------------------------------------------------------------- DOP history
export function drawDop(canvas, tok, hist, spanSec, now) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 30 });
  const Y = (v) => fr.Y(Math.min(1, v / 4));
  yTicks(ctx, tok, fr, [1, 2, 3].map((v) => ({ v, f: v / 4 })), (v) => v.toFixed(0));
  xTimeTicks(ctx, tok, fr, h, spanSec);
  ctx.save(); ctx.beginPath(); ctx.rect(fr.m.l, fr.m.t, fr.iw, fr.ih); ctx.clip();
  const traces = [
    { k: 'p', dash: [4, 3], col: tok.txt2 },   // PDOP — grey dashed
    { k: 'v', dash: [1.5, 2.5], col: tok.gps }, // VDOP — blue dotted
    { k: 'h', dash: [], col: tok.lock },        // HDOP — green solid (primary)
  ];
  for (const tr of traces) {
    ctx.strokeStyle = tr.col; ctx.setLineDash(tr.dash); ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (const p of hist) {
      const f = 1 - (now - p.t) / spanSec;
      if (f < 0) continue;
      started ? ctx.lineTo(fr.X(f), Y(p[tr.k])) : ctx.moveTo(fr.X(f), Y(p[tr.k])); started = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]); ctx.restore();
}

// ---------------------------------------------------------------- fix continuity strip
export function drawContinuity(canvas, tok, hist, spanSec, now, ttffSec, t0) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 30, mb: 18 });
  const bandH = 12;
  // fix-type band
  for (const p of hist) {
    const f = 1 - (now - p.t) / spanSec;
    if (f < 0) continue;
    ctx.fillStyle = p.type === 3 ? tok.lock : p.type >= 1 ? tok.acq : tok.none;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(fr.X(f), fr.m.t + 3, Math.max(1, fr.iw / spanSec + 0.5), bandH);
  }
  ctx.globalAlpha = 1;
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('FIX', fr.m.l - 26, fr.m.t + 3 + bandH / 2);
  // sats-used steps
  const yBase = fr.m.t + bandH + 8, yh = fr.ih - bandH - 12;
  const Y = (s) => yBase + yh * (1 - Math.min(1, s / 24));
  ctx.strokeStyle = tok.line; ctx.globalAlpha = 0.6;
  for (const g of [8, 16, 24]) { ctx.beginPath(); ctx.moveTo(fr.m.l + 1, Y(g)); ctx.lineTo(fr.m.l + fr.iw - 1, Y(g)); ctx.stroke(); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = tok.txt3; ctx.textAlign = 'right';
  for (const g of [8, 16, 24]) ctx.fillText(g, fr.m.l - 4, Y(g));
  ctx.strokeStyle = tok.txt; ctx.lineWidth = 1; ctx.beginPath();
  let started = false;
  for (const p of hist) {
    const f = 1 - (now - p.t) / spanSec;
    if (f < 0) continue;
    const x = fr.X(f), y = Y(p.sats);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
  }
  ctx.stroke();
  // TTFF marker
  const fT = 1 - (now - (t0 + ttffSec)) / spanSec;
  if (fT > 0 && fT < 1) {
    const x = fr.X(fT);
    ctx.strokeStyle = tok.acq; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, fr.m.t + 2); ctx.lineTo(x, fr.m.t + fr.ih - 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = tok.acq; ctx.textAlign = 'left';
    ctx.fillText('TTFF ' + ttffSec.toFixed(1) + 's', x + 4, fr.m.t + fr.ih - 8);
  }
  xTimeTicks(ctx, tok, fr, h, spanSec);
}

// ---------------------------------------------------------------- PPS phase strip
export function drawPhase(canvas, tok, list, spanSec, now, holdSince) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 40 });
  const vals = list.filter((p) => now - p.t <= spanSec).map((p) => p.us);
  // Plot jitter about the mean: real hardware sits ~999 µs off the boundary (fixed
  // ISR latency), which isn't jitter — without centring it draws as a flat line high
  // up. Sim values are already ~zero-mean, so this is a no-op there.
  const mean = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
  const sig = vals.length ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length) : 30;
  const lim = Math.max(80, sig * 3.4);
  const Y = (us) => fr.Y((us + lim) / (2 * lim));
  yTicks(ctx, tok, fr, [-lim * 0.75, 0, lim * 0.75].map((v) => ({ v, f: (v + lim) / (2 * lim) })), (v) => (v > 0 ? '+' : '') + Math.round(v));
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('µs', fr.m.l + 4, fr.m.t + 3);
  xTimeTicks(ctx, tok, fr, h, spanSec);
  // ±1σ band — soft red, the design's signature timing fill
  ctx.fillStyle = tok.led; ctx.globalAlpha = 0.08;
  ctx.fillRect(fr.m.l + 1, Y(sig), fr.iw - 2, Y(-sig) - Y(sig));
  ctx.globalAlpha = 1;
  ctx.save(); ctx.beginPath(); ctx.rect(fr.m.l, fr.m.t, fr.iw, fr.ih); ctx.clip();
  ctx.strokeStyle = tok.led; ctx.lineWidth = 1.3; ctx.beginPath();
  let started = false, lastT = 0; const gaps = [];
  for (const p of list) {
    const f = 1 - (now - p.t) / spanSec;
    if (f < 0) continue;
    const x = fr.X(f), y = Y(Math.max(-lim, Math.min(lim, p.us - mean)));
    if (started && p.t - lastT > 4) { ctx.stroke(); ctx.beginPath(); started = false; gaps.push(x); }
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true; lastT = p.t;
  }
  ctx.stroke();
  // dropped-edge markers — amber verticals where the PPS stream skipped an edge
  if (gaps.length) {
    ctx.strokeStyle = tok.acq; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.beginPath();
    for (const gx of gaps) { ctx.moveTo(gx + 0.5, fr.m.t + 1); ctx.lineTo(gx + 0.5, fr.m.t + fr.ih - 1); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
  // holdover shading at right edge
  if (holdSince && now - holdSince < spanSec) {
    const x = fr.X(1 - (now - holdSince) / spanSec);
    ctx.fillStyle = tok.acq; ctx.globalAlpha = 0.08;
    ctx.fillRect(x, fr.m.t + 1, fr.m.l + fr.iw - x - 1, fr.ih - 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = tok.acq; ctx.font = F9; ctx.textAlign = 'right';
    ctx.fillText('NO PPS — HOLDOVER', fr.m.l + fr.iw - 6, fr.m.t + 6);
  }
}

// ---------------------------------------------------------------- ppm staircase + temp
export function drawStair(canvas, tok, samples, spanSec, now, tempNow) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 40 });
  const inWin = samples.filter((p) => now - p.t <= spanSec);
  if (!inWin.length) { xTimeTicks(ctx, tok, fr, h, spanSec); return; }
  const ppms = inWin.map((p) => p.ppm), temps = inWin.map((p) => p.temp);
  const pLo = Math.min(...ppms) - 0.4, pHi = Math.max(...ppms) + 0.4;
  const tLo = Math.min(...temps) - 0.5, tHi = Math.max(...temps, tempNow) + 0.5;
  const split = 0.62;
  const Yp = (v) => fr.m.t + (1 - (v - pLo) / (pHi - pLo)) * fr.ih * split;
  const Yt = (v) => fr.m.t + fr.ih * (split + 0.06) + (1 - (v - tLo) / (tHi - tLo)) * fr.ih * (0.94 - split - 0.06);
  ctx.strokeStyle = tok.line; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.moveTo(fr.m.l + 1, fr.m.t + fr.ih * (split + 0.03)); ctx.lineTo(fr.m.l + fr.iw - 1, fr.m.t + fr.ih * (split + 0.03)); ctx.stroke();
  ctx.globalAlpha = 1;
  // staircase
  ctx.save(); ctx.beginPath(); ctx.rect(fr.m.l, fr.m.t, fr.iw, fr.ih); ctx.clip();
  ctx.strokeStyle = tok.led; ctx.lineWidth = 1.4; ctx.beginPath();
  let px = null, py = null;
  for (const p of inWin) {
    const x = fr.X(1 - (now - p.t) / spanSec), y = Yp(p.ppm);
    if (px == null) ctx.moveTo(x, y);
    else { ctx.lineTo(x, py); ctx.lineTo(x, y); }
    px = x; py = y;
  }
  if (px != null) ctx.lineTo(fr.X(1), py);
  ctx.stroke();
  // temp
  ctx.strokeStyle = tok.acq; ctx.beginPath();
  inWin.forEach((p, i) => {
    const x = fr.X(1 - (now - p.t) / spanSec), y = Yt(p.temp);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke(); ctx.restore();
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('ppm', fr.m.l + 4, fr.m.t + 3);
  ctx.fillStyle = tok.acq;
  ctx.fillText('die °C', fr.m.l + 4, fr.m.t + fr.ih * (split + 0.06) + 2);
  ctx.fillStyle = tok.txt3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(pHi.toFixed(1), fr.m.l - 4, Yp(pHi) + 4);
  ctx.fillText(pLo.toFixed(1), fr.m.l - 4, Yp(pLo) - 4);
  ctx.fillText(tHi.toFixed(0) + '°', fr.m.l - 4, Yt(tHi) + 3);
  ctx.fillText(tLo.toFixed(0) + '°', fr.m.l - 4, Yt(tLo) - 3);
  xTimeTicks(ctx, tok, fr, h, spanSec);
}

// ---------------------------------------------------------------- ppm vs temp + fit
export function drawPpmTemp(canvas, tok, samples, fit) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  const fr = frame(ctx, w, h, tok, { ml: 40 });
  if (!samples.length) return;
  const temps = samples.map((p) => p.temp), ppms = samples.map((p) => p.ppm);
  const tLo = Math.min(...temps) - 1, tHi = Math.max(...temps) + 1;
  const pLo = Math.min(...ppms) - 0.5, pHi = Math.max(...ppms) + 0.5;
  const X = (t) => fr.X((t - tLo) / (tHi - tLo)), Y = (p) => fr.Y((p - pLo) / (pHi - pLo));
  ctx.font = F9; ctx.fillStyle = tok.txt3; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = Math.ceil(tLo); t <= tHi; t += Math.max(1, Math.round((tHi - tLo) / 6))) {
    ctx.fillText(t + '°', X(t), fr.m.t + fr.ih + 4);
    ctx.strokeStyle = tok.line; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(X(t), fr.m.t + 1); ctx.lineTo(X(t), fr.m.t + fr.ih - 1); ctx.stroke(); ctx.globalAlpha = 1;
  }
  yTicks(ctx, tok, fr, [pLo + (pHi - pLo) * 0.25, pLo + (pHi - pLo) * 0.5, pLo + (pHi - pLo) * 0.75].map((v) => ({ v, f: (v - pLo) / (pHi - pLo) })), (v) => v.toFixed(1));
  ctx.fillStyle = tok.txt3; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('ppm vs die °C', fr.m.l + 4, fr.m.t + 3);
  for (const p of samples) { ctx.fillStyle = tok.gps; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(X(p.temp), Y(p.ppm), 2.4, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (fit) {
    ctx.strokeStyle = tok.acq; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = tLo + (tHi - tLo) * i / 60, x = t - 25;
      const p = fit.k0 + fit.k1 * x + fit.k2 * x * x;
      i ? ctx.lineTo(X(t), Y(p)) : ctx.moveTo(X(t), Y(p));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    // turnover (parabola vertex) — where drift is least temperature-sensitive
    if (Math.abs(fit.k2) > 1e-6) {
      const turnT = 25 - fit.k1 / (2 * fit.k2);
      if (turnT > tLo && turnT < tHi) {
        const tx = X(turnT);
        ctx.strokeStyle = tok.txt3; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(tx, fr.m.t + 1); ctx.lineTo(tx, fr.m.t + fr.ih - 1); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = tok.txt3; ctx.font = F9; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('TURNOVER ' + turnT.toFixed(0) + '°', tx + 3, fr.m.t + 3);
      }
    }
  }
}

// ---------------------------------------------------------------- globe (orthographic, cartographic)
export async function loadLand() {
  try {
    const r = await fetch('./data/land-110m.json'); // vendored world-atlas (static/offline)
    const T = await r.json();
    const sc = T.transform.scale, tr = T.transform.translate;
    const arcs = T.arcs.map((a) => {
      let x = 0, y = 0;
      return a.map(([dx, dy]) => { x += dx; y += dy; return [x * sc[0] + tr[0], y * sc[1] + tr[1]]; });
    });
    const polys = [];
    for (const g of T.objects.land.geometries) {
      const sets = g.type === 'Polygon' ? [g.arcs] : g.arcs;
      for (const poly of sets) for (const ring of poly) {
        let pts = [];
        for (const ai of ring) {
          const rev = ai < 0;
          const arc = arcs[rev ? ~ai : ai];
          const seg = rev ? [...arc].reverse() : arc;
          pts = pts.length ? pts.concat(seg.slice(1)) : pts.concat(seg);
        }
        if (pts.length > 3) polys.push(pts);
      }
    }
    return polys;
  } catch (e) { return null; }
}

function ll2xyz(lat, lon) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function drawGlobe(canvas, tok, g) {
  const { ctx, w, h } = c2d(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = tok.inset; ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 18;
  const rl = g.rot.lon * Math.PI / 180, rp = g.rot.lat * Math.PI / 180;
  const proj = (lat, lon) => {
    const [x0, y0, z0] = ll2xyz(lat, lon);
    const x1 = x0 * Math.cos(rl) + y0 * Math.sin(rl);
    const y1 = -x0 * Math.sin(rl) + y0 * Math.cos(rl);
    const z1 = z0;
    const x2 = x1 * Math.cos(rp) + z1 * Math.sin(rp);
    const z2 = -x1 * Math.sin(rp) + z1 * Math.cos(rp);
    return { x: cx + R * y1, y: cy - R * z2, vis: x2 > 0, depth: x2 };
  };

  // deep-space stars behind the globe — seeded (LCG) so they hold still frame-to-frame
  let seed = 9001; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 190; i++) {
    const x = rnd() * w, y = rnd() * h, tw = rnd();
    if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < (R + 9) * (R + 9)) continue;
    ctx.fillStyle = `rgba(200,210,230,${(0.1 + tw * 0.5).toFixed(2)})`;
    const s = tw > 0.9 ? 1.5 : 1; ctx.fillRect(x, y, s, s);
  }

  // atmosphere halo just outside the limb
  const atm = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R + 16);
  atm.addColorStop(0, 'rgba(80,150,240,0)');
  atm.addColorStop(0.6, 'rgba(70,140,240,0.13)');
  atm.addColorStop(1, 'rgba(70,140,240,0)');
  ctx.fillStyle = atm; ctx.beginPath(); ctx.arc(cx, cy, R + 16, 0, TAU); ctx.fill();

  // ---- globe body, clipped to the disc ----
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  ctx.fillStyle = '#0a1622'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill(); // deep ocean

  // graticule
  if (g.opts.graticule !== false) {
    ctx.strokeStyle = 'rgba(120,150,190,0.14)'; ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.beginPath(); let s = false;
      for (let lon = -180; lon <= 180; lon += 4) { const p = proj(lat, lon); if (p.vis) { s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); s = true; } else s = false; }
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 30) {
      ctx.beginPath(); let s = false;
      for (let lat = -88; lat <= 88; lat += 4) { const p = proj(lat, lon); if (p.vis) { s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); s = true; } else s = false; }
      ctx.stroke();
    }
  }

  // land
  if (g.land) {
    ctx.fillStyle = '#183a52'; ctx.strokeStyle = 'rgba(140,190,220,0.22)'; ctx.lineWidth = 0.8;
    for (const poly of g.land) {
      ctx.beginPath(); let s = false;
      for (const [lon, lat] of poly) { const p = proj(lat, lon); if (p.vis) { s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); s = true; } else s = false; }
      ctx.fill(); ctx.stroke();
    }
  }

  // night side — exact terminator geometry (great-circle ring), filled with a soft
  // twilight gradient along the sun→antisun screen axis (deep night → twilight → day)
  if (g.opts.terminator && g.sun) {
    const s3 = ll2xyz(g.sun.subLat, g.sun.subLon);
    const up = Math.abs(s3[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = norm(cross(up, s3)), v = cross(s3, u);
    const ring = [];
    for (let i = 0; i <= 128; i++) {
      const a = i / 128 * TAU;
      const p3 = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
      const lat = Math.asin(p3[2]) * 180 / Math.PI, lon = Math.atan2(p3[1], p3[0]) * 180 / Math.PI;
      ring.push(proj(lat, lon));
    }
    const sunP = proj(g.sun.subLat, g.sun.subLon);
    // deep night at the antisolar limb, softening toward the terminator
    let dx = sunP.x - cx, dy = sunP.y - cy; const dl = Math.hypot(dx, dy);
    const ux = dl > 1 ? dx / dl : 0, uy = dl > 1 ? dy / dl : -1;
    // RADIAL darkening centred on the antisolar screen point — NOT a linear axis. A linear gradient
    // fades along one direction, but the terminator is an ELLIPSE: the linear iso-alpha lines cross
    // it at an angle, so wherever the gradient reached ~0 alpha it left an *undarkened sliver* of
    // night-side globe right at the terminator (read as a bright diagonal band). A radial fade from
    // the antisolar point keeps a solid floor of darkness across the WHOLE lune up to the terminator
    // (never fully transparent inside the disc), so there is no sliver and no false band. The
    // terminator's soft edge comes from the polygon-edge blur below.
    const antX = cx - ux * R, antY = cy - uy * R;
    const ng = ctx.createRadialGradient(antX, antY, 0, antX, antY, 2.15 * R);
    ng.addColorStop(0.00, 'rgba(1,4,10,0.90)');
    ng.addColorStop(0.35, 'rgba(2,6,13,0.78)');
    ng.addColorStop(0.70, 'rgba(4,9,18,0.62)');
    ng.addColorStop(1.00, 'rgba(6,11,20,0.50)');
    // Night region as an exact terminator polygon. The terminator great circle projects to a full
    // ellipse (front AND back), but only the FRONT half is the real day/night edge on the visible
    // disc — filling the whole ellipse made a bowtie/X. So: extract the contiguous VISIBLE arc
    // (wrap-safe), then close the night region along the NIGHT arc of the LIMB, choosing the limb
    // direction by inverse-projecting a limb point and testing sun·p < 0 (no heuristic — verified
    // clean across a 108-angle sweep). Blur feathers the polygon edge into a soft twilight band.
    const limbNight = (phi) => {
      const y1 = Math.cos(phi), z2 = -Math.sin(phi);
      const x1 = -z2 * Math.sin(rp), z0 = z2 * Math.cos(rp);
      const x0 = x1 * Math.cos(rl) - y1 * Math.sin(rl), y0 = x1 * Math.sin(rl) + y1 * Math.cos(rl);
      return (x0 * s3[0] + y0 * s3[1] + z0 * s3[2]) < 0;
    };
    const N = ring.length;
    let start = -1;
    for (let i = 0; i < N; i++) { if (ring[i].vis && !ring[(i - 1 + N) % N].vis) { start = i; break; } }
    const arc = [];
    if (start >= 0) for (let k = 0; k < N; k++) { const p = ring[(start + k) % N]; if (!p.vis) break; arc.push(p); }
    ctx.fillStyle = ng;
    ctx.filter = `blur(${Math.max(3, R * 0.035).toFixed(1)}px)`;
    if (arc.length > 2) {
      ctx.beginPath();
      ctx.moveTo(arc[0].x, arc[0].y);
      for (const p of arc) ctx.lineTo(p.x, p.y);
      const a0 = Math.atan2(arc[arc.length - 1].y - cy, arc[arc.length - 1].x - cx);
      const a1 = Math.atan2(arc[0].y - cy, arc[0].x - cx);
      const dPos = (a1 - a0 + TAU) % TAU, rr = R - 0.5;
      const sweep = limbNight(a0 + dPos / 2) ? dPos : dPos - TAU; // walk the limb the shadowed way
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / 0.08));
      for (let i = 1; i <= steps; i++) { const a = a0 + sweep * i / steps; ctx.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); }
      ctx.closePath(); ctx.fill();
    } else {
      // terminator doesn't cross the visible disc → the whole disc is day or night
      const c3 = [Math.cos(rp) * Math.cos(rl), Math.cos(rp) * Math.sin(rl), Math.sin(rp)];
      if (c3[0] * s3[0] + c3[1] * s3[1] + c3[2] * s3[2] < 0) { ctx.beginPath(); ctx.arc(cx, cy, R - 0.5, 0, TAU); ctx.fill(); }
    }
    ctx.filter = 'none';
  }
  ctx.restore();

  // luminous limb
  ctx.strokeStyle = 'rgba(150,190,230,0.42)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();

  // ground trails (per-constellation, subtle)
  if (g.opts.trails) {
    for (const [key, tr] of g.gtrails) {
      const sat = g.sats.find((x) => x.key === key); if (!sat) continue;
      ctx.strokeStyle = tok[sat.tok]; ctx.globalAlpha = 0.4; ctx.beginPath(); let s = false;
      for (const p of tr) { const q = proj(p.lat, p.lon); if (q.vis) { s ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); s = true; } else s = false; }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // satellites — floated ABOVE their sub-point at a stylised altitude, with a riser down to
  // the ground: the "pinned to earth" look. The float is the sub-point's screen vector from
  // the globe centre, scaled out by SAT_ALT (orthographic keeps a sat directly over its
  // sub-point along that same ray). A used sat is brighter/larger than a tracked-but-unused one.
  const SAT_ALT = 1.26;
  ctx.font = F9; ctx.textAlign = 'left';
  for (const sat of g.sats) {
    const g0 = proj(sat.geo.lat, sat.geo.lon); // sub-point on the surface
    if (!g0.vis) continue;
    const col = tok[sat.tok] || tok.txt3;
    const fx = cx + (g0.x - cx) * SAT_ALT, fy = cy + (g0.y - cy) * SAT_ALT; // orbit position
    // riser + sub-point tick
    ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(g0.x, g0.y); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.fillStyle = col; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(g0.x, g0.y, 1.3, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    // the satellite itself — glowing
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = sat.used ? 10 : 6;
    ctx.beginPath(); ctx.arc(fx, fy, sat.used ? 3.4 : 2.4, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    if (g.opts.labels) { ctx.fillStyle = tok.txt3; ctx.fillText(sat.key, fx + 5, fy + 3); }
  }

  // subsolar warm glow (unclipped so the bloom spills over the limb)
  if (g.sun) {
    const sp = proj(g.sun.subLat, g.sun.subLon);
    if (sp.vis) {
      ctx.fillStyle = 'rgba(255,220,120,0.95)'; ctx.shadowColor = 'rgba(255,210,90,0.9)'; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 4.5, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    }
  }

  // observer
  const o = proj(g.obs.lat, g.obs.lon);
  if (o.vis) {
    ctx.strokeStyle = tok.lock; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(o.x, o.y, 5, 0, TAU); ctx.stroke();
    ctx.fillStyle = tok.lock; ctx.beginPath(); ctx.arc(o.x, o.y, 1.7, 0, TAU); ctx.fill();
    if (g.opts.labels) { ctx.fillStyle = tok.lock; ctx.fillText('OBS', o.x + 8, o.y - 6); }
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

// ---------------------------------------------------------------- flat world map ("the SICK map")
// The design handoff's "GROUND TRACKS — WORLD" view: a muted equirectangular map with the sub-solar
// point, the observer, coastlines and a graticule (design pcc-lib.js drawMap). The design was a
// decorative stand-in — it drew no real satellites and faked its trails from az/el. We keep its look
// (muted land, no POI clutter) but wire it to the app's REAL geometry: satellites at their true
// sub-points (geo, now populated on sim AND hardware), real ground tracks from gtrails, the sun from
// SIM.sunPos, and a soft day/night terminator (the design left a gradient created-but-unused — this
// completes that intent and matches the globe's terminator).
export function drawMap(canvas, tok, g) {
  const { ctx, w, h } = c2d(canvas);
  const D2R = Math.PI / 180;
  const P = (lon, lat) => ({ x: (lon + 180) / 360 * w, y: (90 - lat) / 180 * h }); // equirectangular
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = tok.inset; ctx.fillRect(0, 0, w, h);

  // graticule — meridians / parallels every 30°, soft
  if (g.opts.graticule !== false) {
    ctx.strokeStyle = tok.line; ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
    for (let lon = -150; lon <= 150; lon += 30) { const a = P(lon, 85), b = P(lon, -85); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { const a = P(-180, lat), b = P(180, lat); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  // land — muted fill + faint stroke (web's flat [lon,lat] polygons, same data as the globe)
  if (g.land) {
    ctx.fillStyle = tok.panel; ctx.strokeStyle = tok.line2; ctx.lineWidth = 1;
    for (const poly of g.land) {
      ctx.beginPath(); let s = false;
      for (const [lon, lat] of poly) { const p = P(lon, lat); s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); s = true; }
      ctx.fill(); ctx.stroke();
    }
  }

  // day/night — the terminator is the great circle 90° from the sub-solar point; per longitude its
  // latitude is atan(-cos(Δlon)/tan(δ)). On this already-dark map, DARKENING the night is invisible,
  // so instead we LIFT the daylit hemisphere with a soft wash and trace the terminator as a faint
  // line — a legible day/night without breaking the muted palette. (The design left an unused
  // gradient here; this completes that intent and matches the globe's terminator.)
  if (g.sun) {
    const dsLat = g.sun.subLat, dsLon = g.sun.subLon;
    let tanD = Math.tan(dsLat * D2R); if (Math.abs(tanD) < 1e-4) tanD = (tanD < 0 ? -1 : 1) * 1e-4;
    const northNight = dsLat < 0; // sun in the south → north pole is in shadow (day pole is south)
    const clamp = (v) => Math.max(-90, Math.min(90, v));
    const curve = [];
    const N = 240;
    for (let i = 0; i <= N; i++) {
      const lon = -180 + 360 * i / N;
      const lat = clamp(Math.atan(-Math.cos((lon - dsLon) * D2R) / tanD) / D2R);
      curve.push(P(lon, lat));
    }
    const trace = () => { curve.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
    // fill the DAY hemisphere (opposite the night pole) with a soft daylight wash
    ctx.beginPath(); trace();
    if (northNight) { ctx.lineTo(w, h); ctx.lineTo(0, h); } else { ctx.lineTo(w, 0); ctx.lineTo(0, 0); }
    ctx.closePath(); ctx.fillStyle = 'rgba(150,170,205,0.05)'; ctx.fill();
    // faint terminator line
    ctx.beginPath(); trace(); ctx.strokeStyle = 'rgba(150,175,215,0.28)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // real ground tracks — per-constellation, subtle (mirrors the globe's gtrails treatment)
  if (g.opts.trails && g.gtrails) {
    ctx.lineWidth = 1.3; ctx.globalAlpha = 0.4;
    for (const [key, tr] of g.gtrails) {
      const sat = g.sats.find((x) => x.key === key); if (!sat || tr.length < 2) continue;
      ctx.strokeStyle = tok[sat.tok] || tok.txt3; ctx.beginPath(); let s = false;
      for (const p of tr) { const q = P(p.lon, p.lat); s ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); s = true; }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // satellites at their true sub-points — the overlay the design lacked. Used sats brighter/larger.
  ctx.font = F9; ctx.textAlign = 'left';
  for (const sat of g.sats) {
    if (!sat.geo || !Number.isFinite(sat.geo.lat) || !Number.isFinite(sat.geo.lon)) continue;
    const p = P(sat.geo.lon, sat.geo.lat), col = tok[sat.tok] || tok.txt3;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = sat.used ? 8 : 4;
    ctx.globalAlpha = sat.used ? 1 : 0.6;
    ctx.beginPath(); ctx.arc(p.x, p.y, sat.used ? 3 : 2.2, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    if (g.opts.labels) { ctx.fillStyle = tok.txt3; ctx.fillText(sat.key, p.x + 5, p.y + 3); }
  }

  // sub-solar glyph — warm bloom
  if (g.sun) {
    const sp = P(g.sun.subLon, g.sun.subLat);
    ctx.fillStyle = tok.acq; ctx.shadowColor = tok.acq; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 6, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
  }

  // observer — cross-haired ring
  if (g.obs) {
    const op = P(g.obs.lon, g.obs.lat);
    ctx.strokeStyle = tok.lock; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(op.x, op.y, 5, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(op.x - 8, op.y); ctx.lineTo(op.x + 8, op.y); ctx.moveTo(op.x, op.y - 8); ctx.lineTo(op.x, op.y + 8); ctx.stroke();
    if (g.opts.labels) { ctx.fillStyle = tok.lock; ctx.fillText('OBS', op.x + 9, op.y - 7); }
  }
}

// ---------------------------------------------------------------- brightness curve mini-editor
export function drawGamma(canvas, tok, gamma, brightness) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  ctx.strokeStyle = tok.line; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.strokeStyle = tok.line; ctx.globalAlpha = 0.6;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tok.txt2; ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const x = i / 40, y = Math.pow(x, gamma);
    i ? ctx.lineTo(x * w, h - y * h) : ctx.moveTo(0, h);
  }
  ctx.stroke();
  const bx = brightness, by = Math.pow(bx, gamma);
  ctx.fillStyle = tok.led; sq(ctx, bx * w, h - by * h, 5);
}

// The 5-point ambient-light DAC curve (ADC 0..4095 → DAC 0..4095), ported from
// BrightnessView.swift's curveGraph. Accent polyline + dots over a dashed linear reference;
// the point being dragged is filled. Pure renderer — the controller owns the points + drag.
export function drawDacCurve(canvas, tok, points, dragIdx) {
  const { ctx, w, h } = c2d(canvas);
  clear(ctx, w, h, tok);
  ctx.strokeStyle = tok.line; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  const X = (adc) => adc / 4095 * w, Y = (dac) => h - dac / 4095 * h;
  ctx.strokeStyle = tok.line; ctx.globalAlpha = 0.5; ctx.beginPath();
  for (let i = 1; i < 4; i++) { ctx.moveTo(w * i / 4, 0); ctx.lineTo(w * i / 4, h); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); }
  ctx.stroke(); ctx.globalAlpha = 1;
  ctx.strokeStyle = tok.txt3; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.strokeStyle = tok.led; ctx.lineWidth = 1.6; ctx.beginPath();
  points.forEach((p, i) => { const x = X(p.adc), y = Y(p.dac); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  points.forEach((p, i) => {
    const x = X(p.adc), y = Y(p.dac);
    ctx.beginPath(); ctx.arc(x, y, i === dragIdx ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = i === dragIdx ? tok.led : tok.inset; ctx.fill();
    ctx.strokeStyle = tok.led; ctx.lineWidth = 1.4; ctx.stroke(); ctx.lineWidth = 1;
  });
}
