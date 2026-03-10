#!/bin/bash
set -euo pipefail

# Usage: worktree-status.sh <repo-path>
# Lists all active worktrees with checklist progress from .state/

if [ $# -lt 1 ]; then
  echo "Usage: $0 <repo-path>"
  exit 1
fi

REPO="$(cd "$1" && pwd)"
WORKSPACE="$(dirname "$REPO")"
STATE_ROOT="$WORKSPACE/worktrees/.state"

if [ ! -d "$STATE_ROOT" ]; then
  echo "No worktree state found at $STATE_ROOT"
  exit 0
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required for JSON parsing"
  exit 1
fi

echo "Worktree tasks:"
echo ""

for state_dir in "$STATE_ROOT"/*/; do
  [ -d "$state_dir" ] || continue
  slug=$(basename "$state_dir")
  manifest="$state_dir/manifest.json"
  checklist="$state_dir/checklist.json"

  if [ ! -f "$manifest" ]; then
    continue
  fi

  # Single python3 call for all manifest + checklist data
  python3 -c "
import json, os
m = json.load(open('$manifest'))
status = 'active' if os.path.isdir(m.get('worktree_path', '')) else 'removed'
print(f\"  {m['slug']} ({status})\")
print(f\"    Branch: {m['branch']}\")
print(f\"    Initialized: {m['initialized']}\")
if os.path.isfile('$checklist'):
    c = json.load(open('$checklist'))
    items = c.get('items', [])
    total = len(items)
    done = sum(1 for i in items if i['status'] == 'done')
    blocked = sum(1 for i in items if i['status'] == 'blocked')
    print(f'    Progress: {done}/{total} done')
    if blocked:
        print(f'    Blocked: {blocked} items')
print()
" 2>/dev/null || echo "  $slug (error reading state)"

done
