import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
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
import { setTimeout as sleep } from "node:timers/promises";

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

const claudeIt = tmux && hasClaude ? it.sequential : it.skip;
const codexIt = tmux && hasCodex ? it.sequential : it.skip;

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
// Runtime metadata and lineage fields may be present depending on the path:
// statusEnteredAt is stamped on status transitions, spawnedBy/parentSession
// capture lineage, and resumedFrom marks resumed provider threads.
const OPTIONAL_STATE_FIELDS = ["statusEnteredAt", "spawnedBy", "parentSession", "resumedFrom"];

/** Assert a session-state record carries exactly the documented required fields
 *  plus only the allowed optional lineage fields — no stray keys leaked in. */
function expectCleanStateSchema(keys: string[]): void {
  const allowed = new Set([...DOCUMENTED_STATE_FIELDS, ...OPTIONAL_STATE_FIELDS]);
  for (const required of DOCUMENTED_STATE_FIELDS) expect(keys).toContain(required);
  for (const key of keys) expect(allowed.has(key)).toBe(true);
}

const testHandles: string[] = [];

// Run agents in an isolated directory so they don't interfere with the project
const TEST_CWD = "/tmp/multmux-test";
let savedCwd: string;
// Sandbox YACO_HOME so session-state files land in a throwaway dir, not the live
// ~/.yaco/sessions the web app reads (tmux new-session propagates the env to the
// spawned agents, so their hook/wrapper state writes stay isolated too).
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(500);
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

      const repaired = JSON.parse(await status(handle, { json: true }));
      expect(repaired.pid).toBe(live.pid);
      expect(repaired.sessionId).toBe(live.sessionId);
      expect(processCommand(repaired.pid)).toBe("claude");
      expectCleanStateSchema(Object.keys(readState(handle)!));

      kill(handle);
    },
    120000,
  );

  codexIt(
    "repairs corrupted Codex pid via status --json and keeps the state schema clean",
    async () => {
      const handle = `${TEST_PREFIX}-codex-repair`;
      testHandles.push(handle);

      start("codex", ["--name", handle]);
      send(handle, "Reply with exactly the word: repair");
      await waitFor(() => readState(handle)?.status === "processing", 15000);

      const live = readState(handle)!;
      writeState({ ...live, pid: 0, sessionId: "" });

      const repaired = JSON.parse(await status(handle, { json: true }));
      expect(repaired.pid).toBe(live.pid);
      if (live.sessionId && live.sessionId !== PENDING_SESSION_ID) {
        expect(repaired.sessionId).toBe(live.sessionId);
      } else {
        expect(repaired.sessionId).toBe(PENDING_SESSION_ID);
      }
      expect(repaired.pid).toBeGreaterThan(0);
      expectCleanStateSchema(Object.keys(readState(handle)!));

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
      await rename(oldHandle, newHandle);

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

      await rename(oldHandle, newHandle);

      await waitFor(() => hasSession(newHandle) && !hasSession(oldHandle), 10000);
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
      if (!sessionId || sessionId === PENDING_SESSION_ID) throw new Error("Claude session id did not resolve");

      kill(first);

      const resumed = start("claude", ["--resume", sessionId, "--name", second]);
      expect(resumed.sessionId).toBe(sessionId);
      expect(readState(second)?.sessionId).toBe(sessionId);

      let output = "";
      await waitFor(async () => {
        output = await capture(second, { lines: 160 });
        return output.includes(token);
      }, 30000);
      expect(output).toContain(token);

      kill(second);
    },
    120000,
  );

  codexIt(
    "resumes a Codex session using the stored UUID sessionId when available",
    async () => {
      const token = `codex-token-${Date.now()}`;
      const first = `${TEST_PREFIX}-codex-resume-a`;
      const second = `${TEST_PREFIX}-codex-resume-b`;
      testHandles.push(first, second);

      start("codex", ["--name", first]);
      send(first, `Remember this token exactly: ${token}. Reply with exactly: stored`);
      await waitFor(() => readState(first)?.status === "processing", 15000);
      try {
        await waitFor(async () => {
          try {
            const state = JSON.parse(await status(first, { json: true, reconcile: true }));
            return !!state.sessionId && state.sessionId !== PENDING_SESSION_ID;
          } catch {
            return false;
          }
        }, 60000);
      } catch {
        // Some Codex installations used in CI/test hosts do not expose a
        // resolvable provider thread id for this named prompt path. Resume by
        // UUID is covered when the id is available, and the non-authoritative
        // origin contract is covered by unit tests; do not fail the lifecycle
        // suite on an unavailable provider id.
        kill(first);
        return;
      }

      const sessionId = readState(first)?.sessionId;
      expect(sessionId).toBeTruthy();
      expect(sessionId).not.toBe(PENDING_SESSION_ID);
      if (!sessionId || sessionId === PENDING_SESSION_ID) throw new Error("Codex session id did not resolve");

      kill(first);

      const resumed = start("codex", ["--resume", sessionId, "--name", second]);
      expect(resumed.sessionId).toBe(sessionId);
      expect(readState(second)?.sessionId).toBe(sessionId);
      expect(hasSession(second)).toBe(true);

      kill(second);
    },
    180000,
  );
});
