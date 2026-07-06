# Conformance harness — clock4 WASM firmware emulator

Three independent tiers prove the emcc-built emulator (`../../clock-fw.mjs`, the real megabuild
firmware `main.c` compiled to WASM) behaves like real Mk IV silicon.

## Tier 1 — golden-trace vs INDEPENDENT truth  ·  `run.mjs`  ·  **4363/4363 PASS**
Drives the emulator across thousands of epochs/positions and checks its *decoded display* against
ground truth computed a completely different way (`truth.mjs`: JS `Date` civil calendar, IAU-1982
GMST, NOAA equation-of-time, ISO-week/ordinal arithmetic, Maidenhead locator). This is the primary
proof — it would catch any emcc miscompilation that changed observable output.
```
node run.mjs
```
Covers: civil time/date/dp/colon, sidereal(+colon+live), solar(+lonscale+bias, 0 s deviation),
precision ladder P0–P3 (incl. the asymmetric P1 branch), alt-mode position-loss honesty,
calendar modes (unix/ordinal/isoweek/weekday), grid.

## Tier 2 — astro byte-anchor  ·  `../../proof.mjs`
Green-anchors the WASM astro math (LST / EoT) against `test_astro.c` reference vectors.

## Tier 1b — firmware timezone engine  ·  `tz_check.mjs`  ·  **912/912 PASS**
Registers the REAL `qspi/output/tzrules.bin` into the emulator's in-memory FATFS shim, loads a zone
through the firmware's OWN `loadRulesSingle()`→`loadRules()` (populating the 162-entry `rules[]` DST
table), then asks the firmware (`setNextTimestamp`/`currentOffset`) for the UTC offset at a battery of
epochs — checked against an INDEPENDENT oracle (JS `Intl`). 8 zones (N/S-hemisphere DST, half-hour
Kolkata, no-DST Phoenix) × 114 epochs incl. exact DST-transition instants: all exact. This is the
byte-faithful IANA engine, replacing the browser-`Intl` single-offset shim. `node tz_check.mjs`.

## Tier 1c — ZoneDetect auto-timezone from GPS position  ·  `tzmap_check.mjs`  ·  **12/12 PASS**
Registers the real 12 MB `tzmap.bin` and runs the firmware's OWN ZoneDetect (`emu_zone_from_pos`:
open `/TZMAP.BIN` → `ZDHelperSimpleLookupString(lat,lon)` → IANA zone → `loadRulesSingle`). 12 world
cities resolve to the correct zone AND the resulting offset matches `Intl`. ZoneDetect STREAMS the
12 MB map through the firmware's 512-byte `mapCache` (`f_read`/`f_lseek`) — never loaded whole; the
`mmap` branch in `zonedetect.c` is `#if 0`'d out, so the FATFS shim (with `f_size` = `obj.objsize`)
is the only path. `node tzmap_check.mjs`. Wired into the app lazily (emu-driver fetches the 12 MB
only when a manual observer position is set), so a faraway observer shows the OBSERVED location's
local time.

## Tier 3b — WASM == native byte-diff  ·  `runner_native.c` + `runner_wasm.mjs`
Same shimmed source (`../main_wrap.c` → firmware `main.c`) built two ways — native clang
(`build_native.sh` → `conform_native`) and emcc — driven by the IDENTICAL stdin event-script;
the two SNAP traces are diffed. Proves the emcc port is bit-for-bit a faithful build.
```
bash build_native.sh
./conform_native      < scripts/battery.txt > native.snap
node runner_wasm.mjs  < scripts/battery.txt > wasm.snap
diff native.snap wasm.snap
```
Event-script verbs: `bootcold/boot <epoch>`, `enable <mode>`, `setadc <u>`, `setpos <lat> <lon>`,
`tick <n>`, `pps`, `pendsv`, `poll`, `nmea <sentence>`, `b1`/`b2`, `snap <label>`.

**Status: COMPLETE — byte-identical native↔WASM across the whole battery.** `scripts/battery.txt`
(cold boot → GPS acquire → minute+hour rollovers → all 27 display modes) diffs clean over 38
snapshots, and a PPS/holdover script diffs clean over its 6 — so the emcc WASM port is bit-for-bit a
faithful build of the firmware across the entire observable surface, including the per-second engine.
(Earlier the native twin SIGSEGV'd once the per-second engine ran: `sendLatch()` = `huart2.Instance->
TDR = 0xFE` with `huart2.Instance` NULL — MX init is stubbed — a store to USART `TDR` at offset 0x28,
which WASM tolerates as a benign linear-memory write but native faults on. Fixed by pointing
`huart2.Instance` at the shimmed `USART2` in `emu_boot`/`emu_boot_cold`.) `runner_native.c` uses
`setvbuf(_IONBF)` so a fault never swallows buffered output.

## Tier 3c — disciplined-timing metrology + model  ·  `timing_model.mjs`  ·  **model within 1.26× ✓**
Characterises the REAL clock's timing from a bench `$PMTXTS` capture: the sub-second PPS phase
(SysTick-VAL residual) and the LSE frequency error (calerr). Computes the OVERLAPPING Allan
deviation, then builds a phase-noise model and confirms it overlays the measured Allan deviation at
every τ (1–256 s). Bench result: **8.6 ns RMS disciplined jitter, 18.89 ppm LSE, Allan slope −1.15
(white PM)** — so the emulator's precision/uncertainty can be grounded on measurement, not a flat
sigma. `emu_set_systick()` injects a model-drawn phase before `emu_pps()` so the emulator's own
`$PMTXTS` carries realistic sub-second jitter (verified: emitted systick == injected). LIMITATION:
the capture is GPS-LOCKED throughout, so it characterises the DISCIPLINED phase noise + LSE error,
NOT free-running holdover drift — that needs a GPS-unplugged capture (physical, not scriptable).

## Tier 3d — live-mode DISPLAY advances (freeze guard)  ·  `live_display_check.mjs`  ·  **8/8 PASS**
The other tiers check the emulator's `currentTime`; this one checks the DECODED 7-seg DISPLAY, which is
a SEPARATE latched buffer. RMC sets currentTime absolutely, but the displayed second is only STAGED
when the sub-second climbs past .900 (SysTick) and LATCHED at the next PPS — so pulsing PPS more than
once per second (the host pulsing on every RMC while the Mk IV emits several RMC talkers/sec) keeps
resetting the sub-second, the display never stages the next second, and the whole face FREEZES while
currentTime keeps ticking. A now-only check is blind to it (this shipped, and froze real hardware).
The tier drives a realistic multi-talker burst (`$GPRMC` + `$GNRMC` + GGA/sec) with ~960 sub-second
ticks and asserts the decoded main row advances: one PPS/sec → **8/8 distinct frames** (`080914→080921`);
two PPS/sec → **1/8 (frozen)**, so the guard is provably sensitive to the regression. `node
live_display_check.mjs`. The host-side discipline that satisfies it lives in `driveEmu` (pulse PPS at
most once per GPS second, keyed on the fix second).

## Tier 3 — real-hardware anchor  ·  `hw_anchor.mjs` + `pmtxts_check.mjs`  ·  **PASS**
Anchors the emulator against a real Mk IV capture (`$PMTXTS` + NMEA over serial), stored as
`fixtures/hw_capture.jsonl` (30 s, 30 `$PMTXTS`, 30 RMC). Source order: `argv[2]` > `$HW_CAPTURE` >
the fixture.
- `node hw_anchor.mjs` — Anchor 1: the hardware's own `$PMTXTS` currentTime == its own RMC UTC
  (30/30 ✓). Anchor 2: replay the captured NMEA into the emulator; its currentTime tracks the
  hardware second-for-second (27/27 ✓, locked 27/27).
- `node pmtxts_check.mjs` — drives the firmware's OWN `emitPPSTimestamp()` in WASM (via
  `emu_pmtxts_line()`) and checks the emitted sentence: well-formed 27/27, valid NMEA checksum
  27/27, epoch == hardware epoch 27/27, seq strictly increments 27/27. The timing/temp fields
  (systick/load/calerr/temp/rtc-good) differ by design — the emulator has no real oscillator or ADC.

## Files
- `harness.mjs` — loads `clock-fw.mjs`, cwraps the `emu_*` API, decodes the latched 7-seg display.
- `truth.mjs` — independent ground-truth oracles + `selfTest()` anchors.
- `scripts/battery.txt` — canonical event-script fixture (boot → GPS fix → rollovers → all modes).
