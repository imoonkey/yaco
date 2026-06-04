#!/usr/bin/env bash
# import-multmux.sh - one-time importer for the multmux repo into the monorepo
# at multmux/. Throwaway clone, git-filter-repo, merge with
# --allow-unrelated-histories. See projects/active/yaco-monorepo/final/cn/design.md
# and projects/active/yaco-monorepo/mono-freeze-audit.md.
#
# Idempotent only in the sense that re-running after a successful merge is a
# no-op for the merge step (the commit is already there); the throwaway clone
# is recreated each run.
#
# v1 keeps multmux Bun-based. Do NOT add multmux to npm workspaces here.
set -euo pipefail

SRC="${MULTMUX_SRC:-$HOME/ld-workspace/multmux}"
MONO_ROOT="${MONO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
WORK="${WORK_DIR:-/tmp/multmux-filter}"
SUBDIR="multmux"
REF="${MULTMUX_REF:-pre-monorepo-final}"
REMOTE="multmux-src"
IMPORT_BRANCH="import-multmux-filtered"

echo "[import-multmux] src=$SRC mono=$MONO_ROOT work=$WORK ref=$REF"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "[import-multmux] ERROR: git-filter-repo not on PATH" >&2
  exit 1
fi

# Pre-flight: source repo and tag exist.
git -C "$SRC" rev-parse --verify "$REF" >/dev/null

# Pre-flight: target subdir not already imported.
if [ -e "$MONO_ROOT/$SUBDIR" ]; then
  echo "[import-multmux] ERROR: $MONO_ROOT/$SUBDIR already exists; aborting." >&2
  exit 1
fi

# Fresh throwaway clone (filter-repo demands a fresh clone).
# --no-local copies the committed history only; dirty worktree files
# (e.g. projects/progress.json) and untracked/ignored files
# (e.g. compiled multmux binary, node_modules) are NOT carried over.
rm -rf "$WORK"
git clone --no-local "$SRC" "$WORK"
git -C "$WORK" checkout -B "$IMPORT_BRANCH" "$REF"

# Move all history into multmux/ subdir.
git -C "$WORK" filter-repo --force --to-subdirectory-filter "$SUBDIR"

# Merge into the monorepo.
git -C "$MONO_ROOT" remote remove "$REMOTE" 2>/dev/null || true
git -C "$MONO_ROOT" remote add "$REMOTE" "$WORK"
git -C "$MONO_ROOT" fetch "$REMOTE"

git -C "$MONO_ROOT" merge --allow-unrelated-histories \
  -m "merge: import multmux into multmux/" \
  "$REMOTE/$IMPORT_BRANCH"

git -C "$MONO_ROOT" remote remove "$REMOTE"

echo "[import-multmux] done."
