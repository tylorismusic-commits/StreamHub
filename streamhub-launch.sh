#!/usr/bin/env bash
# Launch StreamHub fullscreen — intended as the target of a Steam "Add a Non-Steam Game" entry.
#
# Steam starts its games from an arbitrary working directory and with a bare environment, so this
# resolves the app relative to itself and hands the real Electron binary the app directory and the
# --fullscreen flag (see createWindow in src/main.js).
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Prefer the packaged AppImage if one has been built; otherwise run from the source tree.
if [ -x "$here/dist/StreamHub.AppImage" ]; then
  exec "$here/dist/StreamHub.AppImage" --fullscreen "$@"
fi

exec "$here/node_modules/electron/dist/electron" "$here" --fullscreen "$@"
