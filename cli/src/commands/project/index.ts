/** `yaco project <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    list
 *    current
 *    add    <name> <absolute-path>
 *    remove <name>
 *    move   <old-path> <new-path> [--prefix] [--dry-run] [--force]
 *
 *  `list`/`add`/`remove` are the conventional registry surface over
 *  ${YACO_HOME}/projects.json. `move` rekeys cwd-indexed metadata in yaco
 *  sessions, the yaco project registry, `~/.claude/projects/`,
 *  `~/.codex/sessions/`, and `~/.codex/config.toml` after the operator has
 *  physically moved the project. It does NOT touch the project's files.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runList } from "./list.ts";
import { runCurrent } from "./current.ts";
import { runAdd } from "./add.ts";
import { runRemove } from "./remove.ts";
import { runMove } from "./move.ts";

const HELP = `yaco project — operations on registered YACO projects

Usage:
  yaco project list
  yaco project current
  yaco project add <name> <absolute-path>
  yaco project remove <name>
  yaco project move <old-path> <new-path> [options]
  yaco project --help

Subcommands:
  list    List registered projects (and the registry file path under --json).
  current Resolve the current directory to its owning registered project
          (longest-prefix, canonicalized match). NOT_FOUND when unregistered.
  add     Register <name> -> <absolute-path>. Validates a URL-safe name and an
          absolute existing directory; rejects duplicate names and paths.
  remove  Unregister a project by name.
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

function parseSub(argv: string[], sub: string): ParsedSub {
  const out: ParsedSub = { positional: [], flags: { json: false } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") { out.flags.help = true; continue; }
    if (arg === "--json") { out.flags.json = true; continue; }
    if (arg === "--prefix" || arg === "--dry-run" || arg === "--force") {
      // Move-only flags: reject them on every other subcommand rather than
      // silently accepting (and ignoring) them.
      if (sub !== "move") {
        throw new CliError(ErrCode.USAGE, `unknown flag for 'project ${sub}': ${arg}`);
      }
      if (arg === "--prefix") out.flags.prefix = true;
      else if (arg === "--dry-run") out.flags["dry-run"] = true;
      else out.flags.force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      throw new CliError(ErrCode.USAGE, `unknown flag for 'project ${sub}': --${key}`);
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
  const parsed = parseSub(rest, sub);
  if (parsed.flags.help) return ok({ help: HELP });

  const json = opts.json || parsed.flags.json;

  switch (sub) {
    case "list":
      return runList({ json });

    case "current":
      if (parsed.positional.length !== 0) {
        throw new CliError(ErrCode.USAGE, `yaco project current`);
      }
      return runCurrent({ json });

    case "add":
      if (parsed.positional.length !== 2) {
        throw new CliError(
          ErrCode.USAGE,
          `yaco project add <name> <absolute-path>`,
        );
      }
      return runAdd(parsed.positional[0]!, parsed.positional[1]!, { json });

    case "remove":
      if (parsed.positional.length !== 1) {
        throw new CliError(ErrCode.USAGE, `yaco project remove <name>`);
      }
      return runRemove(parsed.positional[0]!, { json });

    case "move":
      if (parsed.positional.length !== 2) {
        throw new CliError(
          ErrCode.USAGE,
          `yaco project move <old-path> <new-path>`,
        );
      }
      return runMove(parsed.positional[0]!, parsed.positional[1]!, {
        json,
        prefix: parsed.flags.prefix === true,
        dryRun: parsed.flags["dry-run"] === true,
        force: parsed.flags.force === true,
      });

    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: project ${sub}. Run \`yaco project --help\`.`,
      );
  }
}
