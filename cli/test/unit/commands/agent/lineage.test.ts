/** Unit tests for deriveSessionLineage: env-precedence at agent start
 *  (agent child / web / terminal), plus stale-handle breadcrumb normalization.
 *  The agent branch resolves the parent handle through the global sessions dir,
 *  so tests that exercise it pin YACO_AGENT_SESSIONS_DIR at a fresh tmp dir. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSessionLineage } from "../../../../src/commands/agent/start.ts";

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaco-lineage-"));
  prevDir = process.env["YACO_AGENT_SESSIONS_DIR"];
  process.env["YACO_AGENT_SESSIONS_DIR"] = dir;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("deriveSessionLineage", () => {
  it("terminal start with no markers", () => {
    expect(deriveSessionLineage({})).toEqual({ spawnedBy: "user:terminal" });
  });

  it("web start via YACO_AGENT_SPAWNED_BY", () => {
    expect(deriveSessionLineage({ YACO_AGENT_SPAWNED_BY: "user:web" })).toEqual({
      spawnedBy: "user:web",
    });
  });

  it("unknown spawn marker falls through to terminal", () => {
    expect(deriveSessionLineage({ YACO_AGENT_SPAWNED_BY: "user:carrier-pigeon" })).toEqual({
      spawnedBy: "user:terminal",
    });
  });

  it("agent child start records the parent handle", () => {
    expect(deriveSessionLineage({ YACO_AGENT_HANDLE: "parent" })).toEqual({
      spawnedBy: "agent",
      parentSession: "parent",
    });
  });

  it("YACO_AGENT_HANDLE wins over the web marker", () => {
    expect(
      deriveSessionLineage({ YACO_AGENT_HANDLE: "parent", YACO_AGENT_SPAWNED_BY: "user:web" }),
    ).toEqual({ spawnedBy: "agent", parentSession: "parent" });
  });

  it("normalizes a stale renamed parent handle through breadcrumbs", () => {
    writeFileSync(join(dir, ".renamed-old-parent"), "new-parent");
    expect(deriveSessionLineage({ YACO_AGENT_HANDLE: "old-parent" })).toEqual({
      spawnedBy: "agent",
      parentSession: "new-parent",
    });
  });

  it("ignores a malformed inherited handle and falls through", () => {
    expect(deriveSessionLineage({ YACO_AGENT_HANDLE: "bad handle!" })).toEqual({
      spawnedBy: "user:terminal",
    });
  });
});
