/** `yaco align` result-path verbs: init / status / handoff.
 *
 *  These return a `Result` through `dual` (the dispatcher renders text or the
 *  `{ok,data}` envelope). The blocking `wait` verb is process-owning and lives
 *  in `wait.ts`. Argument tokenizing is shared via {@link tokenize}.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { dual } from "../../lib/core/render.ts";
import { type Result } from "../../lib/core/result.ts";
import { isRole, transition, type Role } from "./protocol.ts";
import {
  clearOpenTurn,
  hashFinal,
  initBundle,
  initTarget,
  readOpenTurn,
  readStatus,
  resolveBundle,
  turnFileFilled,
  turnFilePath,
  writeStatus,
} from "./store.ts";

export interface AlignArgs {
  positional: string[];
  json: boolean;
  help: boolean;
  first?: string;
  timeoutSec?: number;
}

/** Split argv into positionals + the flags every align verb may take. */
export function tokenize(argv: string[]): AlignArgs {
  const out: AlignArgs = { positional: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--first" || a.startsWith("--first=")) {
      out.first = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i])?.toUpperCase();
      if (out.first === undefined) throw new CliError(ErrCode.USAGE, "--first requires a value");
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new CliError(ErrCode.USAGE, "--timeout requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new CliError(ErrCode.USAGE, `--timeout must be a non-negative number (got '${v}')`);
      }
      out.timeoutSec = n;
    } else if (a.startsWith("-")) {
      throw new CliError(ErrCode.USAGE, `unknown flag: ${a}`);
    } else out.positional.push(a);
  }
  return out;
}

/** Pull the ROLE out of positionals; the remaining (optional) positional is the
 *  bundle dir. Rejects extra/garbage positionals so a typo'd role surfaces. */
export function roleAndDir(args: AlignArgs, verb: string): { role: Role; dir?: string } {
  const roles = args.positional.filter(isRole);
  const rest = args.positional.filter((p) => !isRole(p));
  if (roles.length !== 1 || rest.length > 1) {
    throw new CliError(ErrCode.USAGE, `usage: yaco align ${verb} [<dir>] <CODEX|CLAUDE>`);
  }
  return { role: roles[0]!, dir: rest[0] };
}

export function runInit(args: AlignArgs): Result<unknown> {
  if (args.first === undefined || !isRole(args.first)) {
    throw new CliError(ErrCode.USAGE, "usage: yaco align init [<dir>] --first <CODEX|CLAUDE>");
  }
  if (args.positional.length > 1) {
    throw new CliError(ErrCode.USAGE, "yaco align init takes at most one <dir>");
  }
  const dir = initTarget(args.positional[0]);
  const first = args.first;
  initBundle(dir, first);
  return dual(args.json, { seq: 0, next: first, dir }, () =>
    `initialized alignment at ${dir} (SEQ=0 NEXT=${first})\n`,
  );
}

export function runStatus(args: AlignArgs): Result<unknown> {
  if (args.positional.length > 1) {
    throw new CliError(ErrCode.USAGE, "yaco align status takes at most one <dir>");
  }
  const bundle = resolveBundle(args.positional[0]);
  const s = readStatus(bundle);
  return dual(
    args.json,
    { seq: s.seq, next: s.next, codex: s.codex, claude: s.claude, done: s.next === "DONE" },
    () => `SEQ=${s.seq} NEXT=${s.next} CODEX=${s.codex} CLAUDE=${s.claude}\n`,
  );
}

export function runHandoff(args: AlignArgs): Result<unknown> {
  const { role, dir } = roleAndDir(args, "handoff");
  const bundle = resolveBundle(dir);
  const status = readStatus(bundle);

  if (status.next === "DONE") {
    throw new CliError(ErrCode.CONFLICT, "alignment already DONE; nothing to hand off");
  }
  if (status.next !== role) {
    throw new CliError(ErrCode.CONFLICT, `not your turn: NEXT=${status.next}, you are ${role}`);
  }
  const turnSeq = status.seq + 1;
  const open = readOpenTurn(bundle);
  if (!open || open.role !== role || open.turnSeq !== turnSeq) {
    throw new CliError(
      ErrCode.CONFLICT,
      `no active turn for ${role}; run 'yaco align wait ${role}' first`,
    );
  }
  if (!turnFileFilled(bundle, turnSeq, role)) {
    throw new CliError(
      ErrCode.INVALID,
      `turn file ${turnFilePath(bundle, turnSeq, role)} is missing or empty; write your turn notes before handing off`,
    );
  }

  const changedFinal = hashFinal(bundle) !== open.baseHash;
  const vote = changedFinal ? "CHANGES" : "APPROVE";
  const nextStatus = transition(status, role, vote);
  writeStatus(bundle, nextStatus);
  clearOpenTurn(bundle);

  const done = nextStatus.next === "DONE";
  return dual(
    args.json,
    { status: done ? "DONE" : "HANDED_OFF", seq: turnSeq, role, vote, changedFinal, next: nextStatus.next },
    () =>
      `${done ? "DONE" : "HANDED_OFF"} seq=${turnSeq} vote=${vote} changedFinal=${changedFinal} next=${nextStatus.next}\n`,
  );
}
