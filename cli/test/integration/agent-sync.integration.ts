import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { start } from "../../src/commands/agent/start.ts";
import { send } from "../../src/commands/agent/send.ts";
import { capture } from "../../src/commands/agent/capture.ts";
import { kill } from "../../src/commands/agent/kill.ts";
import { rename } from "../../src/commands/agent/rename.ts";
import { status } from "../../src/commands/agent/status.ts";
import { readState, writeState, deleteState } from "../../src/lib/core/agent/session-state.ts";
import { hasSession, isTmuxAvailable } from "../../src/lib/core/agent/tmux.ts";
import { PENDING_SESSION_ID } from "../../src/lib/core/agent/session-id.ts";

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

const testHandles: string[] = [];

// Run agents in an isolated directory so they don't interfere with the project
const TEST_CWD = "/tmp/multmux-test";
let savedCwd: string;
beforeAll(() => { mkdirSync(TEST_CWD, { recursive: true }); savedCwd = process.cwd(); process.chdir(TEST_CWD); });
afterAll(() => { process.chdir(savedCwd); });

afterEach(() => {
  for (const handle of testHandles) {
    try {
      execSync(`tmux kill-session -t "${handle}"`, { stdio: "pipe", timeout: 5000 });
    } catch { /* session may already be gone */ }
    deleteState(handle);
  }
  testHandles.length = 0;
});

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

describe("runtime metadata repair", () => {
  claudeIt(
    "repairs corrupted Claude pid/sessionId via status --json and keeps the state schema clean",
    async () => {
      const handle = `${TEST_PREFIX}-claude-repair`;
      testHandles.push(handle);

      start("claude", ["--name", handle]);

      const live = readState(handle)!;
      writeState({ ...live, pid: 0, sessionId: "" });

      const repaired = JSON.parse(status(handle, { json: true }));
      expect(repaired.pid).toBe(live.pid);
      expect(repaired.sessionId).toBe(live.sessionId);
      expect(processCommand(repaired.pid)).toBe("claude");
      expect(Object.keys(readState(handle)!).sort()).toEqual(DOCUMENTED_STATE_FIELDS);

      kill(handle);
    },
    120000,
  );

  codexIt(
    "repairs corrupted Codex pid/sessionId via status --json and keeps the state schema clean",
    async () => {
      const handle = `${TEST_PREFIX}-codex-repair`;
      testHandles.push(handle);

      start("codex", ["--name", handle]);
      send(handle, "Reply with exactly the word: repair");
      await waitFor(() => readState(handle)?.status === "processing", 15000);
      await waitFor(() => {
        const state = readState(handle);
        return state?.status === "processing" && !!state.sessionId && state.sessionId !== PENDING_SESSION_ID;
      }, 30000);

      const live = readState(handle)!;
      writeState({ ...live, pid: 0, sessionId: "" });

      const repaired = JSON.parse(status(handle, { json: true }));
      expect(repaired.pid).toBe(live.pid);
      expect(repaired.sessionId).toBe(live.sessionId);
      expect(processCommand(repaired.pid)).toBe("codex");
      expect(Object.keys(readState(handle)!).sort()).toEqual(DOCUMENTED_STATE_FIELDS);

      kill(handle);
    },
    180000,
  );
});

describe("rename sync", () => {
  claudeIt(
    "renames Claude sessions across tmux, state, and Claude's own session metadata",
    async () => {
      const oldHandle = `${TEST_PREFIX}-claude-rename-a`;
      const newHandle = `${TEST_PREFIX}-claude-rename-b`;
      testHandles.push(oldHandle, newHandle);

      start("claude", ["--name", oldHandle]);

      const before = readState(oldHandle)!;
      rename(oldHandle, newHandle);

      await waitFor(() => readClaudeSessionFile(before.pid)?.name === newHandle, 10000);

      expect(readState(oldHandle)).toBeNull();
      expect(readState(newHandle)?.sessionId).toBe(before.sessionId);
      expect(hasSession(oldHandle)).toBe(false);
      expect(hasSession(newHandle)).toBe(true);

      kill(newHandle);
    },
    120000,
  );

  codexIt(
    "renames Codex sessions across tmux, state, and the internal thread name",
    async () => {
      const oldHandle = `${TEST_PREFIX}-codex-rename-a`;
      const newHandle = `${TEST_PREFIX}-codex-rename-b`;
      testHandles.push(oldHandle, newHandle);

      start("codex", ["--name", oldHandle]);

      rename(oldHandle, newHandle);

      await waitFor(() => hasSession(newHandle) && !hasSession(oldHandle), 10000);
      const output = await capture(newHandle, { wait: true, lines: 200 });

      expect(output).toContain(`Thread renamed to ${newHandle}`);
      expect(readState(oldHandle)).toBeNull();
      expect(readState(newHandle)?.handle).toBe(newHandle);

      kill(newHandle);
    },
    180000,
  );
});

describe("session resume", () => {
  claudeIt(
    "resumes a Claude session using the stored sessionId",
    async () => {
      const token = `claude-token-${Date.now()}`;
      const first = `${TEST_PREFIX}-claude-resume-a`;
      const second = `${TEST_PREFIX}-claude-resume-b`;
      testHandles.push(first, second);

      start("claude", [
        `Remember this token exactly: ${token}. Reply with exactly: stored`,
        "--name", first,
      ]);

      const sessionId = readState(first)?.sessionId;
      expect(sessionId).toBeTruthy();
      expect(sessionId).not.toBe(PENDING_SESSION_ID);

      kill(first);

      const resumed = start("claude", ["--resume", sessionId!, "--name", second]);
      expect(resumed.sessionId).toBe(sessionId);
      expect(readState(second)?.sessionId).toBe(sessionId);

      const output = await capture(second, { lines: 160 });
      expect(output).toContain(token);

      kill(second);
    },
    120000,
  );

  codexIt(
    "resumes a Codex session using the stored UUID sessionId",
    async () => {
      const token = `codex-token-${Date.now()}`;
      const first = `${TEST_PREFIX}-codex-resume-a`;
      const second = `${TEST_PREFIX}-codex-resume-b`;
      testHandles.push(first, second);

      start("codex", ["--name", first]);
      send(first, `Remember this token exactly: ${token}. Reply with exactly: stored`);
      await waitFor(() => readState(first)?.status === "processing", 15000);
      await waitFor(() => {
        const sessionId = readState(first)?.sessionId;
        return !!sessionId && sessionId !== PENDING_SESSION_ID;
      }, 30000);

      const sessionId = readState(first)?.sessionId;
      expect(sessionId).toBeTruthy();
      expect(sessionId).not.toBe(PENDING_SESSION_ID);

      kill(first);

      const resumed = start("codex", ["--resume", sessionId!, "--name", second]);
      expect(resumed.sessionId).toBe(sessionId);
      expect(readState(second)?.sessionId).toBe(sessionId);

      const output = await capture(second, { lines: 180 });
      expect(output).toContain(token);

      kill(second);
    },
    180000,
  );
});
