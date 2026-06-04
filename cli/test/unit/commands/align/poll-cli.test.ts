/** Subprocess tests for `yaco align poll` — exit codes and envelopes.
 *
 *  pollStatus is tested with stubbed clock/sleep in poll.test.ts; this
 *  suite exercises the real CLI binary so we can assert the historical
 *  exit-code contract (0 / 1 / 2) and the --json envelope shape on
 *  stderr.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../../../src/main.ts");

function runYaco(
  args: string[],
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bun", ["run", BIN, ...args], {
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
    // Generous timeout — the slowest case is a 5s real-time poll.
    timeout: 30_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "yaco-align-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeStatus(dir: string, line: string): string {
  const path = join(dir, "status.txt");
  writeFileSync(path, line, "utf-8");
  return path;
}

describe("yaco align poll — text mode", () => {
  it("YOUR_TURN: exit 0, single line on stdout", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 NEXT=CLAUDE\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CLAUDE",
        "--interval",
        "1",
        "--timeout",
        "5",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("YOUR_TURN\n");
    });
  });

  it("DONE: exit 0", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=2 NEXT=DONE\n");
      const r = runYaco(["align", "poll", file, "CLAUDE", "--timeout", "5"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("DONE\n");
    });
  });

  it("TIMEOUT: exit 1 with TIMEOUT on stderr", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 NEXT=CODEX\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CLAUDE",
        "--interval",
        "1",
        "--timeout",
        "2",
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("TIMEOUT\n");
      expect(r.stderr).toBe("");
    });
  });

  it("ERROR: exit 2 on malformed status.txt", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 CODEX=PENDING\n"); // no NEXT=
      const r = runYaco(["align", "poll", file, "CLAUDE", "--timeout", "5"]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("ERROR\n");
      expect(r.stderr).toBe("");
    });
  });

  it("ERROR: exit 2 when status file is missing", () => {
    withTmp((dir) => {
      const r = runYaco([
        "align",
        "poll",
        join(dir, "missing.txt"),
        "CLAUDE",
        "--timeout",
        "5",
      ]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("ERROR\n");
      expect(r.stderr).toBe("");
    });
  });

  it("text-mode routing parity with align_poll.sh: terminal word always on stdout", () => {
    // The shell helper printed YOUR_TURN/DONE/TIMEOUT/ERROR to stdout for
    // ALL four outcomes — callers parse stdout. This test pins that down
    // so we never re-break legacy `$(align_poll.sh ...)` capture.
    withTmp((dir) => {
      const f = writeStatus(dir, "SEQ=1 NEXT=CLAUDE\n");
      const turn = runYaco(["align", "poll", f, "CLAUDE", "--timeout", "5"]);
      expect(turn.stdout).toBe("YOUR_TURN\n");
      expect(turn.stderr).toBe("");

      writeStatus(dir, "SEQ=2 NEXT=DONE\n");
      const done = runYaco(["align", "poll", f, "CLAUDE", "--timeout", "5"]);
      expect(done.stdout).toBe("DONE\n");
      expect(done.stderr).toBe("");

      writeStatus(dir, "SEQ=3 NEXT=CODEX\n");
      const to = runYaco(["align", "poll", f, "CLAUDE", "--interval", "1", "--timeout", "2"]);
      expect(to.stdout).toBe("TIMEOUT\n");
      expect(to.stderr).toBe("");

      writeStatus(dir, "SEQ=4 CODEX=PENDING\n");
      const er = runYaco(["align", "poll", f, "CLAUDE", "--timeout", "5"]);
      expect(er.stdout).toBe("ERROR\n");
      expect(er.stderr).toBe("");
    });
  });
});

describe("yaco align poll — --json mode", () => {
  it("YOUR_TURN: exit 0, {ok:true, data:{status:'YOUR_TURN', ...}}", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 NEXT=CLAUDE CODEX=APPROVE CLAUDE=PENDING\n");
      const r = runYaco(["align", "poll", file, "CLAUDE", "--timeout", "5", "--json"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.status).toBe("YOUR_TURN");
      expect(parsed.data.next).toBe("CLAUDE");
      expect(parsed.data.codex).toBe("APPROVE");
    });
  });

  it("TIMEOUT: exit 1, envelope code 'align.timeout' on stderr", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 NEXT=CODEX\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CLAUDE",
        "--interval",
        "1",
        "--timeout",
        "2",
        "--json",
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      const parsed = JSON.parse(r.stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("align.timeout");
      expect(parsed.error.message).toMatch(/CLAUDE/);
    });
  });

  it("ERROR: exit 2, envelope code 'align.error' on stderr", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 CODEX=PENDING\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CLAUDE",
        "--timeout",
        "5",
        "--json",
      ]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      const parsed = JSON.parse(r.stderr);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("align.error");
    });
  });
});

describe("yaco align poll — usage", () => {
  it("missing role: USAGE (exit 2)", () => {
    const r = runYaco(["align", "poll", "/tmp/whatever.txt"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("USAGE");
  });

  it("unknown subcommand: USAGE (exit 2)", () => {
    const r = runYaco(["align", "nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });

  it("--help: exit 0, prints align help to stdout", () => {
    const r = runYaco(["align", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco align");
    expect(r.stdout).toContain("poll");
  });

  it("`align poll --help`: raw prose to stdout in text mode", () => {
    const r = runYaco(["align", "poll", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("yaco align poll");
    expect(r.stderr).toBe("");
    // Sanity: not JSON-wrapped.
    expect(r.stdout.startsWith("{")).toBe(false);
  });

  it("`align poll --help --json`: wrapped in {ok:true,data:{help}} envelope", () => {
    const r = runYaco(["align", "poll", "--help", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.help).toBe("string");
    expect(parsed.data.help).toContain("yaco align poll");
  });
});

describe("yaco align poll — legacy regex parity (parse like `grep -oE`)", () => {
  it("NEXT=CLAUDE1 polled for role=CLAUDE → YOUR_TURN (greedy [A-Z]+ stops at digit)", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "SEQ=1 NEXT=CLAUDE1\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CLAUDE",
        "--interval",
        "1",
        "--timeout",
        "2",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("YOUR_TURN\n");
    });
  });

  it("NEXT=claude (lowercase) → ERROR (no [A-Z]+ match → unparseable)", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "NEXT=claude\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CODEX",
        "--interval",
        "1",
        "--timeout",
        "2",
      ]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("ERROR\n");
    });
  });

  it("NEXT=OTHER (uppercase, non-matching role) → TIMEOUT (parses but never flips)", () => {
    withTmp((dir) => {
      const file = writeStatus(dir, "NEXT=OTHER\n");
      const r = runYaco([
        "align",
        "poll",
        file,
        "CODEX",
        "--interval",
        "1",
        "--timeout",
        "2",
      ]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("TIMEOUT\n");
    });
  });
});
