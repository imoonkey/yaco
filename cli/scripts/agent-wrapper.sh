#!/bin/bash
# yaco agent session wrapper — handle + createdAt passed explicitly, global state dir.
# Sole shell exception in the agent runtime (per Shell Boundary in the design):
# the EXIT trap must fire even if the tmux pane dies abruptly, which TypeScript
# can't observe from outside. Everything else (hooks, lifecycle) lives in TS.
sd="${YACO_AGENT_SESSIONS_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}"
sn="${1:?wrapper requires handle as first arg}"
created_at="${2:?wrapper requires createdAt as second arg}"
shift 2
trap '
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
  [ -n "$name" ] && [ "$should_delete" = "1" ] && {
    rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
    sleep 0.3
    rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
  }
' EXIT
# Strip npm_config_* / npm_lifecycle_* / npm_package_* leaked when the parent
# was launched via `npm run`; nvm refuses to initialize otherwise. The tmux
# server caches its initial env, so this can persist even when the immediate
# parent already stripped them.
unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}')
# Run the agent through a login + interactive bash so it sees the same env as
# if launched from a terminal (sources /etc/profile, ~/.profile, ~/.bashrc) —
# this is what makes SSH_AUTH_SOCK / PATH / etc behave the same in workflow
# as in a hand-opened terminal. `_` becomes $0; original args become $@.
bash -lic 'exec "$@"' _ "$@"
