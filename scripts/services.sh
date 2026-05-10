#!/usr/bin/env bash
# Manage workflow systemd user services (workflow-server, workflow-ui).

set -euo pipefail

SERVICES=(workflow-server.service workflow-ui.service)
CMD="${1:-status}"

usage() {
  cat <<EOF
Usage: scripts/services.sh [command]

Commands:
  status     Show status of both services (default)
  start      Start both services
  stop       Stop both services
  restart    Restart both services
  logs       Tail logs from both services (Ctrl-C to quit)
  enable     Enable autostart at boot
  disable    Disable autostart at boot
EOF
}

case "$CMD" in
  status)
    systemctl --user status "${SERVICES[@]}" --no-pager -n 0
    ;;
  start|stop|restart|enable|disable)
    systemctl --user "$CMD" "${SERVICES[@]}"
    ;;
  logs)
    journalctl --user -u workflow-server -u workflow-ui -f
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
