/** `yaco task archive <id>` — pack a terminal subtree into projects/archive
 *  and prune dangling depends references in the survivors.
 */

import { ok, type Result } from "../../lib/core/result.ts";
import {
  archiveTask,
  loadTasks,
  saveTasks,
  withLock,
} from "../../lib/core/task/index.ts";
import { resolveTaskPaths } from "./paths.ts";

interface ArchiveOpts {
  json: boolean;
  repo?: string | boolean;
}

export async function runArchive(
  id: string,
  opts: ArchiveOpts,
): Promise<Result<unknown>> {
  const paths = resolveTaskPaths(opts.repo);
  let archivedCount = 0;
  let archivePath = "";

  await withLock(
    paths.tasksFile,
    () => {
      const tasks = loadTasks(paths.tasksFile);
      const outcome = archiveTask(tasks, id, paths.archiveDir, new Date());
      archivedCount = outcome.archivedIds.length;
      archivePath = outcome.archivePath;
      saveTasks(paths.tasksFile, tasks);
    },
    { command: `yaco task archive ${id}` },
  );

  if (!opts.json) {
    process.stderr.write(`archived ${archivedCount} tasks → ${archivePath}\n`);
  }

  return ok({ id, archivedCount, archivePath, tasksFile: paths.tasksFile });
}
