#!/usr/bin/env bash
# Launch Stream Hub:HTPC fullscreen — intended as the target of a Steam "Add a Non-Steam Game" entry.
#
# Steam starts its games from an arbitrary working directory and with a bare environment, so this
# resolves the app relative to itself and hands the real Electron binary the app directory and the
# --fullscreen flag (see createWindow in src/main.js).
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Prefer the packaged AppImage if one has been built; otherwise run from the source tree. The
# artifact name is filesystem-safe (no spaces/colon) while the app itself presents as the full name.
for candidate in "$here/dist/StreamHub-HTPC.AppImage" "$here/dist/StreamHub.AppImage"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" --fullscreen "$@"
  fi
done

exec "$here/node_modules/electron/dist/electron" "$here" --fullscreen "$@"
