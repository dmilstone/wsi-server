#!/bin/bash
# Legacy name kept so old shortcuts still work. This no longer resets git or
# builds from the old wsi-server_works tree. It relaunches the image server
# through the shared ops/wsi_service_control.py module.
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "Relaunching the image server via ops/wsi_service_control.py (no git reset)."
exec python3 "$HERE/ops/wsi_service_control.py" relaunch viewer
