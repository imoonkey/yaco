/** How this installation names its own files to code that runs later.
 *
 *  Three things have to be found relative to the package rather than to a
 *  checkout or a working directory, or an installed copy cannot work:
 *  `scripts/agent-wrapper.sh`, `package.json`, and the `yaco` executable
 *  itself — yaco writes its own invocation into provider hook configs and into
 *  queued tmux commands, and both fire later in a stripped environment.
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
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Absolute path of a file shipped inside this package. */
export function packagedAssetPath(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments);
}

/** `which yaco`, memoized against the PATH it was resolved under.
 *
 *  Memoized because the trust gate calls the resolver once per hook entry and
 *  an install writes twenty of them; keyed on PATH because the test suite
 *  rebuilds a shimmed PATH per case in one process, and a cache that outlived
 *  that would answer with the previous sandbox's binary. Self-invalidating
 *  beats a reset hook nobody remembers to call. */
let _pathYaco: { path: string | undefined; found: string | null } | null = null;
function yacoOnPath(): string | null {
  const path = process.env["PATH"];
  const cached = _pathYaco;
  if (cached && cached.path === path) return cached.found;
  let found: string | null = null;
  try {
    const r = execSync("which yaco", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (r.length > 0) found = r;
  } catch { /* not on PATH */ }
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
 *    2. `$YACO_BIN_DIR/yaco`, which `tools/install.sh` and `yaco install` set to
 *       the prefix they installed into, so a fresh install writes hook commands
 *       naming the executable it just put there rather than an older one;
 *    3. `which yaco` — an executable of that name on PATH is an installation the
 *       user chose. This rung is what keeps a command run *from a checkout* from
 *       repointing global hooks at that checkout, which then break when the
 *       worktree is deleted;
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
