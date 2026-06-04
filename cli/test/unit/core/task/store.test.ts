/** Unit tests for the on-disk store: byte-format parity with Python output. */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatJson,
  loadTasks,
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
});
