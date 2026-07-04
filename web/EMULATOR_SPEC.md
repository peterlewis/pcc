# Precision Clock Mk IV — Display Emulator Spec

Implementation record for `js/clockface.js`, a vanilla canvas renderer that emulates
the Mk IV display **pixel-faithfully** from the real firmware + CAD, with **no hardware
attached**. It is both the web app's signature hero and a standalone precision-clock
emulator. Every glyph byte, colon waveform, and dimension below is taken **verbatim** from
the firmware/CAD — sources of record:

- `clock4/mk4-date/Core/Src/main.c` — date board font (`lut_7seg`, `lut_7seg_inv`)
- `clock4/mk4-time/Core/Src/main.c` — time board, colon animation table, display modes
- `clock4/mk4-time/Core/Inc/main.h` — segment `#define`s, colon-mode enum
- `clock4/cad/colons.scad` — physical cell/colon geometry (RevD)

> **Fidelity status:** an adversarial pass diffed the committed `clockface.js` against the
> firmware — all 95 date + 95 inverted-date + 10 time glyphs, the sentinel, and all six colon
> waveform tables are **byte-exact**. No decode, phase, or normalisation error. The only
> non-firmware-derived parts are the within-digit segment *shape* and the two-row hero
> composition (see §7), which are tuned, not measured.

---

## 1. Fonts (generated from firmware, not hand-typed)

Two physical boards. **For rendering, both decode identically: segment `a..g = bit0..bit6`,
on = 1.** The electrical differences (date `<<4`, time-`bLut` `<<2` GPIO shifts; the date
board's `bLut` permutation) are **hardware-only and never applied to pixels**. The decimal
point is always drawn as a discrete dot, never as a segment bit.

```
SEG = { a:0, b:1, c:2, d:3, e:4, f:5, g:6 }
segOn(byte, seg) = (byte >> seg) & 1
```

**Date row** — `LUT_DATE` / `LUT_DATE_INV`, ASCII−32 indexed (index 0 = `' '` = 0x20),
95 entries (0x20–0x7E). Value `64` (`0b01000000`, segment g only) is the firmware's
"unsupported char" sentinel — renders identical to `-`. The imperfect M/W/K/X glyphs are
**reproduced verbatim, not idealised** (fidelity over prettiness). `LUT_DATE_INV` is the
firmware's pre-rotated font for the upside-down half of the board (`inverted` flag → also
reverse cell order, cell `d → 9-d`).

**Time row** — `LUT_TIME` (= `cLut` = `cSegDecode0..9`), digit-indexed 0–9. Byte-identical
to the date digits. `DASH = 0b01000000` is the precision-blank / unsupported glyph.
`cSegDP = 0b00010000` lives in a **separate byte** (`buffer_c[].high`) — informational only;
the renderer draws the DP as a dot.

The exact arrays live in `js/clockface.js` (`LUT_DATE`, `LUT_DATE_INV`, `LUT_TIME`),
generated directly from `main.c`. Decode sanity (date): `0→abcdef`, `8→abcdefg`,
`A→abcefg`, `-→g`. ✓

---

## 2. Geometry (normalised to digit-cell-height H = 1.0 = 34.2 mm, RevD)

From `colons.scad`. Scale the whole face by one number (pixels per H).

| constant      | norm (×H) | mm     | meaning |
|---------------|-----------|--------|---------|
| `cellH`       | 1.0       | 34.2   | digit cell height (the unit) |
| `cellW`       | 0.3509    | 12.0   | digit cell width |
| `pitch`       | 0.4386    | 15.0   | cell centre-to-centre |
| `innerW`      | 0.2924    | 10.0   | active window width |
| `innerH`      | 0.9123    | 31.2   | active window height |
| `colonDotDia` | 0.0921    | 3.15   | colon LED diameter |
| `colonTopY`   | 0.6652    | 22.75  | top colon dot centre (from cell top) |
| `colonBotY`   | 0.3348    | 11.45  | bottom colon dot centre (Δ = 0.3304 = 11.3 mm) |

The **within-digit 7-segment shape is NOT in the CAD** (it's an off-the-shelf through-hole
LED part). Glyph proportions (`glyphW`, `glyphH`, `segThick`, joint gap, end bevel, DP size,
small-fraction scale, row gap) are therefore **tuned to the cell aspect and a device photo**,
not measured — kept as named constants at the top of `clockface.js` so they can be nudged.
The cell is tall and narrow (aspect 0.351), which gives the Mk IV its characteristic tall
digits — the glyph fills the inner window, it is not a wide calculator digit.

Colon `deltaH` (1.85 mm diagonal lean) is dropped — it's a PCB-routing artifact; dots are
drawn on the column centreline.

---

## 3. Layout

**Time row** (hardware-fixed `HH:MM:SS.mmm`): big `HH`, colon, big `MM`, colon, big `SS`
(DP on the seconds digit), then `.` decisecond / centisecond / millisecond as **smaller**
digits. No leading-zero blanking. Precision tiers blank the fraction from the right and turn
the DP off at P0 (`setPrecision(0..3)`). Countdown mode counts the fraction down (`9−x`).

**Date row** (data-driven, 10 cells): whatever string the active mode emits, each char →
`LUT_DATE[char−32]`. A `.` in the stream sets the DP on the **previous** cell and consumes no
position. Default (`ISO8601_STD`): `YYYY-MM-DD`, e.g. `2026-06-29` → cells 4 & 7 are `-`.

Hero stacks **date row above time row** (the device's own arrangement) with a tuned gap;
rows centred horizontally.

---

## 4. Colon animation (verbatim from `loadColonAnimation()`)

Firmware fills two 200-entry tables (`buffer_colons_L/R`) stepped at **10 ms/step → 2 s
cycle**, resynced on the even UTC second; values 0–200 → normalise `/200` to [0,1].
`step = floor((tInCycle·1000)/10) % 200`. Modes (`colon_mode` enum):

| mode (enum)            | name           | L waveform (per `k=0..199`)                              | R |
|------------------------|----------------|----------------------------------------------------------|---|
| 0 `SLOWFADE` (default) | slow triangle  | `k<100: 2k` ; `k≥100: 198−2(k−100)`                      | = L |
| 1 `HEARTBEAT`          | lub-dub        | `k<50: 4k` ; `50≤k<150: 200−2(k−50)` ; `k≥150: 0`        | `L[(k+175)%200]` |
| 2 `1PPS_SAWTOOTH`      | 1 PPS decay    | `196 − (k%100)²/50` (1 s period)                         | = L |
| 3 `ALT_SAWTOOTH`       | alternating    | `k<100: 196−k²/50` else 0                                | `k≥100: 196−(k−100)²/50` else 0 |
| 4 `TOGGLE`             | square 50 %    | `k<100: 200` else 0                                      | = L |
| 5 `SOLID`              | steady         | 200                                                      | = L |

The renderer builds these exact integer tables and indexes them — it does not approximate.
On loss of GPS fix the firmware freezes the animation; the emulator holds last value (or
`SOLID` when mirroring a no-fix device).

---

## 5. Display modes

Each mode is a formatter `(date, ctx) → { dateRow, time-row override? }`. Unless it
overrides the time row, the time row is the standard `HH:MM:SS.mmm`. Implemented set
(others stub to `-` until needed): `ISO8601_STD` (default), `ISO_ORDINAL`, `ISO_WEEK`,
`UNIX`, `JULIAN_DATE`, `MODIFIED_JD`, `WEEKDAY`, `WDY_MM_DD`, `WEEKDA_DD`, `SHOW_OFFSET`
(overrides time row → ±HH MM), `SHOW_TZ_NAME`, `COUNTDOWN` (overrides → counts down), `TEXT`,
`DISPLAYTEST`, `STANDBY`, `VBAT`/`SATVIEW`/`TTFF` (need `ctx` device data). printf padding,
name truncation to 10 cells, and `.`-as-DP are honoured exactly; the imperfect glyphs are
not idealised.

---

## 6. Renderer API (`js/clockface.js`)

```js
const face = createClockFace(canvas, {
  rows: ['date', 'time'],      // which rows, top→bottom (device order)
  tokens: { led, ledDim, ledGlow, inset },  // CSS colour strings (read from CSS vars by default)
  inverted: false,             // date-board upside-down orientation
  utc: false,                  // standalone: show UTC vs host-local
});
face.setMode(name, ctx);       // §5
face.setColonMode(name);       // §4: slowfade|heartbeat|sawtooth|alt_sawtooth|toggle|solid
face.setBrightness(0..1);      // master DAC — scales every lit element incl. colons
face.setPrecision(0..3);       // §3 fraction blank + DP
face.setInverted(flag);
face.render(dateOrEpochMs);    // draw one frame
face.start(timeSource);        // rAF loop; timeSource() => Date (default new Date())
face.stop();
face.applyDeviceFrame(frame);  // live-mirror hook from the serial layer
face.resize(w, h); face.destroy();
```

**Draw:** per cell, decode the glyph byte and draw 7 segments as chamfered hexagons — a
fixed faint **ghost** pass (`--led-dim`, the unlit LED is subtly visible) then a **lit** pass
(`--led`) with a `--led-glow` halo (`shadowBlur`); DP and colons are dots with the same
treatment. Master brightness multiplies the lit alpha (analog DAC behaviour). Tokens read
from CSS custom properties with hard-coded fallbacks, so the module works standalone or
themed by the app.

---

## 7. Known gaps (verify before final ship)

1. **Glyph segment shape is tuned, not measured** (highest impact) — not in CAD. Compare to a
   real Mk IV photo and nudge `segThick` / `glyphW` / bevel.
2. **Row gap & small-fraction scale invented** — hardware is one physical row; the two-row hero
   stack is an app composition choice.
3. **Colon `deltaH` dropped** (centreline instead) — restore if board-exact dots are wanted.
4. **DP dot size/position estimated** — part-specific, not in source.
5. **`LUT_DATE_INV`** spot-checked, not fully re-verified; validate letters if `inverted` is used.
6. **Brightness curve linear** — real LED-supply DAC perceptual curve unknown; add ~2.2 gamma
   on the master term if low levels look too bright.
7. **ISO week / ordinal / TZ math** must match the firmware's libc `gmtime`/`strftime`
   (ISO-8601 week-year boundaries are an easy off-by-one).
