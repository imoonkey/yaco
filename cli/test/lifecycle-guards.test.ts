// Phase 2: Guard/regression tests for lifecycle fixes G8, G9, G10, G11
// Replaces tmux/hooks/session-id with file-scoped module mocks for pure unit testing.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, utimesSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stateDir } from "../src/lib/core/agent/session-state.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { isInputEmpty } from "../src/lib/core/agent/providers/idle.ts";
import { stripAnsi } from "../src/lib/core/agent/model.ts";

// Redirect the session-state dir to a tmp fixture for this suite so a clean
// CI box (no YACO_AGENT_SESSIONS_DIR / YACO_HOME set) doesn't drop test state into
// the real ~/.yaco/sessions root. Mirrors state.test.ts.
const ORIGINAL_YACO_AGENT_SESSIONS_DIR = process.env.YACO_AGENT_SESSIONS_DIR;
const ORIGINAL_YACO_HOME = process.env.YACO_HOME;
const ORIGINAL_HOME = process.env.HOME;
let testStateDir: string;

beforeAll(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "multmux-guards-test-"));
  process.env.YACO_AGENT_SESSIONS_DIR = testStateDir;
  process.env.YACO_HOME = join(testStateDir, "home");
  process.env.HOME = join(testStateDir, "user-home");
  mkdirSync(process.env.HOME, { recursive: true });
});

afterAll(() => {
  if (ORIGINAL_YACO_AGENT_SESSIONS_DIR === undefined) delete process.env.YACO_AGENT_SESSIONS_DIR;
  else process.env.YACO_AGENT_SESSIONS_DIR = ORIGINAL_YACO_AGENT_SESSIONS_DIR;
  if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME;
  else process.env.YACO_HOME = ORIGINAL_YACO_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
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

// `vi.mock` is hoisted above every import, so every piece of state its
// factories close over has to be hoisted with them — one container, reset
// wholesale in `beforeEach`.
const m = vi.hoisted(() => ({
  config: {} as MockConfig,
  checkAliveIdx: 0,
  hasSessionIdx: 0,
  resolveSessionIdCalls: 0,
  sendKeysCaptures: [] as Array<{ handle: string; stateAtCallTime: unknown }>,
  rawKeyCaptures: [] as Array<{ handle: string; key: string }>,
  responderCaptures: [] as Array<{ handle: string; stateAtCallTime: unknown }>,
}));

function resetMocks(): void {
  m.config = {
    checkSessionAlive: [true],
    hasSession: [true],
    captureOutput: "❯ ",
    agentPid: 12345,
    sendKeysThrow: false,
    resolveSessionIdResult: null,
  };
  m.checkAliveIdx = 0;
  m.hasSessionIdx = 0;
  m.resolveSessionIdCalls = 0;
  m.sendKeysCaptures = [];
  m.rawKeyCaptures = [];
  m.responderCaptures = [];
}

/** The two tmux behaviors the factory needs twice: the `hasSession` sequence
 *  and the `sendKeys` state snapshot. Hoisted with the state they read. */
const { nextHasSession, captureSendKeys } = vi.hoisted(() => ({
  nextHasSession: (): boolean => {
    const idx = Math.min(m.hasSessionIdx, m.config.hasSession.length - 1);
    m.hasSessionIdx++;
    return m.config.hasSession[idx]!;
  },
  captureSendKeys: (handle: string, _text?: string): void => {
    // G10: Snapshot state file at the moment sendKeys is called
    const path = join(stateDir(), `${handle}.json`);
    let state = null;
    if (existsSync(path)) {
      try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
    }
    m.sendKeysCaptures.push({ handle, stateAtCallTime: state });
    if (m.config.sendKeysThrow) throw new Error("sendKeys mock failure");
  },
}));

// ---------------------------------------------------------------------------
// Module mocks — `vi.mock` is file-scoped by construction
// ---------------------------------------------------------------------------

vi.mock("../src/lib/core/agent/tmux.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/core/agent/tmux.ts")>()),
  hasSession: nextHasSession,
  checkSessionAlive: () => {
    const idx = Math.min(m.checkAliveIdx, m.config.checkSessionAlive.length - 1);
    m.checkAliveIdx++;
    return m.config.checkSessionAlive[idx]!;
  },
  sendKeys: captureSendKeys,
  // The real `sendKeysWhenInputEmpty` is `hasSession` → `isPaneInputEmpty` →
  // `sendKeys`, and those are calls to tmux.ts's own top-level bindings. Bun's
  // `mock.module` rewrote them; `vi.mock` replaces the module's exports and
  // leaves a real function's internals alone. So the gate is spelled out here,
  // over the same mock state and the real `isInputEmpty` predicate — only the
  // tmux boundary is faked, the decision is still production code.
  sendKeysWhenInputEmpty: (handle: string, providerId: string, text: string) => {
    if (!nextHasSession()) return "missing";
    if (!isInputEmpty(stripAnsi(m.config.captureOutput), providerId, m.config.captureOutput)) return "queued";
    captureSendKeys(handle, text);
    return "sent";
  },
  isTmuxAvailable: () => true,
  capturePane: () => m.config.captureOutput,
  createSession: () => {},
  getAgentPid: () => m.config.agentPid,
  sendRawKeys: (handle: string, key: string) => {
    m.rawKeyCaptures.push({ handle, key });
  },
  startOscColorQueryResponder: (handle: string) => {
    const path = join(stateDir(), `${handle}.json`);
    let state = null;
    if (existsSync(path)) {
      try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
    }
    m.responderCaptures.push({ handle, stateAtCallTime: state });
  },
  getPanePid: () => null,
  ensureTrueColorSupport: () => {},
  renameSession: () => {},
  killSession: () => {},
  resolveAgentPidFromProcesses: () => null,
}));

vi.mock("../src/lib/core/agent/lifecycle.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/core/agent/lifecycle.ts")>()),
  ensureHooks: () => {},
  buildWrappedCommand: (_h: string, _c: string, cmd: string) => cmd,
  HOOK_MARKER: "yaco-agent-hook",
  yacoToolHookGroup: () => ({ matcher: "*", hooks: [] }),
  yacoHookGroup: () => ({ matcher: "yaco-agent-hook", hooks: [] }),
  TOOL_SCOPED_EVENTS: new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "PreCompact", "PostCompact"]),
}));

vi.mock("../src/lib/core/agent/session-id.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/core/agent/session-id.ts")>()),
  PENDING_SESSION_ID: "pending:awaiting-first-prompt",
  resolveSessionId: () => {
    m.resolveSessionIdCalls++;
    return m.config.resolveSessionIdResult;
  },
}));

// ---------------------------------------------------------------------------
// Real imports (depend on mocked modules above)
// ---------------------------------------------------------------------------

import { send } from "../src/commands/agent/send.ts";
import { list, reconcileSession, resolveSession, status } from "../src/commands/agent/status.ts";
import { start } from "../src/commands/agent/start.ts";
import {
  readState,
  writeState,
  deleteState,
  statePath,
  listStateHandles,
  type SessionState,
} from "../src/lib/core/agent/session-state.ts";
import { readOrigins } from "../src/lib/core/agent/origin-read.ts";

/** One durable origin record, through the chunked reader the history window uses. */
const readOrigin = async (sessionId: string) => (await readOrigins([sessionId])).get(sessionId) ?? null;

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

function writeClaudeTranscript(state: SessionState, lines: string[]): void {
  const home = process.env.HOME!;
  const dir = join(home, ".claude", "projects", encodeClaudeCwd(state.sessionPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${state.sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function writeCodexTranscript(state: SessionState, lines: string[]): void {
  const home = process.env.HOME!;
  const dir = join(home, ".codex", "sessions", "2026", "06", "23");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-06-23T00-00-00-${state.sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function claudeAssistantLine(stopReason: "end_turn" | "tool_use"): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: stopReason, content: [{ type: "text", text: "ok" }] },
  });
}

function claudeInterruptLine(): string {
  return JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } });
}

function codexEventLine(type: "task_started" | "task_complete" | "turn_aborted"): string {
  return JSON.stringify({ type: "event_msg", payload: { type, reason: type === "turn_aborted" ? "interrupted" : undefined } });
}

/** Run `fn` with HOME pointed at a fresh dir that has NO `.codex`, so the Codex
 *  startup trust gate (`codexHooksAllYacoOwned`) finds no foreign hooks and is
 *  vacuously true. Keeps these interstitial tests hermetic regardless of the
 *  real `~/.codex` or a process-global `hookBinary()` cache poisoned by an
 *  earlier install/doctor test (the gate builds its canonical prefix from it).
 *  cwd (the sessionPath `start` passes) has no `.codex`, so it is already clean. */
function withCleanCodexHome<T>(fn: () => T): T {
  const prevHome = process.env.HOME;
  const tmpHome = mkdtempSync(join(tmpdir(), "multmux-clean-home-"));
  process.env.HOME = tmpHome;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
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
  it("returns processing for fresh processing state", async () => {
    const handle = `${TEST_PREFIX}-g8-fresh`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    const result = await reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
  });

  it("uses a Claude interrupt transcript to heal stale processing silently", async () => {
    const handle = `${TEST_PREFIX}-g8-claude-interrupt`;
    trackHandle(handle);
    const state = makeState({ handle, status: "processing", sessionId: "claude-interrupt-id" });
    writeState(state);
    writeClaudeTranscript(state, [claudeInterruptLine()]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "still busy"; // would be processing if PTY fallback won

    const result = await reconcileSession(handle);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
    expect(result!.idleReason).toBe("interrupted");
    expect(readState(handle)).toMatchObject({ status: "idle", idleReason: "interrupted" });
  });

  it("uses a Codex turn_aborted transcript to heal stale processing silently", async () => {
    const handle = `${TEST_PREFIX}-g8-codex-interrupt`;
    trackHandle(handle);
    const state = makeState({ handle, provider: "codex", status: "processing", sessionId: "codex-interrupt-id" });
    writeState(state);
    writeCodexTranscript(state, [codexEventLine("turn_aborted")]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "still busy";

    const result = await reconcileSession(handle);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
    expect(result!.idleReason).toBe("interrupted");
    expect(readState(handle)).toMatchObject({ status: "idle", idleReason: "interrupted" });
  });

  it("keeps stale processing active when the transcript says a turn is still running", async () => {
    const handle = `${TEST_PREFIX}-g8-transcript-active`;
    trackHandle(handle);
    const state = makeState({ handle, status: "processing", sessionId: "claude-active-id" });
    writeState(state);
    writeClaudeTranscript(state, [claudeAssistantLine("tool_use")]);
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "❯ "; // would be idle if PTY fallback won

    const result = await reconcileSession(handle);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
    expect(readState(handle)?.status).toBe("processing");
  });

  it("falls back to capture-idle for stale processing state", async () => {
    const handle = `${TEST_PREFIX}-g8-stale`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime beyond STALE_THRESHOLD_MS (30 min)
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    m.config.captureOutput = "❯ "; // idle prompt

    const result = await reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
  });

  it("does not let a stale transcript correction clobber a fresh turn", async () => {
    const handle = `${TEST_PREFIX}-g8-race`;
    trackHandle(handle);
    const oldState = makeState({
      handle,
      status: "processing",
      sessionId: "claude-race-id",
      statusEnteredAt: "2026-06-01T00:00:00.000Z",
    });
    writeState(oldState);
    writeClaudeTranscript(oldState, [claudeInterruptLine()]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);

    const pending = reconcileSession(handle);
    const freshState = makeState({
      handle,
      status: "processing",
      sessionId: "claude-race-id",
      statusEnteredAt: "2026-06-01T00:01:00.000Z",
      notice: "fresh turn",
    });
    writeState(freshState);

    const result = await pending;

    expect(result).toMatchObject({ status: "processing", statusEnteredAt: "2026-06-01T00:01:00.000Z", notice: "fresh turn" });
    expect(readState(handle)).toMatchObject({ status: "processing", statusEnteredAt: "2026-06-01T00:01:00.000Z", notice: "fresh turn" });
  });

  it("heals stale blocked(permission) only from a transcript terminal marker", async () => {
    const handle = `${TEST_PREFIX}-g8-blocked-interrupt`;
    trackHandle(handle);
    const state = makeState({
      handle,
      status: "blocked",
      blockReason: "permission",
      sessionId: "claude-blocked-interrupt-id",
    });
    writeState(state);
    writeClaudeTranscript(state, [claudeInterruptLine()]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "still busy";

    const result = await reconcileSession(handle);

    expect(result).toMatchObject({ status: "idle", idleReason: "interrupted" });
    expect(readState(handle)).toMatchObject({ status: "idle", idleReason: "interrupted" });
    expect(readState(handle)?.blockReason).toBeUndefined();
  });

  it("leaves stale blocked(permission) unchanged while a tool is still pending", async () => {
    const handle = `${TEST_PREFIX}-g8-blocked-pending`;
    trackHandle(handle);
    const state = makeState({
      handle,
      status: "blocked",
      blockReason: "permission",
      sessionId: "claude-blocked-pending-id",
    });
    writeState(state);
    writeClaudeTranscript(state, [claudeAssistantLine("tool_use")]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "❯ ";

    const result = await reconcileSession(handle);

    expect(result).toMatchObject({ status: "blocked", blockReason: "permission" });
    expect(readState(handle)).toMatchObject({ status: "blocked", blockReason: "permission" });
  });

  it("never clears blocked(trust) from a transcript terminal marker", async () => {
    const handle = `${TEST_PREFIX}-g8-blocked-trust`;
    trackHandle(handle);
    const state = makeState({
      handle,
      status: "blocked",
      blockReason: "trust",
      sessionId: "claude-blocked-trust-id",
    });
    writeState(state);
    writeClaudeTranscript(state, [claudeAssistantLine("end_turn")]);
    const past = new Date(Date.now() - 20 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "❯ ";

    const result = await reconcileSession(handle);

    expect(result).toMatchObject({ status: "blocked", blockReason: "trust" });
    expect(readState(handle)).toMatchObject({ status: "blocked", blockReason: "trust" });
  });

  it("falls back to capture-processing for stale starting state", async () => {
    const handle = `${TEST_PREFIX}-g8-stale-start`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "starting" }));

    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    m.config.captureOutput = "Thinking..."; // busy indicator

    const result = await reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
  });

  it("does not heal stale starting from an old transcript terminal marker", async () => {
    const handle = `${TEST_PREFIX}-g8-starting-old-transcript`;
    trackHandle(handle);
    const state = makeState({ handle, status: "starting", sessionId: "claude-starting-old-id" });
    writeState(state);
    writeClaudeTranscript(state, [claudeAssistantLine("end_turn")]);
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "Thinking...";

    const result = await reconcileSession(handle);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("processing");
    expect(readState(handle)?.status).toBe("processing");
  });

  it("returns null and cleans up dead session", async () => {
    const handle = `${TEST_PREFIX}-g8-dead`;
    trackHandle(handle);
    writeState(makeState({ handle }));

    m.config.checkSessionAlive = [false];

    const result = await reconcileSession(handle);
    expect(result).toBeNull();
    expect(readState(handle)).toBeNull();
  });
});

// ===========================================================================
// G9: bootstrap death → start throws
// ===========================================================================

describe("G9: start throws when session dies during bootstrap", () => {
  it("throws Error and cleans up state file", async () => {
    const handle = `${TEST_PREFIX}-g9`;
    trackHandle(handle);

    // hasSession: false for resolveStartHandle + collision preflight, true for waitForReady
    // checkSessionAlive: false at the final G9 guard (session died)
    m.config.hasSession = [false, false, true];
    m.config.checkSessionAlive = [false];
    m.config.captureOutput = "❯ ";

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
  it("state file has status=processing before sendKeys is called", async () => {
    const handle = `${TEST_PREFIX}-g10-opt`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "idle" }));

    send(handle, "test message");

    expect(m.sendKeysCaptures).toHaveLength(1);
    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("processing");
  });

  it("does not downgrade already-processing state", async () => {
    const handle = `${TEST_PREFIX}-g10-noop`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    send(handle, "test message");

    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("processing");

    // State file still processing after send
    expect(readState(handle)?.status).toBe("processing");
  });

  it("reverts optimistic hint on sendKeys failure", async () => {
    const handle = `${TEST_PREFIX}-g10-revert`;
    trackHandle(handle);
    const createdAt = new Date().toISOString();
    writeState(makeState({ handle, status: "idle", createdAt }));

    m.config.sendKeysThrow = true;

    expect(() => send(handle, "test")).toThrow("sendKeys mock failure");

    // Optimistic hint was written before failure
    expect(m.sendKeysCaptures).toHaveLength(1);
    expect((m.sendKeysCaptures[0]!.stateAtCallTime as SessionState).status).toBe("processing");

    // State reverted to idle
    expect(readState(handle)?.status).toBe("idle");
  });

  it("answers blocked(question) → flips to processing and clears blockReason", async () => {
    const handle = `${TEST_PREFIX}-g10-question`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "blocked", blockReason: "question" }));

    send(handle, "the answer");

    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("processing");
    expect(captured.blockReason).toBeUndefined();

    const persisted = readState(handle);
    expect(persisted?.status).toBe("processing");
    expect(persisted?.blockReason).toBeUndefined();
  });

  it("leaves blocked(trust) untouched on send", async () => {
    const handle = `${TEST_PREFIX}-g10-trust`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "blocked", blockReason: "trust" }));

    send(handle, "text");

    // No optimistic flip — the trust screen still needs the user.
    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("blocked");
    expect(captured.blockReason).toBe("trust");

    const persisted = readState(handle);
    expect(persisted?.status).toBe("blocked");
    expect(persisted?.blockReason).toBe("trust");
  });

  it("leaves blocked(permission) untouched on send", async () => {
    const handle = `${TEST_PREFIX}-g10-permission`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "blocked", blockReason: "permission" }));

    send(handle, "text");

    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.status).toBe("blocked");
    expect(captured.blockReason).toBe("permission");

    const persisted = readState(handle);
    expect(persisted?.status).toBe("blocked");
    expect(persisted?.blockReason).toBe("permission");
  });
});

// ===========================================================================
// G11: dead handle reclaim + name reuse
// ===========================================================================

describe("G11: dead handle reclaim allows name reuse", () => {
  it("deletes stale state for dead handle and creates new session with same name", async () => {
    const handle = `${TEST_PREFIX}-g11`;
    trackHandle(handle);

    // Simulate dead session: state file exists but tmux session is gone
    const oldCreatedAt = "2025-01-01T00:00:00.000Z";
    writeState(makeState({ handle, status: "idle", createdAt: oldCreatedAt }));

    // Sequence: G11 reclaim → false (dead), resolveStartHandle → false (no tmux),
    // collision preflight → false, waitForReady → true, G9 guard → true
    m.config.checkSessionAlive = [false, true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "❯ ";

    const state = start("claude", ["--name", handle]);

    expect(state.handle).toBe(handle);
    const newState = readState(handle);
    expect(newState).not.toBeNull();
    expect(newState!.handle).toBe(handle);
    expect(newState!.createdAt).not.toBe(oldCreatedAt);
    expect(newState!.status).toBe("idle");
  });

  it("rejects invalid handle before any reclaim I/O (shell injection regression)", async () => {
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
  it("persists capture-derived status to stale state files", async () => {
    const handle = `${TEST_PREFIX}-reconcile-clone`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime to trigger stale fallback → capture path
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    m.config.captureOutput = "❯ "; // idle prompt

    const result = await reconcileSession(handle);
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
  it("refines stale status for display but does NOT persist the correction", async () => {
    const handle = `${TEST_PREFIX}-resolve-pure`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "processing" }));

    // Backdate mtime to trigger the stale → capture fallback.
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);

    m.config.captureOutput = "❯ "; // idle prompt

    const result = await resolveSession(handle);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle"); // runtime view shows idle

    // Disk must be UNTOUCHED — the pure read never persists.
    expect(readState(handle)?.status).toBe("processing");
  });

  it("filters a confirmed-dead session (null) without deleting its state file", async () => {
    const handle = `${TEST_PREFIX}-resolve-dead`;
    trackHandle(handle);
    // pid 0 → isProcessAlive false, so tmux-gone makes it confirmed dead.
    writeState(makeState({ handle, pid: 0 }));

    m.config.checkSessionAlive = [false];

    const result = await resolveSession(handle);
    expect(result).toBeNull();
    // Pure read does NOT GC — the state file must still exist.
    expect(readState(handle)).not.toBeNull();
  });

  it("never reports dead on an uncertain liveness reading, even pid-less", async () => {
    const handle = `${TEST_PREFIX}-resolve-uncertain`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0, status: "idle" }));

    m.config.checkSessionAlive = [null]; // tmux timeout / wrong socket

    const result = await resolveSession(handle);
    expect(result).not.toBeNull(); // uncertain → keep the session
    expect(readState(handle)).not.toBeNull();
  });
});

// ===========================================================================
// reconcileSession GCs only a CONFIRMED-dead session (tmux gone AND pid dead).
// ===========================================================================

describe("reconcileSession GC is pid-guarded", () => {
  it("deletes the state file when tmux is gone AND the pid is dead", async () => {
    const handle = `${TEST_PREFIX}-recon-dead`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0 }));

    m.config.checkSessionAlive = [false];

    const result = await reconcileSession(handle);
    expect(result).toBeNull();
    expect(readState(handle)).toBeNull(); // GC'd
  });

  it("does NOT delete when tmux is gone but the recorded pid is alive", async () => {
    const handle = `${TEST_PREFIX}-recon-live-pid`;
    trackHandle(handle);
    // The running test process is a guaranteed-live pid.
    writeState(makeState({ handle, pid: process.pid, status: "idle" }));

    m.config.checkSessionAlive = [false]; // wrong-socket: tmux says gone

    const result = await reconcileSession(handle);
    expect(result).not.toBeNull(); // live pid vetoes deletion
    expect(readState(handle)).not.toBeNull();
  });

  it("does NOT delete on an uncertain (null) liveness reading", async () => {
    const handle = `${TEST_PREFIX}-recon-uncertain`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0, status: "idle" }));

    m.config.checkSessionAlive = [null];

    const result = await reconcileSession(handle);
    expect(result).not.toBeNull();
    expect(readState(handle)).not.toBeNull();
  });
});

// ===========================================================================
// Command surface: `list` / `status` are pure reads; `--reconcile` gates all
// mutation (GC) and stays socket-safe via the live-pid veto.
// ===========================================================================

describe("list/status command surface — read vs --reconcile mutation", () => {
  it("default `list` filters a confirmed-dead session out of the view WITHOUT deleting it", async () => {
    const handle = `${TEST_PREFIX}-list-pure-dead`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0 })); // pid dead
    m.config.checkSessionAlive = [false];     // tmux gone → confirmed dead

    const rows = JSON.parse(await list({ all: true, json: true }));
    expect(rows.find((r: any) => r.name === handle)).toBeUndefined(); // hidden
    expect(readState(handle)).not.toBeNull();                          // not GC'd
  });

  it("`list --reconcile` GCs a confirmed-dead session (tmux gone AND pid dead)", async () => {
    const handle = `${TEST_PREFIX}-list-recon-dead`;
    trackHandle(handle);
    writeState(makeState({ handle, pid: 0 }));
    m.config.checkSessionAlive = [false];

    JSON.parse(await list({ all: true, reconcile: true, json: true }));
    expect(readState(handle)).toBeNull(); // GC'd
  });

  it("`list --reconcile` preserves a live-pid session even when tmux reports it gone (wrong socket)", async () => {
    const handle = `${TEST_PREFIX}-list-recon-livepid`;
    trackHandle(handle);
    // The running test process is a guaranteed-live pid.
    writeState(makeState({ handle, pid: process.pid, status: "idle" }));
    m.config.checkSessionAlive = [false]; // wrong-socket: tmux says gone

    const rows = JSON.parse(await list({ all: true, reconcile: true, json: true }));
    expect(readState(handle)).not.toBeNull();                        // live pid vetoes GC
    expect(rows.find((r: any) => r.name === handle)).toBeDefined();  // still listed
  });

  it("`status --reconcile --json` returns the resolved session as a parseable object", async () => {
    const handle = `${TEST_PREFIX}-status-recon`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "idle" }));
    m.config.checkSessionAlive = [true]; // alive

    const obj = JSON.parse(await status(handle, { json: true, reconcile: true }));
    expect(obj.handle).toBe(handle);
    expect(obj.status).toBe("idle");
  });

  // render-foundation: the text sweep must not silently shift the status JSON
  // contract. Pin the resolved runtime-state fields a consumer relies on.
  it("`status --json` pins the resolved runtime-state fields", async () => {
    const handle = `${TEST_PREFIX}-status-json-pin`;
    trackHandle(handle);
    writeState(makeState({
      handle,
      provider: "claude",
      sessionPath: "/tmp/multmux-test-guards",
      pid: 12345,
      sessionId: "test-session-id",
      status: "idle",
      spawnedBy: "agent",
      parentSession: "guard-parent",
    }));
    m.config.checkSessionAlive = [true];

    const obj = JSON.parse(await status(handle, { json: true }));
    expect(obj).toMatchObject({
      handle,
      provider: "claude",
      sessionPath: "/tmp/multmux-test-guards",
      pid: 12345,
      sessionId: "test-session-id",
      status: "idle",
      spawnedBy: "agent",
      parentSession: "guard-parent",
    });
    expect(typeof obj.createdAt).toBe("string");
  });

  // render-foundation: text mode is a multi-line labeled detail block, not the
  // one-word status it used to print.
  it("`status` text mode renders a multi-line labeled block", async () => {
    const handle = `${TEST_PREFIX}-status-text-block`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "idle", sessionId: "test-session-id" }));
    m.config.checkSessionAlive = [true];

    const text = await status(handle);
    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(text).not.toBe("idle");
    expect(text).toContain(`handle:`);
    expect(text).toContain(`status:`);
    expect(text).toContain(`provider:`);
    expect(text).toContain(`sessionId:`);
    expect(text).toContain(`idle`);
    expect(text).toContain(handle);
  });

  // blocked-state: a fresh blocked session renders its status verbatim.
  it("`status` text mode renders a blocked status", async () => {
    // Neutral handle (no "blocked" substring) so the assertion can't pass on
    // the handle line alone — it must match the status line itself.
    const handle = `${TEST_PREFIX}-needs-review`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "blocked", blockReason: "permission" }));
    m.config.checkSessionAlive = [true];

    const text = await status(handle);
    expect(text).toMatch(/^status:\s+blocked$/m);
  });

  // blocked-state: the capture fallback can only derive idle|processing — it
  // must never emit blocked, and a stale blockReason must not survive the
  // correction to a non-blocked status.
  it("capture-correction drops a stale blockReason and never derives blocked", async () => {
    const handle = `${TEST_PREFIX}-status-stale-blocked`;
    trackHandle(handle);
    // Defensive: a stale processing state still carrying a blockReason.
    writeState(makeState({ handle, status: "processing", blockReason: "question" }));
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "❯ "; // idle prompt

    const resolved = await reconcileSession(handle);
    expect(resolved!.status).toBe("idle");
    expect(resolved!.blockReason).toBeUndefined();

    const persisted = readState(handle);
    expect(persisted?.status).toBe("idle");
    expect(persisted?.blockReason).toBeUndefined();
  });

  // blocked-state (Medium regression): even when the captured status MATCHES the
  // persisted status (no status drift), a stale blockReason must be persisted as
  // dropped — the blockReason drift alone has to trigger the write-back.
  it("reconcile clears a stale blockReason on disk when status is unchanged", async () => {
    const handle = `${TEST_PREFIX}-status-reason-drift`;
    trackHandle(handle);
    // Stale processing state carrying a stray reason; capture also reads busy,
    // so capturedStatus === "processing" and the status value never changes.
    writeState(makeState({ handle, status: "processing", blockReason: "question" }));
    const past = new Date(Date.now() - 35 * 60 * 1000);
    utimesSync(statePath(handle), past, past);
    m.config.captureOutput = "Thinking..."; // busy → capturedStatus "processing"

    const resolved = await reconcileSession(handle);
    expect(resolved!.status).toBe("processing");
    expect(resolved!.blockReason).toBeUndefined();

    // The stale reason must be cleared on disk, not just on the runtime view.
    const persisted = readState(handle);
    expect(persisted?.status).toBe("processing");
    expect(persisted?.blockReason).toBeUndefined();
  });
});

// ===========================================================================
// Start --json contract: pid > 0 and non-empty sessionId
// ===========================================================================

describe("start --json contract guarantees", () => {
  it("starts Codex OSC responder before pid and queues title sync after ready", async () => {
    const handle = `${TEST_PREFIX}-codex-responder`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "› ";
    m.config.agentPid = 42002;
    // Provider storage *could* resolve a thread id, but a state-file-only start
    // must not consult it; the pending sentinel stands until a hook backfills.
    m.config.resolveSessionIdResult = { sessionId: "codex-thread-not-consulted-at-start" };

    const state = start("codex", ["--name", handle]);

    // Codex declares terminal.respondToColorQuery, so the responder starts
    // right after createSession. Provider-title /rename waits for bootstrap
    // readiness but no longer waits for provider-title settle.
    expect(m.responderCaptures).toHaveLength(1);
    expect((m.responderCaptures[0]!.stateAtCallTime as SessionState).pid).toBe(0);
    expect(m.sendKeysCaptures).toHaveLength(1);
    const captured = m.sendKeysCaptures[0]!.stateAtCallTime as SessionState;
    expect(captured.pid).toBe(42002);
    expect(state.pid).toBe(42002);
    expect(state.sessionId).toBe("pending:awaiting-first-prompt");
    expect(m.resolveSessionIdCalls).toBe(0);
  });

  it("does not replay Codex hook-review keys when the slash prompt is already active", async () => {
    const handle = `${TEST_PREFIX}-codex-slash-prompt`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true, true, true];
    m.config.captureOutput = [
      "Hooks need review",
      "",
      "Review hooks",
      "Trust all and continue",
      "",
      "› /",
    ].join("\n");
    m.config.agentPid = 42003;

    const state = withCleanCodexHome(() => start("codex", ["--name", handle]));

    expect(state.handle).toBe(handle);
    expect(m.rawKeyCaptures).toEqual([]);
  });

  it("still answers the active Codex hook-review menu", async () => {
    const handle = `${TEST_PREFIX}-codex-hook-review`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true, false];
    m.config.captureOutput = [
      "Hooks need review",
      "",
      "› Review hooks",
      "  Trust all and continue",
    ].join("\n");
    m.config.agentPid = 42004;

    const state = withCleanCodexHome(() => start("codex", ["--name", handle]));

    expect(state.handle).toBe(handle);
    expect(m.rawKeyCaptures).toEqual([
      { handle, key: "Down" },
      { handle, key: "Enter" },
    ]);
  });

  it("returns state with pid > 0 and non-empty sessionId", async () => {
    const handle = `${TEST_PREFIX}-json-contract`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "❯ ";
    m.config.agentPid = 42000;

    const state = start("claude", ["--name", handle]);

    expect(state.handle).toBe(handle);
    expect(state.pid).toBeGreaterThan(0);
    expect(state.sessionId).toBeTruthy();
    expect(state.sessionId.length).toBeGreaterThan(0);
  });

  it("records origin when startup sync resolves a real sessionId", async () => {
    const handle = `${TEST_PREFIX}-origin-start`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "❯ ";
    m.config.agentPid = 42005;
    m.config.resolveSessionIdResult = { sessionId: "origin-start-id" };

    const originalAgentHandle = process.env.YACO_AGENT_HANDLE;
    let state: SessionState | undefined;
    try {
      delete process.env.YACO_AGENT_HANDLE;
      state = start("claude", ["--name", handle]);
    } finally {
      if (originalAgentHandle === undefined) delete process.env.YACO_AGENT_HANDLE;
      else process.env.YACO_AGENT_HANDLE = originalAgentHandle;
    }

    expect(state!.sessionId).toBe("origin-start-id");
    expect(await readOrigin("origin-start-id")).toMatchObject({
      sessionId: "origin-start-id",
      spawnedBy: "user:terminal",
      parentSession: null,
      firstHandle: handle,
    });
  });

  it("does not record origin for --resume starts", async () => {
    const handle = `${TEST_PREFIX}-origin-resume`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "❯ ";
    m.config.agentPid = 42006;

    const state = start("claude", ["--name", handle, "--resume", "resume-thread-id"]);

    expect(state.sessionId).toBe("resume-thread-id");
    expect(state.resumedFrom).toBe("resume-thread-id");
    expect(await readOrigin("resume-thread-id")).toBeNull();
  });

  it("returns pending sentinel when sessionId cannot be resolved", async () => {
    const handle = `${TEST_PREFIX}-json-pending`;
    trackHandle(handle);

    m.config.checkSessionAlive = [true];
    m.config.hasSession = [false, false, true];
    m.config.captureOutput = "❯ ";
    m.config.agentPid = 42001;

    const state = start("claude", ["--name", handle]);

    // When no sessionId resolves, the pending sentinel is used (still non-empty)
    expect(state.sessionId).toBe("pending:awaiting-first-prompt");
  });
});

// ===========================================================================
// Codex sessionId strategy: state-file-only start, provider-storage backfill
// ===========================================================================

describe("Codex sessionId resolution strategy", () => {
  it("status backfill resolves a pending Codex sessionId from provider storage", async () => {
    const handle = `${TEST_PREFIX}-codex-backfill`;
    trackHandle(handle);
    // A live Codex session whose start-time sessionId is still pending.
    writeState(makeState({
      handle,
      provider: "codex",
      sessionId: "pending:awaiting-first-prompt",
      status: "idle",
      pid: 43100,
      spawnedBy: "agent",
      parentSession: "parent-codex",
    }));

    m.config.checkSessionAlive = [true];
    m.config.agentPid = 43100;
    m.config.resolveSessionIdResult = { sessionId: "codex-thread-xyz" };

    const resolved = await reconcileSession(handle);

    // Backfill consults the adapter resolver and persists the real thread id.
    expect(resolved).not.toBeNull();
    expect(m.resolveSessionIdCalls).toBeGreaterThan(0);
    expect(resolved!.sessionId).toBe("codex-thread-xyz");
    expect(readState(handle)?.sessionId).toBe("codex-thread-xyz");
    expect(await readOrigin("codex-thread-xyz")).toMatchObject({
      sessionId: "codex-thread-xyz",
      spawnedBy: "agent",
      parentSession: "parent-codex",
      firstHandle: handle,
    });
  });
});

// ===========================================================================
// Send: rollback guard — no revert when optimistic hint was not written
// ===========================================================================

describe("send rollback guard", () => {
  it("does not revert status when optimistic hint was never written", async () => {
    const handle = `${TEST_PREFIX}-send-norev`;
    trackHandle(handle);
    writeState(makeState({ handle, status: "starting" }));

    m.config.sendKeysThrow = true;

    expect(() => send(handle, "test")).toThrow("sendKeys mock failure");

    // Status must remain "starting" — the old bug would overwrite it
    expect(readState(handle)?.status).toBe("starting");
  });
});
