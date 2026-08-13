#!/usr/bin/env bash
# LaunchAgent entrypoint for the local ops dashboard.
# Loads ops/.env.local, then starts the dashboard under launchd supervision.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "error: missing $ENV_FILE" >&2
    echo "Create it from the placeholders in the repo (gitignored) before loading the LaunchAgent." >&2
    exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$REPO_ROOT"
# Tell start-wsi-ops-dashboard that launchd KeepAlive is the supervisor, so --daemon
# must run the listener in the foreground (not nohup).
export WSI_OPS_UNDER_LAUNCHD=1
exec "$SCRIPT_DIR/start-wsi-ops-dashboard" --daemon
