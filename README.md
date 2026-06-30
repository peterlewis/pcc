# PCC (Precision Clock Companion)

Companion software for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com).

**Active focus: [PCC Web](#pcc-web)** — a browser build that drives the clock over Web Serial. The native **macOS app is paused** (parked under [`macos/`](macos/), still builds) while development concentrates on the web version.

> [!NOTE]
> Independent, community-built. Not affiliated with mitxela.

![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Web: active](https://img.shields.io/badge/Web-active-blue) ![macOS app: paused](https://img.shields.io/badge/macOS%20app-paused-lightgrey)

## Repository layout

| Path | What |
| --- | --- |
| [`web/`](web/) | **PCC Web** — the webserial version (active). Drives the clock from a Chromium browser. |
| [`chrony-bridge/`](chrony-bridge/) | Host daemon feeding the clock's GPS time into chrony as a local NTP source. |
| [`macos/`](macos/) | The native macOS menu-bar app — **paused**. Still builds with `swift build` from that folder. |

## PCC Web

Drives a Precision Clock Mk IV from a Chromium-based browser over [Web Serial](https://developer.mozilla.org/docs/Web/API/Web_Serial_API): display modes, text, countdowns, brightness and raw `key = value` commands; a polar sky view with sector heatmap and age-faded trails; an offline 3D globe; pass history in IndexedDB; GPS / sun / moon info; and a raw serial monitor.

**[Open PCC Web →](https://peterlewis.github.io/pcc/web/)** · full details in [`web/README.md`](web/README.md)

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc
bash web/serve.sh        # http://localhost:8765
```

Needs a Chromium browser (Chrome / Edge / Arc / Brave) and `localhost` or HTTPS — Web Serial isn't in Safari or Firefox. A few capabilities stay Mac-only by nature (NTP server, firmware / timezone updates, native map, WeatherKit, on-device AI) — see [`web/README.md`](web/README.md).

## chrony-bridge (NTP)

A browser can't open a UDP port, so for a real local NTP source there's a small cross-platform daemon that reads the clock's serial stream and feeds [chrony](https://chrony-project.org/) through its `SOCK` refclock — handy on a headless Linux / Raspberry Pi box. Setup, the honest accuracy notes, and service files are in [`chrony-bridge/README.md`](chrony-bridge/README.md).

## macOS app (paused)

The original native menu-bar app — three satellite views, GPS-disciplined NTP, WeatherKit, on-device AI insights. Development is **paused** in favour of the web version, but it stays buildable in [`macos/`](macos/):

```bash
cd macos && swift build && swift run PCC
```

Screenshots, full feature list and setup are in [`macos/README.md`](macos/README.md).

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) — official documentation
- [clock4](https://github.com/mitxela/clock4) — hardware design and firmware source
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app) — discussion on the mitxela forum

## License

MIT — see [LICENSE](LICENSE). Third-party attributions for the macOS app's bundled assets are in [`macos/THIRD_PARTY_LICENSES.md`](macos/THIRD_PARTY_LICENSES.md).
