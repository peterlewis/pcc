#!/usr/bin/env python3
"""
clock-chrony-bridge — feed a GPS-disciplined Precision Clock Mk IV into chrony.

The clock streams NMEA (and, with `pps = on`, the proprietary $PMTXTS sentence)
over its USB CDC virtual serial port. This daemon reads that stream, pairs each
GPS second boundary with a local system timestamp, and hands the pair to chrony
through its SOCK refclock interface. chrony then disciplines the system clock —
giving a headless box (Raspberry Pi, server, NUC) a local stratum-1-ish time
source with no network connection.

ACCURACY — be honest. There is no hardware PPS wire into the host, so the only
timing signal is *when a sentence arrives over USB*. USB full-speed framing plus
OS scheduling smear that by single-digit milliseconds, and the GPS→host path has
a roughly constant latency on top. So:
  * Expect ~1 ms-class accuracy, not microseconds. Still far better than internet
    NTP for an isolated network, and rock-steady in frequency.
  * Prefer $PMTXTS (enable `pps = on` on the clock): it is emitted right at the
    PPS edge, so its arrival latency is small and consistent. Plain $GxRMC arrives
    hundreds of ms after its second and is only a fallback.
  * The residual constant latency shows up as a fixed offset; null it with the
    `offset` option on chrony's refclock line (see chrony.conf.example), measured
    once against another known-good source.

Cross-platform: the bridge runs anywhere Python + pyserial do. The SOCK feed
works on the platforms chrony runs on (Linux, macOS, BSD). Windows has no chrony.

Usage:
    pip install pyserial
    sudo ./clock-chrony-bridge.py --sock /var/run/chrony.clock.sock
    # auto-detects the clock's serial port; override with --serial /dev/ttyACM0
Test without hardware or chrony:
    ./clock-chrony-bridge.py --stdin --sock /tmp/mock.sock --verbose
"""

import argparse
import ctypes
import os
import platform
import signal
import socket
import sys
import time

MAGIC = 0x534F434B  # "SOCK" — chrony rejects samples without it
STM_VID = 0x0483    # STMicroelectronics — the Mk IV time board's USB vendor id


# --- chrony's `struct sock_sample` --------------------------------------------
# struct sock_sample { struct timeval tv; double offset; int pulse, leap, _pad, magic; }
# Built with ctypes so the layout matches the *local* platform's headers exactly.
# The trap: suseconds_t (tv_usec) is 32-bit on macOS but `long` (64-bit) on
# Linux/BSD, which changes sizeof(struct timeval) and the whole struct.
# time_t is 64-bit on every modern target — including 32-bit Raspberry Pi OS
# Bookworm, which moved to a 64-bit time_t for Y2038 — so tv_sec MUST be c_int64,
# not c_long. (c_long is 4 bytes on 32-bit userspace, which would make the struct
# the wrong size and chrony would reject every sample with "Unexpected length of
# SOCK sample".) suseconds_t is a 32-bit int on macOS, else `long` (4 bytes on
# 32-bit, 8 on 64-bit). ctypes then applies the platform's native alignment, which
# matches the chrony binary compiled on the same machine. The startup check in
# main() prints sizeof(SockSample) so any remaining mismatch is loud, not silent.
_time_t = ctypes.c_int64
_suseconds_t = ctypes.c_int32 if platform.system() == "Darwin" else ctypes.c_long


class _Timeval(ctypes.Structure):
    _fields_ = [("tv_sec", _time_t), ("tv_usec", _suseconds_t)]


class SockSample(ctypes.Structure):
    _fields_ = [
        ("tv", _Timeval),
        ("offset", ctypes.c_double),
        ("pulse", ctypes.c_int),
        ("leap", ctypes.c_int),
        ("_pad", ctypes.c_int),
        ("magic", ctypes.c_int),
    ]


def make_sample(local_t: float, offset: float, leap: int = 0) -> bytes:
    """local_t: system CLOCK_REALTIME seconds when the GPS second was observed.
    offset: true_time - local_t (seconds); chrony reads true = local_t + offset."""
    s = SockSample()
    s.tv.tv_sec = int(local_t)
    s.tv.tv_usec = int(round((local_t - int(local_t)) * 1_000_000))
    if s.tv.tv_usec >= 1_000_000:        # rounding can tip it over
        s.tv.tv_usec -= 1_000_000
        s.tv.tv_sec += 1
    s.offset = offset
    s.pulse = 0          # in-band time sample, not a hardware PPS pulse
    s.leap = leap
    s.magic = MAGIC
    return bytes(s)


# --- NMEA parsing -------------------------------------------------------------
def nmea_checksum_ok(line: str) -> bool:
    if "*" not in line or not line.startswith("$"):
        return False
    body, _, cksum = line[1:].partition("*")
    try:
        want = int(cksum[:2], 16)
    except ValueError:
        return False
    got = 0
    for ch in body:
        got ^= ord(ch)
    return got == want


def parse_pmtxts(line: str):
    """$PMTXTS,<seq>,<epoch>,<subms>,<systick>,<load>,<calerr>,<sincecal>,<temp>,<flags>*CC
    Returns (reference_unix_seconds, leap) or None. The PPS edge IS the second
    boundary, so the reference time is the integer `epoch` exactly (subms is the
    clock's own phase error, irrelevant to host time transfer)."""
    f = line.split("*")[0].split(",")
    if f[0] != "$PMTXTS" or len(f) < 10:
        return None
    try:
        epoch = int(f[2])
        flags = int(f[9], 16)
    except ValueError:
        return None
    if not (flags & 0x1):            # bit0 = data_valid
        return None                  # no usable fix
    return float(epoch), 0


def parse_rmc(line: str):
    """$..RMC,hhmmss(.sss),A/V,...,ddmmyy,... — fallback when $PMTXTS is absent.
    Returns (reference_unix_seconds, leap) or None."""
    f = line.split("*")[0].split(",")
    if len(f) < 10 or not f[0].endswith("RMC"):
        return None
    t, status, date = f[1], f[2], f[9]
    if status != "A" or len(t) < 6 or len(date) != 6:
        return None
    try:
        hh, mm = int(t[0:2]), int(t[2:4])
        sec = float(t[4:])
        day, mon, yr = int(date[0:2]), int(date[2:4]), 2000 + int(date[4:6])
    except ValueError:
        return None
    # UTC calendar -> unix seconds, without touching the local timezone.
    tm = (yr, mon, day, hh, mm, 0, 0, 0, 0)
    try:
        base = calendar_timegm(tm)
    except (ValueError, OverflowError):
        return None
    return base + sec, 0


def calendar_timegm(tm) -> int:
    import calendar
    return calendar.timegm(tm)


# --- serial port discovery ----------------------------------------------------
def find_serial_port():
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    candidates = list(list_ports.comports())
    # Prefer an ST CDC device; fall back to common CDC-ACM / usbmodem names.
    for p in candidates:
        if (p.vid == STM_VID) or ("usbmodem" in (p.device or "")) \
                or ("ttyACM" in (p.device or "")):
            return p.device
    return candidates[0].device if candidates else None


# --- chrony SOCK client -------------------------------------------------------
class ChronySock:
    """Connected SOCK_DGRAM client to chrony's refclock socket. chrony creates and
    listens on the path; we connect and send datagrams. Tolerates chrony not being
    up yet (the socket appears once chronyd starts with the SOCK refclock)."""

    def __init__(self, path: str, log):
        self.path = path
        self.log = log
        self.sock = None

    def _ensure(self) -> bool:
        if self.sock is not None:
            return True
        if not os.path.exists(self.path):
            return False  # chrony hasn't created it yet
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            s.connect(self.path)
            self.sock = s
            self.log(f"connected to chrony SOCK at {self.path}")
            return True
        except OSError as e:
            self.log(f"chrony SOCK connect failed: {e}")
            return False

    def send(self, payload: bytes):
        if not self._ensure():
            return
        try:
            self.sock.send(payload)
        except OSError as e:
            self.log(f"chrony SOCK send failed ({e}); will reconnect")
            try:
                self.sock.close()
            finally:
                self.sock = None


# --- main loop ----------------------------------------------------------------
class Bridge:
    def __init__(self, args):
        self.args = args
        self.chrony = ChronySock(args.sock, self.log)
        self.last_ref = None      # dedupe: one sample per GPS second
        self.running = True

    def log(self, msg):
        if self.args.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)

    def handle_line(self, line: str, recv_t: float):
        line = line.strip()
        if not line.startswith("$") or not nmea_checksum_ok(line):
            return
        parsed = None
        if line.startswith("$PMTXTS"):
            parsed = parse_pmtxts(line)
        elif not self.args.require_pps and "RMC" in line[:7]:
            parsed = parse_rmc(line)
        if parsed is None:
            return
        reference, leap = parsed

        # Plausibility gate: reject garbage years but allow any offset so chrony
        # can step a wildly-wrong clock on first sync.
        if not (1_577_836_800 <= reference <= 4_102_444_800):  # 2020..2100
            self.log(f"implausible reference {reference}, skipped")
            return
        # One sample per second; the first sentence of a second is the freshest.
        # (At a positive leap second the :59/:60 pair can share an integer second
        # and one gets dropped — harmless, chrony tolerates an occasional gap.)
        sec = int(reference)
        if sec == self.last_ref:
            return
        self.last_ref = sec

        offset = reference - recv_t + self.args.offset
        self.chrony.send(make_sample(recv_t, offset, leap))
        self.log(f"ref={reference:.3f} local={recv_t:.3f} offset={offset*1e3:+.2f} ms")

    def run_stdin(self):
        self.log("reading sentences from stdin")
        for line in sys.stdin:
            if not self.running:
                break
            self.handle_line(line, now_realtime())

    def run_serial(self):
        try:
            import serial
        except ImportError:
            print("pyserial is required for serial mode. Install it for THIS interpreter:\n"
                  f"    {sys.executable} -m pip install pyserial\n"
                  "(running under sudo uses a different Python than your shell — install for that one,\n"
                  " or run without sudo: reading /dev/cu.* or /dev/ttyACM* usually doesn't need root)",
                  file=sys.stderr)
            return 2
        while self.running:
            # Re-resolve every reconnect: after a USB re-enumeration the device
            # can move (ttyACM0 -> ttyACM1, a new cu.usbmodem path), and a headless
            # box must follow it rather than retry a stale path forever.
            port = self.args.serial or find_serial_port()
            if not port:
                self.log("no serial port found; retrying in 2 s (is the clock plugged in?)")
                time.sleep(2)
                continue
            try:
                self.log(f"opening {port} @ {self.args.baud}")
                ser = serial.Serial(port, self.args.baud, timeout=2)
            except (OSError, serial.SerialException) as e:
                self.log(f"serial open failed ({e}); retrying in 2s")
                time.sleep(2)
                continue
            try:
                with ser:
                    while self.running:
                        raw = ser.readline()
                        # Stamped at end-of-line, not first byte: the variable-length
                        # sentence tail adds a few ms of jitter that --offset can't fully
                        # cancel. That's within the USB accuracy floor (see README); for
                        # better, the firmware would need to assert a PPS line to the host.
                        recv_t = now_realtime()
                        if not raw:
                            continue                  # read timeout; loop
                        try:
                            self.handle_line(raw.decode("ascii", "ignore"), recv_t)
                        except Exception as e:        # never let one bad line kill us
                            self.log(f"line error: {e}")
            except (OSError, serial.SerialException) as e:
                self.log(f"serial dropped ({e}); reopening")
                time.sleep(1)
        return 0


def now_realtime() -> float:
    # CLOCK_REALTIME is exactly the clock chrony disciplines.
    return time.clock_gettime(time.CLOCK_REALTIME)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Feed a Precision Clock Mk IV into chrony via SOCK.")
    ap.add_argument("--sock", default="/var/run/chrony.clock.sock",
                    help="chrony refclock SOCK path (must match chrony.conf)")
    ap.add_argument("--serial", default=None, help="serial device (auto-detect if omitted)")
    ap.add_argument("--baud", type=int, default=115200, help="baud (ignored by USB CDC, but pyserial wants it)")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="seconds added to every sample to cancel constant GPS→host latency")
    ap.add_argument("--require-pps", action="store_true",
                    help="use only $PMTXTS (ignore RMC); needs `pps = on` on the clock")
    ap.add_argument("--stdin", action="store_true", help="read sentences from stdin (for testing)")
    ap.add_argument("--verbose", action="store_true", help="log each sample to stderr")
    args = ap.parse_args(argv)

    # Make the wire layout loud: chrony silently drops samples of the wrong size.
    sz = ctypes.sizeof(SockSample)
    print(f"clock-chrony-bridge: sock_sample = {sz} bytes "
          f"(time_t {ctypes.sizeof(_time_t)}, suseconds_t {ctypes.sizeof(_suseconds_t)})",
          file=sys.stderr)
    if sz != 40:
        print("WARNING: sock_sample is not the 40 bytes expected on a modern 64-bit-time_t "
              "system. If chrony logs 'Unexpected length of SOCK sample', this platform's "
              "struct timeval differs — adjust _time_t/_suseconds_t at the top of this file.",
              file=sys.stderr)

    bridge = Bridge(args)

    def stop(*_):
        bridge.running = False
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    if args.stdin:
        bridge.run_stdin()
        return 0
    return bridge.run_serial()


if __name__ == "__main__":
    sys.exit(main())
