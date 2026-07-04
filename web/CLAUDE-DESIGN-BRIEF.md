# Precision Clock Companion — design brief

**For:** Claude Design. **From:** the PCC project. **Scope:** the complete web companion for mitxela's Precision Clock Mk IV. Self-contained — the prior `DESIGN_BRIEF.md` is historical and superseded in full; everything that survives from it is restated here. Assets listed at the end.

---

## 1. The product, in one paragraph

The Mk IV is a GPS-disciplined desk clock: two rows of red seven-segment LEDs — time and date — displaying milliseconds that are *actually true*, folded together by a two-pin hinge into a compact block that unfolds into a single long bar. The companion is its software half: a browser app (Web Serial, no install) that mirrors the display, drives what it shows, records and visualises the GNSS sky it sees, exposes its timing performance, and manages its configuration. It must read as **an extension of the device, not a generic web dashboard**. The owner is a tinkerer, ham, or timing enthusiast: **they are not put off by density; they are put off by toy UI.** Restraint is the brief.

## 2. The object is the design language

Every visual decision derives from the physical device:

- **The display**: red LED seven-segment digits behind smoked acrylic. Digit cell ≈ 34.2 mm tall × 12 mm column, colon = two 3.15 mm dots 11.3 mm apart — proportions locked, from the manufacturer's CAD; the emulator already renders them faithfully.
- **The chassis**: laser-cut 3 mm smoked acrylic over black PCBs, white Delrin hinge leaves, visible machine screws. Hairlines, flat planes, honest fasteners. No soft shadows exist on this object; none belong in its app.
- **The fold**: the signature mechanism (§3) — the app's entry interaction and structural spine.
- **One accent**: LED red. It is the brand and the live-data colour, nothing else. GNSS status gets reserved hues (§7) so "no fix" never reads as brand.
- **When in doubt, derive from this device's measurements, not from the instrument-UI genre** — the genre is now a SaaS aesthetic too, and the acceptance test (§10) applies to it.

## 3. The entry — the clock opens on its real hinge *(mechanism locked; honour verbatim)*

Traced from the manufacturer's cut files; the attached `fold.gif` is the reference.

The clock's desk state is **folded** — date row stacked above the time row, a two-pin hinge link on the **left edge**. Opening is a **two-stage planar fold, entirely in the face plane**; the **time half never moves**:

1. **Stage 1**: the date half swings **90° counter-clockwise** about the **upper pin** (left-edge hinge column, just above the row seam).
2. **Stage 2**: the **hinge link itself carries it a further 90°** about the **lower pin** (just below the seam, 12 mm from the first). The date half lands to the **left**, 180°-rotated, coplanar: one long bar — **date | hinge | time**.

- **On load:** the folded clock, centred, large, both rows live-ticking (host/NTP time when no device — the app is a faithful soft clock in its own right). It reads as the object on a desk.
- **Affordance:** a restrained hairline prompt / cursor change. No bouncy "click me" pulse.
- **On click:** the two-beat unfold — sequential, both CCW, the second beat carrying the first — into the extended bar, which **docks as the persistent top bar**. The long bar *is* the natural header shape: **the fold literally produces the app's chrome.** Motion character: mechanical and precise, not soft, springy, or bouncy. **This is an instrument.** (The mechanism's implementation notes — pivot coordinates, transform strategy — ship in the attachments; the two beats and their character are the design contract.)
- **Reversible:** clicking the docked face folds the workspace away to a full-screen clock, and back.
- **Reduced motion:** instant cut between states.

Not a single-pivot lift; not a clapperboard; any prior art showing the time half lifting is superseded and wrong.

## 4. The shell

After the fold:

- **Top bar = the unfolded clock.** The live seven-segment face, then the connection block: state LED + port + `115200 8N1`, GNSS fix state (lock / acquiring / none — always with a text label), and, when timing data flows, the headline jitter figure. It never leaves and it is always live.
- **Connection is a shell-level moment, not a menu item.** With no device, the top bar's connection block *is* the call to action; one click requests the port (Web Serial) and the handshake plays out in the face itself (§8.2). Device management (reconnect, reboot, errors) lives in §5.4 — but first contact belongs to the shell.
- **Left rail, four rooms**: **Display** · **Sky** · **Timing** · **Device**. Rail rows carry status dots: which feature owns the display, red while sky-recording, green when the time bridge is confirmed.
- **Monitor is a console drawer**, not a room — toggled from the top bar, sliding up over the workspace: the raw NMEA stream belongs at arm's reach, not at rail rank.
- **Main area**: one panel at a time, panel-strip headers, hairline-divided sections. Density like a good instrument: every pixel earning its place, generous *alignment* rather than generous whitespace. Sky views may go full-bleed within the shell; the top bar never leaves.

**Panel-strip header, defined** (carried from the prior kit): a `--strip` bar carrying a 10 px uppercase micro-label, optional right-aligned status. The component kit also carries forward: dense readout tables, segmented controls, square LED indicators, signal bars — all restated by the deliverables, none decorative.

## 5. The rooms — complete component inventory

This is the full surface of the shipping desktop app plus the timing features it never had; anything dropped is dropped *out loud, with the reason*. Layout within each room is the designer's craft; the contents are the contract.

### 5.1 Display
The single place that answers "what is the date row showing and why".

- **Owner strip** (always visible here): which source currently owns the display — Modes cycle / Text / Data source / Weather / Countdown — with one-click Resume/Release. The desktop app buried contention in per-panel banners; elevate it to first-class arbitration.
- **Text**: input with live `N/10` counter (over-length flips to an orange scroll indicator), send, last-10 recents (resendable, clearable). **Every device-bound string in this app previews on a mini seven-segment strip, never in a system font** — what the user sees is what the LEDs will make, approximate glyphs and all.
- **Data sources**: REST sources rotated onto the display (name, live 7-seg value, error state, enabled, poll 30 s–30 m; delete with confirm); editor with URL, dot-path JSON key, headers (held in session memory by default — persisting them is opt-in and labelled plainly as local plaintext), display format with `{v}`, test-now with over-length/rate-limit feedback; rotation interval (5 s–5 m) when >1 enabled. *(The desktop app's shell-command source type is impossible in a browser and is dropped — the UI says so.)*
- **Weather**: GPS-fix-driven only (no location setting — the clock knows where it is); place name over mono coords; temp/condition/wind/humidity; display-format picker with 7-seg preview; poll 2–30 m; refresh; stale-data state.
- **Countdown**: future datetime picker, UTC ISO preview, start/stop, active indicator.
- **Scrolling**: the four firmware-defined marquee speeds; changing speed retimes an in-flight scroll without resetting its position.

### 5.2 Sky
The flagship. Three renderers over one recorded dataset.

- **Header**: Record/Stop (red dot; recording is app-global and survives navigation), Clear (confirm with exact counts), duration + volume summary ("2d 5h · 259 passes · 107.2K obs"), **Export** (CSV / JSON / GPX / raw NMEA, plus the compact native pass format for round-tripping) — the data is the owner's; a browser that records 100K observations it can't give back would betray §9's trust model — and Insights.
- **View switch**: **Polar / Map / Globe** (persisted) · **time window** (Live → All; trims observations within passes) · **retention** (1 h → ∞; shrinking prompts with the exact deletion count) · **overlay toggles** (satellites · sun/moon · labels · SNR heatmap · smooth trails — persisted per view).
- **Polar**: the classic az/el instrument plot — live satellites, recorded trails, constellation-coloured, elevation rings; sun and moon tracks.
- **Map**: flat world map (muted, no POIs), pass ground-tracks bucketed by constellation × age tier at stepped alphas, live satellite dots (ringed when tracked), sun/moon markers; never fights user pan/zoom.
- **Globe**: the beauty shot — WebGL earth, **day/night textures blended at the live solar terminator**, star field, atmosphere; live satellites as glowing altitude-scaled dots, recorded passes as translucent ribbons, live ones pulsing. This exists and is already web-native; preserve its visual signature exactly.
- **Signal QC**: the SNR heatmap (az/el sectors, colour ramp per theme) as an overlay plus two chart views — **C/N₀ vs elevation** and **per-satellite C/N₀ over time** — and the live per-satellite signal-bar strip. This is how an owner sites an antenna; it is measurement, not decoration.
- **Position**: for a *stationary* clock the honest precision figure — fix scatter with CEP/2DRMS rings, DOP history.
- **Info rail** (all views): coordinates (mono, 4 dp) + altitude, **Maidenhead grid square**, fix type (GPS/DGPS/RTK) with an HDOP quality badge, fix age, sats used per constellation with the constellation colours (charts/legends only, never UI chrome), and the celestial readouts — sun/moon rise·noon·set, golden hour, equation of time, moon phase + illumination — which also serve the device's astro display modes (§5.4).
- **Insights**: deterministic reports — antenna-siting from the horizon mask (coverage %, blocked quadrants), per-constellation quality (median peak SNR, duration, % ≥30°/≥60°), 24 h-vs-week trends. Each gated on data sufficiency with honest disabled-reasons (site: ≥12 filled sectors · quality: ≥6 passes · trends: ≥36 h). *(The desktop app ran a local LLM over these stats; the web version renders the stats themselves — reproducible beats generated.)*

### 5.3 Timing
New territory — the soul of the device, and the payoff room. **Design the absent state first** (§6, state 3): this room lights up only when the firmware streams its per-pulse timing sentence; without it, a quiet factual explainer, and everything else still works.

- **Headline**: phase jitter **RMS (1σ) and peak-to-peak, in µs** — the number the owner brags about. Big, mono, live.
- **Phase strip chart**: sub-second phase error at each GPS pulse, centred, with gap markers on missed pulses and a bad-checksum counter.
- **Discipline row**: oscillator error in **ppm** — drawn honestly as the *staircase* it is (the firmware recalibrates in discrete windows) — die temperature (sparkline), holdover age since last calibration, and a lock-quality chip (no-PPS / acquiring / locked / unstable).
- **Temperature characterisation**: the guided holdover workflow — record across a temperature swing, fit, review (turnover °C, residual rms, ppm-vs-temp scatter with the fitted curve), apply to the device. Gated with honest blockers ("needs ≥30 samples · ≥8 °C spread — keep logging").
- **System clock**: GPS-vs-host offset (±ms, colour-stepped), 1 Hz — works from plain NMEA, so this row is live whenever connected.
- **Honesty rule, as UI copy**: metrics are captured *in firmware at the pulse edge*, so USB jitter never touches them — but absolute UTC offset is unrecoverable over USB. This room shows **jitter, stability, drift — never an absolute offset claim.**
- **Serve time onward**: a browser cannot bind UDP — no NTP serving, and we don't pretend. Status card for the shipped host-side **chrony bridge** with copy-paste setup, and a confirmed-running read-out.

### 5.4 Device
The management room. Sub-structure is the designer's call — these are contents, not a mandated stack:

- **Connection management**: port status + last error (including a **port-busy** state when the OS has the port held elsewhere — the browser can't name the culprit; the desktop app's process-killer is dropped), reconnect, **Reboot clock** (auto-reconnects), unsupported-browser state (§6, state 1).
- **Brightness**: manual lock + live slider; **the 5-point curve editor** — direct-manipulation canvas mapping sensor input → LED output on a 4096² grid, draggable points with neighbour clamping, dashed linear reference, numeric fields with per-point send, factory presets (Rev C ×2, Rev D) and named user presets (save-as / load / delete), Apply (live) vs Save (persist) vs Revert vs Undo-save. Treat it like a synth's envelope editor, not a form. *(The desktop app's 3-D curve-morphing flourish is optional here — port it or drop it, designer's call.)*
- **Modes**: the firmware's display modes, grouped as the firmware groups them — Time (ISO 8601, Unix, UTC offset, TZ name) · Date (ordinal, ISO week, Julian, modified JD) · Weekday (×3, with the honest "M and W render poorly" note) · **Astro** (sun rise/set/noon, sun az/el, moon, grid square, lat/lon — the paged modes cycle their sub-screens on the date row at a configurable dwell while the time row keeps running; preview the paging live on the top-bar face) · **colon animation** (six firmware modes, previewed live on the face) · Standby. Apply/Revert/Save/Undo-save semantics identical to Brightness.
- **Advanced**: timezone override (searchable IANA list), matrix refresh frequency (clamped), the three accuracy-tolerance windows (digit-hiding on fix loss), fake GPS position — with its footgun stated: *setting it also pins the clock's position; live GPS updates are ignored* — and the config-recovery flow when the device reports a parse failure.
- **Config file**: writes go to the device's own `config.txt` on its USB volume (File System Access, Chromium; degrade to instructions elsewhere). A **write-enable safety toggle** gates all writes; visible Saved/Undo confirmations; a raw monospaced editor (dirty indicator, revert) for the whole file; explicit not-mounted / permission-needed states. The newer firmware keys (astro modes, paging dwell, per-pulse timing, temperature compensation) are first-class toggles alongside the classics.
- **Diagnostics**: the seven firmware debug toggles, one tight grid.
- **Updates**: installed firmware/TZ versions read from the mounted volume, latest GitHub release check, install with progress; the browser cannot eject — the UI says so and instructs.
- **Manual**: link out to the manufacturer's documentation.
- **Settings**: units (°C/°F; wind mph/km/h/m/s/kn); **theme follows the system by default, manual override here**. Location is intentionally absent — the GPS fix is the single source of truth.

### 5.5 Monitor (drawer)
NMEA stream selector (Off / RMC / All — disabled with a named-consumer note when Sky/Timing hold the stream), auto-scroll, clear, monospaced log (capped), session-only.

## 6. States — the ladder is canonical; rooms cross-reference it

1. **No Web Serial** (Safari/Firefox): the soft clock — full emulator face, all modes and colon animations, optional demo sky. Beautiful and honest; never a broken page.
2. **Connected, no fix**: face live, GNSS status acquiring/none (labelled, never hue-only), Sky shows live acquisition, Timing shows system-offset only.
3. **Fix, no timing sentence**: everything except Timing's analytics; one factual sentence explains why.
4. **Full**: everything live.

**Loading convention**: nothing skeletal, nothing spins for show. Panels render instantly with their absent-state copy; charts backfill silently as data arrives; the only progress indicator in the product is the firmware installer. First paint *is* the fold hero, already ticking.

Micro-states carried from the desktop app: display contention (owner strip), recording-in-background, device-removed / rebooting / auto-reconnecting, config parse failure, stale weather, rate-limited source, port-busy.

## 7. Design system — **rules locked, values are a baseline**

The rules, non-negotiable:

- **One accent**: LED red is brand + live data, and nothing else.
- **GNSS status is never hue-only** — always paired with a text label; status hues are reserved and are *not* the brand red, so no-fix never reads as brand.
- **The LED face is always a dark screen — even in light mode. Displays are never light.**
- **Light mode is a grey lab enclosure, not white.**
- **Ghost segments** (`--led-dim`) are decorative only, never text; the LED glow is the one sanctioned glow.
- Every colour pairing passes the same WCAG audit the baseline passed.

The baseline values (working, audited — you own the values, we own the rules; a replacement palette must pass the same audit): the full dark + light token tables, including the light-mode accent (a darkened red — the LED red fails contrast on light surfaces), status and constellation hues for both themes, ship as `tokens.css` in the attachments. Headline dark values for orientation: bg `#08090b` · panel `#0e0f13` · text `#c9cdd5` · LED `#ff3b2e` · lock/acq/none `#36c98b`/`#f5b53d`/`#ff6a3d` · constellations GPS `#3b9bff` · GLONASS `#ff5247` · Galileo `#ffa726` · BeiDou `#5fd0ff`.

**Type**: **B612 + B612 Mono** (the aircraft-cockpit family; OFL, bundled, weights 400/700, scale 10/12/13/15 px) is the audited baseline and default. Propose a replacement only if it keeps tabular figures, offline bundling, and instrument character — and re-audits. Seven-segment rendering is *only* ever the emulator; never a novelty display font in UI chrome.

**Space**: 4 px base grid; hairline (`1px`) dividers as the primary structural device; shell caps at ~1680 px with dense text panels at ~1100 px measure; Sky full-bleed allowed.

**Motion**: mechanical, linear-or-near easing, short. The fold is the only theatrical moment in the product; it spends the entire motion budget. Everything else ≤150 ms, no bounce, no parallax. `prefers-reduced-motion` respected globally.

## 8. Signature interactions (spend the craft here)

1. **The fold** (§3) — entry, dock, and the reverse fold to full-screen clock.
2. **The handshake** — the moment the soft clock stops simulating and *becomes* the device: port granted, the top-bar LED flips, and the face's milliseconds snap from host guess to GPS truth. It happens every session; it is the product's premise made visible. Design the snap.
3. **The live terminator globe** — the screenshot people share.
4. **Seven-segment previews everywhere** — device-bound text always shown as the LEDs will render it. Systemic, not a set-piece.
5. **The jitter headline** — a live µs figure that quietly proves the whole premise.

Craft moments (not signatures, still worth love): the brightness curve editor; colon animations previewing live on the docked face; the retention prompt telling you exactly what it will delete.

## 9. Non-goals

No accounts, no cloud, no telemetry: the serial cable is the whole trust model — which is exactly why the owner's recorded data must always export (§5.2). **One clock, by design** — multi-port juggling is out of scope. No shell-command data sources (impossible in-browser; dropped, not hidden). No in-browser NTP serving (impossible; the chrony bridge is the honest path). No CPU/firmware emulation — the emulator renders visible output faithfully, nothing deeper. No mobile-first layout: desktop-window down to ~900 px.

## 10. Deliverables

1. High-fidelity designs of each room (§5) plus the Monitor drawer, dark and light.
2. The shell + fold entry + handshake resolved (motion notes: timing, easing, the two beats, dock, snap).
3. Component kit with states (§6 ladder + micro-states) on the token rules (§7).
4. The three Sky renderers at panel and full-bleed sizes, including the Signal QC and Position views.
5. Timing room: full and absent states; the temperature-characterisation flow.
6. Responsive behaviour ~1680 → ~900 px.

**Acceptance test, applied to every screen: could this be any SaaS product? If yes, it's wrong. Does it look like it shipped with a precision instrument? If yes, it's right.**

## Glossary (the five terms a designer will actually hit)

- **NMEA** — the GPS receiver's text protocol; one line per reading, e.g. `$GPGGA,120044,5128.94,N,00003.61,W,1,08,1.1,46.2,M…`. The Monitor drawer shows this stream raw.
- **HDOP** — horizontal dilution of precision; fix-quality number, lower is better (≈0.8 ideal, >5 poor). Drives the quality badge.
- **az/el** — azimuth (compass bearing, 0–360°) and elevation (angle above horizon, 0–90°) — a satellite's position in the local sky; the polar plot's two axes.
- **C/N₀ (≈SNR)** — signal strength per satellite, in dB-Hz; ~45 is strong, <30 weak. The signal bars and heatmap show it.
- **Horizon mask** — which compass directions/elevations have sky vs obstruction, learned from recorded passes; the antenna-siting insight visualises it as filled/blocked sectors.
- **TTFF** — time to first fix after power-on.
- **Maidenhead grid** — the ham-radio location code (e.g. `IO91wm`) derived from coordinates.

## Attachments

- `hinge-demo/fold.gif`, `closed.png`, `half.png`, `open.png` — the verified fold (plus `hinge-demo/README.md`: mechanism numbers and implementation notes).
- `EMULATOR_SPEC.md` — seven-segment face fidelity rules (geometry, glyphs, colon animations).
- `PPS_TIMESTAMP.md` — the per-pulse timing sentence and every derived metric in §5.3.
- `tokens.css` — the complete audited dark + light token tables (§7 baseline).
- `DESIGN_BRIEF.md` — historical, superseded in full by this document.
