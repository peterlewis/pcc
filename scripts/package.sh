#!/bin/bash
# Builds and packages PCC.app from a release build.
#
# Usage:
#   scripts/package.sh                                   # ad-hoc signed, runs locally
#   scripts/package.sh --identity "Developer ID Application: Peter Lewis (4Q6PGH5UH6)" \
#                      --profile path/to/embedded.provisionprofile
#
# With a real identity the app is signed with the hardened runtime and the
# WeatherKit/Maps entitlements (which require the provisioning profile).
# Notarization stays manual:
#   ditto -c -k --keepParent PCC.app PCC.zip
#   xcrun notarytool submit PCC.zip --keychain-profile <profile> --wait
#   xcrun stapler staple PCC.app
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="-"
PROFILE=""
OUTPUT="."
while [[ $# -gt 0 ]]; do
    case "$1" in
        --identity) IDENTITY="$2"; shift 2 ;;
        --profile)  PROFILE="$2";  shift 2 ;;
        --output)   OUTPUT="$2";   shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

swift build -c release

BIN=".build/release/PCC"
BUNDLE=".build/release/PrecisionClockCompanion_PCC.bundle"
APP="$OUTPUT/PCC.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
cp "$BIN" "$APP/Contents/MacOS/PCC"
# The resource bundle must land in Contents/Resources — Bundle.pccResources
# resolves it from there (see Sources/PCC/ResourceBundle.swift).
cp -R "$BUNDLE" "$APP/Contents/Resources/"

# SPM emits the resource bundle without an Info.plist, and codesign rejects
# a plist-less bundle ("bundle format unrecognized"). Give it one, with the
# version kept in lockstep with the app's.
VERSION=$(plutil -extract CFBundleShortVersionString raw -o - Info.plist)
BUILD_NUM=$(plutil -extract CFBundleVersion raw -o - Info.plist)
cat > "$APP/Contents/Resources/PrecisionClockCompanion_PCC.bundle/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>is.peterlew.pcc.resources</string>
    <key>CFBundleName</key>
    <string>PrecisionClockCompanion_PCC</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUILD_NUM}</string>
</dict>
</plist>
EOF

if [[ -n "$PROFILE" ]]; then
    cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
fi

# Sign inside-out: the nested resource bundle first, then the app. The
# restricted entitlements (WeatherKit/Maps) only validate with a real
# identity plus provisioning profile, so the ad-hoc path skips them —
# weather shows an auth error in that configuration, everything else works.
codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/PrecisionClockCompanion_PCC.bundle"
if [[ "$IDENTITY" == "-" ]]; then
    codesign --force --sign - "$APP"
else
    codesign --force --options runtime --entitlements PCC.entitlements --sign "$IDENTITY" "$APP"
fi

codesign --verify --strict "$APP"
echo "Packaged: $APP"
