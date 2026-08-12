/** `agent start` refuses a provider whose executable is not installed.
 *
 *  The refusal has to happen ABOVE everything that creates something: the
 *  state file, the tmux session, the hook install. So the negative tests run
 *  on a `$PATH` that carries neither the provider NOR `tmux` — if the precheck
 *  were misplaced, the thrown error would name tmux instead, and that is the
 *  assertion.
 *
 *  `$PATH` is built from shims rather than by subtracting from the operator's:
 *  one inherited directory that happens to carry a `claude` would make every
 *  assertion here a statement about this machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireProviderExecutable, start } from "../../../../src/commands/agent/start.ts";
import { getProvider } from "../../../../src/lib/core/agent/providers/index.ts";
import { which } from "../../../../src/lib/core/which.ts";
import { CliError, ErrCode } from "../../../../src/lib/core/errors.ts";

let sandbox: string;
let sessionsDir: string;
const ORIG = { PATH: process.env["PATH"], SESSIONS: process.env["YACO_AGENT_SESSIONS_DIR"] };

/** An executable that would succeed if anything ever ran it — nothing here
 *  does; the probe only asks whether `$PATH` resolves the name. */
function makeShim(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

/** A `$PATH` carrying only `which` (the probe spawns it) plus whatever names
 *  the caller asks for. No provider, and no tmux, unless named. */
function pathWith(...commands: string[]): string {
  const bin = mkdtempSync(join(sandbox, "bin-"));
  const whichPath = spawnSync("which", ["which"], { encoding: "utf-8" }).stdout.trim();
  expect(whichPath.length).toBeGreaterThan(0);
  symlinkSync(whichPath, join(bin, "which"));
  for (const c of commands) makeShim(join(bin, c));
  return bin;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-start-precheck-"));
  sessionsDir = join(sandbox, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  process.env["YACO_AGENT_SESSIONS_DIR"] = sessionsDir;
});

afterEach(() => {
  if (ORIG.PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIG.PATH;
  if (ORIG.SESSIONS === undefined) delete process.env["YACO_AGENT_SESSIONS_DIR"];
  else process.env["YACO_AGENT_SESSIONS_DIR"] = ORIG.SESSIONS;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("which", () => {
  it("answers with the absolute path a name resolves to", () => {
    const bin = pathWith("claude");
    process.env["PATH"] = bin;
    expect(which("claude")).toBe(join(bin, "claude"));
  });

  it("answers null for a name $PATH does not carry", () => {
    process.env["PATH"] = pathWith();
    expect(which("claude")).toBeNull();
  });
});

describe("requireProviderExecutable", () => {
  it("passes when the provider executable is on $PATH", () => {
    process.env["PATH"] = pathWith("claude");
    expect(() => requireProviderExecutable(getProvider("claude"))).not.toThrow();
  });

  it("names the missing executable and what to install", () => {
    process.env["PATH"] = pathWith();
    let thrown: unknown;
    try {
      requireProviderExecutable(getProvider("codex"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const e = thrown as CliError;
    // ENV, so the exit code is 3 (environment) rather than 5 (internal).
    expect(e.code).toBe(ErrCode.ENV);
    expect(e.message).toContain("codex not found on $PATH");
    expect(e.message).toContain("Codex CLI");
    expect(e.message).toContain("yaco doctor");
  });
});

describe("start — refusal happens before anything is created", () => {
  it("refuses, names the executable, and writes no session state", () => {
    // No tmux on this $PATH either: reaching createSession would fail with a
    // tmux error instead, which is what makes this an ordering assertion.
    process.env["PATH"] = pathWith();
    expect(() => start("claude", ["hello"])).toThrowError(/^claude not found on \$PATH/);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });

  it("refuses for every registered provider, not just the default", () => {
    process.env["PATH"] = pathWith("claude");
    expect(() => start("codex", ["hello"])).toThrowError(/^codex not found on \$PATH/);
    expect(readdirSync(sessionsDir)).toEqual([]);
  });
});
