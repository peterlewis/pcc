// datalink-decode.js — the receiver half: the optical PHY (as a real Timex Datalink watch reads it)
// and a decoder that turns a transmission back into what the watch would store. This is our test
// target while there's no physical watch: compose → encode → FLASH → decode → "the watch got this".
//
// PHY ground truth: synthead/timex-datalink-arduino (led_blaster.cpp). Each byte is a START pulse then
// 8 bits LSB-first; a 0-bit is a brief light PULSE, a 1-bit is DARK, each ~465µs. (A 60Hz screen can't
// make 15µs flashes / 465µs bits, so a phone can drive THIS emulator but not a real watch — the real
// transmitter is the clock's LED.) Byte decode mirrors timex-datalink.mjs.
import { crc16arc, CHARS, EEPROM_CHARS, PHONE_CHARS } from "./timex-datalink.mjs?v=1";

export const BIT_US = 465;   // one bit period (LED_ON_MS_NORMAL 15µs + LED_OFF_MS_NORMAL 450µs)

// ---- PHY: bytes <-> symbol stream. A "symbol" is a bit value; each byte = [start=0, b0..b7] LSB-first.
// A 0 emits a pulse; a 1 emits nothing — so `pulse` marks where the watch sees light.
export function phyEncode(bytes) {
  const syms = [];
  for (const b of bytes) {
    syms.push({ bit: 0, start: true, pulse: true });                 // start bit (always a pulse)
    for (let i = 0; i < 8; i++) { const bit = (b >> i) & 1; syms.push({ bit, start: false, pulse: bit === 0 }); }
  }
  return syms;   // length = 9 * bytes.length; multiply by BIT_US for real duration
}

// Recover bytes from a symbol stream (the watch's job): every 9 symbols = 1 start + 8 LSB-first bits.
export function phyDecode(syms) {
  const out = [];
  for (let i = 0; i + 9 <= syms.length; i += 9) {
    let b = 0;
    for (let k = 0; k < 8; k++) if (syms[i + 1 + k].bit) b |= 1 << k;
    out.push(b);
  }
  return out;
}

// ---- byte-stream -> watch state. Walks the CRC-framed packets after the sync preamble. ----
const idx2char = (arr, map) => arr.map((v) => map[v] ?? "?").join("");

// Reverse eeprom_chars_for: little-endian 6-bit values until the 0x3f terminator.
function unpackEeprom(bytes) {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) acc = (acc << 8n) | BigInt(bytes[i]);
  const out = [];
  while (acc > 0n) { const v = Number(acc & 0x3fn); if (v === 0x3f) break; out.push(v); acc >>= 6n; }
  return idx2char(out, EEPROM_CHARS);
}

export function decodeWatch(flat) {
  const state = { time: null, alarms: [], sound: null, appointments: [], warnings: [], packets: 0, crcOk: 0, crcBad: 0 };
  let i = 0;
  if (flat[i] === 0x78) { while (i < flat.length && (flat[i] === 0x78 || flat[i] === 0x55 || flat[i] === 0xaa)) i++; } // skip sync

  const dataPages = {};   // section id -> concatenated data bytes (for paginated EEPROM/WristApp)
  while (i < flat.length) {
    const len = flat[i];
    if (!len || i + len > flat.length) break;
    const payload = flat.slice(i + 1, i + len - 2);
    const crc = (flat[i + len - 2] << 8) | flat[i + len - 1];
    if (crc16arc(flat.slice(i, i + len - 2)) === crc) state.crcOk++; else state.crcBad++;
    i += len;
    state.packets++;

    const c = payload[0];
    if (c === 0x32) {                                   // Time
      state.time = {
        zone: payload[1], sec: payload[2], hour: payload[3], min: payload[4], month: payload[5], day: payload[6],
        year: 2000 + payload[7], name: idx2char([payload[8], payload[9], payload[10]], CHARS).trim(),
        is24h: payload[12] === 2,
      };
    } else if (c === 0x50) {                            // Alarm
      state.alarms.push({
        number: payload[1], hour: payload[2], min: payload[3],
        message: idx2char(payload.slice(6, 14), CHARS).trim(), audible: payload[14] === 1,
      });
    } else if (c === 0x71) {                            // SoundOptions
      state.sound = { hourlyChime: payload[1] === 1, buttonBeep: payload[2] === 1 };
    } else if (c === 0x91) {                            // paginated DATA page: [0x91, sect, pageIdx, ...data]
      const sect = payload[1];
      (dataPages[sect] = dataPages[sect] || []).push(...payload.slice(3));
    } else if (c === 0x90 && payload[1] === 0x01) {     // EEPROM section header:
      // [0x90,0x01, npages, ...8 addr bytes, ...4 item counts, year, notif] -> counts at [11..14]
      state._eepromCounts = [payload[11], payload[12], payload[13], payload[14]]; // appts, lists, phones, annivs
    }
    // 0x20 start / 0x21 end / 0x93 clear / 0x92 section-end: framing, no payload to keep
  }

  // Reassemble EEPROM appointments (first category) from its data bytes: length-prefixed items.
  const eeData = dataPages[0x01];
  const counts = state._eepromCounts;
  if (eeData && counts) {
    let p = 0;
    for (let n = 0; n < counts[0] && p < eeData.length; n++) {   // appointments only (first category)
      const ilen = eeData[p]; if (!ilen) break;
      const item = eeData.slice(p + 1, p + ilen); p += ilen;
      state.appointments.push({
        month: item[0], day: item[1], hour: Math.floor(item[2] / 4), min: (item[2] % 4) * 15,
        message: unpackEeprom(item.slice(3)),
      });
    }
  }
  delete state._eepromCounts;
  return state;
}
