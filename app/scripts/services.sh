#!/usr/bin/env bash
# Manage workflow long-running services (workflow-server, workflow-ui).
# Linux: systemd user services in ~/.config/systemd/user/
# macOS: launchd LaunchAgents in ~/Library/LaunchAgents/

set -euo pipefail

case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=macos ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

WORKFLOW_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$WORKFLOW_DIR/server"
UI_DIR="$WORKFLOW_DIR/ui"

if [ "$OS" = linux ]; then
  UNITS=(workflow-server.service workflow-ui.service)
  UNIT_DIR="$HOME/.config/systemd/user"
else
  LABELS=(com.workflow.server com.workflow.ui)
  PLIST_DIR="$HOME/Library/LaunchAgents"
  LOG_DIR="$HOME/Library/Logs"
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
  cat > "$UNIT_DIR/workflow-server.service" <<EOF
[Unit]
Description=Workflow backend (Hono + tsx watch)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
Environment="PATH=$HOME/.local/bin:$node_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=$node_bin_dir/npm run dev
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  cat > "$UNIT_DIR/workflow-ui.service" <<EOF
[Unit]
Description=Workflow frontend (Vite dev)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$UI_DIR
Environment="PATH=$HOME/.local/bin:$node_bin_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=$node_bin_dir/npm run dev
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNITS[@]}"
  echo "Installed and started:"
  echo "  $UNIT_DIR/workflow-server.service"
  echo "  $UNIT_DIR/workflow-ui.service"
}

install_macos() {
  local node_bin_dir; node_bin_dir="$(resolve_node_bin_dir)"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"
  local labels=(server ui)
  local dirs=("$SERVER_DIR" "$UI_DIR")
  for i in 0 1; do
    local label="com.workflow.${labels[$i]}"
    local wd="${dirs[$i]}"
    local logfile="$LOG_DIR/workflow-${labels[$i]}.log"
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
        <string>dev</string>
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
  echo "  $PLIST_DIR/com.workflow.server.plist  (logs: $LOG_DIR/workflow-server.log)"
  echo "  $PLIST_DIR/com.workflow.ui.plist      (logs: $LOG_DIR/workflow-ui.log)"
}

linux_cmd() {
  case "$1" in
    status)  systemctl --user status "${UNITS[@]}" --no-pager -n 0 ;;
    start|stop|restart|enable|disable)
             systemctl --user "$1" "${UNITS[@]}" ;;
    logs)    journalctl --user -u workflow-server -u workflow-ui -f ;;
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
      touch "$LOG_DIR/workflow-server.log" "$LOG_DIR/workflow-ui.log"
      tail -F "$LOG_DIR/workflow-server.log" "$LOG_DIR/workflow-ui.log"
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
