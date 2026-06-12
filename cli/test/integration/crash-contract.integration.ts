/** T1 crash contract — real-tmux integration (provider-free).
 *
 *  Runs a fake "agent" (a plain shell command) through the REAL wrapper script
 *  in a real tmux session, with YACO_BIN pointed at a shim that runs THIS
 *  worktree's CLI — so `yaco agent mark-crashed` is the code under test. Covers
 *  the end-to-end paths the unit tests can only approximate: a real non-zero
 *  exit tombstones, a real `kill` (SIGTERM) clean-deletes via the sentinel, and
 *  a crashed tombstone survives `list --reconcile`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createSession, hasSession, isTmuxAvailable } from "../../src/lib/core/agent/tmux.ts";
import { writeState, readState, ensureStateDir, type SessionState } from "../../src/lib/core/agent/session-state.ts";
import { kill } from "../../src/commands/agent/kill.ts";
import { list } from "../../src/commands/agent/status.ts";

const itt = isTmuxAvailable() ? it.serial : it.skip;

const WRAPPER = resolve(import.meta.dir, "../../scripts/agent-wrapper.sh");
const MAIN_TS = resolve(import.meta.dir, "../../src/main.ts");
const TEST_CWD = "/tmp/yaco-crash-int";
const PREFIX = `crash-int-${process.pid}`;
const CREATED_AT = "2026-04-10T00:00:00.000Z";
const DEAD_PID = 2_000_000_000;

let sandbox: string;
let shim: string;
let crashScript: string;
let sleepScript: string;
let savedHome: string | undefined;
let savedYacoPath: string | undefined;
let savedCwd: string;
const handles: string[] = [];

function uniq(name: string): string {
  const h = `${PREFIX}-${name}`;
  handles.push(h);
  return h;
}

function makeState(handle: string, o: Partial<SessionState> = {}): SessionState {
  return {
    handle, provider: "claude", sessionPath: TEST_CWD, pid: 0,
    sessionId: "", status: "processing", createdAt: CREATED_AT, ...o,
  };
}

/** Build the real wrapped invocation. createSession injects YACO_HOME + YACO_BIN
 *  via tmux -e (from process.env.YACO_HOME / YACO_PATH), so the command itself
 *  starts with `bash` — exactly the production shape from buildWrappedCommand. */
function wrapped(handle: string, cmd: string): string {
  return `bash "${WRAPPER}" "${handle}" "${CREATED_AT}" ${cmd}`;
}

function waitFor(pred: () => boolean, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    execSync("sleep 0.2");
  }
  return pred();
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-crash-int-"));
  savedHome = process.env["YACO_HOME"];
  process.env["YACO_HOME"] = sandbox;
  ensureStateDir();
  shim = join(sandbox, "yaco-shim");
  writeFileSync(shim, `#!/bin/bash\nexec bun "${MAIN_TS}" "$@"\n`, { mode: 0o755 });
  // createSession resolves YACO_BIN from YACO_PATH → point it at the shim so the
  // wrapper's crash path runs THIS worktree's `agent mark-crashed`.
  savedYacoPath = process.env["YACO_PATH"];
  process.env["YACO_PATH"] = shim;
  // Fake agents as script files — avoids nested-quote breakage when the command
  // is interpolated into tmux new-session.
  crashScript = join(sandbox, "crash.sh");
  writeFileSync(crashScript, "#!/bin/bash\nsleep 0.4\nexit 139\n", { mode: 0o755 });
  sleepScript = join(sandbox, "sleep.sh");
  writeFileSync(sleepScript, "#!/bin/bash\nexec sleep 30\n", { mode: 0o755 });
  execSync(`mkdir -p ${TEST_CWD}`);
  savedCwd = process.cwd();
  process.chdir(TEST_CWD);
});

afterAll(() => {
  for (const h of handles) {
    try { kill(h); } catch { /* best effort */ }
  }
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env["YACO_HOME"];
  else process.env["YACO_HOME"] = savedHome;
  if (savedYacoPath === undefined) delete process.env["YACO_PATH"];
  else process.env["YACO_PATH"] = savedYacoPath;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("crash contract (real tmux)", () => {
  itt("a non-zero agent exit tombstones to crashed + exitCode via the real wrapper", () => {
    const h = uniq("crash");
    writeState(makeState(h));
    createSession(h, wrapped(h, `bash ${crashScript}`), TEST_CWD);

    expect(waitFor(() => !hasSession(h), 12000)).toBe(true);
    execSync("sleep 0.6"); // let the EXIT trap finish writing

    const s = readState(h);
    expect(s).not.toBeNull();
    expect(s!.status).toBe("crashed");
    expect(s!.exitCode).toBe(139);
    expect(typeof s!.statusEnteredAt).toBe("string");
  });

  itt("yaco agent kill (SIGTERM) clean-deletes — never a crash tombstone", () => {
    const h = uniq("kill");
    writeState(makeState(h));
    createSession(h, wrapped(h, `bash ${sleepScript}`), TEST_CWD);
    expect(waitFor(() => hasSession(h), 6000)).toBe(true);

    kill(h);

    expect(waitFor(() => !hasSession(h), 8000)).toBe(true);
    execSync("sleep 0.6");
    // Deleted (intentional kill), NOT left as a crashed tombstone.
    expect(readState(h)).toBeNull();
  });

  itt("list --reconcile preserves a crashed tombstone (dead pid, no tmux session)", () => {
    const h = uniq("recon");
    writeState(makeState(h, { status: "crashed", exitCode: 7, statusEnteredAt: CREATED_AT, pid: DEAD_PID }));

    list({ reconcile: true });

    const s = readState(h);
    expect(s).not.toBeNull();
    expect(s!.status).toBe("crashed");
  });
});
