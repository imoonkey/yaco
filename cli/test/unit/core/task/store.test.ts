/** Unit tests for the on-disk store: byte-format parity with Python output,
 *  and the invariants the asynchronous chunked reader has to keep — the file
 *  order, the merge order, and *which* error a broken tree reports. */

import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { formatJson, loadTaskStore, loadTasks } from "../../../../src/lib/core/task/index.ts";
import { saveTaskStore, saveTasks } from "../../../../src/lib/core/task/store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "task-store-"));
}

function writeGraph(path: string, graph: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatJson(graph));
}

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  parent: null,
  depends: [],
  state: "ready",
  title: "t",
  description: "d",
  acceptCriteria: "ok",
  ...over,
});

describe("loadTasks / saveTasks", () => {
  it("round-trips an empty graph as {}", async () => {
    const f = join(tmp(), "tasks.json");
    saveTasks(f, {});
    expect(readFileSync(f, "utf-8")).toBe("{}\n");
    expect(await loadTasks(f)).toEqual({});
  });

  it("preserves Python-style 2-space indent and final newline", () => {
    const f = join(tmp(), "tasks.json");
    saveTasks(f, {
      x: { parent: null, depends: [], state: "ready", title: "t", description: "d" },
    });
    const body = readFileSync(f, "utf-8");
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain('\n  "x": {');
    expect(body).toContain('\n    "parent": null,');
    expect(body).toContain('\n    "depends": [],');
  });

  it("emits empty list as [] inline, list-of-1 multi-line — matches Python", () => {
    expect(formatJson({ a: [], b: ["one"] }))
      .toBe(
        `{
  "a": [],
  "b": [
    "one"
  ]
}
`,
      );
  });

  it("returns {} for a missing file", async () => {
    expect(await loadTasks(join(tmp(), "nonexistent.json"))).toEqual({});
  });

  it("throws INVALID on malformed JSON", async () => {
    const f = join(tmp(), "bad.json");
    writeFileSync(f, "{ not json", "utf-8");
    await expect(loadTasks(f)).rejects.toThrow(/not valid JSON/);
  });

  it("throws IO — not {} — when the path exists but cannot be read as a file", async () => {
    // ENOENT is the one "no tasks here" answer; every other failure is real.
    const dir = tmp();
    await expect(loadTasks(dir)).rejects.toMatchObject({ code: "IO" });
  });
});

describe("loadTaskStore", () => {
  it("recursively reads tasks.json files and defaults workset", async () => {
    const root = tmp();
    writeGraph(join(root, "tasks", "tasks.json"), { root: task({ title: "r" }) });
    writeGraph(join(root, "tasks", "cli", "tasks.json"), {
      child: task({ parent: "root", title: "c", workset: "backlog" }),
    });

    const store = await loadTaskStore(join(root, "tasks"));
    expect(Object.keys(store.tasks).sort()).toEqual(["child", "root"]);
    expect(store.tasks.root!.workset).toBe("active");
    expect(store.tasks.child!.workset).toBe("backlog");
  });

  it("accepts a single tasks file as the tasks path", async () => {
    const root = tmp();
    const file = join(root, "tasks.json");
    writeGraph(file, { x: task() });
    const store = await loadTaskStore(file);
    expect(store.files).toEqual([file]);
    expect(Object.keys(store.tasks)).toEqual(["x"]);
  });

  it("returns an empty store for an absent tasks path", async () => {
    const store = await loadTaskStore(join(tmp(), "nope"));
    expect(store.files).toEqual([]);
    expect(store.tasks).toEqual({});
  });

  it("rejects duplicate task ids across files", async () => {
    const root = tmp();
    const graph = { x: { parent: null, depends: [], state: "ready" } };
    writeGraph(join(root, "tasks", "tasks.json"), graph);
    writeGraph(join(root, "tasks", "other", "tasks.json"), graph);
    await expect(loadTaskStore(join(root, "tasks"))).rejects.toThrow(/duplicate task id 'x'/);
  });

  it("orders files and merges tasks by sorted path, past the concurrency width", async () => {
    // More files than one chunk, so a reader that merged in completion order
    // rather than file order would scramble both `files` and the graph.
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    const ids = Array.from({ length: 40 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    for (const id of ids) writeGraph(join(tasksRoot, id, "tasks.json"), { [id]: task() });

    const store = await loadTaskStore(tasksRoot);
    expect(store.files).toEqual(ids.map((id) => join(tasksRoot, id, "tasks.json")));
    expect(Object.keys(store.tasks)).toEqual(ids);
  });

  it("reports the first broken file in path order, not the first to fail in time", async () => {
    // Both live in the same chunk and both reject; `Promise.all` would surface
    // whichever the disk finished first.
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    writeGraph(join(tasksRoot, "a", "tasks.json"), { a: task() });
    mkdirSync(join(tasksRoot, "b"), { recursive: true });
    writeFileSync(join(tasksRoot, "b", "tasks.json"), "{ not json");
    mkdirSync(join(tasksRoot, "c"), { recursive: true });
    writeFileSync(join(tasksRoot, "c", "tasks.json"), "[]");

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(loadTaskStore(tasksRoot)).rejects.toThrow(
        new RegExp(`${join(tasksRoot, "b", "tasks.json")} is not valid JSON`),
      );
    }
  });

  it("surfaces an unreadable directory as IO", async () => {
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    const walled = join(tasksRoot, "walled");
    mkdirSync(walled, { recursive: true });
    chmodSync(walled, 0o000);
    try {
      await expect(loadTaskStore(tasksRoot)).rejects.toMatchObject({ code: "IO" });
    } finally {
      chmodSync(walled, 0o755);
    }
  });

  it("names the deepest-first unreadable directory, as the walk order decides", async () => {
    // Depth-first over sorted entries: `a/deep` is reached while descending
    // into `a`, before `b` is looked at. A breadth-first walk would name `b`,
    // which is a different CLI error and a different HTTP failure body.
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    const deep = join(tasksRoot, "a", "deep");
    const shallow = join(tasksRoot, "b");
    mkdirSync(deep, { recursive: true });
    mkdirSync(shallow, { recursive: true });
    chmodSync(deep, 0o000);
    chmodSync(shallow, 0o000);
    try {
      await expect(loadTaskStore(tasksRoot)).rejects.toThrow(
        new RegExp(`failed to read tasks directory ${deep}`),
      );
    } finally {
      chmodSync(deep, 0o755);
      chmodSync(shallow, 0o755);
    }
  });

  it("reports an uninspectable tasks path as IO rather than as an empty graph", async () => {
    // Absence is the only failure that means "no task graph yet". A permission
    // wall answering `{}` is how a server returns 200 over a broken disk.
    const root = tmp();
    const parent = join(root, "locked");
    mkdirSync(join(parent, "tasks"), { recursive: true });
    chmodSync(parent, 0o000);
    try {
      await expect(loadTaskStore(join(parent, "tasks"))).rejects.toMatchObject({ code: "IO" });
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it("does not block the event loop while it walks", async () => {
    // The whole point of rule 5: an unrelated queued callback must get to run
    // during the walk, which a synchronous recursive readdir never allows.
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    for (let i = 0; i < 60; i++) {
      writeGraph(join(tasksRoot, `t${i}`, "tasks.json"), { [`t${i}`]: task() });
    }

    let ticks = 0;
    const tick = (): void => {
      ticks++;
      if (ticks < 1000) setImmediate(tick);
    };
    setImmediate(tick);
    await loadTaskStore(tasksRoot);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("saveTaskStore", () => {
  it("writes existing tasks back to their source file and new tasks to their own bundle file", async () => {
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    const source = join(tasksRoot, "cli", "tasks.json");
    writeGraph(source, { x: task({ title: "x" }) });

    const store = await loadTaskStore(tasksRoot);
    store.tasks.x!.title = "updated";
    store.tasks.y = { parent: null, depends: [], state: "ready", workset: "active", title: "y", description: "d", acceptCriteria: "ok" };
    saveTaskStore(store);

    const sourceGraph = JSON.parse(readFileSync(source, "utf-8"));
    const rootGraph = JSON.parse(readFileSync(join(tasksRoot, "y", "tasks.json"), "utf-8"));
    expect(sourceGraph.x.title).toBe("updated");
    expect(rootGraph.y.title).toBe("y");
  });
});

describe("loadTaskStore agents normalization", () => {
  async function storeWith(over: Record<string, unknown>) {
    const root = tmp();
    const file = join(root, "tasks", "tasks.json");
    writeGraph(file, { t: { parent: null, depends: [], state: "ready", ...over } });
    return { store: await loadTaskStore(join(root, "tasks")), file };
  }

  it("upgrades a legacy agent string to an agents list", async () => {
    const { store } = await storeWith({ agent: "claude" });
    expect(store.tasks.t!.agents).toEqual(["claude"]);
    expect("agent" in store.tasks.t!).toBe(false);
  });

  it("trims, drops empty handles, and dedupes the agents list", async () => {
    const { store } = await storeWith({ agents: [" claude ", "claude", "", "codex"] });
    expect(store.tasks.t!.agents).toEqual(["claude", "codex"]);
  });

  it("prefers agents over a stale legacy agent when both appear", async () => {
    const { store } = await storeWith({ agent: "old", agents: ["claude"] });
    expect(store.tasks.t!.agents).toEqual(["claude"]);
  });

  it("honors an explicit empty agents array over a stale legacy agent", async () => {
    const { store } = await storeWith({ agent: "old", agents: [] });
    expect("agents" in store.tasks.t!).toBe(false);
    expect("agent" in store.tasks.t!).toBe(false);
  });

  it("drops an empty or whitespace-only legacy agent entirely", async () => {
    const { store } = await storeWith({ agent: "  " });
    expect("agents" in store.tasks.t!).toBe(false);
    expect("agent" in store.tasks.t!).toBe(false);
  });

  it("omits agent and writes only agents back to disk", async () => {
    const { store, file } = await storeWith({ agent: "claude" });
    saveTaskStore(store);
    const body = readFileSync(file, "utf-8");
    expect(body).toContain('"agents"');
    expect(body).not.toContain('"agent"');
  });
});
