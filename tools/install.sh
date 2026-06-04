#!/usr/bin/env bash
# yaco bootstrap installer.
#
# The ONLY entry point for first-time install or recovery from a missing/broken
# yaco binary. Builds the bun-compiled binary into $BIN_DIR, codesigns it on
# macOS when codesign is available, then delegates to `"$BIN_DIR/yaco" install
# "$@"` for the rest of the work (hooks, wrapper, symlinks, registry, doctor).
#
# Acceptance contract: this file MUST NOT contain a bare `yaco install` line —
# the delegation is by absolute path so a stale PATH cannot accidentally hit a
# legacy binary.
set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${YACO_BIN_DIR:-$HOME/.local/bin}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "install: required command not found: $1" >&2
    exit 2
  fi
}

require bun

mkdir -p "$BIN_DIR"
echo "yaco bootstrap"
echo "  repo root: $REPO_ROOT"
echo "  bin dir:   $BIN_DIR"
echo "  building $BIN_DIR/yaco ..."

(cd "$REPO_ROOT" && bun build cli/src/main.ts --compile --outfile "$BIN_DIR/yaco")
chmod +x "$BIN_DIR/yaco"

case "$(uname -s)" in
  Darwin)
    if command -v codesign >/dev/null 2>&1; then
      codesign --force --sign - "$BIN_DIR/yaco"
    fi
    ;;
esac

# REPO_ROOT and BIN_DIR must survive the exec into `yaco install` — the child
# CLI defaults repoRoot to YACO_REPO_ROOT (falling back to cwd) and the hook
# command resolver in lib/core/agent/lifecycle reads YACO_BIN_DIR to write the
# canonical `<BIN_DIR>/yaco agent hook-event <Event>` form into provider
# configs. Without these envs, an install.sh invoked from /tmp would install
# /tmp into projects.json and write hook commands pointing at a fallback path.
exec env \
  YACO_REPO_ROOT="$REPO_ROOT" \
  YACO_BIN_DIR="$BIN_DIR" \
  "$BIN_DIR/yaco" install "$@"
