/** How the suite starts the CLI as a child process.
 *
 *  One owner, because the answer kept changing: `bun run src/main.ts`, then
 *  `node src/main.ts` while `cli-sqlite-hop` had no Node artifact to aim at,
 *  and now the artifact itself. `bin/yaco.mjs` over `dist/yaco.mjs` is exactly
 *  what an `npm install -g` puts on the user's PATH, so a subprocess assertion
 *  here is an assertion about the shipped thing — including the Node floor
 *  guard and the package-root offset, neither of which a source run exercises.
 *
 *  The bundle is rebuilt before the suite runs; `test/build-bundle.setup.ts`
 *  owns that, so no caller has to remember it.
 *
 *  `process.execPath` is absolute, which matters: callers hand the child its own
 *  `env` and `uv_spawn` resolves the program against *that* PATH — which the
 *  golden sandbox deliberately leaves empty.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI_ENTRY = fileURLToPath(new URL("../../bin/yaco.mjs", import.meta.url));

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  maxBuffer?: number;
}

export function runCli(args: string[], options: RunCliOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: "utf-8", ...options });
}
