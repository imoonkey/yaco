/** gh-CLI PR creation, captured so callers never see raw gh stdout.
 *
 *  `gh pr create --fill` prints the PR URL to stdout on success. We capture
 *  it and parse the URL out so the dispatcher can return it via envelope
 *  `data.url`. stdio is `pipe` (NOT inherited) so the user's stdout stays
 *  the dispatcher's exclusive envelope channel.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { CliError, ErrCode } from "../errors.ts";

const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+\/pull\/\d+/;

export interface PRCreateArgs {
  cwd: string;
  base: string;
  branch: string;
}

export interface PRResult {
  url: string;
  raw: string;
}

export function createPullRequest(args: PRCreateArgs): PRResult {
  const r: SpawnSyncReturns<string> = spawnSync(
    "gh",
    ["pr", "create", "--base", args.base, "--head", args.branch, "--fill"],
    {
      encoding: "utf-8",
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CliError(ErrCode.ENV, "gh CLI not found on PATH (required for --mode pr)");
    }
    throw new CliError(ErrCode.IO, `gh pr create spawn failed: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `gh pr create failed (exit ${r.status}): ${(stderr.trim() || stdout.trim() || "no output")}`,
    );
  }
  const match = stdout.match(PR_URL_RE) ?? stderr.match(PR_URL_RE);
  if (!match) {
    throw new CliError(
      ErrCode.INVALID,
      `gh pr create succeeded but no PR URL was found in its output`,
    );
  }
  return { url: match[0], raw: stdout };
}
