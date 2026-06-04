/** `yaco align poll` — block until alignment turn or DONE.
 *
 *  Direct port of agent-config/global/skills/align/scripts/align_poll.sh:
 *  read the first line of a status.txt file, look for SEQ/NEXT/CODEX/CLAUDE
 *  tokens, and loop on a fixed interval until either NEXT flips to the
 *  caller's role (YOUR_TURN) or to DONE. TIMEOUT after the deadline; ERROR
 *  if the file is missing or unparseable.
 *
 *  Exit-code contract (non-JSON mode mirrors the shell helper exactly):
 *    0   YOUR_TURN | DONE
 *    1   TIMEOUT
 *    2   ERROR
 *  In --json mode the same outcomes go through the {ok,data}/{ok,error}
 *  envelope; the error.code uses `align.timeout` / `align.error` so
 *  consumers can switch on a stable string rather than the shouted word.
 *
 *  The handler reaches process.exit() directly because the dispatcher's
 *  default exit mapping only knows the standard ErrCode table — TIMEOUT/
 *  ERROR don't fit any of those buckets cleanly. Bypassing render() lets
 *  us honor the historical shell exit codes without polluting the shared
 *  ErrCode enum.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { emit } from "../../lib/core/json.ts";

export const POLL_HELP = `yaco align poll — block until it's your turn or alignment is DONE

Usage:
  yaco align poll <status_file> <role> [--interval <sec>] [--timeout <sec>] [--json]

Arguments:
  <status_file>     Path to align/discussion/status.txt
  <role>            Your agent role (e.g. CODEX or CLAUDE; case-insensitive)

Flags:
  --interval <sec>  Poll interval in seconds (default: 15)
  --timeout <sec>   Max wait in seconds (default: 3600; 0 = wait forever)
  --json            Emit the {ok,data}/{ok,error} envelope instead of one-word
                    lines on stdout/stderr
`;

export type PollStatus = "YOUR_TURN" | "DONE" | "TIMEOUT" | "ERROR";

export interface ParsedStatusLine {
  seq?: string;
  next: string;
  codex?: string;
  claude?: string;
}

export interface PollOutcome {
  status: PollStatus;
  /** Snapshot of the final parsed status line; absent for TIMEOUT/ERROR. */
  parsed?: ParsedStatusLine;
  /** Free-form detail attached to TIMEOUT/ERROR. */
  message?: string;
}

export interface PollOptions {
  statusFile: string;
  role: string;
  intervalMs: number;
  /** 0 means wait indefinitely. */
  timeoutMs: number;
  /** Override the sleep primitive (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the clock (ms epoch). Tests drive deterministic timeouts. */
  now?: () => number;
  /** When true, skip writing poll.log next to status_file. */
  silent?: boolean;
}

/** Pure async poll loop. No process.exit, no stdout writes. Tests use
 *  this directly with `sleep` and `now` mocked. */
export async function pollStatus(opts: PollOptions): Promise<PollOutcome> {
  const role = opts.role.toUpperCase();
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const start = now();
  const log = makeLogger(opts.statusFile, opts.silent === true);

  log(
    `poll start: agent=${role} interval=${opts.intervalMs}ms timeout=${opts.timeoutMs}ms`,
  );

  let prevLine = "";
  while (true) {
    if (opts.timeoutMs > 0 && now() - start >= opts.timeoutMs) {
      const elapsed = now() - start;
      log(`poll timeout after ${elapsed}ms`);
      return {
        status: "TIMEOUT",
        message: `no turn for ${role} within ${opts.timeoutMs}ms`,
      };
    }

    const parsed = parseStatusFile(opts.statusFile);
    if (!parsed) {
      log(`ERROR: cannot parse ${opts.statusFile}`);
      return {
        status: "ERROR",
        message: `cannot read or parse status file: ${opts.statusFile}`,
      };
    }

    const curLine = formatLine(parsed);
    if (curLine !== prevLine) {
      log(curLine);
      prevLine = curLine;
    }

    if (parsed.next === "DONE") {
      log("poll end: DONE");
      return { status: "DONE", parsed };
    }
    if (parsed.next === role) {
      log("poll end: YOUR_TURN");
      return { status: "YOUR_TURN", parsed };
    }

    await sleep(opts.intervalMs);
  }
}

export function parseStatusFile(path: string): ParsedStatusLine | null {
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const line = content.split(/\r?\n/, 1)[0] ?? "";
  const next = grab(line, "NEXT");
  if (!next) return null;
  return {
    seq: grab(line, "SEQ", "[0-9]+"),
    next,
    codex: grab(line, "CODEX", "[A-Z]+"),
    claude: grab(line, "CLAUDE", "[A-Z]+"),
  };
}

/** Mirror the legacy `grep -oE` semantics from align_poll.sh exactly.
 *  Role / vote fields are STRICTLY uppercase letters; SEQ is digits.
 *  This is deliberately lossy: `NEXT=CLAUDE1` matches just `CLAUDE`
 *  (greedy stops at the first non-[A-Z]) — preserves shell behavior so
 *  callers don't see a new "no-match → ERROR" failure for noisy lines.
 *  `NEXT=claude` (lowercase) fails to match → null → ERROR, same as the
 *  shell. No left-anchor: `grep -oE` is unanchored, so `XNEXT=CODEX`
 *  matches `NEXT=CODEX` just like the shell would. */
function grab(line: string, key: string, valueClass: string = "[A-Z]+"): string | undefined {
  const m = line.match(new RegExp(`${key}=(${valueClass})`));
  return m?.[1];
}

function formatLine(p: ParsedStatusLine): string {
  return `SEQ=${p.seq ?? ""} NEXT=${p.next} CODEX=${p.codex ?? ""} CLAUDE=${p.claude ?? ""}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeLogger(statusFile: string, silent: boolean): (msg: string) => void {
  if (silent) return () => {};
  const logPath = `${dirname(statusFile)}/poll.log`;
  let initialized = false;
  return (msg: string) => {
    try {
      if (!initialized) {
        mkdirSync(dirname(logPath), { recursive: true });
        initialized = true;
      }
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] ${msg}\n`,
        "utf-8",
      );
    } catch {
      // Logging is best-effort; never block the poll loop on a log write.
    }
  };
}

// ─── Command-handler glue ───────────────────────────────────────────────

interface ParsedPollArgs {
  positional: string[];
  intervalSec: number;
  timeoutSec: number;
  json: boolean;
  help: boolean;
}

function parsePollArgs(argv: string[]): ParsedPollArgs {
  let intervalSec = 15;
  let timeoutSec = 3600;
  let json = false;
  let help = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--interval" || a.startsWith("--interval=")) {
      const v = a.startsWith("--interval=")
        ? a.slice("--interval=".length)
        : argv[++i];
      if (v === undefined) {
        throw new CliError(ErrCode.USAGE, "--interval requires a value");
      }
      intervalSec = parseNonNegativeNumber(v, "--interval");
      continue;
    }
    if (a === "--timeout" || a.startsWith("--timeout=")) {
      const v = a.startsWith("--timeout=")
        ? a.slice("--timeout=".length)
        : argv[++i];
      if (v === undefined) {
        throw new CliError(ErrCode.USAGE, "--timeout requires a value");
      }
      timeoutSec = parseNonNegativeNumber(v, "--timeout");
      continue;
    }
    if (a.startsWith("-")) {
      throw new CliError(
        ErrCode.USAGE,
        `unknown flag for 'align poll': ${a}`,
      );
    }
    positional.push(a);
  }
  return { positional, intervalSec, timeoutSec, json, help };
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(
      ErrCode.USAGE,
      `${flag} must be a non-negative number (got '${value}')`,
    );
  }
  return n;
}

/** Render an outcome to stdout/stderr and exit the process. Used by the
 *  CLI handler; tests use {@link pollStatus} and skip this entirely.
 *
 *  Text-mode routing matches align_poll.sh exactly: ALL four terminal
 *  words (YOUR_TURN / DONE / TIMEOUT / ERROR) go to stdout so existing
 *  callers — every skill/script that captures the shell helper's output
 *  with `$(align_poll.sh ...)` — still work after the port. Non-zero
 *  exit codes carry the error signal; the terminal word stays on
 *  stdout. JSON-mode failures continue to land on stderr per the
 *  envelope contract. */
export function emitOutcomeAndExit(outcome: PollOutcome, json: boolean): never {
  switch (outcome.status) {
    case "YOUR_TURN":
    case "DONE":
      if (json) {
        emit({
          ok: true,
          data: {
            status: outcome.status,
            seq: outcome.parsed?.seq ?? null,
            next: outcome.parsed?.next ?? null,
            codex: outcome.parsed?.codex ?? null,
            claude: outcome.parsed?.claude ?? null,
          },
        });
      } else {
        process.stdout.write(outcome.status + "\n");
      }
      process.exit(0);
    case "TIMEOUT":
      if (json) {
        emit(
          {
            ok: false,
            error: {
              code: "align.timeout",
              message: outcome.message ?? "alignment poll timed out",
            },
          },
          "stderr",
        );
      } else {
        process.stdout.write("TIMEOUT\n");
      }
      process.exit(1);
    case "ERROR":
      if (json) {
        emit(
          {
            ok: false,
            error: {
              code: "align.error",
              message: outcome.message ?? "alignment status file is malformed",
            },
          },
          "stderr",
        );
      } else {
        process.stdout.write("ERROR\n");
      }
      process.exit(2);
  }
}

/** Top-level entry point for `yaco align poll`. Always terminates the
 *  process (terminal outcomes call process.exit; usage errors throw and
 *  are caught by the dispatcher, which then exits 2). */
export async function runPoll(
  argv: string[],
  opts: { json: boolean },
): Promise<never> {
  const parsed = parsePollArgs(argv);
  const json = opts.json || parsed.json;
  if (parsed.help) {
    // --json: wrap help in the standard envelope so stdout stays
    // machine-parseable (success → exactly one {ok:true,data:...} line).
    // Text mode: write raw prose so it renders like every other --help.
    if (json) {
      emit({ ok: true, data: { help: POLL_HELP } });
    } else {
      process.stdout.write(POLL_HELP);
    }
    process.exit(0);
  }
  const [file, role, extra] = parsed.positional;
  if (!file || !role) {
    throw new CliError(ErrCode.USAGE, "usage: yaco align poll <status_file> <role>");
  }
  if (extra !== undefined) {
    throw new CliError(
      ErrCode.USAGE,
      `yaco align poll: unexpected argument '${extra}'`,
    );
  }
  const outcome = await pollStatus({
    statusFile: resolve(file),
    role,
    intervalMs: parsed.intervalSec * 1000,
    timeoutMs: parsed.timeoutSec * 1000,
  });
  emitOutcomeAndExit(outcome, json);
}
