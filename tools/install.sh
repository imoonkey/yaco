#!/usr/bin/env bash
# yaco bootstrap installer.
#
# The ONLY entry point for first-time install or recovery from a missing/broken
# yaco binary. Packs `@yaco/cli` into a tarball, installs that tarball globally
# into $BIN_DIR's prefix, then delegates to `"$BIN_DIR/yaco" install "$@"` for
# the rest of the work (hooks, wrapper, symlinks, registry, doctor).
#
# It installs the tarball rather than linking the checkout on purpose: the
# artifact this exercises is byte-for-byte the one an `npm install -g` user
# gets, so a packaging mistake fails here instead of on their machine.
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

require node
require npm

# The floor is checked before anything is built: the build targets Node 24 and
# the CLI imports `node:sqlite`, so an older Node fails somewhere deep instead of
# saying which Node it wants.
#
# The comparison is the launcher's own, imported rather than restated. A second
# hand-written comparator here is how `24.15.0-rc.1` got admitted by one and
# refused by the other — the shell copy mapped the prerelease patch component to
# NaN and every comparison against NaN is false. `bin/node-floor.mjs` has no
# dependencies and is not built, so it is importable at this point in the
# bootstrap, and `test/unit/node-floor.test.ts` is its table.
# `pathToFileURL`, not the bare path: `import()` reads its argument as a URL, so
# a checkout under a directory containing `#` or `?` would be truncated at that
# character and fail to resolve.
if ! node -e '
  const { pathToFileURL } = require("node:url");
  import(pathToFileURL(process.argv[1]).href).then(({ belowNodeFloor, MINIMUM_NODE }) => {
    if (!belowNodeFloor(process.versions.node)) return;
    process.stderr.write(
      `install: yaco requires Node >= ${MINIMUM_NODE}, found ${process.versions.node}\n`,
    );
    process.exit(1);
  });
' "$REPO_ROOT/cli/bin/node-floor.mjs"; then
  exit 2
fi

# `npm install --global` puts executables in <prefix>/bin and nowhere else, so
# the prefix is the only knob and $BIN_DIR has to be a prefix's bin/. Refusing is
# the point: silently installing to a directory the caller did not ask for is how
# a hook command ends up naming a yaco that is not the one just installed.
if [ "$(basename "$BIN_DIR")" != "bin" ]; then
  echo "install: YACO_BIN_DIR must end in /bin (got $BIN_DIR)." >&2
  echo "install: npm --global installs executables into <prefix>/bin." >&2
  exit 2
fi
PREFIX="$(dirname "$BIN_DIR")"

echo "yaco bootstrap"
echo "  repo root: $REPO_ROOT"
echo "  bin dir:   $BIN_DIR"
echo "  prefix:    $PREFIX"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Packing is also the readiness probe. `prepack` runs a clean build, so a pack
# that succeeds has resolved the whole import graph, emitted both artifacts, and
# written the file list — no cheaper check can claim as much, and every one tried
# here before (a directory existing, a dependency's manifest existing) mistook a
# partially installed tree for a usable one.
#
# What the probe cannot say is *why* it failed, so a source error selects the
# dependency branch too. That is why its log is kept: if the remedial install
# then fails, the install's own error is a red herring and the real cause has to
# survive.
pack() {
  (cd "$REPO_ROOT" && npm pack --workspace @yaco/cli --pack-destination "$stage")
}

# Is this dependency tree one only this script has installed into?
#
# It matters because `npm ci --workspace` prunes every workspace it was not
# asked about, so repairing the wrong tree deletes an app/ install — minutes of
# native compilation — this script has no business touching. Existence of
# `node_modules` cannot answer it: a developer's tree and an interrupted
# bootstrap look identical from outside.
#
# `node_modules/.package-lock.json` is npm's own record of what it installed and
# answers it exactly: this bootstrap installs the `cli` workspace and nothing
# else, so any other workspace key means somebody's wider install is in there.
# An absent or unreadable record means no install ever completed here, which is
# the interrupted first run — the case that most needs repairing. (A developer
# whose *own* full install was interrupted also lands there and gets reduced to
# the cli workspace; their tree was unusable either way and `npm ci` restores
# it.)
#
# A marker file was tried first and does not work: the obvious place for it is
# inside `node_modules`, and npm replaces that directory, so the signal is gone
# by the time it is needed.
tree_is_bootstrap_only() {
  node -e '
    const { readFileSync } = require("node:fs");
    try {
      const record = JSON.parse(readFileSync(process.argv[1], "utf-8"));
      const foreign = Object.keys(record.packages ?? {}).filter(
        (key) => key !== "" && !key.startsWith("node_modules/") && !key.startsWith("cli"),
      );
      process.exit(foreign.length === 0 ? 0 : 1);
    } catch {
      process.exit(0);
    }
  ' "$REPO_ROOT/node_modules/.package-lock.json"
}

probe_log="$stage/pack.log"
if ! pack >/dev/null 2>"$probe_log"; then
  if ! tree_is_bootstrap_only; then
    echo "install: the cli build failed, and $REPO_ROOT/node_modules holds an install" >&2
    echo "install: wider than this bootstrap's — repairing it would prune the rest." >&2
    echo "install: run \`npm ci\` in $REPO_ROOT and retry." >&2
    cat "$probe_log" >&2
    exit 1
  fi
  # Either a clone that has never been installed — the README's first-run case —
  # or one of this script's own installs that did not finish. Only the CLI's own
  # workspace: the app's native dependencies take minutes to compile and
  # `--cli-only` exists precisely to skip them.
  echo "  installing cli dependencies ..."
  if ! (cd "$REPO_ROOT" && npm ci --workspace cli --include-workspace-root --omit=optional); then
    echo "install: could not install the cli dependencies." >&2
    echo "install: the build failure that asked for them was:" >&2
    cat "$probe_log" >&2
    exit 1
  fi
  pack
fi

# `find`, not a glob: under `set -o pipefail` an unmatched `ls "$stage"/*.tgz`
# fails the assignment and `set -e` exits before the check below can say
# anything useful. find prints nothing and succeeds, so the check is reachable.
tarball="$(find "$stage" -maxdepth 1 -name '*.tgz' | head -1)"
if [ -z "$tarball" ]; then
  echo "install: npm pack reported success but produced no tarball" >&2
  exit 1
fi

echo "  installing $tarball into $PREFIX ..."
mkdir -p "$PREFIX"
npm install --global --prefix "$PREFIX" "$tarball"

# REPO_ROOT and BIN_DIR must survive the exec into `yaco install` — the child
# CLI defaults repoRoot to YACO_REPO_ROOT (falling back to cwd) and the hook
# command resolver in lib/core/agent/lifecycle reads YACO_BIN_DIR to write the
# canonical `<BIN_DIR>/yaco agent hook-event <Event>` form into provider
# configs. Without these envs, an install.sh invoked from /tmp would install
# /tmp into projects.json, and the hook command would name whatever `yaco` was
# already on PATH — a previous install — rather than the one just put in place.
# `exec` replaces this process, so the EXIT trap will not fire — clear the stage
# by hand or every install leaks a temp directory holding a tarball.
rm -rf "$stage"
trap - EXIT

exec env \
  YACO_REPO_ROOT="$REPO_ROOT" \
  YACO_BIN_DIR="$BIN_DIR" \
  "$BIN_DIR/yaco" install "$@"
