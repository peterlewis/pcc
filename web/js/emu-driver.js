// emu-driver.js — the WASM firmware emulator as a live driver for the app's clock faces.
// Wraps the real clock4 firmware (WebAssembly) + a virtual GPS + the input shims (location,
// buttons, light sensor, VBUS/power, config.txt) behind one small interface the app can pump
// each frame. This is the emulator BECOMING the display: driver.frame() feeds the same device
// frame the physical clock's segment buffers produce, straight into applyDeviceFrame().
import factory from '../emu/clock-fw.mjs';
import { VirtualGPS } from '../emu/sim-gps.mjs?v=2';
import { createSatTracker } from './sat-tracker.js?v=2';

const SEG = [0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f]; // 0-9 seven-seg
const DASH = 0x40;
const decode = (b) => { const p=b&0x7f; if(p===0)return 'BLANK'; if(p===DASH)return 'DASH';
  const d=SEG.indexOf(p); return d<0?'DASH':d; };

// The firmware COLON_MODE enum index -> the face's colon-animation name. The firmware enum
// (main.h) and the face's COLON_MODES are the SAME order, so this is 1:1 by index.
const COLON_NAME = ['slowfade', 'heartbeat', 'sawtooth', 'alt_sawtooth', 'toggle', 'solid'];

// Modes enabled by default so the face can cycle through the interesting read-outs. Real
// config.txt keys, applied through the firmware's own parser. Import/replace at runtime.
export const DEFAULT_CONFIG = [
  'colon_mode = heartbeat',       // civil colon (matches the shipped device config.txt)
  'MODE_ISO8601_STD = enabled',
  'MODE_UNIX = enabled',
  'MODE_WEEKDAY = enabled',
  'MODE_ISO_WEEK = enabled',
  'MODE_MOON = enabled',
  'MODE_GRID = enabled',
  'MODE_SUN = enabled',
  'MODE_LATLON = enabled',
  'MODE_LST = enabled',
  'MODE_SOLAR = enabled',
].join('\n');

export async function createEmuDriver({ lat = 51.4779, lon = -0.0015, config = DEFAULT_CONFIG } = {}) {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const E = {
    bootCold: w('emu_boot_cold','void',['number']),
    tick: w('emu_tick'), poll: w('emu_poll'), pps: w('emu_pps'),
    pendsv: w('emu_pendsv'), pendsvPending: w('emu_pendsv_pending','number'),
    button1: w('emu_button1'), button2: w('emu_button2'),
    enable: w('emu_enable_mode','void',['number']),
    setPos: w('emu_set_pos','void',['number','number']),
    setAdc: w('emu_set_adc','void',['number']),
    setVbus: w('emu_set_vbus','void',['number']),
    configLine: w('emu_config_line','void',['string']),
    setTzOffset: w('emu_set_tz_offset','void',['number']),
    tzOffset: w('emu_tz_offset','number'),
    loadZone: w('emu_load_zone','number',['string']),               // firmware DST engine (real /TZRULES.BIN)
    zoneFromPos: w('emu_zone_from_pos','string',['number','number']),// ZoneDetect: (lat,lon)->IANA zone (/TZMAP.BIN)
    _registerFile: w('emu_register_file','void',['string','number','number']),
    feedNmea: w('emu_feed_nmea','void',['string']),
    now: w('emu_now','number'), mode: w('emu_mode','number'),
    hadPps: w('emu_had_pps','number'), sincePps: w('emu_since_pps','number'),
    satcount: w('emu_satcount','number'),
    colonMode: w('emu_colon_mode','number'),
    colonStep: w('emu_colon_step','number'),
    daterow: w('emu_daterow','number'),
    bufb: w('emu_bufb','number',['number']),
    bufcLo: w('emu_bufc_low','number',['number']),
    bufcHi: w('emu_bufc_high','number',['number']),
  };

  let state = { lat, lon, configText: config, signal: true, vbus: true, adc: 2600, geo: 'default',
    tol: { t1: 1000, t10: 10000, t100: 100000 },   // precision-ladder thresholds (s since PPS)
    utc: false, tzZone: 'UTC', tzSec: 0, tzAge: 0,   // timezone: local (browser IANA) unless forced UTC
    locZone: null,   // zone resolved from a manually-observed position (ZoneDetect); overrides browser zone
    live: false };   // LIVE = fed by a real device's NMEA (not the virtual GPS)

  // The observer's current UTC offset, DST-aware, from the browser's IANA zone. The real device
  // derives this from /TZRULES.BIN (+ ZoneDetect on the GPS position); the emulator has no FATFS,
  // so we source the same {zone, offset} from Intl and feed it into the firmware's rules[] shim.
  function browserTz(date = new Date()) {
    let zone = 'UTC';
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
    return { zone, offsetSec: -date.getTimezoneOffset() * 60 };   // +east of UTC
  }
  // Copy a file's bytes into the wasm heap and register it with the firmware's FATFS shim. The
  // malloc'd buffer is intentionally never freed — the C shim keeps the pointer.
  function registerFile(name, bytes) {
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    E._registerFile(name, ptr, bytes.length);
  }
  // Fetch the real /TZRULES.BIN (the same MTZ database the device carries) once and register it, so
  // the firmware's OWN loadRules() can parse full IANA DST rules — byte-faithful across transitions,
  // not a single browser offset. Best-effort: on any failure we fall back to the offset shim below.
  // Resolve an emu runtime asset (tzrules.bin / tzmap.bin) relative to the DOCUMENT, not this module.
  // In dev this module lives at web/js/ so '../emu' would work — but the production build inlines this
  // code into docs/index.html, where import.meta.url is the page and '../emu' escapes the site root.
  // document.baseURI is index.html's own URL in BOTH cases, so 'emu/<f>' resolves under the app in dev
  // AND on Pages (…/pcc/emu/<f>). The runtime .mjs/.wasm are bundled (SINGLE_FILE) so only these fetch.
  const emuAsset = (name) => new URL('emu/' + name, document.baseURI);
  let tzBytes = null, tzZoneLoaded = null, tzMapReady = false, tzMapPromise = null;
  async function initTzEngine() {
    try {
      const resp = await fetch(emuAsset('tzrules.bin'));
      if (resp.ok) { tzBytes = new Uint8Array(await resp.arrayBuffer()); registerFile('/TZRULES.BIN', tzBytes); }
    } catch (e) { /* offline / missing -> offset-shim fallback */ }
  }
  // Lazily fetch + register the 12 MB /TZMAP.BIN (ZoneDetect) — only when a manually-observed
  // position needs its own zone, so the common case (observer ≈ browser) never pays the download.
  function ensureTzMap() {
    if (tzMapReady) return Promise.resolve(true);
    if (!tzMapPromise) tzMapPromise = (async () => {
      try {
        const resp = await fetch(emuAsset('tzmap.bin'));
        if (!resp.ok) return false;
        registerFile('/TZMAP.BIN', new Uint8Array(await resp.arrayBuffer()));
        tzMapReady = true; return true;
      } catch (e) { return false; }
    })();
    return tzMapPromise;
  }
  // Resolve the zone at an observed position via the firmware's own ZoneDetect, then adopt it.
  async function resolveZoneFromPos(la, lo) {
    if (!tzBytes || !(await ensureTzMap())) return null;  // needs both /TZRULES.BIN and /TZMAP.BIN
    const zone = E.zoneFromPos(la, lo);                   // e.g. "America/New_York" (also loads its rules)
    if (zone) { state.locZone = zone; tzZoneLoaded = zone; applyTz(); }
    return zone || null;                                  // so the caller can mirror it to a connected clock
  }
  // Set the observer's timezone. Prefers the firmware's real rules[] engine (loadZone -> DST handled
  // automatically by setNextTimestamp each second); forced-UTC and the no-rules case use the single
  // -offset shim. Called on boot / setUtc / setLoc, and cheaply refreshed each minute for the label.
  function applyTz() {
    if (state.utc) { state.tzZone = 'UTC'; state.tzSec = 0; state.tzAge = 0; tzZoneLoaded = null; E.setTzOffset(0); return; }
    const zone = state.locZone || browserTz().zone;   // an observed-position zone wins over the browser's
    if (tzZoneLoaded === zone) { state.tzZone = zone; state.tzSec = E.tzOffset(); state.tzAge = 0; return; }  // loaded; refresh label
    if (tzBytes && E.loadZone(zone) === 0) {                    // firmware DST engine now authoritative
      tzZoneLoaded = zone; state.tzZone = zone; state.tzSec = E.tzOffset(); state.tzAge = 0; return;
    }
    const t = browserTz();                                      // fallback: single browser offset
    tzZoneLoaded = null; state.tzZone = t.zone; state.tzSec = t.offsetSec; state.tzAge = 0; E.setTzOffset(t.offsetSec);
  }
  let gps;
  let bootMs = 1e9;   // ms since (re)boot; huge => already revealed (first paint isn't a "reboot")

  // Real GPS constellation (CelesTrak TLEs), recomputed for the observer every few seconds.
  const tracker = createSatTracker();
  let visSats = [];             // current real sats in view [{prn,az,el,cn0}]
  let satsAge = 0;             // ms since last recompute
  tracker.load().then((ok) => { if (ok) refreshSats(); });   // best-effort; sim fallback offline
  function refreshSats() {
    if (!tracker.loaded) return;
    try { visSats = tracker.visible(state.lat, state.lon, new Date(), 5); satsAge = 0; } catch (e) {}
  }

  const drain = () => { if (E.pendsvPending()) E.pendsv(); };
  const configLines = (txt) => txt.split('\n').map(s=>s.trim())
    .filter(s => s && !s.startsWith('#') && !/^reboot\b/i.test(s));

  // Cold power-on: apply the config through the REAL parser, seed position + power, start the GPS.
  function boot() {
    E.bootCold(Math.floor(Date.now()/1000));
    for (const line of configLines(state.configText)) E.configLine(line);
    E.setPos(state.lat, state.lon);
    E.setAdc(state.adc);
    E.setVbus(state.vbus ? 1 : 0);
    applyTz();   // seed the observer's local offset (else the firmware, filesystem-less, shows UTC)
    // enabling modes via config makes the firmware jump to the last-enabled one; start on the
    // standard ISO clock if it's enabled (falls through harmlessly if it isn't).
    let guard = 0; while (E.mode() !== 0 && guard++ < 40) { E.button1(); drain(); }
    E.poll();
    // satProvider feeds the REAL constellation (if loaded) into $GxGSV; else the GPS falls back
    // to its plausible synthetic count.
    gps = new VirtualGPS(E, { lat: state.lat, lon: state.lon, acquireSec: 6,
      satProvider: () => (tracker.loaded && visSats.length ? visSats : null) });
    gps.setSignal(state.signal);
    bootMs = 0;   // blank -> fade-in reveal, like the real board coming up on power/reboot
  }
  await initTzEngine();   // register /TZRULES.BIN before the first boot()->applyTz (best-effort)
  boot();

  function setLoc(la, lo, src) {
    state.lat = la; state.lon = lo; state.geo = src || state.geo;
    if (gps) { gps.lat = la; gps.lon = lo; }
    E.setPos(la, lo); refreshSats();
    // A manually-observed location may be in a different zone than the browser — resolve it from the
    // position via ZoneDetect (lazy 12 MB map). Auto-geolocation ('device') ≈ the browser zone, so
    // skip the download there. Returns a promise → the resolved zone, so a caller can mirror it to a
    // connected clock.
    if (src === 'manual') return resolveZoneFromPos(la, lo);
    return Promise.resolve(null);
  }

  // Ask the browser for the real location on first use; fall back silently to the default.
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc(p.coords.latitude, p.coords.longitude, 'device'),
      () => { state.geo = 'denied'; }, { timeout: 8000, maximumAge: 600000 });
  }

  // Decode the firmware's latched segment buffers into a device frame for the faces.
  function frame() {
    const big = [E.bufb(0)>>2, E.bufb(1)>>2, E.bufb(2)>>2, E.bufb(3)>>2, E.bufb(4)>>2, E.bufcLo(0)].map(decode);
    const small = [E.bufcLo(1), E.bufcLo(2), E.bufcLo(3)].map(decode);
    const dp = (E.bufcHi(0) & 0x10) !== 0;
    const p = E.daterow(); let dateRow = '';
    for (let i=1;i<=10;i++){ const c=M.HEAPU8[p+i]; if(c===0x0a||c===0) break; dateRow += (c>=32&&c<127)?String.fromCharCode(c):' '; }
    // colonStep = the firmware's REAL colon-DMA phase, so the face animates the colon in lock
    // with the PPS-disciplined second instead of free-running on wall-clock ms.
    return { dateRow: dateRow.replace(/\s+$/,''), time: { mode:'cells', big, small, dp, colonsOn:true, colonStep: E.colonStep() } };
  }

  return {
    // pump one frame's worth of real time into the firmware (dt clamped so a backgrounded tab
    // can't desync the 1 kHz tick clock from the virtual-GPS clock).
    tick(dtMs) {
      if (!(dtMs > 0)) return;
      if (dtMs > 250) dtMs = 250;
      let steps = Math.round(dtMs);
      while (steps-- > 0) { E.tick(); drain(); }
      if (!state.live) gps.advance(dtMs/1000, new Date());   // in LIVE mode the app feeds real NMEA/PPS
      E.poll();
      satsAge += dtMs;
      if (satsAge > 5000) refreshSats();     // sats move slowly; recompute every ~5 s
      state.tzAge += dtMs;
      if (state.tzAge > 60000) applyTz();     // re-check the offset each minute (catches a DST flip)
      bootMs += dtMs;
    },
    // --- LIVE (real hardware) — feed the connected Mk IV's own NMEA/PPS into the SAME firmware
    // renderer, so it reconstructs exactly what the physical clock shows, with its REAL fix. This
    // is the elegant half of "one renderer": swap the virtual GPS for the real serial stream. ---
    setLive(on) { state.live = !!on; if (on) applyTz(); },   // stop the virtual GPS; keep the observer's zone
    feedLine(nmea) { if (nmea) { E.feedNmea(nmea); drain(); } },   // one raw $Gx sentence from the device
    pulsePps() { E.pps(); drain(); },                              // one PPS edge (from $PMTXTS or the RMC second)
    frame,
    // Boot reveal 0..1: the display comes up BLANK (all LEDs at the off/ghost floor) for a beat,
    // then fades in quickly — the real board's power-on/reboot feel. Multiplies face brightness.
    reveal() {
      const BLANK = 130, FADE = 320;
      if (bootMs < BLANK) return 0;
      const p = Math.min(1, (bootMs - BLANK) / FADE);
      return p * p * (3 - 2 * p);   // smoothstep
    },
    // --- inputs / shims ---
    button1() { E.button1(); drain(); },
    button2() { E.button2(); drain(); },
    setBrightness(v01) { state.adc = Math.max(0, Math.min(4095, Math.round(v01*4095))); E.setAdc(state.adc); },
    setLocation(la, lo, src = 'manual') { return setLoc(la, lo, src); },   // returns a promise → resolved zone (manual)
    // real sats currently reported (with az/el/cn0) — for the app to plot the true constellation
    sats() { return gps ? gps.shownSats : []; },
    satsLoaded() { return tracker.loaded; },
    setSignal(on) { state.signal = !!on; gps.setSignal(state.signal); },
    setVbus(on) { state.vbus = !!on; E.setVbus(state.vbus ? 1 : 0); E.poll(); },
    // --- timezone: local (browser IANA, DST-aware) vs forced UTC. Faithful — drives the
    // firmware's rules[] offset so its own setNextTimestamp does the conversion. ---
    setUtc(on) { state.utc = !!on; applyTz(); },
    tz() {
      const sec = E.tzOffset() | 0;   // what the firmware is actually applying, right now
      const sign = sec < 0 ? '-' : '+', a = Math.abs(sec);
      const label = sec === 0 ? 'UTC'
        : 'UTC' + sign + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor((a % 3600) / 60)).padStart(2, '0');
      return { zone: state.tzZone, offsetSec: sec, label, utc: state.utc };
    },
    // --- HONEST DIGITS: the precision ladder made legible -------------------------------------
    // The firmware blanks sub-second digits as GPS holdover degrades. Surface WHY: which level,
    // what it shows, and the ±uncertainty (tied to the ladder — 1 ms at the P3->P2 edge).
    precision() {
      const hadPps = !!E.hadPps();
      const since = hadPps ? (E.sincePps() >>> 0) : null;
      const { t1, t10, t100 } = state.tol;
      let level, digitsTo;
      if (!hadPps) { level = 'P0'; digitsTo = 'whole seconds'; }
      else if (since < t1) { level = 'P3'; digitsTo = 'milliseconds'; }
      else if (since < t10) { level = 'P2'; digitsTo = 'centiseconds'; }
      else if (since < t100) { level = 'P1'; digitsTo = 'deciseconds'; }
      else { level = 'P0'; digitsTo = 'whole seconds'; }
      const uUs = hadPps ? Math.round(1000 * since / t1) : null;  // µs; = 1 ms at the P3->P2 boundary
      return { level, since, hadPps, uUs, digitsTo, t1, t100, signal: state.signal };
    },
    // Compress the ladder thresholds so holdover degradation is watchable in seconds (a labelled
    // time-lapse — the same firmware path, just faster to reveal the honesty). Off restores real.
    setTimelapse(on) {
      state.tol = on ? { t1: 6, t10: 12, t100: 18 } : { t1: 1000, t10: 10000, t100: 100000 };
      E.configLine('Tolerance_time_1ms = ' + state.tol.t1);
      E.configLine('Tolerance_time_10ms = ' + state.tol.t10);
      E.configLine('Tolerance_time_100ms = ' + state.tol.t100);
    },
    timelapseOn() { return state.tol.t1 < 100; },
    // --- config: twiddle / export / import (all via the real firmware parser) ---
    applyConfig(txt) { state.configText = txt; boot(); },      // reboot with new config.txt
    configLine(line) { for (const l of configLines(line)) E.configLine(l); },  // live single line
    getConfig() { return state.configText; },
    reboot() { boot(); },
    // --- colon animation name for the face (honesty: LST/SOLAR read as 'not civil') ---
    colonName() { return COLON_NAME[E.colonMode()] || 'heartbeat'; },
    // --- state read-out for the UI ---
    state() {
      return {
        locked: !!E.hadPps(), sats: E.satcount(), mode: E.mode(),
        now: E.now()>>>0, lat: state.lat, lon: state.lon,
        signal: state.signal, vbus: state.vbus, geo: state.geo,
        sincePps: E.hadPps() ? (E.sincePps()>>>0) : null,
        gpsState: gps.state, satsReal: tracker.loaded,
      };
    },
  };
}
