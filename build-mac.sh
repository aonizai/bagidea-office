#!/usr/bin/env bash
# BagIdea Office — macOS build & wiring.
#   • builds the DYLD wallpaper shim (drops Godot to the desktop window level)
#   • builds the native shell (daemon + Godot + chat orb + overlay + tray)
#   • points the Claude Code hooks at the cross-platform Node forwarders
#     (daemon/hook.js, daemon/perm.js) using this checkout's absolute path
#
# The committed .claude/settings.json keep the upstream Windows defaults; this
# script rewrites the LOCAL copies for macOS (the same "set the absolute paths"
# step the Windows installer does, just automated). Re-run it any time the repo
# moves or after `bagidea update`.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$HOME/.cargo/env" 2>/dev/null || true

GODOT="$ROOT/godot/bin-mac/Godot.app"
if [ ! -d "$GODOT" ]; then
  echo "Godot not found at $GODOT" >&2
  echo "Download Godot 4.6.x macOS (universal) and unzip Godot.app there:" >&2
  echo "  https://github.com/godotengine/godot/releases (Godot_v4.6.x_macos.universal.zip)" >&2
  exit 1
fi

echo "[1/4] building wallpaper shim (DYLD injected into Godot)…"
( cd "$ROOT/shell/macos/wallpaper_shim" && cargo build --release )
cp "$ROOT/shell/macos/wallpaper_shim/target/release/libwallpaper_shim.dylib" \
   "$ROOT/shell/macos/libwallpaper_shim.dylib"
codesign --force --sign - "$ROOT/shell/macos/libwallpaper_shim.dylib"
echo "    → shell/macos/libwallpaper_shim.dylib (ad-hoc signed)"

echo "[2/4] building the native shell…"
( cd "$ROOT/shell" && cargo build --release )

echo "[3/4] wiring Claude Code hooks for this machine…"
cat > "$ROOT/.claude/settings.json" <<JSON
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"$ROOT/daemon/hook.js\" task.started" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "node \"$ROOT/daemon/hook.js\" task.progress" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"$ROOT/daemon/hook.js\" task.completed" } ] }
    ]
  }
}
JSON
cat > "$ROOT/workspace/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "node \"$ROOT/daemon/perm.js\"", "timeout": 60 } ] }
    ]
  }
}
JSON
echo "    → .claude/settings.json + workspace/.claude/settings.json (local, not committed)"

echo "[4/4] done."
echo
echo "Run it:   $ROOT/shell/target/release/bagidea-office-shell"
echo "Exit it:  menu-bar tray icon → Exit BagIdea Office"
