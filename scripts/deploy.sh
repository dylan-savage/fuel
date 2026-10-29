#!/usr/bin/env bash
# Builds and (re)starts the launchd service from a clone outside ~/Desktop: macOS privacy
# protection denies launchd-started processes access to the Desktop folder, so the service
# cannot run from this checkout. Run this from a terminal after merging to main.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/fuel"
LABEL="com.dylansavage.fuel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

[ -d "$DEST/.git" ] || git clone -q "$SRC" "$DEST"
git -C "$DEST" pull -q --ff-only origin main
cd "$DEST"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

cp scripts/$LABEL.plist "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone, and bootstrapping over it fails with error 5.
for _ in $(seq 50); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.2
done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "deployed $(git rev-parse --short HEAD) from $DEST"
