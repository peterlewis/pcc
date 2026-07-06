# Spec — Confidence-Gated Display ("honest digits")

**Status:** proposed · **Depends on:** PPS timestamping (`$PMTXTS`, shipped) · **Pairs with:** firmware temp-compensation (extends digit lifetime, not required)

## Intent

The clock should display **only the sub-second digits it can currently stand behind, and no more.** When GPS is lost, accuracy decays; today the display keeps showing milliseconds it no longer has. Instead, each trailing digit **dims like an analog needle** as its trustworthiness erodes and goes **dark the instant it is no longer *certainly* right** — precision that visibly *evaporates from the right*. On re-lock, the digits flood back.

Two decisions are fixed:
1. **Threshold = "certainly right."** A digit is lit only while it is certain (conservative, `k_σ = 3` → ~99.7%). Honesty beats showing more digits.
2. **Transition = analog needle.** Brightness is a continuous function of confidence, not an on/off blink. A digit fades over a band as it approaches its limit and is dark at the limit.

## Inputs (already available)

From the disciplining loop / `$PMTXTS` (firmware) and `S.pps` (web):
- `calerr` → fractional frequency error of the timebase (→ ppm).
- `sincecal` → holdover age τ (s since last successful GPS calibration).
- `die_temp` → crystal-temperature proxy.
- lock state (GPS present / holdover / pre-first-fix).
- (once temp-comp lands) the residual frequency-uncertainty after correction.

## The uncertainty model `U(τ)`

Track a running **1σ time-error estimate** since last lock, then gate on a conservative multiple of it.

Rigorous form:
```
σ(τ) = sqrt( σ_lock²  +  (σ_y · τ)²  +  (½ · σ_ẏ · τ²)² )
```
- `σ_lock` — phase uncertainty carried into holdover (PPS jitter at lock, ~10–50 ns). Sets the theoretical ceiling; negligible for ms.
- `σ_y` — effective 1σ **fractional-frequency** uncertainty during holdover:
  ```
  σ_y = sqrt( σ_cal²  +  σ_temp²  +  σ_age² )
  ```
  - `σ_cal` — how well the last GPS cal pinned frequency (≈ Allan deviation at τ = `CAL_PERIOD` = 63 s).
  - `σ_temp` — temperature-driven frequency uncertainty since cal. **Dominant for a bare crystal**; = `|tempco · ΔT_unknown|` uncompensated, = the temp-comp model residual once compensation lands. *This is the term temp-comp attacks — it directly buys more lit digits.*
  - `σ_age` — aging; negligible over holdover hours.
- `σ_ẏ` — drift-*rate* uncertainty (the τ² term); matters only for long holdover. Fold into `σ_temp` for v1.

**Implementable v1 (linear, one multiply-add/second):**
```
U(τ) = k_σ · ( σ_lock + σ_y · τ )        // k_σ = 3  ("certainly right")
```
Take `σ_y` as a single conservative "effective holdover frequency uncertainty" constant to start; refine each term from real holdover logs later. Quadratic form is a v2 refinement.

## Digit → brightness mapping

For a sub-second digit at place value `w_k = 10⁻ᵏ s` (k=1 → 0.1 s, k=2 → 0.01 s, k=3 → 1 ms), half-weight `h_k = 0.5 · w_k`:

```
b_k = clamp( (h_k − U(τ)) / (β · h_k),  0, 1 )
```
- `U ≤ (1−β)·h_k` → `b_k = 1` (fully lit — certainly right, with margin).
- `U` sweeps `(1−β)·h_k → h_k` → `b_k` ramps `1 → 0` (**the needle sweep**).
- `U ≥ h_k` → `b_k = 0` (dark — no longer certainly right).

`β ∈ (0,1]` is the fade-band width (fraction of the certain band spent fading). Start `β = 0.4`. Brightness maps to the panel's existing per-digit intensity; apply the display's gamma so the fade *looks* linear. Optional: `smoothstep(b_k)` for a softer needle. **Floor is true 0** — a not-certainly-right digit is dark, not dim.

Scope: the fractional field (sub-second digits) + the decimal point. Whole seconds stay trustworthy for days in any realistic holdover, so `HH:MM:SS` is unaffected. The **decimal point** goes dark once even the 0.1 s digit fails (`U ≥ h_1 = 50 ms`), signalling "sub-second precision gone."

## Choreography rules

- **Trust frontier.** Maintain a single "rightmost lit digit" index. Because the `h_k` thresholds are ordered, digits naturally fade **right-to-left** as `U` grows — no explicit sequencing needed.
- **Monotonic in holdover.** The frontier only ever moves left (toward more-significant) during holdover; a digit that goes dark stays dark until re-lock. This is the hysteresis — it prevents chatter if `U` momentarily dips.
- **Flood-back on re-lock.** When GPS re-acquires and re-disciplines, `U` collapses to ~`σ_lock`. Brighten the digits back **right-to-left** with a short sweep (≈ 300–500 ms total) — a deliberate re-acquisition tell, distinct from the slow decay.
- **States, visually unambiguous:**
  - **ACQUIRING** (pre-first-fix) — sub-second precision was never earned; show only digits the free-running RTC/NTP can vouch for. Do not display fractional precision.
  - **LOCKED** — all digits full.
  - **HOLDOVER** — the decaying display above.

## Worked example (illustrative, bare ~3 ppm crystal, `k_σ=3`, `β=0.4`)

`U(τ) ≈ 9e-6 · τ` seconds.

| Holdover τ | `U` | Display |
| --- | --- | --- |
| locked | ~ns | `08:53:28.512` — all lit |
| ~33 s | ~0.3 ms | `.512` — ms digit begins to fade |
| ~55 s | ~0.5 ms | `.51_` — ms digit dark |
| ~9 min | ~5 ms | `.5__` — 10-ms digit dark |
| ~1.5 h | ~50 ms | `08:53:28` — decimal + 0.1 s gone |

With temp-comp shrinking `σ_y` ~10×, every crossover time extends ~10× (ms digit holds ~9 min instead of ~1 min) — the visible payoff of compensation.

## Where it's implemented

**A. Web emulator (design + tune surface, and honest sim/mirror):**
- Compute `U(τ)` in the timing/session layer from `S.pps` (ppm, `sincecal`, temp). Sim: model a plausible `σ_y`. Real device: use the device's reported values (or, once firmware implements it, mirror the device's own frontier from the device frame).
- Extend the clock-face renderer (`clockface-svg.js`) to accept a per-digit-position brightness vector and apply `b_k` as per-digit alpha/glow. Wire through all faces (entry, docked, display).
- Trivial actuation (per-digit alpha); this is where the curve/`β`/`k_σ` get tuned.

**B. Firmware (`clock4-megabuild/mk4-time`):**
- Compute `U(τ)` each second from `die_temp`, `calerr`, `sincecal` (and, post-comp, the residual model).
- Drive per-digit intensity for the trailing digits via the display path. **Verify the driver supports per-digit intensity** (multiplex dwell / PWM per position); the DAC/gamma brightness path suggests it does — confirm, else add per-position PWM in the multiplex loop.
- Implement the trust-frontier state machine (monotonic in holdover, flood-back on re-lock).

**Ordering:** ship v1 uncompensated (larger `σ_y`, faster fade — still honest). Temp-comp later *extends* lit lifetime; the two are independent. Emulator first (design), firmware second (the real honest clock).

## Tunable parameters (start values)

| Param | Meaning | Start |
| --- | --- | --- |
| `k_σ` | "certainly right" confidence multiple | 3 |
| `β` | fade-band width (fraction of certain band) | 0.4 |
| `σ_y` | effective holdover freq. uncertainty | conservative; refine from logs |
| `σ_lock` | phase uncertainty at lock | ~50 ns |
| flood-back sweep | re-lock brighten duration | 300–500 ms |
| brightness floor | past-threshold intensity | 0 (dark) |

## Validation

- **Emulator:** drop GPS in sim; confirm crossover times track the ppm (e.g., ms digit dark ≈ 55 s at 3 ppm, `k_σ=3`). Confirm monotonic decay + right-to-left flood-back on re-lock.
- **Firmware:** GPS-off holdover run with `$PMTXTS` logging (tooling already exists); confirm each digit goes dark right as the measured error crosses its `h_k`. The Timing-room fit + logger are the reference.

## Out of scope / open

- Whole-second and above (trustworthy for days).
- The `σ_ẏ` quadratic term (v2).
- Per-crystal `σ_y` characterization — best sourced from the same temp-sweep run that feeds temp-comp.
