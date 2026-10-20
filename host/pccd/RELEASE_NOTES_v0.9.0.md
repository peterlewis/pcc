# pccd v0.9.0

The flight recorder follows each OS's conventions, records the clock's own phase, and exports to
the formats timing tools read.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW**. First install:
download the tarball for your platform below and run `./install-service.sh`.

## Added

- **C rows, every second**: `C,<epoch>,<dwt_ticks>,<residual_ns>` from `$PMTXTS`. `dwt_ticks` is the
  core cycle count over the second minus 80,000,000 (12.5 ns per tick): the free-running crystal's
  frequency error, the quantity the firmware's ADEV integrates. `residual_ns` is the disciplined
  clock's position at the PPS edge, centred and folded across the 1 ms boundary. About 0.5 MB a day
  compressed. `GET /history?series=phase` reads them back.
- **Exports**, streamed, every row in the window: `series=phase&format=stable32` (`MJD y`, Stable32
  frequency data with time tags), `series=timing&format=chrony` (chrony `refclocks.log` layout), and
  `format=csv` for any series.

## Changed

- **History lives in the OS data directory**: `/Library/Application Support/Precision Clock Companion/history` (macOS
  service), `/var/lib/pcc/history` (Linux service, systemd `StateDirectory=pcc`), or the user's
  equivalent when run by hand. Files from `history/` next to the binary move there on first start.
  Uninstalling the service leaves them.
- **Days older than 7 are gzipped** by the system `gzip` in a niced background process and read back
  through `gzip -dc`. A year with a clock streaming is about 275 MB.
- Self-test covers the data-directory rules, the move, the C row and its 1 ms fold, each export
  format, and the gzip round trip.
