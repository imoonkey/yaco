/** Unit tests for `yaco agent rename` reference-rewrite side effects.
 *
 *  The authoritative state-file rename is exercised elsewhere; these focus on
 *  the best-effort rewrites: child `parentSession` lineage and task `agents`
 *  links, plus the guarantee that a failing/skipped task rewrite never aborts
 *  the session rename. No tmux session exists for the test handles, so the
 *  tmux/provider branches are inert. Pins YACO_AGENT_SESSIONS_DIR. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rename } from "../../../../src/commands/agent/rename.ts";
import {
  writeState,
  readState,
  type SessionState,
} from "../../../../src/lib/core/agent/session-state.ts";
import { loadTaskStore, type TaskGraph } from "../../../../src/lib/core/task/index.ts";
import { saveTasks } from "../../../../src/lib/core/task/store.ts";

let sessionsDir: string;
let prevDir: string | undefined;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "yaco-rename-link-"));
  prevDir = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = sessionsDir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prevDir;
  rmSync(sessionsDir, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-rename-proj-"));
  mkdirSync(join(root, "plan", "tasks"), { recursive: true });
  return root;
}

function writeTasks(root: string, graph: TaskGraph): string {
  const tasksPath = join(root, "plan", "tasks");
  saveTasks(join(tasksPath, "tasks.json"), graph);
  return tasksPath;
}

function session(overrides: Partial<SessionState>): SessionState {
  return {
    handle: "h",
    provider: "claude",
    sessionPath: "/tmp/proj",
    pid: 0,
    sessionId: "",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function task(agents?: string[]): TaskGraph[string] {
  return { parent: null, depends: [], state: "ready", ...(agents ? { agents } : {}) };
}

describe("rename link integrity", () => {
  it("rewrites task agents and child parentSession, returns no warnings", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, {
      t1: task(["old"]),
      t2: task(["keep", "old"]),
      t3: task(["unrelated"]),
    });

    writeState(session({ handle: "old", sessionPath: root }));
    writeState(session({ handle: "kid", spawnedBy: "agent", parentSession: "old" }));

    const outcome = await rename("old", "new");

    expect(outcome.warnings).toEqual([]);
    expect(outcome.childSessions).toEqual(["kid"]);
    expect(outcome.tasks.sort()).toEqual(["t1", "t2"]);

    // Authoritative session rename happened.
    expect(readState("old")).toBeNull();
    expect(readState("new")?.handle).toBe("new");
    // Child re-pointed.
    expect(readState("kid")?.parentSession).toBe("new");
    // Task links rewritten, order/dedupe preserved, unrelated untouched.
    const store = loadTaskStore(tasksPath);
    expect(store.tasks.t1!.agents).toEqual(["new"]);
    expect(store.tasks.t2!.agents).toEqual(["keep", "new"]);
    expect(store.tasks.t3!.agents).toEqual(["unrelated"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("renames processing sessions immediately", async () => {
    const root = projectRoot();
    writeTasks(root, { t1: task(["old"]) });
    writeState(session({ handle: "old", sessionPath: root, status: "processing" }));

    const outcome = await rename("old", "new");

    expect(outcome.warnings).toEqual([]);
    expect(readState("old")).toBeNull();
    expect(readState("new")?.status).toBe("processing");

    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the task store from a worktree subdirectory sessionPath", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, { t1: task(["old"]) });
    const sub = join(root, "cli", "src");
    mkdirSync(sub, { recursive: true });

    writeState(session({ handle: "old", sessionPath: sub }));

    const outcome = await rename("old", "new");

    expect(outcome.warnings).toEqual([]);
    expect(outcome.tasks).toEqual(["t1"]);
    expect(loadTaskStore(tasksPath).tasks.t1!.agents).toEqual(["new"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("does not abort the rename when the task rewrite throws; surfaces a warning", async () => {
    // A duplicate task id across two tasks.json files makes loadTaskStore (and
    // thus rewriteTaskAgentHandle) throw — a real failure inside the lock, not a
    // skipped store. The authoritative session rename must still complete.
    const root = projectRoot();
    const tasksPath = join(root, "plan", "tasks");
    saveTasks(join(tasksPath, "tasks.json"), { dup: task(["old"]) });
    mkdirSync(join(tasksPath, "extra"), { recursive: true });
    saveTasks(join(tasksPath, "extra", "tasks.json"), { dup: task(["old"]) });

    writeState(session({ handle: "old", sessionPath: root }));
    writeState(session({ handle: "kid", spawnedBy: "agent", parentSession: "old" }));

    const outcome = await rename("old", "new");

    // Session rename + child rewrite are authoritative and complete.
    expect(readState("old")).toBeNull();
    expect(readState("new")?.handle).toBe("new");
    expect(readState("kid")?.parentSession).toBe("new");
    expect(outcome.childSessions).toEqual(["kid"]);
    // Task rewrite failed -> no tasks rewritten, one warning.
    expect(outcome.tasks).toEqual([]);
    expect(outcome.warnings.length).toBe(1);
    expect(outcome.warnings[0]).toContain("task agents rewrite failed");
    expect(outcome.warnings[0]).toContain("duplicate task id");

    rmSync(root, { recursive: true, force: true });
  });

  it("does not abort the rename when no task store resolves; surfaces a warning", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "yaco-rename-orphan-"));
    writeState(session({ handle: "old", sessionPath: orphan, spawnedBy: "user:terminal" }));
    writeState(session({ handle: "kid", spawnedBy: "agent", parentSession: "old" }));

    const outcome = await rename("old", "new");

    // Authoritative rename + child rewrite still succeed.
    expect(readState("new")?.handle).toBe("new");
    expect(readState("kid")?.parentSession).toBe("new");
    expect(outcome.childSessions).toEqual(["kid"]);
    expect(outcome.tasks).toEqual([]);
    expect(outcome.warnings.length).toBe(1);
    expect(outcome.warnings[0]).toContain("no task store resolved");

    rmSync(orphan, { recursive: true, force: true });
  });

  it("is idempotent — re-running against the new handle is a no-op", async () => {
    const root = projectRoot();
    const tasksPath = writeTasks(root, { t1: task(["new"]) });
    writeState(session({ handle: "new", sessionPath: root }));
    writeState(session({ handle: "kid", spawnedBy: "agent", parentSession: "new" }));

    // Rename a different handle that nothing references.
    writeState(session({ handle: "old", sessionPath: root }));
    const outcome = await rename("old", "fresh");

    expect(outcome.tasks).toEqual([]);
    expect(outcome.childSessions).toEqual([]);
    expect(loadTaskStore(tasksPath).tasks.t1!.agents).toEqual(["new"]);
    expect(readState("kid")?.parentSession).toBe("new");

    rmSync(root, { recursive: true, force: true });
  });
});
