/** Unit tests for the locked attach/detach delta mutation on `task.agents`. */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { formatJson, loadTaskStore } from "../../../../src/lib/core/task/index.ts";
import { applyAgentLink, mutateTaskAgentLink } from "../../../../src/lib/core/task/link.ts";

function repoWith(task: Record<string, unknown>): { tasksPath: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "task-link-"));
  const tasksPath = join(root, "tasks");
  const file = join(tasksPath, "tasks.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    formatJson({ t: { parent: null, depends: [], state: "ready", ...task } }),
  );
  return { tasksPath, file };
}

function diskAgents(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf-8")).t.agents;
}

describe("applyAgentLink (pure delta)", () => {
  it("attach appends a missing handle and is idempotent", () => {
    expect(applyAgentLink(undefined, "a", "attach")).toEqual(["a"]);
    expect(applyAgentLink(["a"], "a", "attach")).toEqual(["a"]);
    expect(applyAgentLink(["a"], "b", "attach")).toEqual(["a", "b"]);
  });

  it("detach removes an existing handle and is idempotent", () => {
    expect(applyAgentLink(["a", "b"], "a", "detach")).toEqual(["b"]);
    expect(applyAgentLink(["a"], "a", "detach")).toEqual([]);
    expect(applyAgentLink(undefined, "a", "detach")).toEqual([]);
  });
});

describe("mutateTaskAgentLink", () => {
  it("attach adds a missing handle and is idempotent", async () => {
    const { tasksPath, file } = repoWith({});
    const r1 = await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "attach" });
    expect(r1.agents).toEqual(["claude"]);
    expect(diskAgents(file)).toEqual(["claude"]);

    const r2 = await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "attach" });
    expect(r2.agents).toEqual(["claude"]);
    expect(diskAgents(file)).toEqual(["claude"]);
  });

  it("detach removes a handle and omits agents after the last detach", async () => {
    const { tasksPath, file } = repoWith({ agents: ["claude", "codex"] });

    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "detach" });
    expect(diskAgents(file)).toEqual(["codex"]);

    // Idempotent: detaching an absent handle is a no-op.
    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "detach" });
    expect(diskAgents(file)).toEqual(["codex"]);

    const last = await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "codex", op: "detach" });
    expect(last.agents).toEqual([]);
    const reloaded = JSON.parse(readFileSync(file, "utf-8")).t;
    expect("agents" in reloaded).toBe(false);
  });

  it("upgrades a legacy agent string before mutating", async () => {
    const { tasksPath, file } = repoWith({ agent: "claude" });
    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "codex", op: "attach" });
    expect(diskAgents(file)).toEqual(["claude", "codex"]);
    expect("agent" in JSON.parse(readFileSync(file, "utf-8")).t).toBe(false);
  });

  it("does not change task state, workset, or timestamps", async () => {
    const { tasksPath } = repoWith({
      state: "running",
      workset: "backlog",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "attach" });
    const t = (await loadTaskStore(tasksPath)).tasks.t!;
    expect(t.state).toBe("running");
    expect(t.workset).toBe("backlog");
    expect(t.created).toBe("2026-01-01T00:00:00Z");
    expect(t.updated).toBe("2026-01-01T00:00:00Z");
  });

  it("preserves an absent workset on a legacy task instead of synthesizing one", async () => {
    // No `workset` key on disk — store normalization would default it to
    // "active", but the link mutation must not persist that.
    const { tasksPath, file } = repoWith({});
    expect("workset" in JSON.parse(readFileSync(file, "utf-8")).t).toBe(false);

    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "attach" });
    const onDisk = JSON.parse(readFileSync(file, "utf-8")).t;
    expect("workset" in onDisk).toBe(false);
    expect(onDisk.agents).toEqual(["claude"]);
  });

  it("leaves file-mate tasks byte-identical (no workset/agent normalization)", async () => {
    const root = mkdtempSync(join(tmpdir(), "task-link-"));
    const tasksPath = join(root, "tasks");
    const file = join(tasksPath, "tasks.json");
    mkdirSync(dirname(file), { recursive: true });
    // `other` lacks workset and still carries a legacy `agent` — neither must
    // change when we attach to `t`.
    writeFileSync(
      file,
      formatJson({
        t: { parent: null, depends: [], state: "ready" },
        other: { parent: null, depends: [], state: "ready", agent: "legacy" },
      }),
    );

    await mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "claude", op: "attach" });
    const other = JSON.parse(readFileSync(file, "utf-8")).other;
    expect(other).toEqual({ parent: null, depends: [], state: "ready", agent: "legacy" });
  });

  it("rejects an invalid session handle", async () => {
    const { tasksPath } = repoWith({});
    await expect(
      mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "bad handle!", op: "attach" }),
    ).rejects.toThrow(/session handle must match/);
  });

  it("rejects a missing task", async () => {
    const { tasksPath } = repoWith({});
    await expect(
      mutateTaskAgentLink({ tasksPath, taskId: "ghost", sessionHandle: "claude", op: "attach" }),
    ).rejects.toThrow(/not found/);
  });

  it("concurrent attaches do not lose handles through full-array overwrite", async () => {
    const { tasksPath, file } = repoWith({});
    await Promise.all([
      mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "a", op: "attach" }),
      mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "b", op: "attach" }),
      mutateTaskAgentLink({ tasksPath, taskId: "t", sessionHandle: "c", op: "attach" }),
    ]);
    expect((diskAgents(file) as string[]).sort()).toEqual(["a", "b", "c"]);
  });
});
