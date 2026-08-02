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

bash -n "$RELEASE"
zsh -n "$CONTROL"
pass "shell syntax"

expect_failure "unknown command is rejected" "$RELEASE" unknown
expect_failure "verify requires a target" "$RELEASE" verify
expect_failure "unknown option is rejected" "$RELEASE" status --unsafe-option

mkdir -p "$TEST_ROOT/repo/.git" "$TEST_ROOT/staging/app" "$TEST_ROOT/staging/config" "$TEST_ROOT/rehearsal/app" "$TEST_ROOT/rehearsal/config" "$TEST_ROOT/production/app" "$TEST_ROOT/production/config" "$TEST_ROOT/production/logs"

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

# Build a small, non-running fixture and prove that stage --dry-run traverses
# preflight without producing a candidate or invoking process control.
rmdir "$TEST_ROOT/repo/.git"
git -C "$TEST_ROOT/repo" init -q
git -C "$TEST_ROOT/repo" config user.name "WSI operations test"
git -C "$TEST_ROOT/repo" config user.email "wsi-operations-test@example.invalid"
printf 'fixture\n' > "$TEST_ROOT/repo/tracked.txt"
git -C "$TEST_ROOT/repo" add tracked.txt
git -C "$TEST_ROOT/repo" commit -q -m fixture

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
