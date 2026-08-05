#!/bin/bash
# Monitored end-to-end release orchestration. Sourced by wsi-release.

RESUME="${RESUME:-false}"
CYCLE_FORMAT=1
CYCLE_BRANCH="${WSI_CYCLE_BRANCH:-feature/multichannel-viewer}"
CYCLE_REMOTE="${WSI_CYCLE_REMOTE:-origin}"
CYCLE_RUNTIME="${WSI_CYCLE_RUNTIME:-$REPO/.runtime}"
CYCLE_RUN="$CYCLE_RUNTIME/run"
CYCLE_LOG_DIR="$CYCLE_RUNTIME/log"
CYCLE_STATE="$CYCLE_RUN/release-cycle.state"
CYCLE_PHASE="initialization"
CYCLE_ID=""
CYCLE_LOG=""

cycle_say() { printf '%s\n' "$*"; [[ -z "$CYCLE_LOG" ]] || printf '%s\n' "$*" >>"$CYCLE_LOG"; }
cycle_fail() {
    cycle_say "FAIL [$CYCLE_PHASE]: $1"
    cycle_say "Detailed log: ${CYCLE_LOG:-not created}"
    if [[ -n "${CYCLE_BACKUP:-}" ]]; then
        cycle_say "Safest next command: ./ops/wsi-release rollback --step (backup: $CYCLE_BACKUP)"
    else
        cycle_say "Safest next command: ./ops/wsi-release cycle --resume"
    fi
    exit 1
}
cycle_hash_file() { [[ -f "$1" ]] && sha256 "$1" || printf absent; }
cycle_hash_config() {
    local root="$1"
    local config="$root/config/application.properties"
    local image annotations marker
    image="$(property_value "$config" wsi.image-directory)"
    annotations="$(property_value "$config" wsi.annotations.directory)"
    marker="$(find "$image" -maxdepth 1 -name '.wsi-environment-*' -print 2>/dev/null | sort | sha256_stream)"
    printf '%s' "$(cycle_hash_file "$config")|$image|$annotations|$marker" | sha256_stream
}
sha256_stream() { shasum -a 256 | awk '{print $1}'; }
cycle_state_get() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/,""); print; exit}' "$CYCLE_STATE"; }
cycle_save() {
    local tmp="$CYCLE_STATE.tmp"
    [[ -z "${TAG_NAME:-}" ]] || validate_tag_name "$TAG_NAME"
    mkdir -p "$CYCLE_RUN"
    umask 077
    cat >"$tmp" <<EOF
format=$CYCLE_FORMAT
cycle_id=$CYCLE_ID
repository=$(cd "$REPO" && pwd -P)
branch=$CYCLE_BRANCH
head=$CYCLE_HEAD
remote_commit=${CYCLE_REMOTE_COMMIT:-unpublished}
completed_phase=${CYCLE_COMPLETED:-0}
candidate_jar=${CYCLE_JAR:-}
candidate_sha=${CYCLE_SHA:-}
staging_identity=${CYCLE_STAGING_ID:-}
rehearsal_identity=${CYCLE_REHEARSAL_ID:-}
production_identity=${CYCLE_PRODUCTION_ID:-}
human_gates=${CYCLE_GATES:-}
production_backup=${CYCLE_BACKUP:-}
requested_tag=${TAG_NAME:-}
development_fingerprint=${CYCLE_DEV_FP:-}
staging_fingerprint=${CYCLE_STAGING_FP:-}
rehearsal_fingerprint=${CYCLE_REHEARSAL_FP:-}
production_fingerprint=${CYCLE_PROD_FP:-}
EOF
    mv "$tmp" "$CYCLE_STATE"
}
cycle_command() {
    local description="$1"; shift
    local display; display="$(quote_command "$@")"
    if $DRY_RUN; then cycle_say "  command: $display"; return 0; fi
    if $STEP_MODE; then
        local answer
        while true; do
            printf '\nSTEP: %s\nCOMMAND: %s\n' "$description" "$display"
            read -r -p "Press Enter to run, p to print again, or q to stop safely: " answer || cycle_fail "Input closed."
            case "$answer" in "") break;; p|P) continue;; q|Q) cycle_say "Stopped safely before: $description"; exit 0;; *) echo "Please press Enter, p, or q.";; esac
        done
    fi
    cycle_say "  RUN $description"
    if $VERBOSE; then "$@" 2>&1 | tee -a "$CYCLE_LOG"; else "$@" >>"$CYCLE_LOG" 2>&1; fi || cycle_fail "$description failed."
    cycle_say "  PASS $description"
}
cycle_gate() {
    local environment="$1" token="$2" answer
    cycle_say "Browser QC — $environment"
    cycle_say "  [ ] correct banner/title; login; image discovery/opening/switching"
    cycle_say "  [ ] tiles, pan/zoom, channel and display controls"
    cycle_say "  [ ] annotation load/select/create/name/rename/delete/persist and global Show/Hide"
    cycle_say "  [ ] exports; $environment annotation-directory isolation"
    cycle_say "  [ ] console has no application Promise rejection or unexpected 403/400/500"
    cycle_say "  [ ] no sustained unexpected performance delay"
    $DRY_RUN && { cycle_say "  expected gate: $token"; return; }
    read -r -p "Type $token: " answer || cycle_fail "Input closed at $token gate."
    [[ "$answer" = "$token" ]] || cycle_fail "$token was not entered exactly."
    CYCLE_GATES="${CYCLE_GATES:+$CYCLE_GATES,}$token"
}
cycle_phase() { CYCLE_PHASE="$2"; cycle_say "PHASE $1 — $2"; }
cycle_identity() { local root="$1"; printf '%s|%s|%s' "$(cat "$root/app/BUILD_COMMIT.txt" 2>/dev/null || :)" "$(cat "$root/app/BUILD_TAG.txt" 2>/dev/null || :)" "$(cycle_hash_file "$root/app/wsi-server.jar")"; }
cycle_dry_preflight() {
    local branch remote root label config environment port image annotations markers tracked sync candidate candidate_sha
    branch="$(git -C "$REPO" branch --show-current 2>/dev/null || printf unavailable)"
    remote="$(git -C "$REPO" rev-parse --verify -q "refs/remotes/$CYCLE_REMOTE/$CYCLE_BRANCH" 2>/dev/null || printf unavailable)"
    tracked="$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null | sed -n '1p' || printf unavailable)"
    if [[ -z "$tracked" ]]; then tracked=clean; fi
    if [[ "$CYCLE_HEAD" = unavailable || "$remote" = unavailable ]]; then
        sync="unavailable"
    elif [[ "$CYCLE_HEAD" = "$remote" ]]; then
        sync="synchronized"
    elif git -C "$REPO" merge-base --is-ancestor "$remote" "$CYCLE_HEAD" 2>/dev/null; then
        sync="local ahead of remote"
    else
        sync="not synchronized"
    fi
    candidate="$REPO/target/$JAR_NAME"
    cycle_say "  branch: $branch"
    cycle_say "  HEAD: $CYCLE_HEAD"
    cycle_say "  remote feature commit (local tracking ref; no network): $remote"
    cycle_say "  tracked tree: $tracked"
    cycle_say "  local/remote synchronization: $sync"
    if [[ -f "$candidate" ]]; then
        candidate_sha="$(sha256 "$candidate")"
        cycle_say "  candidate JAR: $candidate"
        cycle_say "  candidate SHA-256: $candidate_sha"
    else
        cycle_say "  candidate JAR: not built"
    fi
    cycle_say "  available disk KiB: $(df -Pk "$REPO" 2>/dev/null | awk 'NR==2 {print $4}' || printf unavailable)"
    for label in development staging rehearsal production; do
        case "$label" in
            development) root="$CYCLE_RUNTIME"; environment=development; port=8081 ;;
            staging) root="$STAGING"; environment=staging; port=8082 ;;
            rehearsal) root="$REHEARSAL"; environment=production; port=8083 ;;
            production) root="$PRODUCTION"; environment=production; port=8080 ;;
        esac
        config="$root/config/application.properties"
        image="$(property_value "$config" wsi.image-directory 2>/dev/null || :)"
        annotations="$(property_value "$config" wsi.annotations.directory 2>/dev/null || :)"
        if [[ -n "$image" && -d "$image" ]]; then
            markers="$(find "$image" -maxdepth 1 -name '.wsi-environment-*' -print 2>/dev/null | paste -sd, -)"
        else
            markers=""
        fi
        cycle_say "  $label: root=$root config=$config expected-mode=$environment port=$port"
        cycle_say "  $label: images=${image:-unavailable} markers=${markers:-unavailable} annotations=${annotations:-unavailable}"
        cycle_say "  $label identity: $(cycle_identity "$root")"
    done
    cycle_say "  production listener PID: $(listener_pid 8080 || printf unavailable)"
    cycle_say "  PASS read-only preflight report complete (no remote contact)"
}
cycle_validate_config() {
    local label="$1" expected="$2" root="$3" port="$4" annotation image
    validate_environment_config "$expected" "$root/config/application.properties" "$port" >>"$CYCLE_LOG"
    annotation="$(property_value "$root/config/application.properties" wsi.annotations.directory)"
    image="$(property_value "$root/config/application.properties" wsi.image-directory)"
    [[ -n "$annotation" && -d "$annotation" ]] || cycle_fail "$label annotation directory is missing: $annotation"
    case "$image|$annotation" in *"$STAGING"*"$PRODUCTION"*|*"$PRODUCTION"*"$STAGING"*) cycle_fail "$label crosses environment boundaries.";; esac
}
cycle_resume_load() {
    [[ -s "$CYCLE_STATE" ]] || cycle_fail "No resumable state exists at $CYCLE_STATE."
    [[ "$(cycle_state_get format)" = "$CYCLE_FORMAT" ]] || cycle_fail "Unsupported state format."
    CYCLE_ID="$(cycle_state_get cycle_id)"; CYCLE_HEAD="$(cycle_state_get head)"; CYCLE_COMPLETED="$(cycle_state_get completed_phase)"
    CYCLE_REMOTE_COMMIT="$(cycle_state_get remote_commit)"; CYCLE_JAR="$(cycle_state_get candidate_jar)"; CYCLE_SHA="$(cycle_state_get candidate_sha)"
    CYCLE_STAGING_ID="$(cycle_state_get staging_identity)"; CYCLE_REHEARSAL_ID="$(cycle_state_get rehearsal_identity)"; CYCLE_PRODUCTION_ID="$(cycle_state_get production_identity)"
    CYCLE_GATES="$(cycle_state_get human_gates)"; CYCLE_BACKUP="$(cycle_state_get production_backup)"
    local saved_tag; saved_tag="$(cycle_state_get requested_tag)"
    if [[ -n "$saved_tag" ]]; then
        validate_tag_name "$saved_tag"
        if [[ -n "${TAG_NAME:-}" && "$TAG_NAME" != "$saved_tag" ]]; then
            cycle_fail "Resume tag conflicts with saved requested tag: saved $saved_tag, requested $TAG_NAME."
        fi
        TAG_NAME="$saved_tag"
    elif [[ -n "${TAG_NAME:-}" ]]; then
        validate_tag_name "$TAG_NAME"
    fi
    CYCLE_DEV_FP="$(cycle_state_get development_fingerprint)"
    CYCLE_STAGING_FP="$(cycle_state_get staging_fingerprint)"
    CYCLE_REHEARSAL_FP="$(cycle_state_get rehearsal_fingerprint)"
    CYCLE_PROD_FP="$(cycle_state_get production_fingerprint)"
    [[ -n "$CYCLE_DEV_FP" ]] || cycle_fail "Resume state is missing development fingerprint."
    [[ -n "$CYCLE_STAGING_FP" ]] || cycle_fail "Resume state is missing staging fingerprint."
    [[ -n "$CYCLE_REHEARSAL_FP" ]] || cycle_fail "Resume state is missing rehearsal fingerprint."
    [[ -n "$CYCLE_PROD_FP" ]] || cycle_fail "Resume state is missing production fingerprint."
    [[ "$(cd "$REPO" && pwd -P)" = "$(cycle_state_get repository)" ]] || cycle_fail "Repository path changed."
    [[ "$(git -C "$REPO" branch --show-current)" = "$CYCLE_BRANCH" && "$(git -C "$REPO" rev-parse HEAD)" = "$CYCLE_HEAD" ]] || cycle_fail "Repository branch or HEAD changed."
    [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || cycle_fail "Tracked working tree changed."
    [[ -z "$CYCLE_JAR" || ! -f "$CYCLE_JAR" || "$(sha256 "$CYCLE_JAR")" = "$CYCLE_SHA" ]] || cycle_fail "Candidate checksum changed."
    if [[ "$CYCLE_REMOTE_COMMIT" != unpublished ]]; then
        [[ "$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/heads/$CYCLE_BRANCH" | awk 'NR==1{print $1}')" = "$CYCLE_REMOTE_COMMIT" ]] || cycle_fail "Remote feature commit changed."
    fi
    [[ "$CYCLE_DEV_FP" = "$(cycle_hash_config "$CYCLE_RUNTIME")" ]] || cycle_fail "Development configuration changed."
    [[ "$CYCLE_STAGING_FP" = "$(cycle_hash_config "$STAGING")" ]] || cycle_fail "Staging configuration changed."
    [[ "$CYCLE_REHEARSAL_FP" = "$(cycle_hash_config "$REHEARSAL")" ]] || cycle_fail "Rehearsal configuration changed."
    [[ "$CYCLE_PROD_FP" = "$(cycle_hash_config "$PRODUCTION")" ]] || cycle_fail "Production configuration changed."
    if [[ "$CYCLE_COMPLETED" -ge 4 ]]; then [[ "$(cycle_identity "$STAGING")" = "$CYCLE_STAGING_ID" && -n "$(listener_pid 8082)" ]] || cycle_fail "Staging identity or process changed."; fi
    if [[ "$CYCLE_COMPLETED" -ge 5 ]]; then [[ "$(cycle_identity "$REHEARSAL")" = "$CYCLE_REHEARSAL_ID" && -n "$(listener_pid 8083)" ]] || cycle_fail "Rehearsal identity or process changed."; fi
    [[ "$(cycle_identity "$PRODUCTION")" = "$CYCLE_PRODUCTION_ID" && -n "$(listener_pid 8080)" ]] || cycle_fail "Production identity or process changed."
    if [[ -n "$CYCLE_BACKUP" && -d "$CYCLE_BACKUP" ]]; then
        [[ -r "$CYCLE_BACKUP/app/ORIGINAL_SHA256.txt" && "$(sha256 "$CYCLE_BACKUP/app/wsi-server.jar")" = "$(cat "$CYCLE_BACKUP/app/ORIGINAL_SHA256.txt")" ]] || cycle_fail "Production backup identity changed."
    fi
}
cycle_release() {
    local branch remote production_before answer tag_answer free_kb needed_kb candidate dev_pid staging_pid rehearsal_pid
    if $DRY_RUN; then
        CYCLE_ID="dry-run-$(date +%Y%m%d-%H%M%S)"; CYCLE_HEAD="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || printf unavailable)"
        cycle_say "WSI release cycle DRY-RUN (no filesystem, Git, process, backup, push or tag changes)"
    else
        mkdir -p "$CYCLE_LOG_DIR" "$CYCLE_RUN"; CYCLE_ID="$(date +%Y%m%d-%H%M%S)-$$"; CYCLE_LOG="$CYCLE_LOG_DIR/cycle-$CYCLE_ID.log"; : >"$CYCLE_LOG"
    fi
    cycle_phase 1 "repository preflight"
    cycle_say "  repository: $(cd "$REPO" && pwd -P)"; cycle_say "  required branch: $CYCLE_BRANCH"
    $DRY_RUN && cycle_dry_preflight
    $DRY_RUN && CYCLE_COMPLETED=0 || {
        if $RESUME; then cycle_resume_load; cycle_say "  PASS resumable assumptions verified; completed phase $CYCLE_COMPLETED"; else
            branch="$(git -C "$REPO" branch --show-current)"; [[ "$branch" = "$CYCLE_BRANCH" ]] || cycle_fail "Required branch is $CYCLE_BRANCH; found $branch."
            [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || cycle_fail "Tracked working tree is not clean."
            CYCLE_HEAD="$(git -C "$REPO" rev-parse HEAD)"; git -C "$REPO" merge-base --is-ancestor 8a6ddf4453540ccd21b4c740e6b30ce823febec7 "$CYCLE_HEAD" || cycle_fail "Required commit 8a6ddf4 is not an ancestor."
            CYCLE_REMOTE_COMMIT="$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/heads/$CYCLE_BRANCH" | awk 'NR==1{print $1}')"; [[ -n "$CYCLE_REMOTE_COMMIT" ]] || cycle_fail "Remote feature branch is missing."
            git -C "$REPO" merge-base --is-ancestor "$CYCLE_REMOTE_COMMIT" "$CYCLE_HEAD" || cycle_fail "Local feature history diverges from $CYCLE_REMOTE/$CYCLE_BRANCH."
            cycle_validate_config development development "$CYCLE_RUNTIME" 8081; cycle_validate_config staging staging "$STAGING" 8082; cycle_validate_config rehearsal production "$REHEARSAL" 8083; cycle_validate_config production production "$PRODUCTION" 8080
            verify_runtime production >>"$CYCLE_LOG" || cycle_fail "Production is not initially healthy."
            free_kb="$(df -Pk "$PRODUCTION" | awk 'NR==2{print $4}')"; needed_kb="$(du -sk "$PRODUCTION" | awk '{print $1}')"; [[ "$free_kb" -gt "$needed_kb" ]] || cycle_fail "Insufficient disk space."
            production_before="$(cycle_identity "$PRODUCTION")"; CYCLE_PRODUCTION_ID="$production_before"
            CYCLE_DEV_FP="$(cycle_hash_config "$CYCLE_RUNTIME")"; CYCLE_STAGING_FP="$(cycle_hash_config "$STAGING")"; CYCLE_REHEARSAL_FP="$(cycle_hash_config "$REHEARSAL")"; CYCLE_PROD_FP="$(cycle_hash_config "$PRODUCTION")"; CYCLE_COMPLETED=1; cycle_save
        fi
    }
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 2 ]] || {
        cycle_phase 2 "automated development validation"
        cycle_command "Maven clean tests" "$REPO/mvnw" clean test
        cycle_command "JavaScript tests" bash -c 'node --test "$1"/src/test/js/*.test.js' _ "$REPO"
        cycle_command "operations tests" "$REPO/ops/tests/run.sh"
        cycle_command "Git whitespace check" git -C "$REPO" diff --check
        cycle_command "tracked status check" git -C "$REPO" status --short
        cycle_command "stop development only" "$WSI_CONTROL" development stop
        cycle_command "start development" "$WSI_CONTROL" development start
        [[ -n "$(listener_pid 8081)" ]] || cycle_fail "Development is not listening on port 8081."
        cycle_gate development DEVELOPMENT-PASS; CYCLE_COMPLETED=2; cycle_save
    }
    if $DRY_RUN; then cycle_phase 2 "automated development validation"; for c in './mvnw clean test' 'node --test src/test/js/*.test.js' './ops/tests/run.sh' 'git diff --check' 'git status --short' 'wsi development stop/start'; do cycle_say "  command: $c"; done; cycle_gate development DEVELOPMENT-PASS; fi
    cycle_phase 3 "publish candidate"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 3 ]] || {
        [[ "$(git -C "$REPO" rev-parse HEAD)" = "$CYCLE_HEAD" && -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || cycle_fail "Tested source changed."
        remote="$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/heads/$CYCLE_BRANCH" | awk 'NR==1{print $1}')"
        if [[ "$remote" = "$CYCLE_HEAD" ]]; then cycle_say "  PASS candidate already published"; else cycle_command "push tested feature branch" git -C "$REPO" push "$CYCLE_REMOTE" "$CYCLE_BRANCH"; fi
        CYCLE_REMOTE_COMMIT="$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/heads/$CYCLE_BRANCH" | awk 'NR==1{print $1}')"; [[ "$CYCLE_REMOTE_COMMIT" = "$CYCLE_HEAD" ]] || cycle_fail "Remote verification failed."
        CYCLE_COMPLETED=3; cycle_save
    }
    $DRY_RUN && cycle_say "  command after DEVELOPMENT-PASS: git push $CYCLE_REMOTE $CYCLE_BRANCH"
    cycle_phase 4 "staging"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 4 ]] || { ASSUME_YES=true; stage_release; CYCLE_JAR="$STAGING/app/wsi-server.jar"; CYCLE_SHA="$(sha256 "$CYCLE_JAR")"; CYCLE_STAGING_ID="$(cycle_identity "$STAGING")"; cycle_gate staging STAGING-PASS; CYCLE_COMPLETED=4; cycle_save; }
    $DRY_RUN && { cycle_say "  action: build/test, verified staging backup/install/start on 8082"; cycle_gate staging STAGING-PASS; }
    cycle_phase 5 "production rehearsal"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 5 ]] || { ASSUME_YES=true; rehearse_release; [[ "$(sha256 "$REHEARSAL/app/wsi-server.jar")" = "$CYCLE_SHA" ]] || cycle_fail "Rehearsal is not the exact staging artifact."; CYCLE_REHEARSAL_ID="$(cycle_identity "$REHEARSAL")"; cycle_gate rehearsal REHEARSAL-PASS; CYCLE_COMPLETED=5; cycle_save; }
    $DRY_RUN && { cycle_say "  action: copy exact staging JAR; application mode: production; rehearsal port: 8083"; cycle_gate rehearsal REHEARSAL-PASS; }
    cycle_phase 6 "final promotion preflight"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 6 ]] || {
        verify_runtime staging >>"$CYCLE_LOG"; verify_runtime rehearsal >>"$CYCLE_LOG"; verify_runtime production >>"$CYCLE_LOG" || cycle_fail "Final health verification failed."
        [[ "$(cycle_identity "$STAGING")" = "$(cycle_identity "$REHEARSAL")" ]] || cycle_fail "Staging and rehearsal identities differ."
        [[ "$(git -C "$REPO" rev-parse HEAD)" = "$CYCLE_HEAD" && "$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/heads/$CYCLE_BRANCH" | awk 'NR==1{print $1}')" = "$CYCLE_HEAD" ]] || cycle_fail "Candidate no longer equals repository HEAD and remote feature branch."
        free_kb="$(df -Pk "$PRODUCTION" | awk 'NR==2{print $4}')"; needed_kb="$(du -sk "$PRODUCTION" | awk '{print $1}')"; [[ "$free_kb" -gt "$needed_kb" ]] || cycle_fail "Insufficient space for the complete production backup."
        CYCLE_BACKUP="$PRODUCTION/releases/$(date +%Y%m%d-%H%M%S)"
        cycle_say "  candidate commit: $CYCLE_HEAD"; cycle_say "  build: $(cat "$STAGING/app/BUILD_TAG.txt")"; cycle_say "  SHA-256: $CYCLE_SHA"; cycle_say "  source: $STAGING/app/wsi-server.jar"; cycle_say "  production target: $PRODUCTION/app/wsi-server.jar"; cycle_say "  backup: $CYCLE_BACKUP"
        read -r -p "Type PROMOTE: " answer || cycle_fail "Input closed at PROMOTE gate."; [[ "$answer" = PROMOTE ]] || cycle_fail "PROMOTE was not entered exactly."
        CYCLE_GATES="${CYCLE_GATES:+$CYCLE_GATES,}PROMOTE"; CYCLE_COMPLETED=6; cycle_save
    }
    $DRY_RUN && { cycle_say "  expected identities and backup-space checks"; cycle_say "  expected gate: PROMOTE"; }
    cycle_phase 7 "production backup and promotion"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 7 ]] || {
        dev_pid="$(listener_pid 8081)"; staging_pid="$(listener_pid 8082)"; rehearsal_pid="$(listener_pid 8083)"
        backup_production "$CYCLE_BACKUP"; [[ -r "$CYCLE_BACKUP/app/ORIGINAL_SHA256.txt" && -r "$CYCLE_BACKUP/config/application.properties" ]] || cycle_fail "Production backup verification failed."
        cycle_say "  PASS verified backup before production stop: $CYCLE_BACKUP"
        candidate="$PRODUCTION/app/wsi-server.candidate.jar"; cp -p "$CYCLE_JAR" "$candidate"; [[ "$(sha256 "$candidate")" = "$CYCLE_SHA" ]] || cycle_fail "Production candidate differs."
        "$WSI_CONTROL" production stop >>"$CYCLE_LOG" 2>&1 || cycle_fail "Production stop failed."
        mv "$candidate" "$PRODUCTION/app/wsi-server.jar"; write_metadata "$PRODUCTION" "$(cat "$STAGING/app/BUILD_TAG.txt")" "$CYCLE_HEAD" "$CYCLE_SHA"
        "$WSI_CONTROL" production start >>"$CYCLE_LOG" 2>&1 || cycle_fail "Production startup failed. Exact rollback: ./ops/wsi-release rollback --step; backup: $CYCLE_BACKUP"
        verify_runtime production >>"$CYCLE_LOG" || cycle_fail "Automated production verification failed. Exact rollback: ./ops/wsi-release rollback --step; backup: $CYCLE_BACKUP"
        [[ "$(listener_pid 8081)" = "$dev_pid" && "$(listener_pid 8082)" = "$staging_pid" && "$(listener_pid 8083)" = "$rehearsal_pid" ]] || cycle_fail "A non-production environment changed during promotion."
        CYCLE_PRODUCTION_ID="$(cycle_identity "$PRODUCTION")"; CYCLE_COMPLETED=7; cycle_save
    }
    $DRY_RUN && cycle_say "  action: verified complete backup BEFORE stopping only production; exact artifact install/start/verify"
    cycle_phase 8 "production browser QC and optional tag"
    $DRY_RUN || [[ "$CYCLE_COMPLETED" -ge 8 ]] || { cycle_gate production PRODUCTION-PASS; CYCLE_COMPLETED=8; cycle_save; cycle_say "RELEASE COMPLETED SUCCESSFULLY"; }
    if $DRY_RUN; then cycle_gate production PRODUCTION-PASS; cycle_say "  expected optional tag prompt: TAG or SKIP"; return; fi
    if [[ -z "$TAG_NAME" ]]; then read -r -p "Tag name, or SKIP: " TAG_NAME; fi
    if [[ "$TAG_NAME" = SKIP ]]; then cycle_say "Tagging skipped; use ./ops/wsi-release tag later."; else
        read -r -p "Type TAG to create and publish $TAG_NAME: " tag_answer; [[ "$tag_answer" = TAG ]] || cycle_fail "TAG was not entered exactly."
        ASSUME_YES=true; tag_release
        [[ "$(git -C "$REPO" rev-parse "$TAG_NAME^{}")" = "$CYCLE_HEAD" ]] || cycle_fail "Local tag target verification failed."
        remote="$(git -C "$REPO" ls-remote "$CYCLE_REMOTE" "refs/tags/$TAG_NAME^{}" | awk 'NR==1{print $1}')"; [[ "$remote" = "$CYCLE_HEAD" ]] || cycle_fail "Remote tag target verification failed."
    fi
}
