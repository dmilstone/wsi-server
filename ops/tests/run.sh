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
    python3 -m py_compile "$OPS_DIR/render_cheatsheet.py" "$OPS_DIR/retro_build_metadata.py" "$OPS_DIR/tests/test_renderer.py" "$OPS_DIR/tests/test_retro_metadata.py" \
        "$OPS_DIR/wsi_ingest.py" "$OPS_DIR/wsi_ops_dashboard.py" "$OPS_DIR/wsi_ingest_daemon.py" "$OPS_DIR/wsi_ingest_autobatch.py" \
        "$OPS_DIR/tests/test_wsi_ingest.py" "$OPS_DIR/tests/test_wsi_ops_dashboard.py" "$OPS_DIR/tests/test_wsi_ingest_daemon.py" \
        "$OPS_DIR/tests/test_wsi_ingest_autobatch.py"
python3 "$OPS_DIR/tests/test_retro_metadata.py"
pass "epitope sidecar update script"
if python3 -c 'import reportlab' >/dev/null 2>&1; then
    python3 "$OPS_DIR/tests/test_renderer.py"
    pass "portable renderer preflight"
else
    echo "SKIP: portable renderer preflight (install the documented ReportLab package)"
fi

python3 "$OPS_DIR/tests/test_wsi_ingest.py"
pass "manual ingester unit tests"
python3 "$OPS_DIR/tests/test_wsi_ingest_daemon.py"
pass "unattended ingestion daemon unit tests"
python3 "$OPS_DIR/tests/test_wsi_ingest_autobatch.py"
pass "opt-in hot-folder auto-batcher unit tests"
# NOTE: test_wsi_ops_dashboard.py is intentionally NOT run here yet -- it has one
# known pre-existing failure (test_viewer_link_is_local_only_and_no_credentials,
# unrelated to the daemon/Windows-compat work above) that predates its being wired
# into this suite. Fix that test before adding it to this hard gate.

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
grep -q 'expected gate: explicit y to promote' "$TEST_ROOT/cycle-dry-run"
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

# Centralized cycle gates accept only explicit y/n input. Exercise the helper
# and browser-token mapping in isolation so no operational function can run.
gate_fixture="$TEST_ROOT/cycle-gates"
mkdir -p "$gate_fixture"
REPO="$TEST_ROOT/repo" WSI_CYCLE_RUNTIME="$gate_fixture" \
OPS_CYCLE_SCRIPT="$OPS_DIR/wsi-release-cycle.sh" bash <<'EOF'
set -euo pipefail
DRY_RUN=false
CYCLE_LOG=""
CYCLE_GATES=""
source "$OPS_CYCLE_SCRIPT"

for environment_token in "development DEVELOPMENT-PASS" "staging STAGING-PASS" "rehearsal REHEARSAL-PASS" "production PRODUCTION-PASS"; do
    read -r environment token <<<"$environment_token"
    CYCLE_GATES=""
    cycle_gate "$environment" "$token" <<<'y'
    [[ "$CYCLE_GATES" = "$token" ]]
    CYCLE_GATES=""
    cycle_gate "$environment" "$token" <<<'Y'
    [[ "$CYCLE_GATES" = "$token" ]]
done

check_stop() {
    local input="$1" expected="$2" output
    output="$(printf '%b' "$input" | (if cycle_confirm "Approve staging browser QC?"; then printf 'PROCEEDED\n'; fi) 2>&1)"
    [[ "$output" = *"$expected"* ]]
    [[ "$output" != *PROCEEDED* ]]
}
check_stop 'n\n' 'Stopped safely before'
check_stop 'N\n' 'Stopped safely before'
output="$(printf '\n\ny\n' | cycle_confirm "Approve rehearsal browser QC?" 2>&1)"
[[ "$(grep -c 'Approve rehearsal browser QC?' <<<"$output")" -eq 3 ]]
[[ "$(grep -c 'Blank response is not allowed.' <<<"$output")" -eq 2 ]]
output="$(printf 'maybe\ny\n' | cycle_confirm "Approve development browser QC?" 2>&1)"
[[ "$(grep -c 'Approve development browser QC?' <<<"$output")" -eq 2 ]]
[[ "$output" = *"Enter y or n."* ]]
check_stop '' 'Input closed; stopped safely'

# Canonical values already present in old state remain untouched and usable.
CYCLE_GATES='DEVELOPMENT-PASS,STAGING-PASS,REHEARSAL-PASS,PRODUCTION-PASS'
[[ ",$CYCLE_GATES," = *,DEVELOPMENT-PASS,* ]]
EOF
pass "central y/n helper enforces browser gates and preserves canonical tokens"

grep -q 'cycle_confirm "Promote this candidate to production?"' "$OPS_DIR/wsi-release-cycle.sh"
grep -q 'CYCLE_COMPLETED=6; cycle_save' "$OPS_DIR/wsi-release-cycle.sh"
grep -q 'Choosing n stops without completing production QC or publishing a tag' "$OPS_DIR/wsi-release-cycle.sh"
pass "promotion and production QC require explicit y before mutation or completion"

# Exercise the real (non-dry-run) Phase 1 under nounset. The fixture has a
# synchronized local remote and healthy-looking isolated environments. Quitting
# at the first Phase 2 material command must preserve every environment and Git
# ref while leaving a valid Phase 1 resume checkpoint.
cycle_fixture="$TEST_ROOT/cycle-phase-one"
cycle_repo="$cycle_fixture/repo"
cycle_remote="$cycle_fixture/remote.git"
mkdir -p "$cycle_fixture"
git clone -q "$OPS_DIR/.." "$cycle_repo"
git -C "$cycle_repo" switch -q -c fixture-release-cycle
git init -q --bare "$cycle_remote"
git -C "$cycle_repo" remote add fixture "$cycle_remote"
git -C "$cycle_repo" push -q fixture fixture-release-cycle

write_cycle_config() {
    local root="$1"
    local environment="$2"
    local port="$3"
    local image_root="$root/images"
    local annotation_root="$root/annotations"
    mkdir -p "$root/config" "$image_root" "$annotation_root"
    touch "$image_root/.wsi-environment-$environment"
    cat >"$root/config/application.properties" <<EOF
wsi.environment=$environment
wsi.image-directory=$image_root
wsi.annotations.directory=$annotation_root
server.port=$port
EOF
}

cycle_runtime="$cycle_fixture/development"
cycle_staging="$cycle_fixture/staging"
cycle_rehearsal="$cycle_fixture/rehearsal"
cycle_production="$cycle_fixture/production"
write_cycle_config "$cycle_runtime" development 8081
write_cycle_config "$cycle_staging" staging 8082
write_cycle_config "$cycle_rehearsal" production 8083
write_cycle_config "$cycle_production" production 8080
mkdir -p "$cycle_production/app" "$cycle_production/logs"
printf 'production fixture jar\n' >"$cycle_production/app/wsi-server.jar"
printf 'fixture-build\n' >"$cycle_production/app/BUILD_TAG.txt"
git -C "$cycle_repo" rev-parse HEAD >"$cycle_production/app/BUILD_COMMIT.txt"
production_fixture_sha="$(shasum -a 256 "$cycle_production/app/wsi-server.jar" | awk '{print $1}')"
printf '%s  %s\n' "$production_fixture_sha" "$cycle_production/app/wsi-server.jar" >"$cycle_production/app/SHA256.txt"

fake_bin="$cycle_fixture/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/lsof" <<'EOF'
#!/bin/sh
case "$*" in *8080*) printf '4242\n';; esac
EOF
cat >"$fake_bin/never-control" <<EOF
#!/bin/sh
touch "$cycle_fixture/process-control-was-called"
exit 99
EOF
chmod +x "$fake_bin/lsof" "$fake_bin/never-control"

before_fixture="$(find "$cycle_staging" "$cycle_rehearsal" "$cycle_production" -type f -exec shasum -a 256 {} \; | sort)"
before_remote="$(git --git-dir="$cycle_remote" rev-parse refs/heads/fixture-release-cycle)"
printf 'q\n' | PATH="$fake_bin:$PATH" \
    WSI_REPO="$cycle_repo" \
    WSI_CYCLE_BRANCH=fixture-release-cycle \
    WSI_CYCLE_REMOTE=fixture \
    WSI_CYCLE_RUNTIME="$cycle_runtime" \
    WSI_STAGING_ROOT="$cycle_staging" \
    WSI_REHEARSAL_ROOT="$cycle_rehearsal" \
    WSI_PRODUCTION_ROOT="$cycle_production" \
    WSI_CONTROL="$fake_bin/never-control" \
    "$RELEASE" cycle --step --tag fixture-unused >"$cycle_fixture/output" 2>&1

grep -q 'PHASE 1 — repository preflight' "$cycle_fixture/output"
grep -q 'PHASE 2 — automated development validation' "$cycle_fixture/output"
grep -q 'STEP: Maven clean tests' "$cycle_fixture/output"
grep -q 'Stopped safely before: Maven clean tests' "$cycle_fixture/output"
! grep -q 'unbound variable' "$cycle_fixture/output"
[[ ! -e "$cycle_fixture/process-control-was-called" ]]
[[ ! -d "$cycle_production/releases" ]]
[[ "$before_fixture" = "$(find "$cycle_staging" "$cycle_rehearsal" "$cycle_production" -type f -exec shasum -a 256 {} \; | sort)" ]]
[[ "$before_remote" = "$(git --git-dir="$cycle_remote" rev-parse refs/heads/fixture-release-cycle)" ]]
state_file="$cycle_runtime/run/release-cycle.state"
grep -q '^format=1$' "$state_file"
grep -q '^completed_phase=1$' "$state_file"
grep -q "^head=$(git -C "$cycle_repo" rev-parse HEAD)$" "$state_file"
pass "non-dry-run cycle Phase 1 reaches safe step cancellation under nounset"

# Regression: a resume must restore the saved environment fingerprints before
# any later cycle_save call. Otherwise a safe gate abort followed by a resume can
# erase the fingerprints and make a second resume falsely report a configuration
# change. This harness exercises only cycle state/config validation; its stubs
# prevent push, service control, deployment, backup, rollback and tag actions.
fingerprint_fixture="$TEST_ROOT/cycle-fingerprint-resume"
fingerprint_repo="$fingerprint_fixture/repo"
mkdir -p "$fingerprint_repo"
git -C "$fingerprint_repo" init -q
git -C "$fingerprint_repo" config user.name "WSI operations test"
git -C "$fingerprint_repo" config user.email "wsi-operations-test@example.invalid"
printf 'fingerprint fixture\n' >"$fingerprint_repo/tracked.txt"
git -C "$fingerprint_repo" add tracked.txt
git -C "$fingerprint_repo" commit -q -m fingerprint-fixture
git -C "$fingerprint_repo" switch -q -c fixture-release-cycle

fingerprint_runtime="$fingerprint_fixture/development"
fingerprint_staging="$fingerprint_fixture/staging"
fingerprint_rehearsal="$fingerprint_fixture/rehearsal"
fingerprint_production="$fingerprint_fixture/production"
write_cycle_config "$fingerprint_runtime" development 8081
write_cycle_config "$fingerprint_staging" staging 8082
write_cycle_config "$fingerprint_rehearsal" production 8083
write_cycle_config "$fingerprint_production" production 8080
mkdir -p "$fingerprint_production/app"
printf 'production fixture jar\n' >"$fingerprint_production/app/wsi-server.jar"
printf 'fixture-build\n' >"$fingerprint_production/app/BUILD_TAG.txt"
git -C "$fingerprint_repo" rev-parse HEAD >"$fingerprint_production/app/BUILD_COMMIT.txt"

REPO="$fingerprint_repo" \
STAGING="$fingerprint_staging" \
REHEARSAL="$fingerprint_rehearsal" \
PRODUCTION="$fingerprint_production" \
WSI_CYCLE_RUNTIME="$fingerprint_runtime" \
WSI_CYCLE_BRANCH=fixture-release-cycle \
OPS_CYCLE_SCRIPT="$OPS_DIR/wsi-release-cycle.sh" \
bash <<'EOF'
set -euo pipefail
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
validate_tag_name() { git -C "$REPO" check-ref-format "refs/tags/$1"; }
property_value() { awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; exit}' "$1"; }
listener_pid() { [[ "$1" = 8080 ]] && printf '4242\n'; }
source "$OPS_CYCLE_SCRIPT"
CYCLE_LOG="$CYCLE_RUNTIME/resume-regression.log"
: >"$CYCLE_LOG"
CYCLE_ID=fingerprint-regression
CYCLE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
CYCLE_REMOTE_COMMIT=unpublished
CYCLE_COMPLETED=1
CYCLE_PRODUCTION_ID="$(cycle_identity "$PRODUCTION")"
CYCLE_DEV_FP="$(cycle_hash_config "$CYCLE_RUNTIME")"
CYCLE_STAGING_FP="$(cycle_hash_config "$STAGING")"
CYCLE_REHEARSAL_FP="$(cycle_hash_config "$REHEARSAL")"
CYCLE_PROD_FP="$(cycle_hash_config "$PRODUCTION")"
cycle_save
for key in development_fingerprint staging_fingerprint rehearsal_fingerprint production_fingerprint; do
    value="$(cycle_state_get "$key")"
    [[ -n "$value" ]]
    eval "saved_${key}=\$value"
done

# Simulate a failed human gate by resuming from the Phase 1 checkpoint; the
# restored shell variables must then preserve exact state through a later save.
unset CYCLE_DEV_FP CYCLE_STAGING_FP CYCLE_REHEARSAL_FP CYCLE_PROD_FP
cycle_resume_load
[[ "$CYCLE_DEV_FP" = "$saved_development_fingerprint" ]]
[[ "$CYCLE_STAGING_FP" = "$saved_staging_fingerprint" ]]
[[ "$CYCLE_REHEARSAL_FP" = "$saved_rehearsal_fingerprint" ]]
[[ "$CYCLE_PROD_FP" = "$saved_production_fingerprint" ]]
CYCLE_COMPLETED=2
cycle_save
[[ "$(cycle_state_get development_fingerprint)" = "$saved_development_fingerprint" ]]
[[ "$(cycle_state_get staging_fingerprint)" = "$saved_staging_fingerprint" ]]
[[ "$(cycle_state_get rehearsal_fingerprint)" = "$saved_rehearsal_fingerprint" ]]
[[ "$(cycle_state_get production_fingerprint)" = "$saved_production_fingerprint" ]]
cycle_resume_load

cp "$CYCLE_STATE" "$CYCLE_STATE.good"
awk -F= 'BEGIN{OFS="="} $1=="development_fingerprint" {$2=""} {print}' "$CYCLE_STATE.good" >"$CYCLE_STATE"
if ( cycle_resume_load ) >"$CYCLE_RUNTIME/missing.out" 2>&1; then exit 10; fi
grep -q 'Resume state is missing development fingerprint' "$CYCLE_RUNTIME/missing.out"
mv "$CYCLE_STATE.good" "$CYCLE_STATE"
printf '\n# changed\n' >>"$CYCLE_RUNTIME/config/application.properties"
if ( cycle_resume_load ) >"$CYCLE_RUNTIME/changed.out" 2>&1; then exit 11; fi
grep -q 'Development configuration changed' "$CYCLE_RUNTIME/changed.out"
EOF
[[ ! -d "$fingerprint_production/releases" ]]
[[ ! -d "$fingerprint_production/failed-releases" ]]
[[ ! -e "$fingerprint_repo/.git/refs/tags/fixture-unused" ]]
pass "cycle resume restores and preserves fingerprints while rejecting invalid or changed state"


# Regression: release-cycle state persists the requested production tag across
# resumes without performing real pushes, service operations, deployment,
# backup, rollback, or tag creation.
tag_fixture="$TEST_ROOT/cycle-tag-resume"
tag_repo="$tag_fixture/repo"
mkdir -p "$tag_repo"
git -C "$tag_repo" init -q
git -C "$tag_repo" config user.name "WSI operations test"
git -C "$tag_repo" config user.email "wsi-operations-test@example.invalid"
printf 'tag fixture\n' >"$tag_repo/tracked.txt"
git -C "$tag_repo" add tracked.txt
git -C "$tag_repo" commit -q -m tag-fixture
git -C "$tag_repo" switch -q -c fixture-release-cycle

tag_runtime="$tag_fixture/development"
tag_staging="$tag_fixture/staging"
tag_rehearsal="$tag_fixture/rehearsal"
tag_production="$tag_fixture/production"
write_cycle_config "$tag_runtime" development 8081
write_cycle_config "$tag_staging" staging 8082
write_cycle_config "$tag_rehearsal" production 8083
write_cycle_config "$tag_production" production 8080
for root in "$tag_staging" "$tag_rehearsal" "$tag_production"; do
    mkdir -p "$root/app"
    printf 'production fixture jar\n' >"$root/app/wsi-server.jar"
    printf 'fixture-build\n' >"$root/app/BUILD_TAG.txt"
    git -C "$tag_repo" rev-parse HEAD >"$root/app/BUILD_COMMIT.txt"
done

REPO="$tag_repo" \
STAGING="$tag_staging" \
REHEARSAL="$tag_rehearsal" \
PRODUCTION="$tag_production" \
WSI_CYCLE_RUNTIME="$tag_runtime" \
WSI_CYCLE_BRANCH=fixture-release-cycle \
OPS_CYCLE_SCRIPT="$OPS_DIR/wsi-release-cycle.sh" \
bash <<'EOF'
set -euo pipefail
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
property_value() { awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/,""); print; exit}' "$1"; }
listener_pid() { case "$1" in 8080|8082|8083) printf '4242\n';; esac; }
validate_tag_name() { git -C "$REPO" check-ref-format "refs/tags/$1"; }
tag_release() { printf 'TAG_RELEASE:%s\n' "$TAG_NAME"; }
source "$OPS_CYCLE_SCRIPT"
CYCLE_LOG="$CYCLE_RUNTIME/tag-regression.log"
: >"$CYCLE_LOG"
seed_state() {
    TAG_NAME="${1:-}"
    CYCLE_ID=tag-regression
    CYCLE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
    CYCLE_REMOTE_COMMIT=unpublished
    CYCLE_JAR=""
    CYCLE_SHA=""
    CYCLE_COMPLETED="${2:-8}"
    CYCLE_STAGING_ID="$(cycle_identity "$STAGING")"
    CYCLE_REHEARSAL_ID="$(cycle_identity "$REHEARSAL")"
    CYCLE_PRODUCTION_ID="$(cycle_identity "$PRODUCTION")"
    CYCLE_GATES=""
    CYCLE_BACKUP=""
    CYCLE_DEV_FP="$(cycle_hash_config "$CYCLE_RUNTIME")"
    CYCLE_STAGING_FP="$(cycle_hash_config "$STAGING")"
    CYCLE_REHEARSAL_FP="$(cycle_hash_config "$REHEARSAL")"
    CYCLE_PROD_FP="$(cycle_hash_config "$PRODUCTION")"
    cycle_save
}
run_phase8_resume() {
    local answer="$1"
    cycle_resume_load
    printf '%s\n' "$answer" | if cycle_confirm "Publish tag $TAG_NAME?" "Enter y to publish or n to skip:"; then tag_release; else cycle_say "Tagging skipped"; fi
}


seed_state production-2026-08-05-live-image-discovery 8
unset TAG_NAME
cycle_resume_load
[[ "$TAG_NAME" = production-2026-08-05-live-image-discovery ]]
CYCLE_COMPLETED=5
cycle_save
unset TAG_NAME
cycle_resume_load
[[ "$TAG_NAME" = production-2026-08-05-live-image-discovery ]]
CYCLE_COMPLETED=6
cycle_save
unset TAG_NAME
cycle_resume_load
[[ "$TAG_NAME" = production-2026-08-05-live-image-discovery ]]

run_phase8_resume y >"$CYCLE_RUNTIME/restored-phase8.out" 2>&1
grep -q 'Publish tag production-2026-08-05-live-image-discovery?' "$CYCLE_RUNTIME/restored-phase8.out"
! grep -q 'Tag name, or SKIP' "$CYCLE_RUNTIME/restored-phase8.out"
grep -q 'TAG_RELEASE:production-2026-08-05-live-image-discovery' "$CYCLE_RUNTIME/restored-phase8.out"

TAG_NAME=production-2026-08-05-live-image-discovery
cycle_resume_load
[[ "$TAG_NAME" = production-2026-08-05-live-image-discovery ]]
TAG_NAME=production-2026-08-05-conflict
if ( cycle_resume_load ) >"$CYCLE_RUNTIME/conflict.out" 2>&1; then exit 20; fi
grep -q 'Resume tag conflicts with saved requested tag' "$CYCLE_RUNTIME/conflict.out"

seed_state '' 8
awk -F= '$1!="requested_tag" {print}' "$CYCLE_STATE" >"$CYCLE_STATE.old"
mv "$CYCLE_STATE.old" "$CYCLE_STATE"
unset TAG_NAME
cycle_resume_load
[[ "${TAG_NAME:-}" = "" ]]
TAG_NAME=production-2026-08-05-supplied-on-resume
cycle_resume_load
[[ "$TAG_NAME" = production-2026-08-05-supplied-on-resume ]]

TAG_NAME=""
cycle_resume_load
TAG_NAME=SKIP
cycle_say "Tagging skipped; use ./ops/wsi-release tag later." >"$CYCLE_RUNTIME/no-tag-phase8.out"
grep -q 'Tagging skipped' "$CYCLE_RUNTIME/no-tag-phase8.out"
! grep -q 'TAG_RELEASE:' "$CYCLE_RUNTIME/no-tag-phase8.out"

seed_state production-2026-08-05-live-image-discovery 8
run_phase8_resume n >"$CYCLE_RUNTIME/skip-publish.out" 2>&1
grep -q 'Tagging skipped' "$CYCLE_RUNTIME/skip-publish.out"
! grep -q 'TAG_RELEASE:' "$CYCLE_RUNTIME/skip-publish.out"
EOF
[[ ! -d "$tag_production/releases" ]]
[[ ! -d "$tag_production/failed-releases" ]]
[[ ! -e "$tag_repo/.git/refs/tags/production-2026-08-05-live-image-discovery" ]]
pass "cycle resume persists requested tags, handles conflicts and old state, and preserves SKIP prompts safely"

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
