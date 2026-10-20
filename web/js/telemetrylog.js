// telemetrylog.js — the browser's recorder, for a real clock with no pccd recorder behind it.
//
// ONE RECORDER: pccd keeps the clock's full stream when it runs; without it this log keeps the same
// thing, the same way. Two tiers in IndexedDB:
//   - the stream: every line the clock sends and every command written to it, as received, in pccd's
//     format (`<epoch_ms> <line>`, `<epoch_ms> > <command>`), for 24 h. REVIEW replays it through the
//     live parser (streamreplay.js), exactly as it replays pccd's.
//   - the summary: 1-minute rollups + one row per connection (sessions), for the KEEP period. ARCHIVE
//     reads it.
//
// Design:
//   - Mirrors the repo's IndexedDB idiom (skytrailstore.js): EventTarget class, own DB, fire-and-forget
//     writes, localStorage logging/retention toggles, cursor pruning.
//   - Lines are written in chunks (one row per ~10 s of stream), not one row per line: 12 lines a
//     second as single rows is a million rows a day.
//   - FIRM RULE: only CONNECTED real data is ever persisted. This module never imports sim.js; lines
//     come only from realdev's transport tap, the minute tier only from a tick with S.real.
//   - A gap / CLOCK-DISCONNECTED span is simply an ABSENCE of rows (disconnect stops writes; reconnect
//     starts a new sessionId). No special gap rows.
//   - Writes never block the tick or the line handler (no await), so live perf is untouched.

const DB_NAME = 'pcc_telemetry';
const DB_VERSION = 2;               // v2: the stream (lines) replaces the 1 Hz JSON snapshots (samples)
const STORE_SAMPLES_V1 = 'samples'; // v1 only — dropped on upgrade (24 h of a format nothing replays)
const STORE_LINES = 'lines';        // the stream — keyPath [t, t1, sid]: first and last line ms of a chunk
const STORE_MINUTE = 'minute';      // 1-min rollup — keyPath [sessionId, m]
const STORE_SESSIONS = 'sessions';  // per-connection metadata — keyPath sessionId
const CHUNK_MS = 10000;             // a chunk closes after 10 s of stream (or 64 KB)
const CHUNK_MAX = 65536;

const LS_LOGGING = 'pcc_telemetry.logging';       // on unless turned off ('false'): it's local, like pccd's recorder
const LS_RETENTION = 'pcc_telemetry.retention';   // seconds; the minute tier + sessions. Default = pccd's -R (365 d)
const DEFAULT_RETENTION = 365 * 86400;
// Tiered like pccd: the stream (~50 MB/day) is kept for a day; the 1-minute rollups and session rows
// for the full retention.
const RAW_RETENTION = 86400;

export class TelemetryLog extends EventTarget {
  constructor() {
    super();
    this._db = null;
    this._sid = null;                 // current session id (null when not connected)
    this._lastT = -1;                 // last whole-second written (dedupe)
    this._minAccum = null;            // { m, ... } accumulator for the in-progress minute
    this._count = 0;                  // lines written this session (for the sessions row)
    this._chunk = null;               // the stream chunk being filled { t, t1, n, text }
    this._pre = [];                   // lines that arrived before the session row (the connect commands)
    this._writeFailed = false;        // a put errored (quota etc.) — stop pretending to record

    this._enabled = localStorage.getItem(LS_LOGGING) !== 'false';
    const r = parseInt(localStorage.getItem(LS_RETENTION), 10);
    this._retention = Number.isFinite(r) && r > 0 ? r : DEFAULT_RETENTION;

    this._ready = this._open();
    this._ready.then(() => this._prune())
      // A log with data asks to be kept: 1 Hz rows, or only sessions (+ their minute rows) once those age out.
      .then(() => Promise.all([this.count(), this.sessions()])).then(([n, ss]) => { if (n > 0 || ss.length) this.ensurePersisted(); })
      .catch((err) => console.warn('TelemetryLog open failed:', err));
  }

  // --- public toggles (persisted, like skytrailstore) ----------------------
  get enabled() { return this._enabled; }
  setEnabled(v) {
    this._enabled = !!v;
    localStorage.setItem(LS_LOGGING, String(this._enabled));
    this.dispatchEvent(new CustomEvent('logging', { detail: { enabled: this._enabled } }));
  }
  get retention() { return this._retention; }
  // A connection is being recorded right now.
  get recording() { return !!(this._enabled && this._sid && this._db && !this._writeFailed); }
  async setRetention(sec) {
    const s = parseInt(sec, 10);
    if (!Number.isFinite(s) || s <= 0 || s === this._retention) return;
    this._retention = s;
    localStorage.setItem(LS_RETENTION, String(s));
    await this._prune();
  }

  // --- session lifecycle (driven by the connect/disconnect edge) -----------
  // A session is one continuous CONNECTED span. Mint an id, stamp metadata.
  async beginSession(meta = {}) {
    await this._ready;
    this._sid = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    this._lastT = -1; this._minAccum = null; this._count = 0; this._chunk = null;
    // The lines of the last few seconds (the connect's commands and the clock's first replies) open
    // the session's stream: they came before the first tick could start it.
    const pre = this._pre; this._pre = [];
    for (const [ms, ln] of pre) if (Date.now() - ms < 15000) this._appendLine(ms, ln);
    const row = {
      sessionId: this._sid, connectedAt: Date.now(), disconnectAt: null,
      observerLat: meta.observerLat ?? null, observerLon: meta.observerLon ?? null,
      portLabel: meta.portLabel || '', rawCount: 0,
    };
    this._put(STORE_SESSIONS, row);
    return this._sid;
  }
  async endSession() {
    if (!this._sid) return;
    this._flushMinute();                          // don't lose the final <60 s of rollup
    this._flushChunk();                           // ...or the last seconds of stream
    const sid = this._sid;
    await this._ready;
    try {                                          // stamp disconnectAt + rawCount on the sessions row
      const tx = this._db.transaction(STORE_SESSIONS, 'readwrite');
      const os = tx.objectStore(STORE_SESSIONS);
      const g = os.get(sid);
      g.onsuccess = () => { const s = g.result; if (s) { s.disconnectAt = Date.now(); s.rawCount = this._count; os.put(s); } };
    } catch (err) { /* best effort */ }
    this._sid = null; this._lastT = -1; this._minAccum = null;
    await this._prune();
  }

  // --- the stream (called from realdev's transport tap, for every line in and command out) -------
  // `<ms> <line>` / `<ms> > <command>`, pccd's own format. Appended to the open chunk; a chunk is
  // written when it spans 10 s or 64 KB. Fire-and-forget.
  recordLine(ms, text, tx) {
    if (!this._enabled || this._writeFailed) return;
    const s = String(text).replace(/[\r\n]+$/, '').replace(/[\r\n]/g, ' ');
    if (!s.trim() || (!tx && s.startsWith('#PCCD'))) return;   // the bridge's hello is pccd's, not the clock's
    const t = Math.round(ms), ln = t + ' ' + (tx ? '> ' : '') + s + '\n';
    if (!this._sid) {                                          // before the session row: hold a few seconds
      this._pre.push([t, ln]);
      if (this._pre.length > 400) this._pre.splice(0, this._pre.length - 400);
      return;
    }
    this._appendLine(t, ln);
  }
  _appendLine(t, ln) {
    let c = this._chunk;
    if (c && t < c.t1) t = c.t1;                               // the stream's order is its arrival order
    if (c && t - c.t >= CHUNK_MS) { this._flushChunk(); c = null; }   // a chunk spans less than 10 s
    if (!c) c = this._chunk = { t, t1: t, n: 0, text: '' };
    c.text += ln; c.t1 = t; c.n++;
    this._count++;
    if (this._count === 1) this.ensurePersisted();             // the log has data now: ask the browser to keep it (once per load)
    if (c.text.length >= CHUNK_MAX) this._flushChunk();
  }
  _flushChunk() {
    const c = this._chunk;
    if (!c || !this._sid) return;
    this._chunk = null;
    this._put(STORE_LINES, { t: c.t, t1: c.t1, sid: this._sid, n: c.n, text: c.text });
  }

  // --- the summary hook (called from onTick, CONNECTED only) ---------------
  // Feeds the 1-minute rollup once per whole second; writes a chunk the stream left open on a quiet
  // link. Fire-and-forget — never awaited on the tick.
  record(S) {
    if (!this._enabled || !this._db || !this._sid || !S || this._writeFailed) return;
    const t = Math.floor(Date.now() / 1000);
    if (t === this._lastT) return;                 // dedupe: a double/late tick can't double-count
    this._lastT = t;
    this._accumulateMinute(this._snapshot(S, t));
    if (this._chunk && Date.now() - this._chunk.t1 > 3000) this._flushChunk();
    if (t - (this._prunedAt || 0) >= 3600) { this._prunedAt = t; this._prune(); }   // hourly while connected: the stream stays at a day
    this.dispatchEvent(new CustomEvent('sample', { detail: { t, count: this._count } }));
  }

  // The second's reading the minute rollup accumulates (sim:false is stamped structurally).
  _snapshot(S, t) {
    const f = S.fix;
    const fix = (f && f.valid) ? {
      lat: f.lat, lon: f.lon, alt: f.alt ?? null,
      hdop: f.hdop ?? null, pdop: f.pdop ?? null, vdop: f.vdop ?? null,
      type: f.type ?? null, sats: f.sats ?? null,
    } : null;
    // Keep the constellation identity (key/constId/…) so a later REVIEW can colour the sky the
    // same way live does — az/el/cn0 alone can't tell GPS from Galileo.
    const sats = Array.isArray(S.sats) ? S.sats.map((s) => ({
      prn: s.prn, cn0: s.cn0 ?? 0, el: s.el ?? null, az: s.az ?? null, used: !!s.used,
      key: s.key, constId: s.constId, tok: s.tok, talker: s.talker, sysId: s.sysId,
    })) : [];
    // Only record timing once a real $PMTXTS has actually arrived — realdev initialises the pps
    // scalars to 0 (not null), so gating on `temp != null` used to persist phantom 0 degC / 0 ppm
    // rows for the seconds before the stream starts. p.list is populated only by a real PPS edge.
    const p = S.pps;
    const pps = (p && p.list && p.list.length) ? {
      temp: p.temp ?? null, ppm: p.ppm ?? null,
      phaseUs: p.list[p.list.length - 1].us ?? null,
      calerr: p.calerr ?? null,
    } : null;
    return { sessionId: this._sid, t, sim: false, sats, fix, pps };
  }

  // --- 1-minute rollup (coarse tier for zoomed-out scrub) ------------------
  _accumulateMinute(row) {
    const m = Math.floor(row.t / 60) * 60;
    if (!this._minAccum || this._minAccum.m !== m) { this._flushMinute(); this._minAccum = this._newMinute(m); }
    const a = this._minAccum;
    a.n++;
    if (row.fix) {
      a.fixN++; a.latSum += row.fix.lat; a.lonSum += row.fix.lon;
      if (row.fix.hdop != null) { a.hdopSum += row.fix.hdop; a.hdopN++; }
      a.satsSum += row.fix.sats || 0;
    }
    if (row.pps && row.pps.temp != null) {
      a.tempMin = Math.min(a.tempMin, row.pps.temp); a.tempMax = Math.max(a.tempMax, row.pps.temp);
    }
    if (row.pps && row.pps.ppm != null) {
      a.ppmMin = Math.min(a.ppmMin, row.pps.ppm); a.ppmMax = Math.max(a.ppmMax, row.pps.ppm);
    }
    let cn0 = 0, cN = 0;
    for (const s of row.sats) { if (s.cn0 > 0) { cn0 += s.cn0; cN++; } }
    if (cN) { a.cn0Sum += cn0 / cN; a.cn0N++; }
  }
  _newMinute(m) {
    return { m, n: 0, fixN: 0, latSum: 0, lonSum: 0, hdopSum: 0, hdopN: 0, satsSum: 0,
      tempMin: Infinity, tempMax: -Infinity, ppmMin: Infinity, ppmMax: -Infinity, cn0Sum: 0, cn0N: 0 };
  }
  _flushMinute() {
    const a = this._minAccum;
    if (!a || !this._sid) return;
    const row = {
      sessionId: this._sid, m: a.m, n: a.n,
      fixPct: a.n ? a.fixN / a.n : 0,
      lat: a.fixN ? a.latSum / a.fixN : null, lon: a.fixN ? a.lonSum / a.fixN : null,
      hdop: a.hdopN ? a.hdopSum / a.hdopN : null, sats: a.n ? a.satsSum / a.n : null,
      cn0: a.cn0N ? a.cn0Sum / a.cn0N : null,
      tempMin: a.tempMin === Infinity ? null : a.tempMin, tempMax: a.tempMax === -Infinity ? null : a.tempMax,
      ppmMin: a.ppmMin === Infinity ? null : a.ppmMin, ppmMax: a.ppmMax === -Infinity ? null : a.ppmMax,
    };
    this._put(STORE_MINUTE, row);
    this._minAccum = null;
  }

  // --- the stream's read path (REVIEW's replay source without pccd) ------------------------------
  // The recorded text for [fromMs, toMs]: every chunk that overlaps it, oldest first, plus the chunk
  // still open in memory. The caller (parseStamped) trims to the window.
  async linesText(fromMs, toMs) {
    await this._ready;
    let text = '';
    if (this._db) text = await new Promise((resolve) => {
      const parts = [];
      const tx = this._db.transaction(STORE_LINES, 'readonly');
      const rq = tx.objectStore(STORE_LINES).getAll(IDBKeyRange.bound([fromMs - CHUNK_MS - 1000], [toMs + 1], false, true));
      rq.onsuccess = () => { for (const r of rq.result || []) if (r.t1 >= fromMs) parts.push(r.text); };
      tx.oncomplete = () => resolve(parts.join(''));
      tx.onerror = () => resolve(parts.join(''));
    });
    const c = this._chunk;
    if (c && c.t1 >= fromMs && c.t <= toMs) text += c.text;
    return text;
  }
  // When the stream ran: [{ t0, t1 }] (ms), oldest first, a new run wherever 8 s passed with no
  // chunk. Keys only (each chunk's key holds its first and last stamp), so no text is read.
  async lineRuns() {
    await this._ready;
    const runs = [];
    const add = (t, t1) => {
      const r = runs[runs.length - 1];
      if (r && t - r.t1 <= 8000) r.t1 = Math.max(r.t1, t1); else runs.push({ t0: t, t1 });
    };
    if (this._db) await new Promise((resolve) => {
      const tx = this._db.transaction(STORE_LINES, 'readonly');
      const rq = tx.objectStore(STORE_LINES).getAllKeys();
      rq.onsuccess = () => { for (const k of rq.result || []) add(k[0], k[1]); };
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    if (this._chunk) add(this._chunk.t, this._chunk.t1);
    return runs;
  }
  // The stream's depth: { from, to } (ms) of the oldest and newest chunk, and the chunk count; null when empty.
  async streamInfo() {
    await this._ready;
    let first = null, last = null, chunks = 0;
    if (this._db) await new Promise((resolve) => {
      const tx = this._db.transaction(STORE_LINES, 'readonly');
      const os = tx.objectStore(STORE_LINES);
      const k = os.getAllKeys();
      k.onsuccess = () => {
        const ks = k.result || [];
        chunks = ks.length;
        if (ks.length) { first = ks[0][0]; last = ks[ks.length - 1][1]; }
      };
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    if (this._chunk) { if (first == null) first = this._chunk.t; last = this._chunk.t1; chunks++; }
    return first == null ? null : { from: first, to: last, chunks };
  }
  // The stream as plain NMEA (stamps and commands stripped), like pccd's format=nmea: a Blob, built
  // chunk by chunk so a day of stream is never one string.
  async nmeaBlob() {
    await this._ready;
    const parts = [];
    const strip = (text) => {
      let o = '';
      for (const ln of text.split('\n')) {
        const sp = ln.indexOf(' ');
        if (sp < 0) continue;
        const b = ln.slice(sp + 1);
        if (b && !b.startsWith('> ')) o += b + '\n';
      }
      return o;
    };
    if (this._db) await new Promise((resolve) => {
      const tx = this._db.transaction(STORE_LINES, 'readonly');
      const rq = tx.objectStore(STORE_LINES).openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { parts.push(strip(c.value.text)); c.continue(); } };
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    if (this._chunk) parts.push(strip(this._chunk.text));
    return new Blob(parts, { type: 'text/plain' });
  }
  async sessions() {
    await this._ready;
    if (!this._db) return [];
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_SESSIONS, 'readonly');
      const req = tx.objectStore(STORE_SESSIONS).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.connectedAt - a.connectedAt));
      req.onerror = () => resolve([]);
    });
  }
  // Stream chunks held (≈ one per 10 s of a connected clock).
  async count() {
    await this._ready;
    if (!this._db) return 0;
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_LINES, 'readonly');
      const req = tx.objectStore(STORE_LINES).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  }
  async estimateBytes() {
    try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
  }

  // --- minute tier read path (the ARCHIVE charts without pccd) -------------
  // 1-minute rollups with m in [from, to] (epoch s) across every session, oldest first. The store is
  // keyed [sessionId, m] with no time index, so read each session's slice in one transaction; a
  // session whose span cannot reach the window is skipped. Rollups carry no sim flag: they are
  // derived only from rows record() wrote, and record() runs only for a real clock.
  async minuteRange(from, to) {
    await this._ready;
    if (!this._db) return [];
    const lo = Math.floor(from || 0), hi = Math.floor(to || 4e9);
    const sess = (await this.sessions()).filter((s) => !(s.connectedAt / 1000 > hi + 60) &&
      !(s.disconnectAt != null && s.disconnectAt / 1000 < lo - 60));
    if (!sess.length) return [];
    return new Promise((resolve) => {
      const out = [];
      const tx = this._db.transaction(STORE_MINUTE, 'readonly');
      const os = tx.objectStore(STORE_MINUTE);
      for (const s of sess) {
        const rq = os.getAll(IDBKeyRange.bound([s.sessionId, lo], [s.sessionId, hi]));
        rq.onsuccess = () => { for (const r of rq.result || []) out.push(r); };
      }
      tx.oncomplete = () => resolve(out.sort((a, b) => a.m - b.m));
      tx.onerror = () => resolve(out.sort((a, b) => a.m - b.m));
    });
  }
  // First and last minute of each session's rollups: [{ sessionId, m0, m1 }], oldest first. Two
  // one-step cursors per session, so the archive caption can say how many days the log holds
  // without reading every row.
  async minuteSpans() {
    await this._ready;
    if (!this._db) return [];
    const sess = await this.sessions();
    if (!sess.length) return [];
    return new Promise((resolve) => {
      const spans = new Map();
      const tx = this._db.transaction(STORE_MINUTE, 'readonly');
      const os = tx.objectStore(STORE_MINUTE);
      for (const s of sess) {
        const rng = IDBKeyRange.bound([s.sessionId, 0], [s.sessionId, Infinity]);
        for (const dir of ['next', 'prev']) {
          const rq = os.openCursor(rng, dir);
          rq.onsuccess = () => {
            const c = rq.result; if (!c) return;
            const e = spans.get(s.sessionId) || { sessionId: s.sessionId, m0: c.value.m, m1: c.value.m };
            e.m0 = Math.min(e.m0, c.value.m); e.m1 = Math.max(e.m1, c.value.m);
            spans.set(s.sessionId, e);
          };
        }
      }
      const done = () => resolve([...spans.values()].sort((a, b) => a.m0 - b.m0));
      tx.oncomplete = done; tx.onerror = done;
    });
  }

  // --- eviction (navigator.storage.persist) --------------------------------
  // IndexedDB is best-effort storage: the browser may clear it under storage pressure, and Safari
  // clears script-written storage after 7 days without a visit. Ask once per page load, when the
  // log has data, to make it persistent. Chromium answers from site engagement with no prompt;
  // Firefox asks the user. `persistence` is null until asked, then 'persistent' or 'evictable'.
  get persistence() { return this._persist || null; }
  async ensurePersisted() {
    if (this._persistAsk) return this._persistAsk;
    this._persistAsk = (async () => {
      let ok = false;
      try {
        const st = navigator.storage;
        if (st && st.persisted) ok = await st.persisted();
        if (!ok && st && st.persist) ok = await st.persist();
      } catch { ok = false; }
      this._persist = ok ? 'persistent' : 'evictable';
      this.dispatchEvent(new CustomEvent('persist', { detail: { persistent: ok } }));
      return this._persist;
    })();
    return this._persistAsk;
  }

  // --- clear (keeps the sessions list; wipes the telemetry) ----------------
  async clear() {
    this._minAccum = null; this._lastT = -1; this._chunk = null; this._pre = [];
    await this._ready;
    if (!this._db) return;
    await new Promise((resolve) => {
      const tx = this._db.transaction([STORE_LINES, STORE_MINUTE], 'readwrite');
      tx.objectStore(STORE_LINES).clear();
      tx.objectStore(STORE_MINUTE).clear();
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    this.dispatchEvent(new CustomEvent('cleared', {}));
  }

  // --- persistence ---------------------------------------------------------
  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // v1 → v2: the 1 Hz JSON snapshots go (a day at most, in a format nothing replays); the stream
        // takes their place. The minute and sessions tiers carry over untouched.
        if (db.objectStoreNames.contains(STORE_SAMPLES_V1)) db.deleteObjectStore(STORE_SAMPLES_V1);
        if (!db.objectStoreNames.contains(STORE_LINES)) db.createObjectStore(STORE_LINES, { keyPath: ['t', 't1', 'sid'] });
        if (!db.objectStoreNames.contains(STORE_MINUTE)) db.createObjectStore(STORE_MINUTE, { keyPath: ['sessionId', 'm'] });
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          const ss = db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
          ss.createIndex('connectedAt', 'connectedAt');
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        // Another tab opening a newer version must not wait on this one: close, and stop writing.
        this._db.onversionchange = () => { try { this._db.close(); } catch { /* closing anyway */ } this._db = null; };
        resolve(this._db);
      };
      req.onblocked = () => console.warn('TelemetryLog upgrade waits for another tab to close the old log');
      // Resolve to null (not reject) on open failure — private-mode Firefox, storage disabled, etc.
      // Every public method awaits this._ready; a rejection would surface as an unhandled rejection
      // on each call and the Export buttons would silently no-op. Null + the !this._db guards let
      // the whole feature degrade to a clean no-op instead.
      req.onerror = () => { console.warn('TelemetryLog open failed:', req.error); resolve(null); };
    });
  }
  _put(store, row) {
    if (!this._db || this._writeFailed) return;
    try {
      const rq = this._db.transaction(store, 'readwrite').objectStore(store).put(row);
      rq.onerror = (e) => {
        // Quota exhaustion (or any write error) must stop the illusion of recording: flag it so
        // record() stops counting and the UI can surface that persistence stalled, rather than the
        // sample counter climbing while nothing lands.
        this._writeFailed = true;
        console.warn('TelemetryLog write failed (recording stopped):', (e && e.target && e.target.error) || 'unknown');
        this.dispatchEvent(new CustomEvent('writefailed', {}));
      };
    } catch (err) { this._writeFailed = true; console.warn('TelemetryLog put threw:', err); }
  }

  // Delete stream chunks older than a day (by absolute time), then any minute rows / sessions whose
  // whole span fell before the retention cutoff.
  async _prune() {
    if (!this._db) return;
    const nowS = Math.floor(Date.now() / 1000);
    const cutoff = nowS - this._retention;                              // minute tier + sessions
    const rawCut = nowS - Math.min(RAW_RETENTION, this._retention);     // the stream
    await new Promise((resolve) => {
      const tx = this._db.transaction(STORE_LINES, 'readwrite');
      tx.objectStore(STORE_LINES).delete(IDBKeyRange.upperBound([rawCut * 1000], true));   // keys sort by first stamp
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    // sessions fully older than the cutoff: drop their metadata + minute rows too.
    try {
      // A session is stale once its LAST activity fell before the cutoff. Sessions ended cleanly
      // carry disconnectAt; sessions orphaned by a tab-close (endSession never fired) have
      // disconnectAt === null, so fall back to connectedAt — otherwise orphans (and their minute
      // rows) accumulate forever and stretch the scrub timeline back to the first-ever orphan.
      const olds = (await this.sessions()).filter((s) => {
        const last = s.disconnectAt != null ? s.disconnectAt : s.connectedAt;
        return last != null && last / 1000 < cutoff;
      });
      for (const s of olds) {
        const tx = this._db.transaction([STORE_SESSIONS, STORE_MINUTE], 'readwrite');
        tx.objectStore(STORE_SESSIONS).delete(s.sessionId);
        const mos = tx.objectStore(STORE_MINUTE);
        const c = mos.openCursor(IDBKeyRange.bound([s.sessionId, 0], [s.sessionId, Infinity]));
        c.onsuccess = (e) => { const cur = e.target.result; if (cur) { cur.delete(); cur.continue(); } };
      }
    } catch (err) { /* best effort */ }
  }
}
