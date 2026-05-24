#!/bin/bash
# Mac one-click launcher for Sweep.
# Double-click this file in Finder to set up + start Sweep.
# (You may need to right-click → Open the first time, due to Mac Gatekeeper.)

set -e
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║    Sweep by Arvantis — Launcher      ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js not found."
  echo ""
  echo "  Install it first:"
  echo "    https://nodejs.org/en/download"
  echo ""
  echo "  Then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "  First-time setup — installing dependencies (this takes ~3 min)..."
  echo ""
  npm install
  echo ""
  echo "  ✓ Setup complete."
  echo ""
fi

echo "  Starting Sweep — your browser will open to http://localhost:7879"
echo "  (Leave this Terminal window open while you use Sweep.)"
echo ""

npm start
