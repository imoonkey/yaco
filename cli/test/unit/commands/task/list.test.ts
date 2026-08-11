/** Tests for `yaco task list` text/JSON output.
 *
 *  render-foundation re-homed the text branch from `{help}` to `{text}`; the
 *  rendered bytes are unchanged. These pin both the populated table and the
 *  empty-workset message in a sandboxed repo (no yaco.toml → default
 *  `plan/tasks`).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runList } from "../../../../src/commands/task/list.ts";
import { isOk } from "../../../../src/lib/core/result.ts";

const TMP_ROOTS: string[] = [];

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function repoWith(tasks: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-task-list-"));
  TMP_ROOTS.push(root);
  const tasksDir = join(root, "plan", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(tasks));
  return root;
}

describe("yaco task list", () => {
  it("text mode returns a `{text}` envelope with the byte-identical table", () => {
    const repo = repoWith({
      alpha: { parent: null, depends: [], state: "ready", title: "First task" },
      beta: { parent: null, depends: [], state: "done", title: "Second task" },
    });
    const r = runList({ json: false, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // Widest id is "alpha" (5); state padded to 9.
      expect(r.value).toEqual({
        text:
          `alpha  ready      First task\n` +
          `beta   done       Second task\n`,
      });
    }
  });

  it("text mode reports the empty-workset message for an empty graph", () => {
    const repo = repoWith({});
    const tasksPath = resolve(repo, "plan", "tasks");
    const r = runList({ json: false, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ text: `(no active tasks in ${tasksPath})\n` });
    }
  });

  it("JSON mode returns the task graph and paths unchanged", () => {
    const repo = repoWith({
      alpha: { parent: null, depends: [], state: "ready", title: "First task" },
    });
    const r = runList({ json: true, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { tasks: Record<string, unknown>; tasksPath: string };
      expect(Object.keys(v.tasks)).toEqual(["alpha"]);
      expect(v.tasksPath).toBe(resolve(repo, "plan", "tasks"));
    }
  });
});
