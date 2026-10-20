# pccd v0.8.0

Two things the daemon kept and one it did not. The flight recorder has logged every satellite's C/N₀
once a minute since v0.5, but the app only drew C/N₀ over time from what an open tab had seen; the
position scatter had no record behind it at all. This release records the fix and hands both to the
app, so SIGNAL and POSITION reach back through the night whether or not a tab was open. It also finds
the clock's own USB drive and serves `config.txt` from it: the app reads the clock's real config the
moment it connects, with no file picker, in any browser — and writes it back the same way.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW** (SHA-256 verified,
self-tested, atomic swap, reconnect). First install: download the tarball for your platform below and
run `./install-service.sh`.

## Added

- **P rows**: the fix every 10 s while the clock has one — `P,<epoch>,lat,lon,alt,hdop,pdop,vdop,fixtype,used`
  — beside the T and S rows in the daily files. About 430 KB a day.
- **`GET /history?series=pos`**: those rows back, the first of each bucket, as
  `t,lat,lon,alt,hdop,pdop,vdop,fix,used`. The app's POSITION scatter, DOP and continuity strips and
  SIGNAL's C/N₀ over time now offer **6H** and **24H** windows that read the recorder (`sats` carries the
  per-satellite C/N₀ already); where the record is younger than the window the chart says how much is there.
- **`/drive`**: the clock's USB volume. The daemon looks every 5 s for the mounted CLOCK drive
  (`/Volumes/CLOCK` on macOS; a mount named `CLOCK` in `/proc/mounts` on Linux) and reports it in `/health`
  (`"drive"`). `GET /drive` lists it; `GET /drive?file=config.txt` streams a file with its mtime;
  `POST /drive?file=config.txt` rewrites it — `config.txt` only, from an allowed Origin only (the WebSocket's
  list), temp file + rename so the clock never sees a half-written file. `PCCD_DRIVE=<dir>` stands in for the
  volume during development.
- **`/health` → `history.retain`**: the `-R` window in days, so the app's ARCHIVE caption states what is on
  disk and how long it is kept (and its size) from one source. The app adds a **30D** range.

## Changed

- An HTTP request of any method is parsed (only `GET` was before); `OPTIONS` answers CORS preflights. The
  per-client request buffer grows to 64 KB to hold a posted `config.txt`.
- Browsers may read the HTTP endpoints cross-origin only from the app's own origins (the WebSocket's list:
  pcc.ptrl.ws, peterlewis.github.io, loopback). They answered `Access-Control-Allow-Origin: *` before, which
  would have let any open page read `config.txt` and the recorded position. curl and same-origin pages are
  unaffected.
- Self-test covers the GGA/GSA position parse, the P row, the `pos` readout, drive-name hygiene and the CORS gate.
