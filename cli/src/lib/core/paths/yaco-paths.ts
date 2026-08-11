/** Resolve repo-relative YACO project paths.
 *
 *  Reads <repoRoot>/yaco.toml [paths] (if present) and merges with the
 *  canonical defaults. Missing yaco.toml ⇒ defaults. Project identity
 *  lives in ~/.yaco/projects.json and is never read or required here.
 *
 *  Path model: `plan` is the explicit plan-root (repo-relative, default
 *  "plan"); `tasks`/`active`/`archive`/`backlog` are *plan-relative* raw keys
 *  (defaults "tasks"/"active"/"archive"/"backlog") joined under the plan root;
 *  `worktrees` is repo-relative (default ".worktrees", and lives at the repo
 *  root, not under plan). readYacoProjectPaths() returns the normalized
 *  repo-relative effective paths, so callers keep resolving against repoRoot
 *  unchanged and sub-paths can never disagree with the plan root.
 *
 *  All values must be repo-relative. Absolute paths and any segment equal
 *  to ".." are rejected — both surface as CliError(ENV) so the dispatcher
 *  exits 3 with a machine-readable envelope.
 *
 *  Bun/Node neutral: uses only node:path and node:fs sync APIs.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { parseScopedToml } from "./toml.ts";

export interface YacoProjectPaths {
  plan: string;
  tasks: string;
  active: string;
  archive: string;
  backlog: string;
  worktrees: string;
}

/** Effective repo-relative defaults (plan root applied). */
export const DEFAULT_PROJECT_PATHS: YacoProjectPaths = {
  plan: "plan",
  tasks: "plan/tasks",
  active: "plan/active",
  archive: "plan/archive",
  backlog: "plan/backlog",
  worktrees: ".worktrees",
};

/** Raw config defaults: plan + worktrees are repo-relative; the rest are
 *  plan-relative and get joined under the resolved plan root. */
const RAW_DEFAULTS = {
  plan: "plan",
  worktrees: ".worktrees",
  tasks: "tasks",
  active: "active",
  archive: "archive",
  backlog: "backlog",
};

const PLAN_RELATIVE_KEYS = ["tasks", "active", "archive", "backlog"] as const;

/** Read <repoRoot>/yaco.toml and return resolved repo-relative project paths. */
export function readYacoProjectPaths(repoRoot: string): YacoProjectPaths {
  const configPath = join(repoRoot, "yaco.toml");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { ...DEFAULT_PROJECT_PATHS };
    }
    throw new CliError(
      ErrCode.IO,
      `failed to read ${configPath}: ${(err as Error).message}`,
    );
  }

  // The parser already raises CliError(ENV) with the line-numbered message, so
  // there is nothing left to translate here.
  const sections = parseScopedToml(raw);

  const paths = sections["paths"] ?? {};
  const cfg = { ...RAW_DEFAULTS };

  if ("plan" in paths) {
    cfg.plan = normalizeRepoRelative("plan", paths["plan"]!);
  }
  if ("worktrees" in paths) {
    cfg.worktrees = normalizeRepoRelative("worktrees", paths["worktrees"]!);
  }
  for (const key of PLAN_RELATIVE_KEYS) {
    if (!(key in paths)) continue;
    cfg[key] = normalizeRepoRelative(key, paths[key]!);
  }

  return {
    plan: cfg.plan,
    tasks: join(cfg.plan, cfg.tasks),
    active: join(cfg.plan, cfg.active),
    archive: join(cfg.plan, cfg.archive),
    backlog: join(cfg.plan, cfg.backlog),
    worktrees: cfg.worktrees,
  };
}

/** Validate a `[paths]` value and return its canonical repo-relative form.
 *  Rejects absolute paths, `..` segments, empty/dot-only values, and any
 *  segment starting with `-` (so a value can never be option-injected into a
 *  git argv, e.g. `plan = "--bare"`). Strips `.` segments and redundant
 *  separators so the stored value is canonical (`"./plan"` → `"plan"`), which
 *  keeps the `info/exclude` entry and detection consistent. */
function normalizeRepoRelative(key: string, value: string): string {
  if (isAbsolute(value)) {
    throw new CliError(
      ErrCode.ENV,
      `yaco.toml: [paths].${key} must be repo-relative, got absolute path "${value}"`,
    );
  }
  const segments = value.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  if (segments.includes("..")) {
    throw new CliError(
      ErrCode.ENV,
      `yaco.toml: [paths].${key} must be repo-relative, got path with ".." segment "${value}"`,
    );
  }
  if (segments.length === 0) {
    if (value === "") {
      throw new CliError(ErrCode.ENV, `yaco.toml: [paths].${key} must not be empty`);
    }
    throw new CliError(
      ErrCode.ENV,
      `yaco.toml: [paths].${key} must resolve to a repo-relative subdirectory, got "${value}"`,
    );
  }
  for (const seg of segments) {
    if (seg.startsWith("-")) {
      throw new CliError(
        ErrCode.ENV,
        `yaco.toml: [paths].${key} segment must not start with "-" (got "${value}")`,
      );
    }
  }
  return segments.join("/");
}
