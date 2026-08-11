import { describe, it, expect } from "vitest";
import {
  getProvider,
  listProviders,
  listProviderIds,
  hasProvider,
} from "../src/lib/core/agent/providers/index.ts";
import { isIdle } from "../src/lib/core/agent/providers/idle.ts";
import { isInputEmpty } from "../src/lib/core/agent/providers/idle.ts";
import { PROVIDERS, getProvider as getLegacyProvider } from "../src/lib/core/agent/providers.ts";
import { PENDING_SESSION_ID } from "../src/lib/core/agent/model.ts";

/** Mirror the runtime start flow: resume-normalize, name-normalize, assemble. */
function startCommand(id: string, args: string[], handle = ""): string {
  const { command } = getProvider(id);
  const resumed = command.normalizeResumeArgs(args);
  return command.build(command.normalizeStartArgs({ handle, args: resumed }));
}

describe("isIdle", () => {
  it("detects Claude idle pattern (unicode prompt)", () => {
    const output = "some output\n❯ \n─────────\n  status bar";
    expect(isIdle(output)).toBe(true);
  });

  it("detects Claude idle prompt with placeholder hint after ❯ (NBSP separator)", () => {
    // Claude Code separates ❯ from the placeholder hint with U+00A0 (non-breaking
    // space), not a regular space. The idle pattern's \s must match it.
    // Regression: 0m31s starts when this pattern fails.
    const nbsp = String.fromCharCode(0xa0);
    const output = [
      "─── handle ──",
      `❯${nbsp}Try "edit <filepath> to..."`,
      "─────────────",
      "  cwd Opus 4.7 (1M context)",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(isIdle(output)).toBe(true);
  });

  it("does not treat a bare '>' line as idle (avoids false idle during thinking)", () => {
    // A stray line ending in '>' (markdown blockquote, diff marker, shell echo)
    // must not match an idle prompt — only the real ❯ / › prompts count.
    expect(isIdle("some output\n> ")).toBe(false);
    expect(isIdle("here is a quote:\n> blockquote text")).toBe(false);
  });

  it("returns false when agent is processing", () => {
    const output = "Thinking...\nAnalyzing the codebase\nReading files";
    expect(isIdle(output)).toBe(false);
  });

  it("returns false when esc to interrupt is shown", () => {
    const output = "❯ \n────────\n  bypass permissions · esc to interrupt\n  Update available!";
    expect(isIdle(output)).toBe(false);
  });

  it("returns false when Pondering", () => {
    const output = "✽ Pondering…\n❯ \n────────\n  esc to interrupt";
    expect(isIdle(output)).toBe(false);
  });

  it("ignores a bottom prompt placeholder when a busy line is still present above trailing blank space", () => {
    const output = [
      "› Remember this token exactly: probe-token. Reply with exactly: stored",
      "",
      "• Working (3s • esc to interrupt)",
      "",
      "› Write tests for @filename",
      "",
      "  ~/workspace/multmux · master · 100% left · gpt-5.4 xhigh",
      "",
      "",
      "",
      "",
      "",
    ].join("\n");

    expect(isIdle(output)).toBe(false);
  });
});

describe("isInputEmpty", () => {
  it("treats an empty Claude prompt as empty", () => {
    expect(isInputEmpty("some output\n❯ \nstatus", "claude")).toBe(true);
  });

  it("treats Claude placeholder text as empty", () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(isInputEmpty(`❯${nbsp}Try "edit <filepath> to..."`, "claude")).toBe(true);
  });

  it("treats user-typed Claude input as occupied", () => {
    expect(isInputEmpty("some output\n❯ my message", "claude")).toBe(false);
  });

  it("treats an empty Codex prompt as empty", () => {
    expect(isInputEmpty("some output\n› ", "codex")).toBe(true);
  });

  it("treats Codex placeholder text as empty", () => {
    expect(isInputEmpty("› Write tests for @filename", "codex")).toBe(true);
  });

  it("treats styled Codex placeholder text as empty regardless of wording", () => {
    const raw = "\x1b[1m›\x1b[0m \x1b[2mExplain this codebase\x1b[0m";
    expect(isInputEmpty("› Explain this codebase", "codex", raw)).toBe(true);
  });

  it("treats unstyled Codex text after the prompt as occupied", () => {
    expect(isInputEmpty("› Explain this codebase", "codex")).toBe(false);
  });

  it("treats user-typed Codex input as occupied", () => {
    expect(isInputEmpty("some output\n› my message", "codex")).toBe(false);
  });

  it("uses the last prompt line instead of historical prompt lines", () => {
    const output = [
      "› ",
      "old output",
      "› current draft",
    ].join("\n");
    expect(isInputEmpty(output, "codex")).toBe(false);
  });
});

describe("registry", () => {
  it("returns the claude adapter", () => {
    const p = getProvider("claude");
    expect(p.id).toBe("claude");
    expect(p.label).toBe("Claude");
    expect(p.executable).toBe("claude");
  });

  it("returns the codex adapter", () => {
    const p = getProvider("codex");
    expect(p.id).toBe("codex");
    expect(p.label).toBe("Codex");
  });

  it("throws on unknown provider", () => {
    expect(() => getProvider("unknown")).toThrow("Unknown provider");
  });

  it("lists both registered providers", () => {
    expect(listProviderIds().sort()).toEqual(["claude", "codex"]);
    expect(listProviders().map((p) => p.id).sort()).toEqual(["claude", "codex"]);
  });

  it("reports membership via hasProvider", () => {
    expect(hasProvider("claude")).toBe(true);
    expect(hasProvider("shell")).toBe(false);
  });

  it("does not resolve inherited object keys", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(() => getProvider(key)).toThrow("Unknown provider");
      expect(hasProvider(key)).toBe(false);
    }
  });
});

describe("legacy provider surface", () => {
  it("exposes only registered ids, never inherited keys", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(["claude", "codex"]);
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(key in PROVIDERS).toBe(false);
      expect(PROVIDERS[key]).toBeUndefined();
      expect(() => getLegacyProvider(key)).toThrow("Unknown provider");
    }
  });
});

describe("command — claude", () => {
  it("adds default --dangerously-skip-permissions", () => {
    const cmd = startCommand("claude", ["Fix tests"]);
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("'Fix tests'");
  });

  it("passes through an explicit --name", () => {
    const cmd = startCommand("claude", ["Fix tests", "--name", "fixer"]);
    expect(cmd).toContain("--name");
    expect(cmd).toContain("'fixer'");
  });

  it("injects --name <handle> when none is present", () => {
    const args = getProvider("claude").command.normalizeStartArgs({ handle: "worker", args: ["Fix tests"] });
    expect(args).toEqual(["Fix tests", "--name", "worker"]);
  });

  it("does not inject --name when one is already present", () => {
    const args = getProvider("claude").command.normalizeStartArgs({ handle: "worker", args: ["--name", "fixer"] });
    expect(args).toEqual(["--name", "fixer"]);
  });

  it("skips default permission when --permission-mode is present", () => {
    const cmd = startCommand("claude", ["Fix tests", "--permission-mode", "bypassPermissions"]);
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("skips default permission when --dangerously-skip-permissions is explicit (no duplicate)", () => {
    const cmd = startCommand("claude", ["--dangerously-skip-permissions", "Fix tests"]);
    expect(cmd.match(/--dangerously-skip-permissions/g)).toHaveLength(1);
  });

  it("handles empty args", () => {
    const cmd = startCommand("claude", []);
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("canonicalizes resume to the --resume flag form", () => {
    const cmd = startCommand("claude", ["resume", "51ca4415", "-n", "auth-fix"]);
    expect(cmd).toContain("'--resume'");
    expect(cmd).toContain("'51ca4415'");
    expect(cmd).not.toContain("'resume'");
  });
});

describe("command — codex", () => {
  it("adds default --yolo and launch env", () => {
    const cmd = startCommand("codex", ["Fix tests"]);
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("COLORTERM=truecolor");
    expect(cmd).toContain("features.hooks=true");
  });

  it("strips --name from codex start args", () => {
    const cmd = startCommand("codex", ["Fix tests", "--name", "worker"], "worker");
    expect(cmd).not.toContain("--name");
    expect(cmd).not.toContain("'worker'");
    expect(cmd).toContain("'Fix tests'");
  });

  it("strips -n from codex start args", () => {
    const args = getProvider("codex").command.normalizeStartArgs({ handle: "worker", args: ["-n", "worker", "Fix tests"] });
    expect(args).toEqual(["Fix tests"]);
  });

  it("strips --name=value from codex start args", () => {
    const args = getProvider("codex").command.normalizeStartArgs({ handle: "worker", args: ["--name=worker", "Fix tests"] });
    expect(args).toEqual(["Fix tests"]);
  });

  it("skips default permission when --full-auto is present", () => {
    const cmd = startCommand("codex", ["Fix tests", "--full-auto"]);
    expect(cmd).not.toContain("--yolo");
  });

  it("skips default permission when --sandbox is present", () => {
    const cmd = startCommand("codex", ["--sandbox=danger-full-access", "Fix tests"]);
    expect(cmd).not.toContain("--yolo");
  });

  it("skips default when -a is present", () => {
    const cmd = startCommand("codex", ["-a", "never", "Fix tests"]);
    expect(cmd).not.toContain("--yolo");
  });

  it("canonicalizes resume to the `resume <id>` subcommand form", () => {
    const cmd = startCommand("codex", ["--resume", "51ca4415", "Fix tests"]);
    expect(cmd).toContain("'resume'");
    expect(cmd).toContain("'51ca4415'");
    expect(cmd).not.toContain("--resume");
  });
});

describe("command — name and rename inputs", () => {
  it("claude has no post-start inputs; codex renames itself", () => {
    expect(getProvider("claude").command.postStartInputs({ handle: "w", args: [] })).toEqual([]);
    expect(getProvider("codex").command.postStartInputs({ handle: "w", args: [] })).toEqual(["/rename w"]);
  });

  it("both providers rename live sessions via /rename", () => {
    expect(getProvider("claude").command.renameInputs("w2")).toEqual(["/rename w2"]);
    expect(getProvider("codex").command.renameInputs("w2")).toEqual(["/rename w2"]);
  });

  it("declares startup interstitials", () => {
    expect(getProvider("claude").command.startupInterstitials?.length).toBeGreaterThan(0);
    const codexPatterns = getProvider("codex").command.startupInterstitials ?? [];
    expect(codexPatterns.some((i) => /Hooks need review/.test(i.pattern.source))).toBe(true);
  });
});

describe("terminal runtime compatibility", () => {
  it("codex declares truecolor launch env and color-query responder", () => {
    const terminal = getProvider("codex").terminal;
    expect(terminal?.launchEnv?.COLORTERM).toBe("truecolor");
    expect(terminal?.respondToColorQuery).toBe(true);
  });

  it("claude declares no special terminal runtime needs", () => {
    expect(getProvider("claude").terminal).toBeUndefined();
  });
});

describe("session-id strategy", () => {
  it("claude polls provider storage and exposes its env key", () => {
    const sid = getProvider("claude").sessionId;
    expect(sid.pendingValue).toBe(PENDING_SESSION_ID);
    expect(sid.envKeys).toEqual(["CLAUDE_CODE_SESSION_ID"]);
    expect(sid.startResolution).toBe("poll-provider-storage");
  });

  it("codex trusts the state file at start and exposes its env key", () => {
    const sid = getProvider("codex").sessionId;
    expect(sid.envKeys).toEqual(["CODEX_THREAD_ID"]);
    expect(sid.startResolution).toBe("state-file-only");
  });

  it("resolve delegates to the shared resolver (null for invalid pid)", () => {
    expect(getProvider("claude").sessionId.resolve({ pid: 0 })).toBeNull();
  });
});

describe("hook metadata", () => {
  it("each provider declares its hook events and config path", () => {
    const claude = getProvider("claude").hooks!;
    expect(claude.events).toContain("SessionStart");
    expect(claude.configPath()).toContain(".claude");

    const codex = getProvider("codex").hooks!;
    expect(codex.events).toContain("UserPromptSubmit");
    expect(codex.configPath()).toContain(".codex");
  });
});
