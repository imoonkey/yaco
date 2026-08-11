import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeState,
  readState,
  deleteState,
  isStale,
  statePath,
  listStateHandles,
  listByPath,
  stateDir,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";

// Redirect the session-state dir to a tmp fixture for the duration of this
// suite — keeps tests isolated from the real ~/.yaco/sessions root and
// exercises the YACO_AGENT_SESSIONS_DIR override path. The resolver in state.ts
// reads process.env at call time, so this swap is sufficient.
const ORIGINAL_YACO_AGENT_SESSIONS_DIR = process.env.YACO_AGENT_SESSIONS_DIR;
let testStateDir: string;

beforeAll(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "multmux-state-test-"));
  process.env.YACO_AGENT_SESSIONS_DIR = testStateDir;
});

afterAll(() => {
  if (ORIGINAL_YACO_AGENT_SESSIONS_DIR === undefined) delete process.env.YACO_AGENT_SESSIONS_DIR;
  else process.env.YACO_AGENT_SESSIONS_DIR = ORIGINAL_YACO_AGENT_SESSIONS_DIR;
  rmSync(testStateDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "1-claude",
    provider: "claude",
    sessionPath: "/tmp/test-project",
    pid: 12345,
    sessionId: "",
    status: "starting",
    createdAt: "2026-03-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("state", () => {
  // Backed by the tmp dir set up in beforeAll above (YACO_AGENT_SESSIONS_DIR override).
  // Unique handles per test process keep parallel runs from colliding.

  const testPrefix = `test-${process.pid}-${Date.now()}`;

  afterEach(() => {
    // Clean up any test state files
    for (const handle of listStateHandles()) {
      if (handle.startsWith(testPrefix)) {
        deleteState(handle);
      }
    }
  });

  describe("statePath", () => {
    it("returns handle.json under the resolved sessions dir", () => {
      const path = statePath("worker");
      expect(path).toBe(join(testStateDir, "worker.json"));
    });

    it("stateDir() returns the active sessions root", () => {
      expect(stateDir()).toBe(testStateDir);
    });
  });

  describe("writeState / readState", () => {
    it("creates sessions dir and writes state file", () => {
      const handle = `${testPrefix}-write`;
      const state = makeState({ handle });
      writeState(state);

      expect(existsSync(statePath(handle))).toBe(true);

      const read = readState(handle);
      expect(read).toEqual(state);

      deleteState(handle);
    });

    it("overwrites existing state", () => {
      const handle = `${testPrefix}-overwrite`;
      writeState(makeState({ handle, status: "starting" }));
      writeState(makeState({ handle, status: "idle" }));

      const read = readState(handle);
      expect(read?.status).toBe("idle");

      deleteState(handle);
    });

    it("returns null for missing file", () => {
      expect(readState("nonexistent-handle-xyz")).toBeNull();
    });

    it("returns null for corrupt file", () => {
      const handle = `${testPrefix}-corrupt`;
      const path = statePath(handle);
      // Ensure dir exists
      writeState(makeState({ handle }));
      // Corrupt the file
      writeFileSync(path, "not json");

      expect(readState(handle)).toBeNull();

      deleteState(handle);
    });
  });

  describe("deleteState", () => {
    it("removes existing state file", () => {
      const handle = `${testPrefix}-delete`;
      writeState(makeState({ handle }));
      deleteState(handle);

      expect(existsSync(statePath(handle))).toBe(false);
    });

    it("is a no-op for missing file", () => {
      expect(() => deleteState("nonexistent-handle-xyz")).not.toThrow();
    });
  });

  describe("isStale", () => {
    it("returns false for idle status", () => {
      const handle = `${testPrefix}-stale-idle`;
      writeState(makeState({ handle, status: "idle" }));
      expect(isStale(handle)).toBe(false);
      deleteState(handle);
    });

    it("returns false for fresh processing status", () => {
      const handle = `${testPrefix}-stale-fresh`;
      writeState(makeState({ handle, status: "processing" }));
      expect(isStale(handle)).toBe(false);
      deleteState(handle);
    });

    it("returns true for processing status after the short recheck window", () => {
      const handle = `${testPrefix}-stale-old`;
      writeState(makeState({ handle, status: "processing" }));
      const path = statePath(handle);
      const past = new Date(Date.now() - 20 * 1000);
      utimesSync(path, past, past);

      expect(isStale(handle)).toBe(true);
      deleteState(handle);
    });

    it("returns true for blocked status after the short recheck window", () => {
      const handle = `${testPrefix}-stale-blocked`;
      writeState(makeState({ handle, status: "blocked", blockReason: "permission" }));
      const path = statePath(handle);
      const past = new Date(Date.now() - 20 * 1000);
      utimesSync(path, past, past);

      expect(isStale(handle)).toBe(true);
      deleteState(handle);
    });

    it("keeps starting on the longer startup stale threshold", () => {
      const handle = `${testPrefix}-stale-starting-short`;
      writeState(makeState({ handle, status: "starting" }));
      const path = statePath(handle);
      const twentySecondsAgo = new Date(Date.now() - 20 * 1000);
      utimesSync(path, twentySecondsAgo, twentySecondsAgo);
      expect(isStale(handle)).toBe(false);

      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      utimesSync(path, sixMinutesAgo, sixMinutesAgo);
      expect(isStale(handle)).toBe(true);
      deleteState(handle);
    });

    it("returns false for missing file", () => {
      expect(isStale("nonexistent-handle-xyz")).toBe(false);
    });
  });

  describe("listStateHandles", () => {
    it("lists handles from json files", () => {
      const h1 = `${testPrefix}-list-1`;
      const h2 = `${testPrefix}-list-2`;
      writeState(makeState({ handle: h1 }));
      writeState(makeState({ handle: h2 }));

      const handles = listStateHandles();
      expect(handles).toContain(h1);
      expect(handles).toContain(h2);

      deleteState(h1);
      deleteState(h2);
    });
  });

  describe("listByPath", () => {
    it("returns sessions whose sessionPath is under the given path", () => {
      const h1 = `${testPrefix}-path-1`;
      const h2 = `${testPrefix}-path-2`;
      const h3 = `${testPrefix}-path-3`;
      writeState(makeState({ handle: h1, sessionPath: "/foo/bar" }));
      writeState(makeState({ handle: h2, sessionPath: "/foo/bar/sub" }));
      writeState(makeState({ handle: h3, sessionPath: "/foo/baz" }));

      const results = listByPath("/foo/bar");
      const handles = results.map(s => s.handle);
      expect(handles).toContain(h1);
      expect(handles).toContain(h2);
      expect(handles).not.toContain(h3);

      deleteState(h1);
      deleteState(h2);
      deleteState(h3);
    });

    it("is path-boundary-safe", () => {
      const h1 = `${testPrefix}-boundary-1`;
      const h2 = `${testPrefix}-boundary-2`;
      writeState(makeState({ handle: h1, sessionPath: "/foo/bar" }));
      writeState(makeState({ handle: h2, sessionPath: "/foo/bar-old" }));

      const results = listByPath("/foo/bar");
      const handles = results.map(s => s.handle);
      expect(handles).toContain(h1);
      expect(handles).not.toContain(h2);

      deleteState(h1);
      deleteState(h2);
    });

    it("handles trailing slash in path", () => {
      const h1 = `${testPrefix}-slash`;
      writeState(makeState({ handle: h1, sessionPath: "/foo/bar" }));

      const results = listByPath("/foo/bar/");
      expect(results.map(s => s.handle)).toContain(h1);

      deleteState(h1);
    });
  });
});

describe("sessions root resolution", () => {
  // These tests temporarily reshape the env to verify each branch of the
  // resolver: YACO_AGENT_SESSIONS_DIR wins, then YACO_HOME/sessions, then the
  // ~/.yaco/sessions default. They restore env before yielding back.
  const ORIGINAL_MULTMUX = process.env.YACO_AGENT_SESSIONS_DIR;
  const ORIGINAL_YACO = process.env.YACO_HOME;

  afterEach(() => {
    if (ORIGINAL_MULTMUX === undefined) delete process.env.YACO_AGENT_SESSIONS_DIR;
    else process.env.YACO_AGENT_SESSIONS_DIR = ORIGINAL_MULTMUX;
    if (ORIGINAL_YACO === undefined) delete process.env.YACO_HOME;
    else process.env.YACO_HOME = ORIGINAL_YACO;
  });

  it("YACO_AGENT_SESSIONS_DIR wins over YACO_HOME", () => {
    process.env.YACO_AGENT_SESSIONS_DIR = "/tmp/multmux-state-override";
    process.env.YACO_HOME = "/tmp/yaco-state-root";
    expect(stateDir()).toBe("/tmp/multmux-state-override");
    expect(statePath("worker")).toBe("/tmp/multmux-state-override/worker.json");
  });

  it("falls back to ${YACO_HOME}/sessions when YACO_AGENT_SESSIONS_DIR is unset", () => {
    delete process.env.YACO_AGENT_SESSIONS_DIR;
    process.env.YACO_HOME = "/tmp/yaco-state-root";
    expect(stateDir()).toBe("/tmp/yaco-state-root/sessions");
    expect(statePath("worker")).toBe("/tmp/yaco-state-root/sessions/worker.json");
  });

  it("treats empty YACO_AGENT_SESSIONS_DIR as unset", () => {
    process.env.YACO_AGENT_SESSIONS_DIR = "";
    process.env.YACO_HOME = "/tmp/yaco-state-root";
    expect(stateDir()).toBe("/tmp/yaco-state-root/sessions");
  });
});
