# Mk IV PPS host-timestamping — `$PMTXTS`

**Status: proposal, not yet tested on hardware.** Firmware side is an isolated branch in the
`clock4` clone (`pcc-firmware-proposals`); host side is `web/js/ppsts.js` + the demo.

## Why
The clock disciplines itself to the GPS PPS edge to sub-microsecond, but the **host never sees
that edge** — over USB it only gets NMEA sentences, which arrive a few hundred ms after the
second and smeared by USB framing. So *no* timing-stability metric is possible from the host
today. This feature emits one tiny proprietary sentence per PPS that carries the firmware's own
edge measurements, so the companion app can show **phase jitter, oscillator drift, and holdover**.

## The sentence
Emitted once per PPS edge when the firmware config contains `pps = on`. It rides the same CDC
virtual-COM stream as the normal NMEA, framed as a standard proprietary NMEA sentence (so it
coexists cleanly and is checksum-validated):

```
$PMTXTS,<seq>,<epoch>,<subms>,<systick>,<load>,<calerr>,<sincecal>,<temp>,<flags>*CC
```

| field | type | meaning |
|-------|------|---------|
| `seq` | u32 | increments every PPS edge; host detects dropped edges via gaps (32-bit — no practical wrap) |
| `epoch` | u32 | `currentTime` at the edge — Unix seconds, UTC |
| `subms` | 0–999 | modelled **ms-of-second** at the edge, captured *before* the counters reset |
| `systick` | u32 | `SysTick->VAL` at the edge, captured *before* the reload (down-counter) |
| `load` | u32 | `SysTick->LOAD` (≈79999 at 80 MHz/1 ms) — sent so the host needn't assume the core clock |
| `calerr` | i32 | signed LSE cycle error over the last `CAL_PERIOD` s (`debug_rtc_val`) |
| `sincecal` | u32 | seconds since the last successful RTC calibration (holdover age) |
| `temp` | i16 | STM32 die temperature in °C (proxy for the crystal temperature) |
| `flags` | hex | bit0 `data_valid`, bit1 `had_pps`, bit2 `rtc_good` |
| `CC` | hex | standard NMEA XOR checksum of the chars between `$` and `*` |

## Host computations (`web/js/ppsts.js`)
- **Phase position at the edge** (ms): `phaseMs = subms + (load - systick)/(load + 1)`.
  SysTick counts down (one ms tick at 0), so `(load-systick)/(load+1)` is the fraction into the
  current ms. Centre it about the second boundary (values >500 → −1000) before doing statistics,
  so edges straddling the boundary don't inflate the numbers.
- **Phase jitter**: RMS (1σ) and peak-to-peak of the centred phase series — how tightly the 1 ms
  tick tracks GPS. This is the headline stability metric.
- **Oscillator drift** (ppm): `ppm = calerr * 1e6 / (LSE_HZ * CAL_PERIOD)`, with `LSE_HZ = 32768`,
  `CAL_PERIOD = 63`. Updates once per calibration window, so it reads as a staircase.
- **ppm vs temperature**: scatter `ppm` against `temp` and the 32 kHz tuning-fork crystal's
  parabolic curve emerges (tempco ≈ −0.034 ppm/°C² about a ~25 °C turnover).
- **Lock / holdover**: `flags` → no-pps / acquiring / locked; `sincecal` → "time on holdover".

## Holdover temperature compensation (a software TCXO)
Locked to GPS, temperature barely matters (every PPS re-aligns the clock). It bites during
**holdover** (GPS lost), where the clock free-runs on the LSE and that crystal's steep tempco
turns a few °C of drift into seconds/day. This feature compensates it. **Split:** the host fits
the curve (flexible), the firmware just evaluates + applies it (small, per-unit).

Model: **`ppm(T) = k0 + k1·(T − 25) + k2·(T − 25)²`** — a **temperature-centred** quadratic (ref
`TC_TREF = 25 °C`, identical in firmware and host). *Not* a vertex form: a 32 kHz tuning fork over a
modest sweep is nearly linear and its parabola vertex lands thousands of °C away, where
fixed-precision serialisation loses all accuracy. Centring keeps the coefficients well-scaled and
round-trip-safe. Workflow:

1. **Characterise** (host): with `pps = on` and **GPS-locked**, run
   `cat /dev/cu.usbmodemXXXX | node web/pps-fit.mjs` and **vary the clock's temperature over as
   wide a range as you can** (let it warm from cold, move it warmer/cooler). `fitTempCompensation()`
   least-squares-fits `ppm(T)` and prints a config line once it has ≥30 samples spanning ≥8 °C.
   Below ~15 °C of spread it fits a **line** (`k2 = 0`) rather than extrapolating an untrustworthy
   curvature; a wider sweep unlocks the full parabola. It also **round-trip-checks** the serialised
   line (re-parses it and verifies the curve stays within 0.5 ppm of the full-precision fit across
   the operating window ± 10 °C) before reporting `READY`.
2. **Configure**: add the printed line to `config.txt` and eject, e.g.
   ```
   temp_comp = 0.1240,-0.31000,-0.034000     # k0, k1, k2
   ```
3. **Apply** (firmware): during **holdover only** (no PPS for >2 s — while locked, `calibrateRTC`
   still owns `CALR` from real measurements), the firmware reads `temp`, computes `ppm(T)`, and
   steers `RTC->CALR` with the *same* ppm→CALR mapping `calibrateRTC` uses
   (`e = ppm·32768·32/1e6`, `CALR = 0x100 + round(e)`, clamped ±255, under a brief IRQ mask). So
   accuracy degrades far more slowly when the sky is blocked. `temp_comp = off` disables it.

The die sensor reads MCU temperature (slightly above ambient), but since the curve is fitted
against the GPS-measured ppm, absolute sensor accuracy isn't required — only repeatability.
Each unit's crystal differs, so the characterisation run is per-device.

## Precision — be honest about USB
USB full-speed framing quantises any host-*arrival* time to ~1 ms with jitter, so you **cannot**
get sub-ms timing from when the sentence shows up. The trick is that **the metric is captured in
firmware at the edge** (SysTick resolution ≈ 12.5 ns) and shipped in the payload — the host
reconstructs timing from `subms`/`systick`, so USB transport jitter never touches the number.
What the host genuinely cannot recover is the **absolute offset to true UTC** (that needs the
real edge arrival); hence the app shows jitter/stability/drift, not an absolute offset.

For OS-level sync there's a complementary path (a clean DCD/SerialState pulse for Linux
`pps-ldisc`/chrony) — see the firmware briefing — but that's capped at the ~1 ms USB floor and is
out of scope here.

## Contract / sync points
`LSE_HZ` and `CAL_PERIOD` in `ppsts.js` **must match** the firmware
(`mk4-time/Core/Src/main.c`: `#define CAL_PERIOD 63`, LSE 32768 Hz). The sentence layout must
match `emitPPSTimestamp()`. If the firmware ever changes either, bump both.
