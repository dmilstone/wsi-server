#!/bin/bash

set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="$OPS_DIR/wsi-release"
CONTROL="$OPS_DIR/wsi"
TEST_ROOT="$(mktemp -d /tmp/wsi-ops-tests.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass_count=0

pass() {
    echo "PASS: $1"
    pass_count=$((pass_count + 1))
}

expect_failure() {
    local description="$1"
    shift
    if "$@" >"$TEST_ROOT/output" 2>&1; then
        echo "FAIL: $description unexpectedly succeeded"
        cat "$TEST_ROOT/output"
        exit 1
    fi
    pass "$description"
}

bash -n "$RELEASE" "$OPS_DIR/wsi-release-cycle.sh"
if command -v zsh >/dev/null 2>&1; then zsh -n "$CONTROL"; else bash -n "$CONTROL"; fi
pass "shell syntax"

PYTHONPYCACHEPREFIX="$TEST_ROOT/pycache" \
    python3 -m py_compile "$OPS_DIR/render_cheatsheet.py" "$OPS_DIR/tests/test_renderer.py"
if python3 -c 'import reportlab' >/dev/null 2>&1; then
    python3 "$OPS_DIR/tests/test_renderer.py"
    pass "portable renderer preflight"
else
    echo "SKIP: portable renderer preflight (install the documented ReportLab package)"
fi

expect_failure "unknown command is rejected" "$RELEASE" unknown
expect_failure "verify requires a target" "$RELEASE" verify
expect_failure "unknown option is rejected" "$RELEASE" status --unsafe-option

mkdir -p "$TEST_ROOT/repo" "$TEST_ROOT/staging/app" "$TEST_ROOT/staging/config" "$TEST_ROOT/rehearsal/app" "$TEST_ROOT/rehearsal/config" "$TEST_ROOT/production/app" "$TEST_ROOT/production/config" "$TEST_ROOT/production/logs"
git -C "$TEST_ROOT/repo" init -q
git -C "$TEST_ROOT/repo" config user.name "WSI operations test"
git -C "$TEST_ROOT/repo" config user.email "wsi-operations-test@example.invalid"
printf 'fixture\n' > "$TEST_ROOT/repo/tracked.txt"
git -C "$TEST_ROOT/repo" add tracked.txt
git -C "$TEST_ROOT/repo" commit -q -m fixture

if grep -Eq 'eval |rm -rf|git reset --hard|git checkout --' "$RELEASE"; then
    echo "FAIL: prohibited destructive or eval construct found"
    exit 1
fi
pass "no eval or broad destructive Git/filesystem operations"

grep -q 'Type PROMOTE' "$RELEASE"
grep -q 'Type ROLLBACK' "$RELEASE"
grep -q 'Annotations will not be restored or overwritten' "$RELEASE"
grep -q '\-\-step' "$RELEASE"
grep -q '\-\-dry-run' "$RELEASE"
pass "required safety tokens and modes are present"

for command in stage rehearse promote verify status history rollback tag; do
    grep -q "^[[:space:]]*$command)" "$RELEASE"
done
grep -q 'cycle)' "$RELEASE"
pass "cycle and all individual diagnostic commands remain available"

# The end-to-end dry-run is deliberately runnable without configurations or a
# remote. It must describe every gate in order and leave even its runtime state
# and log directories untouched.
cycle_runtime="$TEST_ROOT/cycle-runtime"
WSI_REPO="$TEST_ROOT/repo" WSI_CYCLE_RUNTIME="$cycle_runtime" \
    "$RELEASE" cycle --dry-run >"$TEST_ROOT/cycle-dry-run"
[[ ! -e "$cycle_runtime" ]]
previous=0
for phase in 1 2 3 4 5 6 7 8; do
    line="$(grep -n "PHASE $phase" "$TEST_ROOT/cycle-dry-run" | cut -d: -f1)"
    [[ "$line" -gt "$previous" ]]
    previous="$line"
done
dev_gate="$(grep -n 'expected gate: DEVELOPMENT-PASS' "$TEST_ROOT/cycle-dry-run" | cut -d: -f1)"
push_line="$(grep -n 'git push origin feature/multichannel-viewer' "$TEST_ROOT/cycle-dry-run" | cut -d: -f1)"
[[ "$dev_gate" -lt "$push_line" ]]
grep -q 'expected gate: STAGING-PASS' "$TEST_ROOT/cycle-dry-run"
grep -q 'expected gate: REHEARSAL-PASS' "$TEST_ROOT/cycle-dry-run"
grep -q 'expected gate: PROMOTE' "$TEST_ROOT/cycle-dry-run"
grep -q 'verified complete backup BEFORE stopping only production' "$TEST_ROOT/cycle-dry-run"
grep -q 'expected gate: PRODUCTION-PASS' "$TEST_ROOT/cycle-dry-run"
grep -q 'expected optional tag prompt: TAG or SKIP' "$TEST_ROOT/cycle-dry-run"
grep -q 'PASS read-only preflight report complete (no remote contact)' "$TEST_ROOT/cycle-dry-run"
grep -q 'remote feature commit (local tracking ref; no network)' "$TEST_ROOT/cycle-dry-run"
grep -q 'tracked tree: clean' "$TEST_ROOT/cycle-dry-run"
grep -q 'local/remote synchronization:' "$TEST_ROOT/cycle-dry-run"
grep -q 'candidate JAR: not built' "$TEST_ROOT/cycle-dry-run"
pass "cycle dry-run is mutation-free and preserves complete safe phase ordering"

expect_failure "cycle rejects an unknown option" "$RELEASE" cycle --not-a-mode
expect_failure "cycle tag requires a name" "$RELEASE" cycle --tag
grep -q 'Press Enter to run, p to print again, or q to stop safely' "$OPS_DIR/wsi-release-cycle.sh"
grep -q 'tee -a.*CYCLE_LOG' "$OPS_DIR/wsi-release-cycle.sh"
grep -q 'release-cycle.state' "$OPS_DIR/wsi-release-cycle.sh"
grep -q 'cycle --resume' "$OPS_DIR/wsi-release-cycle.sh"
pass "step, verbose, state, log and resume behavior is implemented"

if grep -Eq 'eval |rm -rf|git reset --hard|git checkout --' "$OPS_DIR/wsi-release-cycle.sh"; then
    echo "FAIL: cycle contains a prohibited destructive or eval construct"
    exit 1
fi
pass "cycle has no eval or broad destructive operation"

# Build a small, non-running fixture and prove that stage --dry-run traverses
# preflight without producing a candidate or invoking process control.
mkdir -p "$TEST_ROOT/staging-images"
touch "$TEST_ROOT/staging-images/.wsi-environment-staging"
cat > "$TEST_ROOT/staging/config/application.properties" <<EOF
wsi.environment=staging
wsi.image-directory=$TEST_ROOT/staging-images
server.port=8082
EOF
printf 'existing staging jar\n' > "$TEST_ROOT/staging/app/wsi-server.jar"
printf 'fixture-build\n' > "$TEST_ROOT/staging/app/BUILD_TAG.txt"
git -C "$TEST_ROOT/repo" rev-parse HEAD > "$TEST_ROOT/staging/app/BUILD_COMMIT.txt"
fixture_sha="$(shasum -a 256 "$TEST_ROOT/staging/app/wsi-server.jar" | awk '{print $1}')"
printf '%s  %s\n' "$fixture_sha" "$TEST_ROOT/staging/app/wsi-server.jar" > "$TEST_ROOT/staging/app/SHA256.txt"

WSI_REPO="$TEST_ROOT/repo" \
WSI_STAGING_ROOT="$TEST_ROOT/staging" \
WSI_PRODUCTION_ROOT="$TEST_ROOT/production" \
WSI_CONTROL="$TEST_ROOT/never-called-wsi" \
"$RELEASE" stage --dry-run > "$TEST_ROOT/dry-run-output"

grep -q '\[DRY-RUN\].*Run the complete Maven build and tests' "$TEST_ROOT/dry-run-output"
grep -q 'Require STAGE confirmation' "$TEST_ROOT/dry-run-output"
[[ ! -e "$TEST_ROOT/staging/app/wsi-server.candidate.jar" ]]
pass "stage dry-run performs no staging mutation"

mkdir -p "$TEST_ROOT/rehearsal-images"
touch "$TEST_ROOT/rehearsal-images/.wsi-environment-production"
cat > "$TEST_ROOT/rehearsal/config/application.properties" <<EOF
wsi.environment=production
wsi.image-directory=$TEST_ROOT/rehearsal-images
server.port=8083
EOF

WSI_REPO="$TEST_ROOT/repo" \
WSI_STAGING_ROOT="$TEST_ROOT/staging" \
WSI_REHEARSAL_ROOT="$TEST_ROOT/rehearsal" \
WSI_PRODUCTION_ROOT="$TEST_ROOT/production" \
WSI_CONTROL="$TEST_ROOT/never-called-wsi" \
"$RELEASE" rehearse --dry-run > "$TEST_ROOT/rehearse-dry-run-output"

grep -q 'exact staging JAR' "$TEST_ROOT/rehearse-dry-run-output"
grep -q 'require REHEARSE' "$TEST_ROOT/rehearse-dry-run-output"
[[ ! -e "$TEST_ROOT/rehearsal/app/wsi-server.candidate.jar" ]]
pass "rehearsal dry-run preserves isolation and performs no mutation"

grep -q 'PORT="8083"' "$CONTROL"
grep -q 'WSI_REHEARSAL_ROOT' "$CONTROL"
grep -q 'server.address=127.0.0.1' "$OPS_DIR/templates/rehearsal-application.properties"
grep -q 'wsi.environment=production' "$OPS_DIR/templates/rehearsal-application.properties"
pass "rehearsal is production-mode on loopback port 8083"

echo "All $pass_count operational script tests passed."
