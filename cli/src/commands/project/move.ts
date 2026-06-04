/** `yaco project move` — rekey project metadata after a path move.
 *
 *  Default match mode: exact. Pass `--prefix` to also rewrite any path
 *  rooted under `<old-path>` (sub-cwd sessions, nested worktrees).
 *
 *  Pre-flight refusals (override with `--force`):
 *    - `<new-path>` must exist on disk (caller has moved the files).
 *    - `<old-path>` must NOT exist on disk (caller has finished the move).
 *
 *  Dry-run (default `--dry-run=false`) prints the plan to stderr in text
 *  mode and returns it under `data.plan` in `--json` mode.
 */

import { existsSync, statSync } from "node:fs";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { ok, type Result } from "../../lib/core/result.ts";
import {
  applyPlan,
  countsFor,
  planMove,
  resolveMoveArg,
  type MatchMode,
  type MovePlan,
} from "../../lib/core/project/index.ts";

export interface MoveHandlerOpts {
  json: boolean;
  prefix: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface MoveReport {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  dryRun: boolean;
  rewrote: ReturnType<typeof countsFor>;
  plan: MovePlan;
}

export function runMove(
  oldArg: string,
  newArg: string,
  opts: MoveHandlerOpts,
): Result<unknown> {
  const oldPath = resolveMoveArg(oldArg);
  const newPath = resolveMoveArg(newArg);

  if (oldPath === newPath) {
    throw new CliError(
      ErrCode.USAGE,
      `<old-path> and <new-path> resolve to the same path: ${oldPath}`,
    );
  }

  if (!opts.force) {
    if (!existsSync(newPath)) {
      throw new CliError(
        ErrCode.IO,
        `<new-path> does not exist: ${newPath}. Move the files first (or pass --force).`,
      );
    }
    if (existsSync(oldPath) && isDirectory(oldPath)) {
      throw new CliError(
        ErrCode.IO,
        `<old-path> still exists as a directory: ${oldPath}. Finish the move first (or pass --force).`,
      );
    }
  }

  const mode: MatchMode = opts.prefix ? "prefix" : "exact";
  const plan = planMove({ oldPath, newPath, mode });

  const totalHits =
    plan.sessions.length +
    plan.registry.length +
    plan.claudeProjects.length +
    plan.codexSessions.length +
    plan.codexConfig.length;

  if (totalHits === 0) {
    throw new CliError(
      ErrCode.NOT_FOUND,
      `no metadata references ${oldPath} (mode=${mode})`,
    );
  }

  const rewrote = opts.dryRun ? countsFor(plan) : applyPlan(plan);
  const report: MoveReport = {
    oldPath, newPath, mode,
    dryRun: opts.dryRun,
    rewrote,
    plan,
  };

  if (opts.json) return ok(report);
  return ok({ help: renderText(report) });
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function renderText(report: MoveReport): string {
  const lines: string[] = [];
  const verb = report.dryRun ? "would rewrite" : "rewrote";
  lines.push(`yaco project move (${report.mode}${report.dryRun ? ", dry-run" : ""})`);
  lines.push(`  ${report.oldPath}`);
  lines.push(`    -> ${report.newPath}`);
  lines.push("");
  lines.push(`${verb}:`);
  lines.push(`  yaco sessions       ${report.rewrote.sessions}`);
  lines.push(`  yaco registry       ${report.rewrote.registry}`);
  lines.push(`  ~/.claude/projects  ${report.rewrote.claudeProjects}`);
  lines.push(`  ~/.codex/sessions   ${report.rewrote.codexSessions}`);
  lines.push(`  ~/.codex/config     ${report.rewrote.codexConfig}`);
  lines.push("");
  if (report.plan.sessions.length > 0) {
    lines.push("yaco sessions:");
    for (const s of report.plan.sessions) {
      lines.push(`  ${s.handle}  ${s.oldSessionPath} -> ${s.newSessionPath}`);
    }
    lines.push("");
  }
  if (report.plan.registry.length > 0) {
    lines.push("yaco registry:");
    for (const r of report.plan.registry) {
      lines.push(`  ${r.id}  ${r.oldPath} -> ${r.newPath}`);
    }
    lines.push("");
  }
  if (report.plan.claudeProjects.length > 0) {
    lines.push("~/.claude/projects:");
    for (const c of report.plan.claudeProjects) {
      const tag = c.merge ? " (merge into existing target)" : "";
      lines.push(`  ${c.oldDir}`);
      lines.push(`    -> ${c.newDir}${tag}`);
      lines.push(`       cwd ${c.oldCwd} -> ${c.newCwd}  [${c.files.length} jsonl file(s)]`);
    }
    lines.push("");
  }
  if (report.plan.codexSessions.length > 0) {
    lines.push("~/.codex/sessions:");
    for (const c of report.plan.codexSessions) {
      lines.push(`  ${c.file}`);
      lines.push(`       cwd ${c.oldCwd} -> ${c.newCwd}`);
    }
    lines.push("");
  }
  if (report.plan.codexConfig.length > 0) {
    lines.push("~/.codex/config.toml:");
    for (const c of report.plan.codexConfig) {
      lines.push(`  ${c.oldHeader} -> ${c.newHeader}`);
    }
    lines.push("");
  }
  if (report.dryRun) {
    lines.push("Re-run without --dry-run to apply.");
  } else {
    lines.push("Done.");
  }
  return lines.join("\n") + "\n";
}
