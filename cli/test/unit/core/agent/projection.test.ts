/** Unit tests for the pure session → row projection shared by the CLI
 *  `agent list` command and the app server's hot state-file reads. Pure: no
 *  tmux, fs, or reconcile — exercised entirely in-memory. */
import { describe, it, expect } from "bun:test";
import {
  isPathDescendantOrEqual,
  normalizeProjectPath,
  resolveProjectForPath,
  toSessionRow,
  type ProjectableSessionState,
  type ProjectRef,
} from "../../../../src/lib/core/agent/projection.ts";
import { NOTICE_MAX } from "../../../../src/lib/core/agent/model.ts";

function state(overrides: Partial<ProjectableSessionState> = {}): ProjectableSessionState {
  return {
    handle: "alpha",
    provider: "claude",
    sessionPath: "/home/me/proj",
    pid: 4242,
    sessionId: "sid-1",
    status: "idle",
    ...overrides,
  };
}

const proj: ProjectRef = { name: "proj", path: "/home/me/proj" };

describe("normalizeProjectPath", () => {
  it("strips trailing separators but preserves root", () => {
    expect(normalizeProjectPath("/a/b/")).toBe("/a/b");
    expect(normalizeProjectPath("/a/b")).toBe("/a/b");
    expect(normalizeProjectPath("/")).toBe("/");
  });
});

describe("isPathDescendantOrEqual", () => {
  it("matches equal and descendant paths, rejects siblings", () => {
    expect(isPathDescendantOrEqual("/a/b", "/a/b")).toBe(true);
    expect(isPathDescendantOrEqual("/a/b/c", "/a/b")).toBe(true);
    expect(isPathDescendantOrEqual("/a/bb", "/a/b")).toBe(false);
    expect(isPathDescendantOrEqual("/a", "/a/b")).toBe(false);
    expect(isPathDescendantOrEqual("", "/a")).toBe(false);
  });
});

describe("resolveProjectForPath", () => {
  const projects: ProjectRef[] = [
    { name: "parent", path: "/work/repo" },
    { name: "child", path: "/work/repo/server" },
  ];

  it("returns the longest-prefix match", () => {
    expect(resolveProjectForPath("/work/repo/server/src", projects)?.name).toBe("child");
    expect(resolveProjectForPath("/work/repo/ui", projects)?.name).toBe("parent");
  });

  it("returns null when nothing matches", () => {
    expect(resolveProjectForPath("/elsewhere", projects)).toBeNull();
  });
});

describe("toSessionRow", () => {
  it("projects a valid state including project and projectPath", () => {
    const row = toSessionRow(state(), proj);
    expect(row).toMatchObject({
      name: "alpha",
      provider: "claude",
      status: "idle",
      project: "proj",
      projectPath: "/home/me/proj",
      sessionPath: "/home/me/proj",
      sessionId: "sid-1",
      pid: 4242,
    });
  });

  it("normalizes a trailing-slash project path", () => {
    const row = toSessionRow(state(), { name: "proj", path: "/home/me/proj/" });
    expect(row?.projectPath).toBe("/home/me/proj");
  });

  it("passes through valid lineage", () => {
    const row = toSessionRow(state({ spawnedBy: "agent", parentSession: "boss" }), proj);
    expect(row).toMatchObject({ spawnedBy: "agent", parentSession: "boss" });
  });

  it("omits lineage when absent and drops an unknown spawnedBy", () => {
    const plain = toSessionRow(state(), proj);
    expect(plain).not.toHaveProperty("spawnedBy");
    expect(plain).not.toHaveProperty("parentSession");

    const weird = toSessionRow(state({ spawnedBy: "user:carrier-pigeon" }), proj);
    expect(weird).not.toHaveProperty("spawnedBy");
  });

  it("rejects states missing handle, provider, or sessionPath", () => {
    expect(toSessionRow(state({ handle: "" }), proj)).toBeNull();
    expect(toSessionRow(state({ provider: "" }), proj)).toBeNull();
    expect(toSessionRow(state({ sessionPath: "" }), proj)).toBeNull();
  });

  it("rejects an unrecognized status (e.g. stopped)", () => {
    expect(toSessionRow(state({ status: "stopped" }), proj)).toBeNull();
  });

  it("emits blockReason for a blocked status with a valid reason", () => {
    const row = toSessionRow(state({ status: "blocked", blockReason: "permission" }), proj);
    expect(row?.blockReason).toBe("permission");
  });

  it("drops blockReason for a blocked status with no reason", () => {
    const row = toSessionRow(state({ status: "blocked" }), proj);
    expect(row).not.toHaveProperty("blockReason");
  });

  it("drops an invalid blockReason on a blocked status", () => {
    const row = toSessionRow(state({ status: "blocked", blockReason: "banana" }), proj);
    expect(row).not.toHaveProperty("blockReason");
  });

  it("drops a stray blockReason when status is not blocked", () => {
    const row = toSessionRow(state({ status: "idle", blockReason: "permission" }), proj);
    expect(row).not.toHaveProperty("blockReason");
  });

  it("defaults a missing sessionId to empty string", () => {
    const row = toSessionRow(state({ sessionId: undefined as unknown as string }), proj);
    expect(row?.sessionId).toBe("");
  });

  it("carries notice through, clamped defensively (F3)", () => {
    const row = toSessionRow(state({ status: "blocked", blockReason: "question", notice: "Ship v1 or wait?" }), proj);
    expect(row?.notice).toBe("Ship v1 or wait?");
  });

  it("re-clamps an oversized state-file notice at the boundary", () => {
    const row = toSessionRow(state({ notice: "z".repeat(NOTICE_MAX + 300) }), proj);
    expect(row?.notice?.length).toBe(NOTICE_MAX + 1); // NOTICE_MAX + ellipsis
    expect(row?.notice?.endsWith("…")).toBe(true);
  });

  it("omits notice when absent or empty", () => {
    expect(toSessionRow(state({}), proj)).not.toHaveProperty("notice");
    expect(toSessionRow(state({ notice: "   " }), proj)).not.toHaveProperty("notice");
  });
});
