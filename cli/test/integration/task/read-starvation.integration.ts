/** What rule 5 buys, measured: the chunked reader against the synchronous walk
 *  it replaced.
 *
 *  A heartbeat reschedules itself as fast as the loop allows while each reader
 *  runs, and the **worst** gap within one call — what an already-queued request
 *  waits — is recorded. p95 is taken across calls, not across gaps: pooling
 *  every gap and percentiling the pool buries one 50 ms stall under four
 *  hundred ordinary 1 ms timer gaps.
 *
 *  The baseline here is the synchronous recursive walk this cutover deleted,
 *  reimplemented verbatim, because that is the reader that ran in
 *  `app/server`'s process (`attention-runtime` calls it) and it is where the
 *  design's rule-5 numbers come from. The design's *other* gate — in process
 *  versus the complete subprocess route the task GET replaced — needs the app's
 *  own `buildChildProcessEnv`, so it lives with that code, in
 *  `app/server/src/routes/__tests__/tasks-read-starvation.test.ts`.
 *
 *  Two fixtures, because a task graph is input-controlled and no single sample
 *  bounds it: one sized to this repository's graph and one ten times larger.
 *  Both are generated, so they match its scale rather than its exact topology;
 *  the repository's real graph is measured in the QA artifact. Absolute
 *  milliseconds drift with machine load, which is why every assertion compares
 *  readers measured in the same run rather than naming a millisecond budget.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTaskList } from "../../../src/lib/core/task/index.ts";
import { isOk } from "../../../src/lib/core/result.ts";

/** Sized to this repository's task tree at the time of the cutover — 60 bundle
 *  files, ~1.1 MB — and to the design's ten-times fixture. */
const REAL_FILES = 60;
const LARGE_FILES = 600;
/** Tasks per bundle file, chosen so the smaller fixture lands near 1.1 MB. */
const TASKS_PER_FILE = 12;

let roots: string[] = [];

function seedRepo(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-starvation-"));
  roots.push(root);
  for (let f = 0; f < fileCount; f++) {
    // Two directory levels, so the walk has real breadth and depth to cover.
    const dir = join(root, "plan/tasks", `group${f % 12}`, `bundle${f}`);
    mkdirSync(dir, { recursive: true });
    const graph: Record<string, unknown> = {};
    for (let t = 0; t < TASKS_PER_FILE; t++) {
      graph[`f${f}-t${t}`] = {
        parent: null,
        depends: [],
        state: "ready",
        workset: "active",
        title: `Task ${f}/${t}`,
        description: "d".repeat(600),
        acceptCriteria: ["criterion one", "criterion two", "criterion three"],
        scope: ["cli/src/**", "app/server/src/**"],
      };
    }
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(graph, null, 2) + "\n");
  }
  return root;
}

/** The longest a self-rescheduling timer was kept waiting during one call, plus
 *  that call's wall time.
 *
 *  The closing interval — from the last beat to the moment the work finished —
 *  counts, and for a blocking reader it is the whole measurement: a synchronous
 *  walk lets no beat fire at all, so counting only the beats that happened
 *  would score it a perfect zero. */
async function invoke(work: () => Promise<void>): Promise<{ worstGap: number; wall: number }> {
  let last = performance.now();
  let worstGap = 0;
  let running = true;
  const beat = (): void => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    if (running) setTimeout(beat, 0);
  };
  setTimeout(beat, 0);
  // Let the heartbeat settle, so the first interval is not its own scheduling.
  await new Promise((r) => setTimeout(r, 5));
  worstGap = 0;
  last = performance.now();

  const started = performance.now();
  await work();
  const wall = performance.now() - started;
  running = false;
  return { worstGap: Math.max(worstGap, performance.now() - last), wall };
}

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

async function inProcessList(repoRoot: string): Promise<void> {
  const result = await readTaskList({ repoRoot, workset: "all" });
  if (!isOk(result)) throw new Error(`read failed: ${result.code} ${result.message}`);
}

/** The reader this cutover replaced, verbatim: a synchronous recursive walk
 *  followed by a synchronous read of every file it found. Kept here — and only
 *  here — because a gate that cannot run the old code cannot claim the new one
 *  is better than it. */
function syncList(repoRoot: string): void {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "tasks.json") files.push(path);
    }
  };
  walk(join(repoRoot, "plan/tasks"));
  const tasks: Record<string, unknown> = {};
  for (const file of files.sort()) {
    for (const [id, task] of Object.entries(JSON.parse(readFileSync(file, "utf-8")))) {
      tasks[id] = task;
    }
  }
  if (Object.keys(tasks).length === 0) throw new Error("empty fixture");
}

interface Measurement {
  starvationP95: number;
  wallMedian: number;
}

/** Run one reader `rounds` times under the heartbeat and summarize. */
async function measure(route: () => Promise<void>, rounds: number): Promise<Measurement> {
  const walls: number[] = [];
  const worstGaps: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const { worstGap, wall } = await invoke(route);
    worstGaps.push(worstGap);
    walls.push(wall);
  }
  return { starvationP95: p95(worstGaps), wallMedian: median(walls) };
}

beforeAll(() => {
  roots = [];
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("task read starvation — chunked async vs the synchronous walk it replaced", () => {
  for (const [label, fileCount, rounds] of [
    ["a repository-sized tree", REAL_FILES, 12],
    ["a ten-times tree", LARGE_FILES, 5],
  ] as const) {
    it(`starves a queued callback far less than the synchronous walk on ${label}`, async () => {
      const repo = seedRepo(fileCount);
      // Warm both readers: the first call pays module load and page cache.
      await inProcessList(repo);
      syncList(repo);

      const sync = await measure(async () => syncList(repo), rounds);
      const inProcess = await measure(() => inProcessList(repo), rounds);

      // eslint-disable-next-line no-console
      console.log(
        `[starvation] ${label} (${fileCount} files, ${fileCount * TASKS_PER_FILE} tasks)\n` +
          `  sync walk    starvation p95=${sync.starvationP95.toFixed(2)}ms  wall=${sync.wallMedian.toFixed(1)}ms\n` +
          `  in process   starvation p95=${inProcess.starvationP95.toFixed(2)}ms  wall=${inProcess.wallMedian.toFixed(1)}ms`,
      );

      // The gate: chunked async yields the loop, the synchronous walk holds it.
      expect(inProcess.starvationP95).toBeLessThan(sync.starvationP95);
      // Wall time is recorded above but deliberately not asserted. The two
      // readers absorb host contention differently — asynchronous wall time
      // stretches under load while the synchronous comparator does not — so a
      // ratio between them measured in one sequential run is a false red on a
      // busy machine, which it duly was. The starvation comparison is what
      // this test owns.
      // Anti-vacuity: a reader that never ran would starve nothing.
      expect(sync.starvationP95).toBeGreaterThan(0);
      expect(inProcess.wallMedian).toBeGreaterThan(0);
    });
  }

  it("keeps concurrent reads of two different repo roots isolated", async () => {
    const a = seedRepo(6);
    const b = seedRepo(6);
    // Distinguish the two trees by a task only one of them has.
    writeFileSync(
      join(a, "plan/tasks", "group0", "bundle0", "tasks.json"),
      JSON.stringify({ ONLY_IN_A: { parent: null, depends: [], state: "ready" } }, null, 2) + "\n",
    );
    writeFileSync(
      join(b, "plan/tasks", "group0", "bundle0", "tasks.json"),
      JSON.stringify({ ONLY_IN_B: { parent: null, depends: [], state: "ready" } }, null, 2) + "\n",
    );

    const reads = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        readTaskList({ repoRoot: i % 2 === 0 ? a : b, workset: "all" }),
      ),
    );

    for (const [i, result] of reads.entries()) {
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) continue;
      const ids = Object.keys(result.value.tasks);
      expect(ids).toContain(i % 2 === 0 ? "ONLY_IN_A" : "ONLY_IN_B");
      expect(ids).not.toContain(i % 2 === 0 ? "ONLY_IN_B" : "ONLY_IN_A");
      expect(result.value.tasksPath).toBe(join(i % 2 === 0 ? a : b, "plan/tasks"));
    }
  });

  it("mutates neither the working directory nor the environment", async () => {
    const repo = seedRepo(4);
    const cwdBefore = process.cwd();
    const envBefore = JSON.stringify(process.env);

    await Promise.all([
      readTaskList({ repoRoot: repo, workset: "all" }),
      readTaskList({ repoRoot: repo, workset: "backlog" }),
    ]);

    expect(process.cwd()).toBe(cwdBefore);
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });
});
