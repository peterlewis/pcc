# PCC — Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). Communicates over USB serial to control the clock's display, brightness, modes, and configuration.

> **Note:** This is an independent, community-built companion app. It is not officially endorsed by or affiliated with mitxela or the Precision Clock Mk IV project.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue) ![Swift 5.9+](https://img.shields.io/badge/Swift-5.9%2B-orange)

## Features

### Display

- **Data sources** — poll REST APIs or run shell commands on a schedule, rotate multiple sources on the clock display at a configurable interval, current values visible in the menu bar
- **Text display** — send arbitrary text to the 10-digit display with character count, marquee indicator for strings over 10 characters, and send history
- **Countdown** — set a target date/time and display a live countdown (sends `countdown_to` in UTC ISO 8601)

Display modes are mutually exclusive — activating one properly disables the previous, with the sidebar indicating which is active.

### Configuration

- **Brightness curve** — interactive drag-to-edit graph for the 5-point ADC/DAC brightness mapping, factory presets (Rev C, Rev D, GL5549), custom preset save/load/delete, manual brightness lock for filming
- **Modes** — toggle which modes appear in the button cycle (ISO 8601, Unix timestamp, UTC offset, timezone name, ordinal date, ISO week, Julian date, weekday variants), colon animation style, standby mode
- **Diagnostics** — toggle debug displays (brightness ADC/DAC, RTC calibration, satellite view, battery voltage, firmware CRC, display test, time to first fix)
- **Advanced** — timezone override with searchable IANA list, matrix display frequency, accuracy tolerance thresholds, fake GPS position, raw config.txt editor

### Connectivity

- **Serial connection** — auto-detects `/dev/cu.usbmodem*` ports, auto-connects on launch, reconnects after reboot, handles device arrival/removal
- **Serial monitor** — live raw serial feed with NMEA sentence filtering (Off/RMC/All), auto-scroll, session-scoped
- **Port diagnostics** — identify which process has claimed the serial port and kill it if needed

### Updates

- **Firmware & timezone updates** — check the clock4 repo for new releases, download and install firmware and timezone data to the CLOCK USB volume
- **Reboot** — one-click reboot from the app or menu bar, with automatic reconnection

### Config file

- **Read on launch** — populates the GUI from `config.txt` on the CLOCK USB volume
- **Save/Revert/Undo** — per-panel Save writes to config, Revert reloads from disk, Undo Save restores the previous version (session-scoped)
- **Local backups** — config.txt backups are stored on the Mac at `~/Library/Application Support/PCC/config-backups/` (not on the USB volume), last 10 retained
- **Write gating** — all config.txt writing is disabled by default and must be explicitly enabled in Advanced, to prevent accidental writes during alpha

### Menu bar

- 7-segment display icon (with hidden red mode easter egg via Option key)
- Connection status, data source values, reboot clock, quick access to the app window

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

All commands are `key = value\r\n`, sent over USB serial at 115200 baud. Commands take effect immediately but reset on power cycle unless saved to `config.txt`. The app sends `nmea = off` on connect (so serial commands work reliably) and restores `nmea = all` on disconnect/quit. See the [Mk IV documentation](https://mitxela.com/projects/precision_clock_mk_iv/docs) for the full command reference.

## Dependencies

- [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) — serial communication (SPM)

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) — official project documentation
- [clock4](https://github.com/mitxela/clock4) — hardware design and firmware source

## License

MIT
