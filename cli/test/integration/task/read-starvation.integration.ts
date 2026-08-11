/** The starvation gate for the task read cutover.
 *
 *  What rule 5 actually buys is measured here: an unrelated callback already
 *  queued on the event loop must not wait for a whole task-tree walk. So a
 *  heartbeat reschedules itself as fast as the loop allows while each reader
 *  runs, and the p95 gap between beats — exactly the delay a queued request
 *  experiences — is compared between two readers.
 *
 *  The baseline is the synchronous recursive walk this cutover deleted,
 *  reimplemented here verbatim. That is the honest comparison: it is the reader
 *  `app/server` was calling in process, and it is where the design's numbers
 *  come from. The subprocess route is measured alongside and reported, not
 *  asserted: `execFile` hands the work to a child, so the parent's own
 *  starvation understates that route badly — the app also paid a synchronous
 *  `spawnSync('ssh-add')` per request through `buildChildProcessEnv`, which the
 *  route medians in the QA artifact capture and this file cannot.
 *
 *  Two fixtures, because a task graph is input-controlled and no single sample
 *  bounds it: one the size of this repository's own tree, and one ten times
 *  larger. Absolute milliseconds drift with machine load, which is why every
 *  assertion is a comparison between readers measured in the same run rather
 *  than a fixed millisecond budget.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
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
import { CLI_ENTRY } from "../../helpers/cli-process.ts";

/** This repository's own task tree at the time of the cutover: 60 bundle files
 *  totalling ~1.1 MB. `LARGE` is the design's ten-times synthetic tree. */
const REAL_FILES = 60;
const LARGE_FILES = 600;
/** Tasks per bundle file, sized so the real fixture lands near 1.1 MB. */
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

/** Runs a heartbeat that reschedules itself immediately and returns the gaps
 *  between consecutive beats while `work` runs.
 *
 *  A gap is exactly what an already-queued unrelated request experiences: the
 *  loop owed it a turn and did not give one. The closing gap — from the last
 *  beat to the moment the work finished — is recorded too, and it is the whole
 *  measurement for a reader that blocks: a synchronous walk lets no beat fire
 *  at all, so counting only the beats that happened would score it a perfect
 *  zero. */
async function heartbeatGaps(work: () => Promise<void>): Promise<number[]> {
  const gaps: number[] = [];
  let last = performance.now();
  let running = true;
  const beat = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) setTimeout(beat, 0);
  };
  setTimeout(beat, 0);
  // Let the heartbeat settle, so the first recorded gap is not its own
  // scheduling.
  await new Promise((r) => setTimeout(r, 5));
  gaps.length = 0;
  last = performance.now();
  await work();
  running = false;
  gaps.push(performance.now() - last);
  return gaps;
}

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

function spawnList(repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, "task", "list", "--workset", "all", "--json"],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

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

/** Interleave `rounds` calls of one route with the heartbeat and summarize. */
async function measure(route: () => Promise<void>, rounds: number): Promise<Measurement> {
  const walls: number[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    gaps.push(
      ...(await heartbeatGaps(async () => {
        await route();
      })),
    );
    walls.push(performance.now() - started);
  }
  return { starvationP95: p95(gaps), wallMedian: median(walls) };
}

beforeAll(() => {
  roots = [];
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("task read starvation — in process vs the subprocess route it replaces", () => {
  for (const [label, fileCount, rounds] of [
    ["this repository's tree", REAL_FILES, 12],
    ["a ten-times synthetic tree", LARGE_FILES, 5],
  ] as const) {
    it(`starves a queued callback far less than the synchronous walk on ${label}`, async () => {
      const repo = seedRepo(fileCount);
      // Warm every route: the first call pays module load and page cache.
      await spawnList(repo);
      await inProcessList(repo);
      syncList(repo);

      const sync = await measure(async () => syncList(repo), rounds);
      const inProcess = await measure(() => inProcessList(repo), rounds);
      const subprocess = await measure(() => spawnList(repo), rounds);

      // Recorded for the QA artifact; the assertions are below it.
      // eslint-disable-next-line no-console
      console.log(
        `[starvation] ${label} (${fileCount} files, ${fileCount * TASKS_PER_FILE} tasks)\n` +
          `  sync walk    p95=${sync.starvationP95.toFixed(2)}ms  wall=${sync.wallMedian.toFixed(1)}ms\n` +
          `  in process   p95=${inProcess.starvationP95.toFixed(2)}ms  wall=${inProcess.wallMedian.toFixed(1)}ms\n` +
          `  subprocess   p95=${subprocess.starvationP95.toFixed(2)}ms  wall=${subprocess.wallMedian.toFixed(1)}ms`,
      );

      // The gate: chunked async yields the loop, the synchronous walk holds it.
      expect(inProcess.starvationP95).toBeLessThan(sync.starvationP95);
      // Yielding is not free, but it is cheap: measured at 1.3-2.4x the
      // synchronous walk across runs. The bound is here to catch a wall-time
      // blowup, not to claim parity.
      expect(inProcess.wallMedian).toBeLessThan(sync.wallMedian * 4);
      // The whole point of the cutover: in process beats the spawn outright.
      expect(inProcess.wallMedian).toBeLessThan(subprocess.wallMedian);
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
