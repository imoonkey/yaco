#!/usr/bin/env bash
# Integration tests for worktree lifecycle scripts.
# Runs in a /tmp/ sandbox to avoid polluting the real repo.
set -euo pipefail

PASS=0
FAIL=0
ERRORS=()
SCRIPTS_SRC="$(readlink -f ~/.claude/skills/orchestrate/scripts 2>/dev/null || echo "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
SANDBOX="$(mktemp -d /tmp/test-worktree-$$-XXXX)"
SANDBOX="$(cd "$SANDBOX" && pwd -P)"

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; ERRORS+=("$1"); }

setup() {
  git init "$SANDBOX/repo" --initial-branch=main >/dev/null 2>&1
  cd "$SANDBOX/repo"
  git config user.email "test@test.com"
  git config user.name "Test"
  git commit --allow-empty -m "initial" >/dev/null 2>&1
  # Copy worktree scripts into sandbox repo
  mkdir -p scripts
  cp "$SCRIPTS_SRC/worktree-lib.sh" scripts/
  cp "$SCRIPTS_SRC/worktree-create.sh" scripts/
  cp "$SCRIPTS_SRC/worktree-cleanup.sh" scripts/
  cp "$SCRIPTS_SRC/worktree-merge.sh" scripts/
  chmod +x scripts/*.sh
  # Commit scripts and gitignore so primary checkout is clean (merge requires clean state)
  echo ".worktrees/" > .gitignore
  git add scripts/ .gitignore
  git commit -m "add worktree scripts and gitignore" >/dev/null 2>&1
}

teardown() {
  cd /
  rm -rf "$SANDBOX"
}
trap teardown EXIT

echo "=== Setting up test sandbox: $SANDBOX ==="
setup

# ── worktree-create.sh ────────────────────────────────────────────

echo ""
echo "=== worktree-create.sh ==="

# Creates .worktrees/<slug>/ directory
./scripts/worktree-create.sh my-feature >/dev/null 2>&1
if [[ -d .worktrees/my-feature ]]; then
  pass "creates .worktrees/<slug>/ directory"
else
  fail "creates .worktrees/<slug>/ directory"
fi

# Creates task/<slug> branch
if git rev-parse --verify task/my-feature &>/dev/null; then
  pass "creates task/<slug> branch"
else
  fail "creates task/<slug> branch"
fi

# Idempotent — second run reuses
output=$(./scripts/worktree-create.sh my-feature 2>&1)
if echo "$output" | grep -qi "reusing"; then
  pass "idempotent: second run reuses existing"
else
  fail "idempotent: second run reuses existing"
fi

# Invalid slugs rejected
if ./scripts/worktree-create.sh "BAD SLUG" 2>/dev/null; then
  fail "rejects slug with spaces"
else
  pass "rejects slug with spaces"
fi

if ./scripts/worktree-create.sh "-leading" 2>/dev/null; then
  fail "rejects leading-hyphen slug"
else
  pass "rejects leading-hyphen slug"
fi

if ./scripts/worktree-create.sh "" 2>/dev/null; then
  fail "rejects empty slug"
else
  pass "rejects empty slug"
fi

# --base flag works
git checkout -b develop >/dev/null 2>&1
git commit --allow-empty -m "develop commit" >/dev/null 2>&1
develop_sha=$(git rev-parse develop)
git checkout main >/dev/null 2>&1

./scripts/worktree-create.sh from-develop --base develop >/dev/null 2>&1
if [[ -d .worktrees/from-develop ]]; then
  worktree_base=$(git -C .worktrees/from-develop merge-base HEAD develop)
  if [[ "$worktree_base" == "$develop_sha" ]]; then
    pass "--base flag creates from specified branch"
  else
    fail "--base flag creates from specified branch"
  fi
else
  fail "--base flag creates from specified branch"
fi

# Clean up from-develop (unmerged into main, needs --force)
./scripts/worktree-cleanup.sh from-develop --force >/dev/null 2>&1

# ── worktree-cleanup.sh ───────────────────────────────────────────

echo ""
echo "=== worktree-cleanup.sh ==="

# Create a worktree from main for cleanup testing (branch will be merged)
./scripts/worktree-create.sh cleanup-test >/dev/null 2>&1

# Removes directory and branch
./scripts/worktree-cleanup.sh cleanup-test >/dev/null 2>&1
if [[ ! -d .worktrees/cleanup-test ]]; then
  pass "removes worktree directory"
else
  fail "removes worktree directory"
fi

if ! git rev-parse --verify task/cleanup-test &>/dev/null; then
  pass "removes task branch"
else
  fail "removes task branch"
fi

# Tolerates already-cleaned state
if ./scripts/worktree-cleanup.sh cleanup-test 2>/dev/null; then
  pass "tolerates already-cleaned state"
else
  fail "tolerates already-cleaned state"
fi

# --force works on dirty worktree
./scripts/worktree-create.sh force-test >/dev/null 2>&1
echo "dirty" > .worktrees/force-test/dirty-file.txt
git -C .worktrees/force-test add dirty-file.txt >/dev/null 2>&1

# Without --force: should fail on dirty worktree
if ./scripts/worktree-cleanup.sh force-test 2>/dev/null; then
  fail "rejects dirty worktree without --force"
else
  pass "rejects dirty worktree without --force"
fi

# With --force: succeeds
if ./scripts/worktree-cleanup.sh force-test --force >/dev/null 2>&1; then
  if [[ ! -d .worktrees/force-test ]]; then
    pass "--force removes dirty worktree"
  else
    fail "--force removes dirty worktree (dir still exists)"
  fi
else
  fail "--force removes dirty worktree (command failed)"
fi

# ── worktree-merge.sh --mode local ───────────────────────────────

echo ""
echo "=== worktree-merge.sh --mode local ==="

./scripts/worktree-create.sh merge-test >/dev/null 2>&1
echo "new content" > .worktrees/merge-test/merge-file.txt
git -C .worktrees/merge-test add merge-file.txt >/dev/null 2>&1
git -C .worktrees/merge-test commit -m "add merge-file" >/dev/null 2>&1

main_before=$(git rev-parse main)
./scripts/worktree-merge.sh merge-test --mode local >/dev/null 2>&1
main_after=$(git rev-parse main)

if [[ "$main_before" != "$main_after" ]]; then
  pass "local merge advances main"
else
  fail "local merge advances main"
fi

if [[ -f merge-file.txt ]]; then
  pass "merged file appears in primary checkout"
else
  fail "merged file appears in primary checkout"
fi

# ── resolve_repo_root ─────────────────────────────────────────────

echo ""
echo "=== resolve_repo_root ==="

# From primary checkout
source scripts/worktree-lib.sh
primary_root=$(resolve_repo_root)
if [[ "$primary_root" == "$SANDBOX/repo" ]]; then
  pass "resolve_repo_root from primary cwd"
else
  fail "resolve_repo_root from primary cwd (got: $primary_root)"
fi

# From worktree cwd (my-feature still exists)
worktree_root=$(cd .worktrees/my-feature && source "$SANDBOX/repo/scripts/worktree-lib.sh" && resolve_repo_root)
if [[ "$worktree_root" == "$SANDBOX/repo" ]]; then
  pass "resolve_repo_root from worktree cwd"
else
  fail "resolve_repo_root from worktree cwd (got: $worktree_root)"
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
