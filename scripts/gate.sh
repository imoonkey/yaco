#!/usr/bin/env bash
# scripts/gate.sh <base-sha> — floor-from-diff aggregator.
#
# Computes `git diff <base>..HEAD --name-only` itself, maps the touched paths to
# the checks they owe, runs every owed check, and reports all of them. The check
# set is derived from the diff, not declared — the agent cannot dodge a gate by
# misclassifying its work (design.md §6.1, "floor from the diff").
#
#   touches code (src|cli|app)/  -> verify (run scripts/verify.sh) + review
#   touches app/ui/              -> qa
#   any change at all            -> doc
#   nothing                      -> every check skips
#
# Evidence checks are existence-only in v1 (verdict/severity parsing is v3):
#   doc    : a doc/** or PROGRESS.md change, or a `docs:` commit since <base>
#   review : a plan/ *review* file referencing the current HEAD sha
#   qa     : a plan/ *qa* file referencing the current HEAD sha
#
# Output discipline: all progress goes to stderr; stdout carries ONLY the final
# JSON line, so `gate.sh <base> | tail -1` is the machine contract. Any check
# == fail -> exit non-zero; otherwise exit 0.
set -uo pipefail

base="${1:-}"
if [ -z "$base" ]; then
  echo "usage: gate.sh <base-sha>" >&2
  exit 2
fi

# Repo root from this script's own location (hardcoded convention, same as
# scripts/worktree-provision.sh) — independent of cwd.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root" || {
  echo "gate: cannot cd to repo root: $repo_root" >&2
  exit 2
}

if ! git rev-parse --verify "$base^{commit}" >/dev/null 2>&1; then
  echo "gate: invalid base sha: $base" >&2
  exit 2
fi

head_sha="$(git rev-parse --short=7 HEAD)"
diff_files="$(git diff "$base"..HEAD --name-only)"

# --- floor from the diff -----------------------------------------------------
touched_any=0
touched_code=0
touched_ui=0
[ -n "$diff_files" ] && touched_any=1
grep -qE '^(src|cli|app)/' <<<"$diff_files" && touched_code=1
grep -qE '^app/ui/' <<<"$diff_files" && touched_ui=1

# artifact_refs_head <iname-glob> : true if some plan/ file matching the glob
# (case-insensitive) contains the current HEAD short sha.
artifact_refs_head() {
  local f
  while IFS= read -r f; do
    grep -qF "$head_sha" "$f" && return 0
  done < <(find plan -type f -iname "$1" 2>/dev/null)
  return 1
}

# --- run every owed check (no short-circuit) ---------------------------------
verify=skip
doc=skip
review=skip
qa=skip
failed=0

if [ "$touched_code" = 1 ]; then
  echo "gate: verify — running scripts/verify.sh" >&2
  if "$repo_root/scripts/verify.sh" >&2; then verify=pass; else verify=fail; failed=1; fi
fi

if [ "$touched_any" = 1 ]; then
  # Capture commit subjects first, then match a here-string: a `cmd | grep -q`
  # pipeline can SIGPIPE `cmd` when grep exits early, which under pipefail would
  # flip a valid `docs:` commit to a false doc=fail. No pipe -> no flake.
  doc_subjects="$(git log --format='%s' "$base"..HEAD)"
  if grep -qE 'PROGRESS\.md$|^doc/' <<<"$diff_files" \
    || grep -qE '^docs(\(.+\))?:' <<<"$doc_subjects"; then
    doc=pass
  else
    doc=fail
    failed=1
  fi
fi

if [ "$touched_code" = 1 ]; then
  if artifact_refs_head '*review*'; then review=pass; else review=fail; failed=1; fi
fi

if [ "$touched_ui" = 1 ]; then
  if artifact_refs_head '*qa*'; then qa=pass; else qa=fail; failed=1; fi
fi

echo "gate: verify=$verify doc=$doc review=$review qa=$qa (base=$base head=$head_sha)" >&2
printf '{"verify":"%s","doc":"%s","review":"%s","qa":"%s"}\n' "$verify" "$doc" "$review" "$qa"

[ "$failed" = 0 ]
