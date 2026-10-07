#!/bin/bash
# Builds "Mark's Render PDF Editor.app" (Apple Silicon + Intel) and a .dmg. Run on macOS after `node build.js`.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
APP="dist/Mark's Render PDF Editor.app"
rm -rf "$APP" dist/dmg dist/AppIcon.iconset dist/mrpdf-*
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# compile for both chip types and join them into one universal program
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -o "dist/mrpdf-$arch" mac/main.swift \
    -framework Cocoa -framework WebKit -framework Vision -framework PDFKit 2>&1 | tee -a dist/swift.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
done
lipo -create -output "$APP/Contents/MacOS/MarksRenderPDFEditor" dist/mrpdf-arm64 dist/mrpdf-x86_64

cp dist/PDFEditor.html "$APP/Contents/Resources/"
sed "s/__VERSION__/$VER/g" mac/Info.plist > "$APP/Contents/Info.plist"

# app icon from the 1024 px artwork
ICONSET=dist/AppIcon.iconset; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s launcher/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) launcher/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# ad-hoc signature (required to run on Apple Silicon; not an Apple-verified signature)
codesign --force --deep --sign - "$APP"

# disk image: drag the app onto Applications
mkdir dist/dmg
cp -R "$APP" dist/dmg/
ln -s /Applications dist/dmg/Applications
hdiutil create -volname "Mark's Render PDF Editor" -srcfolder dist/dmg -ov -format UDZO dist/MarksRenderPDFEditor-mac.dmg
echo "Built dist/MarksRenderPDFEditor-mac.dmg ($(du -h dist/MarksRenderPDFEditor-mac.dmg | cut -f1))"
