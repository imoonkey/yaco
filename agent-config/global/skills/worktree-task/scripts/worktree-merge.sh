#!/bin/bash
set -euo pipefail

# Usage: worktree-merge.sh <repo-path> <slug>
# Rebases task branch on main in the worktree, then merges into main from the main worktree.

if [ $# -lt 2 ]; then
  echo "Usage: $0 <repo-path> <slug>"
  exit 1
fi

REPO="$(cd "$1" && pwd)"
SLUG="$2"
BRANCH="task/$SLUG"
WORKSPACE="$(dirname "$REPO")"
WT_DIR="$WORKSPACE/worktrees/task-$SLUG"

if [ ! -d "$WT_DIR" ]; then
  echo "Error: worktree not found at $WT_DIR"
  exit 1
fi

MAIN_BRANCH=$(git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")

# H3: Check that all checklist items are done
STATE_DIR="$WORKSPACE/worktrees/.state/$SLUG"
CHECKLIST="$STATE_DIR/checklist.json"
if [ -f "$CHECKLIST" ]; then
  NOT_DONE=$(python3 -c "
import json, sys
items = json.load(open('$CHECKLIST'))['items']
not_done = [i for i in items if i['status'] != 'done']
if not_done:
    for i in not_done:
        print(f\"  [{i['status']}] {i['description']}\")
    sys.exit(1)
" 2>/dev/null) || {
    echo "Warning: not all checklist items are done:"
    echo "$NOT_DONE"
    echo ""
    echo "Proceed anyway? The agent should confirm with the human before continuing."
    echo "To force, re-run after marking items done or removing the checklist."
    exit 1
  }
fi

echo "=== Step 1: Rebase task branch on latest $MAIN_BRANCH ==="
cd "$WT_DIR"
git fetch origin "$MAIN_BRANCH"
if ! git rebase "origin/$MAIN_BRANCH"; then
  echo ""
  echo "REBASE CONFLICT — resolve in $WT_DIR, then re-run this script."
  exit 1
fi
echo "Rebase successful."

echo ""
echo "=== Step 2: Merge task branch into $MAIN_BRANCH ==="
cd "$REPO"

# H1: Verify we're on the main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$MAIN_BRANCH" ]; then
  echo "Error: main repo is on '$CURRENT_BRANCH', expected '$MAIN_BRANCH'."
  echo "Switch to $MAIN_BRANCH first: git checkout $MAIN_BRANCH"
  exit 1
fi

# H2: Sync with origin, fail loudly on conflicts
git fetch origin "$MAIN_BRANCH"
if ! git merge "origin/$MAIN_BRANCH" --no-edit; then
  echo "Error: failed to sync local $MAIN_BRANCH with origin. Resolve conflicts first."
  exit 1
fi
if ! git merge "$BRANCH" --no-edit; then
  echo ""
  echo "MERGE CONFLICT on $MAIN_BRANCH — resolve in $REPO or abort with:"
  echo "  git merge --abort"
  exit 1
fi

echo ""
echo "Merge successful. $BRANCH merged into $MAIN_BRANCH."
echo "Run verify to confirm, then push if ready."
