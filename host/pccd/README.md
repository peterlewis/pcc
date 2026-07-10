# pccd — Precision Clock bridge daemon (macOS + Linux)

One small daemon that owns the Mk IV's serial port and fans it out to everything
that wants it, simultaneously:

- **chrony** gets the clock's PPS over the SOCK refclock protocol
  → your machine becomes a stratum-1 NTP source, disciplined by the clock.
- **PCC (the web app)** gets the raw NMEA/telemetry line stream over a localhost
  WebSocket, with config commands flowing back — no Web Serial picker, no port
  contention, and it works in browsers that have no Web Serial at all (Safari,
  Firefox).
- **/health** endpoint lets the app auto-detect the daemon: when pccd is running,
  PCC's CONNECT button transparently uses the bridge instead of Web Serial.

Why a daemon and not a Service Worker: the port is exclusive-open (one owner),
and browsers cannot emit UDP/NTP or feed chrony. A native process can do both
and multiplex the browser on top.

## Install

Prebuilt macOS + Linux binaries land on this repository's Releases page once
the first release (v0.1) is published; until then, build from source below —
it is a single C file with no dependencies. Every binary answers `./pccd -t`
(SHA-1 / RFC 6455 handshake self-test) with `self-test OK`.

Note (macOS): release binaries are unsigned. Fetching with `curl` avoids the
browser quarantine flag; if downloaded with a browser instead, run
`xattr -d com.apple.quarantine pccd` once.

Note (Linux): reading the serial device usually needs membership of the
`dialout` (Debian/Ubuntu) or `uucp` (Arch) group, or a udev rule.

## Build from source

    make            # clang/gcc; IOKit+CoreFoundation on macOS, no deps on Linux
    make install    # -> /usr/local/bin/pccd

`make` runs the self-test after compiling.

## Run

    ./pccd                          # auto-picks the device, dry-run prints offsets
    ./pccd -d /dev/cu.usbmodemXXXX  # explicit device (macOS)
    ./pccd -d /dev/ttyACM0          # explicit device (Linux)
    ./pccd -s /var/run/chrony.pcc.sock   # feed chrony (default is dry-run)

Auto-pick looks for `/dev/cu.usbmodem*` on macOS, and
`/dev/serial/by-id/*STM32*` then `/dev/ttyACM*` on Linux.

Flags: `-d <device>` serial device, `-s <path>` chrony SOCK socket path,
`-p <port>` HTTP/WS port (default 4192), `-o <secs>` fixed offset trim,
`-n` dry-run, `-v` verbose, `-t` self-test.

The daemon listens on 127.0.0.1 only. It reconnects automatically when the
clock re-enumerates (unplug, reboot, firmware flash).

## Timing path — what accuracy to expect

The clock's draft firmware ($PMTXTS with SOF extension, clock4 PR #5) latches
its DWT cycle counter at the true PPS edge *and* at a named USB SOF frame.

- **macOS**: IOKit's `GetBusFrameNumberWithTime` places that same frame on the
  host clock in hardware, so pccd computes `offset = UTC(edge) − host_wall(edge)`
  with USB transport jitter removed — measured scatter ~±70 µs. Samples log as
  `[sof]`.
- **Linux**: no userspace API names a SOF frame, so pccd stamps the $PMTXTS
  *arrival* instead. The sentence is emitted within ~2 ms of the edge; accuracy
  is a few ms, slightly late-biased (trim with `-o`, e.g. `-o 0.003`). Samples
  log as `[arr]`. Still far better than internet NTP for a LAN.

## chrony setup

In `/etc/chrony/chrony.conf` (Linux) or `/opt/homebrew/etc/chrony.conf`
(macOS, Homebrew chrony):

    refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4

Use `precision 1e-2` on Linux (arrival-mode samples). Start chronyd first (it
creates the socket), then pccd with `-s` pointing at the same path.

**Permissions requisite:** chronyd creates the socket root-owned with no write
bit for others, so an unprivileged pccd gets `PERMISSION DENIED` (it prints
this once and keeps retrying). Either

    sudo chmod 666 /var/run/chrony.pcc.sock     # after every chronyd (re)start

or run pccd itself as root. **Beware: every chronyd restart (including config
changes via ChronyControl) recreates the socket root-only**, so the chmod must
be repeated — the durable setup is pccd as a root LaunchDaemon:

    sudo make install
    sudo cp is.peterlew.pcc.d.plist /Library/LaunchDaemons/
    sudo launchctl load -w /Library/LaunchDaemons/is.peterlew.pcc.d.plist

(stop any user-run ./pccd first — the serial port is exclusive-open; logs land
in /var/log/pccd.log). Without a writable socket, chrony silently falls back to any
`local stratum N` directive and *looks* synced (refid `7F7F0101`) while
free-running — check `chronyc tracking` shows refid `PCC`, not `7F7F0101`.

`chronyc sources -v` should show `#* PCC` once samples flow.

On macOS, also disable the system's own time sync so it doesn't fight chrony:
System Settings → General → Date & Time → turn off "Set time and date
automatically".

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

## Releasing (maintainer note)

Binaries are built locally and attached to a GitHub release:

    # macOS universal
    clang -O2 -Wall -Wextra -arch arm64 -arch x86_64 -o dist/pccd-macos-universal pccd.c \
      -framework IOKit -framework CoreFoundation
    # Linux static (per arch, via Docker)
    docker run --rm --platform linux/arm64 -v "$PWD":/src:ro -v "$PWD/dist":/dist alpine:3.20 \
      sh -c 'apk add -q gcc musl-dev && gcc -O2 -static -o /dist/pccd-linux-aarch64 /src/pccd.c && /dist/pccd-linux-aarch64 -t'
    docker run --rm --platform linux/amd64 -v "$PWD":/src:ro -v "$PWD/dist":/dist alpine:3.20 \
      sh -c 'apk add -q gcc musl-dev && gcc -O2 -static -o /dist/pccd-linux-x86_64 /src/pccd.c && /dist/pccd-linux-x86_64 -t'
    (cd dist && shasum -a 256 pccd-* > SHA256SUMS)
    gh release create pccd-v0.1 dist/pccd-* dist/SHA256SUMS --title "pccd v0.1" --notes "..."
