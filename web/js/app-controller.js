// app-controller.js — the PCC Web application body, ported VERBATIM from the
// Claude-Design prototype (PCC Web.dc.html), reparented onto the vanilla DcLite
// runtime. All state, the fold sequence, the 14 renderVals builders, and the 1 Hz
// tick are unchanged; only 'extends DCLogic' -> 'extends DcLite' and the boot differ.
import { DcLite } from './dc-lite.js?v=91';
import * as ASTRO from './astro-fw.js?v=90';
import * as DS from './datasources.js?v=90';
import { TelemetryLog } from './telemetrylog.js?v=4';
import { prepReview, drawReview, sampleAt, tAtX } from './review.js?v=1';
import { subSatellitePoint } from './satpass.js?v=1';
import { parsePMSTAR, parsePMADEV } from './pmext.mjs?v=1';
import { DEFAULT_CONFIG, configToState, stateToConfig } from './default-config.js?v=5';
import { REC as PF_REC, RANGE as PF_RANGE, modelStream, runPrefilter } from './prefilter.mjs?v=2';

// config.txt is the single source of truth: the clock-behaviour defaults (enabled modes, colon,
// astro dwell, …) are DERIVED from the canonical golden config, not hand-written here. See
// default-config.js. UI-only state (theme, panels, sim, gamma, marquee) stays app-owned below.
const CONFIG_DEFAULTS = configToState(DEFAULT_CONFIG);

class Component extends DcLite {
  state = {
    phase: 'boot', entryVisible: true, docked: false, drawerOpen: false, hdrPose: 'open',
    facePose: (typeof localStorage !== 'undefined' && localStorage.getItem('pccweb.facePose')) || 'flat',
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
    // SIGNAL PATH explainer knobs (TIMING room). Defaults = the shipped recommended values (PF_REC);
    // session-only — this is a tuning explainer, not a persisted preference. seed drives the sample
    // stream; freeze halts the sweep for inspection. source is DERIVED (spSyncSource), never chosen:
    // 'real' when a pccd connection streams raw samples, 'model' (sample data) only while a
    // simulation runs, 'none' otherwise — the panel shows an honest absence instead of a demo.
    sp: { K: PF_REC.k, window: PF_REC.window, group: PF_REC.group, floorUs: PF_REC.floorUs, corrRatio: PF_REC.corrRatio, seed: 0x9e37, freeze: false, source: 'none' },
    tzOverride: 'auto', matrixFreq: '1.6',
    skyHeatmap: false, skyHorizon: false, skyTrails: true, skyLabels: true,
    appStale: false,   // the served app moved under this tab (pccd overlay refresh / Pages deploy) — offer a reload
    // SPAN (s): how much ribbon each sat drags in the sky/map/globe views. With 12 h of
    // restored history a full 90 min per sat reads as clutter, so default mid (45 min); 5400 = MAX
    // (the fade horizon / the full trail buffer — pre-control behaviour, bit-for-bit).
    skyTrailAge: 2700,
    sigMedian: true, sigFilter: 'all',
    posWindow: 1800,
    globeTerm: true, globeTrails: true, globeLabels: false, globeGrat: true, globeRotate: true, globeClock: true,
    // GROUND TRACK: one tab, two projections of the same scene — the globe* layer toggles drive
    // both (the old separate map* set existed only because the views were separate tabs).
    groundProj: 'globe',
    wxOffline: false, wxInterval: 'off',
    monPaused: false, monAutoscroll: true, monFilter: '',
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
    // Closing the tab is the normal way to leave — stamp the open session's disconnectAt so it
    // isn't orphaned (an un-stamped session never prunes and stretches the scrub timeline).
    window.addEventListener('pagehide', () => { try { this.telemetryLog && this.telemetryLog.endSession(); } catch (e) {} });
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
    Promise.all([import('./clockface.js?v=91'), import('./clockface-svg.js?v=114'), import('./sim.js?v=101'), import('./charts.js?v=108'), import('./realdev.js?v=117'), import('./emu-driver.js?v=37'), import('./ppsts.js?v=15'), import('./settings-bin.js?v=2')]).then(([CF, CFSVG, SIM, CH, RD, ED, PT, SB]) => {
      this.CF = CF; this.CFSVG = CFSVG; this.SIM = SIM; this.CH = CH; this.RD = RD; this.ED = ED; this.PT = PT; this.SB = SB;
      try { localStorage.removeItem('pccweb.cuckoo'); } catch (e) {}   // parked feature's persisted setting — clear the ghost
      this.session = SIM.createSession({ preroll: 1560 });
      this.realdev = RD.createRealDevice(this.session); // real Mk IV over Web Serial -> same session.S
      // pccd bridge presence: probed at boot and refreshed every 15 s. Drives the Connection
      // room's live BRIDGE row and un-gates CONNECT DEVICE in browsers without Web Serial.
      const probeBridge = () => {
        if (this._pccdUpdating) return;   // don't null bridgeInfo mid-update — it would unmount the panel + its live progress
        return this.realdev.detectBridge().then((j) => {
        const next = j || null;
        if (JSON.stringify(next) !== JSON.stringify(this.state.bridgeInfo || null)) this.setState({ bridgeInfo: next });
        // First time we see a bridge this session, check GitHub once for a newer pccd (prompts in UPDATES).
        if (next && !this._pccdChecked) { this._pccdChecked = true; setTimeout(() => this.checkPccdUpdate(false), 600); }
        // ...and, for a web-refresh-capable daemon, compare the served app to the latest on Pages.
        if (next && next.webrefresh && !this._appChecked) { this._appChecked = true; setTimeout(() => this.checkAppFromPages(), 750); }
        // Keep the archive panels fed: self-healing (a first fetch can race module/bridge readiness)
        // and cheap (fetchArchive caches for 60 s and no-ops without a recorder).
        if (next && next.history) this.fetchArchive();
      }).catch(() => {});
      };
      probeBridge();
      this.bridgeTimer = setInterval(probeBridge, 15000);
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
      CH.loadLand().then((l) => { this.land = l; this.landTried = true; if (this.state.section === 'ground') this.drawChart(this.state.groundProj === 'flat' ? 'map' : 'globe'); });
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
    const s = ['connect', 'devmodes', 'devbright', 'devconfig', 'devadvanced', 'devupdates', 'display', 'satellites', 'signal', 'position', 'timing', 'ground', 'archive', 'monitor', 'export'];
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
            faceOpts.onButtonDown = (btn) => this.onFaceButtonDown(btn);   // chord protocol (hold both → menu)
            faceOpts.onButtonUp = (btn) => this.onFaceButtonUp(btn);
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
    if (name === 'signalPath') { this.spCompute(); this.drawChart('signalPath'); return; }   // paint on mount; the timing room-hook kicks the intro sweep
    if (['sky', 'cn0elev', 'cn0time', 'posScatter', 'dop', 'cont', 'phase', 'stair', 'ppmtemp', 'adev', 'archOffset', 'archAux', 'archSky', 'gammaCurve', 'map'].includes(name)) this.drawChart(name);
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
    // Sat data is CelesTrak-only now — no synthetic fallback. Honest tag: the real count when we have
    // TLEs (live or cached), else why we don't (policy block vs simply no data yet).
    const sats = s.satsReal ? (this.emu.sats().length + ' REAL SATS IN VIEW')
      : (s.satBlocked ? 'SAT DATA BLOCKED (CELESTRAK)' : 'NO SAT DATA');
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

  emuSourceTag() {
    const mode = this.appMode();
    if (mode === 'connected') return 'LIVE · MK IV';
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
      // With a pccd archive on the bridge host, that is the system of record — this store becomes a
      // paint cache for instant reload, so the bulky series keep only a short tail. Web Serial (no
      // daemon) and sim sessions keep the full depth: nothing else records those.
      cn0: [...S.cn0Hist.entries()].map(([k, h]) => [k, h.slice(this.state.bridgeInfo && this.state.bridgeInfo.history && S.real ? -120 : -600)]),
      posHist: (this.state.bridgeInfo && this.state.bridgeInfo.history && S.real) ? S.posHist.slice(-600) : S.posHist,
      dopHist: (this.state.bridgeInfo && this.state.bridgeInfo.history && S.real) ? S.dopHist.slice(-600) : S.dopHist,
      fixHist: (this.state.bridgeInfo && this.state.bridgeInfo.history && S.real) ? S.fixHist.slice(-600) : S.fixHist,
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
    // MENU OPEN → the firmware's menu display owns the face in every state (the physical menu works
    // with or without GPS). paintEmuFrame reads the firmware's live buffers, which menu_poll updated.
    if (this.emu && this.emu.menuState && this.emu.menuState().layer !== 0) { this.paintEmuFrame(); return; }
    const mode = this.appMode();
    if (mode === 'standby' || !this.emu) {   // STANDBY: honest host time, no GPS, no virtual anything
      // Self-healing, not edge-triggered: assert live=false EVERY frame we're not CONNECTED. A
      // stuck live flag (any _emuLive mirror desync — remounts, mid-transition edges) silently
      // froze the virtual GPS mid-acquisition: clock ticking, sats aged to 0, fix never arriving.
      if (this.emu) { this.emu.setLive(false); this._emuLive = false; }
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
    } else {   // NOT connected → the virtual GPS owns the firmware. Unconditional (same self-healing
      // rationale as the standby branch): setLive(false) is a boolean store, free at frame rate.
      this.emu.setLive(false); this._emuLive = false;
      // SIMULATION: feed the sim's $PMTXTS phase (the same openly-synthetic samples the PHASE chart
      // plots) into the firmware's OWN ADEV accumulator via emu_adev_push — the WASM shim has no
      // live DWT cycle counter, so the firmware's internal PPS path can't self-feed (its gap detector
      // resets on every edge). The real reduction pipeline — overlapping ADEV, 4m maturity gates,
      // octave cache, $PMADEV formatting — then runs on the sim's phase. A connected clock never
      // takes this path: its ladder arrives ready-made in its own $PMADEV stream (S.stab).
      if (this.emu.adevPush && this.PT && this.PT.parsePMTXTS) {
        const log = this.session.S.nmeaLog || [];
        if (!this._adevFed) this._adevFed = new WeakSet();   // object-identity dedupe (survives the log's front-trim)
        for (let i = 0; i < log.length; i++) {
          const it = log[i];
          if (!it || typeof it !== 'object' || this._adevFed.has(it)) continue;
          this._adevFed.add(it);
          if (it.dir !== 'rx' || typeof it.text !== 'string' || !it.text.startsWith('$PMTXTS,')) continue;
          const r = this.PT.parsePMTXTS(it.text);
          if (r && isFinite(r.phaseMs)) {
            const us = (r.phaseMs > 500 ? r.phaseMs - 1000 : r.phaseMs) * 1000;  // centre across the boundary (like centrePhase)
            this.emu.adevPush(us * 80);                                          // µs → DWT ticks @ 80 MHz
          }
        }
      }
    }
    const t = performance.now();
    this.emu.tick(t - (this._emuLast || t));
    this._emuLast = t;
    this.paintEmuFrame();
  }

  // Read the firmware's latched segment buffers and push them onto the six emulator-driven faces.
  paintEmuFrame() {
    const frame = this.emu.frame();
    // Colon fix-tell — the canonical hardware affordance: an animated colon means a live
    // GPS-disciplined fix; the firmware HOLDS it SOLID whenever it lacks one (acquiring, or
    // holdover after signal loss). The emulator's colonStep free-runs, so gate it here — the
    // same rule applyFaceState applies to JS faces (noFixFreeze) and the FORMATS caption
    // documents. Without this a DROP-GPS scenario kept pulsing the colons as if still locked.
    const pr = this.emu.precision ? this.emu.precision() : null;
    const heldSolid = pr ? !(pr.hadPps && pr.signal !== false) : false;
    const colon = heldSolid ? 'solid' : this.emu.colonName();
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
    this.driveCuckoo(frame);
  }

  // FIRMWARE cuckoo animations (the clock4 `cuckoo` branch): when the engine's dither interleave
  // is running, render its per-segment levels on the time face through the same setSegField
  // same setSegField surface — the firmware is the choreographer, the face is a screen.
  // On branches without the engine (rollup today) cuckooActive() is a constant 0 and this is
  // inert. Level rows: 0..5 = the six big digits, 6..8 = ds/cs/ms; colons stay on their own
  // TIM2 PWM path (the field's colon values come from computeField as usual).
  driveCuckoo(frame) {
    if (!this.emu || !this.emu.cuckooActive) return;
    // Both time faces: the open display AND the folded entry clock — a cuckoo that fires while
    // the clock is folded plays on the fold. (The firmware separately refuses to start pieces
    // in MODE_STANDBY, the hardware's true "closed" state, and displayOff aborts a running one.)
    const targets = [this.faces.dispTime, this.faces.entryTime, this.faces.hdrTime].filter((f) => f && f.setSegField);
    if (!targets.length) return;
    if (!this.emu.cuckooActive()) {
      if (this._ckOn) { this._ckOn = false; for (const t of targets) t.setSegField(null); }
      return;
    }
    for (const t of targets) {
      const field = t.computeField({ time: frame.time }, Date.now());
      const geo = t.segGeometry();
      for (const e of geo.els) {
        if (e.kind !== 'digit') continue;
        const row = e.role === 'big' ? e.src : (e.role === 'small' ? 6 + e.src : -1);
        if (row < 0 || !field[e.cell]) continue;
        const f = field[e.cell];
        for (let s = 0; s < 7; s++) if (f.segs[s] > 0) f.segs[s] = this.emu.cuckooLevel(row, s) / 16;
        if (f.dp > 0) f.dp = this.emu.cuckooLevel(row, 7) / 16;
      }
      t.setSegField(field);
    }
    this._ckOn = true;
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


  // Closing the docked clock IS closing the hinge, and it is THE ENTRY FOLD RUN BACKWARDS —
  // in-plane, about the seam pins, the hinge axis pointing at the viewer (never a 3D turn: the
  // Mk IV has no such axis). The reverse of stacked->flat is flat->STACKED, so the closed dock
  // is the DESK POSE: date row above time row, both ticking, hinge plate vertical at their left
  // — the entry splash at header scale. Nothing is ever hidden.
  //
  // The reverse arc swings the leaf ABOVE the hinge and the header sits at the viewport top, so
  // the fold does what a person would: TAKE THE CLOCK OFF THE SHELF, FOLD IT, PUT IT BACK.
  //   beat 0  lift-out — the dock descends into the room (clearance = one board length)
  //   beat 1  cartwheel, first 90° — the leaf rises to vertical; the LUT switches at the top
  //   beat 2  cartwheel, second 90° + the double-hinge row-step — the leaf lays down one row up;
  //           its 180° of turn cancels the board's mounting flip exactly as the hardware's does
  //   beat 3  the stacked clock flies back onto the shelf, scaled to the 46px budget
  // Reopen is the same four beats mirrored. Degrades to an instant pose swap when animation is
  // unavailable, like every fold in the app.
  async foldHdrClock(toClosed) {
    if (this._hdrFolding) return;
    const pose = toClosed ? 'closed' : 'open';
    if (this.state.hdrPose === pose) return;
    const E = this.els, M = this.MM;
    const wrap = E.hdrFoldWrap, inner = E.hdrFoldInner, dh = E.hdrDateHalf, th = E.hdrTimeHalf, link = E.hdrLink;
    const dock = E.dockSlot ? E.dockSlot.querySelector('[data-dockbar]') : null;
    if (!this.canAnimate() || !wrap || !inner || !dh || !th || !dock) {
      this.setState({ hdrPose: pose, hdrPoseAuto: false }); this.sizeHdrBar(); return;
    }
    this._hdrFolding = true;
    const ease = 'cubic-bezier(.5,.03,.16,1)', easeMove = 'cubic-bezier(.55,.02,.14,1)';
    const face = () => this.faces.hdrDate;
    const anims = [];
    const play = (el, kf, opts) => { const a = el.animate(kf, opts); anims.push(a); return a; };
    // THE ENTRY'S LINKAGE, copied: the leaf rotates 90° about the DATE-SIDE pin (inner wrap) while
    // the outer wrap — CARRYING THE PLATE — rotates 90° about the TIME-SIDE pin. The plate never
    // animates on its own; it rides the outer wrap, exactly like the original unfold. The glide
    // home is MEASURED from the leaf's landed position, so the linkage's true geometry (not an
    // approximation) decides where things are at every frame.
    const O0 = dock.getBoundingClientRect();   // the dock's rest frame, captured before any transform
    try {
      if (toClosed) {
        const Wk = parseFloat(dh.style.width) || 0, Hk = parseFloat(dh.style.height) || 0;
        const kk = Hk / M.H, pin = 6 * kk;
        const k2 = Math.min(46 / (2 * M.H), 2 * Wk / M.W);
        const s = (M.W * k2) / Wk, D = Wk + 24;
        dock.style.zIndex = '80'; dock.style.transformOrigin = '0 0';
        wrap.style.transformOrigin = (Wk + pin) + 'px ' + pin + 'px';    // time-side pin
        inner.style.transformOrigin = (Wk - pin) + 'px ' + pin + 'px';   // date-side pin
        play(dock, [{ transform: 'translateY(0px)' }, { transform: 'translateY(' + D + 'px)' }],
          { duration: 220, easing: easeMove, fill: 'forwards' });
        play(wrap, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }],
          { duration: 560, delay: 140, easing: ease, fill: 'forwards' });
        play(inner, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }],
          { duration: 500, delay: 320, easing: ease, fill: 'forwards' });
        this.sleep(520).then(() => face() && face().setInverted(false));  // the switch, at the top of the arc
        await this.sleep(840);
        // Glide home, measured: wherever the linkage actually put the stack, take it to the origin.
        const S = dh.getBoundingClientRect();
        const px = S.left - O0.left, py = S.top - D - O0.top;
        play(dock, [{ transform: 'translateY(' + D + 'px)' },
                    { transform: 'translate(' + (-s * px) + 'px,' + (-s * py) + 'px) scale(' + s + ')' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        play(dock, [{ width: (2 * Wk) + 'px' }, { width: (M.W * k2) + 'px' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        await this.sleep(320);
      } else {
        const Wc = parseFloat(dh.style.width) || 0;
        const C = dh.getBoundingClientRect();   // the closed mini's leaf, at rest
        const avail = this.hdrDockAvail();
        const kOpen = Math.min(46 / M.H, Math.max(avail === null ? 2 * Wc : avail, 0) / (2 * M.W));
        const Wk = M.W * kOpen, Hk = M.H * kOpen, pin = 6 * kOpen, D = Wk + 24;
        dock.style.zIndex = '80'; dock.style.transformOrigin = '0 0';
        if (face()) face().setInverted(false);
        // ONE synchronous block: open statics at full scale + both wraps held folded (INLINE
        // transforms — reflected by forced layout, unlike pending WAAPI) + a dock transform that
        // pixel-matches the closed mini's rest. No intermediate paint.
        dock.style.width = Wc + 'px'; dock.style.height = parseFloat(dh.style.height) * 2 + 'px';
        dh.style.left = '0px'; dh.style.top = '0px'; dh.style.width = Wk + 'px'; dh.style.height = Hk + 'px'; dh.style.transform = 'rotate(180deg)';
        th.style.left = Wk + 'px'; th.style.top = '0px'; th.style.width = Wk + 'px'; th.style.height = Hk + 'px';
        if (E.hdrDate) this.sizeFaceCanvas('hdrDate', E.hdrDate, dh, kOpen, 7.0175);
        if (E.hdrTime) this.sizeFaceCanvas('hdrTime', E.hdrTime, th, kOpen, 7.0175);
        if (link) { link.style.left = (Wk - 12 * kOpen) + 'px'; link.style.top = '0px';
          link.style.width = (24 * kOpen) + 'px'; link.style.height = (12 * kOpen) + 'px'; link.style.borderRadius = (6 * kOpen) + 'px'; }
        wrap.style.transformOrigin = (Wk + pin) + 'px ' + pin + 'px'; wrap.style.transform = 'rotate(90deg)';
        inner.style.transformOrigin = (Wk - pin) + 'px ' + pin + 'px'; inner.style.transform = 'rotate(90deg)';
        dock.style.transform = 'none';
        const L0 = dh.getBoundingClientRect();  // forced layout, no paint yet
        const sc = C.width / L0.width;
        const tx = (C.left - O0.left) - sc * (L0.left - O0.left), ty = (C.top - O0.top) - sc * (L0.top - O0.top);
        dock.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
        await this.raf2();
        // Fly out to full scale, descended; the dock's layout width grows in step.
        play(dock, [{ transform: dock.style.transform }, { transform: 'translateY(' + D + 'px)' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        play(dock, [{ width: Wc + 'px' }, { width: (2 * Wk) + 'px' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        await this.sleep(310);
        // The unfold — the entry's own order: leaf first, wrap (with the plate) following.
        wrap.style.transform = ''; inner.style.transform = '';
        play(inner, [{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }],
          { duration: 500, easing: ease, fill: 'forwards' });
        play(wrap, [{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }],
          { duration: 560, delay: 180, easing: ease, fill: 'forwards' });
        this.sleep(340).then(() => face() && face().setInverted(true));
        await this.sleep(760);
        play(dock, [{ transform: 'translateY(' + D + 'px)' }, { transform: 'translateY(0px)' }],
          { duration: 280, easing: easeMove, fill: 'forwards' });
        await this.sleep(300);
      }
    } finally {
      // Land the final pose through the ONE writer of dock statics, then drop the transients.
      this._hdrFolding = false;
      this.setState({ hdrPose: pose, hdrPoseAuto: false });
      this.sizeHdrBar();
      for (const a of anims) { try { a.cancel(); } catch (e) {} }
    }
  }

  sizeDispBar(retry) {
    const E = this.els;
    // Watch the wrap itself, exactly as the header dock is watched. sizeDispBar derives the scale
    // from wrap.clientWidth, and on a narrow first paint that width can be settled-but-wrong: the
    // room mounts, the bar sizes against a width the layout has not finished narrowing, and the
    // retry guard does not catch it because clientWidth is non-zero, merely stale. The clock then
    // stays too wide — cut off at the room edge — until some later window resize happens to fire.
    // That breaks the one rule the face has: ALWAYS SHOW THE WHOLE CLOCK. An observer on the wrap
    // closes it, because the container's own width change is the true trigger, not the window's.
    if (typeof ResizeObserver !== 'undefined' && E.dispWrap && this._dispROel !== E.dispWrap) {
      // dc-lite recreates the wrap on layout changes, so re-point at the live node rather than
      // leaving the observer on a detached one.
      if (this._dispRO) this._dispRO.disconnect();
      this._dispRO = this._dispRO || new ResizeObserver(() => {
        if (this._faceFolding) return;                 // a pose fold owns the bar; don't fight it
        const w = this.els.dispWrap ? this.els.dispWrap.clientWidth : 0;
        if (!w || w === this._dispROw) return;         // width unchanged -> no echo loop
        this._dispROw = w;
        this.sizeDispBar();
      });
      this._dispROel = E.dispWrap;
      this._dispROw = 0;
      this._dispRO.observe(E.dispWrap);
    }
    // Width comes from the DOM parent chain, NOT the dispWrap ref — on remount the canvas
    // ref fires before dispWrap re-attaches, but the canvas's own parent holders are always
    // in the DOM with a real width. This makes sizing independent of ref-callback order.
    // Chain: dateHalf > foldInner > foldWrap (0×0 rotation anchors) > dispBar (absolute stage) > dispWrap.
    const wrap = E.dispDateHalf && E.dispDateHalf.parentElement && E.dispDateHalf.parentElement.parentElement &&
      E.dispDateHalf.parentElement.parentElement.parentElement &&
      E.dispDateHalf.parentElement.parentElement.parentElement.parentElement;
    if (!E.dispDateHalf || !E.dispTimeHalf || !wrap || wrap.clientWidth < 2) {
      if ((retry || 0) < 30 && this.state.section === 'display') {
        cancelAnimationFrame(this._dispRAF);
        this._dispRAF = requestAnimationFrame(() => this.sizeDispBar((retry || 0) + 1));
      }
      return;
    }
    const M = this.MM;
    if (this._faceFolding) return;          // a pose fold is choreographing the bar — don't fight it
    const avail = Math.max(120, wrap.clientWidth - 4);
    const kFlat = avail / (2 * M.W); // fill the available width; on phones this drops below 1 so the wide bar fits
    // AUTO-POSE: on narrow layouts the 20-digit line goes sub-legible while the desk pose is twice
    // the digit height in the same width — prefer STACKED there unless the user chose explicitly.
    if (!this._facePoseUser && this.state.section === 'display') {
      const wantStack = M.H * kFlat < 56;
      const cur = this.state.facePose;
      if (wantStack && cur !== 'stacked') { this.setState({ facePose: 'stacked' }); return; }
      if (!wantStack && cur === 'stacked' && !((typeof localStorage !== 'undefined') && localStorage.getItem('pccweb.facePose'))) { this.setState({ facePose: 'flat' }); return; }
    }
    const stacked = this.state.facePose === 'stacked';
    // Desk-pose digits earn a bump over the line (that is the pose's point) but stay bounded so a
    // desktop stack doesn't balloon: min(full width, 1.4× the flat scale).
    const k = stacked ? Math.min(avail / M.W, 1.4 * kFlat) : kFlat;
    const Wk = M.W * k, Hk = M.H * k;
    const bar = E.dispBar, dh = E.dispDateHalf, th = E.dispTimeHalf, fw = E.dispFoldWrap;
    for (const el of [dh, th]) { el.style.width = Wk + 'px'; el.style.height = Hk + 'px'; }
    if (bar) { bar.style.width = (stacked ? Wk : 2 * Wk) + 'px'; bar.style.height = (stacked ? 2 * Hk : Hk) + 'px'; bar.style.transform = ''; }
    if (fw) { fw.style.display = ''; fw.style.transform = ''; }
    if (E.dispFoldInner) E.dispFoldInner.style.transform = '';
    if (stacked) {
      // The desk pose: date directly above time, shared left edge — the entry stage's own layout.
      dh.style.left = '0px'; dh.style.top = '0px'; dh.style.transform = '';
      th.style.left = '0px'; th.style.top = Hk + 'px';
      if (this.faces.dispDate) this.faces.dispDate.setInverted(false);
    } else {
      dh.style.left = '0px'; dh.style.top = '0px'; dh.style.transform = 'rotate(180deg)';
      th.style.left = Wk + 'px'; th.style.top = '0px';
      if (this.faces.dispDate) this.faces.dispDate.setInverted(true);
    }
    if (E.dispDate) this.sizeFaceCanvas('dispDate', E.dispDate, dh, k, 7.0175);
    if (E.dispTime) this.sizeFaceCanvas('dispTime', E.dispTime, th, k, 7.0175);
    if (E.dispShadow) {
      // The contact pool under the object, whatever its pose — the entry's floorShadow, kept.
      const pw = (stacked ? Wk : 2 * Wk) + 16;
      E.dispShadow.style.width = pw + 'px';
      E.dispShadow.style.left = 'calc(50% - ' + (pw / 2) + 'px)';
    }
    // Reveal only now the bar is at its computed size. The markup ships it visibility:hidden
    // at the 620px MAX default; showing it before this line is what let it flash "far too
    // large then snap back" on any layout whose computed width is under that default.
    if (E.dispBar) E.dispBar.style.visibility = 'visible';
    if (E.dispLink) {
      const L = E.dispLink;
      const pd = 3.2 * k;   // pins scale with the bar (no px floor) — a min clamp made them chunky when small
      // dispLink has a 1px border; its abs-positioned pins anchor to the CONTENT box
      // (inside that border), which shoves the pair 1px off the seam — the left dot ends
      // up closer to the hinge than the right. Subtract the border so the two dots sit
      // exactly symmetric about the seam (and centred vertically).
      const bw = 1;
      const pinEl = (el, cx, cy) => { if (!el) return; el.style.left = (cx - bw - pd / 2) + 'px'; el.style.top = (cy - bw - pd / 2) + 'px'; el.style.width = pd + 'px'; el.style.height = pd + 'px'; };
      if (stacked) {
        // Vertical plate straddling the row seam at the shared left edge — the entry's own hinge.
        L.style.left = '0px'; L.style.top = (Hk - 12 * k) + 'px';
        L.style.width = (12 * k) + 'px'; L.style.height = (24 * k) + 'px'; L.style.borderRadius = (6 * k) + 'px';
        pinEl(E.dispPinA, 6 * k, 6 * k); pinEl(E.dispPinB, 6 * k, 18 * k);
      } else {
        L.style.left = (Wk - 12 * k) + 'px'; // centre the hinge on the flush seam (border-box boundary at Wk)
        L.style.top = '0px';
        L.style.width = (24 * k) + 'px'; L.style.height = (12 * k) + 'px'; L.style.borderRadius = (6 * k) + 'px';
        pinEl(E.dispPinA, 6 * k, 6 * k); pinEl(E.dispPinB, 18 * k, 6 * k);
      }
    }
  }

  // The FACE hero's pose fold — the same four beats as the header's, at hero scale: lift out of
  // the slot into the room, the in-plane cartwheel about the seam (LUT switch at the top of the
  // arc, the leaf's 180° cancelling the mounting flip), then settle back into the slot in the new
  // pose. sizeDispBar owns both poses' statics and lands the result.
  async foldFacePose(toStacked) {
    if (this._faceFolding) return;
    const pose = toStacked ? 'stacked' : 'flat';
    if (this.state.facePose === pose) return;
    const E = this.els, M = this.MM;
    const wrap = E.dispFoldWrap, inner = E.dispFoldInner, dh = E.dispDateHalf, th = E.dispTimeHalf, bar = E.dispBar;
    this._facePoseUser = true;
    try { localStorage.setItem('pccweb.facePose', pose); } catch (e) {}
    if (!this.canAnimate() || !wrap || !inner || !dh || !th || !bar || this.state.section !== 'display') {
      this.setState({ facePose: pose }); this.sizeDispBar(); return;
    }
    this._faceFolding = true;
    const ease = 'cubic-bezier(.5,.03,.16,1)', easeMove = 'cubic-bezier(.55,.02,.14,1)';
    const face = () => this.faces.dispDate;
    const link = E.dispLink;
    const anims = [];
    const play = (el, kf, opts) => { const a = el.animate(kf, opts); anims.push(a); return a; };
    // The entry's linkage, same as the header fold: leaf 90° about the DATE-SIDE pin (inner wrap),
    // outer wrap — carrying the plate — 90° about the TIME-SIDE pin. The plate rides the wrap.
    // The glide home is MEASURED, with the flex-centred bar's recentering folded into the target.
    try {
      if (toStacked) {
        const Wk = parseFloat(dh.style.width) || 0, Hk = parseFloat(dh.style.height) || 0;
        const kk = Hk / M.H, pin = 6 * kk;
        const avail = Math.max(120, (bar.parentElement ? bar.parentElement.clientWidth : 2 * Wk) - 4);
        const kS = Math.min(avail / M.W, 1.4 * kk);       // stacked scale, same law as sizeDispBar
        const s = kS / kk, WS = M.W * kS;
        const O0 = bar.getBoundingClientRect();
        const D = Math.max(60, Wk + 24 - (O0.top - 60));   // clearance above the seam for the rising leaf
        bar.style.zIndex = '60'; bar.style.transformOrigin = '0 0';
        wrap.style.transformOrigin = (Wk + pin) + 'px ' + pin + 'px';    // time-side pin
        inner.style.transformOrigin = (Wk - pin) + 'px ' + pin + 'px';   // date-side pin
        play(bar, [{ transform: 'translateY(0px)' }, { transform: 'translateY(' + D + 'px)' }],
          { duration: 220, easing: easeMove, fill: 'forwards' });
        play(wrap, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }],
          { duration: 560, delay: 140, easing: ease, fill: 'forwards' });
        play(inner, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }],
          { duration: 500, delay: 320, easing: ease, fill: 'forwards' });
        this.sleep(520).then(() => face() && face().setInverted(false));
        await this.sleep(840);
        // Measured glide: take the landed stack to where the stacked statics will paint it —
        // the bar recentres when its width narrows, so the target shifts right by half the delta.
        const S = dh.getBoundingClientRect();
        const px = S.left - O0.left, py = S.top - D - O0.top;
        const tx = (2 * Wk - WS) / 2 - s * px, ty = -s * py;
        play(bar, [{ transform: 'translateY(' + D + 'px)' },
                   { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        await this.sleep(320);
      } else {
        // Reverse: swap to flat statics held folded (pixel-matched to the stacked rest), fly out,
        // unfold — leaf first, wrap with the plate following — then glide home flat.
        const C = dh.getBoundingClientRect();   // the stacked rest's leaf
        const avail = Math.max(120, (bar.parentElement ? bar.parentElement.clientWidth : 240) - 4);
        const kF = avail / (2 * M.W);
        const Wk = M.W * kF, Hk = M.H * kF, pin = 6 * kF, D = Wk + 24;
        bar.style.zIndex = '60'; bar.style.transformOrigin = '0 0';
        if (face()) face().setInverted(false);
        // ONE synchronous block, no intermediate paint: flat statics + wraps held folded INLINE
        // (reflected by forced layout, unlike pending WAAPI) + a bar transform matching the rest.
        bar.style.width = (2 * Wk) + 'px'; bar.style.height = Hk + 'px';
        dh.style.left = '0px'; dh.style.top = '0px'; dh.style.width = Wk + 'px'; dh.style.height = Hk + 'px'; dh.style.transform = 'rotate(180deg)';
        th.style.left = Wk + 'px'; th.style.top = '0px'; th.style.width = Wk + 'px'; th.style.height = Hk + 'px';
        if (E.dispDate) this.sizeFaceCanvas('dispDate', E.dispDate, dh, kF, 7.0175);
        if (E.dispTime) this.sizeFaceCanvas('dispTime', E.dispTime, th, kF, 7.0175);
        if (link) { link.style.left = (Wk - 12 * kF) + 'px'; link.style.top = '0px';
          link.style.width = (24 * kF) + 'px'; link.style.height = (12 * kF) + 'px'; link.style.borderRadius = (6 * kF) + 'px'; }
        wrap.style.transformOrigin = (Wk + pin) + 'px ' + pin + 'px'; wrap.style.transform = 'rotate(90deg)';
        inner.style.transformOrigin = (Wk - pin) + 'px ' + pin + 'px'; inner.style.transform = 'rotate(90deg)';
        bar.style.transform = 'none';
        const OB = bar.getBoundingClientRect(), L0 = dh.getBoundingClientRect();  // forced layout, no paint
        const sc = C.width / L0.width;
        const tx = (C.left - OB.left) - sc * (L0.left - OB.left), ty = (C.top - OB.top) - sc * (L0.top - OB.top);
        bar.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
        await this.raf2();
        play(bar, [{ transform: bar.style.transform }, { transform: 'translateY(' + D + 'px)' }],
          { duration: 300, easing: ease, fill: 'forwards' });
        await this.sleep(310);
        wrap.style.transform = ''; inner.style.transform = '';
        play(inner, [{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }],
          { duration: 500, easing: ease, fill: 'forwards' });
        play(wrap, [{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }],
          { duration: 560, delay: 180, easing: ease, fill: 'forwards' });
        this.sleep(340).then(() => face() && face().setInverted(true));
        await this.sleep(760);
        play(bar, [{ transform: 'translateY(' + D + 'px)' }, { transform: 'translateY(0px)' }],
          { duration: 280, easing: easeMove, fill: 'forwards' });
        await this.sleep(300);
      }
    } finally {
      this._faceFolding = false;
      this.setState({ facePose: pose });
      this.sizeDispBar();
      for (const a of anims) { try { a.cancel(); } catch (e) {} }
      bar.style.zIndex = '';
    }
  }


  // The docked menu-bar clock is the SAME clock as the Display bar, just HEIGHT-constrained to
  // the menu bar instead of width-constrained to the panel. Size it from the board geometry so
  // its proportions (M.W:M.H = 7.68:1, digits inset) are respected exactly — a true miniature —
  // and lay the hinge (link + pins) on the seam with identical relative math to sizeDispBar.
  // Free width the header row can give the docked clock: row width minus every non-dock cluster.
  // The flex:1 spacer is slack, not a claim, so it is excluded; ~52px covers the dock wrapper's own
  // padding + collapse button. Valid whether or not the dock is currently mounted.
  hdrDockAvail() {
    const hdr = document.querySelector('header'); if (!hdr) return null;
    if (hdr.clientWidth < 200) return null;   // header hidden / not laid out (fold screen) — measurement is meaningless
    // Direct measure, robust against media-query overlays: what the dock may use = the spacer's slack
    // + whatever the dock cluster already occupies, minus any genuine row overflow. Summing "all the
    // other clusters" broke after a mobile round-trip (a full-width overlay child poisoned the sum).
    let spacer = 0, dockW = 0;
    for (const ch of hdr.children) {
      const grow = parseFloat(getComputedStyle(ch).flexGrow) || 0;
      if (grow >= 1) { spacer += ch.getBoundingClientRect().width; continue; }
      if (this.els.dockSlot && (ch === this.els.dockSlot || ch.contains(this.els.dockSlot))) dockW += ch.getBoundingClientRect().width;
    }
    const overflow = Math.max(0, hdr.scrollWidth - hdr.clientWidth);
    return spacer + dockW - overflow - 60;   // 60 ≈ dock wrapper padding + collapse button + border slack
  }
  HDR_MIN_H = 24;   // below this the digits stop being legible — collapse instead of cropping

  sizeHdrBar() {
    const E = this.els, M = this.MM;
    const dock = E.dockSlot ? E.dockSlot.querySelector('[data-dockbar]') : null;
    if (!dock || !E.hdrDateHalf || !E.hdrTimeHalf) return;
    // The header's clusters lay out over several frames (fonts, sc-if mounts), so a mount-time
    // free-space measure is stale — at that instant the other clusters can still be 0 wide, which
    // reads as "plenty of room". Observe THOSE clusters (brand + the right-side groups): when their
    // real widths land, re-size against the true free space. The dock and the flex spacer are
    // excluded (the dock is what we resize; the spacer stays 0 whenever the header is full), and the
    // apply-guard below breaks any observer->write->observer echo.
    if (!this._hdrRO && typeof ResizeObserver !== 'undefined') {
      const hdr = document.querySelector('header');
      if (hdr) {
        this._hdrRO = new ResizeObserver(() => this.sizeHdrBar());
        for (const ch of hdr.children) {
          if (ch.style && ch.style.flex && ch.style.flex.startsWith('1')) continue;
          if (E.dockSlot && (ch === E.dockSlot || ch.contains(E.dockSlot))) continue;
          this._hdrRO.observe(ch);
        }
      }
    }
    // Height-constrained on a roomy header, width-constrained on a narrow one (phones): the docked
    // clock scales to the free space instead of running off the right edge of the viewport.
    const avail = this.hdrDockAvail();
    if (avail === null) return;             // no valid layout to size against — keep current state
    // (a real NEGATIVE avail is meaningful: the header is genuinely too tight -> k=0 -> auto-collapse)
    if (this._hdrFolding) return;           // a fold is choreographing the dock — don't fight it
    const closed = this.state.hdrPose === 'closed';
    // OPEN = the flat line (2 boards wide, 1 row tall). CLOSED = the desk pose (1 board wide,
    // 2 rows tall — the entry splash at header scale, both rows ticking). Height budget is 46px
    // either way, so the closed rows are half-height; width budget is what the header spares.
    const k = closed
      ? Math.min(46 / (2 * M.H), Math.max(avail, 0) / M.W)
      : Math.min(46 / M.H, Math.max(avail, 0) / (2 * M.W));
    const legible = closed ? 2 * M.H * k >= this.HDR_MIN_H : M.H * k >= this.HDR_MIN_H;
    if (!legible) {
      // No room for a legible miniature. First fallback is PHYSICAL: fold to the desk pose (half
      // the width). Only when even that won't fit legibly does the dock hide entirely.
      if (!closed) {
        const kC = Math.min(46 / (2 * M.H), Math.max(avail, 0) / M.W);
        if (2 * M.H * kC >= this.HDR_MIN_H) { this.setState({ hdrPose: 'closed', hdrPoseAuto: true }); return; }
      }
      if (!this.state.hdrAutoHide) this.setState({ hdrAutoHide: true });
      return;
    }
    const Wk = M.W * k, Hk = M.H * k;
    if (dock.dataset.pose === this.state.hdrPose &&
        Math.abs((parseFloat(E.hdrTimeHalf.style.width) || 0) - Wk) < 0.5) return;   // already this pose+size — no write, no RO echo
    dock.dataset.pose = this.state.hdrPose;
    dock.style.width = (closed ? Wk : 2 * Wk) + 'px';
    dock.style.height = (closed ? 2 * Hk : Hk) + 'px';
    dock.style.transform = ''; dock.style.zIndex = '';
    dock.style.cursor = closed ? 'pointer' : '';
    const dh = E.hdrDateHalf, th = E.hdrTimeHalf, wrap = E.hdrFoldWrap;
    for (const el of [dh, th]) { el.style.width = Wk + 'px'; el.style.height = Hk + 'px'; }
    if (wrap) { wrap.style.display = ''; wrap.style.transform = ''; }
    if (E.hdrFoldInner) E.hdrFoldInner.style.transform = '';
    if (closed) {
      // Desk pose: date directly above time, left edges shared — the entry stage's own layout.
      dh.style.left = '0px'; dh.style.top = '0px'; dh.style.transform = '';            // stacked mounting: no flip
      th.style.left = '0px'; th.style.top = Hk + 'px';
      if (this.faces.hdrDate) this.faces.hdrDate.setInverted(false);                   // stacked LUT
    } else {
      // Flat line: date left of time, the board's 180° mounting flip on, hinge on the seam.
      dh.style.left = '0px'; dh.style.top = '0px'; dh.style.transform = 'rotate(180deg)';
      th.style.left = Wk + 'px'; th.style.top = '0px';
      if (this.faces.hdrDate) this.faces.hdrDate.setInverted(true);                    // flat LUT
    }
    if (E.hdrDate) this.sizeFaceCanvas('hdrDate', E.hdrDate, dh, k, 7.0175);
    if (E.hdrTime) this.sizeFaceCanvas('hdrTime', E.hdrTime, th, k, 7.0175);
    if (E.hdrLink) {
      const L = E.hdrLink;
      const pd = 3.2 * k, bw = 1;   // pins scale with the bar (no px floor) — matches the display face
      const pinEl = (el, cx, cy) => { if (!el) return; el.style.left = (cx - bw - pd / 2) + 'px'; el.style.top = (cy - bw - pd / 2) + 'px'; el.style.width = pd + 'px'; el.style.height = pd + 'px'; };
      if (closed) {
        // Vertical plate straddling the row seam at the shared left edge — exactly the entry's.
        L.style.left = '0px'; L.style.top = (Hk - 12 * k) + 'px';
        L.style.width = (12 * k) + 'px'; L.style.height = (24 * k) + 'px'; L.style.borderRadius = (6 * k) + 'px';
        pinEl(E.hdrPinA, 6 * k, 6 * k); pinEl(E.hdrPinB, 6 * k, 18 * k);
      } else {
        // Horizontal plate on the mid-line seam.
        L.style.left = (Wk - 12 * k) + 'px'; L.style.top = '0px';
        L.style.width = (24 * k) + 'px'; L.style.height = (12 * k) + 'px'; L.style.borderRadius = (6 * k) + 'px';
        pinEl(E.hdrPinA, 6 * k, 6 * k); pinEl(E.hdrPinB, 18 * k, 6 * k);
      }
    }
  }

  handleResize() {
    if (!this.ready) return;
    if (this.state.phase === 'entry') this.layoutEntry();
    this.sizeDispBar();
    this.sizeHdrBar();
    const availR = this.hdrDockAvail();
    if (this.state.hdrAutoHide) {
      // First fallback is the closed clamshell (one board), so un-hiding needs only that much room.
      const need = this.MM.W * (this.HDR_MIN_H / this.MM.H) + 24;   // +24: hysteresis, no flapping at the edge
      if (availR !== null && availR >= need) this.setState({ hdrAutoHide: false });
    }
    if (this.state.hdrPoseAuto && this.state.hdrPose === 'closed' && !this._hdrFolding) {
      // The clock folded itself shut for want of width — unfold when the open pose fits again.
      const needOpen = 2 * this.MM.W * (this.HDR_MIN_H / this.MM.H) + 24;
      if (availR !== null && availR >= needOpen) this.foldHdrClock(false);
    }
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
        if (s.section === 'ground' && s.groundProj !== 'flat' && s.phase === 'app' && (s.globeRotate || this._globeDrag)) {
          // Long computed trails (24h ≈ 24k points) are costly to reproject each frame, so throttle
          // the rotating globe to ~18 fps and step 3× per redraw — smooth spin, a third of the cost.
          const heavy = s.globeTrails && s.skyTrailAge > 5400 && this.appMode() === 'simulation' && !this._globeDrag;
          if (heavy) {
            if (now - (this._globeHeavyAt || 0) >= 55) { this._globeHeavyAt = now; this.globeRot.lon += 0.084; this.drawChart('globe'); }
          } else {
            if (s.globeRotate && !this._globeDrag) this.globeRot.lon += 0.028;
            this.drawChart('globe');
          }
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
    // Docked-clock fit: converge within a second in every scenario (fold reveal, font load, rotate,
    // dock toggle) — the observer/mount triggers all have gaps, and the apply-guard makes this a
    // no-op (two rect reads) when the size is already right.
    this.sizeHdrBar();
    if (this.state.hdrAutoHide) {
      const need = this.MM.W * (this.HDR_MIN_H / this.MM.H) + 24;   // closed clamshell is the first fallback
      const avail = this.hdrDockAvail();
      if (avail >= need) this.setState({ hdrAutoHide: false });
    }
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
    // Menu idle-exit: menu_poll only runs on our menuEvent/menuTick calls (emu_poll doesn't drive
    // it), so pump one tick/second while the menu is open — advancing uwTick in Standby (where the
    // firmware clock is frozen) and just re-polling in the live modes — to honour the 15 s auto-exit.
    if (this.emu && this.emu.menuState && this.emu.menuState().layer !== 0) {
      this.emu.menuTick(this.appMode() === 'standby' ? 1000 : 0);
      this.repaintFace();
    }
    this.mirrorDeviceClock();
    // Bridge RX-staleness watchdog: a host-side unplug over the pccd bridge leaves the WebSocket
    // open, so without this the app stays CONNECTED on a frozen stream. Drops to Standby after 8 s
    // of silence (self-guarded; a no-op in Standby/Simulation and on a healthy stream).
    if (this.realdev && this.realdev.checkRxStale && !this._pccdUpdating) this.realdev.checkRxStale();   // a self-update drops the bridge briefly — not a "clock lost"
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
    // Firmware learned-model refresh: the on-die tempcomp model evolves slowly, so re-request the
    // read-back every 5 min while a real clock streams (sent once at connect in realdev.js). Logged
    // as tx like every other command — no silent chatter.
    this._tcDumpTick = (this._tcDumpTick || 0) + 1;
    if (this._tcDumpTick >= 300) {
      this._tcDumpTick = 0;
      const S2 = this.session.S;
      if (S2 && S2.real && S2.connected && this.realdev) {
        this.realdev.send('tc_dump = on');
        if (this.session.log) this.session.log('tx', 'tc_dump = on');
      }
    }
    // ADEV/HDEV ladder refresh: $PMADEV/$PMHDEV are dump-on-request, so poll while a real clock is
    // connected AND the TIMING room is open (where the chart lives) — else the σ_y(τ) plot never fills.
    // Every ~15 s: the curve evolves slowly, and the firmware's accumulator is already running.
    this._adevDumpTick = (this._adevDumpTick || 0) + 1;
    if (this._adevDumpTick >= 15) {
      this._adevDumpTick = 0;
      const S3 = this.session.S;
      if (S3 && S3.real && S3.connected && this.realdev && this.state.section === 'timing') {
        this.realdev.send('adev_dump = on'); this.realdev.send('hdev_dump = on');
        this._adevAsked = (this._adevAsked || 0) + 1;   // unanswered asks drive the honest no-answer state
        if (this.session.log) { this.session.log('tx', 'adev_dump = on'); this.session.log('tx', 'hdev_dump = on'); }
      }
    }
    // SIMULATED TRANSITS: the emulator runs the firmware's own MODE_STAR predictor for the sim
    // observer, so the NEXT TRANSITS panel needn't stay blank in Simulation. Refresh every ~10 s
    // (transits move slowly); the panel labels this SIMULATED, kept visually distinct from a real
    // clock's list, so it can never masquerade as device data.
    this._simStarTick = (this._simStarTick || 0) + 1;
    if (this.appMode() === 'simulation' && this.emu && this.emu.starLine) {
      if (this._simStarTick >= 10 || !this.session.S.simStar) {
        this._simStarTick = 0;
        const r = parsePMSTAR(this.emu.starLine());
        this.session.S.simStar = r ? { ...r, at: Math.floor(Date.now() / 1000) } : null;
      }
    } else if (this.session.S.simStar) {
      this.session.S.simStar = null;   // leaving simulation drops the synthesized list
    }
    // Sky-history persistence: snapshot the accumulations every 30 s while a session is live, so a
    // reload (or an accidental unplug) doesn't erase hours of collected sky. Kind-separated buckets.
    this._skySaveTick = (this._skySaveTick || 0) + 1;
    if (this._skySaveTick >= 30 && this.session && this.session.S.connected) { this._skySaveTick = 0; this.saveSkyHistory(); }
    // Stale-tab watch: every 10 min, compare the page's baked build stamp against the SERVED
    // build-info.json. A pccd overlay refresh (or Pages deploy behind the daemon) swaps the files
    // on disk while this tab keeps running the old JS — this is the only way the tab finds out.
    this._appStaleTick = (this._appStaleTick || 0) + 1;
    if (this._appStaleTick >= 600) { this._appStaleTick = 0; this.checkAppStale(); }
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
    else if (s === 'archive') { this.fetchArchive(); this.drawChart('archSky'); }
    else if (s === 'timing') { this.drawChart('phase'); this.drawChart('stair'); this.drawChart('ppmtemp'); this.drawChart('adev'); this.spSyncSource(); this.drawChart('signalPath'); this.spKick(); this.fetchArchive(); this.drawChart('archOffset'); this.drawChart('archAux'); }
    else if (s === 'ground') {
      if (this.state.groundProj === 'flat') this.drawChart('map');
      else if (!this.state.globeRotate) this.drawChart('globe');   // rotating globe repaints on its own driver
    }
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
      // TRAIL control IS the trail span (decoupled from the chart WINDOW). For long windows (1h..24h)
      // in SIMULATION, use the computed full-constellation tracks; otherwise the live accumulated buffer.
      const cut = st.skyTrailAge;
      const comp = this.simTrails(cut);
      const source = comp ? comp.trails : S.trails;
      if (st.skyTrails) for (const [k, tr] of source) {
        const f = tr.filter((p) => nowS - p.t <= cut);
        if (f.length > 1) trails.set(k, f);
      }
      // Long window in the polar view: the HEATMAP is the long-term record (heatLong), the trail-LINES
      // stay a short recent ribbon (lineAge ≤45 min) so it never becomes spaghetti. Ground tracks (the
      // long line trails) live on MAP + GLOBE, not here.
      const heatLong = !!comp;
      const lineAge = heatLong ? Math.min(cut, 2700) : cut;
      // Connected honesty: a real clock's trail reaches back only to this tab's connect (nothing
      // models a real sky, and the daemon archive has no per-sat record yet). When the recorded
      // depth is younger than the TRAIL window, say so on the plot instead of looking broken.
      let accNote = '';
      if (!comp && S.real && st.skyTrails) {
        let oldest = nowS;
        for (const tr of S.trails.values()) if (tr.length && tr[0].t < oldest) oldest = tr[0].t;
        if (nowS - oldest < cut * 0.95) {
          const m = Math.max(0, Math.round((nowS - oldest) / 60));
          const rec = m < 60 ? m + ' MIN' : (m / 60).toFixed(m % 60 ? 1 : 0) + ' H';
          const win = cut >= 3600 ? (cut / 3600) + ' H' : Math.round(cut / 60) + ' MIN';
          accNote = 'TRAIL RECORDS LIVE · ' + rec + ' OF ' + win + ' SO FAR';
        }
      }
      return CH.drawSky(el, T, {
        sats: S.sats, trails, now: nowS,
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon),
        moon: this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon),
      }, { heatmap: st.skyHeatmap, horizon: st.skyHorizon, trails: st.skyTrails, labels: st.skyLabels, trailAge: cut, heatLong, lineAge, accNote });
    }
    if (name === 'cn0elev') return CH.drawCn0Elev(el, T, S.sats, st.sigMedian);
    if (name === 'cn0time') {
      const fil = st.sigFilter;
      const top = S.sats.filter((x) => x.el > 0 && (fil === 'all' || x.constId === fil)).sort((a, b) => b.cn0 - a.cn0).slice(0, 8);
      // One live WINDOW across the strip charts (SIGNAL + POSITION) — a dropout here lines up
      // with the DOP spike and position jump at the same instant on the POSITION tab.
      return CH.drawCn0Time(el, T, top.map((x) => ({ tok: x.tok, pts: S.cn0Hist.get(x.key) || [] })), st.posWindow, nowS);
    }
    if (name === 'posScatter') return CH.drawPosScatter(el, T, this._pos.pts, this._pos, nowS);
    if (name === 'dop') return CH.drawDop(el, T, S.dopHist, st.posWindow, nowS);
    if (name === 'cont') return CH.drawContinuity(el, T, S.fixHist, st.posWindow, nowS, S.ttff, S.t0);
    // Standby draws the ABSENT state, never a leftover buffer — same rule (and reason) as rvTiming's
    // `standby` gate. adevData() already gates itself on appMode; these three read S.pps directly.
    // REVIEW is the one legitimate "data with no live state": reconstructReview rebuilds S.pps from the
    // recording for the scrubber, so it must NOT be blanked (appMode is 'standby' throughout playback).
    const sby = this.appMode() === 'standby' && !this._reviewing;
    if (name === 'phase') return CH.drawPhase(el, T, sby ? [] : S.pps.list, 1800, nowS, sby ? 0 : ((S.pps.flags & 2) ? 0 : (S.pps.lastEdge || 0)));
    if (name === 'stair') return CH.drawStair(el, T, sby ? [] : S.pps.samples, 1800, nowS, sby ? 0 : S.pps.temp, sby ? [] : (S.pps.tempHist || []), sby ? 0 : S.pps.lastEdge);
    if (name === 'ppmtemp') return CH.drawPpmTemp(el, T, sby ? [] : S.pps.samples, sby ? null : (this._timing && this._timing.fit));
    if (name === 'adev') return CH.drawAdev(el, T, this.adevData(), this.adevHint());
    if (name === 'archOffset') return CH.drawArchiveOffset(el, T, this._arch && this._arch.t);
    if (name === 'archAux') return CH.drawArchiveAux(el, T, this._arch && this._arch.t);
    if (name === 'archSky') return CH.drawArchiveSky(el, T, this._arch && this._arch.s);
    if (name === 'signalPath') {
      const pf = this._spPf || this.spCompute();
      if (!pf) return;   // no honest source (standby, or connection without a raw feed) — the absent state owns the panel
      return CH.drawSignalPath(el, T, pf, { K: this.state.sp.K, window: this.state.sp.window, reduced: this.reduced, nowIdx: this._spNow });
    }
    // Ground tracks carry no timestamps (gtrails = plain points at ~45 s cadence), so the TRAIL
    // length control maps to a tail slice: 45 s per point, full buffer (40 pts) at MAX.
    const gcut = (g) => {
      const comp = this.simTrails(st.skyTrailAge);
      if (comp) return comp.gtrails;   // computed sim ground tracks already span exactly the window
      const n = Math.round(st.skyTrailAge / 45);
      if (n >= 40) return g;
      const m = new Map();
      for (const [k, tr] of g) m.set(k, tr.length > n ? tr.slice(-n) : tr);
      return m;
    };
    if (name === 'globe') {
      return CH.drawGlobe(el, T, {
        rot: this.globeRot, land: this.land, sats: S.sats, gtrails: gcut(S.gtrails),
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon),
        moon: this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon), obs: S.obs,
        opts: { terminator: st.globeTerm, trails: st.globeTrails, labels: st.globeLabels, graticule: st.globeGrat, trailAge: st.skyTrailAge },
        dark: st.theme === 'dark',
      });
    }
    if (name === 'map') {
      return CH.drawMap(el, T, {
        land: this.land, sats: S.sats, gtrails: gcut(S.gtrails),
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon),
        moon: this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon), obs: S.obs,
        // GROUND TRACK is one tab with two projections — one layer-toggle set drives both.
        opts: { terminator: st.globeTerm, trails: st.globeTrails, labels: st.globeLabels, graticule: st.globeGrat, trailAge: st.skyTrailAge },
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
    const prevSec = this.state.section;
    (this._lastSub = this._lastSub || {})[this.roomOf(sec)] = sec; // remember the sub-tab per room
    this.traverseClock(prevSec, sec);   // measure the source BEFORE the rerender (setState is microtask-coalesced)
    this.setState({ section: sec });
    localStorage.setItem('pccweb.section', sec);
    if (this.els.main) this.els.main.scrollTop = 0;
    if (sec === 'export') { this.refreshTelStats(); this.openReview(); }   // log counts + load the scrub model
    if (sec === 'datalink') this.mountDatalink();                          // lazy-mount the watch-programming UI
    // Entering TIMING with a live clock: request the σ_y(τ) ladder now (dump-on-request) so the ADEV
    // chart fills at once instead of waiting up to a full poll interval.
    if (sec === 'timing') {
      const S = this.session && this.session.S;
      if (S && S.real && S.connected && this.realdev) {
        this.realdev.send('adev_dump = on'); this.realdev.send('hdev_dump = on');
        this._adevAsked = (this._adevAsked || 0) + 1;
        if (this.session.log) { this.session.log('tx', 'adev_dump = on'); this.session.log('tx', 'hdev_dump = on'); }
        this._adevDumpTick = 0;
      }
    }
  }

  // THE TRAVERSE (Act II of the presentation grammar): the clock never teleports between its two
  // homes. Crossing the FACE-room boundary, the SAME flat clock flies between the header dock and
  // the hero slot — a translate+scale of one object (same pose, so no fold is owed; pose changes
  // fold, relocations slide). Mechanics: the source box is measured BEFORE the rerender swaps the
  // mounts (setState coalesces to a microtask, so the old DOM is still live here), then two rAFs
  // later the destination is sized and the destination ELEMENT plays from the source box to rest
  // (FLIP) — a handoff between the two real elements, pixel-continuous at both ends. Skipped when
  // the dock is folded (desk pose ≠ flat: that relocation would owe a fold — a later act), hidden,
  // or animation is unavailable.
  traverseClock(prev, sec) {
    if (prev === sec || this.state.phase !== 'app' || !this.state.docked) return;
    const entering = sec === 'display' && prev !== 'display';
    const leaving = prev === 'display' && sec !== 'display';
    if ((!entering && !leaving) || !this.canAnimate()) return;
    if (this.state.hdrPose !== 'open' || this.state.hdrAutoHide || this._hdrFolding) return;
    const fly = (el, src, z) => {
      const dst = el.getBoundingClientRect();
      if (!dst.width || !src.width) return;
      el.style.transformOrigin = '0 0';
      el.style.zIndex = z;
      const s = src.width / dst.width;
      this._travLast = { dir: entering ? 'in' : 'out', dx: Math.round(src.left - dst.left), dy: Math.round(src.top - dst.top), s: +s.toFixed(3) };
      const a = el.animate(
        [{ transform: 'translate(' + (src.left - dst.left) + 'px,' + (src.top - dst.top) + 'px) scale(' + s + ')' },
         { transform: 'none' }],
        { duration: 380, easing: 'cubic-bezier(.55,.02,.14,1)' });
      const land = () => { el.style.transform = ''; el.style.zIndex = ''; };
      a.onfinish = land; a.oncancel = land;
    };
    // Two rAFs let the swap render and the destination get sized — but raced against a timeout so a
    // throttled-rAF environment still flies (same defensive shape as settle()).
    const frames = () => Promise.race([this.raf2(), this.sleep(90)]);
    if (entering) {
      const dock = this.els.dockSlot && this.els.dockSlot.querySelector('[data-dockbar]');
      const src = dock && dock.getBoundingClientRect();
      if (!src || src.width < 10) return;
      frames().then(() => {
        const bar = this.els.dispBar; if (!bar) return;
        this.sizeDispBar();
        fly(bar, src, '5');
      });
    } else {
      const bar = this.els.dispBar;
      const src = bar && bar.getBoundingClientRect();
      if (!src || src.width < 10) return;
      frames().then(() => {
        this.sizeHdrBar();
        const dock = this.els.dockSlot && this.els.dockSlot.querySelector('[data-dockbar]');
        if (!dock) return;
        fly(dock, src, '80');
      });
    }
  }

  // Lazily import + mount the Datalink room (self-contained; builds its own DOM in the refDatalink node).
  mountDatalink() {
    if (this._dlMounted) return;
    const host = this.els.datalink;   // populated once the section's sc-if renders the mount div
    if (!host) { setTimeout(() => this.mountDatalink(), 60); return; }
    this._dlMounted = true;
    import('./datalink/datalink-ui.js?v=5').then((m) => m.mountDatalink(host));
  }
  // The redesign collapses the ten sections into four rooms; each room routes to one or more
  // existing sections, surfaced as a sub-tab bar. Content is unchanged — this is IA only.
  get ROOMS() {
    return {
      display: ['display'],
      sky: ['satellites', 'signal', 'position', 'ground', 'archive', 'export'], // GLOBE+MAP merged (one tab, two projections); the daemon archive got its own tab
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
        : { led: 'var(--none)', glow: 'rgba(255,106,61,.55)', state: 'NO SIGNAL', sub: 'NO NMEA ON THIS PORT' };
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
      // Second civil timezone on the date row — target set by the zone2 config key.
      { key: 'zone2', mode: 'MODE_ZONE2', label: 'ZONE 2', group: 'TIME ROW' },
      { key: 'sun', mode: 'MODE_SUN', label: 'SUN RISE/SET', group: 'ASTRO' },
      { key: 'sun_azel', mode: 'MODE_SUN_AZEL', label: 'SUN AZ·EL', group: 'ASTRO' },
      { key: 'moon', mode: 'MODE_MOON', label: 'MOON PHASE', group: 'ASTRO' },
      { key: 'grid', mode: 'MODE_GRID', label: 'MAIDENHEAD', group: 'ASTRO' },
      { key: 'latlon', mode: 'MODE_LATLON', label: 'LAT·LON', group: 'ASTRO' },
      // Observing twilight ladder — civil/nautical/astronomical dusk + countdown to darkness.
      { key: 'dark', mode: 'MODE_DARK', label: 'TWILIGHT', group: 'ASTRO' },
      // Bright-star meridian-transit predictor — paged countdowns to culminating stars.
      { key: 'star', mode: 'MODE_STAR', label: 'STAR TRANSIT', group: 'ASTRO' },
      // Tempcomp diagnostic pages (die temp / HSE / LSE / samples+state) — real firmware read-out.
      { key: 'tempcomp', mode: 'MODE_TEMPCOMP', label: 'TEMP COMP', group: 'DIAGNOSTIC' },
      // Live Allan deviation of the free-running crystal — paged sigma_y(tau) octaves.
      { key: 'adev', mode: 'MODE_ADEV', label: 'ALLAN DEV', group: 'DIAGNOSTIC' },
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
    // Refuse to disable the last enabled mode — the firmware always shows SOMETHING, and leaving
    // modes_enabled[] empty desyncs the UI (which would claim 'iso8601') from a blank/stuck face.
    if (!on && this.MODE_DEFS.map((d) => d.key).filter((k) => this.state.modesEnabled[k]).length <= 1) return;
    const modesEnabled = { ...this.state.modesEnabled, [key]: on };
    const patch = { modesEnabled };
    if (on) patch.currentMode = key;
    else if (this.state.currentMode === key) {
      const rest = this.MODE_DEFS.map((d) => d.key).filter((k) => modesEnabled[k]);
      patch.currentMode = rest[0];
      this.pushMode(this.modeDef(rest[0]).mode, true);   // re-assert so something stays on the face
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
  // firmware displayMode int → MODE_DEFS key, built once from the emulator's own enum so the
  // face label always names the mode the firmware is actually showing (no hardcoded enum ints).
  fwModeKey(modeInt) {
    if (!this.emu || !this.emu.modeId) return null;
    if (!this._fwModeKey) {
      this._fwModeKey = new Map();
      for (const d of this.MODE_DEFS) {
        const id = this.emu.modeId(d.mode);
        if (id >= 0) this._fwModeKey.set(id, d.key);
      }
    }
    return this._fwModeKey.get(modeInt) || null;
  }
  // σ_y(τ) ladder for the TIMING chart. A connected clock's $PMADEV/$PMHDEV stream (S.stab, parsed
  // in realdev) is the primary source; otherwise the EMULATOR's own accumulator — the same firmware
  // adev code fed by the virtual GPS's PPS edges — is asked for its byte-faithful sentences and run
  // through the same parser. Standby (no PPS source at all) simply has no ladder: honest absence.
  // Why is the σ_y(τ) ladder empty? Drives the honest empty-state copy in drawAdev.
  //   no-answer — we've asked the clock (adev_dump) at least twice and NOTHING came back: its
  //               firmware either predates the ADEV serial dump or has the silent CDC-drop bug
  //               (fixed on rollup) — a reflash is the cure, so say that, not "computing…" forever
  //   waiting   — connected, request(s) sent, first reply not in yet
  //   sim       — the emulator is accumulating from the virtual PPS
  //   standby   — no PPS source at all
  adevHint() {
    const m = this.appMode();
    if (m === 'simulation') return 'sim';
    if (m === 'connected') return ((this._adevAsked || 0) >= 2 && !this.adevData()) ? 'no-answer' : 'waiting';
    this._adevAsked = 0;   // fresh judgement for the next connection
    return 'standby';
  }
  adevData() {
    const S = this.session && this.session.S;
    if (S && S.real && S.stab) return S.stab;
    if (S && S.real) return null;                       // connected but no $PMADEV yet (mode off / stock fw)
    if (!this.emu || !this.emu.adevLine || this.appMode() !== 'simulation') return null;
    const now = Date.now();
    if (!this._adevEmu || now - this._adevEmu.t > 1000) {   // 1 Hz cache — same cadence a real clock emits
      const a = parsePMADEV(this.emu.adevLine() || '');
      const h = parsePMADEV(this.emu.hdevLine() || '');
      this._adevEmu = { t: now, stab: (a || h) ? { adev: a, hdev: h, at: Math.floor(now / 1000) } : null };
    }
    return this._adevEmu.stab;
  }

  // Ordinal → 'MODE_XXX' enum-name lookup for the SETTINGS.BIN override decoder. Built by resolving
  // settings-bin's name list through the emulator's modeId export (the emu IS the firmware), so the
  // mapping tracks the compiled enum and can never drift. Returns a lookup fn for winningOverrides.
  fwModeName() {
    if (!this.emu || !this.emu.modeId || !this.SB) return null;
    if (!this._fwModeName) {
      this._fwModeName = new Map();
      for (const n of this.SB.MODE_NAMES) {
        const id = this.emu.modeId(n);
        if (id >= 0) this._fwModeName.set(id, n);
      }
    }
    return (ord) => this._fwModeName.get(ord) || null;
  }
  // The two tactile buttons on the switch cover (clicked on the on-screen board). Like the real
  // clock, they step through the enabled display modes — forward on 1, back on 2. The button id
  // arrives as the furniture-item string ('d-btn-2') OR a raw number; the back button is #2, so
  // match the trailing digit (the old `btn === 2` test was always false against a string id, so
  // BOTH buttons stepped forward — the back button was dead).
  onFaceButton(btn) {
    const back = /2$/.test(String(btn));
    // MENU OPEN → the tap scrolls the menu ring / steps the editor value, exactly like the hardware
    // (the same two buttons do double duty). menuState().layer 0 = clock (closed).
    if (this.emu && this.emu.menuState && this.emu.menuState().layer !== 0) {
      this.emu.menuEvent(back ? 0x92 : 0x91);
      this.repaintFace();
      return;
    }
    if (this.emu) {
      // The emulator IS the firmware: let ITS cursor be the single source of truth. Step it (in
      // firmware-enum order, exactly like the hardware), then derive the label from the resulting
      // mode — instead of also advancing an independent app-order cursor that desynced the caption
      // from the segments (the two enabled-sets and orderings differed).
      back ? this.emu.button2() : this.emu.button1();
      const key = this.fwModeKey(this.emu.state().mode);
      if (key) {
        this.setState({ currentMode: key });
        // Mirror to a connected clock so its face follows too (the emulator drives the picture).
        if (this.session && this.session.S && this.session.S.real) this.devSend(this.modeDef(key).mode + ' = enabled');
      }
    } else {
      this.cycleMode(back ? -1 : 1);
    }
  }

  // Chord protocol reproduction — the physical date board debounces the two switches and emits
  // 0x91/0x92 (tap) or 0x94/95/96 (rolling both-held stage crossings) + 0x93 (release). Here the two
  // SVG buttons drive the same bytes: hold BOTH to open/drive the on-device menu; a lone tap steps
  // modes / scrolls the open menu via onFaceButton. Without this the whole menu dimension — compiled,
  // tested, and rendered by the firmware — was unreachable (the face only single-tapped).
  _chord = { down: {}, active: false, stage: 0, timer: null };
  onFaceButtonDown(btn) {
    const n = /2$/.test(String(btn)) ? 2 : 1;
    this._chord.down[n] = Date.now();
    if (this._chord.down[1] && this._chord.down[2] && !this._chord.active && this.emu && this.emu.menuEvent) {
      // both held → enter the chord; emit stage 1, then roll 1→2→3→1… while held so the firmware
      // pages its self-labelled stages (SETUP/ENTER/EXIT/…). Release fires the shown stage.
      this._chord.active = true; this._chord.stage = 1;
      this.emu.menuEvent(0x94); this.repaintFace();
      this._chord.timer = setInterval(() => {
        this._chord.stage = (this._chord.stage % 3) + 1;
        this.emu.menuEvent(0x93 + this._chord.stage);   // 0x94/95/96
        this.repaintFace();
      }, 800);
    }
  }
  onFaceButtonUp(btn) {
    const n = /2$/.test(String(btn)) ? 2 : 1;
    const downAt = this._chord.down[n];
    delete this._chord.down[n];
    if (this._chord.active) {
      // release out of a chord → fire the shown stage (0x93), then reset so a still-held partner
      // doesn't retrigger. The firmware's own idle-exit handles an abandoned hold.
      if (this._chord.timer) { clearInterval(this._chord.timer); this._chord.timer = null; }
      this._chord.active = false; this._chord.stage = 0; this._chord.down = {};
      if (this.emu && this.emu.menuEvent) { this.emu.menuEvent(0x93); this.repaintFace(); }
      return;
    }
    // lone tap (partner not held) → the normal button action (mode step, or menu scroll if open)
    if (downAt) this.onFaceButton(btn);
  }

  // External button strip (index.html, below the clock) → the SAME two-button chord protocol as the
  // on-face furniture buttons, so the on-device menu stays fully drivable now that the board
  // furniture is hidden for the clean menu-demo face. `which`: 1 = Button 1, 2 = Button 2,
  // 'both' = Button 1+2 (the chord that opens/pages the menu). Tap = one step; holding a single
  // button auto-repeats the step (mirrors the firmware's held-tap value acceleration); holding 1+2
  // rolls the chord stages and release fires the shown stage — both handled by onFaceButtonDown/Up.
  // One strip button is tracked at a time (the dedicated 1+2 button performs the chord atomically),
  // and _extHold.down makes the up handler idempotent since pointerup AND pointercancel both fire.
  _extHold = { timer: null, repeated: false, down: false };
  extBtnDown(which, e) {
    if (e) { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} }
    if (this._extHold.down) return;
    this._extHold.down = true; this._extHold.repeated = false;
    if (which === 'both') { this.onFaceButtonDown('d-btn-1'); this.onFaceButtonDown('d-btn-2'); return; }
    const id = which === 2 ? 'd-btn-2' : 'd-btn-1';
    this.onFaceButtonDown(id);
    const tick = () => {
      if (this._chord.active) return;            // a chord took over → stop the single-button repeat
      this._extHold.repeated = true;
      this.onFaceButton(id);                     // repeat the step while held
      this._extHold.timer = setTimeout(tick, 140);
    };
    this._extHold.timer = setTimeout(tick, 420); // initial hold delay before auto-repeat kicks in
  }
  extBtnUp(which, e) {
    if (!this._extHold.down) return;             // idempotent: ignore the duplicate up (up + cancel/leave)
    this._extHold.down = false;
    if (this._extHold.timer) { clearTimeout(this._extHold.timer); this._extHold.timer = null; }
    if (which === 'both') { this.onFaceButtonUp('d-btn-1'); this.onFaceButtonUp('d-btn-2'); return; }
    const id = which === 2 ? 'd-btn-2' : 'd-btn-1';
    if (this._extHold.repeated) {
      this._extHold.repeated = false;
      delete this._chord.down[which === 2 ? 2 : 1];   // hold already fired taps — drop the down without an extra lone tap
    } else {
      this.onFaceButtonUp(id);                   // short tap → the normal single step
    }
  }

  // Force an immediate face repaint after a menu event (menu FSM updated the firmware buffers, but
  // the render loop is only ~1 Hz — the menu must feel responsive).
  repaintFace() { try { this.driveEmu(); } catch (e) {} }

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
      // Signature right-edge fittings the face was missing: the gold GPS SMA jack and the USB port.
      // PLACEHOLDER positions (drag-to-calibrate); the loadHwConfig merge folds these into an existing
      // saved config as new items WITHOUT a VER bump, so the hand-measured furniture above is untouched.
      { id: 't-ant', row: 'time', kind: 'antenna', x: 266, y: 0.33, r: 2.6 },
      { id: 't-usb', row: 'time', kind: 'usb', x: 266, y: 0.67, r: 2.4 },
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
      this.rvWeather(), this.rvMonitor(), this.rvExport(), this.rvFirmware(), this.rvArchive(), this.rvSignalPath());
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
      // collapses into the header (menu bar) on every other section. There is no "close" — closing
      // IS the fold: the date half swings shut over the hinge and the clamshell stays docked as a
      // half-width, single-row clock, still ticking (the real Mk IV keeps showing time when folded;
      // the firmware has no fold sensor). hdrAutoHide remains the last resort for headers too
      // narrow even for the closed pose.
      hdrBarOn: st.docked && st.section !== 'display' && !st.hdrAutoHide,
      hdrFoldTitle: st.hdrPose === 'closed' ? 'Unfold the clock' : 'Fold the clock shut',
      // The glyph (a hinged pair of leaves) is static SVG markup: dc-lite bindings must stay on
      // HTML-namespace attributes — an SVG-attribute binding kills the template compile downstream.
      hdrDockTitle: st.hdrPose === 'closed' ? 'Closed clock — click to unfold' : '',
      // (dock layout style is STATIC markup: a bound style attr would rewrite on every render and
      // clobber sizeHdrBar's inline width/transform writes — cursor is set by sizeHdrBar instead)
      onHdrFold: () => this.foldHdrClock(st.hdrPose !== 'closed'),
      onHdrDockClick: () => { if (this.state.hdrPose === 'closed') this.foldHdrClock(false); },
      onEntryClick: () => this.beginFold(),
      // …ElementChild, not …Child: whitespace between the markup's children parses to text nodes,
      // and a text node has no .style — the old .lastChild threw on every hover (Safari console).
      onEntryOver: () => { const h = this.els.hint; if (h && h.firstElementChild && h.lastElementChild) { h.lastElementChild.style.color = 'var(--txt2)'; h.firstElementChild.style.background = 'var(--txt3)'; } },
      onEntryOut: () => { const h = this.els.hint; if (h && h.firstElementChild && h.lastElementChild) { h.lastElementChild.style.color = 'var(--txt3)'; h.firstElementChild.style.background = 'var(--line2)'; } },
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
      appStaleOn: st.appStale, onAppReload: () => { try { location.reload(); } catch (e) {} },
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
    for (const r of ['EntryBg', 'FoldStage', 'TimeHalf', 'DateHalf', 'LinkWrap', 'LinkPlate', 'PinTop', 'PinBot', 'EntryTime', 'EntryDate', 'Hint', 'EntryCap', 'FloorShadow', 'DockSlot', 'HdrDate', 'HdrTime', 'Main', 'Drawer', 'DispWrap', 'DispBar', 'DispDateHalf', 'DispTimeHalf', 'DispDate', 'DispTime', 'DispLink', 'DispPinA', 'DispPinB', 'GammaCurve', 'TextInput', 'CdInput', 'LatIn', 'LonIn', 'EmuLat', 'EmuLon', 'EmuCfg', 'EmuCfgFile', 'Sky', 'Cn0elev', 'Cn0time', 'PosScatter', 'Dop', 'Cont', 'Phase', 'Stair', 'Ppmtemp', 'Adev', 'Globe', 'Map', 'MonLog', 'MonFilter', 'Cmd', 'ReviewCanvas', 'Datalink', 'Tol1In', 'Tol10In', 'Tol100In']) {
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

  // ---- THE RACK (Law 1) -----------------------------------------------------------------------
  // The six numbers the FACE room is accountable for. Every value here already existed somewhere in
  // the room; five were being reported as a 9.5px status string and two more only as sentences. A
  // cell reports state as a VALUE, which is what retires the tutorial prose beneath it.
  // Cell states are honest: 'absent' renders an em-dash with the reason in the sub-line, never a
  // fabricated zero. Standby has no fix, so precision and grid are genuinely absent, and say so.
  faceRack(mode, dispName) {
    const st = this.state, S = this.session && this.session.S;
    const em = this.effectiveMode();
    const standby = mode === 'standby';
    const sim = mode === 'simulation';
    const dash = '—';

    // 1 · SIGNIFICANT TO — the finest digit that is still true, and its 3σ bound.
    const P = { P3: ['1', 'ms'], P2: ['10', 'ms'], P1: ['0.1', 's'], P0: ['1', 's'] };
    const pr = (!standby && this.emu && this.emu.precision) ? this.emu.precision() : null;
    const pv = pr ? (P[pr.level] || P.P0) : null;
    const uUs = pr && Number.isFinite(pr.uUs) ? pr.uUs : null;

    // 4 · ZONE — the offset is the value; the IANA name and whether DST is in force qualify it.
    let zoneV = 'UTC', zoneS = 'COORDINATED UNIVERSAL';
    if (!st.utc) {
      const d = new Date(), off = -d.getTimezoneOffset();
      const sgn = off < 0 ? '−' : '+', a = Math.abs(off);
      zoneV = 'UTC' + sgn + String((a / 60) | 0).padStart(2, '0') + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
      let zn = '';
      try { zn = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      // DST tell: compare against January in the same zone (southern hemisphere handled by the max()).
      let dst = false;
      try {
        const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
        const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
        dst = d.getTimezoneOffset() < Math.max(jan, jul);
      } catch (e) {}
      zoneS = (zn.toUpperCase() || this.tzName().toUpperCase()) + (dst ? ' · DST' : '');
    }

    // 5 · GRID — Maidenhead from the observer the astronomy actually uses, with its provenance.
    let gridV = dash, gridS = 'NO POSITION', gridSt = 'absent';
    const lat = S && S.obs ? S.obs.lat : NaN, lon = S && S.obs ? S.obs.lon : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      try { gridV = ASTRO.maidenhead(lat, lon); gridSt = standby ? 'stale' : 'live'; } catch (e) { gridV = dash; }
      gridS = S && S.obsUserSet ? 'SET BY HAND' : (standby ? 'DEFAULT' : 'FROM FIX');
    }

    // 6 · SOURCE — which of the three states is driving the face, and where it comes from.
    const srcV = mode === 'connected' ? 'DEVICE' : sim ? 'SIM' : 'SYSTEM';
    const srcS = mode === 'connected' ? (this.portName(S) || 'USB SERIAL')
      : sim ? 'VIRTUAL GPS' : 'HOST CLOCK · NO DEVICE';

    return {

      rkSigV: pv ? pv[0] : dash, rkSigU: pv ? pv[1] : '',
      rkSigS: standby ? 'NO FIX · HOST CLOCK' : (uUs != null ? '±' + (uUs < 1 ? '<1' : uUs) + ' µs' : 'ACQUIRING'),
      rkSigSt: standby ? 'absent' : (pr && pr.level === 'P3' ? 'live' : 'stale'),

      rkRowV: em.m === 'text' ? 'TEXT' : em.m === 'countdown' ? 'COUNTDOWN' : st.standby ? 'BLANK' : 'MODES',
      rkRowS: dispName, rkRowSt: st.standby ? 'absent' : 'live',

      rkBrtV: Math.round((st.brightness != null ? st.brightness : 0) * 100),
      rkBrtS: st.brightnessFixed ? 'FIXED' : 'AUTO · AMBIENT',
      rkBrtSt: 'live',

      rkZoneV: zoneV, rkZoneS: zoneS, rkZoneSt: 'live',
      rkGridV: gridV, rkGridS: gridS, rkGridSt: gridSt,
      rkSrcV: srcV, rkSrcS: this.withAge(srcS), rkSrcSt: sim ? 'sim' : standby ? 'absent' : 'live',
    };
  }

  // ---- RACK FRESHNESS (direction D's graft) ----------------------------------------------------
  // A rack claims "this is true right now". The claim expires, and the failure mode is silent: a
  // connected clock stops sending and every value sits there looking exactly as confident as it did
  // a second earlier. The one thing an instrument must not do.
  // The honest clock is S.lastRxT — the last line actually received — not a render tick, which would
  // keep counting happily while the link is dead. Simulation is live by construction; standby has no
  // stream to be stale about and says so by saying nothing.
  rackFresh() {
    const mode = this.appMode();
    if (mode === 'standby') return { rkFresh: 'na', rkAge: '' };
    if (mode === 'simulation') return { rkFresh: 'live', rkAge: '' };
    const S = this.session && this.session.S;
    const t = S && S.lastRxT;
    if (!t) return { rkFresh: 'dead', rkAge: 'NO DATA RECEIVED' };
    const a = (Date.now() - t) / 1000;
    return {
      rkFresh: a < 3 ? 'live' : a < 15 ? 'stale' : 'dead',
      rkAge: a < 2 ? 'LIVE'
        : a < 60 ? Math.round(a) + ' S AGO'
        : a < 3600 ? Math.round(a / 60) + ' MIN AGO'
        : 'LINK LOST',
    };
  }
  // The provenance sub-line (cell 6 in every room) is where the age belongs — it already says where
  // the value came from, so it is the natural place to say when.
  withAge(sub) { const a = this.rackFresh().rkAge; return a ? (sub + ' · ' + a) : sub; }

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
      // ---- THE RACK (Law 1) — the six numbers FACE is accountable for. These values all existed
      // already; five of them were being crammed into faceStatusLine at 9.5px. Promoting them to
      // cells is what lets the tutorial prose below be deleted rather than merely shortened.
      ...this.faceRack(_mode, _dispName),
      ...this.rackFresh(),
      faceRoomCap: _mode === 'connected' ? 'MK IV FACE — LIVE HARDWARE' : _mode === 'simulation' ? 'MK IV FACE — SIMULATION' : 'MK IV FACE — SYSTEM TIME',
      // POSE (flat line / stacked desk pose) + FULL FACE — Act III of the presentation grammar.
      ssPoseFlat: this.seg(st.facePose !== 'stacked', true), ssPoseStack: this.seg(st.facePose === 'stacked', false),
      onPoseFlat: () => this.foldFacePose(false), onPoseStack: () => this.foldFacePose(true),
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
      // External button strip → drive the on-device menu (the board furniture buttons are hidden).
      // Fourth wall: the menu these buttons drive belongs to the BUILT-IN firmware. With a real
      // clock connected the face shows the device's data, so say whose menu this is — the exact
      // ambiguity that once convinced a user their bench clock had a menu its flash predates.
      menuBtnNoteOn: _mode === 'connected',
      onB1Down: (e) => this.extBtnDown(1, e), onB1Up: (e) => this.extBtnUp(1, e),
      onB2Down: (e) => this.extBtnDown(2, e), onB2Up: (e) => this.extBtnUp(2, e),
      onBBothDown: (e) => this.extBtnDown('both', e), onBBothUp: (e) => this.extBtnUp('both', e),
      // STANDBY front door: connect-first. A real Mk IV is the point; a simulation is the equal-but-
      // quieter fallback for anyone without hardware. Shown only while in Standby.
      standbyOn: _mode === 'standby',
      onStandbyConnect: () => this.connectRealDevice(),
      onStandbyExplore: () => this.setSim(true),
      standbySerialNote: this.state.bridgeInfo ? 'PCC BRIDGE DETECTED — ANY BROWSER CONNECTS'
        : (typeof navigator !== 'undefined' && !!navigator.serial) ? 'WEB SERIAL READY — OR RUN THE PCC BRIDGE'
        : 'NO WEB SERIAL — RUN THE PCC BRIDGE (DEVICE › CONNECT)',
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
      cbAstDark: this.cb(!!st.modesEnabled.dark), oAstDark: () => this.toggleMode('dark'),   // MODE_DARK — twilight ladder: civil/nautical/astronomical dusk + countdown to darkness
      cbAstStar: this.cb(!!st.modesEnabled.star), oAstStar: () => this.toggleMode('star'),   // MODE_STAR — the NEXT TRANSITS panel needs an enable path (was config-only)
      cbDgTc: this.cb(!!st.modesEnabled.tempcomp), oDgTc: () => this.toggleMode('tempcomp'),   // diagnostic read-out — lives in ADVANCED
      cbDgAdev: this.cb(!!st.modesEnabled.adev), oDgAdev: () => this.toggleMode('adev'),   // MODE_ADEV — Allan-deviation page; parser + ingest existed but had no UI enable
      cbWdFull: this.cb(!!st.modesEnabled.weekday), oWdFull: () => this.toggleMode('weekday'),
      cbWdMmdd: this.cb(!!st.modesEnabled.wdy_mm_dd), oWdMmdd: () => this.toggleMode('wdy_mm_dd'),
      cbWdDd: this.cb(!!st.modesEnabled.weekda_dd), oWdDd: () => this.toggleMode('weekda_dd'),
      cbTrSid: this.cb(!!st.modesEnabled.sidereal), oTrSid: () => this.toggleMode('sidereal'),
      cbTrSol: this.cb(!!st.modesEnabled.solar), oTrSol: () => this.toggleMode('solar'),
      cbTrOff: this.cb(!!st.modesEnabled.offset), oTrOff: () => this.toggleMode('offset'),
      cbTrTz: this.cb(!!st.modesEnabled.tz), oTrTz: () => this.toggleMode('tz'),
      cbTrZone2: this.cb(!!st.modesEnabled.zone2), oTrZone2: () => this.toggleMode('zone2'),   // MODE_ZONE2 — second civil timezone on the date row
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
            ? 'OVERRIDDEN: SIGNIFICANCE FADE is on. Digits are dashed by the measured 3σ holdover uncertainty. Turn the fade off to use these timers.'
            : 'Holdover seconds before each digit is dashed (Tolerance_time_* in config.txt). Ignored while SIGNIFICANCE FADE is on.',
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
      // LED balance calibration read-back (#16): the seg/colon brightness equalisation was applied
      // blind — surface the firmware's actual state (OFF / AUTO / manual strength) here.
      balSeg: this.emu && this.emu.balanceState ? this.emu.balanceState().seg : '—',
      balColon: this.emu && this.emu.balanceState ? this.emu.balanceState().colon : '—',
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
      // CUCKOO schedule segmented control (persisted)
      // Emulator config.txt: APPLY through the real firmware parser + reboot; EXPORT/IMPORT a file.
      // Stage E — when a real Mk IV is attached, APPLY also mirrors every setting onto the
      // physical clock live over serial (runtime-only; see mirrorConfigToDevice).
      emuCfgSync: (() => {
        if (this._emuCfgNote) return this._emuCfgNote;
        const S = this.session && this.session.S;
        return (S && S.real && this.realdev)
          ? 'MK IV CONNECTED. APPLY ALSO MIRRORS THESE SETTINGS TO THE CLOCK OVER SERIAL (RUNTIME ONLY). THE CLOCK’S config.txt IS UNCHANGED. EXPORT AND DROP ON THE DRIVE TO PERSIST.'
          : 'EMULATOR ONLY. CONNECT A MK IV TO MIRROR APPLY ONTO THE PHYSICAL CLOCK.';
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
          ? ('✓ SENT ' + n + ' SETTINGS TO THE CLOCK (RUNTIME-ONLY). EXPORT config.txt TO PERSIST ACROSS A POWER-CYCLE.')
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
      // .seg carries its own state in CSS off aria-pressed, so the segmented control no longer
      // needs a computed style string pushed into markup — and it announces correctly.
      apSrcLocal: st.utc ? 'false' : 'true', apSrcUtc: st.utc ? 'true' : 'false',
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
    const serialOk = typeof navigator !== 'undefined' && !!navigator.serial;
    const bridgeOk = !!st.bridgeInfo;
    const ctxOk = typeof window !== 'undefined' && window.isSecureContext;
    const chrom = typeof window !== 'undefined' && !!window.chrome;
    const bridge = !!this.state.bridgeInfo;   // pccd answered its probe — the bridge transport is up
    return {
      cPort: this.portName(S),
      cDevice: conn ? (S.real ? 'Precision Clock Mk IV · STM32 CDC' : 'Emulated Mk IV · no hardware') : '—',
      cSession: S ? this.fmtDur(Date.now() / 1000 - S.t0) : '—',
      cFix: S && S.fix.valid ? '3D · HDOP ' + S.fix.hdop.toFixed(2) : (conn ? (S.scenario === 'nofix' ? 'NO FIX' : 'ACQUIRING') : '—'),
      cSats: S && conn ? S.fix.sats + ' / ' + S.sats.filter((x) => x.visible).length : '—',
      cAge: S && S.fix.valid && S.fixAgeT ? ((Date.now() - S.fixAgeT) / 1000).toFixed(1) + ' s' : '—',
      // ---- THE RACK (Law 1) for DEVICE. What am I connected to, and is it healthy — stated before
      // the setup procedure rather than after it. Disconnected is the honest default: cells dash and
      // say what is missing, which is also the room's call to action.
      ...(() => {
        const real = !!(S && S.real);
        const cfg = (S && S.cfg && S.cfg.modes) ? Object.keys(S.cfg).length : 0;
        return {
          vLinkSt: conn ? (real ? 'live' : 'sim') : 'absent',
          vLinkV: conn ? '115200' : '—',
          vDeviceS: conn ? (real ? 'MK IV · STM32 CDC' : 'EMULATED · NO HARDWARE') : 'NOT CONNECTED',
          vSatsS: conn ? ((S.fix.sats || 0) + ' USED / ' + S.sats.filter((x) => x.visible).length + ' IN VIEW') : 'NO RECEIVER',
          vFwSt: conn ? (real ? 'live' : 'sim') : 'absent',
          vFwV: conn ? (real ? (S.fwVersion || 'UNREAD') : 'WASM') : '—',
          vFwS: conn ? (real ? 'READ FROM DEVICE' : 'BUILT FROM SOURCE') : 'CONNECT TO READ',
          vCfgSt: cfg ? 'live' : 'absent',
          vCfgV: cfg || '—', vCfgU: cfg ? 'keys' : '',
          vCfgS: cfg ? 'config.txt · READ' : 'NOT READ · USE READ CLOCK DRIVE',
          vTransSt: conn ? 'live' : 'absent',
          vTransV: conn ? (real ? 'SERIAL' : 'EMU') : '—',
          vTransS: conn ? (real ? this.withAge('WEB SERIAL · USB CDC') : 'IN-BROWSER FIRMWARE') : (chrom ? 'WEB SERIAL AVAILABLE' : 'NEEDS A CHROMIUM BROWSER'),

          // ---- CONNECTING A REAL CLOCK: each transport reports its READINESS AS A VALUE, so the
          // room answers "can I use this, here, now?" instead of making you read a walkthrough and
          // work it out. live = this one is carrying the clock; ready = usable now; warn = usable
          // once something changes; absent = not available in this browser.
          trWsSt: (conn && real) ? 'live' : (ctxOk && chrom ? 'ready' : 'absent'),
          trWsV: (conn && real) ? 'CONNECTED'
            : !chrom ? 'UNAVAILABLE — NOT CHROMIUM'
            : !ctxOk ? 'UNAVAILABLE — NEEDS HTTPS OR LOCALHOST'
            : 'AVAILABLE',
          trBrSt: bridge ? (conn && real ? 'live' : 'ready') : 'warn',
          trBrV: bridge ? ((conn && real) ? 'CONNECTED' : 'RUNNING — READY') : 'NOT RUNNING — INSTALL BELOW',
        };
      })(),
      // One command each, copied rather than transcribed from a wall of shell.
      onCopyPccd: () => { try { navigator.clipboard.writeText('curl -L https://github.com/peterlewis/pcc/releases/latest/download/pccd-macos-universal.tar.gz | tar xz && cd pcc && ./pccd\n'); } catch (e) {} },
      onCopyPccdLinux: () => { try { navigator.clipboard.writeText('curl -L https://github.com/peterlewis/pcc/releases/latest/download/pccd-linux-$(uname -m).tar.gz | tar xz && cd pcc && ./pccd\n'); } catch (e) {} },
      onCopyChrony: () => { try { navigator.clipboard.writeText('refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4\n'); } catch (e) {} },
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
          const r = this.realdev.readClockVolume ? await this.realdev.readClockVolume() : await this.realdev.readConfigFile();
          // ≥v0.0.5 clocks persist on-device MENU edits into SETTINGS.BIN, so the EFFECTIVE config is
          // config.txt ⊕ those overrides (merged with the firmware's mtime-stamped precedence rule).
          // Reconstruct that merge here so the app reflects what the clock is actually doing.
          let ovr = null, parsedKeep = null;
          if (r.settings && this.SB) {
            const parsed = this.SB.parseSettingsBin(r.settings);
            parsedKeep = parsed && parsed.found ? parsed : null;   // raw fields feed MERGE INTO config.txt
            ovr = this.SB.winningOverrides(parsed, r.text, r.mtime, this.fwModeName());
            if (ovr) {
              const f = parsed.fields;
              const wins = (id) => { const e = ovr.entries.find((x) => x.id === id); return !!(e && e.wins); };
              if (wins('colon') && this.SB.COLON_NAMES[f.colon]) r.cfg.colon = this.SB.COLON_NAMES[f.colon];
              if (wins('brightness') && f.brightness >= 0) r.cfg.brightness = 1 - f.brightness / 4095; // raw inverted-DAC → fraction; <0 = sensor AUTO (leave as-is)
              if (wins('matrixFreq')) r.cfg.matrixHz = f.matrixFreq;
              if (wins('pageMs')) r.cfg.astroPageMs = f.pageMs;
              for (const m of ovr.modes) if (m.wins && m.name.startsWith('MODE_')) (r.cfg.modes = r.cfg.modes || {})[m.name] = m.on;
            }
          }
          this.applyDeviceConfig(r.cfg);
          this._menuOvr = ovr;                                // panel model (not serialisable state)
          this._menuOvrParsed = parsedKeep;                   // raw SETTINGS.BIN fields for the transpose
          this.cfgHandle = r.fh; this._cfgOriginal = r.text; // handle/original are not serialisable state
          if (this.els.cfgEditor) this.els.cfgEditor.value = r.text;
          const en = Object.values(r.cfg.modes || {}).filter(Boolean).length;
          const ovrN = ovr ? ovr.entries.length + ovr.modes.length : 0;
          if (this.session.log) this.session.log('rx', `[config] ${r.name}: colon=${r.cfg.colon || '?'} · ${en} modes enabled${ovrN ? ` · ${ovrN} menu override${ovrN === 1 ? '' : 's'} merged (SETTINGS.BIN gen ${ovr.gen})` : (r.settings ? ' · SETTINGS.BIN: no menu edits stored' : '')} — applied to face`);
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
      // MENU OVERRIDES — the on-device menu edits recovered from SETTINGS.BIN (≥v0.0.5), with the
      // firmware's own precedence verdict per key. Rendered only after a volume read that found them.
      menuOvrOn: !!(this._menuOvr && (this._menuOvr.entries.length || this._menuOvr.modes.length)),
      menuOvrRows: this._menuOvr ? [
        ...this._menuOvr.entries.map((e) => ({
          k: 'e' + e.id, label: e.label, value: e.value,
          tag: e.wins ? (e.cfgHasIt ? 'OVERRIDES config.txt' : 'MENU-OWNED') : 'SUPERSEDED BY config.txt',
          tagColor: e.wins ? 'var(--lock)' : 'var(--txt3)',
        })),
        ...this._menuOvr.modes.map((m) => ({
          k: 'm' + m.ordinal, label: m.name.replace(/^MODE_/, '').replace(/_/g, ' '), value: m.on ? 'ENABLED' : 'DISABLED',
          tag: m.wins ? (m.cfgHasIt ? 'OVERRIDES config.txt' : 'MENU-OWNED') : 'SUPERSEDED BY config.txt',
          tagColor: m.wins ? 'var(--lock)' : 'var(--txt3)',
        })),
      ] : [],
      menuOvrNote: this._menuOvr ? (this._menuOvr.stampOk
        ? `config.txt unchanged since the menu edit (stamp match). Menu values take precedence, including keys config.txt defines · store gen ${this._menuOvr.gen}`
        : `config.txt was re-saved after the menu edit. config.txt takes precedence wherever both define a key · store gen ${this._menuOvr.gen}`) : '',
      // Transpose the on-device menu state into the config.txt editor as key = value lines. Existing
      // lines for those keys are commented out and the block is APPENDED — the firmware parses top to
      // bottom, last write wins, so the appended block is authoritative and the history stays visible.
      // Saving then re-stamps config.txt's mtime, which is exactly right: config re-asserts these keys.
      onMenuOvrMerge: () => {
        const p = this._menuOvrParsed, ovr = this._menuOvr, SB = this.SB;
        if (!p || !ovr || !SB || !this.els.cfgEditor) return;
        const f = p.fields;
        const kidOf = (id) => (SB.KIDS.find((k) => k.id === id) || {}).kid;
        const has = (id) => !!(p.simpleMask & (1 << kidOf(id)));
        const kv = [];   // [key, value|null]; null = menu says AUTO → the key must be ABSENT (comment out only)
        if (has('brightness')) kv.push(['brightness', f.brightness < 0 ? null : String(f.brightness)]);
        if (has('colon')) kv.push(['colon_mode', SB.COLON_NAMES[f.colon] || 'slowfade']);
        if (has('colonAlt')) kv.push(['colon_alt_mode', SB.COLON_NAMES[f.colonAlt] || 'slowfade']);
        if (has('pageMs')) kv.push(['page_ms', String(f.pageMs)]);
        if (has('sigFade')) kv.push(['significance_fade', f.sigFade ? 'on' : 'off']);
        if (has('pps')) kv.push(['pps', f.pps ? 'on' : 'off']);
        if (has('nmea')) kv.push(['nmea', SB.NMEA_NAMES[f.nmea] || 'all']);
        if (has('matrixFreq')) kv.push(['matrix_frequency', String(f.matrixFreq)]);
        if (has('tempcomp')) { const v = f.tempcomp ? 'on' : 'off'; kv.push(['tc_learn', v], ['tc_apply', v], ['tc_persist', v]); }
        if (has('balance')) { const v = f.balance ? 'on' : 'off'; kv.push(['seg_balance', v], ['colon_balance', v]); }
        for (const m of ovr.modes) kv.push([m.name, m.on ? 'on' : 'off']);
        if (!kv.length) return;
        const keys = new Set(kv.map(([k]) => k.toLowerCase()));
        const lines = this.els.cfgEditor.value.split(/\r?\n/).map((ln) => {
          const mm = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);   // uncommented definitions only
          return (mm && keys.has(mm[1].toLowerCase())) ? '#' + ln : ln;
        });
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        if (lines.length) lines.push('', '');   // spacer only when there is existing content above
        lines.push('## as set in the on-device menu — transposed by PCC');
        for (const [k, v] of kv) lines.push(v == null ? `# ${k}: AUTO in the menu — key left unset` : `${k} = ${v}`);
        lines.push('');
        this.els.cfgEditor.value = lines.join('\n');
        if (this.session && this.session.log) this.session.log('tx', `[config] transposed ${kv.length} menu value${kv.length === 1 ? '' : 's'} into the editor — SAVE TO CLOCK to write them`);
        this.setState({ cfgDirty: this.els.cfgEditor.value !== (this._cfgOriginal || '') });
      },
      cfgSaveDisabled: !(st.cfgDirty && st.cfgWrite && this.cfgHandle),
      cfgSaveStyle: this.btn(false, !(st.cfgDirty && st.cfgWrite && this.cfgHandle)),
      readCfgDisabled: this.appMode() === 'standby' || !(typeof window !== 'undefined' && ('showDirectoryPicker' in window || 'showOpenFilePicker' in window)),
      readCfgStyle: this.btn(false, this.appMode() === 'standby' || !(typeof window !== 'undefined' && ('showDirectoryPicker' in window || 'showOpenFilePicker' in window))),
      // SIMULATE is a toggle, never greyed by history — only blocked while a real device is live.
      // CONNECT DEVICE needs A transport: Web Serial or a detected pccd bridge (any browser).
      realDisabled: conn || !(serialOk || bridgeOk), connectDisabled: !!(S && S.real), discDisabled: !conn,
      btnRealStyle: this.btn(true, conn || !(serialOk || bridgeOk)), btnConnStyle: this.btn(false, !!(S && S.real)), btnDiscStyle: this.btn(false, !conn),
      simBtnLabel: st.sim ? 'STOP SIMULATION' : 'SIMULATE',
      realSeen, isReal: !!(S && S.real),
      supSerial: serialOk ? 'AVAILABLE' : 'NOT AVAILABLE', supSerialC: serialOk ? 'var(--lock)' : 'var(--none)',
      supBridge: bridgeOk ? ('DETECTED v' + (st.bridgeInfo.version || '?') + ' — ' + (st.bridgeInfo.device || 'no device')) : 'NOT RUNNING',
      supBridgeC: bridgeOk ? 'var(--lock)' : 'var(--txt3)',
      supCtx: ctxOk ? 'SECURE' : 'INSECURE', supCtxC: ctxOk ? 'var(--lock)' : 'var(--none)',
      supChrom: chrom ? 'CHROMIUM' : 'NON-CHROMIUM', supChromC: chrom ? 'var(--lock)' : 'var(--acq)',
      gateVisible: (!serialOk || !ctxOk) && !bridgeOk,
    };
  }

  rvSats() {
    const st = this.state, S = this.session && this.session.S;
    const out = {
      cbHeat: this.cb(st.skyHeatmap), oHeat: () => this.setState({ skyHeatmap: !st.skyHeatmap }, () => this.drawChart('sky')),
      cbHoriz: this.cb(st.skyHorizon), oHoriz: () => this.setState({ skyHorizon: !st.skyHorizon }, () => this.drawChart('sky')),
      cbTrails: this.cb(st.skyTrails), oTrails: () => this.setState({ skyTrails: !st.skyTrails }, () => this.drawChart('sky')),
      cbLabels: this.cb(st.skyLabels), oLabels: () => this.setState({ skyLabels: !st.skyLabels }, () => this.drawChart('sky')),
      // SPAN drives the trail ribbons AND the heatmap history; dim it when neither layer is on.
      spanDim: (!st.skyTrails && !st.skyHeatmap) ? 'opacity:.4' : '',
      ssTrail45: this.seg(st.skyTrailAge === 2700, true), ssTrail1h: this.seg(st.skyTrailAge === 3600, false),
      ssTrail3h: this.seg(st.skyTrailAge === 10800, false), ssTrail6h: this.seg(st.skyTrailAge === 21600, false),
      ssTrail12h: this.seg(st.skyTrailAge === 43200, false), ssTrail24h: this.seg(st.skyTrailAge === 86400, false),
      oTrail45: () => this.setTrailAge(2700), oTrail1h: () => this.setTrailAge(3600),
      oTrail3h: () => this.setTrailAge(10800), oTrail6h: () => this.setTrailAge(21600),
      oTrail12h: () => this.setTrailAge(43200), oTrail24h: () => this.setTrailAge(86400),
    };
    if (!S) {
      Object.assign(out, { fLat: '—', fLon: '—', fAlt: '—', fHdop: '—', fFix: '—', fSatsUV: '—', fGrid: '—', cSunAlt: '—', cSunAz: '—', cMoonAlt: '—', cMoonAz: '—', cMoonPhase: '—', cMoonIllum: '—', cRise: '—', cSet: '—', sStarted: '—', sPasses: '—', sObs: '—', sPeak: '—', sCover: '—', nGps: '·', nGlo: '·', nGal: '·', nBds: '·', starShow: false, starSrc: '', starRows: [],
        // Rack, with no session at all: every cell absent and saying why, never a fabricated zero.
        kRackSt: 'absent', kRackPps: 'off', kConst: 'NO SESSION', kDopNote: 'NO FIX',
        kLatLon: 'NO POSITION', kFixNote: 'NO FIX', kAgeSt: 'absent', kPeak: '—',
        kRecSt: 'absent', kRecSub: 'NOTHING RECORDED YET' });
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
      // ---- THE RACK (Law 1) for SKY. All six values were already in the right-hand rail; the rack
      // promotes the six the ROOM is accountable for so the answer precedes the plot. FIX AGE is the
      // honesty cell — it steps to acq then alert as the fix goes stale, because a plot drawn from a
      // minutes-old fix looks exactly as confident as one drawn from a fresh one.
      ...(() => {
        const valid = !!(S.fix && S.fix.valid);
        const ageS = (S.fix && S.fix.valid && S.fixAgeT) ? (Date.now() - S.fixAgeT) / 1000 : null;
        const hd = valid ? S.fix.hdop : null;
        return {
          kRackSt: valid ? 'live' : 'absent',
          kConst: valid ? ('G' + cnt('G') + ' R' + cnt('R') + ' E' + cnt('E') + ' C' + cnt('C')) : 'NO FIX',
          kDopNote: hd == null ? 'NO FIX' : hd < 1 ? 'IDEAL GEOMETRY' : hd < 2 ? 'GOOD GEOMETRY' : hd < 5 ? 'MODERATE' : 'POOR GEOMETRY',
          kLatLon: valid ? (S.obs.lat.toFixed(4) + ', ' + S.obs.lon.toFixed(4)) : 'OBSERVER DEFAULT',
          kFixNote: ageS == null ? 'NO FIX' : 'RMC 1 Hz',
          kAgeSt: ageS == null ? 'absent' : ageS < 5 ? 'live' : ageS < 30 ? 'stale' : 'alert',
          kPeak: 'PEAK EL ' + S.peakEl.toFixed(0) + '°',
          kRecSt: S.passes > 0 ? 'live' : 'absent',
          kRecSub: S.passes > 0
            ? this.withAge((S.obsCount > 1000 ? (S.obsCount / 1000).toFixed(1) + 'k' : String(S.obsCount)) + ' OBS')
            : 'NOTHING RECORDED YET',
        };
      })(),
    });
    // NEXT TRANSITS — the star-transit predictor's $PMSTAR list (MODE_STAR). From a real clock
    // (realdev.js → S.star) when Connected; from the emulator's own predictor (S.simStar, refreshed
    // in onTick) when Simulating. The panel's source label (starSrc) marks which, so a SIMULATED
    // list is never mistaken for device data; Standby still synthesises nothing.
    const star = S.real ? S.star : (this.appMode() === 'simulation' ? S.simStar : null);
    const starSrc = S.real ? 'DEVICE' : (star ? 'SIMULATED' : '');
    const nowS = Math.floor(Date.now() / 1000);
    // Countdown formats: mm:ss under an hour, h:mm above (transit lists span hours).
    const eta = (s) => {
      s = Math.max(0, s);   // 0 = transiting now; holds there until the next $PMSTAR
      return s >= 3600
        ? Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0')
        : String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };
    Object.assign(out, {
      starShow: !!(star && star.stars.length),
      starSrc,
      starRows: star ? star.stars.map((x) => ({
        name: x.name,
        // sec_to_transit was true at receive time (star.at) — age it against the
        // wall clock so the countdown ticks between sparse $PMSTAR emissions.
        eta: eta(x.secToTransit - (nowS - star.at)),
        alt: x.altDeg + '°',
        dir: x.dir,
      })) : [],
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
    const S = this.session && this.session.S;
    // STANDBY has no clock and no simulation, so it has no PPS, no die, and nothing "GPS disciplined".
    // Gate on the app MODE — not merely on "does S.pps hold data": a leftover buffer (a stale-dropped
    // device, a stopped sim) would otherwise render as live telemetry in the one state whose whole
    // invariant is that it shows none. driveEmu doesn't recompute _timing in standby either, so T is
    // stale there too — dashing on mode covers both the buffer and the derived scalars.
    const standby = this.appMode() === 'standby' && !this._reviewing;   // REVIEW rebuilds S.pps for the scrubber — don't dash it
    const fit = standby ? null : T.fit;
    // $PMTXTS is implemented in DRAFT firmware PRs (gated by `pps = on`) — not yet
    // merged upstream. The banner reflects where the stream is coming from right now.
    const streaming = !standby && !!(S && S.pps && S.pps.list && S.pps.list.length);
    const noPps = !!(S && S.real && !streaming); // real hardware, no PPS stream yet → dash the timing KPIs
    const noData = !streaming;                   // NO live PPS at all (standby, or real-without-stream) → nothing honest to show
    // msFolds: samples where the firmware's subms raced its SysTick cascade and reported the same
    // phase 1 ms off (folded in realdev.js). Shown so the heal is visible, not silent.
    const folds = S && S.real && S.pps && S.pps.msFolds ? ' · MS-RACE FOLDED ×' + S.pps.msFolds : '';
    const banner = S && S.real
      ? (streaming ? '$PMTXTS · LIVE · DRAFT FW (pps=on)' + folds : '$PMTXTS · SEND "pps = on" TO STREAM')
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
      // Rack state for TIMING. noData is the honest absent case — the room's six cells all show an
      // em-dash and cell 6 carries the reason, rather than the charts implying a stream that isn't
      // there. The colon only pulses when a PPS edge is actually arriving.
      tRackSt: noData ? 'absent' : 'live',
      tRackProv: noData ? 'NO $PMTXTS · pps=off' : this.withAge('DROPPED ' + String(T.drop || 0)),
      fitK0: fit ? fit.k0.toFixed(4) : '—', fitK1: fit ? fit.k1.toFixed(5) : '—', fitK2: fit ? fit.k2.toFixed(6) : '—',
      fitSpread: fit ? fit.spread.toFixed(1) + ' °C' : '—',
      fitRms: fit ? fit.rms.toFixed(2) + ' ppm' : '—',
      fitN: fit ? String(fit.n) : '0',
      fitStatus: fit ? (fit.ready ? (fit.lineOnly ? 'READY — LINE FIT' : 'READY — QUADRATIC') : 'COLLECTING — NEED ≥30 SAMPLES / ≥8 °C')
        : (streaming ? 'COLLECTING — NEED ≥30 SAMPLES / ≥8 °C' : 'AWAITING SAMPLES'),
      fitStatusC: fit && fit.ready ? 'var(--lock)' : 'var(--acq)',
      // Emit the tempcomp firmware's REAL seed vocabulary (tc_t0 / tc_lse_a/b/c / tc_seed) — the
      // legacy `temp_comp = k0,k1,k2` key was never parsed by any firmware. The block is only shown
      // once the fit is trustworthy (ready); before that a comment says what's still needed, so a
      // half-baked curve can't be pasted into config.txt by accident. tc_dump stays canonical.
      compState: noData ? 'IDLE — NO TIMING STREAM' : (fit && fit.ready ? 'FIT READY — SEED BLOCK FOR config.txt' : 'CHARACTERISING — BLOCK PENDING'),
      compStateC: noData ? 'var(--txt3)' : (fit && fit.ready ? 'var(--lock)' : 'var(--txt2)'),
      compLine: fit && fit.ready && this.PT
        ? this.PT.tcSeedBlock({ k0: fit.k0, k1: fit.k1, k2: fit.k2, tlo: fit.tMin, thi: fit.tMax, n: fit.n, rms: fit.rms }).configBlock
        : (fit ? `# characterising — need ≥30 samples & ≥8 °C span (have ${fit.n}, ${fit.spread.toFixed(1)} °C)`
          : (streaming && S && S.pps && S.pps.samples && S.pps.samples.length
            ? (() => {   // stream live but the fit hasn't engaged: say what's been collected, not "awaiting"
                const t = S.pps.samples.map((x) => x.temp);
                return `# characterising — collecting samples (${S.pps.samples.length}, ${(Math.max(...t) - Math.min(...t)).toFixed(1)} °C span; need ≥30 & ≥8 °C)`;
              })()
            : '# tc seed — awaiting timing stream')),
      // FIRMWARE LEARNED MODEL — the device's own on-die tempcomp state, read back over serial
      // ("tc_dump = on" → $PMTXTC H/L + a state header, parsed in realdev.js → S.tc). Distinct from
      // the host fit above: this is what the CLOCK ITSELF has learned and steers holdover with.
      ...((() => {
        const tc = S && S.real ? S.tc : null;
        if (!S || !S.real) return { fwTcState: S && S.connected ? 'REAL HARDWARE ONLY — SIM HAS NO ON-DIE MODEL' : 'CONNECT A CLOCK TO READ ITS MODEL',
          fwTcStateC: 'var(--txt3)', fwTcHse: '—', fwTcLse: '—', fwTcRange: '—', fwTcMeta: '—' };
        if (!tc || (!tc.hse && !tc.lse)) return { fwTcState: 'AWAITING tc_dump REPLY…', fwTcStateC: 'var(--acq)',
          fwTcHse: '—', fwTcLse: '—', fwTcRange: '—', fwTcMeta: 'sent "tc_dump = on" at connect' };
        const stateName = { A: 'APPLYING — HOLDOVER STEERING ACTIVE', F: 'FROZEN — config.txt OVERRIDES LEARNING',
          L: 'LEARNING', S: 'SEEDED — EVOLVING FROM WARM-START', '-': 'IDLE' }[tc.state] || ('STATE ' + (tc.state || '?'));
        const h = tc.hse, l = tc.lse;
        const age = Math.max(0, Math.floor(Date.now() / 1000) - tc.at);
        return {
          fwTcState: stateName,
          fwTcStateC: (h && h.valid) || (l && l.valid) ? 'var(--lock)' : 'var(--acq)',
          fwTcHse: h ? `${h.n.toLocaleString()} samples · b ${h.b.toFixed(5)} · c ${h.c.toFixed(6)} ppm/°C${h.valid ? '' : ' · NOT YET VALID'}` : '—',
          fwTcLse: l ? `${l.n.toLocaleString()} samples · a ${l.a.toFixed(4)} ppm · b ${l.b.toFixed(5)} · c ${l.c.toFixed(6)}${l.valid ? '' : ' · NOT YET VALID'}` : '—',
          fwTcRange: tc.die ? `${tc.die[0]}–${tc.die[1]} °C DIE` : (h ? `${h.tmin}–${h.tmax} °C DIE` : '—'),
          fwTcMeta: `tc_dump · ${age < 5 ? 'just now' : age + ' s ago'} · refreshes every 5 min`,
        };
      })()),
    };
  }

  rvGlobe() {
    const st = this.state, S = this.session && this.session.S;
    const sun = S ? this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon) : null;
    const vis = S ? S.sats.filter((x) => x.visible) : [];
    const cnt = (id) => vis.filter((x) => x.constId === id).length;
    return {
      cbGTerm: this.cb(st.globeTerm), oGTerm: () => this.setState({ globeTerm: !st.globeTerm }, () => this.drawGround()),
      cbGTrails: this.cb(st.globeTrails), oGTrails: () => this.setState({ globeTrails: !st.globeTrails }, () => this.drawGround()),
      cbGLabels: this.cb(st.globeLabels), oGLabels: () => this.setState({ globeLabels: !st.globeLabels }, () => this.drawGround()),
      cbGGrat: this.cb(st.globeGrat), oGGrat: () => this.setState({ globeGrat: !st.globeGrat }, () => this.drawGround()),
      gtGlobeOn: st.groundProj !== 'flat', gtFlatOn: st.groundProj === 'flat',
      ssProjGlobe: this.seg(st.groundProj !== 'flat', true), ssProjFlat: this.seg(st.groundProj === 'flat', false),
      onProjGlobe: () => this.setState({ groundProj: 'globe' }, () => this.drawGround()),
      onProjFlat: () => this.setState({ groundProj: 'flat' }, () => this.drawGround()),
      // MAP's own toggles — independent state, and they redraw the MAP (the visible surface), not
      // the off-screen globe the shared handlers used to repaint a beat late.
      cbGRot: this.cb(st.globeRotate), oGRot: () => this.setState({ globeRotate: !st.globeRotate }),
      cbGClock: this.cb(st.globeClock), oGClock: () => this.setState({ globeClock: !st.globeClock }),
      globeClockOn: st.globeClock,
      gSub: sun ? sun.subLat.toFixed(1) + '° / ' + sun.subLon.toFixed(1) + '°' : '—',
      gVis: S ? 'G' + cnt('G') + ' · R' + cnt('R') + ' · E' + cnt('E') + ' · C' + cnt('C') : '—',
      gClock: new Date().toISOString().slice(11, 19) + ' UTC',
      // (used to promise "production uses photographic earth" — a leftover from the macOS-app port
      // plan. This IS production; the cartographic render is the design, so say only what's true.)
      landNote: this.landTried && !this.land ? 'COASTLINE DATA UNAVAILABLE — GRATICULE ONLY' : 'CARTOGRAPHIC RENDER — VECTOR COASTLINES + GRATICULE',
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

  // Serial-monitor line filter. Space/comma-separated tokens, case-insensitive:
  //   plain token  → keep lines CONTAINING it (multiple = OR: "GGA RMC" shows either)
  //   -token / !token → HIDE lines containing it (exclude wins over include)
  // Empty filter keeps everything. Cheap substring match over the ~420-line capped log.
  monFilterPred(filter) {
    const q = (filter || '').trim();
    if (!q) return null;
    const inc = [], exc = [];
    for (const t of q.split(/[\s,]+/)) {
      if (!t) continue;
      if ((t[0] === '-' || t[0] === '!') && t.length > 1) exc.push(t.slice(1).toLowerCase());
      else inc.push(t.toLowerCase());
    }
    if (!inc.length && !exc.length) return null;
    return (text) => {
      const T = String(text || '').toLowerCase();
      if (exc.some((e) => T.includes(e))) return false;
      return !inc.length || inc.some((i) => T.includes(i));
    };
  }

  rvMonitor() {
    const st = this.state, S = this.session && this.session.S;
    const full = st.monPaused ? (this._monFrozen || []) : (S ? S.nmeaLog : []);
    const pred = this.monFilterPred(st.monFilter);
    const src = pred ? full.filter((l) => pred(l.text)) : full;
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
      // FILTER: uncontrolled input (like the command line) — read on input, re-render the rows. The
      // count shows "shown / total" only while a filter is active, so it's clear it's doing something.
      refMonFilter: this.ref('monFilter'),
      onMonFilterInput: () => this.setState({ monFilter: this.els.monFilter ? this.els.monFilter.value : '' }, () => this.scrollLog(true)),
      monFilterActive: !!(pred),
      monShown: pred ? (src.length + ' / ' + full.length + ' SHOWN') : '',
      onClear: () => { if (S) { S.nmeaLog.length = 0; this._monFrozen = []; this.setState({}); } },
      onSendCmd: () => this.sendCmd(),
      onCmdKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.sendCmd(); } },
    };
  }

  // ---- flight-recorder archive (pccd /history) ----------------------------------------------------
  // The daemon records timing + sky rows continuously; these fetch a decimated slice for the ARCHIVE
  // panels. Real recorded data with its source named, so it may render in any app state (incl. Standby).
  archSpans() { return { '6h': 21600, '24h': 86400, '7d': 604800, 'all': 0 }; }
  fetchArchive(force) {
    const hi = this.state.bridgeInfo && this.state.bridgeInfo.history;
    if (!hi || !this.realdev) { this._arch = null; return; }
    const range = this.state.archRange || '24h';
    const fresh = this._arch && this._arch.range === range && Date.now() - this._arch.at < 60000;
    if ((fresh && !force) || this._archBusy) return;
    this._archBusy = true;
    const to = Math.floor(Date.now() / 1000);
    const span = this.archSpans()[range];
    const from = span ? to - span : Math.floor(Date.parse(hi.from + 'T00:00:00Z') / 1000);
    Promise.all([
      this.realdev.fetchBridgeHistory({ series: 'timing', from, to, points: 700 }),
      this.realdev.fetchBridgeHistory({ series: 'sky', from, to, points: 400 }),
    ]).then(([t, s]) => {
      this._arch = { t, s, range, at: Date.now() };
      this._archBusy = false;
      this.setState({});
      this.drawChart('archOffset'); this.drawChart('archAux'); this.drawChart('archSky');
    }).catch(() => { this._archBusy = false; this._arch = { t: [], s: [], range, at: Date.now() }; this.setState({}); });
  }
  // ---- extended satellite trails --------------------------------------------------------------------
  // For long TRAIL windows (>90 min live buffer) in SIMULATION, compute each sat's whole track over the
  // window from the deterministic orbit model (session.computeTrails) instead of waiting to accumulate.
  // Cached and refreshed at most once per trail step, so it doesn't recompute every animation frame.
  // Returns null in CONNECTED/STANDBY (a real clock's sats are not modelled) or for short windows.
  simTrails(winSec) {
    if (this.appMode() !== 'simulation' || winSec <= 5400) return null;
    const obs = this.session.S.obs;
    const key = winSec + '|' + obs.lat.toFixed(3) + ',' + obs.lon.toFixed(3);
    const now = Date.now();
    const stepMs = Math.max(30, Math.min(120, Math.round(winSec / 500))) * 1000;
    if (this._simTrail && this._simTrail.key === key && (now - this._simTrail.at) < stepMs) return this._simTrail;
    const { trails, gtrails } = this.session.computeTrails(winSec);
    this._simTrail = { key, at: now, trails, gtrails };
    return this._simTrail;
  }
  setTrailAge(s) {
    this._simTrail = null;
    // A long window in SIM is the polar view's LONG-TERM record → auto-show the heatmap (the coverage
    // field), since the trail-lines there stay short. Ground-track trails are the MAP/GLOBE story.
    const patch = { skyTrailAge: s };
    if (s > 5400 && this.appMode() === 'simulation' && !this.state.skyHeatmap) patch.skyHeatmap = true;
    this.setState(patch, () => { this.drawChart('sky'); this.drawChart('globe'); this.drawChart('map'); });
  }

  // ---- SIGNAL PATH — the pccd prefilter explainer -------------------------------------------------
  // Runs the REAL prefilter (prefilter.mjs, a verified port of pccd.c pf_push) over a clearly-labelled
  // MODEL stream. Model params (seed, calibrated jitter) rebuild the stream; filter knobs re-run the
  // filter on the SAME stream so a drag shows the filter's effect, not fresh noise.
  spCalibJitter() {
    // Calibrate the model's noise to this clock's MEASURED jitter when the flight recorder has data
    // (T rows carry `jit` = the daemon's MAD sigma, µs). Median over the range; else a legible nominal.
    const t = this._arch && this._arch.t;
    if (t && t.length) {
      const j = t.map((r) => r.jit).filter((x) => x > 0).sort((a, b) => a - b);
      if (j.length) return { us: Math.max(3, j[j.length >> 1]), calibrated: true };
    }
    return { us: 10, calibrated: false };
  }
  spEnsureStream() {
    const sp = this.state.sp;
    // REAL: this clock's pre-gate samples fetched from pccd GET /raw (>=16 needed to arm the gate).
    // MODEL (sample data, simulation only): a seeded synthetic stream, calibrated when possible.
    // NONE: no honest source — the panel shows its absent state instead of a demo.
    if (sp.source === 'none') { this._spStream = null; this._spPf = null; this._spCal = {}; this._spStreamKey = 'none'; return; }
    const useReal = sp.source === 'real' && this._spRaw && this._spRaw.length >= 16;
    const key = useReal ? ('real:' + this._spRawStamp)
      : ('model:' + sp.seed + ':' + this.spCalibJitter().us.toFixed(1));
    if (this._spStreamKey === key && this._spStream) return;   // unchanged — keep the stream + sweep position
    if (useReal) {
      this._spStream = this._spRaw;
      this._spCal = { real: true, live: true, n: this._spRaw.length };
    } else {
      const cal = this.spCalibJitter();
      // coreSigma from measured jitter; outliers model USB-retry spikes ~12x the core
      this._spStream = modelStream({ n: 480, coreSigmaUs: cal.us, outlierRate: 0.035, outlierMagUs: Math.max(80, cal.us * 12), driftUs: cal.us * 0.6, seed: sp.seed });
      this._spCal = cal;
    }
    this._spStreamKey = key;
    this._spNow = this._spStream.length - 1;   // default = the COMPLETE frame; spKick rewinds to 16 to animate
  }
  spCompute() {
    this.spEnsureStream();
    if (!this._spStream) { this._spPf = null; return null; }
    const sp = this.state.sp;
    this._spPf = runPrefilter(this._spStream, { window: sp.window, group: sp.group, k: sp.K, floorUs: sp.floorUs });
    return this._spPf;
  }
  // Fetch this clock's pre-gate raw samples from the bridge (GET /raw). `auto` = triggered by the
  // room-enter auto-select (don't fall back to MODEL on a transient fetch error).
  spFetchRaw() {
    const hi = this.state.bridgeInfo;
    if (!this.realdev || !hi || !(hi.raw > 0)) return;
    if (this._spRawBusy) return;
    this._spRawBusy = true;
    this.realdev.fetchBridgeRaw(600).then((rows) => {
      this._spRawBusy = false;
      this._spRaw = rows; this._spRawStamp = Date.now();
      if (this.state.sp.source === 'real') { this._spStreamKey = null; this._spSwept = false; this.spCompute(); this.drawChart('signalPath'); this.spKick(); this.setState({}); }
    }).catch(() => { this._spRawBusy = false; });   // no fallback: sample data never stands in for a real clock
  }
  // The source is DERIVED, never chosen: a connected clock's raw samples when pccd streams them,
  // SAMPLE DATA only while a simulation runs, otherwise none (honest absence). Re-derived on every
  // timing-room draw, so connect/disconnect/sim transitions land within a tick.
  spSyncSource() {
    const mode = this.appMode();
    const eff = (mode === 'connected' && this.state.bridgeInfo && this.state.bridgeInfo.raw >= 16) ? 'real'
      : (mode === 'simulation' ? 'model' : 'none');
    if (this.state.sp.source === eff) return;
    this.setState({ sp: Object.assign({}, this.state.sp, { source: eff }) });
    this._spStreamKey = null; this._spSwept = false;
    if (eff === 'real') this.spFetchRaw();
    this.spCompute(); this.drawChart('signalPath'); this.spKick();
  }
  spKick() {
    // The COMPLETE frame is always shown by default (_spNow=479). This runs the ONE-TIME fill sweep as
    // an enhancement, but only while actually viewing TIMING and only if it can animate — so a hidden
    // tab / reduced-motion never gets stuck mid-fill, and the per-tick timing hook can't restart it
    // (the _spSwept latch). Reseed / unfreeze clear the latch to replay the intro deliberately.
    if (this._spRAF || !this.els.signalPath) return;
    if (this.state.section !== 'timing') return;        // don't consume the intro while mounted off-room (boot)
    if (this._spSwept) return;                           // one-time intro already ran this view
    if (this.reduced || this.state.sp.freeze || !this.canAnimate()) { this._spSwept = true; this.drawChart('signalPath'); return; }
    this._spNow = 16;   // rewind to the gate-arm point and climb — the pretty intro
    const tick = () => {
      this._spRAF = null;
      if (!this.els.signalPath || this.state.section !== 'timing') { this._spNow = this._spPf ? this._spPf.perSample.length - 1 : 479; this._spSwept = true; return; }
      if (this.state.sp.freeze || !this.canAnimate()) { this._spNow = this._spPf ? this._spPf.perSample.length - 1 : 479; this._spSwept = true; this.drawChart('signalPath'); return; }
      const pf = this._spPf; if (!pf) { this._spNow = 479; this._spSwept = true; return; }
      const full = pf.perSample.length - 1;
      this._spNow = Math.min(full, this._spNow + 3);   // ~accelerated fill
      this.drawChart('signalPath');
      if (this._spNow < full) this._spRAF = requestAnimationFrame(tick);   // stop once filled
      else this._spSwept = true;                        // one-time sweep complete — the tick loop won't restart it
    };
    this._spRAF = requestAnimationFrame(tick);
  }
  spSet(key, v) {
    // filter knobs re-run the filter on the same stream (sweep position preserved); seed/reset rebuild
    const sp = Object.assign({}, this.state.sp, { [key]: v });
    this.setState({ sp });
    if (key === 'corrRatio') { this.setState({}); return; }   // downstream-only: no pf change, just the emit line
    this.spCompute();
    this.drawChart('signalPath');
    this.setState({});   // refresh tiles + config well
  }
  spReset() { this.setState({ sp: Object.assign({}, this.state.sp, { K: PF_REC.k, window: PF_REC.window, group: PF_REC.group, floorUs: PF_REC.floorUs, corrRatio: PF_REC.corrRatio }) }); this.spCompute(); this.drawChart('signalPath'); this.setState({}); }
  spReseed() { const s = ((this.state.sp.seed * 1103515245 + 12345) >>> 0) & 0x7fffffff; this.setState({ sp: Object.assign({}, this.state.sp, { seed: s }) }); this._spStream = null; this._spSwept = false; this.spCompute(); this.spKick(); this.setState({}); }
  spToggleFreeze() { const freeze = !this.state.sp.freeze; this.setState({ sp: Object.assign({}, this.state.sp, { freeze }) }); if (!freeze) { this._spSwept = false; this.spKick(); } else this.drawChart('signalPath'); this.setState({}); }
  spConfigText() {
    const sp = this.state.sp;
    const atRec = sp.K === PF_REC.k && sp.window === PF_REC.window && sp.group === PF_REC.group && sp.floorUs === PF_REC.floorUs && sp.corrRatio === PF_REC.corrRatio;
    const head = atRec ? '# recommended configuration'
      : '# NON-DEFAULT — values below differ from the shipped build (rebuild pccd for the prefilter built-ins)';
    return head + '\n' +
      '# pccd build: PF_WIN=' + sp.window + '  PF_AGG=' + sp.group + '  gate=' + sp.K.toFixed(1) + 'σ  floor=' + sp.floorUs + 'us   (compile-time constants in pccd.c pf_push)\n' +
      'refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4 poll ' + PF_REC.poll + ' filter ' + PF_REC.filter + ' prefer\n' +
      'corrtimeratio ' + sp.corrRatio;
  }
  rvSignalPath() {
    if (!this._spPf) this.spCompute();
    // pf is legitimately null when there is no honest source (spOn=false paints the absent state);
    // every binding below must still resolve or the WHOLE rv assembly dies and the app stops rendering.
    const sp = this.state.sp, pf = this._spPf;
    const st = pf ? pf.stats : { rawRms: null, cleanRms: null, reduction: 0, rejected: 0, total: 0, kept: 0, groupsOut: 0 };
    const cal = this._spCal || { us: 10, calibrated: false };
    const fmt = (x, d = 0) => (x == null ? '—' : x.toFixed(d));
    // latest gate half-width (K·σ) at the newest sample, and whether σ is floored there
    let gateUs = null, floored = false;
    if (pf) for (let i = pf.perSample.length - 1; i >= 0; i--) { const p = pf.perSample[i]; if (p.gated) { gateUs = sp.K * p.sigma; floored = p.sigma <= sp.floorUs + 1e-9; break; } }
    // one slider row's binding bundle
    const recKey = (key) => (key === 'K' ? 'k' : key);   // state uses K; PF_REC uses k. others match.
    const knob = (key, min, max, step) => ({
      val: sp[key], atRec: sp[key] === PF_REC[recKey(key)],
      on: (e) => this.spSet(key, key === 'K' ? parseFloat(e.target.value) : parseInt(e.target.value, 10)),
      rec: () => this.spSet(key, PF_REC[recKey(key)]),
      min, max, step,
    });
    const recCol = (atRec) => (atRec ? 'var(--lock)' : 'var(--txt)');
    const kK = knob('K', PF_RANGE.k[0], PF_RANGE.k[1], 0.1);
    const kW = knob('window', PF_RANGE.window[0], PF_RANGE.window[1], 8);
    const kG = knob('group', PF_RANGE.group[0], PF_RANGE.group[1], 2);
    const kF = knob('floorUs', PF_RANGE.floorUs[0], PF_RANGE.floorUs[1], 1);
    const kC = knob('corrRatio', PF_RANGE.corrRatio[0], PF_RANGE.corrRatio[1], 1);
    // Chip reflects the data ACTUALLY shown (cal.live = real device samples in the stream), never
    // what was merely selected — so a "real" label can't sit over sample data.
    let chip;
    if (sp.source === 'none') chip = { txt: 'NO SOURCE', col: 'var(--txt3)' };
    else if (cal.live) chip = { txt: 'THIS CLOCK — pccd RAW SAMPLES · ' + (cal.n || 0) + ' HELD', col: 'var(--lock)' };
    else if (sp.source === 'real') chip = { txt: 'THIS CLOCK — LOADING pccd RAW SAMPLES', col: 'var(--acq)' };
    else if (cal.calibrated) chip = { txt: "SAMPLE DATA · SYNTHETIC, JITTER MATCHED TO THIS CLOCK'S RECORD σ≈" + Math.round(cal.us) + 'µs', col: 'var(--acq)' };
    else chip = { txt: 'SAMPLE DATA · SYNTHETIC, NOMINAL JITTER', col: 'var(--acq)' };
    const realSel = sp.source === 'real';
    // Absent state: no real feed and no simulation — say why, per cause.
    const spAbsentMsg = this.appMode() === 'connected'
      ? 'THIS CONNECTION CARRIES NO RAW-SAMPLE FEED. THE pccd BRIDGE RECORDS PRE-GATE SAMPLES; DIRECT WEB SERIAL DOES NOT.'
      : "NO SOURCE. CONNECT THROUGH THE pccd BRIDGE FOR THIS CLOCK'S RAW SAMPLES, OR START A SIMULATION TO EXPLORE THE FILTER ON SAMPLE DATA.";
    return {
      spRawRms: fmt(st.rawRms, 1), spCleanRms: fmt(st.cleanRms, 1),
      spReduction: st.reduction ? '×' + st.reduction.toFixed(1) : '—',
      spSqrtG: '√' + sp.group + ' = ' + Math.sqrt(sp.group).toFixed(2),
      spRej: st.rejected, spTot: st.total, spKept: st.kept, spGroups: st.groupsOut,
      spGate: gateUs == null ? '—' : '±' + Math.round(gateUs),
      spGateSub: 'MED-CENTRED' + (floored ? ' · FLOOR ' + sp.floorUs + 'µs' : ''),
      spChipTxt: chip.txt, spChipCol: chip.col,
      spCaption: cal.live
        ? "THIS CLOCK'S PRE-GATE OFFSET SAMPLES FROM pccd (GET /raw, IN-MEMORY, LAST ~10 MIN). THE KNOBS RE-FILTER YOUR OWN SAMPLES WITH THE SHIPPED pccd MATH (pf_push). REFRESH PULLS THE LATEST WINDOW."
        : 'SAMPLE DATA — A SYNTHETIC OFFSET STREAM, SHOWN ONLY WHILE SIMULATING. THE GATE AND TRIMMED-MEAN MATH IS THE SHIPPED pccd ALGORITHM (pccd.c pf_push), SO THE KNOB LESSONS HOLD. A CONNECTED CLOCK REPLACES THIS WITH ITS OWN SAMPLES.',
      spOn: sp.source !== 'none', spAbsent: sp.source === 'none', spAbsentMsg,
      spRefreshLabel: realSel ? 'REFRESH' : 'RESEED SAMPLE',
      onSpRefresh: () => (realSel ? this.spFetchRaw(false) : this.spReseed()),
      spConfig: this.spConfigText(),
      // knob rows: value (rec-coloured), input attrs, handlers, REC label
      spKVal: sp.K.toFixed(1), spKCol: recCol(kK.atRec), spKMin: kK.min, spKMax: kK.max, spKStep: kK.step, onSpK: kK.on, onSpKRec: kK.rec,
      spWVal: sp.window, spWCol: recCol(kW.atRec), spWMin: kW.min, spWMax: kW.max, spWStep: kW.step, onSpW: kW.on, onSpWRec: kW.rec,
      spGVal: sp.group, spGCol: recCol(kG.atRec), spGMin: kG.min, spGMax: kG.max, spGStep: kG.step, onSpG: kG.on, onSpGRec: kG.rec,
      spFVal: sp.floorUs, spFCol: recCol(kF.atRec), spFMin: kF.min, spFMax: kF.max, spFStep: kF.step, onSpF: kF.on, onSpFRec: kF.rec,
      spCVal: sp.corrRatio, spCCol: recCol(kC.atRec), spCMin: kC.min, spCMax: kC.max, spCStep: kC.step, onSpC: kC.on, onSpCRec: kC.rec,
      spFreeze: sp.freeze, spFreezeLabel: sp.freeze ? 'RESUME' : 'FREEZE',
      onSpReset: () => this.spReset(), onSpReseed: () => this.spReseed(), onSpFreeze: () => this.spToggleFreeze(),
      onSpCopy: () => { try { navigator.clipboard.writeText(this.spConfigText() + '\n'); } catch (e) {} },
    };
  }
  setArchRange(r) { this.setState({ archRange: r }); this._arch = null; this.fetchArchive(); }
  // Repaint whichever GROUND TRACK projection is live (the other canvas is unmounted; its draw
  // no-ops on the zero-size guard, so calling both would be harmless — this just names the intent).
  drawGround() { this.drawChart(this.state.groundProj === 'flat' ? 'map' : 'globe'); }
  rvArchive() {
    const hi = this.state.bridgeInfo && this.state.bridgeInfo.history;
    const range = this.state.archRange || '24h';
    const chip = (r) => 'font-family:var(--mono);font-size:var(--fs-label);letter-spacing:.04em;padding:3px 10px;cursor:pointer;background:transparent;border:1px solid ' +
      (r === range ? 'var(--txt3);color:var(--txt)' : 'var(--line);color:var(--txt3)');
    const days = hi ? hi.days : 0;
    return {
      archShown: !!hi,
      archAbsent: !hi,   // ARCHIVE tab honest empty state: no recorder behind this connection
      archCaption: hi ? ('ARCHIVE · RECORDED BY pccd · ' + days + (days === 1 ? ' DAY' : ' DAYS') + ' ON DISK' +
        (this._arch && this._arch.t && this._arch.t.length ? '' : ' · FETCHING…')) : '',
      archR6Style: chip('6h'), archR24Style: chip('24h'), archR7Style: chip('7d'), archRAllStyle: chip('all'),
      onArchR6: () => this.setArchRange('6h'), onArchR24: () => this.setArchRange('24h'),
      onArchR7: () => this.setArchRange('7d'), onArchRAll: () => this.setArchRange('all'),
    };
  }

  // Is a release tag (e.g. "pccd-v0.4.1") newer than the running pccd version (e.g. "0.4+abc123")?
  // Compares MAJOR.MINOR.PATCH, ignoring the "pccd-v" prefix and any "+githash" suffix on either side.
  // The patch field is REQUIRED: on major.minor alone, 0.4.1 read as equal to 0.4, so a patch release
  // never surfaced an UPDATE NOW button (and pccd's own ver_cmp refused it as "already current").
  // A missing field is 0, so "0.4" === "0.4.0" and 0.4.1 correctly beats it.
  verNewer(cur, tag) {
    const num = (s) => { const m = String(s).match(/(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [+m[1], +m[2], +(m[3] || 0)] : [0, 0, 0]; };
    const a = num(cur), b = num(tag);
    for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i];
    return false;
  }

  // Check GitHub for a newer pccd release and set the panel state. Called once automatically when a
  // bridge is first detected (manual=false, silent on failure) and by the panel's CHECK button
  // (manual=true, surfaces failures). Sets this._pccdNewerTag so UPDATE NOW only shows when relevant.
  checkPccdUpdate(manual) {
    const bi = this.state.bridgeInfo;
    if (!bi) return;
    if (manual) { this._pccdUpd = { s: 'CHECKING GITHUB…', c: 'var(--txt2)' }; this.setState({}); }
    fetch('https://api.github.com/repos/peterlewis/pcc/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => {
        const tag = j.tag_name || '';
        const newer = this.verNewer(bi.version || '', tag);
        this._pccdNewerTag = newer ? tag : null;
        this._pccdUpd = !tag ? { s: 'CHECK FAILED — UNEXPECTED RESPONSE', c: 'var(--acq)' }
          : !newer ? { s: 'UP TO DATE — ' + tag, c: 'var(--lock)' }
          : bi.updatable ? { s: 'UPDATE AVAILABLE — ' + tag, c: 'var(--acq)' }
          : { s: 'UPDATE AVAILABLE — ' + tag + ' · UPDATE MANUALLY (THIS pccd IS A DEV / -w BUILD)', c: 'var(--acq)' };
        this.setState({});
      })
      .catch(() => { if (manual) { this._pccdUpd = { s: 'CHECK FAILED — OFFLINE OR RATE-LIMITED', c: 'var(--acq)' }; this.setState({}); } });
  }

  // Ask the running pccd to download the latest release, verify it, and relaunch itself. Streams the
  // daemon's progress into the panel, then re-probes /health until the new version answers.
  runPccdUpdate() {
    if (!this.realdev || this._pccdUpdating) return;   // in-flight guard: no double-start, no queued 2nd download
    this._pccdUpdating = true;                          // also: freezes probeBridge + suppresses the RX watchdog
    const oldV = (this.state.bridgeInfo || {}).version || '';
    const want = this._pccdNewerTag;
    const wasLive = !!(this.session && this.session.S.real && this.session.S.connected);   // a live clock session to restore?
    this._pccdUpd = { s: 'STARTING UPDATE…', c: 'var(--txt2)' };
    this.setState({});
    this.realdev.updateBridge((line) => {
      this._pccdUpd = { s: line.toUpperCase(), c: line.startsWith('error') ? 'var(--acq)' : 'var(--txt2)' };
      this.setState({});
    }).then((res) => {
      if (res.msg === 'already up to date') { this._pccdUpdating = false; this._pccdNewerTag = null; this._pccdUpd = { s: 'ALREADY CURRENT', c: 'var(--txt2)' }; this.setState({}); return; }
      // /health after reconnect is the GROUND TRUTH. The daemon re-execs itself to swap the binary, which
      // KILLS the WebSocket — so a dropped bridge (ws error/close) is the signature of a SUCCESSFUL relaunch,
      // not a failure. An explicit daemon 'error…' instead means it stayed up on the old binary. So verify by
      // OUTCOME (did the version bump?) rather than trusting a handshake that execv cuts off. This fixes the
      // false "UPDATE FAILED — BRIDGE NOT REACHABLE" reported when the update had actually succeeded.
      const failMsg = res.ok ? null : String(res.msg || '');
      this._pccdUpd = { s: res.ok ? 'UPDATED — RECONNECTING…' : 'VERIFYING…', c: 'var(--txt2)' };
      this.setState({});
      let tries = 0, lastJ = null;
      const rc = setInterval(() => {
        tries += 1;
        this.realdev.detectBridge().then((j) => {
          if (j) lastJ = j;
          if (j && this.verNewer(oldV, j.version || '')) {
            // SUCCESS — a NEWER version answering is the ONLY trustworthy signal. `pccd --update` downloads
            // the tarball on its single thread, which stalls this WebSocket, so an old-version or unreachable
            // /health mid-flight is NOT failure (the daemon may still be downloading or relaunching). Never
            // conclude from a transient reply — only from a version bump here, or the timeout below.
            clearInterval(rc); this._pccdUpdating = false; this._pccdNewerTag = null;
            this.setState({ bridgeInfo: j });
            this._pccdUpd = { s: 'UPDATED TO v' + (j.version || '?'), c: 'var(--lock)' };
            // The bridge transport needs no user gesture, so make "reconnects automatically" true for a
            // clock session too: re-establish it if the user was watching a live clock before the update.
            if (wasLive && this.session && !this.session.S.connected) this.connectRealDevice();
            this.setState({});
          } else if (tries > 40) {
            // ~28 s with no newer version — long enough to cover a blocking download + relaunch. Report by
            // what we ACTUALLY last saw, not by the (expected) mid-flight ws drop.
            clearInterval(rc); this._pccdUpdating = false;
            if (lastJ) this.setState({ bridgeInfo: lastJ });
            if (failMsg && failMsg.startsWith('error')) {
              this._pccdNewerTag = want;
              this._pccdUpd = { s: 'UPDATE FAILED — ' + failMsg.toUpperCase(), c: 'var(--acq)' };
            } else if (lastJ && !this.verNewer(oldV, lastJ.version || '')) {
              this._pccdNewerTag = want;   // daemon stayed on the old binary → let them retry
              this._pccdUpd = { s: 'STILL v' + (lastJ.version || '?') + ' — TRY AGAIN', c: 'var(--acq)' };
            } else {
              this._pccdUpd = { s: 'UPDATED — REFRESH TO RECONNECT', c: 'var(--acq)' };
            }
            this.setState({});
          }
          // else: old-version or unreachable /health before the timeout → keep polling; the relaunch may lag.
        }).catch(() => {});
      }, 700);
    });
  }

  // Stale-tab check: the page bakes its build stamp (window.__PCC_BUILT, injected by build.mjs) and
  // the SERVED build-info.json carries the current one. When they differ, the files under this tab
  // have moved (pccd REFRESH APP, or a Pages deploy) and the running JS is old — surface the header
  // RELOAD chip. Dev serving of raw web/ has no baked stamp, so the check stays off there. One-way
  // latch: once stale, always stale until the reload actually happens.
  checkAppStale() {
    if (!window.__PCC_BUILT || this.state.appStale) return;
    fetch('build-info.json?ts=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((bi) => {
        if (bi && bi.builtAt && bi.builtAt !== window.__PCC_BUILT) this.setState({ appStale: true });
      }).catch(() => {});   // offline / file:// — nothing to compare, stay quiet
  }

  // Identify the served web app by its manifest hash (exactly what pccd's refresh compares) and say whether
  // it matches the latest on Pages. GitHub Pages is CORS-open, so the compare runs client-side. Sets
  // this._appId (the running app's short id) and this._pccdWeb (the green UP TO DATE / amber NEW BUILD line).
  checkAppFromPages() {
    if (!(window.crypto && crypto.subtle)) return;   // needs a secure context (localhost / https — both are)
    const digest12 = async (text) => {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(b)].slice(0, 6).map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    Promise.all([
      fetch('app-manifest.sha256', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null),
      fetch('https://peterlewis.github.io/pcc/app-manifest.sha256', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null),
    ]).then(async ([mineTxt, pagesTxt]) => {
      if (!mineTxt) return;                          // served app carries no manifest (pre-0.6 build) → show nothing
      this._appId = await digest12(mineTxt);
      if (pagesTxt) {
        const latest = await digest12(pagesTxt);
        this._pccdWeb = (this._appId === latest)
          ? { s: 'UP TO DATE — #' + this._appId, c: 'var(--lock)' }
          : { s: 'NEW BUILD ON PAGES — REFRESH', c: 'var(--acq)' };
      }
      this.setState({});
    }).catch(() => {});
  }

  // Ask pccd to pull the latest web app from Pages (verified) and swap its served overlay — no relaunch,
  // so the bridge stays up. On success the served files changed; reload to load them. Web-only fixes reach
  // the locally-installed daemon this way BETWEEN releases (daemon features still need a real release).
  refreshPccdApp() {
    if (!this.realdev || this._pccdWebBusy) return;
    this._pccdWebBusy = true;
    this._pccdWeb = { s: 'STARTING…', c: 'var(--txt2)' }; this.setState({});
    this.realdev.refreshBridgeApp((line) => {
      this._pccdWeb = { s: line.toUpperCase(), c: line.startsWith('error') ? 'var(--acq)' : 'var(--txt2)' };
      this.setState({});
    }).then((res) => {
      this._pccdWebBusy = false;
      if (res.ok && res.msg === 'done') {
        this._pccdWeb = { s: 'APP UPDATED — RELOADING…', c: 'var(--lock)' }; this.setState({});
        setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 1200);
      } else if (res.ok) {
        this._pccdWeb = { s: 'ALREADY CURRENT', c: 'var(--lock)' }; this.setState({});
      } else {
        this._pccdWeb = { s: 'REFRESH FAILED — ' + String(res.msg || '').toUpperCase(), c: 'var(--acq)' }; this.setState({});
      }
    });
  }

  // DEVICE→UPDATES "FIRMWARE & DATA": what firmware the in-app emulator IS (version + exact
  // clock4 commit the WASM was compiled from — build.mjs writes build-info.json), the tz data
  // shipped alongside, and a user-triggered GitHub check of the rollup branch head.
  rvFirmware() {
    const bi = this.buildInfo;
    const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
    const zone = (() => { try { const z = this.emu && this.emu.tz(); return z && z.zone ? z.zone : null; } catch (e) { return null; } })();
    const upd = this._fwUpd || { s: '', c: 'var(--txt3)' };
    // pccd bridge self-update block (only meaningful when a bridge is present)
    const bri = this.state.bridgeInfo;
    const pu = this._pccdUpd || { s: '', c: 'var(--txt3)' };
    // The manual command runs ON the daemon's own host — but this branch only shows when the daemon
    // reports NO platform (a dev build), so hard-guessing macOS would hand a Linux dev the wrong tarball.
    // Let the user's shell derive the asset with uname (exact, and the same trick the Connection room uses).
    const asset = (bri && bri.platform) || '$(uname -s | grep -qi darwin && echo macos-universal || echo linux-$(uname -m))';
    return {
      pccdShown: !!bri,
      pccdVer: bri ? ('v' + (bri.version || '?') + (bri.platform ? ' · ' + bri.platform.toUpperCase() : '') + (bri.updatable ? '' : ' · SELF-UPDATE OFF (DEV / -w)')) : '—',
      pccdUpdState: pu.s, pccdUpdC: pu.c,
      pccdCanUpdate: !!(bri && bri.updatable && this._pccdNewerTag && !this._pccdUpdating),   // hide UPDATE NOW while one is in flight
      pccdShowManual: !!(bri && !bri.updatable && this._pccdNewerTag),
      pccdCmd: 'curl -L https://github.com/peterlewis/pcc/releases/latest/download/pccd-' + asset + '.tar.gz | tar xz && cd pcc && ./pccd',
      onPccdCheck: () => this.checkPccdUpdate(true),
      onPccdUpdate: () => this.runPccdUpdate(),
      // Pages web-overlay: pull web-only app fixes between releases (no relaunch). Shown only when the daemon
      // actually understands pccd:web-refresh (/health webrefresh) — a pre-0.6 daemon hides it, not errors.
      pccdCanWeb: !!(bri && bri.webrefresh && !this._pccdWebBusy),
      pccdWebState: (this._pccdWeb || {}).s || '', pccdWebC: (this._pccdWeb || {}).c || 'var(--txt3)',
      pccdAppLine: this._appId ? ((bi && bi.builtAt ? bi.builtAt + ' · ' : '') + '#' + this._appId) : '—',
      onPccdWebRefresh: () => this.refreshPccdApp(),
      fwVer: bi ? bi.version + ' — WASM, BUILT FROM SOURCE' + (bi.dateVersion ? ' · DATE BOARD ' + bi.dateVersion.replace(/^Version\s*/i, '').trim() : '') : 'BUILT FROM SOURCE (run build.mjs for provenance)',
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
  // First index i where arr[i].t >= target (arr sorted ascending by .t). Standard lower-bound.
  _lbT(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < target) lo = m + 1; else hi = m; }
    return lo;
  }
  reconstructReview(t, W = 1800) {
    const R = this._review, S = this.session && this.session.S;
    if (!R || !S) return;
    // R.samples is time-sorted (prepReview); binary-search the [t-W, t] window instead of scanning
    // the whole (up to 200k-row) array every scrub frame / playback tick.
    const lo = this._lbT(R.samples, t - W), hi = this._lbT(R.samples, t + 1);
    const win = R.samples.slice(lo, hi);
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
    // Sub-satellite point reconstruction (exactly what the live real-device path does): the log
    // stores observer-relative az/el + constellation identity, so GLOBE and MAP can plot the past
    // as faithfully as the polar plot instead of going empty (they skip any sat whose geo is NaN).
    // The log doesn't carry the raw CONSTELLATIONS object, only its id, so map id → nominal orbit
    // altitude (the only field subSatellitePoint reads).
    const ALT = { G: 20200, R: 19100, E: 23222, C: 21528 };
    const subPt = (az, el, constId) => {
      if (!(el > 0) || az == null) return { lat: NaN, lon: NaN };
      const sp = subSatellitePoint({ azDeg: az, elDeg: el, constellation: { altitudeKm: ALT[constId] || 20200 }, observerLat: refLat, observerLon: refLon });
      return sp ? { lat: sp.lat, lon: sp.lon } : { lat: NaN, lon: NaN };
    };
    const cur = win.length ? win[win.length - 1] : null;
    S.sats = (cur ? cur.sats : []).map((s) => ({
      key: s.key || ('G' + String(s.prn).padStart(2, '0')), prn: s.prn, constId: s.constId || 'G', tok: s.tok || 'gps',
      talker: s.talker || 'GP', sysId: s.sysId || 1, az: s.az, el: s.el, cn0: s.cn0, used: s.used,
      visible: s.el != null && s.el > 0, geo: subPt(s.az, s.el, s.constId || 'G'),
    }));
    // Rebuild windowed ground tracks from the same az/el trails, downsampled to the live ~45 s
    // gtrail cadence so GLOBE/MAP show the scrubbed history's tracks (and the TRAIL-length gcut,
    // which assumes 45 s/point, slices them correctly).
    const gtrails = new Map();
    for (const [key, tr] of trails) {
      const constId = key[0];
      const g = []; let lastT = -Infinity;
      for (const p of tr) {
        if (p.t - lastT < 45 || !(p.el > 0)) continue;
        const geo = subPt(p.az, p.el, constId);
        if (Number.isFinite(geo.lat)) { g.push({ lat: geo.lat, lon: geo.lon, t: p.t }); lastT = p.t; }
      }
      if (g.length) gtrails.set(key, g);
    }
    S.gtrails = gtrails;
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
      // reconstructReview now rebuilds S.gtrails too, so it must be snapshotted or the live ground
      // tracks would be replaced by the scrubbed window on exit.
      gtrails: S.gtrails instanceof Map ? new Map(S.gtrails) : S.gtrails,
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
