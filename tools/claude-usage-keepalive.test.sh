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
EOF
chmod +x "$tmp/bin/yaco"

run_case() {
  local expected_exit="$1"
  : >"$tmp/calls"
  set +e
  PATH="$tmp/bin:$PATH" CALLS="$tmp/calls" START_EXIT="$expected_exit" \
    bash "$repo_root/tools/claude-usage-keepalive.sh" >/dev/null 2>"$tmp/stderr"
  local actual_exit=$?
  set -e

  [ "$actual_exit" -eq "$expected_exit" ]

  mapfile -t args <"$tmp/calls"
  [ "${args[0]}" = agent ]
  [ "${args[1]}" = start ]
  [ "${args[2]}" = claude ]
  [ "${args[3]}" = --wait ]
  [ "${args[4]}" = -- ]
  [ "${args[5]}" = hi ]
  [ "${args[6]}" = --name ]
  local handle="${args[7]}"
  [[ "$handle" =~ ^claude-usage-keepalive-[0-9]+-[0-9]+$ ]]
  [ "${args[8]}" = --model ]
  [ "${args[9]}" = haiku ]
  [ "${args[10]}" = --call-end-- ]
  [ "${args[11]}" = agent ]
  [ "${args[12]}" = kill ]
  [ "${args[13]}" = "$handle" ]
  [ "${args[14]}" = --json ]
  [ "${args[15]}" = --call-end-- ]
}

run_case 0
run_case 7
echo "claude-usage-keepalive: tests passed"
