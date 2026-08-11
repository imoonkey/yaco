/** Unit tests for the graph helpers: refs, cycles, state guard, the milestone
 *  state derivation, and the structured validateGraph report used by
 *  `yaco task validate`.
 *
 *  `deriveMilestoneState`/`deriveMilestoneStates` are imported from `graph.ts`
 *  rather than the package index on purpose: they are the store's internals, not
 *  part of the exported `@yaco/cli/core/task` surface (an in-process consumer
 *  gets the derivation applied for it by `loadTaskStore`). */

import { describe, it, expect } from "vitest";

import {
  deriveMilestoneState,
  deriveMilestoneStates,
} from "../../../../src/lib/core/task/graph.ts";
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

describe("deriveMilestoneState", () => {
  it("returns null for a task with no children — a leaf owns its state", () => {
    const t = makeGraph();
    expect(deriveMilestoneState(t, "a")).toBeNull();
    expect(deriveMilestoneState(t, "absent")).toBeNull();
  });

  it("derives ready while no child has moved", () => {
    expect(deriveMilestoneState(makeGraph(), "root")).toBe("ready");
  });

  it("derives running when some children are done and one is still open", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    expect(deriveMilestoneState(t, "root")).toBe("running");
  });

  it("derives running as soon as one child starts", () => {
    const t = makeGraph();
    t["a"]!.state = "running";
    expect(deriveMilestoneState(t, "root")).toBe("running");
  });

  it("derives running when a child is blocked — blocked is a leaf-only signal", () => {
    const t = makeGraph();
    t["a"]!.state = "blocked";
    expect(deriveMilestoneState(t, "root")).toBe("running");
  });

  it("derives done when every child is done", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "done";
    expect(deriveMilestoneState(t, "root")).toBe("done");
  });

  it("derives done when every child is done-or-cancelled", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "cancelled";
    expect(deriveMilestoneState(t, "root")).toBe("done");
  });

  it("derives cancelled when every child was cancelled — nothing was delivered", () => {
    const t = makeGraph();
    t["a"]!.state = "cancelled";
    t["b"]!.state = "cancelled";
    expect(deriveMilestoneState(t, "root")).toBe("cancelled");
  });

  it("reads the recorded child states, never the milestone's own", () => {
    const t = makeGraph();
    t["root"]!.state = "done";
    expect(deriveMilestoneState(t, "root")).toBe("ready");
  });
});

describe("deriveMilestoneStates", () => {
  /** root -> mid -> {x, y}, plus root's own leaf `z`. */
  function nested(): TaskGraph {
    return {
      root: { parent: null, depends: [], state: "ready", title: "root", description: "d" },
      mid: { parent: "root", depends: [], state: "ready", title: "mid", description: "d" },
      x: { parent: "mid", depends: [], state: "done", title: "x", description: "d", acceptCriteria: "ok" },
      y: { parent: "mid", depends: [], state: "done", title: "y", description: "d", acceptCriteria: "ok" },
      z: { parent: "root", depends: [], state: "done", title: "z", description: "d", acceptCriteria: "ok" },
    };
  }

  it("rewrites every milestone, children before parents", () => {
    const t = nested();
    deriveMilestoneStates(t);
    expect(t["mid"]!.state).toBe("done");
    expect(t["root"]!.state).toBe("done");
  });

  it("propagates an open grandchild all the way up", () => {
    const t = nested();
    t["x"]!.state = "running";
    deriveMilestoneStates(t);
    expect(t["mid"]!.state).toBe("running");
    expect(t["root"]!.state).toBe("running");
  });

  it("leaves leaf states untouched", () => {
    const t = nested();
    deriveMilestoneStates(t);
    expect([t["x"]!.state, t["y"]!.state, t["z"]!.state]).toEqual(["done", "done", "done"]);
  });

  it("corrects a recorded state that disagrees with the children", () => {
    const t = makeGraph();
    t["root"]!.state = "done"; // hand-edited: children are both ready
    deriveMilestoneStates(t);
    expect(t["root"]!.state).toBe("ready");
  });

  it("is idempotent", () => {
    const t = nested();
    deriveMilestoneStates(t);
    const once = JSON.stringify(t);
    deriveMilestoneStates(t);
    expect(JSON.stringify(t)).toBe(once);
  });

  it("terminates on a hand-edited parent cycle so validateGraph can report it", () => {
    const t = makeGraph();
    t["root"]!.parent = "a"; // root -> a -> root
    deriveMilestoneStates(t);
    expect(validateGraph(t).details!.cycles.length).toBeGreaterThan(0);
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

  it("promotes a ready parent to running as soon as one child starts", () => {
    const t = makeGraph();
    t["a"]!.state = "running";
    rollup(t, "a");
    expect(t["root"]!.state).toBe("running");
  });

  it("recomputes the whole ancestor chain, not just the nearest parent", () => {
    const t: TaskGraph = {
      root: { parent: null, depends: [], state: "ready", title: "root", description: "d" },
      mid: { parent: "root", depends: [], state: "ready", title: "mid", description: "d" },
      leaf: { parent: "mid", depends: [], state: "done", title: "leaf", description: "d", acceptCriteria: "ok" },
    };
    rollup(t, "leaf");
    expect(t["mid"]!.state).toBe("done");
    expect(t["root"]!.state).toBe("done");
  });

  it("leaves the edited task's own state alone", () => {
    const t = makeGraph();
    t["a"]!.state = "running";
    rollup(t, "a");
    expect(t["a"]!.state).toBe("running");
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

  it("does not report a milestone state that disagrees with its children", () => {
    // A milestone's state is derived by the loader, so a stale recorded value
    // is corrected on read rather than reported as an integrity problem —
    // there is no divergence left for `yaco task validate` to find.
    const t = makeGraph();
    t["root"]!.state = "done"; // children a and b are both ready
    expect(validateGraph(t).ok).toBe(true);
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
