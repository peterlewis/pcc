# clock-chrony-bridge

Turn a GPS-disciplined **Precision Clock Mk IV** into a local NTP time source by
feeding it to [chrony](https://chrony-project.org/). The bridge reads the clock's
USB serial stream, pairs each GPS second with a system timestamp, and hands the
pair to chrony through its `SOCK` refclock interface. chrony disciplines the
system clock; a headless box (Raspberry Pi, server, NUC) then has stratum-1-ish
time with **no network connection**.

```
 Mk IV ──USB(NMEA + $PMTXTS)──▶ clock-chrony-bridge.py ──SOCK datagram──▶ chronyd ──▶ system clock ──▶ NTP clients
```

## Honest accuracy

There is **no hardware PPS wire into the host** — the only timing signal is *when
a sentence arrives over USB*. USB full-speed framing and OS scheduling smear that
by single-digit milliseconds, with a roughly constant latency on top. So:

- Expect **~1 ms-class** accuracy, not microseconds. Frequency is rock-steady;
  it's the absolute offset that's limited.
- This still beats internet NTP on an isolated LAN, and gives you a real local
  reference clock.
- **Enable `pps = on` on the clock and run the bridge with `--require-pps`.** The
  `$PMTXTS` sentence is emitted right at the PPS edge, so its latency is small and
  consistent. Plain `$GxRMC` arrives hundreds of ms after its second — usable, but
  the worse marker.
- The residual *constant* latency just biases the offset; null it with chrony's
  `offset` option (see Calibration).

> On **macOS** you'll usually just run the Precision Clock app's built-in NTP
> server instead — it already owns the serial port and serves time from the GUI.
> This bridge's home is a **headless Linux / Raspberry Pi**.

## Requirements

- Python 3.3+ and `pyserial` (`pip install pyserial`).
- chrony (Linux: `apt/dnf install chrony`; macOS: `brew install chrony`).
- A 64-bit-`time_t` OS — any 64-bit system, plus 32-bit Raspberry Pi OS Bookworm+
  (which uses 64-bit `time_t`). The bridge logs `sock_sample = 40 bytes` at startup;
  if that's ever not 40, your platform's `struct timeval` differs and the top-of-file
  `_time_t`/`_suseconds_t` need adjusting.

## Setup

1. **Enable `$PMTXTS`** on the clock — put `pps = on` in its `config.txt`, eject.
2. **Tell chrony about the refclock** — append [`chrony.conf.example`](chrony.conf.example)
   to your `chrony.conf`, then restart chrony. chrony creates the socket.
3. **Install & run the bridge**:
   ```sh
   pip install pyserial
   sudo cp clock-chrony-bridge.py /usr/local/bin/ && sudo chmod +x /usr/local/bin/clock-chrony-bridge.py
   # Linux service:
   sudo cp systemd/clock-chrony-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now clock-chrony-bridge
   # macOS service: see launchd/ws.ptrl.clock-chrony-bridge.plist
   ```
   Or run it in the foreground to watch it work:
   ```sh
   sudo ./clock-chrony-bridge.py --require-pps --verbose
   ```
4. **Verify**: `chronyc sources -v` should list the `GPS` refclock; `chronyc
   sourcestats` shows its offset/jitter; `chronyc tracking` shows the disciplined
   clock.

## Calibration (optional, for the last millisecond)

The constant GPS→host latency makes the clock settle slightly *slow*. To remove it:

1. Run for a few minutes, then read the settled offset: `chronyc sourcestats`.
2. Put its **negative** into the refclock line's `offset` (in `chrony.conf`), or
   pass `--offset <seconds>` to the bridge. Restart and re-check.

A few ms of residual bias is fine for almost everything; only bother if you care.

## Notes & gotchas

- **One owner of the serial port.** The bridge, the macOS app, and the web tools
  can't all read the same `/dev/...` at once. Pick one consumer per port.
- **Port auto-detect** prefers an ST-vendor CDC device; override with
  `--serial /dev/ttyACM0` (Linux) / `--serial /dev/cu.usbmodemXXXX` (macOS).
- **Permissions**: the bridge needs to read the serial device and write the
  chrony socket — run as root, or use a `dialout`-group user with a socket path
  it can write.
- **Windows** has no chrony, so the `SOCK` feed doesn't apply there.

## Test

No hardware or chrony needed:

```sh
python3 test_bridge.py        # struct layout, offset math, parsing, gating, dedupe
# or feed it live and watch, pointing at a throwaway socket:
cat /dev/cu.usbmodemXXXX | ./clock-chrony-bridge.py --stdin --sock /tmp/x.sock --verbose
```
