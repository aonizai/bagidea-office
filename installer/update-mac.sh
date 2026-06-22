#!/usr/bin/env bash
# BagIdea Office — macOS Update Script.
# Mirrors Windows update.ps1 behavior:
#   1. Stop the running suite (daemon + shell)
#   2. git pull --ff-only
#   3. Rebuild shell if source changed (and cargo exists)
#   4. Restart daemon
#
# Usage:  bagidea update  |  in-app refresh button  |  directly.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ""
echo "  ===== BagIdea Office - UPDATE ====="
echo ""

# 1) Stop the running suite (daemon + shell).
echo "  [1/4] Stopping the app..."
# Kill daemon (node server.js)
pkill -f "node.*server\.js" 2>/dev/null || true
# Kill the Godot shell / wallpaper
pkill -f "bagidea-office-shell" 2>/dev/null || true
pkill -f "BagIdeaOffice" 2>/dev/null || true
sleep 2

# No git checkout: hand off to the installer (it clones + preserves data).
if [ ! -d "$ROOT/.git" ]; then
  echo "  [2/2] Not a git checkout - running the installer..."
  chmod +x "$ROOT/installer/install-mac.sh"
  exec "$ROOT/installer/install-mac.sh"
fi

# 2) Pull the latest code.
echo "  [2/4] Pulling latest code..."
# Clean the hook-path files so --ff-only doesn't fail on a dirty tree
# (wire-hooks.sh rewrites these with machine-specific absolute paths)
git checkout -- .claude/settings.json workspace/.claude/settings.json 2>/dev/null || true
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "none")
git pull --ff-only || {
  echo "  ⚠ git pull failed — you may have local changes."
  echo "    Run 'git stash' then try again."
  exit 1
}
AFTER=$(git rev-parse HEAD 2>/dev/null || echo "none")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  - Already up to date"
else
  echo "  - Updated: ${BEFORE:0:7} → ${AFTER:0:7}"
  # Re-wire Claude Code hooks with the new install path
  if [ -f "$ROOT/installer/wire-hooks.sh" ]; then
    bash "$ROOT/installer/wire-hooks.sh" "$ROOT"
    echo "  ✓ Hooks re-wired"
  fi
fi

# 3) Rebuild the shell only when its source changed (and cargo exists).
echo "  [3/4] Checking shell rebuild..."
if command -v cargo &>/dev/null; then
  SHELL_CHANGED=$(git diff --name-only "$BEFORE" "$AFTER" 2>/dev/null | grep -c "^shell/" || true)
  if [ "$SHELL_CHANGED" -gt 0 ]; then
    echo "  + Shell source changed — rebuilding..."
    (cd "$ROOT/shell" && cargo build --release)
    echo "  ✓ Shell rebuilt"
  else
    echo "  - Shell unchanged, skipping rebuild"
  fi
else
  echo "  - cargo not found, skipping shell rebuild"
fi

# 4) Restart the daemon.
echo "  [4/4] Restarting daemon..."
if [ -f "$ROOT/cli/bagidea" ]; then
  "$ROOT/cli/bagidea" start &>/dev/null &
  echo "  ✓ Daemon restarting..."
else
  echo "  ⚠ cli/bagidea not found — start manually with: bagidea start"
fi

echo ""
echo "  ✅ Update complete!"
echo ""
