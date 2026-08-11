/** How this installation names its own files to code that runs later.
 *
 *  Four things have to be found relative to the package rather than to a
 *  checkout or a working directory, or an installed copy cannot work:
 *  `scripts/agent-wrapper.sh`, `package.json`, `agent-config/global/skills`, and
 *  the `yaco` executable itself — yaco writes its own invocation into provider
 *  hook configs and into queued tmux commands, and both fire later in a stripped
 *  environment.
 *
 *  The hazard is that the relative distance from *a source file* to the package
 *  root is not the distance from *the built artifact* to it: a bundler rewrites
 *  neither `import.meta.url` nor the `../..` next to it, so every
 *  source-relative asset path silently retargets when the code is bundled.
 *
 *  Concentrating the expression here removes that class of bug by construction.
 *  This module sits one level below the package root, and every build layout the
 *  distribution ships keeps it there — `src/package-root.ts` when run from
 *  source, `dist/package-root.js` from the module emit, and the inlined copy in
 *  `dist/yaco.mjs` from the bundle. So `../` is the package root in all three,
 *  and callers name assets instead of counting directories.
 */
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Absolute path of a file shipped inside this package. */
export function packagedAssetPath(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments);
}

/** The skills `yaco install` plants `~/.claude/skills` links to, and the listing
 *  `yaco doctor` checks those links against — one manifest, named once.
 *
 *  Mirrored into the package from the repo's `agent-config/global/` by
 *  `scripts/sync-agent-config.mjs` at build time, because npm cannot pack a path
 *  outside the package directory. */
export const PACKAGED_SKILLS_DIR = packagedAssetPath("agent-config", "global", "skills");

/** The skill names in a manifest directory — its child directories, ascending.
 *
 *  One enumeration for both readers of the manifest, because they have to agree:
 *  install plants a link per name, doctor reports the names that have none. The
 *  order is part of that agreement — doctor's failure detail names only the
 *  first three missing skills, and a raw directory read makes *which* three an
 *  artifact of the filesystem. Sorted by code unit, never `localeCompare`, so
 *  the answer is a property of the names alone.
 *
 *  Throws like the read it wraps: a manifest that cannot be listed is a broken
 *  installation, and each caller says so in its own words. */
export function listSkillNames(skillsDir: string): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** A `yaco` on PATH that is a real installation — memoized against the PATH it
 *  was found under.
 *
 *  Not `which yaco`, because `which` answers with the first hit and the first
 *  hit is routinely the wrong one: npm creates a `yaco` shim in every
 *  workspace's `node_modules/.bin` (this package declares a `bin`) and prepends
 *  those directories to PATH for the duration of an npm script. Under
 *  `npm run <anything>` in a yaco checkout, `which yaco` therefore names that
 *  checkout — and a hook command written from it dies when the worktree is
 *  deleted, which is precisely the failure this rung exists to prevent. A
 *  `node_modules/.bin` entry is a build-tree artifact, never an installation
 *  someone chose, so the walk skips those directories and keeps looking.
 *
 *  Relative PATH entries are skipped too: they cannot yield the absolute
 *  invocation a later-firing hook needs.
 *
 *  Memoized because the trust gate resolves once per hook entry and an install
 *  writes twenty; keyed on PATH because the suite rebuilds a shimmed PATH per
 *  case inside one process, and a cache that outlived that would answer with
 *  the previous sandbox's binary. Self-invalidating beats a reset hook nobody
 *  remembers to call. */
const WORKSPACE_SHIM_DIR = join("node_modules", ".bin");
const { X_OK } = constants;

let _pathYaco: { path: string | undefined; found: string | null } | null = null;
function yacoOnPath(): string | null {
  const path = process.env["PATH"];
  const cached = _pathYaco;
  if (cached && cached.path === path) return cached.found;
  let found: string | null = null;
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    if (dir.endsWith(sep + WORKSPACE_SHIM_DIR)) continue;
    const candidate = join(dir, "yaco");
    try {
      accessSync(candidate, X_OK);
      if (!statSync(candidate).isFile()) continue;
    } catch { continue; }
    found = candidate;
    break;
  }
  _pathYaco = { path, found };
  return found;
}

/** The absolute `yaco` invocation to hand to something that will run it later —
 *  a provider hook entry, a tmux environment, a detached respawn.
 *
 *  Absolute because every one of those fires in an environment whose PATH yaco
 *  does not control. Four answers, in order of how deliberately the machine
 *  said "this is my yaco":
 *
 *    1. `$YACO_PATH`, honored verbatim — the override the app and the
 *       crash-contract tests point at a specific binary or shim;
 *    2. `$YACO_BIN_DIR/yaco`, which `tools/install.sh` sets to the prefix it
 *       installed into, so a fresh install writes hook commands naming the
 *       executable it just put there rather than an older one. `yaco install`
 *       only exports it when the caller actually supplied one: its *default*
 *       (`~/.local/bin`) is a guess, and a guess must not outrank a real
 *       installation found below;
 *    3. an executable `yaco` on PATH, skipping workspace shims — see
 *       {@link yacoOnPath}. This rung is what keeps a command run *from a
 *       checkout* from repointing global hooks at that checkout, which then
 *       break when the worktree is deleted;
 *    4. this package's own launcher.
 *
 *  Rung 4 is the floor and it always exists, which is the point of resolving
 *  from the package root: it replaces a literal `"yaco"` last resort that wrote
 *  a command failing at hook-fire time, and a `process.execPath` rung that only
 *  ever fired for a Bun-compiled binary whose files lived in a virtual
 *  filesystem. It is reached by an install whose prefix is not on PATH — where
 *  naming ourselves is both correct and the only true answer. */
export function yacoExecutable(): string {
  const explicit = process.env["YACO_PATH"];
  if (explicit && explicit.length > 0) return explicit;

  const binDir = process.env["YACO_BIN_DIR"];
  if (binDir && binDir.length > 0) {
    const candidate = resolve(binDir, "yaco");
    if (existsSync(candidate)) return candidate;
  }

  return yacoOnPath() ?? packagedAssetPath("bin", "yaco.mjs");
}
