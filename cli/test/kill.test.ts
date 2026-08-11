import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  writeState,
  readState,
  deleteState,
  listByPath,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";
import { kill } from "../src/commands/agent/kill.ts";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

// `vi.mock` is hoisted above every import, so the state its factory closes
// over has to be hoisted with it.
const tmux = vi.hoisted(() => ({ aliveResult: true as boolean | null, killCalled: false }));

vi.mock("../src/lib/core/agent/tmux.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/core/agent/tmux.ts")>()),
  checkSessionAlive: () => tmux.aliveResult,
  killSession: () => { tmux.killCalled = true; },
  hasSession: () => tmux.aliveResult === true,
}));

const testPrefix = `test-kill-${process.pid}-${Date.now()}`;
const TEST_SESSION_PATH = "/tmp/multmux-test-kill";

function makeState(handle: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath: TEST_SESSION_PATH,
    pid: 12345,
    sessionId: "sess-1",
    status: "idle",
    createdAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

// kill --all uses listByPath(process.cwd()). We use a test sessionPath
// so real sessions are never affected. Helper lists test sessions only.
function testSessionHandles(): string[] {
  return listByPath(TEST_SESSION_PATH).map(s => s.handle);
}

describe("kill", () => {
  beforeEach(() => {
    tmux.aliveResult = true;
    tmux.killCalled = false;
  });

  afterEach(() => {
    for (const suffix of ["live", "dead", "uncertain", "a", "b"]) {
      deleteState(`${testPrefix}-${suffix}`);
    }
  });

  it("kills live tmux session and deletes state", () => {
    const handle = `${testPrefix}-live`;
    writeState(makeState(handle));
    tmux.aliveResult = true;

    kill(handle);

    expect(tmux.killCalled).toBe(true);
    expect(readState(handle)).toBeNull();
  });

  it("deletes state only when tmux session is already dead", () => {
    const handle = `${testPrefix}-dead`;
    writeState(makeState(handle));
    tmux.aliveResult = false;

    kill(handle);

    expect(tmux.killCalled).toBe(false);
    expect(readState(handle)).toBeNull();
  });

  it("throws on tmux uncertainty and preserves state", () => {
    const handle = `${testPrefix}-uncertain`;
    writeState(makeState(handle));
    tmux.aliveResult = null;

    expect(() => kill(handle)).toThrow("Cannot determine tmux status");
    expect(tmux.killCalled).toBe(false);
    expect(readState(handle)).not.toBeNull();
  });

  it("throws when no state file and tmux confirms dead", () => {
    const handle = `${testPrefix}-dead`;
    tmux.aliveResult = false;

    expect(() => kill(handle)).toThrow(`Session "${handle}" not found`);
  });

  it("throws when name is missing and --all is not set", () => {
    expect(() => kill()).toThrow("Session name is required");
  });

  it("kill --all skips uncertain sessions", () => {
    const handleA = `${testPrefix}-a`;
    const handleB = `${testPrefix}-b`;
    writeState(makeState(handleA));
    writeState(makeState(handleB));

    tmux.aliveResult = null;
    const origCwd = process.cwd;
    process.cwd = () => TEST_SESSION_PATH;
    try {
      kill(undefined, { all: true });
    } finally {
      process.cwd = origCwd;
    }

    expect(readState(handleA)).not.toBeNull();
    expect(readState(handleB)).not.toBeNull();
  });

  it("kill --all deletes state for dead sessions without killing", () => {
    const handle = `${testPrefix}-a`;
    writeState(makeState(handle));
    tmux.aliveResult = false;

    const origCwd = process.cwd;
    process.cwd = () => TEST_SESSION_PATH;
    try {
      kill(undefined, { all: true });
    } finally {
      process.cwd = origCwd;
    }

    expect(tmux.killCalled).toBe(false);
    expect(readState(handle)).toBeNull();
  });
});
