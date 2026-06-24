/** `yaco gate` core — the thin wrapper around `scripts/gate.sh`.
 *
 *  `gate ⊃ verify`. The floor-from-diff logic (which checks are owed, running
 *  verify.sh, looking for doc/review/qa evidence) all lives in the repo's
 *  `scripts/gate.sh` (T1) — this module only:
 *    1. resolves the SESSION's working-tree root,
 *    2. computes the diff base (default = merge-base of HEAD and `main`),
 *    3. runs `<root>/scripts/gate.sh <base>` and parses its one-line checks JSON,
 *    4. detects a dirty worktree,
 *    5. shapes the `{ ok, data:{ base, sha, checks, dirty } }` result.
 *
 *  `runGate` is the contract: the `yaco gate` command is one caller; the
 *  set-done guard (T3) and the Stop hook (T6) call this same function directly.
 *
 *  v1 is STATELESS — no sha-keyed cache (that is T5, where the cache finally
 *  earns its keep: a loop re-running verify on the same sha). Re-running verify
 *  on an unchanged sha here is merely slower, not more complex.
 *
 *  Why the working-tree top-level, not `resolveRepoRoot`: gate.sh self-locates
 *  its own repo root from `BASH_SOURCE/..` and diffs *that* tree. A session in a
 *  linked worktree must gate the worktree's own diff, so we invoke the worktree's
 *  own checked-out `scripts/gate.sh` (`git rev-parse --show-toplevel`). The
 *  common-dir primary (`resolveRepoRoot`) would gate the primary checkout
 *  instead — wrong for the "gate sees the session's diff" pillar (design.md §5).
 *  In the primary checkout the two roots coincide; the hardcoded
 *  `join(root, "scripts", "gate.sh")` path (per create.ts:82) resolves either way.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { getMergeBase, isDirty, runGit } from "../worktree/git.ts";

/** The default branch the diff base is measured against when no --base given. */
const DEFAULT_BRANCH = "main";

export type GateStatus = "pass" | "fail" | "skip";

/** The four floor checks gate.sh reports. Matches its stdout JSON. */
export interface GateChecks {
  verify: GateStatus;
  doc: GateStatus;
  review: GateStatus;
  qa: GateStatus;
}

export interface GateData {
  /** The diff baseline (merge-base, or the explicit --base). */
  base: string;
  /** Current HEAD of the gated worktree. */
  sha: string;
  /** Per-check verdicts from scripts/gate.sh. */
  checks: GateChecks;
  /** Uncommitted changes present (separate signal — does NOT flip `ok`; the
   *  set-done guard refuses on it so "done" can't land on a dirty tree). */
  dirty: boolean;
}

export interface GateResult {
  ok: boolean;
  data: GateData;
}

export interface RunGateOptions {
  /** Explicit diff base; defaults to merge-base(HEAD, main). */
  base?: string;
}

/** Resolve the top-level of the working tree containing `cwd`. Unlike
 *  resolveRepoRoot (which follows --git-common-dir to the primary checkout),
 *  this returns the linked worktree's own root — the tree whose diff we gate. */
function worktreeRoot(cwd: string): string {
  const r = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.ENV,
      `not in a git repository (cwd=${cwd}): ${r.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  return r.stdout.trim();
}

/** Parse gate.sh's machine contract: the LAST non-empty stdout line is the
 *  checks JSON (all progress goes to stderr). */
function parseChecks(stdout: string, stderr: string): GateChecks {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new CliError(
      ErrCode.INTERNAL,
      `gate.sh produced no stdout to parse${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new CliError(ErrCode.INTERNAL, `gate.sh stdout is not JSON: ${last}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CliError(ErrCode.INTERNAL, `gate.sh JSON is not an object: ${last}`);
  }
  const obj = parsed as Record<string, unknown>;
  const pick = (name: keyof GateChecks): GateStatus => {
    const v = obj[name];
    if (v === "pass" || v === "fail" || v === "skip") return v;
    throw new CliError(ErrCode.INTERNAL, `gate.sh check '${name}' missing/invalid: ${last}`);
  };
  return { verify: pick("verify"), doc: pick("doc"), review: pick("review"), qa: pick("qa") };
}

/** Run the repo's gate against the session's working tree.
 *
 *  Throws CliError for hard "couldn't run" conditions (not a git repo, no
 *  scripts/gate.sh, unparseable output). A RED gate is NOT an error — it
 *  returns `{ ok:false, data }` so callers see which checks failed. */
export function runGate(cwd: string, opts: RunGateOptions = {}): GateResult {
  const root = worktreeRoot(cwd);
  const base = opts.base ?? getMergeBase(root, "HEAD", DEFAULT_BRANCH);

  const script = join(root, "scripts", "gate.sh");
  if (!existsSync(script)) {
    throw new CliError(
      ErrCode.ENV,
      `gate script not found: ${script} (the repo must provide scripts/gate.sh)`,
    );
  }

  const r = spawnSync(script, [base], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) {
    throw new CliError(ErrCode.IO, `failed to run ${script}: ${r.error.message}`);
  }

  const checks = parseChecks(r.stdout ?? "", r.stderr ?? "");
  const sha = runGit(["rev-parse", "HEAD"], root).stdout.trim();
  const dirty = isDirty(root);
  const ok = Object.values(checks).every((s) => s !== "fail");

  return { ok, data: { base, sha, checks, dirty } };
}
