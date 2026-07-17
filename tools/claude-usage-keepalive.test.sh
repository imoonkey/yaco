#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat >"$tmp/bin/yaco" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$CALLS"
printf '%s\n' --call-end-- >>"$CALLS"
if [ "$1 $2" = "agent start" ]; then
  exit "${START_EXIT:-0}"
fi
if [ "$1 $2" = "agent kill" ]; then
  exit "${KILL_EXIT:-0}"
fi
EOF
chmod +x "$tmp/bin/yaco"

run_case() {
  local start_exit="$1" kill_exit="$2" expected_exit="$3" cleanup_error="$4"
  : >"$tmp/calls"
  set +e
  PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" START_EXIT="$start_exit" KILL_EXIT="$kill_exit" \
    bash "$repo_root/tools/claude-usage-keepalive.sh" >/dev/null 2>"$tmp/stderr"
  local actual_exit=$?
  set -e

  [ "$actual_exit" -eq "$expected_exit" ]

  mapfile -t args <"$tmp/calls"
  [ "${args[0]}" = agent ]
  [ "${args[1]}" = start ]
  [ "${args[2]}" = claude ]
  [ "${args[3]}" = --wait ]
  [ "${args[4]}" = --timeout-ms ]
  [ "${args[5]}" = 120000 ]
  [ "${args[6]}" = -- ]
  [ "${args[7]}" = hi ]
  [ "${args[8]}" = --name ]
  local handle="${args[9]}"
  [[ "$handle" =~ ^claude-usage-keepalive-[0-9]+-[0-9]+$ ]]
  [ "${args[10]}" = --model ]
  [ "${args[11]}" = haiku ]
  [ "${args[12]}" = --call-end-- ]
  [ "${args[13]}" = agent ]
  [ "${args[14]}" = kill ]
  [ "${args[15]}" = "$handle" ]
  [ "${args[16]}" = --json ]
  [ "${args[17]}" = --call-end-- ]

  if [ "$cleanup_error" = true ]; then
    grep -q "failed to kill $handle" "$tmp/stderr"
  else
    ! grep -q "failed to kill" "$tmp/stderr"
  fi
}

run_case 0 0 0 false
run_case 7 0 7 false
run_case 0 9 1 true
run_case 7 9 7 true
echo "claude-usage-keepalive: tests passed"
