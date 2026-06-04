/** Resolve repo-relative YACO project paths.
 *
 *  Reads <repoRoot>/yaco.toml [paths] (if present) and merges with the
 *  canonical defaults. Missing yaco.toml ⇒ defaults. Project identity
 *  lives in ~/.yaco/projects.json and is never read or required here.
 *
 *  All values must be repo-relative. Absolute paths and any segment equal
 *  to ".." are rejected — both surface as CliError(ENV) so the dispatcher
 *  exits 3 with a machine-readable envelope.
 *
 *  Bun/Node neutral: uses only node:path and node:fs sync APIs.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { CliError, ErrCode } from "../errors.ts";
import { parseScopedToml, TomlParseError } from "./toml.ts";

export interface YacoProjectPaths {
  tasks: string;
  active: string;
  archive: string;
  worktrees: string;
}

export const DEFAULT_PROJECT_PATHS: YacoProjectPaths = {
  tasks: "projects/tasks.json",
  active: "projects/active",
  archive: "projects/archive",
  worktrees: ".worktrees",
};

const KEYS: readonly (keyof YacoProjectPaths)[] = [
  "tasks",
  "active",
  "archive",
  "worktrees",
] as const;

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

  let sections: ReturnType<typeof parseScopedToml>;
  try {
    sections = parseScopedToml(raw);
  } catch (err: unknown) {
    if (err instanceof TomlParseError) {
      throw new CliError(ErrCode.ENV, err.message);
    }
    throw err;
  }

  const paths = sections["paths"] ?? {};
  const result: YacoProjectPaths = { ...DEFAULT_PROJECT_PATHS };

  for (const key of KEYS) {
    if (!(key in paths)) continue;
    const value = paths[key]!;
    validateRepoRelative(key, value);
    result[key] = value;
  }
  return result;
}

function validateRepoRelative(key: string, value: string): void {
  if (isAbsolute(value)) {
    throw new CliError(
      ErrCode.ENV,
      `yaco.toml: [paths].${key} must be repo-relative, got absolute path "${value}"`,
    );
  }
  const segments = value.split(/[/\\]/).filter((s) => s.length > 0);
  if (segments.includes("..")) {
    throw new CliError(
      ErrCode.ENV,
      `yaco.toml: [paths].${key} must be repo-relative, got path with ".." segment "${value}"`,
    );
  }
  // Be conservative about platform separators landing in stored values.
  void sep;
}
