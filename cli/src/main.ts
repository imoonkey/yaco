#!/usr/bin/env bun

/** yaco — unified CLI dispatcher.
 *
 *  This file is the bin entry. It owns argv intake, help text, and routing
 *  to one of the eight top-level areas. Each area module is responsible for
 *  parsing its own subcommands and producing a Result. Runtime
 *  implementations land in follow-up tasks (yc-core-paths, yc-agent-port,
 *  etc.); this scaffold only wires the dispatch surface.
 */

import { parseArgs } from "./lib/core/args.ts";
import { ok, isErr, type Result } from "./lib/core/result.ts";
import { CliError, ErrCode, exitCodeFor, toErr } from "./lib/core/errors.ts";
import { emit, stringify } from "./lib/core/json.ts";
import { handlePaths } from "./commands/paths.ts";

const AREAS = [
  "agent",
  "task",
  "worktree",
  "align",
  "init",
  "install",
  "doctor",
  "paths",
] as const;
type Area = (typeof AREAS)[number];

const AREA_HELP: Record<Area, string> = {
  agent: "Start / send / capture / kill / status / rename tmux-backed agent sessions",
  task: "Read and mutate the project task graph",
  worktree: "Create, merge, and clean up git worktrees per task slug",
  align: "Drive multi-agent alignment workflows (double-design, align)",
  init: "Initialize a YACO project (yaco.toml, projects/, .worktrees/)",
  install: "Install the yaco binary, hooks, wrappers, and global symlinks",
  doctor: "Run YACO health checks against ~/.yaco and the current repo",
  paths: "Resolve canonical YACO paths (YACO_HOME, sessions, events, ...)",
};

function helpText(): string {
  const rows = AREAS.map((a) => `  ${a.padEnd(10)} ${AREA_HELP[a]}`).join("\n");
  return `yaco — YACO unified CLI

Usage:
  yaco <area> <command> [args...]
  yaco <area> --help
  yaco --help

Areas:
${rows}

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
  agent: stubHandler("agent"),
  task: stubHandler("task"),
  worktree: stubHandler("worktree"),
  align: stubHandler("align"),
  init: stubHandler("init"),
  install: stubHandler("install"),
  doctor: stubHandler("doctor"),
  paths: handlePaths,
};

function stubHandler(area: Area): AreaHandler {
  return (argv) => {
    if (argv[0] === "--help" || argv[0] === "-h") {
      return ok({ area, help: AREA_HELP[area], status: "stub" });
    }
    return ok({ area, status: "stub", note: "runtime lands in a later task" });
  };
}

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
  // Text mode: print known shapes; otherwise fall back to pretty JSON.
  const v = result.value as Record<string, unknown> | undefined;
  if (v && typeof v === "object" && typeof v["help"] === "string") {
    process.stdout.write(v["help"] as string);
    if (!(v["help"] as string).endsWith("\n")) process.stdout.write("\n");
    return;
  }
  process.stdout.write(stringify(v) + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { result, json } = await dispatch(argv);
  render(result, json);
  process.exit(isErr(result) ? exitCodeFor(result.code) : 0);
}

if (import.meta.main) {
  void main();
}

export { AREAS, helpText, dispatch };
