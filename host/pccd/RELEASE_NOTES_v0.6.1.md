# pccd v0.6.1

The app moved home to **https://pcc.ptrl.ws** — this patch teaches the daemon's WebSocket bridge to
accept it. On v0.6.0 the hosted app at the new address is refused (`rejected websocket from origin`
in the log) and reports **no clock** while the daemon itself sits healthy with the serial port open.
Localhost pages and the old github.io address were unaffected.

Existing daemons on v0.4.1+ self-update in place: **DEVICE → UPDATES → UPDATE NOW** (SHA-256 verified,
self-tested, atomic swap, reconnect). First install: download the tarball for your platform below and
run `./install-service.sh`.

## Fixed

- **WebSocket origin allowlist knows the new home.** `https://pcc.ptrl.ws` is accepted; the pre-move
  `https://peterlewis.github.io` stays allowed for pages cached from before the domain change. The
  allowlist itself is unchanged in spirit: any web page can open `ws://127.0.0.1`, so the bridge only
  ever talks to the app's own origins and loopback.

## Changed

- **The LaunchDaemon label follows the app home.** `ws.ptrl.pcc.d` replaces `is.peterlew.pcc.d` on
  macOS. The installer retires the old label during upgrade — bootout plus plist removal, the same way
  it already retires the pre-release label — so no machine ends up with two daemons contending for the
  exclusive serial port. The Linux unit name is unchanged (`pccd.service`).
