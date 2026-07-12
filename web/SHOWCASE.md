# SHOWCASE — the 7-segment as an instrument

Design notes + research for the PCC clock-face showcase: what a Precision Clock Mk IV
(2 hinged boards, ~132 individually dimmable red elements) can be made to *do* beyond
telling the time. Kept so the exploration doesn't get lost between sessions.

The engine lives in [`js/demo7.js`](js/demo7.js) (the web prototype) and drives the
per-element intensity field on the clock face via `setSegField` /
`computeField` / `segGeometry` in [`js/clockface-svg.js`](js/clockface-svg.js).
The firmware-native catalogue (real hardware) is parked on the clock4 `cuckoo` branch.

---

## The canon (non-negotiable honesty rules)

Every act obeys these — they are what keep the piece an *instrument* and not a screensaver:

1. **The live time stays recoverable.** Effects decorate or multiply the true glyph mask;
   they never replace it with fiction.
2. **The fast sub-second digits and colon dots get no blooms or slow tails.** Their honest
   counting *is* their spectacle. They may dim to anchors, never smear. (A blooming digit
   that flips every frame just saturates into a solid `8`.)
3. **No fake data, ever** — no synthetic satellites, no invented drift.
4. **Choreography is minute-locked to the *displayed* time** (wall-clock stepped, never
   frame-counted), so it stays phase-true.

---

## SHOWCASE II — shipped web acts (demo7.js)

A two-minute theme-and-variations, split by minute parity.

**EVEN minute — the PHYSICS half** (what the display physically *is*):
- **ALIVE** (:00) — change-blooms: a soft bloom where a segment just changed.
- **MORPH** (:06) — slow-motion time. At each second boundary the leaving segments drain
  while the arriving ones fill over ~0.85 s, staggered right→left, so a 59→00 rollover
  becomes a wave cascading toward the hours.
- **THE SCAN** (:20) — variable refresh made visible. The solid face melts into the writing
  beam a multiplexed display actually is: a comet sweeping at a visible ~60 column-steps/s
  (date row counts the live rate, `SCAn 60`), then the rate climbs exponentially to the
  stock 20 000 and the beams outrun the eye and fuse back to solid light. Persistence of
  vision, demonstrated on the instrument that depends on it.
- **DEVELOP** (:34) — darkroom. The face dissolves into red film grain, then the still-ticking
  live time condenses out of the noise like a print in developer — patchy, filling, fixed
  sharp. Date row: `dEUELOPInG`.

**ODD minute — the INSTRUMENT half** (what the clock *knows*):
- **ALIVE** (:00), **HEARTBEAT SCOPE** (:06) — the big digits become an oscilloscope tracing
  the real colon DMA table, phase-locked to `colonStep`; the real colons pulse as the beam
  crosses them. **SAT RAIN** (:26) — real satellites fall down their true azimuth columns
  (no fix → PPS droplets only).

**Both halves share** PENDULUM (:50, stepped-frequency oscillation collapsing to unison at
:55) + LANDING + **THE CARRY** (:59→:00, the rollover pours a bolus of light across the colon
into the minutes digit).

Bloom suppression is gated so a flash never fires over a morph / scan-gap / grain (it would
read as a glitch): `BLOOM * clamp01(1 - wMorph - wScan - wDev)`.

---

## SHOWCASE III — hinge-aware concept research (2026-07)

A concept panel (four orthogonal creative stances × four concepts, three judges) run once
the **hinge** was recognised as the design unlock. Sixteen concepts generated, adversarially
judged on wow / native / honest / feasible / fold-coherent.

### The structural unlocks

1. **The fold gives two topologies.** Open flat = one continuous 20-digit line (date row then
   time row — the natural serialization). Folded = two stacked 10-digit rows, date directly
   above time. There is no fold-angle sensor, so an act must read in **both**. A sweep ordered
   *date-row-then-time-row* is one continuous pass open, and a CRT raster (line 1, then line 2)
   folded — one choreography, coherent in both. Make that the house rule for travelling effects.

2. **The date board is mounted rotated 180°** (the renderer un-flips it via `LUT_DATE_INV`).
   ⚠️ **Correction the panel caught:** this is a *point rotation*, NOT a vertical reflection.
   A raw copy of the time row onto the date row reads upside-down *and* reversed, not like ink
   or water. Two otherwise-lovely concepts (STILL WATER, THE INKBLOT) were killed on exactly
   this — "rotation is not reflection." The concepts that use the truth *correctly* win.

3. **Glyphs have insides.** Each digit is a 6-node segment graph (segments = edges, so glyphs
   can hand-write themselves in stroke order) and decomposes into 3 horizontal strata
   (top bar / middle / bottom bar) — so digits can roll like odometer drums.

### The podium (avg of 3 judges, /50)

- **🥇 THE SOMERSAULT (43) — native 9.7, the most "only-this-clock" idea.** The time climbs
  across the hinge onto the upside-down board, lands *standing on its head* (genuinely
  inverted — that's what the raw bytes look like there), then each digit somersaults upright
  around its own middle bar, one per second, right→left. It publicly performs the 180°
  correction the firmware does silently 60×/s. A micro-hinge inside every glyph echoing the
  macro-hinge between the boards. No kills; ships on the existing engine.

- **🥈 THE FORGETTING (42.3) — the only concept on all three judges' podiums.** The clock
  rehearses its own death: GPS is "unplugged" in a labelled time-lapse and a wall of blur
  eats the digits right→left, each dissolving into a dim superposition of every value it might
  be — until one real PPS snaps all twenty digits sharp again, left→right. It *is* the
  firmware's real U(τ) holdover + significance-fade maths, driven by this crystal's learned ppm.

- **🥉 THE WHISPER (41.3) — no kills; four stances independently converged on it.** The date
  row dies to black, then a single spark carries the real 1 Hz inter-board UART frame over the
  hinge and the date unpacks itself byte by byte. You can *see* the two boards talking. Folded,
  the spark physically jumps the crease — exactly where the real wire lives.

- **Honourable mention — SHUTTER (41, maker podium).** The display becomes its own
  long-exposure photograph: as a shutter readout climbs 1 s → 1 day, every digit collapses to
  its exact time-average (the millisecond digits burn into perfect duty-cycle `8`s; the date
  stays an unexposed black plate). Brightness becomes the derivative of time — the open-flat
  line reads as an arrow-of-time gradient (geology at the date end, weather at the ms end).
  Duty maths must be exact or precision viewers catch it — and they *can* be, the tables exist.

### Killed, deservedly
STILL WATER / THE INKBLOT (the mirror-is-really-a-rotation error), ROSETTA (a sidereal second
is 2.7 ms shorter — the headline drift is invisible at viewing distance), THE SIGNATURE
(~9 s of dark time over-stretches canon rule 1).

### Recommendation
Build the podium three into the two-minute program: **SOMERSAULT** joins the physics/even
minute (the object's autobiography), **THE FORGETTING** anchors the instrument/odd minute,
**THE WHISPER** takes the slot before PENDULUM. **SHUTTER** is the bench player. The only new
plumbing: expose the date-frame bytes and the learned-ppm read-back from the emulator (small;
a future RAW TWIN act gets the ppm hook for free).

---

*Full 16-concept panel output + per-judge scores: session transcript, workflow
`showcase-iii-concept-panel`. Firmware-native catalogue (carry / heartbeat / rain / pendulum /
trust): clock4 `cuckoo` branch + `CUCKOO_SPEC.md` (parked).*
