#!/usr/bin/env bash
# BagIdea Office — macOS Uninstaller.
# Removes ONLY this app's own footprint:
#   - stops the running suite (daemon + shell + Godot)
#   - removes LaunchAgent plist (autostart)
#   - removes the bagidea command from PATH (.zshrc/.bashrc)
#   - deletes the app folder
# It does NOT touch shared tools (Homebrew / Node / Rust / Godot install).
#
# Usage:  bagidea uninstall  |  directly.
# Options: --keep-data  back up workspace data before deleting.

set -e

APP_DIR="${BAGIDEA_HOME:-$HOME/BagIdeaOffice}"
KEEP_DATA=false

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
  esac
done

echo ""
echo "  ===== BagIdea Office - UNINSTALL ====="
echo ""

# 1) Stop the whole suite (so no file stays locked).
echo "  [1/4] Stopping the app..."
pkill -f "node.*server\.js" 2>/dev/null || true
pkill -f "bagidea-office-shell" 2>/dev/null || true
pkill -f "BagIdeaOffice" 2>/dev/null || true
pkill -f "BagIdeaOffice" 2>/dev/null || true
sleep 1

# 2) Remove LaunchAgent (autostart at login).
echo "  [2/4] Removing autostart..."
PLIST="$HOME/Library/LaunchAgents/com.bagidea.office.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  ✓ LaunchAgent removed"
else
  echo "  - No LaunchAgent found"
fi

# 3) Remove PATH entry from shell config.
echo "  [3/4] Removing PATH entry..."
BIN_DIR="$APP_DIR/bin"
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -q "$BIN_DIR" "$rc" 2>/dev/null; then
    # Remove the line(s) containing the bin path
    sed -i '' "/$BIN_DIR/d" "$rc" 2>/dev/null || \
    sed -i '' "\|$BIN_DIR|d" "$rc" 2>/dev/null || true
    echo "  ✓ Removed from $(basename "$rc")"
  fi
done
# Also remove symlink if it exists
rm -f "$BIN_DIR/bagidea" 2>/dev/null || true

# 4) Delete the app folder (or back up first).
echo "  [4/4] Removing app files..."
if [ "$KEEP_DATA" = true ]; then
  BACKUP="$HOME/bagidea-backup-$(date +%Y%m%d-%H%M%S)"
  echo "  + Backing up workspace to $BACKUP..."
  mkdir -p "$BACKUP"
  if [ -d "$APP_DIR/workspace" ]; then
    cp -R "$APP_DIR/workspace" "$BACKUP/"
    echo "  ✓ Workspace backed up"
  fi
  if [ -d "$APP_DIR/daemon" ] && [ -d "$APP_DIR/daemon/data" ]; then
    cp -R "$APP_DIR/daemon/data" "$BACKUP/"
    echo "  ✓ Daemon data backed up"
  fi
fi

rm -rf "$APP_DIR"
echo "  ✓ App folder removed"

echo ""
echo "  ✅ Uninstall complete!"
echo ""
echo "  Shared tools (Homebrew, Node, Rust, Godot) were NOT removed."
if [ "$KEEP_DATA" = true ]; then
  echo "  Your workspace backup is at: $BACKUP"
fi
echo ""
