/** Core logic for `yaco plan init` — promote the plan directory into a private,
 *  colocated git repo that the host repo never tracks.
 *
 *  Reproducible per machine and idempotent:
 *    preflight  resolve the host repo root (git rev-parse --show-toplevel) and the
 *               [paths] plan root; refuse if the root working-tree .gitignore
 *               matches it (it would be dimmed in the app and dropped from
 *               colocated-repo detection).
 *    1  git init <plan> in place if it is not already its own repo; ensure
 *       <plan>/.gitignore exists with sane runtime-noise patterns (never
 *       overwrite an existing one).
 *    2  ensure "/<plan>/" is in the host's exclude file — resolved via
 *       `git rev-parse --git-path info/exclude` so a linked worktree (where
 *       .git is a file) is handled correctly — so the host repo never tracks it.
 *    3  ensure "!<plan>/" is in the root .ignore — the exclude entry also makes
 *       ignore-stack tools (rg/fd, agent file search) blind to the plan dir; the
 *       .ignore negation re-includes it at higher precedence (no-op for tools
 *       when the plan dir is tracked).
 *    4  --remote: add origin; a different existing origin is a CONFLICT unless
 *       --force. Never pushes — publishing the plan repo is a separate, personal
 *       step the tool does not assume.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { readYacoProjectPaths } from "../../lib/core/paths/index.ts";
import { runGit } from "../../lib/core/worktree/git.ts";

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
  // resolves to that plan repo, not the host. Detect the signature plan init
  // leaves (a /<name>/ entry in the parent repo's info/exclude) and redirect.
  if (nestedInExcludedParent(repoRoot)) {
    throw new CliError(
      ErrCode.USAGE,
      `${repoRoot} is a colocated repo excluded by its parent — run 'yaco plan init' from the host repo root`,
    );
  }

  const plan = readYacoProjectPaths(repoRoot).plan; // validated + canonicalized
  // Colocated-repo detection is depth-1 only, so the plan root must be a single
  // directory; a nested root would be excluded but never surfaced in the app.
  if (plan.includes("/")) {
    throw new CliError(
      ErrCode.ENV,
      `[paths] plan must be a depth-1 directory for the colocated mechanism, got "${plan}"`,
    );
  }
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
  const excludeUpdated = ensureExcluded(repoRoot, plan);

  // ── 3. root .ignore whitelist ────────────────────────────────────────────
  const ignoreUpdated = ensureLine(join(repoRoot, ".ignore"), `!${plan}/`);

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

/** Ensure "/<plan>/" is a line in the host's info/exclude. Returns whether it
 *  appended (false ⇒ already present). */
function ensureExcluded(repoRoot: string, plan: string): boolean {
  const r = runGit(["rev-parse", "--git-path", "info/exclude"], repoRoot);
  if (r.status !== 0) {
    throw new CliError(
      ErrCode.IO,
      `could not resolve info/exclude: ${r.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  return ensureLine(resolve(repoRoot, r.stdout.trim()), `/${plan}/`);
}

/** Append `entry` as its own line in `filePath` unless already present
 *  (trim-compared per line). Creates the file if absent; never reorders or
 *  rewrites existing lines. Returns whether it appended. */
function ensureLine(filePath: string, entry: string): boolean {
  let current = "";
  try {
    current = readFileSync(filePath, "utf-8");
  } catch {
    /* file may not exist yet — created below */
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return false;

  mkdirSync(dirname(filePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, current + prefix + entry + "\n");
  return true;
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

/** True iff repoRoot's parent is a git repo whose info/exclude already carries
 *  the "/<basename>/" entry plan init writes — i.e. repoRoot is itself a plan
 *  repo and we resolved into it by mistake. */
function nestedInExcludedParent(repoRoot: string): boolean {
  const parent = dirname(repoRoot);
  const r = runGit(["rev-parse", "--git-path", "info/exclude"], parent);
  if (r.status !== 0) return false; // parent not in a git repo
  const excludePath = resolve(parent, r.stdout.trim());
  let content = "";
  try {
    content = readFileSync(excludePath, "utf-8");
  } catch {
    return false;
  }
  const entry = `/${basename(repoRoot)}/`;
  return content.split(/\r?\n/).some((line) => line.trim() === entry);
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
    `  info/exclude ${r.excludeUpdated ? "added /" + r.plan + "/" : "already excludes /" + r.plan + "/"}`,
    `  .ignore ${r.ignoreUpdated ? "added !" + r.plan + "/" : "already whitelists !" + r.plan + "/"}`,
  ];
  if (r.remote !== "none") lines.push(`  origin ${r.remote}`);
  return lines.join("\n") + "\n";
}
