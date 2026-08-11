/** Which session does a provider hook belong to?
 *
 *  The provider hook configs are installed globally (`~/.claude/settings.json`,
 *  `~/.codex/hooks.json`), so `yaco agent hook-event` runs for EVERY Claude /
 *  Codex process on the machine — including ones yaco never started and that
 *  are not inside tmux at all. Those invocations carry a foreign `session_id`
 *  and a foreign `transcript_path`, and the handler must recognise that they
 *  belong to no live session and write nothing.
 *
 *  The failure this pins: asking tmux for "the current session" with no target
 *  still yields an answer when the caller is outside tmux — the server's
 *  most-recently-active session, i.e. an arbitrary live agent. Applying a
 *  foreign event there rewrites that agent's `status` and `notice` (a
 *  completion notice attributed to the wrong session) and, on `SessionStart`,
 *  its `sessionId` — which re-points every sessionId-keyed read (`agent
 *  messages`, `output-cursor`, `agent wait`, `send --wait`) at a foreign
 *  provider log.
 *
 *  A `tmux` shim stands in for the server so the resolution is exact and needs
 *  no real one: with `-t <pane>` it answers for that pane, without a target it
 *  answers with the ambient session, exactly as tmux does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runHookEvent } from "../src/lib/core/agent/hook-event.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

/** Three concurrently live agents; the ambient answer is the third. */
const HANDLES = ["victim-a", "victim-b", "victim-c"] as const;
const AMBIENT = "victim-c";
const OWN_PANE = "%42";
const FOREIGN_ID = "foreign-unmanaged-session";
const FOREIGN_FINAL = "SECRET FROM THE UNMANAGED SESSION";

/** A pid no ancestor walk can reach, so the fixtures are identifiable only by
 *  the pane / session-id routes under test. */
const UNREACHABLE_PID = 0x7ffffff0;

let root: string;
let savedEnv: Record<string, string | undefined>;

function statePathOf(handle: string): string {
  return join(root, "sessions", `${handle}.json`);
}

function stateOf(handle: string): SessionState {
  return JSON.parse(readFileSync(statePathOf(handle), "utf-8")) as SessionState;
}

function setFixtureStatus(handle: string, status: SessionState["status"]): void {
  writeFileSync(statePathOf(handle), JSON.stringify({ ...stateOf(handle), status }));
}

/** tmux, reduced to the two answers this path depends on. `display-message -t
 *  <pane>` resolves that pane's session; with no target it resolves the
 *  ambient one — which is what a caller outside tmux gets. */
function writeTmuxShim(dir: string): void {
  const path = join(dir, "tmux");
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      'if [ "$1" = "has-session" ]; then exit 0; fi',
      'if [ "$1" != "display-message" ]; then exit 0; fi',
      'pane=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-t" ]; then pane="$a"; fi; prev="$a"; done',
      `if [ "$pane" = "${OWN_PANE}" ]; then echo "${HANDLES[1]}"; exit 0; fi`,
      'if [ -n "$pane" ]; then exit 1; fi',
      `echo "${AMBIENT}"`,
    ].join("\n") + "\n",
  );
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yaco-hook-identity-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "sessions"));
  writeTmuxShim(bin);

  for (const handle of HANDLES) {
    writeFileSync(
      join(root, "sessions", `${handle}.json`),
      JSON.stringify({
        handle,
        provider: "claude",
        sessionPath: root,
        pid: UNREACHABLE_PID,
        sessionId: `own-${handle}`,
        status: "processing",
        createdAt: "2026-08-11T00:00:00.000Z",
        statusEnteredAt: "2026-08-11T00:00:00.000Z",
      } satisfies SessionState),
    );
  }

  const transcript = join(root, "foreign.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: { stop_reason: "end_turn", content: [{ type: "text", text: FOREIGN_FINAL }] },
    }) + "\n",
  );

  savedEnv = {
    PATH: process.env["PATH"],
    TMUX: process.env["TMUX"],
    TMUX_PANE: process.env["TMUX_PANE"],
    YACO_AGENT_SESSIONS_DIR: process.env["YACO_AGENT_SESSIONS_DIR"],
  };
  process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  process.env["YACO_AGENT_SESSIONS_DIR"] = join(root, "sessions");
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const foreignStop = () =>
  runHookEvent("Stop", { session_id: FOREIGN_ID, transcript_path: join(root, "foreign.jsonl") });

describe("hook-event session identity", () => {
  it("ignores a Stop from a provider process that is not a live agent", async () => {
    await foreignStop();

    for (const handle of HANDLES) {
      const state = stateOf(handle);
      expect(state.status).toBe("processing");
      expect(state.notice).toBeUndefined();
    }
  });

  it("ignores a SessionStart from a provider process that is not a live agent", async () => {
    // SessionStart rewrites `sessionId` unconditionally, but only on a session
    // that is not mid-turn — so an idle agent is the one a foreign SessionStart
    // can re-point at a foreign provider log.
    for (const handle of HANDLES) setFixtureStatus(handle, "idle");

    await runHookEvent("SessionStart", { session_id: FOREIGN_ID });

    for (const handle of HANDLES) {
      expect(stateOf(handle).sessionId).toBe(`own-${handle}`);
    }
  });

  it("applies a Stop to the session that owns the calling pane", async () => {
    process.env["TMUX_PANE"] = OWN_PANE;
    await foreignStop();

    expect(stateOf(HANDLES[1]).status).toBe("idle");
    expect(stateOf(HANDLES[1]).notice).toBe(FOREIGN_FINAL);
    expect(stateOf(HANDLES[0]).status).toBe("processing");
    expect(stateOf(HANDLES[2]).status).toBe("processing");
  });

  it("ignores a hook whose pane belongs to no live agent", async () => {
    process.env["TMUX_PANE"] = "%99";
    await foreignStop();

    for (const handle of HANDLES) {
      expect(stateOf(handle).status).toBe("processing");
    }
  });
});
