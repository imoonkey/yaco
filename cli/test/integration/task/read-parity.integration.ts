/** Read-path parity: the in-process `readTaskList` against the spawned CLI.
 *
 *  `app/server` stopped spawning `yaco task list --workset all --json` for its
 *  task GET and calls `readTaskList` instead. The claim that makes that a
 *  cutover rather than a rewrite is that both routes produce the same bytes —
 *  so this spawns the real `bin/yaco.mjs` and deep-equals its envelope against
 *  the in-process `Result`, success and failure alike.
 *
 *  The comparison runs through `JSON.parse(JSON.stringify(...))` on the
 *  in-process side on purpose: that is exactly what the app's `c.json()` does
 *  to the value, so it is the shape a browser actually receives.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readTaskList } from "../../../src/lib/core/task/index.ts";
import { isErr, isOk } from "../../../src/lib/core/result.ts";
import { runCli } from "../../helpers/cli-process.ts";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "yaco-read-parity-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeGraph(relPath: string, graph: Record<string, unknown>): void {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(graph, null, 2) + "\n");
}

/** A tree with more files than one read chunk, several nesting depths, every
 *  workset and state in play, and a legacy `agent` field to normalize. */
function seedRealisticGraph(): void {
  writeGraph("plan/tasks/tasks.json", {
    milestone: {
      parent: null,
      depends: [],
      state: "running",
      title: "Milestone",
      description: "d",
      workset: "active",
      agent: "claude",
    },
  });
  for (let i = 0; i < 24; i++) {
    const id = `t${String(i).padStart(2, "0")}`;
    writeGraph(`plan/tasks/${id}/tasks.json`, {
      [id]: {
        parent: "milestone",
        depends: i > 0 ? [`t${String(i - 1).padStart(2, "0")}`] : [],
        state: ["ready", "running", "done", "blocked"][i % 4],
        title: `Task ${i}`,
        description: "d",
        acceptCriteria: ["a", "b"],
        ...(i % 3 === 0 ? { workset: "backlog" } : {}),
        ...(i % 5 === 0 ? { workset: "archive" } : {}),
      },
    });
  }
  writeGraph("plan/tasks/deep/nested/further/tasks.json", {
    buried: { parent: null, depends: [], state: "ready", title: "Buried", description: "d" },
  });
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

function spawnList(args: string[]): Envelope {
  const r = runCli(["task", "list", ...args, "--json"], {
    cwd: repo,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const line = (r.stdout || r.stderr).trim();
  return JSON.parse(line) as Envelope;
}

const transported = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("readTaskList vs `yaco task list --json`", () => {
  for (const args of [[], ["--workset", "all"], ["--workset", "backlog"], ["--workset", "archive"]]) {
    it(`agrees on the payload for \`task list ${args.join(" ")}\``, async () => {
      seedRealisticGraph();
      const workset = args[1] as "all" | "backlog" | "archive" | undefined;
      const inProcess = await readTaskList({ repoRoot: repo, workset });
      const spawned = spawnList(args);

      expect(isOk(inProcess)).toBe(true);
      expect(spawned.ok).toBe(true);
      if (!isOk(inProcess)) return;
      expect(transported(inProcess.value)).toEqual(spawned.data);
      // Anti-vacuity: an empty graph would make any two readers agree.
      expect(Object.keys((spawned.data as { tasks: object }).tasks).length).toBeGreaterThan(0);
    });
  }

  it("agrees on the payload for a state filter composed with a workset", async () => {
    seedRealisticGraph();
    const inProcess = await readTaskList({ repoRoot: repo, workset: "all", state: "done" });
    const spawned = spawnList(["--workset", "all", "--state", "done"]);

    expect(isOk(inProcess)).toBe(true);
    if (!isOk(inProcess)) return;
    expect(transported(inProcess.value)).toEqual(spawned.data);
    expect(Object.keys((spawned.data as { tasks: object }).tasks).length).toBeGreaterThan(0);
  });

  it("agrees on the payload when yaco.toml relocates the task tree", async () => {
    writeFileSync(join(repo, "yaco.toml"), '[paths]\nplan = "docs"\ntasks = "graph"\n');
    writeGraph("docs/graph/tasks.json", {
      only: { parent: null, depends: [], state: "ready", title: "Only", description: "d" },
    });

    const inProcess = await readTaskList({ repoRoot: repo, workset: "all" });
    expect(isOk(inProcess)).toBe(true);
    if (!isOk(inProcess)) return;
    expect(transported(inProcess.value)).toEqual(spawnList(["--workset", "all"]).data);
  });

  it("agrees on an empty tree", async () => {
    const inProcess = await readTaskList({ repoRoot: repo, workset: "all" });
    expect(isOk(inProcess)).toBe(true);
    if (!isOk(inProcess)) return;
    expect(transported(inProcess.value)).toEqual(spawnList(["--workset", "all"]).data);
  });
});

describe("readTaskList vs `yaco task list --json` — failures", () => {
  const cases: { name: string; seed: () => void; code: string }[] = [
    {
      name: "malformed JSON in a task file",
      seed: () => {
        mkdirSync(join(repo, "plan/tasks"), { recursive: true });
        writeFileSync(join(repo, "plan/tasks/tasks.json"), "{ not json");
      },
      code: "INVALID",
    },
    {
      name: "a task file holding a JSON array",
      seed: () => writeGraph("plan/tasks/tasks.json", [] as unknown as Record<string, unknown>),
      code: "INVALID",
    },
    {
      name: "a duplicate task id across two files",
      seed: () => {
        const graph = { dup: { parent: null, depends: [], state: "ready" } };
        writeGraph("plan/tasks/tasks.json", graph);
        writeGraph("plan/tasks/other/tasks.json", graph);
      },
      code: "INVALID",
    },
    {
      name: "an absolute path in yaco.toml [paths]",
      seed: () => writeFileSync(join(repo, "yaco.toml"), '[paths]\ntasks = "/etc"\n'),
      code: "ENV",
    },
    {
      name: "unparseable yaco.toml",
      seed: () => writeFileSync(join(repo, "yaco.toml"), "[paths\ntasks =\n"),
      code: "ENV",
    },
  ];

  for (const { name, seed, code } of cases) {
    it(`reports the same error for ${name}`, async () => {
      seed();
      const inProcess = await readTaskList({ repoRoot: repo, workset: "all" });
      const spawned = spawnList(["--workset", "all"]);

      expect(isErr(inProcess)).toBe(true);
      expect(spawned.ok).toBe(false);
      if (!isErr(inProcess)) return;
      expect(inProcess.code).toBe(code);
      // The app's failure body is built from exactly these three fields.
      expect({
        code: inProcess.code,
        message: inProcess.message,
        details: inProcess.details,
      }).toEqual({
        code: spawned.error!.code,
        message: spawned.error!.message,
        details: spawned.error!.details,
      });
    });
  }

  it("returns the failure rather than throwing it", async () => {
    mkdirSync(join(repo, "plan/tasks"), { recursive: true });
    writeFileSync(join(repo, "plan/tasks/tasks.json"), "{ not json");
    // The app must not acquire an unhandled rejection at the moment its
    // subprocess boundary disappears.
    await expect(readTaskList({ repoRoot: repo, workset: "all" })).resolves.toMatchObject({
      ok: false,
    });
  });
});
