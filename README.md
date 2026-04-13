# Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_4_user_manual) by mitxela. Communicates over USB serial to control the clock's display, fetch live weather, run countdowns, and tune the brightness curve.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue) ![Swift 5.9+](https://img.shields.io/badge/Swift-5.9%2B-orange)

## Features

- **Serial connection** — auto-detects `/dev/cu.usbmodem*` ports, handles device arrival/removal, cleans up on disconnect
- **Text display** — send arbitrary text to the 20-digit 7-segment display, with character counter and history
- **Weather** — fetches current weather via WeatherKit REST API, formats it for 7-segment display (temperature, conditions, wind), polls on a configurable interval
- **Countdown** — set a target date/time, converts to UTC ISO8601, sends `countdown_to` command
- **Brightness curve editor** — interactive drag-to-edit graph for the 5-point brightness curve (BS1–BS5), with presets for Rev C, Rev D, and GL5549 configurations
- **Manual brightness** — lock brightness for filming, with one-click reboot to restore auto curve
- **Port diagnostics** — check which process has the serial port claimed (`lsof`), kill it if needed
- **Mode safety** — confirmation dialog when switching panels while a display mode is active

## Requirements

- macOS 13 (Ventura) or later
- Precision Clock Mk IV connected via USB
- For weather: Apple Developer account with WeatherKit access and a `.p8` signing key

## Building

```bash
# Clone and build
git clone <repo-url>
cd precision-clock-companion
swift build

# Run
swift run PCC
```

The built binary is `PCC`. To create `PCC.app`, open `Package.swift` in Xcode, build, then archive.

Or open `Package.swift` in Xcode and hit Run.

The app runs unsandboxed (no entitlements needed for serial port or network access).

## Configuration

### Serial

The clock appears at `/dev/cu.usbmodem*`. Select the port in the Connect panel and click Connect. The app sends `nmea = off` on connect and restores `nmea = all` + `mode_text = 0` on disconnect/quit.

### WeatherKit

Go to **Settings > WeatherKit** and enter:

| Field | Example |
|---|---|
| Team ID | `XXXXXXXXXX` (10 chars) |
| Service ID | `com.example.weatherkit` |
| Key ID | `XXXXXXXXXX` (10 chars) |
| .p8 key path | `/path/to/AuthKey.p8` |

The app signs JWTs locally with CryptoKit (ES256) — no server needed.

### Location & Units

Default location is Bath, UK (51.4043, -2.3234). Override in **Settings > Location**.

Temperature (C/F), wind speed (mph/km/h/m/s/knots), and poll interval (30–600s) are in **Settings > Units**.

## Brightness Curve

The curve maps the light sensor ADC reading (0–4095) to DAC brightness output (0–4095) via 5 control points. Drag points on the graph or type exact values. Presets included for different hardware revisions:

| Preset | Sensor | R11 |
|---|---|---|
| Rev C | GL5528 | 20K |
| GL5549 | GL5549 | 470K |
| Rev D | VTT9812FH | 470K |

Use `mode_debug_brightness` (in the Debug section) to see live ADC/DAC values on the clock while tuning.

## Serial Protocol

All commands are `key = value\r\n`, case insensitive, temporary until power cycle. Key commands:

```
text = hello world          # set display text
mode_text = 1               # enable text mode
brightness = 0.5            # lock brightness (0.0–1.0)
BS1 = 0,400                 # set curve point 1
mode_countdown = 1          # enable countdown
countdown_to = 2026-12-25T00:00:00Z
mode_debug_brightness = 1   # show ADC/DAC
nmea = off                  # silence GPS output
reboot                      # reset clock
```

## Dependencies

- [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) — serial port communication (via SPM)
- CryptoKit (system) — JWT signing for WeatherKit
- URLSession (system) — WeatherKit API calls

## License

MIT
