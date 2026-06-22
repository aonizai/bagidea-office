#!/usr/bin/env bash
# BagIdea Office - macOS Web Installer.
#
# Installs EVERYTHING needed on a Mac:
#   Git · Node.js · Rust · Godot 4.6.3 · Claude Code CLI
# Then clones the repo to ~/BagIdeaOffice, builds the shell,
# wires hooks, and sets up the `bagidea` command.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install-mac.sh | bash

set -e

APP_DIR="$HOME/BagIdeaOffice"
# Official repo + branch (override with BAGIDEA_REPO / BAGIDEA_BRANCH to test a fork).
REPO_URL="${BAGIDEA_REPO:-https://github.com/bagidea/bagidea-office.git}"
BRANCH="${BAGIDEA_BRANCH:-main}"

echo ""
echo "  ==========================================="
echo "   BagIdea Office - macOS WEB INSTALLER"
echo "  ==========================================="
echo ""

# 1. Check for Git
if ! command -v git &> /dev/null; then
    echo "    ! Git not found. Please install Xcode Command Line Tools first:"
    echo "      xcode-select --install"
    exit 1
fi

# 2. Clone or Update the repository
if [ ! -d "$APP_DIR" ]; then
    echo "[1/2] Cloning repository to $APP_DIR..."
    git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
    echo "[1/2] Repository already exists at $APP_DIR, updating..."
    cd "$APP_DIR"
    git pull origin "$BRANCH"
fi

# 3. Hand off to the internal one-shot builder
echo "[2/2] Launching internal build & setup..."
cd "$APP_DIR"
chmod +x build-mac.sh
./build-mac.sh

echo ""
echo "  Done! BagIdea Office is ready at $APP_DIR"
echo "  Try running: bagidea status"
echo ""
