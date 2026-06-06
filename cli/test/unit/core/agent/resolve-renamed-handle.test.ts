/** Unit tests for resolveRenamedHandle: normalize a possibly-stale parent
 *  handle to its current name by following the `.renamed-<old>` breadcrumb
 *  chain (cycle-safe). Pins YACO_AGENT_SESSIONS_DIR at a fresh tmp dir. */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRenamedHandle, renameState } from "../../../../src/lib/core/agent/session-state.ts";

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-rename-resolve-"));
  prevDir = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

function breadcrumb(from: string, to: string): void {
  writeFileSync(join(dir, `.renamed-${from}`), to);
}

function stateFile(handle: string): void {
  writeFileSync(join(dir, `${handle}.json`), JSON.stringify({ handle }));
}

describe("resolveRenamedHandle", () => {
  it("returns the handle unchanged when no breadcrumb exists", () => {
    expect(resolveRenamedHandle("parent")).toBe("parent");
  });

  it("follows a single rename breadcrumb", () => {
    breadcrumb("old", "new");
    expect(resolveRenamedHandle("old")).toBe("new");
  });

  it("follows a chained rename to the final handle", () => {
    breadcrumb("a", "b");
    breadcrumb("b", "c");
    expect(resolveRenamedHandle("a")).toBe("c");
  });

  it("prefers a live state file over a stale same-name breadcrumb", () => {
    // A new session reused the freed name "old"; its live state file wins
    // over a lingering .renamed-old breadcrumb from the prior occupant.
    stateFile("old");
    breadcrumb("old", "new");
    expect(resolveRenamedHandle("old")).toBe("old");
  });

  it("is cycle-safe", () => {
    breadcrumb("x", "y");
    breadcrumb("y", "x");
    // Must terminate; the exact endpoint is unimportant as long as it stops.
    expect(["x", "y"]).toContain(resolveRenamedHandle("x"));
  });

  it("resolves the original handle across a chained renameState a→b→c", () => {
    // renameState must keep the incoming a→b breadcrumb alive and re-point it
    // to c, so a child still holding YACO_AGENT_HANDLE=a resolves to the live c.
    stateFile("a");
    renameState("a", "b");
    renameState("b", "c");
    expect(resolveRenamedHandle("a")).toBe("c");
    expect(resolveRenamedHandle("b")).toBe("c");
  });
});
