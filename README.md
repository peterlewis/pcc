# Precision Clock Companion

A browser app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). It drives a real clock over Web Serial — display modes, text and countdowns, brightness curves, satellite views, timing analysis — and with no clock attached it *is* one: the on-screen clock is the actual `clock4` firmware compiled to WebAssembly, not an imitation of it.

### **[▶ Open Precision Clock Companion (Beta) →](https://peterlewis.github.io/pcc/)**

> [!NOTE]
> Independent, community-built. Not affiliated with mitxela.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Deploys from CI](https://img.shields.io/badge/deploy-GitHub%20Pages%20(CI)-blue) ![Web Serial](https://img.shields.io/badge/Web%20Serial-Chromium-orange)

## The clock face is the real firmware

The C source that flashes to the physical clock is compiled to WASM at build time (from the [`clock4`](https://github.com/mitxela/clock4) submodule) and runs in the page — real NMEA parsing, real PPS discipline, real display latching. The build is the [`rollup`](https://github.com/peterlewis/clock4/tree/rollup) branch (0.0.5+): mitxela's released 0.0.4 plus a nine-PR draft stack, each opened against upstream —

- [#5 $PMTXTS timing telemetry](https://github.com/mitxela/clock4/pull/5) · [#6 astro display modes](https://github.com/mitxela/clock4/pull/6) · [#7 hardening fixes](https://github.com/mitxela/clock4/pull/7) · [#8 sidereal & solar time](https://github.com/mitxela/clock4/pull/8) · [#9 self-learning temperature compensation](https://github.com/mitxela/clock4/pull/9)
- [#10 per-segment brightness equalisation](https://github.com/mitxela/clock4/pull/10) · [#11 live Allan deviation](https://github.com/mitxela/clock4/pull/11) · [#12 bright-star transit predictor](https://github.com/mitxela/clock4/pull/12) · [#13 on-device two-button menu](https://github.com/mitxela/clock4/pull/13)

Draft firmware: it runs happily on my own clock, but it isn't upstream yet.

It's verified rather than assumed: 4,511 display checks against independently computed astronomical truth, plus a replay anchor against a physical Mk IV on real GPS data. The DEVICE → UPDATES panel shows the exact commit the running WASM was built from and can check it against GitHub.

## Three states, no fake data

- **Standby** — no clock, no simulation: the face shows your system time and the telemetry stays empty.
- **Simulation** — opt-in and labelled: a virtual GPS (with real satellite positions from live TLEs) feeds the firmware's own reception path, so lock, discipline and holdover all happen in real firmware code.
- **Connected** — a real Mk IV over Web Serial. Its NMEA drives the same firmware renderer and every chart; simulated data is never mixed in.

## What's in it

- **FACE** — every display mode (including live sidereal and apparent-solar time), text with marquee scrolling, countdowns, brightness / gamma / DAC curve editing, colon animations, the significance-fade precision display, observer location, and a timezone engine using the clock's own IANA rules database. Edit and apply `config.txt` through the firmware's real parser.
- **SKY** — polar az/el plot with signal heatmap, horizon mask and age-faded trails; a flat world map and an orthographic globe with satellites at their true sub-points and a day/night terminator; C/N₀ and position/DOP analysis; a GPS fix panel. Sky history persists across reloads and exports as CSV / JSON / GPX / NMEA, including a per-satellite history CSV.
- **TIMING** — with the draft firmware streaming `$PMTXTS`: PPS phase with robust (median/MAD) jitter stats, the oscillator drift staircase, and a temperature-compensation fit that emits the firmware's own `tc_*` warm-start config block.
- **DEVICE** — Web Serial connect, config editing, REST data sources that poll and push values onto the date row, recorded-data downloads, firmware provenance and update check, and a raw NMEA serial monitor.

## Run it

- **Hosted:** <https://peterlewis.github.io/pcc/> — open it in any browser. Everything but a live hardware connection works everywhere; to drive a real clock, see [**Connect a real clock**](#connect-a-real-clock).
- **Local dev** — live source, no build step:
  ```bash
  git clone https://github.com/peterlewis/pcc.git
  cd pcc && bash web/serve.sh        # http://localhost:8765
  ```
- **Build the static site** (what CI deploys; needs [emscripten](https://emscripten.org) to compile the firmware from source):
  ```bash
  cd web && npm install && node build.mjs   # → ../docs/
  ```

## Connect a real clock

Two ways — pick one:

1. **Web Serial** — a Chromium browser (Chrome / Edge / Arc / Brave). Open the hosted app, click **CONNECT DEVICE**, choose the port. No install.
2. **PCC Bridge (`pccd`)** — works in **any** browser (Safari and Firefox included), and shares the port so the clock can simultaneously feed **chrony** as a stratum-1 source. One line:
   ```bash
   curl -L https://github.com/peterlewis/pcc/releases/latest/download/pccd-macos-universal.tar.gz | tar xz && cd pcc && ./pccd
   # Linux: swap in pccd-linux-$(uname -m).tar.gz
   ```
   Then open <http://localhost:4192> and click **CONNECT DEVICE**. `pccd` serves its own copy of the app, so the bridge WebSocket is same-origin and works in every browser. Full guide: [`host/pccd/README.md`](host/pccd/README.md).

## Repository layout

| Path | What |
| --- | --- |
| [`web/`](web/) | **The app** — source. Built to `docs/` by CI and served on Pages. See [`web/README.md`](web/README.md). |
| [`web/emu/`](web/emu/) | The firmware emulator: `clock4` submodule, emscripten shim, and the conformance suite. |
| [`.github/workflows/pages.yml`](.github/workflows/pages.yml) | Compiles the firmware WASM + builds `web/`, deploys to GitHub Pages on every push to `main`. |

`main` is **web-only**. The original native macOS menu-bar app is paused and preserved on the [`macos-app`](https://github.com/peterlewis/pcc/tree/macos-app) branch:

```bash
git fetch && git switch macos-app
cd macos && swift build && swift run PCC
```

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) — official documentation
- [clock4](https://github.com/mitxela/clock4) — hardware design & firmware source (mitxela)
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app) — discussion on the mitxela forum

## License

MIT — see [LICENSE](LICENSE). Bundled third-party assets (fonts, map data, libraries) keep their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
