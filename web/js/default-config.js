// default-config.js — config.txt is the SINGLE SOURCE OF TRUTH for PCC Web.
//
// DEFAULT_CONFIG is the canonical, annotated "golden" config.txt: every option the clock4 firmware
// understands, curated in the device's own house style. It does three jobs:
//   1. Seeds the app's boot defaults (configToState) — so the UI and the clock start from ONE place.
//   2. Is what Export writes out (stateToConfig) — a file you can drop straight on the CLOCK drive.
//   3. Is the sample config.txt the firmware ships: emu/firmware/qspi/config.txt is this text, byte
//      for byte. emu/phase1/config_template_check.mjs fails if the two differ, if the firmware's
//      parser knows a key this does not list, or if a switched-off line shows a value that is not
//      the firmware's default. Change the file there and paste it here, or the other way round.
// retemplate() lays any config.txt onto it: that file's settings, this file's layout and comments.
// The same CONFIG_FIELDS table drives both directions, so the UI and the clock can never diverge.
//
// Keys use the CURRENT firmware spellings (e.g. MODE_SOLAR, not the older MODE_SUNDIAL). Parsing is
// case-insensitive; firmware `enabled/on/1/yes` are truthy. See the conformance notes in main.c.

export const DEFAULT_CONFIG = `# =============================================================================
# Precision Clock Mk IV: config.txt
#
# Edit this file on the CLOCK drive. The clock reads it at power-on and again
# when you save it. A line that starts with # is switched off: the clock then
# uses its built-in value for that key. Delete a line, or put # in front of it,
# and that setting goes back to its built-in value.
#
# Every key the firmware knows is in this file. Precision Clock Companion (PCC)
# uses the same file as its template.
# =============================================================================


## display

# Matrix refresh rate in Hz, 1000 to 100000. The clock uses the nearest rate it
# can divide from its processor clock.
MATRIX_FREQUENCY = 20000


## timezone

# Leave ZONE_OVERRIDE switched off to find the zone from the GPS position. To
# fix it, give an IANA name: Europe/London, Etc/UTC, or Etc/GMT+5 for a fixed
# offset. The value below is an example.
#ZONE_OVERRIDE = Europe/London

# The second timezone, shown by MODE_ZONE2. Same format. An example.
#zone2 = America/New_York


## display modes
# Enable each mode you want. The two buttons step through the enabled modes.

# Date row: ISO 8601 date (YYYY-MM-DD), day of the year, week number
MODE_ISO8601_STD = enabled
MODE_ISO_ORDINAL = disabled
MODE_ISO_WEEK    = disabled
# Unix time (always UTC), Julian Date, Modified Julian Date
MODE_UNIX        = disabled
MODE_JULIAN_DATE = disabled
MODE_MODIFIED_JD = disabled

# Weekday name, alone and with the date
MODE_WEEKDAY   = disabled
MODE_WDY_MM_DD = disabled
MODE_WEEKDA_DD = disabled

# UTC offset (+01:00) and timezone name
MODE_SHOW_OFFSET  = disabled
MODE_SHOW_TZ_NAME = disabled

# Other clocks on the time row. The date row keeps the local date.
# Local sidereal time, apparent solar (sundial) time, the second timezone.
MODE_LST   = disabled
MODE_SOLAR = disabled
MODE_ZONE2 = disabled

# The text and the countdown set further down
MODE_TEXT      = disabled
MODE_COUNTDOWN = disabled

# All LEDs off. GPS stays on.
MODE_STANDBY = disabled


## astronomy modes
# These need a position: a GPS fix, or the fixed position below.

# Sunrise, sunset and solar noon. The sun's azimuth and elevation now.
MODE_SUN      = disabled
MODE_SUN_AZEL = disabled
# Moon phase and illuminated percentage (needs no position)
MODE_MOON     = disabled
# Maidenhead grid locator. Latitude and longitude.
MODE_GRID     = disabled
MODE_LATLON   = disabled
# Countdown to astronomical darkness (sun 18 degrees down), and the twilight times
MODE_DARK     = disabled
# Countdown to the next bright stars crossing your meridian. Needs STARS.BIN on the drive.
MODE_STAR     = disabled

# Use only stars brighter than this magnitude. A smaller number gives fewer,
# better-known stars: 1.5 is about two dozen.
#star_max_mag = 6

# How long each page of a paged mode stays up, in milliseconds. 250 or more.
page_ms = 5500

# A fixed position, in decimal degrees, north and east positive. With these set
# the clock ignores the GPS position. An example.
#fake_latitude  = 51.4779
#fake_longitude = -0.0015


## diagnostic modes

# Satellites in view
MODE_SATVIEW  = disabled
# Allan deviation of the clock's own oscillator, measured against GPS
MODE_ADEV     = disabled
# What the temperature compensation has learned
MODE_TEMPCOMP = disabled
# Coin-cell voltage
MODE_VBAT     = disabled
# Checksum of the installed firmware
MODE_FIRMWARE_CRC = disabled
# Time to first fix after power-on. Light every segment. Raw brightness. RTC calibration.
MODE_TTFF             = disabled
MODE_DISPLAYTEST      = disabled
MODE_DEBUG_BRIGHTNESS = disabled
MODE_DEBUG_RTC        = disabled


## colons

# slowfade, heartbeat, sawtooth, alt_sawtooth, toggle or solid
colon_mode = heartbeat
# The colon for MODE_LST, MODE_SOLAR and MODE_ZONE2. Switched off, the clock
# picks one that differs from colon_mode, so those modes never look like local time.
#colon_alt_mode = alt_sawtooth

# A small flourish on each quarter-hour and a longer one on the hour: off or trust
cuckoo = off


## text and countdown

# The text MODE_TEXT shows. An example.
#text = HELLO
# The moment MODE_COUNTDOWN counts down to, in UTC. An example.
#countdown_to = 2027-01-01T00:00:00Z


## when GPS is lost

# The clock hides its last digits as its time gets less certain. With
# significance_fade off, these are the seconds without GPS after which the
# 1 ms, 10 ms and 100 ms digits go.
Tolerance_time_1ms   = 1000
Tolerance_time_10ms  = 10000
Tolerance_time_100ms = 100000
# on (the default): use the clock's own measurement of its error and not the
# three times above. Each digit fades as the error reaches it.
significance_fade = on

# on (the default): without GPS, hold the oscillator frequency measured while
# GPS was present. The clock needs 48 seconds of GPS first.
freq_hold = on

# Temperature compensation. With GPS, tc_learn measures how the oscillators
# drift with temperature. Without GPS, tc_apply corrects the display for it and
# tc_rtc corrects the battery-backed clock. tc_persist keeps what was learned
# across power-off. All but tc_rtc are on by default.
tc_learn   = on
tc_apply   = on
tc_rtc     = off
tc_persist = on
# Reference temperature in degrees C. Seconds without GPS before the correction
# starts (2 or more). The largest correction, in parts per million.
#tc_t0       = 40
#tc_engage_s = 2
#tc_max_ppm  = 100
# A model to start from. Send "tc_dump = on" over USB serial and paste the lines
# it prints here. The numbers below are placeholders.
#tc_hse_b = 0
#tc_hse_c = 0
#tc_lse_a = 0
#tc_lse_b = 0
#tc_lse_c = 0
#tc_seed_lo = 0
#tc_seed_hi = 0
#tc_seed = on


## brightness

# The curve from the light sensor to the display brightness: five points, each
# "sensor,brightness", 0 to 4095. This one suits the VTT9812FH sensor with R11 = 470K.
BS1 = 0,0
BS2 = 131,365
BS3 = 1076,1422
BS4 = 2774,2665
BS5 = 3849,4095
# A fixed brightness, 0.0 to 1.0 or 0 to 4095. Switched off, the light sensor sets it. An example.
#brightness = 0.5

# on (the default): make every digit equally bright. Off, a 1 is brighter than
# an 8. A number from 2 to 300 sets a fixed strength.
seg_balance = on
# on (the default): dim the colons with the digits. A number from 2 to 256 sets
# a fixed level.
colon_balance = on
# The two ends of the automatic colon curve: the brightness at or below which the
# colons are full, and their level (of 256) at the dimmest setting.
#colon_full_at = 2048
#colon_floor   = 20


## USB serial output

# GPS sentences: on, rmc (position and time only) or off
nmea = on
# on (the default): one $PMTXTS timing sentence for each GPS pulse
pps = on
# on: report the automatic dimmer once a second as $PMBRIT. PCC asks for this
# when it connects. Leave it switched off here, or a reload of this file stops it.
#brightness_report = on
# on: report the main loop's longest pause once a second as $PMLOOP
#loop_diag = on


## reliability

# on (the default): restart the clock if its firmware stops for 8 seconds. Once
# it is running, "off" takes effect at the next restart.
watchdog = on


## this file and the menu

# A setting you change with the clock's buttons stays until you change that
# setting's line in this file. Changing a different line does not undo it.
#
# on: the clock writes its menu changes into this file, so the file shows what
# the clock is doing. It only does this when no computer has been connected
# since power-on. It then adds a line that starts "# synced". With PCC's pccd
# running on a connected computer, pccd writes the changes whatever this says.
config_write = off

# To erase every menu change and everything the clock has learned, choose
# SYS > RESET in the menu, or send "factory_reset = on" over USB serial. The
# clock then does exactly what this file says.
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

// Lay a config.txt onto the template: every setting `text` makes (its active `key = value` lines, the
// last one for a key winning, as in the firmware) goes onto the template's line for that key, which is
// switched on if it was off. The template's layout, comments and every other line stay as they are.
// MODE_* values are written as enabled/disabled. `aliases` maps an old key to the current one
// (MODE_SUNDIAL is MODE_SOLAR). Returns { text, unknown }: `unknown` lists the keys the template has
// no line for; they are added at the end, so nothing the file set is lost.
export function retemplate(text, template = DEFAULT_CONFIG, aliases = { mode_sundial: 'mode_solar', alt_colon_mode: 'colon_alt_mode', astro_page_ms: 'page_ms' }) {
  const want = new Map();
  for (const [k, v] of Object.entries(parseConfigText(text))) want.set(aliases[k] || k, v);
  const seen = new Set();
  const out = String(template).split('\n').map((line) => {
    const m = line.match(/^(#?)(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const kl = m[3].toLowerCase();
    if (!want.has(kl)) return line;
    seen.add(kl);
    let v = want.get(kl);
    if (kl.startsWith('mode_')) v = truthy(v) ? 'enabled' : 'disabled';
    return m[2] + m[3] + m[4] + v;
  });
  const unknown = [...want.keys()].filter((k) => !seen.has(k));
  if (unknown.length) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push('', '', '## keys this template has no line for', ...unknown.map((k) => `${k} = ${want.get(k)}`), '');
  }
  return { text: out.join('\n'), unknown };
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
  { cfg: 'mode_dark', key: 'dark', group: 'astro' },
  { cfg: 'mode_star', key: 'star', group: 'astro' },
  { cfg: 'mode_tempcomp', key: 'tempcomp', group: 'diag' },
  { cfg: 'mode_adev', key: 'adev', group: 'diag' },
  { cfg: 'mode_zone2', key: 'zone2', group: 'timerow' },
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
