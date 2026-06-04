/** Unit tests for the graph helpers: refs, cycles, state guard, rollup,
 *  and the structured validateGraph report used by `yaco task validate`. */

import { describe, it, expect } from "bun:test";

import {
  checkCycles,
  hasChildren,
  rollup,
  validateGraph,
  validateRefs,
  validateState,
  type TaskGraph,
} from "../../../../src/lib/core/task/index.ts";

function makeGraph(): TaskGraph {
  return {
    root: { parent: null, depends: [], state: "ready", title: "root", description: "x" },
    a: {
      parent: "root",
      depends: [],
      state: "ready",
      title: "a",
      description: "x",
      acceptCriteria: "ok",
    },
    b: {
      parent: "root",
      depends: ["a"],
      state: "ready",
      title: "b",
      description: "x",
      acceptCriteria: "ok",
    },
  };
}

describe("hasChildren / childrenOf", () => {
  it("reports true for a milestone", () => {
    const t = makeGraph();
    expect(hasChildren(t, "root")).toBe(true);
    expect(hasChildren(t, "a")).toBe(false);
  });
});

describe("validateRefs", () => {
  it("rejects self-reference via parent", () => {
    const t = makeGraph();
    t["a"]!.parent = "a";
    expect(() => validateRefs(t, "a", t["a"]!)).toThrow(/self-reference/);
  });

  it("rejects self-reference via depends", () => {
    const t = makeGraph();
    t["a"]!.depends = ["a"];
    expect(() => validateRefs(t, "a", t["a"]!)).toThrow(/self-reference/);
  });

  it("rejects missing parent", () => {
    const t = makeGraph();
    t["a"]!.parent = "nope";
    expect(() => validateRefs(t, "a", t["a"]!)).toThrow(/parent 'nope' not found/);
  });

  it("rejects missing depends", () => {
    const t = makeGraph();
    t["a"]!.depends = ["nope"];
    expect(() => validateRefs(t, "a", t["a"]!)).toThrow(/depends 'nope' not found/);
  });
});

describe("checkCycles", () => {
  it("detects parent-chain cycles", () => {
    const t = makeGraph();
    t["root"]!.parent = "a";
    expect(() => checkCycles(t)).toThrow(/cycle in parent chain/);
  });

  it("detects depends cycles", () => {
    const t = makeGraph();
    t["a"]!.depends = ["b"];
    t["b"]!.depends = ["a"];
    expect(() => checkCycles(t)).toThrow(/cycle in depends/);
  });

  it("passes on a clean graph", () => {
    expect(() => checkCycles(makeGraph())).not.toThrow();
  });
});

describe("validateState", () => {
  it("rejects invalid state value", () => {
    const t = makeGraph();
    expect(() => validateState(t, "a", "ready", "wat")).toThrow(/invalid state/);
  });

  it("blocks setting state on a milestone", () => {
    const t = makeGraph();
    expect(() => validateState(t, "root", "ready", "running")).toThrow(/milestone task/);
  });

  it("allows milestone state to stay unchanged (no-op)", () => {
    const t = makeGraph();
    expect(() => validateState(t, "root", "ready", "ready")).not.toThrow();
  });

  it("blocks running when a dep is not terminal", () => {
    const t = makeGraph();
    expect(() => validateState(t, "b", "ready", "running")).toThrow(/depends 'a' not terminal/);
  });

  it("allows running when all deps are terminal", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    expect(() => validateState(t, "b", "ready", "running")).not.toThrow();
  });
});

describe("rollup", () => {
  it("promotes a parent to done when every child is terminal", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "done";
    rollup(t, "a");
    expect(t["root"]!.state).toBe("done");
  });

  it("demotes a done parent to running when a child becomes non-terminal", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "done";
    t["root"]!.state = "done";
    t["a"]!.state = "ready";
    rollup(t, "a");
    const finalState: string = t["root"]!.state;
    expect(finalState).toBe("running");
  });
});

describe("validateGraph", () => {
  it("reports clean graph as ok", () => {
    expect(validateGraph(makeGraph()).ok).toBe(true);
  });

  it("reports dangling parent and depends", () => {
    const t = makeGraph();
    t["a"]!.parent = "ghost";
    t["b"]!.depends = ["a", "ghost2"];
    const r = validateGraph(t);
    expect(r.ok).toBe(false);
    expect(r.details!.dangling).toEqual([
      { id: "a", kind: "parent", ref: "ghost" },
      { id: "b", kind: "depends", ref: "ghost2" },
    ]);
  });

  it("reports missing acceptCriteria on leaves", () => {
    const t = makeGraph();
    delete t["a"]!.acceptCriteria;
    const r = validateGraph(t);
    expect(r.ok).toBe(false);
    expect(r.details!.missingAC).toContain("a");
  });

  it("reports cycles", () => {
    const t = makeGraph();
    t["a"]!.depends = ["b"];
    t["b"]!.depends = ["a"];
    const r = validateGraph(t);
    expect(r.ok).toBe(false);
    expect(r.details!.cycles.length).toBeGreaterThan(0);
  });

  it("narrowing by id only reports problems on the parent chain", () => {
    const t = makeGraph();
    delete t["a"]!.acceptCriteria;
    delete t["b"]!.acceptCriteria;
    const r = validateGraph(t, { id: "a" });
    expect(r.ok).toBe(false);
    expect(r.details!.missingAC).toEqual(["a"]);
    expect(r.details!.missingAC).not.toContain("b");
  });
});
