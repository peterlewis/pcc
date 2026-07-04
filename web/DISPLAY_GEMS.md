# Display Gems — the complete catalogue

Every idea for the Mk IV's display beyond telling the time, in one place. The premise
that makes these more than LED-toy tricks: **this is a GPS-disciplined light source with
a light sensor beside it** — photons with ~10 ns provenance, and a closed optical loop.

Feasibility shorthand: **T** = time board (direct segment buffers, ISR-rate control —
easy) · **D** = date board (ASCII-only protocol; segment-level gems need a small
mk4-date firmware addition) · **E** = prototypable in the web emulator first ·
**S** = uses the light sensor · **F** = uses the fold/hall.
Ratings: wow ★1–5 / effort €1–5.

---

## A · Choreography — the visual showpieces

| # | Gem | The trick | Feas. | ★ | € |
|---|-----|-----------|-------|---|---|
| A1 | **Larson scanner** | A bright pip sweeps the mid-segments of all 10 digits with a PWM-faded tail. The fade is what sells it — everyone does on/off; nobody does the tail. | T·E | ★★★★ | €2 |
| A2 | **The second hand** | One digit's six outer segments as a rotating spinner — driven from the sub-second counter so it turns *exactly* once per second. A mechanical second hand accurate to the microsecond. | T·E | ★★★★★ | €1 |
| A3 | **The snake** | A lit segment slithers one continuous path threading every digit — top row, down an edge, back along the middle. The craft is finding the Hamiltonian-ish path through the segment graph. | T·E | ★★★ | €3 |
| A4 | **DP-row canvas** | The ten decimal points are a free 1-D display everyone wastes: binary seconds counter, bouncing ball, progress-to-next-minute fill, light-sensor VU meter. | T·E(·S) | ★★★ | €1 |
| A5 | **Phase-offset spinners** | A2 on all ten digits with per-digit phase offsets → a hypnotic barber-pole wave rolling down the bar. | T·E | ★★★★ | €1 |
| A6 | **Vertical wipe** | All `a` → all `g` → all `d`: a horizontal bar sweeping down the face. The natural screen-transition / mode-change animation. | T·E | ★★ | €1 |
| A7 | **Segment rain** | Matrix-style: segments cascade top→middle→bottom in random columns and pool into the real time. | T·E | ★★★ | €2 |
| A8 | **Reveal-from-8** | Power-on: every digit starts as `8` (all segments) and peels away to the true reading. The display introducing itself. | T·E | ★★★ | €1 |
| A9 | **Odometer roll** | Digits morph/roll on change instead of snapping — segment-level tweening on tick. | T·E | ★★★ | €3 |
| A10 | **Inverted words** | The date board already renders upside-down (fold/hall `inverted` flag): calculator-speak that reads both ways up, revealed by folding. | D·F | ★★ | €1 |
| A11 | **Ambient breathing** | Light-sensor drives the animation, not just brightness: the Larson tail lengthens in the dark; the DP VU dances to the room. | T·S·E | ★★★ | €2 |

## B · Kinetic astronomy — the display wearing the sky

| # | Gem | The trick | Feas. | ★ | € |
|---|-----|-----------|-------|---|---|
| B1 | **The terminator bar** | Each digit column = 36° of longitude; per-column brightness = daylight there *right now*. The day/night terminator crawls across your clock once a day — a 1-D live world map. Pairs with the astro pack's solar maths. | T·E | ★★★★★ | €3 |
| B2 | **Solar vs sidereal race** | Two swept dots, one solar-second, one sidereal-second — visibly separating, lapping every ~6 minutes. Kinetic proof the sky and the sun disagree. (Pairs with the deferred time-row LST mode.) | T·E | ★★★★ | €2 |
| B3 | **Seconds pendulum** | A dot swinging bar-end to bar-end with true sinusoidal velocity, period exactly 2 s — the pendulum-clock ancestor, rendered perfect by GPS. | T·E | ★★★ | €1 |

## C · Time as position

| # | Gem | The trick | Feas. | ★ | € |
|---|-----|-----------|-------|---|---|
| C1 | **Linear second hand** | One lit element sweeps the full 530 mm open bar exactly once per second, phase-locked to PPS — milliseconds as *position*, read like a meter. Lock loss becomes *visible drift*. No clock has ever shown its own phase error as geometry. | T(+D for full bar)·E | ★★★★★ | €2 |
| C2 | **Fold light-painting** | Strobe the date board during its 180° swing: long-exposure photos catch text painted through the air along the hinge's own arc. The mechanism is the brush. | D·F | ★★★★ | €3 |

## D · The display as an optical instrument

| # | Gem | The trick | Feas. | ★ | € |
|---|-----|-----------|-------|---|---|
| D1 | **Strobe standard** | Software-set matrix refresh (1–100 kHz) on a GPS timebase → light at *exactly* N Hz. Shutter tester, stroboscope, camera-fps calibrator. NIST-traceable desk lighting. | T | ★★★★ | €2 |
| D2 | **Film-slate mode** | Gray-coded milliseconds strobed on the decimal points — designed to survive motion blur where digits don't. Any video frame containing the clock becomes timestampable to ~1 ms in post. A £60 GPS timecode slate; real users already film this clock. | T(+D)·E | ★★★★★ | €3 |
| D3 | **Steganographic photos** | Sub-perceptual temporal dither: every rolling-shutter photo of the clock carries its capture instant hidden in the banding. Every desk photo self-timestamps. | T | ★★★ | €4 |

## E · The optical loop — transmitter + receiver

| # | Gem | The trick | Feas. | ★ | € |
|---|-----|-----------|-------|---|---|
| E1 | **Rolling-shutter LiFi** | kHz banding a phone camera reads but the eye can't: the companion reads fix state / config / coarse time from the clock **through a webcam, no cable**. | T | ★★★★ | €4 |
| E2 | **DataLink resurrection** | The browser flashes a black/white block; the clock's phototransistor (already ADC-sampled at 1 kHz) receives. Hold the clock to the monitor and the timezone trickles in by lamplight — the Timex DataLink, thirty years on, zero extra hardware. | S·(T) | ★★★★★ | €3 |
| E3 | **Clock-to-clock sync** | Two Mk IVs face to face — one's display, the other's sensor — exchanging time optically and displaying their mutual offset in µs. Completely useless. Absolutely irresistible. | T·S | ★★★ | €4 |

---

## Where they run

- **Time board** gems (most of the above): direct `buffer_b`/`buffer_c` segment control
  exists; effects are main-loop/ISR table-driven — the hard part is already in the firmware.
- **Date board** gems (A10, C2, and full-bar C1/D2): the inter-board protocol is
  ASCII + a few commands; segment-level control needs a small mk4-date addition
  (a `CMD_RAW_SEGMENTS` frame would unlock the whole catalogue on both rows).
- **Everything marked E prototypes in the web emulator first** — no flashing required
  to tune choreography.
- Natural firmware home: a `MODE_GEMS` screensaver/idle mode (config-gated, like every
  other mode), plus discrete features (D2 film-slate, E2 optical config) as their own keys.

## Build order (opinionated)

1. **A2 second hand** — an afternoon, instantly the best thing on the desk.
2. **C1 linear second hand** — the thesis gem: precision made visible.
3. **B1 terminator bar** — the beauty gem; astro pack already computes the maths.
4. **D2 film-slate** — the product gem; real users, real problem, unreal price.
5. **E2 DataLink** — the love gem; the browser teaching a clock by lamplight.
