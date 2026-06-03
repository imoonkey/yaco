import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HOOK_V2_SCRIPT, HOOK_MARKER, CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS, cleanupDeprecatedHooks } from "../src/hooks.ts";

describe("hook v2 script content", () => {
  it("starts with shebang", () => {
    expect(HOOK_V2_SCRIPT.startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("does NOT reference MULTMUX_SESSION_SUFFIX", () => {
    expect(HOOK_V2_SCRIPT).not.toContain('MULTMUX_SESSION_SUFFIX');
  });

  it("honors MULTMUX_STATE_DIR override (parameterized state-dir resolver)", () => {
    // The override stays as an explicit test/escape hatch; the default is
    // ${YACO_HOME:-$HOME/.yaco}/sessions and the env var takes precedence.
    expect(HOOK_V2_SCRIPT).toContain('${MULTMUX_STATE_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}');
  });

  it("uses YACO_HOME-rooted global path", () => {
    expect(HOOK_V2_SCRIPT).toContain('${YACO_HOME:-$HOME/.yaco}/sessions');
    // Old root must not leak back in.
    expect(HOOK_V2_SCRIPT).not.toContain('$HOME/.multmux/sessions');
  });

  it("derives handle from tmux session name directly", () => {
    expect(HOOK_V2_SCRIPT).toContain('tmux display-message');
    expect(HOOK_V2_SCRIPT).toContain('#{session_name}');
    // No suffix stripping
    expect(HOOK_V2_SCRIPT).not.toContain('${sn%-$suffix}');
  });

  it("uses tmux exact-match syntax (=) to prevent prefix matching", () => {
    expect(HOOK_V2_SCRIPT).toContain('has-session -t "=$handle"');
    expect(HOOK_V2_SCRIPT).not.toMatch(/has-session -t "\$handle"/);
  });

  it("handles all required events", () => {
    expect(HOOK_V2_SCRIPT).toContain("SessionStart)");
    expect(HOOK_V2_SCRIPT).toContain("UserPromptSubmit)");
    expect(HOOK_V2_SCRIPT).toContain("Stop|StopFailure)");
    expect(HOOK_V2_SCRIPT).toContain("SessionEnd)");
    expect(HOOK_V2_SCRIPT).toContain("PreToolUse|PostToolUse|PostToolUseFailure|PreCompact|PostCompact)");
    expect(HOOK_V2_SCRIPT).toContain("Notification)");
  });

  it("implements Codex guard (skip SessionStart if processing)", () => {
    expect(HOOK_V2_SCRIPT).toContain('"processing"');
  });

  it("extracts and stores session_id on SessionStart", () => {
    expect(HOOK_V2_SCRIPT).toContain("session_id");
    expect(HOOK_V2_SCRIPT).toContain("sessionId");
  });
});

describe("hook events", () => {
  it("claude hooks cover all required events", () => {
    expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
    expect(CLAUDE_HOOK_EVENTS).toContain("UserPromptSubmit");
    expect(CLAUDE_HOOK_EVENTS).toContain("Stop");
    expect(CLAUDE_HOOK_EVENTS).toContain("StopFailure");
    expect(CLAUDE_HOOK_EVENTS).toContain("PreToolUse");
    expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUse");
    expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUseFailure");
    expect(CLAUDE_HOOK_EVENTS).toContain("PermissionRequest");
    expect(CLAUDE_HOOK_EVENTS).toContain("Notification");
    expect(CLAUDE_HOOK_EVENTS).toContain("PreCompact");
    expect(CLAUDE_HOOK_EVENTS).toContain("PostCompact");
    expect(CLAUDE_HOOK_EVENTS).toContain("SessionEnd");
  });

  it("codex hooks cover available events", () => {
    expect(CODEX_HOOK_EVENTS).toContain("SessionStart");
    expect(CODEX_HOOK_EVENTS).toContain("UserPromptSubmit");
    expect(CODEX_HOOK_EVENTS).toContain("Stop");
    expect(CODEX_HOOK_EVENTS).toContain("PreToolUse");
    expect(CODEX_HOOK_EVENTS).toContain("PostToolUse");
    expect(CODEX_HOOK_EVENTS).toContain("PermissionRequest");
    expect(CODEX_HOOK_EVENTS).toContain("PreCompact");
    expect(CODEX_HOOK_EVENTS).toContain("PostCompact");
  });
});

describe("tool-scoped hook matchers", () => {
  // Claude Code interprets `matcher` as a tool-name filter for PreToolUse/PostToolUse/
  // PostToolUseFailure/PermissionRequest. "multmux-hook" never matches any tool,
  // so tool-scoped events MUST use "*" to fire. Lifecycle events use HOOK_MARKER as a label.
  it("TOOL_SCOPED_EVENTS covers all tool-filtered hook events", async () => {
    const { TOOL_SCOPED_EVENTS } = await import("../src/hooks.ts");
    expect(TOOL_SCOPED_EVENTS.has("PreToolUse")).toBe(true);
    expect(TOOL_SCOPED_EVENTS.has("PostToolUse")).toBe(true);
    expect(TOOL_SCOPED_EVENTS.has("PostToolUseFailure")).toBe(true);
    expect(TOOL_SCOPED_EVENTS.has("PermissionRequest")).toBe(true);
    // Notification + PreCompact/PostCompact also use matcher as content filter,
    // not as a label — they need "*" to fire on all sub-types.
    expect(TOOL_SCOPED_EVENTS.has("Notification")).toBe(true);
    expect(TOOL_SCOPED_EVENTS.has("PreCompact")).toBe(true);
    expect(TOOL_SCOPED_EVENTS.has("PostCompact")).toBe(true);
    // Lifecycle events are NOT tool-scoped
    expect(TOOL_SCOPED_EVENTS.has("SessionStart")).toBe(false);
    expect(TOOL_SCOPED_EVENTS.has("Stop")).toBe(false);
    expect(TOOL_SCOPED_EVENTS.has("UserPromptSubmit")).toBe(false);
  });

  it("multmuxToolHookGroup uses '*' matcher; multmuxHookGroup uses HOOK_MARKER", async () => {
    const { multmuxToolHookGroup, multmuxHookGroup, HOOK_MARKER } = await import("../src/hooks.ts");
    expect(multmuxToolHookGroup().matcher).toBe("*");
    expect(multmuxHookGroup().matcher).toBe(HOOK_MARKER);
  });

  it("recognizes v2 tool-scoped hooks as existing multmux hooks", async () => {
    const { hasMultmuxHook } = await import("../src/hooks.ts");
    const existingHook = [{
      matcher: "*",
      hooks: [{ type: "command", command: 'bash "/Users/me/.yaco/hook-v2.sh"', async: false }],
    }];

    expect(hasMultmuxHook(existingHook)).toBe(true);
  });

  it("upgrades legacy hook-v2 path to the current YACO hook path", async () => {
    const { upgradeHookToV2 } = await import("../src/hooks.ts");
    const existingHook = [{
      matcher: HOOK_MARKER,
      hooks: [{ type: "command", command: 'bash "/home/me/.multmux/hook-v2.sh"', async: false }],
    }];

    expect(upgradeHookToV2(existingHook)).toBe(true);
    expect(existingHook[0].hooks[0].command).toContain("/.yaco/hook-v2.sh");
    expect(existingHook[0].hooks[0].command).not.toContain("/.multmux/");
  });
});

describe("hook v2 script execution", () => {
  let tmpDir: string;
  let hookPath: string;
  let stateDir: string;
  let mockBinDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multmux-hook-test-"));
    hookPath = join(tmpDir, "hook-v2.sh");
    // Create a mock global sessions dir
    stateDir = join(tmpDir, "sessions");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(hookPath, HOOK_V2_SCRIPT, { mode: 0o755 });

    // Create mock tmux that returns a known session name (= handle directly in v2)
    mockBinDir = join(tmpDir, "bin");
    mkdirSync(mockBinDir);
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\nif [ "$1" = "display-message" ]; then echo "test"; fi\n',
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(event: string, stateJson: string, sessionId?: string, extras?: Record<string, string>): string {
    // V2 hook resolves state dir as ${MULTMUX_STATE_DIR:-${YACO_HOME:-$HOME/.yaco}/sessions}.
    // We override HOME (so $HOME/.yaco/sessions points into our tmpDir) and
    // explicitly leave MULTMUX_STATE_DIR/YACO_HOME unset to exercise the default branch.
    const fakeHome = join(tmpDir, "fakehome");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    const stateFile = join(fakeSessionsDir, "test.json");
    writeFileSync(stateFile, stateJson);

    const hookInput = JSON.stringify({
      hook_event_name: event,
      session_id: sessionId ?? "test-session-123",
      ...(extras ?? {}),
    });

    const { execSync } = require("child_process");
    const childEnv: Record<string, string> = {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      HOME: fakeHome,
    };
    delete childEnv.MULTMUX_STATE_DIR;
    delete childEnv.YACO_HOME;
    try {
      execSync(`echo '${hookInput.replace(/'/g, "'\\''")}' | bash ${hookPath}`, {
        encoding: "utf-8",
        env: childEnv,
        timeout: 5000,
      });
    } catch {
      // hook exits 0 on guards, which is fine
    }

    return existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";
  }

  it("transitions starting → idle on SessionStart", () => {
    const result = runHook("SessionStart", '{"status":"starting","sessionId":""}');
    expect(result).toContain('"status":"idle"');
  });

  it("transitions idle → processing on UserPromptSubmit", () => {
    const result = runHook("UserPromptSubmit", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("transitions processing → idle on Stop", () => {
    const result = runHook("Stop", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"idle"');
  });

  it("transitions processing → idle on StopFailure", () => {
    const result = runHook("StopFailure", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"idle"');
  });

  it("sets status to idle on SessionEnd (context reset safe)", () => {
    // Mock tmux to also handle has-session
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\n'
        + 'if [ "$1" = "display-message" ]; then echo "test"; fi\n'
        + 'if [ "$1" = "has-session" ]; then exit 0; fi\n',
      { mode: 0o755 },
    );
    const result = runHook("SessionEnd", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"idle"');
  });

  it("skips write on SessionEnd when tmux session is dead", () => {
    writeFileSync(
      join(mockBinDir, "tmux"),
      '#!/bin/bash\n'
        + 'if [ "$1" = "display-message" ]; then echo "test"; fi\n'
        + 'if [ "$1" = "has-session" ]; then exit 1; fi\n',
      { mode: 0o755 },
    );

    const result = runHook("SessionEnd", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("guards SessionStart when already processing (Codex edge case)", () => {
    const result = runHook("SessionStart", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("stores session_id on SessionStart", () => {
    const result = runHook("SessionStart", '{"status":"starting","sessionId":""}', "abc-123");
    expect(result).toContain('"sessionId":"abc-123"');
  });

  it("stores session_id with special characters", () => {
    const result = runHook("SessionStart", '{"status":"starting","sessionId":""}', "51ca4415-2f5e-42d0-9af6-1252b1928f80");
    expect(result).toContain('"sessionId":"51ca4415-2f5e-42d0-9af6-1252b1928f80"');
  });

  it("PostToolUse sets status to processing", () => {
    const result = runHook("PostToolUse", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("PostToolUse corrects premature idle back to processing", () => {
    const result = runHook("PostToolUse", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("PostToolUseFailure sets status to processing", () => {
    const result = runHook("PostToolUseFailure", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("PermissionRequest sets status to idle", () => {
    const result = runHook("PermissionRequest", '{"status":"processing","sessionId":""}');
    expect(result).toContain('"status":"idle"');
  });

  it("PreToolUse sets status to processing (earlier than PostToolUse)", () => {
    const result = runHook("PreToolUse", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("PreCompact sets status to processing (compaction window)", () => {
    const result = runHook("PreCompact", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("PostCompact sets status to processing (next event will adjust)", () => {
    const result = runHook("PostCompact", '{"status":"idle","sessionId":""}');
    expect(result).toContain('"status":"processing"');
  });

  it("Notification with idle_prompt sets status to idle", () => {
    const result = runHook(
      "Notification",
      '{"status":"processing","sessionId":""}',
      undefined,
      { notification_type: "idle_prompt" },
    );
    expect(result).toContain('"status":"idle"');
  });

  it("Notification with permission_prompt sets status to idle", () => {
    const result = runHook(
      "Notification",
      '{"status":"processing","sessionId":""}',
      undefined,
      { notification_type: "permission_prompt" },
    );
    expect(result).toContain('"status":"idle"');
  });

  it("Notification with unknown type does not change status", () => {
    const result = runHook(
      "Notification",
      '{"status":"processing","sessionId":""}',
      undefined,
      { notification_type: "auth_success" },
    );
    expect(result).toContain('"status":"processing"');
  });

  it("exits silently when no state file exists", () => {
    // Create mock with no state file — hook should be a no-op
    const fakeHome = join(tmpDir, "fakehome-empty");
    const fakeSessionsDir = join(fakeHome, ".yaco", "sessions");
    mkdirSync(fakeSessionsDir, { recursive: true });
    // Don't create state file — hook should exit silently

    const { execSync } = require("child_process");
    const childEnv: Record<string, string> = {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      HOME: fakeHome,
    };
    delete childEnv.MULTMUX_STATE_DIR;
    delete childEnv.YACO_HOME;
    // Should not throw
    execSync(`echo '{"hook_event_name":"Stop"}' | bash ${hookPath}`, {
      encoding: "utf-8",
      env: childEnv,
      timeout: 5000,
    });
  });

  it("honors MULTMUX_STATE_DIR env override", () => {
    // When MULTMUX_STATE_DIR is set, it wins over the default YACO root.
    const overrideHome = join(tmpDir, "fakehome-override");
    mkdirSync(join(overrideHome, ".yaco", "sessions"), { recursive: true });
    // Decoy: a state file at the default YACO path that we DO NOT want touched.
    const decoy = join(overrideHome, ".yaco", "sessions", "test.json");
    writeFileSync(decoy, '{"status":"starting","sessionId":""}');

    // Real state file lives under MULTMUX_STATE_DIR.
    const overrideDir = join(tmpDir, "override-state");
    mkdirSync(overrideDir, { recursive: true });
    const realStateFile = join(overrideDir, "test.json");
    writeFileSync(realStateFile, '{"status":"starting","sessionId":""}');

    const { execSync } = require("child_process");
    execSync(
      `echo '{"hook_event_name":"SessionStart","session_id":"abc-123"}' | bash ${hookPath}`,
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${mockBinDir}:${process.env.PATH}`,
          HOME: overrideHome,
          MULTMUX_STATE_DIR: overrideDir,
        },
        timeout: 5000,
      },
    );

    // The override-rooted file should have been updated to idle.
    expect(readFileSync(realStateFile, "utf-8")).toContain('"status":"idle"');
    // The decoy file at the default YACO path must stay untouched.
    expect(readFileSync(decoy, "utf-8")).toContain('"status":"starting"');
  });

  it("honors YACO_HOME env override when MULTMUX_STATE_DIR is unset", () => {
    const fakeHome = join(tmpDir, "fakehome-yaco");
    // Default $HOME/.yaco path — must remain untouched because YACO_HOME wins.
    mkdirSync(join(fakeHome, ".yaco", "sessions"), { recursive: true });
    const decoy = join(fakeHome, ".yaco", "sessions", "test.json");
    writeFileSync(decoy, '{"status":"starting","sessionId":""}');

    // YACO_HOME-rooted dir
    const yacoRoot = join(tmpDir, "yaco-override");
    mkdirSync(join(yacoRoot, "sessions"), { recursive: true });
    const realStateFile = join(yacoRoot, "sessions", "test.json");
    writeFileSync(realStateFile, '{"status":"starting","sessionId":""}');

    const { execSync } = require("child_process");
    const childEnv: Record<string, string> = {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      HOME: fakeHome,
      YACO_HOME: yacoRoot,
    };
    delete childEnv.MULTMUX_STATE_DIR;
    execSync(
      `echo '{"hook_event_name":"SessionStart","session_id":"abc-123"}' | bash ${hookPath}`,
      { encoding: "utf-8", env: childEnv, timeout: 5000 },
    );

    expect(readFileSync(realStateFile, "utf-8")).toContain('"status":"idle"');
    expect(readFileSync(decoy, "utf-8")).toContain('"status":"starting"');
  });
});

describe("cleanupDeprecatedHooks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "multmux-cleanup-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes bare hook groups referencing on-stop.sh", () => {
    const settings: Record<string, any> = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/Users/me/.claude/hooks/on-stop.sh" }] },
          { matcher: "multmux-hook", hooks: [{ type: "command", command: "bash hook.sh" }] },
        ],
      },
    };

    const changed = cleanupDeprecatedHooks(settings, tmpDir);

    expect(changed).toBe(true);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].matcher).toBe("multmux-hook");
  });

  it("preserves non-on-stop.sh bare hook groups", () => {
    const settings: Record<string, any> = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/some/other/hook.sh" }] },
          { matcher: "multmux-hook", hooks: [{ type: "command", command: "bash hook.sh" }] },
        ],
      },
    };

    const changed = cleanupDeprecatedHooks(settings, tmpDir);

    expect(changed).toBe(false);
    expect(settings.hooks.Stop).toHaveLength(2);
  });

  it("deletes on-stop.sh file and empty hooks dir", () => {
    const hooksDir = join(tmpDir, "hooks");
    mkdirSync(hooksDir);
    writeFileSync(join(hooksDir, "on-stop.sh"), "#!/bin/bash\nexit 0");

    cleanupDeprecatedHooks({ hooks: {} }, tmpDir);

    expect(existsSync(join(hooksDir, "on-stop.sh"))).toBe(false);
    expect(existsSync(hooksDir)).toBe(false);
  });

  it("keeps hooks dir if it has other files", () => {
    const hooksDir = join(tmpDir, "hooks");
    mkdirSync(hooksDir);
    writeFileSync(join(hooksDir, "on-stop.sh"), "#!/bin/bash");
    writeFileSync(join(hooksDir, "other-hook.sh"), "#!/bin/bash");

    cleanupDeprecatedHooks({ hooks: {} }, tmpDir);

    expect(existsSync(join(hooksDir, "on-stop.sh"))).toBe(false);
    expect(existsSync(hooksDir)).toBe(true);
    expect(existsSync(join(hooksDir, "other-hook.sh"))).toBe(true);
  });

  it("no-ops when no on-stop.sh entries or file exist", () => {
    const settings: Record<string, any> = {
      hooks: { Stop: [{ matcher: "multmux-hook", hooks: [] }] },
    };

    const changed = cleanupDeprecatedHooks(settings, tmpDir);

    expect(changed).toBe(false);
    expect(settings.hooks.Stop).toHaveLength(1);
  });
});
