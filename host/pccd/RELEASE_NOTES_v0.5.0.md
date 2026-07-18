# pccd v0.5.0

The daemon becomes a **flight recorder**, the TIMING room gains an interactive view of the signal
purification that can run on your clock's **real captured samples**, and the sky views grow **long
satellite trails**. Plus a security hardening pass over the HTTP surface and an all-new copy voice.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW** (SHA-256 verified,
self-tested, atomic swap, reconnect). First install / pre-v0.4.1: download the tarball for your
platform below and run `./install-service.sh`.

## New

- **Flight recorder.** pccd continuously records timing (offset / jitter / drift / die-temp, one row
  per prefilter group) and a sky snapshot per 60 s to plain daily CSV files next to the binary
  (`-H dir`, default on; `-R days` retention, default 365). Served back decimated over `GET /history`;
  `/health` reports the archive span. The PCC **ARCHIVE** panels chart it — real, timestamped, sourced,
  viewable even in Standby. Real-only by construction: the daemon never sees a simulation.
- **SIGNAL PATH — the prefilter, made visible and adjustable.** A new panel in TIMING runs the real
  `pf_push` math (MAD 3σ gate over a 64-sample window, 5 µs floor, trimmed-mean batches of 8) and shows
  the raw noise collapse into the clean disciplined signal as you move five knobs — each marked with
  its recommended value. The current settings emit the matching `chrony.conf`.
- **Run it on your clock's REAL samples.** A `MODEL | REAL` toggle. In REAL, the panel fetches this
  clock's actual pre-gate offset samples from the daemon's new in-memory ring (`GET /raw`) and runs the
  identical prefilter — the knobs re-filter your own data.
- **Long satellite trails.** Sky/Globe/Map trail windows now go `45M · 1H · 3H · 6H · 12H · 24H`. In
  simulation the whole track is computed from the orbit model (no waiting): full ground tracks on Map
  and Globe, and a long-term coverage **heatmap** in the polar Sky plot, coloured per constellation.
- **New copy voice** across the app — bench-instrument register, units and config keys preserved.

## Fixed / hardened

- HTTP surface hardened before this public release (7 findings from an adversarial C review, all
  fixed): a `/history` day-loop denial-of-service (an unbounded `to=` could freeze the single-threaded
  daemon — now clamped to the retention window, returns instantly); an out-of-bounds heap read in the
  history streamer; exact-key query parsing (`?min=` no longer hijacks `?n=`); `FD_CLOEXEC` on the log
  file; and a slow-loris client-slot reaper.
- The raw-sample ring clears the instant the clock unplugs, so `/raw` and `/health` go honest.
- chrony refclock retuned for thermal chase (poll 4 / filter 8 / corrtimeratio 10 in the example conf).
- Docked menu-bar clock scales to the header's free width and collapses cleanly on mobile.

## Assets

Each tarball is the `pccd` binary next to a copy of the PCC web app (open `http://localhost:4192` in
any browser after install). `SHA256SUMS` is attached. macOS universal; Linux x86-64 and aarch64 static.
