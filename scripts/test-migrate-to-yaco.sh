#!/usr/bin/env bash
# Smoke test for scripts/migrate-to-yaco.sh.
#
# Seeds a synthetic ~/.workflow, ~/.multmux, and a fake repo into a temp
# HOME, runs the migration script, asserts each acceptance criterion, then
# re-runs and asserts the second pass is a no-op (no [ok] write lines for
# operations that already happened).
#
# Usage: bash scripts/test-migrate-to-yaco.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE="$SCRIPT_DIR/migrate-to-yaco.sh"

if [ ! -x "$MIGRATE" ]; then
  echo "FAIL: $MIGRATE not found or not executable" >&2
  exit 1
fi

FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAIL=1; }

assert_file() {
  if [ -f "$1" ]; then pass "exists: $1"; else fail "missing file: $1"; fi
}
assert_dir() {
  if [ -d "$1" ]; then pass "exists: $1"; else fail "missing dir: $1"; fi
}
assert_eq() {
  # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1: $2"; else fail "$1: expected '$2' got '$3'"; fi
}
assert_contains() {
  # assert_contains <label> <needle> <haystack-file>
  if grep -q -- "$2" "$3"; then pass "$1: contains '$2'"; else fail "$1: '$2' not found in $3"; fi
}

# ---- temp HOME -------------------------------------------------------------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" /tmp/yaco-workstream-todos-fake.txt' EXIT

export HOME="$TMP"
export YACO_HOME="$TMP/.yaco"
export WORKFLOW_HOME="$TMP/.workflow"
export MULTMUX_HOME="$TMP/.multmux"
# This test exercises migration logic, not preflight; bypass the host-state
# checks so the test works whether or not the operator's real workflow
# server happens to be running on :3001.
export MIGRATE_SKIP_PREFLIGHT=1

REPO="$TMP/fake-repo"
mkdir -p "$REPO/projects/active/smart-capsule-v2"
mkdir -p "$REPO/projects/active/auth-rewrite"

# Top-level progress.json: 2 generic + 1 legacy ProgressEntry shape
cat > "$REPO/projects/progress.json" <<'JSON'
[
  {
    "id": "evt_top_1",
    "ts": "2026-05-10T10:00:00.000Z",
    "kind": "progress",
    "workstream": "smart-capsule-v2",
    "summary": "kickoff"
  },
  {
    "id": "evt_top_2",
    "ts": "2026-05-11T10:00:00.000Z",
    "kind": "progress",
    "workstream": "smart-capsule-v2",
    "summary": "design draft"
  },
  {
    "id": "p_legacy_idle",
    "agent": "claude",
    "type": "session_idle",
    "message": "session w-foo went idle",
    "timestamp": "2026-05-13T10:00:00.000Z",
    "status": "active",
    "sessionName": "w-foo",
    "workstream": "smart-capsule-v2"
  },
  {
    "id": "p_legacy_review",
    "agent": "codex",
    "type": "human_review",
    "message": "needs review",
    "timestamp": "2026-05-14T10:00:00.000Z",
    "status": "active",
    "sessionName": "w-bar"
  }
]
JSON

# Bundle-level progress.json (1 entry)
cat > "$REPO/projects/active/smart-capsule-v2/progress.json" <<'JSON'
[
  {
    "id": "evt_bundle_1",
    "ts": "2026-05-12T10:00:00.000Z",
    "kind": "checkpoint",
    "workstream": "smart-capsule-v2",
    "label": "Design approved"
  }
]
JSON

# Two workstream.json files
cat > "$REPO/projects/active/smart-capsule-v2/workstream.json" <<'JSON'
{
  "status": "active",
  "doc": "design.md",
  "checkpoints": [
    {"label": "Design approved", "done": true},
    {"label": "Core impl complete", "done": false}
  ]
}
JSON

cat > "$REPO/projects/active/auth-rewrite/workstream.json" <<'JSON'
{
  "status": "human_review",
  "doc": "design.md",
  "checkpoints": []
}
JSON

# ---- workflow / multmux state ---------------------------------------------

mkdir -p "$WORKFLOW_HOME/ui-state" \
         "$WORKFLOW_HOME/shell-sessions" \
         "$WORKFLOW_HOME/channels/whatsapp" \
         "$WORKFLOW_HOME/channels/wechat" \
         "$MULTMUX_HOME/sessions"

cat > "$WORKFLOW_HOME/projects.json" <<JSON
[
  {"name": "fake", "path": "$REPO"}
]
JSON

cat > "$WORKFLOW_HOME/ui-state/notifications.json" <<'JSON'
{"inbox": [{"id": "n1"}], "read": []}
JSON
cat > "$WORKFLOW_HOME/ui-state/pinned-sessions.json" <<'JSON'
{}
JSON
cat > "$WORKFLOW_HOME/shell-sessions/sh-1.json" <<'JSON'
{"handle":"sh-1","cwd":"/tmp"}
JSON
cat > "$WORKFLOW_HOME/channels/whatsapp/auth.json" <<'JSON'
{"token":"x"}
JSON
cat > "$WORKFLOW_HOME/channels/wechat/state.json" <<'JSON'
{"qr":"y"}
JSON

cat > "$MULTMUX_HOME/sessions/w-a.json" <<'JSON'
{"handle":"w-a","status":"idle"}
JSON
cat > "$MULTMUX_HOME/sessions/w-b.json" <<'JSON'
{"handle":"w-b","status":"processing"}
JSON
cat > "$MULTMUX_HOME/hook-v2.sh"    <<'SH'
#!/usr/bin/env bash
echo legacy-hook
SH
cat > "$MULTMUX_HOME/wrapper-v2.sh" <<'SH'
#!/usr/bin/env bash
echo legacy-wrapper
SH
chmod +x "$MULTMUX_HOME/hook-v2.sh" "$MULTMUX_HOME/wrapper-v2.sh"

# A "channel already partially migrated" case: pre-create one file at the destination.
mkdir -p "$YACO_HOME/channels/wechat"
cat > "$YACO_HOME/channels/wechat/state.json" <<'JSON'
{"qr":"pre-existing"}
JSON

# ---- run #1 ---------------------------------------------------------------

echo
echo '=== run #1 ==='
RUN1_LOG="$TMP/run1.log"
if ! "$MIGRATE" --yes > "$RUN1_LOG" 2>&1; then
  echo "FAIL: migrate-to-yaco.sh exited non-zero on run #1; log:" >&2
  sed 's/^/  /' "$RUN1_LOG" >&2
  exit 1
fi
sed 's/^/  /' "$RUN1_LOG"

# Acceptance: projects.json converted with id/path
assert_file "$YACO_HOME/projects.json"
if [ -f "$YACO_HOME/projects.json" ]; then
  ID=$(jq -r '.[0].id' "$YACO_HOME/projects.json")
  PATH_=$(jq -r '.[0].path' "$YACO_HOME/projects.json")
  assert_eq "projects.json id"   "fake" "$ID"
  assert_eq "projects.json path" "$REPO" "$PATH_"
fi

# Acceptance: ui-state, shell-sessions, sessions moved
assert_file "$YACO_HOME/ui-state/notifications.json"
assert_file "$YACO_HOME/ui-state/pinned-sessions.json"
assert_file "$YACO_HOME/shell-sessions/sh-1.json"
assert_file "$YACO_HOME/sessions/w-a.json"
assert_file "$YACO_HOME/sessions/w-b.json"

# Channels moved with per-scope merge; pre-existing wechat/state.json untouched
assert_file "$YACO_HOME/channels/whatsapp/auth.json"
assert_file "$YACO_HOME/channels/wechat/state.json"
PRE=$(jq -r '.qr' "$YACO_HOME/channels/wechat/state.json")
assert_eq "wechat state.json preserved (mv -n)" "pre-existing" "$PRE"

# Hook + wrapper scripts moved
assert_file "$YACO_HOME/hook-v2.sh"
assert_file "$YACO_HOME/wrapper-v2.sh"

# Source files removed (they were mv'd, not copied) — except hook/wrapper scripts
# which are intentionally COPIED so live old tmux sessions can still resolve them.
if [ ! -f "$WORKFLOW_HOME/shell-sessions/sh-1.json" ]; then
  pass "source shell-sessions/sh-1.json removed (mv)"
else
  fail "source shell-sessions/sh-1.json still present"
fi
if [ -f "$MULTMUX_HOME/hook-v2.sh" ]; then
  pass "source hook-v2.sh preserved (cp, not mv — live old sessions need it)"
else
  fail "source hook-v2.sh was removed; should be copied (cp) so live old sessions still resolve it"
fi
if [ -f "$MULTMUX_HOME/wrapper-v2.sh" ]; then
  pass "source wrapper-v2.sh preserved (cp, not mv — live old sessions need it)"
else
  fail "source wrapper-v2.sh was removed; should be copied (cp) so live old sessions still resolve it"
fi
# Permission bit preserved on the copy
if [ -x "$YACO_HOME/hook-v2.sh" ]; then
  pass "copied hook-v2.sh kept executable bit"
else
  fail "copied hook-v2.sh lost executable bit"
fi
# But the pre-existing wechat/state.json source must remain (mv -n skipped it)
if [ -f "$WORKFLOW_HOME/channels/wechat/state.json" ]; then
  pass "source channels/wechat/state.json preserved (mv -n collision)"
else
  fail "source channels/wechat/state.json was removed despite mv -n collision"
fi

# Acceptance: events.jsonl created with valid NDJSON
EVTS="$YACO_HOME/projects/fake/events.jsonl"
assert_file "$EVTS"
if [ -f "$EVTS" ]; then
  LINES=$(wc -l < "$EVTS" | tr -d ' ')
  # 4 top-level + 1 bundle = 5
  assert_eq "events.jsonl line count" "5" "$LINES"
  # Each line is valid JSON object with required fields
  VALID=$(jq -c 'select(.id and .ts and .kind and .projectId)' "$EVTS" | wc -l | tr -d ' ')
  assert_eq "events.jsonl valid NDJSON lines" "5" "$VALID"
  # taskId mapped from .workstream (slug)
  TASK_ID=$(jq -r 'select(.id == "evt_top_1") | .taskId' "$EVTS")
  assert_eq "events.jsonl taskId mapped from workstream" "smart-capsule-v2" "$TASK_ID"
  # Legacy ProgressEntry type=session_idle -> scanner-recognized event kind=session_idle
  IDLE_KIND=$(jq -r 'select(.id == "p_legacy_idle") | .kind' "$EVTS")
  assert_eq "legacy type=session_idle -> kind=session_idle" "session_idle" "$IDLE_KIND"
  # sessionName -> sessionId
  IDLE_SID=$(jq -r 'select(.id == "p_legacy_idle") | .sessionId' "$EVTS")
  assert_eq "legacy sessionName -> sessionId"             "w-foo"        "$IDLE_SID"
  # Original message + agent preserved in payload (scanner projects these back)
  IDLE_MSG=$(jq -r 'select(.id == "p_legacy_idle") | .payload.message' "$EVTS")
  assert_eq "legacy message preserved in payload"         "session w-foo went idle" "$IDLE_MSG"
  IDLE_AGENT=$(jq -r 'select(.id == "p_legacy_idle") | .payload.agent' "$EVTS")
  assert_eq "legacy agent preserved in payload"           "claude"       "$IDLE_AGENT"
  # Legacy ProgressEntry type=human_review -> kind=human_review_requested
  REVIEW_KIND=$(jq -r 'select(.id == "p_legacy_review") | .kind' "$EVTS")
  assert_eq "legacy type=human_review -> kind=human_review_requested" "human_review_requested" "$REVIEW_KIND"
  REVIEW_TS=$(jq -r 'select(.id == "p_legacy_review") | .ts' "$EVTS")
  assert_eq "legacy timestamp -> event ts" "2026-05-14T10:00:00.000Z" "$REVIEW_TS"
fi

# Acceptance: workstream TODO instruction file written
TODOS="/tmp/yaco-workstream-todos-fake.txt"
assert_file "$TODOS"
if [ -f "$TODOS" ]; then
  assert_contains "todos lists smart-capsule-v2 status" "smart-capsule-v2" "$TODOS"
  assert_contains "todos lists status=active"           "status:         active" "$TODOS"
  assert_contains "todos lists status=human_review"     "human_review" "$TODOS"
  assert_contains "todos mentions /update-tasks"        "/update-tasks" "$TODOS"
fi
# Workstream source files were NOT auto-deleted
assert_file "$REPO/projects/active/smart-capsule-v2/workstream.json"
assert_file "$REPO/projects/active/auth-rewrite/workstream.json"

# Operator follow-up text printed
if grep -q "multmux install-hooks" "$RUN1_LOG"; then
  pass "follow-up: install-hooks reminder printed"
else
  fail "follow-up: install-hooks reminder NOT printed"
fi

# ---- run #2 (must be a no-op) ---------------------------------------------

echo
echo '=== run #2 (idempotency) ==='
RUN2_LOG="$TMP/run2.log"
if ! "$MIGRATE" --yes > "$RUN2_LOG" 2>&1; then
  echo "FAIL: migrate-to-yaco.sh exited non-zero on run #2; log:" >&2
  sed 's/^/  /' "$RUN2_LOG" >&2
  exit 1
fi
sed 's/^/  /' "$RUN2_LOG"

# A no-op run must NOT contain any "[ok]" lines for "moved", "wrote", "appended"
# (the preflight + step-banner [ok] lines are allowed).
OFFENDERS=$(grep -E '^\[ok\][[:space:]]+(.*moved|.*wrote|.*appended)' "$RUN2_LOG" || true)
if [ -z "$OFFENDERS" ]; then
  pass "rerun: no destructive [ok] write/move/append lines"
else
  fail "rerun: unexpected mutation lines on second run:
$OFFENDERS"
fi

# events.jsonl line count must stay the same
if [ -f "$EVTS" ]; then
  LINES2=$(wc -l < "$EVTS" | tr -d ' ')
  assert_eq "events.jsonl unchanged after rerun" "5" "$LINES2"
fi

# projects.json content must stay the same
if [ -f "$YACO_HOME/projects.json" ]; then
  COUNT=$(jq 'length' "$YACO_HOME/projects.json")
  assert_eq "projects.json unchanged after rerun" "1" "$COUNT"
fi

# ---- dry-run smoke (clean temp) -------------------------------------------

echo
echo '=== run #3 (--dry-run on fresh state) ==='
TMP2=$(mktemp -d)
HOME2_ENV=( HOME="$TMP2" YACO_HOME="$TMP2/.yaco" WORKFLOW_HOME="$TMP2/.workflow" MULTMUX_HOME="$TMP2/.multmux" )
mkdir -p "$TMP2/.workflow/ui-state" "$TMP2/.multmux/sessions"
cat > "$TMP2/.workflow/projects.json" <<JSON
[{"name":"x","path":"$TMP2"}]
JSON
cat > "$TMP2/.workflow/ui-state/notifications.json" <<'JSON'
{}
JSON
RUN3_LOG="$TMP/run3.log"
env "${HOME2_ENV[@]}" MIGRATE_SKIP_PREFLIGHT=1 "$MIGRATE" --yes --dry-run > "$RUN3_LOG" 2>&1
sed 's/^/  /' "$RUN3_LOG"

if grep -q "^\[would\]" "$RUN3_LOG"; then
  pass "dry-run: emits [would] lines"
else
  fail "dry-run: no [would] lines emitted"
fi
if [ ! -f "$TMP2/.yaco/projects.json" ]; then
  pass "dry-run: did not write projects.json"
else
  fail "dry-run: unexpectedly wrote $TMP2/.yaco/projects.json"
fi
rm -rf "$TMP2"

# ---- summary --------------------------------------------------------------

echo
if [ "$FAIL" = 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "TESTS FAILED" >&2
  exit 1
fi
