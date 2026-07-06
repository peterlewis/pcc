// timex-datalink.js — a byte-exact JavaScript port of the Timex Datalink wire protocol, so PCC can
// program a vintage Timex Datalink watch by flashing light (clock LEDs or the phone screen) with the
// GENUINE protocol. Ground truth: synthead/timex_datalink_client (Ruby). This module reproduces its
// `model.packets` output byte-for-byte; conformance is checked against that library's own RSpec
// fixtures (see web/js/datalink/conformance.test.mjs). Protocol 3 = Timex Datalink 150 (the classic).
//
// A "transmission" is an ordered list of models (Sync, Start, Time, Alarm, Eeprom, WristApp, End);
// each model yields one or more packets (arrays of byte values 0..255); the packets are concatenated
// and sent over the optical link. All packets except Sync are wrapped with a length header + CRC.

// ---- CRC-16/ARC (poly 0x8005, init 0x0000, refin/refout true, xorout 0x0000) -------------------
// Anchored by the canonical check value: crc16arc("123456789") === 0xBB3D.
export function crc16arc(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;   // 0xA001 = reflected 0x8005
  }
  return crc & 0xffff;
}

// Wrap one payload as an on-wire packet: [len+3] + payload + CRC-16/ARC(header+payload) as [MSB, LSB].
// (Mirrors Helpers::CrcPacketsWrapper: header = [packet.length + 3]; footer = crc.divmod(256).)
export function crcWrap(payload) {
  const header = [payload.length + 3];
  const framed = header.concat(payload);
  const crc = crc16arc(framed);
  return framed.concat([(crc >> 8) & 0xff, crc & 0xff]);
}

// ---- character maps (indices are the on-wire byte values) --------------------------------------
export const CHARS = "0123456789abcdefghijklmnopqrstuvwxyz !\"#$%&'()*+,-./:\\;=@?_|<>[]";
export const EEPROM_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz !\"#$%&'()*+,-./:\\;=@?_|<>[";
export const PHONE_CHARS = "0123456789cfhpw ";
const EEPROM_TERMINATOR = 0x3f;

// Map a string to character indices (Helpers::CharEncoders#chars_for): downcase, truncate to `length`,
// optionally right-pad with spaces; unknown characters become a space. Returns an array of byte values.
export function charsFor(str, { map = CHARS, length = null, pad = false } = {}) {
  let s = String(str).toLowerCase();
  if (length != null) s = s.slice(0, length);
  if (pad && length != null) s = s.padEnd(length, " ");
  const space = map.indexOf(" ");
  return Array.from(s, (ch) => { const i = map.indexOf(ch); return i < 0 ? space : i; });
}

// 6-bit little-endian packing with a 0x3f terminator (Helpers::CharEncoders#eeprom_chars_for).
export function eepromCharsFor(str, length = 31) {
  const chars = charsFor(str, { map: EEPROM_CHARS, length }).concat([EEPROM_TERMINATOR]);
  return packLE(chars, 6);
}

// 4-bit little-endian packing (Helpers::CharEncoders#phone_chars_for).
export function phoneCharsFor(str) {
  return packLE(charsFor(str, { map: PHONE_CHARS, length: 12 }), 4);
}

// Pack an array of small ints into a little-endian byte string, `bits` per value (BigInt for safety).
function packLE(values, bits) {
  let acc = 0n;
  values.forEach((v, i) => { acc += BigInt(v) << BigInt(bits * i); });
  const out = [];
  if (acc === 0n) return [0];
  while (acc > 0n) { out.push(Number(acc & 0xffn)); acc >>= 8n; }
  return out;
}

// Split a byte stream into pages of `length`, each prefixed with `header` + a 1-based page index
// (Helpers::CpacketPaginator#paginate_cpackets).
function paginate(header, length, cpackets) {
  const pages = [];
  for (let i = 0; i < cpackets.length; i += length) {
    pages.push([...header, pages.length + 1, ...cpackets.slice(i, i + length)]);
  }
  return pages;
}
// Prefix a raw EEPROM item packet with its own length+1 (Helpers::LengthPacketWrapper).
const lengthWrap = (raw) => [raw.length + 1, ...raw];

// EEPROM item raw packets (before length-wrap). time is {month,day,hour,min,year}.
const apptRaw = ({ time, message }) =>
  [time.month, time.day, time.hour * 4 + Math.floor(time.min / 15), ...eepromCharsFor(message)];
const anniRaw = ({ time, anniversary }) => [time.month, time.day, ...eepromCharsFor(anniversary)];
const phoneRaw = ({ name, number, type = " " }) =>
  [...phoneCharsFor(`${number} ${type}`.padStart(12)), ...eepromCharsFor(name)];
const listRaw = ({ listEntry, priority }) => [priority == null ? 0 : priority, ...eepromCharsFor(listEntry)];

// ---- Protocol 3 (Timex Datalink 150) models. Each returns Array<Array<int>> (already wrapped). ----
export const DATE_FORMAT = {
  "%_m-%d-%y": 0, "%_d-%m-%y": 1, "%y-%m-%d": 2, "%_m.%d.%y": 4, "%_d.%m.%y": 5, "%y.%m.%d": 6,
};

export const Protocol3 = {
  // Optical carrier + preamble. NOT CRC-wrapped. length = number of 0x55 sync bytes (default 300).
  sync({ length = 300 } = {}) {
    return [[0x78, ...Array(length).fill(0x55), ...Array(40).fill(0xaa)]];
  },
  start() { return [crcWrap([0x20, 0x00, 0x00, 0x03])]; },
  end() { return [crcWrap([0x21])]; },

  // Set a time zone's clock. `time` is a plain {sec,hour,min,month,day,year,wday} (wday: 0=Sun..6=Sat,
  // JS Date convention). zone 1|2; is24h bool; dateFormat a key of DATE_FORMAT; name ≤3 chars.
  time({ zone, is24h, dateFormat, time, name }) {
    if (zone < 1 || zone > 2) throw new Error(`zone ${zone} is invalid (valid 1..2)`);
    if (!(dateFormat in DATE_FORMAT)) throw new Error(`date format ${dateFormat} is invalid`);
    const nm = name != null ? name : `tz${zone}`;
    return [crcWrap([
      0x32, zone, time.sec, time.hour, time.min, time.month, time.day, time.year % 100,
      ...charsFor(nm, { length: 3, pad: true }),
      (time.wday + 6) % 7, is24h ? 2 : 1, DATE_FORMAT[dateFormat],
    ])];
  },

  // Alarm 1..5. `time` is {hour,min}; message ≤8 chars.
  alarm({ number, audible, time, message }) {
    if (number < 1 || number > 5) throw new Error(`alarm number ${number} is invalid (valid 1..5)`);
    return [crcWrap([
      0x50, number, time.hour, time.min, 0, 0,
      ...charsFor(message, { length: 8, pad: true }), audible ? 1 : 0,
    ])];
  },

  soundOptions({ hourlyChime, buttonBeep }) {
    return [crcWrap([0x71, hourlyChime ? 1 : 0, buttonBeep ? 1 : 0])];
  },

  // The watch's data store: appointments / lists / phone numbers / anniversaries. Items are packed in
  // that fixed order (the wire order, NOT the arg order), length-prefixed, paginated into 32-byte DATA
  // pages, framed by a CLEAR + a section header (item start addresses + counts) + an END.
  eeprom({ appointments = [], anniversaries = [], phoneNumbers = [], lists = [], appointmentNotificationMinutes = null } = {}) {
    const apptPkts = appointments.map((a) => lengthWrap(apptRaw(a)));
    const listPkts = lists.map((l) => lengthWrap(listRaw(l)));
    const phonePkts = phoneNumbers.map((p) => lengthWrap(phoneRaw(p)));
    const anniPkts = anniversaries.map((a) => lengthWrap(anniRaw(a)));
    const allItems = [apptPkts, listPkts, phonePkts, anniPkts];   // wire order

    const dataPages = paginate([0x91, 0x01], 32, allItems.flat(2));
    let address = 0x0236;                                          // START_ADDRESS
    const addresses = [];
    for (const pkts of allItems) {
      addresses.push((address >> 8) & 0xff, address & 0xff);
      address += pkts.reduce((s, p) => s + p.length, 0);
    }
    const lengths = allItems.map((pkts) => pkts.length);          // item counts per category
    const earliestYear = appointments.length ? Math.min(...appointments.map((a) => a.time.year)) % 100 : 0;
    const notif = appointmentNotificationMinutes == null ? 0xff : appointmentNotificationMinutes / 5;
    const header = [0x90, 0x01, dataPages.length, ...addresses, ...lengths, earliestYear, notif];
    return [crcWrap([0x93, 0x01]), crcWrap(header), ...dataPages.map(crcWrap), crcWrap([0x92, 0x01])];
  },

  // A compiled WristApp (a program for the watch). `data` is the raw app bytes (string or byte array).
  wristApp({ data }) {
    const bytes = typeof data === "string" ? Array.from(data, (c) => c.charCodeAt(0)) : data;
    const pages = paginate([0x91, 0x02], 32, bytes);
    return [crcWrap([0x93, 0x02]), crcWrap([0x90, 0x02, pages.length, 1]), ...pages.map(crcWrap), crcWrap([0x92, 0x02])];
  },

  // A sound theme. `data` is the SPC payload bytes (byte array) with its 4-byte file header removed.
  soundTheme({ data }) {
    const pages = paginate([0x91, 0x03], 32, data);
    const offset = 0x100 - data.length;
    return [crcWrap([0x90, 0x03, pages.length, offset]), ...pages.map(crcWrap), crcWrap([0x92, 0x03])];
  },
};

// Concatenate the packets of an ordered model list (TimexDatalinkClient#packets = models.flat_map).
export function compile(models) { return models.flatMap((m) => m); }
