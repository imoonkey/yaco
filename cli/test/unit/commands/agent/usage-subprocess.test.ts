/** `yaco agent usage codex` subprocess lifecycle.
 *
 *  The Codex probe spawns `codex app-server` and talks JSON-RPC to it, which is
 *  the one part of this command with real process-level failure modes. These
 *  tests put a fake `codex` at the front of $PATH so each mode is reproducible
 *  without the real binary, an account, or a network.
 *
 *  Not covered here: the 20s read timeout and its SIGTERM→SIGKILL escalation.
 *  Reproducing it costs 22s of wall clock, too slow for the unit suite; it is
 *  exercised by hand against a TERM-ignoring child (verified: the command exits
 *  in ~22s leaving no child process and no zombie).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../../../src/main.ts");
const TMP: string[] = [];
afterAll(() => {
  for (const dir of TMP) rmSync(dir, { recursive: true, force: true });
});

/** A temp home plus a `codex` on PATH running `script`. */
function fakeCodex(script: string): { env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "yaco-usage-proc-"));
  TMP.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "codex");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: root,
      YACO_HOME: join(root, ".yaco"),
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    } as Record<string, string>,
  };
}

function runUsage(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
} {
  const started = Date.now();
  const r = spawnSync("bun", ["run", BIN, "agent", "usage", "codex", "--json"], {
    encoding: "utf-8",
    env,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ms: Date.now() - started,
  };
}

describe("codex app-server failures", () => {
  it("reports a child that dies as an exit, not as a timeout, and quotes its stderr", () => {
    const { env } = fakeCodex('#!/bin/sh\necho "boom: config parse error" >&2\nexit 1\n');
    const { status, stderr, ms } = runUsage(env);
    expect(status).not.toBe(0);
    // Whether the write or the read notices first is a race against how fast
    // the child dies; both name a dead child and both quote its stderr.
    expect(stderr).toMatch(/exited before reporting quota|closed its input/);
    expect(stderr).toContain("boom: config parse error");
    // The distinction matters because the timeout branch would claim it waited
    // 20 seconds; a wrong diagnosis here sends the user to the wrong fix.
    expect(stderr).not.toContain("did not report quota within");
    expect(ms).toBeLessThan(15_000);
  });

  it("bounds a flood of child stderr instead of buffering all of it", () => {
    // 16 MiB on stderr: retained in full this would be materialized just to
    // quote the last line.
    const { env } = fakeCodex('#!/bin/sh\nhead -c 16777216 /dev/zero | tr "\\0" "x" >&2\nexit 1\n');
    const { status, stderr } = runUsage(env);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/exited before reporting quota|closed its input/);
    // The whole envelope stays small — the tail is quoted, not the flood.
    expect(stderr.length).toBeLessThan(20_000);
  });

  it("surfaces a JSON-RPC error from the app-server as an ENV failure", () => {
    const { env } = fakeCodex(
      '#!/bin/sh\n' +
        'read -r _line\n' +
        'echo \'{"id":1,"result":{}}\'\n' +
        'echo \'{"id":2,"error":{"message":"account authentication required"}}\'\n' +
        'cat > /dev/null\n',
    );
    const { status, stderr } = runUsage(env);
    expect(status).not.toBe(0);
    expect(stderr).toContain("codex rejected the quota request");
    expect(stderr).toContain("account authentication required");
  });

  it("reports a missing codex binary as an environment failure", () => {
    const root = mkdtempSync(join(tmpdir(), "yaco-usage-nocodex-"));
    TMP.push(root);
    const r = spawnSync("bun", ["run", BIN, "agent", "usage", "codex", "--json"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NO_COLOR: "1",
        HOME: root,
        YACO_HOME: join(root, ".yaco"),
        // Only `codex` is missing — bun's own directory stays on PATH.
        PATH: dirname(process.execPath),
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ENV");
  });

  it("leaves no child process behind after a failed probe", () => {
    const { env } = fakeCodex('#!/bin/sh\necho "dying" >&2\nexit 3\n');
    runUsage(env);
    // The fake lives under a unique temp root, so any survivor is ours.
    const survivors = spawnSync("pgrep", ["-f", env["HOME"] ?? "///"], { encoding: "utf-8" });
    expect((survivors.stdout ?? "").trim()).toBe("");
  });
});
