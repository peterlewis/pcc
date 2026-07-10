# Per-segment brightness compensation (Precision Clock Mk IV)

**Status:** design + numerical proof (this dir). Firmware prototype pending a decision on the
spatial-vs-temporal tradeoff (§5). Target: a config-gated feature, PR-worthy for mitxela/clock4.

## 1. The symptom

At low brightness, characters with FEWER lit segments glow brighter, monotonic in segment count:

| char | segments (7-seg) | count | observed |
|------|------------------|-------|----------|
| `-`  | g                | 1     | brightest |
| `1`  | b,c              | 2     | ↓ |
| `7`  | a,b,c            | 3     | ↓ |
| `4`  | b,c,f,g          | 4     | "a bit brighter" |
| `0`  | a,b,c,d,e,f      | 6     | ~normal |
| `8`  | a..g             | 7     | dimmest |

Perfect monotonicity in segment count is the fingerprint of **current sharing**.

## 2. Why (the hardware model, from the firmware)

The display is a multiplexed matrix scanned **one column at a time** (5 B-columns via `bCat0..4`
column-select in `buffer_b[]`, plus the C word in `buffer_c[]`), clocked by TIM1/TIM7 UP events at
Period=256 @ 80 MHz ≈ **3.2 µs/slot**, DMA'd **circularly** to `GPIOB->ODR`/`GPIOC->ODR`. The
transfer count `bright` (normally 5 = the five real columns) sets the circular length.

Brightness is otherwise set by **DAC1** (`dac_target`, 12-bit, smoothed at 100 Hz, DMA'd to
`buffer_dac[]`): a **single global** current/voltage reference for the whole display. It cannot vary
per-column within a scan.

So when a column with `N` lit segments is energised, those `N` segments **share one current
budget** `I_col` → each carries `≈ I_col/N`. Fewer segments ⇒ more current each ⇒ brighter.
This is analog; the digital firmware never "sees" it.

Per-segment time-averaged brightness today (5 columns, 1 slot each, cycle length 5):

```
B(seg in column c) = (I_col / N_c) · (1/5)      # depends only on N_c → context-independent, uneven
```

## 3. The only digital knob: duty

The DAC is global and the segment pattern per column is fixed by the digit, so the **sole** per-column
brightness control is **how many of the scan's slots that column occupies** (its duty). The scan buffers
are already sized `[80]` — only slots `0..4` are used today; slots `5..79` are the headroom this needs.

## 4. Duty compensation (per-segment equalisation — the user's chosen target)

Give column `c` a slot count `s_c ∝ N_c` (interleaved across the buffer to avoid per-column flicker),
with total slots `M = Σ s_c`:

```
B(seg in column c) = (I_col / N_c) · (s_c / M)
                   = (I_col / N_c) · (N_c / ΣN)          # s_c = M·N_c/ΣN
                   = I_col / ΣN                          # SAME for every lit segment ✓
```

Every lit segment, in every digit, ends up at `I_col/ΣN`. The `-`/`1`/`4`/`7` bloom is gone. This is
exactly "equalise per-segment".

Slot budget & flicker: worst case `ΣN` for five 7-seg columns is `5·7 = 35`; with `M = 80` the cycle
is `80·3.2 µs = 256 µs` ⇒ **3.9 kHz** full-cycle, each column refreshed well above flicker even at its
minimum slot allocation. Ample headroom.

## 5. The tradeoff (decision needed)

Compensation makes brightness **spatially uniform** but **context-dependent**: `B = I_col/ΣN` depends
on the *total* lit segments across all digits. So the whole panel is slightly dimmer when it shows
segment-heavy values and brighter for sparse ones — a **temporal** shimmer as the clock ticks (largest
at rare rollovers like `59→00`, tiny second-to-second). Total drawn current stays constant (one column
lit at a time); the same light is just shared among more segments.

Today's uncompensated display has the opposite property: uneven across digits, but each digit's
brightness is **stable over time** (depends only on its own `N`).

- **Option A — duty only.** Fixes the spatial bloom (the actual complaint). Accepts a mild temporal
  shimmer. Simplest, self-contained, low-risk. **Recommended first.**
- **Option B — duty + DAC∝ΣN.** Also boost `dac_target` proportional to `ΣN` once per second so total
  light ∝ ΣN ⇒ per-segment brightness constant in *both* axes. Removes the shimmer entirely, but adds
  current-headroom limits (can't boost past max at full brightness) and couples into the auto-brightness
  loop. Best done as a phase-2 refinement, gated, after measuring whether A's shimmer is even visible.

## 6. Implementation sketch (Option A, config-gated)

- New config key, default OFF (stock behaviour byte-identical when off): e.g. `seg_balance = 1`.
- At latch time compute `N_c = popcount(segment bits of column c)` for the 5 B-columns (+ the C word),
  `ΣN`, then `s_c = round(M · N_c / ΣN)` with a fix-up so `Σ s_c = M` exactly.
- Fill `buffer_b[0..M-1]` (and `buffer_c`) by an **interleaved** spread (Bresenham/Floyd-style) so each
  column's `s_c` slots are distributed, not contiguous (flicker). Set `bright = M` (M fixed ⇒ set once).
- Guard the zero case (`ΣN = 0`, blank display) and countdown/text paths that also latch.
- When `seg_balance = 0`, keep the current `latchSegments()` (5 slots) verbatim.

### Emulator verification — what it can and cannot show
The WASM emulator runs the **real firmware C**, so it will fill `buffer_b/buffer_c` identically and we
can **inspect the slot allocation** (via `emu_bufb()`/`emu_bufc_*()`) to prove, e.g., `1`→2 slots,
`8`→7 slots, interleaved, digits intact, no crash — a full **logic** verification. It will **not** show
the analog brightness itself (the emulator doesn't model LED current sharing) unless we add a
current-sharing brightness model to the JS renderer (reads per-column `N_c` + duty → predicted
per-segment brightness). That model is the only way to *see* bloom-vs-compensated in the emulator;
worth doing as the visual proof, separate from the firmware.

## 7. Recommendation
Ship **Option A**, config-gated (`seg_balance`, default off), verified in the emulator at the logic
level + a JS brightness-preview model. Measure the temporal shimmer on real hardware at low brightness;
if objectionable, add **Option B** (DAC∝ΣN) as a gated refinement. This keeps the PR principled and the
stock display bit-identical when the feature is off.

## 8. IMPLEMENTED (2026-07-10, clock4 rollup 4fa34ee) — Option A, config-gated
`seg_balance = on | 0..100` (default off, stock-identical). Non-invasive expander: all 206 existing
buffer writers keep targeting slots 0..4 (the live masters); `segbal_poll()` (main loop, ≤1 kHz)
mirrors them into slots 5..79 with duty `s = 16 − strength·(16−2N)/100` per digit; the cycle mask
`(k·s) mod 16 < s` always lights cycle 0 = the master slot. `display_scan_len` shadows the DMA
count to steer 5↔80 across standby/chainloader.

**Hardware model correction (caught by adversarial review, would have garbled the display):**
`buffer_c[].high` is NOT a second segment byte — it is GPIOC's one-cold column select + enables
(SysInit patterns `0b11001110/1101/1011/0111/1111`), with only bit 4 (`cSegDP`, the decimal point)
being a real LED. The C digit's N = popcount(.low) + DP; the DP rides its digit's duty cycles; the
addressing byte is carried VERBATIM in every mirror slot. The first WASM test encoded the same
misconception and passed — the corrected test (`web/emu/phase1/segbal_check.mjs`) now asserts the
addressing byte is byte-identical in all 16 cycles, so the misconception cannot return.

Verified: WASM 20/20 (duty exact at 100/50, per-segment ratio uniform, live toggle clean); ARM
Release 0 errors; independent line-by-line review SOUND. Staged image (CRC'd, NOT flashed):
`backups/segbal-staging/fwt.bin`. Not visualised in the web emulator (renders masters only) — a JS
brightness model remains the way to *see* it there (§6). Date board unaffected (own MCU + scan —
same treatment possible as a follow-up). Option B (DAC∝ΣN, kills the temporal shimmer) still open.
