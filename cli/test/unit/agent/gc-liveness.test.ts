/** Socket-safe GC: a `yaco agent list` running on the wrong tmux socket sees
 *  every live session as "dead" via `tmux has-session`. Deleting state files on
 *  that signal alone wipes all of the user's live sessions. The PID guard makes
 *  deletion socket-independent: a session whose process is alive is never GC'd.
 *
 *  Regression: 31 live agent sessions vanished from `yaco agent list` + the web
 *  when the app server's 60s reconciler ran `list` against the wrong socket. */
import { describe, it, expect } from "vitest";
import { isProcessAlive } from "../../../src/lib/core/agent/tmux.ts";
import { confirmedDead } from "../../../src/commands/agent/status.ts";

// A PID that is virtually certain not to exist (above the typical pid_max).
const DEAD_PID = 2_000_000_000;

describe("isProcessAlive — socket-independent liveness", () => {
  it("is true for the running test process and false for absent/invalid pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(undefined)).toBe(false);
    expect(isProcessAlive(null)).toBe(false);
  });
});

describe("confirmedDead — only GC a session when tmux AND the process agree it is gone", () => {
  it("never deletes when the recorded process is still alive (wrong-socket protection)", () => {
    // tmux on the wrong socket reports `false` for a session that is actually
    // alive — the live PID must veto deletion.
    expect(confirmedDead(false, process.pid)).toBe(false);
  });

  it("deletes only when tmux says gone AND the process is truly dead", () => {
    expect(confirmedDead(false, DEAD_PID)).toBe(true);
    expect(confirmedDead(false, 0)).toBe(true);
    expect(confirmedDead(false, undefined)).toBe(true);
  });

  it("never deletes on an uncertain or alive tmux result, regardless of pid", () => {
    expect(confirmedDead(null, DEAD_PID)).toBe(false); // timeout / tmux unavailable
    expect(confirmedDead(null, process.pid)).toBe(false);
    expect(confirmedDead(true, DEAD_PID)).toBe(false);
    expect(confirmedDead(true, process.pid)).toBe(false);
  });
});
