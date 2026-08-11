/** Build `dist/yaco.mjs` once, before any test runs.
 *
 *  `test/helpers/cli-process.ts` spawns the bundle, not the source, because the
 *  bundle is what `bin/yaco.mjs` loads and what an installed package contains —
 *  a subprocess test against the source would not exercise the artifact anyone
 *  runs. That makes a stale bundle a silent wrong answer, so the build belongs
 *  where it cannot be skipped: a `npm test`-only hook would leave every focused
 *  `npx vitest run <file>` testing yesterday's code.
 *
 *  esbuild costs about 50 ms, which is noise against a suite that spawns tmux
 *  and git.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));

export default function buildBundle(): void {
  const r = spawnSync("npm", ["run", "--silent", "build:bundle"], {
    cwd: CLI_DIR,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(`could not build dist/yaco.mjs for the suite:\n${r.stderr ?? ""}`);
  }
}
