#!/usr/bin/env bash
# import-agent-config.sh - one-time importer for the agent-config repo into the
# monorepo at agent-config/. Throwaway clone, git-filter-repo, merge with
# --allow-unrelated-histories. See projects/active/yaco-monorepo/final/cn/design.md
# and projects/active/yaco-monorepo/mono-freeze-audit.md.
#
# Idempotent only in the sense that re-running after a successful merge is a
# no-op for the merge step (the commit is already there); the throwaway clone
# is recreated each run.
set -euo pipefail

SRC="${AGENT_CONFIG_SRC:-$HOME/ld-workspace/agent-config}"
MONO_ROOT="${MONO_ROOT:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
WORK="${WORK_DIR:-/tmp/agent-config-filter}"
SUBDIR="agent-config"
REF="${AGENT_CONFIG_REF:-pre-monorepo-final}"
REMOTE="agent-config-src"
IMPORT_BRANCH="import-agent-config-filtered"

echo "[import-agent-config] src=$SRC mono=$MONO_ROOT work=$WORK ref=$REF"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "[import-agent-config] ERROR: git-filter-repo not on PATH" >&2
  exit 1
fi

# Pre-flight: source repo and tag exist.
git -C "$SRC" rev-parse --verify "$REF" >/dev/null

# Pre-flight: target subdir not already imported.
if [ -e "$MONO_ROOT/$SUBDIR" ]; then
  echo "[import-agent-config] ERROR: $MONO_ROOT/$SUBDIR already exists; aborting." >&2
  exit 1
fi

# Fresh throwaway clone (filter-repo demands a fresh clone).
rm -rf "$WORK"
git clone --no-local "$SRC" "$WORK"
git -C "$WORK" checkout -B "$IMPORT_BRANCH" "$REF"

# Per mono-freeze-audit section 4 decision: REMOVE stale .gitmodules before importing.
# We do this inside the throwaway clone so the source repo stays untouched.
if [ -f "$WORK/.gitmodules" ]; then
  git -C "$WORK" rm -f .gitmodules
  git -C "$WORK" commit -m "chore: drop stale last30days submodule declaration"
fi

# Move all history into agent-config/ subdir.
git -C "$WORK" filter-repo --force --to-subdirectory-filter "$SUBDIR"

# Merge into the monorepo.
git -C "$MONO_ROOT" remote remove "$REMOTE" 2>/dev/null || true
git -C "$MONO_ROOT" remote add "$REMOTE" "$WORK"
git -C "$MONO_ROOT" fetch "$REMOTE"

git -C "$MONO_ROOT" merge --allow-unrelated-histories \
  -m "merge: import agent-config into agent-config/" \
  "$REMOTE/$IMPORT_BRANCH"

git -C "$MONO_ROOT" remote remove "$REMOTE"

echo "[import-agent-config] done."
