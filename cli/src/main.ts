/** yaco — unified CLI dispatcher.
 *
 *  This file is the bundle entry. It owns argv intake, help text, and routing
 *  to one of the eight top-level areas. Each area module is responsible for
 *  parsing its own subcommands and producing a Result.
 *
 *  It does not decide whether it is being run: `bin/yaco.mjs` is the executable
 *  and calls {@link main}. Importing this module — which the export audit and a
 *  handful of tests do — must never execute a command, so there is no
 *  self-invocation branch here.
 */

import { parseArgs } from "./lib/core/args.ts";
import { ok, isErr, type Result } from "./lib/core/result.ts";
import { CliError, ErrCode, exitCodeFor, toErr } from "./lib/core/errors.ts";
import { emit } from "./lib/core/json.ts";
import { handlePaths } from "./commands/paths.ts";
import { handleAgent, runStart } from "./commands/agent/index.ts";
import { handleHookEvent } from "./commands/agent/hook-event.ts";
import { handleTask } from "./commands/task/index.ts";
import { handleWorktree } from "./commands/worktree/index.ts";
import { handleAlign } from "./commands/align/index.ts";
import { handleInit } from "./commands/init.ts";
import { handleInstall } from "./commands/install.ts";
import { handleDoctor } from "./commands/doctor.ts";
import { handleGate } from "./commands/gate.ts";
import { handleProject } from "./commands/project/index.ts";
import { handlePlan } from "./commands/plan/index.ts";
import { PROVIDERS } from "./lib/core/agent/providers.ts";

const AREAS = [
  "agent",
  "task",
  "worktree",
  "align",
  "init",
  "install",
  "doctor",
  "paths",
  "project",
  "plan",
  "gate",
] as const;
type Area = (typeof AREAS)[number];

const AREA_HELP: Record<Area, string> = {
  agent: "Start / send / capture / kill / status / rename tmux-backed agent sessions",
  task: "Read and mutate the project task graph",
  worktree: "Create, merge, and clean up git worktrees per task slug",
  align: "Drive multi-agent alignment workflows (double-design, align)",
  init: "Initialize a YACO project (yaco.toml, plan/, .worktrees/)",
  install: "Install the yaco binary, hooks, wrappers, and global symlinks",
  doctor: "Run YACO health checks against ~/.yaco and the current repo",
  paths: "Resolve canonical YACO paths (YACO_HOME, sessions, events, ...)",
  project: "Operate on registered YACO projects (move metadata, ...)",
  plan: "Promote the plan directory into a private, colocated git repo",
  gate: "Run the repo's exit gate (verify/doc/review/qa floor) against the session's diff",
};

function helpText(): string {
  const rows = AREAS.map((a) => `  ${a.padEnd(10)} ${AREA_HELP[a]}`).join("\n");
  const providerList = Object.keys(PROVIDERS).join(", ");
  return `yaco — YACO unified CLI

Usage:
  yaco <area> <command> [args...]
  yaco <area> --help
  yaco --help

Areas:
${rows}

Provider shortcuts:
  yaco <provider> [args...]   Equivalent to \`yaco agent start <provider> [args...]\`
                              Providers: ${providerList}
                              (everything after a standalone \`--\` is forwarded
                              verbatim to the provider CLI)

Global flags:
  --json     Emit machine-readable JSON instead of text
  --help     Show this help (or area-specific help when after an area)
`;
}

type AreaHandler = (
  argv: string[],
  opts: { json: boolean },
) => Promise<Result<unknown>> | Result<unknown>;

const HANDLERS: Record<Area, AreaHandler> = {
  agent: handleAgent,
  task: handleTask,
  worktree: handleWorktree,
  align: handleAlign,
  init: handleInit,
  install: handleInstall,
  doctor: handleDoctor,
  paths: handlePaths,
  project: handleProject,
  plan: handlePlan,
  gate: handleGate,
};

function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

async function dispatch(argv: string[]): Promise<{
  result: Result<unknown>;
  area?: Area;
  json: boolean;
}> {
  const top = parseArgs(argv);
  const json = top.flags["json"] === true;

  // First positional is the area. With no area, bare --help/--json (or no
  // args) all resolve to top-level help.
  const area = top.positional[0];
  if (area === undefined) {
    return { result: ok({ help: helpText() }), json };
  }

  // Top-level provider shortcut: `yaco claude ...` / `yaco codex ...`.
  // Routes to `agent start <provider>` with everything else passed through.
  if (area in PROVIDERS) {
    const idx = argv.indexOf(area);
    const rest = idx >= 0 ? argv.slice(idx + 1) : [];
    try {
      const result = await runStart([area, ...rest], { json });
      return { result, area: "agent", json };
    } catch (e) {
      return { result: toErr(e), area: "agent", json };
    }
  }

  if (!isArea(area)) {
    return {
      result: new CliError(
        ErrCode.USAGE,
        `unknown area: ${area}. Run \`yaco --help\` for the list.`,
      ).toResult(),
      json,
    };
  }

  // Strip the area token from argv before handing to the area handler;
  // area-local --help is the area handler's responsibility.
  const idx = argv.indexOf(area);
  const sub = idx >= 0 ? argv.slice(idx + 1) : [];

  try {
    const result = await HANDLERS[area](sub, { json });
    return { result, area, json };
  } catch (e) {
    return { result: toErr(e), area, json };
  }
}

/** The two text-mode envelopes render() prints verbatim. Every ordinary
 *  result-bearing command must produce one of these (via `dual` for results,
 *  or `{help}` for usage). Returns the raw string to print, or undefined when
 *  the value is neither — which render() treats as an internal bug.
 *
 *  Streaming / process-owning commands are NOT covered here because they never
 *  reach render(): `agent output-follow` writes its NDJSON stream and exits,
 *  `align poll` and `doctor` own stdout and `process.exit()` directly. That
 *  allowlist is exact — anything else returning a bare object in text mode is a
 *  bug, surfaced as INTERNAL rather than a silent JSON dump. */
function textEnvelope(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v["help"] === "string") return v["help"];
    if (typeof v["text"] === "string") return v["text"];
  }
  return undefined;
}

function render(result: Result<unknown>, json: boolean): void {
  if (isErr(result)) {
    if (json) {
      // Failure envelope: stderr only, stdout stays empty so machine
      // consumers can rely on success → stdout, failure → stderr.
      const error: Record<string, unknown> = {
        code: result.code,
        message: result.message,
      };
      if (result.details !== undefined) error["details"] = result.details;
      emit({ ok: false, error }, "stderr");
    } else {
      process.stderr.write(`error [${result.code}]: ${result.message}\n`);
    }
    return;
  }
  if (json) {
    emit({ ok: true, data: result.value });
    return;
  }
  // Text mode: the value must be a `{help}` or `{text}` envelope. Both are
  // written verbatim; no trailing newline is appended when one is already
  // present, preserving captured buffers / tables byte-for-byte.
  const text = textEnvelope(result.value);
  if (text !== undefined) {
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  // Guarded fallback: reaching here means an ordinary command returned a bare
  // object in text mode instead of `{text}`/`{help}`. That is a bug — every
  // result-bearing handler must branch through `dual`. The exit code is set to
  // INTERNAL by main() (see renderExitCode).
  process.stderr.write(
    "error [INTERNAL]: command returned an unrendered result in text mode " +
      "(expected a {text} or {help} envelope)\n",
  );
}

/** Exit code for a rendered result: error code on failure, INTERNAL when an ok
 *  text-mode result lacked a `{text}`/`{help}` envelope (the guarded fallback),
 *  0 otherwise. */
function renderExitCode(result: Result<unknown>, json: boolean): number {
  if (isErr(result)) return exitCodeFor(result.code);
  if (!json && textEnvelope(result.value) === undefined) {
    return exitCodeFor(ErrCode.INTERNAL);
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Fast-path: `yaco agent hook-event <Event>` is fired by provider hooks on
  // every event, and Codex blocks its loop until the hook returns. The branch
  // exists for the *contract*, not for load time — it reads stdin, updates
  // state, swallows every failure so a broken hook cannot block the agent
  // loop, and exits 0 regardless. The import is static because a dynamic one
  // would defer nothing: the dispatcher statically imports
  // commands/agent/index.ts, which statically imports this handler, so it is
  // already loaded by the time main() runs.
  if (argv[0] === "agent" && argv[1] === "hook-event") {
    try {
      await handleHookEvent(argv.slice(2));
    } catch { /* hooks must never block the agent loop on failure */ }
    process.exit(0);
  }
  const { result, json } = await dispatch(argv);
  render(result, json);
  // Let stdout/stderr drain naturally. Calling process.exit() immediately after
  // rendering can truncate large JSON envelopes when stdout is a pipe.
  process.exitCode = renderExitCode(result, json);
}

export { AREAS, helpText, dispatch, main, textEnvelope, renderExitCode };
