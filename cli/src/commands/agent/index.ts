/** `yaco agent <subcommand>` — area dispatcher.
 *
 *  Subcommands:
 *    start <provider> [yaco-flags] [-- ...passthrough]    Start a session
 *    send <name> "message" | --stdin                      Send a message
 *    capture <name>                                       Capture pane buffer
 *    list [--all] [--path <p>] [--reconcile]              List live sessions
 *    status <name> [--reconcile]                          Inspect one session
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
import { dual } from "../../lib/core/render.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { PROVIDERS } from "../../lib/core/agent/providers.ts";
import { validateName } from "../../lib/core/agent/model.ts";
import { waitForInputEmptyThenSend } from "../../lib/core/agent/tmux.ts";
import { start, extractResume } from "./start.ts";
import { send } from "./send.ts";
import { capture } from "./capture.ts";
import { kill } from "./kill.ts";
import { markCrashed } from "./mark-crashed.ts";
import { rename } from "./rename.ts";
import { status, list } from "./status.ts";
import { whoami } from "./whoami.ts";
import { HISTORY_USAGE, parseHistoryArgs, runHistory, renderHistory } from "./history.ts";
import { runSummaries, renderSummaries } from "./summaries.ts";
import { runProviders, renderProviders } from "./providers.ts";
import { runOutputCursor, runOutputFollow, parseOutputFollowArgs, OUTPUT_FOLLOW_USAGE } from "./output.ts";
import { parseMessagesArgs, runMessages, renderMessages, MESSAGES_USAGE } from "./messages.ts";
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
  yaco agent list [--all] [--path <p>] [--reconcile] [--json]
  yaco agent status <name> [--reconcile] [--json]
  yaco agent whoami [--json]
  yaco agent history [--path <project-path>] [--since <iso>] [--limit <n>] [--json]
  yaco agent summaries --path <project-path> [--json]
  yaco agent providers [--json]
  yaco agent output-cursor <name> [--json]
  yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>] [--json]
  yaco agent messages <name> [--meta|--index <i>|--summary] [--role r] [--type t] [--range a..b] [--preview[=N]] [--ts] [--json]
  yaco agent kill <name> | --all
  yaco agent rename <old> <new>
  yaco agent mark-crashed <name> --exit <code> --created-at <ts>   (called by the wrapper EXIT trap)
  yaco agent hooks install
  yaco agent hook-event <EventName>   (called by provider hook runner)

Providers (start): ${Object.keys(PROVIDERS).join(", ")}

In \`start\`, everything after \`--\` is forwarded verbatim to the provider CLI
(yaco flags like \`--json\` only bind before \`--\`).

Use top-level shortcuts \`yaco claude ...\` / \`yaco codex ...\` to start a
session in one step. \`yaco agent <provider>\` (without 'start') is rejected.

\`list\` and \`status\` are pure reads. \`--reconcile\` opts into the mutating
pass: GC confirmed-dead tombstones and persist stale-status corrections (the
app server's 60s loop is the intended reconcile caller).
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
    reconcile: boolean;
  };
}

function emptyOpts(): ParsedSubArgs["options"] {
  return {
    all: false,
    wait: false,
    stripAnsi: true,
    json: false,
    stdin: false,
    reconcile: false,
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
    } else if (arg === "--reconcile") {
      parsed.options.reconcile = true;
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
    const result = await waitForAgentCompletion(state.handle, origin, { timeoutMs });
    // Text mode prints the reply text raw (pipe-friendly); --json keeps the
    // AgentCompletionResult record.
    return dual(json || opts.json, result, () => result.text);
  }

  const state = start(provider, passthrough, undefined);
  // Text mode prints the handle raw (pipe-friendly); --json keeps the full
  // session-state record so callers can read pid/sessionId/path etc.
  return dual(json || opts.json, state, () => `${state.handle}\n`);
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
    case "_send-when-input-empty": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      const provider = parsed.positional[1];
      const input = parsed.positional.slice(2).join(" ");
      if (!name || !provider || !input) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco agent _send-when-input-empty <name> <provider> <input>",
        );
      }
      validateName(name);
      if (!(provider in PROVIDERS)) {
        throw new CliError(ErrCode.USAGE, `unknown provider: ${provider}`);
      }
      const result = waitForInputEmptyThenSend(name, provider, input, parsed.options.timeoutMs);
      return dual(
        parsed.options.json || opts.json,
        { result },
        () => `${result}\n`,
      );
    }

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
        const result = await waitForAgentCompletion(name, origin, { timeoutMs: parsed.options.timeoutMs });
        return dual(parsed.options.json || opts.json, result, () => result.text);
      }
      send(name, message);
      return dual(
        parsed.options.json || opts.json,
        { sent: { name, length: message.length } },
        () => `sent to ${name} (${message.length} bytes)\n`,
      );
    }

    case "wait": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: `${WAIT_USAGE}\n` });
      }
      const waitArgs = parseWaitArgs(rest);
      const result = await runWait(waitArgs);
      return dual(opts.json, result, () => result.text);
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
      const json = parsed.options.json || opts.json;
      if (parsed.options.all) {
        if (parsed.positional.length > 0) {
          throw new CliError(ErrCode.USAGE, "yaco agent kill --all takes no positional");
        }
        kill(undefined, { all: true });
        return dual(json, { killed: "all" }, () => `killed all sessions\n`);
      }
      const name = parsed.positional[0];
      if (!name || parsed.positional.length !== 1) {
        throw new CliError(ErrCode.USAGE, "yaco agent kill <name> | --all");
      }
      kill(name);
      return dual(json, { killed: name }, () => `killed ${name}\n`);
    }

    case "mark-crashed": {
      // Internal: the wrapper EXIT trap calls this on a non-zero agent exit that
      // is not an intentional kill. Generation/sentinel-guarded inside.
      const handle = rest[0];
      if (!handle) {
        throw new CliError(ErrCode.USAGE, "yaco agent mark-crashed <name> --exit <code> --created-at <ts>");
      }
      validateName(handle);
      let exitCode: number | undefined;
      let createdAt: string | undefined;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--exit") exitCode = Number(rest[++i]);
        else if (rest[i] === "--created-at") createdAt = rest[++i];
      }
      if (exitCode === undefined || Number.isNaN(exitCode) || !createdAt) {
        throw new CliError(ErrCode.USAGE, "yaco agent mark-crashed <name> --exit <code> --created-at <ts>");
      }
      const marked = markCrashed(handle, exitCode, createdAt);
      return dual(opts.json, { marked, handle }, () => `${marked ? "marked crashed" : "no-op"}: ${handle}\n`);
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
      const output = await list({
        json,
        all: parsed.options.all,
        path: parsed.options.path,
        reconcile: parsed.options.reconcile,
      });
      // list() returns a string (JSON array or text table). Pre-parse for the
      // JSON envelope so the dispatcher emits one `{ok,data:[...]}` line.
      if (json) {
        return ok(JSON.parse(output));
      }
      return ok({ text: output });
    }

    case "status": {
      const parsed = parseSubArgs(rest);
      const name = parsed.positional[0];
      if (!name) {
        throw new CliError(
          ErrCode.USAGE,
          "yaco agent status <name> [--reconcile] [--json]. Use `yaco agent list` to enumerate sessions.",
        );
      }
      const json = parsed.options.json || opts.json;
      const output = await status(name, { json, reconcile: parsed.options.reconcile });
      // status() returns a string (JSON or the text detail block). Pre-parse for
      // the JSON envelope; text mode carries the block raw via `{text}`.
      if (json) {
        return ok(JSON.parse(output));
      }
      return ok({ text: output });
    }

    case "whoami": {
      const parsed = parseSubArgs(rest);
      if (parsed.positional.length > 0) {
        throw new CliError(ErrCode.USAGE, "yaco agent whoami [--json]");
      }

      const identity = await whoami();
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
      const nonGlobal = rest.filter((a) => a !== "--json");
      if (nonGlobal.length === 1 && (nonGlobal[0] === "--help" || nonGlobal[0] === "-h")) {
        return ok({ help: `${HISTORY_USAGE}\n` });
      }
      const parsed = parseHistoryArgs(rest);
      const result = await runHistory(parsed.projectPath, { limit: parsed.limit, since: parsed.since });
      return dual(parsed.json || opts.json, result, () => renderHistory(result.rows));
    }

    case "summaries": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent summaries --path <project-path> [--json]\n" });
      }
      const parsed = parseSubArgs(rest);
      const projectPath = parsed.options.path ?? process.cwd();
      const summaries = await runSummaries(projectPath);
      return dual(parsed.options.json || opts.json, summaries, () => renderSummaries(summaries));
    }

    case "messages": {
      // Standalone help only (the global --json aside); a --help appearing as a
      // flag value falls through to strict parsing → USAGE, like output-follow.
      const nonGlobal = rest.filter((a) => a !== "--json");
      if (nonGlobal.length === 1 && (nonGlobal[0] === "--help" || nonGlobal[0] === "-h")) {
        return ok({ help: `${MESSAGES_USAGE}\n` });
      }
      const parsed = parseMessagesArgs(rest);
      const json = rest.includes("--json") || opts.json;
      const result = await runMessages(parsed);
      return dual(json, result, () => renderMessages(parsed, result));
    }

    case "providers": {
      if (rest.includes("--help") || rest.includes("-h")) {
        return ok({ help: "yaco agent providers [--json]\n" });
      }
      const catalog = runProviders();
      return dual(opts.json, catalog, () => renderProviders(catalog));
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
      const cursor = await runOutputCursor(name);
      return dual(parsed.options.json || opts.json, cursor, () => `${cursor.token} ${cursor.offset}\n`);
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
      const json = parsed.options.json || opts.json;
      if (!json) {
        for (const w of outcome.warnings) process.stderr.write(`warning: ${w}\n`);
      }
      return dual(
        json,
        {
          renamed: { from: oldName, to: newName },
          childSessions: outcome.childSessions,
          tasks: outcome.tasks,
          warnings: outcome.warnings,
        },
        () => `renamed '${oldName}' -> '${newName}'\n`,
      );
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
      return handleHooksInstall(rest.slice(1), opts.json);
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
