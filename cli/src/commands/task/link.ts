/** `yaco task attach|detach <id> <session-handle>` — link a YACO session
 *  handle to a task through the locked delta mutation.
 *
 *  Thin wrapper over `mutateTaskAgentLink`: it resolves the tasks path the
 *  same way every other `yaco task` subcommand does, then attaches or
 *  detaches one handle. Idempotent; the last detach drops the `agents` key.
 */

import { type Result } from "../../lib/core/result.ts";
import { dual } from "../../lib/core/render.ts";
import {
  mutateTaskAgentLink,
  type TaskAgentLinkOp,
} from "../../lib/core/task/index.ts";
import { taskLockTimeoutMs } from "./lock-timeout.ts";
import { resolveTaskPaths } from "./paths.ts";

interface LinkOpts {
  json: boolean;
  repo?: string | boolean;
}

export async function runLink(
  op: TaskAgentLinkOp,
  id: string,
  handle: string,
  opts: LinkOpts,
): Promise<Result<unknown>> {
  const paths = resolveTaskPaths(opts.repo);
  const result = await mutateTaskAgentLink({
    tasksPath: paths.tasksPath,
    taskId: id,
    sessionHandle: handle,
    op,
    timeoutMs: taskLockTimeoutMs(),
  });
  return dual(
    opts.json,
    { ...result, op, tasksPath: paths.tasksPath },
    () =>
      op === "attach"
        ? `attached '${handle}' to task '${id}'\n`
        : `detached '${handle}' from task '${id}'\n`,
  );
}
