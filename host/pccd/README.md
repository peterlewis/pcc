# pccd — Precision Clock bridge daemon

One small daemon that owns the Mk IV's serial port and fans it out to everything
that wants it, simultaneously:

- **chrony** gets a SOF-corrected PPS reference over the SOCK refclock protocol
  → your Mac becomes a stratum-1 NTP source, disciplined by the clock.
- **PCC (the web app)** gets the raw NMEA/telemetry line stream over a localhost
  WebSocket, with config commands flowing back — no Web Serial picker, no port
  contention, and it works in browsers that have no Web Serial at all (Safari,
  Firefox).
- **/health** endpoint lets the app auto-detect the daemon: when pccd is running,
  PCC's CONNECT button transparently uses the bridge instead of Web Serial.

Why a daemon and not a Service Worker: the port is exclusive-open (one owner),
and browsers cannot emit UDP/NTP or feed chrony. A native process can do both
and multiplex the browser on top.

## Timing path

The clock's draft firmware ($PMTXTS with SOF extension, clock4 PR #5) latches
its DWT cycle counter at the true PPS edge *and* at a named USB SOF frame.
pccd asks IOKit for the host arrival time of that same frame
(`GetBusFrameNumberWithTime`), bridges mach → wall time, and computes

    offset = UTC(edge) − host_wall(edge)

with the USB transport jitter (~ms) removed — measured scatter is on the order
of ±70 µs, limited by SOF quantisation, not serial timing. Frame-number deltas
are taken mod 2048 (signed-nearest) and the DWT frequency self-calibrates from
the 1 Hz edge cadence.

## Build

    make            # clang, needs IOKit + CoreFoundation (macOS)

## Run

    ./pccd                          # auto-picks /dev/cu.usbmodem*, dry-run prints offsets
    ./pccd -d /dev/cu.usbmodemXXXX  # explicit device
    ./pccd -s /var/run/chrony.pcc.sock   # feed chrony (default is dry-run)

Flags: `-d <device>` serial device, `-s <path>` chrony SOCK socket path,
`-p <port>` HTTP/WS port (default 4192).

The daemon listens on 127.0.0.1 only. It reconnects automatically when the
clock re-enumerates (unplug, reboot, firmware flash).

## chrony setup

In `/etc/chrony/chrony.conf` (or wherever your chrony keeps it):

    refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4

Start chrony first (it creates the socket), then pccd with `-s` pointing at the
same path. `chronyc sources` should show `#* PCC` once samples flow.

## PCC integration

Nothing to configure. With pccd running, open PCC and press CONNECT — the app
probes `http://127.0.0.1:4192/health` (350 ms budget) and, if the daemon
answers, connects over the WebSocket instead of Web Serial. The daemon injects
a `#PCCD v1 device=<path>` hello so the app can show the real port name.
Multiple tabs can connect at once; commands from any tab go to the clock,
every line from the clock goes to every tab (and to chrony, independently).

Note for Safari: pages served over https cannot open ws://localhost — run PCC
from http://localhost (dev server) or use the packaged app.

## Protocol (WebSocket, text frames)

- daemon → client: `#PCCD v1 device=<path>` once, then every serial line verbatim.
- client → daemon: one command per frame, e.g. `nmea = all`; the daemon appends
  CRLF and writes it to the port. Non-printable characters are dropped.
