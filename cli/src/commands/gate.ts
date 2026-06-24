/** `yaco gate` — run the repo's exit gate against the session's diff.
 *
 *  Thin verb over `runGate` (cli/src/lib/core/gate): compute the diff base,
 *  run scripts/gate.sh, report `{ base, sha, checks, dirty }`. `gate ⊃ verify`
 *  — agents call `yaco gate --json` to self-check ("what do I still owe?"), and
 *  humans for debugging. The same `runGate` backs the set-done guard and Stop
 *  hook directly, so this command stays a pure presentation layer.
 *
 *  Envelope (deliberate, mirrors `doctor`): a RED gate is a *status*, not a CLI
 *  error — the command ran fine and found the gate red. So like doctor, this
 *  bypasses the dispatcher's render path and emits the result on stdout with the
 *  exit code carrying the verdict (0 = all checks green/skip, 1 = a check
 *  failed). The --json line is `{ ok, data }` in BOTH cases so callers read the
 *  checks and `ok` together. Only a hard "couldn't run" condition (not a git
 *  repo, missing scripts/gate.sh) throws CliError → the standard
 *  `{ok:false,error}` stderr envelope.
 */

import { ok, type Result } from "../lib/core/result.ts";
import { CliError, ErrCode } from "../lib/core/errors.ts";
import { emit } from "../lib/core/json.ts";
import { runGate, type GateResult } from "../lib/core/gate/index.ts";

const HELP = `yaco gate — run the repo's exit gate against the session's diff

Usage:
  yaco gate [--base <ref>] [--json]
  yaco gate --help

Flags:
  --base <ref>   Diff baseline (default: merge-base of HEAD and main)
  --json         Emit {ok, data:{base, sha, checks, dirty}} on stdout (always —
                 a red gate is a status, not an error envelope; exit code is 1
                 when any check failed, 0 otherwise)

Reports the floor checks owed by the diff (verify / doc / review / qa) plus
whether the worktree is dirty. Checks are computed from the diff, not declared.
`;

/** Render a gate result as human-readable text. */
function renderText(result: GateResult): string {
  const { base, sha, checks, dirty } = result.data;
  const lines: string[] = [`yaco gate (base=${base} head=${sha.slice(0, 7)})`];
  for (const [name, status] of Object.entries(checks)) {
    const tag = status === "pass" ? "PASS " : status === "fail" ? "FAIL " : "SKIP ";
    lines.push(`  ${tag} ${name}`);
  }
  if (dirty) lines.push("  DIRTY  worktree has uncommitted changes");
  lines.push(`  => ${result.ok ? "ok" : "BLOCKED"}`);
  return lines.join("\n") + "\n";
}

export async function handleGate(
  argv: string[],
  outer: { json: boolean },
): Promise<Result<unknown>> {
  let json = outer.json;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return ok({ help: HELP });
    if (a === "--json") { json = true; continue; }
    if (a === "--base" || a.startsWith("--base=")) {
      let v: string | undefined;
      if (a.startsWith("--base=")) {
        v = a.slice("--base=".length);
      } else {
        const next = argv[i + 1];
        // A value starting with '-' is a flag, not a base — treat as missing
        // (mirrors parseArgs' boolean-flag rule).
        if (next !== undefined && !next.startsWith("-")) { v = next; i++; }
      }
      if (!v) throw new CliError(ErrCode.USAGE, "--base requires a value");
      base = v;
      continue;
    }
    throw new CliError(ErrCode.USAGE, `unknown gate flag: ${a}`);
  }

  // runGate throws CliError for hard failures (caught by the dispatcher → error
  // envelope); a red gate returns ok:false and is reported as a status below.
  const result = runGate(process.cwd(), base !== undefined ? { base } : {});

  if (json) {
    emit({ ok: result.ok, data: result.data });
    process.exit(result.ok ? 0 : 1);
  }
  process.stdout.write(renderText(result));
  process.exit(result.ok ? 0 : 1);
}
