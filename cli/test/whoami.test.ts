import { describe, expect, it } from "vitest";
import {
  resolveWhoamiMatch,
  type WhoamiProcessInfo,
} from "../src/lib/core/agent/whoami.ts";
import type { SessionState } from "../src/lib/core/agent/model.ts";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    handle: "codex-live",
    provider: "codex",
    sessionPath: "/tmp/project",
    pid: 100,
    sessionId: "codex-session",
    status: "processing",
    createdAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveWhoamiMatch", () => {
  it("resolves the current yaco handle from TMUX_PANE", () => {
    const match = resolveWhoamiMatch({
      env: { TMUX_PANE: "%1" },
      states: [
        makeState({ handle: "claude-live", provider: "claude", sessionId: "claude-session" }),
      ],
      tmuxSessionNameFromPane: () => "claude-live",
    });

    expect(match).toEqual({ handle: "claude-live", source: "tmux-pane" });
  });

  it("falls back to provider session id when TMUX_PANE is unavailable", () => {
    const match = resolveWhoamiMatch({
      env: { CODEX_THREAD_ID: "codex-session" },
      states: [makeState()],
      tmuxSessionNameFromPane: () => null,
    });

    expect(match).toEqual({ handle: "codex-live", source: "session-id" });
  });

  it("supports Claude's official session id environment name", () => {
    const match = resolveWhoamiMatch({
      env: { CLAUDE_CODE_SESSION_ID: "claude-session" },
      states: [
        makeState({ handle: "claude-live", provider: "claude", sessionId: "claude-session" }),
      ],
      tmuxSessionNameFromPane: () => null,
    });

    expect(match).toEqual({ handle: "claude-live", source: "session-id" });
  });

  it("does not rely on unverified Claude session id environment names", () => {
    const match = resolveWhoamiMatch({
      env: { CLAUDE_SESSION_ID: "claude-session" },
      states: [
        makeState({ handle: "claude-live", provider: "claude", sessionId: "claude-session" }),
      ],
      tmuxSessionNameFromPane: () => null,
    });

    expect(match).toBeNull();
  });

  it("falls back to the nearest ancestor agent pid", () => {
    const processes: WhoamiProcessInfo[] = [
      { pid: 10, ppid: 1 },
      { pid: 100, ppid: 10 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ];

    const match = resolveWhoamiMatch({
      env: {},
      currentPid: 300,
      processes,
      states: [
        makeState({ handle: "outer", pid: 10 }),
        makeState({ handle: "nearest-agent", pid: 100 }),
      ],
      tmuxSessionNameFromPane: () => null,
    });

    expect(match).toEqual({ handle: "nearest-agent", source: "ancestor-pid" });
  });

  it("returns null when the current process cannot be tied to yaco state", () => {
    const match = resolveWhoamiMatch({
      env: { TMUX_PANE: "%1", CODEX_THREAD_ID: "missing" },
      currentPid: 300,
      processes: [{ pid: 300, ppid: 1 }],
      states: [makeState()],
      tmuxSessionNameFromPane: () => "not-yaco-managed",
    });

    expect(match).toBeNull();
  });
});
