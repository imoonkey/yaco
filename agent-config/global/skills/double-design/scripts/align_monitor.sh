#!/bin/bash
# Monitor /align progress and nudge idle agents.
# Usage: align_monitor.sh <status_txt_path> <claude_session> <codex_session> [interval_seconds]
#
# Example:
#   align_monitor.sh doc/todo/myproject/discussion/status.txt claude-design codex-design 15

set -euo pipefail

STATUS_FILE="$1"
CLAUDE_SESSION="$2"
CODEX_SESSION="$3"
INTERVAL="${4:-15}"

echo "[align_monitor] Watching: $STATUS_FILE (every ${INTERVAL}s)"

while true; do
  STATUS=$(cat "$STATUS_FILE" 2>/dev/null || echo "")

  if echo "$STATUS" | grep -q "NEXT=DONE"; then
    echo "[align_monitor] Alignment complete."
    break
  fi

  NEXT=$(echo "$STATUS" | grep -o 'NEXT=[A-Z]*' | cut -d= -f2)

  if [ "$NEXT" = "CLAUDE" ]; then
    AGENT_STATUS=$(multmux status "$CLAUDE_SESSION" 2>/dev/null || echo "")
    if echo "$AGENT_STATUS" | grep -qi "idle"; then
      echo "[align_monitor] Claude is idle but it's their turn — nudging."
      multmux send "$CLAUDE_SESSION" "It's your turn. Read the latest discussion files and continue /align."
    fi
  elif [ "$NEXT" = "CODEX" ]; then
    AGENT_STATUS=$(multmux status "$CODEX_SESSION" 2>/dev/null || echo "")
    if echo "$AGENT_STATUS" | grep -qi "idle"; then
      echo "[align_monitor] Codex is idle but it's their turn — nudging."
      multmux send "$CODEX_SESSION" "It's your turn. Read the latest discussion files and continue /align."
    fi
  fi

  sleep "$INTERVAL"
done
