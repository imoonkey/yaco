#!/usr/bin/env bash
# Smoke test for scripts/yaco-doctor.sh.
#
# Seeds a temp YACO_HOME with a clean migrated fixture (1 fake project, valid
# tasks.json, valid events.jsonl, etc.), runs the doctor and asserts exit 0.
# Then introduces each failure mode in turn, asserts the doctor exits non-zero
# and emits a relevant FAIL line, then restores. Final step re-runs against
# the clean fixture to confirm cleanup.
#
# Usage: bash scripts/test-yaco-doctor.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCTOR="$SCRIPT_DIR/yaco-doctor.sh"

if [ ! -x "$DOCTOR" ]; then
  echo "FAIL: $DOCTOR not found or not executable" >&2
  exit 1
fi

FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAIL=1; }

# ---- fixture setup ---------------------------------------------------------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export YACO_HOME="$TMP/.yaco"
# Point check-6 scanner at an empty directory so live-repo scans don't leak
# in. Tests with intentional legacy hits seed their own directory under TMP.
export YACO_DOCTOR_SCAN_ROOTS="$TMP/scan"
mkdir -p "$YACO_DOCTOR_SCAN_ROOTS"

REPO="$TMP/fake-repo"
PROJECT_ID="fake"

seed_clean_fixture() {
  rm -rf "$YACO_HOME" "$REPO"
  mkdir -p "$YACO_HOME/projects/$PROJECT_ID"
  mkdir -p "$REPO/projects/active"

  cat > "$YACO_HOME/projects.json" <<JSON
[
  {"id": "$PROJECT_ID", "path": "$REPO"}
]
JSON

  # valid tasks.json: one milestone parent + one leaf child with acceptCriteria
  cat > "$REPO/projects/tasks.json" <<'JSON'
{
  "demo-milestone": {
    "title": "Demo milestone",
    "state": "ready"
  },
  "demo-leaf": {
    "title": "Demo leaf task",
    "parent": "demo-milestone",
    "state": "ready",
    "acceptCriteria": ["it works"]
  }
}
JSON

  # valid events.jsonl: two valid event lines
  cat > "$YACO_HOME/projects/$PROJECT_ID/events.jsonl" <<JSON
{"id":"evt1","ts":"2026-05-01T10:00:00.000Z","kind":"dispatched","projectId":"$PROJECT_ID","taskId":"demo-leaf"}
{"id":"evt2","ts":"2026-05-01T11:00:00.000Z","kind":"session_idle","projectId":"$PROJECT_ID","sessionId":"w-x"}
JSON

  # scan dir starts empty (no legacy hits)
  rm -rf "$YACO_DOCTOR_SCAN_ROOTS"
  mkdir -p "$YACO_DOCTOR_SCAN_ROOTS"
}

# Run doctor, capture stdout+stderr and exit code.
# Sets globals: DOC_OUT (log path), DOC_RC (exit code).
run_doctor() {
  DOC_OUT="$TMP/doctor.log"
  set +e
  "$DOCTOR" > "$DOC_OUT" 2>&1
  DOC_RC=$?
  set -e
}

assert_exit() {
  # assert_exit <label> <expected-cond>  where cond is "zero" or "nonzero"
  local label="$1" want="$2"
  case "$want" in
    zero)
      if [ "$DOC_RC" = 0 ]; then pass "$label (exit 0)"
      else fail "$label (exit $DOC_RC); log:"; sed 's/^/        /' "$DOC_OUT" >&2; fi
      ;;
    nonzero)
      if [ "$DOC_RC" != 0 ]; then pass "$label (exit $DOC_RC)"
      else fail "$label (expected non-zero, got 0); log:"; sed 's/^/        /' "$DOC_OUT" >&2; fi
      ;;
  esac
}

assert_log_match() {
  # assert_log_match <label> <regex>
  if grep -E -q -- "$2" "$DOC_OUT"; then
    pass "$1"
  else
    fail "$1 (regex '$2' not found); log tail:"
    tail -30 "$DOC_OUT" | sed 's/^/        /' >&2
  fi
}

# ---- scenario 0: clean fixture passes -------------------------------------

echo
echo '=== scenario 0: clean fixture passes ==='
seed_clean_fixture
run_doctor
assert_exit "clean fixture" zero
assert_log_match "clean: check 1 PASS" '^PASS  check 1:'
assert_log_match "clean: check 2 PASS" '^PASS  check 2:'
assert_log_match "clean: check 3 PASS" '^PASS  check 3:'
assert_log_match "clean: check 4 PASS" '^PASS  check 4:'
assert_log_match "clean: check 6 PASS" '^PASS  check 6:'
assert_log_match "clean: check 7 PASS" '^PASS  check 7:'
# check 5 may PASS or WARN depending on multmux availability; just assert
# either is emitted (not FAIL).
if grep -E -q '^FAIL  check 5:' "$DOC_OUT"; then
  fail "clean: check 5 unexpectedly FAILed"
else
  pass "clean: check 5 PASS or WARN"
fi

# ---- scenario 1: missing registry path ------------------------------------

echo
echo '=== scenario 1: missing registry path (check 1) ==='
seed_clean_fixture
rm -rf "$REPO"   # registered path no longer exists
run_doctor
assert_exit "missing path" nonzero
assert_log_match "missing path: check 1 FAIL" '^FAIL  check 1:'
assert_log_match "missing path: mentions project id" "fake -> $REPO"

# ---- scenario 2: duplicate project id -------------------------------------

echo
echo '=== scenario 2: duplicate project id (check 2) ==='
seed_clean_fixture
mkdir -p "$TMP/fake-repo-2"
cat > "$YACO_HOME/projects.json" <<JSON
[
  {"id": "fake", "path": "$REPO"},
  {"id": "fake", "path": "$TMP/fake-repo-2"}
]
JSON
run_doctor
assert_exit "duplicate id" nonzero
assert_log_match "dup id: check 2 FAIL" '^FAIL  check 2:'

# ---- scenario 3: invalid tasks.json (missing acceptCriteria on leaf) ------

echo
echo '=== scenario 3: invalid tasks.json (check 3) ==='
seed_clean_fixture
cat > "$REPO/projects/tasks.json" <<'JSON'
{
  "broken-leaf": {
    "title": "Leaf without acceptCriteria",
    "state": "ready"
  }
}
JSON
run_doctor
assert_exit "invalid tasks.json (leaf ac)" nonzero
assert_log_match "bad tasks: check 3 FAIL" '^FAIL  check 3:'
assert_log_match "bad tasks: mentions acceptCriteria" 'acceptCriteria'

# ---- scenario 3b: tasks.json with dangling parent ref ---------------------

echo
echo '=== scenario 3b: tasks.json dangling parent (check 3) ==='
seed_clean_fixture
cat > "$REPO/projects/tasks.json" <<'JSON'
{
  "orphan": {
    "title": "Orphan",
    "parent": "ghost",
    "state": "ready",
    "acceptCriteria": ["x"]
  }
}
JSON
run_doctor
assert_exit "dangling parent" nonzero
assert_log_match "dangling: check 3 FAIL" '^FAIL  check 3:'
assert_log_match "dangling: mentions parent" "parent 'ghost'"

# ---- scenario 4: invalid events.jsonl line --------------------------------

echo
echo '=== scenario 4: invalid events.jsonl (check 4) ==='
seed_clean_fixture
# Append a non-JSON line and a JSON line missing required fields.
{
  echo 'this is not json'
  echo '{"id":"x","kind":"y"}'  # missing ts + projectId
} >> "$YACO_HOME/projects/$PROJECT_ID/events.jsonl"
run_doctor
assert_exit "bad events.jsonl" nonzero
assert_log_match "bad events: check 4 FAIL" '^FAIL  check 4:'
assert_log_match "bad events: mentions invalid line" 'invalid line'

# ---- scenario 5: multmux status failure (simulated) -----------------------
#
# We can't easily make the real multmux binary fail without disturbing the
# operator's environment. The doctor's design says "skip with WARN if multmux
# is unavailable" — so we exercise the WARN path by removing multmux + bun
# from PATH and unsetting MULTMUX_SRC.

echo
echo '=== scenario 5: multmux unavailable -> WARN, doctor still exits 0 ==='
seed_clean_fixture
DOC_OUT="$TMP/doctor.log"
set +e
env -i HOME="$HOME" PATH="/usr/bin:/bin" \
    YACO_HOME="$YACO_HOME" \
    YACO_DOCTOR_SCAN_ROOTS="$YACO_DOCTOR_SCAN_ROOTS" \
    MULTMUX_SRC="$TMP/does-not-exist.ts" \
    "$DOCTOR" > "$DOC_OUT" 2>&1
DOC_RC=$?
set -e
assert_exit "multmux unavailable -> exit 0" zero
assert_log_match "multmux unavailable: WARN emitted" '^WARN  check 5:.*skipped'

# ---- scenario 6: residual workstream.json ---------------------------------

echo
echo '=== scenario 6: residual workstream.json (check 7) ==='
seed_clean_fixture
mkdir -p "$REPO/projects/active/old-bundle"
cat > "$REPO/projects/active/old-bundle/workstream.json" <<'JSON'
{"status":"active","doc":"design.md"}
JSON
run_doctor
assert_exit "residual workstream.json" nonzero
assert_log_match "residual: check 7 FAIL" '^FAIL  check 7:'
assert_log_match "residual: mentions workstream.json path" 'old-bundle/workstream.json'

# ---- scenario 7: new live legacy reference (check 6) ----------------------

echo
echo '=== scenario 7: new ~/.workflow reference outside allowlist (check 6) ==='
seed_clean_fixture
mkdir -p "$YACO_DOCTOR_SCAN_ROOTS/src/lib"
cat > "$YACO_DOCTOR_SCAN_ROOTS/src/lib/sneaky.ts" <<'TS'
// new file added by someone who forgot YACO migration
import { join } from "node:path";
import { homedir } from "node:os";
export const sessionDir = join(homedir(), ".multmux", "sessions");
TS
run_doctor
assert_exit "new legacy ref" nonzero
assert_log_match "new legacy: check 6 FAIL" '^FAIL  check 6:'
assert_log_match "new legacy: mentions sneaky.ts" 'sneaky\.ts'

# ---- final: clean fixture still passes ------------------------------------

echo
echo '=== final: clean fixture still passes (regression-check) ==='
seed_clean_fixture
run_doctor
assert_exit "final clean" zero
assert_log_match "final: OK summary" '^OK  all checks passed'

# ---- summary --------------------------------------------------------------

echo
if [ "$FAIL" = 0 ]; then
  echo 'test-yaco-doctor: all assertions PASS'
  exit 0
else
  echo 'test-yaco-doctor: one or more assertions FAILED' >&2
  exit 1
fi
