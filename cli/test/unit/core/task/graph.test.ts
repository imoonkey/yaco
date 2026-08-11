/** Unit tests for the graph helpers: refs, cycles, state guard, the milestone
 *  state derivation, and the structured validateGraph report used by
 *  `yaco task validate`.
 *
 *  The derivation is exercised through `deriveMilestoneStates` — the function
 *  the loader and both mutation commands actually call — rather than a
 *  test-only accessor, so what these pin is what ships. */

import { describe, it, expect } from "vitest";

import {
  checkCycles,
  deriveMilestoneStates,
  hasChildren,
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

describe("deriveMilestoneStates — the child-state rule", () => {
  /** Derive, then read `root`'s settled state. */
  function derived(t: TaskGraph, id = "root"): string {
    deriveMilestoneStates(t);
    return t[id]!.state;
  }

  it("leaves a task with no children alone — a leaf owns its state", () => {
    const t = makeGraph();
    t["a"]!.state = "blocked";
    deriveMilestoneStates(t);
    expect(t["a"]!.state).toBe("blocked");
    expect(t["b"]!.state).toBe("ready");
  });

  it("derives ready while no child has moved", () => {
    expect(derived(makeGraph())).toBe("ready");
  });

  it("derives running when some children are done and one is still open", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    expect(derived(t)).toBe("running");
  });

  it("derives running as soon as one child starts", () => {
    const t = makeGraph();
    t["a"]!.state = "running";
    expect(derived(t)).toBe("running");
  });

  it("derives running when a child is blocked — blocked is a leaf-only signal", () => {
    const t = makeGraph();
    t["a"]!.state = "blocked";
    expect(derived(t)).toBe("running");
  });

  it("derives done when every child is done", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "done";
    expect(derived(t)).toBe("done");
  });

  it("derives done when every child is done-or-cancelled", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "cancelled";
    expect(derived(t)).toBe("done");
  });

  it("derives cancelled when every child was cancelled — nothing was delivered", () => {
    const t = makeGraph();
    t["a"]!.state = "cancelled";
    t["b"]!.state = "cancelled";
    expect(derived(t)).toBe("cancelled");
  });

  it("reads the children, never the milestone's own recorded state", () => {
    const t = makeGraph();
    t["root"]!.state = "done"; // hand-edited: both children are ready
    expect(derived(t)).toBe("ready");
  });
});

describe("deriveMilestoneStates — the whole graph", () => {
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

  /** A chain of `n` milestones ending in one leaf: depth is the input. */
  function chain(n: number, leafState = "done"): TaskGraph {
    const t: TaskGraph = {};
    for (let i = 0; i < n; i++) {
      t[`m${i}`] = {
        parent: i === 0 ? null : `m${i - 1}`,
        depends: [], state: "ready", title: `m${i}`, description: "d",
      };
    }
    t["leaf"] = {
      parent: `m${n - 1}`, depends: [], state: leafState as "done",
      title: "leaf", description: "d", acceptCriteria: "ok",
    };
    return t;
  }

  it("settles every milestone, children before parents", () => {
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

  it("is idempotent", () => {
    const t = nested();
    deriveMilestoneStates(t);
    const once = JSON.stringify(t);
    deriveMilestoneStates(t);
    expect(JSON.stringify(t)).toBe(once);
  });

  it("re-derives a milestone the caller never named — no chain is privileged", () => {
    // What a reparent looks like in memory: `moving` leaves `old` for `new`.
    // A walk seeded from the edited task would only ever reach `new`.
    const t: TaskGraph = {
      old: { parent: null, depends: [], state: "running", title: "old", description: "d" },
      finished: { parent: "old", depends: [], state: "done", title: "f", description: "d", acceptCriteria: "ok" },
      moving: { parent: "old", depends: [], state: "ready", title: "m", description: "d", acceptCriteria: "ok" },
      fresh: { parent: null, depends: [], state: "ready", title: "new", description: "d" },
    };
    t["moving"]!.parent = "fresh";
    deriveMilestoneStates(t);
    expect(t["old"]!.state).toBe("done"); // its one remaining child is done
    expect(t["fresh"]!.state).toBe("ready");
  });

  it("handles a chain far deeper than the call stack allows", () => {
    // Tree depth is input, so a recursive post-order would throw RangeError
    // here — on exactly the malformed shape that most needs to reach
    // validateGraph and be reported.
    const t = chain(50_000);
    deriveMilestoneStates(t);
    expect(t["m0"]!.state).toBe("done");
    expect(t["m49999"]!.state).toBe("done");
  });

  it("settles a wide-and-deep graph in linear time", () => {
    const t = chain(5_000);
    const started = Date.now();
    deriveMilestoneStates(t);
    expect(Date.now() - started).toBeLessThan(1_000); // quadratic took ~2.9s at this size
  });

  it("terminates on a parent cycle so validateGraph can report it", () => {
    const t = makeGraph();
    t["root"]!.parent = "a"; // root -> a -> root
    deriveMilestoneStates(t);
    expect(validateGraph(t).details!.cycles.length).toBeGreaterThan(0);
  });

  it("terminates on a self-parent", () => {
    const t = makeGraph();
    t["a"]!.parent = "a";
    deriveMilestoneStates(t);
    expect(validateGraph(t).details!.selfReference).toContain("a");
  });

  it("ignores a parent id that is not in the graph", () => {
    const t = makeGraph();
    t["a"]!.parent = "ghost";
    deriveMilestoneStates(t);
    expect(t["a"]!.state).toBe("ready"); // still a leaf, still its own
    expect(t["root"]!.state).toBe("ready"); // `b` alone, still ready
    expect(validateGraph(t).details!.dangling).toContainEqual({ id: "a", kind: "parent", ref: "ghost" });
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

  // A graph that reached `validateGraph` through `loadTaskStore` is already
  // derived, so these can only fire for a caller that composed the published
  // `loadTasks` + `validateGraph` itself. The check is the same rule the
  // derivation applies, so the two cannot drift apart.
  it("reports a milestone recorded done while a child is still open", () => {
    const t = makeGraph();
    t["root"]!.state = "done"; // children a and b are both ready
    const r = validateGraph(t);
    expect(r.ok).toBe(false);
    expect(r.details!.milestoneRollup).toEqual([
      {
        id: "root",
        recordedState: "done",
        impliedState: "ready",
        reason: "milestone state 'done' is not what its children imply ('ready')",
      },
    ]);
  });

  it("reports a milestone left ready after every child finished", () => {
    const t = makeGraph();
    t["a"]!.state = "done";
    t["b"]!.state = "done";
    expect(
      validateGraph(t).details!.milestoneRollup.some(
        (m) => m.id === "root" && m.impliedState === "done",
      ),
    ).toBe(true);
  });

  it("reports nothing once the derivation has run", () => {
    const t = makeGraph();
    t["root"]!.state = "done";
    deriveMilestoneStates(t);
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
