/** `yaco task validate [--id <id>]` — read-only graph integrity report.
 *
 *  Whole-graph by default; `--id` narrows to the task plus its parent
 *  chain (so a single ID still gets cycles + dangling refs in its scope).
 *
 *  Cross-host stale locks are part of the error payload (per the design
 *  contract — they MUST be reported, never auto-broken). Same-host
 *  stale locks (dead PID) and live locks are surfaced as advisories
 *  only — they don't fail validate.
 */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { err, type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import {
  describeLock,
  loadTaskStore,
  validateGraph,
  type LockStatus,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface ValidateOpts {
  json: boolean;
  id?: string;
  repo?: string | boolean;
}

export function runValidate(opts: ValidateOpts): Result<unknown> {
  const paths = resolveTaskPaths(opts.repo);
  const store = loadTaskStore(paths.tasksPath);
  const tasks = store.tasks;

  if (opts.id !== undefined && !(opts.id in tasks)) {
    throw new CliError(ErrCode.NOT_FOUND, `task '${opts.id}' not found`);
  }
  const report = validateGraph(tasks, opts.id ? { id: opts.id } : undefined);

  const lock = describeLock(paths.tasksPath);
  const staleLocks = lock.held && lock.sameHost === false ? [lock] : [];
  const localAdvisoryNotes = lock.held && lock.sameHost !== false ? lock.notes ?? [] : [];

  if (!report.ok || staleLocks.length > 0) {
    const details: Record<string, unknown> = { ...report.details };
    if (staleLocks.length > 0) details["staleLocks"] = staleLocks;
    const reason =
      report.ok && staleLocks.length > 0
        ? "cross-host stale lock present (never auto-broken)"
        : "task graph has integrity problems";
    return err(ErrCode.INVALID, reason, details);
  }

  if (!opts.json) {
    for (const note of localAdvisoryNotes) process.stderr.write(`advisory: ${note}\n`);
  }

  return dual(
    opts.json,
    {
      ok: true,
      scope: opts.id ?? "all",
      tasksPath: paths.tasksPath,
      tasksFile: store.defaultFile,
      lock: lock.held ? (lock as LockStatus) : undefined,
    },
    () => `valid: ${opts.id ?? "all"} (${store.defaultFile})\n`,
  );
}
