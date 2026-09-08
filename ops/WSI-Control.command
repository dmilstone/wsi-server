#!/bin/bash
# Double-click launcher on macOS. Prefer the .app in ops/macos or ~/Applications.
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export WSI_REPO="$(CDPATH= cd -- "$HERE/.." && pwd)"
exec /usr/bin/python3 "$HERE/wsi_control_app.py"
