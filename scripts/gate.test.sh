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

# artifact_raw <repo> <path> <body> : write an arbitrary artifact body (e.g. one
# carrying NO reviewed_sha line). Guards the temp root like the other writers.
artifact_raw() {
  local repo="$1" path="$2" body="$3"
  in_root "$repo"
  mkdir -p "$repo/$(dirname "$path")"
  printf '%s\n' "$body" >"$repo/$path"
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

# --- F0: review/qa freshness = reviewed_sha..HEAD touches no code (qa: no app/ui) ---

# F0a. THE FOOTGUN FIX — a docs-only commit stacked on reviewed code keeps
# review=pass. The artifact references the CODE sha (not HEAD); the later docs
# commit moves HEAD past it, but reviewed_sha..HEAD touches no code -> still fresh.
# Under the old exact-HEAD-sha rule this false-failed (artifact != HEAD sha).
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
code_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
commit_file "$r" doc/PROGRESS.md "docs: progress on top of reviewed code"
artifact "$r" plan/review_x.md "$code_sha"
expect "docs tail on reviewed code -> review pass (no false-stale)" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# F0b. a code commit lands AFTER the review -> review goes stale (fail). The
# artifact reviewed the first code commit; new code after it is unreviewed.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
code_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
artifact "$r" plan/review_x.md "$code_sha"
commit_file "$r" cli/bar.ts "feat: more code after the review"
commit_file "$r" doc/PROGRESS.md "progress"
expect "code commit after review -> review fail (stale)" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# F0c. reviewed_sha is a valid commit but NOT an ancestor of HEAD (rebased /
# orphaned onto a side branch) -> can't prove it covers HEAD's history -> stale.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
in_root "$r"
orig_branch="$(git -C "$r" rev-parse --abbrev-ref HEAD)"
git -C "$r" checkout -q -b side
commit_file "$r" cli/side.ts "feat: orphaned code"
orphan_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
git -C "$r" checkout -q "$orig_branch"
artifact "$r" plan/review_x.md "$orphan_sha"
commit_file "$r" doc/PROGRESS.md "progress"
expect "reviewed_sha not ancestor of HEAD -> review fail (stale)" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# F0d. a review artifact with NO reviewed_sha line -> freshness cannot be
# established -> not fresh -> review fail.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
commit_file "$r" doc/PROGRESS.md "progress"
artifact_raw "$r" plan/review_x.md "just prose, no machine-readable sha here"
expect "review artifact without reviewed_sha -> review fail" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# F0e. multiple review artifacts: one stale, one fresh -> ANY fresh one passes.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
old_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
commit_file "$r" cli/bar.ts "feat: more code"
new_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_old.md "$old_sha"   # stale: cli/bar.ts landed after it
artifact "$r" plan/review_new.md "$new_sha"   # fresh: no code since
expect "multiple reviews, any fresh -> review pass" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# F0f. qa keys on app/ui, review on all code roots: a cli/ commit after the
# artifacts makes review stale (code touched) but qa still fresh (no app/ui).
# Exercises that the two freshness checks use DIFFERENT touch predicates.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" app/ui/x.ts "feat: ui"
ui_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
artifact "$r" plan/review_x.md "$ui_sha"
artifact "$r" plan/qa_x.md "$ui_sha"
commit_file "$r" cli/foo.ts "feat: cli code, not app/ui"
commit_file "$r" doc/PROGRESS.md "progress"
expect "cli commit after artifacts -> review stale, qa fresh" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"pass"}' 1

# F0g. full-length (40-char) reviewed_sha is parsed too (artifacts may carry the
# long form). Fresh through a docs tail.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
long_sha="$(git -C "$r" rev-parse HEAD)"
commit_file "$r" doc/PROGRESS.md "progress"
artifact "$r" plan/review_x.md "$long_sha"
expect "40-char reviewed_sha parsed -> review pass" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# F0h. the verdict-line inline form `reviewed_sha=<sha>` (T7 format, amid the
# unresolved_* counts) is parsed. Fresh through a docs tail.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
code_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
commit_file "$r" doc/PROGRESS.md "progress"
artifact_raw "$r" plan/review_x.md \
  "VERDICT: pass  unresolved_critical=0  unresolved_high=0  reviewed_sha=$code_sha"
expect "inline reviewed_sha= verdict form parsed -> review pass" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# F0i. markdown-bold + backtick-wrapped marker (`**reviewed_sha:** ` + backticks)
# is parsed — the real header style.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
code_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
commit_file "$r" doc/PROGRESS.md "progress"
artifact_raw "$r" plan/review_x.md "- **reviewed_sha:** \`$code_sha\` — frozen there"
expect "markdown/backtick reviewed_sha form parsed -> review pass" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"pass","qa":"skip"}' 0

# F0j. a `reviewed_sha` SUBSTRING inside another identifier (`unreviewed_sha:`)
# must NOT be read as the field — otherwise a fresh-looking sha on a non-field
# line forges freshness. No real reviewed_sha field -> not fresh -> review fail.
r="$(mk 0)"; b="$(head_sha "$r")"
commit_file "$r" cli/foo.ts "feat: code"
code_sha="$(git -C "$r" rev-parse --short=7 HEAD)"
artifact_raw "$r" plan/review_x.md "unreviewed_sha: $code_sha (not a real field)"
commit_file "$r" doc/PROGRESS.md "progress"
expect "reviewed_sha substring (unreviewed_sha) not parsed -> review fail" "$r" "$b" \
  '{"verify":"pass","doc":"pass","review":"fail","qa":"skip"}' 1

# 9. invalid base sha -> hard error exit 2 (must not masquerade as empty diff)
r="$(mk 0)"
expect_exit "invalid base -> exit 2" "$r" "nonexistent" 2

echo
echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
