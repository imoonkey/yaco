/** Unit tests for the on-disk store: byte-format parity with Python output. */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  formatJson,
  loadTaskStore,
  loadTasks,
  saveTaskStore,
  saveTasks,
} from "../../../../src/lib/core/task/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "task-store-"));
}

describe("loadTasks / saveTasks", () => {
  it("round-trips an empty graph as {}", () => {
    const f = join(tmp(), "tasks.json");
    saveTasks(f, {});
    expect(readFileSync(f, "utf-8")).toBe("{}\n");
    expect(loadTasks(f)).toEqual({});
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

  it("returns {} for a missing file", () => {
    expect(loadTasks(join(tmp(), "nonexistent.json"))).toEqual({});
  });

  it("loadTasks throws INVALID on malformed JSON", () => {
    const f = join(tmp(), "bad.json");
    writeFileSync(f, "{ not json", "utf-8");
    expect(() => loadTasks(f)).toThrow(/not valid JSON/);
  });

  it("loadTaskStore recursively reads tasks.json files and defaults workset", () => {
    const root = tmp();
    const a = join(root, "tasks", "tasks.json");
    const b = join(root, "tasks", "cli", "tasks.json");
    mkdirSync(dirname(a), { recursive: true });
    mkdirSync(dirname(b), { recursive: true });
    writeFileSync(a, formatJson({
      root: { parent: null, depends: [], state: "ready", title: "r", description: "d", acceptCriteria: "ok" },
    }));
    writeFileSync(b, formatJson({
      child: { parent: "root", depends: [], state: "ready", title: "c", description: "d", acceptCriteria: "ok", workset: "backlog" },
    }));

    const store = loadTaskStore(join(root, "tasks"));
    expect(Object.keys(store.tasks).sort()).toEqual(["child", "root"]);
    expect(store.tasks.root!.workset).toBe("active");
    expect(store.tasks.child!.workset).toBe("backlog");
  });

  it("loadTaskStore rejects duplicate task ids across files", () => {
    const root = tmp();
    const a = join(root, "tasks", "tasks.json");
    const b = join(root, "tasks", "other", "tasks.json");
    mkdirSync(dirname(a), { recursive: true });
    mkdirSync(dirname(b), { recursive: true });
    const graph = { x: { parent: null, depends: [], state: "ready" } };
    writeFileSync(a, formatJson(graph));
    writeFileSync(b, formatJson(graph));
    expect(() => loadTaskStore(join(root, "tasks"))).toThrow(/duplicate task id 'x'/);
  });

  it("saveTaskStore writes existing tasks back to their source file and new tasks to their own bundle file", () => {
    const root = tmp();
    const tasksRoot = join(root, "tasks");
    const source = join(tasksRoot, "cli", "tasks.json");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, formatJson({
      x: { parent: null, depends: [], state: "ready", title: "x", description: "d", acceptCriteria: "ok" },
    }));

    const store = loadTaskStore(tasksRoot);
    store.tasks.x!.title = "updated";
    store.tasks.y = { parent: null, depends: [], state: "ready", workset: "active", title: "y", description: "d", acceptCriteria: "ok" };
    saveTaskStore(store);

    const sourceGraph = JSON.parse(readFileSync(source, "utf-8"));
    const rootGraph = JSON.parse(readFileSync(join(tasksRoot, "y", "tasks.json"), "utf-8"));
    expect(sourceGraph.x.title).toBe("updated");
    expect(rootGraph.y.title).toBe("y");
  });
});
