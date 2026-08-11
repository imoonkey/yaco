/** How the suite starts the CLI as a child process.
 *
 *  One owner, because the answer changed twice: it was `bun run src/main.ts`,
 *  and `cli-sqlite-hop` made `src/main.ts` unloadable under Bun. Node 24 strips
 *  types on the way in, so the entry runs directly and the runtime is simply the
 *  one hosting the test.
 *
 *  `process.execPath` is absolute, which matters: callers hand the child its own
 *  `env` and `uv_spawn` resolves the program against *that* PATH — which the
 *  golden sandbox deliberately leaves empty.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI_ENTRY = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

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
