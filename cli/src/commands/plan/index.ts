/** `yaco plan <subcommand>` — manage the project's plan repo.
 *
 *  Subcommands:
 *    init  Promote the [paths] plan directory into a private, colocated git
 *          repo: in-place `git init`, a default plan .gitignore, and a
 *          `/<plan>/` entry in the host's info/exclude so the host repo never
 *          tracks it. Idempotent. `--remote <url>` adds an origin (never pushes).
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { handlePlanInit } from "./init.ts";

const HELP = `yaco plan — manage the project's plan repo

Usage:
  yaco plan init [--remote <url>] [--force] [--cwd <path>] [--json]
  yaco plan --help

Subcommands:
  init   Promote the [paths] plan directory into a private, colocated git repo:
         in-place git init, a default plan .gitignore (kept if one exists), and a
         /<plan>/ entry in .git/info/exclude so the host repo never tracks it.
         Idempotent. Refuses if the root .gitignore matches the plan root.

Flags for 'init':
  --remote <url>   Add 'origin' pointing at <url> (never pushes). A different
                   existing origin conflicts unless --force.
  --force          Replace an existing origin with a different URL
  --cwd <path>     Operate in <path> instead of the current directory
`;

export async function handlePlan(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "init") {
    return handlePlanInit(rest, opts.json, HELP);
  }

  throw new CliError(
    ErrCode.USAGE,
    `unknown subcommand: plan ${sub}. Run \`yaco plan --help\`.`,
  );
}
