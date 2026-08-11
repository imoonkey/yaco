/** Unit tests for the task-side half of `yaco agent rename` link integrity:
 *  resolving a tasks path from a (possibly worktree/subdir) sessionPath and
 *  rewriting `agents` handle references old -> new. */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadTaskStore,
  resolveTasksPathForSessionPath,
  type TaskGraph,
} from "../../../../src/lib/core/task/index.ts";
import { rewriteTaskAgentHandle } from "../../../../src/lib/core/task/link.ts";
import { saveTasks } from "../../../../src/lib/core/task/store.ts";

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rename-task-"));
  mkdirSync(join(root, "plan", "tasks"), { recursive: true });
  return root;
}

function writeTasks(root: string, graph: TaskGraph): string {
  const tasksPath = join(root, "plan", "tasks");
  saveTasks(join(tasksPath, "tasks.json"), graph);
  return tasksPath;
}

function task(agents?: string[]): TaskGraph[string] {
  return { parent: null, depends: [], state: "ready", ...(agents ? { agents } : {}) };
}

describe("resolveTasksPathForSessionPath", () => {
  it("resolves the project root from the root itself", () => {
    const root = projectRoot();
    expect(resolveTasksPathForSessionPath(root)).toBe(join(root, "plan", "tasks"));
  });

  it("walks up from a nested subdirectory", () => {
    const root = projectRoot();
    const deep = join(root, "src", "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(resolveTasksPathForSessionPath(deep)).toBe(join(root, "plan", "tasks"));
  });

  it("resolves a worktree checkout to its own task store", () => {
    // A worktree is itself a project root (own plan/tasks); nearest root wins.
    const root = projectRoot();
    const worktree = join(root, ".worktrees", "feature");
    mkdirSync(join(worktree, "plan", "tasks"), { recursive: true });
    const sub = join(worktree, "cli", "src");
    mkdirSync(sub, { recursive: true });
    expect(resolveTasksPathForSessionPath(sub)).toBe(join(worktree, "plan", "tasks"));
  });

  it("honors a yaco.toml [paths].tasks override (plan-relative)", () => {
    const root = mkdtempSync(join(tmpdir(), "rename-toml-"));
    writeFileSync(join(root, "yaco.toml"), '[paths]\ntasks = "items"\n');
    expect(resolveTasksPathForSessionPath(root)).toBe(join(root, "plan", "items"));
  });

  it("returns null when no project root is found", () => {
    const orphan = mkdtempSync(join(tmpdir(), "rename-orphan-"));
    expect(resolveTasksPathForSessionPath(orphan)).toBeNull();
  });
});

describe("rewriteTaskAgentHandle", () => {
  it("rewrites the handle in every task that references it", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, {
      t1: task(["old"]),
      t2: task(["keep", "old"]),
      t3: task(["unrelated"]),
      t4: task(),
    });

    const { tasks } = await rewriteTaskAgentHandle(tasksPath, "old", "new");

    expect(tasks.sort()).toEqual(["t1", "t2"]);
    const store = loadTaskStore(tasksPath);
    expect(store.tasks.t1!.agents).toEqual(["new"]);
    expect(store.tasks.t2!.agents).toEqual(["keep", "new"]);
    expect(store.tasks.t3!.agents).toEqual(["unrelated"]);
    expect(store.tasks.t4!.agents).toBeUndefined();
  });

  it("preserves order and dedupes when the new handle already linked", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, { t: task(["a", "old", "new", "b"]) });

    await rewriteTaskAgentHandle(tasksPath, "old", "new");

    expect(loadTaskStore(tasksPath).tasks.t!.agents).toEqual(["a", "new", "b"]);
  });

  it("is idempotent — a second run finds nothing to rewrite", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, { t: task(["old"]) });

    await rewriteTaskAgentHandle(tasksPath, "old", "new");
    const second = await rewriteTaskAgentHandle(tasksPath, "old", "new");

    expect(second.tasks).toEqual([]);
    expect(loadTaskStore(tasksPath).tasks.t!.agents).toEqual(["new"]);
  });

  it("upgrades a legacy `agent` field on a rewritten task and drops it", async () => {
    const root = projectRoot();
    const tasksPath = join(root, "plan", "tasks");
    // Write raw legacy shape directly to disk.
    saveTasks(join(tasksPath, "tasks.json"), {
      t: { parent: null, depends: [], state: "ready", agent: "old" } as TaskGraph[string],
    });

    await rewriteTaskAgentHandle(tasksPath, "old", "new");

    const store = loadTaskStore(tasksPath);
    expect(store.tasks.t!.agents).toEqual(["new"]);
    expect((store.tasks.t as Record<string, unknown>).agent).toBeUndefined();
  });

  it("does not touch unrelated tasks' fields on disk", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, {
      t1: task(["old"]),
      t2: { parent: null, depends: [], state: "ready", title: "untouched" },
    });

    await rewriteTaskAgentHandle(tasksPath, "old", "new");

    // t2 had no workset on disk; the targeted patch must not synthesize one.
    const raw = loadTaskStore(tasksPath);
    expect((raw.tasks.t2 as Record<string, unknown>).title).toBe("untouched");
  });
});
