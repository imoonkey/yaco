/** Tests for `yaco task get <id>` and `yaco task list --state <s>`.
 *
 *  Both are pure reads. `get` returns a single record (JSON includes the `id`
 *  the stored graph keys it by; text is a labeled detail block); `--state`
 *  filters the list and composes with `--workset`. Validation and miss paths
 *  surface USAGE / NOT_FOUND CliErrors. Sandboxed repos use the default
 *  `plan/tasks` layout (no yaco.toml).
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runGet, runListState } from "../../../../src/commands/task/get.ts";
import { handleTask } from "../../../../src/commands/task/index.ts";
import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";
import { isOk } from "../../../../src/lib/core/result.ts";

const TMP_ROOTS: string[] = [];

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function repoWith(tasks: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-task-get-"));
  TMP_ROOTS.push(root);
  const tasksDir = join(root, "plan", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(tasks));
  return root;
}

describe("yaco task get", () => {
  it("JSON mode returns {id, task, tasksPath, tasksFile} with id included", async () => {
    const repo = repoWith({
      alpha: { parent: null, depends: ["beta"], state: "ready", title: "First" },
    });
    const r = await runGet("alpha", { json: true, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as {
        id: string;
        task: { state: string; title: string };
        tasksPath: string;
        tasksFile: string;
      };
      expect(v.id).toBe("alpha");
      expect(v.task.state).toBe("ready");
      expect(v.task.title).toBe("First");
      expect(v.tasksPath).toBe(resolve(repo, "plan", "tasks"));
      expect(v.tasksFile).toBe(resolve(repo, "plan", "tasks", "tasks.json"));
    }
  });

  it("reports the task's actual source file in a directory-backed store", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaco-task-get-"));
    TMP_ROOTS.push(root);
    const tasksDir = join(root, "plan", "tasks");
    mkdirSync(join(tasksDir, "alpha"), { recursive: true });
    // Root file holds `beta`; the per-id subdir holds `alpha`.
    writeFileSync(
      join(tasksDir, "tasks.json"),
      JSON.stringify({ beta: { parent: null, depends: [], state: "ready" } }),
    );
    writeFileSync(
      join(tasksDir, "alpha", "tasks.json"),
      JSON.stringify({ alpha: { parent: null, depends: [], state: "ready" } }),
    );
    const r = await runGet("alpha", { json: true, repo: root });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { tasksFile: string };
      expect(v.tasksFile).toBe(resolve(tasksDir, "alpha", "tasks.json"));
    }
  });

  it("text mode returns a labeled detail block", async () => {
    const repo = repoWith({
      alpha: {
        parent: "root",
        depends: ["beta", "gamma"],
        state: "running",
        workset: "active",
        title: "First task",
        agents: ["w-1"],
        scope: ["a.ts", "b.ts"],
        acceptCriteria: ["does X", "does Y"],
        description: "A task.",
      },
    });
    const r = await runGet("alpha", { json: false, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const { text } = r.value as { text: string };
      expect(text).toContain("id:           alpha");
      expect(text).toContain("state:        running");
      expect(text).toContain("title:        First task");
      expect(text).toContain("parent:       root");
      expect(text).toContain("depends:      beta, gamma");
      expect(text).toContain("agents:       w-1");
      expect(text).toContain("scope:        a.ts, b.ts");
      // Multi-line accept criteria align under the value column.
      expect(text).toContain("accept:       does X\n              does Y");
      expect(text).toContain("description:  A task.");
    }
  });

  it("omits absent fields from the text block", async () => {
    const repo = repoWith({
      alpha: { parent: null, depends: [], state: "ready" },
    });
    const r = await runGet("alpha", { json: false, repo });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const { text } = r.value as { text: string };
      expect(text).toContain("id:");
      expect(text).toContain("state:");
      expect(text).not.toContain("depends:");
      expect(text).not.toContain("title:");
      expect(text).not.toContain("parent:");
    }
  });

  it("throws NOT_FOUND on a missing id", async () => {
    const repo = repoWith({ alpha: { parent: null, depends: [], state: "ready" } });
    try {
      await runGet("nope", { json: true, repo });
      throw new Error("expected NOT_FOUND");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ErrCode.NOT_FOUND);
    }
  });
});

describe("yaco task list --state", () => {
  const repo = repoWith({
    a: { parent: null, depends: [], state: "running", workset: "active", title: "A" },
    b: { parent: null, depends: [], state: "ready", workset: "active", title: "B" },
    c: { parent: null, depends: [], state: "running", workset: "backlog", title: "C" },
    d: { parent: null, depends: [], state: "done", workset: "active", title: "D" },
  });

  it("filters by state within the default active workset", async () => {
    const r = await runListState({ json: true, repo, state: "running" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { tasks: Record<string, unknown> };
      // c is running but backlog → excluded by the default active workset.
      expect(Object.keys(v.tasks)).toEqual(["a"]);
    }
  });

  it("composes with --workset", async () => {
    const r = await runListState({ json: true, repo, workset: "all", state: "running" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { tasks: Record<string, unknown> };
      expect(Object.keys(v.tasks).sort()).toEqual(["a", "c"]);
    }
  });

  it("text mode renders the filtered table", async () => {
    const r = await runListState({ json: false, repo, workset: "all", state: "done" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const { text } = r.value as { text: string };
      expect(text).toBe(`d  done       D\n`);
    }
  });

  it("text mode reports an empty filtered set", async () => {
    const tasksPath = resolve(repo, "plan", "tasks");
    const r = await runListState({ json: false, repo, state: "cancelled" });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({
        text: `(no cancelled tasks in active workset in ${tasksPath})\n`,
      });
    }
  });
});

describe("yaco task dispatcher", () => {
  it("rejects an invalid --state with USAGE", async () => {
    await expect(handleTask(["list", "--state", "bogus"], { json: true })).rejects.toMatchObject({
      code: ErrCode.USAGE,
    });
  });

  it("accepts a valid --state through the dispatcher", async () => {
    const repo = repoWith({
      a: { parent: null, depends: [], state: "running", workset: "active", title: "A" },
    });
    const r = await handleTask(["list", "--state", "running", "--repo", repo], { json: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const v = r.value as { tasks: Record<string, unknown> };
      expect(Object.keys(v.tasks)).toEqual(["a"]);
    }
  });

  it("requires an id for `get` with USAGE", async () => {
    await expect(handleTask(["get"], { json: true })).rejects.toMatchObject({
      code: ErrCode.USAGE,
    });
  });
});
