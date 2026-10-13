#!/bin/bash
# Builds "build/Equation Explainer.app" at the repo root (release by default).
# usage: macos/scripts/build_app.sh [debug|release]
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"     # macos/: the Swift package
ROOT="$(cd "$PKG/.." && pwd)"               # the repo: .env, shared/web, shared/python
CONFIG="${1:-release}"
APP="$ROOT/build/Equation Explainer.app"
cd "$PKG"

swift build -c "$CONFIG" --product EquationExplainer
BIN="$(swift build -c "$CONFIG" --show-bin-path)/EquationExplainer"

# icon (cached)
ICNS="$ROOT/build/AppIcon.icns"
if [ ! -f "$ICNS" ] || [ "$PKG/scripts/make_icon.swift" -nt "$ICNS" ]; then
  mkdir -p "$ROOT/build/AppIcon.iconset"
  swift "$PKG/scripts/make_icon.swift" "$ROOT/build/icon-1024.png"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/build/icon-1024.png" --out "$ROOT/build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z $d $d "$ROOT/build/icon-1024.png" --out "$ROOT/build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ROOT/build/AppIcon.iconset" -o "$ICNS"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/EquationExplainer"
rsync -a --delete --exclude '.DS_Store' "$ROOT/shared/web/" "$APP/Contents/Resources/web/"
rsync -a --delete --exclude '__pycache__' --exclude '.DS_Store' "$ROOT/shared/python/" "$APP/Contents/Resources/python/"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
sed "s|__PROJECT_ROOT__|$ROOT|" "$PKG/Info.plist" > "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc codesign failed (app still runs locally)"
echo "$APP"
