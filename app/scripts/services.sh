#!/usr/bin/env bash
# Manage YACO long-running services (yaco-server, yaco-ui, yaco-ui-build).
# Linux: systemd user services in ~/.config/systemd/user/
# macOS: launchd LaunchAgents in ~/Library/LaunchAgents/

set -euo pipefail

case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=macos ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

APP_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$APP_DIR/server"
UI_DIR="$APP_DIR/ui"

# The canonical service set, as
# `name|working dir|npm script|description|MemoryHigh|MemoryMax|autostart`.
# Unit/label names derive from `name`, so this table is the single place a
# service is added, renamed, or moved between always-on and on-demand.
#
# autostart=no still generates the unit/plist — `install` just does not enable or
# start it. That is for services only a person actively editing needs: they cost
# a resident Node process around the clock otherwise, and this box shares memory
# with agent fleets.
#
# The memory bounds matter as much as the restart policy. These are long-lived
# Node processes on a box that also runs agent fleets; once one is large enough
# to be paged out, every major GC becomes a swap-in storm that stalls the whole
# event loop for seconds — which on `server` freezes every attached terminal.
# Killing and restarting is strictly better than that. MemoryMax is a cgroup
# ceiling; the backend additionally caps V8 itself via `--max-old-space-size`
# in `app/server/package.json`, so it usually dies on the heap cap first with a
# clean OOM trace instead of a SIGKILL.
#
# Size these from the CGROUP's observed peak, never from the main process's RSS
# — the ceiling governs every process in the unit. `server` also hosts the
# WhatsApp puppeteer Chrome fleet (~950MB RSS across 7 processes), and
# `ui-build` spikes to ~1.3GB during a full rebuild; a limit set from the Node
# RSS alone kills both. An OOM'd `ui-build` is especially bad: vite empties
# `dist/` per rebuild, so a mid-build kill can leave `/` serving nothing.
SERVICES=(
  "server|$SERVER_DIR|start|YACO backend (Hono)|2G|3G|yes"
  "ui|$UI_DIR|dev|YACO frontend (Vite dev)|1G|2G|no"
  "ui-build|$UI_DIR|build:watch|YACO frontend (production build watcher)|2G|3G|yes"
)
svc_name()  { cut -d'|' -f1 <<<"$1"; }
svc_dir()   { cut -d'|' -f2 <<<"$1"; }
svc_script(){ cut -d'|' -f3 <<<"$1"; }
svc_desc()  { cut -d'|' -f4 <<<"$1"; }
svc_mem_high(){ cut -d'|' -f5 <<<"$1"; }
svc_mem_max() { cut -d'|' -f6 <<<"$1"; }
svc_autostart(){ cut -d'|' -f7 <<<"$1"; }

# Canonical tailnet mapping: `/` serves the built bundle — over a high-RTT link
# Vite dev's unbundled module graph costs ~7x the requests — and DEV_SERVE_PORT
# keeps Vite reachable for HMR. -> See: doc/dev/app/workflow.md
UI_PORT=5173
API_PORT=3001
DEV_SERVE_PORT=8741

if [ "$OS" = linux ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNITS=(); for s in "${SERVICES[@]}"; do UNITS+=("yaco-$(svc_name "$s").service"); done
  # Subset `install` enables; the rest are generated but left for on-demand start.
  AUTO_UNITS=(); for s in "${SERVICES[@]}"; do
    [ "$(svc_autostart "$s")" = yes ] && AUTO_UNITS+=("yaco-$(svc_name "$s").service")
  done
else
  PLIST_DIR="$HOME/Library/LaunchAgents"
  LOG_DIR="$HOME/Library/Logs"
  LABELS=(); for s in "${SERVICES[@]}"; do LABELS+=("com.yaco.$(svc_name "$s")"); done
fi

CMD="${1:-status}"

usage() {
  cat <<EOF
Usage: app/scripts/services.sh [command]

Commands:
  status     Show status of both services (default)
  start      Start both services
  stop       Stop both services
  restart    Restart both services
  logs       Tail logs from both services (Ctrl-C to quit)
  enable     Enable autostart at boot/login
  disable    Disable autostart
  install    Generate unit/plist files for current OS and enable them
EOF
}

resolve_node_bin_dir() {
  local n
  n="$(command -v node || true)"
  if [ -z "$n" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    n="$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1)"
  fi
  if [ -z "$n" ]; then
    echo "Could not locate node. Install Node (e.g. via nvm) before running install." >&2
    return 1
  fi
  dirname "$n"
}

# YACO_ALLOWED_HOSTNAMES has to reach the Vite dev server through the service
# environment, because vite.config.ts reads process.env and never loads a .env.
# Trim around the commas exactly as the app parsers trim each entry, then refuse
# anything left that is not hostname text. `desktop, laptop` is accepted because
# both parsers accept it; `desk top` or a line-wrapped value is refused rather
# than joined into a different, real hostname the operator never authorized.
# Refusing non-hostname text is also what keeps the value from breaking the
# systemd directive or the plist XML it lands in. The `case` test is deliberate:
# `grep` anchors per line, so a two-line value would pass it line by line.
normalize_allowed_hostnames() {
  local v
  v="$(printf '%s' "${YACO_ALLOWED_HOSTNAMES:-}" \
       | sed 's/[[:blank:]]*,[[:blank:]]*/,/g; s/^[[:blank:]]*//; s/[[:blank:]]*$//')"
  case "$v" in
    *[!A-Za-z0-9.,:-]*)
      echo "services.sh: YACO_ALLOWED_HOSTNAMES is not a hostname list: ${YACO_ALLOWED_HOSTNAMES:-}" >&2
      echo "             expected something like 'desktop,.example.ts.net'" >&2
      return 1 ;;
  esac
  YACO_ALLOWED_HOSTNAMES="$v"
}

# Only the Vite dev server needs the hostnames in its process environment. The
# backend's source of truth is app/server/.env, and a service-level value would
# win over it permanently — dotenv leaves a key alone once it is in the
# environment, so a stale installer value would silently outrank the .env one.
svc_takes_hostnames() {
  [ "$(svc_name "$1")" = ui ] && [ -n "${YACO_ALLOWED_HOSTNAMES:-}" ]
}

install_linux() {
  local node_bin_dir; node_bin_dir="$(resolve_node_bin_dir)"
  mkdir -p "$UNIT_DIR"
  for s in "${SERVICES[@]}"; do
    local hosts_env=""
    svc_takes_hostnames "$s" \
      && hosts_env="Environment=\"YACO_ALLOWED_HOSTNAMES=$YACO_ALLOWED_HOSTNAMES\""
    cat > "$UNIT_DIR/yaco-$(svc_name "$s").service" <<EOF
[Unit]
Description=$(svc_desc "$s")
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$(svc_dir "$s")
Environment="PATH=$HOME/.local/bin:$node_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
$hosts_env
ExecStart=$node_bin_dir/npm run $(svc_script "$s")
Restart=on-failure
RestartSec=5
MemoryHigh=$(svc_mem_high "$s")
MemoryMax=$(svc_mem_max "$s")
MemorySwapMax=0
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  done
  systemctl --user daemon-reload
  systemctl --user enable --now "${AUTO_UNITS[@]}"
  echo "Installed and started:"
  for u in "${AUTO_UNITS[@]}"; do echo "  $UNIT_DIR/$u"; done
  # Declarative, not additive: a unit demoted to autostart=no must lose the
  # enablement a previous install gave it, or it silently keeps coming back at
  # boot. Not --now, so an install never kills a session someone is using.
  for s in "${SERVICES[@]}"; do
    [ "$(svc_autostart "$s")" = yes ] && continue
    local n; n="$(svc_name "$s")"
    systemctl --user disable "yaco-$n.service" >/dev/null 2>&1 || true
    echo "  $UNIT_DIR/yaco-$n.service  (on demand: systemctl --user start yaco-$n)"
  done
  configure_serve
}

install_macos() {
  local node_bin_dir; node_bin_dir="$(resolve_node_bin_dir)"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  for s in "${SERVICES[@]}"; do
    local hosts_env=""
    svc_takes_hostnames "$s" && hosts_env="        <key>YACO_ALLOWED_HOSTNAMES</key>
        <string>$YACO_ALLOWED_HOSTNAMES</string>"
    local name; name="$(svc_name "$s")"
    local label="com.yaco.$name"
    local wd; wd="$(svc_dir "$s")"
    local logfile="$LOG_DIR/yaco-$name.log"
    local plist="$PLIST_DIR/$label.plist"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>WorkingDirectory</key>
    <string>$wd</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node_bin_dir/npm</string>
        <string>run</string>
        <string>$(svc_script "$s")</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:$node_bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
        <key>LC_CTYPE</key>
        <string>en_US.UTF-8</string>
$hosts_env
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$logfile</string>
    <key>StandardErrorPath</key>
    <string>$logfile</string>
</dict>
</plist>
EOF
    # Reload: bootout if already loaded, then bootstrap (also starts due to RunAtLoad).
    # An autostart=no service gets its plist written but is left unloaded, so it
    # neither runs now nor at login until someone bootstraps it deliberately.
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    [ "$(svc_autostart "$s")" = yes ] && launchctl bootstrap "gui/$UID" "$plist"
  done
  echo "Installed:"
  for s in "${SERVICES[@]}"; do
    local n; n="$(svc_name "$s")"
    local on_demand=""
    [ "$(svc_autostart "$s")" = yes ] || on_demand="  (on demand: launchctl bootstrap gui/\$UID $PLIST_DIR/com.yaco.$n.plist)"
    echo "  $PLIST_DIR/com.yaco.$n.plist  (logs: $LOG_DIR/yaco-$n.log)$on_demand"
  done
  configure_serve
}

# Point the tailnet at the canonical pair. Idempotent; persists across reboots.
configure_serve() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale not found — skipping tailnet serve setup"
    return 0
  fi
  if tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" >/dev/null &&
     tailscale serve --bg --https="$DEV_SERVE_PORT" "http://127.0.0.1:$UI_PORT" >/dev/null; then
    echo "Tailnet: / -> :$API_PORT (built UI), :$DEV_SERVE_PORT -> :$UI_PORT (Vite dev, HMR)"
  else
    echo "Tailnet serve setup failed — is tailscaled up, and on Linux has 'sudo tailscale set --operator=$USER' been run?" >&2
  fi
}

linux_cmd() {
  case "$1" in
    status)  systemctl --user status "${UNITS[@]}" --no-pager -n 0 ;;
    start|stop|restart|enable|disable)
             systemctl --user "$1" "${UNITS[@]}" ;;
    logs)    local args=(); for u in "${UNITS[@]}"; do args+=(-u "$u"); done
             journalctl --user "${args[@]}" -f ;;
  esac
}

macos_cmd() {
  case "$1" in
    status)
      for label in "${LABELS[@]}"; do
        echo "=== $label ==="
        if launchctl print "gui/$UID/$label" 2>/dev/null | grep -E '^\s*(state|pid|last exit code)\s*=' ; then
          :
        else
          echo "  not loaded"
        fi
      done
      ;;
    start)
      for label in "${LABELS[@]}"; do
        local plist="$PLIST_DIR/$label.plist"
        if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
          launchctl kickstart -k "gui/$UID/$label"
        else
          launchctl bootstrap "gui/$UID" "$plist"
        fi
      done
      ;;
    stop)
      for label in "${LABELS[@]}"; do
        launchctl bootout "gui/$UID/$label" 2>/dev/null || true
      done
      ;;
    restart)
      for label in "${LABELS[@]}"; do
        launchctl kickstart -k "gui/$UID/$label" 2>/dev/null || launchctl bootstrap "gui/$UID" "$PLIST_DIR/$label.plist"
      done
      ;;
    enable)
      for label in "${LABELS[@]}"; do
        launchctl enable "gui/$UID/$label" 2>/dev/null || true
        launchctl bootstrap "gui/$UID" "$PLIST_DIR/$label.plist" 2>/dev/null || true
      done
      ;;
    disable)
      for label in "${LABELS[@]}"; do
        launchctl bootout "gui/$UID/$label" 2>/dev/null || true
        launchctl disable "gui/$UID/$label" 2>/dev/null || true
      done
      ;;
    logs)
      local logs=(); for s in "${SERVICES[@]}"; do logs+=("$LOG_DIR/yaco-$(svc_name "$s").log"); done
      touch "${logs[@]}"
      tail -F "${logs[@]}"
      ;;
  esac
}

case "$CMD" in
  status|start|stop|restart|logs|enable|disable)
    if [ "$OS" = linux ]; then linux_cmd "$CMD"; else macos_cmd "$CMD"; fi
    ;;
  install)
    normalize_allowed_hostnames || exit 1
    if [ "$OS" = linux ]; then install_linux; else install_macos; fi
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    usage >&2
    exit 1
    ;;
esac
