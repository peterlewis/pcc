#!/usr/bin/env bash
# dist.sh — build the pccd release tarballs. Each tarball extracts to a top-level `pcc/` dir holding
# the platform `pccd` binary NEXT TO `pcc-web/` (the built web app), so a user's one-liner is:
#
#     curl -L <url> | tar xz && cd pcc && ./pccd     # then open http://localhost:4192 in any browser
#
# pccd auto-serves the co-located pcc-web/, making the bridge same-origin (works in every browser).
#
# ONE source of truth for the build recipe, callable whole (local) or per-target (CI, one per runner):
#     dist.sh                 all targets  — macOS universal + both Linux + SHA256SUMS (needs mac + docker)
#     dist.sh macos           macOS universal tarball only          (a macOS runner)
#     dist.sh linux-x86_64    one Linux static-musl tarball (docker) (an x86_64 runner)
#     dist.sh linux-aarch64   one Linux static-musl tarball (docker) (via qemu, or an arm64 runner)
#     dist.sh sums            SHA256SUMS over whatever tarballs already exist in dist/
#
# Run from host/pccd/ after `node web/build.mjs` (docs/ must exist). See .github/workflows/release.yml.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
WEB="$ROOT/docs"
OUT="$ROOT/host/pccd/dist"
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
mkdir -p "$OUT"

need_web () { [ -f "$WEB/index.html" ] || { echo "no built app at $WEB — run: node web/build.mjs"; exit 1; }; }

pack () {  # $1=asset-name  $2=path-to-built-binary
  need_web
  local name=$1 bin=$2 stage="$OUT/stage-$1"
  rm -rf "$stage"; mkdir -p "$stage/pcc/pcc-web"
  cp "$bin" "$stage/pcc/pccd"; chmod +x "$stage/pcc/pccd"
  cp -R "$WEB/." "$stage/pcc/pcc-web/"
  ( cd "$stage" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT/$name.tar.gz" pcc )
  rm -rf "$stage"
  echo "  packed $name.tar.gz ($(du -h "$OUT/$name.tar.gz" | cut -f1))"
}

# -DPCCD_PLATFORM stamps the release-asset tag into each binary so `pccd --update` knows which asset to
# pull from releases/latest/download (it fetches pccd-<PLATFORM>.tar.gz). Must match the pack() name
# minus the "pccd-" prefix, or self-update fetches the wrong (or a missing) asset.
build_macos () {
  echo "[dist] macOS universal (arm64 + x86_64)"
  clang -O2 -Wall -Wextra -DPCCD_GIT=\"$GIT_HASH\" -DPCCD_PLATFORM=\"macos-universal\" -arch arm64 -arch x86_64 \
    -o "$OUT/pccd-macos" pccd.c -framework IOKit -framework CoreFoundation
  "$OUT/pccd-macos" -t
  pack pccd-macos-universal "$OUT/pccd-macos"; rm -f "$OUT/pccd-macos"
}

build_linux () {  # $1=docker-platform  $2=asset-name (pccd-linux-x86_64 / pccd-linux-aarch64)
  local plat=${2#pccd-}                                  # -> linux-x86_64 / linux-aarch64
  echo "[dist] linux $1 (static musl, via Docker)"
  docker run --rm --platform "$1" -v "$PWD":/src -w /src alpine:3.20 sh -c '
    apk add --no-cache build-base >/dev/null 2>&1
    cc -O2 -Wall -Wextra -DPCCD_GIT=\"'"$GIT_HASH"'\" -DPCCD_PLATFORM=\"'"$plat"'\" -static -o /tmp/pccd pccd.c -lm
    /tmp/pccd -t && cp /tmp/pccd /src/dist/'"$2"'.bin
  '
  pack "$2" "$OUT/$2.bin"; rm -f "$OUT/$2.bin"
}

sums () {
  echo "[dist] SHA256SUMS"
  local sha; sha=$(command -v shasum >/dev/null 2>&1 && echo "shasum -a 256" || echo "sha256sum")
  ( cd "$OUT" && $sha *.tar.gz > SHA256SUMS && cat SHA256SUMS )
}

case "${1:-all}" in
  macos)         build_macos ;;
  linux-x86_64)  build_linux linux/amd64 pccd-linux-x86_64 ;;
  linux-aarch64) build_linux linux/arm64 pccd-linux-aarch64 ;;
  sums)          sums ;;
  all)           rm -rf "$OUT"; mkdir -p "$OUT"
                 build_macos
                 build_linux linux/amd64 pccd-linux-x86_64
                 build_linux linux/arm64 pccd-linux-aarch64
                 sums ;;
  *) echo "usage: dist.sh [all|macos|linux-x86_64|linux-aarch64|sums]"; exit 2 ;;
esac
echo "[dist] done → $OUT"
