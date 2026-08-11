/** How this plateau starts the CLI as a child process.
 *
 *  `src/main.ts` still imports `bun:sqlite` transitively, so the child is a Bun
 *  process whichever runner hosts the test. Under Vitest the host is Node, so
 *  `process.execPath` is no longer the answer and the runtime has to be named.
 *
 *  It is named once, here. `cli-sqlite-hop` and `cli-dual-artifact-package`
 *  turn this into `process.execPath` plus the built bundle by editing
 *  `runCli`, not eighteen call sites.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_ENTRY = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

/** An absolute path, because `runCli` callers hand the child its own `env` and
 *  `uv_spawn` resolves the program against *that* PATH — which the golden
 *  sandbox deliberately leaves empty. */
function resolveBun(): string {
  if (process.versions.bun) return process.execPath;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    const candidate = join(dir, "bun");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no `bun` on PATH — the CLI entry is not runnable under plain Node yet");
}

export const BUN_BIN = resolveBun();

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  maxBuffer?: number;
}

export function runCli(args: string[], options: RunCliOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(BUN_BIN, ["run", CLI_ENTRY, ...args], { encoding: "utf-8", ...options });
}
