import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { tmpdir } from "node:os";
import { originsDir } from "../../../../src/lib/core/paths/yaco-home.ts";
import { recordOriginIfResolved } from "../../../../src/lib/core/agent/origin.ts";
import { originPathForSessionId, readOrigins } from "../../../../src/lib/core/agent/origin-read.ts";
import type { SessionState } from "../../../../src/lib/core/agent/model.ts";

/** One durable origin record, through the chunked reader the history window uses. */
const readOrigin = async (sessionId: string) => (await readOrigins([sessionId])).get(sessionId) ?? null;

const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
let sandbox: string;

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "worker",
    provider: "claude",
    sessionPath: "/repo",
    pid: 1,
    sessionId: "session-1",
    status: "idle",
    createdAt: "2026-06-01T00:00:00.000Z",
    spawnedBy: "user:terminal",
    ...overrides,
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(`${tmpdir()}/yaco-origin-`);
  process.env["YACO_HOME"] = sandbox;
});

afterEach(() => {
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("recordOriginIfResolved", () => {
  it("no-ops for empty, pending, resume, and missing spawn origin states", () => {
    recordOriginIfResolved(state({ sessionId: "" }));
    recordOriginIfResolved(state({ sessionId: "pending:awaiting-first-prompt" }));
    recordOriginIfResolved(state({ sessionId: "resumed-id", resumedFrom: "resumed-id" }));
    recordOriginIfResolved(state({ sessionId: "legacy-id", spawnedBy: undefined }));

    expect(existsSync(originsDir())).toBe(false);
  });

  it("writes one origin record for a resolved session id", async () => {
    recordOriginIfResolved(state({
      sessionId: "session-real",
      spawnedBy: "agent",
      parentSession: "parent",
      handle: "renamed-before-id",
    }));

    expect(await readOrigin("session-real")).toEqual({
      sessionId: "session-real",
      spawnedBy: "agent",
      parentSession: "parent",
      firstHandle: "renamed-before-id",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("uses exclusive create so the first origin record wins", async () => {
    recordOriginIfResolved(state({ sessionId: "dup-id", spawnedBy: "user:terminal", handle: "first" }));
    recordOriginIfResolved(state({ sessionId: "dup-id", spawnedBy: "agent", handle: "second", parentSession: "parent" }));

    expect(await readOrigin("dup-id")).toMatchObject({
      sessionId: "dup-id",
      spawnedBy: "user:terminal",
      firstHandle: "first",
      parentSession: null,
    });
  });

  it("encodes raw session ids so they cannot traverse out of originsDir", async () => {
    const sessionId = "../../evil";
    recordOriginIfResolved(state({ sessionId }));

    const path = originPathForSessionId(sessionId);
    expect(path).not.toBeNull();
    expect(relative(originsDir(), path!)).toBe("..%2F..%2Fevil.json");
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, "utf-8")).toContain(sessionId);
    expect((await readOrigin(sessionId))?.sessionId).toBe(sessionId);
  });

  it("does not throw when the origin directory cannot be created", () => {
    const blocked = `${sandbox}/blocked-file`;
    writeFileSync(blocked, "not a directory");
    process.env["YACO_HOME"] = blocked;

    expect(() => recordOriginIfResolved(state({ sessionId: "mkdir-fails" }))).not.toThrow();
  });

  it("does not throw when the origin record write fails", () => {
    expect(() => recordOriginIfResolved(state({ sessionId: "x".repeat(5000) }))).not.toThrow();
  });
});

describe("readOrigins", () => {
  it("reads a whole history window in one call and omits ids with no record", async () => {
    // Wider than the reader's own chunk, so the result spans several chunks.
    const written = Array.from({ length: 25 }, (_, i) => `known-${i}`);
    for (const sessionId of written) recordOriginIfResolved(state({ sessionId, handle: sessionId }));

    const ids = [...written, "absent-1", "absent-2"];
    const found = await readOrigins(ids);

    expect([...found.keys()].sort()).toEqual([...written].sort());
    expect(found.get("known-7")).toMatchObject({ sessionId: "known-7", firstHandle: "known-7" });
  });

  it("drops a record that is not this session's well-formed origin", async () => {
    for (const [sessionId, body] of [
      ["not-json", "{"],
      ["wrong-id", JSON.stringify({ sessionId: "someone-else", spawnedBy: "agent" })],
      ["bad-origin", JSON.stringify({ sessionId: "bad-origin", spawnedBy: "impostor" })],
    ]) {
      mkdirSync(originsDir(), { recursive: true });
      writeFileSync(originPathForSessionId(sessionId!)!, body!);
    }

    expect(await readOrigins(["not-json", "wrong-id", "bad-origin"])).toEqual(new Map());
  });

  it("returns an empty map for an unresolved session id", async () => {
    expect(await readOrigins(["", "pending:awaiting-first-prompt"])).toEqual(new Map());
  });
});
