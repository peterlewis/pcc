// Round-trip: the encoder and the emulated-watch decoder must agree. Proves the whole loop
// (compose → encode → optical PHY → decode) without any hardware. Run: `node .../roundtrip.test.mjs`.
import { Protocol3, compile } from "./timex-datalink.mjs?v=1";
import { phyEncode, phyDecode, decodeWatch } from "./datalink-decode.mjs?v=1";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

// 1. PHY symbol round-trip: bytes -> flashes -> bytes.
const sample = [0x78, 0x55, 0xaa, 0x00, 0xff, 0x32, 0x01, 0x93, 0x91, 0x21];
const back = phyDecode(phyEncode(sample));
ok("PHY bytes→symbols→bytes", JSON.stringify(back) === JSON.stringify(sample), JSON.stringify(back));
ok("PHY start bit is a pulse", phyEncode([0xff]).slice(0, 1)[0].pulse === true);
ok("PHY 0-bit pulses, 1-bit dark", (() => { const s = phyEncode([0x01]); return s[1].pulse === false && s[2].pulse === true; })());

// 2. Full watch round-trip: compose → encode → decode → matches what we set.
const now = { sec: 5, hour: 14, min: 32, month: 3, day: 9, year: 2026, wday: 1 };
const flat = compile([
  Protocol3.sync({ length: 50 }),
  Protocol3.start(),
  Protocol3.time({ zone: 1, is24h: true, dateFormat: "%y-%m-%d", name: "utc", time: now }),
  Protocol3.alarm({ number: 1, audible: true, message: "wake up", time: { hour: 7, min: 15 } }),
  Protocol3.soundOptions({ hourlyChime: true, buttonBeep: false }),
  Protocol3.eeprom({ appointments: [{ time: { year: 2026, month: 10, day: 21, hour: 9, min: 30 }, message: "the future" }] }),
  Protocol3.end(),
]).flat();

const w = decodeWatch(flat);
ok("all packets CRC-valid", w.crcBad === 0, `crcBad=${w.crcBad}`);
ok("time hour/min", w.time && w.time.hour === 14 && w.time.min === 32, JSON.stringify(w.time));
ok("time date", w.time && w.time.month === 3 && w.time.day === 9 && w.time.year === 2026);
ok("time 24h + name", w.time && w.time.is24h === true && w.time.name === "utc", JSON.stringify(w.time));
ok("alarm decoded", w.alarms.length === 1 && w.alarms[0].hour === 7 && w.alarms[0].min === 15 && w.alarms[0].message === "wake up", JSON.stringify(w.alarms));
ok("alarm audible", w.alarms[0] && w.alarms[0].audible === true);
ok("sound options", w.sound && w.sound.hourlyChime === true && w.sound.buttonBeep === false, JSON.stringify(w.sound));
ok("appointment decoded", w.appointments.length === 1 && w.appointments[0].month === 10 && w.appointments[0].day === 21
  && w.appointments[0].hour === 9 && w.appointments[0].min === 30 && w.appointments[0].message === "the future", JSON.stringify(w.appointments));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
