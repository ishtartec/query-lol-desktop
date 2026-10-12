#!/bin/bash
# Regenerates every app icon from the Icon Composer document
# src-tauri/icons/QueryLoL.icon (edit that in Icon Composer, then run this).
#
#   Assets.car         Liquid Glass icon for macOS 26+ (light/dark/clear/tinted)
#   icon.icns          fallback for older macOS, drawn on Apple's 824/1024 grid
#   icon.ico, *.png    Windows and the rest, full-bleed
#   docs/favicon.png, public/favicon.png, src/assets/logo.png
#
# Needs Xcode 26 or later. Assets.car is committed rather than built by the
# Tauri bundler: Xcode 27's actool fails with "Bad file descriptor" when its
# output is a pipe (as the bundler runs it), and CI need not have Xcode 26.
set -euo pipefail
cd "$(dirname "$0")/.."

ICONS=src-tauri/icons
DOC=$ICONS/QueryLoL.icon
ICTOOL="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

render() { # size output
  "$ICTOOL" "$DOC" --export-image --output-file "$2" --platform macOS \
    --rendition Default --width "$1" --height "$1" --scale 1 >/dev/null
}

# Liquid Glass. actool wants the document named after --app-icon.
mkdir -p "$TMP/out"
cp -R "$DOC" "$TMP/Icon.icon"
actool "$TMP/Icon.icon" --compile "$TMP/out" --output-format human-readable-text \
  --output-partial-info-plist "$TMP/out/info.plist" --app-icon Icon \
  --include-all-app-icons --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx \
  >"$TMP/actool.log" 2>&1
if [ ! -f "$TMP/out/Assets.car" ]; then
  cat "$TMP/actool.log"
  exit 1
fi
cp "$TMP/out/Assets.car" "$ICONS/Assets.car"

# Full-bleed for Windows and the web; 824px body with a transparent margin
# for the legacy macOS icns, so it sits on the same grid as system icons.
render 1024 "$TMP/full.png"
render 824 "$TMP/body.png"
sips -p 1024 1024 "$TMP/body.png" --out "$TMP/mac.png" >/dev/null

pnpm tauri icon "$TMP/full.png" -o "$TMP/full" >/dev/null
pnpm tauri icon "$TMP/mac.png" -o "$TMP/mac" >/dev/null
for f in "$ICONS"/*.png; do cp "$TMP/full/$(basename "$f")" "$f"; done
cp "$TMP/full/icon.ico" "$ICONS/icon.ico"
cp "$TMP/mac/icon.icns" "$ICONS/icon.icns"

sips -z 512 512 "$TMP/full.png" --out docs/favicon.png >/dev/null
sips -z 64 64 "$TMP/full.png" --out public/favicon.png >/dev/null
sips -z 96 96 "$TMP/full.png" --out src/assets/logo.png >/dev/null
echo "Icons regenerated from $DOC"
