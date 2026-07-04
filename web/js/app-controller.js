// app-controller.js — the PCC Web application body, ported VERBATIM from the
// Claude-Design prototype (PCC Web.dc.html), reparented onto the vanilla DcLite
// runtime. All state, the fold sequence, the 14 renderVals builders, and the 1 Hz
// tick are unchanged; only 'extends DCLogic' -> 'extends DcLite' and the boot differ.
import { DcLite } from './dc-lite.js?v=86';
import * as ASTRO from './astro-fw.js?v=86';
import * as DS from './datasources.js?v=86';

class Component extends DcLite {
  state = {
    phase: 'boot', entryVisible: true, docked: false, drawerOpen: false, hdrClockOpen: true,
    section: 'display', theme: 'dark', scenario: 'locked',
    mode: 'time', dateFormat: 'iso8601', weekdayFmt: 'off', timeRow: 'std',
    precision: 3, brightness: 0.85, brightLock: false, gamma: 1.0,
    colon: 'heartbeat', utc: false, standby: false, diag: 'off',
    text: 'HELLO', marqueeSpeed: 'std', countdownTo: 0,
    astroFmt: 'off', astroDwell: 5500,
    // 5-point ambient-light DAC curve (ADC→DAC, 0..4095). Default = Rev D (VTT9812FH), the
    // firmware/macOS default. Edited by dragging in the Brightness tab; committed via BS1..BS5.
    dacCurve: [{ adc: 0, dac: 0 }, { adc: 131, dac: 365 }, { adc: 1076, dac: 1422 }, { adc: 2774, dac: 2665 }, { adc: 3849, dac: 4095 }],
    // config.txt editor. Write-gate defaults OFF (matches macOS AppSettings.configWriteEnabled),
    // persisted to localStorage. The textarea is uncontrolled (ref) so editing never fights re-renders.
    cfgName: '', cfgDirty: false, cfgWrite: (typeof localStorage !== 'undefined' && localStorage.getItem('pccweb.cfgWrite') === '1'),
    // REST data sources (persisted to localStorage). dsMode = the add-form's extract mode.
    dataSources: (() => { try { return JSON.parse(localStorage.getItem('pccweb.dataSources') || '[]'); } catch (e) { return []; } })(),
    dsMode: 'json',
    tzOverride: 'auto', matrixFreq: '1.6',
    skyHeatmap: false, skyHorizon: false, skyTrails: true, skyLabels: true,
    window: 900,
    sigMedian: true, sigFilter: 'all',
    posWindow: 1800,
    globeTerm: true, globeTrails: true, globeLabels: false, globeGrat: true, globeRotate: true, globeClock: true,
    wxOffline: false, wxInterval: 'off',
    monPaused: false, monAutoscroll: true,
    hdrBar: false, rebootArm: false,
    tick: 0,
  };

  componentDidMount() {
    this.els = this.els || {};
    this.faces = {};
    this.MM = { W: 265.365, H: 34.56, PIN: 6 }; // real acrylic board (mm): 7.68:1, pins ±6mm about the seam
    this.globeRot = { lon: 0.1218, lat: 52.2053 };
    const savedTheme = localStorage.getItem('pccweb.theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = savedTheme;
    const savedSec = localStorage.getItem('pccweb.section');
    this.setState({
      theme: savedTheme,
      section: savedSec && this.SECTIONS.includes(savedSec) ? savedSec : 'display',
      hdrBar: localStorage.getItem('pccweb.hdrbar') === '1',
    });
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    Promise.all([import('./clockface.js?v=86'), import('./clockface-svg.js?v=86'), import('./sim.js?v=86'), import('./charts.js?v=86'), import('./realdev.js?v=86')]).then(([CF, CFSVG, SIM, CH, RD]) => {
      this.CF = CF; this.CFSVG = CFSVG; this.SIM = SIM; this.CH = CH; this.RD = RD;
      this.session = SIM.createSession({ preroll: 1560 });
      this.realdev = RD.createRealDevice(this.session); // real Mk IV over Web Serial -> same session.S
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

  componentDidUpdate(prevProps, prevState) {
    if (!prevProps || !this.ready) return;
    // Display remount: refs attach children-before-parents, so the canvas ref callbacks
    // run before dispWrap is back. Re-run the sizer here, after the whole subtree is attached.
    if (prevState && prevState.section !== 'display' && this.state.section === 'display') {
      cancelAnimationFrame(this._dispRAF);
      this._dispRAF = requestAnimationFrame(() => this.sizeDispBar());
    }
    if (prevProps.glowIntensity !== this.props.glowIntensity || prevProps.ghostIntensity !== this.props.ghostIntensity) {
      this.allFaces((f) => f.setTokens(this.faceTokens()));
    }
  }

  get SECTIONS() { return ['connect', 'devmodes', 'devbright', 'devconfig', 'devadvanced', 'devupdates', 'display', 'satellites', 'signal', 'position', 'timing', 'globe', 'map', 'weather', 'monitor', 'export']; }

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
        f = this.CFSVG.createClockFaceSVG(holder, Object.assign({}, faceDefs[name], { tokens: this.faceTokens() }));
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
        line: g('--line'), line2: g('--line2'), txt: g('--txt'), txt2: g('--txt2'), txt3: g('--txt3'),
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
    this.allFaces((f) => f.setModeCtx({ text: this.marqueeWindow() }));
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
    if (s.mode === 'countdown') return { m: 'countdown', ctx: { countdownTo: s.countdownTo || Date.now() + 3600e3 } };
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
  set2(patch) {
    // Picking a date format / weekday is mutually exclusive with an astro date-row mode —
    // clear astro so the chosen format actually shows (astro wins in effectiveMode otherwise).
    if (('dateFormat' in patch || 'weekdayFmt' in patch) && !('astroFmt' in patch)) patch = { ...patch, astroFmt: 'off' };
    this.setState(patch, () => this.syncFaces()); this.devApply(patch);
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
    if (patch.astroDwell != null) c.push('astro_page_ms = ' + patch.astroDwell);
    if (patch.colon) c.push('colon_mode = ' + patch.colon);
    // Empty text is never sent: blanking happens by switching to date mode (above), and an
    // empty `text =` in TEXT mode is exactly what draws the stray dash on the device.
    if ('text' in patch && patch.text != null && patch.text !== '') c.push('text = ' + patch.text);
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
    // DAC brightness curve, if the config.txt carried BS1..BS5.
    if (cfg.bs) { const c = []; for (let i = 1; i <= 5; i++) { const p = cfg.bs['bs' + i]; if (p) c.push({ adc: p.adc, dac: p.dac }); } if (c.length === 5) patch.dacCurve = c; }
    this.setState(patch, () => this.syncFaces());
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
    const avail = Math.max(320, wrap.clientWidth - 4);
    const k = Math.max(1, avail / (2 * M.W)); // no cap — the panel column width is the natural bound
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
      const pd = Math.max(3, 3.2 * k);
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
      const pd = Math.max(2, 3.2 * k), bw = 1;
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
          const M = this.MM, k = Math.max(1, (this.els.dispWrap.clientWidth - 4) / (2 * M.W)); // uncapped — MUST match sizeDispBar or this drift check thrashes
          if (Math.abs((parseFloat(this.els.dispDateHalf.style.width) || 0) - M.W * k) > 1) this.sizeDispBar();
        }
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
    // When a real device is streaming, its NMEA drives session.S — don't let the
    // simulator overwrite it. The sim only advances when not mirroring hardware.
    if (!this.session.S.real) this.session.tick(Date.now());
    this.mirrorDeviceClock();
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
      if (st.skyTrails) for (const [k, tr] of S.trails) {
        const f = st.window >= 5400 ? tr : tr.filter((p) => nowS - p.t <= st.window);
        if (f.length > 1) trails.set(k, f);
      }
      return CH.drawSky(el, T, {
        sats: S.sats, trails, now: nowS,
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon),
        moon: this.SIM.moonPos(Date.now(), S.obs.lat, S.obs.lon),
      }, { heatmap: st.skyHeatmap, horizon: st.skyHorizon, trails: st.skyTrails, labels: st.skyLabels });
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
    if (name === 'globe') {
      return CH.drawGlobe(el, T, {
        rot: this.globeRot, land: this.land, sats: S.sats, gtrails: S.gtrails,
        sun: this.SIM.sunPos(Date.now(), S.obs.lat, S.obs.lon), obs: S.obs,
        opts: { terminator: st.globeTerm, trails: st.globeTrails, labels: st.globeLabels, graticule: st.globeGrat },
        dark: st.theme === 'dark',
      });
    }
    if (name === 'map') {
      return CH.drawMap(el, T, {
        land: this.land, sats: S.sats, gtrails: S.gtrails,
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
    if (!S) return { rms: 0, p2p: 0, ppm: 0, hold: 0, temp: 0, seq: 0, drop: 0, locked: true, fit: null };
    // .t is in whole seconds (sim tick floors ms→s; realdev matches). Last 900 s.
    const nowS = Math.floor(Date.now() / 1000);
    const win = S.pps.list.filter((p) => nowS - p.t <= 900).map((p) => p.us);
    // Jitter is deviation about the MEAN. Absolute offset (fixed ISR latency, the
    // ~1 ms sub-second DC term) isn't recoverable over USB and isn't jitter — a real
    // Mk IV sits ~999 µs off the boundary yet holds ~10 ns RMS, so subtract the mean
    // before squaring or the metric reports the offset as jitter (verified on hardware).
    const mean = win.length ? win.reduce((a, v) => a + v, 0) / win.length : 0;
    const rms = win.length ? Math.sqrt(win.reduce((a, v) => a + (v - mean) * (v - mean), 0) / win.length) : 0;
    let mn = Infinity, mx = -Infinity;
    for (const v of win) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return {
      rms, p2p: win.length ? mx - mn : 0, ppm: S.pps.ppm,
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
  }
  // The redesign collapses the ten sections into four rooms; each room routes to one or more
  // existing sections, surfaced as a sub-tab bar. Content is unchanged — this is IA only.
  get ROOMS() {
    return {
      display: ['display'],
      sky: ['satellites', 'signal', 'position', 'globe', 'map', 'export'], // weather moved to the Display room
      timing: ['timing'],
      device: ['connect', 'devmodes', 'devbright', 'devconfig', 'devadvanced', 'devupdates'], // Monitor is a slide-up drawer, not a room/tab
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
    if (!S.connected) return { led: 'var(--line2)', glow: 'transparent', state: 'DISCONNECTED', sub: 'EMULATOR — HOST TIME' };
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
    if (S.scenario === 'locked') return { led: 'var(--lock)', glow: 'rgba(54,201,139,.55)', state: 'LOCKED', sub: '3D FIX · STREAM OK' };
    if (S.scenario === 'acquiring') return { led: 'var(--acq)', glow: 'rgba(245,181,61,.5)', state: 'ACQUIRING', sub: 'SEARCHING SKY' };
    return { led: 'var(--none)', glow: 'rgba(255,106,61,.55)', state: 'NO FIX', sub: 'SIGNAL LOST — COLONS HELD' };
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
      this.rvWeather(), this.rvMonitor(), this.rvExport());
  }

  rvShell() {
    const st = this.state, ci = this.connInfo();
    const S = this.session && this.session.S;
    const out = {
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
      hdrTitle: (st.docked && st.section !== 'display' && st.hdrClockOpen) ? 'PC' : 'PRECISION CLOCK',
      onCloseHdrClock: () => this.setState({ hdrClockOpen: false }),
      onOpenHdrClock: () => this.setState({ hdrClockOpen: true }),
      onEntryClick: () => this.beginFold(),
      onEntryOver: () => { const h = this.els.hint; if (h && h.lastChild) { h.lastChild.style.color = 'var(--txt2)'; h.firstChild.style.background = 'var(--txt3)'; } },
      onEntryOut: () => { const h = this.els.hint; if (h && h.lastChild) { h.lastChild.style.color = 'var(--txt3)'; h.firstChild.style.background = 'var(--line2)'; } },
      onReplay: () => this.replayEntry(),
      connLed: ci.led, connGlow: ci.glow || 'transparent', connState: ci.state, connSub: ci.sub,
      // Header status doubles as a connect affordance: click when disconnected to open the
      // Web-Serial picker (the click is the required user gesture); when connected it jumps to
      // the Device room. Subtle amber wash hints it's actionable while disconnected.
      onHdrStatus: () => { if (S && S.connected) this.goRoom('device'); else this.connectRealDevice(); },
      hdrStatusHint: (S && S.connected) ? 'Connection details' : 'Click to connect your Precision Clock',
      hdrStatusBg: (S && S.connected) ? '' : 'background:var(--beta-fill)',
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
    };
    for (const room of ['display', 'sky', 'timing', 'device']) {
      const on = curRoom === room;
      out['goRoom_' + room] = () => this.goRoom(room);
      out['roomBg_' + room] = on ? 'var(--strip)' : 'transparent';
      out['roomC_' + room] = on ? 'var(--txt)' : 'var(--txt2)';
      out['roomE_' + room] = on ? 'var(--led)' : 'transparent';
      out['roomI_' + room] = on ? 'var(--led)' : 'var(--line2)';
      out['roomDot_' + room] = dots[room];
    }
    out.roomSky = curRoom === 'sky';
    out.roomDevice = curRoom === 'device';
    // Monitor drawer (slides up over the workspace from the top-bar toggle)
    out.onToggleDrawer = () => { this.setState({ drawerOpen: !this.state.drawerOpen }, () => this.scrollLog(true)); };
    out.drawerXform = st.drawerOpen ? 'translateY(0)' : 'translateY(calc(100% + 2px))';
    out.drawerBtnStyle = 'display:flex;align-items:center;gap:8px;padding:0 15px;background:' + (st.drawerOpen ? 'var(--strip)' : 'transparent') + ';border:0;border-left:1px solid var(--line);cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:.14em;color:' + (st.drawerOpen ? 'var(--txt)' : 'var(--txt3)');
    // Sections keep driving their content (sec_X) and act as sub-tabs (go_X + a segmented style).
    for (const sec of this.SECTIONS) {
      const on = st.section === sec;
      out['go_' + sec] = () => this.go(sec);
      out['sec_' + sec] = on;
      out['subStyle_' + sec] = 'flex:none;font-family:var(--mono);font-size:10px;letter-spacing:.12em;padding:7px 13px 8px;background:'
        + (on ? 'var(--led-fill)' : 'transparent') + ';border:0;box-shadow:' + (on ? 'inset 0 -2px 0 var(--led)' : 'none')
        + ';color:' + (on ? 'var(--txt)' : 'var(--txt3)') + ';cursor:pointer;white-space:nowrap';
    }
    for (const r of ['EntryBg', 'FoldStage', 'TimeHalf', 'DateHalf', 'LinkWrap', 'LinkPlate', 'PinTop', 'PinBot', 'EntryTime', 'EntryDate', 'Hint', 'EntryCap', 'FloorShadow', 'DockSlot', 'HdrDate', 'HdrTime', 'Main', 'Drawer', 'DispWrap', 'DispBar', 'DispDateHalf', 'DispTimeHalf', 'DispDate', 'DispTime', 'DispLink', 'DispPinA', 'DispPinB', 'GammaCurve', 'TextInput', 'CdInput', 'LatIn', 'LonIn', 'Sky', 'Cn0elev', 'Cn0time', 'PosScatter', 'Dop', 'Cont', 'Phase', 'Stair', 'Ppmtemp', 'Globe', 'Map', 'MonLog', 'Cmd']) {
      out['ref' + r] = this.ref(r[0].toLowerCase() + r.slice(1));
    }
    return out;
  }

  rvDisplay() {
    const st = this.state, em = this.effectiveMode();
    const S = this.session && this.session.S;
    const names = { iso8601: 'ISO 8601', ordinal: 'ISO ORDINAL', isoweek: 'ISO WEEK', unix: 'UNIX', julian: 'JULIAN', mjd: 'MOD JULIAN', weekday: 'WEEKDAY', wdy_mm_dd: 'WDY MM-DD', weekda_dd: 'WEEKDAY DD', text: 'TEXT', countdown: 'COUNTDOWN', offset: 'UTC OFFSET', standby: 'STANDBY', displaytest: 'DISPLAY TEST', vbat: 'BATTERY', satview: 'SAT VIEW' };
    return {
      faceStatusLine: (st.standby ? 'STANDBY' : (names[em.m] || em.m.toUpperCase())) + ' · BRT ' + Math.round(st.brightness * 100) + '% · P' + st.precision + ' · ' + (st.utc ? 'UTC' : 'LOCAL'),
      sourceTag: S && S.real ? 'MK IV — LIVE · CONTROLS COMMAND DEVICE · BUTTONS NOT REPORTED'
        : (S && S.connected ? 'MK IV EMULATION — MIRRORING SIMULATED DEVICE' : 'MK IV EMULATION — HOST TIME · NO DEVICE'),
      cbHdrBar: this.cb(st.hdrBar),
      oHdrBar: () => {
        const v = !st.hdrBar;
        localStorage.setItem('pccweb.hdrbar', v ? '1' : '0');
        this.setState({ hdrBar: v });
      },
      ssModeTime: this.seg(st.mode === 'time', true), ssModeText: this.seg(st.mode === 'text', false), ssModeCd: this.seg(st.mode === 'countdown', false),
      onModeTime: () => this.set2({ mode: 'time' }),
      onModeText: () => { this.marqOff = 0; this.set2({ mode: 'text', standby: false, diag: 'off' }); },
      onModeCd: () => this.set2({ mode: 'countdown', countdownTo: st.countdownTo || Date.now() + 600e3, standby: false, diag: 'off' }),
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
      onCd10m: () => this.setCdTarget(Date.now() + 600e3),
      onCd1h: () => this.setCdTarget(Date.now() + 3600e3),
      onCdNye: () => { const y = new Date().getFullYear(); this.setCdTarget(new Date(y + 1, 0, 1, 0, 0, 0).getTime()); }, // local midnight, next Jan 1
      cdTargetLabel: st.countdownTo ? this.msToLocalInput(st.countdownTo).replace('T', ' ') : '— NOT SET',
      rbIso: this.rb(st.dateFormat === 'iso8601' && st.weekdayFmt === 'off'), rbOrd: this.rb(st.dateFormat === 'ordinal' && st.weekdayFmt === 'off'), rbWeek: this.rb(st.dateFormat === 'isoweek' && st.weekdayFmt === 'off'), rbUnix: this.rb(st.dateFormat === 'unix' && st.weekdayFmt === 'off'), rbJul: this.rb(st.dateFormat === 'julian' && st.weekdayFmt === 'off'), rbMjd: this.rb(st.dateFormat === 'mjd' && st.weekdayFmt === 'off'),
      oFmtIso: () => this.set2({ dateFormat: 'iso8601', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      oFmtOrd: () => this.set2({ dateFormat: 'ordinal', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      oFmtWeek: () => this.set2({ dateFormat: 'isoweek', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      oFmtUnix: () => this.set2({ dateFormat: 'unix', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      oFmtJul: () => this.set2({ dateFormat: 'julian', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      oFmtMjd: () => this.set2({ dateFormat: 'mjd', weekdayFmt: 'off', timeRow: 'std', mode: 'time' }),
      // Astro date-row modes (Device › Display Modes › ASTRO). Mutually exclusive with the date
      // formats above (set2 clears astroFmt when a format is picked; each astro pick sets mode:time).
      rbAstOff: this.rb(st.astroFmt === 'off'), rbAstSun: this.rb(st.astroFmt === 'sun'), rbAstAzel: this.rb(st.astroFmt === 'sun_azel'), rbAstMoon: this.rb(st.astroFmt === 'moon'), rbAstGrid: this.rb(st.astroFmt === 'grid'), rbAstLl: this.rb(st.astroFmt === 'latlon'),
      oAstOff: () => this.set2({ astroFmt: 'off', mode: 'time' }),
      oAstSun: () => this.set2({ astroFmt: 'sun', mode: 'time', standby: false, diag: 'off' }),
      oAstAzel: () => this.set2({ astroFmt: 'sun_azel', mode: 'time', standby: false, diag: 'off' }),
      oAstMoon: () => this.set2({ astroFmt: 'moon', mode: 'time', standby: false, diag: 'off' }),
      oAstGrid: () => this.set2({ astroFmt: 'grid', mode: 'time', standby: false, diag: 'off' }),
      oAstLl: () => this.set2({ astroFmt: 'latlon', mode: 'time', standby: false, diag: 'off' }),
      astroDwellVal: String(st.astroDwell || 5500),
      onAstroDwell: () => { const v = this.els.astroDwellIn && this.els.astroDwellIn.value; const n = parseInt(v, 10); if (Number.isFinite(n)) this.set2({ astroDwell: Math.max(250, n || 5500) }); },
      rbWdOff: this.rb(st.weekdayFmt === 'off'), rbWdFull: this.rb(st.weekdayFmt === 'weekday'), rbWdMmdd: this.rb(st.weekdayFmt === 'wdy_mm_dd'), rbWdDd: this.rb(st.weekdayFmt === 'weekda_dd'),
      oWdOff: () => this.set2({ weekdayFmt: 'off', mode: 'time' }),
      oWdFull: () => this.set2({ weekdayFmt: 'weekday', timeRow: 'std', mode: 'time' }),
      oWdMmdd: () => this.set2({ weekdayFmt: 'wdy_mm_dd', timeRow: 'std', mode: 'time' }),
      oWdDd: () => this.set2({ weekdayFmt: 'weekda_dd', timeRow: 'std', mode: 'time' }),
      rbTrStd: this.rb(st.timeRow === 'std'), rbTrOff: this.rb(st.timeRow === 'offset'), rbTrTz: this.rb(st.timeRow === 'tz'),
      oTrStd: () => this.set2({ timeRow: 'std', mode: 'time' }),
      oTrOff: () => this.set2({ timeRow: 'offset', mode: 'time' }),
      oTrTz: () => this.set2({ timeRow: 'tz', mode: 'time' }),
      ssP0: this.seg(st.precision === 0, true), ssP1: this.seg(st.precision === 1, false), ssP2: this.seg(st.precision === 2, false), ssP3: this.seg(st.precision === 3, false),
      oP0: () => this.set2({ precision: 0 }), oP1: () => this.set2({ precision: 1 }), oP2: () => this.set2({ precision: 2 }), oP3: () => this.set2({ precision: 3 }),
      brightVal: Math.round(st.brightness * 100), brightPctLabel: Math.round(st.brightness * 100) + '%', brightLock: st.brightLock,
      onBright: (e) => { const b = (+e.target.value) / 100; this.setState({ brightness: b }); this.allFaces((f) => f.setBrightness(Math.pow(b, this.state.gamma))); this.drawChart('gammaCurve'); this.devBright(b); },
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
      oSrcLocal: () => this.set2({ utc: false }), oSrcUtc: () => this.set2({ utc: true }),
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
    try {
      await this.realdev.connect();
      try { localStorage.setItem('pcc.realDeviceSeen', '1'); } catch (e) { /* private mode */ }
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
      cFix: S && S.fix.valid ? '3D · HDOP ' + S.fix.hdop.toFixed(2) : (conn ? (S.scenario === 'acquiring' ? 'ACQUIRING' : 'NO FIX') : '—'),
      cSats: S && conn ? S.fix.sats + ' / ' + S.sats.filter((x) => x.visible).length : '—',
      cAge: S && S.fix.valid && S.fixAgeT ? ((Date.now() - S.fixAgeT) / 1000).toFixed(1) + ' s' : '—',
      // Real Mk IV over Web Serial (requires a genuine user gesture for requestPort).
      onConnectReal: () => this.connectRealDevice(),
      // Simulate (fake data) — for exploring without hardware; disabled once a real device has been used.
      onConnect: () => { if (this.session && !conn && !realSeen) { this.session.connect(); this.session.log('tx', 'OPEN (simulated device) @115200'); this.setState({}); } },
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
      readCfgDisabled: !(typeof window !== 'undefined' && 'showOpenFilePicker' in window),
      readCfgStyle: this.btn(false, !(typeof window !== 'undefined' && 'showOpenFilePicker' in window)),
      realDisabled: conn || !serialOk, connectDisabled: conn || realSeen, discDisabled: !conn,
      btnRealStyle: this.btn(true, conn || !serialOk), btnConnStyle: this.btn(false, conn || realSeen), btnDiscStyle: this.btn(false, !conn),
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
    const banner = S && S.real
      ? (streaming ? '$PMTXTS · LIVE · DRAFT FW (pps=on)' : '$PMTXTS · SEND "pps = on" TO STREAM')
      : (S && S.connected ? '$PMTXTS · SIMULATED STREAM' : '$PMTXTS · DRAFT-FIRMWARE FEATURE — pps=on');
    return {
      ppsBanner: banner,
      ppsBannerC: (S && S.real && streaming) ? 'var(--lock)' : 'var(--acq)',
      // Real device with no $PMTXTS yet (stock FW, or before `pps = on`): the KPIs
      // have no honest value — dash them rather than show stale sim scalars or 0s.
      // In sim mode `streaming` is true (sim fills pps.list), so tiles show as before.
      tJitter: noPps ? '—' : (T.rms || 0).toFixed(1), tP2p: noPps ? '—' : (T.p2p || 0).toFixed(0),
      tDrift: noPps ? '—' : (T.ppm || 0).toFixed(2), tHold: noPps ? '—' : (T.locked ? '0' : String(T.hold || 0)),
      tHoldSub: T.locked ? 'GPS DISCIPLINED' : 'FREE-RUNNING — LSE (TEMP COMP HOST-SIDE)',
      tTemp: noPps ? '—' : (T.temp || 0).toFixed(1), tSeq: noPps ? '—' : String(T.seq || 0), tDrop: noPps ? '—' : String(T.drop || 0),
      fitK0: fit ? fit.k0.toFixed(4) : '—', fitK1: fit ? fit.k1.toFixed(5) : '—', fitK2: fit ? fit.k2.toFixed(6) : '—',
      fitSpread: fit ? fit.spread.toFixed(1) + ' °C' : '—',
      fitRms: fit ? fit.rms.toFixed(2) + ' ppm' : '—',
      fitN: fit ? String(fit.n) : '0',
      fitStatus: fit ? (fit.ready ? (fit.lineOnly ? 'READY — LINE FIT' : 'READY — QUADRATIC') : 'COLLECTING — NEED ≥30 SAMPLES / ≥8 °C') : 'AWAITING SAMPLES',
      fitStatusC: fit && fit.ready ? 'var(--lock)' : 'var(--acq)',
      // The firmware doesn't consume temp_comp yet, so we never claim to be steering.
      compState: fit && fit.ready ? 'FIT READY — PASTE temp_comp INTO config.txt' : 'CHARACTERISING — FIRMWARE APPLY PENDING',
      compStateC: fit && fit.ready ? 'var(--lock)' : 'var(--txt2)',
      compLine: fit ? 'temp_comp = ' + fit.k0.toFixed(4) + ',' + fit.k1.toFixed(5) + ',' + fit.k2.toFixed(6) : 'temp_comp = off',
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
      onDlCsv: () => this.session && this.dl('pcc-session.csv', 'text/csv', this.session.toCSV()),
      onDlJson: () => this.session && this.dl('pcc-session.json', 'application/json', this.session.toJSON()),
      onDlGpx: () => this.session && this.dl('pcc-session.gpx', 'application/gpx+xml', this.session.toGPX()),
      onDlNmea: () => this.session && this.dl('pcc-session.nmea', 'text/plain', this.session.toNMEA()),
    };
  }
}

// ---- boot ----
const PROPS = { glowIntensity: 0.55, ghostIntensity: 1, foldTempo: 0.8, entry: 'fold' };
const app = new Component(PROPS);
window.__pcc = app;
app.mount(document.getElementById('root'));
