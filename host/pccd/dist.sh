#!/usr/bin/env bash
# dist.sh — build the pccd release tarballs. Each tarball extracts to a top-level `pcc/` dir holding
# the platform `pccd` binary NEXT TO `pcc-web/` (the built web app), so a user's one-liner is:
#
#     curl -L <url> | tar xz && cd pcc && ./pccd     # then open http://localhost:4192 in any browser
#
# pccd auto-serves the co-located pcc-web/, making the bridge same-origin (works in every browser).
# macOS universal is built with the local clang; the static-musl Linux binaries are built in Alpine
# via Docker (aarch64 through qemu). Run from host/pccd/ after `node web/build.mjs` (docs/ must exist).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
WEB="$ROOT/docs"
OUT="$ROOT/host/pccd/dist"
GIT_HASH=$(git rev-parse --short HEAD)
[ -f "$WEB/index.html" ] || { echo "no built app at $WEB — run: node web/build.mjs"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"

pack () {  # $1=asset-name  $2=path-to-built-binary
  local name=$1 bin=$2 stage="$OUT/stage-$1"
  rm -rf "$stage"; mkdir -p "$stage/pcc/pcc-web"
  cp "$bin" "$stage/pcc/pccd"; chmod +x "$stage/pcc/pccd"
  cp -R "$WEB/." "$stage/pcc/pcc-web/"
  ( cd "$stage" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT/$name.tar.gz" pcc )
  rm -rf "$stage"
  echo "  packed $name.tar.gz ($(du -h "$OUT/$name.tar.gz" | cut -f1))"
}

echo "[dist] macOS universal (arm64 + x86_64)"
clang -O2 -Wall -Wextra -DPCCD_GIT=\"$GIT_HASH\" -arch arm64 -arch x86_64 \
  -o "$OUT/pccd-macos" pccd.c -framework IOKit -framework CoreFoundation
"$OUT/pccd-macos" -t
pack pccd-macos-universal "$OUT/pccd-macos"; rm -f "$OUT/pccd-macos"

build_linux () {  # $1=docker-platform  $2=asset-name
  echo "[dist] linux $1 (static musl, via Docker)"
  docker run --rm --platform "$1" -v "$PWD":/src -w /src alpine:3.20 sh -c '
    apk add --no-cache build-base >/dev/null 2>&1
    cc -O2 -Wall -Wextra -DPCCD_GIT=\"'"$GIT_HASH"'\" -static -o /tmp/pccd pccd.c -lm
    /tmp/pccd -t && cp /tmp/pccd /src/dist/'"$2"'.bin
  '
  pack "$2" "$OUT/$2.bin"; rm -f "$OUT/$2.bin"
}
build_linux linux/amd64 pccd-linux-x86_64
build_linux linux/arm64 pccd-linux-aarch64

echo "[dist] SHA256SUMS"
( cd "$OUT" && shasum -a 256 *.tar.gz > SHA256SUMS && cat SHA256SUMS )
echo "[dist] done → $OUT"
