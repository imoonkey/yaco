#!/bin/bash
set -euo pipefail

# Usage: worktree-cleanup.sh <repo-path> <slug> [--purge-state]
# Removes worktree + branch. Preserves .state/ by default.

if [ $# -lt 2 ]; then
  echo "Usage: $0 <repo-path> <slug> [--purge-state]"
  exit 1
fi

REPO="$(cd "$1" && pwd)"
SLUG="$2"
BRANCH="task/$SLUG"
WORKSPACE="$(dirname "$REPO")"
WT_DIR="$WORKSPACE/worktrees/task-$SLUG"
STATE_DIR="$WORKSPACE/worktrees/.state/$SLUG"
PURGE_STATE=false

if [ "${3:-}" = "--purge-state" ]; then
  PURGE_STATE=true
fi

cd "$REPO"

# Remove worktree (try clean first, then force)
if [ -d "$WT_DIR" ]; then
  git worktree remove "$WT_DIR" 2>/dev/null || {
    echo "Warning: worktree has uncommitted changes, forcing removal"
    git worktree remove "$WT_DIR" --force 2>/dev/null || {
      rm -rf "$WT_DIR"
      git worktree prune
    }
  }
  echo "Removed worktree: $WT_DIR"
else
  echo "Worktree already removed: $WT_DIR"
fi

# Delete branch
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH"
  echo "Deleted branch: $BRANCH"
else
  echo "Branch already deleted: $BRANCH"
fi

# Optionally purge state
if [ "$PURGE_STATE" = true ] && [ -d "$STATE_DIR" ]; then
  rm -rf "$STATE_DIR"
  echo "Purged state: $STATE_DIR"
else
  echo "State preserved: $STATE_DIR"
fi

echo "Cleanup complete."
