#!/usr/bin/env bash
# launchd entry point and the manual trigger. Same shape as stash's run_worker.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

# Pinned interpreter. better-sqlite3 is a native module built for this ABI, so an nvm
# upgrade must be a deliberate edit here plus `npm rebuild`, never a silent change.
NODE=/Users/dylansavage/.nvm/versions/node/v22.22.3/bin/node

exec "$NODE" dist/server/main.js
