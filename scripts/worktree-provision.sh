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
# script in the worktree to refresh it, which converges (links to entries main no
# longer has are dropped) rather than accumulating. It never runs `rm -r`: every
# removal is guarded to a symlink, so it cannot reach into the shared tree.
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

# Main checkout = the first entry of `git worktree list`. Both sides are
# canonicalized before they are compared: reached through a symlinked alias, a
# logical cwd would not match git's physical path, the guard below would not
# fire, and the mirror would run with the main install as both source and
# destination.
main="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"
[ -n "${main:-}" ] && main="$(cd "$main" && pwd -P)"
wt="$(pwd -P)"
if [ -z "${main:-}" ] || [ "$main" = "$wt" ]; then
  echo "worktree-provision: could not resolve main checkout; skipping" >&2
  exit 0
fi

# Workspace packages of THIS worktree, one tab-separated "<name>\t<dir>" per
# line. What to ask the resolver for is decided later, by the self-check, which
# is the only place that can find out which subpaths this resolver answers.
workspaces="$(node -e '
  const { globSync, readFileSync, realpathSync } = require("node:fs");
  const { join, sep } = require("node:path");

  const root = realpathSync(process.cwd());
  const inside = (p, base) => p === base || p.startsWith(base + sep);
  const opaque = (v) => /[\u0000-\u001f\u007f]/.test(v);

  try {
    const globs = JSON.parse(readFileSync("package.json", "utf8")).workspaces ?? [];
    const seen = new Set();
    const out = [];
    for (const glob of globs)
      for (const dir of globSync(glob).sort()) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        let pkg;
        try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { continue; }
        if (!pkg.name) continue;

        // Both writes these names drive — the link at node_modules/<name> and the
        // mirror of <dir>/node_modules — must land inside this worktree. They come
        // from a manifest and a glob, and nothing downstream re-checks them.
        //
        // Representable first: everything below reasons about the value the shell
        // will hold, and the shell does not carry every byte through. It splits on
        // the tab and the newline and drops NUL, so a value holding one arrives at
        // a write different from the one checked here. Refused, not escaped, so
        // there is one representation rather than two.
        const carried = [pkg.name, dir].find(opaque);
        if (carried !== undefined)
          throw new Error(`workspace value ${JSON.stringify(carried)} contains a control character`);
        //
        // The name is held to the shape npm allows first, because lexical
        // containment is not enough by itself: `leftpad/lib/local` resolves under
        // the node_modules of this worktree, but `leftpad` is by then a link to
        // the copy of that dependency in main, and the write would follow it into
        // the main install. One segment, or @scope/name — every publishable name.
        const segments = pkg.name.split("/");
        const shaped =
          (segments.length === 1 || (segments.length === 2 && segments[0].startsWith("@"))) &&
          segments.every((s) => s !== "" && s !== "." && s !== ".." && !s.includes("\\"));
        if (!shaped)
          throw new Error(`workspace package name ${JSON.stringify(pkg.name)} is not an npm package name (one segment, or @scope/name)`);
        // A glob can match a symlink, so the directory is checked physically.
        // The name needs no containment check of its own: after the shape above,
        // one segment or @scope/name cannot leave node_modules lexically, and
        // what it can do through a symlinked ancestor is checked at the write.
        const abs = realpathSync(dir);
        if (!inside(abs, root))
          throw new Error(`workspace directory "${dir}" resolves to ${abs}, outside ${root}`);

        out.push([pkg.name, dir].join("\t"));
      }
    process.stdout.write(out.join("\n"));
  } catch (e) {
    process.stderr.write("worktree-provision: " + e.message + "\n");
    process.exit(1);
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
while IFS="$(printf '\t')" read -r name _; do
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

# mirror <src node_modules> <dst node_modules> : make <dst> hold exactly what
# <src> holds. A symlink is recreated with its target copied verbatim; anything
# else is linked at main's copy, except the `$descend` names, which are rebuilt
# as real directories and mirrored one level down. Links to entries <src> no
# longer has are dropped, so a refresh converges on the current install instead
# of accumulating; a real entry in <dst> is worktree-owned and is never touched.
mirror() {
  local src="$1" dst="$2" entry base
  real_dir "$dst"
  if [ -d "$src" ] && [ "$(cd "$src" && pwd -P)" = "$(cd "$dst" && pwd -P)" ]; then
    echo "worktree-provision: refusing to mirror $src onto itself" >&2
    exit 1
  fi
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
  for entry in "$dst"/*; do
    base="${entry##*/}"
    if [ -e "$src/$base" ] || [ -L "$src/$base" ]; then continue; fi
    if [ -L "$entry" ]; then
      rm -f "$entry"
    elif [ -d "$entry" ] && [[ " $descend " == *" $base "* ]]; then
      # A directory this mirror owns whose source is gone: empty it of the links
      # it put there, and drop it if nothing worktree-owned remains. `rmdir`
      # never recurses, so a leftover real entry keeps the directory alive.
      mirror "$src/$base" "$entry"
      rmdir "$entry" 2>/dev/null || true
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
  # Each workspace's own nested tree (npm leaves the deps it cannot hoist there).
  # Mirrored when EITHER side exists: once main re-hoists them away, the worktree
  # copy still has to be emptied, or it goes on shadowing with links main dropped.
  while IFS="$(printf '\t')" read -r _ dir; do
    if [ -d "$main/$dir/node_modules" ] || [ -d "$wt/$dir/node_modules" ]; then
      mirror "$main/$dir/node_modules" "$wt/$dir/node_modules"
    fi
  done <<<"$workspaces"

  # Point every workspace package at THIS worktree. The verbatim relative links
  # above already do this for the packages main knows about; this also covers one
  # that exists only on this branch.
  while IFS="$(printf '\t')" read -r name dir; do
    # Physical containment before anything is created, independently of the shape
    # the name was already held to. The parent may not exist yet and `mkdir -p`
    # would follow a mirrored dependency link into the main install on its way to
    # making it, so the deepest ancestor that DOES exist is the one canonicalized.
    ancestor="$(dirname "$wt/node_modules/$name")"
    while [ ! -d "$ancestor" ]; do ancestor="$(dirname "$ancestor")"; done
    ancestor="$(cd "$ancestor" && pwd -P)"
    case "$ancestor" in
    "$wt/node_modules" | "$wt/node_modules"/*) ;;
    *)
      echo "worktree-provision: refusing to link $name — $ancestor is outside $wt/node_modules" >&2
      exit 1
      ;;
    esac
    case "$name" in */*) real_dir "$wt/node_modules/${name%/*}" ;; esac
    relink "$wt/$dir" "$wt/node_modules/$name"
  done <<<"$workspaces"

  echo "worktree-provision: mirrored $main/node_modules -> $wt/node_modules (workspace packages local)"
fi

# --------------------------------------------------------------------------
# Self-check — ask the real Node resolver, from every directory that imports.
# `node --input-type=module -e` anchors import.meta at the cwd, so this says
# which physical file an import would load, not which symlink it went through.
# --------------------------------------------------------------------------
resolve_js='
  import { readFileSync, realpathSync } from "node:fs";
  import { dirname, join } from "node:path";
  import { fileURLToPath } from "node:url";

  // A path, not the URL the resolver hands back: a URL percent-encodes, and a
  // checkout under a directory with a space in it would then never match the
  // prefix it is being compared against.
  //
  // The resolver canonicalizes symlinks only when the target file exists, and a
  // fresh worktree has nothing built — an unresolved `dist/` would leave the
  // answer sitting on the node_modules link and look local while pointing away.
  // Canonicalize the deepest existing ancestor, so it reads the same either way.
  const physical = (url) => {
    let p = fileURLToPath(url), tail = "";
    for (;;) {
      try { return realpathSync(p) + tail; } catch {}
      const up = dirname(p);
      if (up === p) return p + tail;
      tail = p.slice(up.length) + tail;
      p = up;
    }
  };

  // What to ask for. A package without `exports` answers to any path, and
  // `package.json` is the one file it certainly has. With `exports`, only a
  // declared subpath answers — and WHICH of them answer depends on the
  // conditions this resolver applies and on targets that may be null, so rather
  // than predict that, offer them in order and keep the first that resolves.
  const candidates = (name, dir) => {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(process.env.WP_ROOT, dir, "package.json"), "utf8")); } catch {}
    const exp = pkg.exports;
    if (exp === undefined || exp === null) return [name + "/package.json"];
    const subs = typeof exp === "object" && !Array.isArray(exp)
      ? Object.keys(exp).filter((k) => k.startsWith("./")).map((k) => name + k.slice(1))
      : [];
    return [name, ...subs];
  };

  // The specifier is reported back through the shell; a control character in an
  // `exports` key would otherwise re-split the line it is printed on.
  const printable = (s) => s.replace(/[\u0000-\u001f\u007f]/g, "?");

  let out = "";
  for (const line of process.env.WP_PKGS.split("\n").filter(Boolean)) {
    const [name, dir] = line.split("\t");
    let asked = name, answer = null, failure = "UNRESOLVED:NO_CANDIDATE";
    for (const spec of candidates(name, dir)) {
      asked = spec;
      try { answer = physical(import.meta.resolve(spec)); break; }
      catch (e) { failure = "UNRESOLVED:" + (e.code ?? e.message); }
    }
    out += printable(asked) + "\t" + (answer ?? failure) + "\n";
  }
  process.stdout.write(out);
'
bad=0

# probe <dir> : report every workspace package that <dir> resolves outside $wt.
probe() {
  local dir="$1" out spec resolved where
  [ -d "$dir" ] || return 0
  where="${dir#"$wt"/}"
  [ "$where" != "$dir" ] || where="."
  if ! out="$(cd "$dir" && WP_ROOT="$wt" WP_PKGS="$workspaces" node --input-type=module -e "$resolve_js")"; then
    echo "worktree-provision: ✗ resolution probe failed to run in $where" >&2
    bad=$((bad + 1))
    return 0
  fi
  while IFS="$(printf '\t')" read -r spec resolved; do
    [ -n "$spec" ] || continue
    case "$resolved" in
    "$wt/"*) ;;
    *)
      echo "worktree-provision: ✗ $spec does not resolve inside this worktree" >&2
      echo "worktree-provision:     imported from  $where" >&2
      echo "worktree-provision:     resolves to    $resolved" >&2
      bad=$((bad + 1))
      ;;
    esac
  done <<<"$out"
}

probe "$wt"
while IFS="$(printf '\t')" read -r _ dir; do probe "$wt/$dir"; done <<<"$workspaces"

if [ "$bad" -gt 0 ]; then
  echo "worktree-provision: FAILED — $bad workspace import(s) resolve outside $wt." >&2
  echo "worktree-provision: Tests run here would validate another checkout's source." >&2
  exit 1
fi

echo "worktree-provision: ✓ every workspace package resolves inside $wt"
