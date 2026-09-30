/** Which `tmux new-session` carries the cgroup escape: only the one that starts
 *  the tmux server.
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

const { createSession } = await import("../../../src/lib/core/agent/tmux.ts");
const { ESCAPE_UNIT_PREFIX } = await import("../../../src/lib/core/agent/tmux-escape.ts");

const isNewSession = (cmd: string) => cmd.includes("new-session");
const newSessions = () => issued.filter(isNewSession);

let serverRunning = false;

/** systemd-run present; a tmux server exactly when `serverRunning`. */
function world() {
  outcome = (cmd) => {
    if (cmd === "tmux list-sessions" && !serverRunning) {
      throw Object.assign(new Error("no server running"), { status: 1 });
    }
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
    expect(newSessions()[0]).toMatch(/^systemd-run --user --scope --unit=yaco-tmux-server-/);
  });

  it("names a fresh unit per founding, so a scope a stray daemon kept loaded never blocks the next", () => {
    // keychain's ssh-agent, forked from a session's login shell, outlives the
    // server in its cgroup; a reused unit name was then refused by systemd-run
    // ("already loaded") and no session could start until the scope was stopped.
    createSession("first", "cmd", "/p");
    createSession("again", "cmd", "/p");
    const units = newSessions().map(cmd => cmd.match(/--unit=(\S+)/)?.[1]);
    expect(units[0]).toMatch(new RegExp(`^${ESCAPE_UNIT_PREFIX}`));
    expect(units[1]).not.toBe(units[0]);
  });

  it("does not wrap when a server is already running — that server is already escaped", () => {
    serverRunning = true;
    createSession("later", "cmd", "/p");
    expect(newSessions()).toHaveLength(1);
    expect(newSessions()[0]!.startsWith("tmux new-session")).toBe(true);
  });
});
