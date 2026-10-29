#!/usr/bin/env bash
# launchd entry point, and the way to run the built server by hand.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Pinned interpreter: better-sqlite3 is a native module built for this Node ABI, so moving
# to another Node is a deliberate edit here plus `npm rebuild`.
NODE=/Users/dylansavage/.nvm/versions/node/v22.22.3/bin/node

# tokenstash writes keys to the parent folder's .env.local.
exec "$NODE" \
  --env-file-if-exists="$REPO/.env.local" \
  --env-file-if-exists="$REPO/../.env.local" \
  dist/server/main.js
