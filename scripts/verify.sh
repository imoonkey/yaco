#!/usr/bin/env bash
# scripts/verify.sh — the single verify entry for this repo.
#
# Runs every component's build/lint/test in a fixed order. Stops at the first
# failing step, names it, and exits non-zero; exits 0 only when all steps pass.
# Pure shell with no CLI/TS dependency, so it is callable from scripts/gate.sh,
# a hook, or a human shell identically.
set -uo pipefail

# Repo root resolved from this script's own location (hardcoded convention,
# same as scripts/worktree-provision.sh) — never from cwd or git probing.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# run_step <name> <dir> <cmd...> : run <cmd> with cwd = repo_root/<dir> in a
# subshell (so cwd never leaks to the next step); on failure, name it and exit.
run_step() {
  local name="$1" dir="$2"
  shift 2
  echo "verify: ▶ $name"
  if ! (cd "$repo_root/$dir" && "$@"); then
    echo "verify: ✗ step failed: $name" >&2
    exit 1
  fi
}

run_step "keepalive test" .          bash tools/claude-usage-keepalive.test.sh
run_step "cli test"       cli        bun run test
run_step "codex transcribe typecheck" . npm run typecheck --workspace @yaco/codex-transcribe
run_step "codex transcribe test"      . npm test --workspace @yaco/codex-transcribe
run_step "server test"    app/server npm test
run_step "ui lint"        app/ui     npm run lint
run_step "build"          .          npm run build

echo "verify: ✓ all steps passed"
