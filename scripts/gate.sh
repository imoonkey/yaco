#!/usr/bin/env bash
# scripts/gate.sh <base-sha> — floor-from-diff aggregator.
#
# Computes `git diff <base>..HEAD --name-only` itself, maps the touched paths to
# the checks they owe, runs every owed check, and reports all of them. The check
# set is derived from the diff, not declared — the agent cannot dodge a gate by
# misclassifying its work (design.md §6.1, "floor from the diff").
#
#   touches code (src|cli|app|tools)/  -> verify (run scripts/verify.sh) + review
#   touches app/ui/              -> qa
#   any change at all            -> doc
#   nothing                      -> every check skips
#
# Evidence checks are existence + freshness in v1 (verdict/severity parsing is v3):
#   doc    : a doc/** or PROGRESS.md change, or a `docs:` commit since <base>
#   review : a plan/ *review* file whose reviewed_sha..HEAD touches no code root
#            (^(src|cli|app)/) — the review lands AFTER the last code change.
#   qa     : a plan/ *qa* file whose reviewed_sha..HEAD touches no app/ui/.
# Freshness reads reviewed_sha FROM the artifact (not the live HEAD sha), so a
# docs/plan-only commit stacked on reviewed code keeps the review valid (no
# docs-tail false-stale); a code commit after the review correctly goes stale.
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
# --no-renames so a rename exposes BOTH paths: `git mv cli/x.ts plan/x.md` must
# not hide the code source (rename detection reports only the destination),
# which would let relocated code skip the verify/review floor.
diff_files="$(git diff "$base"..HEAD --name-only --no-renames)"

# Code-touch predicates — ONE definition, reused by both the floor mapping below
# and the review/qa freshness check (a review is fresh iff no code path changed
# since its reviewed_sha; qa keys on app/ui only). Keep these the single source of
# truth for "what counts as code" so the floor and freshness can never diverge.
code_roots_re='^(src|cli|app|tools)/'
ui_root_re='^app/ui/'

# --- floor from the diff -----------------------------------------------------
touched_any=0
touched_code=0
touched_ui=0
[ -n "$diff_files" ] && touched_any=1
grep -qE "$code_roots_re" <<<"$diff_files" && touched_code=1
grep -qE "$ui_root_re" <<<"$diff_files" && touched_ui=1

# A diff confined to the documentation trees — doc/ and plan/ (design docs,
# task graphs) — is its own doc-sync: no separate code change is left to record,
# so a design doc committed without a `docs:` prefix must not false-fail the doc
# check. Scoped to those trees on purpose: a bare *.md match would admit
# behavior-bearing markdown (agent-config skill prompts, CLAUDE.md/AGENTS.md),
# which must still owe doc evidence. Any path outside doc//plan/ flips this off.
doc_only=0
if [ "$touched_any" = 1 ] && [ "$touched_code" = 0 ] && [ "$touched_ui" = 0 ] \
  && ! grep -qvE '^(doc|plan)/' <<<"$diff_files"; then
  doc_only=1
fi

# extract_reviewed_sha <file> : print the first sha following a `reviewed_sha`
# field marker. The `(^|[^a-z0-9_])` boundary means a substring inside another
# identifier (e.g. `unreviewed_sha:`) is NOT mistaken for the field; `[:=]` is the
# required separator (`reviewed_sha:` header or `reviewed_sha=` verdict-line form);
# `[^0-9a-f]*` then eats any markdown/backticks/space up to the sha (7-40 hex, so
# both short and full forms parse). Empty output when no real reviewed_sha field
# is present — freshness can't be established, so the caller treats it as not fresh.
extract_reviewed_sha() {
  grep -oiE '(^|[^a-z0-9_])reviewed_sha[:=][^0-9a-f]*[0-9a-f]{7,40}' "$1" 2>/dev/null \
    | grep -oiE '[0-9a-f]{7,40}' | head -1
}

# artifact_is_fresh <touch-regex> <iname-glob> : true if SOME plan/ artifact
# matching the glob carries a reviewed_sha whose `reviewed_sha..HEAD` diff
# (--no-renames) touches no path matching <touch-regex>. The sha must be a known
# commit AND an ancestor of HEAD — a missing, unknown, or rebased/orphaned sha
# can't prove the review covers HEAD's history, so it is stale. Any one fresh
# artifact passes the check.
artifact_is_fresh() {
  local touch_re="$1" glob="$2" f sha changed
  while IFS= read -r f; do
    sha="$(extract_reviewed_sha "$f")"
    [ -n "$sha" ] || continue
    git rev-parse --verify --quiet "$sha^{commit}" >/dev/null 2>&1 || continue
    git merge-base --is-ancestor "$sha" HEAD 2>/dev/null || continue
    changed="$(git diff "$sha"..HEAD --name-only --no-renames)"
    grep -qE "$touch_re" <<<"$changed" && continue
    return 0
  done < <(find plan -type f -iname "$glob" 2>/dev/null)
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
  if [ "$doc_only" = 1 ] \
    || grep -qE 'PROGRESS\.md$|^doc/' <<<"$diff_files" \
    || grep -qE '^docs(\(.+\))?:' <<<"$doc_subjects"; then
    doc=pass
  else
    doc=fail
    failed=1
  fi
fi

if [ "$touched_code" = 1 ]; then
  if artifact_is_fresh "$code_roots_re" '*review*'; then review=pass; else review=fail; failed=1; fi
fi

if [ "$touched_ui" = 1 ]; then
  if artifact_is_fresh "$ui_root_re" '*qa*'; then qa=pass; else qa=fail; failed=1; fi
fi

echo "gate: verify=$verify doc=$doc review=$review qa=$qa (base=$base head=$head_sha)" >&2
printf '{"verify":"%s","doc":"%s","review":"%s","qa":"%s"}\n' "$verify" "$doc" "$review" "$qa"

[ "$failed" = 0 ]
