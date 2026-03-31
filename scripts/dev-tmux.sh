#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${WORKFLOW_DEV_TMUX_SESSION:-workflow-dev}"
ATTACH=1
RESET=0
RESTART=0
DEV_WINDOW="dev"

sync_tmux_env() {
  local target="$1"
  local vars=(
    PATH
    SHELL
    LANG
    LC_ALL
    LC_CTYPE
    TERM
    TERM_PROGRAM
    TERM_PROGRAM_VERSION
    SSH_AUTH_SOCK
    SSH_AGENT_PID
    HOME
  )

  for var in "${vars[@]}"; do
    if [ -n "${!var-}" ]; then
      tmux set-environment -t "$target" "$var" "${!var}"
    else
      tmux set-environment -r -t "$target" "$var" >/dev/null 2>&1 || true
    fi
  done
}

respawn_dev_panes() {
  sync_tmux_env "$SESSION_NAME"
  tmux respawn-pane -k -t "$SESSION_NAME:${DEV_WINDOW}.0" -c "$ROOT_DIR" 'npm run dev:server'
  tmux respawn-pane -k -t "$SESSION_NAME:${DEV_WINDOW}.1" -c "$ROOT_DIR" 'npm run dev:ui'
}

usage() {
  cat <<'EOF'
Usage: scripts/dev-tmux.sh [--detached] [--reset] [--restart] [--session NAME]

Starts a tmux session with two panes:
- left: backend dev server
- right: frontend dev server

Options:
  --detached       Start or reuse the session without attaching
  --reset          Kill an existing session with the same name before starting
  --restart        Respawn both dev panes in place with refreshed environment
  --session NAME   Override tmux session name
  -h, --help       Show this help

Env:
  WORKFLOW_DEV_TMUX_SESSION  Default session name override
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

validate_session_name() {
  if [[ -z "$SESSION_NAME" ]]; then
    echo "Session name must not be empty" >&2
    exit 1
  fi

  if [[ ! "$SESSION_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Invalid session name: $SESSION_NAME" >&2
    echo "Use only letters, numbers, dot, underscore, and dash." >&2
    exit 1
  fi
}

attach_session() {
  if [ "$ATTACH" -ne 1 ]; then
    return
  fi

  if [ -n "${TMUX:-}" ]; then
    exec tmux switch-client -t "$SESSION_NAME"
  fi

  exec tmux attach-session -t "$SESSION_NAME"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --detached)
      ATTACH=0
      shift
      ;;
    --reset)
      RESET=1
      shift
      ;;
    --restart)
      RESTART=1
      shift
      ;;
    --session)
      if [ "$#" -lt 2 ]; then
        echo "--session requires a value" >&2
        exit 1
      fi
      SESSION_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd tmux
require_cmd npm
validate_session_name

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [ "$RESTART" -eq 1 ]; then
    echo "Restarting dev servers in: $SESSION_NAME"
    respawn_dev_panes
    attach_session
    exit 0
  fi
  if [ "$RESET" -eq 1 ]; then
    tmux kill-session -t "$SESSION_NAME"
  else
    echo "Reusing existing tmux session: $SESSION_NAME"
    attach_session
    exit 0
  fi
fi

tmux new-session -d -s "$SESSION_NAME" -n "$DEV_WINDOW" -c "$ROOT_DIR"
tmux set-option -t "$SESSION_NAME" remain-on-exit on
sync_tmux_env "$SESSION_NAME"
tmux send-keys -t "$SESSION_NAME:${DEV_WINDOW}.0" 'npm run dev:server' C-m

tmux split-window -h -t "$SESSION_NAME:$DEV_WINDOW" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:${DEV_WINDOW}.1" 'npm run dev:ui' C-m

tmux select-layout -t "$SESSION_NAME:$DEV_WINDOW" even-horizontal
tmux select-pane -t "$SESSION_NAME:${DEV_WINDOW}.0"

echo "Started tmux session: $SESSION_NAME"
echo "Backend pane: npm run dev:server"
echo "Frontend pane: npm run dev:ui"

attach_session
