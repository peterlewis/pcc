// app-controller.js — the PCC Web application body, ported VERBATIM from the
// Claude-Design prototype (PCC Web.dc.html), reparented onto the vanilla DcLite
// runtime. All state, the fold sequence, the 14 renderVals builders, and the 1 Hz
// tick are unchanged; only 'extends DCLogic' -> 'extends DcLite' and the boot differ.
import { DcLite } from './dc-lite.js?v=90';
import * as ASTRO from './astro-fw.js?v=90';
import * as DS from './datasources.js?v=90';
import { TelemetryLog } from './telemetrylog.js?v=3';
import { prepReview, drawReview, sampleAt, tAtX } from './review.js?v=1';
import { DEFAULT_CONFIG, configToState, stateToConfig } from './default-config.js?v=3';

// config.txt is the single source of truth: the clock-behaviour defaults (enabled modes, colon,
// astro dwell, …) are DERIVED from the canonical golden config, not hand-written here. See
// default-config.js. UI-only state (theme, panels, sim, gamma, marquee) stays app-owned below.
const CONFIG_DEFAULTS = configToState(DEFAULT_CONFIG);

class Component extends DcLite {
  state = {
    phase: 'boot', entryVisible: true, docked: false, drawerOpen: false, hdrClockOpen: true,
    section: 'display', theme: 'dark', scenario: 'locked',
    mode: 'time',
    // Clock-behaviour defaults (dateFormat, weekdayFmt, timeRow, modesEnabled, astroFmt, colon,
    // astroDwell) are SEEDED from config.txt — the single source of truth — not hand-written here.
    ...CONFIG_DEFAULTS,
    currentMode: 'iso8601',
    precision: 3, brightness: 0.85, brightLock: false, gamma: 1.0,
    utc: false, standby: false, diag: 'off',
    text: 'HELLO', marqueeSpeed: 'std', countdownTo: 0,
    // 5-point ambient-light DAC curve (ADC→DAC, 0..4095). Default = Rev D (VTT9812FH), the
    // firmware/macOS default. Edited by dragging in the Brightness tab; committed via BS1..BS5.
    dacCurve: [{ adc: 0, dac: 0 }, { adc: 131, dac: 365 }, { adc: 1076, dac: 1422 }, { adc: 2774, dac: 2665 }, { adc: 3849, dac: 4095 }],
    // config.txt editor. Write-gate defaults OFF (matches macOS AppSettings.configWriteEnabled),
    // persisted to localStorage. The textarea is uncontrolled (ref) so editing never fights re-renders.
    cfgName: '', cfgDirty: false, cfgWrite: (typeof localStorage !== 'undefined' && localStorage.getItem('pccweb.cfgWrite') === '1'),
    // REST data sources (persisted to localStorage). dsMode = the add-form's extract mode.
    dataSources: (() => { try { return JSON.parse(localStorage.getItem('pccweb.dataSources') || '[]'); } catch (e) { return []; } })(),
    dsMode: 'json',
    // Accessory tier (FACE room): TEXT/COUNTDOWN/DATA SOURCES/WEATHER fold to summary rows; open
    // state persists per session. The instrument panels above always lead full-width.
    accessoryOpen: (() => { try { return JSON.parse(localStorage.getItem('pccweb.accOpen') || '{}'); } catch (e) { return {}; } })(),
    // The honest-digits panel's GPS-drop / time-lapse are a SIMULATION-ONLY demo ("drill"); folded away
    // behind a chip by default so the panel leads with the readout, not a party trick. Session-only.
    drillOpen: false,
    tzOverride: 'auto', matrixFreq: '1.6',
    skyHeatmap: false, skyHorizon: false, skyTrails: true, skyLabels: true,
    window: 900,
    // TRAIL length (s): how much ribbon each sat drags in the sky/map/globe views. With 12 h of
    // restored history a full 90 min per sat reads as clutter, so default mid (45 min); 5400 = MAX
    // (the fade horizon / the full trail buffer — pre-control behaviour, bit-for-bit).
    skyTrailAge: 2700,
    sigMedian: true, sigFilter: 'all',
    posWindow: 1800,
    globeTerm: true, globeTrails: true, globeLabels: false, globeGrat: true, globeRotate: true, globeClock: true,
    wxOffline: false, wxInterval: 'off',
    monPaused: false, monAutoscroll: true,
    hdrBar: false, rebootArm: false,
    hdrPop: false,   // header connection/status popover (H2 — collapses the dense readout columns)
    // The three-state model (see [[pcc-web-three-state-model]]). One renderer (clock4 firmware),
    // one data source at a time. STANDBY (default) = the user's system time, no fix, no telemetry —
    // an honest empty baseline that puts "connect your clock" front and centre. SIMULATION (opt-in)
    // = firmware + VIRTUAL GPS, drenched in SIMULATION markers. CONNECTED = a real Mk IV over serial.
    sim: false,   // is the (clearly-labelled) simulation running? default OFF — never greet an owner with fake data
    hwCalibrate: false,   // hardware-furniture calibration overlay (drag buttons/screws/sensor)
    tick: 0,
  };

  componentDidMount() {
    this.els = this.els || {};
    this.faces = {};
    // Telemetry log — persists the CONNECTED real stream to IndexedDB for later scrub/rewind.
    // Opt-in (default off); never records simulation. record() guards on its own _db, so no await.
    try { this.telemetryLog = new TelemetryLog(); } catch (e) { this.telemetryLog = null; }
    this.hwConfig = this.loadHwConfig();   // editable board-furniture positions (calibration overlay)
    this.MM = { W: 264, H: 34.56, PIN: 6 }; // rendered board (mm): 12mm nubbin + 240mm digits + 12mm nubbin, symmetric; pins ±6mm about the seam
    this.globeRot = { lon: -0.0015, lat: 51.4779 };   // Royal Observatory Greenwich — matches the emulator's default observer
    const savedTheme = localStorage.getItem('pccweb.theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = savedTheme;
    const savedSec = localStorage.getItem('pccweb.section');
    this.setState({
      theme: savedTheme,
      section: savedSec && this.SECTIONS.includes(savedSec) ? savedSec : 'display',
      hdrBar: localStorage.getItem('pccweb.hdrbar') === '1',
    });
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Build provenance for the FIRMWARE & DATA panel — written by build.mjs (deploy AND local
    // builds). Absent (fresh clone, dev server, no build yet) → the panel says so honestly.
    fetch('build-info.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j && j.fwSha) { this.buildInfo = j; this.setState({}); }
    }).catch(() => {});
    Promise.all([import('./clockface.js?v=91'), import('./clockface-svg.js?v=108'), import('./sim.js?v=95'), import('./charts.js?v=93'), import('./realdev.js?v=96'), import('./emu-driver.js?v=30'), import('./ppsts.js?v=14')]).then(([CF, CFSVG, SIM, CH, RD, ED, PT]) => {
      this.CF = CF; this.CFSVG = CFSVG; this.SIM = SIM; this.CH = CH; this.RD = RD; this.ED = ED; this.PT = PT;
      this.session = SIM.createSession({ preroll: 1560 });
      this.realdev = RD.createRealDevice(this.session); // real Mk IV over Web Serial -> same session.S
      // The WASM firmware emulator drives the display faces (the emulator IS the clock). Async
      // (loads wasm); the render loop guards on this.emu until it's ready. It boots from the
      // GOLDEN config.txt — the same single source the UI state is seeded from — so the clock
      // enables exactly the modes the config says and nothing else (emu-driver's own list is
      // only the standalone demo page's fallback).
      ED.createEmuDriver({ config: DEFAULT_CONFIG }).then((d) => {
        this.emu = d; this._emuLast = performance.now();
        // Config-declared dash-ladder thresholds → the driver's precision model (usually the
        // same as its defaults; matters when the golden config is edited).
        const cd = CONFIG_DEFAULTS;
        if (d.setTolerances && (cd.tol1 !== 1000 || cd.tol10 !== 10000 || cd.tol100 !== 100000)) d.setTolerances(cd.tol1, cd.tol10, cd.tol100);
        // populate any already-mounted emulator controls now that the driver exists
        if (this.els.emuCfg && !this.els.emuCfg.value) this.els.emuCfg.value = d.getConfig();
        const est = d.state();
        if (this.els.emuLat && !this.els.emuLat.value) this.els.emuLat.value = est.lat.toFixed(4);
        if (this.els.emuLon && !this.els.emuLon.value) this.els.emuLon.value = est.lon.toFixed(4);
      }).catch((e) => console.error('[pcc] emu init failed:', e));
      CH.loadLand().then((l) => { this.land = l; this.landTried = true; if (this.state.section === 'globe') this.drawChart('globe'); });
      this.ready = true;
      this.onTickStats();
      for (const k of Object.keys(this.els)) this.initEl(k, this.els[k]);
      this.layoutEntry();
      if (this.props.entry === 'skip' || this.reduced) this.jumpToApp();
      else this.setState({ phase: 'entry' });
      this.startLoops();
    });
    this.onResize = () => this.handleResize();
    window.addEventListener('resize', this.onResize);
    this.onKey = (e) => {
      const t0 = e.target, tag0 = t0 && t0.tagName;
      const typing = tag0 === 'INPUT' || tag0 === 'TEXTAREA' || tag0 === 'SELECT' || (t0 && t0.isContentEditable);
      if ((e.key === 'Enter' || e.key === ' ') && this.state.phase === 'entry') { e.preventDefault(); this.beginFold(); return; }
      // 1..9,0 jump to nav item 1..10 (0 -> item 10 / Export), in the app only and
      // never while typing in a field.
      if (this.state.phase === 'app' && !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        const t = e.target, tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        const secs = this.SECTIONS;
        if (idx >= 0 && idx < secs.length) { e.preventDefault(); this.go(secs[idx]); }
      }
    };
    window.addEventListener('keydown', this.onKey);
    // If the tab is hidden mid-fold, rAF/WAAPI stall — don't strand the user; jump to the app.
    this.onVis = () => { if (document.visibilityState === 'hidden' && (this.state.phase === 'folding' || this.state.phase === 'docking')) this.jumpToApp(); };
    document.addEventListener('visibilitychange', this.onVis);
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('visibilitychange', this.onVis);
    clearTimeout(this.rebootTimer);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this._dispRAF);
    clearInterval(this.hz);
    Object.values(this.faces).forEach((f) => f && f.destroy && f.destroy());
  }

  // 'weather' retired from the routable sections while the feature is rebuilt (COMING SOON pill on
  // the FACE-room accessory keeps the promise visible); a stale saved section falls back to display.
  // 'datalink' hidden for now — early days on the feature; flip DATALINK_SHOW to bring the room back
  // (modules, tests and room wiring all stay intact).
  get DATALINK_SHOW() { return false; }
  get SECTIONS() {
    const s = ['connect', 'devmodes', 'devbright', 'devconfig', 'devadvanced', 'devupdates', 'display', 'satellites', 'signal', 'position', 'timing', 'globe', 'map', 'monitor', 'export'];
    if (this.DATALINK_SHOW) s.push('datalink');
    return s;
  }

  // ---------- refs ----------
  ref(name) {
    this._refs = this._refs || {};
    if (!this._refs[name]) {
      this._refs[name] = (el) => {
        this.els = this.els || {};
        if (el) { this.els[name] = el; if (this.ready) this.initEl(name, el); }
        else { delete this.els[name]; this.dropEl(name); }
      };
    }
    return this._refs[name];
  }

  initEl(name, el) {
    const faceDefs = {
      entryDate: { rows: ['date'] }, entryTime: { rows: ['time'] },
      hdrDate: { rows: ['date'] }, hdrTime: { rows: ['time'] },
      dispDate: { rows: ['date'] }, dispTime: { rows: ['time'] },
    };
    if (faceDefs[name]) {
      if (this.faces[name]) this.faces[name].destroy();
      // Every board renders with the crisp SVG face: it draws into a holder that fills the
      // same box the canvas would (sizeFaceCanvas makes canvases fill their holder), and the
      // underlying <canvas> ref is hidden. Because the holder is inset:0 in the board half,
      // the SVG rides the fold animation (which transforms the halves) for free. The app's
      // render loop drives it via render(now) exactly like the canvas faces.
      const useSvg = !!this.CFSVG;
      let f;
      if (useSvg) {
        el.style.display = 'none';
        const prev = el.parentElement.querySelector('.cf-svg');
        if (prev) prev.remove();
        const holder = document.createElement('div');
        holder.className = 'cf-svg';
        holder.style.cssText = 'position:absolute;inset:0';
        el.parentElement.appendChild(holder);
        const faceOpts = Object.assign({}, faceDefs[name], { tokens: this.faceTokens() });
        // Every board carries the real furniture — switch-cover buttons, edge screws, light sensor —
        // identically in ALL views (open display, folded entry, AND the menu-bar miniature), so the
        // clock always reads as the same physical object. Interaction (button taps, calibration drag)
        // is wired only on the full-size boards; the tiny header clock shows the furniture but is inert.
        if (name === 'dispDate' || name === 'dispTime' || name === 'entryDate' || name === 'entryTime' ||
            name === 'hdrDate' || name === 'hdrTime') {
          faceOpts.hardware = true;
          faceOpts.hwSpec = this.hwConfig;
          if (name !== 'hdrDate' && name !== 'hdrTime') {
            faceOpts.onButton = (btn) => this.onFaceButton(btn);
            faceOpts.hwCalibrate = !!this.state.hwCalibrate;
            faceOpts.onHwMove = (id, mm) => this.onHwMove(id, mm);
          }
        }
        f = this.CFSVG.createClockFaceSVG(holder, faceOpts);
      } else {
        f = this.CF.createClockFace(el, Object.assign({}, faceDefs[name], { tokens: this.faceTokens() }));
      }
      this.faces[name] = f;
      if (name === 'hdrDate' || name === 'dispDate') f.setInverted(true);
      if (name === 'entryDate') f.setInverted(this.state.phase === 'app');
      this.applyFaceState(f);
      if (name === 'hdrDate' || name === 'hdrTime') this.sizeHdrBar(); // faithful miniature — board aspect + hinge
      if (name === 'dispDate' || name === 'dispTime') this.sizeDispBar();
      f.render(Date.now());
      return;
    }
    if (name === 'reviewCanvas') {
      let dragging = false;
      el.addEventListener('pointerdown', (e) => { dragging = true; try { el.setPointerCapture(e.pointerId); } catch (x) {} this._reviewPointer(e); });
      el.addEventListener('pointermove', (e) => { if (dragging) this._reviewPointer(e); });
      const up = () => { dragging = false; };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      if (this._review) this.renderReview();
      return;
    }
    if (name === 'hwJson') { el.value = JSON.stringify(this.hwConfig, null, 2); return; }
    if (name === 'emuCfg') { if (this.emu && !el.value) el.value = this.emu.getConfig(); return; }
    if (name === 'emuCfgFile') {
      el.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const txt = String(reader.result);
          if (this.els.emuCfg) this.els.emuCfg.value = txt;
          if (this.emu) this.emu.applyConfig(txt);   // align the emulator to the imported config
        };
        reader.readAsText(file);
        e.target.value = ''; // allow re-importing the same filename
      });
      return;
    }
    if (name === 'globe') { this.bindGlobe(el); this.drawChart('globe'); return; }
    if (name === 'dacCurve') { this.bindDacCurve(el); this.drawChart('dacCurve'); return; }
    if (name === 'monLog') { this.scrollLog(true); return; }
    if (['sky', 'cn0elev', 'cn0time', 'posScatter', 'dop', 'cont', 'phase', 'stair', 'ppmtemp', 'gammaCurve', 'map'].includes(name)) this.drawChart(name);
  }

  dropEl(name) {
    if (this.faces && this.faces[name]) { this.faces[name].destroy(); delete this.faces[name]; }
  }

  // ---------- tokens ----------
  hexC(c) { c = c.replace('#', ''); if (c.length === 3) c = c.split('').map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); }
  mix(a, b, t) { const pa = this.hexC(a), pb = this.hexC(b); return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
  rgba(c, a) { const p = this.hexC(c); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }

  faceTokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const led = v('--face-led', '#ff3b2e'), inset = v('--inset', '#040506'), dim = v('--face-dim', '#5a1c16');
    const glow = Math.max(0, Math.min(1, this.props.glowIntensity != null ? this.props.glowIntensity : 0.55));
    const ghost = Math.max(0, Math.min(1, this.props.ghostIntensity != null ? this.props.ghostIntensity : 1));
    return { led, inset, ledDim: this.mix(inset, dim, ghost), ledGlow: this.rgba(led, glow) };
  }

  tok() {
    if (!this._tokCache || this._tokTheme !== this.state.theme) {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      this._tokCache = {
        inset: g('--inset'), bg: g('--bg'), panel: g('--panel'), strip: g('--strip'),
        line: g('--line'), line2: g('--line2'), lineSoft: g('--line-soft'), txt: g('--txt'), txt2: g('--txt2'), txt3: g('--txt3'), txtHi: g('--txt-hi'),
        led: g('--led'), lock: g('--lock'), acq: g('--acq'), none: g('--none'),
        gps: g('--gps'), glo: g('--glo'), gal: g('--gal'), bds: g('--bds'),
      };
      this._tokTheme = this.state.theme;
    }
    return this._tokCache;
  }

  // ---------- face state ----------
  tzName() {
    try { return new Date().toLocaleTimeString('en-GB', { timeZoneName: 'short' }).split(' ').pop().slice(0, 10); }
    catch (e) { return 'UTC'; }
  }
  marqueeWindow() {
    const t = (this.state.text || '').toUpperCase();
    if (t.length <= 10) return t;
    const pad = t + '   ';
    const off = (this.marqOff || 0) % pad.length;
    return (pad + pad).slice(off, off + 10);
  }
  marqueeTick() {
    const s = this.state;
    if (s.mode !== 'text' || s.standby || s.diag !== 'off' || (s.text || '').length <= 10) return;
    const now = Date.now();
    const sp = { slow: 520, std: 300, fast: 150 }[s.marqueeSpeed] || 300;
    if (this._mq && now - this._mq < sp) return;
    this._mq = now;
    this.marqOff = (this.marqOff || 0) + 1;
    const win = this.marqueeWindow();
    this.allFaces((f) => f.setModeCtx({ text: win }));
    // Emu-driven faces render from the firmware, not setModeCtx — so re-write the firmware's text
    // buffer each tick to scroll the window on the emulator.
    if (this.emu && this.emu.configLine) this.emu.configLine('text = ' + win);
    // Scroll the PHYSICAL clock too. The Mk IV firmware shows text statically (no built-in scroll),
    // so we drive the scroll app-side by pushing each window straight over serial. Sent unlogged
    // (raw realdev.send, not devSend) — it's a high-frequency stream and would flood the monitor.
    const S = this.session && this.session.S;
    if (S && S.real && this.realdev) this.realdev.send('text = ' + win);
  }
  // Absolute ms → the "YYYY-MM-DDTHH:mm" local wall-clock string a datetime-local input wants
  // (and reads back the same way). One place so the input, the TARGET label and onSetCd agree.
  msToLocalInput(ms) { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  // A preset both sets the target AND writes it into the datetime-local field — otherwise the
  // input stays blank and the preset looks like it did nothing (it had set the target silently).
  setCdTarget(ms) {
    if (this.els.cdInput) this.els.cdInput.value = this.msToLocalInput(ms);
    this.set2({ countdownTo: ms, mode: 'countdown', standby: false, diag: 'off' });
  }
  effectiveMode() {
    const s = this.state;
    // Standby is handled as a graceful opacity fade (setStandby), NOT a mode swap — the
    // digits keep computing under the fade so waking shows the current time. So we do NOT
    // return a 'standby' mode here; the face keeps its normal mode and just dims.
    if (s.diag === 'test') return { m: 'displaytest', ctx: {} };
    if (s.diag === 'vbat') return { m: 'vbat', ctx: { vbat: this.vbat || 4.032 } };
    if (s.diag === 'satview') return { m: 'satview', ctx: { gps: String(this.session ? this.session.S.fix.sats : '-') } };
    if (s.mode === 'text') return { m: 'text', ctx: { text: this.marqueeWindow() } };
    if (s.mode === 'countdown') return { m: 'countdown', ctx: { countdownTo: s.countdownTo || Date.now() + 7 * 864e5 } };
    // Astro date-row modes: date row = astro readout, time row = running clock (SATVIEW-style).
    if (s.astroFmt !== 'off') return { m: s.astroFmt, ctx: this.astroCtx() };
    if (s.timeRow === 'offset') return { m: 'offset', ctx: {} };
    if (s.timeRow === 'tz') return { m: 'text', ctx: { text: this.tzName() } };
    if (s.weekdayFmt !== 'off') return { m: s.weekdayFmt, ctx: {} };
    return { m: s.dateFormat, ctx: {} };
  }
  // Build the astro date-row context from the observer fix + browser clock, using the
  // firmware-faithful astro-fw math (see astro-fw.js). Whole-degree az/el and local
  // minutes-of-day mirror the firmware's astro_cache exactly. Recomputed once/sec.
  astroCtx() {
    const s = this.state, S = this.session && this.session.S;
    const lat = S ? S.obs.lat : NaN, lon = S ? S.obs.lon : NaN;
    const havePos = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const nowMs = Date.now(), unix = nowMs / 1000;
    const offH = s.utc ? 0 : -new Date().getTimezoneOffset() / 60; // local − UTC, in hours
    const ctx = { tick: nowMs, dwell: Math.max(250, s.astroDwell || 5500), havePos, grid: '----' };
    if (havePos) {
      const st = ASTRO.sunTimes(lat, lon, unix);
      ctx.sunUpToday = !st.polar;
      ctx.riseMin = ASTRO.toLocalMinutes(st.sunrise, offH);
      ctx.setMin = ASTRO.toLocalMinutes(st.sunset, offH);
      ctx.noonMin = ASTRO.toLocalMinutes(st.solarNoon, offH);
      const ae = ASTRO.sunAzEl(lat, lon, unix);
      ctx.az = ((Math.round(ae.az) % 360) + 360) % 360;
      ctx.el = Math.round(ae.el);
      ctx.grid = ASTRO.maidenhead(lat, lon);
      ctx.lat = lat; ctx.lon = lon;
    }
    const ph = ASTRO.moonPhase(unix); // moon needs no fix (UTC-only), like firmware
    ctx.moonIdx = ASTRO.moonPhaseIndex(ph);
    ctx.moonPct = Math.round(ASTRO.moonIlluminatedFraction(ph) * 100);
    return ctx;
  }
  noFixFreeze() {
    const S = this.session && this.session.S;
    return !!(S && S.connected && S.scenario !== 'locked');
  }
  applyFaceState(f) {
    // Faces owned by the emulator get their content from device frames (driveEmu), not the JS
    // mode pipeline — setMode here would null the deviceFrame and flash host time for a frame.
    // (Standby for these faces is asserted per-frame in paintEmuFrame so it survives re-renders.)
    if (this.isEmuDrivenFace(f)) return;
    const em = this.effectiveMode();
    f.setMode(em.m, em.ctx);
    f.setColonMode(this.noFixFreeze() ? 'solid' : this.state.colon);
    f.setBrightness(Math.pow(this.state.brightness, this.state.gamma));
    f.setPrecision(this.state.precision);
    f.setUTC(this.state.utc);
    if (f.setStandby) f.setStandby(this.state.standby); // graceful LED fade, not a hard blank
  }
  allFaces(fn) { for (const k of Object.keys(this.faces || {})) { const f = this.faces[k]; if (!f) continue; try { fn(f); } catch (e) {} } }
  syncFaces() { this.allFaces((f) => this.applyFaceState(f)); }

  // EVERY clock face is a DEVICE-FRAME face owned by the WASM firmware emulator (the emulator IS
  // the clock — landing, header mini, and the display board). applyFaceState/setMode is skipped
  // for these (it would null the deviceFrame and flash host time); driveEmu re-asserts the frame,
  // colon and brightness every rAF frame.
  EMU_FACES = ['entryTime', 'entryDate', 'hdrDate', 'hdrTime', 'dispDate', 'dispTime'];
  isEmuDrivenFace(f) { return this.EMU_FACES.some((k) => this.faces[k] === f); }   // these 6 faces are always frame-driven (standby/sim/connected), never setMode

  // Honest caption for the standalone (no hardware) case — it's the real firmware in WASM driven
  // by a virtual GPS, NOT host time. Reflects the live acquisition/lock state.
  emuObserverTag() {
    if (!this.emu) return '';
    const s = this.emu.state();
    const src = s.geo === 'device' ? 'DEVICE GPS' : s.geo === 'manual' ? 'MANUAL'
      : s.geo === 'denied' ? 'DEFAULT · LOCATION DENIED' : 'DEFAULT';
    const sats = s.satsReal ? (this.emu.sats().length + ' REAL SATS IN VIEW') : 'SIM SATS';
    return s.lat.toFixed(3) + ', ' + s.lon.toFixed(3) + ' · ' + src + ' · ' + sats;
  }
  // Timezone tell — honest about which time the clock is showing. The real device auto-detects
  // the zone from the GPS fix; the emulator sources the same offset from the browser's IANA zone.
  emuTzTag() {
    if (!this.emu || !this.emu.tz) return '';
    const t = this.emu.tz();
    return t.utc ? 'UTC · FORCED' : (t.zone + ' · ' + t.label);
  }

  // SIGNIFICANT DIGITS: turn the firmware's precision ladder into a legible, self-teaching panel —
  // each sub-second digit is shown only while it stays significant under the holdover uncertainty.
  precUi() {
    const off = { level: '—', style: '', unc: '—', digits: '—', hold: '—', pct: 0, colon: '', gps: 'GPS SIGNAL: ON', tl: 'TIME-LAPSE: OFF', fade: 'SIGNIFICANCE FADE: OFF' };
    // Standby has no GPS discipline — say so plainly instead of showing a precision ladder that
    // isn't backed by any fix. CONNECTED and SIMULATION both drive the firmware (real NMEA / virtual
    // GPS) so both fall through to the live precision ladder below — a connected clock shows its REAL
    // holdover precision, not this placeholder.
    if (this.appMode() === 'standby') {
      return { ...off, level: '1 s', style: 'display:inline-flex;align-items:center;justify-content:center;min-width:58px;height:36px;font-family:var(--mono);font-size:15px;font-weight:700;color:var(--txt3);border:1.5px solid var(--line2);border-radius:7px',
        unc: 'no fix', digits: 'whole seconds', hold: 'SYSTEM TIME', colon: 'no PPS — start a simulation or connect a clock' };
    }
    if (!this.emu || !this.emu.precision) return off;
    const p = this.emu.precision();
    const COL = { P3: '#3fd06a', P2: '#caa63a', P1: '#e08b3a', P0: '#e0503a' };
    const col = COL[p.level] || '#888';
    // "P3..P0" is the firmware's INTERNAL handler naming (SysTick_CountUp_P3 …), not real metrology —
    // surface the honest quantity instead: the RESOLUTION of the finest digit still displayed.
    const RES = { P3: '1 ms', P2: '10 ms', P1: '0.1 s', P0: '1 s' };
    const unc = p.uUs == null ? 'unknown' : (p.uUs < 1000 ? (p.uUs < 1 ? '<1' : p.uUs) + ' µs' : (p.uUs / 1000).toFixed(p.uUs < 10000 ? 2 : 1) + ' ms');
    const hold = !p.hadPps ? 'NO FIX' : (p.since <= 0 ? 'PPS fresh' : 'holdover ' + p.since + ' s');
    // Meter: how far significance has decayed. On the dash ladder that's holdover age vs the 100 ms
    // threshold; with the significance-fade on it's driven by which digits remain (the ladder age is
    // meaningless once significance_fade overrides it), so map the fade level straight to the meter.
    const pct = p.fade ? ({ P3: 8, P2: 38, P1: 68, P0: 100 }[p.level] ?? 100)
      : (!p.hadPps ? 100 : Math.min(100, Math.round(100 * p.since / p.t100)));
    const cn = this.emu.colonName();
    const colon = cn === 'heartbeat' ? 'colon HEARTBEAT — PPS-disciplined (locked)'
      : cn === 'alt_sawtooth' ? 'colon ALT — sidereal/solar, not civil'
      : cn === 'solid' ? 'colon SOLID — free-running / holdover' : 'colon ' + cn.toUpperCase();
    return {
      level: RES[p.level] || p.level,
      style: 'display:inline-flex;align-items:center;justify-content:center;min-width:58px;height:36px;font-family:var(--mono);font-size:15px;font-weight:700;letter-spacing:.04em;color:' + col + ';border:1.5px solid ' + col + ';border-radius:7px;transition:color .25s,border-color .25s;white-space:nowrap;padding:0 8px',
      unc, digits: p.digitsTo, hold, pct, colon,
      gps: p.signal ? 'GPS SIGNAL: ON' : 'GPS SIGNAL: OFF',
      tl: this.emu.timelapseOn && this.emu.timelapseOn() ? 'TIME-LAPSE: ON' : 'TIME-LAPSE: OFF',
      fade: this.emu.holdoverFadeOn && this.emu.holdoverFadeOn() ? 'SIGNIFICANCE FADE: ON' : 'SIGNIFICANCE FADE: OFF',
    };
  }

  emuSourceTag() {
    const mode = this.appMode();
    if (mode === 'connected') return 'LIVE · YOUR MK IV';
    if (mode === 'standby') return 'SYSTEM TIME · NO CLOCK CONNECTED';
    // simulation — always say so, never let it read as a real clock
    if (!this.emu) return 'SIMULATION · MK IV FIRMWARE (WASM) — BOOTING';
    const s = this.emu.state();
    const gps = !s.signal ? 'GPS SIGNAL OFF · HOLDOVER'
      : s.locked ? ('VIRTUAL GPS LOCKED · ' + s.sats + ' SATS')
      : ('VIRTUAL GPS ACQUIRING · ' + s.sats + ' SATS');
    return 'SIMULATION · ' + gps;
  }

  // Which of the three states are we in (see [[pcc-web-three-state-model]]). Exactly one data
  // source drives the renderer: a real clock (connected), the virtual GPS (simulation), or nothing
  // but the host clock (standby). A real device always wins — the firm rule: sim and real never mix.
  appMode() {
    const S = this.session && this.session.S;
    if (S && S.real) return 'connected';
    return this.state.sim ? 'simulation' : 'standby';
  }
  // ---------- sky-history persistence ----------
  // The SKY accumulations (az/el trails, ground tracks, C/N0 + pos/DOP/fix histories) build up over
  // hours and used to die on every reload. Persist them, honouring the three-state model: REAL and
  // SIM histories live in separate buckets and only ever restore into their own kind — sim data can
  // never dress up as a real sky. A deliberate SIMULATION STOP clears its bucket (ending the fiction
  // ends its history); a reload or an accidental unplug of a real clock gets its sky back.
  skyHistKey(kind) { return 'pccweb.skyHist.' + kind; }
  saveSkyHistory() {
    const S = this.session && this.session.S;
    if (!S || !S.connected) return;
    const kind = S.real ? 'real' : 'sim';
    const m2a = (m) => [...m.entries()];
    const payload = {
      v: 1, savedAt: Date.now(), obs: S.obs ? { lat: S.obs.lat, lon: S.obs.lon } : null,
      trails: m2a(S.trails), gtrails: m2a(S.gtrails),
      cn0: [...S.cn0Hist.entries()].map(([k, h]) => [k, h.slice(-600)]),   // trim: quota headroom
      posHist: S.posHist, dopHist: S.dopHist, fixHist: S.fixHist,
    };
    try { localStorage.setItem(this.skyHistKey(kind), JSON.stringify(payload)); }
    catch (e) {
      // quota: retry without the bulkier histories — the sky trails are the part people miss
      try { payload.cn0 = []; payload.posHist = []; payload.dopHist = []; payload.fixHist = [];
        localStorage.setItem(this.skyHistKey(kind), JSON.stringify(payload)); } catch (e2) {}
    }
  }
  restoreSkyHistory(kind) {
    const S = this.session && this.session.S;
    if (!S) return;
    let p = null;
    try { p = JSON.parse(localStorage.getItem(this.skyHistKey(kind)) || 'null'); } catch (e) {}
    if (!p || p.v !== 1) return;
    if (Date.now() - p.savedAt > 12 * 3600e3) return;   // half a sidereal lap — older sky is stale
    // Adopt the saved observer BEFORE restoring, so the connect-time obs-seed (realdev.js: first
    // GGA clears the trails when the fix moved >1e-4 deg from S.obs) sees the location the history
    // was actually collected at. Same place -> the seed is a no-op and the restored sky survives;
    // genuinely moved -> the seed still (correctly) clears the now-stale trails. Without this the
    // restore was wiped ~1 s after connect for every user not sitting at the default meridian.
    if (kind === 'real' && p.obs && Number.isFinite(p.obs.lat) && Number.isFinite(p.obs.lon) && S.obs && !S.obsUserSet) {
      S.obs.lat = p.obs.lat; S.obs.lon = p.obs.lon;
    }
    const into = (arr, m) => { for (const [k, v] of arr || []) if (!m.has(k)) m.set(k, v); };
    into(p.trails, S.trails); into(p.gtrails, S.gtrails); into(p.cn0, S.cn0Hist);
    if (!S.posHist.length && p.posHist) S.posHist.push(...p.posHist);
    if (!S.dopHist.length && p.dopHist) S.dopHist.push(...p.dopHist);
    if (!S.fixHist.length && p.fixHist) S.fixHist.push(...p.fixHist);
    if (this.session.log) this.session.log('rx', 'sky history restored (' + kind + ', saved ' + Math.round((Date.now() - p.savedAt) / 60000) + ' min ago)');
  }

  // STANDBY face: the user's own system time, no GPS fix. Big row = HH:MM:SS (24h), the three
  // sub-second digits DASHED (honest "no fix" — exactly what a real Mk IV shows before it locks),
  // decimal point off, colon steady (no PPS heartbeat to sync to). Same firmware-shaped frame the
  // emulator emits, so it flows through applyDeviceFrame unchanged — no fabricated precision.
  paintStandby() { this.paintFaceAt(new Date()); }
  // Start / stop SIMULATION — one switch drives both data sources of the simulated world: the
  // emulator's virtual GPS (the clock face) and the sim telemetry session (sats / charts). Never
  // available while a real device is connected (sim and real never mix).
  setSim(on) {
    on = !!on;
    if (this.session && this.session.S && this.session.S.real) return;   // real device owns the app
    this.setState({ sim: on });
    this._emuLast = performance.now();       // resume the emulator cleanly (no dt spike from the pause)
    if (on) {
      if (this.emu && this.emu.reboot) this.emu.reboot();                 // fresh cold-boot reveal
      if (this.session && !this.session.S.connected) { this.session.connect(); this.session.log && this.session.log('tx', 'SIMULATION START'); }
      this.restoreSkyHistory('sim');   // reload continuity — sim history only ever restores into sim
      // Ask the browser for a location ONLY here — when the user opts into a simulation. Standby
      // never prompts; a real clock brings its own GPS fix. Skip if already located (device/manual).
      if (this.emu && this.emu.state && this.emu.state().geo === 'default') this.geolocate(true);
    } else {
      if (this.session && this.session.S.connected && !this.session.S.real) { this.session.disconnect(); this.session.log && this.session.log('tx', 'SIMULATION STOP'); }
      try { localStorage.removeItem(this.skyHistKey('sim')); } catch (e) {}   // deliberate stop ends the fiction AND its history
      this.setState({ scenario: 'locked' });
    }
    this.syncFaces();
  }

  // --- Observer location cascade: DEFAULT (Greenwich) → BROWSER (on simulation start) → the
  // connected clock's own GPS fix. One setter keeps the emulator state, the panel inputs and the
  // observer tag in agreement, so the shown lat/lon always reflects the best-known source. ------
  applyEmuLoc(la, lo, src) {
    if (!this.emu || !isFinite(la) || !isFinite(lo)) return Promise.resolve(null);
    const z = this.emu.setLocation(la, lo, src);   // manual → a promise resolving to the zone
    this.syncEmuLocInputs();
    this.setState({});                             // refresh the observer tag + precision panel now
    return Promise.resolve(z);
  }
  // Ask the browser for the location. Fires only on a user action or when a simulation starts —
  // never automatically at boot. Silent on refusal (flags DEFAULT · LOCATION DENIED honestly).
  geolocate(auto) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => this.applyEmuLoc(p.coords.latitude, p.coords.longitude, 'device'),
      () => { if (this.emu && this.emu.denyGeo) { this.emu.denyGeo(); this.setState({}); } },
      { timeout: 8000, maximumAge: auto ? 600000 : 60000 });
  }
  // Mirror the emulator's current lat/lon into the panel inputs unless the user is editing them —
  // so the displayed numbers follow the cascade (default/browser/actual) live.
  syncEmuLocInputs() {
    const s = this.emu && this.emu.state && this.emu.state(); if (!s) return;
    const put = (el, v) => { if (el && document.activeElement !== el && el.value !== v) el.value = v; };
    put(this.els.emuLat, s.lat.toFixed(4));
    put(this.els.emuLon, s.lon.toFixed(4));
  }

  driveEmu() {
    if (this._reviewing) {   // REVIEW: the face shows the historical wall-clock time at the playhead
      this.paintFaceAt(new Date(((this._review && this._review.playT) || 0) * 1000));
      return;
    }
    const mode = this.appMode();
    if (mode === 'standby' || !this.emu) {   // STANDBY: honest host time, no GPS, no virtual anything
      if (this._emuLive && this.emu) { this.emu.setLive(false); this._emuLive = false; }
      this.paintStandby();
      return;
    }
    if (mode === 'connected') {
      // CONNECTED — feed the real Mk IV's own NMEA into the firmware renderer so it reconstructs
      // the physical clock's display WITH its real fix. Switch the renderer off the virtual GPS.
      const log = this.session.S.nmeaLog || [];
      if (!this._emuLive) {
        this.emu.setLive(true);
        if (this.emu.reboot) this.emu.reboot();               // cold-boot, then let the real stream lock it
        this._emuLive = true;
        // Track fed sentences by OBJECT IDENTITY, not array index. S.nmeaLog is front-trimmed at 420
        // (realdev), so an absolute cursor silently stops matching once the cap is hit — that froze the
        // clock ~40 s after connect, looping the last second. A WeakSet feeds each sentence exactly
        // once, survives the splice (GC-safe), and needs no per-item seq field (version-skew proof).
        this._fedNmea = new WeakSet();
        for (const it of log) if (it && typeof it === 'object') this._fedNmea.add(it);   // skip the backlog; feed from now on
        this._lastPpsSec = null;
        this._emuFixLat = null; this._emuFixLon = null;   // re-adopt the clock's own fix as the observer
      }
      for (let i = 0; i < log.length; i++) {
        const it = log[i];
        if (!it || typeof it !== 'object' || this._fedNmea.has(it)) continue;
        this._fedNmea.add(it);
        if (it.dir !== 'rx' || it.err || typeof it.text !== 'string' || it.text[0] !== '$') continue;
        this.emu.feedLine(it.text);
        // Pulse PPS at MOST once per GPS second. The Mk IV emits SEVERAL RMC talkers per second
        // (GPRMC + GNRMC …); pulsing on each resets the firmware's sub-second before it can climb past
        // the .900 boundary that STAGES the next display — so the whole second freezes while the ms
        // loop keeps running, even though currentTime still tracks from RMC (why it looked like it
        // worked). Key the pulse on the fix's SECOND so multi-talker bursts collapse to one pulse.
        let ppsSec = null, m = it.text.match(/RMC,\d{4}(\d{2})/);
        if (m) ppsSec = m[1];
        else if (/PMTXTS/.test(it.text)) { m = it.text.match(/PMTXTS,\d+,(\d+)/); if (m) ppsSec = String(+m[1] % 60).padStart(2, '0'); }
        if (ppsSec !== null && ppsSec !== this._lastPpsSec) { this._lastPpsSec = ppsSec; this.emu.pulsePps(); }
      }
      // The observer follows the clock: mirror its own GPS fix into BOTH the emulator location
      // (drives the face + panel) AND the session observer S.obs (drives astronomy — sat trails,
      // globe, sidereal/solar), so the whole app uses the ACTUAL position, not the browser/default.
      // Only on a real move, and only if the user hasn't deliberately pinned the observer.
      const S = this.session.S;
      if (S.fix && S.fix.valid && isFinite(S.fix.lat) && isFinite(S.fix.lon) && !S.obsUserSet &&
          this.emu.state().geo !== 'manual' &&   // a deliberate manual pin still wins
          (this._emuFixLat == null || Math.abs(S.fix.lat - this._emuFixLat) > 1e-4 || Math.abs(S.fix.lon - this._emuFixLon) > 1e-4)) {
        this._emuFixLat = S.fix.lat; this._emuFixLon = S.fix.lon;
        this.emu.setLocation(S.fix.lat, S.fix.lon, 'device');
        S.obs.lat = S.fix.lat; S.obs.lon = S.fix.lon;   // astronomy reference frame tracks the fix
        this.syncEmuLocInputs();
      }
    } else if (this._emuLive) {                 // leaving CONNECTED for SIMULATION: back to the virtual GPS
      this.emu.setLive(false); this._emuLive = false;
    }
    const t = performance.now();
    this.emu.tick(t - (this._emuLast || t));
    this._emuLast = t;
    this.paintEmuFrame();
  }

  // Read the firmware's latched segment buffers and push them onto the six emulator-driven faces.
  paintEmuFrame() {
    const frame = this.emu.frame();
    const colon = this.emu.colonName();
    // boot reveal: multiply brightness by the driver's 0..1 fade so a reboot goes blank then fades in.
    const bright = Math.pow(this.state.brightness, this.state.gamma) * (this.emu.reveal ? this.emu.reveal() : 1);
    for (const k of this.EMU_FACES) {
      const f = this.faces[k];
      if (!f) continue;
      // Track colon/brightness PER FACE: dc-lite may recreate a face (new object) whose colon
      // defaults to heartbeat, so a global "changed?" gate would leave it flashing.
      if (f._emuColon !== colon) { f.setColonMode(colon); f._emuColon = colon; }
      if (f._emuBright !== bright) { f.setBrightness(bright); f._emuBright = bright; }
      // Standby is a graceful crisp-group opacity fade; re-assert per face so a dc-lite-recreated
      // face (opacity reset to 1) blanks again — same reason colon/brightness are tracked per face.
      if (f._emuStandby !== this.state.standby) { if (f.setStandby) f.setStandby(this.state.standby); f._emuStandby = this.state.standby; }
      f.applyDeviceFrame(frame);
    }
  }

  set2(patch) {
    // Picking a date format / weekday is mutually exclusive with an astro date-row mode —
    // clear astro so the chosen format actually shows (astro wins in effectiveMode otherwise).
    if (('dateFormat' in patch || 'weekdayFmt' in patch) && !('astroFmt' in patch)) patch = { ...patch, astroFmt: 'off' };
    this.setState(patch, () => this.syncFaces());
    // The WASM emulator RENDERS the on-screen face, so mode/text/countdown/colon/standby changes must
    // reach ITS firmware parser too — not only a connected clock. Mirror the SAME config lines the
    // device gets (devCmdsFor) into emu.configLine. Exclude zone_override: the emu-driver's own tz
    // engine (setUtc / loadZone / zoneFromPos) owns timezone and pushing it here would fight it.
    if (this.emu && this.emu.configLine) {
      // Skip zone_override (emu-driver's tz engine owns it) and MODE_STANDBY (emu standby is the
      // face opacity fade above, so the firmware stays in its live mode and waking is instant).
      for (const cmd of this.devCmdsFor(patch)) if (!/^(zone_override|MODE_STANDBY)\b/.test(cmd)) this.emu.configLine(cmd);
    }
    this.devApply(patch);
  }

  // ---------- device fidelity: mirror a control onto the connected Mk IV ----------
  // The on-screen face already reflects a control change locally (set2 → setState).
  // When a REAL device is attached we ALSO translate the change into the firmware's
  // `key = value` config protocol and send it over serial, so the physical clock
  // tracks the UI. This is command-authoritative: the firmware never reports its
  // state or its physical button presses (verified over serial), so we mirror by
  // reproducing what we commanded, not by reading the device back.
  devSend(cmd) {
    const S = this.session && this.session.S;
    if (S && S.real && this.realdev) {
      this.realdev.send(cmd);
      if (this.session.log) this.session.log('tx', cmd);
    } else if (this.session) {
      this.session.send(cmd); // simulator: logs + fakes an ACK
    }
  }

  // Only real hardware is commanded; the sim's face is already updated by set2.
  devApply(patch) {
    const S = this.session && this.session.S;
    if (!(S && S.real && this.realdev)) return;
    for (const cmd of this.devCmdsFor(patch)) this.devSend(cmd);
  }

  // STAGE E — hardware sync. Mirror the emulator's config.txt onto a connected Mk IV.
  // Each `key = value` line goes over serial through the SAME write-only protocol the
  // twiddles use (devSend). This is command-authoritative and RUNTIME-ONLY: the firmware
  // applies the setting live but never rewrites its config.txt (verified over serial —
  // the file is the boot-time store, changed only by editing the USB drive). So Apply
  // makes the physical clock *look* like the emulator immediately; to persist across a
  // power-cycle, EXPORT the config.txt and drop it on the clock's drive.
  // Returns the number of settings pushed (0 if no clock is attached).
  mirrorConfigToDevice(txt) {
    const S = this.session && this.session.S;
    if (!(S && S.real && this.realdev)) return 0;
    const lines = String(txt || '').split('\n').map((s) => s.trim())
      // Drop zone_override from the raw mirror — a stale/foreign one would disagree with the app's
      // own timezone. We re-append a fresh one below, recomputed from current app/emulator state.
      .filter((s) => s && !s.startsWith('#') && !/^reboot\b/i.test(s) && !/^zone_override\b/i.test(s));
    let n = 0;
    for (const line of lines) { this.devSend(line); n++; }
    const tz = this.emu && this.emu.tz ? this.emu.tz() : null;
    const zone = tz && tz.utc ? 'Etc/UTC' : (tz && tz.zone) || null;
    if (zone) { this.devSend('zone_override = ' + zone); n++; }
    // Enabling modes over serial jumps the device through them, landing on the LAST enabled one.
    // Re-assert the config's OWN last-enabled mode (NOT a hardcoded ISO) so the physical face lands
    // on the mode the config actually selects — matching the emulator, instead of overriding it.
    const modeLines = lines.filter((l) => /^MODE_[A-Z0-9_]+\s*=\s*(enabled|on|1|yes|true)\b/i.test(l));
    if (modeLines.length) this.devSend(modeLines[modeLines.length - 1].split('=')[0].trim() + ' = enabled');
    return n;
  }

  // Map an emulator state patch to the firmware config commands that reproduce it.
  // Sending `MODE_X = enabled` both enables that mode AND jumps to it (requestMode).
  devCmdsFor(patch) {
    const c = [];
    const DATE = { iso8601: 'MODE_ISO8601_STD', ordinal: 'MODE_ISO_ORDINAL', isoweek: 'MODE_ISO_WEEK', unix: 'MODE_UNIX', julian: 'MODE_JULIAN_DATE', mjd: 'MODE_MODIFIED_JD' };
    const WD = { weekday: 'MODE_WEEKDAY', wdy_mm_dd: 'MODE_WDY_MM_DD', weekda_dd: 'MODE_WEEKDA_DD' };
    const DIAG = { test: 'MODE_DISPLAYTEST', vbat: 'MODE_VBAT', satview: 'MODE_SATVIEW' };
    const ASTRO = { sun: 'MODE_SUN', sun_azel: 'MODE_SUN_AZEL', moon: 'MODE_MOON', grid: 'MODE_GRID', latlon: 'MODE_LATLON' };
    if (patch.dateFormat && DATE[patch.dateFormat]) c.push(DATE[patch.dateFormat] + ' = enabled');
    if (patch.weekdayFmt && WD[patch.weekdayFmt]) c.push(WD[patch.weekdayFmt] + ' = enabled');
    if (patch.timeRow === 'offset') c.push('MODE_SHOW_OFFSET = enabled');
    else if (patch.timeRow === 'tz') c.push('MODE_SHOW_TZ_NAME = enabled');
    if (patch.mode === 'text') c.push('MODE_TEXT = enabled');
    else if (patch.mode === 'countdown') c.push('MODE_COUNTDOWN = enabled');
    // Turning ON an astro date-row mode jumps the device straight to it (set_mode_enabled).
    else if (patch.astroFmt && ASTRO[patch.astroFmt]) c.push(ASTRO[patch.astroFmt] + ' = enabled');
    // Leaving text/countdown/astro for the clock: there's no "date mode" key — you re-assert the
    // active date mode, which jumps the device out of text (via requestMode). Without this,
    // CLEAR/MODES left the device stuck in MODE_TEXT; an accompanying empty `text =` then
    // rendered as a lone dash. (Skip when the patch already carries a dateFormat — that
    // branch above emits the command — to avoid sending it twice.)
    else if (patch.mode === 'time' && !patch.dateFormat) c.push((DATE[this.state.dateFormat] || 'MODE_ISO8601_STD') + ' = enabled');
    // Firmware renamed astro_page_ms -> page_ms (it paces ALL paged read-outs incl. MODE_TEMPCOMP).
    // Send both: current firmware honours page_ms, older builds honour astro_page_ms, each ignores
    // the key it doesn't know. Without this the dwell control was silently dead post-rename.
    if (patch.astroDwell != null) { c.push('page_ms = ' + patch.astroDwell); c.push('astro_page_ms = ' + patch.astroDwell); }
    if (patch.colon) c.push('colon_mode = ' + patch.colon);
    // Empty text is never sent: blanking happens by switching to date mode (above), and an
    // empty `text =` in TEXT mode is exactly what draws the stray dash on the device.
    if ('text' in patch && patch.text != null && patch.text !== '') c.push('text = ' + patch.text);
    // The countdown TARGET (firmware key `countdown_to`, ISO `YYYY-MM-DDThh:mm:ssZ` UTC via mktime).
    // Was never emitted, so COUNTDOWN switched mode but never got a target — on emu OR device.
    if (patch.countdownTo != null && patch.countdownTo > 0)
      c.push('countdown_to = ' + new Date(patch.countdownTo).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    if (patch.standby === true) c.push('MODE_STANDBY = enabled');
    else if (patch.standby === false) {
      // Wake: re-send the active display mode so the device leaves standby (there is no
      // "exit standby" key — enabling a mode jumps to it via requestMode).
      const s = this.state;
      const wake = s.mode === 'text' ? 'MODE_TEXT' : s.mode === 'countdown' ? 'MODE_COUNTDOWN' : DATE[s.dateFormat];
      if (wake) c.push(wake + ' = enabled');
    }
    if (patch.diag && DIAG[patch.diag]) c.push(DIAG[patch.diag] + ' = enabled');
    if ('utc' in patch) {
      // The firmware IGNORES an empty zone_override (it returns early on `!value[0]`), so we
      // can't clear back to GPS-auto over serial. For LOCAL, send the browser's own IANA zone
      // instead — it's co-located with the clock and matches exactly what the web shows.
      let zone = 'Etc/UTC';
      if (!patch.utc) { try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'; } catch (e) { /* keep UTC */ } }
      c.push('zone_override = ' + zone);
    }
    return c;
  }

  // Brightness is a continuous slider — debounce the serial write so dragging it
  // doesn't flood the link; the local face updates every frame regardless.
  devBright(b) {
    const S = this.session && this.session.S;
    if (!(S && S.real && this.realdev)) return;
    clearTimeout(this._brTimer);
    this._brTimer = setTimeout(() => this.devSend('brightness = ' + b.toFixed(3)), 200);
  }

  // Mirror a parsed config.txt (read from the CLOCK drive) onto local state, so the
  // emulator starts in the device's REAL state instead of fabricated defaults. This
  // is a READ: update state directly, do NOT route through set2/devApply — that would
  // echo the config straight back to the device as commands.
  applyDeviceConfig(cfg) {
    if (!cfg) return;
    const patch = {};
    const COLON = ['slowfade', 'heartbeat', 'sawtooth', 'alt_sawtooth', 'toggle', 'solid'];
    if (cfg.colon && COLON.includes(cfg.colon)) patch.colon = cfg.colon;
    if (Number.isFinite(cfg.brightness)) { patch.brightness = Math.max(0, Math.min(1, cfg.brightness)); patch.brightLock = true; }
    if (cfg.zone != null) patch.utc = /^etc\/utc$/i.test(cfg.zone);
    if (Number.isFinite(cfg.matrixHz)) patch.matrixFreq = (cfg.matrixHz / 1000).toFixed(1);
    // The device cycles through all ENABLED modes; we can't know which is on screen
    // (no read-back), so show the first enabled one the emulator can render.
    const DATE = { MODE_ISO8601_STD: 'iso8601', MODE_ISO_ORDINAL: 'ordinal', MODE_ISO_WEEK: 'isoweek', MODE_UNIX: 'unix', MODE_JULIAN_DATE: 'julian', MODE_MODIFIED_JD: 'mjd' };
    for (const k of Object.keys(DATE)) { if (cfg.modes && cfg.modes[k]) { patch.dateFormat = DATE[k]; patch.mode = 'time'; break; } }
    const WD = { MODE_WEEKDAY: 'weekday', MODE_WDY_MM_DD: 'wdy_mm_dd', MODE_WEEKDA_DD: 'weekda_dd' };
    for (const k of Object.keys(WD)) { if (cfg.modes && cfg.modes[k]) { patch.weekdayFmt = WD[k]; break; } }
    if (cfg.modes && cfg.modes.MODE_SHOW_OFFSET) patch.timeRow = 'offset';
    else if (cfg.modes && cfg.modes.MODE_SHOW_TZ_NAME) patch.timeRow = 'tz';
    // Astro date-row modes (first enabled wins, like DATE above) + the page-dwell.
    const AST = { MODE_SUN: 'sun', MODE_SUN_AZEL: 'sun_azel', MODE_MOON: 'moon', MODE_GRID: 'grid', MODE_LATLON: 'latlon' };
    for (const k of Object.keys(AST)) { if (cfg.modes && cfg.modes[k]) { patch.astroFmt = AST[k]; patch.mode = 'time'; break; } }
    if (Number.isFinite(cfg.astroPageMs) && cfg.astroPageMs > 0) patch.astroDwell = cfg.astroPageMs;
    // Reflect ALL of the device's enabled modes into the multi-select toggles (keyed by MODE_DEFS.key)
    // — this is how sidereal (MODE_LST) / solar (MODE_SOLAR) and every other mode surface on connect.
    const me = {};
    for (const d of this.MODE_DEFS) {
      if (!cfg.modes) break;
      const on = cfg.modes[d.mode] || (this.MODE_ALIASES[d.mode] || []).some((a) => cfg.modes[a]);
      if (on) me[d.key] = true;
    }
    if (Object.keys(me).length) patch.modesEnabled = { ...this.state.modesEnabled, ...me };
    // CAPABILITY DETECTION: a config.txt LISTS every MODE_* the firmware knows (enabled or disabled),
    // so the set of keys = what this device supports. An older/stock clock simply omits the rollup
    // modes (MODE_LST/MODE_SOLAR/…). Record it to gate PR-only commands; null elsewhere = assume full.
    this._devCaps = (cfg.modes && Object.keys(cfg.modes).length) ? new Set(Object.keys(cfg.modes)) : null;
    // DAC brightness curve, if the config.txt carried BS1..BS5.
    if (cfg.bs) { const c = []; for (let i = 1; i <= 5; i++) { const p = cfg.bs['bs' + i]; if (p) c.push({ adc: p.adc, dac: p.dac }); } if (c.length === 5) patch.dacCurve = c; }
    this.setState(patch, () => this.syncFaces());
    // Keep the emulator's own tz engine in sync with the device's config (a READ — emu.setUtc only
    // moves the emulator, never echoes a command back to the device).
    if (this.emu && 'utc' in patch && this.emu.setUtc) this.emu.setUtc(patch.utc);
    if (patch.dacCurve) this.drawChart('dacCurve');
  }

  // ---------- entry fold ----------
  layoutEntry() {
    const E = this.els;
    if (!E.foldStage || !E.timeHalf) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = this.MM;
    // Scale to FILL the viewport at any resolution (1080p → 6K) — no hard cap. Four rails,
    // whichever binds (each keeps the clock on-screen through the WHOLE fold, not just at rest):
    //   kWidth  — never exceed 92% of the width (a safety rail; rarely binds).
    //   kHeight — never exceed 72% of the height with the STACKED (2·H) entry pose. (The old
    //             code divided by M.W here, not 2·M.H, mis-measuring the height and then leaning
    //             on the 4.2 cap — which is why big/tall displays never filled.)
    //   kSwing  — HORIZONTAL fold clearance: a dead-centre hinge folds the date half Wk to the
    //             LEFT, reaching vw/2 − 1.5·Wk; require that to clear MARGIN → Wk ≤ (vw−2·MARGIN)/3
    //             ≈ vw/3. Clearance becomes a SCALE cap, not a shift — stays dead-centre, no clip.
    //   kFold   — VERTICAL fold clearance: mid-fold the date half swings UP through vertical, so
    //             its far corner reaches its full DIAGONAL √(W²+H²) above the hinge (at SEAM_FRAC·vh).
    //             Require diag·k ≤ SEAM_FRAC·vh − MARGIN or it overhangs the top edge on short/
    //             landscape windows. (This is the rail the removed 4.2 cap had been masking.)
    const MARGIN = 40;
    // Hinge sits a hair BELOW centre. The fold sweeps UP, so room ABOVE the hinge (== SEAM_FRAC·vh)
    // is what caps the size via kFold. Dead-centre (0.5) gives the least room → smallest clock;
    // 0.56 buys fold room for a bigger clock while still reading as centred. Horizontal stays vw/2.
    const SEAM_FRAC = 0.56;
    const diag = Math.sqrt(M.W * M.W + M.H * M.H);
    const kWidth = 0.92 * vw / (2 * M.W);
    const kHeight = 0.72 * vh / (2 * M.H);
    const kSwing = (0.5 * vw - MARGIN) / (1.5 * M.W);
    const kFold = (SEAM_FRAC * vh - MARGIN) / diag;
    const k = Math.max(1.0, Math.min(kWidth, kHeight, kSwing, kFold));
    this.k = k;
    const Wk = M.W * k, Hk = M.H * k, pin = M.PIN * k;
    // Horizontally dead-centre: kSwing guarantees the leftward fold clears MARGIN, so no rightward
    // floor is needed — centre == vw/2 at every resolution and aspect ratio.
    const cxF = 0.5 * vw;
    const originX = Math.round(cxF - Wk / 2), seamY = Math.round(SEAM_FRAC * vh);
    E.foldStage.style.left = originX + 'px';
    E.foldStage.style.top = seamY + 'px';
    const half = (el, top) => { el.style.left = '0px'; el.style.top = top + 'px'; el.style.width = Wk + 'px'; el.style.height = Hk + 'px'; };
    half(E.timeHalf, 0);
    if (E.dateHalf) {
      half(E.dateHalf, -Hk);
      E.dateHalf.style.transformOrigin = pin + 'px ' + (Hk - pin) + 'px';
    }
    if (E.linkWrap) E.linkWrap.style.transformOrigin = pin + 'px ' + pin + 'px';
    if (E.linkPlate) {
      const pw = 12 * k, ph = 24 * k; // r6 caps about the pins — flush with the left edge
      E.linkPlate.style.left = '0px';
      E.linkPlate.style.top = (-ph / 2) + 'px';
      E.linkPlate.style.width = pw + 'px';
      E.linkPlate.style.height = ph + 'px';
      E.linkPlate.style.borderRadius = (pw / 2) + 'px';
      const pd = 3.2 * k;
      // linkPlate has a 1px border; its pins anchor to the content box (inside it), which
      // shoves them 1px off centre — the SAME bug fixed on the disp hinge. Compensate so the
      // fold's hinge matches the docked/display hinge exactly and doesn't jump 1px at the swap.
      const bw = 1;
      const pinEl = (el, cy) => { if (!el) return; el.style.left = (pw / 2 - bw - pd / 2) + 'px'; el.style.top = (cy - bw - pd / 2) + 'px'; el.style.width = pd + 'px'; el.style.height = pd + 'px'; };
      pinEl(E.pinTop, ph / 2 - pin);
      pinEl(E.pinBot, ph / 2 + pin);
    }
    if (E.entryDate) this.sizeFaceCanvas('entryDate', E.entryDate, E.dateHalf, k, 7.0175);
    if (E.entryTime) this.sizeFaceCanvas('entryTime', E.entryTime, E.timeHalf, k, 7.0175);
    if (E.hint) { E.hint.style.top = (seamY + Hk + 42) + 'px'; E.hint.style.left = (originX + Wk / 2) + 'px'; }
    if (E.floorShadow) {
      E.floorShadow.style.left = (originX - 8) + 'px';
      E.floorShadow.style.top = (seamY + Hk - 12) + 'px';
      E.floorShadow.style.width = (Wk + 16) + 'px';
      E.floorShadow.style.height = '30px';
      E.floorShadow.style.opacity = '1'; // revealed only now it's positioned (no stray corner dot)
    }
    this.entryGeom = { originX, seamY, Wk, Hk, k };
  }

  sizeFaceCanvas(key, canvas, holder, k, layoutW) {
    if (!canvas || !holder) return;
    const u = 34.2 * k; // exact CAD scale — one px-per-mm number drives the whole face
    const wc = Math.round(u * layoutW / 0.92), hc = Math.round(u / 0.88);
    const hw = parseFloat(holder.style.width) || holder.clientWidth;
    const hh = parseFloat(holder.style.height) || holder.clientHeight;
    canvas.style.position = 'absolute';
    canvas.style.left = '0px';
    canvas.style.top = '0px';
    canvas.style.width = hw + 'px';
    canvas.style.height = hh + 'px';
    const f = this.faces[key];
    if (f) { f.resize(hw, hh); f.render(Date.now()); }
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  // Double-rAF, but never hang: some renderers (backgrounded/offscreen preview tabs,
  // reduced-motion, heavy throttling) starve requestAnimationFrame, so guard with a timer.
  raf2() { return Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), this.sleep(140)]); }
  // Await a Web-Animations animation, but NEVER block app state on it: a WAAPI `.finished`
  // promise does not resolve while the document is not rendering (throttled rAF, offscreen).
  // Race it against a timer of the animation's own duration + slack; `fill:'forwards'` keeps
  // the end state either way, so the fold always completes and the user is never trapped.
  settle(anim, ms) {
    if (!anim || !anim.finished) return this.sleep(ms);
    return Promise.race([anim.finished.catch(() => {}), this.sleep(ms + 90)]);
  }

  // Can we actually run the fold? A hidden/backgrounded document (preview panes, inactive
  // tabs, some embeds) fully pauses requestAnimationFrame and WAAPI and throttles timers, so
  // the animation can neither play nor ever "finish"; reduced-motion users opt out entirely.
  canAnimate() { return !this.reduced && typeof document !== 'undefined' && document.visibilityState !== 'hidden'; }

  async beginFold() {
    if (this.state.phase !== 'entry' || !this.ready) return;
    if (!this.state.hdrBar) this.go('display'); // the bar lands in the Display panel by default
    // The fold is pure decoration — never gate entering the app on it. If we can't animate,
    // enter instantly (a microtask render, unaffected by rAF/timer throttling).
    if (!this.canAnimate()) { this.jumpToApp(); return; }
    this.setState({ phase: 'folding' });
    const E = this.els;
    const tempo = 1 / (this.props.foldTempo || 1);
    const ease = 'cubic-bezier(.5,.03,.16,1)';
    if (E.hint) E.hint.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
    const run = (el, dur, delay) => el && el.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-90deg)' }],
      { duration: dur * tempo, delay: (delay || 0) * tempo, easing: ease, fill: 'forwards' });
    await this.settle(run(E.dateHalf, 540, 70), (540 + 70) * tempo);
    if (E.floorShadow && this.entryGeom) {
      const g2 = this.entryGeom;
      E.floorShadow.animate(
        [{ left: (g2.originX - 8) + 'px', width: (g2.Wk + 16) + 'px' },
         { left: (g2.originX - g2.Wk - 8) + 'px', width: (2 * g2.Wk + 16) + 'px' }],
        { duration: 770 * tempo, easing: ease, fill: 'forwards' });
    }
    await this.settle(run(E.linkWrap, 620, 150), (620 + 150) * tempo);
    if (this.faces.entryDate) this.faces.entryDate.setInverted(true); // the hinge switch — firmware swaps to the pre-rotated LUT
    await this.sleep(190 * tempo);
    await this.dockBar();
  }

  async dockBar() {
    this.setState({ phase: 'docking', docked: true });
    await this.raf2();
    // Size the Display bar to its computed width NOW, before the dock animation measures the
    // target's box below. Otherwise it measures the 620px default and the clock zooms to that,
    // then snaps to the real (smaller) size once the docked face takes over.
    this.sizeDispBar();
    const E = this.els, g = this.entryGeom;
    if (!E.foldStage || !g) { this.jumpToApp(); return; }
    const target = this.state.hdrBar
      ? (E.dockSlot ? E.dockSlot.querySelector('[data-dockbar]') : null)
      : E.dispBar;
    if (target) target.style.visibility = 'hidden';
    const bar = { x: g.originX - g.Wk, y: g.seamY };
    let tx = 24 - bar.x, ty = 12 - bar.y, s = 40 / g.Hk;
    if (target) { const r = target.getBoundingClientRect(); tx = r.left - bar.x; ty = r.top - bar.y; s = r.height / g.Hk; }
    E.foldStage.style.transformOrigin = (-g.Wk) + 'px 0px';
    const dur = 680 / (this.props.foldTempo || 1);
    const move = E.foldStage.animate(
      [{ transform: 'translate(0px,0px) scale(1)' }, { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')' }],
      { duration: dur, easing: 'cubic-bezier(.55,.02,.14,1)', fill: 'forwards' });
    if (E.entryBg) E.entryBg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur * 0.7, delay: dur * 0.3, fill: 'forwards', easing: 'ease-out' });
    if (E.entryCap) E.entryCap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    if (E.floorShadow) E.floorShadow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur * 0.5, fill: 'forwards', easing: 'ease-out' });
    await this.settle(move, dur);
    if (target) target.style.visibility = '';
    this.setState({ phase: 'app', entryVisible: false });
  }

  jumpToApp() { this.setState({ phase: 'app', entryVisible: false, docked: true }); }

  replayEntry() {
    this.marqOff = 0;
    this.setState({ entryVisible: true, docked: false, phase: 'entry' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.faces.entryDate) this.faces.entryDate.setInverted(false);
      this.layoutEntry();
    }));
  }

  sizeDispBar(retry) {
    const E = this.els;
    // Width comes from the DOM parent chain, NOT the dispWrap ref — on remount the canvas
    // ref fires before dispWrap re-attaches, but the canvas's own parent holders are always
    // in the DOM with a real width. This makes sizing independent of ref-callback order.
    const wrap = E.dispDateHalf && E.dispDateHalf.parentElement && E.dispDateHalf.parentElement.parentElement;
    if (!E.dispDateHalf || !E.dispTimeHalf || !wrap || wrap.clientWidth < 2) {
      if ((retry || 0) < 30 && this.state.section === 'display') {
        cancelAnimationFrame(this._dispRAF);
        this._dispRAF = requestAnimationFrame(() => this.sizeDispBar((retry || 0) + 1));
      }
      return;
    }
    const M = this.MM;
    const avail = Math.max(120, wrap.clientWidth - 4);
    const k = avail / (2 * M.W); // fill the available width; on phones this drops below 1 so the wide bar fits
    const Wk = M.W * k, Hk = M.H * k;
    for (const el of [E.dispDateHalf, E.dispTimeHalf]) { el.style.width = Wk + 'px'; el.style.height = Hk + 'px'; }
    // No column-gap: the two halves butt flush so their 1px borders meet as a single seam —
    // exactly like the entry/fold face. Adding a gap here made the docked face 1px wider at
    // the seam than the freshly-opened one ("extra pixel once put into place").
    if (E.dispBar) E.dispBar.style.columnGap = '0px';
    if (E.dispDate) this.sizeFaceCanvas('dispDate', E.dispDate, E.dispDateHalf, k, 7.0175);
    if (E.dispTime) this.sizeFaceCanvas('dispTime', E.dispTime, E.dispTimeHalf, k, 7.0175);
    // Reveal only now the bar is at its computed size. The markup ships it visibility:hidden
    // at the 620px MAX default; showing it before this line is what let it flash "far too
    // large then snap back" on any layout whose computed width is under that default.
    if (E.dispBar) E.dispBar.style.visibility = 'visible';
    if (E.dispLink) {
      const L = E.dispLink;
      L.style.left = (Wk - 12 * k) + 'px'; // centre the hinge on the flush seam (border-box boundary at Wk)
      L.style.top = '0px';
      L.style.width = (24 * k) + 'px';
      L.style.height = (12 * k) + 'px';
      L.style.borderRadius = (6 * k) + 'px';
      const pd = 3.2 * k;   // pins scale with the bar (no px floor) — a min clamp made them chunky when small
      // dispLink has a 1px border; its abs-positioned pins anchor to the CONTENT box
      // (inside that border), which shoves the pair 1px off the seam — the left dot ends
      // up closer to the hinge than the right. Subtract the border so the two dots sit
      // exactly symmetric about the seam (and centred vertically).
      const bw = 1;
      const pinEl = (el, cx) => { if (!el) return; el.style.left = (cx - bw - pd / 2) + 'px'; el.style.top = (6 * k - bw - pd / 2) + 'px'; el.style.width = pd + 'px'; el.style.height = pd + 'px'; };
      pinEl(E.dispPinA, 6 * k);
      pinEl(E.dispPinB, 18 * k);
    }
  }

  // The docked menu-bar clock is the SAME clock as the Display bar, just HEIGHT-constrained to
  // the menu bar instead of width-constrained to the panel. Size it from the board geometry so
  // its proportions (M.W:M.H = 7.68:1, digits inset) are respected exactly — a true miniature —
  // and lay the hinge (link + pins) on the seam with identical relative math to sizeDispBar.
  sizeHdrBar() {
    const E = this.els, M = this.MM;
    const dock = E.dockSlot ? E.dockSlot.querySelector('[data-dockbar]') : null;
    if (!dock || !E.hdrDateHalf || !E.hdrTimeHalf) return;
    const H = 46;                 // menu-bar clock height (the constraint)
    const k = H / M.H, Wk = M.W * k, Hk = H; // Hk === M.H·k === H
    dock.style.height = Hk + 'px';
    for (const el of [E.hdrDateHalf, E.hdrTimeHalf]) { el.style.width = Wk + 'px'; el.style.height = Hk + 'px'; }
    if (E.hdrDate) this.sizeFaceCanvas('hdrDate', E.hdrDate, E.hdrDateHalf, k, 7.0175);
    if (E.hdrTime) this.sizeFaceCanvas('hdrTime', E.hdrTime, E.hdrTimeHalf, k, 7.0175);
    if (E.hdrLink) {
      const L = E.hdrLink;
      L.style.left = (Wk - 12 * k) + 'px'; L.style.top = '0px';
      L.style.width = (24 * k) + 'px'; L.style.height = (12 * k) + 'px'; L.style.borderRadius = (6 * k) + 'px';
      const pd = 3.2 * k, bw = 1;   // pins scale with the bar (no px floor) — matches the display face
      const pinEl = (el, cx) => { if (!el) return; el.style.left = (cx - bw - pd / 2) + 'px'; el.style.top = (6 * k - bw - pd / 2) + 'px'; el.style.width = pd + 'px'; el.style.height = pd + 'px'; };
      pinEl(E.hdrPinA, 6 * k); pinEl(E.hdrPinB, 18 * k);
    }
  }

  handleResize() {
    if (!this.ready) return;
    if (this.state.phase === 'entry') this.layoutEntry();
    this.sizeDispBar();
    this.sizeHdrBar();
    this.drawCharts();
  }

  // ---------- loops ----------
  startLoops() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      // Guard the whole frame: this loop drives face-render, dispBar sizing and globe
      // spin. A throw in any one used to break the requestAnimationFrame chain, silently
      // freezing everything downstream (the marquee-froze-but-clock-ticks bug — the face
      // has its OWN loop so it kept animating while this loop was dead). Recover per-frame.
      try {
        const now = Date.now();
        const s = this.state;
        // Self-correcting: on any remount into Display the ref order can leave the halves
        // unsized. Detect the mismatch here (frame-driven, framework-agnostic) and re-run once.
        if (s.section === 'display' && s.phase === 'app' && this.els.dispWrap && this.els.dispDateHalf && this.els.dispWrap.clientWidth > 2) {
          const M = this.MM, k = Math.max(120, this.els.dispWrap.clientWidth - 4) / (2 * M.W); // MUST match sizeDispBar or this drift check thrashes
          if (Math.abs((parseFloat(this.els.dispDateHalf.style.width) || 0) - M.W * k) > 1) this.sizeDispBar();
        }
        this.driveEmu();
        this.allFaces((f) => f.render(now));
        if (s.section === 'globe' && s.phase === 'app' && (s.globeRotate || this._globeDrag)) {
          if (s.globeRotate && !this._globeDrag) this.globeRot.lon += 0.028;
          this.drawChart('globe');
        }
      } catch (e) { if (!this._loopErr) { this._loopErr = 1; console.error('[pcc] render-loop frame error (recovering):', e); } }
    };
    loop();
    this.hz = setInterval(() => this.onTick(), 1000);
    // Marquee runs on its OWN timer, decoupled from the render loop above — a stalled or
    // throwing render frame must never freeze scrolling text. setInterval also survives
    // rAF throttling. Fine-grained tick (70ms) gated by the per-speed dwell below.
    this.marqTimer = setInterval(() => { try { this.marqueeTick(); } catch (e) {} }, 70);
    this.onTick();
    this.startDataSources(); // begin polling any saved REST sources
  }

  onTickStats() {
    this._pos = this.posStats();
    this._timing = this.timingStats();
  }

  onTick() {
    if (!this.session) return;
    // REVIEW: session.S is frozen to the playhead by the scrub — never advance live data over it.
    if (this._reviewing) { this.onTickStats(); return; }
    // When a real device is streaming, its NMEA drives session.S — don't let the
    // simulator overwrite it. The sim only advances when not mirroring hardware.
    if (!this.session.S.real) this.session.tick(Date.now());
    // Only in SIMULATION does the virtual GPS feed sats into the Sky / Globe / Map. In STANDBY the
    // telemetry stays empty (no fake data); in CONNECTED the real device owns S.sats.
    if (this.appMode() === 'simulation' && this.emu && this.emu.satsLoaded && this.emu.satsLoaded()) {
      const rs = this.emu.sats();
      if (rs && rs.length) {
        this.session.S.sats = rs;
        if (this.session.S.fix) this.session.S.fix.sats = rs.length;
      }
    }
    this.mirrorDeviceClock();
    // Telemetry logging — CONNECTED real data only, and ONLY when the user has opted in. The
    // opt-in gate must sit on beginSession/record too, not just the UI: the logger's contract is
    // "no silent persistence", so nothing (not even the sessions row with the observer's home
    // coordinates) may be written while logging is off. Edge-detect here (rather than importing
    // the logger into realdev.js) so simulation can never reach the log. Disabling mid-session
    // ends the open session cleanly.
    if (this.telemetryLog) {
      const S = this.session.S;
      const on = this.telemetryLog.enabled;
      const real = !!(S && S.real && S.connected && on);
      if (real && !this._wasReal) {
        this.telemetryLog.beginSession({ observerLat: S.obs && S.obs.lat, observerLon: S.obs && S.obs.lon, portLabel: S.portLabel || '' });
      } else if (!real && this._wasReal) {
        this.telemetryLog.endSession();
      }
      this._wasReal = real;
      if (real) this.telemetryLog.record(S);   // dedupes on the whole second; fire-and-forget
    }
    // Sky-history persistence: snapshot the accumulations every 30 s while a session is live, so a
    // reload (or an accidental unplug) doesn't erase hours of collected sky. Kind-separated buckets.
    this._skySaveTick = (this._skySaveTick || 0) + 1;
    if (this._skySaveTick >= 30 && this.session && this.session.S.connected) { this._skySaveTick = 0; this.saveSkyHistory(); }
    this.vbat = 4.021 + 0.013 * Math.sin(Date.now() / 60000);
    if (this.state.diag === 'satview') this.allFaces((f) => f.setModeCtx({ gps: String(this.session.S.fix.sats) }));
    if (this.state.diag === 'vbat') this.allFaces((f) => f.setModeCtx({ vbat: this.vbat }));
    if (this.state.astroFmt !== 'off' && this.state.diag === 'off') this.allFaces((f) => f.setModeCtx(this.astroCtx()));
    this.onTickStats();
    this.setState({ tick: this.state.tick + 1 });
    requestAnimationFrame(() => { this.drawCharts(); this.scrollLog(); });
  }

  // Run the on-screen face on the CONNECTED clock's GPS time, not host time, so MJD / unix /
  // ISO match the real Mk IV (the host clock may be seconds — or worse — off from GPS). RMC
  // gives whole-second UTC; baseline the host→device offset from the instant a device second
  // landed (deviceTimeAtHost) and HOLD it, letting the host interpolate sub-seconds — re-
  // baselining every second would just inject sync jitter. Cleared back to host time on
  // disconnect / in simulator mode (there's no device to mirror).
  mirrorDeviceClock() {
    const S = this.session && this.session.S;
    if (S && S.real && S.deviceTimeMs && S.deviceTimeAtHost) {
      if (this._devClockOffset == null) this._devClockOffset = S.deviceTimeMs - S.deviceTimeAtHost;
      this.allFaces((f) => { if (f.setClockOffset) f.setClockOffset(this._devClockOffset); });
    } else if (this._devClockOffset != null) {
      this._devClockOffset = null;
      this.allFaces((f) => { if (f.setClockOffset) f.setClockOffset(0); });
    }
  }

  drawCharts() {
    const s = this.state.section;
    if (s === 'display') this.drawChart('gammaCurve');
    else if (s === 'satellites') this.drawChart('sky');
    else if (s === 'signal') { this.drawChart('cn0elev'); this.drawChart('cn0time'); }
    else if (s === 'position') { this.drawChart('posScatter'); this.drawChart('dop'); this.drawChart('cont'); }
    else if (s === 'timing') { this.drawChart('phase'); this.drawChart('stair'); this.drawChart('ppmtemp'); }
    else if (s === 'globe' && !this.state.globeRotate) this.drawChart('globe');
    else if (s === 'map') this.drawChart('map');
  }

  drawChart(name) {
    if (!this.ready) return;
    const el = this.els[name];
    if (!el) return;
    // Canvas-sizing race: when a room mounts (or un-hides) before layout has
    // settled, el.clientWidth is 0, so c2d() falls back to a 300px bitmap that
    // CSS then stretches across the real width — the "squished on load" flash
    // seen across every chart. Don't paint an unsized canvas; instead observe it
    // once and redraw the instant it gets a real box (RO delivers an initial
    // observation immediately if it's already sized).
    if ((el.clientWidth | 0) < 2 || (el.clientHeight | 0) < 2) { this.observeCanvas(el, name); return; }
    const T = this.tok(), S = this.session.S, CH = this.CH, st = this.state;
    const nowS = Math.floor(Date.now() / 1000);
    if (name === 'gammaCurve') return CH.drawGamma(el, T, st.gamma, st.brightness);
    if (name === 'dacCurve') return CH.drawDacCurve(el, T, st.dacCurve, this._dacDrag);
    if (name === 'sky') {
      const trails = new Map();
      // Effective trail cutoff = the tighter of the chart WINDOW and the TRAIL length control.
      const cut = Math.min(st.window >= 5400 ? 5400 : st.window, st.skyTrailAge);
      if (st.skyTrails) for (const [k, tr] of S.trails) {
        const f = tr.filter((p) => nowS - p.t <= cut);
        if (f.length > 1) trails.set(k, f);
      }
      return CH.drawSky(el, T, {
        sats: S.sats, trails, now: nowS,
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon),
        moon: this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon),
      }, { heatmap: st.skyHeatmap, horizon: st.skyHorizon, trails: st.skyTrails, labels: st.skyLabels, trailAge: cut });
    }
    if (name === 'cn0elev') return CH.drawCn0Elev(el, T, S.sats, st.sigMedian);
    if (name === 'cn0time') {
      const fil = st.sigFilter;
      const top = S.sats.filter((x) => x.el > 0 && (fil === 'all' || x.constId === fil)).sort((a, b) => b.cn0 - a.cn0).slice(0, 8);
      return CH.drawCn0Time(el, T, top.map((x) => ({ tok: x.tok, pts: S.cn0Hist.get(x.key) || [] })), 1800, nowS);
    }
    if (name === 'posScatter') return CH.drawPosScatter(el, T, this._pos.pts, this._pos, nowS);
    if (name === 'dop') return CH.drawDop(el, T, S.dopHist, st.posWindow, nowS);
    if (name === 'cont') return CH.drawContinuity(el, T, S.fixHist, 1800, nowS, S.ttff, S.t0);
    if (name === 'phase') return CH.drawPhase(el, T, S.pps.list, 1800, nowS, (S.pps.flags & 2) ? 0 : (S.pps.lastEdge || 0));
    if (name === 'stair') return CH.drawStair(el, T, S.pps.samples, 1800, nowS, S.pps.temp);
    if (name === 'ppmtemp') return CH.drawPpmTemp(el, T, S.pps.samples, this._timing && this._timing.fit);
    // Ground tracks carry no timestamps (gtrails = plain points at ~45 s cadence), so the TRAIL
    // length control maps to a tail slice: 45 s per point, full buffer (40 pts) at MAX.
    const gcut = (g) => {
      const n = Math.round(st.skyTrailAge / 45);
      if (n >= 40) return g;
      const m = new Map();
      for (const [k, tr] of g) m.set(k, tr.length > n ? tr.slice(-n) : tr);
      return m;
    };
    if (name === 'globe') {
      return CH.drawGlobe(el, T, {
        rot: this.globeRot, land: this.land, sats: S.sats, gtrails: gcut(S.gtrails),
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon), obs: S.obs,
        opts: { terminator: st.globeTerm, trails: st.globeTrails, labels: st.globeLabels, graticule: st.globeGrat },
        dark: st.theme === 'dark',
      });
    }
    if (name === 'map') {
      return CH.drawMap(el, T, {
        land: this.land, sats: S.sats, gtrails: gcut(S.gtrails),
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon), obs: S.obs,
        opts: { trails: st.globeTrails, labels: st.globeLabels, graticule: st.globeGrat },
        dark: st.theme === 'dark',
      });
    }
  }

  // Wait until `el` has a real layout box, then draw `name` exactly once — so
  // the correct-size draw is the canvas's first-ever paint (no squished 300px
  // fallback, no blank gap). Driven by setTimeout, NOT requestAnimationFrame:
  // rAF is fully paused while the document is hidden/backgrounded (and reading
  // clientWidth in the callback forces the pending layout), whereas timers keep
  // firing. Bounded (~1.3 s) so a genuinely hidden room's canvas stops retrying;
  // the next section-change / onTick redraw paints it once it is actually shown.
  observeCanvas(el, name) {
    if (el._pccSizeWait) return; // already waiting on this element
    let tries = 0;
    const attempt = () => {
      if (!this.ready || !el.isConnected) { el._pccSizeWait = 0; return; }
      if ((el.clientWidth | 0) >= 2 && (el.clientHeight | 0) >= 2) { el._pccSizeWait = 0; this.drawChart(name); return; }
      if (++tries > 40) { el._pccSizeWait = 0; return; }
      el._pccSizeWait = setTimeout(attempt, 32);
    };
    el._pccSizeWait = setTimeout(attempt, 0);
  }

  bindGlobe(el) {
    if (el._pccBound) return;
    el._pccBound = 1;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      this._globeDrag = { x: e.clientX, y: e.clientY, lon: this.globeRot.lon, lat: this.globeRot.lat };
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._globeDrag) return;
      const R = Math.min(el.clientWidth, el.clientHeight) / 2 || 200;
      this.globeRot.lon = this._globeDrag.lon - (e.clientX - this._globeDrag.x) / R * 70;
      this.globeRot.lat = Math.max(-80, Math.min(80, this._globeDrag.lat + (e.clientY - this._globeDrag.y) / R * 70));
      if (!this.state.globeRotate) this.drawChart('globe');
    });
    const up = () => { this._globeDrag = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // Drag the 5-point DAC curve — ports BrightnessView.handleDrag: grab the nearest point within
  // 24px, then move it with adc clamped between its neighbours (points stay ordered) and both
  // axes clamped 0..4095. Live curve feedback on move; numeric readout refreshes on release.
  bindDacCurve(el) {
    if (el._pccBound) return;
    el._pccBound = 1;
    el.style.touchAction = 'none';
    el.style.cursor = 'crosshair';
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let best = -1, bestD = Infinity;
      this.state.dacCurve.forEach((p, i) => {
        const x = p.adc / 4095 * r.width, y = r.height - p.dac / 4095 * r.height;
        const d = Math.hypot(px - x, py - y); if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD > 24) return;
      this._dacDrag = best;
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      this.drawChart('dacCurve');
    });
    el.addEventListener('pointermove', (e) => {
      if (this._dacDrag == null) return;
      const idx = this._dacDrag, pts = this.state.dacCurve, r = el.getBoundingClientRect();
      let adc = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 4095);
      const dac = Math.round(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) * 4095);
      if (idx > 0) adc = Math.max(pts[idx - 1].adc, adc);
      if (idx < 4) adc = Math.min(pts[idx + 1].adc, adc);
      pts[idx] = { adc, dac };
      this.drawChart('dacCurve');
    });
    const up = () => { if (this._dacDrag != null) { this._dacDrag = null; this.drawChart('dacCurve'); this.setState({}); } };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  loadDacPreset(name) {
    const P = {
      revc: [[0, 0], [1425, 737], [2566, 1601], [3396, 2725], [4095, 4095]],
      gl5549: [[0, 0], [1860, 225], [3050, 684], [3920, 2269], [4095, 4095]],
      revd: [[0, 0], [131, 365], [1076, 1422], [2774, 2665], [3849, 4095]],
    }[name];
    if (!P) return;
    this.setState({ dacCurve: P.map(([adc, dac]) => ({ adc, dac })) });
    this.drawChart('dacCurve');
  }
  // Firmware brightness-curve keys. PLAIN human DAC value — the firmware stores 4095−value
  // internally (invert=1); do NOT pre-invert here (survey must-do #1).
  dacCommands() { return this.state.dacCurve.map((p, i) => `BS${i + 1} = ${p.adc},${p.dac}`); }
  applyDacCurve() { for (const cmd of this.dacCommands()) this.devSend(cmd); }

  // ---------- REST data sources ----------
  saveDataSources() { try { localStorage.setItem('pccweb.dataSources', JSON.stringify(this.state.dataSources)); } catch (e) {} }
  startDataSources() {
    if (!this.dsTimers) this.dsTimers = new Map();
    for (const t of this.dsTimers.values()) clearInterval(t);
    this.dsTimers.clear();
    if (!this.dsValues) this.dsValues = new Map();
    for (const src of this.state.dataSources) {
      if (!src.enabled) continue;
      this.pollDataSource(src);
      this.dsTimers.set(src.id, setInterval(() => this.pollDataSource(src), Math.max(5, src.pollSec || 60) * 1000));
    }
  }
  async pollDataSource(src) {
    const r = await DS.fetchValue(src);
    if (!this.dsValues) this.dsValues = new Map();
    this.dsValues.set(src.id, { value: r.ok ? r.value : null, error: r.ok ? null : r.error, at: Date.now() });
    this.setState({});
    if (r.ok && src.autoPush) this.pushDataSource(src);
  }
  // Cooperative push: only take the date row when it's idle (time or already text, no diag) so
  // a running Countdown / diagnostic / the user's own Text isn't stomped — mirrors macOS sendToDisplay.
  pushDataSource(src) {
    const v = this.dsValues && this.dsValues.get(src.id);
    if (!v || v.value == null) return;
    const s = this.state;
    if (s.diag !== 'off' || (s.mode !== 'time' && s.mode !== 'text')) return;
    this.marqOff = 0; this.set2({ mode: 'text', text: String(v.value), standby: false, diag: 'off' });
  }
  addDataSource() {
    const g = (k) => this.els[k] ? this.els[k].value.trim() : '';
    const endpoint = g('dsUrl'); if (!endpoint) return;
    const mode = this.state.dsMode || 'json';
    const src = {
      id: 'ds' + Date.now(), name: g('dsName') || endpoint, endpoint, extractMode: mode,
      jsonKeyPath: mode === 'json' ? g('dsPath') : '', regex: mode === 'regex' ? g('dsPath') : '',
      displayFormat: g('dsFormat') || '{v}', pollSec: Math.max(5, parseInt(g('dsInterval'), 10) || 60),
      autoPush: false, enabled: true,
    };
    this.setState({ dataSources: this.state.dataSources.concat([src]) }, () => { this.saveDataSources(); this.startDataSources(); });
    for (const k of ['dsName', 'dsUrl', 'dsPath', 'dsFormat']) if (this.els[k]) this.els[k].value = '';
  }
  deleteDataSource(id) {
    if (this.dsValues) this.dsValues.delete(id);
    this.setState({ dataSources: this.state.dataSources.filter((s) => s.id !== id) }, () => { this.saveDataSources(); this.startDataSources(); });
  }
  mutateDataSource(id, fn) {
    this.setState({ dataSources: this.state.dataSources.map((s) => s.id === id ? fn({ ...s }) : s) }, () => { this.saveDataSources(); this.startDataSources(); });
  }

  // ---------- stats ----------
  posStats() {
    const S = this.session && this.session.S;
    const win = this.state.posWindow, nowS = Math.floor(Date.now() / 1000);
    const pts = S ? S.posHist.filter((p) => nowS - p.t <= win) : [];
    if (!pts.length) return { pts, me: 0, mn: 0, cep: 0, drms: 0, sigE: 0, sigN: 0, n: 0 };
    let me = 0, mn = 0;
    for (const p of pts) { me += p.e; mn += p.n; }
    me /= pts.length; mn /= pts.length;
    let ve = 0, vn = 0;
    const rads = [];
    for (const p of pts) { const de = p.e - me, dn = p.n - mn; ve += de * de; vn += dn * dn; rads.push(Math.hypot(de, dn)); }
    ve /= pts.length; vn /= pts.length;
    rads.sort((a, b) => a - b);
    return { pts, me, mn, sigE: Math.sqrt(ve), sigN: Math.sqrt(vn), cep: rads[Math.floor(rads.length / 2)] || 0, drms: 2 * Math.sqrt(ve + vn), n: pts.length };
  }

  timingStats() {
    const S = this.session && this.session.S;
    if (!S) return { rms: 0, p2p: 0, anom: 0, ppm: 0, hold: 0, temp: 0, seq: 0, drop: 0, locked: true, fit: null };
    // .t is in whole seconds (sim tick floors ms→s; realdev matches). Last 900 s.
    const nowS = Math.floor(Date.now() / 1000);
    const win = S.pps.list.filter((p) => nowS - p.t <= 900).map((p) => p.us);
    // Jitter is deviation about the CENTRE, robustly. The absolute offset (fixed ISR latency,
    // the ~1 ms sub-second DC term) isn't jitter, and neither are the occasional single-sample
    // ~−1 ms capture artifacts (lost ms-tick under an IRQ-masked window) — a real Mk IV holds
    // ~10 ns RMS, and a handful of artifacts in a mean/σ smear that into tens of µs. Median/MAD
    // (robustPhaseStats) reports the clock's real jitter; artifacts are counted as `anom` and
    // peak-to-peak is taken over the inliers only.
    const R = win.length && this.PT ? this.PT.robustPhaseStats(win) : { med: 0, sigma: 0, thr: 50, outliers: 0 };
    let mn = Infinity, mx = -Infinity;
    for (const v of win) { if (Math.abs(v - R.med) > R.thr) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
    return {
      rms: R.sigma, p2p: mx > mn ? mx - mn : 0, anom: R.outliers, ppm: S.pps.ppm,
      hold: (S.pps.flags & 2) ? 0 : Math.floor(S.pps.sincecal),
      temp: S.pps.temp, seq: S.pps.seq, drop: S.pps.dropped,
      locked: !!(S.pps.flags & 2), fit: this.session.fit(),
    };
  }

  sendCmd() {
    const el = this.els.cmd;
    if (!el || !el.value.trim() || !this.session) return;
    this.devSend(el.value.trim()); // real device when attached, else simulator
    el.value = '';
    this.setState({});
    requestAnimationFrame(() => this.scrollLog(true));
  }

  scrollLog(force) {
    const el = this.els.monLog;
    if (el && (force || (this.state.monAutoscroll && !this.state.monPaused))) el.scrollTop = el.scrollHeight;
  }

  // ---------- actions ----------
  go(sec) {
    (this._lastSub = this._lastSub || {})[this.roomOf(sec)] = sec; // remember the sub-tab per room
    this.setState({ section: sec });
    localStorage.setItem('pccweb.section', sec);
    if (this.els.main) this.els.main.scrollTop = 0;
    if (sec === 'export') { this.refreshTelStats(); this.openReview(); }   // log counts + load the scrub model
    if (sec === 'datalink') this.mountDatalink();                          // lazy-mount the watch-programming UI
  }

  // Lazily import + mount the Datalink room (self-contained; builds its own DOM in the refDatalink node).
  mountDatalink() {
    if (this._dlMounted) return;
    const host = this.els.datalink;   // populated once the section's sc-if renders the mount div
    if (!host) { setTimeout(() => this.mountDatalink(), 60); return; }
    this._dlMounted = true;
    import('./datalink/datalink-ui.js?v=4').then((m) => m.mountDatalink(host));
  }
  // The redesign collapses the ten sections into four rooms; each room routes to one or more
  // existing sections, surfaced as a sub-tab bar. Content is unchanged — this is IA only.
  get ROOMS() {
    return {
      display: ['display'],
      sky: ['satellites', 'signal', 'position', 'globe', 'map', 'export'], // weather moved to the Display room
      timing: ['timing'],
      device: ['connect', 'devmodes', 'devbright', 'devconfig', 'devadvanced', 'devupdates'], // Monitor is a slide-up drawer, not a room/tab
      datalink: ['datalink'],   // program a vintage Timex Datalink watch by light (its own room)
    };
  }
  roomOf(sec) { for (const r in this.ROOMS) if (this.ROOMS[r].includes(sec)) return r; return 'display'; }
  goRoom(room) {
    const subs = this.ROOMS[room] || ['display'];
    const cur = this.state.section;
    this.go(subs.includes(cur) ? cur : ((this._lastSub && this._lastSub[room]) || subs[0]));
  }
  setTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('pccweb.theme', t);
    this.setState({ theme: t }, () => {
      this.allFaces((f) => f.setTokens(this.faceTokens()));
      this.drawCharts();
    });
  }
  setScen(s) {
    if (!this.session || !this.session.S.connected) return;
    this.session.setScenario(s);
    this.set2({ scenario: s });
  }
  dl(name, mime, str) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([str], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  connInfo() {
    const S = this.session && this.session.S;
    if (!S) return { led: 'var(--txt3)', glow: 'transparent', state: 'INITIALISING', sub: 'LOADING MODULES' };
    if (!S.connected) return { led: 'var(--line2)', glow: 'transparent', state: 'STANDBY', sub: 'SYSTEM TIME · NO CLOCK' };
    if (S.rebooting) return { led: 'var(--acq)', glow: 'rgba(245,181,61,.5)', state: 'REBOOT', sub: 'RE-ENUMERATING USB' };
    if (S.real) {
      // Real device: status comes from the actual NMEA, never the sim scenario.
      if (S.fix.valid) return { led: 'var(--lock)', glow: 'rgba(54,201,139,.55)', state: 'LOCKED', sub: '3D FIX · STREAM OK' };
      if (S.sats && S.sats.length) return { led: 'var(--acq)', glow: 'rgba(245,181,61,.5)', state: 'ACQUIRING', sub: 'SEARCHING SKY' };
      if (S.deviceTimeMs) return { led: 'var(--none)', glow: 'rgba(255,106,61,.55)', state: 'NO FIX', sub: 'GNSS TIME — NO FIX' };
      const waiting = S.realConnectedAt && Date.now() - S.realConnectedAt < 6000;
      return waiting
        ? { led: 'var(--acq)', glow: 'rgba(245,181,61,.5)', state: 'CONNECTING', sub: 'WAITING FOR NMEA…' }
        : { led: 'var(--none)', glow: 'rgba(255,106,61,.55)', state: 'NO SIGNAL', sub: 'NO NMEA — NOT A PRECISION CLOCK?' };
    }
    // Simulation (connected, but not a real device): every readout says SIMULATION, never a bare lock.
    if (S.scenario === 'locked') return { led: 'var(--lock)', glow: 'rgba(54,201,139,.55)', state: 'LOCKED', sub: 'SIMULATION · 3D FIX' };
    if (S.scenario === 'acquiring') return { led: 'var(--acq)', glow: 'rgba(245,181,61,.5)', state: 'ACQUIRING', sub: 'SIMULATION' };
    return { led: 'var(--none)', glow: 'rgba(255,106,61,.55)', state: 'NO FIX', sub: 'SIMULATION' };
  }

  // ---------- style helpers ----------
  seg(on, first) {
    return 'font-family:var(--mono);font-size:11px;letter-spacing:.07em;padding:4px 11px;cursor:pointer;white-space:nowrap;border:0;' +
      (first ? '' : 'border-left:1px solid var(--line);') +
      (on ? 'color:var(--led);background:var(--led-fill);font-weight:700;box-shadow:inset 0 -2px 0 var(--led)' : 'color:var(--txt2);background:transparent');
  }
  cb(on) {
    const base = 'width:26px;height:13px;flex:none;background-color:var(--well);background-repeat:no-repeat;background-size:10px 9px;transition:background-position .12s ease-out;';
    return on
      ? base + 'border:1px solid var(--led);background-image:linear-gradient(var(--led),var(--led));background-position:right 1px center;box-shadow:0 0 6px var(--led-glow)'
      : base + 'border:1px solid var(--line2);background-image:linear-gradient(var(--line2),var(--line2));background-position:1px center';
  }
  rb(on) {
    return on
      ? 'width:12px;height:12px;flex:none;background:var(--led);border:1px solid var(--led);box-shadow:inset 0 0 0 2px var(--panel), 0 0 6px var(--led-glow)'
      : 'width:12px;height:12px;flex:none;background:var(--well);border:1px solid var(--line2)';
  }
  // The firmware's cyclable display modes (modes_enabled[]). key = UI id, mode = config/serial key.
  // Enabling one over serial jumps to it (set_mode_enabled -> requestMode).
  get MODE_DEFS() {
    return [
      { key: 'iso8601', mode: 'MODE_ISO8601_STD', label: 'ISO 8601', group: 'DATE ROW' },
      { key: 'ordinal', mode: 'MODE_ISO_ORDINAL', label: 'ISO ORDINAL', group: 'DATE ROW' },
      { key: 'isoweek', mode: 'MODE_ISO_WEEK', label: 'ISO WEEK', group: 'DATE ROW' },
      { key: 'unix', mode: 'MODE_UNIX', label: 'UNIX', group: 'DATE ROW' },
      { key: 'julian', mode: 'MODE_JULIAN_DATE', label: 'JULIAN DATE', group: 'DATE ROW' },
      { key: 'mjd', mode: 'MODE_MODIFIED_JD', label: 'MODIFIED JD', group: 'DATE ROW' },
      { key: 'weekday', mode: 'MODE_WEEKDAY', label: 'WEEKDAY', group: 'WEEKDAY' },
      { key: 'wdy_mm_dd', mode: 'MODE_WDY_MM_DD', label: 'WDY MM-DD', group: 'WEEKDAY' },
      { key: 'weekda_dd', mode: 'MODE_WEEKDA_DD', label: 'WEEKDAY DD', group: 'WEEKDAY' },
      { key: 'sidereal', mode: 'MODE_LST', label: 'SIDEREAL LST', group: 'TIME ROW' },
      { key: 'solar', mode: 'MODE_SOLAR', label: 'SOLAR TIME', group: 'TIME ROW' },
      { key: 'offset', mode: 'MODE_SHOW_OFFSET', label: 'UTC OFFSET', group: 'TIME ROW' },
      { key: 'tz', mode: 'MODE_SHOW_TZ_NAME', label: 'TZ NAME', group: 'TIME ROW' },
      { key: 'sun', mode: 'MODE_SUN', label: 'SUN RISE/SET', group: 'ASTRO' },
      { key: 'sun_azel', mode: 'MODE_SUN_AZEL', label: 'SUN AZ·EL', group: 'ASTRO' },
      { key: 'moon', mode: 'MODE_MOON', label: 'MOON PHASE', group: 'ASTRO' },
      { key: 'grid', mode: 'MODE_GRID', label: 'MAIDENHEAD', group: 'ASTRO' },
      { key: 'latlon', mode: 'MODE_LATLON', label: 'LAT·LON', group: 'ASTRO' },
      // Tempcomp diagnostic pages (die temp / HSE / LSE / samples+state) — real firmware read-out.
      { key: 'tempcomp', mode: 'MODE_TEMPCOMP', label: 'TEMP COMP', group: 'DIAGNOSTIC' },
    ];
  }
  modeDef(key) { return this.MODE_DEFS.find((d) => d.key === key); }
  enabledModeKeys() { return this.MODE_DEFS.map((d) => d.key).filter((k) => this.state.modesEnabled[k]); }
  // Push a mode enable/disable to BOTH the emulator (its own parser) and a connected clock (serial).
  // Does the CONNECTED device's firmware support this mode? Emulator (always the rollup) and an
  // unknown/unread device → assume yes; a device whose config.txt was read → only if it listed the key.
  // Known config-key aliases across firmware revisions — the SAME feature has been spelled two
  // ways: apparent-solar time is MODE_SOLAR in the current firmware parser but shipped as
  // MODE_SUNDIAL in older config.txt templates (the megabuild fwt.bin only matches "MODE_SOLAR",
  // yet a device's on-disk config.txt can still carry a stale "MODE_SUNDIAL" line). Treat them as
  // one capability so detection/reflection never false-alarms on the naming drift. Bidirectional.
  get MODE_ALIASES() { return { MODE_SOLAR: ['MODE_SUNDIAL'], MODE_SUNDIAL: ['MODE_SOLAR'] }; }
  // Is `modeConst` present in the read device caps (alias-aware)? Caller guards this._devCaps != null.
  _devCapListed(modeConst) {
    if (this._devCaps.has(modeConst)) return true;
    const a = this.MODE_ALIASES[modeConst];
    return !!(a && a.some((k) => this._devCaps.has(k)));
  }
  deviceSupportsMode(modeConst) {
    const S = this.session && this.session.S;
    if (!(S && S.real) || !this._devCaps) return true;
    return this._devCapListed(modeConst);
  }
  pushMode(modeConst, on) {
    const line = modeConst + (on ? ' = enabled' : ' = disabled');
    if (this.emu && this.emu.configLine) this.emu.configLine(line);   // the emulator is always the full rollup
    // Don't send a mode a stock clock can't honour (it would silently no-op and diverge the UI).
    if (this.deviceSupportsMode(modeConst)) this.devSend(line);
    else if (this.session && this.session.log) this.session.log('tx', '(skipped ' + modeConst + ' — device firmware lacks it)');
  }
  // Toggle a display mode in the enabled set. Enabling makes it current (jumps to it), exactly like
  // the firmware; disabling the active one falls back to the first mode still enabled.
  toggleMode(key) {
    const def = this.modeDef(key); if (!def) return;
    const on = !this.state.modesEnabled[key];
    const modesEnabled = { ...this.state.modesEnabled, [key]: on };
    const patch = { modesEnabled };
    if (on) patch.currentMode = key;
    else if (this.state.currentMode === key) {
      const rest = this.MODE_DEFS.map((d) => d.key).filter((k) => modesEnabled[k]);
      patch.currentMode = rest[0] || 'iso8601';
      if (rest[0]) this.pushMode(this.modeDef(rest[0]).mode, true);   // re-assert so something stays on the face
    }
    this.setState(patch);
    this.pushMode(def.mode, on);
  }
  // Cycle the enabled set forward/back — what the physical buttons do. Re-asserts the target's
  // enable so the emulator AND a connected clock jump to it, keeping the "current" marker in sync.
  cycleMode(dir) {
    const on = this.enabledModeKeys();
    if (on.length < 2) return;
    let i = on.indexOf(this.state.currentMode); if (i < 0) i = 0;
    i = (i + (dir < 0 ? -1 : 1) + on.length) % on.length;
    const key = on[i];
    this.setState({ currentMode: key });
    this.pushMode(this.modeDef(key).mode, true);
  }
  // The two tactile buttons on the switch cover (clicked on the on-screen board). Like the real
  // clock, they step through the enabled display modes — forward on 1, back on 2.
  onFaceButton(btn) {
    if (this.emu) { btn === 2 ? this.emu.button2() : this.emu.button1(); }
    this.cycleMode(btn === 2 ? -1 : 1);
  }

  // ---- hardware calibration: drag the on-screen buttons/screws/sensor, read the mm back --------
  defaultHwConfig() {
    // GOSPEL positions — 100% measured by hand against the corrected board geometry. Right-side
    // furniture (buttons / brightness sensor / body screws) at x=266; hinge mounting bolts at x=9.5,
    // all three on their own board's row. Radii are in MILLIMETRES (r = radius): screws/sensor r=2,
    // buttons r=1.5. Do not "tidy" these numbers — they are measured, not derived.
    return [
      { id: 'd-btn-1', row: 'date', kind: 'button', x: 266, y: 0.375, r: 1.5 },
      { id: 'd-btn-2', row: 'date', kind: 'button', x: 266, y: 0.625, r: 1.5 },
      { id: 'd-scr-1', row: 'date', kind: 'screw', x: 266, y: 0.16, r: 2 },
      { id: 'd-scr-2', row: 'date', kind: 'screw', x: 266, y: 0.84, r: 2 },
      { id: 'd-hng-0', row: 'date', kind: 'screw', x: 9.5, y: 0.84, r: 2 },
      { id: 'd-hng-1', row: 'date', kind: 'screw', x: 9.5, y: 0.16, r: 2 },
      { id: 'd-hng-2', row: 'date', kind: 'screw', x: 9.5, y: 0.5, r: 2 },
      { id: 't-sensor', row: 'time', kind: 'sensor', x: 266, y: 0.5, r: 2 },
      { id: 't-scr-1', row: 'time', kind: 'screw', x: 266, y: 0.16, r: 2 },
      { id: 't-scr-2', row: 'time', kind: 'screw', x: 266, y: 0.84, r: 2 },
      { id: 't-hng-0', row: 'time', kind: 'screw', x: 9.5, y: 0.16, r: 2 },
      { id: 't-hng-1', row: 'time', kind: 'screw', x: 9.5, y: 0.5, r: 2 },
      { id: 't-hng-2', row: 'time', kind: 'screw', x: 9.5, y: 0.84, r: 2 },
    ];
  }
  loadHwConfig() {
    const VER = 6;   // bump whenever the GOSPEL defaults change → a pre-gospel saved config re-adopts them ONCE
    let saved = null;
    try { const s = localStorage.getItem('pccweb.hwConfig'); const p = s && JSON.parse(s); if (Array.isArray(p) && p.length) saved = p; } catch (e) {}
    let ver = 0; try { ver = +(localStorage.getItem('pccweb.hwConfigVer') || 0); } catch (e) {}
    if (!saved || ver < VER) {
      // Fresh install, or a saved config predating the current gospel positions → adopt the gospel and
      // stamp the version so we don't clobber it again (subsequent drags/edits persist normally).
      const def = this.defaultHwConfig();
      try { localStorage.setItem('pccweb.hwConfig', JSON.stringify(def)); localStorage.setItem('pccweb.hwConfigVer', String(VER)); } catch (e) {}
      return def;
    }
    // Same gospel version: respect the user's own calibration; fold in any new default items only.
    const have = new Set(saved.map((f) => f.id));
    for (const d of this.defaultHwConfig()) if (!have.has(d.id)) saved.push(d);
    return saved;
  }
  HW_FACES = ['dispDate', 'dispTime', 'entryDate', 'entryTime', 'hdrDate', 'hdrTime'];
  applyHwToFaces() { for (const k of this.HW_FACES) { const f = this.faces[k]; if (f && f.setHwSpec) f.setHwSpec(this.hwConfig); } }
  onHwMove(id, mm) {
    const it = this.hwConfig.find((f) => f.id === id); if (!it) return;
    it.x = mm.x; it.y = mm.y;
    if (mm.final) { localStorage.setItem('pccweb.hwConfig', JSON.stringify(this.hwConfig)); this.applyHwToFaces(); this.syncHwJson(); this.setState({}); }
  }
  // Mirror the current config into the JSON editor — but never while the user is typing in it.
  syncHwJson() { const el = this.els && this.els.hwJson; if (el && document.activeElement !== el) el.value = JSON.stringify(this.hwConfig, null, 2); }
  // Live-parse the JSON editor; on a valid furniture array, apply straight to the faces.
  onHwJsonInput() {
    const el = this.els && this.els.hwJson; if (!el) return;
    let parsed = null;
    try {
      const p = JSON.parse(el.value);
      if (!Array.isArray(p) || !p.length) throw 0;
      for (const it of p) {
        if (!it || typeof it.id !== 'string' || typeof it.x !== 'number' || typeof it.y !== 'number' ||
            (it.row !== 'date' && it.row !== 'time') || typeof it.kind !== 'string') throw 0;
      }
      parsed = p;
    } catch (e) { parsed = null; }
    if (parsed) {
      this.hwConfig = parsed;
      localStorage.setItem('pccweb.hwConfig', JSON.stringify(parsed));
      this.applyHwToFaces();
      if (this._hwJsonErr) { this._hwJsonErr = false; this.setState({}); }
      else this.setState({});   // refresh the mm readout live
    } else if (!this._hwJsonErr) {
      this._hwJsonErr = true; this.setState({});
    }
  }
  toggleHwCalibrate() {
    const on = !this.state.hwCalibrate;
    this.setState({ hwCalibrate: on });
    for (const k of this.HW_FACES) { const f = this.faces[k]; if (f && f.setHwCalibrate) f.setHwCalibrate(on); }
  }
  resetHwConfig() {
    this.hwConfig = this.defaultHwConfig();
    localStorage.removeItem('pccweb.hwConfig');
    this._hwJsonErr = false;
    this.applyHwToFaces(); this.syncHwJson(); this.setState({});
  }
  btn(primary, disabled) {
    return 'font-family:var(--sans);font-size:12px;padding:6px 16px;background:transparent;border:1px solid ' +
      (primary ? 'var(--led)' : 'var(--line2)') + ';color:var(--txt);cursor:' + (disabled ? 'default' : 'pointer') +
      (disabled ? ';opacity:.4' : '');
  }

  fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm ' + String(s).padStart(2, '0') + 's';
  }
  ll(v, latMode) { return Math.abs(v).toFixed(5) + '° ' + (latMode ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W')); }
  hhmm(d) { return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }

  // ---------- renderVals ----------
  renderVals() {
    return Object.assign({},
      this.rvShell(), this.rvDisplay(), this.rvConnect(), this.rvSats(),
      this.rvSignal(), this.rvPosition(), this.rvTiming(), this.rvGlobe(),
      this.rvWeather(), this.rvMonitor(), this.rvExport(), this.rvFirmware());
  }

  rvShell() {
    const st = this.state, ci = this.connInfo();
    const S = this.session && this.session.S;
    const out = {
      // REVIEW banner — shown across ALL rooms while the scrub is driving the app, so it's never
      // mistaken for live data. Carries the playhead time + a one-click exit back to live.
      reviewBannerOn: !!this._reviewing,
      reviewBannerTime: this._reviewing && this._review ? new Date(this._review.playT * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '',
      onExitReview: () => this.exitReview(),
      entryVisible: st.entryVisible, docked: st.docked,
      // One clock, one home: it lives in the Display panel while you're on Display, and
      // collapses into the header (menu bar) on every other section — where it can be closed
      // (hdrClockOpen) to free ~650px when the crowded status row would otherwise clip.
      hdrBarOn: st.docked && st.section !== 'display' && st.hdrClockOpen,
      // Clock docked-but-closed → show a compact "reopen" affordance in its place.
      hdrClockClosed: st.docked && st.section !== 'display' && !st.hdrClockOpen,
      // Abbreviate the wordmark to "PC" only while the ~650px clock is actually in the header;
      // with it closed (or on Display) there's room for the full name. "PC" not "PCC" — the
      // "COMPANION" subtitle underneath carries the third word (PC = Precision Clock).
      // (brand is static markup now — no abbreviated 'PC' variant; it read as a different product)
      onCloseHdrClock: () => this.setState({ hdrClockOpen: false }),
      onOpenHdrClock: () => this.setState({ hdrClockOpen: true }),
      onEntryClick: () => this.beginFold(),
      onEntryOver: () => { const h = this.els.hint; if (h && h.lastChild) { h.lastChild.style.color = 'var(--txt2)'; h.firstChild.style.background = 'var(--txt3)'; } },
      onEntryOut: () => { const h = this.els.hint; if (h && h.lastChild) { h.lastChild.style.color = 'var(--txt3)'; h.firstChild.style.background = 'var(--line2)'; } },
      onReplay: () => this.replayEntry(),
      connLed: ci.led, connGlow: ci.glow || 'transparent', connState: ci.state, connSub: ci.sub,
      // H2 — the status pill is now a disclosure: click to open a popover that holds the
      // connection readouts (PORT / FRAMING / FIX·SATS / FIX AGE) and the SIM fix toggles,
      // instead of spraying four dense columns across the menu bar. The primary connect/
      // open-room action lives inside the popover.
      onHdrStatus: () => this.setState({ hdrPop: !st.hdrPop }),
      hdrPopOn: !!st.hdrPop,
      hdrStatusHint: 'Connection status & controls',
      hdrStatusBg: (S && S.connected) ? '' : 'background:var(--beta-fill)',
      onHdrConnect: () => { this.setState({ hdrPop: false }); if (S && S.real) this.goRoom('device'); else this.connectRealDevice(); },
      hdrConnectLabel: (S && S.real) ? 'DEVICE ROOM →' : 'CONNECT MK IV',
      portLabel: this.portName(S),
      fixTypeLabel: S ? (S.fix.type === 3 ? '3D' : S.fix.type >= 1 ? '2D' : 'NONE') : '—',
      satsLabel: S ? (S.fix.sats + '/' + S.sats.filter((x) => x.visible).length) : '—',
      ageLabel: S && S.fix.valid && S.fixAgeT ? ((Date.now() - S.fixAgeT) / 1000).toFixed(1) + ' s' : '—',
      ssThemeDark: this.seg(st.theme === 'dark', true), ssThemeLight: this.seg(st.theme === 'light', false),
      onThemeDark: () => this.setTheme('dark'), onThemeLight: () => this.setTheme('light'),
      ssScenLock: this.seg(st.scenario === 'locked', true),
      ssScenAcq: this.seg(st.scenario === 'acquiring', false),
      ssScenNone: this.seg(st.scenario === 'nofix', false),
      onScenLock: () => this.setScen('locked'), onScenAcq: () => this.setScen('acquiring'), onScenNone: () => this.setScen('nofix'),
      scenDisabled: !(S && S.connected) || !!(S && S.real), // can't force a real receiver's fix state
    };
    // Four-room rail (the redesign IA). Each room row: active bg/text + LED left-edge + a
    // live status dot on the right that gives an at-a-glance health readout per room.
    const curRoom = this.roomOf(st.section);
    const acqLike = ci.state === 'ACQUIRING' || ci.state === 'CONNECTING';   // ci, S from rvShell() top
    const realDev = !!(S && S.connected && S.real);
    const dots = {
      display: (S && S.connected) ? 'var(--led)' : 'var(--line2)',                          // segments lit
      sky: ci.state === 'LOCKED' ? 'var(--lock)' : (acqLike ? 'var(--acq)' : 'var(--line2)'),// fix health
      timing: ci.state === 'LOCKED' ? 'var(--lock)' : 'var(--line2)',                         // PPS stream live
      device: realDev ? (ci.state === 'LOCKED' ? 'var(--lock)' : 'var(--acq)') : 'var(--line2)', // real hardware
      datalink: 'var(--line2)',   // watch-programming surface; no live status source
    };
    for (const room of ['display', 'sky', 'timing', 'device', 'datalink']) {
      const on = curRoom === room;
      out['goRoom_' + room] = () => this.goRoom(room);
      out['roomBg_' + room] = on ? 'var(--strip)' : 'transparent';
      out['roomC_' + room] = on ? 'var(--txt-hi)' : 'var(--txt2)';
      out['roomE_' + room] = on ? 'var(--led)' : 'transparent';
      out['roomDot_' + room] = dots[room];
    }
    out.roomSky = curRoom === 'sky';
    out.roomDevice = curRoom === 'device';
    // Monitor drawer (slides up over the workspace from the top-bar toggle)
    out.onToggleDrawer = () => { this.setState({ drawerOpen: !this.state.drawerOpen }, () => this.scrollLog(true)); };
    out.drawerXform = st.drawerOpen ? 'translateY(0)' : 'translateY(calc(100% + 2px))';
    out.drawerBtnStyle = 'display:flex;align-items:center;gap:8px;padding:0 15px;background:' + (st.drawerOpen ? 'var(--strip)' : 'transparent') + ';border:0;border-left:1px solid var(--line);cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:.14em;color:' + (st.drawerOpen ? 'var(--txt)' : 'var(--txt3)');
    // Sections keep driving their content (sec_X) and act as sub-tabs (go_X + a segmented style).
    out.sec_weather = false;   // retired section (COMING SOON); keep the binding defined so its sc-if stays hidden
    out.dlShow = this.DATALINK_SHOW;   // Datalink room hidden while the feature matures
    if (!this.DATALINK_SHOW) out.sec_datalink = false;
    for (const sec of this.SECTIONS) {
      const on = st.section === sec;
      out['go_' + sec] = () => this.go(sec);
      out['sec_' + sec] = on;
      out['subStyle_' + sec] = 'flex:none;font-family:var(--mono);font-size:var(--fs-label);letter-spacing:.12em;padding:7px 13px 8px;background:transparent'
        + ';border:0;box-shadow:' + (on ? 'inset 0 -2px 0 var(--led)' : 'none')
        + ';color:' + (on ? 'var(--txt-hi)' : 'var(--txt2)') + ';cursor:pointer;white-space:nowrap';
    }
    for (const r of ['EntryBg', 'FoldStage', 'TimeHalf', 'DateHalf', 'LinkWrap', 'LinkPlate', 'PinTop', 'PinBot', 'EntryTime', 'EntryDate', 'Hint', 'EntryCap', 'FloorShadow', 'DockSlot', 'HdrDate', 'HdrTime', 'Main', 'Drawer', 'DispWrap', 'DispBar', 'DispDateHalf', 'DispTimeHalf', 'DispDate', 'DispTime', 'DispLink', 'DispPinA', 'DispPinB', 'GammaCurve', 'TextInput', 'CdInput', 'LatIn', 'LonIn', 'EmuLat', 'EmuLon', 'EmuCfg', 'EmuCfgFile', 'Sky', 'Cn0elev', 'Cn0time', 'PosScatter', 'Dop', 'Cont', 'Phase', 'Stair', 'Ppmtemp', 'Globe', 'Map', 'MonLog', 'Cmd', 'ReviewCanvas', 'Datalink', 'Tol1In', 'Tol10In', 'Tol100In']) {
      out['ref' + r] = this.ref(r[0].toLowerCase() + r.slice(1));
    }
    return out;
  }

  // Accessory tier (Move 5): fold/unfold a secondary FACE-room panel; persist open state per session.
  toggleAccessory(key) {
    const m = { ...(this.state.accessoryOpen || {}) };
    m[key] = !m[key];
    this.setState({ accessoryOpen: m });
    try { localStorage.setItem('pccweb.accOpen', JSON.stringify(m)); } catch (e) {}
  }

  rvDisplay() {
    const st = this.state, em = this.effectiveMode();
    const S = this.session && this.session.S;
    const names = { iso8601: 'ISO 8601', ordinal: 'ISO ORDINAL', isoweek: 'ISO WEEK', unix: 'UNIX', julian: 'JULIAN', mjd: 'MOD JULIAN', weekday: 'WEEKDAY', wdy_mm_dd: 'WDY MM-DD', weekda_dd: 'WEEKDAY DD', text: 'TEXT', countdown: 'COUNTDOWN', offset: 'UTC OFFSET', standby: 'STANDBY', displaytest: 'DISPLAY TEST', vbat: 'BATTERY', satview: 'SAT VIEW' };
    const _mode = this.appMode();
    const _modeLbl = _mode === 'connected' ? 'LIVE' : _mode === 'simulation' ? 'SIMULATION' : 'STANDBY';
    // Both simulation AND connected drive the firmware, so both read the REAL precision ladder from
    // the emulator; only standby (host time, no fix) has no honest precision to show. Displayed as
    // RESOLUTION (place value of the finest lit digit) — "P3" etc. is internal handler naming only.
    const _RES = { P3: '1 ms', P2: '10 ms', P1: '0.1 s', P0: '1 s' };
    const _pl = _mode === 'standby' ? 'NO FIX'
      : 'RES ' + (this.emu && this.emu.precision ? (_RES[this.emu.precision().level] || '1 s') : (_RES['P' + st.precision] || '1 s'));
    const _dispName = _mode === 'standby' ? 'SYSTEM TIME' : (st.standby ? 'STANDBY' : (names[em.m] || em.m.toUpperCase()));
    const acc = st.accessoryOpen || {};
    return {
      // Accessory tier (Move 5) — disclosure toggles + live glance summaries for the folded panels.
      accTogText: () => this.toggleAccessory('text'), accOpenText: acc.text ? 'true' : 'false', accChevText: acc.text ? '▾' : '▸',
      accStatText: st.text ? ('“' + String(st.text).slice(0, 16) + '” · ' + String(st.marqueeSpeed || 'std').toUpperCase()) : 'NO TEXT',
      accTogCd: () => this.toggleAccessory('countdown'), accOpenCd: acc.countdown ? 'true' : 'false', accChevCd: acc.countdown ? '▾' : '▸',
      accStatCd: st.countdownTo > 0 ? (new Date(st.countdownTo).toISOString().slice(0, 16).replace('T', ' ') + ' UTC') : 'NOT SET',
      accTogDs: () => this.toggleAccessory('datasources'), accOpenDs: acc.datasources ? 'true' : 'false', accChevDs: acc.datasources ? '▾' : '▸',
      accStatDs: (st.dataSources && st.dataSources.length) ? (st.dataSources.length + ' SOURCE' + (st.dataSources.length === 1 ? '' : 'S')) : 'NONE',
      accTogWx: () => this.toggleAccessory('weather'), accOpenWx: acc.weather ? 'true' : 'false', accChevWx: acc.weather ? '▾' : '▸',
      accStatWx: st.wxOffline ? 'UNAVAILABLE' : 'AT FIX',
      faceStatusLine: _modeLbl + ' · ' + _dispName + ' · BRT ' + Math.round(st.brightness * 100) + '% · ' + _pl + ' · ' + (st.utc ? 'UTC' : 'LOCAL'),
      faceRoomCap: _mode === 'connected' ? 'MK IV FACE — LIVE HARDWARE' : _mode === 'simulation' ? 'MK IV FACE — SIMULATION' : 'MK IV FACE — SYSTEM TIME',
      // Hardware calibration overlay — drag the board furniture on the face, read the mm here.
      hwCalibrateOn: !!st.hwCalibrate,
      hwCalShow: false,   // furniture positions are baked to gospel defaults — hide the calibrate entry (flip to re-enable)
      hwCalBtnLabel: st.hwCalibrate ? '● CALIBRATING — TAP TO FINISH' : 'CALIBRATE HARDWARE',
      hwCalBtnStyle: 'font-family:var(--mono);font-size:9px;letter-spacing:.08em;border-radius:4px;padding:4px 9px;cursor:pointer;' + (st.hwCalibrate ? 'color:#000;background:var(--beta);border:1px solid var(--beta)' : 'color:var(--beta);background:transparent;border:1px solid var(--beta)'),
      onHwCalibrate: () => this.toggleHwCalibrate(),
      hwReadout: (this.hwConfig || []).map((f) => f.id.padEnd(9) + ' x=' + String(f.x).padStart(6) + ' mm   y=' + String(Math.round(f.y * 34.56)).padStart(2) + ' mm').join('\n'),
      refHwJson: this.ref('hwJson'),
      onHwJsonInput: () => this.onHwJsonInput(),
      hwJsonBorder: this._hwJsonErr ? 'var(--none)' : 'var(--line2)',
      hwJsonStatusColor: this._hwJsonErr ? 'var(--none)' : 'var(--lock)',
      hwJsonStatus: this._hwJsonErr ? '✗ INVALID JSON — last valid edit still applied' : '✓ APPLIED LIVE TO THE CLOCK',
      onHwCopy: () => { try { navigator.clipboard.writeText(JSON.stringify(this.hwConfig, null, 2)); } catch (e) {} },
      onHwReset: () => this.resetHwConfig(),
      // STANDBY front door: connect-first. A real Mk IV is the point; a simulation is the equal-but-
      // quieter fallback for anyone without hardware. Shown only while in Standby.
      standbyOn: _mode === 'standby',
      onStandbyConnect: () => this.connectRealDevice(),
      onStandbyExplore: () => this.setSim(true),
      standbySerialNote: (typeof navigator !== 'undefined' && 'serial' in navigator) ? 'WEB SERIAL READY — CHROME, EDGE OR OPERA' : 'NEEDS CHROME, EDGE OR OPERA FOR WEB SERIAL',
      sourceTag: (S && S.real) ? 'MK IV — LIVE · CONTROLS COMMAND DEVICE · BUTTONS NOT REPORTED' : this.emuSourceTag(),
      cbHdrBar: this.cb(st.hdrBar),
      oHdrBar: () => {
        const v = !st.hdrBar;
        localStorage.setItem('pccweb.hdrbar', v ? '1' : '0');
        this.setState({ hdrBar: v });
      },
      ssModeTime: this.seg(st.mode === 'time', true), ssModeText: this.seg(st.mode === 'text', false), ssModeCd: this.seg(st.mode === 'countdown', false),
      // DATE ROW SOURCE only means something when the firmware is rendering the row (simulation or a
      // connected clock). In STANDBY the face is plain host time, so the control is inert — grey it
      // out + block clicks instead of letting a button light up with no effect on the face.
      modeSelDisabled: this.appMode() === 'standby',
      modeSelWrapStyle: 'display:flex;border:1px solid var(--line);border-radius:var(--r-1);overflow:hidden' + (this.appMode() === 'standby' ? ';opacity:.4;pointer-events:none' : ''),
      onModeTime: () => this.set2({ mode: 'time' }),
      onModeText: () => { this.marqOff = 0; this.set2({ mode: 'text', standby: false, diag: 'off' }); },
      onModeCd: () => this.set2({ mode: 'countdown', countdownTo: st.countdownTo || Date.now() + 7 * 864e5, standby: false, diag: 'off' }),
      modeIsText: st.mode === 'text', modeIsCd: st.mode === 'countdown',
      onSendText: () => { const v = this.els.textInput ? this.els.textInput.value : ''; this.marqOff = 0; this.set2({ mode: 'text', text: v || ' ' }); },
      onClearText: () => { if (this.els.textInput) this.els.textInput.value = ''; this.marqOff = 0; this._mq = 0; this.set2({ mode: 'time', text: '' }); },
      // DATA SOURCES — the saved REST sources merged with their last polled value + per-row actions.
      dsList: st.dataSources.map((s) => {
        const v = this.dsValues && this.dsValues.get(s.id);
        const chip = (on) => `font-family:var(--mono);font-size:9px;letter-spacing:.06em;padding:3px 8px;background:transparent;border:1px solid ${on ? 'var(--led)' : 'var(--line2)'};color:${on ? 'var(--txt)' : 'var(--txt3)'};cursor:pointer;white-space:nowrap`;
        return {
          k: s.id, name: s.name, endpoint: s.endpoint,
          val: v ? (v.value != null ? String(v.value) : ('⚠ ' + (v.error || 'error'))) : 'polling…',
          enTxt: s.enabled ? 'ON' : 'OFF', enStyle: chip(s.enabled), autoStyle: chip(s.autoPush),
          onPush: () => this.pushDataSource(s),
          onTog: () => this.mutateDataSource(s.id, (x) => (x.enabled = !x.enabled, x)),
          onAuto: () => this.mutateDataSource(s.id, (x) => (x.autoPush = !x.autoPush, x)),
          onDel: () => this.deleteDataSource(s.id),
        };
      }),
      dsEmpty: st.dataSources.length === 0,
      rbDsJson: this.rb(st.dsMode === 'json'), rbDsRegex: this.rb(st.dsMode === 'regex'), rbDsText: this.rb(st.dsMode === 'text'),
      oDsJson: () => this.setState({ dsMode: 'json' }), oDsRegex: () => this.setState({ dsMode: 'regex' }), oDsText: () => this.setState({ dsMode: 'text' }),
      dsPathPlaceholder: st.dsMode === 'json' ? 'JSON path · e.g. main.temp' : st.dsMode === 'regex' ? 'regex · 1st capture group' : 'unused for TEXT (first line)',
      onDsAdd: () => this.addDataSource(),
      ssSpdSlow: this.seg(st.marqueeSpeed === 'slow', true), ssSpdStd: this.seg(st.marqueeSpeed === 'std', false), ssSpdFast: this.seg(st.marqueeSpeed === 'fast', false),
      onSpdSlow: () => this.setState({ marqueeSpeed: 'slow' }), onSpdStd: () => this.setState({ marqueeSpeed: 'std' }), onSpdFast: () => this.setState({ marqueeSpeed: 'fast' }),
      marqueeNote: (st.text || '').length > 10 ? 'SCROLLING — ' + (st.text || '').length + ' CHARS' : 'AUTO WHEN >10 CHARS',
      onSetCd: () => { const v = this.els.cdInput && this.els.cdInput.value; const t = v ? new Date(v).getTime() : NaN; if (!isNaN(t)) this.set2({ countdownTo: t, mode: 'countdown', standby: false, diag: 'off' }); },
      // Countdown targets are events (New Year, a launch, a deadline) — long-term, not minutes away.
      onCd1w: () => this.setCdTarget(Date.now() + 7 * 864e5),
      onCd1mo: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); this.setCdTarget(d.getTime()); },
      onCd1y: () => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); this.setCdTarget(d.getTime()); },
      onCdNye: () => { const y = new Date().getFullYear(); this.setCdTarget(new Date(y + 1, 0, 1, 0, 0, 0).getTime()); }, // local midnight, next Jan 1
      cdTargetLabel: st.countdownTo ? this.msToLocalInput(st.countdownTo).replace('T', ' ') : '— NOT SET',
      // MULTI-SELECT display modes — checkboxes = the firmware's modes_enabled[]. Toggling one
      // enables/disables it on the emulator AND a connected clock; enabling jumps to it. The mode
      // shown on the face (the "current" of the cycle) gets an accent ring.
      cbIso: this.cb(!!st.modesEnabled.iso8601), oFmtIso: () => this.toggleMode('iso8601'),
      cbOrd: this.cb(!!st.modesEnabled.ordinal), oFmtOrd: () => this.toggleMode('ordinal'),
      cbWeek: this.cb(!!st.modesEnabled.isoweek), oFmtWeek: () => this.toggleMode('isoweek'),
      cbUnix: this.cb(!!st.modesEnabled.unix), oFmtUnix: () => this.toggleMode('unix'),
      cbJul: this.cb(!!st.modesEnabled.julian), oFmtJul: () => this.toggleMode('julian'),
      cbMjd: this.cb(!!st.modesEnabled.mjd), oFmtMjd: () => this.toggleMode('mjd'),
      cbAstSun: this.cb(!!st.modesEnabled.sun), oAstSun: () => this.toggleMode('sun'),
      cbAstAzel: this.cb(!!st.modesEnabled.sun_azel), oAstAzel: () => this.toggleMode('sun_azel'),
      cbAstMoon: this.cb(!!st.modesEnabled.moon), oAstMoon: () => this.toggleMode('moon'),
      cbAstGrid: this.cb(!!st.modesEnabled.grid), oAstGrid: () => this.toggleMode('grid'),
      cbAstLl: this.cb(!!st.modesEnabled.latlon), oAstLl: () => this.toggleMode('latlon'),
      cbDgTc: this.cb(!!st.modesEnabled.tempcomp), oDgTc: () => this.toggleMode('tempcomp'),   // diagnostic read-out — lives in ADVANCED
      cbWdFull: this.cb(!!st.modesEnabled.weekday), oWdFull: () => this.toggleMode('weekday'),
      cbWdMmdd: this.cb(!!st.modesEnabled.wdy_mm_dd), oWdMmdd: () => this.toggleMode('wdy_mm_dd'),
      cbWdDd: this.cb(!!st.modesEnabled.weekda_dd), oWdDd: () => this.toggleMode('weekda_dd'),
      cbTrSid: this.cb(!!st.modesEnabled.sidereal), oTrSid: () => this.toggleMode('sidereal'),
      cbTrSol: this.cb(!!st.modesEnabled.solar), oTrSol: () => this.toggleMode('solar'),
      cbTrOff: this.cb(!!st.modesEnabled.offset), oTrOff: () => this.toggleMode('offset'),
      cbTrTz: this.cb(!!st.modesEnabled.tz), oTrTz: () => this.toggleMode('tz'),
      // Capability note: when a stock clock is connected whose firmware lacks some rollup modes,
      // say so (they still work in the emulator). Empty for the emulator / an unread device = full.
      modesCapNote: (() => {
        if (!this._devCaps) return '';
        const lack = this.MODE_DEFS.filter((d) => !this._devCapListed(d.mode)).map((d) => d.label);
        return lack.length ? ('DEVICE FIRMWARE LACKS ' + lack.join(' · ') + ' — EMULATOR ONLY') : '';
      })(),
      modesCapOn: !!(this._devCaps && this.MODE_DEFS.some((d) => !this._devCapListed(d.mode))),
      // Cycle the enabled set (what the buttons do) + the "currently on the face" read-out.
      onModePrev: () => this.cycleMode(-1), onModeNext: () => this.cycleMode(1),
      modeCurLabel: (this.modeDef(st.currentMode) || { label: '—' }).label,
      modeEnabledCount: this.enabledModeKeys().length,
      astroDwellVal: String(st.astroDwell || 5500),
      onAstroDwell: () => { const v = this.els.astroDwellIn && this.els.astroDwellIn.value; const n = parseInt(v, 10); if (Number.isFinite(n)) this.set2({ astroDwell: Math.max(250, n || 5500) }); },
      // Holdover tolerances — the REAL firmware knobs (config.txt Tolerance_time_*). The old P0–P3
      // "pick a level" selector was a design-era leftover: resolution is derived, never set.
      // significance_fade is the EVOLUTION of this ladder: while it's enabled the firmware ignores
      // these timers entirely (setPrecision's fade branch), so the panel disables and says so.
      tol1Val: st.tol1 || 1000, tol10Val: st.tol10 || 10000, tol100Val: st.tol100 || 100000,   // seeded from config.txt
      ...(() => {
        const fadeOn = !!(this.emu && this.emu.holdoverFadeOn && this.emu.holdoverFadeOn());
        return {
          tolDisabled: fadeOn,
          tolRowStyle: fadeOn ? 'opacity:.38;pointer-events:none' : '',
          tolApplyStyle: 'font-family:var(--sans);font-size:12px;padding:5px 14px;background:transparent;border:1px solid var(--led);color:var(--txt);cursor:' + (fadeOn ? 'not-allowed' : 'pointer'),
          tolNote: fadeOn
            ? 'OVERRIDDEN — Significance Fade is on: digits are dashed by the measured 3σ holdover uncertainty, not these timers. Turn the fade off to use the fixed ladder again.'
            : 'Seconds of holdover before each digit is dashed (config.txt Tolerance_time_*). Resolution is earned from GPS discipline, not set — these only decide when the clock stops claiming digits. Significance Fade supersedes this ladder while enabled.',
        };
      })(),
      onTolApply: () => {
        if (this.emu && this.emu.holdoverFadeOn && this.emu.holdoverFadeOn()) return;   // ladder overridden
        const read = (el, dflt) => { const n = parseInt(el && el.value, 10); return Number.isFinite(n) && n > 0 ? n : dflt; };
        const t1 = read(this.els.tol1In, 1000), t10 = read(this.els.tol10In, 10000), t100 = read(this.els.tol100In, 100000);
        if (this.emu && this.emu.setTolerances) this.emu.setTolerances(t1, t10, t100);   // keeps precision() in sync
        for (const l of ['Tolerance_time_1ms = ' + t1, 'Tolerance_time_10ms = ' + t10, 'Tolerance_time_100ms = ' + t100]) this.devSend(l);
        if (this.session && this.session.log) this.session.log('tx', 'holdover tolerances: ' + t1 + ' / ' + t10 + ' / ' + t100 + ' s');
      },
      brightVal: Math.round(st.brightness * 100), brightPctLabel: Math.round(st.brightness * 100) + '%', brightLock: st.brightLock,
      onBright: (e) => { const b = (+e.target.value) / 100; this.setState({ brightness: b }); this.allFaces((f) => f.setBrightness(Math.pow(b, this.state.gamma))); this.drawChart('gammaCurve'); this.devBright(b); },
      // Observer location shim: drives the emulator's virtual GPS (sidereal/solar/grid + real sky).
      emuLatVal: this.emu ? this.emu.state().lat.toFixed(4) : '51.4779',
      emuLonVal: this.emu ? this.emu.state().lon.toFixed(4) : '-0.0015',
      emuObserverTag: this.emuObserverTag(),
      emuTzTag: this.emuTzTag(),
      // In CONNECTED mode the observer IS the clock's own GPS fix — the app reflects it, it can't
      // override it. Lock the location controls (device drives location); editable in sim/standby.
      obsCtrlDisabled: this.appMode() === 'connected',
      obsGeoStyle: 'display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--face-led,#ff4530);background:transparent;border:1px solid var(--face-led,#ff4530);border-radius:5px;padding:8px 13px;cursor:' + (this.appMode() === 'connected' ? 'not-allowed;opacity:.4' : 'pointer'),
      obsSetStyle: 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--txt);background:var(--well);border:1px solid var(--line2);padding:6px 12px;margin-left:4px;cursor:' + (this.appMode() === 'connected' ? 'not-allowed;opacity:.4' : 'pointer'),
      onGeolocate: () => this.geolocate(false),
      onSetLoc: () => {
        const la = parseFloat(this.els.emuLat && this.els.emuLat.value);
        const lo = parseFloat(this.els.emuLon && this.els.emuLon.value);
        // Resolve the observed location's zone (ZoneDetect) then, if a real clock is attached,
        // mirror that zone to it so device and emulator agree — otherwise the device keeps the
        // browser zone while the emulator shows the observed one.
        this.applyEmuLoc(la, lo, 'manual').then((zone) => {
          const S = this.session && this.session.S;
          if (zone && S && S.real && this.realdev) this.devSend('zone_override = ' + zone);
        });
      },
      // Honest-digits precision panel (recomputed each render; onTick re-renders at 1 Hz).
      ...(() => { const u = this.precUi(); return {
        precLevel: u.level, precLevelStyle: u.style, precUnc: u.unc, precDigits: u.digits,
        precHold: u.hold, precMeterPct: u.pct + '%', precColon: u.colon, gpsSignalLabel: u.gps, timelapseLabel: u.tl, fadeLabel: u.fade,
      }; })(),
      // The GPS-drop / time-lapse toggles are a SIMULATION-ONLY drill — you can't fake a real
      // receiver's signal, and standby is plain host time. Enable them only in simulation; grey
      // them out (not-allowed cursor + faded) everywhere else so they never read as clickable.
      simDemoDisabled: this.appMode() !== 'simulation',
      simDemoBtnStyle: 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--txt);background:var(--well);border:1px solid var(--line2);border-radius:var(--r-1);padding:6px 12px;cursor:' +
        (this.appMode() !== 'simulation' ? 'not-allowed;opacity:.38' : 'pointer'),
      onGpsSignal: () => { if (this.appMode() !== 'simulation' || !this.emu) return; this.emu.setSignal(!this.emu.state().signal); },
      onTimelapse: () => { if (this.appMode() !== 'simulation' || !this.emu) return; this.emu.setTimelapse(!(this.emu.timelapseOn && this.emu.timelapseOn())); },
      // SIGNIFICANCE FADE toggle — flips the firmware's significance_fade so sub-second digits fade out
      // (continuous TIE-driven) instead of dashing (the fixed tolerance ladder). Sim-only, like the rest.
      onHoldoverFade: () => { if (this.appMode() !== 'simulation' || !this.emu) return; this.emu.setHoldoverFade(!(this.emu.holdoverFadeOn && this.emu.holdoverFadeOn())); },
      // DRILL disclosure — folds the sim-only demo toggles away so the honest readout leads.
      onDrillTog: () => this.setState({ drillOpen: !this.state.drillOpen }),
      drillOpenStr: st.drillOpen ? 'true' : 'false', drillChev: st.drillOpen ? '▾' : '▸',
      // Emulator config.txt: APPLY through the real firmware parser + reboot; EXPORT/IMPORT a file.
      // Stage E — when a real Mk IV is attached, APPLY also mirrors every setting onto the
      // physical clock live over serial (runtime-only; see mirrorConfigToDevice).
      emuCfgSync: (() => {
        if (this._emuCfgNote) return this._emuCfgNote;
        const S = this.session && this.session.S;
        return (S && S.real && this.realdev)
          ? 'MK IV CONNECTED — APPLY ALSO MIRRORS THESE SETTINGS TO THE CLOCK LIVE OVER SERIAL (RUNTIME-ONLY; THE CLOCK’S config.txt FILE IS UNCHANGED — EXPORT + DROP ON THE DRIVE TO PERSIST).'
          : 'EMULATOR ONLY — CONNECT A MK IV IN THE DEVICE ROOM TO ALSO MIRROR APPLY ONTO THE PHYSICAL CLOCK.';
      })(),
      onEmuCfgApply: () => {
        if (!this.emu || !this.els.emuCfg) return;
        const txt = this.els.emuCfg.value;
        this.emu.applyConfig(txt);                    // reboot the emulator with the new config.txt
        // config.txt is the source of truth: reflect the applied config back into the UI controls
        // (toggles/selectors) via the one table, so editing the text drives the whole app, not just
        // the emulator. syncFaces reconciles the face rendering with the new state.
        this.setState(configToState(txt), () => this.syncFaces());
        const n = this.mirrorConfigToDevice(txt);     // 0 if no clock attached
        this._emuCfgNote = n
          ? ('✓ MIRRORED ' + n + ' SETTINGS TO THE CONNECTED CLOCK (LIVE / RUNTIME). EXPORT config.txt TO PERSIST ACROSS A POWER-CYCLE.')
          : '';
        this.setState({ tick: this.state.tick });     // re-render the sync note
      },
      onEmuCfgExport: () => {
        // The curated golden config.txt (every firmware option, annotated) with the CURRENT UI
        // settings substituted in — drop straight on the CLOCK drive. Single source of truth.
        const txt = stateToConfig(this.state);
        const blob = new Blob([txt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'config.txt'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      onEmuCfgImport: () => { if (this.els.emuCfgFile) this.els.emuCfgFile.click(); },
      cbBrightLock: this.cb(st.brightLock), oBrightLock: () => this.setState({ brightLock: !st.brightLock }),
      gammaVal: st.gamma, gammaLabel: st.gamma.toFixed(2),
      onGamma: (e) => { const g = +e.target.value; this.setState({ gamma: g }); this.allFaces((f) => f.setBrightness(Math.pow(this.state.brightness, g))); this.drawChart('gammaCurve'); },
      // DAC-curve editor (Brightness tab). Points drag on the canvas; the numeric grid mirrors them.
      dacPts: st.dacCurve.map((p, i) => ({ k: i, n: 'P' + (i + 1), adc: p.adc, dac: p.dac })),
      oDacRevC: () => this.loadDacPreset('revc'), oDacGl: () => this.loadDacPreset('gl5549'), oDacRevD: () => this.loadDacPreset('revd'),
      onDacApply: () => this.applyDacCurve(),
      onDacCopy: () => { try { navigator.clipboard.writeText(this.dacCommands().join('\n')); } catch (e) {} },
      dacApplyNote: (S && S.real) ? 'APPLY → BS1..BS5 OVER SERIAL' : 'CONNECT A CLOCK TO SEND · OR COPY THE BS LINES',
      rbColSlow: this.rb(st.colon === 'slowfade'), rbColHeart: this.rb(st.colon === 'heartbeat'), rbColSaw: this.rb(st.colon === 'sawtooth'), rbColAlt: this.rb(st.colon === 'alt_sawtooth'), rbColTog: this.rb(st.colon === 'toggle'), rbColSolid: this.rb(st.colon === 'solid'),
      oColSlow: () => this.set2({ colon: 'slowfade' }), oColHeart: () => this.set2({ colon: 'heartbeat' }), oColSaw: () => this.set2({ colon: 'sawtooth' }), oColAlt: () => this.set2({ colon: 'alt_sawtooth' }), oColTog: () => this.set2({ colon: 'toggle' }), oColSolid: () => this.set2({ colon: 'solid' }),
      colonFreezeNote: this.noFixFreeze() ? 'HELD SOLID — FIRMWARE FREEZES THE ANIMATION WITHOUT FIX' : 'RESYNCED ON THE EVEN UTC SECOND · 2 S CYCLE',
      ssSrcLocal: this.seg(!st.utc, true), ssSrcUtc: this.seg(st.utc, false),
      oSrcLocal: () => { this.set2({ utc: false }); if (this.emu) this.emu.setUtc(false); },
      oSrcUtc: () => { this.set2({ utc: true }); if (this.emu) this.emu.setUtc(true); },
      cbStandby: this.cb(st.standby), oStandby: () => this.set2({ standby: !st.standby }),
      rbDgOff: this.rb(st.diag === 'off'), rbDgTest: this.rb(st.diag === 'test'), rbDgVbat: this.rb(st.diag === 'vbat'), rbDgSat: this.rb(st.diag === 'satview'),
      oDgOff: () => this.set2({ diag: 'off' }), oDgTest: () => this.set2({ diag: 'test', standby: false }), oDgVbat: () => this.set2({ diag: 'vbat', standby: false }), oDgSat: () => this.set2({ diag: 'satview', standby: false }),
      tzVal: st.tzOverride, onTz: (e) => this.setState({ tzOverride: e.target.value }),
      mxVal: st.matrixFreq, onMx: (e) => this.setState({ matrixFreq: e.target.value }),
      onApplyPos: () => {
        const la = parseFloat(this.els.latIn && this.els.latIn.value), lo = parseFloat(this.els.lonIn && this.els.lonIn.value);
        if (isNaN(la) || isNaN(lo) || Math.abs(la) > 85 || Math.abs(lo) > 180 || !this.session) return;
        const S = this.session.S;
        S.obs.lat = la; S.obs.lon = lo;
        S.obsUserSet = true; // a deliberate pin — real-device fix seeding must not override it
        S.posHist.length = 0; S.trails.clear(); S.gtrails.clear(); S.cn0Hist.clear(); S.bins.clear();
        this.globeRot = { lon: lo, lat: la };
        this.onTickStats(); this.setState({}); requestAnimationFrame(() => this.drawCharts());
      },
      onReboot: () => {
        if (!(this.session && this.session.S.connected && !this.session.S.rebooting)) return;
        if (!this.state.rebootArm) {
          clearTimeout(this.rebootTimer);
          this.rebootTimer = setTimeout(() => this.setState({ rebootArm: false }), 3000);
          this.setState({ rebootArm: true });
          return;
        }
        clearTimeout(this.rebootTimer);
        const S = this.session.S;
        if (S.real && this.realdev) {
          // Real Mk IV: the `reboot` command re-enumerates USB, so the serial
          // link drops — send it, log it, and let realdev observe the disconnect.
          this.realdev.send('reboot');
          if (this.session.log) this.session.log('tx', 'reboot');
        } else {
          this.session.reboot();
        }
        this.setState({ rebootArm: false });
      },
      rebootLabel: st.rebootArm ? 'CONFIRM — REBOOT NOW' : 'REBOOT DEVICE',
      rebootDisabled: !(S && S.connected) || !!(S && S.rebooting),
      rebootStyle: this.btn(false, !(S && S.connected) || !!(S && S.rebooting)) + (st.rebootArm ? ';border-color:var(--acq);color:var(--acq)' : ''),
    };
  }

  // Open a real Mk IV over Web Serial. MUST be reached from a click (Web Serial
  // requires a user gesture for the port picker) — used by both the Connect button
  // and the clickable header status.
  async connectRealDevice() {
    if (!this.realdev || (this.session && this.session.S.connected)) return;
    this._devCaps = null;   // unknown until this device's config.txt is read (assume full meanwhile)
    try {
      await this.realdev.connect();
      try { localStorage.setItem('pcc.realDeviceSeen', '1'); } catch (e) { /* private mode */ }
      this.restoreSkyHistory('real');   // reload/unplug continuity — a real sky only restores into a real session
      this.setState({});
    } catch (e) {
      if (this.session) this.session.log('rx', 'ERR: ' + ((e && e.message) || 'connect cancelled'), true);
      this.setState({});
    }
  }

  // The port identifier shown in the header and Connect room. Never invent an OS
  // device path: for real hardware Web Serial only exposes the USB id (S.portLabel),
  // and the simulator has no port at all.
  portName(S) {
    if (!S || !S.connected) return '—';
    if (S.real) return S.portLabel ? 'MK IV · ' + S.portLabel : 'MK IV · USB SERIAL';
    return 'SIMULATED';
  }

  rvConnect() {
    const st = this.state;
    const S = this.session && this.session.S;
    const conn = !!(S && S.connected);
    const realSeen = typeof localStorage !== 'undefined' && localStorage.getItem('pcc.realDeviceSeen') === '1';
    const serialOk = typeof navigator !== 'undefined' && 'serial' in navigator;
    const ctxOk = typeof window !== 'undefined' && window.isSecureContext;
    const chrom = typeof window !== 'undefined' && !!window.chrome;
    return {
      cPort: this.portName(S),
      cDevice: conn ? (S.real ? 'Precision Clock Mk IV · STM32 CDC' : 'Emulated Mk IV · no hardware') : '—',
      cSession: S ? this.fmtDur(Date.now() / 1000 - S.t0) : '—',
      cFix: S && S.fix.valid ? '3D · HDOP ' + S.fix.hdop.toFixed(2) : (conn ? (S.scenario === 'nofix' ? 'NO FIX' : 'ACQUIRING') : '—'),
      cSats: S && conn ? S.fix.sats + ' / ' + S.sats.filter((x) => x.visible).length : '—',
      cAge: S && S.fix.valid && S.fixAgeT ? ((Date.now() - S.fixAgeT) / 1000).toFixed(1) + ' s' : '—',
      // Real Mk IV over Web Serial (requires a genuine user gesture for requestPort).
      onConnectReal: () => this.connectRealDevice(),
      // Explore with a simulation — a clearly-labelled demo for anyone without hardware. NEVER
      // greyed out (a visitor with no clock is exactly who needs it); only unavailable while a
      // real Mk IV is connected, since sim and real never coexist.
      simOn: !!st.sim,
      simBtnDisabled: !!(S && S.real),
      onConnect: () => this.setSim(!this.state.sim),
      onDisconnect: () => {
        if (!conn) return;
        if (S && S.real && this.realdev) this.realdev.disconnect(); else if (this.session) this.session.disconnect();
        if (this.session) this.session.log('tx', 'CLOSE');
        this.setState({ scenario: 'locked' }); this.syncFaces();
      },
      // Read config.txt off the mounted CLOCK drive → initialise the face to the
      // device's REAL state (colon, enabled modes, brightness, zone). Serial can't
      // read config back, so this is the only accurate-init path.
      onReadConfig: async () => {
        if (!this.realdev) return;
        try {
          const r = await this.realdev.readConfigFile();
          this.applyDeviceConfig(r.cfg);
          this.cfgHandle = r.fh; this._cfgOriginal = r.text; // handle/original are not serialisable state
          if (this.els.cfgEditor) this.els.cfgEditor.value = r.text;
          const en = Object.values(r.cfg.modes || {}).filter(Boolean).length;
          if (this.session.log) this.session.log('rx', `[config] ${r.name}: colon=${r.cfg.colon || '?'} · ${en} modes enabled — applied to face`);
          this.setState({ cfgName: r.name, cfgDirty: false });
        } catch (e) {
          if (e && e.name === 'AbortError') return; // user dismissed the picker
          if (this.session) this.session.log('rx', 'config read failed: ' + ((e && e.message) || e), true);
          this.setState({});
        }
      },
      onCfgInput: () => { const t = this.els.cfgEditor ? this.els.cfgEditor.value : ''; const d = t !== (this._cfgOriginal || ''); if (d !== st.cfgDirty) this.setState({ cfgDirty: d }); },
      onCfgRevert: () => { if (this.els.cfgEditor) this.els.cfgEditor.value = this._cfgOriginal || ''; this.setState({ cfgDirty: false }); },
      onCfgWriteToggle: () => { const v = !st.cfgWrite; try { localStorage.setItem('pccweb.cfgWrite', v ? '1' : '0'); } catch (e) {} this.setState({ cfgWrite: v }); },
      onCfgSave: async () => {
        const t = this.els.cfgEditor && this.els.cfgEditor.value;
        if (!this.cfgHandle || t == null || !st.cfgWrite || !st.cfgDirty) return;
        try {
          await this.realdev.writeConfigFile(this.cfgHandle, t);
          this._cfgOriginal = t;
          if (this.session && this.session.log) this.session.log('tx', `[config] wrote ${st.cfgName} (${t.length} bytes) to the CLOCK drive`);
          this.setState({ cfgDirty: false });
        } catch (e) {
          if (this.session) this.session.log('tx', 'config write failed: ' + ((e && e.message) || e), true);
        }
      },
      cbCfgWrite: this.cb(st.cfgWrite),
      cfgHasFile: !!this.cfgHandle,
      cfgSaveDisabled: !(st.cfgDirty && st.cfgWrite && this.cfgHandle),
      cfgSaveStyle: this.btn(false, !(st.cfgDirty && st.cfgWrite && this.cfgHandle)),
      readCfgDisabled: this.appMode() === 'standby' || !(typeof window !== 'undefined' && 'showOpenFilePicker' in window),
      readCfgStyle: this.btn(false, this.appMode() === 'standby' || !(typeof window !== 'undefined' && 'showOpenFilePicker' in window)),
      // SIMULATE is a toggle, never greyed by history — only blocked while a real device is live.
      realDisabled: conn || !serialOk, connectDisabled: !!(S && S.real), discDisabled: !conn,
      btnRealStyle: this.btn(true, conn || !serialOk), btnConnStyle: this.btn(false, !!(S && S.real)), btnDiscStyle: this.btn(false, !conn),
      simBtnLabel: st.sim ? 'STOP SIMULATION' : 'SIMULATE',
      realSeen, isReal: !!(S && S.real),
      supSerial: serialOk ? 'AVAILABLE' : 'NOT AVAILABLE', supSerialC: serialOk ? 'var(--lock)' : 'var(--none)',
      supCtx: ctxOk ? 'SECURE' : 'INSECURE', supCtxC: ctxOk ? 'var(--lock)' : 'var(--none)',
      supChrom: chrom ? 'CHROMIUM' : 'NON-CHROMIUM', supChromC: chrom ? 'var(--lock)' : 'var(--acq)',
      gateVisible: !serialOk || !ctxOk,
    };
  }

  rvSats() {
    const st = this.state, S = this.session && this.session.S;
    const out = {
      cbHeat: this.cb(st.skyHeatmap), oHeat: () => this.setState({ skyHeatmap: !st.skyHeatmap }, () => this.drawChart('sky')),
      cbHoriz: this.cb(st.skyHorizon), oHoriz: () => this.setState({ skyHorizon: !st.skyHorizon }, () => this.drawChart('sky')),
      cbTrails: this.cb(st.skyTrails), oTrails: () => this.setState({ skyTrails: !st.skyTrails }, () => this.drawChart('sky')),
      cbLabels: this.cb(st.skyLabels), oLabels: () => this.setState({ skyLabels: !st.skyLabels }, () => this.drawChart('sky')),
      ssWinLive: this.seg(st.window === 120, true), ssWin15: this.seg(st.window === 900, false), ssWin1h: this.seg(st.window === 3600, false), ssWinAll: this.seg(st.window === 5400, false),
      oWinLive: () => this.setState({ window: 120 }, () => this.drawChart('sky')),
      oWin15: () => this.setState({ window: 900 }, () => this.drawChart('sky')),
      oWin1h: () => this.setState({ window: 3600 }, () => this.drawChart('sky')),
      oWinAll: () => this.setState({ window: 5400 }, () => this.drawChart('sky')),
      ssTrail15: this.seg(st.skyTrailAge === 900, true), ssTrail45: this.seg(st.skyTrailAge === 2700, false), ssTrail90: this.seg(st.skyTrailAge === 5400, false),
      oTrail15: () => this.setState({ skyTrailAge: 900 }, () => this.drawChart('sky')),
      oTrail45: () => this.setState({ skyTrailAge: 2700 }, () => this.drawChart('sky')),
      oTrail90: () => this.setState({ skyTrailAge: 5400 }, () => this.drawChart('sky')),
    };
    if (!S) {
      Object.assign(out, { fLat: '—', fLon: '—', fAlt: '—', fHdop: '—', fFix: '—', fSatsUV: '—', fGrid: '—', cSunAlt: '—', cSunAz: '—', cMoonAlt: '—', cMoonAz: '—', cMoonPhase: '—', cMoonIllum: '—', cRise: '—', cSet: '—', sStarted: '—', sPasses: '—', sObs: '—', sPeak: '—', sCover: '—', nGps: '·', nGlo: '·', nGal: '·', nBds: '·' });
      return out;
    }
    const sun = this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon);
    const moon = this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon);
    const times = this.SIM.sunTimes(Date.now(), S.obs.lat, S.obs.lon);
    const vis = S.sats.filter((x) => x.visible);
    const cnt = (id) => vis.filter((x) => x.constId === id).length;
    Object.assign(out, {
      fLat: S.fix.valid ? this.ll(S.fix.lat, true) : '—',
      fLon: S.fix.valid ? this.ll(S.fix.lon, false) : '—',
      fAlt: S.fix.valid ? S.fix.alt.toFixed(1) + ' m' : '—',
      fHdop: S.fix.valid ? S.fix.hdop.toFixed(2) : '—',
      fFix: S.fix.valid ? '3D FIX' : (S.connected ? (S.scenario === 'acquiring' ? 'ACQUIRING' : 'NO FIX') : 'NO DEVICE'),
      fSatsUV: S.fix.sats + ' / ' + vis.length,
      fGrid: this.SIM.maidenhead(S.obs.lat, S.obs.lon).toUpperCase(),
      cSunAlt: sun.el.toFixed(1) + '°', cSunAz: sun.az.toFixed(1) + '°',
      cMoonAlt: moon.el.toFixed(1) + '°', cMoonAz: moon.az.toFixed(1) + '°',
      cMoonPhase: moon.phaseName, cMoonIllum: Math.round(moon.illum * 100) + '%',
      cRise: times ? this.hhmm(times.rise) + ' UTC' : '—',
      cSet: times ? this.hhmm(times.set) + ' UTC' : '—',
      sStarted: new Date(S.t0 * 1000).toISOString().slice(11, 19) + ' UTC',
      sPasses: String(S.passes),
      sObs: S.obsCount > 1000 ? (S.obsCount / 1000).toFixed(1) + 'k' : String(S.obsCount),
      sPeak: S.peakEl.toFixed(1) + '°',
      sCover: Math.round(S.bins.size / (36 * 9) * 100) + '%',
      nGps: String(cnt('G')), nGlo: String(cnt('R')), nGal: String(cnt('E')), nBds: String(cnt('C')),
    });
    return out;
  }

  rvSignal() {
    const st = this.state, S = this.session && this.session.S;
    return {
      cbMedian: this.cb(st.sigMedian), oMedian: () => this.setState({ sigMedian: !st.sigMedian }, () => this.drawChart('cn0elev')),
      ssFilAll: this.seg(st.sigFilter === 'all', true), ssFilG: this.seg(st.sigFilter === 'G', false), ssFilR: this.seg(st.sigFilter === 'R', false), ssFilE: this.seg(st.sigFilter === 'E', false), ssFilC: this.seg(st.sigFilter === 'C', false),
      oFilAll: () => this.setState({ sigFilter: 'all' }, () => this.drawChart('cn0time')),
      oFilG: () => this.setState({ sigFilter: 'G' }, () => this.drawChart('cn0time')),
      oFilR: () => this.setState({ sigFilter: 'R' }, () => this.drawChart('cn0time')),
      oFilE: () => this.setState({ sigFilter: 'E' }, () => this.drawChart('cn0time')),
      oFilC: () => this.setState({ sigFilter: 'C' }, () => this.drawChart('cn0time')),
      barRows: !S ? [] : S.sats.filter((x) => x.el > 0).sort((a, b) => b.cn0 - a.cn0).slice(0, 18).map((x) => ({
        key: x.key, color: 'var(--' + x.tok + ')',
        w: Math.min(100, x.cn0 / 55 * 100).toFixed(1) + '%',
        val: x.cn0.toFixed(1), el: Math.round(x.el) + '°',
        dim: x.used ? '1' : '0.45',
        valColor: x.used ? 'var(--txt-hi)' : 'var(--txt)',   // DIM = UNUSED: used values read brightest
      })),
    };
  }

  rvPosition() {
    const st = this.state, P = this._pos || { cep: 0, drms: 0, sigE: 0, sigN: 0, me: 0, mn: 0, n: 0 };
    const S = this.session && this.session.S;
    const mlat = S ? S.obs.lat + P.mn / 111320 : 0;
    const mlon = S ? S.obs.lon + P.me / (111320 * Math.cos((S.obs.lat || 0) * Math.PI / 180)) : 0;
    return {
      pCep: P.cep.toFixed(2) + ' m', pDrms: P.drms.toFixed(2) + ' m',
      pSigE: P.sigE.toFixed(2) + ' m', pSigN: P.sigN.toFixed(2) + ' m',
      pMeanLat: S && P.n ? this.ll(mlat, true) : '—',
      pMeanLon: S && P.n ? this.ll(mlon, false) : '—',
      pN: String(P.n),
      ssPwin15: this.seg(st.posWindow === 900, true), ssPwin30: this.seg(st.posWindow === 1800, false), ssPwin1h: this.seg(st.posWindow === 3600, false),
      oPwin15: () => this.setState({ posWindow: 900 }, () => { this.onTickStats(); this.drawCharts(); }),
      oPwin30: () => this.setState({ posWindow: 1800 }, () => { this.onTickStats(); this.drawCharts(); }),
      oPwin1h: () => this.setState({ posWindow: 3600 }, () => { this.onTickStats(); this.drawCharts(); }),
      ttffLabel: S ? S.ttff.toFixed(1) + ' s' : '—',
    };
  }

  rvTiming() {
    const T = this._timing || {};
    const fit = T.fit;
    const S = this.session && this.session.S;
    // $PMTXTS is implemented in DRAFT firmware PRs (gated by `pps = on`) — not yet
    // merged upstream. The banner reflects where the stream is coming from right now.
    const streaming = !!(S && S.pps && S.pps.list && S.pps.list.length);
    const noPps = !!(S && S.real && !streaming); // real hardware, no PPS stream yet → dash the timing KPIs
    const noData = !streaming;                   // NO live PPS at all (standby, or real-without-stream) → nothing honest to show
    const banner = S && S.real
      ? (streaming ? '$PMTXTS · LIVE · DRAFT FW (pps=on)' : '$PMTXTS · SEND "pps = on" TO STREAM')
      : (S && S.connected ? '$PMTXTS · SIMULATED STREAM' : '$PMTXTS · DRAFT-FIRMWARE FEATURE — pps=on');
    return {
      ppsBanner: banner,
      ppsBannerC: (S && S.real && streaming) ? 'var(--lock)' : 'var(--acq)',
      // Real device with no $PMTXTS yet (stock FW, or before `pps = on`): the KPIs
      // have no honest value — dash them rather than show stale sim scalars or 0s.
      // In sim mode `streaming` is true (sim fills pps.list), so tiles show as before.
      // Robust jitter on real hardware is ns-scale — show ns below 1 µs instead of "0.0 µs".
      ...((() => {
        const f = (v, dp) => v > 0 && v < 1 ? [String(Math.max(1, Math.round(v * 1000))), 'ns'] : [v.toFixed(dp), 'µs'];
        const [jv, ju] = f(T.rms || 0, 1), [pv, pu] = f(T.p2p || 0, 0);
        return noData ? { tJitter: '—', tJitterU: 'µs', tP2p: '—', tP2pU: 'µs' }
                      : { tJitter: jv, tJitterU: ju, tP2p: pv, tP2pU: pu };
      })()),
      tDrift: noData ? '—' : (T.ppm || 0).toFixed(2), tHold: noData ? '—' : (T.locked ? '0' : String(T.hold || 0)),
      tHoldSub: noData ? 'NO PPS — CONNECT A CLOCK OR SIMULATE' : (T.locked ? 'GPS DISCIPLINED' : 'FREE-RUNNING — LSE (TEMP COMP HOST-SIDE)'),
      tTemp: noData ? '—' : (T.temp || 0).toFixed(1), tSeq: noData ? '—' : String(T.seq || 0), tDrop: noData ? '—' : String(T.drop || 0),
      fitK0: fit ? fit.k0.toFixed(4) : '—', fitK1: fit ? fit.k1.toFixed(5) : '—', fitK2: fit ? fit.k2.toFixed(6) : '—',
      fitSpread: fit ? fit.spread.toFixed(1) + ' °C' : '—',
      fitRms: fit ? fit.rms.toFixed(2) + ' ppm' : '—',
      fitN: fit ? String(fit.n) : '0',
      fitStatus: fit ? (fit.ready ? (fit.lineOnly ? 'READY — LINE FIT' : 'READY — QUADRATIC') : 'COLLECTING — NEED ≥30 SAMPLES / ≥8 °C') : 'AWAITING SAMPLES',
      fitStatusC: fit && fit.ready ? 'var(--lock)' : 'var(--acq)',
      // Emit the tempcomp firmware's REAL seed vocabulary (tc_t0 / tc_lse_a/b/c / tc_seed) — the
      // legacy `temp_comp = k0,k1,k2` key was never parsed by any firmware. The block is only shown
      // once the fit is trustworthy (ready); before that a comment says what's still needed, so a
      // half-baked curve can't be pasted into config.txt by accident. tc_dump stays canonical.
      compState: noData ? 'IDLE — NO TIMING STREAM' : (fit && fit.ready ? 'FIT READY — SEED BLOCK FOR config.txt' : 'CHARACTERISING — BLOCK PENDING'),
      compStateC: noData ? 'var(--txt3)' : (fit && fit.ready ? 'var(--lock)' : 'var(--txt2)'),
      compLine: fit && fit.ready && this.PT
        ? this.PT.tcSeedBlock({ k0: fit.k0, k1: fit.k1, k2: fit.k2, tlo: fit.tMin, thi: fit.tMax, n: fit.n, rms: fit.rms }).configBlock
        : (fit ? `# characterising — need ≥30 samples & ≥8 °C span (have ${fit.n}, ${fit.spread.toFixed(1)} °C)` : '# tc seed — awaiting timing stream'),
    };
  }

  rvGlobe() {
    const st = this.state, S = this.session && this.session.S;
    const sun = S ? this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon) : null;
    const vis = S ? S.sats.filter((x) => x.visible) : [];
    const cnt = (id) => vis.filter((x) => x.constId === id).length;
    return {
      cbGTerm: this.cb(st.globeTerm), oGTerm: () => this.setState({ globeTerm: !st.globeTerm }, () => this.drawChart('globe')),
      cbGTrails: this.cb(st.globeTrails), oGTrails: () => this.setState({ globeTrails: !st.globeTrails }, () => this.drawChart('globe')),
      cbGLabels: this.cb(st.globeLabels), oGLabels: () => this.setState({ globeLabels: !st.globeLabels }, () => this.drawChart('globe')),
      cbGGrat: this.cb(st.globeGrat), oGGrat: () => this.setState({ globeGrat: !st.globeGrat }, () => this.drawChart('globe')),
      cbGRot: this.cb(st.globeRotate), oGRot: () => this.setState({ globeRotate: !st.globeRotate }),
      cbGClock: this.cb(st.globeClock), oGClock: () => this.setState({ globeClock: !st.globeClock }),
      globeClockOn: st.globeClock,
      gSub: sun ? sun.subLat.toFixed(1) + '° / ' + sun.subLon.toFixed(1) + '°' : '—',
      gVis: S ? 'G' + cnt('G') + ' · R' + cnt('R') + ' · E' + cnt('E') + ' · C' + cnt('C') : '—',
      gClock: new Date().toISOString().slice(11, 19) + ' UTC',
      landNote: this.landTried && !this.land ? 'COASTLINE DATA UNAVAILABLE — GRATICULE ONLY' : 'CARTOGRAPHIC RENDER — PRODUCTION USES PHOTOGRAPHIC EARTH',
    };
  }

  rvWeather() {
    const st = this.state, S = this.session && this.session.S;
    const W = S ? S.weather : null;
    const dirName = (d) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16];
    const push = W ? (W.temp.toFixed(1) + 'C ' + W.code.slice(0, 3) + ' ' + Math.round(W.rh) + 'RH ' + Math.round(W.mslp) + 'HPA') : '';
    return {
      wxOffline: st.wxOffline,
      wxOnline: !st.wxOffline,
      cbWxOff: this.cb(st.wxOffline), oWxOff: () => this.setState({ wxOffline: !st.wxOffline }),
      onWxRetry: () => this.setState({ wxOffline: false }),
      wTemp: W ? W.temp.toFixed(1) + ' °C' : '—', wApp: W ? W.app.toFixed(1) + ' °C' : '—',
      wRh: W ? Math.round(W.rh) + ' %' : '—', wMslp: W ? W.mslp.toFixed(1) + ' hPa' : '—',
      wWind: W ? W.wind.toFixed(1) + ' m/s ' + dirName(W.dir) : '—',
      wGust: W ? W.gust.toFixed(1) + ' m/s' : '—',
      wPrecip: W ? W.precip.toFixed(1) + ' mm/h' : '—',
      wCloud: W ? Math.round(W.cloud) + ' %' : '—',
      wCode: W ? W.code : '—',
      wAsOf: W && W.asOf ? new Date(W.asOf).toISOString().slice(11, 16) + ' UTC' : '—',
      wPos: S && S.fix.valid ? this.ll(S.fix.lat, true) + '  ' + this.ll(S.fix.lon, false) : 'NO FIX — LAST KNOWN',
      pushPreview: push.length > 10 ? push + '  ·  MARQUEE' : push,
      onWxPush: () => { if (!W || st.wxOffline) return; this.marqOff = 0; this.set2({ mode: 'text', text: push, standby: false, diag: 'off' }); },
      ssWivOff: this.seg(st.wxInterval === 'off', true), ssWiv5: this.seg(st.wxInterval === '5', false), ssWiv15: this.seg(st.wxInterval === '15', false),
      oWivOff: () => this.setState({ wxInterval: 'off' }), oWiv5: () => this.setState({ wxInterval: '5' }), oWiv15: () => this.setState({ wxInterval: '15' }),
    };
  }

  rvMonitor() {
    const st = this.state, S = this.session && this.session.S;
    const src = st.monPaused ? (this._monFrozen || []) : (S ? S.nmeaLog : []);
    return {
      monRows: src.slice(-240).map((l) => {
        if (l._id == null) l._id = (this._monN = (this._monN || 0) + 1); // stable id → row-node reuse
        return {
          k: l._id,
          ts: new Date(l.t).toISOString().slice(11, 22),
          tag: l.dir === 'tx' ? 'TX' : 'RX',
          tagStyle: 'font-weight:700;color:' + (l.dir === 'tx' ? 'var(--led)' : 'var(--txt3)'),
          txtStyle: 'color:' + (l.err ? 'var(--none)' : l.dir === 'tx' ? 'var(--led)' : 'var(--txt)'),
          text: l.text,
        };
      }),
      monRate: S && S.connected ? S.nmeaRate + ' LINES/S' : '0 LINES/S',
      cbPaused: this.cb(st.monPaused),
      oPaused: () => { if (!st.monPaused && S) this._monFrozen = S.nmeaLog.slice(); this.setState({ monPaused: !st.monPaused }); },
      cbAuto: this.cb(st.monAutoscroll), oAuto: () => this.setState({ monAutoscroll: !st.monAutoscroll }),
      onClear: () => { if (S) { S.nmeaLog.length = 0; this._monFrozen = []; this.setState({}); } },
      onSendCmd: () => this.sendCmd(),
      onCmdKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.sendCmd(); } },
    };
  }

  // DEVICE→UPDATES "FIRMWARE & DATA": what firmware the in-app emulator IS (version + exact
  // clock4 commit the WASM was compiled from — build.mjs writes build-info.json), the tz data
  // shipped alongside, and a user-triggered GitHub check of the rollup branch head.
  rvFirmware() {
    const bi = this.buildInfo;
    const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
    const zone = (() => { try { const z = this.emu && this.emu.tz(); return z && z.zone ? z.zone : null; } catch (e) { return null; } })();
    const upd = this._fwUpd || { s: '', c: 'var(--txt3)' };
    return {
      fwVer: bi ? bi.version + ' — WASM, BUILT FROM SOURCE' : 'BUILT FROM SOURCE (run build.mjs for provenance)',
      fwSrc: bi ? 'clock4 @ ' + bi.fwSha.slice(0, 7) + ' (' + bi.fwBranch + ')' : 'web/emu/firmware submodule',
      fwBuilt: bi ? bi.builtAt + (bi.emcc ? ' · emcc ' + bi.emcc : '') : '—',
      fwTz: (bi && bi.tzrules ? 'IANA RULES ' + kb(bi.tzrules) : 'IANA RULES (tzrules.bin)')
        + (bi && bi.tzmap ? ' · ZONEDETECT MAP ' + kb(bi.tzmap) + ' (LAZY)' : ' · ZONEDETECT MAP (LAZY)')
        + (zone ? ' · ACTIVE ' + zone.toUpperCase() : ''),
      fwUpdState: upd.s, fwUpdC: upd.c,
      onFwCheck: () => {
        this._fwUpd = { s: 'CHECKING GITHUB…', c: 'var(--txt2)' };
        this.setState({});
        fetch('https://api.github.com/repos/peterlewis/clock4/commits/rollup', { headers: { Accept: 'application/vnd.github+json' } })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((j) => {
            const sha = j.sha || '';
            const date = ((j.commit || {}).committer || {}).date || '';
            const head = sha.slice(0, 7) + (date ? ' · ' + date.slice(0, 10) : '');
            this._fwUpd = !sha ? { s: 'CHECK FAILED — UNEXPECTED RESPONSE', c: 'var(--acq)' }
              : (bi && bi.fwSha === sha) ? { s: 'UP TO DATE — rollup @ ' + head, c: 'var(--lock)' }
              : bi ? { s: 'NEWER FIRMWARE ON rollup — ' + head + ' (BUILT FROM ' + bi.fwSha.slice(0, 7) + ')', c: 'var(--acq)' }
              : { s: 'rollup HEAD ' + head + ' — LOCAL BUILD COMMIT UNKNOWN', c: 'var(--txt2)' };
            this.setState({});
          })
          .catch(() => { this._fwUpd = { s: 'CHECK FAILED — OFFLINE OR RATE-LIMITED', c: 'var(--acq)' }; this.setState({}); });
      },
    };
  }

  rvExport() {
    const S = this.session && this.session.S;
    const fx = S ? S.posHist.length : 0;
    const rx = S ? S.nmeaLog.filter((l) => l.dir === 'rx').length : 0;
    return {
      eStarted: S ? new Date(S.t0 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—',
      eDur: S ? this.fmtDur(Date.now() / 1000 - S.t0) : '—',
      eFixes: String(fx),
      eObs: S ? String(S.obsCount) : '0',
      eLines: rx + ' (RING BUFFER 420)',
      ePps: S ? String(S.pps.list.length) : '0',
      eCsvN: fx + ' ROWS · ≈' + Math.max(1, Math.round(fx * 0.1)) + ' KB',
      eGpxN: Math.ceil(fx / 5) + ' TRKPTS',
      eNmeaN: rx + ' SENTENCES',
      eSatN: (() => {
        if (!S) return '0 PTS';
        let pts = 0; for (const tr of S.trails.values()) pts += tr.length;
        return pts + ' PTS · ' + S.trails.size + ' SATS';
      })(),
      onDlCsv: () => this.session && this.dl('pcc-session.csv', 'text/csv', this.session.toCSV()),
      onDlJson: () => this.session && this.dl('pcc-session.json', 'application/json', this.session.toJSON()),
      onDlGpx: () => this.session && this.dl('pcc-session.gpx', 'application/gpx+xml', this.session.toGPX()),
      onDlNmea: () => this.session && this.dl('pcc-session.nmea', 'text/plain', this.session.toNMEA()),
      onDlSat: () => this.session && this.dl('pcc-session-sats.csv', 'text/csv', this.session.toSatCSV()),
      // Persistent telemetry log (IndexedDB) — the data-safety controls. Opt-in; never simulation.
      cbTelLog: this.cb(!!(this.telemetryLog && this.telemetryLog.enabled)),
      onTelLog: () => { if (!this.telemetryLog) return; this.telemetryLog.setEnabled(!this.telemetryLog.enabled); this.setState({}); },
      telStat: (() => { const s = this._telStats; return s ? (s.rows.toLocaleString() + ' SAMPLES · ' + s.sessions + ' SESSION' + (s.sessions === 1 ? '' : 'S') + (s.kb ? ' · ' + (s.kb > 1024 ? (s.kb / 1024).toFixed(1) + ' MB' : s.kb + ' KB') : '')) : '—'; })(),
      telRetVal: String(this.telemetryLog ? this.telemetryLog.retention : 604800),
      onTelRet: (e) => { if (this.telemetryLog) this.telemetryLog.setRetention(+e.target.value).then(() => this.refreshTelStats()); },
      onTelClear: () => {
        if (!this.telemetryLog) return;
        if (!confirm('Delete all persisted telemetry? Session history is kept; the recorded stream is erased. This cannot be undone.')) return;
        this.telemetryLog.clear().then(() => {
          // Drop the in-memory scrub model + repaint the (now empty) timeline STRAIGHT AWAY, rather
          // than leaving stale charts until the user navigates away and back (which reloads openReview).
          if (this._reviewing) this.exitReview();   // nothing left to drive the rooms from
          this._review = null;
          this.reviewPause();
          this.renderReview();                       // wipes the canvas (no model) + refreshes the readout
          return this.refreshTelStats();
        });
      },
      onTelExport: async () => {
        if (!this.telemetryLog) return;
        const sess = await this.telemetryLog.sessions();
        if (!sess.length) { alert('No recorded sessions yet.'); return; }
        const s = sess[0];   // newest session
        const rows = await this.telemetryLog.range(s.sessionId, 0, 2 ** 31);
        const head = 't,lat,lon,alt,hdop,pdop,sats,fixType,cn0avg,temp,ppm\n';
        const body = rows.map((r) => {
          const f = r.fix || {}, p = r.pps || {}; let c = 0, cn = 0;
          for (const x of r.sats) { if (x.cn0 > 0) { c += x.cn0; cn++; } }
          return [r.t, f.lat ?? '', f.lon ?? '', f.alt ?? '', f.hdop ?? '', f.pdop ?? '', f.sats ?? '', f.type ?? '', cn ? (c / cn).toFixed(1) : '', p.temp ?? '', p.ppm ?? ''].join(',');
        }).join('\n');
        this.dl('pcc-telemetry-' + s.sessionId + '.csv', 'text/csv', head + body);
      },
      // Rewind / scrub over the persisted log.
      ...(() => { const r = this.reviewReadout(); return {
        rvTime: r.time, rvPos: r.disconnected ? 'CLOCK DISCONNECTED' : r.pos, rvFix: r.disconnected ? '—' : r.fix,
        rvSats: r.disconnected ? '—' : r.sats, rvTemp: r.disconnected ? '—' : r.temp, rvSkew: r.disconnected ? '—' : r.skew,
        rvHasData: r.has, rvNoData: !r.has, rvPlayLabel: r.playing ? '❚❚ PAUSE' : '▶ PLAY',
      }; })(),
      onReviewPlayPause: () => { this._reviewPlaying ? this.reviewPause() : this.reviewPlay(); },
      onReviewReload: () => this.openReview(),
      // Drive the whole app (Sky / Signal / Position / Timing + the face) from the playhead.
      reviewDriveLabel: this._reviewing ? '● REVIEWING — EXIT TO LIVE' : 'DRIVE ROOMS FROM SCRUB →',
      reviewDriveStyle: this._reviewing
        ? 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:#fff;background:var(--beta,#f5b53d);border:1px solid var(--beta,#f5b53d);border-radius:5px;padding:7px 15px;cursor:pointer'
        : 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--face-led,#ff4530);background:transparent;border:1px solid var(--face-led,#ff4530);border-radius:5px;padding:7px 15px;cursor:pointer',
      onReviewDrive: () => { this._reviewing ? this.exitReview() : this.enterReview(); },
    };
  }
  // Refresh the persistent-log stats shown in the Export room (async IndexedDB counts).
  async refreshTelStats() {
    if (!this.telemetryLog) return;
    try {
      const [rows, sessions, bytes] = await Promise.all([this.telemetryLog.count(), this.telemetryLog.sessions(), this.telemetryLog.estimateBytes()]);
      this._telStats = { rows, sessions: sessions.length, kb: Math.round(bytes / 1024) };
      this.setState({});
    } catch (e) { /* ignore */ }
  }

  // ---------- REWIND / SCRUB over the persisted telemetry log -----------------
  // Load every session's samples into one scrub model, spanning the whole log,
  // with connected/disconnected segments derived from the sample runs.
  async openReview() {
    if (!this.telemetryLog) return;
    try {
      const sessions = await this.telemetryLog.sessions();
      let samples = [];
      for (const s of sessions) {                      // newest-first; cap total for a sane first load
        const rows = await this.telemetryLog.range(s.sessionId, 0, 2 ** 31);
        samples = samples.concat(rows);
        if (samples.length > 200000) break;            // safety cap; scrub still decimates to pixels
      }
      this._review = prepReview(sessions, samples);
      this.reviewPause();
      this.renderReview();
    } catch (e) { console.warn('openReview failed', e); }
  }
  renderReview() {
    const cv = this.els.reviewCanvas, R = this._review;
    if (cv) {
      if (R) { try { drawReview(cv, R); } catch (e) { /* canvas not laid out yet */ } }
      // No model (e.g. the log was just cleared) — wipe the timeline so it doesn't keep stale pixels
      // until the next navigation reloads openReview(). Match the canvas backing size, not CSS px.
      else { try { const g = cv.getContext('2d'); if (g) g.clearRect(0, 0, cv.width, cv.height); } catch (e) {} }
    }
    this.setState({});   // refresh the readout below the timeline
  }
  reviewSeek(t) {
    if (!this._review) return;
    this._review.playT = Math.max(this._review.tMin, Math.min(this._review.tMax, t));
    this.renderReview();
    if (this._reviewing) this.applyReviewFrame(this._review.playT);   // drive the rooms to the playhead
  }
  reviewPlay() {
    if (!this._review || this._reviewTimer) return;
    this._reviewPlaying = true;
    let last = performance.now();
    const SPEED = 120;   // 120× real time
    const step = () => {
      if (!this._reviewPlaying || !this._review) return;
      const now = performance.now(), dt = (now - last) / 1000; last = now;
      let t = this._review.playT + dt * SPEED;
      if (t >= this._review.tMax) { t = this._review.tMax; this.reviewPause(); }
      this._review.playT = t; this.renderReview();
      if (this._reviewing) this.applyReviewFrame(t);   // playback drives the rooms too
      if (this._reviewPlaying) this._reviewTimer = requestAnimationFrame(step);
    };
    if (this._review.playT >= this._review.tMax) this._review.playT = this._review.tMin;   // restart from the top
    this._reviewTimer = requestAnimationFrame(step);
    this.setState({});
  }
  reviewPause() {
    this._reviewPlaying = false;
    if (this._reviewTimer) { cancelAnimationFrame(this._reviewTimer); this._reviewTimer = null; }
    this.setState({});
  }
  // Pointer scrubbing on the timeline canvas (wired in initEl).
  _reviewPointer(e) {
    const cv = this.els.reviewCanvas; if (!cv || !this._review) return;
    const r = cv.getBoundingClientRect();
    this.reviewPause();
    this.reviewSeek(tAtX(this._review, e.clientX - r.left));
  }
  // Values at the playhead — the scrub read-out.
  reviewReadout() {
    const off = { time: '—', pos: '—', fix: '—', sats: '—', temp: '—', skew: '—', has: false, playing: false };
    const R = this._review; if (!R || !R.samples.length) return off;
    const s = sampleAt(R, R.playT);
    const d = new Date(R.playT * 1000);
    const time = d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    if (!s) return { ...off, time, has: true, disconnected: true, playing: !!this._reviewPlaying };
    const f = s.fix, p = s.pps;
    return {
      time, has: true, disconnected: false, playing: !!this._reviewPlaying,
      pos: f ? f.lat.toFixed(5) + ', ' + f.lon.toFixed(5) : 'no fix',
      fix: f ? ((f.type === 3 ? '3D' : f.type >= 1 ? '2D' : 'NONE') + (f.hdop != null ? ' · HDOP ' + f.hdop.toFixed(2) : '')) : 'no fix',
      sats: f && f.sats != null ? String(f.sats) : String(s.sats ? s.sats.length : 0),
      temp: p && p.temp != null ? p.temp.toFixed(1) + ' °C' : '—',
      skew: p && p.phaseUs != null ? p.phaseUs.toFixed(2) + ' µs' : '—',
    };
  }

  // ---- REVIEW MODE — the scrub drives the whole app to the playhead time ----
  // Reconstruct session.S (sats, fix, and every history buffer the rooms read) from the log
  // window up to t, so Sky / Signal / Position / Timing render the PAST with no room changes.
  reconstructReview(t, W = 1800) {
    const R = this._review, S = this.session && this.session.S;
    if (!R || !S) return;
    const win = R.samples.filter((r) => r.t >= t - W && r.t <= t);
    const D2R = Math.PI / 180;
    let refLat = S.obs && S.obs.lat, refLon = S.obs && S.obs.lon;
    const firstFix = win.find((r) => r.fix);
    if ((refLat == null || refLon == null) && firstFix) { refLat = firstFix.fix.lat; refLon = firstFix.fix.lon; }
    const cosRef = Math.cos((refLat || 0) * D2R);
    const posHist = [], dopHist = [], fixHist = [], cn0Hist = new Map(), trails = new Map(), ppsList = [], ppsSamples = [];
    let lastPpm = null;
    for (const r of win) {
      if (r.fix) {
        posHist.push({ t: r.t, e: (r.fix.lon - refLon) * 111320 * cosRef, n: (r.fix.lat - refLat) * 111320, lat: r.fix.lat, lon: r.fix.lon, alt: r.fix.alt });
        dopHist.push({ t: r.t, h: r.fix.hdop, p: r.fix.pdop, v: r.fix.vdop });
        fixHist.push({ t: r.t, type: r.fix.type, sats: r.fix.sats });
      }
      for (const s of r.sats) {
        const key = s.key || ('G' + String(s.prn).padStart(2, '0'));
        let h = cn0Hist.get(key); if (!h) { h = []; cn0Hist.set(key, h); } h.push({ t: r.t, v: s.cn0 });
        let tr = trails.get(key); if (!tr) { tr = []; trails.set(key, tr); } tr.push({ t: r.t, az: s.az, el: s.el, cn0: s.cn0 });
      }
      if (r.pps) {
        if (r.pps.phaseUs != null) ppsList.push({ t: r.t, us: r.pps.phaseUs });
        if (r.pps.temp != null && r.pps.ppm !== lastPpm) { ppsSamples.push({ t: r.t, temp: r.pps.temp, ppm: r.pps.ppm }); lastPpm = r.pps.ppm; }
      }
    }
    const cur = win.length ? win[win.length - 1] : null;
    S.sats = (cur ? cur.sats : []).map((s) => ({
      key: s.key || ('G' + String(s.prn).padStart(2, '0')), prn: s.prn, constId: s.constId || 'G', tok: s.tok || 'gps',
      talker: s.talker || 'GP', sysId: s.sysId || 1, az: s.az, el: s.el, cn0: s.cn0, used: s.used,
      visible: s.el != null && s.el > 0, geo: { lat: NaN, lon: NaN },
    }));
    if (cur && cur.fix) S.fix = { valid: true, lat: cur.fix.lat, lon: cur.fix.lon, alt: cur.fix.alt, hdop: cur.fix.hdop, pdop: cur.fix.pdop, vdop: cur.fix.vdop, type: cur.fix.type, sats: cur.fix.sats };
    else S.fix = { ...S.fix, valid: false, type: 0, sats: 0 };
    S.posHist = posHist; S.dopHist = dopHist; S.fixHist = fixHist; S.cn0Hist = cn0Hist; S.trails = trails;
    S.pps = S.pps || {}; S.pps.list = ppsList; S.pps.samples = ppsSamples;
    if (cur && cur.pps) { S.pps.temp = cur.pps.temp; S.pps.ppm = cur.pps.ppm; S.pps.calerr = cur.pps.calerr; }
  }
  enterReview() {
    if (this._reviewing || !this._review) return;
    const S = this.session.S;
    // Snapshot COPIES, not references: review reconstruction mutates the live buffers in place, so a
    // reference snapshot let those edits leak — corrupting the live PPS/position stream on exit.
    // Copying the arrays/Maps/pps.list means exitReview's Object.assign truly restores them untouched.
    const cpArr = (a) => (Array.isArray(a) ? a.slice() : a);
    this._liveSnap = {
      sats: cpArr(S.sats), fix: { ...S.fix },
      posHist: cpArr(S.posHist), dopHist: cpArr(S.dopHist), fixHist: cpArr(S.fixHist),
      cn0Hist: S.cn0Hist instanceof Map ? new Map(S.cn0Hist) : S.cn0Hist,
      trails: S.trails instanceof Map ? new Map(S.trails) : S.trails,
      pps: S.pps ? { ...S.pps, list: cpArr(S.pps.list) } : S.pps,
    };
    this._reviewing = true;
    this.applyReviewFrame(this._review.playT);
  }
  exitReview() {
    if (!this._reviewing) return;
    this._reviewing = false;
    const s = this._liveSnap, S = this.session.S;
    if (s) Object.assign(S, s);   // restore the live buffers untouched
    this._liveSnap = null;
    this.reviewPause();
    if (this.drawCharts) this.drawCharts();
    this.setState({});
  }
  applyReviewFrame(t) {
    if (!this._reviewing || !this._review) return;
    this.reconstructReview(t);
    if (this.drawCharts) this.drawCharts();   // repaint whichever room's charts are mounted
    this.setState({});
  }
  // Paint the six emulator faces to a wall-clock time (STANDBY = now; REVIEW = the playhead).
  paintFaceAt(d) {
    const two = (n) => [Math.floor(n / 10), n % 10];
    const big = [...two(d.getHours()), ...two(d.getMinutes()), ...two(d.getSeconds())];
    const dateRow = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const frame = { dateRow, time: { mode: 'cells', big, small: ['DASH', 'DASH', 'DASH'], dp: false, colonsOn: true, colonStep: 0 } };
    const bright = Math.pow(this.state.brightness, this.state.gamma);
    for (const k of this.EMU_FACES) {
      const f = this.faces[k]; if (!f) continue;
      if (f._emuColon !== 'solid') { f.setColonMode('solid'); f._emuColon = 'solid'; }
      if (f._emuBright !== bright) { f.setBrightness(bright); f._emuBright = bright; }
      f.applyDeviceFrame(frame);
    }
  }
}

// ---- boot ----
const PROPS = { glowIntensity: 0.55, ghostIntensity: 1, foldTempo: 0.8, entry: 'fold' };
const app = new Component(PROPS);
window.__pcc = app;
app.mount(document.getElementById('root'));
