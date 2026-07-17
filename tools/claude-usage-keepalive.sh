#!/usr/bin/env bash
# One Claude Haiku turn for an external hourly scheduler such as cron.
set -euo pipefail

if ! command -v yaco >/dev/null 2>&1; then
  echo "claude-usage-keepalive: yaco is not on PATH" >&2
  exit 127
fi

handle="claude-usage-keepalive-$(date +%s)-$$"

cleanup() {
  local status=$?
  trap - EXIT
  if ! yaco agent kill "$handle" --json >/dev/null; then
    echo "claude-usage-keepalive: failed to kill $handle" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A one-word reply should finish quickly; bound failure well below the hourly cadence.
yaco agent start claude --wait --timeout-ms 120000 -- hi --name "$handle" --model haiku >/dev/null
