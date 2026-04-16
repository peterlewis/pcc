# PCC (Precision Clock Companion)

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


</table>
</details>

## What it does

### Display & Configuration
- Connects over serial, auto-detects ports, reconnects after reboot
- Configure display modes, colon animation, brightness curve, diagnostics, timezone, and more
- Send text or countdowns to the display
- Poll REST APIs or shell commands and rotate values on the clock (with HTTP header support)
- Edit the 5-point brightness curve with a draggable graph; save custom presets
- Read and write `config.txt` with local backups kept on the Mac
- Check for firmware and timezone updates; install to the <kbd>CLOCK</kbd> USB volume

### GPS & Satellites
- Three satellite views — Polar plot, world Map, and interactive 3D Globe — with consistent toggles for satellites, labels, and trails
- Sky trail recording: satellite observations accumulated to an aggregated 1° grid, persists across launches
- GPS info: coordinates, Maidenhead grid locator, altitude, HDOP[^1], fix type, satellites used
- Celestial data: sun rise/set, solar noon, golden hour, civil twilight; moon phase, illumination, altitude, azimuth
- Signal analysis with diagnostics panel

### NTP Time Server
- Basic Stratum 1 server on `localhost:12321`, disciplined by the clock’s GNSS module — see [setup below](#ntp-time-server)

### Weather
- Conditions scrolled on the clock via WeatherKit; configurable location and update interval

### Other
- Serial monitor for raw NMEA and debug output
- Lives in the menu bar; window opens on demand

## Building

Requires macOS 26+ and a Precision Clock Mk IV connected via USB.

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc
swift build
swift run PCC
```

Or open `Package.swift` in Xcode and hit <kbd>⌘</kbd><kbd>R</kbd>.

## NTP Time Server

Enable from the Time Server tab. The NTP server is a localhost convenience tool — there is no holdover oscillator, so if GPS fix is lost it falls back to system time without adjusting stratum.

> [!NOTE]
> Not a production time source, and not intended as a network-facing server. Designed as a localhost source for chrony while GPS fix is held.

```mermaid
graph LR
    A["GPS Satellites"] --> B["Mk IV GNSS"]
    B -->|USB Serial| C["PCC NTP Server"]
    C -->|UDP 12321| D["chrony"]
    D --> E["System Clock"]
```

<details>
<summary>Pairing with chrony</summary>
<br>

Install [chrony](https://chrony-project.org/):

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

Check status with `chronyc tracking`. You should see Stratum 1 with reference ID `GPS`.

> [!IMPORTANT]
> chrony requires elevated privileges to discipline the system clock. PCC’s NTP server runs unprivileged on a non-standard port.

</details>

## Serial protocol

<details>
<summary>Protocol details</summary>
<br>

Commands are `key = value\r\n` over USB serial at 115200 baud. They take effect immediately but reset on power cycle unless saved to `config.txt`. The app disables NMEA output on connect so commands work reliably, and restores it on disconnect. See the [Mk IV documentation](https://mitxela.com/projects/precision_clock_mk_iv/docs) for the full command reference.

> [!CAUTION]
> Writing to config.txt overwrites the clock’s saved settings. PCC keeps a local backup on each write, but take care with manual serial commands.

</details>

## Dependencies

| Dependency | Type | Purpose |
|---|---|---|
| [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) | SPM | USB serial communication |
| [globe.gl](https://globe.gl) | Runtime | Interactive 3D globe view |
| WeatherKit | Apple framework | Weather data |

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs): official project documentation
- [clock4](https://github.com/mitxela/clock4): hardware design and firmware source
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app): discussion on the mitxela forum

[^1]: HDOP (Horizontal Dilution of Precision) indicates the geometric quality of the satellite constellation. Lower is better; < 1.0 is excellent, > 5.0 is poor.
