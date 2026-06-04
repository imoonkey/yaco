/** `yaco task <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    set <id> --data | --stdin | --file [--repo <p>] [--json]
 *    rm <id> [--repo <p>] [--json]
 *    archive <id> [--repo <p>] [--json]
 *    validate [--id <id>] [--repo <p>] [--json]
 *    list [--repo <p>] [--json]
 *
 *  Every subcommand goes through readYacoProjectPaths(repoRoot) for the
 *  tasks file location — fixes the long-standing update-tasks.py bug
 *  that hardcoded `projects/tasks.json`.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runArchive } from "./archive.ts";
import { runList } from "./list.ts";
import { runRm } from "./rm.ts";
import { runSet } from "./set.ts";
import { runValidate } from "./validate.ts";

const HELP = `yaco task — read and mutate the project task graph

Usage:
  yaco task set <id> --data '<json>' [--repo <p>] [--json]
  yaco task set <id> --stdin           [--repo <p>] [--json]
  yaco task set <id> --file <path>     [--repo <p>] [--json]
  yaco task rm <id>                    [--repo <p>] [--json]
  yaco task archive <id>               [--repo <p>] [--json]
  yaco task validate [--id <id>]       [--repo <p>] [--json]
  yaco task list                       [--repo <p>] [--json]

Flags:
  --data '<json>'   Inline JSON payload (mutually exclusive with --stdin/--file)
  --stdin           Read JSON payload from stdin
  --file <path>     Read JSON payload from a file
  --id <id>         Narrow \`validate\` to one task + its parent chain
  --repo <path>     Override repo root (defaults to cwd)
  --json            Emit the {ok,data}/{ok,error} envelope
`;

interface ParsedSub {
  positional: string[];
  flags: {
    json: boolean;
    repo?: string | boolean;
    data?: string;
    stdin?: boolean;
    file?: string;
    id?: string;
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
    if (arg === "--stdin") {
      out.flags.stdin = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) {
      const key = arg.slice(2, eq);
      const val = arg.slice(eq + 1);
      assignFlag(out, key, val);
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "--")) {
        // Treat as boolean flag — unknown flags fall through to USAGE later.
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
    case "data":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--data requires a value");
      }
      out.flags.data = val;
      return;
    case "file":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--file requires a value");
      }
      out.flags.file = val;
      return;
    case "id":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--id requires a value");
      }
      out.flags.id = val;
      return;
    case "repo":
      if (typeof val !== "string") {
        throw new CliError(ErrCode.USAGE, "--repo requires a value");
      }
      out.flags.repo = val;
      return;
    default:
      throw new CliError(ErrCode.USAGE, `unknown flag: --${key}`);
  }
}

export async function handleTask(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const sub = argv[0]!;
  const rest = argv.slice(1);
  const parsed = parseSub(rest);
  if (parsed.flags.help) return ok({ help: HELP });
  const json = opts.json || parsed.flags.json;

  switch (sub) {
    case "set": {
      const id = parsed.positional[0];
      if (!id) throw new CliError(ErrCode.USAGE, "yaco task set <id> --data|--stdin|--file");
      if (parsed.positional.length > 1) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco task set: positional JSON is not supported; use --data, --stdin, or --file",
        );
      }
      return runSet(id, {
        json,
        data: parsed.flags.data,
        stdin: parsed.flags.stdin,
        file: parsed.flags.file,
        repo: parsed.flags.repo,
      });
    }
    case "rm": {
      const id = parsed.positional[0];
      if (!id || parsed.positional.length !== 1) {
        throw new CliError(ErrCode.USAGE, "yaco task rm <id>");
      }
      return runRm(id, { json, repo: parsed.flags.repo });
    }
    case "archive": {
      const id = parsed.positional[0];
      if (!id || parsed.positional.length !== 1) {
        throw new CliError(ErrCode.USAGE, "yaco task archive <id>");
      }
      return runArchive(id, { json, repo: parsed.flags.repo });
    }
    case "validate": {
      if (parsed.positional.length > 0) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco task validate takes no positional args (use --id <id>)",
        );
      }
      return runValidate({ json, id: parsed.flags.id, repo: parsed.flags.repo });
    }
    case "list": {
      if (parsed.positional.length > 0) {
        throw new CliError(ErrCode.USAGE, "yaco task list takes no positional args");
      }
      return runList({ json, repo: parsed.flags.repo });
    }
    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: task ${sub}. Run \`yaco task --help\`.`,
      );
  }
}
