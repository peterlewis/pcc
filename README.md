# PCC: Precision Clock Companion

A native macOS companion app for the [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs) by [mitxela](https://mitxela.com). Connects over USB serial to configure the clock's display, brightness, modes, and settings.

> This is an independent, community-built companion app. Not affiliated with mitxela.

![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue) ![Swift 5.9+](https://img.shields.io/badge/Swift-5.9%2B-orange)

## What it does

- Connects to the clock over serial, auto-detects ports, reconnects after reboot
- Configure display modes, colon animation, brightness curve, diagnostics, timezone, and more
- Send text or countdowns to the display
- Poll REST APIs or shell commands and rotate values on the clock
- Edit the 5-point brightness curve with a draggable graph, save custom presets
- Check for firmware and timezone updates, install to the CLOCK USB volume
- Read and write `config.txt` with local backups kept on the Mac
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

Or open `Package.swift` in Xcode and hit Run. Runs unsandboxed, no entitlements needed.

## Serial protocol

Commands are `key = value\r\n` over USB serial at 115200 baud. They take effect immediately but reset on power cycle unless saved to `config.txt`. The app disables NMEA output on connect so commands work reliably, and restores it on disconnect. See the [Mk IV documentation](https://mitxela.com/projects/precision_clock_mk_iv/docs) for the full command reference.

## Dependencies

- [ORSSerialPort](https://github.com/armadsen/ORSSerialPort) (SPM)

## Related

- [Precision Clock Mk IV](https://mitxela.com/projects/precision_clock_mk_iv/docs): official project documentation
- [clock4](https://github.com/mitxela/clock4): hardware design and firmware source

## License

MIT
