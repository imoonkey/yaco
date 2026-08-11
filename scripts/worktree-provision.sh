#!/usr/bin/env bash
# Worktree provisioning — runs (cwd = worktree root) when `yaco worktree create`
# makes a fresh worktree. npm workspaces hoist node_modules to the repo root, and
# a git worktree does NOT copy the (gitignored) node_modules, so vitest/playwright
# can't run without help from the main checkout.
#
# The third-party tree is branch-independent and stays SHARED with the main
# checkout. The workspace self-links inside it are not: npm writes them relative
# (`@yaco/cli -> ../../cli`), and a relative symlink resolves against its physical
# location — so sharing node_modules whole made a worktree resolve `@yaco/*` to
# the MAIN checkout's source, i.e. to a different branch.
#
# So node_modules is MIRRORED, not symlinked: a real directory whose entries are
# links into main's tree, with `.bin` and the workspace scope directories rebuilt
# one level down. Every link is recreated with its target copied verbatim, which
# re-anchors the relative ones inside this worktree and leaves the rest on main:
#
#   .bin/vitest -> ../vitest/vitest.mjs   ->  <wt>/node_modules/vitest -> main's
#   .bin/yaco   -> ../@yaco/cli/bin/...   ->  <wt>/node_modules/@yaco/cli -> <wt>/cli
#   @yaco/cli   -> ../../cli              ->  <wt>/cli
#
# The mirror is a snapshot: a package installed into main AFTER a worktree exists
# is missing from it. That fails loudly (`Cannot find module`) — re-run this
# script in the worktree to refresh it. It is idempotent, and it never runs
# `rm -r`: it only ever unlinks symlinks, so it cannot damage the shared tree.
#
#   worktree-provision.sh [<worktree path>]   provision, then self-check
#   worktree-provision.sh --check             self-check an existing worktree only
#
# Port isolation for dev/e2e is handled in code, not here: app/ui/e2ePorts.ts
# derives an isolated UI/API port pair from the worktree path, consumed by
# app/ui/{vite,playwright}.config.ts. So a worktree serves and tests its own code
# without colliding with the main checkout or sibling worktrees.
set -euo pipefail
shopt -s nullglob dotglob

# Main checkout = the first entry of `git worktree list`.
main="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
if [ -z "${main:-}" ] || [ "$main" = "$PWD" ]; then
  echo "worktree-provision: could not resolve main checkout; skipping" >&2
  exit 0
fi
wt="$(pwd -P)"

# Workspace packages of THIS worktree, one "<name> <dir> <probe specifier>" per
# line. The probe specifier is what the self-check asks the resolver for, and it
# has to answer in an unbuilt checkout: an `exports` map resolves a declared
# subpath without touching disk, while a package without one is asked for its
# `package.json`, the one file it is guaranteed to have.
workspaces="$(node -e '
  const { globSync, readFileSync } = require("node:fs");
  const globs = JSON.parse(readFileSync("package.json", "utf8")).workspaces ?? [];
  const seen = new Set();
  for (const glob of globs)
    for (const dir of globSync(glob).sort()) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      let pkg;
      try { pkg = JSON.parse(readFileSync(dir + "/package.json", "utf8")); } catch { continue; }
      if (!pkg.name) continue;
      const exp = pkg.exports;
      let spec = pkg.name;
      if (exp === undefined || exp === null) spec += "/package.json";
      else if (typeof exp === "object" && !Array.isArray(exp)) {
        const sub = Object.keys(exp).find((k) => k.startsWith("./"));
        if (sub) spec += sub.slice(1);
      }
      console.log([pkg.name, dir, spec].join(" "));
    }
')"
if [ -z "$workspaces" ]; then
  echo "worktree-provision: WARNING no workspace packages declared in $wt/package.json;" >&2
  echo "worktree-provision: nothing to isolate, and nothing checked. Skipping." >&2
  exit 0
fi

# Directories the mirror must descend into instead of sharing whole: `.bin` and
# every scope that hosts a workspace package. Both hold workspace-owned links.
descend=".bin"
while read -r name _ _; do
  case "$name" in
  @*/*) case " $descend " in *" ${name%%/*} "*) ;; *) descend="$descend ${name%%/*}" ;; esac ;;
  esac
done <<<"$workspaces"

# --------------------------------------------------------------------------
# Mirroring
# --------------------------------------------------------------------------

# relink <target> <dst> : point <dst> at <target>. Replaces an existing symlink
# (unlinking a symlink never touches what it points at); a real file or directory
# at <dst> is worktree-owned state and is left alone.
relink() {
  if [ -L "$2" ] || [ ! -e "$2" ]; then
    rm -f "$2"
    ln -s "$1" "$2"
  fi
}

# real_dir <path> : ensure <path> is a real directory, replacing a symlink there.
real_dir() {
  if [ -L "$1" ]; then rm -f "$1"; fi
  mkdir -p "$1"
}

# mirror <src node_modules> <dst node_modules> : reproduce every entry of <src>
# under <dst>. A symlink is recreated with its target copied verbatim; anything
# else is linked at main's copy, except the `$descend` names, which are rebuilt
# as real directories and mirrored one level down.
mirror() {
  local src="$1" dst="$2" entry base
  real_dir "$dst"
  for entry in "$src"/*; do
    base="${entry##*/}"
    if [ -d "$entry" ] && [ ! -L "$entry" ] && [[ " $descend " == *" $base "* ]]; then
      mirror "$entry" "$dst/$base"
    elif [ -L "$entry" ]; then
      relink "$(readlink "$entry")" "$dst/$base"
    else
      relink "$entry" "$dst/$base"
    fi
  done
}

if [ "${1:-}" != "--check" ]; then
  if [ ! -d "$main/node_modules" ]; then
    echo "worktree-provision: WARNING $main/node_modules does not exist, so this worktree" >&2
    echo "worktree-provision: has no dependencies to share and no resolution to check." >&2
    echo "worktree-provision: Run 'npm install' in $main, then re-run this script here." >&2
    exit 0
  fi

  # The root tree, then each workspace's own nested tree (npm leaves the deps it
  # cannot hoist there).
  mirror "$main/node_modules" "$wt/node_modules"
  while read -r _ dir _; do
    if [ -d "$main/$dir/node_modules" ]; then
      mirror "$main/$dir/node_modules" "$wt/$dir/node_modules"
    fi
  done <<<"$workspaces"

  # Point every workspace package at THIS worktree. The verbatim relative links
  # above already do this for the packages main knows about; this also covers one
  # that exists only on this branch.
  while read -r name dir _; do
    case "$name" in */*) real_dir "$wt/node_modules/${name%/*}" ;; esac
    rm -f "$wt/node_modules/$name"
    ln -s "$wt/$dir" "$wt/node_modules/$name"
  done <<<"$workspaces"

  echo "worktree-provision: mirrored $main/node_modules -> $wt/node_modules (workspace packages local)"
fi

# --------------------------------------------------------------------------
# Self-check — ask the real Node resolver, from every directory that imports.
# `node --input-type=module -e` anchors import.meta at the cwd, so this says
# which physical file an import would load, not which symlink it went through.
# --------------------------------------------------------------------------
resolve_js='
  import { realpathSync } from "node:fs";
  import { dirname } from "node:path";
  import { fileURLToPath, pathToFileURL } from "node:url";

  // The resolver canonicalizes symlinks only when the target file exists, and a
  // fresh worktree has nothing built — an unresolved `dist/` would leave the
  // answer sitting on the node_modules link and look local while pointing away.
  // Canonicalize the deepest existing ancestor, so it reads the same either way.
  const physical = (url) => {
    let p = fileURLToPath(url), tail = "";
    for (;;) {
      try { return pathToFileURL(realpathSync(p)).href + tail; } catch {}
      const up = dirname(p);
      if (up === p) return url;
      tail = p.slice(up.length) + tail;
      p = up;
    }
  };

  let out = "";
  for (const spec of process.env.WP_SPECS.split("\n").filter(Boolean)) {
    try { out += spec + " " + physical(import.meta.resolve(spec)) + "\n"; }
    catch (e) { out += spec + " UNRESOLVED:" + (e.code ?? e.message) + "\n"; }
  }
  process.stdout.write(out);
'
specs="$(awk '{print $3}' <<<"$workspaces")"
bad=0

# probe <dir> : report every workspace specifier that <dir> resolves outside $wt.
probe() {
  local dir="$1" out spec resolved
  [ -d "$dir" ] || return 0
  if ! out="$(cd "$dir" && WP_SPECS="$specs" node --input-type=module -e "$resolve_js")"; then
    echo "worktree-provision: ✗ resolution probe failed to run in ${dir#"$wt/"}" >&2
    bad=$((bad + 1))
    return 0
  fi
  while read -r spec resolved; do
    [ -n "$spec" ] || continue
    case "$resolved" in
    "file://$wt/"*) ;;
    *)
      echo "worktree-provision: ✗ $spec does not resolve inside this worktree" >&2
      echo "worktree-provision:     imported from  ${dir#"$wt"/}" >&2
      echo "worktree-provision:     resolves to    $resolved" >&2
      bad=$((bad + 1))
      ;;
    esac
  done <<<"$out"
}

probe "$wt"
while read -r _ dir _; do probe "$wt/$dir"; done <<<"$workspaces"

if [ "$bad" -gt 0 ]; then
  echo "worktree-provision: FAILED — $bad workspace import(s) resolve outside $wt." >&2
  echo "worktree-provision: Tests run here would validate another checkout's source." >&2
  exit 1
fi

echo "worktree-provision: ✓ every workspace package resolves inside $wt"
