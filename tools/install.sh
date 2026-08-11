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

# The CLI has runtime dependencies and the build resolves them from
# node_modules, so a clone that has never been installed cannot build. Neither
# clone shape can install them in place: run inside cli/ and Bun discovers the
# monorepo workspace root, then tries to migrate the npm lockfile and dies under
# --frozen-lockfile; the published subset has no root to discover at all. An
# isolated copy of the CLI's own manifest is the one thing that behaves
# identically in both, so install there and copy the result in.
#
# Readiness is decided by the bundler, not by inspecting node_modules. It is the
# same resolution the compile below performs, over the whole import graph, so it
# is the only signal that cannot mistake a partially installed or damaged
# package — or a missing transitive dependency — for a usable one. Every cheaper
# check tried here (a directory existing, then a dependency's own manifest
# existing) did exactly that. A non-dependency build error trips it too; the
# install that follows is harmless and the compile then reports the real failure.
if ! (cd "$REPO_ROOT" && bun build --target=bun cli/src/main.ts) >/dev/null 2>&1; then
  echo "  installing cli dependencies ..."
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  cp "$REPO_ROOT/cli/package.json" "$REPO_ROOT/cli/bun.lock" "$stage/"
  (cd "$stage" && bun install --production --frozen-lockfile)
  # Copy rather than replace: node_modules may already hold something this
  # bootstrap did not put there and has no business deleting.
  mkdir -p "$REPO_ROOT/cli/node_modules"
  cp -R "$stage/node_modules/." "$REPO_ROOT/cli/node_modules/"
  rm -rf "$stage"
  trap - EXIT
fi

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
