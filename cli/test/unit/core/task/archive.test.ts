/** Unit tests for archive: filename rotation, subtree collection,
 *  and dangling-depends pruning. */

import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveTask,
  collectDescendants,
  pickArchivePath,
  type TaskGraph,
} from "../../../../src/lib/core/task/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "task-archive-"));
}

const FIXED = new Date(2026, 5, 3); // June 3, 2026 (month is 0-indexed)

describe("pickArchivePath", () => {
  it("returns YYYYMMDD_<slug>.json for the first archive of the day", () => {
    const dir = tmp();
    expect(pickArchivePath(dir, "thing", FIXED)).toBe(join(dir, "20260603_thing.json"));
  });

  it("rotates _2, _3, ... on same-day collision", () => {
    const dir = tmp();
    writeFileSync(join(dir, "20260603_thing.json"), "x");
    expect(pickArchivePath(dir, "thing", FIXED)).toBe(join(dir, "20260603_thing_2.json"));
    writeFileSync(join(dir, "20260603_thing_2.json"), "x");
    expect(pickArchivePath(dir, "thing", FIXED)).toBe(join(dir, "20260603_thing_3.json"));
  });
});

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
  it("snapshots the subtree, deletes from graph, prunes dangling depends", () => {
    const dir = tmp();
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
    const out = archiveTask(t, "a", dir, FIXED);
    expect(out.archivedIds.sort()).toEqual(["a", "b"]);
    expect(existsSync(out.archivePath)).toBe(true);
    const snap = JSON.parse(readFileSync(out.archivePath, "utf-8"));
    expect(Object.keys(snap).sort()).toEqual(["a", "b"]);
    expect(t["a"]).toBeUndefined();
    expect(t["b"]).toBeUndefined();
    expect(t["survivor"]!.depends).toEqual([]);
  });

  it("refuses to archive a non-terminal task", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "ready" },
    };
    expect(() => archiveTask(t, "a", tmp(), FIXED)).toThrow(/not terminal/);
  });

  it("refuses to archive when any descendant is non-terminal", () => {
    const t: TaskGraph = {
      a: { parent: null, depends: [], state: "done" },
      b: { parent: "a", depends: [], state: "ready" },
    };
    expect(() => archiveTask(t, "a", tmp(), FIXED)).toThrow(/non-terminal children/);
  });
});
