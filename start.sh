#!/usr/bin/env sh
# Start the gemini-to-dsh bridge. POSIX sh, no bashisms, no absolute paths.
set -eu

cd "$(dirname "$0")/bridge"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH — install Node.js 20 or newer" >&2
  exit 1
fi

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "error: Node.js 20 or newer required, found $(node -v)" >&2
  exit 1
fi

exec node bridge.js