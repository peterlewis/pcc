// streamreplay.js — REVIEW replays the clock's full stream.
//
// The record is the stream itself: every line the clock sent and every command written to it, as
// `<epoch_ms> <line>` and `<epoch_ms> > <command>`. pccd keeps it (one file per UTC hour, 30 days,
// GET /history?series=stream); without pccd the browser keeps the same lines for 24 h
// (telemetrylog.js). One input format, one replay.
//
// REVIEW feeds the recorded lines through realdev's own ingest: a replay instance on the recording's
// clock (createRealDevice(…, { replay: true })) writing into a private, S-shaped frame. Every room
// then reads a past moment through the parser that drew it live. The app projects the frame onto
// session.S while REVIEW drives the rooms (projectInto), and reads the scrub readout from it always.
//
// A seek re-feeds a bounded window before the playhead (WINDOW_S: 45 min reaches the sky trails; the
// TIMING charts need 30) instead of the day. A forward step inside that window (playback, a short
// drag) feeds only the new lines. Hours are fetched once and cached; a newer seek supersedes an older
// one mid-feed.

import { createRealDevice } from './realdev.js?v=122';

export const WINDOW_S = 2700;      // 45 min before the playhead
const HOUR = 3600;
const CACHE_HOURS = 6;             // a 45-min window touches two; the rest is look-ahead and back-scrub
const GAP_MS = 8000;               // silence this long = the link was down (realdev's RX watchdog horizon)
const SLICE_MS = 150;              // feed this long, then let the page take input (and a newer seek land): a 45-min rebuild is ~100 ms
// A macrotask that a background tab does not throttle (setTimeout there waits up to a second).
const yieldTask = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });

// Recorded text → { ms[], tx[], lines[] }, oldest first, for [fromMs, toMs]. Tolerates a CR, a torn
// last line and an unstamped line (skipped).
export function parseStamped(text, fromMs = -Infinity, toMs = Infinity) {
  const ms = [], tx = [], lines = [];
  const n = text.length;
  let i = 0, sorted = true, last = -Infinity;
  while (i < n) {
    let j = text.indexOf('\n', i); if (j < 0) j = n;
    const sp = text.indexOf(' ', i);
    if (sp > i && sp < j) {
      const t = +text.slice(i, sp);
      if (t >= fromMs && t <= toMs) {
        let b = sp + 1, isTx = false;
        if (text.charCodeAt(b) === 62 && text.charCodeAt(b + 1) === 32) { isTx = true; b += 2; }   // "> "
        let e = j; if (e > b && text.charCodeAt(e - 1) === 13) e--;
        if (e > b) {
          if (t < last) sorted = false;
          last = t; ms.push(t); tx.push(isTx); lines.push(text.slice(b, e));
        }
      }
    }
    i = j + 1;
  }
  if (!sorted) {   // two writers interleaved (two tabs): order by stamp, stable
    const ix = ms.map((_, k) => k).sort((a, b) => ms[a] - ms[b] || a - b);
    return { ms: ix.map((k) => ms[k]), tx: ix.map((k) => tx[k]), lines: ix.map((k) => lines[k]) };
  }
  return { ms, tx, lines };
}

// First index with ms[i] > t.
function upperBound(ms, t) {
  let lo = 0, hi = ms.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ms[m] <= t) lo = m + 1; else hi = m; }
  return lo;
}

// The frame a replay writes into: the fields realdev reads and writes, shaped like session.S.
function makeFrame(obs) {
  return {
    real: false, connected: false, nmeaLog: [],
    fix: { valid: false, type: 0, sats: 0, lat: NaN, lon: NaN, alt: null, hdop: null, pdop: null, vdop: null },
    sats: [], obs: { ...obs }, obsUserSet: false,
    gtrails: new Map(), trails: new Map(), cn0Hist: new Map(), posHist: [], dopHist: [], fixHist: [],
    bins: new Set(), passes: 0, peakEl: 0, obsCount: 0,
    pps: { list: [], samples: [], tempHist: [], tempT: 0, dropped: 0, flags: 0, temp: 0, ppm: 0, seq: 0,
      calerr: 0, sincecal: 0, lastEdge: 0, phaseRef: null, msFolds: 0 },
    tc: null, star: null, stab: null, bright: null,
    fixAgeT: 0, lastRxT: 0, deviceTimeMs: 0, deviceTimeAtHost: 0, t0: 0,
  };
}

// The session.S fields a frame carries. projectInto points them at the frame's (no copies: the next
// feed shows through); the caller snapshots them before REVIEW and restores them after.
export const FRAME_FIELDS = ['sats', 'fix', 'posHist', 'dopHist', 'fixHist', 'cn0Hist', 'trails', 'gtrails', 'pps',
  'tc', 'star', 'stab', 'bright', 'fixAgeT', 'lastRxT', 'deviceTimeMs', 'deviceTimeAtHost',
  'passes', 'obsCount', 'peakEl', 'bins', 't0', 'nmeaLog'];

export class StreamReplay {
  // kind: 'pccd' | 'browser'. fetchText(fromS, toS) → the recorded text for that window.
  // baseObs: the observer before any recorded fix (the app's, as REVIEW began).
  constructor({ kind, fetchText, baseObs }) {
    this.kind = kind;
    this._fetchText = fetchText;
    this._baseObs = { lat: 51.4779, lon: -0.0015, ...(baseObs || {}) };
    this._hours = new Map();        // hour start (s) → { p, at, partial }
    this._pending = new Map();      // hour start → in-flight fetch
    this.frame = null;              // the S-shaped frame (null until the first seek lands)
    this._rd = null;
    this._cursor = -Infinity;       // ms of the last moment fed
    this._lastLine = 0;             // ms of the last line fed (0 = none in this run)
    this._begun = 0;                // ms the current run began (a rebuild, or the line after a gap)
    this.t = null;                  // the playhead (s) the frame shows
    this.loading = false;
    this.error = null;
    this._want = null; this._run = null;
    this.onFrame = null;            // (t) after each completed seek
  }

  // The clock was sending at the frame's moment (a line within 5 s).
  get live() { return !!(this.frame && this._lastLine && this.t != null && this.t * 1000 - this._lastLine <= 5000); }

  // Move the frame to t (s). Latest wins: seeks that arrive mid-feed replace the target, and the feed
  // carries on toward it instead of starting over when it lies ahead.
  seek(t) {
    this._want = t;
    if (!this._run) this._run = this._loop().finally(() => { this._run = null; });
    return this._run;
  }
  async _loop() {
    while (this._want != null) {
      const t = this._want; this._want = null;
      let done = false;
      try { done = await this._seekTo(t); } catch (e) { this.error = String(e && e.message || e); console.warn('stream replay:', e); }
      if (done) { this.t = t; if (this.onFrame) this.onFrame(t); }
    }
  }

  async _hour(h) {
    const c = this._hours.get(h);
    const nowMs = Date.now();
    // The hour still being written is refetched once its copy is 10 s old.
    if (c && !(c.partial && nowMs - c.at > 10000)) { this._hours.delete(h); this._hours.set(h, c); return c.p; }
    if (this._pending.has(h)) return this._pending.get(h);
    const job = (async () => {
      try {
        const text = await this._fetchText(h, h + HOUR - 0.001);
        const p = parseStamped(text || '', h * 1000, (h + HOUR) * 1000 - 1);
        this._hours.set(h, { p, at: Date.now(), partial: (h + HOUR) * 1000 > Date.now() - 5000 });
        while (this._hours.size > CACHE_HOURS) this._hours.delete(this._hours.keys().next().value);
        this.error = null;
        return p;
      } finally { this._pending.delete(h); }
    })();
    this._pending.set(h, job);
    return job;
  }
  // The recorded lines of the run that holds endMs, at most spanMs back, oldest first, in the frame's
  // nmeaLog shape ({ t, dir, text }). A silence longer than GAP_MS starts a run, as in the feed; [] when
  // the link was down at endMs. Synchronous, from the hour cache (a seek fetched the hours its window
  // covers): null when an hour of the span is not cached.
  runBefore(endMs, spanMs) {
    const fromMs = endMs - spanMs;
    let out = [], lastRx = 0;
    for (let h = Math.floor(fromMs / 1000 / HOUR) * HOUR; h * 1000 <= endMs; h += HOUR) {
      const c = this._hours.get(h);
      if (!c) return null;
      const { ms, tx, lines } = c.p;
      for (let i = upperBound(ms, fromMs); i < ms.length && ms[i] <= endMs; i++) {
        if (lastRx && ms[i] - lastRx > GAP_MS) { out = []; lastRx = 0; }
        out.push({ t: ms[i], dir: tx[i] ? 'tx' : 'rx', text: lines[i] });
        if (!tx[i]) lastRx = ms[i];
      }
    }
    return lastRx && endMs - lastRx <= GAP_MS ? out : [];
  }
  // Fetch the hour after t in the background once the playhead is within 15 min of it.
  prefetch(t) {
    const next = Math.floor(t / HOUR) * HOUR + HOUR;
    if (next - t < 900 && next * 1000 < Date.now() && !this._hours.has(next)) this._hour(next).catch(() => {});
  }

  _begin(ms) {
    this.frame = makeFrame(this._baseObs);
    this._rd = createRealDevice({ S: this.frame }, { replay: true });
    this._rd.replayBegin(ms);
    this._lastLine = 0; this._begun = ms;
  }

  async _seekTo(t) {
    const endMs = Math.round(t * 1000), startMs = endMs - WINDOW_S * 1000;
    const ahead = this._rd && endMs >= this._cursor && endMs - this._cursor <= WINDOW_S * 1000;
    const fromMs = ahead ? this._cursor : startMs;
    const hours = [];
    for (let h = Math.floor(fromMs / 1000 / HOUR) * HOUR; h * 1000 <= endMs; h += HOUR) hours.push(h);
    this.loading = true;
    let parts;
    try { parts = await Promise.all(hours.map((h) => this._hour(h))); } finally { this.loading = false; }
    if (this._want != null && !(this._want * 1000 >= fromMs)) return false;   // superseded by a seek behind this window
    if (!ahead) { this._begin(startMs); this._cursor = startMs; }
    const rd = this._rd;
    let fed = 0, slice = performance.now();
    for (const p of parts) {
      let i = upperBound(p.ms, this._cursor);
      while (i < p.ms.length && p.ms[i] <= endMs) {
        const ms = p.ms[i];
        // A silence longer than the RX watchdog means the link was down: the next line starts afresh,
        // as a reconnect does live.
        if (ms - (this._lastLine || this._begun) > GAP_MS) { rd.replayBegin(ms); this._begun = ms; this._lastLine = 0; }
        rd.replayLine(ms, p.lines[i], p.tx[i]);
        if (!p.tx[i]) this._lastLine = ms;
        this._cursor = ms;
        i++;
        if ((++fed & 511) === 0 && performance.now() - slice > SLICE_MS) {
          await yieldTask();
          slice = performance.now();
          if (this._want != null) return false;   // a newer seek takes over from this cursor
        }
      }
    }
    // Nothing for a while before the playhead: the link was down at this moment, so the frame is empty.
    if (endMs - (this._lastLine || this._begun) > GAP_MS) { rd.replayBegin(endMs); this._begun = endMs; this._lastLine = 0; }
    rd.replayTo(endMs);
    this._cursor = endMs;
    return true;
  }

  // Point session.S's frame fields at this frame's, and the observer at the recorded clock's.
  projectInto(S) {
    const F = this.frame; if (!F || !S) return;
    for (const k of FRAME_FIELDS) S[k] = F[k];
    if (S.obs && F.obs) { S.obs.lat = F.obs.lat; S.obs.lon = F.obs.lon; }
  }
}
