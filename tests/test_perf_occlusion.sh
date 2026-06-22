#!/usr/bin/env bash
# test_perf_occlusion.sh
# Measures CPU% and real FPS before and after the occlusion throttle kicks in.
#
# Architecture:
#   • bagidea-office-shell (Rust) monitors CGWindowListCopyWindowInfo every 1s.
#     When a window at layer ≥ 0 covers ≥ 95% of the primary screen, it writes
#     /tmp/bagidea_occ.  Also fires on display-sleep (CGDisplayIsAsleep).
#   • office_floor.gd (Godot) reads the flag every 0.5s and calls
#     Engine.max_fps = 2 (occluded) or 30 (visible).
#
# Usage:
#   1. Start BagIdea Office:  ./shell/target/release/bagidea-office-shell
#   2. Run:  bash tests/test_perf_occlusion.sh

set -euo pipefail

OCC_FLAG=/private/tmp/bagidea_occ
FPS_LOG=/private/tmp/bagidea_fps
BASELINE_SECS=5   # seconds to sample with desktop clear
CLEAR_WAIT=7      # seconds to wait for FPS to recover to 30 after hiding windows
COVER_WAIT=7      # seconds to wait: 2s debounce + ~5s for Engine.get_frames_per_second() to converge
COVER_SECS=6      # seconds to sample while covered

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

# ── Find Godot PID ────────────────────────────────────────────────────────────
GODOT_PID=$(pgrep "Godot" 2>/dev/null | head -1 || true)
if [[ -z "$GODOT_PID" ]]; then
    echo "${RED}ERROR: BagIdea Office is not running.${RESET}"
    echo "  Start it:  ./shell/target/release/bagidea-office-shell"
    exit 1
fi
echo "${BOLD}=== BagIdea Office — Occlusion Throttle Perf Test ===${RESET}"
echo "  Godot PID : $GODOT_PID"
echo "  FPS log   : $FPS_LOG"
echo ""

# ── Sampling helper ───────────────────────────────────────────────────────────
# Sets globals: PHASE_CPU_AVG, PHASE_FPS_AVG
sample_phase() {
    local label="$1" secs="$2"
    local cpu_sum=0 fps_sum=0 count=0
    echo "  ${CYAN}${label}${RESET}"
    for ((i = 1; i <= secs; i++)); do
        cpu=$(ps -p "$GODOT_PID" -o %cpu= 2>/dev/null | tr -d ' ' | head -1); cpu=${cpu:-0}
        fps=$(cat "$FPS_LOG" 2>/dev/null | tr -d '[:space:]' | head -1);       fps=${fps:-0}
        occ=$([ -f "$OCC_FLAG" ] && echo "OCC" || echo "vis")
        printf "    s%-2d  CPU=%5.1f%%  FPS=%-5s  flag=%s\n" "$i" "$cpu" "$fps" "$occ"
        cpu_sum=$(echo "scale=4; $cpu_sum + $cpu" | bc -l)
        fps_sum=$(echo "scale=4; $fps_sum + $fps" | bc -l 2>/dev/null || echo "$fps_sum")
        count=$((count + 1))
        sleep 1
    done
    PHASE_CPU_AVG=$(echo "scale=1; $cpu_sum / $count" | bc -l)
    PHASE_FPS_AVG=$(echo "scale=1; $fps_sum / $count" | bc -l 2>/dev/null || echo "?")
}

# ── Phase 1: Clear desktop → 30fps ───────────────────────────────────────────
echo "${BOLD}Phase 1: DESKTOP CLEAR (hiding app windows)${RESET}"
osascript -e '
tell application "System Events"
  repeat with a in (every application process whose visible is true)
    try
      set visible of a to false
    end try
  end repeat
end tell' 2>/dev/null || true
echo "  Waiting ${CLEAR_WAIT}s for occlusion flag to clear and FPS to stabilise at 30…"
sleep "$CLEAR_WAIT"
sample_phase "Sampling (target 30 fps)…" "$BASELINE_SECS"
cpu_before=$PHASE_CPU_AVG
fps_before=$PHASE_FPS_AVG

# Restore windows
osascript -e 'tell application "System Events" to set visible of every process to true' 2>/dev/null || true
echo "  ${GREEN}Result: avg CPU=${cpu_before}%  avg FPS=${fps_before}${RESET}"
echo ""

# ── Phase 2: Fullscreen cover → 2fps ─────────────────────────────────────────
echo "${BOLD}Phase 2: SCREEN COVERED (fullscreen window — shell detects via CGWindowList)${RESET}"
COVER_SWIFT=/tmp/bagidea_cover.swift
cat > "$COVER_SWIFT" << 'SWIFT'
import Cocoa
let secs = Double(CommandLine.arguments.dropFirst().first ?? "8") ?? 8.0
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.main!
let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
win.level = NSWindow.Level(rawValue: 2000)  // screensaverWindow level — above all apps
win.backgroundColor = .black
win.isOpaque = true
win.makeKeyAndOrderFront(nil)
NSApp.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + secs) { win.orderOut(nil); NSApp.terminate(nil) }
app.run()
SWIFT

COVER_TOTAL=$((COVER_WAIT + COVER_SECS + 2))
swift "$COVER_SWIFT" "$COVER_TOTAL" &
COVER_PID=$!
echo "  Cover window up (PID $COVER_PID) — waiting ${COVER_WAIT}s for throttle to kick in…"
sleep "$COVER_WAIT"
sample_phase "Sampling (target 2 fps)…" "$COVER_SECS"
cpu_after=$PHASE_CPU_AVG
fps_after=$PHASE_FPS_AVG

kill "$COVER_PID" 2>/dev/null; wait "$COVER_PID" 2>/dev/null || true
echo "  ${GREEN}Result: avg CPU=${cpu_after}%  avg FPS=${fps_after}${RESET}"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "${BOLD}=== Summary ===${RESET}"
printf "  %-16s  %8s  %8s\n" "Phase" "CPU avg" "FPS avg"
printf "  %-16s  %7s%%  %s fps\n" "Desktop clear"  "$cpu_before" "$fps_before"
printf "  %-16s  %7s%%  %s fps\n" "Screen covered" "$cpu_after"  "$fps_after"
echo ""
if (( $(echo "$cpu_before > 0.1" | bc -l) )); then
    cpu_pct=$(awk "BEGIN {printf \"%.1f\", (1 - $cpu_after / $cpu_before) * 100}")
    cpu_abs=$(awk "BEGIN {printf \"%.1f\", $cpu_before - $cpu_after}")
    fps_pct=$(awk "BEGIN {printf \"%.1f\", (1 - $fps_after / $fps_before) * 100}")
    echo "  CPU saved   : ~${cpu_pct}%  (${cpu_abs}pp absolute: ${cpu_before}% → ${cpu_after}%)"
    echo "  FPS reduced : ~${fps_pct}%  (${fps_before} → ${fps_after} fps, target 2 fps)"
fi
rm -f "$OCC_FLAG"
echo ""
echo "${GREEN}Done. Flag removed — office back to 30 fps.${RESET}"
