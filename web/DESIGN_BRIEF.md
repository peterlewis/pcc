# Precision Clock Companion — Design Brief

*For a world-class visual + interaction redesign. Feed this alongside `export/pcc-design-export.html`.*

---

## 1. The one sentence

**It is the instrument's own screen** — a companion for the Precision Clock Mk IV that makes the invisible (GPS-disciplined time, the satellites overhead, the drift of a crystal against the universe) visible, and makes you *trust* it at a glance.

Not an app. Not a dashboard. An **instrument** — as precise, honest, and quietly confident as the object it serves.

## 2. What the product actually is

The Precision Clock Mk IV (by mitxela) is a folding, GPS-disciplined LED clock that displays UTC to the millisecond and stays true to nanoseconds of GPS. Two seven-segment boards on a hinge — a date board and a time board — that fold shut like a book.

This web app is three things at once, and the design must hold all three without feeling like three apps:
1. **An emulator** — a byte-faithful software Mk IV for the ~everyone who doesn't own the hardware. The clock face is the hero.
2. **A companion** — plug a real Mk IV in over USB (Web Serial) and it drives the same views: sky plots, signal, position, timing stability, a live globe. Controls command the physical clock.
3. **An instrument for the mathematics** — it surfaces things the clock itself can't show: phase jitter, oscillator drift vs. temperature, Allan/Hadamard deviation, holdover — the *science of keeping time*.

## 3. Who it's for

Horologists, GNSS and timing engineers, radio amateurs, metrology hobbyists, and makers — people who find a nanosecond beautiful. They are **discerning and technical**; they smell fakery instantly and they revere precision. Design *up* to them. The reward for their attention is not decoration — it is **rigour, rendered beautifully**.

## 4. The design thesis (everything flows from this)

> **The interface disappears so the time appears.**

Reduce until only the truth is left, then make that truth inevitable. Every pixel is either data, or the frame that lets data breathe. When it's right, the user won't notice the design — they'll notice they *trust the number*.

## 5. Principles (the non-negotiables)

- **Reduction, not addition.** Remove elements until something breaks, then add back only what's essential. Density is fine — *clutter is not*. A screen dense with meaning can still feel calm.
- **Inevitability.** Every measure, weight, and interval should feel like the only possible choice. Use a real modular scale (spacing, type, radii). Nothing arbitrary; nothing "roughly."
- **Deference.** The chrome serves the data. The frame is quiet so the signal is loud. Borders whisper; numbers speak.
- **Honesty of material.** This is a *screen for LEDs and satellites*. Lean into it: true black, emitted light, precise geometry. No skeuomorphic kitsch, no fake bevels — but no flat blandness either. The LED **emits**; let it emit.
- **Care about the unseen.** The 1 px seam, the hinge symmetry, the sub-pixel alignment, the way a colon breathes — the details no one is asked to notice are exactly the ones that create trust. Get them perfect.
- **Coherence.** One type system, one spatial grid, one motion language, one palette driven by tokens. Change a variable, the whole instrument moves as one.
- **Calm confidence.** Precision instruments don't shout. Restraint *is* the luxury.

## 6. The hero: the clock face

The folding LED face is the emotional and functional center — the first thing seen, the thing that must be flawless. It is now **pure SVG** (`clockface-svg.js`), so it is vector-crisp at any size and fully themeable.

- **Seven-segment authenticity is sacred.** The glyph geometry, the 10° italic lean, the segment miters, the colon dot positions — all derived verbatim from the firmware/CAD. Do not "improve" the letterforms; they are the real part. Style the *light*, not the shapes.
- **Light, not paint.** Lit segments emit (`--led`) with a restrained bloom (`--led-glow`); off-segments are the faint ghost of an unlit LED (`--led-dim`) on true inset black (`--inset`). The bloom should read as *emission*, never as a blur.
- **The fold is the soul.** The book-fold open/close is beloved — keep its physicality (hinge, seam, the pins, the drop shadow of an object with mass). The hinge must be perfectly symmetric; the two board halves meet at a clean 1 px seam.
- **The clock is the hero on every screen size.** On a large display it should be able to grow into a genuine centerpiece, not stay a thin strip. Give it room to be magnificent.
- **Motion with meaning.** The colon "heartbeat," the resync on the even second — these are firmware-true behaviors, not decoration. Preserve their timing.

## 7. Typography

Current system: **B612** (regular/bold) + **B612 Mono** — a typeface commissioned for aircraft cockpit displays: legible under duress, precise, unshowy. It is *exactly right* for this instrument; treat it as a strong default, not a constraint to fight.

- Monospace for all **data** (numbers, coordinates, timestamps, hex, NMEA) — tabular, aligned, scannable. Numbers must never dance as they tick.
- Establish a true **type scale** and a clear hierarchy: instrument readouts (large, confident) → labels (small, quiet, tracked-out caps) → body/notes (calm). Right now labels lean on letter-spacing + low-contrast greys; that instinct is good — make it *systematic*.
- Set numerals with intent: consistent decimal alignment, considered use of super/subscript units (µs, ppm, °C), and unit labels that recede so the value leads.

## 8. Colour & materiality

A dark **instrument** palette, with a genuine light mode (it exists — honour both).

- Foundations: true near-black insets for the LED boards; layered near-blacks/greys for panels, strips, and lines so depth comes from *value*, not ornament.
- **One signal accent — the LED red** — used with discipline: the clock, active/locked states, the current selection. Scarcity is what gives it meaning. Add a second, cooler accent only if a real semantic need appears (e.g., a "locked/GPS-good" vs "acquiring" distinction), never for variety.
- Everything themeable through CSS custom properties (`--led`, `--led-dim`, `--led-glow`, `--inset`, panel/line/text tiers). A palette change should ripple through the whole instrument from the tokens — including the SVG clock.
- Materiality via light and precision, not texture: hairline separators, considered inner shadows on the LED wells, the faintest vignette. If it looks "designed," it's too much.

## 9. Layout, grid & information architecture

Ten rooms: Connect · Display · Satellites · Signal · Position · Timing · Globe · Weather · Monitor · Export. The docked clock lives in the header when you leave Display and returns when you come back — *one clock, one home*.

- Impose a **single, strict spatial grid** and a consistent panel language (header strip, body, footer note). Today the panels are close — make the rhythm *exact*: identical gutters, identical strip heights, aligned baselines across columns.
- **Hierarchy per room:** one primary object (the sky plot, the phase chart, the globe), supporting readouts, then controls — in that order of visual weight. The eye should always know where to land first.
- Let whitespace do structural work. Precision reads as *space used deliberately*, not space filled.
- Responsive with intent: the instrument should feel composed at 1280, generous at 2560 (let the hero clock and primary viz scale up), and coherent when narrow — never merely "reflowed."

## 10. Data visualization

The charts *are* the product for the technical user — hold them to the standard of a great scientific figure (think *The Visual Display of Quantitative Information*, not a BI dashboard).

- Polar sky plot, C/N₀ bars, position scatter/DOP, the PPS phase + oscillator-drift charts, the orthographic globe, ppm-vs-temperature fit. Each should be legible, honestly scaled, and quietly beautiful.
- Restrained grids and axes; data ink maximised; annotations that inform, not clutter. Constellation colours consistent everywhere (GPS/GLONASS/Galileo/BeiDou).
- **The heatmap note:** the current sky heatmap reads too harsh — aim for the macOS app's soft, granular, industrial gradient. Softer falloff, finer steps, background-aware opacity.
- Motion in charts only where it clarifies (a sweep, a new sample landing) — never ambient animation for its own sake.

## 11. Motion

- **Purposeful and physical.** The fold has mass and a hinge; transitions between rooms are quick and certain; the LED behaviors are firmware-true. A little easing goes a long way — nothing bounces, nothing lingers.
- Standby should *fade* like the real clock's brightness ramp (~0.8 s), never hard-cut. Waking fades back to the live time.
- 60 fps, always. Elegance that stutters is not elegance.

## 12. What is sacred (do not break)

- **Firmware-true fidelity:** glyph geometry, display modes, colon animation timing, the fold, the hinge. This app's credibility rests on being *real*.
- **Technical honesty:** where a value can't be known (absolute UTC offset over USB, physical button state), the UI says so plainly. Never fake certainty.
- **Performance and the static-site nature:** it's a single self-contained page; it must stay fast and dependency-free.

## 13. Anti-patterns (please avoid)

- Generic SaaS-dashboard chrome, card shadows-for-the-sake-of-it, rounded-everything, gradient buttons, emoji, playful mascoting.
- Decoration masquerading as data. Gauges that don't measure. Glow that's just glow.
- Inconsistent spacing/sizes, off-grid nudges, "close enough" alignment — the opposite of the whole point.
- More than one accent colour without a semantic reason.

## 14. The bar

Dieter Rams' ten principles. Braun. Leica. Teenage Engineering's restraint and joy in a tool. Apple at its most reductive. A Nagra deck, a HUD, an aerospace instrument panel. **The feeling to chase: you pick it up, and it is obviously, quietly, the most precise thing in the room — and it never had to tell you so.**

---

### Technical notes for the redesign (so the app keeps working)

- The visual design lives in the page markup's **inline styles** + the inlined `<style>` block (from `css/base.css`). Restyle those.
- `{{…}}` tokens are **live data bindings** (DcLite). Keep them intact; restyle *around* them. Don't remove `ref="{{…}}"`, `onClick="{{…}}"`, or `<sc-if>` blocks.
- The clock is **SVG**, coloured entirely from the `--led*` / `--inset` CSS variables — theme it via tokens, don't hand-edit segment nodes.
- Drive **everything** from the token layer at the top of the stylesheet (palette, type scale, spacing, radii, line colours) so the instrument moves as one.
- Both **light and dark** themes must remain first-class.
