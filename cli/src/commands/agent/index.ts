/** `yaco agent <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    start <provider> [yaco-flags] [-- ...passthrough]    Start a session
 *    send <name> "message" | --stdin                      Send a message
 *    capture <name> [--wait]                              Capture pane buffer
 *    status [name] [--all] [...]                          Inspect session state
 *    kill <name> | --all                                  Kill a session
 *    rename <old> <new>                                   Rename an idle session
 *    hooks install                                        Install hook configs
 *    hook-event <EventName>                               Provider hook entry
 *
 *  Provider shortcut policy:
 *    - top-level `yaco claude ...` / `yaco codex ...` — accepted (dispatcher)
 *    - mid-layer `yaco agent claude ...` — REJECTED with USAGE exit 2
 */
import { readFileSync } from "fs";
import { ok, type Result } from "../../lib/core/result.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { PROVIDERS } from "../../lib/core/agent/providers.ts";
import { start } from "./start.ts";
import { send } from "./send.ts";
import { capture } from "./capture.ts";
import { kill } from "./kill.ts";
import { rename } from "./rename.ts";
import { status } from "./status.ts";
import { handleHookEvent } from "./hook-event.ts";
import { handleHooksInstall } from "./hooks/install.ts";

const HELP = `yaco agent — tmux-backed agent sessions

Usage:
  yaco agent start <provider> [yaco-flags] [-- ...passthrough]
  yaco agent send <name> "message"
  yaco agent send <name> --stdin                (read message from stdin)
  yaco agent capture <name> [--wait] [--lines <n>] [--strip-ansi true|false]
  yaco agent status [name] [--all] [--path <p>] [--json]
  yaco agent kill <name> | --all
  yaco agent rename <old> <new>
  yaco agent hooks install
  yaco agent hook-event <EventName>   (called by provider hook runner)

Providers (start): ${Object.keys(PROVIDERS).join(", ")}

In \`start\`, everything after \`--\` is forwarded verbatim to the provider CLI
(yaco flags like \`--json\` only bind before \`--\`).

Use top-level shortcuts \`yaco claude ...\` / \`yaco codex ...\` to start a
session in one step. \`yaco agent <provider>\` (without 'start') is rejected.
`;

interface ParsedSubArgs {
  positional: string[];
  passthrough: string[];
  options: {
    name?: string;
    all: boolean;
    wait: boolean;
    lines?: number;
    stripAnsi: boolean;
    json: boolean;
    path?: string;
    stdin: boolean;
  };
}

function emptyOpts(): ParsedSubArgs["options"] {
  return {
    all: false,
    wait: false,
    stripAnsi: true,
    json: false,
    stdin: false,
  };
}

/** Parse the args for a generic agent subcommand (not start, which uses
 *  passthrough semantics handled separately). */
function parseSubArgs(argv: string[]): ParsedSubArgs {
  const parsed: ParsedSubArgs = {
    positional: [],
    passthrough: [],
    options: emptyOpts(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-n" || arg === "--name") {
      parsed.options.name = argv[++i];
    } else if (arg === "--all") {
      parsed.options.all = true;
    } else if (arg === "--wait") {
      parsed.options.wait = true;
    } else if (arg === "--json") {
      parsed.options.json = true;
    } else if (arg === "--stdin") {
      parsed.options.stdin = true;
    } else if (arg === "--lines") {
      parsed.options.lines = parseInt(argv[++i]!, 10);
    } else if (arg === "--strip-ansi") {
      const val = argv[++i];
      parsed.options.stripAnsi = val !== "false";
    } else if (arg === "--path") {
      parsed.options.path = argv[++i];
    } else if (arg.startsWith("--name=")) {
      parsed.options.name = arg.slice("--name=".length);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

/** Parse the args for `start <provider> [yaco-flags] [-- ...passthrough]`.
 *
 *  Per CLI contract: everything after the first standalone `--` is forwarded
 *  verbatim to the provider CLI. Before `--`, yaco binds only its own known
 *  flags (currently just `--json`); any other token is treated as passthrough
 *  to keep backward compatibility with callers that omit the `--`. */
export function parseStartArgs(argv: string[]): {
  provider: string | undefined;
  passthrough: string[];
  json: boolean;
} {
  const provider = argv[0];
  const rest = argv.slice(1);
  const sepIdx = rest.indexOf("--");
  const yacoSide = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
  const afterSep = sepIdx >= 0 ? rest.slice(sepIdx + 1) : [];

  let json = false;
  const beforeSepPassthrough: string[] = [];
  for (const arg of yacoSide) {
    if (arg === "--json") {
      json = true;
    } else {
      beforeSepPassthrough.push(arg);
    }
  }
  return {
    provider,
    passthrough: [...beforeSepPassthrough, ...afterSep],
    json,
  };
}

export async function runStart(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  const { provider, passthrough, json } = parseStartArgs(argv);
  if (!provider) {
    throw new CliError(
      ErrCode.USAGE,
      "yaco agent start requires a provider (e.g. `yaco agent start claude`)",
    );
  }
  if (!(provider in PROVIDERS)) {
    throw new CliError(
      ErrCode.USAGE,
      `unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  const state = start(provider, passthrough, undefined);
  if (json || opts.json) return ok(state);
  return ok({ handle: state.handle, state });
}

/** Read process.stdin to end-of-stream, returning the full payload as a UTF-8
 *  string. Used by `yaco agent send --stdin`. */
function readAllStdin(): string {
  return readFileSync(0, "utf-8");
}

export async function handleAgent(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const sub = argv[0]!;
  const rest = argv.slice(1);

  // Provider shortcut policy — mid-layer `yaco agent claude ...` is REJECTED.
  // Top-level `yaco claude ...` is handled by the dispatcher and never lands here.
  if (sub in PROVIDERS) {
    throw new CliError(
      ErrCode.USAGE,
      `\`yaco agent ${sub}\` is not a valid shortcut. ` +
        `Use \`yaco agent start ${sub} ...\` (canonical) or \`yaco ${sub} ...\` (top-level shortcut).`,
    );
  }

  switch (sub) {
    case "start":
      return runStart(rest, opts);

    case "send": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(ErrCode.USAGE, 'yaco agent send <name> "message" | --stdin');
      }
      let message: string;
      if (parsed.options.stdin) {
        if (parsed.positional.length > 1) {
          throw new CliError(
            ErrCode.USAGE,
            "yaco agent send: --stdin and inline message are mutually exclusive",
          );
        }
        message = readAllStdin();
      } else {
        message = parsed.positional.slice(1).join(" ");
      }
      if (!message) {
        throw new CliError(ErrCode.USAGE, 'yaco agent send <name> "message" | --stdin');
      }
      send(name, message);
      return ok({ sent: { name, length: message.length } });
    }

    case "capture": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(ErrCode.USAGE, "yaco agent capture <name> [--wait] [--lines <n>]");
      }
      const output = await capture(name, {
        wait: parsed.options.wait,
        lines: parsed.options.lines,
        stripAnsiCodes: parsed.options.stripAnsi,
      });
      // Dual mode: text-mode renderer recognizes `text` and writes it raw;
      // JSON mode wraps as { ok: true, data: { text: "..." } }.
      return ok({ text: output });
    }

    case "kill": {
      const parsed = parseSubArgs(rest);
      if (parsed.options.all) {
        if (parsed.positional.length > 0) {
          throw new CliError(ErrCode.USAGE, "yaco agent kill --all takes no positional");
        }
        kill(undefined, { all: true });
        return ok({ killed: "all" });
      }
      const name = parsed.positional[0];
      if (!name || parsed.positional.length !== 1) {
        throw new CliError(ErrCode.USAGE, "yaco agent kill <name> | --all");
      }
      kill(name);
      return ok({ killed: name });
    }

    case "status": {
      const parsed = parseSubArgs(rest);
      const json = parsed.options.json || opts.json;
      const output = status(parsed.positional[0], {
        json,
        all: parsed.options.all,
        path: parsed.options.path,
      });
      // status() returns a string (JSON or text). Pre-parse for JSON envelope.
      if (json) {
        return ok(JSON.parse(output));
      }
      return ok({ help: output });
    }

    case "rename": {
      const parsed = parseSubArgs(rest);
      const oldName = parsed.positional[0];
      const newName = parsed.positional[1];
      if (!oldName || !newName || parsed.positional.length !== 2) {
        throw new CliError(ErrCode.USAGE, "yaco agent rename <old-name> <new-name>");
      }
      rename(oldName, newName);
      return ok({ renamed: { from: oldName, to: newName } });
    }

    case "hooks": {
      const action = rest[0];
      if (!action || action === "--help" || action === "-h") {
        return ok({ help: "yaco agent hooks install\n" });
      }
      if (action !== "install") {
        throw new CliError(
          ErrCode.USAGE,
          `unknown subcommand: agent hooks ${action}. Run \`yaco agent hooks --help\`.`,
        );
      }
      return handleHooksInstall(rest.slice(1));
    }

    case "hook-event":
      return handleHookEvent(rest);

    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: agent ${sub}. Run \`yaco agent --help\`.`,
      );
  }
}
