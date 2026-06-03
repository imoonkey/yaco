#!/usr/bin/env bash
# YACO doctor — validates a migrated ~/.yaco state.
#
# Design: projects/active/yaco-core/final/design.md  (section "Doctor Checks")
# SPEC:   projects/active/yaco-core/final/SPEC.md
#
# Runs 7 checks against $YACO_HOME (default: $HOME/.yaco) and the projects
# registered in $YACO_HOME/projects.json. Prints PASS/FAIL per check with the
# affected paths. Exits 0 on all PASS, otherwise exits the number of failures
# (capped at 125).
#
# Usage:
#   bash app/scripts/yaco-doctor.sh [--verbose]

set -uo pipefail

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --help|-h) sed -n '2,15p' "$0"; exit 0 ;;
    *) printf 'yaco-doctor: unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TASK_VALIDATOR="$SCRIPT_DIR/_yaco-doctor-validate-tasks.py"

YACO_HOME="${YACO_HOME:-$HOME/.yaco}"
REGISTRY="$YACO_HOME/projects.json"

# Roots scanned by check 6. Override with YACO_DOCTOR_SCAN_ROOTS (colon-separated)
# in tests to point at fixture directories.
DEFAULT_SCAN_ROOTS="$REPO_ROOT/app/server/src:$REPO_ROOT/multmux/src:$REPO_ROOT/agent-config/global"
SCAN_ROOTS="${YACO_DOCTOR_SCAN_ROOTS:-$DEFAULT_SCAN_ROOTS}"

# Allowlist for check 6: files (path suffix match) that are intentionally
# allowed to mention ~/.workflow or ~/.multmux in comments/docs/migration code.
# Override with YACO_DOCTOR_ALLOWLIST (colon-separated suffixes) in tests.
DEFAULT_ALLOWLIST="app/server/src/lib/yacoHome.ts:multmux/src/yacoHome.ts:agent-config/global/lib/yaco_home.py:agent-config/global/skills/multmux/SKILL.md"
ALLOWLIST="${YACO_DOCTOR_ALLOWLIST:-$DEFAULT_ALLOWLIST}"

FAILS=0
WARNS=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$1" >&2; WARNS=$((WARNS + 1)); }
verb() { [ "$VERBOSE" = 1 ] && printf '      %s\n' "$1" || true; }

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'yaco-doctor: required binary not found: %s\n' "$1" >&2
    exit 2
  fi
}

# ---- registry ---------------------------------------------------------------

PIDS=()
PPATHS=()
load_registry() {
  if [ ! -f "$REGISTRY" ]; then
    return 0
  fi
  local count i pid ppath
  count=$(jq 'length' "$REGISTRY" 2>/dev/null || echo 0)
  i=0
  while [ "$i" -lt "$count" ]; do
    pid=$(jq -r ".[$i].id"   "$REGISTRY")
    ppath=$(jq -r ".[$i].path" "$REGISTRY")
    PIDS+=("$pid")
    PPATHS+=("$ppath")
    i=$((i + 1))
  done
}

# ---- check 1: registry paths exist ----------------------------------------

check_registry_paths() {
  local label="check 1: registry paths exist on disk"
  if [ ! -f "$REGISTRY" ]; then
    fail "$label — registry missing: $REGISTRY"
    return
  fi
  local missing=()
  local i=0
  while [ "$i" -lt "${#PIDS[@]}" ]; do
    if [ ! -d "${PPATHS[$i]}" ]; then
      missing+=("${PIDS[$i]} -> ${PPATHS[$i]}")
    fi
    i=$((i + 1))
  done
  if [ "${#missing[@]}" = 0 ]; then
    pass "$label (${#PIDS[@]} project(s))"
    if [ "$VERBOSE" = 1 ]; then
      local j=0
      while [ "$j" -lt "${#PIDS[@]}" ]; do
        verb "${PIDS[$j]} -> ${PPATHS[$j]}"
        j=$((j + 1))
      done
    fi
  else
    fail "$label — ${#missing[@]} missing"
    for m in "${missing[@]}"; do printf '      %s\n' "$m" >&2; done
  fi
}

# ---- check 2: project ids are unique --------------------------------------

check_unique_ids() {
  local label="check 2: project ids are unique"
  if [ ! -f "$REGISTRY" ]; then
    fail "$label — registry missing: $REGISTRY"
    return
  fi
  local dups
  dups=$(jq -r '.[].id' "$REGISTRY" | sort | uniq -d)
  if [ -z "$dups" ]; then
    pass "$label"
  else
    fail "$label — duplicates:"
    printf '%s\n' "$dups" | sed 's/^/      /' >&2
  fi
}

# ---- check 3: per-project tasks.json validates ----------------------------

check_tasks_graphs() {
  local label="check 3: tasks.json graphs validate"
  if [ ! -f "$TASK_VALIDATOR" ]; then
    fail "$label — validator missing: $TASK_VALIDATOR"
    return
  fi
  if [ "${#PIDS[@]}" = 0 ]; then
    pass "$label (no projects to check)"
    return
  fi
  local bad=()
  local i=0
  while [ "$i" -lt "${#PIDS[@]}" ]; do
    local pid="${PIDS[$i]}" ppath="${PPATHS[$i]}"
    local tasks_file="$ppath/projects/tasks.json"
    i=$((i + 1))
    if [ ! -d "$ppath" ]; then
      verb "$pid: skip (path missing — see check 1)"
      continue
    fi
    if [ ! -f "$tasks_file" ]; then
      verb "$pid: no tasks.json (ok)"
      continue
    fi
    local out
    if ! out=$(python3 "$TASK_VALIDATOR" "$tasks_file" 2>&1); then
      bad+=("$pid ($tasks_file): $out")
    else
      verb "$pid: $out"
    fi
  done
  if [ "${#bad[@]}" = 0 ]; then
    pass "$label"
  else
    fail "$label — ${#bad[@]} invalid"
    for b in "${bad[@]}"; do printf '      %s\n' "$b" >&2; done
  fi
}

# ---- check 4: events.jsonl is valid NDJSON --------------------------------

# Validate one events.jsonl file. Echoes "" on success, or "line N: <reason>"
# on the first offending line. Exit code mirrors success/failure.
validate_events_file() {
  local f="$1" lineno=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    # skip blank lines
    case "$line" in
      ''|$'\t'|' ') continue ;;
    esac
    # parse + require fields
    if ! printf '%s\n' "$line" | jq -e \
        '(type == "object")
         and ((.id|type) == "string")
         and ((.ts|type) == "string")
         and ((.kind|type) == "string")
         and ((.projectId|type) == "string")' >/dev/null 2>&1; then
      printf 'line %d' "$lineno"
      return 1
    fi
  done < "$f"
  return 0
}

check_events_jsonl() {
  local label="check 4: events.jsonl is valid NDJSON"
  local bad=()
  local i=0
  while [ "$i" -lt "${#PIDS[@]}" ]; do
    local pid="${PIDS[$i]}"
    local f="$YACO_HOME/projects/$pid/events.jsonl"
    i=$((i + 1))
    if [ ! -f "$f" ]; then
      verb "$pid: no events.jsonl (ok)"
      continue
    fi
    local err
    if ! err=$(validate_events_file "$f"); then
      bad+=("$pid ($f): invalid $err")
    else
      verb "$pid: $(awk 'NF' "$f" | wc -l | tr -d ' ') line(s) ok"
    fi
  done
  if [ "${#bad[@]}" = 0 ]; then
    pass "$label"
  else
    fail "$label — ${#bad[@]} invalid"
    for b in "${bad[@]}"; do printf '      %s\n' "$b" >&2; done
  fi
}

# ---- check 5: multmux status --json --all parses ---------------------------

check_multmux_status() {
  local label="check 5: 'multmux status --json --all' returns valid JSON"
  local bin=""
  if command -v multmux >/dev/null 2>&1; then
    bin="multmux"
  elif command -v bun >/dev/null 2>&1 && [ -f "${MULTMUX_SRC:-$HOME/ld-workspace/multmux/src/index.ts}" ]; then
    bin="bun ${MULTMUX_SRC:-$HOME/ld-workspace/multmux/src/index.ts}"
  fi
  if [ -z "$bin" ]; then
    warn "$label — multmux binary not on PATH and bun fallback not available (skipped)"
    return
  fi
  local out rc
  out=$($bin status --json --all 2>&1)
  rc=$?
  if [ "$rc" != 0 ]; then
    fail "$label — '$bin status' exited $rc: $(printf '%s' "$out" | head -1)"
    return
  fi
  if ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    fail "$label — output is not parseable JSON"
    [ "$VERBOSE" = 1 ] && printf '%s\n' "$out" | head -5 | sed 's/^/      /' >&2
    return
  fi
  local n
  n=$(printf '%s' "$out" | jq 'length' 2>/dev/null || echo "?")
  pass "$label ($n session(s))"
}

# ---- check 6: no NEW ~/.workflow or ~/.multmux references -----------------

is_allowed_legacy() {
  local path="$1"
  # match by suffix
  IFS=':' read -ra suffixes <<< "$ALLOWLIST"
  for s in "${suffixes[@]}"; do
    [ -z "$s" ] && continue
    case "$path" in
      */$s|$s) return 0 ;;
    esac
  done
  return 1
}

check_no_legacy_paths() {
  local label="check 6: no new ~/.workflow or ~/.multmux references"
  local hits=()

  # Match .workflow or .multmux when it appears as a leading path segment.
  # Preceded by one of:  ~  $HOME  /  "  '
  # Followed by one of:  /  "  '  end-of-line  whitespace
  # This catches ~/.workflow, $HOME/.multmux, ".multmux", '.workflow', and
  # bare /.workflow/ in shell scripts, without matching things like
  # "not.workflow.example.com".
  local pat
  pat='(~|\$HOME|["'"'"'/])\.workflow(["'"'"'/]|$|[[:space:]])'
  pat="$pat|"'(~|\$HOME|["'"'"'/])\.multmux(["'"'"'/]|$|[[:space:]])'

  IFS=':' read -ra roots <<< "$SCAN_ROOTS"
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    local raw
    raw=$(grep -rEn -- "$pat" "$root" 2>/dev/null \
        | grep -v -E '/(node_modules|dist|build|\.git|coverage)/' || true)
    [ -z "$raw" ] && continue
    while IFS= read -r line; do
      local file="${line%%:*}"
      if is_allowed_legacy "$file"; then
        verb "allowed: $line"
        continue
      fi
      hits+=("$line")
    done <<< "$raw"
  done

  if [ "${#hits[@]}" = 0 ]; then
    pass "$label"
  else
    fail "$label — ${#hits[@]} hit(s) found"
    for h in "${hits[@]}"; do printf '      %s\n' "$h" >&2; done
  fi
}

# ---- check 7: no workstream.json under registered projects ----------------

check_no_workstream_files() {
  local label="check 7: no residual workstream.json files"
  local hits=()
  local i=0
  while [ "$i" -lt "${#PIDS[@]}" ]; do
    local pid="${PIDS[$i]}" ppath="${PPATHS[$i]}"
    i=$((i + 1))
    [ -d "$ppath/projects/active" ] || continue
    while IFS= read -r -d '' f; do
      hits+=("$pid: $f")
    done < <(find "$ppath/projects/active" -type f -name workstream.json -print0 2>/dev/null)
  done
  if [ "${#hits[@]}" = 0 ]; then
    pass "$label"
  else
    fail "$label — ${#hits[@]} file(s) remain"
    for h in "${hits[@]}"; do printf '      %s\n' "$h" >&2; done
  fi
}

# ---- main ------------------------------------------------------------------

require jq
require python3

printf 'yaco-doctor: YACO_HOME=%s\n' "$YACO_HOME"
printf -- '----\n'

load_registry

check_registry_paths
check_unique_ids
check_tasks_graphs
check_events_jsonl
check_multmux_status
check_no_legacy_paths
check_no_workstream_files

printf -- '----\n'
if [ "$FAILS" = 0 ]; then
  printf 'OK  all checks passed'
  [ "$WARNS" -gt 0 ] && printf ' (%d warning(s))' "$WARNS"
  printf '\n'
  exit 0
fi
printf 'FAIL  %d check(s) failed' "$FAILS"
[ "$WARNS" -gt 0 ] && printf ' (%d warning(s))' "$WARNS"
printf '\n'
[ "$FAILS" -gt 125 ] && FAILS=125
exit "$FAILS"
