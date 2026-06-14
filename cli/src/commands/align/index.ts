/** `yaco align <subcommand>` — area dispatcher.
 *
 *  The align module internalizes the whole `status.txt` protocol behind four
 *  verbs so the grammar + state machine live in one place and illegal
 *  transitions are unrepresentable:
 *
 *    init     create the bundle + status.txt (first mover, once)
 *    wait     block until your turn or DONE; opens your turn (process-owning)
 *    handoff  close your turn — vote is inferred from final/ edits
 *    status   read coordination state (non-blocking, for the orchestrator)
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runHandoff, runInit, runStatus, tokenize } from "./verbs.ts";
import { runWait, WAIT_HELP } from "./wait.ts";

const HELP = `yaco align — drive multi-agent alignment (init / wait / handoff / status)

Usage:
  yaco align init    [<dir>] --first <CODEX|CLAUDE>          [--json]
  yaco align wait    [<dir>] <CODEX|CLAUDE> [--timeout <sec>] [--json]
  yaco align handoff [<dir>] <CODEX|CLAUDE>                  [--json]
  yaco align status  [<dir>]                                [--json]
  yaco align --help

Subcommands:
  init     Create the bundle + status.txt (first mover, once)
  wait     Block until it's your turn or DONE; opens your turn
  handoff  Close your turn — vote is inferred from final/ edits
  status   Read coordination state (non-blocking, for the orchestrator)
`;

export async function handleAlign(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const sub = argv[0];
  const args = tokenize(argv.slice(1));
  args.json = args.json || opts.json;

  switch (sub) {
    case "init":
      return args.help ? ok({ help: HELP }) : runInit(args);
    case "status":
      return args.help ? ok({ help: HELP }) : runStatus(args);
    case "handoff":
      return args.help ? ok({ help: HELP }) : runHandoff(args);
    case "wait":
      if (args.help) return ok({ help: WAIT_HELP });
      // runWait always terminates the process; the throw is for the type
      // checker — control never returns to the dispatcher.
      await runWait(args);
      throw new CliError(ErrCode.INTERNAL, "runWait returned unexpectedly");
    default:
      throw new CliError(
        ErrCode.USAGE,
        `unknown subcommand: align ${sub}. Run \`yaco align --help\`.`,
      );
  }
}
