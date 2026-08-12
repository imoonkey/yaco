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

const { createSession, CGROUP_ESCAPE_PREFIX } = await import(
  "../../../src/lib/core/agent/tmux.ts"
);

const isNewSession = (cmd: string) => cmd.includes("tmux new-session");
const newSessions = () => issued.filter(isNewSession);

/** Is a tmux server up? Mutable, so a test can have one appear mid-call the way
 *  a concurrent starter makes one appear. */
let serverRunning = false;

/** Default world: systemd-run present, no tmux server, handle not taken. */
function world(over: { hasSession?: boolean; newSession?: () => void } = {}) {
  outcome = (cmd) => {
    if (cmd === "which systemd-run") return;
    if (cmd === "tmux list-sessions" && !serverRunning) throw new Error("no server running");
    if (cmd.includes("has-session") && !over.hasSession) throw new Error("no such session");
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
    expect(newSessions()[1]!.startsWith("tmux new-session")).toBe(true);
    // Same command either way — the escape is the only difference.
    expect(newSessions()[0]).toBe(CGROUP_ESCAPE_PREFIX + newSessions()[1]);
  });

  it("does not retry a new-session that already created the session", () => {
    // The 5s exec timeout elapsing after tmux forked: the command failed, the
    // session exists. Retrying would only fail again on the duplicate name.
    world({
      hasSession: true,
      newSession: () => {
        throw new Error("ETIMEDOUT");
      },
    });

    expect(() => createSession("timed-out", "cmd", "/p")).toThrow("ETIMEDOUT");
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

  it("surfaces a genuine failure after the one retry", () => {
    serverRunning = true;
    world({
      newSession: () => {
        throw new Error("no such directory");
      },
    });

    // A server is up, so this start is unwrapped from the outset: one attempt.
    expect(() => createSession("bad-cwd", "cmd", "/nope")).toThrow("no such directory");
    expect(newSessions()).toHaveLength(1);
  });
});
