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

## Install (prebuilt, from GitHub Releases)

macOS (universal — Apple Silicon + Intel):

    curl -L -o pccd https://github.com/peterlewis/pcc/releases/latest/download/pccd-macos-universal
    chmod +x pccd

Linux (static musl — runs on any distro; x86_64 and aarch64):

    curl -L -o pccd https://github.com/peterlewis/pcc/releases/latest/download/pccd-linux-$(uname -m)
    chmod +x pccd

`SHA256SUMS` is attached to each release. Every binary answers `./pccd -t`
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
`-n` dry-run, `-v` verbose, `-r` raw (bypass the sample prefilter),
`-t` self-test, `-T` frame-clock probe (macOS).

The daemon listens on 127.0.0.1 only. It reconnects automatically when the
clock re-enumerates (unplug, reboot, firmware flash).

## Timing path — what accuracy to expect

The clock's draft firmware ($PMTXTS with SOF extension, clock4 PR #5) latches
its DWT cycle counter at the true PPS edge *and* at a named USB SOF frame.

- **macOS**: pccd anchors the frame clock to the host clock and computes
  `offset = UTC(edge) − host_wall(edge)` with USB transport jitter removed.
  Since v0.2 the anchor is a **microframe edge-hunt** — spin-reading
  `GetBusMicroFrameNumber` (the 125 µs MFINDEX counter) until it increments
  pins a boundary to within the bracketed width of one call, a few µs; it
  agrees with the driver-supplied `GetBusFrameNumberWithTime` anchor to
  −2…−8 µs on bench hardware (`pccd -T` prints the comparison live).
  Samples log as `[sof]`.
- **Linux**: no userspace API names a SOF frame, so pccd reconstructs the
  anchor by **SOF-clock regression** (v0.3) — the device's SOF counter is
  locked to the host's 1 ms frame clock, so regressing sentence-arrival-time
  against the frame number (both already in `$PMTXTS`) over a sliding window
  recovers host-time-of-frame; the random USB delivery jitter averages out in
  the fit. `PPS = fit(sof_frame) + (dwt_pps−dwt_sof)/f_dwt`. This is the macOS
  correlation in pure userspace — no root, no usbmon, no kernel module. Samples
  log as `[reg]` once the fit is warm (~40 s), `[arr]` (plain arrival stamp)
  before that. A constant delivery-latency bias remains — trim with `-o`. The
  macOS build runs the regression beside the IOKit anchor and prints its error
  vs that hardware truth at exit (`SOF-regression vs IOKit anchor: … jitter …`).

### Sample prefilter (v0.2, both platforms)

Raw per-second offsets carry scatter plus rare large outliers (USB retries,
IRQ preemption). By default pccd conditions the stream before chrony sees it:
samples more than 3 robust-sigma (MAD over the last 64, 5 µs floor) from the
running median are rejected outright, and each 8 accepted samples are sent as
ONE trimmed-mean sample stamped at the group's centre time. Scatter drops
~√8 and chrony stops chasing individual samples. `-r` bypasses the filter
(raw sample-per-second, the v0.1 behaviour); rejects and group emissions show
under `-v`. The filter vectors run in `pccd -t`.

To smooth the tracking further, let chrony average more per update in
chrony.conf, and correct more gently:

    refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4 poll 6 filter 128
    corrtimeratio 30

## Linux accuracy — considerations (macOS-first, for now)

Development has focused on macOS, where IOKit's `GetBusFrameNumberWithTime`
pairs a SOF frame number with a hardware host timestamp in one call — that is
the whole trick behind the ~±70 µs result. Linux never plumbed its equivalent
kernel primitive (`usb_get_current_frame_number()`) through to userspace: a
[`USBDEVFS_GETFRAMENUM` patch was proposed in 2007](https://www.spinics.net/lists/linux-usb-devel/msg04458.html)
and died unmerged, current
[uapi headers](https://github.com/torvalds/linux/blob/master/include/uapi/linux/usbdevice_fs.h)
carry no frame ioctl, and the URB `start_frame` field is populated for
isochronous transfers only — which CDC ACM doesn't have. Hence today's
arrival-timestamp fallback.

Parity looks reachable regardless. The firmware already emits everything the
host needs (`$PMTXTS` names a SOF frame and gives DWT cycle offsets from it to
the PPS edge); what's missing is host-side frame↔time pairing, and there is a
ladder of ways to approximate it:

| Tier | Mechanism | Expected accuracy | Needs |
|---|---|---|---|
| 0 | **Min-filter / prefilter** — ✅ **shipped (v0.2)**. Delivery latency is one-sided, and chrony's own refclock `filter` is a median that [handles one-sided distributions poorly](https://chrony-users.chrony.tuxfamily.narkive.com/R927UEDz/chrony-configuration-with-gps-direct-phc), so pccd rejects outliers and trims-means upstream of the SOCK feed. | 0.1–1 ms, host-dependent | nothing |
| 2 | **SOF-clock regression** — ✅ **shipped (v0.3)**. Regress arrival-time against the firmware's `sof_frame` (locked to the host's 1 ms frame clock), evaluate at the PPS frame, add the DWT cycle offset. The macOS correlation in pure userspace — no privileges. Turned out to *not* need tier 1 underneath. Accuracy validated against the macOS IOKit anchor (see the timing section). | ~tens of µs (measured on macOS) | nothing |
| 1 | **usbmon arrival stamping** — the [usbmon binary API](https://docs.kernel.org/usb/usbmon.html) timestamps the bulk completion carrying `$PMTXTS` in the USB core, before cdc_acm/tty/scheduler. Now an *optional refinement*: it cleans the regression's input (less jitter to average out), not a prerequisite. | tightens tier 2 | root, `CONFIG_USB_MON` |
| 3 | **debugfs MFINDEX anchor** (optional) — edge-detect the 125 µs microframe counter via [xHCI debugfs](https://github.com/torvalds/linux/blob/master/drivers/usb/host/xhci-debugfs.c) to pin tier 2's static bias directly; unstable ABI, feature-detect only. | removes tier 2's bias | root + debugfs |
| 4 | **Out-of-tree kernel module** returning an atomic (frame, timestamp) pair — the exact macOS semantic. Only worth it if tiers 2–3 measurably fall short. | µs-class | DKMS |

Working notes for whoever picks this up:

- Naive arrival stamping is wildly host-controller dependent — measured
  [anywhere from ~2 µs to 350 µs to milliseconds](https://digitalnigel.com/wordpress/?p=3449)
  across machines — so measure a given host before assuming the worst; `-o`
  trims the constant part.
- usbmon records use `CLOCK_REALTIME` at µs resolution (the very clock chrony
  is steering — handle steps), and its device nodes are deliberately
  root-only.
- The frame number the device sees in SOF packets and the host's MFINDEX>>3
  may differ by a small fixed offset depending on controller/hub topology —
  calibrate once empirically rather than assuming equality.
- Don't bother adding an ISO endpoint to the firmware just to harvest URB
  `start_frame`, and there is no FTDI-style latency timer to tune on native
  CDC ACM.
- Validate every tier against the macOS SOF result with the same clock before
  claiming a number.

## chrony setup

The minimal line, in `/etc/chrony/chrony.conf` (Linux) or
`/opt/homebrew/etc/chrony.conf` (macOS, Homebrew chrony):

    refclock SOCK /var/run/chrony.pcc.sock refid PCC precision 1e-4

Use `precision 1e-2` on Linux (arrival-mode samples). Start chronyd first (it
creates the socket), then pccd with `-s` pointing at the same path.

For a production stratum-1 server, [`chrony.conf.example`](chrony.conf.example)
in this directory is a complete, commented config: PCC steers alone (`prefer`),
an internet pool provides seamless fallback and a falseticker jury, the LAN is
served (with rate-limiting), and the v0.2 smoothing (`poll 6 filter 128`,
`corrtimeratio 30`) is applied. Copy the parts you need.

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
