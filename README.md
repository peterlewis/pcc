# PCC — Precision Clock Companion

A native macOS menu bar app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_4_user_manual) by [mitxela](https://mitxela.com). Communicates over USB serial to control the clock's display, brightness, modes, and more.

> **Note:** This is an independent, community-built companion app. It is not officially endorsed by or affiliated with mitxela or the Precision Clock Mk IV project.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue) ![Swift 5.9+](https://img.shields.io/badge/Swift-5.9%2B-orange)

## Features

- **Menu bar app** — lives in the menu bar with a 7-segment display icon, runs in the background, window opens on demand
- **Serial connection** — auto-detects `/dev/cu.usbmodem*` ports, auto-connects on launch, handles device arrival/removal
- **Data sources** — poll REST APIs or run shell commands on a schedule, rotate multiple sources on the display at a configurable interval
- **Text display** — send arbitrary text to the 10-digit display with character counter and history
- **Countdown** — set a target date/time, sends `countdown_to` in UTC ISO 8601
- **Brightness curve** — interactive drag-to-edit graph for the 5-point brightness curve, with presets for Rev C, Rev D, and GL5549 hardware
- **Manual brightness** — lock brightness for filming, one-click reboot to restore auto curve
- **Modes** — toggle which modes appear in the button cycle (time, date, weekday, stopwatch, etc.), colon animation style, standby
- **Diagnostics** — toggle debug displays (ADC/DAC, RTC calibration, satellite view, battery voltage, firmware CRC, display test, TTFF)
- **Advanced** — timezone override, NMEA output, matrix frequency, accuracy tolerance, fake GPS position
- **Port diagnostics** — see which process has the serial port claimed, kill it if needed
- **Reboot clock** — one-click reboot from the Connect panel

### Coming soon

- **Weather** — backend-driven weather display
- **Config file** — read and write `config.txt` via USB mass storage

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

The app runs unsandboxed — no entitlements needed for serial port access.

## Serial protocol

All commands are `key = value\r\n`, case insensitive, temporary until power cycle. The app sends `nmea = off` on connect and restores `nmea = all` + `mode_text = 0` on disconnect/quit. See the [Mk IV user manual](https://mitxela.com/projects/precision_clock_4_user_manual) for the full command reference.

## Dependencies

- [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) — serial communication (SPM)

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_4_user_manual) — official project documentation
- [GitHub](https://github.com/mitxela/clock4) — hardware design and firmware source

## License

MIT
