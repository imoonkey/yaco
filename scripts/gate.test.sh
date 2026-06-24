#!/usr/bin/env bash
# Hermetic test for scripts/gate.sh — builds throwaway git repos and asserts the
# JSON summary line + exit code across every floor-mapping case. No real build or
# test suite runs: each fixture supplies a stub scripts/verify.sh whose exit code
# the case controls, so the test is fast and isolated from the live repo.
#
# Run: bash scripts/gate.test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate_src="$here/gate.sh"

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
pass=0
fail=0

# mk <verify_rc> : print a fresh repo dir whose stub verify.sh exits <verify_rc>.
# Uses mktemp so each repo is unique without shared counter state (mk runs in a
# command substitution, so a parent-scope counter would not survive the subshell).
mk() {
  local rc="$1" d
  d="$(mktemp -d "$root/repo.XXXXXX")"
  mkdir -p "$d/scripts"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  cp "$gate_src" "$d/scripts/gate.sh"
  printf '#!/usr/bin/env bash\necho "stub verify ran" >&2\nexit %s\n' "$rc" >"$d/scripts/verify.sh"
  chmod +x "$d/scripts/verify.sh"
  echo seed >"$d/README.md"
  git -C "$d" add -A
  git -C "$d" commit -qm seed
  echo "$d"
}

# in_root <path> : abort the entire test unless <path> is under the temp root.
# Hard safety rail — a fixture op must never be able to mutate the real repo,
# no matter how a path computation goes wrong.
in_root() {
  case "$1" in
  "$root"/*) : ;;
  *)
    echo "FATAL test bug: target '$1' is outside test root '$root' — aborting" >&2
    exit 99
    ;;
  esac
}

# commit_file <repo> <path> <msg>
commit_file() {
  local repo="$1" path="$2" msg="$3"
  in_root "$repo"
  mkdir -p "$repo/$(dirname "$path")"
  echo x >>"$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" commit -qm "$msg"
}

# artifact <repo> <path> [sha] : write an evidence file referencing a sha
# (default: current HEAD short sha), uncommitted in the working tree.
artifact() {
  local repo="$1" path="$2" sha="${3:-}"
  in_root "$repo"
  [ -n "$sha" ] || sha="$(git -C "$repo" rev-parse --short=7 HEAD)"
  mkdir -p "$repo/$(dirname "$path")"
  printf 'reviewed_sha: %s\n' "$sha" >"$repo/$path"
}

# expect <label> <repo> <base> <want_json> <want_exit>
expect() {
  local label="$1" repo="$2" base="$3" want_json="$4" want_exit="$5" out rc json
  out="$(cd "$repo" && bash scripts/gate.sh "$base" 2>/dev/null)"
  rc=$?
  json="$(printf '%s\n' "$out" | tail -1)"
  if [ "$json" = "$want_json" ] && [ "$rc" = "$want_exit" ]; then
    echo "ok   - $label"
    pass=$((pass + 1))
  else
    echo "FAIL - $label"
    echo "         want: exit=$want_exit json=$want_json"
    echo "         got:  exit=$rc json=$json"
    fail=$((fail + 1))
  fi
}

# expect_exit <label> <repo> <base> <want_exit> : assert exit code only
expect_exit() {
  local label="$1" repo="$2" base="$3" want_exit="$4" rc
  (cd "$repo" && bash scripts/gate.sh "$base" >/dev/null 2>&1)
  rc=$?
  if [ "$rc" = "$want_exit" ]; then
    echo "ok   - $label"
    pass=$((pass + 1))
  else
    echo "FAIL - $label (want exit=$want_exit got=$rc)"
    fail=$((fail + 1))
  fi
}

head_sha() { git -C "$1" rev-parse HEAD; }

# 1. clean tree (base == HEAD) -> every check skips, exit 0
r="$(mk 0)"
expect "clean -> all skip" "$r" "$(head_sha "$r")" \
  '{"verify":"skip","doc":"skip","review":"skip","qa":"skip"}' 0

# 2. doc-only diff (plan/ markdown), no docs: prefix -> self-documenting: a
# pure-doc change has no separate code to record, so doc passes (was a false fail).
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" plan/foo.md "add plan note"
expect "doc-only plan/ -> doc pass" "$r" "$b" \
  '{"verify":"skip","doc":"pass","review":"skip","qa":"skip"}' 0

# 3. doc/** change -> doc passes by path
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" doc/PROGRESS.md "note progress"
expect "doc path -> doc pass" "$r" "$b" \
  '{"verify":"skip","doc":"pass","review":"skip","qa":"skip"}' 0

# 3b. docs: commit subject (non-doc path) -> doc passes by commit
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" plan/x.md "docs: record decision"
expect "docs: commit -> doc pass" "$r" "$b" \
  '{"verify":"skip","doc":"pass","review":"skip","qa":"skip"}' 0

# 3c. docs: commit amid several non-matching commits (the case that would
# SIGPIPE a `git log | grep -q` pipeline under pipefail) -> still doc pass.
# A non-doc file (tool.cfg) keeps the diff OFF the doc-only path, so the docs:
# subject detection is what passes the doc check (preserving that coverage).
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" tool.cfg "chore: zero"
commit_file "$r" plan/a.md "chore: one"
commit_file "$r" plan/b.md "docs: the evidence"
commit_file "$r" plan/c.md "chore: two"
commit_file "$r" plan/d.md "chore: three"
expect "docs: commit amid noise (mixed) -> doc pass" "$r" "$b" \
  '{"verify":"skip","doc":"pass","review":"skip","qa":"skip"}' 0

# 3d. behavior-bearing markdown OUTSIDE the doc/plan trees (an agent-config skill
# prompt) is NOT doc_only — it changes behavior, so it still owes doc evidence
# and must not be auto-passed just for being *.md.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" agent-config/skills/x/SKILL.md "update skill"
expect "behavior .md outside doc trees not doc_only -> doc fail" "$r" "$b" \
  '{"verify":"skip","doc":"fail","review":"skip","qa":"skip"}' 1

# 3e. MIXED non-doc + plan/ diff, no doc/PROGRESS and no docs: commit -> doc
# fail: the doc-only relaxation must NOT leak to a diff with real non-doc work.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" tool.cfg "chore: config change"
commit_file "$r" plan/note.md "add note"
expect "mixed non-doc+plan, no evidence -> doc fail" "$r" "$b" \
  '{"verify":"skip","doc":"fail","review":"skip","qa":"skip"}' 1

# 3f. a code file RENAMED into a doc path must NOT be classified doc_only: git's
# rename detection reports only the destination, hiding the cli/ source. gate.sh
# uses --no-renames so both sides show -> touched_code stays on, verify+review owed.
r="$(mk 0)"
commit_file "$r" cli/foo.ts "feat: code"
b="$(head_sha "$r")"
in_root "$r"
mkdir -p "$r/plan"
git -C "$r" mv cli/foo.ts plan/foo.md
git -C "$r" commit -qm "refactor: relocate"
expect "renamed code->plan is not doc_only -> verify+review owed" "$r" "$b" \
  '{"verify":"pass","doc":"fail","review":"fail","qa":"skip"}' 1

# 4. code + verify pass + doc + review present -> all green, qa skip
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_x.md
expect "code+verify-pass+doc+review -> green" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# 5. code + verify FAIL -> verify fail, non-zero exit
r="$(mk 1)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
expect "code+verify-fail -> verify fail" "$r" "$b" \
  '{"verify":"fail","doc":"fail","review":"fail","qa":"skip"}' 1

# 6. code + verify pass but NO review artifact -> review fail
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
commit_file "$r" doc/PROGRESS.md "progress"
expect "code, no review artifact -> review fail" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# 7. app/ui change with review + qa artifacts -> qa owed and passes
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" app/ui/x.ts "feat: ui"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_x.md
artifact "$r" plan/qa_x.md
expect "app/ui + qa artifact -> qa pass" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"pass"}' 0

# 7b. app/ui change, review present but qa MISSING -> qa fail
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" app/ui/x.ts "feat: ui"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_x.md
expect "app/ui, no qa artifact -> qa fail" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"fail"}' 1

# 8. review artifact referencing a STALE sha -> review fail
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_x.md deadbeef
expect "stale review sha -> review fail" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# 9. invalid base sha -> hard error exit 2 (must not masquerade as empty diff)
r="$(mk 0)"
expect_exit "invalid base -> exit 2" "$r" "nonexistent" 2

echo
echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
