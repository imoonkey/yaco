/** Parity test — runs the legacy Python and the new TS implementation on
 *  identical command sequences and diffs the resulting tasks.json
 *  (timestamps stripped). The Python script is the ground truth.
 *
 *  Skipped automatically if Python 3 isn't on PATH (CI image may not have it).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../../src/main.ts");
const PY_SCRIPT = resolve(
  import.meta.dir,
  "../../../../agent-config/global/skills/update-tasks/scripts/update-tasks.py",
);

function pythonAvailable(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
}

function mkRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-task-parity-"));
  // The Python script writes to plan/tasks.json relative to cwd.
  mkdirSync(join(root, "plan"), { recursive: true });
  return root;
}

function runPy(repo: string, args: string[]): { status: number; stderr: string } {
  const r = spawnSync("python3", [PY_SCRIPT, ...args], {
    encoding: "utf-8",
    cwd: repo,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

function runTs(repo: string, id: string, data: unknown): { status: number; stderr: string } {
  const r = spawnSync(
    "bun",
    ["run", BIN, "task", "set", id, "--data", JSON.stringify(data), "--json"],
    {
      encoding: "utf-8",
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

/** Replace every ISO Z timestamp with a placeholder so two runs separated
 *  by milliseconds still compare byte-for-byte. */
function stripTimestamps(body: string): string {
  return body.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, "<ts>");
}

const PY_AVAILABLE = pythonAvailable() && existsSync(PY_SCRIPT);
const describeIfPy = PY_AVAILABLE ? describe : describe.skip;

describeIfPy("parity: update-tasks.py vs yaco task set", () => {
  let pyRepo: string;
  let tsRepo: string;
  beforeEach(() => {
    pyRepo = mkRepo();
    tsRepo = mkRepo();
  });

  it("byte-identical tasks.json for a sequential build of a small graph", () => {
    const steps: { id: string; data: unknown }[] = [
      { id: "root", data: { title: "root", description: "r", acceptCriteria: "x" } },
      { id: "a", data: { parent: "root", title: "a", description: "d", acceptCriteria: "ok", priority: "high", tags: ["t1"] } },
      { id: "b", data: { parent: "root", depends: ["a"], title: "b", description: "d", acceptCriteria: ["one", "two"], scope: ["src/**"] } },
      { id: "a", data: { state: "done" } }, // leaf transition
      { id: "b", data: { state: "running" } }, // depends terminal, allowed
    ];
    for (const s of steps) {
      const py = runPy(pyRepo, ["set", s.id, JSON.stringify(s.data)]);
      expect(py.status).toBe(0);
      const ts = runTs(tsRepo, s.id, s.data);
      expect(ts.status).toBe(0);
    }
    const pyBody = readFileSync(join(pyRepo, "plan/tasks.json"), "utf-8");
    const tsBody = readFileSync(join(tsRepo, "plan/tasks.json"), "utf-8");
    expect(stripTimestamps(tsBody)).toBe(stripTimestamps(pyBody));
  });

  it("byte-identical after a rm + rollup cascade", () => {
    const steps: { id: string; data: unknown }[] = [
      { id: "root", data: { title: "root", description: "r", acceptCriteria: "x" } },
      { id: "a", data: { parent: "root", title: "a", description: "d", acceptCriteria: "ok" } },
      { id: "b", data: { parent: "root", title: "b", description: "d", acceptCriteria: "ok", state: "done" } },
    ];
    for (const s of steps) {
      expect(runPy(pyRepo, ["set", s.id, JSON.stringify(s.data)]).status).toBe(0);
      expect(runTs(tsRepo, s.id, s.data).status).toBe(0);
    }
    // Remove a — leaving only b under root, which is done → root should rollup to done.
    expect(spawnSync("python3", [PY_SCRIPT, "rm", "a"], { cwd: pyRepo }).status).toBe(0);
    expect(
      spawnSync("bun", ["run", BIN, "task", "rm", "a", "--json"], { cwd: tsRepo }).status,
    ).toBe(0);
    const pyBody = readFileSync(join(pyRepo, "plan/tasks.json"), "utf-8");
    const tsBody = readFileSync(join(tsRepo, "plan/tasks.json"), "utf-8");
    expect(stripTimestamps(tsBody)).toBe(stripTimestamps(pyBody));
  });
});
