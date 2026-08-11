/** Tests for the path encoder used by `yaco project move`. */

import { describe, expect, it } from "vitest";

import { encodeClaudeCwd } from "../../../../src/lib/core/project/encode.ts";

describe("encodeClaudeCwd", () => {
  it("replaces each '/' with '-'", () => {
    expect(encodeClaudeCwd("/a/b/c")).toBe("-a-b-c");
  });

  it("replaces each '.' with '-' (so hidden segments collapse)", () => {
    expect(encodeClaudeCwd("/x/.worktrees/y")).toBe("-x--worktrees-y");
  });

  it("preserves existing hyphens", () => {
    expect(encodeClaudeCwd("/home/ld-workspace")).toBe("-home-ld-workspace");
  });

  it("matches the real layout observed under ~/.claude/projects/", () => {
    // Sample from desktop (cli/CLAUDE.md context):
    //   /home/user/ld-workspace/yaco -> -home-user-ld-workspace-yaco
    expect(encodeClaudeCwd("/home/user/ld-workspace/yaco")).toBe(
      "-home-user-ld-workspace-yaco",
    );
    //   /home/user/ld-workspace/yaco/.worktrees/remote-perf-compress
    //     -> -home-user-ld-workspace-yaco--worktrees-remote-perf-compress
    expect(
      encodeClaudeCwd("/home/user/ld-workspace/yaco/.worktrees/remote-perf-compress"),
    ).toBe("-home-user-ld-workspace-yaco--worktrees-remote-perf-compress");
  });

  it("collapses other non-alphanumerics (whitespace, underscores)", () => {
    expect(encodeClaudeCwd("/p_a/b c")).toBe("-p-a-b-c");
  });
});
