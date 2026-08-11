/** Unit tests for archive: subtree collection and workset marking. */

import { describe, it, expect } from "vitest";

import {
  archiveTask,
  collectDescendants,
  type TaskGraph,
} from "../../../../src/lib/core/task/index.ts";

describe("collectDescendants", () => {
  it("returns all transitive children", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "ready" },
      b: { parent: "a", depends: [], state: "ready" },
      c: { parent: "b", depends: [], state: "ready" },
      d: { parent: null, depends: [], state: "ready" },
    };
    expect(collectDescendants(t, "a").sort()).toEqual(["b", "c"]);
    expect(collectDescendants(t, "d")).toEqual([]);
  });
});

describe("archiveTask", () => {
  it("marks the terminal subtree as archived and keeps graph edges intact", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "done", title: "a", description: "d", acceptCriteria: "ok" },
      b: { parent: "a", depends: [], state: "done", title: "b", description: "d", acceptCriteria: "ok" },
      survivor: {
        parent: null,
        depends: ["b"],
        state: "ready",
        title: "s",
        description: "d",
        acceptCriteria: "ok",
      },
    };
    const out = archiveTask(t, "a");
    expect(out.archivedIds.sort()).toEqual(["a", "b"]);
    expect(t["a"]!.workset).toBe("archive");
    expect(t["b"]!.workset).toBe("archive");
    expect(t["survivor"]!.depends).toEqual(["b"]);
  });

  it("refuses to archive a non-terminal task", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "ready" },
    };
    expect(() => archiveTask(t, "a")).toThrow(/not terminal/);
  });

  it("refuses to archive when any descendant is non-terminal", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "done" },
      b: { parent: "a", depends: [], state: "ready" },
    };
    expect(() => archiveTask(t, "a")).toThrow(/non-terminal children/);
  });
});
