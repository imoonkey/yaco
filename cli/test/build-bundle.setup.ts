/** Build the package's own artifacts once, before any test runs.
 *
 *  Two of them are test inputs, and both are silent wrong answers when stale:
 *
 *  - `dist/yaco.mjs`, because `test/helpers/cli-process.ts` spawns the bundle
 *    rather than the source — the bundle is what `bin/yaco.mjs` loads and what an
 *    installed package contains, so a subprocess test against the source would
 *    not exercise the artifact anyone runs;
 *  - `agent-config/`, the skills mirrored in from the repo, because `install` and
 *    `doctor` resolve the skills manifest from the package root. Without it a
 *    source run has no manifest at all, and a run against a stale one asserts a
 *    skill list nobody ships.
 *
 *  So the build belongs where it cannot be skipped: a `npm test`-only hook would
 *  leave every focused `npx vitest run <file>` testing yesterday's code.
 *
 *  esbuild costs about 50 ms and the mirror rather less, which is noise against a
 *  suite that spawns tmux and git.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));

export default function buildTestInputs(): void {
  // The mirror needs nothing but Node, so it skips npm's startup. The bundle
  // goes through `npm run` because that is what puts the hoisted `esbuild` on
  // PATH — this workspace has no `node_modules/.bin` of its own.
  run("agent-config/", process.execPath, [join(CLI_DIR, "scripts", "sync-agent-config.mjs")]);
  run("dist/yaco.mjs", "npm", ["run", "--silent", "build:bundle"]);
}

function run(what: string, command: string, args: string[]): void {
  const r = spawnSync(command, args, {
    cwd: CLI_DIR,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(`could not build ${what} for the suite:\n${r.stderr ?? ""}`);
  }
}
