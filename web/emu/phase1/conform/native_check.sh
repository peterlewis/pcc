#!/usr/bin/env bash
# Tier 3b in one command: build the native twin, run every script in scripts/ through it and
# through the WASM emulator (../../clock-fw.mjs, built by ../build.sh), and compare the traces.
# Exit 0 only if every trace is byte-identical.
set -euo pipefail
cd "$(dirname "$0")"
bash build_native.sh >/dev/null 2>&1 || { echo "FAIL  the native twin did not build (run: bash build_native.sh)"; exit 1; }
fail=0
for s in scripts/*.txt; do
  n=$(basename "$s" .txt)
  ./conform_native     < "$s" > "$n.native.snap"
  node runner_wasm.mjs < "$s" > "$n.wasm.snap"
  if cmp -s "$n.native.snap" "$n.wasm.snap" && [ -s "$n.native.snap" ]; then
    echo "PASS  $n: $(wc -l < "$n.native.snap" | tr -d ' ') snapshots identical"
  else
    echo "FAIL  $n: native and WASM traces differ (diff $n.native.snap $n.wasm.snap)"; fail=1
  fi
done
[ "$fail" = 0 ] && echo && echo "ALL PASS"
exit "$fail"
