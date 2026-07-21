// settings-bin.js — parse the Mk IV's /SETTINGS.BIN menu-override store (firmware ≥ v0.0.5+rollup)
// and replicate the firmware's boot merge, so PCC can sync the clock's EFFECTIVE config —
// config.txt ⊕ on-device menu edits — not just the config.txt baseline.
//
// Byte-faithful to mk4-time main.c (ee_pack / ee_scan / menu_apply_overrides):
//   · The file is 16 KiB; the MENU store ping-pongs across the first two 4 KiB sectors
//     (file offsets 0x0000 and 0x1000), 64 slots of 64-byte records each. (Sectors 2–3 hold the
//     independent tempcomp store, magic "MK4T" — not parsed here; tc read-back has $PMTXTC.)
//   · Record layout (little-endian):  0 magic u32 "MK4E" | 4 gen u32 | 8 schema u16 | 10 fdate u16 |
//     12 ftime u16 | 14 simple_mask u16 | 16 modes_mask u32 | 20 modes_val u32 | 24 brightness i16 |
//     26 colon u8 | 27 alt_colon u8 | 28 page_ms u16 | 30 sig_fade u8 | 31 pps u8 | 32 nmea u8 |
//     33 matrix_freq u32 | 37 tc u8 | 38 bal u8 | 39..61 rsvd | 62 crc16.
//   · CRC-16-CCITT (poly 0x1021, init 0xFFFF) over bytes 0..61; the winner is the highest-generation
//     record that passes magic + schema + CRC (a torn write self-rejects, exactly like ee_scan).
//   · MERGE RULE (menu_apply_overrides): an override applies iff the key was menu-set AND
//     (config.txt does not define that key, OR the stored config.txt-mtime stamp equals config.txt's
//     current mtime — i.e. the file has not been re-saved since the menu edit). A zero stamp never
//     matches. Re-saving config.txt therefore re-asserts config for the keys it defines.

export const EE_MAGIC = 0x4d4b3445;         // "MK4E" read as u32-LE
export const EE_SCHEMA = 1;
const REC_SZ = 64, PAGE_SZ = 4096, PAGES = [0x0000, 0x1000], SLOTS = PAGE_SZ / REC_SZ;

// KID numbering (main.h) + the config.txt keys that mark each KID "defined by config this load"
// (parseConfigString sets cfg_simple_defined for exactly these keys; TEMPCOMP and BALANCE are
// bundles — ANY of their keys in config.txt gives config precedence for the whole bundle).
export const KIDS = [
  { kid: 1, id: 'brightness', label: 'BRIGHTNESS', cfgKeys: ['brightness'] },
  { kid: 2, id: 'colon', label: 'COLON', cfgKeys: ['colon_mode'] },
  { kid: 3, id: 'colonAlt', label: 'COLON ALT', cfgKeys: ['colon_alt_mode'] },
  { kid: 4, id: 'pageMs', label: 'PAGE DWELL', cfgKeys: ['page_ms'] },
  { kid: 5, id: 'sigFade', label: 'SIG FADE', cfgKeys: ['significance_fade'] },
  { kid: 6, id: 'pps', label: 'PPS EMIT', cfgKeys: ['pps'] },
  { kid: 7, id: 'nmea', label: 'NMEA LEVEL', cfgKeys: ['nmea'] },
  { kid: 8, id: 'matrixFreq', label: 'MATRIX', cfgKeys: ['matrix_frequency'] },
  { kid: 9, id: 'tempcomp', label: 'TEMPCOMP', cfgKeys: ['tc_learn', 'tc_apply', 'tc_persist'] },
  { kid: 10, id: 'balance', label: 'LED BALANCE', cfgKeys: ['seg_balance', 'colon_balance'] },
];

// Display-name tables (enum order from main.h — used to render values, and to synthesize the
// config-equivalent value when merging an override into PCC's parsed-config object).
export const COLON_NAMES = ['slowfade', 'heartbeat', 'sawtooth', 'alt_sawtooth', 'toggle', 'solid'];
export const NMEA_NAMES = ['all', 'rmc', 'off'];   // NMEA_ALL=0, NMEA_RMC, NMEA_NONE

// Every MODE_* enum name (main.h). Consumers must NOT trust this order — resolve each name to its
// ordinal through the emulator's modeId export at runtime (the emu IS the firmware, so the mapping
// can never drift); names the firmware doesn't know simply resolve to -1 and are skipped.
export const MODE_NAMES = [
  'MODE_ISO8601_STD', 'MODE_ISO_ORDINAL', 'MODE_ISO_WEEK', 'MODE_UNIX', 'MODE_JULIAN_DATE',
  'MODE_MODIFIED_JD', 'MODE_SHOW_OFFSET', 'MODE_SHOW_TZ_NAME', 'MODE_WEEKDAY', 'MODE_WEEKDA_DD',
  'MODE_WDY_MM_DD', 'MODE_STANDBY', 'MODE_COUNTDOWN', 'MODE_SATVIEW', 'MODE_DEBUG_BRIGHTNESS',
  'MODE_DEBUG_RTC', 'MODE_TEXT', 'MODE_FIRMWARE_CRC_T', 'MODE_FIRMWARE_CRC_D', 'MODE_VBAT',
  'MODE_DISPLAYTEST', 'MODE_TTFF', 'MODE_SUN', 'MODE_SUN_AZEL', 'MODE_MOON', 'MODE_GRID',
  'MODE_LATLON', 'MODE_DARK', 'MODE_TEMPCOMP', 'MODE_LST', 'MODE_SOLAR', 'MODE_ADEV', 'MODE_STAR', 'MODE_ZONE2',
];

export function crc16ccitt(bytes, n) {
  let c = 0xffff;
  for (let i = 0; i < n; i++) {
    c ^= (bytes[i] << 8) & 0xffff;
    for (let b = 0; b < 8; b++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xffff) : ((c << 1) & 0xffff);
  }
  return c;
}

/// Scan both menu-store pages; return the highest-generation CRC-valid record (or found:false).
export function parseSettingsBin(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out = { found: false, gen: 0, validRecords: 0 };
  if (u8.length < PAGES[PAGES.length - 1] + PAGE_SZ) return out;   // needs ≥ 8 KiB (both menu pages)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let best = null;
  for (const base of PAGES) {
    for (let s = 0; s < SLOTS; s++) {
      const off = base + s * REC_SZ;
      if (dv.getUint32(off, true) !== EE_MAGIC) continue;
      if (dv.getUint16(off + 8, true) !== EE_SCHEMA) continue;
      if (crc16ccitt(u8.subarray(off, off + 62), 62) !== dv.getUint16(off + 62, true)) continue;   // torn write → reject
      out.validRecords++;
      const gen = dv.getUint32(off + 4, true);
      if (!best || gen > best.gen) best = { gen, off };
    }
  }
  if (!best) return out;
  const o = best.off;
  out.found = true;
  out.gen = best.gen;
  out.stamp = { fdate: dv.getUint16(o + 10, true), ftime: dv.getUint16(o + 12, true) };
  out.simpleMask = dv.getUint16(o + 14, true);
  out.modesMask = dv.getUint32(o + 16, true) >>> 0;
  out.modesVal = dv.getUint32(o + 20, true) >>> 0;
  out.fields = {
    brightness: dv.getInt16(o + 24, true),
    colon: u8[o + 26], colonAlt: u8[o + 27],
    pageMs: dv.getUint16(o + 28, true),
    sigFade: u8[o + 30], pps: u8[o + 31], nmea: u8[o + 32],
    matrixFreq: dv.getUint32(o + 33, true) >>> 0,   // unaligned — DataView handles it
    tempcomp: u8[o + 37], balance: u8[o + 38],
  };
  return out;
}

/// Encode a JS ms-epoch as the FAT fdate/ftime pair FATFS reports for the file. FAT timestamps are
/// timezone-naive LOCAL time (2 s resolution) — macOS/Linux present them as local time, so encoding
/// the host file's lastModified with the browser's local calendar reproduces the dirent bytes.
export function fatStamp(msEpoch) {
  const d = new Date(msEpoch);
  return {
    fdate: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    ftime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/// Which KIDs / MODE_* keys does this config.txt DEFINE? (rebuilt each load, like cfg_*_defined.)
/// Returns { simple: bitmask by KID, modeKeys: Set<'MODE_XXX'> (uppercased) }.
export function cfgDefined(text) {
  const simpleByKey = new Map();
  for (const k of KIDS) for (const key of k.cfgKeys) simpleByKey.set(key, k.kid);
  let simple = 0;
  const modeKeys = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const kid = simpleByKey.get(key);
    if (kid) simple |= 1 << kid;
    else if (key.startsWith('mode_')) modeKeys.add(key.toUpperCase());
  }
  return { simple, modeKeys };
}

/// Apply the firmware's merge rule. `modeName(ordinal)` maps a firmware MODE_* ordinal to its
/// 'MODE_XXX' key (PCC builds it from the emulator's modeId export, so it can never drift from the
/// compiled firmware). Returns per-key verdicts for the UI plus the effective winners for the face.
export function winningOverrides(parsed, cfgText, cfgMtimeMs, modeName) {
  if (!parsed || !parsed.found) return null;
  const def = cfgDefined(cfgText);
  const now = Number.isFinite(cfgMtimeMs) ? fatStamp(cfgMtimeMs) : null;
  const stampOk = !!(now && (parsed.stamp.fdate || parsed.stamp.ftime) &&
    parsed.stamp.fdate === now.fdate && parsed.stamp.ftime === now.ftime);
  const f = parsed.fields;
  const fmt = {
    brightness: () => (f.brightness < 0 ? 'AUTO (SENSOR)' : `${f.brightness} / 4095 (${Math.round((1 - f.brightness / 4095) * 100)}%)`),
    colon: () => (COLON_NAMES[f.colon] || `#${f.colon}`).toUpperCase(),
    colonAlt: () => (COLON_NAMES[f.colonAlt] || `#${f.colonAlt}`).toUpperCase(),
    pageMs: () => `${f.pageMs} MS`,
    sigFade: () => (f.sigFade ? 'ON' : 'OFF'),
    pps: () => (f.pps ? 'ON' : 'OFF'),
    nmea: () => (NMEA_NAMES[f.nmea] || `#${f.nmea}`).toUpperCase(),
    matrixFreq: () => `${(f.matrixFreq / 1000).toFixed(f.matrixFreq % 1000 ? 1 : 0)} KHZ`,
    tempcomp: () => (f.tempcomp ? 'ARMED (LEARN+APPLY+PERSIST)' : 'OFF'),
    balance: () => (f.balance ? 'AUTO (SEG+COLON)' : 'OFF'),
  };
  const entries = [];
  for (const k of KIDS) {
    if (!(parsed.simpleMask & (1 << k.kid))) continue;
    const cfgHasIt = !!(def.simple & (1 << k.kid));
    entries.push({ id: k.id, label: k.label, value: fmt[k.id](), wins: !cfgHasIt || stampOk, cfgHasIt });
  }
  const modes = [];
  for (let m = 0; m < 32; m++) {
    if (!(parsed.modesMask & (1 << m))) continue;
    const name = (modeName && modeName(m)) || `MODE #${m}`;
    const cfgHasIt = def.modeKeys.has(name);
    modes.push({ ordinal: m, name, on: !!((parsed.modesVal >> m) & 1), wins: !cfgHasIt || stampOk, cfgHasIt });
  }
  return { stampOk, stamp: parsed.stamp, gen: parsed.gen, entries, modes };
}
