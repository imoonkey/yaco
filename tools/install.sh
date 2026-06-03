#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${YACO_BIN_DIR:-$HOME/.local/bin}"
INSTALL_WORKFLOW_DEPS=1
RUN_HOOKS=1
UPDATE_REGISTRY=1
DRY_RUN=0

usage() {
  cat <<EOF
Usage: tools/install.sh [options]

Options:
  --cli-only       Skip Workflow app/server npm installs.
  --bin-dir PATH   Install multmux and mt into PATH (default: ~/.local/bin).
  --skip-hooks     Build/install multmux but do not run multmux install-hooks.
  --no-registry    Do not update ~/.yaco/projects.json.
  --dry-run        Print the resolved plan without changing files.
  -h, --help       Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli-only) INSTALL_WORKFLOW_DEPS=0; shift ;;
    --bin-dir)
      if [ "$#" -lt 2 ]; then
        echo "install: --bin-dir requires a path" >&2
        exit 2
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --skip-hooks) RUN_HOOKS=0; shift ;;
    --no-registry) UPDATE_REGISTRY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install: required command not found: $1" >&2
    exit 2
  fi
}

link_path() {
  local target="$1"
  local link="$2"
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ] || [ ! -e "$link" ]; then
    ln -sfn "$target" "$link"
    echo "linked: $link -> $target"
    return
  fi
  echo "install: refusing to replace non-symlink path: $link" >&2
  echo "install: move it aside or replace it with a symlink, then re-run tools/install.sh" >&2
  exit 1
}

install_binary() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    rm -f "$dest"
  fi
  if [ "$(readlink -f "$src")" != "$(readlink -f "$dest" 2>/dev/null || true)" ]; then
    cp "$src" "$dest"
  fi
  chmod +x "$dest"
}

update_registry() {
  local registry="${YACO_HOME:-$HOME/.yaco}/projects.json"
  mkdir -p "$(dirname "$registry")"
  REGISTRY="$registry" ROOT_DIR="$ROOT_DIR" python3 - <<'PY'
import json
import os
from pathlib import Path

registry = Path(os.environ["REGISTRY"])
root = os.environ["ROOT_DIR"]
try:
    projects = json.loads(registry.read_text())
except (FileNotFoundError, json.JSONDecodeError):
    projects = []

result = []
seen_workflow = False
for project in projects:
    pid = project.get("id")
    if pid in {"workflow", "yaco"}:
        if not seen_workflow:
            result.append({**project, "id": "yaco", "path": root})
            seen_workflow = True
        continue
    elif pid in {"multmux", "agent-config"}:
        continue
    else:
        result.append(project)

if not seen_workflow:
    result.insert(0, {"id": "yaco", "path": root})

registry.write_text(json.dumps(result, indent=2) + "\n")
PY
  echo "updated registry: $registry"
}
echo "YACO install"
echo "repo root: $ROOT_DIR"
echo "bin dir:   $BIN_DIR"

if [ "$DRY_RUN" = 1 ]; then
  cat <<EOF
dry run:
  workflow deps: $INSTALL_WORKFLOW_DEPS
  run hooks:     $RUN_HOOKS
  update registry: $UPDATE_REGISTRY
  app server:    $ROOT_DIR/app/server
  app ui:        $ROOT_DIR/app/ui
  multmux src:   $ROOT_DIR/multmux
  agent config:  $ROOT_DIR/agent-config/global
  claude config: $HOME/.claude/CLAUDE.md -> $ROOT_DIR/agent-config/global/CLAUDE.md
  claude skills: $HOME/.claude/skills -> $ROOT_DIR/agent-config/global/skills
  codex agents:  $HOME/.codex/AGENTS.md -> $ROOT_DIR/agent-config/global/CLAUDE.md
EOF
  exit 0
fi

require bun
require npm
require python3

if [ "$INSTALL_WORKFLOW_DEPS" = 1 ]; then
  echo "Installing Workflow server deps..."
  (cd "$ROOT_DIR/app/server" && npm install)
  echo "Installing Workflow UI deps..."
  (cd "$ROOT_DIR/app/ui" && npm install)
else
  echo "Skipping Workflow JS deps (--cli-only)."
fi

echo "Installing multmux..."
(cd "$ROOT_DIR/multmux" && bun install && bun build src/index.ts --compile --outfile multmux)
install_binary "$ROOT_DIR/multmux/multmux" "$BIN_DIR/multmux"
link_path "$BIN_DIR/multmux" "$BIN_DIR/mt"

if command -v codesign >/dev/null 2>&1; then
  codesign -s - "$BIN_DIR/multmux"
fi

if [ "$RUN_HOOKS" = 1 ]; then
  "$BIN_DIR/multmux" install-hooks
else
  echo "Skipping multmux install-hooks (--skip-hooks)."
fi

echo "Linking global agent config..."
link_path "$ROOT_DIR/agent-config/global/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
link_path "$ROOT_DIR/agent-config/global/skills" "$HOME/.claude/skills"
link_path "$ROOT_DIR/agent-config/global/CLAUDE.md" "$HOME/.codex/AGENTS.md"
link_path "$HOME/.claude/skills" "$HOME/.agents/skills"

if [ "$UPDATE_REGISTRY" = 1 ]; then
  update_registry
else
  echo "Skipping registry update (--no-registry)."
fi

"$ROOT_DIR/tools/doctor.sh"
