# pccd v0.7.0

The flight recorder has kept every satellite's position once a minute since v0.5, but the app could only
draw trails from what an open tab had seen live: 90 minutes at most, and nothing from while no tab was
open. This release hands the per-satellite record to the app. With it, the SKY room's TRAIL window (45M
to 24H) and the GROUND TRACK globe and map show where your clock's satellites actually went, as far back
as the recorder reaches.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW** (SHA-256 verified,
self-tested, atomic swap, reconnect). First install: download the tarball for your platform below and
run `./install-service.sh`.

## Added

- **`GET /history?series=sats`**: the recorder's per-satellite rows as `t,<TKprn:az:el:cn0;…>`, the first
  row of each bucket, so a 24 h window is one response of about 220 KB. The `timing` and `sky` series are
  unchanged. Against an older daemon the app keeps drawing trails from its live buffer.
