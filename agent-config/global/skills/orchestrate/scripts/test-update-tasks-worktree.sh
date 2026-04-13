#!/usr/bin/env bash
# Tests for worktree field validation in update-tasks.py.
# Runs against a temp tasks.json in /tmp/.
set -euo pipefail

PASS=0
FAIL=0
ERRORS=()
SCRIPT="$HOME/workspace/agent-config/global/skills/update-tasks/scripts/update-tasks.py"
SANDBOX="/tmp/test-update-tasks-$$"

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; ERRORS+=("$1"); }

setup() {
  rm -rf "$SANDBOX"
  mkdir -p "$SANDBOX/doc/todo"
  cd "$SANDBOX"
}

teardown() {
  cd /
  rm -rf "$SANDBOX"
}
trap teardown EXIT

# Helper: create or reset a fresh task file
reset_tasks() {
  rm -f doc/todo/tasks.json doc/todo/.tasks.json.lock
}

# Base JSON for a valid leaf task (title + description + acceptCriteria required)
BASE='{"title":"t","description":"d","acceptCriteria":"ac"'

echo "=== Setting up test sandbox: $SANDBOX ==="
setup

# ── Valid worktree slugs ──────────────────────────────────────────

echo ""
echo "=== Valid worktree slugs ==="

for slug in "auth-v2" "a" "my-feature-123" "x1"; do
  reset_tasks
  if python3 "$SCRIPT" set "t1" "${BASE},\"worktree\":\"$slug\"}" 2>/dev/null; then
    pass "accepts: $slug"
  else
    fail "accepts: $slug"
  fi
done

# ── Invalid worktree slugs ────────────────────────────────────────

echo ""
echo "=== Invalid worktree slugs ==="

declare -a invalid_cases=(
  "spaces:has spaces"
  "special chars:feat@1"
  "leading hyphen:-leading"
  "trailing hyphen:trailing-"
  "empty string:"
  "just hyphens:---"
  "slash:a/b"
  "dot only:."
  "uppercase:A"
  "mixed case:mixedCase1"
)

for entry in "${invalid_cases[@]}"; do
  desc="${entry%%:*}"
  slug="${entry#*:}"
  reset_tasks
  if python3 "$SCRIPT" set "t1" "${BASE},\"worktree\":\"$slug\"}" 2>/dev/null; then
    fail "rejects: $desc ($slug)"
  else
    pass "rejects: $desc ($slug)"
  fi
done

# ── Round-trip ────────────────────────────────────────────────────

echo ""
echo "=== Round-trip ==="

reset_tasks
python3 "$SCRIPT" set "t1" "${BASE},\"worktree\":\"my-wt\"}" 2>/dev/null
got=$(python3 -c "import json; t=json.load(open('doc/todo/tasks.json')); print(t['t1'].get('worktree','__MISSING__'))")
if [[ "$got" == "my-wt" ]]; then
  pass "round-trip: set worktree, read back matches"
else
  fail "round-trip: expected 'my-wt', got '$got'"
fi

# ── Null/remove ───────────────────────────────────────────────────

echo ""
echo "=== Null/remove worktree ==="

# Update existing task to remove worktree by setting null
if python3 "$SCRIPT" set "t1" '{"worktree":null}' 2>/dev/null; then
  got=$(python3 -c "import json; t=json.load(open('doc/todo/tasks.json')); print(t['t1'].get('worktree','__REMOVED__'))")
  if [[ "$got" == "__REMOVED__" ]]; then
    pass "null removes worktree field"
  else
    fail "null removes worktree field (got: $got)"
  fi
else
  fail "null removes worktree field (command rejected)"
fi

# ── Summary ───────────────────────────────────────────────────────

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  echo "Failures:"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  exit 1
fi
echo "All tests passed!"
