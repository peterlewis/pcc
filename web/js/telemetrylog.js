// telemetrylog.js — persistent telemetry log for the CONNECTED state.
//
// When a real Precision Clock Mk IV is connected over Web Serial, its live
// stream (fix, satellites, PPS temperature / skew) is captured once per second
// into IndexedDB so the user can later REWIND / SCRUB through it and a future
// background helper app can keep collecting. See pcc-web-three-state-model.
//
// Design (from the logging/decimation design synthesis):
//   - Mirrors the repo's IndexedDB idiom (skytrailstore.js): EventTarget class,
//     own DB, fire-and-forget writes, localStorage logging/retention toggles,
//     index-cursor pruning. No new conventions.
//   - ONE snapshot row per whole second (sats inline) — not per-sat-per-second,
//     which would 25× the row count and get the DB evicted.
//   - FIRM RULE: only CONNECTED real data is ever persisted. This module never
//     imports sim.js; the caller gates on S.real; and every row is stamped
//     sim:false with a read-time assertion. Three independent guards.
//   - A gap / CLOCK-DISCONNECTED span is simply an ABSENCE of rows (disconnect
//     stops writes; reconnect starts a new sessionId). No special gap rows.
//   - Writes never block the 1 Hz tick (no await), so live perf is untouched.

const DB_NAME = 'pcc_telemetry';
const DB_VERSION = 1;
const STORE_SAMPLES = 'samples';    // raw 1 Hz — keyPath [sessionId, t]
const STORE_MINUTE = 'minute';      // 1-min rollup — keyPath [sessionId, m]
const STORE_SESSIONS = 'sessions';  // per-connection metadata — keyPath sessionId

const LS_LOGGING = 'pcc_telemetry.logging';       // opt-IN, default off (honesty: no silent persistence)
const LS_RETENTION = 'pcc_telemetry.retention';   // seconds; default 7 days
const DEFAULT_RETENTION = 7 * 86400;

export class TelemetryLog extends EventTarget {
  constructor() {
    super();
    this._db = null;
    this._sid = null;                 // current session id (null when not connected)
    this._lastT = -1;                 // last whole-second written (dedupe)
    this._minAccum = null;            // { m, ... } accumulator for the in-progress minute
    this._count = 0;                  // rows written this session (for the sessions row)

    this._enabled = localStorage.getItem(LS_LOGGING) === 'true';
    const r = parseInt(localStorage.getItem(LS_RETENTION), 10);
    this._retention = Number.isFinite(r) && r > 0 ? r : DEFAULT_RETENTION;

    this._ready = this._open();
    this._ready.then(() => this._prune()).catch((err) => console.warn('TelemetryLog open failed:', err));
  }

  // --- public toggles (persisted, like skytrailstore) ----------------------
  get enabled() { return this._enabled; }
  setEnabled(v) {
    this._enabled = !!v;
    localStorage.setItem(LS_LOGGING, String(this._enabled));
    this.dispatchEvent(new CustomEvent('logging', { detail: { enabled: this._enabled } }));
  }
  get retention() { return this._retention; }
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
    this._lastT = -1; this._minAccum = null; this._count = 0;
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

  // --- the write hook (called from onTick, CONNECTED only) -----------------
  // One append per whole second. Fire-and-forget — never awaited on the tick.
  record(S) {
    if (!this._enabled || !this._db || !this._sid || !S) return;
    const t = Math.floor(Date.now() / 1000);
    if (t === this._lastT) return;                 // dedupe: a double/late tick can't double-write
    this._lastT = t;
    const row = this._snapshot(S, t);
    this._put(STORE_SAMPLES, row);                 // fire-and-forget
    this._count++;
    this._accumulateMinute(row);
    this.dispatchEvent(new CustomEvent('sample', { detail: { t, count: this._count } }));
  }

  // Build the honest one-second snapshot. sim:false is stamped structurally.
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
    const p = S.pps;
    const pps = (p && (p.temp != null || p.calerr != null)) ? {
      temp: p.temp ?? null, ppm: p.ppm ?? null,
      phaseUs: p.phaseUs ?? (p.list && p.list.length ? p.list[p.list.length - 1].us : null) ?? null,
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

  // --- read path (for the future scrub view + verification) ----------------
  // Raw samples within [tStart, tEnd] of a session, oldest first. Rejects any
  // row not stamped sim:false (defense-in-depth against a fake-data leak).
  async range(sessionId, tStart, tEnd) {
    await this._ready;
    // NB: no `| 0` — these are whole-second epoch timestamps (~1.8e9), which overflow a signed
    // 32-bit truncation. Floor to plain numbers; IndexedDB orders the compound key numerically.
    const lo = Math.floor(tStart || 0), hi = Math.floor(tEnd || 4e9);
    return new Promise((resolve) => {
      const out = [];
      const tx = this._db.transaction(STORE_SAMPLES, 'readonly');
      const rng = IDBKeyRange.bound([sessionId, lo], [sessionId, hi]);
      const req = tx.objectStore(STORE_SAMPLES).openCursor(rng);
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { if (c.value && c.value.sim === false) out.push(c.value); c.continue(); }
        else resolve(out);
      };
      req.onerror = () => resolve(out);
    });
  }
  async sessions() {
    await this._ready;
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_SESSIONS, 'readonly');
      const req = tx.objectStore(STORE_SESSIONS).getAll();
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.connectedAt - a.connectedAt));
      req.onerror = () => resolve([]);
    });
  }
  async count() {
    await this._ready;
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_SAMPLES, 'readonly');
      const req = tx.objectStore(STORE_SAMPLES).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  }
  async estimateBytes() {
    try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
  }

  // --- clear (keeps the sessions list; wipes the telemetry) ----------------
  async clear() {
    this._minAccum = null; this._lastT = -1;
    await this._ready;
    await new Promise((resolve) => {
      const tx = this._db.transaction([STORE_SAMPLES, STORE_MINUTE], 'readwrite');
      tx.objectStore(STORE_SAMPLES).clear();
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
        if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
          const s = db.createObjectStore(STORE_SAMPLES, { keyPath: ['sessionId', 't'] });
          s.createIndex('t', 't');                 // for cross-session retention prune by absolute time
        }
        if (!db.objectStoreNames.contains(STORE_MINUTE)) db.createObjectStore(STORE_MINUTE, { keyPath: ['sessionId', 'm'] });
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          const ss = db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
          ss.createIndex('connectedAt', 'connectedAt');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  }
  _put(store, row) {
    if (!this._db) return;
    try { this._db.transaction(store, 'readwrite').objectStore(store).put(row); }
    catch (err) { console.warn('TelemetryLog put failed:', err); }
  }

  // Delete raw samples older than the retention cutoff (by absolute time), then
  // any minute rows / sessions whose whole span fell before the cutoff. Cursor
  // delete on the 't' index — identical shape to skytrailstore._pruneOldPasses.
  async _prune() {
    if (!this._db) return;
    const cutoff = Math.floor(Date.now() / 1000) - this._retention;
    await new Promise((resolve) => {
      const tx = this._db.transaction(STORE_SAMPLES, 'readwrite');
      const idx = tx.objectStore(STORE_SAMPLES).index('t');
      const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
      req.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
    // sessions fully older than the cutoff: drop their metadata + minute rows too.
    try {
      const olds = (await this.sessions()).filter((s) => s.disconnectAt && s.disconnectAt / 1000 < cutoff);
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
