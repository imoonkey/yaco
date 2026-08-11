#!/usr/bin/env bash
# Hermetic test for scripts/worktree-provision.sh — builds a throwaway npm
# workspaces repo under a mktemp root, hand-builds the node_modules layout npm
# would produce (no network, no install), adds a git worktree, runs the real
# provisioning script, and asks the real Node resolver where each import lands.
#
# The property under test is which PHYSICAL file a worktree's import resolves to:
# its own checkout for workspace packages, the main checkout for third-party.
#
# Run: bash scripts/worktree-provision.test.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
provision_src="$here/worktree-provision.sh"

root="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$root"' EXIT
pass=0
fail=0

# in_root <path> : abort the entire test unless <path> is under the temp root.
# Hard safety rail — no fixture op may mutate a real checkout, however a path
# computation goes wrong. This test's subject unlinks node_modules entries.
in_root() {
  case "$1" in
  "$root"/*) : ;;
  *)
    echo "FATAL test bug: target '$1' is outside test root '$root' — aborting" >&2
    exit 99
    ;;
  esac
}

# --------------------------------------------------------------------------
# Fixture
# --------------------------------------------------------------------------

# write <path> <body> : create a file under the temp root, parents included.
write() {
  in_root "$1"
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}

# mk_repo [--no-deps] : print a fresh "main checkout" — an npm workspaces repo
# with the node_modules layout npm builds for it (workspace self-links relative,
# third-party real, `.bin` shims relative), committed to git.
mk_repo() {
  local d
  d="$(mktemp -d "$root/repo.XXXXXX")"
  in_root "$d"

  write "$d/package.json" '{"name":"fx","private":true,"workspaces":["cli","app/server","packages/*"]}'
  write "$d/.gitignore" 'node_modules'
  write "$d/cli/package.json" '{"name":"@fx/cli","version":"1.0.0","bin":{"fx":"./bin/fx.mjs"},"exports":{"./core":{"development":"./src/core.ts","default":"./dist/core.js"}}}'
  write "$d/cli/src/core.ts" 'export const WHO = "cli"'
  write "$d/cli/bin/fx.mjs" 'console.log("fx")'
  # No `exports`, no `main` — an application workspace, like app/server here.
  write "$d/app/server/package.json" '{"name":"@fx/app","version":"1.0.0"}'
  write "$d/app/server/src/index.js" 'export const WHO = "app"'
  # A `main` pointing into an unbuilt dist/, the state of a fresh worktree.
  write "$d/packages/tr/package.json" '{"name":"@fx/tr","version":"1.0.0","main":"./dist/index.js"}'
  write "$d/packages/tr/src/index.ts" 'export const WHO = "tr"'
  mkdir -p "$d/scripts"
  cp "$provision_src" "$d/scripts/worktree-provision.sh"

  if [ "${1:-}" != "--no-deps" ]; then
    mkdir -p "$d/node_modules/@fx" "$d/node_modules/.bin"
    ln -s ../../cli "$d/node_modules/@fx/cli"
    ln -s ../../app/server "$d/node_modules/@fx/app"
    ln -s ../../packages/tr "$d/node_modules/@fx/tr"
    # A third-party package published INTO a workspace's own scope — the mirror
    # descends into @fx, so this one must still come from the main checkout.
    write "$d/node_modules/@fx/vendor/package.json" '{"name":"@fx/vendor","version":"1.0.0","main":"./index.js"}'
    write "$d/node_modules/@fx/vendor/index.js" 'export const WHO = "vendor"'
    # A scope with no workspace member is shared whole.
    write "$d/node_modules/@types/node/package.json" '{"name":"@types/node","version":"1.0.0"}'
    write "$d/node_modules/leftpad/package.json" '{"name":"leftpad","version":"1.0.0","main":"./index.js"}'
    write "$d/node_modules/leftpad/index.js" 'export const WHO = "leftpad"'
    write "$d/node_modules/leftpad/cli.js" 'console.log("leftpad")'
    ln -s ../leftpad/cli.js "$d/node_modules/.bin/leftpad"
    ln -s ../@fx/cli/bin/fx.mjs "$d/node_modules/.bin/fx"
    write "$d/node_modules/.package-lock.json" '{"lockfileVersion":3,"packages":{}}'
    write "$d/node_modules/.vite/deps/marker" 'cache'
    # A dep npm could not hoist, in a workspace's own nested tree.
    write "$d/cli/node_modules/@types/deep/package.json" '{"name":"@types/deep","version":"1.0.0"}'
  fi

  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  git -C "$d" add -A
  git -C "$d" commit -qm seed
  echo "$d"
}

# mk_wt <repo> : print a fresh git worktree of <repo>, NOT yet provisioned.
mk_wt() {
  local repo="$1" wt
  in_root "$repo"
  wt="$(mktemp -d "$repo/wt.XXXXXX")"
  rmdir "$wt"
  git -C "$repo" worktree add -q -b "b$(basename "$wt")" "$wt" >/dev/null 2>&1
  (cd "$wt" && pwd -P)
}

# provision <worktree> [args...] : run the real script the way create.ts does —
# cwd = worktree, worktree path as $1. Prints combined output; returns its code.
provision() {
  local wt="$1"
  shift
  in_root "$wt"
  (cd "$wt" && bash scripts/worktree-provision.sh "${@:-$wt}" 2>&1)
}

# phys <path> : <path> with every symlink component resolved, whether or not the
# leaf exists — a fresh worktree has no `dist/` built, and the answer for an
# unbuilt target must still name the checkout it came from. Written out here
# rather than reused from the subject: a test that borrows the subject's
# canonicalization cannot catch a bug in it.
phys() {
  local p="$1" tail="" up
  while [ ! -e "$p" ]; do
    up="$(dirname "$p")"
    [ "$up" != "$p" ] || break
    tail="/$(basename "$p")$tail"
    p="$up"
  done
  if [ -d "$p" ]; then
    printf '%s%s' "$(cd "$p" && pwd -P)" "$tail"
  else
    printf '%s/%s%s' "$(cd "$(dirname "$p")" && pwd -P)" "$(basename "$p")" "$tail"
  fi
}

# resolve_from <dir> <specifier> : which physical file the real Node resolver
# would load for <specifier> when imported from <dir>, as a path — the resolver
# answers with a URL, which percent-encodes anything a path may legally contain.
resolve_from() {
  local answer
  answer="$(cd "$1" && WP_S="$2" node --input-type=module -e \
    'import{fileURLToPath}from"node:url";
     try{const u=import.meta.resolve(process.env.WP_S);
       process.stdout.write(u.startsWith("file:")?fileURLToPath(u):u)}
     catch(e){process.stdout.write("ERR:"+(e.code??e.message))}')"
  case "$answer" in
  /*) phys "$answer" ;;
  *) printf '%s' "$answer" ;;
  esac
}

# fp <var> <dir> : capture the shape of a tree — entry kind, path, link target —
# into <var>, for the no-damage and idempotency assertions. Node rather than
# `find -printf`, which is GNU-only: under a BSD find this printed nothing, and
# the two assertions that compare a tree before and after compared one empty
# string to another and reported themselves as passing. A fingerprint that
# cannot be taken aborts the run instead of quietly agreeing with itself.
fp() {
  local out
  out="$(FP_DIR="$2" node -e '
    const { readdirSync, lstatSync, readlinkSync } = require("node:fs");
    const { join, relative } = require("node:path");
    const root = process.env.FP_DIR;
    const rows = [];
    const walk = (dir, depth) => {
      for (const e of readdirSync(dir).sort()) {
        const full = join(dir, e);
        const st = lstatSync(full);
        const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : "f";
        rows.push([kind, relative(root, full), kind === "l" ? readlinkSync(full) : ""].join(" "));
        if (kind === "d" && depth > 1) walk(full, depth - 1);
      }
    };
    walk(root, 3);
    process.stdout.write(rows.join("\n"));
  ')" || {
    echo "FATAL test bug: could not fingerprint '$2' — aborting" >&2
    exit 98
  }
  [ -n "$out" ] || {
    echo "FATAL test bug: fingerprint of '$2' is empty — aborting" >&2
    exit 98
  }
  printf -v "$1" '%s' "$out"
}

# --------------------------------------------------------------------------
# Assertions
# --------------------------------------------------------------------------
ok() {
  echo "ok   - $1"
  pass=$((pass + 1))
}
no() {
  echo "FAIL - $1"
  shift
  local line
  for line in "$@"; do echo "         $line"; done
  fail=$((fail + 1))
}
assert_prefix() { # <label> <prefix> <got>
  case "$3" in
  "$2"*) ok "$1" ;;
  *) no "$1" "want prefix: $2" "got:         $3" ;;
  esac
}
assert_eq() { # <label> <want> <got>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "want: $2" "got:  $3"; fi
}
assert_contains() { # <label> <needle> <haystack>
  case "$3" in
  *"$2"*) ok "$1" ;;
  *) no "$1" "want to contain: $2" "got:             $3" ;;
  esac
}

# --------------------------------------------------------------------------
# 1. A freshly provisioned worktree resolves workspace packages inside itself
#    and third-party packages in the main checkout.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
wt="$(mk_wt "$repo")"
fp before "$repo/node_modules"
out="$(provision "$wt")"
rc=$?
assert_eq "provision exits 0" 0 "$rc"
assert_contains "provision reports the self-check passed" "every workspace package resolves inside" "$out"

for probe in . cli app/server packages/tr; do
  for spec in @fx/cli/core @fx/app/package.json @fx/tr/package.json; do
    assert_prefix "$spec from $probe resolves inside the worktree" \
      "$wt/" "$(resolve_from "$wt/$probe" "$spec")"
  done
done

# The unbuilt cases: an `exports` subpath whose dist/ does not exist yet, and a
# package with no entry point at all. Both are how a fresh worktree really looks.
assert_eq "@fx/cli/core resolves to the worktree's own cli" \
  "$wt/cli/dist/core.js" "$(resolve_from "$wt/app/server" @fx/cli/core)"
assert_eq "an entry-pointless workspace resolves to the worktree's own copy" \
  "$wt/app/server/package.json" "$(resolve_from "$wt/cli" @fx/app/package.json)"
assert_eq "a workspace with an unbuilt main resolves to the worktree's own copy" \
  "$wt/packages/tr/package.json" "$(resolve_from "$wt/app/server" @fx/tr/package.json)"
assert_eq "third-party stays shared with the main checkout" \
  "$repo/node_modules/leftpad/index.js" "$(resolve_from "$wt/app/server" leftpad)"
assert_eq "third-party inside a workspace scope stays shared" \
  "$repo/node_modules/@fx/vendor/index.js" "$(resolve_from "$wt/app/server" @fx/vendor)"

# --------------------------------------------------------------------------
# 2. .bin coherence — a workspace-owned shim points into the worktree, a
#    third-party shim points at the main checkout, both via the same verbatim
#    relative target npm wrote.
# --------------------------------------------------------------------------
assert_eq "node_modules is a real directory, not a link" "" "$(readlink "$wt/node_modules")"
assert_eq ".bin/fx (workspace-owned) runs the worktree's cli" \
  "$wt/cli/bin/fx.mjs" "$(realpath "$wt/node_modules/.bin/fx")"
assert_eq ".bin/leftpad (third-party) runs the main checkout's copy" \
  "$repo/node_modules/leftpad/cli.js" "$(realpath "$wt/node_modules/.bin/leftpad")"

# --------------------------------------------------------------------------
# 3. Hidden lockfile and shared caches stay coherent: mirrored as links to the
#    main tree they describe, byte-identical, never copied or rewritten.
# --------------------------------------------------------------------------
assert_eq "hidden lockfile links to main's" \
  "$repo/node_modules/.package-lock.json" "$(realpath "$wt/node_modules/.package-lock.json")"
assert_eq "hidden lockfile reads identically" \
  "$(cat "$repo/node_modules/.package-lock.json")" "$(cat "$wt/node_modules/.package-lock.json")"
assert_eq "a scope with no workspace member is shared whole" \
  "$repo/node_modules/@types" "$(realpath "$wt/node_modules/@types")"
assert_eq "a workspace's own nested tree is mirrored too" \
  "$repo/cli/node_modules/@types" "$(realpath "$wt/cli/node_modules/@types")"

# --------------------------------------------------------------------------
# 4. The main checkout's tree is not modified. The script unlinks symlinks in a
#    directory whose every entry points into a real 600 MB install.
# --------------------------------------------------------------------------
fp after "$repo/node_modules"
assert_eq "main's node_modules is byte-for-byte unchanged" "$before" "$after"

# --------------------------------------------------------------------------
# 5. Idempotent: re-running changes nothing and still passes.
# --------------------------------------------------------------------------
fp snapshot "$wt/node_modules"
out="$(provision "$wt")"
rc=$?
assert_eq "second run exits 0" 0 "$rc"
fp snapshot2 "$wt/node_modules"
assert_eq "second run leaves the mirror unchanged" "$snapshot" "$snapshot2"

# --------------------------------------------------------------------------
# 6. Self-heals a worktree provisioned by the old whole-tree symlink.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
wt="$(mk_wt "$repo")"
in_root "$wt"
ln -s "$repo/node_modules" "$wt/node_modules"
assert_prefix "old layout resolves to the MAIN checkout (the defect)" \
  "$repo/" "$(resolve_from "$wt/app/server" @fx/cli/core)"
out="$(provision "$wt")"
rc=$?
assert_eq "re-provisioning an old-layout worktree exits 0" 0 "$rc"
assert_prefix "old layout is repaired in place" \
  "$wt/" "$(resolve_from "$wt/app/server" @fx/cli/core)"

# --------------------------------------------------------------------------
# 7. --check fails loudly, naming the package and where it wrongly resolved.
# --------------------------------------------------------------------------
in_root "$wt"
rm -f "$wt/node_modules/@fx/cli" "$wt/node_modules/@fx/app"
ln -s "$repo/cli" "$wt/node_modules/@fx/cli"
ln -s "$repo/app/server" "$wt/node_modules/@fx/app"
out="$(cd "$wt" && bash scripts/worktree-provision.sh --check 2>&1)"
rc=$?
assert_eq "--check on a wrongly linked worktree exits non-zero" 1 "$rc"
assert_contains "--check names the exports-mapped package" "@fx/cli/core" "$out"
assert_contains "--check names the entry-pointless package" "@fx/app/package.json" "$out"
assert_contains "--check names where it resolved" "$repo/cli/dist/core.js" "$out"
assert_contains "--check says what that costs" "would validate another checkout" "$out"
assert_eq "--check does not repair" \
  "$repo/cli/dist/core.js" "$(resolve_from "$wt/app/server" @fx/cli/core)"

# --------------------------------------------------------------------------
# 8. Nothing to share -> warn loudly, exit 0. A missing install in the main
#    checkout is the user's to fix; it is not a reason to fail worktree creation.
# --------------------------------------------------------------------------
repo="$(mk_repo --no-deps)"
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "no main node_modules -> exit 0" 0 "$rc"
assert_contains "no main node_modules -> warns" "WARNING" "$out"
assert_contains "no main node_modules -> says how to fix it" "npm install" "$out"

# --------------------------------------------------------------------------
# 9. Run from the main checkout itself -> skip, do not mirror onto itself.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
fp before "$repo/node_modules"
out="$(cd "$repo" && bash scripts/worktree-provision.sh "$repo" 2>&1)"
rc=$?
assert_eq "run in the main checkout exits 0" 0 "$rc"
assert_contains "run in the main checkout skips" "skipping" "$out"
fp after "$repo/node_modules"
assert_eq "run in the main checkout changes nothing" "$before" "$after"

# --------------------------------------------------------------------------
# 10. Reached through a symlinked alias of the main checkout, the same guard has
#     to hold — a logical cwd that does not match git's physical path would
#     otherwise mirror the main install onto itself, unlinking as it went.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
in_root "$root/main-alias"
ln -s "$repo" "$root/main-alias"
fp before "$repo/node_modules"
out="$(cd "$root/main-alias" && bash scripts/worktree-provision.sh 2>&1)"
rc=$?
assert_eq "run through an alias of the main checkout exits 0" 0 "$rc"
assert_contains "run through an alias skips" "skipping" "$out"
fp after "$repo/node_modules"
assert_eq "run through an alias changes nothing" "$before" "$after"

# --------------------------------------------------------------------------
# 11. A refresh is a mirror, not an accumulation: a dependency main no longer
#     has must not survive in the worktree, where it would go on being imported.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
wt="$(mk_wt "$repo")"
provision "$wt" >/dev/null
in_root "$repo/node_modules/leftpad"
mv "$repo/node_modules/leftpad" "$repo/leftpad-removed"
rm -f "$repo/node_modules/.bin/leftpad"
out="$(provision "$wt")"
rc=$?
assert_eq "refresh after a dependency was removed exits 0" 0 "$rc"
assert_eq "the removed dependency is gone from the worktree" "" \
  "$(readlink "$wt/node_modules/leftpad" || true)"
assert_eq "its .bin shim is gone too" "" "$(readlink "$wt/node_modules/.bin/leftpad" || true)"
assert_prefix "a dependency main still has is untouched" \
  "$repo/node_modules/@fx/vendor" "$(resolve_from "$wt/app/server" @fx/vendor)"

# --------------------------------------------------------------------------
# 12. A workspace directory containing a space is one workspace, not two.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/packages/two words/package.json" '{"name":"@fx/spaced","version":"1.0.0"}'
git -C "$repo" add -A
git -C "$repo" commit -qm spaced
in_root "$repo/node_modules/@fx"
ln -s "../../packages/two words" "$repo/node_modules/@fx/spaced"
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "a workspace path with a space provisions cleanly" 0 "$rc"
assert_eq "and resolves to its own directory, unsplit" \
  "$wt/packages/two words/package.json" \
  "$(resolve_from "$wt/app/server" @fx/spaced/package.json)"

# --------------------------------------------------------------------------
# 13. A workspace package name is a path fragment this script writes with. One
#     that points out of node_modules must be refused before the first write,
#     not caught by the audit after the main checkout has already been changed.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/packages/escape/package.json" '{"name":"../../node_modules/sentinel","version":"1.0.0"}'
git -C "$repo" add -A
git -C "$repo" commit -qm escape
write "$repo/node_modules/sentinel" 'must survive'
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "an escaping workspace name is refused" 1 "$rc"
assert_contains "and says which name" "../../node_modules/sentinel" "$out"
assert_eq "the file it pointed at is untouched" "must survive" "$(cat "$repo/node_modules/sentinel")"
assert_eq "and nothing was mirrored first" "" "$(readlink "$wt/node_modules" || true)"

# --------------------------------------------------------------------------
# 14. The shell re-reads these records on tabs. A name that survives the
#     containment check but carries a delimiter would arrive at the write as a
#     different name and directory than the one that was approved, so the check
#     has to be on the value the shell will see, not only on the value Node saw.
#     `safe<TAB>../victim` resolves inside node_modules as one string, then
#     re-parses into name `safe` and directory `../victim`.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/packages/escape-tab/package.json" '{"name":"safe\t../victim","version":"1.0.0"}'
git -C "$repo" add -A
git -C "$repo" commit -qm escape-tab
write "$root/victim/node_modules/marker" 'source side'
write "$repo/victim/keep" 'must survive'
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "a workspace name carrying a record delimiter is refused" 1 "$rc"
assert_contains "and says it carries one" "control character" "$out"
assert_eq "no tree was written outside the worktree" "keep" "$(ls "$repo/victim")"
assert_eq "and nothing was mirrored first" "" "$(readlink "$wt/node_modules" || true)"

# --------------------------------------------------------------------------
# 15. The same class, one byte the shell drops rather than splits on: command
#     substitution strips NUL. `safe/..<NUL>/../../victim` stays inside
#     node_modules while the NUL is a path segment character, and escapes the
#     moment the shell removes it. Containment therefore has to be checked on a
#     value the transport carries intact, not only on the value Node held.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/packages/escape-nul/package.json" '{"name":"safe/..\u0000/../../victim","version":"1.0.0"}'
git -C "$repo" add -A
git -C "$repo" commit -qm escape-nul
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "a workspace name carrying a NUL is refused" 1 "$rc"
assert_contains "and says it carries a control character" "control character" "$out"
# Nothing pre-exists at the escaped destination: with the NUL stripped, the
# workspace link lands one level above the worktree and creates it.
assert_eq "no link was created outside the worktree" "absent" \
  "$(if [ -e "$repo/victim" ] || [ -L "$repo/victim" ]; then echo present; else echo absent; fi)"
assert_eq "and nothing was mirrored first" "" "$(readlink "$wt/node_modules" || true)"

# --------------------------------------------------------------------------
# 16. A name with more than one path segment stays lexically under the
#     worktree's node_modules while its FIRST segment is, by then, a link to
#     main's copy of that dependency — so the write follows it into the main
#     install. Containment on the string is not containment on the path.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/node_modules/leftpad/lib/keep.js" 'main-owned'
write "$repo/packages/through-dep/package.json" '{"name":"leftpad/lib/local","version":"1.0.0"}'
git -C "$repo" add -A
git -C "$repo" commit -qm through-dep
fp before "$repo/node_modules"
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "a multi-segment package name is refused" 1 "$rc"
assert_contains "and says it is not a package name" "not an npm package name" "$out"
fp after "$repo/node_modules"
assert_eq "main's tree is untouched by the attempt" "$before" "$after"

# --------------------------------------------------------------------------
# 17. `exports` may block an internal subpath with a null target. Probing that
#     one would report a correctly provisioned worktree as broken, on nothing
#     but the order of the keys.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
write "$repo/packages/blocked/package.json" \
  '{"name":"@fx/blocked","version":"1.0.0","exports":{"./internal":null,"./public":"./dist/public.js"}}'
git -C "$repo" add -A
git -C "$repo" commit -qm blocked
in_root "$repo/node_modules/@fx"
ln -s ../../packages/blocked "$repo/node_modules/@fx/blocked"
wt="$(mk_wt "$repo")"
out="$(provision "$wt")"
rc=$?
assert_eq "a blocked subpath before an exported one still provisions" 0 "$rc"
assert_eq "and the exported subpath is what resolves" \
  "$wt/packages/blocked/dist/public.js" "$(resolve_from "$wt/app/server" @fx/blocked/public)"

# --------------------------------------------------------------------------
# 18. Convergence is claimed for the whole tree, so it has to hold when a
#     directory the mirror owns disappears from the source, not only when a
#     single entry inside one does.
# --------------------------------------------------------------------------
repo="$(mk_repo)"
wt="$(mk_wt "$repo")"
provision "$wt" >/dev/null
in_root "$repo/node_modules/.bin"
mv "$repo/node_modules/.bin" "$repo/bin-removed"
in_root "$repo/cli/node_modules"
mv "$repo/cli/node_modules" "$repo/cli-nested-removed"
out="$(provision "$wt")"
rc=$?
assert_eq "refresh after whole directories disappeared exits 0" 0 "$rc"
assert_eq "the .bin the mirror owned is gone" "absent" \
  "$(if [ -e "$wt/node_modules/.bin" ]; then echo present; else echo absent; fi)"
assert_eq "a workspace's emptied nested tree keeps no stale links" "" \
  "$(readlink "$wt/cli/node_modules/@types" || true)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
