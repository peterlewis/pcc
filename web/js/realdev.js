// realdev.js — bridge a REAL Precision Clock Mk IV (Web Serial) into the same
// session-state object the UI rooms read from the simulator. A physical device
// then drives the identical views (polar sky, globe, signal bars, fix panel,
// NMEA log) with no room-side changes.
//
// The contract is deliberately narrow: we write into `session.S` using the
// EXACT item shapes the sim produces (see sim.js satSnapshot / tick), so every
// consumer — charts.js drawSky/drawGlobe/drawCn0Elev, app-controller bar rows,
// the fix panel — keeps working unmodified. We do NOT touch the clock face here
// (Tier-1 time mirroring is the app-controller's job); we only stash the device
// UTC epoch in `S.deviceTimeMs` for it to pick up.
//
// Chromium only (Web Serial). Gate the connect button on isSupported().

import { Clock } from './serial.js?v=12';
import { parseGGA, parseRMC, parseGSA, GSVBuffer } from './nmea.js?v=2';
import { parsePMTXTS, parsePMTXTC, centrePhase } from './ppsts.js?v=15';
// subSatellitePoint reconstructs a sat's ground point from observer-relative
// az/el (all GSV gives us) — the exact inverse of the sim's forward azel(). The
// import also runs satpass.js's augmentConstellations() IIFE, which sets
// .altitudeKm on the shared nmea CONSTELLATIONS entries we read below.
import { subSatellitePoint } from './satpass.js?v=1';

// nmea.js CONSTELLATIONS keys/prefixes → the sim's per-constellation metadata
// (constId / tok / talker / sysId). The sim tags every sat with these and the
// UI colours + filters by them, so a real sat must carry the same tags.
//   nmea prefix   sim constId / tok / talker / sysId
const CONST_MAP = {
    G: { constId: 'G', tok: 'gps', talker: 'GP', sysId: 1 }, // GPS
    R: { constId: 'R', tok: 'glo', talker: 'GL', sysId: 2 }, // GLONASS
    E: { constId: 'E', tok: 'gal', talker: 'GA', sysId: 3 }, // Galileo
    C: { constId: 'C', tok: 'bds', talker: 'GB', sysId: 4 }, // BeiDou
};

// Parse a Mk IV config.txt (read from the device's mass-storage drive) into the
// fields the emulator mirrors. Firmware grammar (main.c parseConfigString / the
// config.txt loader): `key = value`, `#`/`;` line comments, keys case-insensitive,
// MODE_* take enabled/disabled. This is the ONLY way to learn the device's real
// state — the serial channel is write-only (no read-back). Pure + testable.
export function parseDeviceConfig(text) {
    const cfg = { modes: {} };
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line[0] === '#' || line[0] === ';') continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        const k = key.toLowerCase();
        if (k === 'colon_mode') cfg.colon = val.toLowerCase();
        else if (k === 'brightness') { const b = parseFloat(val); if (Number.isFinite(b)) cfg.brightness = b; }
        else if (k === 'zone_override') cfg.zone = val;
        else if (k === 'matrix_frequency') { const n = parseInt(val, 10); if (Number.isFinite(n)) cfg.matrixHz = n; }
        else if (k === 'astro_page_ms') { const n = parseInt(val, 10); if (Number.isFinite(n)) cfg.astroPageMs = n; }
        else if (/^bs[1-5]$/.test(k)) { const a = val.split(','); const adc = parseInt(a[0], 10), dac = parseInt(a[1], 10); if (Number.isFinite(adc) && Number.isFinite(dac)) (cfg.bs = cfg.bs || {})[k] = { adc, dac }; }
        else if (k.startsWith('mode_')) cfg.modes[key.toUpperCase()] = /^(enabled|on|1|true|yes)$/i.test(val);
    }
    return cfg;
}

export function createRealDevice(session) {
    const S = session.S;
    let clock = null;

    // Persistent GSV reassembler. Its onSatellites fires (debounced ~100ms)
    // with a merged, deduped snapshot across all constellations/signals seen
    // so far; we translate that into sim-shaped S.sats items.
    const gsv = new GSVBuffer({
        onSatellites: (sats) => mergeSats(sats),
    });

    const gtrailLast = new Map(); // sat.key → last wall-clock ms a ground-trail point was appended
    const trailLast = new Map();  // sat.key → last wall-clock ms a polar az/el trail point was appended
    let obsSeeded = false;        // adopt the device's own fix as the observer once per connection
    let obsAtConnect = null;      // pre-connect observer, restored on disconnect
    let lastHistT = 0;            // last whole-second we sampled POSITION/DOP/continuity history
    let lastCn0T = 0;             // last whole-second we sampled per-sat C/N0 history
    let rxSeq = 0;                // monotonic id per rx line — survives the 420 front-trim (see log())

    /// Push one line into S.nmeaLog with the sim's item shape, capped like sim.
    /// Each item carries a MONOTONIC `seq`: the log is front-trimmed at 420, so any
    /// consumer that tracks "new sentences since" by absolute array index silently
    /// breaks once the cap is hit (this froze the emulator clock ~40 s after connect).
    /// `seq` survives the splice, so the drive loop can advance reliably.
    function log(text, err) {
        S.nmeaLog.push({ t: Date.now(), dir: 'rx', text, err: !!err, seq: ++rxSeq });
        if (S.nmeaLog.length > 420) S.nmeaLog.splice(0, S.nmeaLog.length - 420);
    }

    /// Tear down all real-device telemetry so the app can fall to STANDBY (or a
    /// clean simulation) with no lingering real data. Shared by the explicit
    /// disconnect() and the physical-unplug status edge.
    function clearRealBuffers() {
        S.real = false;
        S.connected = false;
        S.fix.valid = false;
        S.fix.type = 0;
        S.sats = [];
        S.gtrails.clear(); S.trails.clear(); gtrailLast.clear(); trailLast.clear();
        if (S.cn0Hist && S.cn0Hist.clear) S.cn0Hist.clear();
        if (Array.isArray(S.posHist)) S.posHist.length = 0;
        if (Array.isArray(S.dopHist)) S.dopHist.length = 0;
        if (Array.isArray(S.fixHist)) S.fixHist.length = 0;
        if (S.pps && Array.isArray(S.pps.list)) S.pps.list.length = 0;   // TIMING KPIs go honest (no stale stream)
        lastHistT = 0; lastCn0T = 0;
        // Restore the observer we adopted from the device fix back to whatever it
        // was before connecting, so the sim resumes from the honest default.
        if (obsAtConnect) { S.obs.lat = obsAtConnect.lat; S.obs.lon = obsAtConnect.lon; S.obsUserSet = !!obsAtConnect.userSet; obsAtConnect = null; }
        S.portLabel = '';
    }

    /// Translate a GSVBuffer snapshot (items: {id, prn, constellation,
    /// elevation, azimuth, snr}) into the EXACT sim S.sats[] item shape and
    /// replace S.sats. We rebuild the whole array each snapshot because the
    /// buffer already merges/dedupes across constellations for us.
    function mergeSats(sats) {
        // A GSV debounce timer scheduled just before an unplug/disconnect can fire
        // after teardown; without this guard it would repopulate S.sats and the
        // trail/cn0 buffers with vanished-device satellites in STANDBY.
        if (!S.connected || !S.real) return;
        const out = [];
        const now = Date.now();
        const tSec = Math.floor(now / 1000);
        const sampleCn0 = tSec !== lastCn0T; // one C/N0-history point per sat per whole second
        for (const sat of sats) {
            const c = sat.constellation;               // nmea CONSTELLATIONS entry (has .altitudeKm)
            if (!c) continue;
            const meta = CONST_MAP[c.prefix];          // → sim constId/tok/talker
            if (!meta) continue;
            const el = Number.isFinite(sat.elevation) ? sat.elevation : -99;
            const az = Number.isFinite(sat.azimuth) ? sat.azimuth : 0;
            const cn0 = Number.isFinite(sat.snr) ? sat.snr : 0;
            const visible = el > 0;
            const key = `${meta.constId}${String(sat.prn).padStart(2, '0')}`;
            // GSV gives only observer-relative az/el, never an orbital sub-point.
            // Reconstruct the ground point (the sim's `geo`) with the exact inverse
            // of the sim's forward azel(), using the constellation's nominal orbit
            // altitude and the current observer (S.obs — the same point the globe
            // draws as OBS, kept honest by the GGA seeding below). Below the horizon
            // subSatellitePoint returns null → keep NaN so the globe skips it (its
            // proj() returns vis:false on NaN) rather than plotting a bogus point.
            const sp = visible
                ? subSatellitePoint({ azDeg: az, elDeg: el, constellation: c, observerLat: S.obs.lat, observerLon: S.obs.lon })
                : null;
            out.push({
                // identity — key is the sim's "G02"-style label the UI shows
                key,
                constId: meta.constId, tok: meta.tok, talker: meta.talker,
                sysId: meta.sysId, prn: sat.prn,
                // live geometry (degrees), matching sim satSnapshot output
                az, el, cn0,
                // reconstructed sub-satellite point (NaN when below horizon)
                geo: sp ? { lat: sp.lat, lon: sp.lon } : { lat: NaN, lon: NaN },
                // "used" isn't in GSV; approximate the sim's rule (in view with
                // usable signal). The authoritative used-count is S.fix.sats.
                used: visible && cn0 >= 30,
                visible,
            });
            // Synthesise a ground track for the globe's trail layer. mergeSats
            // rebuilds S.sats on every GSV frame (~1 Hz), so throttle to one point
            // per sat per 30 s (≈ the sim's 45-tick cadence) and cap at 40 to bound
            // memory and keep the trail a sane length.
            if (sp && (now - (gtrailLast.get(key) || 0) >= 30000)) {
                let gt = S.gtrails.get(key);
                if (!gt) { gt = []; S.gtrails.set(key, gt); }
                gt.push({ lat: sp.lat, lon: sp.lon });
                if (gt.length > 40) gt.shift();
                gtrailLast.set(key, now);
            }
            // Polar az/el trail — mirrors sim.tick's cadence (1 pt / 30 s / sat, cap 180
            // ≈ 90 min). Without this, CONNECTED mode never accumulated sky trails at all:
            // the polar TRAILS layer and the heatmap's history field only worked in sim.
            if (visible && (now - (trailLast.get(key) || 0) >= 30000)) {
                let tr = S.trails.get(key);
                if (!tr) { tr = []; S.trails.set(key, tr); }
                tr.push({ t: tSec, az, el, cn0 });
                if (tr.length > 180) tr.shift();
                trailLast.set(key, now);
            }
            // Per-sat C/N0 history for the "C/N0 over time" chart — mirrors
            // sim.tick's cn0Hist (one point/sec/sat, cap 1800 ≈ 30 min).
            if (sampleCn0 && visible) {
                let ch = S.cn0Hist.get(key);
                if (!ch) { ch = []; S.cn0Hist.set(key, ch); }
                ch.push({ t: tSec, v: cn0 });
                if (ch.length > 1800) ch.shift();
            }
        }
        if (sampleCn0) lastCn0T = tSec;
        S.sats = out;
    }

    // ---- $PMTXTS PPS-timing → S.pps (the sim's exact shape) ----------------
    // The firmware emits one $PMTXTS per PPS edge when `pps = on`. We translate
    // each record into the same S.pps fields the sim produces so the Timing room
    // (phase chart, drift staircase, ppm-vs-temp fit, KPI tiles) comes alive on
    // real hardware with zero room-side changes. Seq gaps → dropped count; a new
    // calerr value → one drift/temp sample (mirrors the sim's per-cal-window push).
    let ppsLastSeq = null;
    let ppsLastCalerr = null;

    function ingestPMTXTS(text) {
        const r = parsePMTXTS(text);
        if (!r) return false;              // not a $PMTXTS line
        if (!r.checksumOK) return true;    // it is one, but corrupt — logged, not applied
        const P = S.pps;
        // History timestamps are in WHOLE SECONDS across the app (sim tick floors
        // ms→s; the charts compare against a seconds `now` and a seconds span).
        const ts = Math.floor(Date.now() / 1000);

        // missed edges: only count small forward jumps (a reboot/reorder just resyncs)
        if (ppsLastSeq !== null) {
            const d = r.seq - ppsLastSeq;
            if (d > 1 && d < 256) P.dropped += d - 1;
        }
        ppsLastSeq = r.seq;

        // phase jitter series (µs), centred about the second boundary like the sim's `us`
        P.list.push({ t: ts, us: centrePhase(r.phaseMs) * 1000 });
        if (P.list.length > 1800) P.list.shift();

        // one drift/temp sample per successful RTC calibration (calerr changes)
        if (ppsLastCalerr === null || r.calerr !== ppsLastCalerr) {
            P.samples.push({ t: ts, temp: r.temp, ppm: r.ppm });
            if (P.samples.length > 200) P.samples.shift();
            ppsLastCalerr = r.calerr;
        }

        P.seq = r.seq;
        P.calerr = r.calerr;
        P.ppm = r.ppm;
        P.sincecal = r.sincecal;
        P.temp = r.temp;
        P.flags = (r.valid ? 0x1 : 0) | (r.hadPps ? 0x2 : 0) | (r.rtcGood ? 0x4 : 0);
        if (r.hadPps) P.lastEdge = ts;
        return true;
    }

    /// Route one raw serial line into session state.
    function ingestLine(line) {
        const text = String(line).trim();
        if (!text) return;
        log(text, false);

        // GGA — position + fix quality → S.fix
        if (/GGA/.test(text) && text.startsWith('$')) {
            const g = parseGGA(text);
            if (g) {
                if (Number.isFinite(g.fix) && g.fix > 0 &&
                    Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
                    S.fix.valid = true;
                    // GGA's quality field (1=GPS, 2=DGPS, 4=RTK…) is not the
                    // GSA 2D/3D flag; any positive quality means we have a
                    // position. Match the sim's convention of type 3 for a
                    // good fix (the fix panel keys its "3D FIX" label off
                    // S.fix.valid, and 3 is the sim's locked-fix value).
                    S.fix.type = 3;
                    S.fix.lat = g.lat;
                    S.fix.lon = g.lon;
                    if (Number.isFinite(g.altitudeM)) S.fix.alt = g.altitudeM;
                    if (Number.isFinite(g.hdop)) S.fix.hdop = g.hdop;
                    S.fix.sats = Number.isFinite(g.satsUsed) ? g.satsUsed : S.fix.sats;
                    // Observer honesty: the sub-point reconstruction and the globe's
                    // OBS marker both key off S.obs, which otherwise stays at the
                    // Cambridge default. Adopt the device's own fix the first time we
                    // get one so the plotted geometry matches the real location —
                    // unless the user has pinned the observer manually (onApplyPos).
                    // Once per connection only, so GPS-noise jitter doesn't keep
                    // clearing the trails. Skip when already within ~10 m.
                    if (!obsSeeded && !S.obsUserSet) {
                        obsSeeded = true;
                        if (Math.abs(g.lat - S.obs.lat) > 1e-4 || Math.abs(g.lon - S.obs.lon) > 1e-4) {
                            S.obs.lat = g.lat; S.obs.lon = g.lon;
                            S.gtrails.clear(); S.trails.clear(); gtrailLast.clear(); trailLast.clear();
                            if (Array.isArray(S.posHist)) S.posHist.length = 0;
                        }
                    }
                } else {
                    // fix === 0 → no position
                    S.fix.valid = false;
                    S.fix.type = 0;
                    S.fix.sats = 0;
                }
                // Sample POSITION-scatter / DOP / continuity history once per whole
                // second (GGA is ~1 Hz; guard against faster emitters), mirroring
                // sim.tick so the POSITION room populates on hardware. ENU east/north
                // are metres of the fix off the observer origin (the inverse of the
                // sim's forward projection) — the scatter then shows GPS wander about
                // S.obs. PDOP/VDOP come from GSA (below); HDOP from GGA.
                const tSec = Math.floor(Date.now() / 1000);
                if (tSec !== lastHistT) {
                    lastHistT = tSec;
                    if (S.fix.valid && Array.isArray(S.posHist)) {
                        const cosLat = Math.cos(S.obs.lat * Math.PI / 180);
                        const e = (S.fix.lon - S.obs.lon) * 111320 * cosLat;
                        const n = (S.fix.lat - S.obs.lat) * 111320;
                        S.posHist.push({ t: tSec, e, n, lat: S.fix.lat, lon: S.fix.lon, alt: S.fix.alt });
                        if (S.posHist.length > 3600) S.posHist.shift();
                    }
                    if (Array.isArray(S.dopHist)) {
                        S.dopHist.push({ t: tSec, h: S.fix.hdop, p: S.fix.pdop, v: S.fix.vdop });
                        if (S.dopHist.length > 3600) S.dopHist.shift();
                    }
                    if (Array.isArray(S.fixHist)) {
                        S.fixHist.push({ t: tSec, type: S.fix.type, sats: S.fix.sats });
                        if (S.fixHist.length > 3600) S.fixHist.shift();
                    }
                }
            }
            return;
        }

        // GSA — DOP + solution PRNs. Fills PDOP/VDOP that GGA lacks (HDOP is in
        // both); the per-second DOP history above reads these back. Emitted by
        // u-blox by default; if the module is configured silent, PDOP/VDOP simply
        // stay null and the DOP chart shows only the HDOP trace from GGA.
        if (/GSA/.test(text) && text.startsWith('$')) {
            const a = parseGSA(text);
            if (a) {
                if (Number.isFinite(a.pdop)) S.fix.pdop = a.pdop;
                if (Number.isFinite(a.vdop)) S.fix.vdop = a.vdop;
                if (Number.isFinite(a.hdop)) S.fix.hdop = a.hdop;
            }
            return;
        }

        // RMC — authoritative UTC date+time. Stash the epoch for the clock-face
        // mirror; do NOT drive the face from here.
        if (/RMC/.test(text) && text.startsWith('$')) {
            const r = parseRMC(text);
            if (r && r.active && r.utc instanceof Date && Number.isFinite(r.utc.getTime())) {
                S.deviceTimeMs = r.utc.getTime();
                S.deviceTimeAtHost = Date.now(); // host clock when this device second landed → for the time mirror
            }
            return;
        }

        // GSV — satellites in view → GSVBuffer (fires mergeSats on frame close)
        if (/GSV/.test(text) && text.startsWith('$')) {
            gsv.push(text);
            return;
        }

        // $PMTXTS — per-PPS timing record → S.pps (drives the Timing room)
        if (text.startsWith('$PMTXTS,')) {
            ingestPMTXTS(text);
            return;
        }

        // $PMTXTC — the firmware's learned tempcomp model (reply to "tc_dump = on") → S.tc.
        // Two checksummed sentences: H (system-clock HSE model) and L (battery-RTC LSE model).
        if (text.startsWith('$PMTXTC,')) {
            const r = parsePMTXTC(text);
            if (r && r.checksumOK) {
                const tc = (S.tc = S.tc || { hse: null, lse: null, state: '', die: null, at: 0 });
                if (r.kind === 'H') tc.hse = { n: r.n, tmin: r.tmin, tmax: r.tmax, b: r.b, c: r.c, valid: r.valid };
                else tc.lse = { n: r.n, a: r.a, b: r.b, c: r.c, valid: r.valid };
                tc.at = Math.floor(Date.now() / 1000);
            }
            return;
        }

        // tc_dump's human header carries the learn-state letter (A applying · F frozen · L learning ·
        // S seeded · - idle) and the observed die range — the only place the firmware reports them.
        if (text.startsWith('# tempcomp:')) {
            const m = text.match(/die (-?\d+)\.\.(-?\d+) C, state (\S)/);
            if (m) {
                const tc = (S.tc = S.tc || { hse: null, lse: null, state: '', die: null, at: 0 });
                tc.die = [+m[1], +m[2]];
                tc.state = m[3];
                tc.at = Math.floor(Date.now() / 1000);
            }
            return;
        }

        // Everything else ($PMTX ACKs, boot banners, plain text): logged only.
    }

    return {
        isSupported() { return Clock.isSupported(); },

        async connect() {
            clock = new Clock();
            clock.addEventListener('line', (e) => this.ingestLine(e.detail));
            clock.addEventListener('status', (e) => {
                const d = e.detail || {};
                S.connected = !!d.connected;
                if (!d.connected) {
                    // Device dropped (physical unplug / reboot). Leave real-device mode AND tear the
                    // accumulated real telemetry down — otherwise the app falls into STANDBY (whose
                    // invariant is "no telemetry") while the SKY/SIGNAL/POSITION/TIMING rooms keep
                    // drawing the vanished device's real trails/history, and a later simulation would
                    // merge that stale real data. The explicit disconnect() path already does this;
                    // an unplug must too.
                    S.real = false; S.rebooting = false;
                    clearRealBuffers();
                }
                if (d.message) log(`[serial] ${d.message}`, d.connected === false);
            });
            clock.addEventListener('error', (e) => {
                const msg = e.detail && e.detail.message ? e.detail.message : String(e.detail);
                log(`[serial error] ${msg}`, true);
            });

            await clock.connect();     // user-gesture required (button handler)
            clock.requestNMEA();       // ref-counted: turn the firehose on
            clock.send('pps = on');    // ask the firmware to stream $PMTXTS per PPS edge
            clock.send('tc_dump = on'); // read back the learned tempcomp model → $PMTXTC → S.tc

            // Enter real-device mode. Clear any stale sim telemetry so the rooms
            // start from the device's honest state and fill in as sentences land.
            S.real = true;
            S.connected = true;
            S.sats = [];
            S.fix.valid = false;
            S.fix.type = 0;
            S.fix.sats = 0;
            // Stale sim ground tracks / trails / chart history must not linger.
            S.gtrails.clear(); S.trails.clear(); gtrailLast.clear(); trailLast.clear();
            if (S.cn0Hist && S.cn0Hist.clear) S.cn0Hist.clear();
            if (Array.isArray(S.posHist)) S.posHist.length = 0;
            if (Array.isArray(S.dopHist)) S.dopHist.length = 0;
            if (Array.isArray(S.fixHist)) S.fixHist.length = 0;
            lastHistT = 0; lastCn0T = 0;
            // Allow one observer seed from the device's first fix; remember the current observer
            // (and whether it was a deliberate user pin) so disconnect() can restore it. Clearing
            // obsUserSet here is essential: without it a manual pin set earlier (e.g. in a prior
            // simulation) would block the real device's own fix from ever seeding the observer.
            obsSeeded = false;
            obsAtConnect = { lat: S.obs.lat, lon: S.obs.lon, userSet: S.obsUserSet };
            S.obsUserSet = false;
            S.realConnectedAt = Date.now(); // to distinguish "still connecting" from "not a clock"
            S.deviceTimeMs = 0;             // no device time until an RMC lands
            S.portLabel = clock.describe(); // honest USB id — no invented cu.usbmodem path

            // Fresh timing state: the sim leaves S.pps populated with convincing
            // fake scalars (31.2 °C, SEQ 4211, a ppm). Clear the history AND those
            // scalars so nothing stale shows before real $PMTXTS lands (the Timing
            // KPIs also dash until S.pps.list fills — see rvTiming).
            S.pps.list = [];
            S.pps.samples = [];
            S.pps.dropped = 0;
            S.pps.flags = 0;
            S.pps.temp = 0; S.pps.ppm = 0; S.pps.seq = 0;
            S.pps.calerr = 0; S.pps.sincecal = 0; S.pps.lastEdge = 0;
            ppsLastSeq = null;
            ppsLastCalerr = null;
            S.tc = null;   // learned model belongs to ONE device — never show a previous clock's
        },

        async disconnect() {
            try { clock && clock.send('pps = off'); } catch { /* ignore */ }
            try { clock && clock.releaseNMEA?.(); } catch { /* ignore */ }
            try { await clock?.disconnect(); } catch { /* ignore */ }
            clock = null;
            clearRealBuffers();
            S.tc = null;   // the model readout leaves with the device
        },

        ingestLine,

        send(cmd) { clock && clock.send(cmd); },

        /// Read the device's config.txt via the File System Access API (the Mk IV
        /// mounts its QSPI flash as a drive; serial can't read config back). Must be
        /// called from a user gesture. Returns { name, cfg, text } or throws/cancels.
        async readConfigFile() {
            if (typeof window === 'undefined' || !window.showOpenFilePicker) {
                throw new Error('File System Access API unavailable (Chromium + https/localhost only)');
            }
            const [fh] = await window.showOpenFilePicker({
                types: [{ description: 'Mk IV config.txt', accept: { 'text/plain': ['.txt', '.TXT'] } }],
                excludeAcceptAllOption: false, multiple: false,
            });
            const file = await fh.getFile();
            const text = await file.text();
            // Return the handle too so the editor can write back to the same file (write-gated).
            return { name: file.name, cfg: parseDeviceConfig(text), text, fh };
        },

        /// Write edited text back to a config.txt file handle (from readConfigFile). Re-checks
        /// readwrite permission (may re-prompt), then truncates + writes. User-gesture + gated.
        async writeConfigFile(fh, text) {
            if (!fh || !fh.createWritable) throw new Error('No writable file handle — read config.txt first');
            const opt = { mode: 'readwrite' };
            let perm = await fh.queryPermission(opt);
            if (perm !== 'granted') perm = await fh.requestPermission(opt);
            if (perm !== 'granted') throw new Error('Write permission denied');
            const w = await fh.createWritable();
            await w.write(text);
            await w.close();
            return true;
        },

        /// Offline self-check: drive ingestLine with fixed, checksum-valid
        /// sentences against a throwaway state and assert the parsed results.
        /// No hardware, no randomness — safe to call on load.
        selfTest() {
            // Fixed literal sentences with correct XOR checksums (nmea.js splits
            // on '*' before parsing, so a valid *HH is accepted, not required —
            // but we include real ones so this doubles as a checksum sanity net).
            //   GGA: 3D fix (qual 1), 52°12.318'N 000°07.308'E, 21.0m, hdop 0.98, 9 sats
            const GGA = '$GNGGA,120000.00,5212.31800,N,00007.30800,E,1,09,0.98,21.0,M,45.3,M,,*7A';
            //   RMC: active, same time, date 03/07/26 → 2026-07-03T12:00:00Z
            const RMC = '$GNRMC,120000.00,A,5212.31800,N,00007.30800,E,0.03,,030726,,,A*5C';
            //   GPGSV: one complete frame, 1 of 1, 3 sats (GPS)
            const GSV = '$GPGSV,1,1,03,02,45,090,44,05,30,180,40,12,60,270,48*47';
            //   GNGSA: 3D, PRNs 02/05/12, PDOP 2.10, HDOP 0.98, VDOP 1.85
            const GSA = '$GNGSA,A,3,02,05,12,,,,,,,,,,2.10,0.98,1.85*00';

            const fake = { S: { nmeaLog: [], fix: {}, sats: [], obs: { lat: 52.2053, lon: 0.1218, alt: 21.0 }, gtrails: new Map(), trails: new Map(), cn0Hist: new Map(), posHist: [], dopHist: [], fixHist: [] } };
            const rd = createRealDevice(fake); // isolated instance → its own GSVBuffer

            const checks = [];
            const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

            rd.ingestLine(GSA); // before GGA so PDOP/VDOP are set when the DOP history samples
            checks.push({ name: 'GSA pdop 2.10 / vdop 1.85', ok: near(fake.S.fix.pdop, 2.10, 0.01) && near(fake.S.fix.vdop, 1.85, 0.01), detail: `pdop=${fake.S.fix.pdop} vdop=${fake.S.fix.vdop}` });

            rd.ingestLine(GGA);
            checks.push({ name: 'GGA fix.valid', ok: fake.S.fix.valid === true, detail: `valid=${fake.S.fix.valid}` });
            checks.push({ name: 'GGA fix.type 3D', ok: fake.S.fix.type === 3, detail: `type=${fake.S.fix.type}` });
            checks.push({ name: 'GGA lat ≈ 52.2053', ok: near(fake.S.fix.lat, 52.2053, 1e-3), detail: `lat=${fake.S.fix.lat}` });
            checks.push({ name: 'GGA lon ≈ 0.1218', ok: near(fake.S.fix.lon, 0.1218, 1e-3), detail: `lon=${fake.S.fix.lon}` });
            checks.push({ name: 'GGA alt ≈ 21.0', ok: near(fake.S.fix.alt, 21.0, 0.05), detail: `alt=${fake.S.fix.alt}` });
            checks.push({ name: 'GGA hdop ≈ 0.98', ok: near(fake.S.fix.hdop, 0.98, 0.01), detail: `hdop=${fake.S.fix.hdop}` });
            checks.push({ name: 'GGA sats = 9', ok: fake.S.fix.sats === 9, detail: `sats=${fake.S.fix.sats}` });

            rd.ingestLine(RMC);
            const expectMs = Date.UTC(2026, 6, 3, 12, 0, 0);
            checks.push({
                name: 'RMC deviceTimeMs plausible',
                ok: Number.isFinite(fake.S.deviceTimeMs) && fake.S.deviceTimeMs === expectMs,
                detail: `deviceTimeMs=${fake.S.deviceTimeMs} expect=${expectMs}`,
            });

            rd.ingestLine(GSV); // GSVBuffer flush is debounced; force it deterministically
            // The onSatellites callback runs on a ~100ms timer — call the flush
            // synchronously so selfTest returns without awaiting a timer.
            if (typeof rd._flushGsvNow === 'function') rd._flushGsvNow();
            else { /* fall through: assert after microtask below is not needed */ }

            const s0 = fake.S.sats[0] || {};
            checks.push({ name: 'GSV sat count = 3', ok: fake.S.sats.length === 3, detail: `count=${fake.S.sats.length}` });
            checks.push({ name: 'GSV sat[0] has az/el/cn0', ok: Number.isFinite(s0.az) && Number.isFinite(s0.el) && Number.isFinite(s0.cn0), detail: `az=${s0.az} el=${s0.el} cn0=${s0.cn0}` });
            checks.push({ name: 'GSV sat[0] constellation GPS', ok: s0.constId === 'G' && s0.tok === 'gps', detail: `constId=${s0.constId} tok=${s0.tok}` });
            checks.push({ name: 'GSV sat[0] key formatted', ok: s0.key === 'G02', detail: `key=${s0.key}` });
            // sub-point reconstruction: az=90/el=45 GPS sat over a Cambridge observer
            // must yield a finite ground point in-range (east of the observer).
            const geoOk = s0.geo && Number.isFinite(s0.geo.lat) && Number.isFinite(s0.geo.lon) &&
                Math.abs(s0.geo.lat) <= 90 && Math.abs(s0.geo.lon) <= 180;
            checks.push({ name: 'GSV sat[0] geo reconstructed (finite, in-range)', ok: geoOk, detail: `geo=${JSON.stringify(s0.geo)}` });

            // chart-history coverage (POSITION room + C/N0-over-time on hardware)
            const ph = fake.S.posHist[0] || {};
            checks.push({ name: 'posHist sampled (finite ENU)', ok: fake.S.posHist.length === 1 && Number.isFinite(ph.e) && Number.isFinite(ph.n), detail: `posHist=${fake.S.posHist.length} e=${ph.e} n=${ph.n}` });
            const dh = fake.S.dopHist[0] || {};
            checks.push({ name: 'dopHist sampled (h/p/v)', ok: fake.S.dopHist.length === 1 && near(dh.h, 0.98, 0.01) && near(dh.p, 2.10, 0.01) && near(dh.v, 1.85, 0.01), detail: `dop=${JSON.stringify(dh)}` });
            checks.push({ name: 'fixHist sampled (3D, 9 sats)', ok: fake.S.fixHist.length === 1 && fake.S.fixHist[0].type === 3 && fake.S.fixHist[0].sats === 9, detail: `fixHist=${JSON.stringify(fake.S.fixHist[0])}` });
            const ch0 = fake.S.cn0Hist.get('G02') || [];
            checks.push({ name: 'cn0Hist sampled for G02', ok: ch0.length === 1 && ch0[0].v === 44, detail: `cn0Hist(G02)=${JSON.stringify(ch0)}` });

            const pass = checks.every((c) => c.ok);
            return { pass, checks };
        },

        // Test hook: force the GSV buffer to flush synchronously (bypass the
        // debounce timer) so selfTest is deterministic without awaiting.
        _flushGsvNow() { try { gsv._flush(); } catch { /* no frame yet */ } },
    };
}
