#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${YACO_BIN_DIR:-$HOME/.local/bin}"
YACO_ROOT="${YACO_HOME:-$HOME/.yaco}"
REGISTRY="$YACO_ROOT/projects.json"
FAILS=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

check_exists() {
  local path="$1"
  if [ -e "$path" ]; then pass "exists: $path"; else fail "missing: $path"; fi
}

check_absent() {
  local path="$1"
  if [ ! -e "$path" ]; then pass "absent: $path"; else fail "should not exist: $path"; fi
}

check_symlink_target() {
  local link="$1"
  local target="$2"
  if [ ! -L "$link" ]; then
    fail "not a symlink: $link"
    return
  fi
  if [ "$(readlink -f "$link")" = "$(readlink -f "$target")" ]; then
    pass "link: $link -> $target"
  else
    fail "bad link: $link -> $(readlink "$link"), expected $target"
  fi
}

echo "YACO doctor"
echo "repo root: $ROOT_DIR"

check_exists "$ROOT_DIR/app/server"
check_exists "$ROOT_DIR/app/ui"
check_exists "$ROOT_DIR/multmux/src"
check_exists "$ROOT_DIR/agent-config/global/skills"
check_exists "$ROOT_DIR/projects/tasks.json"
check_absent "$ROOT_DIR/server"
check_absent "$ROOT_DIR/ui"
check_absent "$ROOT_DIR/multmux/projects/tasks.json"
check_absent "$ROOT_DIR/agent-config/projects/tasks.json"
check_absent "$ROOT_DIR/multmux/projects/progress.json"
check_absent "$ROOT_DIR/multmux/projects/progress.json.lock"
check_absent "$ROOT_DIR/multmux/projects/active"
check_absent "$ROOT_DIR/multmux/projects/archive"
check_absent "$ROOT_DIR/agent-config/projects/active"
check_absent "$ROOT_DIR/agent-config/projects/archive"

if [ -f "$REGISTRY" ]; then
  if registry_error="$(REGISTRY="$REGISTRY" ROOT_DIR="$ROOT_DIR" python3 - <<'PY' 2>&1
import json
import os
from pathlib import Path

projects = json.loads(Path(os.environ["REGISTRY"]).read_text())
root = os.environ["ROOT_DIR"]
by_id = {p.get("id"): p for p in projects}
errors = []
if by_id.get("workflow", {}).get("path") != root:
    errors.append(f"workflow registry path is {by_id.get('workflow', {}).get('path')!r}, expected {root!r}")
for pid in ("multmux", "agent-config"):
    if pid in by_id:
        errors.append(f"legacy project id still registered: {pid}")
if errors:
    raise SystemExit("\n".join(errors))
PY
  )"; then
    pass "registry points workflow at root and omits component project ids"
  else
    fail "registry points workflow at root and omits component project ids"
    if [ -n "$registry_error" ]; then
      printf '%s\n' "$registry_error" >&2
    fi
  fi
else
  fail "registry missing: $REGISTRY"
fi

check_symlink_target "$HOME/.claude/CLAUDE.md" "$ROOT_DIR/agent-config/global/CLAUDE.md"
check_symlink_target "$HOME/.claude/skills" "$ROOT_DIR/agent-config/global/skills"
check_symlink_target "$HOME/.codex/AGENTS.md" "$ROOT_DIR/agent-config/global/CLAUDE.md"
check_symlink_target "$HOME/.agents/skills" "$ROOT_DIR/agent-config/global/skills"

if [ -x "$BIN_DIR/multmux" ]; then pass "multmux binary installed: $BIN_DIR/multmux"; else fail "multmux binary missing: $BIN_DIR/multmux"; fi
if [ -f "$ROOT_DIR/multmux/multmux" ]; then
  pass "monorepo multmux build artifact exists"
  if cmp -s "$ROOT_DIR/multmux/multmux" "$BIN_DIR/multmux"; then pass "installed multmux matches monorepo build"; else fail "installed multmux does not match monorepo build"; fi
else
  fail "monorepo multmux build artifact missing: run tools/install.sh"
fi
if [ -L "$BIN_DIR/mt" ] || [ -x "$BIN_DIR/mt" ]; then pass "mt command installed: $BIN_DIR/mt"; else fail "mt command missing: $BIN_DIR/mt"; fi
if "$BIN_DIR/multmux" status --json --all >/dev/null; then pass "multmux status --json --all"; else fail "multmux status failed"; fi

bash -n "$ROOT_DIR/tools/install.sh" && pass "tools/install.sh syntax"
bash -n "$ROOT_DIR/tools/doctor.sh" && pass "tools/doctor.sh syntax"
bash -n "$ROOT_DIR/app/scripts/services.sh" && pass "app/scripts/services.sh syntax"

if [ "$FAILS" -gt 0 ]; then
  echo "doctor failed: $FAILS issue(s)" >&2
  exit 1
fi

echo "doctor passed"
