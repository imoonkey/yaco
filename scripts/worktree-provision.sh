#!/usr/bin/env bash
# Worktree provisioning — runs (cwd = worktree root) when `yaco worktree create`
# makes a fresh worktree. npm workspaces hoist node_modules to the repo root, and
# a git worktree does NOT copy the (gitignored) node_modules, so vitest/playwright
# can't run. Symlink the dependency trees from the main checkout.
#
# Port isolation for dev/e2e is handled in code, not here: app/ui/e2ePorts.ts
# derives an isolated UI/API port pair from the worktree path, consumed by
# app/ui/{vite,playwright}.config.ts. So a worktree serves and tests its own code
# without colliding with the main checkout or sibling worktrees.
set -euo pipefail

# Main checkout = the first entry of `git worktree list`.
main="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [ -z "${main:-}" ] || [ "$main" = "$PWD" ]; then
  echo "worktree-provision: could not resolve main checkout; skipping" >&2
  exit 0
fi

for d in . app/ui app/server cli; do
  src="$main/$d/node_modules"
  dst="$d/node_modules"
  if [ -d "$src" ] && [ ! -e "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "worktree-provision: linked $dst -> $src"
  fi
done
