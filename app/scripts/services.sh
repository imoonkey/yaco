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

# The canonical service set, as `name|working dir|npm script|description`.
# Unit/label names derive from `name`, so this table is the single place a
# service is added or renamed.
SERVICES=(
  "server|$SERVER_DIR|start|YACO backend (Hono)"
  "ui|$UI_DIR|dev|YACO frontend (Vite dev)"
  "ui-build|$UI_DIR|build:watch|YACO frontend (production build watcher)"
)
svc_name()  { cut -d'|' -f1 <<<"$1"; }
svc_dir()   { cut -d'|' -f2 <<<"$1"; }
svc_script(){ cut -d'|' -f3 <<<"$1"; }
svc_desc()  { cut -d'|' -f4 <<<"$1"; }

# Canonical tailnet mapping: `/` serves the built bundle — over a high-RTT link
# Vite dev's unbundled module graph costs ~7x the requests — and DEV_SERVE_PORT
# keeps Vite reachable for HMR. -> See: doc/dev/app/workflow.md
UI_PORT=5173
API_PORT=3001
DEV_SERVE_PORT=8741

if [ "$OS" = linux ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNITS=(); for s in "${SERVICES[@]}"; do UNITS+=("yaco-$(svc_name "$s").service"); done
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

install_linux() {
  local node_bin_dir; node_bin_dir="$(resolve_node_bin_dir)"
  mkdir -p "$UNIT_DIR"
  for s in "${SERVICES[@]}"; do
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
ExecStart=$node_bin_dir/npm run $(svc_script "$s")
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  done
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNITS[@]}"
  echo "Installed and started:"
  for u in "${UNITS[@]}"; do echo "  $UNIT_DIR/$u"; done
  configure_serve
}

install_macos() {
  local node_bin_dir; node_bin_dir="$(resolve_node_bin_dir)"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  for s in "${SERVICES[@]}"; do
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
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" "$plist"
  done
  echo "Installed and started:"
  for s in "${SERVICES[@]}"; do
    local n; n="$(svc_name "$s")"
    echo "  $PLIST_DIR/com.yaco.$n.plist  (logs: $LOG_DIR/yaco-$n.log)"
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
