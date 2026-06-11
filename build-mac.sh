#!/usr/bin/env bash
# BagIdea Office — macOS One-Shot Installer & Build Script.
#   • checks for dependencies (Homebrew, Node, Rust)
#   • downloads Godot 4.6.3 automatically if missing
#   • builds the DYLD wallpaper shim and the native shell
#   • wires Claude Code hooks and sets up the 'bagidea' CLI
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "  ==========================================="
echo "   BagIdea Office - macOS INSTALLER"
echo "  ==========================================="

# ---- 1. Check Dependencies ---------------------------------------------------
echo "[1/6] checking dependencies..."

if ! command -v brew &> /dev/null; then
    echo "    ! Homebrew not found. Please install it first: https://brew.sh"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "    + installing Node.js..."
    brew install node
fi

if ! command -v cargo &> /dev/null; then
    echo "    + installing Rust..."
    # The 'rustup' homebrew formula is deprecated/removed in many taps.
    # We use the official rustup installer instead.
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    source "$HOME/.cargo/env"
fi
source "$HOME/.cargo/env" 2>/dev/null || true

# ---- 2. Download Godot -------------------------------------------------------
GODOT_DIR="$ROOT/godot/bin-mac"
GODOT_APP="$GODOT_DIR/Godot.app"
GODOT_ZIP="$ROOT/godot/godot_macos.zip"

echo "[2/6] checking Godot engine..."
if [ ! -d "$GODOT_APP" ]; then
    echo "    + downloading Godot 4.6.3 (universal) - about 120 MB; a progress bar follows. This takes a few minutes, it is NOT frozen..."
    mkdir -p "$GODOT_DIR"
    # --progress-bar gives a visible moving bar so the download never looks stuck.
    curl -L --progress-bar "https://github.com/godotengine/godot/releases/download/4.6.3-stable/Godot_v4.6.3-stable_macos.universal.zip" -o "$GODOT_ZIP"
    echo "    + unzipping (a moment)..."
    unzip -q "$GODOT_ZIP" -d "$GODOT_DIR"
    rm "$GODOT_ZIP"
    echo "    → installed Godot to $GODOT_APP"
else
    echo "    - Godot already present"
fi

# ---- 3. Build Components -----------------------------------------------------
echo "[3/6] building wallpaper shim (DYLD injected into Godot)…"
echo "    + compiling Rust - 'Compiling ...' lines will scroll. The first build takes several minutes, it is NOT frozen..."
( cd "$ROOT/shell/macos/wallpaper_shim" && cargo build --release )
cp "$ROOT/shell/macos/wallpaper_shim/target/release/libwallpaper_shim.dylib" \
   "$ROOT/shell/macos/libwallpaper_shim.dylib"
codesign --force --sign - "$ROOT/shell/macos/libwallpaper_shim.dylib"

echo "[4/6] building the native shell…"
echo "    + compiling the shell - more 'Compiling ...' lines; another few minutes, still working (NOT frozen)..."
( cd "$ROOT/shell" && cargo build --release )

# ---- 4. Wiring --------------------------------------------------------------
echo "[5/6] wiring Claude Code hooks for this machine…"
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

# ---- 5. CLI Setup -----------------------------------------------------------
echo "[6/6] setting up the 'bagidea' CLI command..."
mkdir -p "$ROOT/bin"
# Ensure the cli script has the right permission
chmod +x "$ROOT/cli/bagidea"
ln -sf "$ROOT/cli/bagidea" "$ROOT/bin/bagidea"
export PATH="$ROOT/bin:$PATH"

echo "  ==========================================="
echo "   INSTALL COMPLETE!"
echo "  ==========================================="
echo ""
echo "To use the 'bagidea' command from any terminal, add this to your .zshrc:"
echo "  export PATH=\"$ROOT/bin:\$PATH\""
echo ""
echo "Run the office:  bagidea start"
echo "Or run shell:    $ROOT/shell/target/release/bagidea-office-shell"
