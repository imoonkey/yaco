/** `yaco paths` — print canonical runtime and project paths.
 *
 *  Subcommands:
 *    runtime   ${YACO_HOME} and the helpers rooted there
 *    project   repo-relative paths from yaco.toml [paths] (or defaults)
 *
 *  Both subcommands return a flat object keyed by the helper name, so a
 *  consumer can write `(yaco paths runtime --json).sessionsDir`.
 *  Malformed yaco.toml surfaces as ENV (exit 3) via readYacoProjectPaths.
 */

import { resolve } from "node:path";

import { parseArgs } from "../lib/core/args.ts";
import { CliError, ErrCode } from "../lib/core/errors.ts";
import { ok, type Result } from "../lib/core/result.ts";
import {
  agentWrapperPath,
  channelsDir,
  getYacoHome,
  projectsFile,
  readYacoProjectPaths,
  sessionsDir,
  shellSessionsDir,
  uiStateDir,
} from "../lib/core/paths/index.ts";

const HELP = `yaco paths — resolve canonical YACO paths

Usage:
  yaco paths runtime [--json]
  yaco paths project [--json] [--repo <path>]

Subcommands:
  runtime  YACO_HOME and the runtime directories rooted under it
  project  Repo-relative paths from yaco.toml [paths] (or defaults)

Flags for 'project':
  --repo <path>   Override the repo root (defaults to cwd)
`;

export interface RuntimePaths {
  yacoHome: string;
  projectsFile: string;
  sessionsDir: string;
  uiStateDir: string;
  shellSessionsDir: string;
  channelsDir: string;
  agentWrapperPath: string;
}

function runtimePaths(): RuntimePaths {
  return {
    yacoHome: getYacoHome(),
    projectsFile: projectsFile(),
    sessionsDir: sessionsDir(),
    uiStateDir: uiStateDir(),
    shellSessionsDir: shellSessionsDir(),
    channelsDir: channelsDir(),
    agentWrapperPath: agentWrapperPath(),
  };
}

export async function handlePaths(
  argv: string[],
  _opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "runtime":
      if (rest.some((t) => t === "--help" || t === "-h")) {
        return ok({ help: HELP });
      }
      return ok(runtimePaths());

    case "project": {
      if (rest.some((t) => t === "--help" || t === "-h")) {
        return ok({ help: HELP });
      }
      const parsed = parseArgs(rest);
      const repo = resolveRepoFlag(parsed.flags["repo"]);
      const relative = readYacoProjectPaths(repo);
      return ok({
        tasks: resolve(repo, relative.tasks),
        active: resolve(repo, relative.active),
        archive: resolve(repo, relative.archive),
        worktrees: resolve(repo, relative.worktrees),
      });
    }

    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: paths ${sub}. Run \`yaco paths --help\`.`,
      );
  }
}

/** Validate the `--repo` flag and resolve it to an absolute path.
 *  Absent → cwd. Present but missing a value (`--repo` alone, or
 *  followed by another flag) → USAGE error so the contract holds. */
function resolveRepoFlag(value: string | boolean | undefined): string {
  if (value === undefined) return resolve(process.cwd());
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(ErrCode.USAGE, `--repo requires a value`);
  }
  return resolve(value);
}
