#!/usr/bin/env bash
# BagIdea Office — macOS Tier-1 launcher (normal window, no wallpaper embed).
# Starts the Node daemon (if not already up) and launches the Godot office.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
GODOT="$ROOT/godot/bin-mac/Godot.app/Contents/MacOS/Godot"

if [ ! -x "$GODOT" ]; then
  echo "Godot not found at $GODOT — run the download step first." >&2
  exit 1
fi

# Start daemon if port 8787 is free.
if ! curl -s -m2 http://127.0.0.1:8787/ -o /dev/null; then
  echo "[run-mac] starting daemon…"
  node "$ROOT/daemon/server.js" > /tmp/bagidea-daemon.log 2>&1 &
  sleep 2
else
  echo "[run-mac] daemon already running on :8787"
fi

echo "[run-mac] launching office… (pass --shot for a one-off screenshot to shots/)"
exec "$GODOT" --path "$ROOT/godot" "$@"
