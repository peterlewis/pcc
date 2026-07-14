A correctness release. **If you run pccd for chrony, update — v0.4 could silently lose your stratum-1 source.**

## The clock's PPS stream is the daemon's, not the browser's
pccd feeds chrony from `$PMTXTS`, which the firmware only emits while `pps = on`. But pccd never asserted it — the *web app* did, on connect, and sent `pps = off` again on disconnect. The clock's config default is `pps = off` too. The result: your machine's stratum-1 source only existed **while a browser tab was open and connected to it**, and closing that tab quietly ended it. Caught in the wild after 7.3 hours of silent fallback to internet NTP.

- **pccd now asserts `pps = on` itself** on every serial open, and re-asserts if nothing arrives for 60 s — so it self-heals a clock reboot, a firmware reflash, or any client that switches the stream off behind its back.
- **The app no longer sends `pps = off`.** That stream isn't the app's alone; over the bridge, the daemon is feeding chrony from it.

Nothing you run needs to change — the feed just stops depending on a browser being open.

## Self-update could not see a patch release
`ver_cmp` compared only MAJOR.MINOR, so `0.4.1` read as equal to `0.4`: the daemon would have answered "already current" and refused to install this very release, and the app would never have offered **UPDATE NOW**. Both comparators now handle MAJOR.MINOR.PATCH (and order `0.4.10` above `0.4.9`).

## The app stops inventing a clock
STANDBY means no clock and no simulation — but the TIMING room rendered whatever was left in its buffers, so it could show "GPS DISCIPLINED", a die temperature and 77,000 PPS edges with nothing attached. The room now gates on the app's **state**, not on "is there data": the KPIs dash, the charts draw their absent state. Two feeders behind it were fixed as well — line ingestion is guarded on actually consuming a device, and the RX-staleness watchdog now drops the transport instead of leaving a socket that quietly refills the rooms.

## Also
The service installer uses the project's real LaunchDaemon label, `is.peterlew.pcc.d`.

---
`SHA256SUMS` is attached. Every binary answers `./pccd -t`. Already on a release tarball? **DEVICE → UPDATES → UPDATE NOW**, or `./pccd --update`.
