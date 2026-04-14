# PCC: Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). Connects over USB serial to configure the clock's display, brightness, modes, and settings.

> This is an independent, community-built companion app. Not affiliated with mitxela.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue) ![Swift 5.9+](https://img.shields.io/badge/Swift-5.9%2B-orange)

## Screenshots

<details>
<summary>Connect</summary>

![Connect](docs/screenshots/connect-light.png)
</details>

### Display

<details>
<summary>Data Sources</summary>

![Data Sources](docs/screenshots/data-sources-light.png)
![Data Sources — GitHub Stars](docs/screenshots/data-sources-light-github-stars.png)
</details>

<details>
<summary>Text</summary>

![Text](docs/screenshots/text-light.png)
</details>

<details>
<summary>Countdown</summary>

![Countdown](docs/screenshots/countdown-light.png)
</details>

### GPS

<details>
<summary>Sky View</summary>

![Sky View — Light](docs/screenshots/sky-view-light.png)
![Sky View — Dark](docs/screenshots/sky-view-dark.png)
</details>

<details>
<summary>Map</summary>

![Map](docs/screenshots/map-light.png)
</details>

### Configuration

<details>
<summary>Brightness</summary>

![Brightness — Light](docs/screenshots/brightness-light.png)
![Brightness — Dark](docs/screenshots/brightness-dark.png)
</details>

<details>
<summary>Modes</summary>

![Modes — Light](docs/screenshots/modes-light.png)
![Modes — Dark](docs/screenshots/modes-dark.png)
</details>

<details>
<summary>Time Server</summary>

![Time Server](docs/screenshots/ntp-light.png)
</details>

<details>
<summary>Diagnostics</summary>

![Diagnostics](docs/screenshots/diagnostics-light.png)
</details>

<details>
<summary>Serial Monitor</summary>

![Serial Monitor](docs/screenshots/serial-monitor-light.png)
</details>

<details>
<summary>Advanced</summary>

![Advanced](docs/screenshots/advanced-light.png)
</details>

<details>
<summary>Updates</summary>

![Updates](docs/screenshots/updates-light.png)
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
- Satellite sky view: polar plot with signal strength bars and 24-hour trail history
- Sun and moon positions rendered on the polar plot in real time
- Horizon mask analysis: tracks minimum elevation per azimuth sector to map obstructions
- GPS info panel: coordinates, Maidenhead grid locator, altitude, HDOP quality indicator
- Sun data: rise/set times, solar noon, golden hour, civil twilight, equation of time
- Moon data: phase with emoji, illumination percentage, altitude and azimuth
- Satellite map view: sub-satellite points plotted on a world map
- Fix statistics: satellites used, fix type, time since first fix

### NTP Time Server
- Stratum 1 NTP server using GPS-disciplined time from the clock's GNSS module
- Serves time on localhost UDP port 12321 using POSIX sockets
- Time extrapolation compensates for serial latency (~200-500ms)
- Works with chrony for continuous Mac system clock synchronisation
- Built-in test query button to verify operation
- Auto-starts on launch if previously enabled

### Weather
- Weather conditions displayed on the clock via WeatherKit
- Location picker with interactive map
- Configurable update interval

### Other
- Serial monitor for viewing raw NMEA and debug output
- Lives in the menu bar, window opens on demand

## Requirements

- macOS 13 (Ventura) or later
- Precision Clock Mk IV connected via USB

## Building

```bash
git clone https://github.com/peterlew/pcc.git
cd pcc
swift build
swift run PCC
```

Or open `Package.swift` in Xcode and hit Run.

## NTP Time Server

The app includes a Stratum 1 NTP server that serves GPS-disciplined time from the clock's GNSS receiver. Enable it from the Time Server tab.

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
- WeatherKit (Apple framework, macOS 13+)

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs): official project documentation
- [clock4](https://github.com/mitxela/clock4): hardware design and firmware source
- [Forum thread](https://mitxela.com/forum/topic/pcc-precision-clock-companion-macos-menu-bar-app): discussion on the mitxela forum

## License

MIT
