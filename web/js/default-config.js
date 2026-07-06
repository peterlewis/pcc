// default-config.js — config.txt is the SINGLE SOURCE OF TRUTH for PCC Web.
//
// DEFAULT_CONFIG is the canonical, annotated "golden" config.txt: every option the clock4 firmware
// understands, curated in the device's own house style. It does two jobs:
//   1. Seeds the app's boot defaults (configToState) — so the UI and the clock start from ONE place.
//   2. Is what Export writes out (stateToConfig) — a file you can drop straight on the CLOCK drive.
// The same CONFIG_FIELDS table drives both directions, so the UI and the clock can never diverge.
//
// Keys use the CURRENT firmware spellings (e.g. MODE_SOLAR, not the older MODE_SUNDIAL). Parsing is
// case-insensitive; firmware `enabled/on/1/yes` are truthy. See the conformance notes in main.c.

export const DEFAULT_CONFIG = `# =============================================================================
# Precision Clock Mk IV — config.txt
# The single source of truth. This drives the clock, and PCC Web seeds its
# defaults from it. Every firmware option is listed with its default; edit and
# drop on the CLOCK USB drive, or round-trip it through PCC Web (Export).
# =============================================================================

# Matrix refresh rate, in Hz (min 1000, max 100000). A target only — the exact
# frequency is a division of the processor clock.
MATRIX_FREQUENCY = 20000

# Timezone. Leave commented to auto-detect from the GPS fix. IANA name, e.g.
# Europe/London; Etc/GMT+5 for a fixed offset; Etc/UTC for UTC.
#ZONE_OVERRIDE = Europe/London


## display modes — enable every row you want; the buttons cycle the enabled set

# Date row — ISO 8601 standard (YYYY-MM-DD)
MODE_ISO8601_STD = enabled
# ISO 8601 ordinal (day-of-year) / ISO week
MODE_ISO_ORDINAL = disabled
MODE_ISO_WEEK    = disabled
# Unix timestamp (always UTC) / Julian Date / Modified Julian Date
MODE_UNIX        = disabled
MODE_JULIAN_DATE = disabled
MODE_MODIFIED_JD = disabled

# Weekday name, and weekday-with-date variants
MODE_WEEKDAY   = disabled
MODE_WDY_MM_DD = disabled
MODE_WEEKDA_DD = disabled

# Time row — UTC offset (e.g. +01:00) / timezone name
MODE_SHOW_OFFSET  = disabled
MODE_SHOW_TZ_NAME = disabled

# Alternate timebases on the time row (the date row keeps the civil date):
# Local Sidereal Time (live), and apparent-solar / sundial time.
MODE_LST   = disabled
MODE_SOLAR = disabled

# Generic text (see 'text' below) and countdown (see 'countdown_to' below)
MODE_TEXT      = disabled
MODE_COUNTDOWN = disabled

# Turn off all LEDs (GPS stays fully powered)
MODE_STANDBY = disabled


## astro modes (GPS-derived; shown on the date row while the clock keeps ticking)
MODE_SUN      = disabled
MODE_SUN_AZEL = disabled
MODE_MOON     = disabled
MODE_GRID     = disabled
MODE_LATLON   = disabled

# Dwell per sub-screen for the paged read-outs (astro + temp comp), in ms (default 5500,
# min 250). Older firmware called this astro_page_ms.
page_ms = 5500

# Fixed position for astro when there's no GPS fix (decimal degrees, N+/E+)
#fake_latitude  = 51.48
#fake_longitude = -0.01


## colon animation
# One of: slowfade, heartbeat, sawtooth, alt_sawtooth, toggle, solid
colon_mode = heartbeat
# Colon for the alternate timebases (LST/SOLAR) — kept automatically distinct
# from the civil colon; leave commented for that guarantee.
#alt_colon_mode = alt_sawtooth


## text & countdown
#text = hello
#countdown_to = 2027-01-01T00:00:00Z


## holdover tolerance times, in seconds
# As the GPS fix ages, the clock hides its least-significant digits to reflect
# the widening accuracy. These set when each digit drops.
Tolerance_time_1ms   = 1000
Tolerance_time_10ms  = 10000
Tolerance_time_100ms = 100000
# Replace the fixed ladder above with measured uncertainty: each digit is dashed when the
# live 3-sigma holdover error passes its place value (needs the significance-fade firmware).
significance_fade = off


## brightness
# Nonlinear ambient-light curve: five (input,output) stops, 0..4095.
# Default = VTT9812FH sensor with R11 = 470K.
BS1 = 0,0
BS2 = 131,365
BS3 = 1076,1422
BS4 = 2774,2665
BS5 = 3849,4095
# Fixed brightness override (0.0-1.0 or 0-4095); leave commented for auto.
#brightness = 0.5


## temperature compensation (opt-in; all off = stock behaviour)
# GPS-locked, the clock can LEARN how each oscillator drifts with die temp
# (tc_learn), then during a GPS outage steer the timebase (tc_apply) and/or
# trim the battery RTC (tc_rtc). Paste tc_dump output below to freeze a model.
tc_learn = off
tc_apply = off
tc_rtc   = off
# Diagnostic date-row read-out: die temp / HSE model / LSE model / samples (pages, page_ms each)
MODE_TEMPCOMP = disabled
#tc_t0 = 40
#tc_engage_s = 2
#tc_max_ppm = 100


## serial output
# NMEA passthrough over USB: off / rmc / on
nmea = off
# Emit a $PMTXTS PPS-edge timing sentence for host-side jitter/drift analysis
pps = off
`;

// --- config.txt grammar (mirrors the firmware): `key = value`, `#`/`;` comments, case-insensitive
// keys. Returns a lowercase-keyed map of raw string values (commented lines omitted). ----------------
export function parseConfigText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

const truthy = (v) => /^(enabled|on|1|true|yes)$/i.test(String(v || '').trim());

// The ONE bidirectional table. Each firmware MODE_* key maps to the app's mode `key` and its group,
// so config<->state stays symmetric. (Non-mode keys — colon, astro dwell, tz, text, countdown — are
// handled explicitly below since they don't fit the enable/disable shape.)
export const MODE_FIELDS = [
  { cfg: 'mode_iso8601_std', key: 'iso8601', group: 'date' },
  { cfg: 'mode_iso_ordinal', key: 'ordinal', group: 'date' },
  { cfg: 'mode_iso_week', key: 'isoweek', group: 'date' },
  { cfg: 'mode_unix', key: 'unix', group: 'date' },
  { cfg: 'mode_julian_date', key: 'julian', group: 'date' },
  { cfg: 'mode_modified_jd', key: 'mjd', group: 'date' },
  { cfg: 'mode_weekday', key: 'weekday', group: 'weekday' },
  { cfg: 'mode_wdy_mm_dd', key: 'wdy_mm_dd', group: 'weekday' },
  { cfg: 'mode_weekda_dd', key: 'weekda_dd', group: 'weekday' },
  { cfg: 'mode_show_offset', key: 'offset', group: 'timerow' },
  { cfg: 'mode_show_tz_name', key: 'tz', group: 'timerow' },
  { cfg: 'mode_lst', key: 'sidereal', group: 'timerow' },
  { cfg: 'mode_solar', key: 'solar', group: 'timerow', alias: ['mode_sundial'] },
  { cfg: 'mode_sun', key: 'sun', group: 'astro' },
  { cfg: 'mode_sun_azel', key: 'sun_azel', group: 'astro' },
  { cfg: 'mode_moon', key: 'moon', group: 'astro' },
  { cfg: 'mode_grid', key: 'grid', group: 'astro' },
  { cfg: 'mode_latlon', key: 'latlon', group: 'astro' },
  { cfg: 'mode_tempcomp', key: 'tempcomp', group: 'diag' },
];

// Derive the config-DRIVEN slice of app state from a config.txt (defaults to the golden config).
// UI-only fields (theme, panels, sim, gamma, marquee…) are NOT set here — they stay app-owned.
export function configToState(text = DEFAULT_CONFIG) {
  const c = parseConfigText(text);
  const on = (f) => truthy(c[f.cfg]) || (f.alias || []).some((a) => truthy(c[a]));

  const modesEnabled = {};
  for (const f of MODE_FIELDS) if (on(f)) modesEnabled[f.key] = true;

  // Derive the singular "which is showing" fields the UI tracks, first-enabled-wins per group.
  const first = (group) => { const f = MODE_FIELDS.find((x) => x.group === group && on(x)); return f && f.key; };
  const st = {
    modesEnabled,
    dateFormat: first('date') || 'iso8601',
    weekdayFmt: first('weekday') || 'off',
    timeRow: truthy(c.mode_show_offset) ? 'offset' : truthy(c.mode_show_tz_name) ? 'tz' : 'std',
    astroFmt: first('astro') || 'off',
    colon: (c.colon_mode || 'heartbeat').toLowerCase(),
  };
  const dwell = c.page_ms != null ? c.page_ms : c.astro_page_ms;   // current key, old-firmware fallback
  if (dwell != null) { const n = parseInt(dwell, 10); if (Number.isFinite(n) && n > 0) st.astroDwell = n; }
  else st.astroDwell = 5500;
  // Holdover dash-ladder thresholds (seconds) — seed the DEVICE panel's editable values.
  const tolN = (k, d) => { const n = parseInt(c[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
  st.tol1 = tolN('tolerance_time_1ms', 1000); st.tol10 = tolN('tolerance_time_10ms', 10000); st.tol100 = tolN('tolerance_time_100ms', 100000);
  // timezone: blank/commented => auto (local); Etc/UTC => the UTC toggle; else a specific IANA zone.
  const zone = (c.zone_override || '').trim();
  st.utc = /^etc\/utc$/i.test(zone);
  st.tzOverride = zone || 'auto';
  // custom text + countdown target (both commented-out in the golden default = the app defaults)
  st.text = c.text != null ? c.text : 'HELLO';
  st.countdownTo = 0;
  if (c.countdown_to != null) { const t = Date.parse(c.countdown_to); if (Number.isFinite(t)) st.countdownTo = t; }
  // ambient-light DAC curve: BS1..BS5 = "input,output" (0..4095) -> [{adc,dac} x5]
  const bs = [];
  for (let i = 1; i <= 5; i++) {
    const v = c['bs' + i]; if (v == null) continue;
    const p = String(v).split(','); const a = parseInt(p[0], 10), d = parseInt(p[1], 10);
    if (Number.isFinite(a) && Number.isFinite(d)) bs.push({ adc: a, dac: d });
  }
  if (bs.length === 5) st.dacCurve = bs;
  return st;
}

// Serialize the live app state back into config.txt — the golden template with the current values
// substituted, so comments/sections/ordering are preserved and it drops straight onto the clock.
export function stateToConfig(state, text = DEFAULT_CONFIG) {
  const me = state.modesEnabled || {};
  const onFor = (cfgKey) => { const f = MODE_FIELDS.find((x) => x.cfg === cfgKey); return f ? !!me[f.key] : null; };
  const setVal = (line, key, value) => line.replace(new RegExp('^(#?\\s*' + key + '\\s*=\\s*).*$', 'i'), (m, p1) => p1.replace(/^#\s*/, '') + value);

  return String(text).split('\n').map((line) => {
    const m = line.match(/^#?\s*([A-Za-z0-9_]+)\s*=/);
    if (!m) return line;
    const key = m[1], kl = key.toLowerCase();
    // MODE_* → enabled/disabled from the enabled set
    const modeOn = onFor(kl);
    if (modeOn !== null) return setVal(line, key, modeOn ? 'enabled' : 'disabled');
    if (kl === 'colon_mode') return setVal(line, key, state.colon || 'heartbeat');
    if (kl === 'page_ms' || kl === 'astro_page_ms') return setVal(line, key, state.astroDwell || 5500);
    if (kl === 'text') return state.text ? setVal(line, key, state.text) : line;
    if (kl === 'countdown_to' && state.countdownTo > 0)
      return setVal(line, key, new Date(state.countdownTo).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    if (/^bs[1-5]$/.test(kl) && Array.isArray(state.dacCurve)) {
      const p = state.dacCurve[parseInt(kl.slice(2), 10) - 1];
      if (p) return setVal(line, key, p.adc + ',' + p.dac);
    }
    if (kl === 'zone_override') {
      const z = state.utc ? 'Etc/UTC' : (state.tzOverride && state.tzOverride !== 'auto' ? state.tzOverride : null);
      return z ? setVal(line, key, z) : line;   // leave commented for GPS-auto
    }
    return line;
  }).join('\n');
}
