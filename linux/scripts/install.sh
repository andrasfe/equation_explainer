#!/bin/bash
# Puts Equation Explainer into the desktop's app grid for this user (no root needed):
# a launcher that runs the app from this source tree, its icon, and the chalk fonts
# (so the board list and matplotlib figures can use them too).  usage: linux/scripts/install.sh [--uninstall]
set -euo pipefail
LINUX="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$LINUX/.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor/scalable/apps"
FONTS="$DATA/fonts/equation-explainer"
DESKTOP="dev.equationexplainer.app.desktop"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$APPS/$DESKTOP" "$ICONS/equation-explainer.svg"
  rm -rf "$FONTS"
  command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
  command -v fc-cache >/dev/null && fc-cache -f >/dev/null 2>&1 || true
  echo "removed the launcher, icon and fonts"
  exit 0
fi

mkdir -p "$APPS" "$ICONS" "$FONTS"
sed "s|__EXEC__|$LINUX/bin/equation-explainer|" "$LINUX/data/$DESKTOP" > "$APPS/$DESKTOP"
cp -f "$LINUX/data/icons/hicolor/scalable/apps/equation-explainer.svg" "$ICONS/"
cp -f "$ROOT"/shared/web/fonts/*.ttf "$FONTS/"
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk4-update-icon-cache >/dev/null && gtk4-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
command -v fc-cache >/dev/null && fc-cache -f >/dev/null 2>&1 || true
echo "installed: $APPS/$DESKTOP (runs $LINUX/bin/equation-explainer)"
