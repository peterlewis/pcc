// Golden-trace conformance harness: drives the WASM emulator and decodes its latched display
// into digit/char values, so run.mjs can compare against independently-computed ground truth.
import factory from '../../clock-fw.mjs';

// Standard 7-seg LUT (a=bit0 .. g=bit6). The firmware's cLut is this map; civil conformance
// against JS Date proves the inverse decode is exact (a wrong LUT would fail thousands of cases).
const SEG = [0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f];
const DASH = 0x40;
export function decodeSeg(b){
  const p = b & 0x7f;
  if (p === 0)    return ' ';       // blank
  if (p === DASH) return '-';       // dash (no-fix / blanked precision digit)
  const d = SEG.indexOf(p);
  return d < 0 ? '?' : d;           // '?' = unrecognised pattern (a real failure)
}

export async function loadEmu(){
  const M = await factory();
  const w = (n,r='void',a=[]) => M.cwrap(n,r,a);
  const emu = {
    M,
    boot:      w('emu_boot','void',['number']),
    bootCold:  w('emu_boot_cold','void',['number']),
    tick:      w('emu_tick'),
    poll:      w('emu_poll'),
    pps:       w('emu_pps'),
    pendsv:    w('emu_pendsv'),
    pendsvPending: w('emu_pendsv_pending','number'),
    button1:   w('emu_button1'),
    button2:   w('emu_button2'),
    enable:    w('emu_enable_mode','void',['number']),
    setPos:    w('emu_set_pos','void',['number','number']),
    setAdc:    w('emu_set_adc','void',['number']),
    feedNmea:  w('emu_feed_nmea','void',['string']),
    forceHoldover:  w('emu_force_holdover','void',['number']),
    forceHoldover2: w('emu_force_holdover2','void',['number','number']),
    colonMode:  w('emu_colon_mode','number'),
    colonCivil: w('emu_colon_civil','number'),
    colonAlt:   w('emu_colon_alt','number'),
    now:       w('emu_now','number'),
    mode:      w('emu_mode','number'),
    flags:     w('emu_flags','number'),
    hadPps:    w('emu_had_pps','number'),
    sincePps:  w('emu_since_pps','number'),
    satcount:  w('emu_satcount','number'),
    daterow:   w('emu_daterow','number'),
    pmtxtsLine: w('emu_pmtxts_line','string'),
    loadZone:  w('emu_load_zone','number',['string']),
    offsetAt:  w('emu_offset_at','number',['number']),
    setSystick: w('emu_set_systick','void',['number']),
    zoneFromPos: w('emu_zone_from_pos','string',['number','number']),   // ZoneDetect: (lat,lon)->IANA zone
    _registerFile: w('emu_register_file','void',['string','number','number']),
    bufb:      w('emu_bufb','number',['number']),
    bufcLo:    w('emu_bufc_low','number',['number']),
    bufcHi:    w('emu_bufc_high','number',['number']),
    LST: w('emu_MODE_LST','number')(),
    SOL: w('emu_MODE_SOLAR','number')(),
    // named mode ids (avoid magic numbers that rot if the firmware enum reorders)
    M_UNIX:    w('emu_MODE_UNIX','number')(),
    M_ORDINAL: w('emu_MODE_ISO_ORDINAL','number')(),
    M_ISOWEEK: w('emu_MODE_ISO_WEEK','number')(),
    M_WEEKDAY: w('emu_MODE_WEEKDAY','number')(),
    M_MOON:    w('emu_MODE_MOON','number')(),
    M_GRID:    w('emu_MODE_GRID','number')(),
    M_LATLON:  w('emu_MODE_LATLON','number')(),
    M_SUN:     w('emu_MODE_SUN','number')(),
    M_JULIAN:  w('emu_MODE_JULIAN_DATE','number')(),
    M_MJD:     w('emu_MODE_MODIFIED_JD','number')(),
  };
  // Register a file's bytes into the wasm heap for the firmware's FATFS shim (e.g. /TZRULES.BIN).
  // The malloc'd buffer is intentionally NEVER freed — the C shim keeps the pointer.
  emu.registerFile = (name, bytes) => {
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    emu._registerFile(name, ptr, bytes.length);
    return ptr;
  };
  return emu;
}

// One SysTick tick, draining the PendSV the firmware requests at second boundaries.
export function tickN(emu, n){ while(n-->0){ emu.tick(); if(emu.pendsvPending()) emu.pendsv(); } }
export function pps(emu){ emu.pps(); if(emu.pendsvPending()) emu.pendsv(); }

// Decode the full latched display into comparable values.
export function snapshot(emu){
  const big   = [emu.bufb(0)>>2, emu.bufb(1)>>2, emu.bufb(2)>>2, emu.bufb(3)>>2, emu.bufb(4)>>2, emu.bufcLo(0)].map(decodeSeg);
  const small = [emu.bufcLo(1), emu.bufcLo(2), emu.bufcLo(3)].map(decodeSeg);
  const dp    = (emu.bufcHi(0) & 0x10) !== 0;
  // Date row is terminated by '\n' (the firmware writes it at position i+1); bytes after it are
  // stale and never displayed. Read up to the terminator, not a fixed 10 chars.
  const p = emu.daterow(); let dateRow='';
  for (let i=1;i<=10;i++){ const c=emu.M.HEAPU8[p+i]; if (c===0x0a || c===0) break; dateRow += (c>=32&&c<127)?String.fromCharCode(c):' '; }
  const fl = emu.flags();
  return {
    big, small, dp, dateRow: dateRow.replace(/\s+$/,''),
    mode: emu.mode(), now: emu.now() >>> 0,          // C unsigned -> read as uint32 (Y2038-safe to 2106)
    hadPps: !!(fl&2), dataValid: !!(fl&1),
    sincePps: emu.hadPps() ? (emu.sincePps() >>> 0) : null,
    colon: emu.colonMode(),
    bigStr: big.join(''), smallStr: small.join(''),
  };
}
