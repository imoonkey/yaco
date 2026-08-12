/** T1 crash contract — real-tmux integration (provider-free).
 *
 *  Runs a fake "agent" (a plain shell command) through the REAL wrapper script
 *  in a real tmux session, with YACO_BIN pointed at a shim that runs THIS
 *  worktree's CLI — so `yaco agent mark-crashed` is the code under test. Covers
 *  the end-to-end paths the unit tests can only approximate: a real non-zero
 *  exit tombstones, a real `kill` (SIGTERM) clean-deletes via the sentinel, and
 *  a crashed tombstone survives `list --reconcile`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createSession, hasSession, isTmuxAvailable } from "../../src/lib/core/agent/tmux.ts";
import {
  writeState,
  readState,
  ensureStateDir,
  exitReportPath,
  readExitReport,
  type SessionState,
} from "../../src/lib/core/agent/session-state.ts";
import { kill } from "../../src/commands/agent/kill.ts";
import { list } from "../../src/commands/agent/status.ts";
import { CLI_ENTRY } from "../helpers/cli-process.ts";

const itt = isTmuxAvailable() ? it.sequential : it.skip;

const WRAPPER = resolve(import.meta.dirname, "../../scripts/agent-wrapper.sh");

const TEST_CWD = "/tmp/yaco-crash-int";
const PREFIX = `crash-int-${process.pid}`;
const CREATED_AT = "2026-04-10T00:00:00.000Z";
const DEAD_PID = 2_000_000_000;

let sandbox: string;
let shim: string;
let crashScript: string;
let rejectScript: string;
let burstScript: string;
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
  writeFileSync(shim, `#!/bin/bash\nexec "${process.execPath}" "${CLI_ENTRY}" "$@"\n`, { mode: 0o755 });
  // createSession resolves YACO_BIN from YACO_PATH → point it at the shim so the
  // wrapper's crash path runs THIS worktree's `agent mark-crashed`.
  savedYacoPath = process.env["YACO_PATH"];
  process.env["YACO_PATH"] = shim;
  // Fake agents as script files — avoids nested-quote breakage when the command
  // is interpolated into tmux new-session.
  crashScript = join(sandbox, "crash.sh");
  writeFileSync(crashScript, "#!/bin/bash\nsleep 0.4\nexit 139\n", { mode: 0o755 });
  // A provider that rejects an argument and exits — the shape of `yaco claude
  // --nmae foo`, where the forwarded token is the provider's to complain about.
  rejectScript = join(sandbox, "reject.sh");
  writeFileSync(
    rejectScript,
    "#!/bin/bash\necho \"fake-provider: error: unknown option '--nmae'\" >&2\nexit 2\n",
    { mode: 0o755 },
  );
  burstScript = join(sandbox, "burst.sh");
  writeFileSync(
    burstScript,
    // ~250KB, which tmux cannot ingest in one read callback — so the tail of it
    // is still pending on the pty when the process exits. Without an ordering
    // barrier the capture lands mid-stream and the last line is not there yet.
    "#!/bin/bash\nfor i in $(seq 1 4000); do " +
      "echo \"noise line $i ----------------------------------------\"; done\n" +
      "echo 'LAST-LINE-BEFORE-EXIT' >&2\nexit 3\n",
    { mode: 0o755 },
  );
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

  itt("an agent that rejects an argument leaves its own message behind, not just an exit code", () => {
    // The defect this covers: yaco forwards every unbound token to the provider
    // by design, so a mistyped flag is the PROVIDER's complaint — and it used
    // to be written to a pane tmux destroyed before anyone could read it. The
    // wrapper salvages it from inside the pane while the pane still exists.
    const h = uniq("reject");
    writeState(makeState(h));
    createSession(h, wrapped(h, `bash ${rejectScript}`), TEST_CWD);

    expect(waitFor(() => !hasSession(h), 12000)).toBe(true);
    execSync("sleep 0.6"); // let the EXIT trap finish writing

    const report = readExitReport(h, CREATED_AT);
    expect(report).not.toBeNull();
    expect(report!.exitCode).toBe(2);
    expect(report!.output).toContain("unknown option '--nmae'");
  });

  itt("the last bytes written before the exit are in the report, not lost to the pane read", () => {
    // ~250KB then an immediate exit: the screen has scrolled far past where the
    // burst began, and the bytes most at risk are the last ones written.
    //
    // Honest scope: this asserts the OUTCOME, and it does not by itself prove
    // the barrier in `write_exit_report` is what produces it — a wrapper with a
    // single unsynchronized capture also passes it, here, today. The barrier is
    // justified by construction (capture-pane reads the screen; the screen is
    // filled by an asynchronous read of the pty), not by this test failing
    // without it. What this test does catch is a regression that loses the tail
    // for any reason at all, including the marker leaking into the report.
    const h = uniq("tail");
    writeState(makeState(h));
    createSession(h, wrapped(h, `bash ${burstScript}`), TEST_CWD);

    expect(waitFor(() => !hasSession(h), 12000)).toBe(true);
    execSync("sleep 0.6");

    const report = readExitReport(h, CREATED_AT);
    expect(report).not.toBeNull();
    expect(report!.exitCode).toBe(3);
    expect(report!.output).toContain("LAST-LINE-BEFORE-EXIT");
    // The marker is the barrier, not content — it must never reach the reader.
    expect(report!.output).not.toContain("yaco-exit-marker");
  });

  itt("an intentional kill leaves no exit report — there is no error to explain", () => {
    const h = uniq("kill-noreport");
    writeState(makeState(h));
    createSession(h, wrapped(h, `bash ${sleepScript}`), TEST_CWD);
    expect(waitFor(() => hasSession(h), 6000)).toBe(true);

    kill(h);

    expect(waitFor(() => !hasSession(h), 8000)).toBe(true);
    execSync("sleep 0.6");
    expect(existsSync(exitReportPath(h))).toBe(false);
  });

  itt("list --reconcile preserves a crashed tombstone (dead pid, no tmux session)", async () => {
    const h = uniq("recon");
    writeState(makeState(h, { status: "crashed", exitCode: 7, statusEnteredAt: CREATED_AT, pid: DEAD_PID }));

    await list({ reconcile: true });

    const s = readState(h);
    expect(s).not.toBeNull();
    expect(s!.status).toBe("crashed");
  });
});
