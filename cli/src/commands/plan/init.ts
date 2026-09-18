/** Core logic for `yaco plan init` — promote `.yaco/plan` into a private,
 *  colocated git repo that the host repo never tracks.
 *
 *  Reproducible per machine and idempotent:
 *    preflight  resolve the host repo root (git rev-parse --show-toplevel);
 *               refuse if cwd resolved into the plan repo itself, or if the
 *               root working-tree .gitignore matches the plan (it would be
 *               dimmed in the app and dropped from colocated-repo detection).
 *    1  git init .yaco/plan in place if it is not already its own repo; ensure
 *       its .gitignore exists with sane runtime-noise patterns (never
 *       overwrite an existing one).
 *    2  ensure "/.yaco/plan" is in the host's exclude file — resolved via
 *       `git rev-parse --git-path info/exclude` so a linked worktree (where
 *       .git is a file) is handled correctly — so the host repo never tracks
 *       it. No trailing slash: the line also matches a worktree's plan symlink.
 *    3  ensure "!.yaco/plan/" is in the root .ignore — the exclude entry also
 *       makes ignore-stack tools (rg/fd, agent file search) blind to the plan;
 *       the .ignore negation re-includes it at higher precedence. A .ignore
 *       this step creates is itself excluded, so the host stays clean.
 *    4  --remote: add origin; a different existing origin is a CONFLICT unless
 *       --force. Never pushes — publishing the plan repo is a separate, personal
 *       step the tool does not assume.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ensureLine } from "../../lib/core/ensure-line.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { PLAN_DIR } from "../../lib/core/paths/index.ts";
import { ensureExcluded, runGit } from "../../lib/core/worktree/git.ts";

/** Runtime-noise patterns the plan repo should ignore by default. */
const DEFAULT_PLAN_GITIGNORE = ["poll.log", "poll.err", "_monitor.log", "*.lock"];

export interface PlanInitOptions {
  cwd?: string;
  remote?: string;
  force?: boolean;
}

export interface PlanInitResult {
  repoRoot: string;
  plan: string;
  planDir: string;
  initialized: boolean;
  gitignoreCreated: boolean;
  excludeUpdated: boolean;
  ignoreUpdated: boolean;
  remote: "none" | "added" | "unchanged" | "updated";
}

export function runPlanInit(opts: PlanInitOptions = {}): PlanInitResult {
  const cwd = resolve(opts.cwd ?? process.cwd());

  // ── preflight ──────────────────────────────────────────────────────────
  const topLevel = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (topLevel.status !== 0) {
    throw new CliError(
      ErrCode.ENV,
      `not in a git repository (cwd=${cwd}): ${topLevel.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  const repoRoot = resolve(cwd, topLevel.stdout.trim());

  // Guard: if cwd is inside an already-initialized plan repo, --show-toplevel
  // resolves to that plan repo, not the host.
  if (repoRoot.endsWith(`/${PLAN_DIR}`)) {
    throw new CliError(
      ErrCode.USAGE,
      `${repoRoot} is the plan repo itself — run 'yaco plan init' from the host repo root`,
    );
  }

  const plan = PLAN_DIR;
  const planDir = join(repoRoot, plan);

  if (rootGitignoreMatches(repoRoot, plan)) {
    throw new CliError(
      ErrCode.ENV,
      `the root .gitignore matches "${plan}" — it would be dimmed in the app and dropped from colocated-repo detection. Remove that entry; the plan repo is kept private via .git/info/exclude instead.`,
    );
  }

  // ── 1. in-place git init + plan .gitignore ────────────────────────────────
  const initialized = !existsSync(join(planDir, ".git"));
  if (initialized) {
    const r = runGit(["init", "--", plan], repoRoot);
    if (r.status !== 0) {
      throw new CliError(ErrCode.IO, `git init ${plan} failed: ${r.stderr.trim()}`);
    }
  }

  const planGitignore = join(planDir, ".gitignore");
  const gitignoreCreated = !existsSync(planGitignore);
  if (gitignoreCreated) {
    writeFileSync(planGitignore, DEFAULT_PLAN_GITIGNORE.join("\n") + "\n");
  }

  // ── 2. host info/exclude ─────────────────────────────────────────────────
  const excludeUpdated = ensureExcluded(repoRoot, `/${plan}`);

  // ── 3. root .ignore whitelist ────────────────────────────────────────────
  const ignorePath = join(repoRoot, ".ignore");
  const ignoreCreated = !existsSync(ignorePath);
  const ignoreUpdated = ensureLine(ignorePath, `!${plan}/`);
  if (ignoreCreated) ensureExcluded(repoRoot, "/.ignore");

  // ── 4. remote (never pushes) ─────────────────────────────────────────────
  const remote = opts.remote
    ? ensureRemote(planDir, opts.remote, opts.force ?? false)
    : "none";

  return {
    repoRoot,
    plan,
    planDir,
    initialized,
    gitignoreCreated,
    excludeUpdated,
    ignoreUpdated,
    remote,
  };
}

/** True iff the host's root working-tree .gitignore matches the plan root.
 *  Disables the global excludes file and inspects check-ignore's reported source
 *  so a /<plan>/ entry already in info/exclude (idempotent re-run) does not
 *  count — only a real .gitignore match refuses. */
function rootGitignoreMatches(repoRoot: string, plan: string): boolean {
  const r = runGit(
    ["-c", "core.excludesFile=/dev/null", "check-ignore", "-v", "--", plan],
    repoRoot,
  );
  if (r.status !== 0) return false; // status 1 = not ignored (errors: don't block)
  const source = r.stdout.split(":")[0] ?? "";
  return source.endsWith(".gitignore");
}

/** Add or reconcile the plan repo's origin. Never pushes. */
function ensureRemote(planDir: string, url: string, force: boolean): PlanInitResult["remote"] {
  const existing = runGit(["remote", "get-url", "origin"], planDir);
  if (existing.status !== 0) {
    const add = runGit(["remote", "add", "origin", url], planDir);
    if (add.status !== 0) {
      throw new CliError(ErrCode.IO, `git remote add origin failed: ${add.stderr.trim()}`);
    }
    return "added";
  }
  if (existing.stdout.trim() === url) return "unchanged";
  if (!force) {
    throw new CliError(
      ErrCode.CONFLICT,
      `origin already set to ${existing.stdout.trim()} (not ${url}) — re-run with --force to replace it`,
    );
  }
  const set = runGit(["remote", "set-url", "origin", url], planDir);
  if (set.status !== 0) {
    throw new CliError(ErrCode.IO, `git remote set-url origin failed: ${set.stderr.trim()}`);
  }
  return "updated";
}

/** Parse argv for `plan init` and run it. */
export function handlePlanInit(argv: string[], json: boolean, help: string): Result<unknown> {
  const opts: PlanInitOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return ok({ help });
    if (a === "--json") { json = true; continue; }
    if (a === "--force") { opts.force = true; continue; }
    if (a === "--remote" || a.startsWith("--remote=")) {
      const v = a.startsWith("--remote=") ? a.slice("--remote=".length) : argv[++i];
      if (v === undefined || v === "") throw new CliError(ErrCode.USAGE, "--remote requires a value");
      opts.remote = v;
      continue;
    }
    if (a === "--cwd" || a.startsWith("--cwd=")) {
      const v = a.startsWith("--cwd=") ? a.slice("--cwd=".length) : argv[++i];
      if (v === undefined || v === "") throw new CliError(ErrCode.USAGE, "--cwd requires a value");
      opts.cwd = v;
      continue;
    }
    throw new CliError(ErrCode.USAGE, `yaco plan init: unexpected argument '${a}'`);
  }

  const result = runPlanInit(opts);
  return dual(json, result, () => renderPlanInit(result));
}

function renderPlanInit(r: PlanInitResult): string {
  const lines = [
    `plan repo: ${r.planDir}`,
    `  ${r.initialized ? "git init (new repo)" : "already a repo"}`,
    `  .gitignore ${r.gitignoreCreated ? "created" : "kept"}`,
    `  info/exclude ${r.excludeUpdated ? "added /" + r.plan : "already excludes /" + r.plan}`,
    `  .ignore ${r.ignoreUpdated ? "added !" + r.plan + "/" : "already whitelists !" + r.plan + "/"}`,
  ];
  if (r.remote !== "none") lines.push(`  origin ${r.remote}`);
  return lines.join("\n") + "\n";
}
