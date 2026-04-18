// Port of Sources/PCC/SkyTrailStore.swift.
//
// Records satellite passes with per-observation detail, maintains the
// horizon-mask and sector-heatmap aggregates, and prunes older passes
// against a retention window. See MAC_PARITY.md for the mirror policy.
//
// Storage: IndexedDB (Mac uses FileManager JSON files). The passes
// object-store holds one row per pass; `observations` is an inline array
// on the pass row because typical passes fit comfortably inside a single
// IndexedDB record (a few hundred 4-byte tuples). This matches the
// Swift "one JSON file per pass" model semantically.
//
// Events: the class extends EventTarget and emits:
//   - "passes"    — detail: { passes, activePRNs }
//   - "mask"      — detail: { horizonMask }
//   - "heatmap"   — detail: { sectorHeatmap }
//   - "stats"     — detail: { stats }
// Renderers subscribe to whichever events they need.
//
// NMEA ingestion: `update(satellites)` takes the same shape as the Swift
// `SerialManager.satellites` — an array of `{id, prn, constellation,
// azimuth, elevation, snr}`. SNR must be non-null and > 0 to count.

import { CONSTELLATIONS } from './nmea.js';
import { passPeakElevation, passDuration, passEndTime, RetentionWindow, TimeWindow } from './satpass.js';

const DB_NAME = 'pcc_web';
const DB_VERSION = 1;
const STORE_PASSES = 'passes';

// Tunables — mirror the Swift constants exactly.
const RECORDING_INTERVAL_S = 6;     // seconds between saved obs per PRN
const PASS_TIMEOUT_S = 90;          // silence → close pass
const PASS_REJOIN_WINDOW_S = 300;   // same PRN reappearing within window resumes prior pass
const MIN_OBSERVATIONS = 3;         // shorter passes are discarded

// 5° bins: 72 azimuth × 18 elevation over the hemisphere.
const AZ_BINS = 72;
const EL_BINS = 18;

const LS_RETENTION_KEY = 'pcc_web.skyTrailRetention';
const LS_LOGGING_KEY = 'pcc_web.skyTrailLogging';

export class SkyTrailStore extends EventTarget {
    constructor() {
        super();
        this._db = null;
        this._ready = this._open();
        this._active = new Map();              // prn → { pass, lastSeen, lastRecorded }
        this._passes = [];                     // closed passes, newest first
        this._horizonMask = new Array(AZ_BINS).fill(null);
        this._sectorHeatmap = Array.from({ length: AZ_BINS }, () => new Array(EL_BINS).fill(null));
        this._timeoutTimer = null;

        const storedRet = localStorage.getItem(LS_RETENTION_KEY);
        this._retention = RetentionWindow.all_cases.includes(storedRet) ? storedRet : RetentionWindow.d30;

        const storedLogging = localStorage.getItem(LS_LOGGING_KEY);
        this._isLogging = storedLogging === 'true';

        // Load from disk then run a retention prune. Downstream listeners
        // attached before _ready settles will still get the events.
        this._ready.then(async () => {
            await this._loadPasses();
            await this._pruneOldPasses();
            this._emitAll();
        }).catch(err => console.warn('SkyTrailStore open failed:', err));
    }

    // MARK: - Public state ----------------------------------------------

    /// IsLogging = are we recording new observations into the store?
    /// Persisted to localStorage so the toggle survives reload.
    get isLogging() { return this._isLogging; }
    set isLogging(v) {
        this._isLogging = !!v;
        localStorage.setItem(LS_LOGGING_KEY, String(this._isLogging));
    }

    get retention() { return this._retention; }
    async setRetention(window) {
        if (!RetentionWindow.all_cases.includes(window)) return;
        if (window === this._retention) return;
        this._retention = window;
        localStorage.setItem(LS_RETENTION_KEY, window);
        await this._pruneOldPasses();
        this._emitAll();
    }

    /// Completed + currently-recording passes, newest-first. Mirrors
    /// `SkyTrailStore.allPasses`.
    get allPasses() {
        const active = [...this._active.values()].map(e => e.pass);
        return [...this._passes, ...active]
            .sort((a, b) => b.startTime - a.startTime);
    }

    get activePRNs() { return new Set(this._active.keys()); }

    get horizonMask() { return this._horizonMask; }
    get sectorHeatmap() { return this._sectorHeatmap; }

    /// Aggregate stats for UI summary. Mirrors `SkyStats` / `stats`.
    get stats() {
        const all = this.allPasses;
        if (!all.length) {
            return {
                totalPasses: 0, passesToday: 0, observations: 0,
                coveragePercent: 0, peakElevation: 0, longestPassSeconds: 0,
            };
        }
        const now = Date.now();
        const todayCutoff = now - 86400_000;
        let peak = 0, longest = 0, obsCount = 0, todayCount = 0;
        for (const p of all) {
            const pk = passPeakElevation(p); if (pk > peak) peak = pk;
            const dur = passDuration(p); if (dur > longest) longest = dur;
            obsCount += p.observations.length;
            if (passEndTime(p).getTime() >= todayCutoff) todayCount++;
        }
        const occupied = this._horizonMask.filter(v => v != null).length;
        return {
            totalPasses: all.length,
            passesToday: todayCount,
            observations: obsCount,
            coveragePercent: occupied / AZ_BINS * 100,
            peakElevation: peak,
            longestPassSeconds: longest,
        };
    }

    // MARK: - Window filter ---------------------------------------------

    /// Passes within the given TimeWindow, trimmed to observations whose
    /// absolute time is >= cutoff. Mirrors `SkyTrailStore.filtered(by:)`.
    filtered(window, now = new Date()) {
        const cutoffSec = TimeWindow.cutoffSec(window);
        if (cutoffSec == null) return this.allPasses;
        const cutoff = new Date(now.getTime() - cutoffSec * 1000);

        const out = [];
        for (const pass of this.allPasses) {
            if (passEndTime(pass) < cutoff) continue;
            const cutoffOffset = (cutoff.getTime() - pass.startTime.getTime()) / 1000;
            if (cutoffOffset <= 0) { out.push(pass); continue; }
            const cutoffT = Math.max(0, Math.round(cutoffOffset));
            const firstIdx = pass.observations.findIndex(o => o.t >= cutoffT);
            if (firstIdx < 0) continue;
            if (pass.observations.length - firstIdx < 2) continue;
            out.push({
                ...pass,
                observations: pass.observations.slice(firstIdx),
            });
        }
        return out;
    }

    // MARK: - Recording --------------------------------------------------

    /// Main entry point. `satellites` is an array of live sats — same shape
    /// as the polar/globe input. Mirrors `update(satellites:)`.
    update(satellites) {
        if (!this._isLogging) return;
        const now = new Date();
        for (const sat of satellites) {
            if ((sat.snr ?? 0) <= 0) continue;
            this._updateHorizonMask(sat.azimuth, sat.elevation);
            this._updateSectorHeatmap(sat.azimuth, sat.elevation, sat.snr);
            this._appendObservation(sat, now);
        }
        this._ensureTimeoutTimerRunning();
        this._emitAll();
    }

    _updateHorizonMask(az, el) {
        if (!(el > 1)) return;
        const sector = ((((az % 360) + 360) % 360) / 5) | 0;
        if (sector < 0 || sector >= AZ_BINS) return;
        const cur = this._horizonMask[sector];
        if (cur == null || el < cur) this._horizonMask[sector] = el;
    }

    /// Peak SNR per 5°×5° cell — matches SkyTrailStore.updateSectorHeatmap.
    _updateSectorHeatmap(az, el, snr) {
        if (!(el >= 0 && el <= 90) || !(snr > 0)) return;
        const azBin = ((((az % 360) + 360) % 360) / 5) | 0;
        const elBin = Math.min(EL_BINS - 1, Math.max(0, (el / 5) | 0));
        if (azBin < 0 || azBin >= AZ_BINS) return;
        const cur = this._sectorHeatmap[azBin][elBin] ?? 0;
        if (snr > cur) this._sectorHeatmap[azBin][elBin] = snr;
    }

    _appendObservation(sat, now) {
        const prn = sat.id;
        const az = clamp(sat.azimuth, -32768, 32767);
        const el = clamp(sat.elevation, -128, 127);
        const snr = clamp(sat.snr ?? 0, -128, 127);

        const entry = this._active.get(prn);
        if (entry) {
            entry.lastSeen = now;
            if (now - entry.lastRecorded >= RECORDING_INTERVAL_S * 1000) {
                const tOffset = clamp(Math.round((now - entry.pass.startTime) / 1000), 0, 65535);
                entry.pass.observations.push({ az, el, snr, t: tOffset });
                entry.lastRecorded = now;
                this._savePass(entry.pass);
            }
            return;
        }

        const rejoinIdx = this._recentPassIndex(prn, now);
        if (rejoinIdx >= 0) {
            // Drop-outs shorter than passRejoinWindow are treated as brief
            // signal interruptions (obstruction / multipath null / unlock)
            // rather than horizon events — resume the prior pass so the
            // trail stays continuous across momentary losses.
            const revived = this._passes.splice(rejoinIdx, 1)[0];
            const tOffset = clamp(Math.round((now - revived.startTime) / 1000), 0, 65535);
            revived.observations.push({ az, el, snr, t: tOffset });
            this._active.set(prn, { pass: revived, lastSeen: now, lastRecorded: now });
            this._savePass(revived);
            return;
        }

        const first = { az, el, snr, t: 0 };
        const pass = {
            id: crypto.randomUUID(),
            prn,
            // Store the constellation id string on disk (not the live object)
            // and rehydrate on load so CONSTELLATIONS is the one source of
            // metadata. Mirrors Swift's `Codable SatConstellation`.
            constellation: sat.constellation,
            startTime: now,
            observations: [first],
        };
        this._active.set(prn, { pass, lastSeen: now, lastRecorded: now });
        this._savePass(pass);
    }

    _recentPassIndex(prn, now) {
        const cutoff = now - PASS_REJOIN_WINDOW_S * 1000;
        // _passes is sorted newest-first (post-load). Walk forward to find
        // the most recent matching PRN whose endTime >= cutoff.
        for (let i = 0; i < this._passes.length; i++) {
            const p = this._passes[i];
            if (p.prn !== prn) continue;
            if (passEndTime(p).getTime() >= cutoff) return i;
        }
        return -1;
    }

    _ensureTimeoutTimerRunning() {
        if (this._timeoutTimer) return;
        this._timeoutTimer = setInterval(() => this._timeoutStalePasses(), 30_000);
    }

    _timeoutStalePasses() {
        const now = Date.now();
        const stale = [];
        for (const [prn, entry] of this._active) {
            if (now - entry.lastSeen >= PASS_TIMEOUT_S * 1000) stale.push(prn);
        }
        for (const prn of stale) this._closePass(prn);
        if (this._active.size === 0 && this._timeoutTimer) {
            clearInterval(this._timeoutTimer);
            this._timeoutTimer = null;
        }
        if (stale.length) this._emitAll();
    }

    _closePass(prn) {
        const entry = this._active.get(prn);
        if (!entry) return;
        this._active.delete(prn);
        if (entry.pass.observations.length >= MIN_OBSERVATIONS) {
            this._passes.push(entry.pass);
            this._passes.sort((a, b) => b.startTime - a.startTime);
        } else {
            this._deletePass(entry.pass.id);
        }
    }

    _flushActivePasses() {
        for (const prn of [...this._active.keys()]) this._closePass(prn);
    }

    // MARK: - External control ------------------------------------------

    async clear() {
        this._flushActivePasses();
        this._active.clear();
        this._passes = [];
        this._horizonMask = new Array(AZ_BINS).fill(null);
        this._sectorHeatmap = Array.from({ length: AZ_BINS }, () => new Array(EL_BINS).fill(null));
        if (this._timeoutTimer) { clearInterval(this._timeoutTimer); this._timeoutTimer = null; }
        await this._ready;
        await new Promise((resolve, reject) => {
            const tx = this._db.transaction(STORE_PASSES, 'readwrite');
            tx.objectStore(STORE_PASSES).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        this._emitAll();
    }

    /// Count of passes that a shorter retention would delete.
    /// Mirrors SkyTrailStore.passesThatWouldBePruned.
    passesThatWouldBePruned(retention, now = new Date()) {
        const secs = RetentionWindow.seconds(retention);
        if (secs == null) return [];
        const cutoff = new Date(now.getTime() - secs * 1000);
        return this.allPasses.filter(p => passEndTime(p) < cutoff);
    }

    // MARK: - Persistence ----------------------------------------------

    _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_PASSES)) {
                    const store = db.createObjectStore(STORE_PASSES, { keyPath: 'id' });
                    store.createIndex('endTime', 'endTime');
                    store.createIndex('prn', 'prn');
                }
            };
            req.onsuccess = () => { this._db = req.result; resolve(this._db); };
            req.onerror = () => reject(req.error);
        });
    }

    _savePass(pass) {
        // Fire-and-forget — UI has the in-memory copy already; persistence
        // is a durability nicety. Mirrors Swift's saveQueue.async write.
        if (!this._db) return;
        try {
            const row = this._serialize(pass);
            const tx = this._db.transaction(STORE_PASSES, 'readwrite');
            tx.objectStore(STORE_PASSES).put(row);
        } catch (err) {
            console.warn('savePass failed:', err);
        }
    }

    _deletePass(id) {
        if (!this._db) return;
        try {
            const tx = this._db.transaction(STORE_PASSES, 'readwrite');
            tx.objectStore(STORE_PASSES).delete(id);
        } catch (err) {
            console.warn('deletePass failed:', err);
        }
    }

    async _loadPasses() {
        const rows = await new Promise((resolve, reject) => {
            const tx = this._db.transaction(STORE_PASSES, 'readonly');
            const req = tx.objectStore(STORE_PASSES).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        this._passes = rows.map(r => this._deserialize(r))
            .filter(Boolean)
            .sort((a, b) => b.startTime - a.startTime);

        // Rebuild horizon mask + sector heatmap from the raw observations,
        // in a single pass. Both are derived state — cheap to reconstruct.
        const mask = new Array(AZ_BINS).fill(null);
        const heat = Array.from({ length: AZ_BINS }, () => new Array(EL_BINS).fill(null));
        for (const p of this._passes) {
            for (const o of p.observations) {
                const azBin = ((((o.az % 360) + 360) % 360) / 5) | 0;
                if (azBin < 0 || azBin >= AZ_BINS) continue;
                if (o.el > 1) {
                    const cur = mask[azBin];
                    if (cur == null || o.el < cur) mask[azBin] = o.el;
                }
                if (o.el >= 0 && o.el <= 90 && o.snr > 0) {
                    const elBin = Math.min(EL_BINS - 1, Math.max(0, (o.el / 5) | 0));
                    const best = heat[azBin][elBin] ?? 0;
                    if (o.snr > best) heat[azBin][elBin] = o.snr;
                }
            }
        }
        this._horizonMask = mask;
        this._sectorHeatmap = heat;
    }

    async _pruneOldPasses() {
        const secs = RetentionWindow.seconds(this._retention);
        if (secs == null) return;
        const cutoff = new Date(Date.now() - secs * 1000);

        // In-memory drop
        const before = this._passes.length;
        this._passes = this._passes.filter(p => passEndTime(p) >= cutoff);
        const dropped = before - this._passes.length;

        // Disk cleanup — iterate by endTime index, delete rows older than cutoff.
        if (this._db) {
            await new Promise((resolve) => {
                const tx = this._db.transaction(STORE_PASSES, 'readwrite');
                const idx = tx.objectStore(STORE_PASSES).index('endTime');
                const range = IDBKeyRange.upperBound(cutoff.getTime(), true);
                const req = idx.openCursor(range);
                req.onsuccess = (e) => {
                    const cur = e.target.result;
                    if (cur) { cur.delete(); cur.continue(); }
                };
                tx.oncomplete = resolve;
                tx.onerror = resolve;  // best effort
            });
        }
        if (dropped) this._emitAll();
    }

    // MARK: - Serialization ---------------------------------------------

    _serialize(pass) {
        // Pre-compute endTime so the IDB index works without materialising
        // the whole row. Stored as epoch-ms (IDB prefers numbers over Date).
        const endMs = passEndTime(pass).getTime();
        return {
            id: pass.id,
            prn: pass.prn,
            constellationId: pass.constellation.id,
            startTime: pass.startTime.getTime(),
            endTime: endMs,
            observations: pass.observations,
        };
    }

    _deserialize(row) {
        const constellation = CONSTELLATIONS[row.constellationId];
        if (!constellation) return null;
        return {
            id: row.id,
            prn: row.prn,
            constellation,
            startTime: new Date(row.startTime),
            observations: row.observations ?? [],
        };
    }

    // MARK: - Emit helpers ----------------------------------------------

    _emitAll() {
        this.dispatchEvent(new CustomEvent('passes',  { detail: { passes: this.allPasses, activePRNs: this.activePRNs } }));
        this.dispatchEvent(new CustomEvent('mask',    { detail: { horizonMask: this._horizonMask } }));
        this.dispatchEvent(new CustomEvent('heatmap', { detail: { sectorHeatmap: this._sectorHeatmap } }));
        this.dispatchEvent(new CustomEvent('stats',   { detail: { stats: this.stats } }));
    }
}

function clamp(v, lo, hi) {
    v = v | 0;
    return v < lo ? lo : (v > hi ? hi : v);
}
