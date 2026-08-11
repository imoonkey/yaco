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
# Shared by the readiness probe and the compile, so the probe can never resolve
# a different graph than the build it is standing in for.
BUILD_ENTRY="cli/src/main.ts"
BUILD_TARGET="bun"

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
# node_modules, so a clone that has never been installed cannot build. One
# mechanism has to serve both clone shapes, and installing in place is not it:
# inside a full clone's cli/, Bun walks up to the monorepo workspace root, tries
# to migrate the npm lockfile, and dies under --frozen-lockfile. Installing from
# an isolated copy of the CLI's own manifest has no root to walk up to, so it
# behaves the same in a full clone and in the published subset (which could also
# install in place, but would then need a second code path).
#
# Readiness is decided by the bundler, not by inspecting node_modules: the probe
# and the compile below share an entry point and a target, so the probe performs
# the compile's own resolution over the whole import graph. That makes it the
# only signal that cannot mistake a partially installed or damaged package — or
# a missing transitive dependency — for a usable one. Every cheaper check tried
# here (a directory existing, then a dependency's own manifest existing) did
# exactly that.
#
# What the probe cannot do is say *why* the bundle failed, so a source error
# selects this branch too. Its diagnostic is therefore kept: if the remedial
# install then fails — an offline machine is enough — the install's own error
# would otherwise be the only thing reported, and it is a red herring.
probe_log="$(mktemp)"
trap 'rm -f "$probe_log"' EXIT
if ! (cd "$REPO_ROOT" && bun build --target="$BUILD_TARGET" "$BUILD_ENTRY") >/dev/null 2>"$probe_log"; then
  echo "  installing cli dependencies ..."
  stage="$(mktemp -d)"
  trap 'rm -f "$probe_log"; rm -rf "$stage"' EXIT
  cp "$REPO_ROOT/cli/package.json" "$REPO_ROOT/cli/bun.lock" "$stage/"
  if ! (cd "$stage" && bun install --production --frozen-lockfile); then
    echo "install: could not install the cli dependencies." >&2
    echo "install: the build failure that asked for them was:" >&2
    cat "$probe_log" >&2
    exit 1
  fi
  # Copy rather than replace: node_modules may already hold something this
  # bootstrap did not put there and has no business deleting.
  mkdir -p "$REPO_ROOT/cli/node_modules"
  cp -R "$stage/node_modules/." "$REPO_ROOT/cli/node_modules/"
  rm -rf "$stage"
fi
rm -f "$probe_log"
trap - EXIT

echo "  building $BIN_DIR/yaco ..."

(cd "$REPO_ROOT" && bun build --target="$BUILD_TARGET" "$BUILD_ENTRY" --compile --outfile "$BIN_DIR/yaco")
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
