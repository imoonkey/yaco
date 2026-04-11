#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/worktree-lib.sh"

usage() {
  cat <<'EOF'
Usage: worktree-create.sh <slug> [--base <branch>]

Create a git worktree at <repo>/.worktrees/<slug>/ on branch task/<slug>.
Idempotent — reuses existing worktree if already present.
Runs scripts/worktree-provision.sh on first creation if it exists.

Arguments:
  slug              Worktree identifier (lowercase alphanumeric + hyphens)

Options:
  --base <branch>   Base branch to create from (default: main)
  -h, --help        Show this help

Output:
  Prints the worktree path on success (last line of stdout).
EOF
}

slug=""
base_branch="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
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

# --- Idempotent: reuse existing worktree ---
if [[ -d "$worktree_dir" ]]; then
  echo "Worktree exists, reusing: $worktree_dir" >&2
  echo "$worktree_dir"
  exit 0
fi

# --- Create worktree ---
mkdir -p "$repo_root/.worktrees"

if git rev-parse --verify "$branch" &>/dev/null; then
  # Branch exists (e.g. partial cleanup left it behind) — attach worktree to it
  echo "Branch $branch exists, attaching worktree" >&2
  git worktree add "$worktree_dir" "$branch"
else
  # Fresh: create new branch from base
  git worktree add "$worktree_dir" -b "$branch" "$base_branch"
fi

# --- Provision hook (first create only) ---
provision_script="$repo_root/scripts/worktree-provision.sh"
if [[ -x "$provision_script" ]]; then
  echo "Running provision hook: $provision_script" >&2
  (cd "$worktree_dir" && "$provision_script")
fi

echo "Created worktree: $worktree_dir (branch: $branch)" >&2
echo "$worktree_dir"
