/** End-to-end CLI integration: spawns `yaco` and asserts on the envelope.
 *
 *  Covers: set / rm / archive / validate / list, the configured-tasks-path
 *  regression that update-tasks.py had (hardcoded plan/tasks.json),
 *  and the lock-contention + cross-host stale-lock contracts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { lockPathFor } from "../../../src/lib/core/task/index.ts";
import { BUN_BIN, CLI_ENTRY, runCli } from "../../helpers/cli-process.ts";


function runYaco(repo: string, args: string[], stdin?: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const r = runCli(args, { cwd: repo, env: { ...process.env, NO_COLOR: "1", ...env }, input: stdin });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

function mkRepo(opts: { tasksFile?: string; archive?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-task-int-"));
  if (opts.tasksFile || opts.archive) {
    const lines = ["[paths]"];
    if (opts.tasksFile) lines.push(`tasks = "${opts.tasksFile}"`);
    if (opts.archive) lines.push(`archive = "${opts.archive}"`);
    writeFileSync(join(root, "yaco.toml"), lines.join("\n") + "\n");
  }
  return root;
}

function parseJson(line: string): { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } } {
  return JSON.parse(line.endsWith("\n") ? line.slice(0, -1) : line);
}

function defaultTasksPath(repo: string): string {
  return join(repo, "plan/tasks");
}

function defaultTasksFile(repo: string, id: string): string {
  return join(defaultTasksPath(repo), id, "tasks.json");
}

describe("yaco task set / rm / archive / list / validate", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
  });

  it("creates a new task at the configured path", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "root",
      "--data",
      JSON.stringify({ title: "root", description: "d", acceptCriteria: "x" }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(env.ok).toBe(true);
    const data = env.data as { id: string; action: string; task: Record<string, unknown> };
    expect(data.id).toBe("root");
    expect(data.action).toBe("create");
    expect(data.task["state"]).toBe("ready");
    // Default file path
    const tasksJson = JSON.parse(readFileSync(defaultTasksFile(repo, "root"), "utf-8"));
    expect(tasksJson.root.title).toBe("root");
    expect(tasksJson.root.workset).toBe("active");
  });

  it("list filters by workset and can return all worksets", () => {
    for (const [id, workset] of [
      ["active-task", "active"],
      ["backlog-task", "backlog"],
      ["archive-task", "archive"],
    ] as const) {
      const r = runYaco(repo, [
        "task",
        "set",
        id,
        "--data",
        JSON.stringify({
          title: id,
          description: "d",
          acceptCriteria: "ok",
          state: workset === "archive" ? "done" : "ready",
          workset,
        }),
        "--json",
      ]);
      expect(r.status).toBe(0);
    }

    const active = parseJson(runYaco(repo, ["task", "list", "--json"]).stdout).data as { tasks: Record<string, unknown> };
    expect(Object.keys(active.tasks).sort()).toEqual(["active-task"]);

    const backlog = parseJson(runYaco(repo, ["task", "list", "--workset", "backlog", "--json"]).stdout).data as { tasks: Record<string, unknown> };
    expect(Object.keys(backlog.tasks).sort()).toEqual(["backlog-task"]);

    const archive = parseJson(runYaco(repo, ["task", "list", "--workset=archive", "--json"]).stdout).data as { tasks: Record<string, unknown> };
    expect(Object.keys(archive.tasks).sort()).toEqual(["archive-task"]);

    const all = parseJson(runYaco(repo, ["task", "list", "--workset", "all", "--json"]).stdout).data as { tasks: Record<string, unknown> };
    expect(Object.keys(all.tasks).sort()).toEqual(["active-task", "archive-task", "backlog-task"]);
  });

  it("stamps stateEnteredAt on the edited task and on a rollup-flipped parent (R5)", () => {
    runYaco(repo, ["task", "set", "ms", "--data",
      JSON.stringify({ title: "ms", description: "d", acceptCriteria: "x" }), "--json"]);
    runYaco(repo, ["task", "set", "leaf", "--data",
      JSON.stringify({ title: "leaf", description: "d", acceptCriteria: "x", parent: "ms", state: "ready" }), "--json"]);
    const file = defaultTasksFile(repo, "ms");

    // Completing the only child rolls the parent milestone to done.
    const r = runYaco(repo, ["task", "set", "leaf", "--data", JSON.stringify({ state: "done" }), "--json"]);
    expect(r.status).toBe(0);
    const tasks = JSON.parse(readFileSync(file, "utf-8"));
    expect(tasks.leaf.state).toBe("done");
    expect(tasks.ms.state).toBe("done"); // rolled up
    expect(typeof tasks.leaf.stateEnteredAt).toBe("string");
    expect(typeof tasks.ms.stateEnteredAt).toBe("string"); // R5: rollup-flipped parent stamped too

    // A non-state edit must NOT bump stateEnteredAt — the generation stays stable.
    const leafGen = tasks.leaf.stateEnteredAt;
    const parentGen = tasks.ms.stateEnteredAt;
    runYaco(repo, ["task", "set", "leaf", "--data", JSON.stringify({ title: "leaf-renamed" }), "--json"]);
    const after = JSON.parse(readFileSync(file, "utf-8"));
    expect(after.leaf.stateEnteredAt).toBe(leafGen);
    expect(after.ms.stateEnteredAt).toBe(parentGen);
  });

  it("rejects a new task missing title/description", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ acceptCriteria: "x" }),
      "--json",
    ]);
    expect(r.status).toBe(1);
    const env = parseJson(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("INVALID");
    expect(env.error!.message).toMatch(/new task requires/);
  });

  it("rejects positional JSON (--data | --stdin | --file only)", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "{}",
      "--json",
    ]);
    expect(r.status).toBe(2);
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("USAGE");
    expect(env.error!.message).toMatch(/positional JSON is not supported/);
  });

  it("reads payload from --stdin", () => {
    const r = runYaco(
      repo,
      ["task", "set", "root", "--stdin", "--json"],
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "x" }),
    );
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).ok).toBe(true);
  });

  it("--file with missing path fails with USAGE exit 2", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--file",
      "/no/such/file.json",
      "--json",
    ]);
    expect(r.status).toBe(2);
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("USAGE");
    expect(env.error!.message).toContain("/no/such/file.json");
  });

  it("--json response uses `warnings`, not `advisories`", () => {
    // Two tasks sharing the same worktree slug with different repo scopes
    // triggers checkWorktreeScope to emit a warning.
    runYaco(repo, [
      "task",
      "set",
      "a",
      "--data",
      JSON.stringify({
        title: "a",
        description: "d",
        acceptCriteria: "ok",
        worktree: "shared",
        scope: ["src/**"],
      }),
      "--json",
    ]);
    const r = runYaco(repo, [
      "task",
      "set",
      "b",
      "--data",
      JSON.stringify({
        title: "b",
        description: "d",
        acceptCriteria: "ok",
        worktree: "shared",
        scope: ["~/elsewhere/repo/**"],
      }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    const data = env.data as Record<string, unknown>;
    expect(Array.isArray(data["warnings"])).toBe(true);
    expect((data["warnings"] as string[]).length).toBeGreaterThan(0);
    expect(data["advisories"]).toBeUndefined();
  });

  it("updates an existing task and preserves created timestamp", () => {
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    const before = JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8"));
    const created = before.x.created;
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t2", created: "1970-01-01T00:00:00Z" }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8"));
    expect(after.x.created).toBe(created);
    expect(after.x.title).toBe("t2");
  });

  it("rejects leaf with blank acceptCriteria", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d" }),
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error!.message).toMatch(/non-empty acceptCriteria/);
  });

  it("rm refuses a running task", () => {
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ state: "running" }),
      "--json",
    ]);
    const r = runYaco(repo, ["task", "rm", "x", "--json"]);
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error!.code).toBe("CONFLICT");
  });

  it("archive --json returns exactly {archivedCount, workset}", () => {
    runYaco(repo, [
      "task",
      "set",
      "parent",
      "--data",
      JSON.stringify({ title: "p", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    runYaco(repo, [
      "task",
      "set",
      "child",
      "--data",
      JSON.stringify({ parent: "parent", title: "c", description: "d", acceptCriteria: "ok", state: "done" }),
      "--json",
    ]);
    // rollup should now mark parent done; archive parent.
    const r = runYaco(repo, ["task", "archive", "parent", "--json"]);
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(Object.keys(env.data as object).sort()).toEqual([
      "archivedCount",
      "workset",
    ]);
    const data = env.data as { archivedCount: number; workset: string };
    expect(data.archivedCount).toBe(2);
    expect(data.workset).toBe("archive");
    const tasksJson = JSON.parse(readFileSync(defaultTasksFile(repo, "parent"), "utf-8"));
    expect(tasksJson.parent.workset).toBe("archive");
    expect(tasksJson.child.workset).toBe("archive");
  });

  it("validate --json returns {ok:true} on a clean graph", () => {
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    const r = runYaco(repo, ["task", "validate", "--json"]);
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    expect(env.ok).toBe(true);
  });

  it("validate --json returns {ok:false, error.details} on dangling refs", () => {
    // Inject a hand-crafted tasks.json with a dangling depends ref.
    mkdirSync(join(defaultTasksPath(repo), "bad"), { recursive: true });
    writeFileSync(
      join(defaultTasksPath(repo), "bad", "tasks.json"),
      JSON.stringify({
        a: { parent: null, depends: ["ghost"], state: "ready", title: "a", description: "d", acceptCriteria: "ok" },
      }, null, 2) + "\n",
    );
    const r = runYaco(repo, ["task", "validate", "--json"]);
    expect(r.status).toBe(1);
    const env = parseJson(r.stderr);
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("INVALID");
    const details = env.error!.details as { dangling: { id: string; kind: string; ref: string }[] };
    expect(details.dangling.some((d) => d.ref === "ghost")).toBe(true);
  });

  it("validate --json reports milestoneRollup divergence", () => {
    // Hand-write a graph where parent state diverges from its children.
    mkdirSync(join(defaultTasksPath(repo), "bad"), { recursive: true });
    writeFileSync(
      join(defaultTasksPath(repo), "bad", "tasks.json"),
      JSON.stringify({
        p: { parent: null, depends: [], state: "done", title: "p", description: "d" },
        c: { parent: "p", depends: [], state: "ready", title: "c", description: "d", acceptCriteria: "ok" },
      }, null, 2) + "\n",
    );
    const r = runYaco(repo, ["task", "validate", "--json"]);
    expect(r.status).toBe(1);
    const env = parseJson(r.stderr);
    const details = env.error!.details as {
      milestoneRollup: { id: string; recordedState: string; impliedState: string }[];
    };
    expect(details.milestoneRollup.length).toBe(1);
    expect(details.milestoneRollup[0]).toMatchObject({
      id: "p",
      recordedState: "done",
      impliedState: "running",
    });
  });

  it("list returns the configured graph", () => {
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    const r = runYaco(repo, ["task", "list", "--json"]);
    expect(r.status).toBe(0);
    const env = parseJson(r.stdout);
    const data = env.data as { tasks: Record<string, unknown> };
    expect(Object.keys(data.tasks)).toEqual(["x"]);
  });
});

describe("task attach / detach (agents link delta)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkRepo();
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
  });

  function agentsOnDisk(): unknown {
    return JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8")).x.agents;
  }

  it("attach adds a handle, is idempotent, and detach omits the key after last", () => {
    const a = runYaco(repo, ["task", "attach", "x", "w-x", "--json"]);
    expect(a.status).toBe(0);
    expect((parseJson(a.stdout).data as { agents: string[] }).agents).toEqual(["w-x"]);
    expect(agentsOnDisk()).toEqual(["w-x"]);

    // Idempotent attach.
    runYaco(repo, ["task", "attach", "x", "w-x", "--json"]);
    expect(agentsOnDisk()).toEqual(["w-x"]);

    const d = runYaco(repo, ["task", "detach", "x", "w-x", "--json"]);
    expect(d.status).toBe(0);
    expect((parseJson(d.stdout).data as { agents: string[] }).agents).toEqual([]);
    expect("agents" in JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8")).x).toBe(false);
  });

  it("the orchestrate dispatch flow links a worker without writing legacy agent", () => {
    runYaco(repo, ["task", "set", "x", "--data", JSON.stringify({ state: "running" }), "--json"]);
    runYaco(repo, ["task", "attach", "x", "w-x", "--json"]);
    const task = JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8")).x;
    expect(task.state).toBe("running");
    expect(task.agents).toEqual(["w-x"]);
    expect("agent" in task).toBe(false);
  });

  it("rejects an invalid session handle with INVALID exit 1", () => {
    const r = runYaco(repo, ["task", "attach", "x", "bad handle", "--json"]);
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error!.code).toBe("INVALID");
  });

  it("task set refuses to write agents (forces callers through attach/detach)", () => {
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ agents: ["w-other"] }),
      "--json",
    ]);
    expect(r.status).toBe(1);
    const env = parseJson(r.stderr);
    expect(env.error!.code).toBe("INVALID");
    expect(env.error!.message).toMatch(/attach\|detach/);
    // The legacy full-array write never reached disk.
    expect("agents" in JSON.parse(readFileSync(defaultTasksFile(repo, "x"), "utf-8")).x).toBe(false);
  });

  it("rejects attach on a missing task with NOT_FOUND exit 1", () => {
    const r = runYaco(repo, ["task", "attach", "ghost", "w-x", "--json"]);
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error!.code).toBe("NOT_FOUND");
  });

  it("requires both id and handle", () => {
    const r = runYaco(repo, ["task", "attach", "x", "--json"]);
    expect(r.status).toBe(2);
    expect(parseJson(r.stderr).error!.code).toBe("USAGE");
  });
});

describe("configured tasks path (yc-task-ts bug fix)", () => {
  it("honors yaco.toml [paths].tasks file overrides instead of default plan/tasks", () => {
    const repo = mkRepo({ tasksFile: "custom/dir/tasks.json" });
    const expectedTasksFile = join(repo, "plan/custom/dir/tasks.json");
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    const data = parseJson(r.stdout).data as { tasksFile: string; tasksPath: string };
    expect(data.tasksFile).toBe(expectedTasksFile);
    expect(data.tasksPath).toBe(expectedTasksFile);
    expect(existsSync(expectedTasksFile)).toBe(true);
    expect(existsSync(defaultTasksFile(repo, "x"))).toBe(false);
  });

  it("honors yaco.toml [paths].tasks directory overrides under the plan root", () => {
    const repo = mkRepo({ tasksFile: "custom/tasks" });
    const expectedTasksPath = join(repo, "plan/custom/tasks");
    const expectedTasksFile = join(expectedTasksPath, "x", "tasks.json");
    const r = runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    const data = parseJson(r.stdout).data as { tasksFile: string; tasksPath: string };
    expect(data.tasksFile).toBe(expectedTasksFile);
    expect(data.tasksPath).toBe(expectedTasksPath);
    expect(existsSync(expectedTasksFile)).toBe(true);
    expect(existsSync(defaultTasksFile(repo, "x"))).toBe(false);
  });
});

describe("lock contention", () => {
  it("two concurrent set invocations both succeed", async () => {
    const repo = mkRepo();

    // Pre-create the parent so both invocations are pure updates.
    runYaco(repo, [
      "task",
      "set",
      "p",
      "--data",
      JSON.stringify({ title: "p", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);

    const spawnSet = (id: string, title: string) =>
      new Promise<{ stdout: string; stderr: string; status: number }>((resolve) => {
        const child = spawn(
          BUN_BIN,
          [
            "run",
            CLI_ENTRY,
            "task",
            "set",
            id,
            "--data",
            JSON.stringify({
              parent: "p",
              title,
              description: "d",
              acceptCriteria: "ok",
            }),
            "--json",
          ],
          { cwd: repo, env: { ...process.env, NO_COLOR: "1" } },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b.toString("utf-8")));
        child.stderr.on("data", (b) => (stderr += b.toString("utf-8")));
        child.on("close", (code) => resolve({ stdout, stderr, status: code ?? -1 }));
      });

    const [r1, r2] = await Promise.all([spawnSet("a", "alpha"), spawnSet("b", "beta")]);
    expect(r1.status).toBe(0);
    expect(r2.status).toBe(0);

    const final = JSON.parse(readFileSync(defaultTasksFile(repo, "p"), "utf-8"));
    expect(final.a.title).toBe("alpha");
    expect(final.b.title).toBe("beta");
    expect(final.p).toBeTruthy();
  }, 15_000);
});

describe("cross-host stale lock", () => {
  it("validate fails with error.details.staleLocks and set fails with LOCK exit 4", async () => {
    const repo = mkRepo();
    runYaco(repo, [
      "task",
      "set",
      "x",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);

    const tasksPath = defaultTasksPath(repo);
    const lockDir = lockPathFor(tasksPath);
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 99999,
        hostname: hostname() + ".foreign",
        startedAt: "2026-01-01T00:00:00Z",
        command: "foreign",
      }),
    );

    // validate must FAIL (exit 1) and report the stale lock under
    // error.details.staleLocks — cross-host stale-lock is never silent.
    const v = runYaco(repo, ["task", "validate", "--json"]);
    expect(v.status).toBe(1);
    const venv = parseJson(v.stderr);
    expect(venv.ok).toBe(false);
    expect(venv.error!.code).toBe("INVALID");
    const vdetails = venv.error!.details as { staleLocks?: { sameHost?: boolean; notes?: string[] }[] };
    expect(Array.isArray(vdetails.staleLocks)).toBe(true);
    expect(vdetails.staleLocks!.length).toBe(1);
    expect(vdetails.staleLocks![0]!.sameHost).toBe(false);
    expect(vdetails.staleLocks![0]!.notes?.[0]).toContain("cross-host");

    // set must FAIL with LOCK (exit 4) — never auto-broken. Use a short
    // timeout so the test doesn't pay the full 10s wait.
    const setResult = runYaco(
      repo,
      [
        "task",
        "set",
        "y",
        "--data",
        JSON.stringify({ title: "y", description: "d", acceptCriteria: "ok" }),
        "--json",
      ],
      undefined,
      { YACO_TASK_LOCK_TIMEOUT_MS: "200" },
    );
    expect(setResult.status).toBe(4);
    expect(parseJson(setResult.stderr).error!.code).toBe("LOCK");

    // Lock dir still owned by the foreign host — never auto-broken.
    expect(existsSync(lockDir)).toBe(true);
    const ownerNow = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8"));
    expect(ownerNow.hostname).toBe(hostname() + ".foreign");

    rmSync(lockDir, { recursive: true, force: true });
  }, 20_000);
});

describe("local stale-lock recovery", () => {
  it("reclaims a dead-PID lock from this host silently", async () => {
    const repo = mkRepo();
    runYaco(repo, [
      "task",
      "set",
      "seed",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    const tasksPath = defaultTasksPath(repo);
    const lockDir = lockPathFor(tasksPath);
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 8_388_607, // above the typical PID range; reads as ESRCH
        hostname: hostname(),
        startedAt: "2026-01-01T00:00:00Z",
        command: "dead",
      }),
    );
    const r = runYaco(repo, [
      "task",
      "set",
      "after",
      "--data",
      JSON.stringify({ title: "t", description: "d", acceptCriteria: "ok" }),
      "--json",
    ]);
    expect(r.status).toBe(0);
    expect(existsSync(lockDir)).toBe(false);
  });
});
