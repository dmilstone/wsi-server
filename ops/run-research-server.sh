#!/bin/bash
# Line 3 Academic Research Platform launcher.
# Binds the viewer to 9090 and the operations dashboard to 9094 so this
# instance cannot collide with the primary Line 1/2 pair (8080/8084).
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$OPS_DIR/.." && pwd)"

resolve_wsi_home() {
    local raw="${WSI_HOME:-${WSIHOME:-}}"
    if [[ -n "$raw" ]]; then
        printf '%s\n' "$raw"
        return 0
    fi
    if [[ -n "${USERPROFILE:-}" ]]; then
        printf '%s\n' "${USERPROFILE}/wsi"
        return 0
    fi
    if [[ -n "${HOME:-}" ]]; then
        printf '%s\n' "${HOME}/wsi"
        return 0
    fi
    printf '%s\n' "${PWD}/wsi"
}

expand_path() {
    local value="$1"
    case "$value" in
        "~/"*) value="${HOME:-}${value#\~}" ;;
        "~") value="${HOME:-}" ;;
    esac
    printf '%s\n' "$value"
}

source_kv_file() {
    local path="$1"
    [[ -f "$path" ]] || return 0
    local line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        if [[ "$line" == export\ * ]]; then
            line="${line#export }"
            line="${line#"${line%%[![:space:]]*}"}"
        fi
        [[ "$line" == *=* ]] || continue
        key="${line%%=*}"
        value="${line#*=}"
        key="${key%"${key##*[![:space:]]}"}"
        key="${key#"${key%%[![:space:]]*}"}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
            value="${value#\"}"
            value="${value%\"}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
            value="${value#\'}"
            value="${value%\'}"
        fi
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        case "$key" in
            WSI_*|SERVER_PORT) ;;
            *) continue ;;
        esac
        printf -v "$key" '%s' "$value"
        export "$key"
    done < "$path"
}

find_python() {
    if command -v python3 >/dev/null 2>&1; then
        command -v python3
        return 0
    fi
    if command -v python >/dev/null 2>&1; then
        command -v python
        return 0
    fi
    echo "error: python3 (or python) is required" >&2
    exit 1
}

find_maven_wrapper() {
    if [[ -x "$REPO_ROOT/mvnw" ]]; then
        printf '%s\n' "$REPO_ROOT/mvnw"
        return 0
    fi
    if [[ -f "$REPO_ROOT/mvnw" ]]; then
        printf '%s\n' "$REPO_ROOT/mvnw"
        return 0
    fi
    if [[ -f "$REPO_ROOT/mvnw.cmd" ]]; then
        printf '%s\n' "$REPO_ROOT/mvnw.cmd"
        return 0
    fi
    echo "error: Maven wrapper not found under $REPO_ROOT" >&2
    exit 1
}

BACKGROUND_PIDS=""
INGEST_CONTROL_DIR=""
CLEANED_UP=0

register_background() {
    local pid="$1"
    if [[ -n "$BACKGROUND_PIDS" ]]; then
        BACKGROUND_PIDS="$BACKGROUND_PIDS $pid"
    else
        BACKGROUND_PIDS="$pid"
    fi
}

cleanup() {
    local status=$?
    local pid
    if [[ "$CLEANED_UP" -eq 1 ]]; then
        return 0
    fi
    CLEANED_UP=1
    trap - EXIT INT TERM HUP
    if [[ -n "$INGEST_CONTROL_DIR" ]]; then
        mkdir -p "$INGEST_CONTROL_DIR"
        : >"$INGEST_CONTROL_DIR/stop"
    fi
    for pid in $BACKGROUND_PIDS; do
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    if [[ -n "$BACKGROUND_PIDS" ]]; then
        sleep 0.4
        for pid in $BACKGROUND_PIDS; do
            if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        done
    fi
    return "$status"
}

trap cleanup EXIT INT TERM HUP

WSI_HOME="$(expand_path "$(resolve_wsi_home)")"
export WSI_HOME

WSI_RESEARCH_PROFILE="${WSI_RESEARCH_PROFILE:-research-develop}"
case "$WSI_RESEARCH_PROFILE" in
    research-develop|research-deploy) ;;
    *)
        echo "error: WSI_RESEARCH_PROFILE must be research-develop or research-deploy" >&2
        exit 1
        ;;
esac
export WSI_RESEARCH_PROFILE

INGEST_CONF="${WSI_OPS_INGEST_CONF_FILE:-$OPS_DIR/wsi-ingest.conf}"
LOCAL_ENV="${WSI_OPS_ENV_LOCAL:-$OPS_DIR/.env.local}"
source_kv_file "$INGEST_CONF"
source_kv_file "$LOCAL_ENV"

# Port split is mandatory for Line 3. Re-apply after conf so 8080/8084 cannot win.
export SERVER_PORT="${SERVER_PORT:-9090}"
export WSI_DASHBOARD_PORT="${WSI_DASHBOARD_PORT:-9094}"
if [[ "$SERVER_PORT" == "8080" || "$WSI_DASHBOARD_PORT" == "8084" ]]; then
    echo "error: research launcher refuses primary sockets 8080/8084" >&2
    exit 1
fi
export WSI_OPS_DASHBOARD_LISTEN_PORT="${WSI_DASHBOARD_PORT}"
export WSI_CONTROL_VIEWER_PORT="${SERVER_PORT}"
export WSI_CONTROL_VIEWER_HOST="${WSI_CONTROL_VIEWER_HOST:-127.0.0.1}"
export WSI_ENVIRONMENT="${WSI_ENVIRONMENT:-development}"
export WSI_INGEST_DAEMON_REFRESH_URL="${WSI_INGEST_DAEMON_REFRESH_URL:-https://127.0.0.1:${SERVER_PORT}}"
export WSI_OPS_DASHBOARD_URL="${WSI_OPS_DASHBOARD_URL:-https://127.0.0.1:${WSI_DASHBOARD_PORT}/services}"

PROFILE_ROOT="${WSI_HOME}/${WSI_RESEARCH_PROFILE}"
# Conf may name clinical Line 1/2 roots. Isolate unless the operator opts in.
if [[ "${WSI_RESEARCH_KEEP_CONF_ROOTS:-0}" == "1" ]]; then
    export WSI_INGEST_STAGING_ROOT="$(expand_path "${WSI_INGEST_STAGING_ROOT:-${PROFILE_ROOT}/ingest-staging}")"
    export WSI_INGEST_PRODUCTION_ROOT="$(expand_path "${WSI_INGEST_PRODUCTION_ROOT:-${PROFILE_ROOT}/slides}")"
    export WSI_IMAGE_DIRECTORY="$(expand_path "${WSI_IMAGE_DIRECTORY:-${WSI_INGEST_PRODUCTION_ROOT}}")"
else
    export WSI_INGEST_STAGING_ROOT="$(expand_path "${PROFILE_ROOT}/ingest-staging")"
    export WSI_INGEST_PRODUCTION_ROOT="$(expand_path "${PROFILE_ROOT}/slides")"
    export WSI_IMAGE_DIRECTORY="$(expand_path "${WSI_RESEARCH_IMAGE_DIRECTORY:-${PROFILE_ROOT}/slides}")"
fi
export WSI_INGEST_NETWORK_STABLE_SECONDS="${WSI_INGEST_NETWORK_STABLE_SECONDS:-2}"

mkdir -p "$WSI_INGEST_STAGING_ROOT" "$WSI_INGEST_PRODUCTION_ROOT"

MARKER="$WSI_IMAGE_DIRECTORY/.wsi-environment-${WSI_ENVIRONMENT}"
if ! compgen -G "${WSI_IMAGE_DIRECTORY}/.wsi-environment-*" >/dev/null; then
    : >"$MARKER"
fi

INGEST_CONTROL_DIR="${WSI_INGEST_STAGING_ROOT}/.wsi-ingest-control/daemon"
mkdir -p "$INGEST_CONTROL_DIR"
rm -f "$INGEST_CONTROL_DIR/stop" "$INGEST_CONTROL_DIR/pause"

PYTHON_BIN="$(find_python)"
MVN_WRAPPER="$(find_maven_wrapper)"
export WSI_INGEST_DAEMON_LOG="${WSI_INGEST_DAEMON_LOG:-${INGEST_CONTROL_DIR}/daemon.log.jsonl}"

echo "WSI research server"
echo "  profile:     ${WSI_RESEARCH_PROFILE}"
echo "  WSI_HOME:    ${WSI_HOME}"
echo "  repo:        ${REPO_ROOT}"
echo "  viewer:      https://${WSI_CONTROL_VIEWER_HOST}:${SERVER_PORT}/"
echo "  dashboard:   ${WSI_OPS_DASHBOARD_URL}"
echo "  images:      ${WSI_IMAGE_DIRECTORY}"
echo "  staging:     ${WSI_INGEST_STAGING_ROOT}"
echo "  ingest conf: ${INGEST_CONF}"

"$PYTHON_BIN" -u "$OPS_DIR/wsi_ingest_daemon.py" &
register_background "$!"
echo "  ingest pid:  $!"

if [[ -n "${WSI_OPS_DASHBOARD_PASSWORD:-}" ]]; then
    "$PYTHON_BIN" -u "$OPS_DIR/wsi_ops_dashboard.py" &
    register_background "$!"
    echo "  dashboard:   started (pid $!)"
else
    echo "  dashboard:   skipped (set WSI_OPS_DASHBOARD_PASSWORD to bind ${WSI_DASHBOARD_PORT})"
fi

cd "$REPO_ROOT"
BOOT_ARGS="--server.port=${SERVER_PORT} --wsi.environment=${WSI_ENVIRONMENT} --wsi.image-directory=${WSI_IMAGE_DIRECTORY}"
echo "  maven:       ${MVN_WRAPPER} spring-boot:run -Dspring-boot.run.arguments=\"--server.port=${SERVER_PORT}\""
"$MVN_WRAPPER" spring-boot:run -Dspring-boot.run.arguments="${BOOT_ARGS}"
