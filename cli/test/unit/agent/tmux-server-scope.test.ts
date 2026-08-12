/** The cgroup escape has exactly one destination, because tmux has exactly one
 *  server: every session is forked BY that server and lands in its cgroup, no
 *  matter what scope its own client was launched into. Wrapping every
 *  `new-session` in `systemd-run --user --scope` therefore did not give each
 *  session a scope — it named the one shared cgroup after whichever session
 *  happened to start the server, and billed all of them to that session.
 *
 *  Observed on the desktop: one anonymous `run-p1584948-i18351714.scope` held the
 *  tmux server plus the wrapper and provider processes of ten separate agent
 *  sessions, 34 processes in total.
 *
 *  So the escape names a fixed unit and is applied only to the invocation that
 *  starts the server. A machine with no `systemd-run` takes neither path and its
 *  command line must not move a byte — that is what `newSessionCommand` pins.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CGROUP_ESCAPE_PREFIX,
  needsCgroupEscape,
  newSessionCommand,
} from "../../../src/lib/core/agent/tmux.ts";

describe("needsCgroupEscape — the environment probe's decision", () => {
  it("wraps only for a managed .service leaf that is not the user manager", () => {
    // Spawned by a unit that `systemctl --user restart` would take tmux down with.
    expect(needsCgroupEscape("yaco-server.service")).toBe(true);
    expect(needsCgroupEscape("workflow-server.service")).toBe(true);

    // The user manager itself: direct membership means a top-level user process.
    expect(needsCgroupEscape("user@1000.service")).toBe(false);
    expect(needsCgroupEscape("user@0.service")).toBe(false);

    // Already outside a restartable service — nothing to escape.
    expect(needsCgroupEscape("run-p1584948-i18351714.scope")).toBe(false);
    expect(needsCgroupEscape("yaco-tmux-server.scope")).toBe(false);
    expect(needsCgroupEscape("app.slice")).toBe(false);

    // No cgroup line to read (non-cgroup-v2 host, unreadable /proc).
    expect(needsCgroupEscape(undefined)).toBe(false);
    expect(needsCgroupEscape("")).toBe(false);
  });
});

describe("CGROUP_ESCAPE_PREFIX — the scope belongs to the server, not to a session", () => {
  it("names one fixed unit instead of systemd-run's per-invocation scope", () => {
    expect(CGROUP_ESCAPE_PREFIX).toBe(
      "systemd-run --user --scope --unit=yaco-tmux-server --collect --quiet " +
        `--description="yaco tmux server (hosts every agent session)" `,
    );
  });

  it("describes the server, so the journal's resource line names no session", () => {
    // systemd defaults a transient unit's Description to the command line it was
    // given — which is the first session's, and it is the string that shows up in
    // `Started …` and in the `Consumed … CPU time` line printed when it stops.
    expect(CGROUP_ESCAPE_PREFIX).toContain("--description=");
  });

  it("is a singleton, so a second session cannot create a second scope", () => {
    // Without --unit, systemd-run mints `run-p<pid>-i<id>.scope` per invocation:
    // a fresh unit name every time, each one claiming to be that session's.
    expect(CGROUP_ESCAPE_PREFIX).toContain("--unit=");
  });
});

describe("newSessionCommand — the un-escaped command line is unchanged", () => {
  const saved = { home: process.env["YACO_HOME"], path: process.env["YACO_PATH"] };

  beforeEach(() => {
    process.env["YACO_PATH"] = "/opt/bin/yaco";
  });
  afterEach(() => {
    for (const [key, value] of [["YACO_HOME", saved.home], ["YACO_PATH", saved.path]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is byte-identical to the command a machine without systemd-run has always run", () => {
    delete process.env["YACO_HOME"];
    expect(newSessionCommand("w-tmux-scope", "bash wrapper.sh", "/home/u/proj")).toBe(
      `tmux new-session -d -s "w-tmux-scope" -c "/home/u/proj" ` +
        `-e "YACO_BIN=/opt/bin/yaco" -x 333 -y 100 bash wrapper.sh`,
    );
  });

  it("forwards an explicit YACO_HOME ahead of YACO_BIN", () => {
    process.env["YACO_HOME"] = "/tmp/home";
    expect(newSessionCommand("h", "cmd", "/p")).toBe(
      `tmux new-session -d -s "h" -c "/p" -e "YACO_HOME=/tmp/home" ` +
        `-e "YACO_BIN=/opt/bin/yaco" -x 333 -y 100 cmd`,
    );
  });

  it("carries no escape prefix of its own — the caller decides", () => {
    expect(newSessionCommand("h", "cmd", "/p").startsWith("tmux ")).toBe(true);
  });
});
