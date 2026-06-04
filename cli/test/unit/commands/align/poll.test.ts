/** Pure pollStatus tests — no subprocess, no fs polling delay.
 *
 *  Drive the loop deterministically by stubbing `now` and `sleep`. The
 *  real-time path is exercised end-to-end by the CLI subprocess tests in
 *  poll-cli.test.ts.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseStatusFile,
  pollStatus,
} from "../../../../src/commands/align/poll.ts";

const TMP_ROOTS: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaco-align-poll-"));
  TMP_ROOTS.push(dir);
  return dir;
}

function writeStatus(dir: string, line: string): string {
  const path = join(dir, "status.txt");
  writeFileSync(path, line, "utf-8");
  return path;
}

afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("parseStatusFile", () => {
  it("parses a well-formed line with all four tokens", () => {
    const dir = tempDir();
    const path = writeStatus(dir, "SEQ=3 NEXT=CLAUDE CODEX=APPROVE CLAUDE=PENDING\n");
    expect(parseStatusFile(path)).toEqual({
      seq: "3",
      next: "CLAUDE",
      codex: "APPROVE",
      claude: "PENDING",
    });
  });

  it("reads only the first line when the file has trailing content", () => {
    const dir = tempDir();
    const path = writeStatus(dir, "SEQ=1 NEXT=CODEX\nNEXT=CLAUDE\n");
    expect(parseStatusFile(path)).toEqual({
      seq: "1",
      next: "CODEX",
      codex: undefined,
      claude: undefined,
    });
  });

  it("returns null when the file is missing", () => {
    expect(parseStatusFile(join(tempDir(), "nope.txt"))).toBeNull();
  });

  it("returns null when NEXT= is absent", () => {
    const dir = tempDir();
    const path = writeStatus(dir, "SEQ=1 CODEX=PENDING\n");
    expect(parseStatusFile(path)).toBeNull();
  });

  it("returns null on empty file", () => {
    const dir = tempDir();
    const path = writeStatus(dir, "");
    expect(parseStatusFile(path)).toBeNull();
  });
});

describe("pollStatus", () => {
  it("returns YOUR_TURN immediately when NEXT matches the role", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=1 NEXT=CLAUDE CODEX=APPROVE CLAUDE=PENDING\n");
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 5000,
      silent: true,
    });
    expect(outcome.status).toBe("YOUR_TURN");
    expect(outcome.parsed?.next).toBe("CLAUDE");
    expect(outcome.parsed?.seq).toBe("1");
  });

  it("treats role case-insensitively", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=1 NEXT=CODEX\n");
    const outcome = await pollStatus({
      statusFile: file,
      role: "codex",
      intervalMs: 1000,
      timeoutMs: 5000,
      silent: true,
    });
    expect(outcome.status).toBe("YOUR_TURN");
    expect(outcome.parsed?.next).toBe("CODEX");
  });

  it("returns DONE when NEXT=DONE regardless of role", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=4 NEXT=DONE CODEX=APPROVE CLAUDE=APPROVE\n");
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 5000,
      silent: true,
    });
    expect(outcome.status).toBe("DONE");
    expect(outcome.parsed?.codex).toBe("APPROVE");
    expect(outcome.parsed?.claude).toBe("APPROVE");
  });

  it("returns ERROR when the status file is missing", async () => {
    const outcome = await pollStatus({
      statusFile: join(tempDir(), "nope.txt"),
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 5000,
      silent: true,
    });
    expect(outcome.status).toBe("ERROR");
    expect(outcome.message).toContain("cannot read or parse");
  });

  it("returns ERROR when the status file is malformed (no NEXT)", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=2 CODEX=PENDING\n");
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 5000,
      silent: true,
    });
    expect(outcome.status).toBe("ERROR");
  });

  it("returns TIMEOUT after deadline when NEXT stays on the other role", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=1 NEXT=CODEX CODEX=PENDING CLAUDE=PENDING\n");
    let virtualMs = 0;
    let sleepCalls = 0;
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 1000,
      timeoutMs: 3000,
      silent: true,
      sleep: async (ms) => {
        sleepCalls++;
        virtualMs += ms;
      },
      now: () => virtualMs,
    });
    expect(outcome.status).toBe("TIMEOUT");
    expect(outcome.message).toContain("CLAUDE");
    // Three 1s sleeps before the elapsed >= timeout check fires.
    expect(sleepCalls).toBe(3);
  });

  it("flips from CODEX to CLAUDE between polls and returns YOUR_TURN", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=1 NEXT=CODEX CODEX=PENDING CLAUDE=PENDING\n");
    let virtualMs = 0;
    let sleeps = 0;
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 500,
      timeoutMs: 5000,
      silent: true,
      sleep: async (ms) => {
        sleeps++;
        virtualMs += ms;
        // Flip the file on the second wakeup.
        if (sleeps === 2) {
          writeFileSync(
            file,
            "SEQ=2 NEXT=CLAUDE CODEX=APPROVE CLAUDE=PENDING\n",
            "utf-8",
          );
        }
      },
      now: () => virtualMs,
    });
    expect(outcome.status).toBe("YOUR_TURN");
    expect(outcome.parsed?.seq).toBe("2");
    expect(outcome.parsed?.codex).toBe("APPROVE");
  });

  it("respects timeoutMs=0 as infinite (would loop, so flip on sleep 1)", async () => {
    const dir = tempDir();
    const file = writeStatus(dir, "SEQ=1 NEXT=CODEX\n");
    let sleeps = 0;
    const outcome = await pollStatus({
      statusFile: file,
      role: "CLAUDE",
      intervalMs: 1,
      timeoutMs: 0,
      silent: true,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) {
          writeFileSync(file, "SEQ=2 NEXT=DONE\n", "utf-8");
        }
        // Cap sleeps so a bug never produces an infinite loop.
        if (sleeps > 5) throw new Error("infinite loop guard");
      },
      now: () => 0,
    });
    expect(outcome.status).toBe("DONE");
  });
});
