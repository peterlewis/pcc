Hardening from a comprehensive review of the v0.4 → v0.4.1 arc. No behaviour change to a healthy chrony feed — everything here is defence in depth. **This is the first release a v0.4.1 daemon can pull automatically** (DEVICE → UPDATES → UPDATE NOW, or `./pccd --update`).

## Daemon
- **Pinned `PATH` before shelling out.** Self-update runs `curl`/`tar`/`shasum` via the shell; the daemon (typically root) now resolves them only from `/usr/bin:/bin:/usr/sbin:/sbin`, so a binary planted in a writable early-`PATH` dir can't be run as root.
- **Bounded network fetches.** Both `curl` calls carry `--connect-timeout` / `--max-time`, so a stalled download can't wedge the single-threaded daemon (and its chrony fan-out).
- **The planted `install-service.sh` tracks releases.** A self-update now refreshes the exe-adjacent installer, so re-running it later (repair / upgrade / `--uninstall`) uses the current script, not the one you first installed with.

## Service installer
- **Safe to re-run in place.** `install-service.sh` stages the new bundle before touching the live one, so re-running the copy it plants at `/usr/local/pcc` is now a repair-in-place instead of deleting the web app and stopping the service.

## App (DEVICE → UPDATES)
- An update that's interrupted (daemon killed mid-download) is reported honestly instead of "UPDATED"; the panel re-checks the version over `/health`.
- Guards against double-clicking UPDATE NOW, the panel vanishing mid-update, and a bogus "clock lost" while the bridge briefly drops; a live clock session reconnects on its own; a wedged update times out instead of hanging.
- The TIMING room no longer blanks while scrubbing recorded data.

## Release tooling
- Releases are cut by CI from the tag's own code (`--verify-tag`), and local builds stamp a `-dirty` suffix so `/health`'s version never claims a clean commit it wasn't built from.

---
`SHA256SUMS` is attached. Every binary answers `./pccd -t`. On v0.4 or v0.3? Update once by hand — `curl … | tar xz && cd pcc && sudo ./install-service.sh` — then self-update works from here on.
