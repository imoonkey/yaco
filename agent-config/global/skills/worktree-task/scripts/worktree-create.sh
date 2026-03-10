#!/bin/bash
set -euo pipefail

# Usage: worktree-create.sh <repo-path> <slug>
# Creates a worktree + branch + .state directory with manifest.json

if [ $# -lt 2 ]; then
  echo "Usage: $0 <repo-path> <slug>"
  exit 1
fi

REPO="$(cd "$1" && pwd)"
SLUG="$2"

# Validate slug format
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Error: slug must be lowercase alphanumeric with hyphens (got: '$SLUG')"
  exit 1
fi

BRANCH="task/$SLUG"
WORKSPACE="$(dirname "$REPO")"
WT_DIR="$WORKSPACE/worktrees/task-$SLUG"
STATE_DIR="$WORKSPACE/worktrees/.state/$SLUG"

if [ -d "$WT_DIR" ]; then
  echo "Error: worktree already exists at $WT_DIR"
  exit 1
fi

# Check if branch already exists
if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Error: branch '$BRANCH' already exists. Clean up first or use a different slug."
  exit 1
fi

# Create worktree with new branch from main
cd "$REPO"
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
git worktree add -b "$BRANCH" "$WT_DIR" "$MAIN_BRANCH"

# Create state directory + manifest
mkdir -p "$STATE_DIR"
cat > "$STATE_DIR/manifest.json" <<EOF
{
  "slug": "$SLUG",
  "branch": "$BRANCH",
  "worktree_path": "$WT_DIR",
  "state_path": "$STATE_DIR",
  "repo_path": "$REPO",
  "verify_command": "",
  "initialized": false,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "Created worktree: $WT_DIR"
echo "Branch: $BRANCH"
echo "State: $STATE_DIR"
echo ""
echo "Next: cd $WT_DIR and initialize the task"
