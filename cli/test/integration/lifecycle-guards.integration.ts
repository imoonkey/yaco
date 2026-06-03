// Phase 2: Integration guard tests for lifecycle fixes G3, G4
// Requires real agents (Claude/Codex) and tmux.
//
// Coverage notes:
//   P6 (Codex /rename during processing) — already covered by agent-lifecycle.integration.ts
//     "runs deferred initial input after /rename for named starts"
//   P7 (Claude rename verification) — already covered by agent-sync.integration.ts
//     "renames Claude sessions across tmux, state, and Claude's own session metadata"
//
// Known limitation: Codex Stop hook does not fire. UserPromptSubmit works.
// State stays "processing" after agent completes. Stale fallback (30 min) or
// pane capture is the only reconciliation path. See G4 test comments.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { start } from "../../src/commands/start.ts";
import { send } from "../../src/commands/send.ts";
import { capture } from "../../src/commands/capture.ts";
import { kill } from "../../src/commands/kill.ts";
import { readState, deleteState } from "../../src/state.ts";
import { isTmuxAvailable } from "../../src/tmux.ts";
import { isIdle } from "../../src/providers.ts";
import { PENDING_SESSION_ID } from "../../src/session-id.ts";

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
// Tests UserPromptSubmit hook fires (state → processing) and agent completes
// (pane shows idle prompt). Codex Stop hook does NOT fire — state stays
// "processing" after completion. This is a known Codex limitation.
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
      // NOTE: Codex Stop hook does not fire. State stays "processing" after
      // agent completes. Pane-based idle detection is the only reliable signal.
      await waitFor(async () => isIdle(await capture(handle, { lines: 20 })), 30000);

      kill(handle);
    },
    60000,
  );
});
