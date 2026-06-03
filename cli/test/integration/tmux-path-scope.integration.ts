import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, afterEach } from "bun:test";
import { capture } from "../../src/commands/capture.ts";
import { kill } from "../../src/commands/kill.ts";
import { send } from "../../src/commands/send.ts";
import { status } from "../../src/commands/status.ts";
import {
  capturePane,
  createSession,
  hasSession,
  isTmuxAvailable,
} from "../../src/tmux.ts";
import { writeState, deleteState, listByPath, type SessionState } from "../../src/state.ts";

const tmuxIt = isTmuxAvailable() ? it.serial : it.skip;
const BOOT_TIMEOUT_MS = 5000;
const POLL_MS = 100;

function makeState(handle: string, sessionPath: string): SessionState {
  return {
    handle,
    provider: "claude",
    sessionPath,
    pid: 0,
    sessionId: "",
    status: "starting",
    createdAt: new Date().toISOString(),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = BOOT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function withCwd<T>(cwd: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

function killTmuxSession(name: string): void {
  try {
    execSync(`tmux kill-session -t "${name}"`, { stdio: "pipe", timeout: 5000 });
  } catch {
    // Session may already be gone.
  }
}

function showSessionOption(name: string, option: string): string {
  return execSync(`tmux show-options -qv -t "${name}" ${option}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
  }).trim();
}

describe("tmux global handles", () => {
  // Use unique handles to avoid collisions with real sessions
  const testPrefix = `inttest-${process.pid}-${Date.now()}`;

  afterEach(() => {
    // Clean up any test sessions
    for (const state of listByPath("/")) {
      if (state.handle.startsWith(testPrefix)) {
        killTmuxSession(state.handle);
        deleteState(state.handle);
      }
    }
  });

  tmuxIt("handle = tmux session name directly", async () => {
    const handle = `${testPrefix}-direct`;
    const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));

    try {
      // Write state file and create tmux session with handle as name
      writeState(makeState(handle, projectPath));
      createSession(handle, "bash -lc 'printf ready\\\\n; exec bash -i'", projectPath);

      await waitFor(() => hasSession(handle));
      await waitFor(() => {
        try { return capturePane(handle).includes("ready"); }
        catch { return false; }
      });

      // Handle IS the tmux session name — no suffix
      expect(hasSession(handle)).toBe(true);
    } finally {
      killTmuxSession(handle);
      deleteState(handle);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  tmuxIt("send and capture work with global handles", async () => {
    const handle = `${testPrefix}-sendcap`;
    const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));

    try {
      writeState(makeState(handle, projectPath));
      createSession(handle, "bash -lc 'printf ready\\\\n; exec bash -i'", projectPath);

      await waitFor(() => hasSession(handle));
      await waitFor(() => {
        try { return capturePane(handle).includes("ready"); }
        catch { return false; }
      });

      send(handle, "echo ping-test");

      await waitFor(async () => {
        const output = await capture(handle, { lines: 20 });
        return output.includes("ping-test");
      });

      const output = await capture(handle, { lines: 20 });
      expect(output).toContain("ping-test");
    } finally {
      killTmuxSession(handle);
      deleteState(handle);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  tmuxIt("status filters by sessionPath descendant match", async () => {
    const h1 = `${testPrefix}-parent`;
    const h2 = `${testPrefix}-child`;
    const h3 = `${testPrefix}-other`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));
    const parentDir = join(root, "project");
    const childDir = join(root, "project", "sub");
    const otherDir = join(root, "other");
    mkdirSync(parentDir, { recursive: true });
    mkdirSync(childDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });

    try {
      writeState(makeState(h1, parentDir));
      writeState(makeState(h2, childDir));
      writeState(makeState(h3, otherDir));

      createSession(h1, "bash -lc 'exec bash -i'", parentDir);
      createSession(h2, "bash -lc 'exec bash -i'", childDir);
      createSession(h3, "bash -lc 'exec bash -i'", otherDir);

      await waitFor(() => hasSession(h1) && hasSession(h2) && hasSession(h3));

      // Status from parent should see h1 and h2 but not h3
      const output = await withCwd(parentDir, () => status(undefined, { json: true }));
      const sessions = JSON.parse(output);
      const handles = sessions.map((s: any) => s.handle);
      expect(handles).toContain(h1);
      expect(handles).toContain(h2);
      expect(handles).not.toContain(h3);
    } finally {
      killTmuxSession(h1);
      killTmuxSession(h2);
      killTmuxSession(h3);
      deleteState(h1);
      deleteState(h2);
      deleteState(h3);
      rmSync(root, { recursive: true, force: true });
    }
  });

  tmuxIt("kill --all only affects sessions under cwd", async () => {
    const h1 = `${testPrefix}-killme`;
    const h2 = `${testPrefix}-keepme`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA);
    mkdirSync(projectB);

    try {
      writeState(makeState(h1, projectA));
      writeState(makeState(h2, projectB));
      createSession(h1, "bash -lc 'exec bash -i'", projectA);
      createSession(h2, "bash -lc 'exec bash -i'", projectB);

      await waitFor(() => hasSession(h1) && hasSession(h2));

      await withCwd(projectA, () => kill(undefined, { all: true }));

      await waitFor(() => !hasSession(h1));
      expect(hasSession(h2)).toBe(true);
    } finally {
      killTmuxSession(h1);
      killTmuxSession(h2);
      deleteState(h1);
      deleteState(h2);
      rmSync(root, { recursive: true, force: true });
    }
  });

  tmuxIt("disables the tmux status bar for managed sessions", () => {
    const handle = `${testPrefix}-opts`;
    const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));

    try {
      createSession(handle, "bash -lc 'printf ready\\\\n; exec bash -i'", projectPath);

      expect(showSessionOption(handle, "status")).toBe("off");
      expect(showSessionOption(handle, "focus-events")).toBe("on");
      expect(showSessionOption(handle, "allow-passthrough")).toBe("on");
    } finally {
      killTmuxSession(handle);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  tmuxIt("preserves ANSI escapes when capture disables stripping", async () => {
    const handle = `${testPrefix}-ansi`;
    const projectPath = realpathSync(mkdtempSync(join(tmpdir(), "multmux-integration-")));
    const red = "\u001b[41mred\u001b[0m";

    try {
      writeState(makeState(handle, projectPath));
      createSession(handle, `bash -lc 'printf "${red}\\\\n"; exec bash -i'`, projectPath);

      await waitFor(() => hasSession(handle));
      await waitFor(() => {
        try { return capturePane(handle, undefined, true).includes("\u001b[41mred"); }
        catch { return false; }
      });

      const plain = await capture(handle, { lines: 10 });
      const raw = await capture(handle, { lines: 10, stripAnsiCodes: false });

      expect(plain).toContain("red");
      expect(plain).not.toContain("\u001b[41m");
      expect(raw).toContain("\u001b[41mred");
    } finally {
      killTmuxSession(handle);
      deleteState(handle);
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
