/** The one expression that locates this package's own directory.
 *
 *  Assets that ship inside the package — `scripts/agent-wrapper.sh`,
 *  `package.json` — have to be found relative to the code, not to a checkout
 *  or to the working directory, or an installed copy cannot read them. The
 *  hazard is that the relative distance from *a source file* to the package
 *  root is not the distance from *the built artifact* to it: a bundler rewrites
 *  neither `import.meta.url` nor the `../..` next to it, so every
 *  source-relative asset path silently retargets when the code is bundled.
 *
 *  Concentrating the expression here removes that class of bug by construction.
 *  This module sits one level below the package root, and every build layout
 *  the distribution design admits keeps it there — `src/package-root.ts` when
 *  run from source, `dist/package-root.js` from the module emit, and the
 *  inlined copy in `dist/yaco.mjs` from the bundle. So `../` is the package
 *  root in all three, and callers name assets instead of counting directories.
 *
 *  A single-file compiled artifact is the exception it cannot cover: its
 *  modules live in a virtual filesystem with no real path, so the root
 *  resolves to something that exists nowhere. Callers that must keep working
 *  there (the agent wrapper) check the path before reading it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Absolute path of a file shipped inside this package. */
export function packagedAssetPath(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments);
}

/** True when this package's own files have no real path — the process is a
 *  single-file compiled artifact serving its modules from a virtual
 *  filesystem. The package root is the exact thing that is missing, so testing
 *  it is both the cheapest signal and the one that cannot disagree with the
 *  asset lookups above. */
export function isSingleFileArtifact(): boolean {
  return !existsSync(PACKAGE_ROOT);
}

/** This process's own absolute path when it *is* the yaco executable, else null.
 *
 *  yaco writes its own invocation into provider hook configs and into queued
 *  tmux commands, and both fire later in a stripped environment, so the
 *  invocation has to be absolute or it silently stops working. A single-file
 *  artifact is the one case where the running process is itself that
 *  invocation. Under a runtime that was handed yaco's entry point instead
 *  (`bun run src/main.ts`, `node dist/yaco.mjs`) this is null: `process.execPath`
 *  would name the runtime, which is not a yaco invocation, and the caller has to
 *  supply the entry point as well. */
export function selfExecutablePath(): string | null {
  return isSingleFileArtifact() ? process.execPath : null;
}
