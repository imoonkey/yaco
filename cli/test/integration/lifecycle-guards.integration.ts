// Phase 2: Integration guard tests for lifecycle fixes G3, G4
// Requires real agents (Claude/Codex) and tmux.
//
// Coverage notes:
//   P6 (Codex /rename during processing) — covered by agent-sync.integration.ts
//     "renames Codex sessions across tmux, state, and the internal thread name"
//   P7 (Claude rename verification) — already covered by agent-sync.integration.ts
//     "renames Claude sessions across tmux, state, and Claude's own session metadata"
//
// Codex UserPromptSubmit and Stop hooks are both part of the lifecycle contract.
// This live guard smokes prompt submission and rendered completion when a real
// Codex environment is available; in-process hook-event tests cover the Stop
// idle state + final-message notice path deterministically.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { start } from "../../src/commands/agent/start.ts";
import { send } from "../../src/commands/agent/send.ts";
import { capture } from "../../src/commands/agent/capture.ts";
import { kill } from "../../src/commands/agent/kill.ts";
import { readState, deleteState } from "../../src/lib/core/agent/session-state.ts";
import { isTmuxAvailable } from "../../src/lib/core/agent/tmux.ts";
import { isIdle } from "../../src/lib/core/agent/providers.ts";
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
// Unique handle prefix + cleanup
// ---------------------------------------------------------------------------

const TEST_PREFIX = `guard-int-${process.pid}`;
const testHandles: string[] = [];

// Run agents in an isolated directory so they don't interfere with the project
const TEST_CWD = "/tmp/multmux-test";
let savedCwd: string;
// Sandbox YACO_HOME so session-state files land in a throwaway dir, not the live
// ~/.yaco/sessions the web app reads (env propagates into the spawned agents'
// tmux session, isolating hook/wrapper state writes too).
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
    await Bun.sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

// ===========================================================================
// G3: SessionStart timing
// Claude resolves sessionId from ~/.claude/sessions/<pid>.json at startup
// (PID file scan), even without a prompt. Codex requires a prompt to create
// a thread — covered by agent-lifecycle "keeps unnamed empty starts pending".
// ===========================================================================

describe("G3: SessionStart timing", () => {
  claudeIt(
    "no-prompt start resolves sessionId via PID file scan (not hook)",
    async () => {
      const handle = `${TEST_PREFIX}-g3-noprompt`;
      testHandles.push(handle);

      // Start Claude without a prompt
      const state = start("claude", ["--name", handle]);

      expect(state.handle).toBe(handle);

      const persisted = readState(handle);
      expect(persisted?.status).toBe("idle");
      // Claude writes ~/.claude/sessions/<pid>.json at startup.
      // sessionId is resolved via PID file scan, even without a prompt.
      expect(persisted?.sessionId).toBeTruthy();
      expect(persisted?.sessionId).not.toBe(PENDING_SESSION_ID);

      kill(handle);
    },
    120000,
  );
});

// ===========================================================================
// G4: Codex hook cycle
// Tests UserPromptSubmit hook fires (state → processing), the agent completes
// (pane shows idle prompt). Stop idle/final-message notice is covered in
// hook-event tests because real Codex hook startup can be environment-sensitive.
// ===========================================================================

describe("G4: Codex hook cycle", () => {
  codexIt(
    "UserPromptSubmit hook fires and agent completes to idle prompt",
    async () => {
      const handle = `${TEST_PREFIX}-g4`;
      testHandles.push(handle);

      start("codex", ["--name", handle]);
      send(handle, "/help");

      // Verify UserPromptSubmit hook fires — state transitions to processing
      await waitFor(() => readState(handle)?.status === "processing", 15000);

      // Verify agent completes — pane shows idle prompt (›).
      await waitFor(async () => isIdle(await capture(handle, { lines: 20 })), 30000);

      kill(handle);
    },
    60000,
  );
});
