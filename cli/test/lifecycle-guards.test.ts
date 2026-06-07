// Phase 2: Guard/regression tests for lifecycle fixes G8, G9, G10, G11
// Uses mock.module to replace tmux/hooks/session-id for pure unit testing.

import { mock, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stateDir } from "../src/lib/core/agent/session-state.ts";

// Redirect the session-state dir to a tmp fixture for this suite so a clean
// CI box (no YACO_AGENT_SESSIONS_DIR / YACO_HOME set) doesn't drop test state into
// the real ~/.yaco/sessions root. Mirrors state.test.ts.
const ORIGINAL_YACO_AGENT_SESSIONS_DIR = process.env.YACO_AGENT_SESSIONS_DIR;
let testStateDir: string;

beforeAll(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "multmux-guards-test-"));
  process.env.YACO_AGENT_SESSIONS_DIR = testStateDir;
});

afterAll(() => {
  if (ORIGINAL_YACO_AGENT_SESSIONS_DIR === undefined) delete process.env.YACO_AGENT_SESSIONS_DIR;
  else process.env.YACO_AGENT_SESSIONS_DIR = ORIGINAL_YACO_AGENT_SESSIONS_DIR;
  rmSync(testStateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Configurable mock state — mutated per-test, reset in beforeEach
// ---------------------------------------------------------------------------

interface MockConfig {
  /** Sequence of return values for checkSessionAlive (last value sticks) */
  checkSessionAlive: (boolean | null)[];
  /** Sequence of return values for hasSession (last value sticks) */
  hasSession: boolean[];
  /** Output returned by capturePane */
  captureOutput: string;
  /** PID returned by getAgentPid */
  agentPid: number | null;
  /** If true, sendKeys throws after capturing state */
  sendKeysThrow: boolean;
  /** Result the provider-storage resolver returns (null = unresolved) */
  resolveSessionIdResult: { sessionId: string; summary?: string } | null;
}

let mockConfig: MockConfig;
let checkAliveIdx: number;
let hasSessionIdx: number;
let resolveSessionIdCalls: number;
let sendKeysCaptures: Array<{ handle: string; stateAtCallTime: unknown }>;
let responderCaptures: Array<{ handle: string; stateAtCallTime: unknown }>;

function resetMocks(): void {
  mockConfig = {
    checkSessionAlive: [true],
    hasSession: [true],
    captureOutput: "❯ ",
    agentPid: 12345,
    sendKeysThrow: false,
    resolveSessionIdResult: null,
  };
  checkAliveIdx = 0;
  hasSessionIdx = 0;
  resolveSessionIdCalls = 0;
  sendKeysCaptures = [];
  responderCaptures = [];
}

// ---------------------------------------------------------------------------
// Module mocks — bun hoists these before static imports
// ---------------------------------------------------------------------------

mock.module("../src/lib/core/agent/tmux.ts", () => ({
  hasSession: () => {
    const idx = Math.min(hasSessionIdx, mockConfig.hasSession.length - 1);
    hasSessionIdx++;
    return mockConfig.hasSession[idx]!;
  },
  checkSessionAlive: () => {
    const idx = Math.min(checkAliveIdx, mockConfig.checkSessionAlive.length - 1);
    checkAliveIdx++;
    return mockConfig.checkSessionAlive[idx]!;
  },
  sendKeys: (handle: string, _text: string) => {
    // G10: Snapshot state file at the moment sendKeys is called
    const path = join(stateDir(), `${handle}.json`);
    let state = null;
    if (existsSync(path)) {
      try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
    }
    sendKeysCaptures.push({ handle, stateAtCallTime: state });
    if (mockConfig.sendKeysThrow) throw new Error("sendKeys mock failure");
  },
  isTmuxAvailable: () => true,
  capturePane: () => mockConfig.captureOutput,
  createSession: () => {},
  getAgentPid: () => mockConfig.agentPid,
  sendRawKeys: () => {},
  startOscColorQueryResponder: (handle: string) => {
    const path = join(stateDir(), `${handle}.json`);
    let state = null;
    if (existsSync(path)) {
      try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
    }
    responderCaptures.push({ handle, stateAtCallTime: state });
  },
  getPanePid: () => null,
  ensureTrueColorSupport: () => {},
  renameSession: () => {},
  killSession: () => {},
  resolveAgentPidFromProcesses: () => null,
}));

mock.module("../src/lib/core/agent/lifecycle.ts", () => ({
  ensureHooks: () => {},
  buildWrappedCommand: (_h: string, _c: string, cmd: string) => cmd,
  HOOK_MARKER: "yaco-agent-hook",
  yacoToolHookGroup: () => ({ matcher: "*", hooks: [] }),
  yacoHookGroup: () => ({ matcher: "yaco-agent-hook", hooks: [] }),
  TOOL_SCOPED_EVENTS: new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "PreCompact", "PostCompact"]),
}));

mock.module("../src/lib/core/agent/session-id.ts", () => ({
  PENDING_SESSION_ID: "pending:awaiting-first-prompt",
  resolveSessionId: () => {
    resolveSessionIdCalls++;
    return mockConfig.resolveSessionIdResult;
  },
}));

// ---------------------------------------------------------------------------
// Real imports (depend on mocked modules above)
// ---------------------------------------------------------------------------

import { send } from "../src/commands/agent/send.ts";
import { reconcileSession, resolveSession } from "../src/commands/agent/status.ts";
import { start } from "../src/commands/agent/start.ts";
import {
  readState,
  writeState,
  deleteState,
  statePath,
  listStateHandles,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PREFIX = `guard-${process.pid}`;
const createdHandles: string[] = [];

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: `${TEST_PREFIX}-default`,
    provider: "claude",
    sessionPath: "/tmp/multmux-test-guards",
    pid: 12345,
    sessionId: "test-session-id",
    status: "idle",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function trackHandle(handle: string): void {
  if (!createdHandles.includes(handle)) createdHandles.push(handle);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  for (const handle of createdHandles) {
    deleteState(handle);
  }
  for (const handle of listStateHandles()) {
    if (handle.startsWith(TEST_PREFIX)) deleteState(handle);
  }
  createdHandles.length = 0;
});

// ===========================================================================
// G8: reconcile stale-detection consistency
// ===========================================================================

describe("G8: reconcile stale-detection consistency", () => {
  it("returns processing for fresh processing state", () => {
    const handle = `${TEST_PREFIX}-g8-fresh`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    const result = reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
  });

  it("falls back to capture-idle for stale processing state", () => {
    const handle = `${TEST_PREFIX}-g8-stale`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime beyond STALE_THRESHOLD_MS (30 min)
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    mockConfig.captureOutput = "❯ "; // idle prompt

    const result = reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
  });

  it("falls back to capture-processing for stale starting state", () => {
    const handle = `${TEST_PREFIX}-g8-stale-start`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "starting" }));

    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    mockConfig.captureOutput = "Thinking..."; // busy indicator

    const result = reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
  });

  it("returns null and cleans up dead session", () => {
    const handle = `${TEST_PREFIX}-g8-dead`;
    trackHandle(handle);
    writeState(makeState({ handle }));

    mockConfig.checkSessionAlive = [false];

    const result = reconcileSession(handle);
    expect(result).toBeNull();
    expect(readState(handle)).toBeNull();
  });
});

// ===========================================================================
// G9: bootstrap death → start throws
// ===========================================================================

describe("G9: start throws when session dies during bootstrap", () => {
  it("throws Error and cleans up state file", () => {
    const handle = `${TEST_PREFIX}-g9`;
    trackHandle(handle);

    // hasSession: false for resolveStartHandle + collision preflight, true for waitForReady
    // checkSessionAlive: false at the final G9 guard (session died)
    mockConfig.hasSession = [false, false, true];
    mockConfig.checkSessionAlive = [false];
    mockConfig.captureOutput = "❯ ";

    expect(() => {
      start("claude", ["--name", handle]);
    }).toThrow(`Session "${handle}" died during bootstrap`);

    expect(readState(handle)).toBeNull();
  });
});

// ===========================================================================
// G10: send writes optimistic processing before sendKeys
// ===========================================================================

describe("G10: send optimistic processing hint", () => {
  it("state file has status=processing before sendKeys is called", () => {
    const handle = `${TEST_PREFIX}-g10-opt`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "idle" }));

    send(handle, "test message");

    expect(sendKeysCaptures).toHaveLength(1);
    const captured = sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("processing");
  });

  it("does not downgrade already-processing state", () => {
    const handle = `${TEST_PREFIX}-g10-noop`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    send(handle, "test message");

    const captured = sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("processing");

    // State file still processing after send
    expect(readState(handle)?.status).toBe("processing");
  });

  it("reverts optimistic hint on sendKeys failure", () => {
    const handle = `${TEST_PREFIX}-g10-revert`;
    trackHandle(handle);
    const createdAt = new Date().toISOString();
    writeState(makeState({ handle, status: "idle", createdAt }));

    mockConfig.sendKeysThrow = true;

    expect(() => send(handle, "test")).toThrow("sendKeys mock failure");

    // Optimistic hint was written before failure
    expect(sendKeysCaptures).toHaveLength(1);
    expect((sendKeysCaptures[0]!.stateAtCallTime as SessionState).status).toBe("processing");

    // State reverted to idle
    expect(readState(handle)?.status).toBe("idle");
  });
});

// ===========================================================================
// G11: dead handle reclaim + name reuse
// ===========================================================================

describe("G11: dead handle reclaim allows name reuse", () => {
  it("deletes stale state for dead handle and creates new session with same name", () => {
    const handle = `${TEST_PREFIX}-g11`;
    trackHandle(handle);

    // Simulate dead session: state file exists but tmux session is gone
    const oldCreatedAt = "2025-01-01T00:00:00.000Z";
    writeState(makeState({ handle, status: "idle", createdAt: oldCreatedAt }));

    // Sequence: G11 reclaim → false (dead), resolveStartHandle → false (no tmux),
    // collision preflight → false, waitForReady → true, G9 guard → true
    mockConfig.checkSessionAlive = [false, true];
    mockConfig.hasSession = [false, false, true];
    mockConfig.captureOutput = "❯ ";

    const state = start("claude", ["--name", handle]);

    expect(state.handle).toBe(handle);
    const newState = readState(handle);
    expect(newState).not.toBeNull();
    expect(newState!.handle).toBe(handle);
    expect(newState!.createdAt).not.toBe(oldCreatedAt);
    expect(newState!.status).toBe("idle");
  });

  it("rejects invalid handle before any reclaim I/O (shell injection regression)", () => {
    // An invalid --name with path separators or shell metacharacters must be
    // rejected by validateName() BEFORE readState/checkSessionAlive touch it.
    expect(() => {
      start("claude", ["--name", "bad/name"]);
    }).toThrow('Invalid session name: "bad/name"');

    expect(() => {
      start("claude", ["--name", "evil;rm -rf /"]);
    }).toThrow('Invalid session name');
  });
});

// ===========================================================================
// Reconcile: capture-derived status persists to stale state files
// ===========================================================================

describe("reconcile capture status is runtime-only", () => {
  it("persists capture-derived status to stale state files", () => {
    const handle = `${TEST_PREFIX}-reconcile-clone`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime to trigger stale fallback → capture path
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    mockConfig.captureOutput = "❯ "; // idle prompt

    const result = reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle"); // runtime view shows idle

    // Stale state file should be corrected on disk
    const persisted = readState(handle);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("idle");
  });
});

// ===========================================================================
// resolveSession is a PURE READ — refines display status without persisting,
// and never deletes a confirmed-dead session's state file.
// ===========================================================================

describe("resolveSession is a pure read", () => {
  it("refines stale status for display but does NOT persist the correction", () => {
    const handle = `${TEST_PREFIX}-resolve-pure`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime to trigger the stale → capture fallback.
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    mockConfig.captureOutput = "❯ "; // idle prompt

    const result = resolveSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle"); // runtime view shows idle

    // Disk must be UNTOUCHED — the pure read never persists.
    expect(readState(handle)?.status).toBe("processing");
  });

  it("filters a confirmed-dead session (null) without deleting its state file", () => {
    const handle = `${TEST_PREFIX}-resolve-dead`;
    trackHandle(handle);
    // pid 0 → isProcessAlive false, so tmux-gone makes it confirmed dead.
    writeState(makeState({ handle, pid: 0 }));

    mockConfig.checkSessionAlive = [false];

    const result = resolveSession(handle);
    expect(result).toBeNull();
    // Pure read does NOT GC — the state file must still exist.
    expect(readState(handle)).not.toBeNull();
  });

  it("never reports dead on an uncertain liveness reading, even pid-less", () => {
    const handle = `${TEST_PREFIX}-resolve-uncertain`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0, status: "idle" }));

    mockConfig.checkSessionAlive = [null]; // tmux timeout / wrong socket

    const result = resolveSession(handle);
    expect(result).not.toBeNull(); // uncertain → keep the session
    expect(readState(handle)).not.toBeNull();
  });
});

// ===========================================================================
// reconcileSession GCs only a CONFIRMED-dead session (tmux gone AND pid dead).
// ===========================================================================

describe("reconcileSession GC is pid-guarded", () => {
  it("deletes the state file when tmux is gone AND the pid is dead", () => {
    const handle = `${TEST_PREFIX}-recon-dead`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0 }));

    mockConfig.checkSessionAlive = [false];

    const result = reconcileSession(handle);
    expect(result).toBeNull();
    expect(readState(handle)).toBeNull(); // GC'd
  });

  it("does NOT delete when tmux is gone but the recorded pid is alive", () => {
    const handle = `${TEST_PREFIX}-recon-live-pid`;
    trackHandle(handle);
    // The running test process is a guaranteed-live pid.
    writeState(makeState({ handle, pid: process.pid, status: "idle" }));

    mockConfig.checkSessionAlive = [false]; // wrong-socket: tmux says gone

    const result = reconcileSession(handle);
    expect(result).not.toBeNull(); // live pid vetoes deletion
    expect(readState(handle)).not.toBeNull();
  });

  it("does NOT delete on an uncertain (null) liveness reading", () => {
    const handle = `${TEST_PREFIX}-recon-uncertain`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0, status: "idle" }));

    mockConfig.checkSessionAlive = [null];

    const result = reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(readState(handle)).not.toBeNull();
  });
});

// ===========================================================================
// Start --json contract: pid > 0 and non-empty sessionId
// ===========================================================================

describe("start --json contract guarantees", () => {
  it("starts Codex OSC responder (gated by adapter terminal flag) before publishing pid", () => {
    const handle = `${TEST_PREFIX}-codex-responder`;
    trackHandle(handle);

    mockConfig.checkSessionAlive = [true];
    mockConfig.hasSession = [false, false, true];
    mockConfig.captureOutput = "› ";
    mockConfig.agentPid = 42002;
    // Provider storage *could* resolve a thread id, but a state-file-only start
    // must not consult it; the pending sentinel stands until a hook backfills.
    mockConfig.resolveSessionIdResult = { sessionId: "codex-thread-not-consulted-at-start" };

    const state = start("codex", ["--name", handle]);

    // Codex declares terminal.respondToColorQuery, so the responder is started
    // right after createSession — before the pid is captured into state.
    expect(responderCaptures).toHaveLength(1);
    expect((responderCaptures[0]!.stateAtCallTime as SessionState).pid).toBe(0);
    expect(sendKeysCaptures).toHaveLength(1);
    const captured = sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.pid).toBe(42002);
    expect(state.pid).toBe(42002);
    expect(state.sessionId).toBe("pending:awaiting-first-prompt");
    expect(resolveSessionIdCalls).toBe(0);
  });

  it("returns state with pid > 0 and non-empty sessionId", () => {
    const handle = `${TEST_PREFIX}-json-contract`;
    trackHandle(handle);

    mockConfig.checkSessionAlive = [true];
    mockConfig.hasSession = [false, false, true];
    mockConfig.captureOutput = "❯ ";
    mockConfig.agentPid = 42000;

    const state = start("claude", ["--name", handle]);

    expect(state.handle).toBe(handle);
    expect(state.pid).toBeGreaterThan(0);
    expect(state.sessionId).toBeTruthy();
    expect(state.sessionId.length).toBeGreaterThan(0);
  });

  it("returns pending sentinel when sessionId cannot be resolved", () => {
    const handle = `${TEST_PREFIX}-json-pending`;
    trackHandle(handle);

    mockConfig.checkSessionAlive = [true];
    mockConfig.hasSession = [false, false, true];
    mockConfig.captureOutput = "❯ ";
    mockConfig.agentPid = 42001;

    const state = start("claude", ["--name", handle]);

    // When no sessionId resolves, the pending sentinel is used (still non-empty)
    expect(state.sessionId).toBe("pending:awaiting-first-prompt");
  });
});

// ===========================================================================
// Codex sessionId strategy: state-file-only start, provider-storage backfill
// ===========================================================================

describe("Codex sessionId resolution strategy", () => {
  it("status backfill resolves a pending Codex sessionId from provider storage", () => {
    const handle = `${TEST_PREFIX}-codex-backfill`;
    trackHandle(handle);
    // A live Codex session whose start-time sessionId is still pending.
    writeState(makeState({
      handle,
      provider: "codex",
      sessionId: "pending:awaiting-first-prompt",
      status: "idle",
      pid: 43100,
    }));

    mockConfig.checkSessionAlive = [true];
    mockConfig.agentPid = 43100;
    mockConfig.resolveSessionIdResult = { sessionId: "codex-thread-xyz" };

    const resolved = reconcileSession(handle);

    // Backfill consults the adapter resolver and persists the real thread id.
    expect(resolved).not.toBeNull();
    expect(resolveSessionIdCalls).toBeGreaterThan(0);
    expect(resolved!.sessionId).toBe("codex-thread-xyz");
    expect(readState(handle)?.sessionId).toBe("codex-thread-xyz");
  });
});

// ===========================================================================
// Send: rollback guard — no revert when optimistic hint was not written
// ===========================================================================

describe("send rollback guard", () => {
  it("does not revert status when optimistic hint was never written", () => {
    const handle = `${TEST_PREFIX}-send-norev`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "starting" }));

    mockConfig.sendKeysThrow = true;

    expect(() => send(handle, "test")).toThrow("sendKeys mock failure");

    // Status must remain "starting" — the old bug would overwrite it
    expect(readState(handle)?.status).toBe("starting");
  });
});
