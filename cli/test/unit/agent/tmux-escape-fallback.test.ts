/** Which `tmux new-session` carries the cgroup escape, and what happens when the
 *  singleton scope unit is already taken.
 *
 *  `/orchestrate` starts a fleet of sessions at once. They all probe an empty
 *  socket, all decide they are the one starting the server, and all reach for the
 *  same `--unit=yaco-tmux-server`. Exactly one can have it; the rest must still
 *  get their session, joining the server the winner escaped. What they must NOT
 *  do is retry a `new-session` that already succeeded.
 *
 *  child_process is mocked so the decisions are observable without a tmux server:
 *  these assertions are about which command line is issued, not about tmux.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CGROUP_LINE =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/yaco-server.service\n";

/** Commands issued via execSync, in order. */
let issued: string[] = [];
/** Per-command outcome; throwing stands in for a non-zero exit. */
let outcome: (cmd: string) => void = () => {};

vi.mock("child_process", () => ({
  execSync: (cmd: string) => {
    issued.push(cmd);
    outcome(cmd);
    return "";
  },
  execFileSync: () => "",
  spawn: () => ({ on: () => {}, unref: () => {} }),
}));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    readFileSync: (path: unknown, ...rest: unknown[]) =>
      path === "/proc/self/cgroup"
        ? CGROUP_LINE
        : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest),
  };
});

// The escape is Linux-only by construction; pin the platform so the file asserts
// the same thing on the maintainer's macOS laptop as on the Linux desktop.
Object.defineProperty(process, "platform", { value: "linux" });
process.env["YACO_PATH"] = "/opt/bin/yaco";
delete process.env["YACO_HOME"];

const { createSession, CGROUP_ESCAPE_PREFIX, JOIN_EXISTING_SERVER } = await import(
  "../../../src/lib/core/agent/tmux.ts"
);

// Matches both forms the code can issue: `tmux new-session` and the join-only
// `tmux -N new-session` of the fallback.
const isNewSession = (cmd: string) => cmd.includes("new-session");
const newSessions = () => issued.filter(isNewSession);

/** Is a tmux server up? Mutable, so a test can have one appear mid-call the way
 *  a concurrent starter makes one appear. */
let serverRunning = false;

/** tmux's own exit-1 "no such session", which is the only answer that confirms
 *  absence. Anything without a status (a timeout, a signal) is indeterminate. */
function exitOne(message: string): Error {
  return Object.assign(new Error(message), { status: 1 });
}

/** Default world: systemd-run present, no tmux server, handle confirmed absent. */
function world(
  over: {
    session?: "absent" | "present" | "indeterminate";
    newSession?: () => void;
  } = {},
) {
  outcome = (cmd) => {
    if (cmd === "which systemd-run") return;
    if (cmd === "tmux list-sessions" && !serverRunning) throw exitOne("no server running");
    if (cmd.includes("has-session")) {
      if (over.session === "present") return;
      if (over.session === "indeterminate") throw new Error("ETIMEDOUT");
      throw exitOne("can't find session");
    }
    if (isNewSession(cmd)) over.newSession?.();
  };
}

beforeEach(() => {
  issued = [];
  serverRunning = false;
  world();
});

describe("the escape goes on the invocation that starts the tmux server", () => {
  it("wraps the first session, when no server is running yet", () => {
    createSession("first", "cmd", "/p");
    expect(newSessions()).toHaveLength(1);
    expect(newSessions()[0]).toContain(CGROUP_ESCAPE_PREFIX);
  });

  it("does not wrap when a server is already running — that server is already escaped", () => {
    serverRunning = true;
    createSession("later", "cmd", "/p");
    expect(newSessions()).toHaveLength(1);
    expect(newSessions()[0]!.startsWith("tmux new-session")).toBe(true);
  });
});

describe("losing the race for the singleton scope unit", () => {
  it("retries unwrapped, so the session is still created", () => {
    let attempt = 0;
    world({
      newSession: () => {
        // systemd-run refuses a unit name that a concurrent start already took —
        // and the start that took it has the server up by the time we look.
        if (++attempt === 1) {
          serverRunning = true;
          throw new Error("Unit yaco-tmux-server.scope was already loaded");
        }
      },
    });

    createSession("loser", "cmd", "/p");

    expect(newSessions()).toHaveLength(2);
    expect(newSessions()[0]).toContain(CGROUP_ESCAPE_PREFIX);
    // The retry cannot start a server, only join the rival's escaped one: if
    // that server went away in between, this must fail rather than found an
    // unescaped replacement inside the service.
    expect(newSessions()[1]!.startsWith(`tmux ${JOIN_EXISTING_SERVER}new-session`)).toBe(true);
  });

  it("does not retry a new-session that already created the session", () => {
    // The 5s exec timeout elapsing after tmux forked: the command failed, the
    // session exists. Retrying would only fail again on the duplicate name.
    world({
      session: "present",
      newSession: () => {
        throw new Error("ETIMEDOUT");
      },
    });

    expect(() => createSession("timed-out", "cmd", "/p")).toThrow("ETIMEDOUT");
    expect(newSessions()).toHaveLength(1);
  });

  it("does not retry when the session probe could not answer", () => {
    // A probe that timed out has not confirmed the session absent, and a retry
    // on that basis would be a guess about whether tmux forked.
    world({
      session: "indeterminate",
      newSession: () => {
        throw new Error("Unit yaco-tmux-server.scope was already loaded");
      },
    });

    expect(() => createSession("unknown", "cmd", "/p")).toThrow("already loaded");
    expect(newSessions()).toHaveLength(1);
  });

  it("does not quietly drop the escape when no rival server appeared", () => {
    // No user bus, systemd-run refusing an option: the escape failed on its own
    // account and no other start escaped a server on our behalf. Retrying here
    // would found the tmux server inside the restartable service and say nothing
    // — the exact silent forfeit the escape exists to prevent.
    world({
      newSession: () => {
        throw new Error("Failed to connect to bus");
      },
    });

    expect(() => createSession("no-bus", "cmd", "/p")).toThrow("Failed to connect to bus");
    expect(newSessions()).toHaveLength(1);
  });

  it("surfaces the fallback's own failure when the retry also fails", () => {
    let attempt = 0;
    world({
      newSession: () => {
        if (++attempt === 1) {
          serverRunning = true;
          throw new Error("Unit yaco-tmux-server.scope was already loaded");
        }
        // The rival's server went away before the join could land.
        throw new Error("no server running");
      },
    });

    expect(() => createSession("loser-then-gone", "cmd", "/p")).toThrow("no server running");
    expect(newSessions()).toHaveLength(2);
  });

  it("makes one attempt only when a server was up from the outset", () => {
    serverRunning = true;
    world({
      newSession: () => {
        throw new Error("no such directory");
      },
    });

    expect(() => createSession("bad-cwd", "cmd", "/nope")).toThrow("no such directory");
    expect(newSessions()).toHaveLength(1);
  });
});
