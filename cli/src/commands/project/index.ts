/** `yaco project <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    move <old-path> <new-path> [--prefix] [--dry-run] [--force]
 *
 *  `move` rekeys cwd-indexed metadata in yaco sessions, the yaco project
 *  registry, `~/.claude/projects/`, `~/.codex/sessions/`, and
 *  `~/.codex/config.toml` after the operator has physically moved the
 *  project. It does NOT touch the project's files.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runMove } from "./move.ts";

const HELP = `yaco project — operations on registered YACO projects

Usage:
  yaco project move <old-path> <new-path> [options]
  yaco project --help

Subcommands:
  move    Rekey project metadata (yaco sessions + registry, ~/.claude/projects,
          ~/.codex/sessions, ~/.codex/config.toml) after the operator has
          moved the project on disk from <old-path> to <new-path>. Does NOT
          move or copy any files at <old-path> or <new-path>.

Flags for 'move':
  --prefix      Also rewrite paths under <old-path> (sub-cwd sessions,
                nested worktrees). Default: only exact-path matches.
  --dry-run     Compute the plan and report what would change without
                touching any file. Recommended on first run.
  --force       Skip the pre-flight refusals (<new-path> must exist,
                <old-path> must not exist). Use only when the operator
                knows the on-disk state.
  --json        Emit the {ok,data}/{ok,error} envelope
`;

interface ParsedSub {
  positional: string[];
  flags: {
    json: boolean;
    prefix?: boolean;
    "dry-run"?: boolean;
    force?: boolean;
    help?: boolean;
  };
}

function parseSub(argv: string[]): ParsedSub {
  const out: ParsedSub = { positional: [], flags: { json: false } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") { out.flags.help = true; continue; }
    if (arg === "--json") { out.flags.json = true; continue; }
    if (arg === "--prefix") { out.flags.prefix = true; continue; }
    if (arg === "--dry-run") { out.flags["dry-run"] = true; continue; }
    if (arg === "--force") { out.flags.force = true; continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      // No move flag takes a value, so any unknown long flag is a usage error.
      throw new CliError(ErrCode.USAGE, `unknown flag for 'project move': --${key}`);
    }
    out.positional.push(arg);
  }
  return out;
}

export function handleProject(
  argv: string[],
  opts: { json: boolean },
): Result<unknown> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const sub = argv[0]!;
  const rest = argv.slice(1);

  if (sub !== "move") {
    throw new CliError(
      ErrCode.USAGE,
      `unknown subcommand: project ${sub}. Run \`yaco project --help\`.`,
    );
  }

  const parsed = parseSub(rest);
  if (parsed.flags.help) return ok({ help: HELP });

  if (parsed.positional.length !== 2) {
    throw new CliError(
      ErrCode.USAGE,
      `yaco project move <old-path> <new-path>`,
    );
  }

  return runMove(parsed.positional[0]!, parsed.positional[1]!, {
    json: opts.json || parsed.flags.json,
    prefix: parsed.flags.prefix === true,
    dryRun: parsed.flags["dry-run"] === true,
    force: parsed.flags.force === true,
  });
}
