/** `yaco agent hook-event <EventName>` — provider hook entry point.
 *
 *  Reads JSON from stdin, applies the event to the live session state. The
 *  provider hook configs written by `yaco agent hooks install` point here.
 *
 *  Wire-protocol parity: silently no-op when the session isn't yaco-managed
 *  (no state file, no tmux session, malformed JSON), because hooks are
 *  invoked by Claude/Codex on every event regardless of whether yaco is
 *  tracking the session.
 */
import { readFileSync } from "fs";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import {
  runHookEvent,
  type HookInput,
} from "../../lib/core/agent/hook-event.ts";

const HELP = `yaco agent hook-event <EventName>

Provider hook entry point. Reads JSON event payload from stdin, updates the
session state file for the live tmux session.

This command is invoked by the provider hook runner (Claude / Codex). Most
users do not run it directly.
`;

export async function handleHookEvent(
  argv: string[],
): Promise<Result<unknown>> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }

  const eventName = argv[0];
  if (!eventName) {
    throw new CliError(
      ErrCode.USAGE,
      "yaco agent hook-event requires an EventName positional",
    );
  }

  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf-8");
    if (raw.trim().length > 0) {
      input = JSON.parse(raw) as HookInput;
    }
  } catch {
    // Malformed JSON or empty stdin — treat as no-op, mirroring the old
    // shell handler's silent-on-error contract.
    return ok({ event: eventName, applied: false, reason: "no-input" });
  }

  runHookEvent(eventName, input);
  return ok({ event: eventName, applied: true });
}
