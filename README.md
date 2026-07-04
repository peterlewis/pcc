# Precision Clock Companion

A browser app that drives the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com) over Web Serial — display modes, text & countdowns, brightness curves, a live polar sky, an orthographic globe **and** a flat world map, GPS / satellite / timing charts, and a raw serial monitor. With no clock attached it runs as a faithful **emulator**.

### **[▶ Open Precision Clock Companion (Beta) →](https://peterlewis.github.io/pcc/)**

> [!NOTE]
> Independent, community-built. Not affiliated with mitxela.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Deploys from CI](https://img.shields.io/badge/deploy-GitHub%20Pages%20(CI)-blue) ![Web Serial](https://img.shields.io/badge/Web%20Serial-Chromium-orange)

## Why a website, and not the Mac app?

There *was* a native macOS menu-bar app — it still exists, just [paused](#the-macos-app-paused). A few practical reasons why a web version is better:

- **Distribution.** A native Mac app requires a Developer Program membership (£99/yr) and signing + notarizing each build. A web app is a URL — nothing to install or sign.
- **Reach.** Anyone on a Chromium browser can open it — macOS, Windows, Linux, a Chromebook. No per-platform build, no updates to push.
- **Knowledge.** I know more HTML / JS / Canvas than I do Swift / AppKit.

A few things stay Mac-only by nature (acting as a system NTP server, native WeatherKit, on-device AI).

## What it does

- **Clock control** — display modes, text & scrolling marquee, countdowns, brightness / gamma / DAC curves, colon styles, and raw `key = value` commands.
- **Sky room** — a polar az/el plot with sector heatmap and age-faded trails, C/N₀ vs elevation + over time, a static-position CEP scatter with DOP history, an orthographic **globe** with a soft day/night terminator, and a flat **world map** with satellites at their real sub-points.
- **Timing** — PPS host-timestamping: phase jitter, drift staircase, and a temperature-compensation fit (with the draft firmware streaming `$PMTXTS`).
- **Emulator** — everything above runs with no hardware, driven by a built-in simulator; connect a real Mk IV over Web Serial and the same views drive the physical clock.
- **Config & data** — read/write the clock's `config.txt`, REST data-sources for the date row, weather-at-fix, and a raw NMEA / serial monitor.

## Run it

- **Hosted:** <https://peterlewis.github.io/pcc/> — needs a Chromium browser (Chrome / Edge / Arc / Brave) over HTTPS.
- **Local dev:** live source, no build step:
  ```bash
  git clone https://github.com/peterlewis/pcc.git
  cd pcc && bash web/serve.sh        # http://localhost:8765
  ```
- **Build the static site** (what CI deploys):
  ```bash
  cd web && npm install && node build.mjs   # → ../docs/
  ```

Web Serial isn't in Safari or Firefox — use a Chromium browser. Nothing is required to *look* around (it emulates a clock); plug one in to drive the real thing.

## Repository layout

| Path | What |
| --- | --- |
| [`web/`](web/) | **The app** — source. Built to `docs/` by CI and served on Pages. See [`web/README.md`](web/README.md). |
| [`chrony-bridge/`](chrony-bridge/) | Small host daemon feeding the clock's GPS time into [chrony](https://chrony-project.org/) as a local NTP source. |
| [`.github/workflows/pages.yml`](.github/workflows/pages.yml) | Builds `web/` with esbuild and deploys to GitHub Pages on every push to `main`. |

`main` is **web-only**. The native macOS app is **paused** and preserved on the [`macos-app`](https://github.com/peterlewis/pcc/tree/macos-app) branch (kept as a Swift reference).

## chrony-bridge (NTP)

A browser can't open a UDP port, so for a real local NTP source there's a small cross-platform daemon that reads the clock's serial stream and feeds chrony through its `SOCK` refclock — handy on a headless Linux / Raspberry Pi box. Setup, honest accuracy notes and service files are in [`chrony-bridge/README.md`](chrony-bridge/README.md).

## The macOS app (paused)

The original native menu-bar app — three satellite views, GPS-disciplined NTP, WeatherKit, on-device AI insights — is paused in favour of the web version, but preserved and still buildable on its branch:

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
