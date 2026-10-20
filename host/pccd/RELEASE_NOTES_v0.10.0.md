# pccd v0.10.0

pccd keeps the clock's full stream: every line it sends and every command written to it, as
received. The app's REVIEW can replay any moment of the last 30 days through the same parser as a
live connection, and the record is plain NMEA for any GNSS tool.

Daemons on v0.4.1+ update in place: **DEVICE → UPDATES → UPDATE NOW**.

## Added

- **The full stream**: `stream/YYYY-MM-DDTHH.nmea` in the recorder directory, one file per UTC hour,
  `<epoch_ms> <line>` per received line and `<epoch_ms> > <command>` per command (from an app or
  pccd's own `pps = on`). Closed hours are gzipped; `-F <days>` sets retention (default 30, `0` off).
  About 9 MB a day compressed.
- `GET /history?series=stream&from=E&to=E`: the stream as kept, at most 24 h a request (REVIEW's source).
  `&format=nmea`: plain NMEA download over any window in the retention.
- `/health` → `history.stream`: first hour, hours on disk, bytes, retention.

## Changed

- Every `/history` answer (the stream, an export, the decimated rows) now comes from a detached child
  process, so a long read never pauses the timing loop. Before, ARCHIVE · ALL over 80 gzipped days held
  it for about half a second on a Mac, an 80-day chrony export for about a second, and a Pi several
  times longer; past about a second the chrony feed stalls and the SOF timing path rejects samples.
- Self-test covers the stream: hourly files, command marking, the read window, gzip of closed hours,
  both read modes and the `/health` summary.
