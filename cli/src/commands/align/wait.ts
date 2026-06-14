/** `yaco align wait` — block until it's your turn or alignment is DONE.
 *
 *  Process-owning, like the `poll` verb it replaces: it reaches `process.exit`
 *  directly so it can honor exit codes the shared `ErrCode` table doesn't model.
 *
 *    0   YOUR_TURN | DONE
 *    1   TIMEOUT   (envelope code `align.timeout`)
 *    2   ERROR     (envelope code `align.error` — uninitialized/corrupt bundle)
 *
 *  On YOUR_TURN it opens the turn (snapshots `final/`, reserves the discussion
 *  turn file) and returns the path the agent must write next. The poll interval
 *  is fixed internally; `--timeout` (default 3600s) is the only knob.
 */

import { emit } from "../../lib/core/json.ts";
import { type AlignArgs, roleAndDir } from "./verbs.ts";
import {
  finalDir,
  openTurn,
  resolveWaitBundle,
  turnFilePath,
  waitForTurn,
  type WaitOutcome,
} from "./store.ts";
import type { Role } from "./protocol.ts";

const WAIT_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_SEC = 3600;

export const WAIT_HELP = `yaco align wait — block until it's your turn or alignment is DONE

Usage:
  yaco align wait [<dir>] <CODEX|CLAUDE> [--timeout <sec>] [--json]

Arguments:
  <dir>             Bundle directory (default: nearest bundle walking up from cwd)
  <CODEX|CLAUDE>    Your agent role

Flags:
  --timeout <sec>   Max wait in seconds (default: ${DEFAULT_TIMEOUT_SEC}; 0 = wait forever)
  --json            Emit the {ok,data}/{ok,error} envelope
`;

export async function runWait(args: AlignArgs): Promise<never> {
  const { role, dir } = roleAndDir(args, "wait");
  const bundle = resolveWaitBundle(dir);
  const outcome = await waitForTurn({
    bundle,
    role,
    intervalMs: WAIT_INTERVAL_MS,
    timeoutMs: (args.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
  });
  emitWaitAndExit(outcome, bundle, role, args.json);
}

function emitWaitAndExit(outcome: WaitOutcome, bundle: string, role: Role, json: boolean): never {
  switch (outcome.status) {
    case "YOUR_TURN": {
      const turnSeq = outcome.parsed!.seq + 1;
      openTurn(bundle, role, turnSeq);
      const turnFile = turnFilePath(bundle, turnSeq, role);
      const final = finalDir(bundle);
      if (json) {
        emit({ ok: true, data: { status: "YOUR_TURN", seq: turnSeq, turnFile, finalDir: final } });
      } else {
        process.stdout.write(`YOUR_TURN seq=${turnSeq} turn=${turnFile} final=${final}\n`);
      }
      process.exit(0);
    }
    case "DONE":
      if (json) emit({ ok: true, data: { status: "DONE", seq: outcome.parsed!.seq } });
      else process.stdout.write("DONE\n");
      process.exit(0);
    case "TIMEOUT":
      if (json) {
        emit(
          { ok: false, error: { code: "align.timeout", message: outcome.message ?? "alignment wait timed out" } },
          "stderr",
        );
      } else process.stdout.write("TIMEOUT\n");
      process.exit(1);
    case "ERROR":
      if (json) {
        emit(
          { ok: false, error: { code: "align.error", message: outcome.message ?? "alignment bundle uninitialized or corrupt" } },
          "stderr",
        );
      } else process.stdout.write("ERROR\n");
      process.exit(2);
  }
}
