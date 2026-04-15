# PCC: Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). Connects over USB serial to configure the clock's display, brightness, modes, and settings.

> This is an independent, community-built companion app. Not affiliated with mitxela.

![macOS 26+](https://img.shields.io/badge/macOS-26%2B-blue) ![Swift 6.2](https://img.shields.io/badge/Swift-6.2-orange)

## Screenshots

![Satellites — Globe](docs/screenshots/satellites-globe-trails.png)

<table>
<tr>
<td><a href="docs/screenshots/data-sources.png"><img src="docs/screenshots/data-sources.png" width="280"></a><br><sub>Data Sources</sub></td>
<td><a href="docs/screenshots/satellites-polar-trails.png"><img src="docs/screenshots/satellites-polar-trails.png" width="280"></a><br><sub>Satellites — Polar</sub></td>
<td><a href="docs/screenshots/satellites-map-trails.png"><img src="docs/screenshots/satellites-map-trails.png" width="280"></a><br><sub>Satellites — Map</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/brightness.png"><img src="docs/screenshots/brightness.png" width="280"></a><br><sub>Brightness</sub></td>
<td><a href="docs/screenshots/weather.png"><img src="docs/screenshots/weather.png" width="280"></a><br><sub>Weather</sub></td>
<td><a href="docs/screenshots/time-server.png"><img src="docs/screenshots/time-server.png" width="280"></a><br><sub>Time Server</sub></td>
</tr>
</table>

<details>
<summary>All screenshots</summary>
<br>
<table>
<tr>
<td><a href="docs/screenshots/menu-bar.png"><img src="docs/screenshots/menu-bar.png" width="280"></a><br><sub>Menu Bar</sub></td>
<td><a href="docs/screenshots/connect.png"><img src="docs/screenshots/connect.png" width="280"></a><br><sub>Connect</sub></td>
<td><a href="docs/screenshots/data-sources.png"><img src="docs/screenshots/data-sources.png" width="280"></a><br><sub>Data Sources</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/data-sources-rest.png"><img src="docs/screenshots/data-sources-rest.png" width="280"></a><br><sub>Data Sources — REST</sub></td>
<td><a href="docs/screenshots/data-sources-bash.png"><img src="docs/screenshots/data-sources-bash.png" width="280"></a><br><sub>Data Sources — Bash</sub></td>
<td><a href="docs/screenshots/text.png"><img src="docs/screenshots/text.png" width="280"></a><br><sub>Text</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/weather.png"><img src="docs/screenshots/weather.png" width="280"></a><br><sub>Weather</sub></td>
<td><a href="docs/screenshots/countdown.png"><img src="docs/screenshots/countdown.png" width="280"></a><br><sub>Countdown</sub></td>
<td><a href="docs/screenshots/satellites-polar.png"><img src="docs/screenshots/satellites-polar.png" width="280"></a><br><sub>Satellites — Polar</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/satellites-polar-trails.png"><img src="docs/screenshots/satellites-polar-trails.png" width="280"></a><br><sub>Polar with Trails</sub></td>
<td><a href="docs/screenshots/satellites-polar-dark.png"><img src="docs/screenshots/satellites-polar-dark.png" width="280"></a><br><sub>Polar — Dark</sub></td>
<td><a href="docs/screenshots/satellites-map.png"><img src="docs/screenshots/satellites-map.png" width="280"></a><br><sub>Satellites — Map</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/satellites-map-trails.png"><img src="docs/screenshots/satellites-map-trails.png" width="280"></a><br><sub>Map with Trails</sub></td>
<td><a href="docs/screenshots/satellites-globe.png"><img src="docs/screenshots/satellites-globe.png" width="280"></a><br><sub>Satellites — Globe</sub></td>
<td><a href="docs/screenshots/satellites-globe-trails.png"><img src="docs/screenshots/satellites-globe-trails.png" width="280"></a><br><sub>Globe with Trails</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/signal-analysis.png"><img src="docs/screenshots/signal-analysis.png" width="280"></a><br><sub>Signal Analysis</sub></td>
<td><a href="docs/screenshots/brightness.png"><img src="docs/screenshots/brightness.png" width="280"></a><br><sub>Brightness</sub></td>
<td><a href="docs/screenshots/modes.png"><img src="docs/screenshots/modes.png" width="280"></a><br><sub>Modes</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/time-server.png"><img src="docs/screenshots/time-server.png" width="280"></a><br><sub>Time Server</sub></td>
<td><a href="docs/screenshots/diagnostics.png"><img src="docs/screenshots/diagnostics.png" width="280"></a><br><sub>Diagnostics</sub></td>
<td><a href="docs/screenshots/serial-monitor.png"><img src="docs/screenshots/serial-monitor.png" width="280"></a><br><sub>Serial Monitor</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/advanced.png"><img src="docs/screenshots/advanced.png" width="280"></a><br><sub>Advanced</sub></td>
<td><a href="docs/screenshots/updates.png"><img src="docs/screenshots/updates.png" width="280"></a><br><sub>Updates</sub></td>
<td><a href="docs/screenshots/manual.png"><img src="docs/screenshots/manual.png" width="280"></a><br><sub>Mk IV User Manual</sub></td>
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
- Check for firmware and timezone updates, install to the CLOCK USB volume

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
- GPS-disciplined time from the clock's GNSS module, served on localhost UDP port 12321
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

## Serial protocol

Commands are `key = value\r\n` over USB serial at 115200 baud. They take effect immediately but reset on power cycle unless saved to `config.txt`. The app disables NMEA output on connect so commands work reliably, and restores it on disconnect. See the [Mk IV documentation](https://mitxela.com/projects/precision_clock_mk_iv/docs) for the full command reference.

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
