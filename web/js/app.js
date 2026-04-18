// PCC Web — main wiring.
//
// Pulls together Clock (Web Serial), NMEA parsers, polar plot, sky-trail
// store (IndexedDB), 3D globe iframe, and the various UI tabs. Each UI
// affordance is wired directly rather than routed through a state
// manager — keep it readable, factor later if it outgrows this file.
//
// The polar / store / globe triad is modelled on the Mac app:
//   SkyView ↔ polar.js, SkyTrailStore ↔ skytrailstore.js,
//   SkyGlobeView ↔ globe.js + web/globe/index.html (shared HTML).
// See MAC_PARITY.md for the mirror policy.

import { Clock } from './serial.js';
import { parseGGA, parseRMC, GSVBuffer } from './nmea.js';
import { PolarPlot } from './polar.js';
import {
    sunPosition, moonPosition, moonPhase, sunTimes, maidenhead
} from './astronomy.js';
import { SkyTrailStore } from './skytrailstore.js';
import { RetentionWindow } from './satpass.js';
import { Globe3D } from './globe.js';

// --- state ----------------------------------------------------------------

const clock = new Clock();

/// Live GPS snapshot. Kept in one object so the periodic celestial-update
/// timer and the globe ticker have a single source of truth.
const gps = {
    lat: null,
    lon: null,
    altitudeM: null,
    fix: 0,
    satsUsed: 0,
    hdop: null,
    utc: null,
    utcReceivedAt: null,
};

let satellites = [];
let scrollState = null; // { text, wrapLen, pos, timer }
let scrollIntervalSec = 0.40;
let monitorPaused = false;
let satTrackingActive = false;
let activeTab = 'connect';
let timeWindow = 'h1';

/// Persistent pass store. Instantiated up-front so prior history is
/// visible on the polar plot the moment the user opens the Satellites
/// tab, even before they click Record.
const store = new SkyTrailStore();

// --- elements -------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const statusPill = $('statusPill');
const statusText = $('statusText');
const connectBtn = $('connectBtn');
const disconnectBtn = $('disconnectBtn');
const browserWarn = $('browserWarn');

const modeSelect = $('modeSelect');
const textInput = $('textInput');
const textSendBtn = $('textSendBtn');
const textStopBtn = $('textStopBtn');
const scrollSpeedSel = $('scrollSpeed');
const countdownTarget = $('countdownTarget');
const countdownStartBtn = $('countdownStartBtn');
const countdownStopBtn = $('countdownStopBtn');
const brightLock = $('brightLock');
const brightSlider = $('brightSlider');
const brightValue = $('brightValue');
const rawInput = $('rawInput');
const rawSendBtn = $('rawSendBtn');

const satStartBtn = $('satStartBtn');
const satStopBtn = $('satStopBtn');
const satCount = $('satCount');
const polarCanvas = $('polar');

const logToggle = $('logToggle');
const showTrailsInput = $('showTrails');
const showHeatmapInput = $('showHeatmap');
const showHorizonInput = $('showHorizon');
const showLabelsInput = $('showLabels');
const smoothTrailsInput = $('smoothTrails');
const timeWindowSel = $('timeWindow');
const retentionSel = $('retentionSelect');
const clearHistoryBtn = $('clearHistoryBtn');

const statPasses = $('statPasses');
const statToday = $('statToday');
const statObs = $('statObs');
const statPeak = $('statPeak');
const statLongest = $('statLongest');
const statCoverage = $('statCoverage');

const globeFrame = $('globeFrame');
const globeShowSats = $('globeShowSats');
const globeShowCelestials = $('globeShowCelestials');
const globeShowLabels = $('globeShowLabels');
const globeSmooth = $('globeSmooth');
const globeShowClock = $('globeShowClock');
const globeClockFormatBtn = $('globeClockFormatBtn');

const monitorLog = $('monitorLog');
const nmeaToggle = $('nmeaToggle');
const clearLogBtn = $('clearLogBtn');
const pauseLogBtn = $('pauseLogBtn');

// --- browser support check ------------------------------------------------

if (!Clock.isSupported()) {
    browserWarn.hidden = false;
    connectBtn.disabled = true;
    connectBtn.title = 'Web Serial not available in this browser';
}

// --- flag persistence -----------------------------------------------------

const LS_FLAGS = 'pcc_web.flags';
const defaultFlags = {
    showTrails: true, showHeatmap: true, showHorizon: true, showLabels: true,
    smoothTrails: true,
    globeShowSats: true, globeShowCelestials: true, globeShowLabels: true,
    globeSmooth: true, globeShowClock: true,
};
let flags = { ...defaultFlags };
try {
    const stored = JSON.parse(localStorage.getItem(LS_FLAGS) ?? 'null');
    if (stored && typeof stored === 'object') flags = { ...defaultFlags, ...stored };
} catch { /* ignore */ }
function saveFlags() { localStorage.setItem(LS_FLAGS, JSON.stringify(flags)); }

// --- tabs -----------------------------------------------------------------

document.getElementById('sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    activateTab(btn.dataset.tab);
});
// In-page "jump to tab" anchors — used by the reduced-feature-set notice
// to point the reader at About.
document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto]');
    if (!link) return;
    e.preventDefault();
    activateTab(link.dataset.goto);
});

function activateTab(tab) {
    activeTab = tab;
    document.querySelectorAll('nav.sidebar button').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.panel').forEach(p => {
        p.classList.toggle('active', p.id === `panel-${tab}`);
    });
    // The polar canvas lives in a display:none panel until this switch;
    // ResizeObserver *should* fire as it becomes visible, but poke a
    // redraw explicitly so the rings appear on first reveal.
    if (tab === 'satellites') polar._resize();
    if (tab === 'globe') {
        initGlobeIfNeeded();
        startGlobeTicker();
    } else {
        stopGlobeTicker();
    }
}

// --- polar plot wiring ----------------------------------------------------

const polar = new PolarPlot(polarCanvas);

// Apply persisted flags to DOM + polar before first paint.
showTrailsInput.checked   = flags.showTrails;
showHeatmapInput.checked  = flags.showHeatmap;
showHorizonInput.checked  = flags.showHorizon;
showLabelsInput.checked   = flags.showLabels;
smoothTrailsInput.checked = flags.smoothTrails;
polar.setFlags({
    showTrails:   flags.showTrails,
    showHeatmap:  flags.showHeatmap,
    showHorizon:  flags.showHorizon,
    showLabels:   flags.showLabels,
    smoothTrails: flags.smoothTrails,
});

function bindPolarFlag(input, key) {
    input.addEventListener('change', () => {
        flags[key] = input.checked;
        saveFlags();
        polar.setFlags({ [key]: flags[key] });
    });
}
bindPolarFlag(showTrailsInput,   'showTrails');
bindPolarFlag(showHeatmapInput,  'showHeatmap');
bindPolarFlag(showHorizonInput,  'showHorizon');
bindPolarFlag(showLabelsInput,   'showLabels');
bindPolarFlag(smoothTrailsInput, 'smoothTrails');

// --- store wiring ---------------------------------------------------------

logToggle.checked = store.isLogging;
retentionSel.value = store.retention;
timeWindowSel.value = timeWindow;

logToggle.addEventListener('change', () => {
    store.isLogging = logToggle.checked;
});

timeWindowSel.addEventListener('change', () => {
    timeWindow = timeWindowSel.value;
    pushFilteredPassesToRenderers();
});

retentionSel.addEventListener('change', async () => {
    const next = retentionSel.value;
    if (next === store.retention) return;
    const toPrune = store.passesThatWouldBePruned(next);
    if (toPrune.length > 0) {
        const plural = toPrune.length === 1 ? '' : 'es';
        const ok = confirm(
            `Shrinking retention to ${RetentionWindow.label(next)} ` +
            `will delete ${toPrune.length} stored pass${plural} from this browser.\n\n` +
            `Continue?`
        );
        if (!ok) {
            retentionSel.value = store.retention;
            return;
        }
    }
    await store.setRetention(next);
});

clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Delete all recorded passes from this browser? This cannot be undone.')) return;
    await store.clear();
});

// Store → renderers. Passes flow through the time-window filter; mask +
// heatmap go straight through (they're aggregated-over-all-time).
store.addEventListener('passes', () => pushFilteredPassesToRenderers());
store.addEventListener('mask',   (e) => polar.setHorizonMask(e.detail.horizonMask));
store.addEventListener('heatmap',(e) => polar.setSectorHeatmap(e.detail.sectorHeatmap));
store.addEventListener('stats',  (e) => updateStatsDOM(e.detail.stats));

function pushFilteredPassesToRenderers() {
    const filtered = store.filtered(timeWindow);
    polar.setPasses({ passes: filtered, activePRNs: store.activePRNs });
    updateGlobeIfActive();
}

function updateStatsDOM(stats) {
    statPasses.textContent   = String(stats.totalPasses);
    statToday.textContent    = String(stats.passesToday);
    statObs.textContent      = String(stats.observations);
    statPeak.textContent     = stats.peakElevation > 0
        ? `${Math.round(stats.peakElevation)}°` : '—';
    statLongest.textContent  = stats.longestPassSeconds > 0
        ? formatDuration(stats.longestPassSeconds) : '—';
    statCoverage.textContent = `${Math.round(stats.coveragePercent)}%`;
}

function formatDuration(secs) {
    const s = Math.round(secs);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m >= 60) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        return `${h}h ${mm}m`;
    }
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

// --- GSV → polar + store --------------------------------------------------

const gsvBuffer = new GSVBuffer({
    onSatellites: (list) => {
        satellites = list;
        satCount.textContent = `${list.length} satellites in view`;
        polar.setSatellites(list);
        if (store.isLogging) store.update(list);
        updateGlobeIfActive();
    }
});

// --- clock wiring ---------------------------------------------------------

clock.addEventListener('status', (e) => {
    const { connected, message } = e.detail;
    statusPill.classList.toggle('connected', connected);
    statusText.textContent = message;
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;

    if (!connected) {
        // Reset dependent UI
        satTrackingActive = false;
        satStartBtn.disabled = false;
        satStopBtn.disabled = true;
        nmeaToggle.checked = false;
        satellites = [];
        polar.setSatellites([]);
        satCount.textContent = '0 satellites in view';
        stopScroll();
    }
});

clock.addEventListener('error', (e) => {
    appendMonitor(`error: ${e.detail?.message ?? e.detail}\n`, 'err');
});

clock.addEventListener('line', (e) => {
    const line = e.detail;
    appendMonitor(line, 'rx');
    const trimmed = line.trim();
    if (trimmed.includes('GGA,')) handleGGA(trimmed);
    else if (trimmed.includes('RMC,')) handleRMC(trimmed);
    else if (satTrackingActive && trimmed.includes('GSV,')) gsvBuffer.push(trimmed);
});

connectBtn.addEventListener('click', async () => {
    try {
        await clock.connect();
    } catch (err) {
        if (err.name === 'NotFoundError') return; // user cancelled picker
        statusText.textContent = `Error: ${err.message}`;
        appendMonitor(`connect error: ${err.message}\n`, 'err');
    }
});

disconnectBtn.addEventListener('click', () => clock.disconnect());

// --- display tab ----------------------------------------------------------

let activeMode = 'none';
modeSelect.addEventListener('change', () => {
    const mode = modeSelect.value;
    if (mode === activeMode) return;
    // Tear down previous mode first (mirrors SerialManager.activateDisplayMode)
    if (activeMode === 'text') {
        stopScroll();
        clock.send('mode_text = 0');
    } else if (activeMode === 'countdown') {
        clock.send('mode_countdown = 0');
    }
    activeMode = mode;
    if (mode === 'text')      clock.send('mode_text = 1');
    if (mode === 'countdown') clock.send('mode_countdown = 1');
});

textSendBtn.addEventListener('click', () => {
    const value = textInput.value;
    if (!value) return;
    modeSelect.value = 'text';
    modeSelect.dispatchEvent(new Event('change'));
    sendScrollingText(value);
});

textStopBtn.addEventListener('click', () => {
    stopScroll();
    clock.send('mode_text = 0');
    activeMode = 'none';
    modeSelect.value = 'none';
});

scrollSpeedSel.addEventListener('change', () => {
    scrollIntervalSec = parseFloat(scrollSpeedSel.value);
    if (scrollState) restartScrollTimer();
});

/// Same marquee discipline as SerialManager: underscore separator (visible
/// on 7-segment), <=10 chars sends once, longer scrolls one column at a
/// time with a double-buffer wrap.
function sendScrollingText(value) {
    const newScrollText = value + '_';
    if (scrollState && scrollState.text === newScrollText) return;
    stopScroll();
    if (value.length <= 10) {
        clock.send(`text = ${value}`);
        return;
    }
    scrollState = { text: newScrollText, wrapLen: newScrollText.length, pos: 0 };
    sendScrollFrame();
    restartScrollTimer();
}

function stopScroll() {
    if (scrollState && scrollState.timer) clearInterval(scrollState.timer);
    scrollState = null;
}

function restartScrollTimer() {
    if (!scrollState) return;
    if (scrollState.timer) clearInterval(scrollState.timer);
    scrollState.timer = setInterval(() => {
        scrollState.pos = (scrollState.pos + 1) % scrollState.wrapLen;
        sendScrollFrame();
    }, scrollIntervalSec * 1000);
}

function sendScrollFrame() {
    const doubled = scrollState.text + scrollState.text;
    const slice = doubled.slice(scrollState.pos, scrollState.pos + 10);
    clock.send(`text = ${slice}`);
}

countdownStartBtn.addEventListener('click', () => {
    const v = countdownTarget.value;
    if (!v) return;
    const target = new Date(v); // browser reads as local time
    const unix = Math.floor(target.getTime() / 1000);
    clock.send(`countdown_to = ${unix}`);
    clock.send('mode_countdown = 1');
    activeMode = 'countdown';
    modeSelect.value = 'countdown';
});

countdownStopBtn.addEventListener('click', () => {
    clock.send('mode_countdown = 0');
    activeMode = 'none';
    modeSelect.value = 'none';
});

brightLock.addEventListener('change', () => {
    brightSlider.disabled = !brightLock.checked;
    if (brightLock.checked) {
        clock.send(`brightness = ${brightSlider.value}`);
    }
    // The clock reverts to ambient tracking automatically once no further
    // manual `brightness =` writes arrive — no explicit unlock command.
});

brightSlider.addEventListener('input', () => {
    brightValue.textContent = `${Math.round(brightSlider.value * 100)}%`;
    if (brightLock.checked) {
        clock.send(`brightness = ${parseFloat(brightSlider.value).toFixed(3)}`);
    }
});

rawSendBtn.addEventListener('click', () => {
    const cmd = rawInput.value.trim();
    if (!cmd) return;
    clock.send(cmd);
    appendMonitor(`> ${cmd}\n`, 'tx');
    rawInput.value = '';
});
rawInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') rawSendBtn.click();
});

// --- satellites tab -------------------------------------------------------

satStartBtn.addEventListener('click', () => {
    if (!clock.isConnected) {
        alert('Connect to the clock first.');
        return;
    }
    satTrackingActive = true;
    clock.requestNMEA();
    satStartBtn.disabled = true;
    satStopBtn.disabled = false;
});

satStopBtn.addEventListener('click', () => {
    if (satTrackingActive) {
        satTrackingActive = false;
        clock.releaseNMEA();
    }
    satStartBtn.disabled = false;
    satStopBtn.disabled = true;
});

// --- NMEA → UI ------------------------------------------------------------

function handleGGA(line) {
    const r = parseGGA(line);
    if (!r) return;
    gps.fix = r.fix ?? 0;
    if (r.fix === 0) {
        updateGpsPanel();
        return;
    }
    if (r.lat != null) gps.lat = r.lat;
    if (r.lon != null) gps.lon = r.lon;
    if (r.altitudeM != null) gps.altitudeM = r.altitudeM;
    if (r.hdop != null) gps.hdop = r.hdop;
    if (r.satsUsed != null) gps.satsUsed = r.satsUsed;
    updateGpsPanel();
}

function handleRMC(line) {
    const r = parseRMC(line);
    if (!r) return;
    if (r.active === false) return;
    gps.utc = r.utc;
    gps.utcReceivedAt = new Date();
    updateGpsPanel();
}

function updateGpsPanel() {
    $('gpsStatus').textContent = gps.fix > 0 ? (gps.fix === 2 ? 'DGPS fix' : 'GPS fix') : 'No fix';
    $('gpsStatus').classList.toggle('muted', gps.fix === 0);
    $('gpsLat').textContent = gps.lat != null ? formatDeg(gps.lat, 'NS') : '—';
    $('gpsLon').textContent = gps.lon != null ? formatDeg(gps.lon, 'EW') : '—';
    $('gpsAlt').textContent = gps.altitudeM != null ? `${gps.altitudeM.toFixed(1)} m` : '—';
    $('gpsHdop').textContent = gps.hdop != null ? gps.hdop.toFixed(1) : '—';
    $('gpsSats').textContent = gps.satsUsed || '—';
    $('gpsGrid').textContent = (gps.lat != null && gps.lon != null) ? maidenhead(gps.lat, gps.lon) : '—';
    $('gpsUtc').textContent = gps.utc ? gps.utc.toISOString().replace('T', ' ').replace('.000Z', 'Z') : '—';

    // Celestials refresh opportunistically when fix data changes too —
    // the 1s interval below handles the no-fix-yet case.
    updateCelestial();
}

function formatDeg(deg, axis) {
    const hemi = deg >= 0 ? axis[0] : axis[1];
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    return `${d}° ${m.toFixed(3)}′ ${hemi}`;
}

function updateCelestial() {
    if (gps.lat == null || gps.lon == null) return;
    const now = new Date();
    const sun = sunPosition(now, gps.lat, gps.lon);
    const moon = moonPosition(now, gps.lat, gps.lon);
    const phase = moonPhase(now);
    $('sunAltAz').textContent  = `${sun.altitude.toFixed(1)}° / ${sun.azimuth.toFixed(1)}°`;
    $('moonAltAz').textContent = `${moon.altitude.toFixed(1)}° / ${moon.azimuth.toFixed(1)}°`;
    const phaseLabel = describeMoonPhase(phase);
    $('moonPhase').textContent = `${(phase * 100).toFixed(1)}% · ${phaseLabel}`;

    const st = sunTimes(now, gps.lat, gps.lon);
    if (st) {
        $('sunrise').textContent = st.sunrise.toTimeString().slice(0, 5);
        $('sunset').textContent  = st.sunset.toTimeString().slice(0, 5);
    } else {
        $('sunrise').textContent = 'n/a';
        $('sunset').textContent  = 'n/a';
    }
}

function describeMoonPhase(p) {
    // Phase 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
    if (p < 0.03 || p > 0.97) return 'New moon';
    if (p < 0.22) return 'Waxing crescent';
    if (p < 0.28) return 'First quarter';
    if (p < 0.47) return 'Waxing gibbous';
    if (p < 0.53) return 'Full moon';
    if (p < 0.72) return 'Waning gibbous';
    if (p < 0.78) return 'Last quarter';
    return 'Waning crescent';
}

// Refresh celestials once a second even when no NMEA is flowing, as long
// as we've latched a position at some point in this session.
setInterval(() => {
    if (gps.lat != null && gps.lon != null) updateCelestial();
}, 1000);

// --- globe tab ------------------------------------------------------------

/// GlobeClockFormat cycle — mirrors `enum GlobeClockFormat` on the Mac.
/// The globe itself draws the overlay; we just hand it the format name and
/// a visible flag. Cycling order matches the Mac's cmd-click behaviour.
const GLOBE_CLOCK_CYCLE = ['matchClock', 'iso8601Utc', 'iso8601Local', 'utc', 'local'];
let globe = null;
let globeTickTimer = null;
let globeClockFormat = 'matchClock';

globeShowSats.checked       = flags.globeShowSats;
globeShowCelestials.checked = flags.globeShowCelestials;
globeShowLabels.checked     = flags.globeShowLabels;
globeSmooth.checked         = flags.globeSmooth;
globeShowClock.checked      = flags.globeShowClock;

function initGlobeIfNeeded() {
    if (globe) return;
    globe = new Globe3D(globeFrame, {
        onLog: (msg) => appendMonitor(`[globe] ${msg}\n`, 'rx'),
        onClockToggle: () => {
            // The globe HTML treats a tap on the clock overlay as "toggle
            // visible". Mirror that into our persisted flag + DOM checkbox.
            flags.globeShowClock = !flags.globeShowClock;
            globeShowClock.checked = flags.globeShowClock;
            saveFlags();
            globe.setClockFormat(globeClockFormat, flags.globeShowClock);
        },
        onClockCycleFormat: () => cycleGlobeClockFormat(),
    });
    globe.setClockFormat(globeClockFormat, flags.globeShowClock);
}

function cycleGlobeClockFormat() {
    const i = GLOBE_CLOCK_CYCLE.indexOf(globeClockFormat);
    globeClockFormat = GLOBE_CLOCK_CYCLE[(i + 1) % GLOBE_CLOCK_CYCLE.length];
    if (globe) globe.setClockFormat(globeClockFormat, flags.globeShowClock);
}

function startGlobeTicker() {
    if (globeTickTimer) return;
    updateGlobeIfActive();
    // 1 Hz is plenty — sat positions move on the order of a pixel/second
    // at the globe's default scale, and trail/stats updates come through
    // the store's own event emissions.
    globeTickTimer = setInterval(updateGlobeIfActive, 1000);
}

function stopGlobeTicker() {
    if (globeTickTimer) { clearInterval(globeTickTimer); globeTickTimer = null; }
}

function updateGlobeIfActive() {
    if (!globe || activeTab !== 'globe') return;
    const now = new Date();
    const sun  = (gps.lat != null && gps.lon != null) ? sunPosition(now,  gps.lat, gps.lon) : null;
    const moon = (gps.lat != null && gps.lon != null) ? moonPosition(now, gps.lat, gps.lon) : null;
    globe.update({
        satellites,
        sunPosition:  sun,
        moonPosition: moon,
        observerLat:  gps.lat,
        observerLon:  gps.lon,
        passes:       store.filtered(timeWindow),
        activePRNs:   store.activePRNs,
        now,
        showSatellites: flags.globeShowSats,
        showCelestials: flags.globeShowCelestials,
        showLabels:     flags.globeShowLabels,
        smoothTrails:   flags.globeSmooth,
    });
}

function bindGlobeFlag(input, key) {
    input.addEventListener('change', () => {
        flags[key] = input.checked;
        saveFlags();
        updateGlobeIfActive();
    });
}
bindGlobeFlag(globeShowSats,       'globeShowSats');
bindGlobeFlag(globeShowCelestials, 'globeShowCelestials');
bindGlobeFlag(globeShowLabels,     'globeShowLabels');
bindGlobeFlag(globeSmooth,         'globeSmooth');

globeShowClock.addEventListener('change', () => {
    flags.globeShowClock = globeShowClock.checked;
    saveFlags();
    if (globe) globe.setClockFormat(globeClockFormat, flags.globeShowClock);
});
globeClockFormatBtn.addEventListener('click', () => cycleGlobeClockFormat());

// --- monitor tab ----------------------------------------------------------

function appendMonitor(text, cls = 'rx') {
    if (monitorPaused) return;
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    monitorLog.appendChild(span);
    // Cap log size to ~50k chars to avoid unbounded memory growth
    while (monitorLog.childNodes.length > 3000) {
        monitorLog.removeChild(monitorLog.firstChild);
    }
    // Auto-scroll only if the user is already at the bottom
    const nearBottom = monitorLog.scrollTop + monitorLog.clientHeight >= monitorLog.scrollHeight - 20;
    if (nearBottom) monitorLog.scrollTop = monitorLog.scrollHeight;
}

nmeaToggle.addEventListener('change', () => {
    if (!clock.isConnected) {
        nmeaToggle.checked = false;
        return;
    }
    if (nmeaToggle.checked) clock.requestNMEA();
    else clock.releaseNMEA();
});

clearLogBtn.addEventListener('click', () => { monitorLog.textContent = ''; });

pauseLogBtn.addEventListener('click', () => {
    monitorPaused = !monitorPaused;
    pauseLogBtn.textContent = monitorPaused ? 'Resume' : 'Pause';
    pauseLogBtn.dataset.paused = String(monitorPaused);
});

// --- cleanup --------------------------------------------------------------

window.addEventListener('beforeunload', () => {
    if (clock.isConnected) {
        // Best-effort teardown; the page is going away regardless.
        try { clock.disconnect(); } catch { /* ignore */ }
    }
});
