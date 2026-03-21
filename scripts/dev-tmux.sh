#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${WORKFLOW_DEV_TMUX_SESSION:-workflow-dev}"
ATTACH=1
RESET=0
RESTART=0

usage() {
  cat <<'EOF'
Usage: scripts/dev-tmux.sh [--detached] [--reset] [--restart] [--session NAME]

Starts a tmux session with two panes:
- left: backend dev server
- right: frontend dev server

Options:
  --detached       Start or reuse the session without attaching
  --reset          Kill an existing session with the same name before starting
  --restart        Send C-c + re-run dev commands in both panes (no session kill)
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
    for pane in 0 1; do
      tmux send-keys -t "$SESSION_NAME:dev.$pane" C-c
      tmux send-keys -t "$SESSION_NAME:dev.$pane" "cd \"$ROOT_DIR\"" C-m
    done
    sleep 1
    tmux send-keys -t "$SESSION_NAME:dev.0" 'npm run dev:server' C-m
    tmux send-keys -t "$SESSION_NAME:dev.1" 'npm run dev:ui' C-m
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

tmux new-session -d -s "$SESSION_NAME" -n dev -c "$ROOT_DIR"
tmux set-option -t "$SESSION_NAME" remain-on-exit on
tmux send-keys -t "$SESSION_NAME:dev.0" 'npm run dev:server' C-m

tmux split-window -h -t "$SESSION_NAME:dev" -c "$ROOT_DIR"
tmux send-keys -t "$SESSION_NAME:dev.1" 'npm run dev:ui' C-m

tmux select-layout -t "$SESSION_NAME:dev" even-horizontal
tmux select-pane -t "$SESSION_NAME:dev.0"

echo "Started tmux session: $SESSION_NAME"
echo "Backend pane: npm run dev:server"
echo "Frontend pane: npm run dev:ui"

attach_session
