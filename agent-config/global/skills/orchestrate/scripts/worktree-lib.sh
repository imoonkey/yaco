#!/usr/bin/env bash
# Shared utilities for worktree lifecycle scripts.
# Source this file — do not execute directly.

# Resolve primary repo root from any cwd (primary checkout or linked worktree).
# Uses git-common-dir which always points to the main .git directory.
resolve_repo_root() {
  local git_common_dir
  git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || { echo "Error: not in a git repository" >&2; return 1; }
  # git-common-dir returns <repo>/.git in both primary and worktree contexts
  echo "${git_common_dir%/.git}"
}

# Validate slug format: lowercase alphanumeric and hyphens, no leading/trailing hyphen.
validate_slug() {
  local slug="$1"
  if [[ ! "$slug" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
    echo "Error: invalid slug '$slug' — use lowercase alphanumeric and hyphens, no leading/trailing hyphen" >&2
    return 1
  fi
}
