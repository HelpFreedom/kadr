#!/usr/bin/env bash
# Register (or remove) a Kadr menu entry so the app launches from the
# application launcher / by double-click — no terminal. Ships as install.sh at
# the root of the tar.gz archive next to the `kadr` executable. Run once after
# putting the folder in its final location (e.g. /opt/kadr):
#
#   bash ./install.sh              # add to the app menu
#   bash ./install.sh --uninstall  # remove it
#
# Run as your normal user (NOT sudo) even if the app lives in /opt — it writes
# only under ~/.local/share, and stores the ABSOLUTE path of the app in the
# .desktop, so re-run it if you move the folder.
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP="$APPS/kadr.desktop"
ICON_DST="$ICONS/kadr.png"

refresh() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true
  command -v gtk-update-icon-cache   >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" || true
  command -v kbuildsycoca6           >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || \
  command -v kbuildsycoca5           >/dev/null 2>&1 && kbuildsycoca5 --noincremental >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DESKTOP" "$ICON_DST"
  refresh
  echo "Removed Kadr menu entry."
  exit 0
fi

[ -x "$DIR/kadr" ] || { echo "error: 'kadr' executable not found next to this script ($DIR)" >&2; exit 1; }

mkdir -p "$APPS" "$ICONS"

# icon: prefer the one shipped at the archive root; fall back to any bundled png
if [ -f "$DIR/kadr.png" ]; then
  cp -f "$DIR/kadr.png" "$ICON_DST"
else
  found="$(find "$DIR/resources" -name '*.png' 2>/dev/null | head -n1 || true)"
  [ -n "$found" ] && cp -f "$found" "$ICON_DST" || true
fi

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Kadr
Comment=GPU-accelerated multi-track video editor
Exec="$DIR/kadr" %U
Icon=${ICON_DST}
Terminal=false
Categories=AudioVideo;AudioVideoEditing;Video;
StartupWMClass=Kadr
StartupNotify=true
EOF
chmod +x "$DESKTOP" 2>/dev/null || true

refresh
echo "Installed. Look for “Kadr” in your application launcher."
echo "(Moved the folder? Re-run this script to fix the path.)"
