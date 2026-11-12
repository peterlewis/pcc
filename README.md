# Precision Clock Companion

A browser app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). It drives a real clock over Web Serial, and with no clock attached it *is* one: the on-screen clock is the actual `clock4` firmware compiled to WebAssembly, not an imitation of it.

### **[▶ Open Precision Clock Companion (beta) →](https://pcc.ptrl.ws/)**

> [!NOTE]
> Independent, community-built. Not affiliated with mitxela.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Deploys from CI](https://img.shields.io/badge/deploy-GitHub%20Pages%20(CI)-blue) ![Web Serial](https://img.shields.io/badge/Web%20Serial-Chromium-orange)

## What's in it

| | |
|---|---|
| **FACE** | Every display mode, text and countdowns, brightness curves, and `config.txt` through the firmware's own parser |
| **SKY** | Polar plot with signal heatmap, world map and globe, signal and position analysis, history that persists and exports |
| **TIMING** | PPS phase and jitter, oscillator drift, and a temperature-compensation fit, from the [extended firmware](#pcc-and-the-extended-firmware) |
| **DEVICE** | Connect, `config.txt` editing, REST data onto the date row, firmware provenance, serial monitor |

<details>
<summary><b>Everything in each tab</b></summary>

- **FACE**: every display mode (including live sidereal and apparent-solar time), text with marquee scrolling, countdowns, brightness / gamma / DAC curve editing, colon animations, the significance-fade precision display, observer location, and a timezone engine using the clock's own IANA rules database. Edit and apply `config.txt` through the firmware's real parser.
- **SKY**: polar az/el plot with signal heatmap, horizon mask and age-faded trails; a flat world map and an orthographic globe with satellites at their true sub-points and a day/night terminator; C/N₀ and position/DOP analysis; a GPS fix panel. History persists across reloads and exports as CSV / JSON / GPX / NMEA, including a per-satellite CSV. With `pccd` running, the trails, C/N₀ over time and the position scatter read its recordings, so a 24 h window reaches back through the night whether or not a tab was open.
- **TIMING**: from the extended firmware's `$PMTXTS` sentence: PPS phase with robust (median/MAD) jitter stats, the oscillator drift staircase, the Allan deviation curve, and a temperature-compensation fit that writes the firmware's own `tc_*` lines for `config.txt`.
- **DEVICE**: Web Serial connect, `config.txt` editing (read straight off the clock's drive through `pccd`, or from a drive the browser remembers), REST data sources that push values onto the date row, recorded-data downloads, firmware provenance and update check, and a raw serial monitor.

</details>

## The clock face is the real firmware

The C source that flashes to the physical clock is compiled to WebAssembly and runs in the page: real NMEA parsing, real PPS discipline, real display latching. Feed it a simulated GPS and watch it acquire, lock and hold over, or plug in a clock and the same code draws what yours is doing.

- **Standby**: no clock, no simulation. The face shows your system time and the telemetry stays empty.
- **Simulation**: opt-in and labelled. A virtual GPS, with real satellite positions from live TLEs, feeds the firmware's own reception path.
- **Connected**: a real Mk IV. Its data drives the same renderer and every chart; simulated data is never mixed in.

<details>
<summary><b>How it is verified</b></summary>

4,511 display checks against independently computed astronomical truth, plus a replay against a physical Mk IV on real GPS data. DEVICE ▸ UPDATES shows the exact firmware commit the page was built from, and checks it against GitHub.

</details>

## PCC and the extended firmware

PCC works with a stock clock: the face, SKY and `config.txt` editing need nothing but the GPS sentences every Mk IV sends.

The face itself runs my [extended firmware](https://github.com/peterlewis/clock4/tree/rollup): mitxela's 0.0.4 with new display modes, a settings menu on the clock, better holdover, timing telemetry and fixes. So every new mode, the menu and each `config.txt` key can be tried here before you flash anything. It is draft firmware, run on my own clock, and not part of mitxela's releases.

**[How that firmware differs from stock →](https://github.com/peterlewis/clock4/tree/rollup#how-this-firmware-differs-from-stock)** · **[Latest release](https://github.com/peterlewis/clock4/releases/latest)**

<details>
<summary><b>What the firmware reports, and where PCC shows it</b></summary>

| From the firmware | In PCC |
| --- | --- |
| `$PMTXTS`, one line per GPS pulse | TIMING: phase against GPS, jitter, oscillator drift |
| The learned temperature model (`tc_dump`) | TIMING: fits the same model from live data and writes the `tc_*` lines for `config.txt` |
| `$PMADEV` | TIMING: the Allan deviation curve |
| `$PMSTAR` | SKY: the next star transits |
| `$PMBRIT` | FACE: the brightness the clock's own dimmer has chosen |
| `SETTINGS.BIN`, the menu's saved choices | DEVICE: read with `config.txt`, so the editor shows the settings the clock is actually using |
| `$PMCFG`, the menu's choices as `config.txt` lines | `pccd` writes them into `config.txt` on the clock's drive, so the file shows what the clock is doing |

</details>

<details>
<summary><b>Where the firmware is tested and tuned</b></summary>

**Tested here.** The firmware's emulator test suites live in [`web/emu/phase1`](web/emu/phase1): 37 suites that drive the real firmware code. A firmware change comes with a test in this repository.

**Tuned here.** `pccd` records everything a connected clock reports. The firmware's holdover was designed from those recordings, not from estimates: the frequency hold, the bound behind the fading digits, and the discovery that the millisecond count ran one ahead of GPS all came from them.

</details>

## Connect a real clock

1. **Web Serial**: in Chrome, Edge, Arc or Brave, open the app, click **CONNECT DEVICE** and choose the port. Nothing to install.
2. **`pccd`**: a small background program for any browser, Safari and Firefox included. It also records the clock while no tab is open, reads and writes the clock's drive, and can feed the clock's GPS pulse to chrony as a time source.

   ```bash
   curl -L https://github.com/peterlewis/pcc/releases/latest/download/pccd-macos-universal.tar.gz | tar xz && cd pcc && ./pccd
   ```

   On Linux, use `pccd-linux-$(uname -m).tar.gz`. Then open <http://localhost:4192> and click **CONNECT DEVICE**.

<details>
<summary><b>Which address to use</b></summary>

With `pccd` running, use **<http://localhost:4192>**: the same app, served by `pccd`, with its recordings and the clock's drive behind it. The hosted page tells you when it can see `pccd` on your machine, and **ALWAYS OPEN LOCAL** sends you straight there next time; <https://pcc.ptrl.ws/local> does the same. Everyone else: <https://pcc.ptrl.ws>.

Full guide: [`host/pccd/README.md`](host/pccd/README.md).

</details>

<details>
<summary><b>Run or build it yourself</b></summary>

Local dev, live source, no build step:

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc && bash web/serve.sh        # http://localhost:8765
```

Build the static site that CI deploys (needs the firmware submodule, and [emscripten](https://emscripten.org) to compile it):

```bash
git submodule update --init
cd web && npm install && node build.mjs   # → ../docs/
```

| Path | What |
| --- | --- |
| [`web/`](web/) | The app. Built to `docs/` by CI and served on Pages. See [`web/README.md`](web/README.md). |
| [`web/emu/`](web/emu/) | The firmware emulator: the `clock4` submodule, the emscripten shim and the test suites. |
| [`host/pccd/`](host/pccd/) | `pccd`, the background program. |
| [`.github/workflows/pages.yml`](.github/workflows/pages.yml) | Compiles the firmware, builds `web/` and deploys on every push to `main`. |

The original macOS menu-bar app is paused and preserved on the [`macos-app`](https://github.com/peterlewis/pcc/tree/macos-app) branch.

</details>

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs): official documentation
- [mitxela/clock4](https://github.com/mitxela/clock4): hardware design and firmware source
- [peterlewis/clock4](https://github.com/peterlewis/clock4/tree/rollup): the extended firmware PCC runs
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app) on the mitxela forum

## License

MIT; see [LICENSE](LICENSE). Bundled third-party assets (fonts, map data, libraries) keep their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
