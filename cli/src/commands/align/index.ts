/** `yaco align <subcommand>` — area dispatcher.
 *
 *  Today the only subcommand is `poll`, ported from align_poll.sh; future
 *  alignment helpers (double-design driver, status init) will hang off
 *  this same dispatcher.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { runPoll } from "./poll.ts";

const HELP = `yaco align — drive multi-agent alignment workflows

Usage:
  yaco align poll <status_file> <role> [--interval <sec>] [--timeout <sec>] [--json]
  yaco align --help

Subcommands:
  poll   Block until status.txt flips to your role or DONE
`;

export async function handleAlign(
  argv: string[],
  opts: { json: boolean },
): Promise<Result<unknown>> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub === "poll") {
    // runPoll always terminates the process; the `never` below is just for
    // type checkers — control never returns to the dispatcher.
    await runPoll(rest, opts);
    throw new CliError(ErrCode.INTERNAL, "runPoll returned unexpectedly");
  }

  throw new CliError(
    ErrCode.USAGE,
    `unknown subcommand: align ${sub}. Run \`yaco align --help\`.`,
  );
}
