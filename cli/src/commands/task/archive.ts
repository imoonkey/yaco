/** `yaco task archive <id>` — mark a terminal subtree as archived.
 */

import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import { loadTaskStore } from "../../lib/core/task/index.ts";
import { archiveTask } from "../../lib/core/task/archive.ts";
import { withLock } from "../../lib/core/task/lock.ts";
import { saveTaskStore } from "../../lib/core/task/store.ts";
import { taskLockTimeoutMs } from "./lock-timeout.ts";
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

  await withLock(
    paths.tasksPath,
    async () => {
      const store = await loadTaskStore(paths.tasksPath);
      const outcome = archiveTask(store.tasks, id);
      archivedCount = outcome.archivedIds.length;
      saveTaskStore(store);
    },
    { command: `yaco task archive ${id}`, timeoutMs: taskLockTimeoutMs() },
  );

  return dual(
    opts.json,
    { archivedCount, workset: "archive" },
    () => `archived ${archivedCount} task${archivedCount === 1 ? "" : "s"}\n`,
  );
}
