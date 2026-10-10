#!/bin/bash
# Builds "build/Equation Explainer.app" (release by default).  usage: scripts/build_app.sh [debug|release]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-release}"
APP="$ROOT/build/Equation Explainer.app"
cd "$ROOT"

swift build -c "$CONFIG" --product EquationExplainer
BIN="$(swift build -c "$CONFIG" --show-bin-path)/EquationExplainer"

# icon (cached)
ICNS="$ROOT/build/AppIcon.icns"
if [ ! -f "$ICNS" ] || [ "$ROOT/scripts/make_icon.swift" -nt "$ICNS" ]; then
  mkdir -p "$ROOT/build/AppIcon.iconset"
  swift "$ROOT/scripts/make_icon.swift" "$ROOT/build/icon-1024.png"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/build/icon-1024.png" --out "$ROOT/build/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z $d $d "$ROOT/build/icon-1024.png" --out "$ROOT/build/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ROOT/build/AppIcon.iconset" -o "$ICNS"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/EquationExplainer"
rsync -a --delete --exclude '.DS_Store' "$ROOT/App/Web/" "$APP/Contents/Resources/Web/"
rsync -a --delete --exclude '__pycache__' --exclude '.DS_Store' "$ROOT/App/Python/" "$APP/Contents/Resources/Python/"
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"
sed "s|__PROJECT_ROOT__|$ROOT|" "$ROOT/App/Info.plist" > "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc codesign failed (app still runs locally)"
echo "$APP"
