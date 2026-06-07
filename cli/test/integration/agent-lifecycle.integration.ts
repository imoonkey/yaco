import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { start } from "../../src/commands/agent/start.ts";
import { send } from "../../src/commands/agent/send.ts";
import { capture } from "../../src/commands/agent/capture.ts";
import { kill } from "../../src/commands/agent/kill.ts";
import { rename } from "../../src/commands/agent/rename.ts";
import { status } from "../../src/commands/agent/status.ts";
import { readState, writeState, deleteState, statePath, type SessionState } from "../../src/lib/core/agent/session-state.ts";
import { hasSession, isTmuxAvailable } from "../../src/lib/core/agent/tmux.ts";
import { PENDING_SESSION_ID } from "../../src/lib/core/agent/session-id.ts";

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

function cliAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const tmux = isTmuxAvailable();
const hasClaude = cliAvailable("claude");
const hasCodex = cliAvailable("codex");

const claudeIt = tmux && hasClaude ? it.serial : it.skip;
const codexIt = tmux && hasCodex ? it.serial : it.skip;

// ---------------------------------------------------------------------------
// Unique handle prefix
// ---------------------------------------------------------------------------

const TEST_PREFIX = `agent-test-${process.pid}`;
const DOCUMENTED_STATE_FIELDS = [
  "createdAt",
  "handle",
  "pid",
  "provider",
  "sessionId",
  "sessionPath",
  "status",
];

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const testHandles: string[] = [];

// Run agents in an isolated directory so they don't interfere with the project
const TEST_CWD = "/tmp/multmux-test";
let savedCwd: string;
// Sandbox YACO_HOME so session-state files land in a throwaway dir instead of
// the live ~/.yaco/sessions the web app reads. The spawned agents' tmux session
// inherits this env (tmux new-session copies the caller's env), so hook/wrapper
// state writes stay isolated too.
const ORIGINAL_YACO_HOME = process.env["YACO_HOME"];
let yacoSandbox: string;
beforeAll(() => {
  mkdirSync(TEST_CWD, { recursive: true });
  yacoSandbox = mkdtempSync(join(tmpdir(), "yaco-itest-"));
  process.env["YACO_HOME"] = yacoSandbox;
  savedCwd = process.cwd();
  process.chdir(TEST_CWD);
});
afterAll(() => {
  process.chdir(savedCwd);
  if (ORIGINAL_YACO_HOME === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = ORIGINAL_YACO_HOME;
  rmSync(yacoSandbox, { recursive: true, force: true });
});

afterEach(() => {
  for (const handle of testHandles) {
    try {
      execSync(`tmux kill-session -t "${handle}"`, { stdio: "pipe", timeout: 5000 });
    } catch { /* session may already be gone */ }
    deleteState(handle);
  }
  testHandles.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function processCommand(pid: number | undefined): string {
  if (!pid || pid <= 0) return "";
  try {
    return execSync(`ps -p "${pid}" -o comm=`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function readClaudeSessionFile(pid: number | undefined): Record<string, unknown> | null {
  if (!pid || pid <= 0) return null;
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Claude full lifecycle
// ---------------------------------------------------------------------------

describe("claude agent lifecycle", () => {
  claudeIt(
    "start -> idle -> send -> processing -> idle -> verify state -> kill",
    async () => {
      const handle = `${TEST_PREFIX}-claude`;
      testHandles.push(handle);

      // Start Claude with a simple prompt
      const state = start("claude", [
        "Reply with exactly the word: pong",
        "--name", handle,
      ]);

      // After start() returns, agent should be idle (finished initial prompt)
      expect(state.handle).toBe(handle);
      expect(state.provider).toBe("claude");

      // Wait for agent to finish processing initial prompt
      await waitFor(() => readState(handle)?.status === "idle", 30000);

      const stateAfterStart = readState(handle);
      expect(stateAfterStart?.status).toBe("idle");
      expect(stateAfterStart?.pid).toBeGreaterThan(0);
      expect(processCommand(stateAfterStart?.pid)).toBe("claude");

      expect(stateAfterStart?.sessionId).toBeTruthy();
      expect(stateAfterStart?.sessionId).not.toBe(PENDING_SESSION_ID);
      expect(readClaudeSessionFile(stateAfterStart?.pid)?.name).toBe(handle);

      // Send another message — should transition to processing
      send(handle, "Reply with exactly the word: ping");

      // Verify status transitions to processing (hook: UserPromptSubmit)
      await waitFor(() => readState(handle)?.status === "processing", 10000);

      // Wait for idle again (hook: Stop)
      await waitFor(() => readState(handle)?.status === "idle");

      // Capture should contain response
      const output = await capture(handle, { lines: 50 });
      expect(output).toBeTruthy();

      // Kill and verify cleanup
      kill(handle);
      expect(hasSession(handle)).toBe(false);
    },
    120000,
  );
});

// ---------------------------------------------------------------------------
// Test 2: Codex full lifecycle
// ---------------------------------------------------------------------------

describe("codex agent lifecycle", () => {
  codexIt(
    "start -> idle -> send -> processing -> verify state -> kill",
    async () => {
      const handle = `${TEST_PREFIX}-codex`;
      testHandles.push(handle);

      const state = start("codex", ["--name", handle]);

      expect(state.handle).toBe(handle);
      expect(state.provider).toBe("codex");

      // start() is best-effort: a slow boot (e.g. under load) can return before
      // the SessionStart hook has fired. The hook settles the session to idle
      // shortly after — wait for that rather than trusting the sync return.
      await waitFor(() => readState(handle)?.status === "idle", 60000);

      const stateAfterStart = readState(handle);
      expect(stateAfterStart?.status).toBe("idle");
      expect(stateAfterStart?.pid).toBeGreaterThan(0);
      expect(processCommand(stateAfterStart?.pid)).toBe("codex");

      send(handle, "Reply with exactly the word: pong");
      await waitFor(() => readState(handle)?.status === "processing", 15000);

      await waitFor(() => {
        const s = readState(handle);
        return s?.status === "processing" && !!s.sessionId && s.sessionId !== PENDING_SESSION_ID;
      }, 30000);

      // Tmux session should exist with handle name
      expect(hasSession(handle)).toBe(true);
      expect(readState(handle)?.sessionId).not.toBe(PENDING_SESSION_ID);

      // Kill and verify cleanup
      kill(handle);
      expect(hasSession(handle)).toBe(false);
    },
    180000,
  );

  codexIt(
    "starts named sessions without blocking on best-effort thread rename",
    async () => {
      const handle = `${TEST_PREFIX}-codex-deferred-input`;
      testHandles.push(handle);

      const state = start("codex", ["/help", "--name", handle]);

      expect(state.handle).toBe(handle);
      // Best-effort start may return while still booting under load; wait for
      // the session to leave "starting" before asserting the settled status.
      await waitFor(() => readState(handle)?.status !== "starting", 60000);
      const persisted = readState(handle);
      expect(persisted?.status).toBeOneOf(["idle", "processing"]);
      expect(processCommand(persisted?.pid)).toBe("codex");

      const output = await capture(handle, { lines: 180 });
      expect(output).toContain("/help");

      kill(handle);
    },
    120000,
  );
});

// ---------------------------------------------------------------------------
// Test 3: Status detection (three-layer)
// ---------------------------------------------------------------------------

describe("status detection", () => {
  claudeIt(
    "detects idle via state file, backfills Claude metadata, and falls back from stale processing",
    async () => {
      const handle = `${TEST_PREFIX}-status`;
      testHandles.push(handle);

      start("claude", ["--name", handle]);

      const stateAfterStart = readState(handle);
      expect(stateAfterStart?.status).toBe("idle");
      expect(stateAfterStart?.sessionId).toBeTruthy();
      expect(stateAfterStart?.sessionId).not.toBe(PENDING_SESSION_ID);
      expect(processCommand(stateAfterStart?.pid)).toBe("claude");
      expect(readClaudeSessionFile(stateAfterStart?.pid)?.name).toBe(handle);

      const statusResult = status(handle);
      expect(statusResult).toBe("idle");

      const jsonResult = JSON.parse(status(handle, { json: true }));
      expect(jsonResult.status).toBe("idle");
      expect(jsonResult.pid).toBeGreaterThan(0);
      expect(jsonResult.handle).toBe(handle);

      const staleState = readState(handle)!;
      staleState.status = "processing";
      writeState(staleState);
      const old = new Date(Date.now() - 31 * 60 * 1000);
      utimesSync(statePath(handle), old, old);

      expect(status(handle)).toBe("idle");

      kill(handle);
    },
    120000,
  );
});

// ---------------------------------------------------------------------------
// Test 5: Codex handle independence
// ---------------------------------------------------------------------------

describe("codex handle independence", () => {
  codexIt(
    "keeps the YACO handle authoritative even before Codex title sync completes",
    async () => {
      const handle = `${TEST_PREFIX}-name`;
      testHandles.push(handle);

      start("codex", ["--name", handle]);

      // start() is best-effort; the SessionStart hook settles status to idle.
      await waitFor(() => readState(handle)?.status === "idle", 60000);
      const state = readState(handle);
      expect(state?.status).toBe("idle");
      expect(processCommand(state?.pid)).toBe("codex");
      expect(hasSession(handle)).toBe(true);

      expect(state?.handle).toBe(handle);

      kill(handle);
    },
    120000,
  );

  codexIt(
    "resolves a stable sessionId for an unnamed empty start and keeps the handle authoritative",
    async () => {
      const started = start("codex", []);
      const handle = started.handle;
      testHandles.push(handle);

      // start() is best-effort; wait for the SessionStart hook to settle idle.
      // (Pre-fix the hook never fired, so this would hang in "starting".)
      await waitFor(() => readState(handle)?.status === "idle", 60000);
      expect(processCommand(readState(handle)?.pid)).toBe("codex");

      send(handle, `Reply with exactly the word: first-${Date.now()}`);

      await waitFor(() => {
        const state = readState(handle);
        return state?.status === "processing" && !!state.sessionId && state.sessionId !== PENDING_SESSION_ID;
      }, 30000);

      const state = readState(handle);
      expect(state?.sessionId).toBeTruthy();
      expect(state?.sessionId).not.toBe(PENDING_SESSION_ID);
      expect(processCommand(state?.pid)).toBe("codex");

      kill(handle);
    },
    180000,
  );
});
