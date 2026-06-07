/** `yaco agent <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    start <provider> [yaco-flags] [-- ...passthrough]    Start a session
 *    send <name> "message" | --stdin                      Send a message
 *    capture <name>                                       Capture pane buffer
 *    list [--all] [--path <p>]                             List live sessions
 *    status <name>                                         Inspect one session
 *    whoami                                                Print current agent handle
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
import { start, extractResume } from "./start.ts";
import { send } from "./send.ts";
import { capture } from "./capture.ts";
import { kill } from "./kill.ts";
import { rename } from "./rename.ts";
import { status, list } from "./status.ts";
import { whoami } from "./whoami.ts";
import { runHistory } from "./history.ts";
import { runSummaries } from "./summaries.ts";
import { runProviders } from "./providers.ts";
import { runOutputCursor, runOutputFollow, parseOutputFollowArgs, OUTPUT_FOLLOW_USAGE } from "./output.ts";
import {
  parseTimeoutMs,
  resolveResumeCursor,
  resolveSendWaitOrigin,
  waitForAgentCompletion,
  type WaitOrigin,
} from "./output.ts";
import { parseWaitArgs, runWait, WAIT_USAGE } from "./wait.ts";
import { handleHookEvent } from "./hook-event.ts";
import { handleHooksInstall } from "./hooks/install.ts";

const HELP = `yaco agent — tmux-backed agent sessions

Usage:
  yaco agent start <provider> [yaco-flags] [--wait [--timeout-ms <ms>]] [-- ...passthrough]
  yaco agent send <name> "message" [--wait [--timeout-ms <ms>]]
  yaco agent send <name> --stdin                (read message from stdin)
  yaco agent wait <name> (--from-start | --cursor <token> --offset <bytes>) [--timeout-ms <ms>] [--json]
  yaco agent capture <name> [--lines <n>] [--strip-ansi true|false]
  yaco agent list [--all] [--path <p>] [--json]
  yaco agent status <name> [--json]
  yaco agent whoami [--json]
  yaco agent history --path <project-path> [--json]
  yaco agent summaries --path <project-path> [--json]
  yaco agent providers [--json]
  yaco agent output-cursor <name> [--json]
  yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>] [--json]
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
    timeoutMs?: number;
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
    } else if (arg === "--timeout-ms") {
      parsed.options.timeoutMs = parseTimeoutMs(argv[++i]);
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.options.timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length));
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
  wait: boolean;
  timeoutMs?: number;
} {
  const provider = argv[0];
  const rest = argv.slice(1);
  const sepIdx = rest.indexOf("--");
  const yacoSide = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
  const afterSep = sepIdx >= 0 ? rest.slice(sepIdx + 1) : [];

  let json = false;
  let wait = false;
  let timeoutMs: number | undefined;
  const beforeSepPassthrough: string[] = [];
  for (let i = 0; i < yacoSide.length; i++) {
    const arg = yacoSide[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout-ms") {
      timeoutMs = parseTimeoutMs(yacoSide[++i]);
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length));
    } else {
      beforeSepPassthrough.push(arg);
    }
  }

  // `--wait` / `--timeout-ms` are YACO-side flags wherever they appear: a
  // post-`--` occurrence must still be consumed here and NEVER forwarded to the
  // provider CLI. `--json` after `--` stays provider-side (unchanged).
  const afterSepPassthrough: string[] = [];
  for (let i = 0; i < afterSep.length; i++) {
    const arg = afterSep[i]!;
    if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout-ms") {
      timeoutMs = parseTimeoutMs(afterSep[++i]);
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length));
    } else {
      afterSepPassthrough.push(arg);
    }
  }
  return {
    provider,
    passthrough: [...beforeSepPassthrough, ...afterSepPassthrough],
    json,
    wait,
    timeoutMs,
  };
}

export async function runStart(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  const { provider, passthrough, json, wait, timeoutMs } = parseStartArgs(argv);
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

  if (wait) {
    // Pick the wait origin BEFORE launching. A resumed session must wait from a
    // cursor captured at the resume log's current EOF, or we risk replaying its
    // old final answer; if that cursor cannot be resolved, fail rather than
    // return a stale answer. A fresh session waits from provider-log start.
    let origin: WaitOrigin;
    const resumeId = extractResume(passthrough);
    if (resumeId) {
      const pre = await resolveResumeCursor(provider, resumeId, process.cwd());
      if (!pre) {
        throw new CliError(
          ErrCode.NOT_FOUND,
          `cannot resolve resume cursor for "${provider}" session "${resumeId}"`,
        );
      }
      origin = { kind: "cursor", token: pre.token, offset: pre.offset };
    } else {
      origin = { kind: "from-start" };
    }
    const state = start(provider, passthrough, undefined);
    return ok(await waitForAgentCompletion(state.handle, origin, { timeoutMs }));
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
      if (parsed.options.wait) {
        // Pick the wait origin BEFORE sending so a fast reply cannot land
        // between send and wait. resolveSendWaitOrigin waits from log start only
        // when no provider log existed before the send (Codex pending first
        // turn); it fails rather than risk replaying an old final answer when a
        // resolved session's cursor is only momentarily unresolved.
        const origin = await resolveSendWaitOrigin(name);
        send(name, message);
        return ok(await waitForAgentCompletion(name, origin, { timeoutMs: parsed.options.timeoutMs }));
      }
      send(name, message);
      return ok({ sent: { name, length: message.length } });
    }

    case "wait": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: `${WAIT_USAGE}\n` });
      }
      const waitArgs = parseWaitArgs(rest);
      return ok(await runWait(waitArgs));
    }

    case "capture": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(ErrCode.USAGE, "yaco agent capture <name> [--lines <n>]");
      }
      if (parsed.options.wait) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco agent capture is a diagnostic snapshot. Use `yaco agent wait` for completion.",
        );
      }
      const output = await capture(name, {
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

    case "list": {
      const parsed = parseSubArgs(rest);
      if (parsed.options.all && parsed.options.path !== undefined) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco agent list: --all and --path are mutually exclusive",
        );
      }
      const json = parsed.options.json || opts.json;
      const output = list({
        json,
        all: parsed.options.all,
        path: parsed.options.path,
      });
      // list() returns a string (JSON array or text table). Pre-parse for the
      // JSON envelope so the dispatcher emits one `{ok,data:[...]}` line.
      if (json) {
        return ok(JSON.parse(output));
      }
      return ok({ help: output });
    }

    case "status": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco agent status <name> [--json]. Use `yaco agent list` to enumerate sessions.",
        );
      }
      const json = parsed.options.json || opts.json;
      const output = status(name, { json });
      // status() returns a string (JSON or text). Pre-parse for JSON envelope.
      if (json) {
        return ok(JSON.parse(output));
      }
      return ok({ help: output });
    }

    case "whoami": {
      const parsed = parseSubArgs(rest);
      if (parsed.positional.length > 0) {
        throw new CliError(ErrCode.USAGE, "yaco agent whoami [--json]");
      }

      const identity = whoami();
      if (!identity) {
        throw new CliError(
          ErrCode.NOT_FOUND,
          "current process is not inside a yaco-managed agent session",
        );
      }

      if (parsed.options.json || opts.json) return ok(identity);
      return ok({ text: identity.handle });
    }

    case "history": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent history --path <project-path> [--json]\n" });
      }
      const parsed = parseSubArgs(rest);
      const projectPath = parsed.options.path ?? process.cwd();
      return ok(await runHistory(projectPath));
    }

    case "summaries": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent summaries --path <project-path> [--json]\n" });
      }
      const parsed = parseSubArgs(rest);
      const projectPath = parsed.options.path ?? process.cwd();
      return ok(await runSummaries(projectPath));
    }

    case "providers": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent providers [--json]\n" });
      }
      return ok(runProviders());
    }

    case "output-cursor": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent output-cursor <name> [--json]\n" });
      }
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(ErrCode.USAGE, "yaco agent output-cursor <name> [--json]");
      }
      return ok(await runOutputCursor(name));
    }

    case "output-follow": {
      // Help is only a STANDALONE request: exactly `--help`/`-h` (the global
      // `--json` is parsed separately by the dispatcher). A `--help`/`-h` that
      // appears as a flag value — e.g. `--cursor --help` — is NOT help; it falls
      // through to strict parsing and fails as USAGE before any stream.
      const nonGlobal = rest.filter((a) => a !== "--json");
      if (nonGlobal.length === 1 && (nonGlobal[0] === "--help" || nonGlobal[0] === "-h")) {
        return ok({ help: `${OUTPUT_FOLLOW_USAGE}\n` });
      }
      // A dedicated strict-allowlist parser: only the handle, --cursor/--cursor=,
      // --offset/--offset=, and --json are accepted. Generic agent flags and any
      // other token fail with USAGE here — before any frame is written — and
      // --offset is validated so a bad value never reaches the follower as NaN.
      const followArgs = parseOutputFollowArgs(rest);
      // output-follow is a persistent NDJSON stdout stream, not a single
      // envelope: frames are written directly and the process exits when the
      // stream ends, so render() never appends a trailing envelope. Setup
      // errors (unknown name / no log) still surface before any frame is
      // written and route through the normal error envelope.
      const signal = { aborted: false };
      const abort = () => {
        signal.aborted = true;
      };
      process.once("SIGTERM", abort);
      process.once("SIGINT", abort);
      // Reader closed the pipe (EPIPE) — stop without a stack trace.
      process.stdout.once("error", () => process.exit(0));
      await runOutputFollow(
        followArgs,
        { write: (line) => process.stdout.write(line) },
        signal,
      );
      process.exit(0);
    }

    case "rename": {
      const parsed = parseSubArgs(rest);
      const oldName = parsed.positional[0];
      const newName = parsed.positional[1];
      if (!oldName || !newName || parsed.positional.length !== 2) {
        throw new CliError(ErrCode.USAGE, "yaco agent rename <old-name> <new-name>");
      }
      const outcome = await rename(oldName, newName);
      return ok({
        renamed: { from: oldName, to: newName },
        childSessions: outcome.childSessions,
        tasks: outcome.tasks,
        warnings: outcome.warnings,
      });
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
