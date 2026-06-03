#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/worktree-lib.sh"

usage() {
  cat <<'EOF'
Usage: worktree-merge.sh <slug> [--mode pr|local] [--base <branch>]

Merge worktree branch task/<slug> back to base branch.

Modes:
  pr      (default) Push branch and create PR via gh CLI
  local   Rebase onto base, then fast-forward merge in primary checkout

Arguments:
  slug              Worktree identifier

Options:
  --mode <pr|local> Merge strategy (default: pr)
  --base <branch>   Target branch (default: main)
  -h, --help        Show this help
EOF
}

slug=""
mode="pr"
base_branch="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --mode) mode="${2:?--mode requires pr or local}"; shift 2 ;;
    --base) base_branch="${2:?--base requires a branch name}"; shift 2 ;;
    -*) echo "Error: unknown option: $1" >&2; usage >&2; exit 1 ;;
    *) [[ -z "$slug" ]] && slug="$1" || { echo "Error: unexpected argument: $1" >&2; exit 1; }; shift ;;
  esac
done

[[ -n "$slug" ]] || { echo "Error: slug required" >&2; usage >&2; exit 1; }
validate_slug "$slug"

repo_root="$(resolve_repo_root)"
worktree_dir="$repo_root/.worktrees/$slug"
branch="task/$slug"

[[ -d "$worktree_dir" ]] || { echo "Error: worktree not found: $worktree_dir" >&2; exit 1; }

# Reject dirty worktree
if [[ -n "$(git -C "$worktree_dir" status --porcelain)" ]]; then
  echo "Error: worktree has uncommitted changes — commit or stash first" >&2
  git -C "$worktree_dir" status --short >&2
  exit 1
fi

case "$mode" in
  pr)
    echo "Pushing $branch to origin..." >&2
    git -C "$worktree_dir" push -u origin "$branch"
    echo "Creating PR: $branch → $base_branch" >&2
    gh pr create -R "$(git -C "$repo_root" remote get-url origin | sed -E 's|.*github\.com[:/]||;s|\.git$||')" \
      --base "$base_branch" --head "$branch" --fill
    ;;
  local)
    # Verify primary checkout is clean
    if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
      echo "Error: primary checkout has uncommitted changes — commit or stash first" >&2
      git -C "$repo_root" status --short >&2
      exit 1
    fi
    echo "Rebasing $branch onto $base_branch..." >&2
    git -C "$worktree_dir" rebase "$base_branch"
    echo "Checking out $base_branch in primary..." >&2
    git -C "$repo_root" checkout "$base_branch"
    # Pull if remote tracking exists
    if git -C "$repo_root" rev-parse --abbrev-ref "@{upstream}" &>/dev/null; then
      git -C "$repo_root" pull --ff-only
    fi
    echo "Merging $branch into $base_branch (fast-forward only)..." >&2
    git -C "$repo_root" merge --ff-only "$branch"
    ;;
  *)
    echo "Error: unknown mode '$mode' — use 'pr' or 'local'" >&2
    exit 1
    ;;
esac

echo "Merge complete ($mode mode)" >&2
