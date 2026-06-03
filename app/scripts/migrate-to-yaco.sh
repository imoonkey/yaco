#!/usr/bin/env bash
# One-time operator script to migrate ~/.workflow + ~/.multmux state into ~/.yaco.
#
# Design: projects/active/yaco-core/final/design.md  (section "Migration")
# SPEC:   projects/active/yaco-core/final/SPEC.md
#
# This script is idempotent: a second invocation on already-migrated state
# is a no-op (every step prints [skip]). It does NOT delete source data and
# it does NOT reinstall multmux hooks — those are operator follow-ups.
#
# Flags:
#   --dry-run   Print every operation prefixed with [would] without performing it.
#   --yes       Skip interactive prompts (used by the smoke test).
#   --help      Print usage and exit.

set -euo pipefail

# ---- argv ------------------------------------------------------------------

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --help|-h)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) echo "migrate-to-yaco: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ---- environment -----------------------------------------------------------

YACO_HOME="${YACO_HOME:-$HOME/.yaco}"
WORKFLOW_HOME="${WORKFLOW_HOME:-$HOME/.workflow}"
MULTMUX_HOME="${MULTMUX_HOME:-$HOME/.multmux}"

# ---- log helpers -----------------------------------------------------------

log_ok()   { printf '[ok]    %s\n'   "$1"; }
log_skip() { printf '[skip]  %s\n'   "$1"; }
log_warn() { printf '[warn]  %s\n'   "$1" >&2; }
log_err()  { printf '[error] %s\n'   "$1" >&2; }
log_info() { printf '[info]  %s\n'   "$1"; }
log_would(){ printf '[would] %s\n'   "$1"; }

do_or_would() {
  # do_or_would "<human description>" cmd args...
  local msg="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then
    log_would "$msg"
    return 0
  fi
  "$@"
  log_ok "$msg"
}

require() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    log_err "required binary not found in PATH: $bin"
    exit 1
  fi
}

# ---- preflight -------------------------------------------------------------

preflight_workflow_server() {
  if [ "${MIGRATE_SKIP_PREFLIGHT:-0}" = 1 ]; then
    log_warn "preflight: MIGRATE_SKIP_PREFLIGHT=1 — skipping workflow server check (test only)"
    return 0
  fi
  local detected=0
  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
      detected=1
    fi
  fi
  if [ "$detected" = 0 ] && command -v curl >/dev/null 2>&1; then
    if curl -sf -o /dev/null --max-time 1 http://localhost:3001/health 2>/dev/null; then
      detected=1
    fi
  fi
  if [ "$detected" = 1 ]; then
    log_err "YACO dev server appears to be running on :3001."
    log_err "Stop it (npm run dev / systemctl --user stop yaco-server) and re-run."
    exit 1
  fi
  log_ok "preflight: workflow server not running on :3001"
}

preflight_tmux_sessions() {
  local sessions
  sessions=$(tmux ls 2>/dev/null || true)
  if [ -z "$sessions" ]; then
    log_ok "preflight: no live tmux sessions"
    return 0
  fi
  log_warn "live tmux sessions detected — migration does not preserve old hook paths:"
  printf '%s\n' "$sessions" | sed 's/^/        /' >&2
  log_warn "restart affected sessions if their old hook paths stop updating state."
  if [ "$ASSUME_YES" = 1 ]; then
    log_info "--yes set; continuing without prompt."
    return 0
  fi
  printf 'Continue? [y/N] ' >&2
  local reply
  read -r reply || reply=
  case "${reply:-}" in
    y|Y|yes|YES) ;;
    *) log_err "aborted by user."; exit 1 ;;
  esac
}

# ---- step 1: projects.json -------------------------------------------------

migrate_projects_json() {
  local src="$WORKFLOW_HOME/projects.json"
  local dst="$YACO_HOME/projects.json"

  if [ ! -f "$src" ]; then
    log_skip "projects.json: no source at $src"
    return 0
  fi

  # Compute converted target content (id from old name, path from old path).
  local converted
  if ! converted=$(jq -c 'map({id: .name, path: .path})' "$src" 2>/dev/null); then
    log_err "projects.json: failed to parse $src as JSON array"
    exit 1
  fi

  if [ -f "$dst" ]; then
    local existing
    existing=$(jq -c '.' "$dst" 2>/dev/null || echo 'null')
    if [ "$existing" = "$converted" ]; then
      log_skip "projects.json: $dst already matches converted source"
      return 0
    fi
    # Tolerate an empty array as "fresh".
    local existing_len
    existing_len=$(jq 'length' "$dst" 2>/dev/null || echo 'x')
    if [ "$existing_len" != "0" ]; then
      log_err "projects.json: $dst exists with different content; refusing to overwrite."
      log_err "Resolve manually (diff against $src) and re-run."
      exit 1
    fi
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log_would "write converted projects.json to $dst"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  printf '%s\n' "$converted" | jq '.' > "$dst.tmp"
  mv "$dst.tmp" "$dst"
  log_ok "projects.json: wrote $dst ($(jq 'length' "$dst") entries)"
}

# ---- step 2-4: directory contents moves (mv -n, per-file) ------------------

move_dir_contents() {
  # move_dir_contents "<label>" <src_dir> <dst_dir>
  local label="$1" src="$2" dst="$3"

  if [ ! -d "$src" ]; then
    log_skip "$label: no source dir $src"
    return 0
  fi

  # Anything to move?
  local has_entry=0
  if [ -n "$(find "$src" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    has_entry=1
  fi
  if [ "$has_entry" = 0 ]; then
    log_skip "$label: source dir $src is empty"
    return 0
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log_would "ensure dir $dst exists"
  else
    mkdir -p "$dst"
  fi

  local moved=0 skipped=0
  # NUL-delimited to handle awkward names.
  while IFS= read -r -d '' entry; do
    local base
    base=$(basename "$entry")
    local target="$dst/$base"
    if [ -e "$target" ]; then
      log_skip "$label: $base already exists in $dst"
      skipped=$((skipped + 1))
      continue
    fi
    if [ -d "$entry" ] && [ -d "$target" ]; then
      # both dirs exist somehow — recurse per-child
      move_dir_contents "$label/$base" "$entry" "$target"
      continue
    fi
    if [ "$DRY_RUN" = 1 ]; then
      log_would "mv $entry -> $target"
    else
      mv -n "$entry" "$target"
      log_ok "$label: moved $base -> $dst"
    fi
    moved=$((moved + 1))
  done < <(find "$src" -mindepth 1 -maxdepth 1 -print0)

  if [ "$DRY_RUN" = 0 ] && [ "$moved" = 0 ] && [ "$skipped" -gt 0 ]; then
    log_skip "$label: nothing new to move (all $skipped entries already in $dst)"
  fi
}

# ---- step 5: per-scope channels merge --------------------------------------

migrate_channels() {
  local src="$WORKFLOW_HOME/channels"
  local dst="$YACO_HOME/channels"

  if [ ! -d "$src" ]; then
    log_skip "channels: no source dir $src"
    return 0
  fi

  while IFS= read -r -d '' scope_dir; do
    local scope
    scope=$(basename "$scope_dir")
    move_dir_contents "channels/$scope" "$scope_dir" "$dst/$scope"
  done < <(find "$src" -mindepth 1 -maxdepth 1 -type d -print0)
}

# ---- step 6: multmux hook + wrapper scripts -------------------------------
#
migrate_multmux_scripts() {
  for f in hook-v2.sh wrapper-v2.sh; do
    local src="$MULTMUX_HOME/$f"
    local dst="$YACO_HOME/$f"
    if [ ! -f "$src" ]; then
      log_skip "multmux script: no source $src"
      continue
    fi
    if [ -e "$dst" ]; then
      log_skip "multmux script: $dst already exists"
      continue
    fi
    if [ "$DRY_RUN" = 1 ]; then
      log_would "mv $src -> $dst"
    else
      mkdir -p "$YACO_HOME"
      mv -n "$src" "$dst"
      log_ok "multmux script: moved $f -> $YACO_HOME/"
    fi
  done
}

# ---- step 7: progress.json -> events.jsonl --------------------------------

# Convert a single source progress.json file into NDJSON event lines on stdout.
# Each entry becomes one line. Entry-level mapping rules:
#   id:        entry.id      // generated uuid-like
#   ts:        entry.ts      // entry.timestamp // <file mtime ISO>
#   kind:      derived from entry.type (legacy ProgressEntry → scanner-recognized event kind):
#                session_idle  -> session_idle
#                human_review  -> human_review_requested
#                blocked       -> verification_failed
#                info          -> dispatched      (both `dispatched` and `verified` project to `info` in scanner)
#              otherwise: entry.kind // "progress" (preserved as-is; non-projected events are stored but invisible to UI)
#   taskId:    entry.workstream // entry.taskId // entry.task   (only when value matches schema slug pattern)
#   sessionId: entry.sessionName // entry.sessionId // entry.session
#   payload:   remaining fields (incl. message, agent, summary, label, …)
progress_to_events_jsonl() {
  local project_id="$1" src="$2"
  local mtime_iso
  mtime_iso=$(date -u -r "$src" '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || \
              date -u -d "@$(stat -c %Y "$src" 2>/dev/null || echo 0)" '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || \
              date -u '+%Y-%m-%dT%H:%M:%S.000Z')

  # The source may be either an array, or an object with an "entries" array, or a single object.
  # Normalize to an array first.
  jq -c \
    --arg projectId "$project_id" \
    --arg mtime "$mtime_iso" \
    '
    (if type == "array" then .
     elif type == "object" and (.entries|type) == "array" then .entries
     else [.] end)
    | to_entries[]
    | .value as $e
    | (
        if ($e.type // "") == "session_idle"  then "session_idle"
        elif ($e.type // "") == "human_review" then "human_review_requested"
        elif ($e.type // "") == "blocked"      then "verification_failed"
        elif ($e.type // "") == "info"         then "dispatched"
        else ($e.kind // "progress") end
      ) as $kind
    | (($e.workstream // $e.taskId // $e.task // "") | tostring) as $rawTask
    | (($e.sessionName // $e.sessionId // $e.session // "") | tostring) as $rawSession
    | {
        id:        ($e.id // ("evt_" + ($projectId|tostring) + "_" + (.key|tostring) + "_" + $mtime)),
        ts:        ($e.ts // $e.timestamp // $mtime),
        kind:      $kind,
        projectId: $projectId,
      }
      + (if ($rawTask != "") and ($rawTask | test("^[a-z0-9][a-z0-9-]*$"))
            then {taskId: $rawTask} else {} end)
      + (if $rawSession != "" then {sessionId: $rawSession} else {} end)
      + {payload: ($e | del(.id, .ts, .timestamp, .kind, .type, .workstream, .taskId, .task, .sessionId, .sessionName, .session))}
    ' "$src" 2>/dev/null
}

migrate_progress_for_project() {
  local project_id="$1" project_path="$2"
  local dst="$YACO_HOME/projects/$project_id/events.jsonl"
  local sources=()

  # Top-level progress.json
  if [ -f "$project_path/projects/progress.json" ]; then
    sources+=("$project_path/projects/progress.json")
  fi
  # Bundle-level progress.json
  if [ -d "$project_path/projects/active" ]; then
    while IFS= read -r -d '' f; do
      sources+=("$f")
    done < <(find "$project_path/projects/active" -mindepth 2 -maxdepth 2 -type f -name progress.json -print0 2>/dev/null)
  fi

  if [ "${#sources[@]}" = 0 ]; then
    log_skip "events: project $project_id has no progress.json sources"
    return 0
  fi

  # Generate new content into a tmpfile. Every exit path below removes $tmp.
  local tmp
  tmp=$(mktemp)

  for src in "${sources[@]}"; do
    if ! progress_to_events_jsonl "$project_id" "$src" >> "$tmp"; then
      log_err "events: failed to convert $src"
      rm -f "$tmp"
      return 1
    fi
  done

  local new_lines
  new_lines=$(wc -l < "$tmp" | tr -d ' ')
  if [ "$new_lines" = 0 ]; then
    log_skip "events: project $project_id source files produced no events"
    rm -f "$tmp"
    return 0
  fi

  if [ -f "$dst" ]; then
    local existing_lines
    existing_lines=$(wc -l < "$dst" | tr -d ' ')
    if [ "$existing_lines" -ge "$new_lines" ]; then
      log_skip "events: $dst has $existing_lines >= $new_lines lines (assume up-to-date)"
      rm -f "$tmp"
      return 0
    fi
    # Append only the missing tail lines deterministically.
    local missing=$((new_lines - existing_lines))
    if [ "$DRY_RUN" = 1 ]; then
      log_would "append last $missing line(s) to $dst"
    else
      tail -n "$missing" "$tmp" >> "$dst"
      log_ok "events: appended $missing line(s) to $dst (now $(wc -l < "$dst" | tr -d ' ') total)"
    fi
    rm -f "$tmp"
    return 0
  fi

  if [ "$DRY_RUN" = 1 ]; then
    log_would "write $new_lines event line(s) to $dst"
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  mv "$tmp" "$dst"
  log_ok "events: wrote $new_lines line(s) to $dst"
}

migrate_progress_files() {
  local registry="$YACO_HOME/projects.json"
  if [ ! -f "$registry" ]; then
    log_skip "events: no $registry — skip progress conversion"
    return 0
  fi
  local count
  count=$(jq 'length' "$registry" 2>/dev/null || echo 0)
  if [ "$count" = 0 ]; then
    log_skip "events: registry is empty"
    return 0
  fi
  local i=0
  while [ "$i" -lt "$count" ]; do
    local pid ppath
    pid=$(jq -r ".[$i].id" "$registry")
    ppath=$(jq -r ".[$i].path" "$registry")
    if [ ! -d "$ppath" ]; then
      log_warn "events: project $pid path does not exist: $ppath (skip)"
    else
      migrate_progress_for_project "$pid" "$ppath" || true
    fi
    i=$((i + 1))
  done
}

# ---- step 8: workstream.json -> TODO instruction file ---------------------

emit_workstream_todos_for_project() {
  local project_id="$1" project_path="$2"
  local active_dir="$project_path/projects/active"
  if [ ! -d "$active_dir" ]; then
    return 0
  fi
  local todos=()
  while IFS= read -r -d '' ws; do
    todos+=("$ws")
  done < <(find "$active_dir" -mindepth 2 -maxdepth 2 -type f -name workstream.json -print0 2>/dev/null)

  if [ "${#todos[@]}" = 0 ]; then
    log_skip "workstream: project $project_id has no workstream.json bundles"
    return 0
  fi

  local out="/tmp/yaco-workstream-todos-${project_id}.txt"
  if [ "$DRY_RUN" = 1 ]; then
    log_would "write workstream TODO file $out (${#todos[@]} bundle(s))"
    return 0
  fi
  local tmp_out
  tmp_out=$(mktemp)
  {
    printf '# YACO workstream-collapse TODOs for project: %s\n' "$project_id"
    printf '# Repo: %s\n' "$project_path"
    printf '#\n'
    printf '# These workstream.json files were detected. /update-tasks should\n'
    printf '# create or amend tasks per projects/active/yaco-core/final/fixtures/workstream-status-mapping.json.\n'
    printf '#\n'
    printf '# Status mapping:\n'
    printf '#   active        -> ready\n'
    printf '#   human_review  -> blocked, blockReason=human-review\n'
    printf '#   blocked       -> blocked, blockReason=external (override if a better reason is known)\n'
    printf '#   parked        -> cancelled, tags=[parked]\n'
    printf '#   done          -> done\n'
    printf '# Incomplete checkpoints become child tasks; completed checkpoints become history (notes/events).\n'
    printf '# Move doc into task.design.\n'
    printf '#\n'
    printf '# Suggested invocation:\n'
    printf '#   cd %s && /update-tasks   (then attach this file)\n' "$project_path"
    printf '#\n'
    printf '# Bundles:\n'
    local i=1
    for ws in "${todos[@]}"; do
      local rel="${ws#"$project_path/"}"
      local slug status doc cps_total cps_open
      slug=$(basename "$(dirname "$ws")")
      status=$(jq -r '.status // "unknown"' "$ws" 2>/dev/null || echo unknown)
      doc=$(jq -r '.doc // ""' "$ws" 2>/dev/null || echo '')
      cps_total=$(jq '(.checkpoints // []) | length' "$ws" 2>/dev/null || echo 0)
      cps_open=$(jq '(.checkpoints // []) | map(select(.done != true)) | length' "$ws" 2>/dev/null || echo 0)
      printf '%d. %s\n' "$i" "$rel"
      printf '   slug:           %s\n' "$slug"
      printf '   status:         %s\n' "$status"
      printf '   doc:            %s\n' "${doc:-(none)}"
      printf '   checkpoints:    total=%s open=%s\n' "$cps_total" "$cps_open"
      printf '\n'
      i=$((i + 1))
    done
    printf '# After /update-tasks has applied the mapping and you verify the result,\n'
    printf '# remove the workstream.json files manually:\n'
    for ws in "${todos[@]}"; do
      printf '#   rm %s\n' "$ws"
    done
  } > "$tmp_out"

  if [ -f "$out" ] && cmp -s "$tmp_out" "$out"; then
    rm -f "$tmp_out"
    log_skip "workstream: $out already up-to-date (${#todos[@]} bundle(s))"
    return 0
  fi
  mv "$tmp_out" "$out"
  log_ok "workstream: wrote $out (${#todos[@]} bundle(s))"
}

emit_workstream_todos() {
  local registry="$YACO_HOME/projects.json"
  if [ ! -f "$registry" ]; then
    log_skip "workstream: no $registry — skip workstream collapse"
    return 0
  fi
  local count
  count=$(jq 'length' "$registry" 2>/dev/null || echo 0)
  local i=0
  while [ "$i" -lt "$count" ]; do
    local pid ppath
    pid=$(jq -r ".[$i].id" "$registry")
    ppath=$(jq -r ".[$i].path" "$registry")
    if [ -d "$ppath" ]; then
      emit_workstream_todos_for_project "$pid" "$ppath" || true
    fi
    i=$((i + 1))
  done
}

# ---- main ------------------------------------------------------------------

main() {
  require jq

  printf 'migrate-to-yaco: dry-run=%s yes=%s\n' "$DRY_RUN" "$ASSUME_YES"
  printf '  YACO_HOME     = %s\n' "$YACO_HOME"
  printf '  WORKFLOW_HOME = %s\n' "$WORKFLOW_HOME"
  printf '  MULTMUX_HOME  = %s\n' "$MULTMUX_HOME"
  printf -- '----\n'

  preflight_workflow_server
  preflight_tmux_sessions

  if [ "$DRY_RUN" = 1 ]; then
    log_would "mkdir -p $YACO_HOME"
  else
    mkdir -p "$YACO_HOME"
  fi

  # 1. projects.json
  migrate_projects_json

  # 2-4. ui-state, shell-sessions, multmux sessions
  move_dir_contents "ui-state"       "$WORKFLOW_HOME/ui-state"       "$YACO_HOME/ui-state"
  move_dir_contents "shell-sessions" "$WORKFLOW_HOME/shell-sessions" "$YACO_HOME/shell-sessions"
  move_dir_contents "sessions"       "$MULTMUX_HOME/sessions"        "$YACO_HOME/sessions"

  # 5. channels (per-scope merge)
  migrate_channels

  # 6. multmux hook + wrapper scripts
  migrate_multmux_scripts

  # 7. progress.json -> events.jsonl per project
  migrate_progress_files

  # 8. workstream.json -> instruction file per project
  emit_workstream_todos

  printf -- '----\n'
  printf 'Migration data steps complete.\n'
  printf '\n'
  printf 'Operator follow-ups (NOT performed automatically):\n'
  printf '  1. Run:\n'
  printf '       multmux install-hooks\n'
  printf '     This rewrites Claude/Codex hook configs to the new ~/.yaco paths.\n'
  printf '\n'
  printf '  2. For each project listed in $YACO_HOME/projects.json with a\n'
  printf '     /tmp/yaco-workstream-todos-<id>.txt file, run /update-tasks and\n'
  printf '     attach that file. Verify the resulting tasks.json, then manually\n'
  printf '     delete the workstream.json files listed there.\n'
  printf '\n'
  printf '  3. Run doctor checks (yc-doctor-checks task / script) and confirm\n'
  printf '     that no references to ~/.workflow or ~/.multmux remain.\n'
  printf '\n'
  printf '  4. After doctor checks pass, you can:\n'
  printf '       rm -rf %s\n' "$WORKFLOW_HOME"
  printf '       rm -rf %s\n' "$MULTMUX_HOME"
  printf '\n'
  printf 'Next: bash scripts/yaco-doctor.sh   # validate the migrated state\n'
}

main "$@"
