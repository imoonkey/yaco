/** `yaco worktree <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    create  <slug> [--base <branch>]
 *    merge   <slug> [--mode pr|local] [--base <branch>]
 *    cleanup <slug> [--force]
 *
 *  All subcommands accept `--json`. Slug = lowercase alphanumeric + hyphens
 *  (no leading/trailing hyphen). Branch is always `task/<slug>`; worktree
 *  always lands at `<repoRoot>/.worktrees/<slug>` where `<repoRoot>` is
 *  resolved per-invocation from cwd via `git rev-parse --git-common-dir`.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runCleanup } from "./cleanup.ts";
import { runCreate } from "./create.ts";
import { runMerge } from "./merge.ts";

const HELP = `yaco worktree — create, merge, and clean up git worktrees per task slug

Usage:
  yaco worktree create  <slug> [--base <branch>]                 [--json]
  yaco worktree merge   <slug> [--mode pr|local] [--base <branch>] [--json]
  yaco worktree cleanup <slug> [--force]                          [--json]

Flags:
  --base <branch>     Base branch (default: main)
  --mode <pr|local>   Merge strategy (default: pr)
  --force             cleanup: force-remove dirty worktree / unmerged branch
  --json              Emit the {ok,data}/{ok,error} envelope
`;

interface ParsedSub {
  positional: string[];
  flags: {
    json: boolean;
    base?: string;
    mode?: string;
    force?: boolean;
    help?: boolean;
  };
}

function parseSub(argv: string[]): ParsedSub {
  const out: ParsedSub = { positional: [], flags: { json: false } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      out.flags.help = true;
      continue;
    }
    if (arg === "--json") {
      out.flags.json = true;
      continue;
    }
    if (arg === "--force") {
      out.flags.force = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) {
      assignFlag(out, arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "--")) {
        assignFlag(out, key, true);
      } else {
        assignFlag(out, key, next);
        i++;
      }
      continue;
    }
    out.positional.push(arg);
  }
  return out;
}

function assignFlag(out: ParsedSub, key: string, val: string | boolean): void {
  switch (key) {
    case "json":
      out.flags.json = val === true || val === "true";
      return;
    case "force":
      out.flags.force = val === true || val === "true";
      return;
    case "base":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--base requires a value");
      }
      out.flags.base = val;
      return;
    case "mode":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--mode requires a value");
      }
      out.flags.mode = val;
      return;
    default:
      throw new CliError(ErrCode.USAGE, `unknown flag: --${key}`);
  }
}

export function handleWorktree(
  argv: string[],
  opts: { json: boolean },
): Result<unknown> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const sub = argv[0]!;
  const rest = argv.slice(1);
  const parsed = parseSub(rest);
  if (parsed.flags.help) return ok({ help: HELP });
  const json = opts.json || parsed.flags.json;

  const slug = parsed.positional[0];
  if (!slug) {
    throw new CliError(ErrCode.USAGE, `yaco worktree ${sub} <slug>`);
  }
  if (parsed.positional.length > 1) {
    throw new CliError(
      ErrCode.USAGE,
      `yaco worktree ${sub}: unexpected argument '${parsed.positional[1]}'`,
    );
  }

  switch (sub) {
    case "create":
      return runCreate(slug, { json, base: parsed.flags.base });
    case "merge": {
      const mode = parsed.flags.mode;
      if (mode !== undefined && mode !== "pr" && mode !== "local") {
        throw new CliError(
          ErrCode.USAGE,
          `--mode must be 'pr' or 'local' (got '${mode}')`,
        );
      }
      return runMerge(slug, { json, mode, base: parsed.flags.base });
    }
    case "cleanup":
      return runCleanup(slug, { json, force: parsed.flags.force });
    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: worktree ${sub}. Run \`yaco worktree --help\`.`,
      );
  }
}
