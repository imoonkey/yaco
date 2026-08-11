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
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Absolute path of a file shipped inside this package. */
export function packagedAssetPath(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments);
}

/** The absolute `yaco` invocation to hand to something that will run it later —
 *  a provider hook entry, a tmux environment, a detached respawn.
 *
 *  Absolute because every one of those fires in an environment whose PATH yaco
 *  does not control. There are exactly three answers, in order:
 *
 *    1. `$YACO_PATH`, honored verbatim — the deliberate override the app and the
 *       crash-contract tests point at a specific binary or shim;
 *    2. `$YACO_BIN_DIR/yaco`, which `tools/install.sh` and `yaco install` set to
 *       the prefix they installed into, so a fresh install writes hook commands
 *       naming the executable it just put there rather than an older one;
 *    3. this package's own launcher.
 *
 *  Rung 3 is the floor and it always exists, which is the whole point of
 *  resolving from the package root: there used to be a `which yaco` rung and a
 *  bare `"yaco"` last resort below it, needed because a Bun-compiled binary's
 *  files lived in a virtual filesystem and the package could not name itself.
 *  Both could resolve to a *different* installation than the one running, and
 *  the bare rung wrote a command that fails at hook-fire time. */
export function yacoExecutable(): string {
  const explicit = process.env["YACO_PATH"];
  if (explicit && explicit.length > 0) return explicit;

  const binDir = process.env["YACO_BIN_DIR"];
  if (binDir && binDir.length > 0) {
    const candidate = resolve(binDir, "yaco");
    if (existsSync(candidate)) return candidate;
  }

  return packagedAssetPath("bin", "yaco.mjs");
}
