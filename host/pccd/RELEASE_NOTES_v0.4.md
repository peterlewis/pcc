**pccd** owns the Precision Clock Mk IV's serial port once and shares it: connect the clock from a browser (no port contention, no picker), and feed **chrony** so your machine becomes a stratum-1 time source.

## New in v0.4 — pccd updates itself
The app now checks GitHub for a newer pccd and, when it finds one, offers **UPDATE NOW** in DEVICE → UPDATES. One click asks the running daemon to download the latest release, verify it, replace itself, and relaunch — the app reconnects on its own. No re-download, no manual `curl`, no losing your chrony feed.

It's deliberately careful:
- **Verified before anything is touched.** The new binary must pass its own self-test *and* be strictly newer, and the tarball is checked against `SHA256SUMS`. Any failure leaves the current install exactly as it was.
- **Relaunches in place.** `execv` keeps the same PID, so a launchd/systemd service keeps tracking the job — no restart gap, no KeepAlive dependency. Live serial data is never interrupted longer than the swap.
- **Won't touch a dev setup.** Self-update only fires for a real downloaded tarball; a `-w` / source checkout is left alone (the app shows the manual command instead).

You can also run it from the shell: `pccd --update` (and `pccd --version`, `pccd --self-update-dry`).

Prefer to do it by hand, or updating from v0.3? The one-liner still works:
```
curl -L <asset-url> | tar xz && cd pcc && ./pccd
```

## Also in v0.4 — run it always-on
Each tarball now ships `install-service.sh`. One command turns pccd into a boot-time service that restarts if it dies, serves the app at `http://localhost:4192`, and is ready to feed chrony as a stratum-1 source:
```
cd pcc && sudo ./install-service.sh          # macOS LaunchDaemon or Linux systemd
```
It installs to a fixed `/usr/local/pcc` with no `-w`, so the **service updates itself** — UPDATE NOW / `pccd --update` swap the binary in place and launchd/systemd keep the same PID. `sudo ./install-service.sh --uninstall` removes it.

## Also in v0.4
- **`FD_CLOEXEC` on the long-lived sockets** — the listener, serial tty, chrony socket, and client connections no longer leak into the `curl`/`tar` helpers or across the self-update relaunch.
- `/health` now reports `updatable` and `platform`; releases are cut by CI on a version tag.

`SHA256SUMS` is attached. Every binary answers `./pccd -t`. macOS binary is unsigned — the `curl | tar` one-liner avoids the Gatekeeper quarantine a browser download would attach.
