#!/bin/sh
# install-service.sh — run pccd as an always-on service: it starts at boot, restarts if it dies, serves
# the bundled app at http://localhost:4192 (any browser), and is ready to feed chrony as a stratum-1
# source. Ships INSIDE each release tarball, next to pccd + pcc-web. Run it from there:
#
#     curl -L <asset-url> | tar xz && cd pcc && sudo ./install-service.sh
#
# It copies the bundle to a stable, root-owned prefix so pccd can update ITSELF in place (the app's
# UPDATE NOW button and `pccd --update` both keep working — launchd/systemd keep tracking the same PID).
# Re-running it upgrades an existing install. `sudo ./install-service.sh --uninstall` removes it.
set -eu

LABEL=is.peterlew.pcc.d                   # macOS LaunchDaemon label (reverse-DNS of peterlew.is) / Linux unit is pccd.service
PREFIX=/usr/local/pcc                     # bundle lives here: $PREFIX/pccd + $PREFIX/pcc-web
PLIST=/Library/LaunchDaemons/$LABEL.plist
UNIT=/etc/systemd/system/pccd.service
OS=$(uname -s)
[ "$OS" = Darwin ] && SOCK=/var/run/chrony.pcc.sock || SOCK=/run/chrony.pcc.sock
SRC=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "needs root — run: sudo ./install-service.sh${1:+ $1}"; exit 1; }

stop_existing() {  # tear down any running pccd service so we can replace the binary + reclaim the serial port
  if [ "$OS" = Darwin ]; then
    # io.github.peterlewis.pccd = a label a pre-release build of this installer used. Boot it out AND
    # delete its plist, or it reloads at boot and holds the (exclusive) serial port against us.
    for L in "$LABEL" io.github.peterlewis.pccd; do
      launchctl bootout system/"$L" 2>/dev/null || launchctl unload -w /Library/LaunchDaemons/"$L".plist 2>/dev/null || true
    done
    rm -f /Library/LaunchDaemons/io.github.peterlewis.pccd.plist
  else
    systemctl disable --now pccd.service 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_existing
  [ "$OS" = Darwin ] && rm -f "$PLIST" || { rm -f "$UNIT"; systemctl daemon-reload 2>/dev/null || true; }
  echo "removed the pccd service. The bundle in $PREFIX and any chrony config were left in place."
  exit 0
fi

[ -x "$SRC/pccd" ] || { echo "run this from the extracted tarball dir ($SRC/pccd not found)"; exit 1; }

[ "$SRC" = "$PREFIX" ] && echo "[pccd] repairing/upgrading the install in place ($PREFIX)"
echo "[pccd] installing the bundle to $PREFIX"
mkdir -p "$PREFIX"
# Stage into .new siblings FIRST, from SRC while it is still intact. SRC may BE $PREFIX (a user re-running
# the copy this script plants at line ~72), so nothing destructive may happen until every copy has landed;
# with `set -e` a failed copy here aborts BEFORE stop_existing, leaving the running service untouched.
rm -rf "$PREFIX/.pcc-web.new"
cp "$SRC/pccd" "$PREFIX/.pccd.new" && chmod 755 "$PREFIX/.pccd.new"
cp -R "$SRC/pcc-web" "$PREFIX/.pcc-web.new"
cp "$SRC/install-service.sh" "$PREFIX/.install-service.sh.new" 2>/dev/null || true
# Everything is staged — now stop the service (frees the exclusive serial port + old binary) and swap.
stop_existing
mv -f "$PREFIX/.pccd.new" "$PREFIX/pccd"
rm -rf "$PREFIX/pcc-web.old"; [ -d "$PREFIX/pcc-web" ] && mv "$PREFIX/pcc-web" "$PREFIX/pcc-web.old" || true
mv "$PREFIX/.pcc-web.new" "$PREFIX/pcc-web"; rm -rf "$PREFIX/pcc-web.old"
[ -f "$PREFIX/.install-service.sh.new" ] && { mv "$PREFIX/.install-service.sh.new" "$PREFIX/install-service.sh"; chmod 755 "$PREFIX/install-service.sh"; }

if [ "$OS" = Darwin ]; then
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PREFIX/pccd</string>
    <string>-s</string><string>$SOCK</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/pccd.log</string>
  <key>StandardErrorPath</key><string>/var/log/pccd.log</string>
</dict></plist>
EOF
  chmod 644 "$PLIST"
  launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  echo "[pccd] started as LaunchDaemon $LABEL — logs: /var/log/pccd.log"
elif [ "$OS" = Linux ]; then
  cat > "$UNIT" <<EOF
[Unit]
Description=PCC bridge daemon (Precision Clock Mk IV -> WebSocket + chrony stratum-1)
After=network.target chronyd.service chrony.service

[Service]
ExecStart=$PREFIX/pccd -s $SOCK
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now pccd.service
  echo "[pccd] started as systemd unit pccd.service — logs: journalctl -u pccd -f"
else
  echo "unsupported OS: $OS (macOS or Linux only)"; exit 1
fi

cat <<EOF

  Done. Open  http://localhost:4192  in any browser and click CONNECT DEVICE.
  It updates itself: DEVICE -> UPDATES -> UPDATE NOW (or run: $PREFIX/pccd --update).

  Stratum-1 chrony feed (optional): pccd already offers PPS to $SOCK. To use it, add a
  refclock to chrony and restart chronyd (see host/pccd/README.md, or chrony.conf.example):
      refclock SOCK $SOCK refid PCC precision $([ "$OS" = Darwin ] && echo 1e-4 || echo 1e-2)
$([ "$OS" = Darwin ] && echo "  macOS: also turn OFF System Settings -> General -> Date & Time -> Set time automatically.")
EOF
