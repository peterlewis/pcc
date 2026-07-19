# pccd v0.6.0

The daemon can now **track the web app from GitHub Pages between releases**. Web-only fixes ship to
Pages on every push, but until now only reached a locally-installed daemon when a release was cut.
A bundled pccd can pull those straight from Pages and serve them from an overlay dir — **without
restarting, so timekeeping never pauses** — with the bundled app kept intact as the fallback.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW** (SHA-256 verified,
self-tested, atomic swap, reconnect). First install / pre-v0.4.1: download the tarball for your
platform below and run `./install-service.sh`.

## New

- **Track the app from Pages.** Click **REFRESH APP FROM PAGES** in DEVICE → UPDATES, or run
  `pccd --web-refresh`, and the daemon pulls the latest web app from Pages, verifies it, and swaps it
  in live — no relaunch, no dropped serial/chrony feed. The bundled app stays put as fallback. Daemon
  *features* (new endpoints) still come via UPDATE NOW; this tracks the app only.
- **Optional automatic tracking.** Set `PCCD_WEB_TRACK=1` in the daemon's environment for a check every
  6 hours. **Off by default** — a time server shouldn't reach out to the internet unless you ask it to.
- **Verified and delta-fetched.** Pages ships an `app-manifest.sha256` over the deployed tree; the
  daemon re-validates every path, downloads only the files that changed (a one-line UI fix doesn't
  re-pull the 12 MB timezone map), and gates the swap on `shasum -c`. Any mismatch refuses and leaves
  the install untouched. Trust rests on HTTPS to your own Pages origin — there is no signature, which
  is why it is opt-in.
- Bundles the latest app, including this cycle's **Allan-deviation** fix (the σ_y(τ) ladder now
  populates on a real clock) and the reworked **Sky satellites control bar** (single SPAN control, the
  dead WINDOW group removed).

## Hardened

The whole refresh path was built around a stratum-1 invariant — **never block the poll loop on the
network** — and then put through an adversarial C review (14 findings raised, 6 confirmed, all fixed):

- Every fetch (manual button included) runs in a **forked worker**; the single-threaded loop never
  waits on I/O. The worker drops every inherited fd first (listener / tty / chrony / client sockets).
- The manifest parser rejects embedded-NUL paths, traversal (`..`), absolute paths, and over-long or
  over-count listings; fetches are size-capped (per-file 25 MiB, 64 MiB aggregate).
- A persisted overlay is **re-verified against its manifest at boot** before it is trusted; a
  corrupted or tampered overlay is ignored and the bundled app is served.
- `--update` kills and reaps any in-flight refresh worker before swapping, so a release can't be
  shadowed by a stale overlay. The swap can't 404 a client mid-rename (it falls back to the bundle).

## Assets

Each tarball is the `pccd` binary next to a copy of the PCC web app (open `http://localhost:4192` in
any browser after install). `SHA256SUMS` is attached. macOS universal; Linux x86-64 and aarch64 static.
