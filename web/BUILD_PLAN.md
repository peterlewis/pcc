# PCC Web — Master Build Plan

All key claims confirmed against the actual firmware:
- CDC out is **only** the three `CDC_Copy_Transmit(&nmea[...])` NMEA sites — `displayMode` never reaches USB (SYNC's core finding holds: button index is passively unknowable).
- `CDC_Receive_FS` (usbd_cdc_if.c:268) feeds every RX byte into `rxConfigString()` — the destructive input trap is real; a naive query would risk `nextMode()`.
- `sendDate()` formats `uart2_tx_buffer` each second; `displayMode/countMode/colonMode` are globals (main.c:190) — Tier-2 read-only report is feasible.
- **`$PMTXTS` is genuinely absent** from this firmware (only `data_valid/had_pps/rtc_good` flag primitives exist) — confirming the emulator must synthesize it and the Timing "absent state" is the default.
- ppsts.js constants `LSE_HZ=32768`, `CAL_PERIOD=63`, `phaseMs = subms + (load-systick)/(load+1)` all present as claimed.

Every load-bearing claim across all five design outputs is evidence-backed. I have enough to write the decisive master plan.

---

# PCC Web — Master Build Plan

Lead architect's single, buildable synthesis. Every decision below is backed by files read this session; conflicts between the five inputs are resolved in-line.

---

## 1. Final tech decision: **HYBRID — harvest the logic, throw away the runtime**

**Decision: convert the `.dc.html` prototype's *logic + design* verbatim; rebuild only its ~200-line React/DC runtime as a hand-rolled vanilla base class. Zero framework, zero CDN, ES modules, optional single-dependency (esbuild) build.**

Why, from evidence not preference: the DC runtime is a live-authoring shell, not a shippable substrate — `support.js:1568/1570` hard-load React 18.3.1 from unpkg, `support.js:1048` loads `@babel/standalone` and transpiles the logic block in-browser via `window.Babel.transform` + `new Function`, and `PCC Web.dc.html:13-15` pulls B612 from `fonts.googleapis.com`. Three external network fetches at boot directly violate the hard "static, all logic client-side, offline, GitHub-Pages" constraint. But the *app itself* is framework-agnostic: `class Component extends DCLogic` (`.dc.html:1038`) touches only `state`, `setState`, `this.props`, and `ref()` — no React APIs in any of its ~930 lines of state model, `componentDidMount`, `initEl`, `effectiveMode`, `connInfo`, the 14 `rv*` render-value builders, the fold WAAPI sequence, or the 1 Hz tick. The three sibling modules (`clockface.js`, `sim.js`, `charts.js`) are already clean `export`ed ES modules imported via `Promise.all([import('./clockface.js'),…])` with zero React coupling. So we copy the `Component` body verbatim, swap `extends DCLogic → extends DcLite` (a ~150-line base providing `state/setState/ref/props/forceRender` + a `data-ref/data-bind/data-if/data-on-*` template binder), and convert the 436 uniform `{{…}}` placeholders + 18 `<sc-if>` to `data-*` attributes with a ~60-line build-time transform that **fails loudly on any unmapped placeholder**. This is a convert-prototype for 95% of the surface and a rebuild of only the runtime skin.

---

## 2. File tree + module responsibilities

Ship everything under `web/` (already the groundwork home: has `tokens.css`, `fonts/*.woff2`, the real `js/` serial stack, `globe/` with **local** `globe.gl.min.js` + `earth-day/night.jpg` + `night-sky.png`). Build/copy to `docs/` for Pages.

```
web/
  index.html            — the ONE static entry. Inlines the helmet reset; links css/. Entry
                          overlay is FIRST child (paints first), shell second, panels inline.
                          Shell = converted <x-dc> inner (.dc.html:60–1030) with data-* bindings.
                          <base href="./"> — ALL asset refs relative (Pages sub-path safe).
  css/
    tokens.css          — web/tokens.css (AUDITED, WCAG-checked, dark + [data-theme=light],
                          status/constellation hues, light accent #a81a10) MERGED with the 4
                          face-token extras the helmet added (--face-led/--face-dim/--face-glow,
                          --led-fill) that web/tokens.css lacks. tokens.css is authoritative for
                          shared vars; take ONLY the --face-* extras from the helmet.
    base.css            — helmet reset + scrollbar + range-thumb + :focus-visible outline --led
                          + @keyframes pcc-caret/pcc-in + ::selection (.dc.html:38–58)
                          + @font-face → ../fonts/*.woff2 (LOCAL — NO Google Fonts).
  fonts/                — EXISTS: B612-Regular/Bold, B612Mono-Regular/Bold .woff2.
  js/
    dc-lite.js          — NEW ~150 lines. THE runtime. Base class {state, setState(patch,cb)→
                          microtask render, props, ref(name) callback-cache, mount(root),
                          forceRender()} + template binder. Syncs ONLY the active panel subtree
                          + always-live header per tick (canvases bypass render entirely).
    app-controller.js   — `class Component` body (.dc.html:1038–~1969) VERBATIM, extends DcLite.
                          state model, componentDidMount, initEl, effectiveMode, connInfo,
                          drawChart dispatch, all 14 rv* builders, fold WAAPI, 1 Hz onTick.
                          Owns ONE this.session interface; chooses sim-vs-serial behind it.
    clockface.js        — MERGED (see §risk): EMU datasheet geometry BASE + web/js gems +
                          astronomy import. export createClockFace. Pixel-faithful KYX-1106AS face.
    sim.js              — from Emulator design files/ VERBATIM. createSession + soft-clock engine.
                          EXTENDED with the $PMTXTS synthesiser (§4.9) — emits real wire lines.
    charts.js           — from Emulator design files/ VERBATIM. drawSky/Cn0Elev/Cn0Time/PosScatter/
                          Dop/Continuity/Phase/Stair/PpmTemp/Globe/Gamma + loadLand.
                          EXTENDED with drawAllan/drawHadamard/drawMtieTdev (§4).
    astronomy.js        — EXISTS. subSolarPoint etc. Feeds clockface gems + celestial readouts.
    serial.js           — EXISTS. REAL Web Serial (class Clock extends EventTarget, 115200 8N1,
                          requestPort, isSupported). The .dc.html has ZERO serial. Wired into
                          app-controller as the serial→session adapter (§5, the net-new work).
    firmware.js         — NEW. GitHub loading: releases + raw-source schema + flash links (§6).
    nmea.js, ppsts.js, satpass.js, skytrailstore.js, polar.js, globe.js — EXIST. Real-device
                          parsing / PPS math / IndexedDB pass store / polar+globe renderers.
  globe/                — EXISTS. LOCAL globe.gl.min.js + earth-day/night.jpg + night-sky.png.
  assets/
    land.json           — coastline for charts.js loadLand() (ship locally).
    firmware-snapshot.json — NEW. Build-time snapshot: pinnedSha, configTemplate (raw config.txt),
                          acceptedKeys (scraped from main.c), latestReleaseKnownAtBuild. Offline-safe
                          cold start; GitHub is enhancement-only (§6).
  build.mjs             — NEW. esbuild: {{}}→data-* template compile (fail-loud) + bundle/minify +
                          copy css/fonts/globe/assets → /docs. Writes .nojekyll.
docs/                   — build output = Pages source (main/docs). Pure static, .nojekyll.
```

**Responsibility split:** `dc-lite` = render/bind only. `app-controller` = ALL state + behaviour, and it is the ONLY module that decides sim-vs-serial. `clockface/charts/polar/globe` = pure draw. `sim` = emulator data (+ synthetic $PMTXTS). `serial/nmea/ppsts/satpass/skytrailstore/firmware` = real-device I/O. The controller presents both data paths behind one `this.session`-shaped `.S` interface.

**Archive, do not ship:** `support.js` (DC runtime), `PCC Web.dc.html` (source-of-copy, then archive), old `web/index.html` + `web/app.js` (superseded by app-controller; keep only their import pattern), `web/emulator.html`/`mockup.html`/`pps-demo.html`/`hinge-demo/` (dev harnesses — keep out of `docs/`).

---

## 3. Rooms / features — final IA and dispositions

**IA decision:** ship the prototype's **10 built-and-tested sections** for v1 (`connect/display/satellites/signal/position/timing/globe/weather/monitor/export`, `SECTIONS` at `.dc.html:1113`), but group them in the rail under the brief's **4-room taxonomy** (Display / Sky / Timing / Device) + a **Monitor drawer** + the **Connect top-bar moment**. The rail already groups CONTROL/GNSS/DATA — this is a rail-grouping change, not an architecture change. The 4-room collapse (Satellites/Signal/Position/Globe → **Sky** view-switch; Weather/Text/Countdown → **Display**; Export → **Sky/Display**; Connect → shell top-bar) is deferred to a post-v1 regroup so v1 ships what's tested.

Routing: hash-based. `go(sec)` → `state.section` + `location.hash` + `localStorage['pccweb.section']`. On load: hash > localStorage > `'display'`.

| Room / feature | Disposition |
|---|---|
| **Connect** (top-bar) | PORT via serial.js `Clock.connect/disconnect/reboot`. Web Serial has no port list → single "Connect" button + `getPorts()` one-click reconnect. **DROP** lsof port-killer (no PIDs/signals in browser) → honest "port busy — another app/tab holds it" from `port.open()` rejection, no culprit naming. Drop the fake `cu.usbmodem14201` path → show `getInfo()` VID/PID or `"USB CDC · 115200 8N1"`. Add **State-1 soft-clock** gate for unsupported browsers. |
| **Display** (owner strip / Text / Data sources / Weather / Countdown / Scrolling) | PORT. Owner-arbitration state machine, live 7-seg marquee preview via clockface. Data sources via `fetch()` — **CORS-gated** (new distinct error state the mac never had). **DROP** Bash-command source type (no shell) — say so in UI. Weather via Open-Meteo keyed off live NMEA lat/lon + CORS-friendly reverse-geocode. Countdown/Scrolling PORT verbatim (scrolling stays honestly "app-side, not saved to clock"). |
| **Sky** (Polar / Map / Globe / Signal QC / Position / Info rail / Insights) | Most web-ready room; modules already exist (polar.js, globe.js, skytrailstore.js IndexedDB pass store, charts.js). Recording is app-global, survives nav. Export → Blob+objectURL (CSV/JSON/GPX/NMEA). Globe already globe.gl terminator earth with **LOCAL** textures. **DROP** on-device-LLM Insights (`FoundationModels`) → render the deterministic STATS themselves (coverage %, blocked quadrants, median peak SNR, %≥30°/≥60°, 24h-vs-week deltas) from existing skytrailstore aggregates, gated on data-sufficiency. |
| **Timing** (NEW — §4) | Full build. $PMTXTS via ppsts.js. **Default state is the "absent" explainer** — $PMTXTS is NOT in shipping firmware (verified), so most users see State-3 first (design it FIRST). New Allan/Hadamard/MTIE/TDEV/phase-drift analytics + temp-comp wizard + holdover ledger. |
| **Timing — serve onward (NTP)** | **DROP HARD** the in-app UDP NTP server + test-query (browsers cannot bind/serve UDP or open raw sockets). Replace with the shipped host-side chrony bridge (`chrony-bridge/launchd/is.peterlew.pcc.chrony-bridge.plist`, confirmed present) as a setup+status card, plus the pure-math GPS-vs-host offset readout. State the drop loudly. |
| **Device — Brightness** | PORT the 5-point curve editor (canvas drag + neighbour clamping + factory presets + user presets in localStorage + Apply=serial / Save=config.txt via File System Access). **DEFER** the 3-D SceneKit surface (optional per brief; disproportionate WebGL effort). |
| **Device — Modes + Astro** | PORT verbatim. Each toggle = `KEY = 1|0` serial send; Save = config.txt write. Emulator previews all modes + 6 colon animations live on the docked face. Astro modes = pure astronomy.js math + config keys; keep extensible (MEMORY flags LST/solar/sundial as deferred). |
| **Device — Advanced** | PORT. IANA tz via `Intl.supportedValuesOf('timeZone')` (no bundle). Matrix-freq clamp 1000–100000. Tolerance windows. Fake-GPS with the footgun warning. Config-recovery: last-known-good in IndexedDB (replaces host FS backups). |
| **Device — Config editor + write-enable** | PORT via File System Access (Chromium). Global write-enable gate on ALL writes. Raw editor + dirty/revert + whole-file save. Off-Chromium → copy-paste-instructions degrade. |
| **Device — Diagnostics** | PORT verbatim. 7 debug toggles → serial + config; emulator renders displaytest/vbat/satview. |
| **Device — Updates** | PORT via File System Access (read version files, write .bin/tz to CLOCK volume). GitHub releases via CORS-permitted api.github.com. The ONE sanctioned progress indicator. **DROP** auto-eject → "eject manually, then reconnect". |
| **Monitor** (drawer, not a room) | PORT. `NMEA = off\|RMC\|all`, consumer-gating copy, auto-scroll/clear/send, capped session log. Top-bar-toggled drawer over the workspace. |
| **Settings / Docs / menu-bar** | PORT units + theme (localStorage + CSS tokens). Location intentionally ABSENT (GPS is the sole truth). Docs = link out. **DROP** macOS menu-bar (the always-live top-bar 7-seg face is the ambient-clock affordance). |

**Feasibility verdict: ~85% ports cleanly.** True losses (each with honest replacement above): UDP NTP serve/test-query, bash sources, lsof/kill, volume eject, on-device-LLM insights. New cross-cutting constraint: **CORS** on all `fetch()` (REST/weather/geocode) — surface as an explicit error state. All third-party libs (globe.gl/three, world map, earth textures, fonts) are **vendored** — no CDN.

---

## 4. New timing features + key algorithms

Grounded in `web/PPS_TIMESTAMP.md`, `ppsts.js` (constants verified: `LSE_HZ=32768`, `CAL_PERIOD=63`, `phaseMs = subms + (load−systick)/(load+1)`, `centrePhase`, `fitTempCompensation`), and the `pps-*.mjs` files. **Honest-USB rule (non-negotiable):** every metric is firmware-captured AT the pulse edge; the host reconstructs from `subms/systick` so USB framing jitter never touches it. Absolute UTC offset is unrecoverable over USB → show phase **jitter / stability / drift**, **never absolute offset**. All new analytics are differential/statistical.

**Gap handling (applies to all τ-analytics):** build the phase series `x[k] = centrePhase(phaseMs[k]) · 1e-3` (seconds) **per contiguous segment**, split at any `seq` discontinuity or epoch jump > 1 s — never average across a hole (a missing edge is not a zero). Use `seq`, not array index, as the clock. Compute per-segment, combine variances weighted by pair-count, or require a min segment length and annotate gaps.

Already-computed in ppsts.js (reuse, don't reinvent): `phaseMs`, `ppm = calerr·1e6/(LSE_HZ·CAL_PERIOD)`, `centrePhase`, `PpsMonitor.stats()` (rmsJitterUs, pkpkJitterUs, ppm/min/max, sincecal, gaps, badChecksums, lock∈{no-pps|acquiring|locked|unstable} at rms<50µs), and the two fits `fitHseTempco` + `fitTempCompensation`.

New algorithms to add (all JS-buildable; τ₀ = 1 s):

**4.1 Overlapping Allan deviation σy(τ) — THE headline** (log-log, slope identifies noise type, floor is disciplined stability):
```
σ²y(τ) = 1/(2·τ²·(N−2m)) · Σ_{i=0}^{N−2m−1} (x[i+2m] − 2x[i+m] + x[i])² ,  τ = m·τ₀
```
Loop m on an octave/log grid up to `floor((N−1)/2)`; need `N ≥ 2m+1`. Error bars from cheap edf ≈ pairs; flag τ with pairs<10 as dashed/low-confidence. Overlay slope-reference guides + "GPSDO territory" band.

**4.2 Overlapping Hadamard Hσy(τ)** — third-difference, drift-INSENSITIVE (trust it during warm-up):
```
Hσ²y(τ) = 1/(6·τ²·(N−3m)) · Σ (x[i+3m] − 3x[i+2m] + 3x[i+m] − x[i])² ,  N ≥ 3m+1
```

**4.3 MTIE + TDEV (telecom masks — ITU-T G.811/G.8272 PRC credibility):** MTIE(τ) = max peak-to-peak time error over any length-τ window (implement O(N) per m via monotonic-deque sliding max/min so it stays live for N≤3600). TDEV(τ) = τ/√3 · MDEV(τ) from the boxcar-averaged second difference. Overlay the standard MTIE mask → "meets/violates PRC".

**4.4 Phase-drift trend** — fit `x[k]` vs `t=k·τ₀` with linear + parabola (`x = a0 + a1·t + a2·t²`): slope = residual fractional-freq error (×1e9 = ppb), curvature `a2 = ½·drift`, residual RMS = true short-term jitter. **Reuse the existing `det3/solve3` Cramer helper in ppsts.js**; guard det≈0 → fall back to linear.

**4.5 Temp-comp wizard (software TCXO)** — surface existing `fitTempCompensation` + `fitHseTempco` as first-class. Model `ppm(T) = k0 + k1·(T−25) + k2·(T−25)²` (centred at 25, NOT vertex-form). Full parabola only at span ≥15 °C, else line. Gates: ≥30 samples & ≥8 °C spread. Noise floor = `1e6/(LSE_HZ·CAL_PERIOD) ≈ 0.484 ppm` (one calerr step). Turnover vertex = `25 − k1/(2k2)`. **Round-trip check before READY:** re-parse the `toFixed`-serialised line, verify |curve−refit| < 0.5 ppm across [tlo−10, mid, thi+10]. Emit exact `temp_comp = k0,k1,k2` config line + copy button. Firmware apply mapping `e = ppm·32768·32/1e6, CALR = 0x100+round(e) clamp ±255` matches main.c.

**4.6 Holdover ledger** (promote `pps-holdover.mjs`) — each GPS gap logs {duration, phase-jump-on-reacquire, implied ppm, temp}; table + ppm-vs-temp scatter = the direct before/after proof of temp_comp.

**4.7 Lock-quality strip** — state timeline (no-pps/acquiring/locked/unstable) + rmsJitter sparkline + gap/bad-checksum counters + sincecal holdover clock. Greys out Allan while unlocked.

**Room layout:** Allan/Hadamard/MTIE/TDEV τ-plots + phase-drift + lock strip in **Timing**; temp-comp wizard + holdover ledger as a **Holdover/Temp-Comp** sub-view.

**4.9 Emulated $PMTXTS (CRITICAL — 99% of visitors have no device AND no firmware that emits it):** `sim.js` synthesises one physically-plausible wire line per second so every chart is alive and **the same unmodified `parsePMTXTS` path runs** (never bypass it). State: phase x(s), fractional-freq y, die-temp T. (1) T = warm-up ramp 22→38 °C over ~20 min + diurnal + noise → fills the 8–15 °C temp-comp span in a demo. (2) y = white-FM (σ~3e-11, gives τ^−1/2) + random-walk-FM (σ~1e-12, gives τ^+1/2 upturn + Hadamard drift) + temp term `1e-6·(0.12 − 0.31(T−25) − 0.034(T−25)²)` (matches the PPS_TIMESTAMP.md example — so the fit converges to injected truth = built-in self-test). (3) Discipline while locked: `x += y·τ₀; x −= 0.5·x` + white phase jitter σ~1e-8 s → correct τ^−1 white-phase floor (looks like a real GPSDO). (4) Encode back by inverting `phaseMs`: `load=79999`, `systick = round(load·(1−frac))`, `subms = floor(ms)`, `calerr = round(y·LSE_HZ·CAL_PERIOD)` updated as a **staircase once per 63 s**, `temp=round(T)`, `flags=0x7` locked; compute XOR checksum, append `*CC`. (5) Holdover button clears `had_pps` for D s → x free-runs → reacquire phase-jump feeds the ledger. Inject occasional dropped seq + rare bad checksums to exercise segment-splitting + counters.

---

## 5. Non-destructive sync design + firmware addition

**The knowability boundary (verified against firmware):** CDC out is ONLY the three `CDC_Copy_Transmit(&nmea[...])` sites (stm32l4xx_it.c:310/358/366) gated by `nmea_cdc_level`. `displayMode` (main.c:190) is never emitted → **the current button-cycle frame is passively unknowable.** Worse, `CDC_Receive_FS` (usbd_cdc_if.c:268) feeds every RX byte into `rxConfigString()` → the same config parser → writing to "query" would mutate state and could call `nextMode()`. This is the destructive trap.

**Two-tier design, honest about that boundary:**

**Tier 1 — passive mirror (ship now, zero firmware risk, the default).** The **TIME row is always safe** — it's the live GPS-disciplined time, independent of displayMode; drive it from forwarded NMEA (RMC/GGA) + local interpolation, applying `colon_mode` + tolerance-driven digit-hiding from config.txt. The **DATE row** renders from config.txt's *enabled* MODE_* set (first-enabled default, optional emulator-side auto-cycle preview honouring `astro_page_ms`). UI states explicitly: *"modes your clock is configured to show,"* not the live button position. 100% non-destructive: only READS config.txt (File System Access) and LISTENS to NMEA; writes nothing to CDC.

**Tier 2 — read-only status report (opt-in, exact fidelity, tiny firmware addition).** Since we own the firmware, add ONE CDC command that formats `$PCCST,<displayMode>,<countMode>,<colonMode>,<nmea_cdc_level>,"<10-char frame from uart2_tx_buffer[1..10]>"*CC` and `CDC_Transmit_FS`'s it at ~1 Hz (or on demand). **Discipline (mandatory):** it MUST live entirely on the read path — read globals, format, transmit — and must **NOT** flow through `rxConfigString→parseConfigString→nextMode/requestMode/latch`. `sendDate()` already computes the exact 10-char payload into `uart2_tx_buffer` every second, so the report copies an already-computed buffer + reads globals; it cannot change the LEDs. Gated behind a new `status_report=on` config key so **old firmware simply no-ops** the unknown key → graceful degrade to Tier 1. This gives the emulator the EXACT current frame + button index including astro sub-pages.

**Net promise:** exact mirroring only where the hardware can honestly provide it — time row always; date-row frame exactly with the Tier-2 report, config-derived approximation otherwise.

---

## 6. GitHub-loading design (`js/firmware.js`)

CORS verified live this session (per the GITHUB input): three tiers, distinction is load-bearing.

- **(A) api.github.com — WORKS** (`access-control-allow-origin: *`, 60/hr per IP unauthenticated). Use for `/repos/mitxela/clock4/releases/latest`, `/releases`, `/commits/master`. Fork `peterlewis/clock4` has zero releases → releases always from `mitxela/clock4`. Owner/repo as a swappable const.
- **(B) raw.githubusercontent.com — WORKS** (`ACAO: *`, separate CDN, effectively unlimited, NOT counted against the 60/hr core). Fetch `qspi/config.txt` (self-documenting schema: comments→tooltips, `KEY=value`→fields, ranges from comment prose, `##` headers→sections, enum comments→dropdowns) and `mk4-time/Core/Src/main.c` (scrape `parseConfigString` `strcasecmp` key literals = authoritative accepted-key list + on/off synonyms). Point at fork branches for $PMTXTS/astro/gems keys. This drives emulator + config-editor fidelity from upstream — add a mode upstream, it lights up with no redeploy.
- **(C) Release BINARIES — NEVER fetch()** (final host `release-assets.githubusercontent.com` returns NO ACAO → CORS-blocked). Offer as `<a download href=browser_download_url target=_blank>` navigations (not subject to CORS) + rendered flash instructions from `qspi/qspi.md`.

Three async functions: `getLatestRelease()`, `getUpstreamSchema(ref)`, `getFlashLinks()`. Rate-limit mitigations: localStorage cache + `If-None-Match` ETag (304s cheap), prefer raw@pinned-sha, optional read-only PAT field (lifts to 5000/hr, never required).

**Offline-first (§7 caching):** `assets/firmware-snapshot.json` baked at build = `{pinnedSha, configTemplate, acceptedKeys, latestReleaseKnownAtBuild}`. App renders from snapshot instantly at 0 API calls, then background-revalidates against raw@master; if SHA moved, show a subtle "schema updated upstream" nudge. Every network path degrades to the snapshot with a quiet inline note ("showing bundled data, GitHub rate-limited — resets in N min" from `x-ratelimit-reset`). Never a blocking error, never an empty room.

Updates room UI: latest tag + date + fwt/fwd/tz versions parsed from release body + rendered changelog; if a clock is connected, running build string beside it with a match/mismatch chip. Primary "Get firmware files" (download links) + rendered flash instructions.

---

## 7. GitHub Pages deploy

- **Source = `main` branch, `/docs` folder** (Pages only allows `/` or `/docs`, not `/web`). Author in `web/`, `node web/build.mjs` outputs to `docs/`.
- **`web/build.mjs` (esbuild, single dev dependency):** (a) the one-time `{{}}`→`data-*` template compile that **fails loudly on any unmapped placeholder** + asserts `renderVals()` key-set == bound-attr set; (b) bundle/minify JS; (c) copy css/fonts/globe/assets. Zero-build alternative: author the shell with `data-*` directly and `cp -r` — but recommend the compile step for the fail-loud safety net.
- **Base path:** project Pages serve under `/<repo>/` → ALL refs RELATIVE (`./js/…`, `./css/…`, `./assets/land.json`). Dynamic imports already use `./` form. Add `<base href="./">`. A `<user>.github.io` repo or CNAME removes the sub-path.
- **`.nojekyll` in `docs/`** so Jekyll doesn't mangle `js/` or underscore paths.
- **Fully self-contained:** React/Babel/Google-Fonts removed → every asset same-origin. Optional service worker (cache-first shell + snapshot, stale-while-revalidate for raw.githubusercontent; never SW-cache api.github.com — respect rate limit via localStorage+ETag; never cache CORS-opaque binaries) for true offline PWA — nice-to-have.

---

## 8. Phased build order (each phase independently shippable + browser-verifiable)

**Phase 1 — Shell + entry + emulator (world-class on screen FAST).** Build `dc-lite.js`; convert the `<x-dc>` inner template + helmet CSS into `index.html` + `css/`; wire `@font-face` to local woff2; drop in `sim.js` + the **merged** `clockface.js` (do the EMU-geometry-base + gems-port merge here — §risk); copy the `Component` body into `app-controller.js` as `extends DcLite`; run the two-stage fold WAAPI + docked top-bar face + 1 Hz tick. **Verify:** entry overlay paints first, fold animates, live emulated LED clock renders pixel-faithfully, one panel visible at a time, theme toggle works, zero network requests in devtools. This is the "world-class fast" deliverable.

**Phase 2 — All emulator rooms (the full 10-section soft-clock).** Wire the remaining `rv*` builders + `charts.js` (sky/cn0/pos/dop/globe) + `polar.js`/`globe.js` (local textures) + Display/Modes/Diagnostics/Brightness-curve previews. Everything runs off `sim.js`. **Verify:** every section renders and interacts on emulated data; globe terminator earth shows with no CDN fetch; brightness curve drags + clamps.

**Phase 3 — Timing + the new mathematics.** Extend `sim.js` with the $PMTXTS synthesiser (§4.9); add `oadev/hadamard/mtie/tdev/phase-drift` to `charts.js`; wire ppsts.js metrics + temp-comp wizard + holdover ledger. **Verify:** Allan curve shows textbook GPSDO shape, Hadamard overlays drift-free, temp-comp parabola's fitted k's ≈ injected k's (the built-in self-test), holdover button produces a ledger entry. Design the **absent-state (State-3) explainer FIRST** — it's the default for real users until firmware ships.

**Phase 4 — Real Web Serial (the one genuine net-new module).** Build the `serial.js`+`nmea.js` → session adapter presenting sim's `.S` shape; the §5.2 connect handshake (connLed, locked/acq/nofix, snap ms host-guess→GPS); Monitor drawer over the raw line stream. **Verify:** on a real device (or a serial loopback feeding canned NMEA) the app swaps from sim to live data, time row mirrors, no-fix/fix states transition.

**Phase 5 — File System Access (config + flash).** Directory-handle acquisition + IndexedDB persistence + permission states; write-enable gate; config.txt read/edit/write; last-known-good backup; Updates file-copy + "eject manually" copy. Off-Chromium → copy-paste-instructions degrade. **Verify (Chromium):** grant volume, edit a key, whole-file save, restore-from-last-good.

**Phase 6 — GitHub loading + Tier-2 sync + deploy.** `firmware.js` (releases + raw-schema + flash links + snapshot); the `$PCCST` Tier-2 firmware read-only report + parser (if the firmware branch is flashed); `build.mjs`; `docs/` + `.nojekyll`; ship to Pages. **Verify:** Updates room renders from snapshot at 0 API calls then revalidates; rate-limit note appears when throttled; deployed Pages URL loads fully offline-capable with all-relative assets.

---

## Cross-cutting risks (mitigations baked into the phases above)

1. **Clockface divergence (highest — 187 changed lines, verified).** Neither file is a superset: EMU has correct KYX-1106AS datasheet geometry (`14.0 W × 25.4 H mm, aspect 0.551, 10° italic, miter 0.0149`), web/js has stale "tuned to photo, NOT in CAD" geometry BUT the gems (`larson`/`terminator`) + `import { subSolarPoint }`. **Merge in Phase 1:** EMU as base, port the gem render modes + astronomy import (both share LUT_DATE/LUT_TIME + the createClockFace signature → additive). Visual-diff against EMULATOR_SPEC.md + a device photo. Ship neither file unmodified.
2. **Template-compile fidelity (436 `{{}}` + 18 `<sc-if>`).** Compiler fails loudly on any unmapped placeholder; boot-time assert `renderVals()` keys == bound attrs.
3. **Real serial is 100% unbuilt** (0 refs verified). Budget Phase 4 as net-new, not conversion.
4. **1 Hz full-map rebuild.** dc-lite syncs only the active panel subtree + live header; canvases bypass render.
5. **Pages `/web` constraint** → build to `/docs` + `.nojekyll` + relative paths.
6. **Runtime fetches must be same-origin** (loadLand, globe textures) — vendored locally (confirmed present).
7. **Fonts** → local `@font-face`, delete Google Fonts link (else FOUT).
8. **$PMTXTS + Tier-2 both require an unmerged firmware branch** — design the absent-state as default; both degrade gracefully.

**Key files for the implementing engineer:** `/Users/peter/Developer/ML/Claude/pcc/Emulator design files/PCC Web.dc.html` (copy the `Component` body verbatim, lines ~1038–1969), `/Users/peter/Developer/ML/Claude/pcc/Emulator design files/BUILD_NOTES.md` (render/fold/props contract), `/Users/peter/Developer/ML/Claude/pcc/web/js/clockface.js` + `/Users/peter/Developer/ML/Claude/pcc/Emulator design files/clockface.js` (the merge inputs), `/Users/peter/Developer/ML/Claude/pcc/web/js/ppsts.js` (timing math + constants), `/Users/peter/Developer/ML/Claude/pcc/web/js/serial.js` (real Web Serial adapter), `/Users/peter/Developer/ML/Claude/pcc/web/tokens.css` (authoritative tokens), `/Users/peter/Developer/ML/Claude/pcc/clock4/mk4-time/Core/Src/main.c` + `stm32l4xx_it.c` + `USB_DEVICE/App/usbd_cdc_if.c` (firmware sync/emit facts).