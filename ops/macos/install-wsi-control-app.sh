#!/bin/bash
# Install WSI Control.app to ~/Applications and optionally the Desktop.
# The installed copy remembers this repository path so it still works
# after being moved out of ops/macos/.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
SRC="$SCRIPT_DIR/WSI Control.app"
DEST_DIR="${WSI_CONTROL_APP_DIR:-$HOME/Applications}"
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/WSI Control.app"
rm -rf "$DEST"
ditto "$SRC" "$DEST"
mkdir -p "$DEST/Contents/Resources"
printf '%s' "$REPO" > "$DEST/Contents/Resources/repo.path"
chmod +x "$DEST/Contents/MacOS/wsi-control"
if [[ "${WSI_CONTROL_ALSO_DESKTOP:-1}" == "1" ]]; then
  DESKTOP="$HOME/Desktop/WSI Control.app"
  rm -rf "$DESKTOP"
  ditto "$DEST" "$DESKTOP"
  echo "Installed Desktop copy: $DESKTOP"
fi
echo "Installed: $DEST"
echo "Repository: $REPO"
echo "Double-click WSI Control to launch, quit, or relaunch the image server and ingestion engine."
