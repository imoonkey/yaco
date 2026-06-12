#!/bin/bash
# yaco agent session wrapper — handle + createdAt passed explicitly, global state dir.
# Sole shell exception in the agent runtime (per Shell Boundary in the design):
# the EXIT trap must fire even if the tmux pane dies abruptly, which TypeScript
# can't observe from outside. Everything else (hooks, lifecycle) lives in TS.
sd="${YACO_AGENT_SESSIONS_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}"
sn="${1:?wrapper requires handle as first arg}"
created_at="${2:?wrapper requires createdAt as second arg}"
shift 2

# Generation-scoped kill discriminator. True only when a `.killing-<handle>`
# sentinel exists AND its stored createdAt matches THIS generation — so a stale
# sentinel left by a crashed CLI cannot suppress a future same-handle crash.
# Mirrors the TS killSentinelMatches helper (kill-sentinel.ts).
kill_sentinel_matches() {
  ksm_s="$sd/.killing-$1"
  [ -f "$ksm_s" ] && [ "$(cat "$ksm_s" 2>/dev/null)" = "$2" ]
}

# Fail-closed crash tombstone — the documented narrow shell exception. Used ONLY
# when `yaco agent mark-crashed` cannot run (binary missing, PATH stripped), so a
# non-zero exit never leaves a GC-able non-crashed dead state. Writes the full
# crash invariant set (status:crashed, exitCode, statusEnteredAt; drops
# blockReason; preserves createdAt/handle/provider/...) as valid compact JSON via
# temp-file + mv, guarded by the same generation + sentinel checks as mark-crashed.
crash_fallback() {
  cf_name="$1"; cf_ec="$2"; cf_ca="$3"
  cf_file="$sd/$cf_name.json"
  [ -f "$cf_file" ] || return 0
  cf_cur=$(sed -n "s/.*\"createdAt\":\"\([^\"]*\)\".*/\1/p" "$cf_file")
  [ "$cf_cur" = "$cf_ca" ] || return 0          # reused/newer generation — leave it
  kill_sentinel_matches "$cf_name" "$cf_ca" && return 0
  cf_now="$(date -u +%Y-%m-%dT%H:%M:%S).000Z"
  cf_body=$(cat "$cf_file")
  cf_body=$(printf '%s' "$cf_body" | sed -E \
    -e 's/"blockReason":"[^"]*",?//g' \
    -e 's/"exitCode":-?[0-9]+,?//g' \
    -e 's/"statusEnteredAt":"[^"]*",?//g' \
    -e 's/"status":"[^"]*"/"status":"crashed"/' \
    -e 's/,+}/}/g' \
    -e 's/,{2,}/,/g' \
    -e 's/\{,/{/g')
  cf_body=$(printf '%s' "$cf_body" | sed -E "s/}\$/,\"exitCode\":$cf_ec,\"statusEnteredAt\":\"$cf_now\"}/")
  cf_tmp="$cf_file.$$.crash.tmp"
  printf '%s' "$cf_body" > "$cf_tmp" && mv -f "$cf_tmp" "$cf_file"
}

trap '
  ec=$?
  should_delete=1
  # Only re-read session name if tmux session is still alive (rename case).
  # Do NOT query display-message on a dead session — tmux falls back to a
  # random other session, causing deletion of the wrong state file.
  name="$sn"
  if tmux has-session -t "=$sn" 2>/dev/null; then
    cn=$(tmux display-message -p -t "=$sn" "#{session_name}" 2>/dev/null)
    [ -n "$cn" ] && name="$cn"
  elif [ -f "$sd/.renamed-$sn" ]; then
    name=$(cat "$sd/.renamed-$sn")
  fi
  # Clean up breadcrumb regardless of how we resolved the name
  rm -f "$sd/.renamed-$sn"
  if [ -n "$name" ] && [ -f "$sd/$name.json" ]; then
    current_created_at=$(sed -n "s/.*\"createdAt\":\"\([^\"]*\)\".*/\1/p" "$sd/$name.json")
    if [ -n "$current_created_at" ] && [ "$current_created_at" != "$created_at" ]; then
      should_delete=0
    fi
  fi
  if [ -n "$name" ] && [ "$should_delete" = "1" ]; then
    # Clean exit (0) or an intentional kill of THIS generation deletes the state.
    # Any other non-zero exit is a crash: tombstone it (fail-closed via fallback).
    # The clean-delete branch checks a generation-matched sentinel, never bare
    # file existence, so a stale sentinel cannot erase a future crash.
    if [ "$ec" = "0" ] || kill_sentinel_matches "$name" "$created_at"; then
      rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
      sleep 0.3
      rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
    else
      $YACO_BIN agent mark-crashed "$name" --exit "$ec" --created-at "$created_at" \
        || crash_fallback "$name" "$ec" "$created_at"
    fi
  fi
' EXIT
# Strip npm_config_* / npm_lifecycle_* / npm_package_* leaked when the parent
# was launched via `npm run`; nvm refuses to initialize otherwise. The tmux
# server caches its initial env, so this can persist even when the immediate
# parent already stripped them.
unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}')
# Session lineage capture: export this session's handle so a child `yaco agent
# start` launched from inside the agent inherits it and records spawnedBy=agent
# with parentSession=<this handle>. Clear the one-shot web spawn marker so it
# never leaks into long-lived child environments (handle precedence already
# makes an inherited user:web harmless; clearing it is cheap env hygiene).
export YACO_AGENT_HANDLE="$sn"
unset YACO_AGENT_SPAWNED_BY
# Run the agent through a login + interactive bash so it sees the same env as
# if launched from a terminal (sources /etc/profile, ~/.profile, ~/.bashrc) —
# this is what makes SSH_AUTH_SOCK / PATH / etc behave the same in workflow
# as in a hand-opened terminal. `_` becomes $0; original args become $@.
bash -lic 'exec "$@"' _ "$@"
