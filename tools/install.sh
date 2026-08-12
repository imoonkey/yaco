#!/usr/bin/env bash
# yaco bootstrap installer.
#
# The ONLY entry point for first-time install or recovery from a missing/broken
# yaco binary. Packs `yaco-cli` into a tarball, installs that tarball globally
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
  # Selected by workspace DIRECTORY, not by package name: this is the only line
  # in the bootstrap that would otherwise have to be edited when the published
  # name changes, and `cli/` is what it actually means.
  (cd "$REPO_ROOT" && npm pack --workspace cli --pack-destination "$stage")
}

# Install the CLI workspace's dependencies **without deleting anything**.
#
# `npm ci --workspace cli` prunes every workspace it was not asked about, so run
# straight at the repo it would take out an app/ install — minutes of native
# compilation — that this script has no business touching. Deciding when that is
# safe turned out to be the wrong question: every signal tried (the directory
# existing, a marker file inside it, npm's own hidden lock) either cannot
# survive the operation it describes or fails open when it is missing, and
# "absence of evidence" must never authorize a destructive repair.
#
# So the repair is not destructive. npm resolves from the manifests and the
# lockfile, nothing else, so an isolated copy of those produces the same tree in
# a directory that is entirely ours to prune — and the result is *copied in*,
# never swapped for what is already there. This is the same non-destructive
# shape the Bun-era bootstrap used, which had the identical problem.
#
# The hidden lock is deliberately not copied: the merged tree is not the one
# either record describes, and an absent one makes npm verify rather than trust
# on the next install.
install_cli_dependencies() {
  echo "  installing cli dependencies ..."
  local deps="$stage/deps"
  mkdir -p "$deps"

  # Every manifest npm needs to build the workspace tree: the root, its lockfile,
  # and each workspace member's package.json (npm reads the `workspaces` globs
  # and fails on a member it cannot find, even one it is not installing).
  cp "$REPO_ROOT/package-lock.json" "$deps/"
  # The root manifest, minus its scripts. The stage exists to resolve
  # dependencies and nothing else, and the repo's own `postinstall` reaches for
  # `app/scripts/` — files a dependency stage has no reason to carry. Each
  # dependency's own install scripts still run, which is what makes the copied
  # tree usable.
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf-8"));
    delete manifest.scripts;
    writeFileSync(process.argv[2], JSON.stringify(manifest));
  ' "$REPO_ROOT/package.json" "$deps/package.json"
  [ -f "$REPO_ROOT/.npmrc" ] && cp "$REPO_ROOT/.npmrc" "$deps/"
  while IFS= read -r manifest; do
    local relative="${manifest#"$REPO_ROOT"/}"
    mkdir -p "$deps/$(dirname "$relative")"
    cp "$manifest" "$deps/$relative"
  done < <(find "$REPO_ROOT" -maxdepth 3 -name package.json -not -path '*/node_modules/*' -not -path "$REPO_ROOT/package.json")

  (cd "$deps" && npm ci --workspace cli --include-workspace-root --omit=optional) || return 1

  # Copy, never replace: node_modules may already hold something this bootstrap
  # did not put there. The `.bin` entries and the workspace self-links npm writes
  # are relative, so they resolve correctly against the real tree once moved.
  mkdir -p "$REPO_ROOT/node_modules"
  cp -R "$deps/node_modules/." "$REPO_ROOT/node_modules/"
  # Neither record describes the merged tree — the staged one omits whatever was
  # already in the destination, and the destination's predates the copy — so
  # both go. An absent hidden lock makes the next npm operation verify the tree
  # instead of trusting metadata written for a different one.
  rm -f "$deps/node_modules/.package-lock.json" "$REPO_ROOT/node_modules/.package-lock.json"
}

probe_log="$stage/pack.log"
if ! pack >/dev/null 2>"$probe_log"; then
  if ! install_cli_dependencies; then
    echo "install: could not install the cli dependencies." >&2
    echo "install: the build failure that asked for them was:" >&2
    cat "$probe_log" >&2
    exit 1
  fi
  pack
fi

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
