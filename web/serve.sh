#!/usr/bin/env bash
# Launch a local web server for the PCC web companion and open the page.
#
# Browsers block ES modules (and Web Serial) on file:// origins, so the
# only way to run the page locally is over HTTP. Run this from the repo
# root or from inside web/ — either works.
#
#   bash web/serve.sh            # defaults to port 8765
#   PORT=9000 bash web/serve.sh  # override

set -e
PORT="${PORT:-8765}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}/"

echo "PCC Web → ${URL}  (Ctrl-C to stop)"

# Fire the browser open in the background once the server has had a beat
# to bind the port. `open` is macOS, `xdg-open` covers most Linux DEs.
( sleep 0.6 && (open "$URL" >/dev/null 2>&1 \
                || xdg-open "$URL" >/dev/null 2>&1 \
                || true) ) &

cd "$SCRIPT_DIR"
exec python3 -m http.server "$PORT"
