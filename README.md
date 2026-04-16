# PCC: Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). Connects over USB serial to configure the clock's display, brightness, modes, and settings.

> [!NOTE]
> This is an independent, community-built companion app. Not affiliated with mitxela.

![macOS 26+](https://img.shields.io/badge/macOS-26%2B-blue) ![Swift 6.2](https://img.shields.io/badge/Swift-6.2-orange) ![License: MIT](https://img.shields.io/badge/License-MIT-green)

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-globe-dark.png">
  <img src="docs/screenshots/satellites-globe-light.png" alt="Satellites — Globe">
</picture>

<table>
<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/data-sources-dark.png">
  <img src="docs/screenshots/data-sources-light.png" width="280">
</picture>
<br><sub>Data Sources</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-polar-dark.png">
  <img src="docs/screenshots/satellites-polar-light.png" width="280">
</picture>
<br><sub>Satellites — Polar</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-map-dark.png">
  <img src="docs/screenshots/satellites-map-light.png" width="280">
</picture>
<br><sub>Satellites — Map</sub>
</td>
</tr>
<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/brightness-dark.png">
  <img src="docs/screenshots/brightness-light.png" width="280">
</picture>
<br><sub>Brightness</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/weather-dark.png">
  <img src="docs/screenshots/weather-light.png" width="280">
</picture>
<br><sub>Weather</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/time-server-dark.png">
  <img src="docs/screenshots/time-server-light.png" width="280">
</picture>
<br><sub>Time Server</sub>
</td>
</tr>
</table>

<details>
<summary>All screenshots</summary>
<br>

<table>
<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/connect-dark.png">
  <img src="docs/screenshots/connect-light.png" width="280">
</picture>
<br><sub>Connect</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/data-sources-dark.png">
  <img src="docs/screenshots/data-sources-light.png" width="280">
</picture>
<br><sub>Data Sources</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/text-dark.png">
  <img src="docs/screenshots/text-light.png" width="280">
</picture>
<br><sub>Text</sub>
</td>
</tr>

<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/data-sources-rest-dark.png">
  <img src="docs/screenshots/data-sources-rest-light.png" width="280">
</picture>
<br><sub>Data Sources — REST</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/data-sources-bash-dark.png">
  <img src="docs/screenshots/data-sources-bash-light.png" width="280">
</picture>
<br><sub>Data Sources — Bash</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/countdown-dark.png">
  <img src="docs/screenshots/countdown-light.png" width="280">
</picture>
<br><sub>Countdown</sub>
</td>
</tr>

<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-polar-dark.png">
  <img src="docs/screenshots/satellites-polar-light.png" width="280">
</picture>
<br><sub>Satellites — Polar</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-map-dark.png">
  <img src="docs/screenshots/satellites-map-light.png" width="280">
</picture>
<br><sub>Satellites — Map</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/satellites-globe-dark.png">
  <img src="docs/screenshots/satellites-globe-light.png" width="280">
</picture>
<br><sub>Satellites — Globe</sub>
</td>
</tr>

<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/signal-analysis-dark.png">
  <img src="docs/screenshots/signal-analysis-light.png" width="280">
</picture>
<br><sub>Signal Analysis</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/modes-dark.png">
  <img src="docs/screenshots/modes-light.png" width="280">
</picture>
<br><sub>Modes</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/diagnostics-dark.png">
  <img src="docs/screenshots/diagnostics-light.png" width="280">
</picture>
<br><sub>Diagnostics</sub>
</td>
</tr>

<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/serial-monitor-dark.png">
  <img src="docs/screenshots/serial-monitor-light.png" width="280">
</picture>
<br><sub>Serial Monitor</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/advanced-dark.png">
  <img src="docs/screenshots/advanced-light.png" width="280">
</picture>
<br><sub>Advanced</sub>
</td>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/updates-dark.png">
  <img src="docs/screenshots/updates-light.png" width="280">
</picture>
<br><sub>Updates</sub>
</td>
</tr>

<tr>
<td>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/manual-dark.png">
  <img src="docs/screenshots/manual-light.png" width="280">
</picture>
<br><sub>Mk IV User Manual</sub>
</td>
</tr>

</table>
</details>

## What it does

### Display & Configuration
- Connects to the clock over serial, auto-detects ports, reconnects after reboot
- Configure display modes, colon animation, brightness curve, diagnostics, timezone, and more
- Send text or countdowns to the display
- Poll REST APIs or shell commands and rotate values on the clock (with HTTP header support)
- Edit the 5-point brightness curve with a draggable graph, save custom presets
- Read and write `config.txt` with local backups kept on the Mac
- Check for firmware and timezone updates, install to the <kbd>CLOCK</kbd> USB volume

### GPS & Satellites
- Three satellite views — Polar, Map, and Globe — with consistent toggle controls for satellites, labels, and trails
- Polar plot with signal strength bars, sun/moon positions, and horizon mask
- World map with sub-satellite points and trail overlay
- Interactive 3D globe (globe.gl) with satellite ground tracks, sun/moon celestial projections, and space background
- Persistent trail recording: logs satellite observations to disk as an aggregated 1° grid, runs in the background, persists across launches
- Signal analysis with GPS diagnostics
- GPS info panel: coordinates, Maidenhead grid locator, altitude, HDOP quality indicator
- Sun data: rise/set times, solar noon, golden hour, civil twilight, equation of time
- Moon data: phase with emoji, illumination percentage, altitude and azimuth
- Fix statistics: satellites used, fix type, time since first fix

### NTP Time Server
- Turns your Mac into a Stratum 1 NTP time server — near-millisecond accuracy from GPS, no internet required
- GPS-disciplined time from the clock's GNSS module, served on localhost UDP port `12321`
- Pair with chrony to keep your Mac's system clock continuously disciplined to GPS time
- Time extrapolation compensates for serial latency (~200–500ms)
- Built-in test query and live offset display to verify operation
- Auto-starts on launch if previously enabled

### Weather
- Weather conditions displayed on the clock via WeatherKit
- Location picker with interactive map
- Configurable update interval

### Other
- Serial monitor for viewing raw NMEA and debug output
- Lives in the menu bar, window opens on demand

## Requirements

- macOS 26 or later
- Precision Clock Mk IV connected via USB

## Building

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc
swift build
swift run PCC
```

Or open `Package.swift` in Xcode and hit Run.

## NTP Time Server

The app includes a Stratum 1 NTP server that serves GPS-disciplined time from the clock's GNSS receiver. With chrony, this gives your Mac near-millisecond clock accuracy from GPS — no internet dependency. Enable it from the Time Server tab.

[!TIP]
To sync your Mac's clock continuously, install [chrony](https://chrony-project.org/):

```bash
brew install chrony
```

Add to `/opt/homebrew/etc/chrony.conf`:

```
server 127.0.0.1 port 12321 iburst prefer
```

Start chrony:

```bash
sudo mkdir -p /var/run/chrony
sudo /opt/homebrew/sbin/chronyd -f /opt/homebrew/etc/chrony.conf
```

Check status with `chronyc tracking`. You should see Stratum 1 with the reference ID `GPS`.

> [!IMPORTANT]
> chrony requires elevated privileges to discipline the system clock. The PCC NTP server itself runs unprivileged on a non-standard port.

## Serial protocol

Commands are `key = value\r\n` over USB serial at 115200 baud. They take effect immediately but reset on power cycle unless saved to `config.txt`. The app disables NMEA output on connect so commands work reliably, and restores it on disconnect. See the [Mk IV documentation](https://mitxela.com/projects/precision_clock_mk_iv/docs) for the full command reference.

> [!CAUTION]
> Writing to config.txt overwrites the clock’s saved settings. PCC keeps a local backup on each write, but take care with manual serial commands.

## Dependencies

- [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) (SPM)
- [globe.gl](https://globe.gl) (loaded at runtime for 3D globe view)
- WeatherKit (Apple framework)

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs): official project documentation
- [clock4](https://github.com/mitxela/clock4): hardware design and firmware source
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app): discussion on the mitxela forum

## License

MIT
