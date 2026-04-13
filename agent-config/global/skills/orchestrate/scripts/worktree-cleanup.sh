#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/worktree-lib.sh"

usage() {
  cat <<'EOF'
Usage: worktree-cleanup.sh <slug> [--force]

Remove worktree at <repo>/.worktrees/<slug>/ and delete branch task/<slug>.
Conservative: refuses to delete unmerged branches without --force.
Tolerant of partially-cleaned state (missing dir or branch).

Arguments:
  slug              Worktree identifier

Options:
  --force           Force removal even with uncommitted changes or unmerged branch
  -h, --help        Show this help
EOF
}

slug=""
force=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --force) force=true; shift ;;
    -*) echo "Error: unknown option: $1" >&2; usage >&2; exit 1 ;;
    *) [[ -z "$slug" ]] && slug="$1" || { echo "Error: unexpected argument: $1" >&2; exit 1; }; shift ;;
  esac
done

[[ -n "$slug" ]] || { echo "Error: slug required" >&2; usage >&2; exit 1; }
validate_slug "$slug"

repo_root="$(resolve_repo_root)"
worktree_dir="$repo_root/.worktrees/$slug"
branch="task/$slug"

# --- Remove worktree directory ---
if [[ -d "$worktree_dir" ]]; then
  if $force; then
    git worktree remove --force "$worktree_dir"
  else
    git worktree remove "$worktree_dir"
  fi
  echo "Removed worktree: $worktree_dir" >&2
else
  echo "Worktree directory not found, skipping: $worktree_dir" >&2
  # Clean up stale worktree entry if git still tracks it
  git worktree prune 2>/dev/null || true
fi

# --- Delete branch ---
if git rev-parse --verify "$branch" &>/dev/null; then
  if $force; then
    git branch -D "$branch"
  else
    git branch -d "$branch"
  fi
  echo "Deleted branch: $branch" >&2
else
  echo "Branch not found, skipping: $branch" >&2
fi

echo "Cleanup complete: $slug" >&2
